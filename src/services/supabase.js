'use strict';
const { avaliarFuncionamento } = require('../utils/horarios');

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { normalizar, parseItens, avaliarRascunho, calcularSubtotal } = require('../utils/pedido');
const { deveReabrir } = require('../utils/funcionamento');
const logger = require('../logger');

const sb = createClient(
  process.env.SUPA_URL,
  process.env.SUPA_SERVICE_KEY,
  { realtime: { transport: ws } }
);

// ─── HISTÓRICO DE CONVERSA ────────────────────────────────────────────────────

async function carregarHistorico(telefone, limite = 16) {
  // O cardápio grava o telefone com o 9 e o WhatsApp sem. Os avisos de status
  // saíam numa conversa e a resposta do cliente caía em outra, vazia: quem
  // respondia "Ok, obrigada" ao "pedido entregue" recebia a saudação de novo.
  const { data, error } = await sb
    .from('n8n_chat_histories')
    .select('message')
    .in('session_id', variantesTelefone(telefone))
    // Pega as mensagens mais novas; inverte para alimentar o modelo em ordem
    // cronológica e preservar as falas registradas durante a pausa humana.
    .order('created_at', { ascending: false })
    .limit(limite);

  if (error) throw new Error(`Supabase/carregarHistorico: ${error.message}`);

  return (data || []).reverse()
    .map(row => {
      try { return typeof row.message === 'string' ? JSON.parse(row.message) : row.message; }
      catch { return null; }
    })
    .filter(m => m && m.role && m.content);
}

// "message" segue no formato antigo ({role, content}) porque é dele que a
// memória do agente é montada. Os campos novos vão em colunas próprias e
// existem só para analisar e otimizar depois.
async function salvarMensagem(telefone, role, content, extras = {}) {
  const { error } = await sb.from('n8n_chat_histories').insert({
    session_id: telefone,
    telefone,
    // objeto jsonb de verdade (antes ia JSON.stringify, o que guardava uma STRING
    // dentro do jsonb e fazia message->>'content' devolver NULL nas consultas)
    message: { role, content, ts: Date.now() },
    origem:              extras.origem || (role === 'user' ? 'cliente' : 'agente'),
    tipo:                extras.tipo || 'texto',
    whatsapp_message_id: extras.msgId || null,
    transcricao:         extras.transcricao || null,
    analise_imagem:      extras.analiseImagem || null,
    tool_calls:          extras.toolCalls || null,
    etapa_pedido:        extras.etapa || null,
    modelo:              extras.modelo || null,
    latencia_ms:         extras.latenciaMs || null,
    tokens_entrada:      extras.tokensEntrada || null,
    tokens_saida:        extras.tokensSaida || null,
    erro:                extras.erro || null,
    request_id:          extras.requestId || null,
  });

  if (!error) return true;

  // Se as colunas novas ainda não existem (migration não rodada), grava ao menos
  // a conversa no formato antigo. Sem isso o histórico fica vazio e o agente
  // perde a MEMÓRIA — cada mensagem recomeçaria do zero.
  if (/column|schema cache/i.test(error.message || '')) {
    const { error: e2 } = await sb.from('n8n_chat_histories').insert({
      session_id: telefone,
      message: JSON.stringify({ role, content, ts: Date.now() }),
    });
    if (!e2) {
      logger.warn('historico/sem-colunas', 'Gravado sem metadados — rode historico.sql', { telefone });
      return true;
    }
  }

  // Falha de histórico NÃO derruba o atendimento: a resposta já foi enviada ao
  // cliente, e lançar aqui faria ele receber um "problema técnico" logo depois
  // de uma resposta correta. Fica registrado em agent_logs para não passar batido.
  logger.error('historico/falha-ao-gravar', error.message, { telefone, origem: extras.origem, role });
  return false;
}

