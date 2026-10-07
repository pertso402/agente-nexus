'use strict';

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { normalizar, parseItens, avaliarRascunho, calcularSubtotal } = require('../utils/pedido');
const logger = require('../logger');

const sb = createClient(
  process.env.SUPA_URL,
  process.env.SUPA_SERVICE_KEY,
  { realtime: { transport: ws } }
);

// ─── HISTÓRICO DE CONVERSA ────────────────────────────────────────────────────

async function carregarHistorico(telefone, limite = 16) {
  const { data, error } = await sb
    .from('n8n_chat_histories')
    .select('message')
    .eq('session_id', telefone)
    .order('created_at', { ascending: true })
    .limit(limite);

  if (error) throw new Error(`Supabase/carregarHistorico: ${error.message}`);

  return (data || [])
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

async function criarPedidoCompleto({ nomeCliente, telefone, tipoEntrega, endereco, formaPagamento, itens }) {
  const tel = String(telefone).replace(/\D/g, '');
  const listaItens = parseItens(itens);
  if (!listaItens.length) throw new Error('Pedido sem itens válidos.');

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
  if (pErr) throw new Error(`Supabase/criarPedido: ${pErr.message}`);

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

async function atualizarStatusPedido(telefone, novoStatus) {
  const tel = String(telefone).replace(/\D/g, '');

  const { data: cli } = await sb.from('clientes').select('id').eq('telefone', tel).maybeSingle();
  if (!cli?.id) throw new Error('Cliente não encontrado.');

  const { data: pedidos, error } = await sb
    .from('pedidos')
    .select('id, numero_pedido, total')
    .eq('cliente_id', cli.id)
    .eq('status', 'pendente')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Supabase/buscarPedidoPendente: ${error.message}`);
  if (!pedidos?.length) throw new Error('Nenhum pedido pendente encontrado para este cliente.');

  const pedido = pedidos[0];
  const { error: uErr } = await sb.from('pedidos').update({ status: novoStatus }).eq('id', pedido.id);
  if (uErr) throw new Error(`Supabase/atualizarStatus: ${uErr.message}`);

  return pedido;
}

module.exports = {
  carregarHistorico, salvarMensagem,
  carregarRascunho, salvarRascunho, atualizarRascunho, limparRascunho,
  buscarProdutos, validarItens, buscarMistura, buscarInfo, getTaxaEntrega,
  buscarOuCriarCliente, criarPedidoCompleto, atualizarStatusPedido, mensagemJaRegistrada,
  registrarOrigemAnuncio, determinarCanal, marcarOfertaConvertida,
};
