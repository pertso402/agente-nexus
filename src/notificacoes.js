'use strict';

// ─── AVISO DE STATUS PARA O CLIENTE ───────────────────────────────────────────
// Quando a cozinha move o pedido no painel, o cliente recebe no WhatsApp.
//
// Quem envia é o agente, não o painel: o painel é uma página estática e pública,
// e colocar a chave da Evolution nele deixaria qualquer um com o link mandando
// mensagem pelo número da loja.
//
// Vale para pedido do WhatsApp E do cardápio digital — os dois gravam na mesma
// tabela, então o aviso sai igual independente de onde veio.

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { enviarTexto } = require('./services/evolution');
const logger = require('./logger');

// Cliente criado sob demanda: se fosse na importação, faltar SUPA_URL derrubaria
// o agente inteiro ao subir — e a checagem em iniciarNotificacoes nunca rodaria.
let _sb = null;
const sb = () => (_sb ||= createClient(process.env.SUPA_URL, process.env.SUPA_SERVICE_KEY, {
  realtime: { transport: ws },
}));

const norm = s => String(s || '').toLowerCase().trim().replace(/\s+/g, '_');
const fmt = v => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

// 'pendente' fica de fora de propósito: é o estado de criação, e o cliente
// acabou de receber a confirmação (pelo agente ou pela tela do cardápio).
function montarMensagem(pedido, nome) {
  const n = `*#${String(pedido.numero_pedido).padStart(3, '0')}*`;
  const quem = nome ? `, ${String(nome).split(' ')[0]}` : '';
  const retirada = pedido.tipo_entrega === 'retirada';

  switch (norm(pedido.status)) {
    case 'confirmado':
      return `Oba${quem}! Seu pedido ${n} foi confirmado e já entrou na fila 🍻`;
    case 'preparando':
    case 'aguardando_preparo':
      return `Pedido ${n} já está na chapa 🔥\n\nDaqui a pouco te aviso quando sair.`;
    case 'pronto':
      return retirada
        ? `Pedido ${n} está *pronto*! 🎉\n\nPode vir buscar aqui no balcão que já te entregamos.`
        : `Pedido ${n} está *pronto* 🎉\n\nJá já sai pra entrega.`;
    case 'saiu_entrega':
      // a coluna "Pronto / Saiu" do painel grava saiu_entrega para os dois tipos;
      // quem vai buscar não pode receber "saiu para entrega"
      return retirada
        ? `Pedido ${n} está *pronto* pra retirada! 🎉\n\nPode vir buscar. Total: ${fmt(pedido.total)}`
        : `Pedido ${n} *saiu para entrega* 🛵\n\nFica de olho que já chega. Total: ${fmt(pedido.total)}`;
    case 'entregue':
      return retirada
        ? `Pedido ${n} entregue! Valeu${quem} 🍻\n\nSe curtiu, volta sempre.`
        : `Pedido ${n} entregue! Bom apetite${quem} 🍻\n\nQualquer coisa é só chamar aqui.`;
    case 'cancelado':
      return `Seu pedido ${n} foi cancelado.\n\nSe não foi você que pediu o cancelamento, me chama aqui que a gente resolve.`;
    default:
      return null;   // status sem aviso definido: não inventa mensagem
  }
}

// Trava de duplicidade: o realtime pode repetir o evento, e o mesmo status pode
// ser gravado duas vezes (ex: clique duplo no painel).
async function jaAvisado(pedidoId, status) {
  const { data } = await sb()
    .from('notificacoes_pedido_enviadas')
    .select('id')
    .eq('pedido_id', pedidoId)
    .eq('status', norm(status))
    .limit(1);
  return !!data?.length;
}

async function avisar(pedido) {
  const status = norm(pedido.status);
  const texto = montarMensagem(pedido, null);
  if (!texto) return;
  if (await jaAvisado(pedido.id, status)) return;

  const { data: cli } = await sb()
    .from('clientes').select('nome, telefone').eq('id', pedido.cliente_id).maybeSingle();
  const tel = String(cli?.telefone || '').replace(/\D/g, '');
  if (!tel) {
    logger.warn('aviso/sem-telefone', 'Pedido sem telefone do cliente', { pedido: pedido.numero_pedido });
    return;
  }

  // reserva ANTES de enviar: se duas instâncias rodarem, só uma passa da trava
  const { error: eIns } = await sb().from('notificacoes_pedido_enviadas')
    .insert({ pedido_id: pedido.id, status, telefone: tel });
  if (eIns) {
    if (!/duplicate|unique/i.test(eIns.message)) {
      logger.error('aviso/trava', eIns.message, { pedido: pedido.numero_pedido });
    }
    return;   // outra execução já pegou este aviso
  }

  try {
    await enviarTexto(tel, montarMensagem(pedido, cli?.nome));
    logger.info('aviso/enviado', 'Cliente avisado da mudança de status', {
      pedido: pedido.numero_pedido, status, telefone: tel,
    });
  } catch (err) {
    // libera a trava pra poder tentar de novo numa próxima mudança
    await sb().from('notificacoes_pedido_enviadas').delete()
      .eq('pedido_id', pedido.id).eq('status', status);
    logger.error('aviso/falha-envio', err.message, { pedido: pedido.numero_pedido, status });
  }
}

function iniciarNotificacoes() {
  if (!process.env.SUPA_URL) return;

  sb().channel('avisos-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pedidos' }, ({ new: novo, old: velho }) => {
      if (!novo || norm(novo.status) === norm(velho?.status)) return;   // mudou outra coisa
      avisar(novo).catch(err =>
        logger.error('aviso/erro', err.message, { pedido: novo.numero_pedido, stack: err.stack }));
    })
    .subscribe(st => logger.info('aviso/canal', `Canal de avisos: ${st}`, {}));
}

module.exports = { iniciarNotificacoes, montarMensagem };