// O webhook ecoa também o que o próprio agente mandou. Se o id já está gravado,
// aquele "fromMe" é do agente; se não está, foi um humano digitando no celular.
async function mensagemJaRegistrada(msgId) {
  if (!msgId) return false;
  const { data } = await sb
    .from('n8n_chat_histories')
    .select('id')
    .eq('whatsapp_message_id', msgId)
    .limit(1);
  return !!data?.length;
}

// A pausa é por número/conversa. Cada evento cria uma linha para manter o
// histórico de escalonamentos e de respostas humanas visível no painel.
const DURACAO_PAUSA_MINUTOS = Math.max(1, Number(process.env.PAUSA_ATENDENTE_MINUTOS) || 10);

async function carregarPausaAtiva(telefone) {
  const { data, error } = await sb.from('agente_pausas')
    .select('motivo, pausado_ate, created_at')
    .in('telefone', variantesTelefone(telefone))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase/carregarPausaAtiva: ${error.message}`);
  return data && Date.parse(data.pausado_ate) > Date.now() ? data : null;
}

async function pausarAtendimento(telefone, motivo, minutos = DURACAO_PAUSA_MINUTOS) {
  const tel = String(telefone || '').replace(/\D/g, '');
  if (!tel) throw new Error('Telefone ausente ao pausar atendimento.');
  const pausadoAte = new Date(Date.now() + Math.max(1, Number(minutos) || DURACAO_PAUSA_MINUTOS) * 60_000).toISOString();
  const { data, error } = await sb.from('agente_pausas')
    .insert({ telefone: tel, motivo, pausado_ate: pausadoAte })
    .select('id, telefone, motivo, pausado_ate, created_at')
    .single();
  if (error) throw new Error(`Supabase/pausarAtendimento: ${error.message}`);
  return data;
}

// ─── RASCUNHO DO PEDIDO ───────────────────────────────────────────────────────
// Fonte da verdade do estado do pedido. A etapa é SEMPRE recalculada pelo código.

async function carregarRascunho(telefone) {
  const { data } = await sb
    .from('pedido_rascunho')
    .select('*')
    .eq('telefone', telefone)
    .maybeSingle();
  return data || null;
}

// Rascunho esquecido trava a conversa: a cliente mandava uma foto dois dias
// depois e recebia de novo "Confira seu pedido". Vence após algumas horas, ou
// quando já existe um pedido mais novo dela (a atendente lançou pelo painel).
const VALIDADE_RASCUNHO_HORAS = Math.max(1, Number(process.env.VALIDADE_RASCUNHO_HORAS) || 6);

async function carregarRascunhoAtivo(telefone) {
  const r = await carregarRascunho(telefone);
  if (!r) return null;
  const atualizado = Date.parse(r.updated_at || 0);
  let motivo = Date.now() - atualizado > VALIDADE_RASCUNHO_HORAS * 3600_000 ? 'vencido' : null;
  if (!motivo && r.etapa_atual !== 'aguardando_pix') {
    const ids = await idsClientes(telefone);
    if (ids.length) {
      const { data } = await sb.from('pedidos').select('id')
        .in('cliente_id', ids).gt('created_at', new Date(atualizado).toISOString()).limit(1);
      if (data?.length) motivo = 'pedido lançado por outro canal';
    }
  }
  if (!motivo) return r;
  await limparRascunho(telefone);
  logger.info('rascunho/descartado', 'Rascunho antigo descartado', { telefone, motivo, etapa: r.etapa_atual });
  return null;
}

// Merge parcial de baixo nível: nunca apaga campo que não veio.
async function salvarRascunho(telefone, campos) {
  const update = { ...campos, updated_at: new Date().toISOString() };

  const { data: existing } = await sb
    .from('pedido_rascunho')
    .select('telefone')
    .eq('telefone', telefone)
    .maybeSingle();

  if (existing) {
    const { error } = await sb.from('pedido_rascunho').update(update).eq('telefone', telefone);
    if (error) throw new Error(`Supabase/salvarRascunho(update): ${error.message}`);
  } else {
    const { error } = await sb.from('pedido_rascunho').insert({ telefone, ...update });
    if (error) throw new Error(`Supabase/salvarRascunho(insert): ${error.message}`);
  }
}

// Alto nível: merge campos + valida itens + RECALCULA etapa determinística.
// Retorna { rascunho, avaliacao, naoEncontrados }.
async function atualizarRascunho(telefone, campos) {
  const atual = (await carregarRascunho(telefone)) || {};

  let naoEncontrados = [];
  const merge = { ...campos };

  // Se vierem itens, valida contra o catálogo (preço REAL, nome canônico)
  if (campos.itens !== undefined) {
    const { itens, naoEncontrados: nf } = await validarItens(campos.itens);
    merge.itens = JSON.stringify(itens);
    naoEncontrados = nf;
  }

  // Estado consolidado (atual + novos campos) para avaliar
  const consolidado = { ...atual, ...merge };
  const avaliacao = avaliarRascunho(consolidado);

  // Código decide a etapa — a LLM nunca seta isso
  merge.etapa_atual = avaliacao.etapa;

  await salvarRascunho(telefone, merge);

  const rascunho = await carregarRascunho(telefone);
  return { rascunho, avaliacao, naoEncontrados };
}

async function limparRascunho(telefone) {
  await sb.from('pedido_rascunho').delete().eq('telefone', telefone);
}

// ─── PRODUTOS / CARDÁPIO ──────────────────────────────────────────────────────

async function buscarProdutos() {
  const { data, error } = await sb
    .from('produtos')
    .select('id, nome, categoria, preco, preco_promocional, descricao, disponivel')
    .eq('disponivel', true)
    .order('categoria')
    .order('nome');
  if (error) throw new Error(`Supabase/buscarProdutos: ${error.message}`);
  return data || [];
}

function precoFinal(p) {
  return p.preco_promocional != null ? Number(p.preco_promocional) : Number(p.preco);
}

// Valida itens contra o catálogo: preço real, nome canônico, produto_id.
// Itens sem correspondência voltam em naoEncontrados (não são salvos).
async function validarItens(itensInput) {
  const produtos = await buscarProdutos();
  const itens = [];
  const naoEncontrados = [];

  for (const item of parseItens(itensInput)) {
    const alvo = normalizar(item.nome);
    if (!alvo) continue;

    let prod = produtos.find(p => normalizar(p.nome) === alvo);
    if (!prod) {
      prod = produtos.find(p => {
        const pn = normalizar(p.nome);
        return pn.includes(alvo) || alvo.includes(pn);
      });
    }

    if (!prod) {
      naoEncontrados.push(item.nome);
      continue;
    }

    itens.push({
      produto_id: prod.id,
      nome: prod.nome.trim(),
      quantidade: Math.max(1, Number(item.quantidade) || 1),
      preco_unitario: precoFinal(prod),
      observacao: item.observacao ? String(item.observacao).trim() : null,
    });
  }

  return { itens, naoEncontrados };
}

async function buscarMistura() {
  const { data, error } = await sb
    .from('misturas_do_dia')
    .select('titulo, descricao')
    .eq('ativo', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase/buscarMistura: ${error.message}`);
  return data || null;
}

