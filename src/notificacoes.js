'use strict';

// O gatilho em avisos.sql registra cada mudança na fila do Supabase. Realtime
// acelera o envio; a consulta periódica recupera falhas e períodos desconectados.
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { enviarTexto } = require('./services/evolution');
const { salvarMensagem } = require('./services/supabase');
const logger = require('./logger');

let _sb = null;
const sb = () => (_sb ||= createClient(process.env.SUPA_URL, process.env.SUPA_SERVICE_KEY, {
  realtime: { transport: ws },
}));
const norm = s => String(s || '').toLowerCase().trim().replace(/\s+/g, '_');
const fmt = v => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

function montarMensagem(pedido, nome) {
  const n = `*#${String(pedido.numero_pedido).padStart(3, '0')}*`;
  const quem = nome ? `, ${String(nome).trim().split(/\s+/)[0]}` : '';
  const retirada = norm(pedido.tipo_entrega) === 'retirada';
  switch (norm(pedido.status)) {
    case 'confirmado':
    case 'aguardando_preparo':
      return `Oba${quem}! Seu pedido ${n} foi confirmado e está na fila de preparo 🍻`;
    case 'preparando':
      return `Seu pedido ${n} *entrou em preparo*! 🔥\n\nTe aviso quando estiver pronto.`;
    case 'pronto':
      return retirada
        ? `Seu pedido ${n} está *pronto para retirada*! 🎉\n\nPode vir buscar aqui no balcão.`
        : `Seu pedido ${n} está *pronto*! 🎉\n\nAgora estamos organizando a entrega.`;
    case 'saiu_entrega':
      // O painel usa a mesma coluna para entrega e retirada.
      return retirada
        ? `Seu pedido ${n} está *pronto para retirada*! 🎉\n\nPode vir buscar. Total: ${fmt(pedido.total)}`
        : `Seu pedido ${n} *saiu para entrega*! 🛵\n\nFica de olho que já chega. Total: ${fmt(pedido.total)}`;
    case 'entregue':
      return retirada
        ? `Pedido ${n} retirado! Valeu${quem} 🍻\n\nBom apetite!`
        : `Pedido ${n} entregue! Bom apetite${quem} 🍻`;
    case 'cancelado':
      return `Seu pedido ${n} foi cancelado.\n\nSe não foi você que pediu o cancelamento, me chama aqui que a gente resolve.`;
    default:
      return null;
  }
}

async function atualizarAviso(aviso, campos) {
  const { data, error } = await sb().from('notificacoes_pedido_enviadas')
    .update(campos).eq('id', aviso.id).eq('reserva_token', aviso.reserva_token).select('id');
  if (error) throw new Error(`Supabase/atualizarAviso: ${error.message}`);
  if (!data?.length) throw new Error('Reserva do aviso expirou ou foi assumida por outra instância');
}

async function enviarAviso(aviso) {
  const pedido = aviso.pedido;
  let tel, texto, msgId;
  try {
    const { data: cli, error } = await sb().from('clientes')
      .select('nome, telefone').eq('id', pedido.cliente_id).maybeSingle();
    if (error) throw new Error(`Supabase/clienteAviso: ${error.message}`);
    tel = String(cli?.telefone || '').replace(/\D/g, '');
    if (!tel) throw new Error('Cliente do pedido sem telefone para o aviso');
    texto = montarMensagem(pedido, cli?.nome);
    if (!texto) throw new Error(`Status de aviso desconhecido: ${pedido.status}`);
    msgId = await enviarTexto(tel, texto);
  } catch (err) {
    const esperaMs = Math.min(300_000, 5_000 * 2 ** Math.min(aviso.tentativas - 1, 6));
    await atualizarAviso(aviso, {
      ultimo_erro: String(err.message).slice(0, 500),
      disponivel_em: new Date(Date.now() + esperaMs).toISOString(),
      reserva_token: null, reservado_ate: null,
    });
    logger.error('aviso/falha-envio', err.message, { pedido: pedido.numero_pedido, status: aviso.status });
    return;
  }

  // Não liberar a reserva quando o envio já ocorreu: uma falha ao confirmar no
  // banco deve ficar visível, sem disparar imediatamente a mesma mensagem.
  await atualizarAviso(aviso, {
    enviado_em: new Date().toISOString(), telefone: tel, whatsapp_message_id: msgId,
    ultimo_erro: null, reserva_token: null, reservado_ate: null,
  });
  await salvarMensagem(tel, 'assistant', texto, {
    origem: 'agente', tipo: 'texto', msgId, etapa: aviso.status,
  });
  logger.info('aviso/enviado', 'Cliente avisado da mudança de status', {
    pedido: pedido.numero_pedido, status: aviso.status,
  });
}

let processamento = null;
function processarFila() {
  if (processamento) return processamento;
  processamento = (async () => {
    // Limita cada rodada para não monopolizar o processo em filas grandes.
    for (let i = 0; i < 50; i++) {
      const { data, error } = await sb().rpc('reservar_aviso_pedido');
      if (error) throw new Error(`Supabase/filaAvisos: ${error.message}. Confira se avisos.sql foi aplicado.`);
      if (!data?.length) break;
      await enviarAviso(data[0]);
    }
  })().catch(err => {
    logger.error('aviso/fila', err.message, { stack: err.stack });
  }).finally(() => { processamento = null; });
  return processamento;
}

let canal = null, timer = null;
function iniciarNotificacoes() {
  if (canal) return;
  const faltando = ['SUPA_URL', 'SUPA_SERVICE_KEY', 'EVOLUTION_URL', 'EVOLUTION_KEY', 'EVOLUTION_INSTANCE']
    .filter(chave => !process.env[chave]);
  if (faltando.length) {
    logger.warn('aviso/config', 'Avisos não iniciados: faltam variáveis de ambiente', { faltando });
    return;
  }
  canal = sb().channel('avisos-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pedidos' }, processarFila)
    .subscribe(st => {
      logger.info('aviso/canal', `Canal de avisos: ${st}`, {});
      if (st === 'SUBSCRIBED') processarFila();
    });
  timer = setInterval(processarFila, 5_000);
  timer.unref();
  processarFila();
}

async function pararNotificacoes() {
  clearInterval(timer);
  timer = null;
  if (canal) await sb().removeChannel(canal);
  canal = null;
  if (processamento) await processamento;
}

module.exports = { iniciarNotificacoes, pararNotificacoes, montarMensagem, processarFila };