async function buscarInfo() {
  const { data, error } = await sb.from('info_restaurante').select('chave, valor');
  if (error) throw new Error(`Supabase/buscarInfo: ${error.message}`);
  const info = {};
  for (const row of (data || [])) info[row.chave] = row.valor;
  return info;
}

async function getTaxaEntrega() {
  const info = await buscarInfo();
  const t = Number(info.taxa_entrega);
  return Number.isFinite(t) ? t : 5;
}

// ─── IDENTIDADE DO CLIENTE ────────────────────────────────────────────────────
// O cardápio grava o número com o 9 (5544999877146) e o WhatsApp entrega o JID
// no formato antigo (554499877146). São a MESMA pessoa: sem unificar, ela vira
// dois cadastros com 1 pedido cada — e aí a taxa de recompra dá 0%, o LTV sai
// pela metade e o CAC conta duas aquisições.
function variantesTelefone(num) {
  const d = String(num || '').replace(/\D/g, '');
  const vs = new Set([d]);
  const m = d.match(/^55(\d{2})(\d{8,9})$/);
  if (m) {
    const [, ddd, resto] = m;
    if (resto.length === 9 && resto[0] === '9') vs.add(`55${ddd}${resto.slice(1)}`);
    if (resto.length === 8) vs.add(`55${ddd}9${resto}`);
  }
  return [...vs];
}

// Procura o cliente por qualquer uma das formas do número.
async function acharClientePorTelefone(telefone) {
  const vs = variantesTelefone(telefone);
  const { data } = await sb
    .from('clientes')
    .select('id, total_pedidos, total_gasto, primeiro_pedido, telefone')
    .in('telefone', vs)
    .order('total_pedidos', { ascending: false })   // na dúvida, fica com o que tem histórico
    .limit(1);
  return data?.[0] || null;
}

// Pode haver dois cadastros da mesma pessoa (criados antes da unificação).
async function idsClientes(telefone) {
  const { data } = await sb.from('clientes').select('id').in('telefone', variantesTelefone(telefone));
  return (data || []).map(c => c.id);
}

// ─── ORIGEM / ATRIBUIÇÃO ──────────────────────────────────────────────────────

const JANELA_ANUNCIO_HORAS = 24;   // clique no anúncio ainda "vale" pelo pedido de hoje
const JANELA_RECOMPRA_DIAS = 7;    // oferta do agente ainda em pé quando o cliente volta

// Cria/atualiza o cliente já na PRIMEIRA mensagem vinda de anúncio, antes de
// existir pedido. Sem isso só dá pra contar quem comprou, e o funil perde a
// conta de quantos leads o anúncio trouxe e não converteram.
async function registrarOrigemAnuncio(telefone, pushName, anuncio) {
  const tel = String(telefone).replace(/\D/g, '');
  const patch = {
    veio_de_anuncio: true,
    anuncio_meta: anuncio,
    demonstrou_interesse_em: new Date().toISOString(),
  };

  const ex = await acharClientePorTelefone(tel);
  if (ex) {
    const { error } = await sb.from('clientes').update(patch).eq('id', ex.id);
    if (error) throw new Error(`Supabase/registrarOrigemAnuncio(update): ${error.message}`);
    return ex.id;
  }

  const { data, error } = await sb.from('clientes')
    .insert({ nome: pushName || 'Lead', telefone: tel, ...patch })
    .select('id').single();
  if (error) throw new Error(`Supabase/registrarOrigemAnuncio(insert): ${error.message}`);
  return data.id;
}

// De onde veio ESTE pedido. A ordem importa: uma oferta de recompra em aberto
// ganha do anúncio, senão a reativação seria creditada à mídia paga.
async function determinarCanal(clienteId) {
  if (!clienteId) return 'whatsapp_organico';

  const desde = new Date(Date.now() - JANELA_RECOMPRA_DIAS * 86400000).toISOString();
  const { data: ofertas } = await sb
    .from('ofertas_enviadas')
    .select('id')
    .eq('cliente_id', clienteId)
    .eq('converteu', false)
    .gte('enviado_em', desde)
    .limit(1);
  if (ofertas?.length) return 'recompra';

  const { data: cli } = await sb
    .from('clientes')
    .select('veio_de_anuncio, anuncio_meta, total_pedidos')
    .eq('id', clienteId)
    .maybeSingle();
  if (!cli) return 'whatsapp_organico';

  const recebidoEm = cli.anuncio_meta?.recebido_em;
  const cliqueRecente = recebidoEm &&
    (Date.now() - new Date(recebidoEm).getTime()) < JANELA_ANUNCIO_HORAS * 3600000;

  // Também conta o lead que demorou dias pra fechar a primeira compra.
  if (cliqueRecente || (cli.veio_de_anuncio && !cli.total_pedidos)) return 'whatsapp_anuncio';

  return 'whatsapp_organico';
}

// Fecha o ciclo da campanha: sem isso o agente de recompra nunca mostra ROI.
async function marcarOfertaConvertida(clienteId, pedidoId) {
  const desde = new Date(Date.now() - JANELA_RECOMPRA_DIAS * 86400000).toISOString();
  const { data: oferta } = await sb
    .from('ofertas_enviadas')
    .select('id')
    .eq('cliente_id', clienteId)
    .eq('converteu', false)
    .gte('enviado_em', desde)
    .order('enviado_em', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!oferta) return;
  await sb.from('ofertas_enviadas')
    .update({ converteu: true, pedido_convertido_id: pedidoId })
    .eq('id', oferta.id);
}

// ─── CLIENTES ─────────────────────────────────────────────────────────────────

async function buscarOuCriarCliente(nome, telefone, endereco) {
  const tel = String(telefone).replace(/\D/g, '');

  // Busca por todas as formas do número (com e sem o 9), senão o mesmo cliente
  // vindo do cardápio e do WhatsApp vira dois cadastros.
  const ex = await acharClientePorTelefone(tel);

  if (ex) {
    // Atualiza nome/endereço se vieram (cliente pode ter mudado)
    const patch = {};
    if (nome) patch.nome = nome;
    if (endereco) patch.endereco = endereco;
    if (Object.keys(patch).length) await sb.from('clientes').update(patch).eq('id', ex.id);
    return ex;
  }

  const { data, error } = await sb
    .from('clientes')
    .insert({ nome, telefone: tel, endereco: endereco || null, total_pedidos: 0, total_gasto: 0 })
    .select('id, total_pedidos, total_gasto, primeiro_pedido')
    .single();
  if (error) throw new Error(`Supabase/criarCliente: ${error.message}`);
  return data;
}

async function atualizarStatsCliente(cliente, totalPedido) {
  const agora = new Date().toISOString();
  const patch = {
    total_pedidos: (cliente.total_pedidos || 0) + 1,
    total_gasto: parseFloat(((cliente.total_gasto || 0) + totalPedido).toFixed(2)),
    ultimo_pedido: agora,
    data_ultima_interacao: agora,
  };
  if (!cliente.primeiro_pedido) patch.primeiro_pedido = agora;

  const { error } = await sb.from('clientes').update(patch).eq('id', cliente.id);
  if (error) throw new Error(`Supabase/atualizarStats: ${error.message}`);
}

// ─── PEDIDOS ──────────────────────────────────────────────────────────────────

async function criarPedidoCompleto({ nomeCliente, telefone, tipoEntrega, endereco, formaPagamento, itens, requisicao }) {
  const disponibilidade = avaliarFuncionamento(await buscarInfo());
  if (!disponibilidade.aberto) {
    const erro = new Error(disponibilidade.mensagem);
    erro.code = 'LOJA_FECHADA';
    throw erro;
  }
  const tel = String(telefone).replace(/\D/g, '');
  const listaItens = parseItens(itens);
  if (!listaItens.length) throw new Error('Pedido sem itens válidos.');

  if (formaPagamento === 'pix') {
    try {
      return await require('./pix').criarPedidoPix({ nomeCliente, telefone, tipoEntrega, endereco, itens: listaItens, requisicao });
    } catch (err) {
      // Sem o pix.sql a função não existe. Antes isso virava "tive um
      // probleminha" para todo pedido Pix; agora registra o pedido e a equipe
      // confere o comprovante como já fazia.
      if (!pixAssistidoAusente(err)) throw err;
      logger.warn('pix/sem-migracao', 'pix.sql não aplicado — pedido Pix registrado no fluxo direto', { telefone });
    }
  }
  const subtotal = calcularSubtotal(listaItens);
  const taxaConfig = await getTaxaEntrega();
  const taxaEntrega = tipoEntrega === 'delivery' ? taxaConfig : 0;
  const total = parseFloat((subtotal + taxaEntrega).toFixed(2));

  const cliente = await buscarOuCriarCliente(nomeCliente, tel, endereco);
  const canal = await determinarCanal(cliente.id);

  const { data: pedido, error: pErr } = await sb
    .from('pedidos')
    .insert({
      cliente_id: cliente.id,
      status: 'pendente',
      tipo_entrega: tipoEntrega,
      endereco_entrega: endereco || null,
      forma_pagamento: formaPagamento,
      subtotal,
      taxa_entrega: taxaEntrega,
      total,
      observacao: null,
      canal,
    })
    .select('id, numero_pedido, total')
    .single();
  if (pErr) {
    const erro = new Error(/LOJA_FECHADA/.test(pErr.message) ? (avaliarFuncionamento(await buscarInfo())).mensagem : 'Supabase/criarPedido: ' + pErr.message);
    if (/LOJA_FECHADA/.test(pErr.message)) erro.code = 'LOJA_FECHADA';
    throw erro;
  }

  if (canal === 'recompra') await marcarOfertaConvertida(cliente.id, pedido.id);

  const rows = listaItens.map(i => ({
    pedido_id: pedido.id,
    produto_id: i.produto_id || null,
    nome_produto: i.nome,
    quantidade: Number(i.quantidade),
    preco_unitario: Number(i.preco_unitario),
    observacao: i.observacao || null,
    total: parseFloat((Number(i.preco_unitario) * Number(i.quantidade)).toFixed(2)),
  }));
  const { error: iErr } = await sb.from('itens_pedido').insert(rows);
  if (iErr) throw new Error(`Supabase/criarItens: ${iErr.message}`);

  await atualizarStatsCliente(cliente, total);

  return { numeroPedido: pedido.numero_pedido, total, subtotal, taxaEntrega, formaPagamento };
}

function pixAssistidoAusente(err) {
  return ['PGRST202', '42883', 'PGRST205'].includes(err?.code) ||
    /could not find the function|function .* does not exist|schema cache/i.test(err?.message || '');
}

// Últimos pedidos do cliente, para responder "meu pedido já saiu?" sem chamar
// a atendente (eram boa parte dos encaminhamentos).
async function consultarPedidosRecentes(telefone, horas = 24) {
  const ids = await idsClientes(telefone);
  if (!ids.length) return [];
  const { data, error } = await sb.from('pedidos')
    .select('id, numero_pedido, status, tipo_entrega, forma_pagamento, total, observacao, created_at, updated_at, itens_pedido(nome_produto, quantidade)')
    .in('cliente_id', ids)
    .gte('created_at', new Date(Date.now() - horas * 3600_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(3);
  if (error) throw new Error(`Supabase/consultarPedidos: ${error.message}`);
  return data || [];
}

const STATUS_ENCERRADOS = ['entregue', 'cancelado'];

// Pedido do cliente ainda em andamento (cardápio, WhatsApp ou painel).
async function pedidosEmAndamento(telefone, horas = 6) {
  return (await consultarPedidosRecentes(telefone, horas))
    .filter(p => !STATUS_ENCERRADOS.includes(String(p.status).toLowerCase()));
}

// Sem o pix.sql não há tela de conferência: o comprovante que chega no
// WhatsApp fica anotado no próprio pedido, que a equipe já vê no painel.
async function anotarComprovantePix(pedido, leitura) {
  const hora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const nota = `Comprovante Pix recebido no WhatsApp às ${hora} — conferir na conta${leitura ? ` (leitura: ${String(leitura).slice(0, 140)})` : ''}`;
  const observacao = [pedido.observacao, nota].filter(Boolean).join(' · ');
  const { error } = await sb.from('pedidos').update({ observacao }).eq('id', pedido.id);
  if (error) throw new Error(`Supabase/anotarComprovante: ${error.message}`);
}

async function atualizarStatusPedido(telefone, novoStatus) {
  const ids = await idsClientes(telefone);
  if (!ids.length) throw new Error('Cliente não encontrado.');

  // select('*'): pix_status só existe depois do pix.sql; pedir a coluna pelo
  // nome derrubava o cancelamento pelo WhatsApp em bancos sem a migração.
  const { data: pedidos, error } = await sb
    .from('pedidos')
    .select('*')
    .in('cliente_id', ids)
    .eq('status', 'pendente')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Supabase/buscarPedidoPendente: ${error.message}`);
  if (!pedidos?.length) throw new Error('Nenhum pedido pendente encontrado para este cliente.');

  const pedido = pedidos[0];
  if (novoStatus !== 'cancelado' && 'pix_status' in pedido && String(pedido.forma_pagamento).toLowerCase() === 'pix' && pedido.pix_status !== 'confirmado') throw new Error('O Pix precisa da conferência do recebimento pela equipe antes de liberar o preparo.');
  const { error: uErr } = await sb.from('pedidos').update({ status: novoStatus }).eq('id', pedido.id);
  if (uErr) throw new Error(`Supabase/atualizarStatus: ${uErr.message}`);

  return pedido;
}

// ─── CONVERSAS QUE NÃO SÃO DE CLIENTE ─────────────────────────────────────────
// O número da loja também é usado pela equipe com fornecedores, motoboys e
// família. O agente respondia "Pedido confirmado: 20 pães" para a padaria.

const JANELA_CONVERSA_HORAS = 12;
const GAP_CONVERSA_MS = JANELA_CONVERSA_HORAS * 3600_000;

// Conversa que a LOJA começou (atendente mandou a primeira mensagem) é da
// equipe: fornecedor, motoboy, ou a atendente já cuidando de um cliente
// ("qual o número da sua casa?"). Nos dois casos o agente não entra.
async function conversaIniciadaPelaLoja(telefone) {
  const { data, error } = await sb.from('n8n_chat_histories')
    .select('origem, created_at')
    .in('session_id', variantesTelefone(telefone))
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`Supabase/inicioConversa: ${error.message}`);
  if (!data?.length || Date.now() - Date.parse(data[0].created_at) > GAP_CONVERSA_MS) return false;
  let inicio = data[0];
  for (let i = 1; i < data.length; i++) {
    if (Date.parse(data[i - 1].created_at) - Date.parse(data[i].created_at) > GAP_CONVERSA_MS) break;
    inicio = data[i];
  }
  return inicio.origem === 'humano';
}

// Quando a mensagem da loja é a primeira em 12h, ela está COMEÇANDO a conversa.
async function semConversaRecente(telefone) {
  const { data } = await sb.from('n8n_chat_histories').select('created_at')
    .in('session_id', variantesTelefone(telefone))
    .order('created_at', { ascending: false }).limit(1);
  return !data?.length || Date.now() - Date.parse(data[0].created_at) > GAP_CONVERSA_MS;
}

// Lista mantida pela equipe (tabela contatos_ignorados) + TELEFONES_IGNORADOS.
// Esses números não passam pela IA nem são gravados: são conversas pessoais.
let cacheIgnorados = { ts: 0, telefones: new Set() };
async function contatoIgnorado(telefone) {
  if (Date.now() - cacheIgnorados.ts > 60_000) {
    const telefones = new Set();
    const brutos = String(process.env.TELEFONES_IGNORADOS || '').split(',');
    const { data, error } = await sb.from('contatos_ignorados').select('telefone');
    if (!error) for (const c of data || []) brutos.push(c.telefone);
    for (const t of brutos) for (const v of variantesTelefone(t)) if (v) telefones.add(v);
    cacheIgnorados = { ts: Date.now(), telefones };
  }
  return variantesTelefone(telefone).some(v => cacheIgnorados.telefones.has(v));
}

// Respostas que a equipe já deu e o agente não sabia (reserva, bolo, frango
// misto...). Editável no Supabase sem mexer no código.
let cacheFaq = { ts: 0, itens: [] };
async function carregarFaq() {
  if (Date.now() - cacheFaq.ts > 300_000) {
    const { data, error } = await sb.from('faq_atendimento').select('pergunta, resposta')
      .eq('ativo', true).order('ordem', { ascending: true });
    cacheFaq = { ts: Date.now(), itens: error ? [] : (data || []) };
  }
  return cacheFaq.itens;
}

// Mensagens das últimas horas nesta conversa (mais nova primeiro).
async function mensagensRecentes(telefone, horas) {
  const { data, error } = await sb.from('n8n_chat_histories')
    .select('origem, etapa_pedido, created_at')
    .in('session_id', variantesTelefone(telefone))
    .gte('created_at', new Date(Date.now() - horas * 3600_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) throw new Error(`Supabase/mensagensRecentes: ${error.message}`);
  return data || [];
}

// Avisos de status vão para o telefone do pedido (com o 9); gravamos na
// conversa em que o cliente realmente fala, para o agente enxergar o pedido.
async function sessaoDoContato(telefone) {
  const { data } = await sb.from('n8n_chat_histories').select('session_id')
    .in('session_id', variantesTelefone(telefone)).eq('origem', 'cliente')
    .order('created_at', { ascending: false }).limit(1);
  return data?.[0]?.session_id || String(telefone).replace(/\D/g, '');
}

// ─── LOJA ABERTA PELA AGENDA ──────────────────────────────────────────────────
let reaberturaIndisponivel = false;
async function reabrirLojaSeEsquecida(agora = new Date()) {
  if (reaberturaIndisponivel) return null;
  const { data, error } = await sb.from('info_restaurante')
    .select('valor, atualizado_em').eq('chave', 'loja_aberta').maybeSingle();
  if (error) {
    if (/atualizado_em/.test(error.message)) {
      reaberturaIndisponivel = true;
      logger.warn('loja/reabertura', 'Reabertura automática desligada: rode atendimento.sql', {});
    }
    return null;
  }
  if (!data || !deveReabrir(await buscarInfo(), data.atualizado_em, agora)) return null;
  const { data: mudou, error: e2 } = await sb.from('info_restaurante')
    .update({ valor: 'true' }).eq('chave', 'loja_aberta').eq('valor', 'false').select('chave');
  if (e2) throw new Error(`Supabase/reabrirLoja: ${e2.message}`);
  return mudou?.length ? { fechadaEm: data.atualizado_em } : null;
}

module.exports = {
  sb,
  carregarRascunhoAtivo, consultarPedidosRecentes, pedidosEmAndamento, anotarComprovantePix,
  conversaIniciadaPelaLoja, semConversaRecente,
  contatoIgnorado, carregarFaq, mensagensRecentes, sessaoDoContato, reabrirLojaSeEsquecida,
  variantesTelefone, idsClientes,
  carregarHistorico, salvarMensagem,
  carregarPausaAtiva, pausarAtendimento,
  carregarRascunho, salvarRascunho, atualizarRascunho, limparRascunho,
  buscarProdutos, validarItens, buscarMistura, buscarInfo, getTaxaEntrega,
  buscarOuCriarCliente, criarPedidoCompleto, atualizarStatusPedido, mensagemJaRegistrada,
  registrarOrigemAnuncio, determinarCanal, marcarOfertaConvertida,
};
