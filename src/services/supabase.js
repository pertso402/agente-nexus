'use strict';

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { normalizar, parseItens, avaliarRascunho, calcularSubtotal } = require('../utils/pedido');

const sb = createClient(
  process.env.SUPA_URL,
  process.env.SUPA_SERVICE_KEY,
  { realtime: { transport: ws } }
);

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

async function salvarMensagem(telefone, role, content) {
  const { error } = await sb.from('n8n_chat_histories').insert({
    session_id: telefone,
    message: JSON.stringify({ role, content, ts: Date.now() }),
  });
  if (error) throw new Error(`Supabase/salvarMensagem: ${error.message}`);
}

async function carregarRascunho(telefone) {
  const { data } = await sb
    .from('pedido_rascunho')
    .select('*')
    .eq('telefone', telefone)
    .maybeSingle();
  return data || null;
}

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

async function atualizarRascunho(telefone, campos) {
  const atual = (await carregarRascunho(telefone)) || {};

  let naoEncontrados = [];
  const merge = { ...campos };

  if (campos.itens !== undefined) {
    const { itens, naoEncontrados: nf } = await validarItens(campos.itens);
    merge.itens = JSON.stringify(itens);
    naoEncontrados = nf;
  }

  const consolidado = { ...atual, ...merge };
  const avaliacao = avaliarRascunho(consolidado);

  merge.etapa_atual = avaliacao.etapa;

  await salvarRascunho(telefone, merge);

  const rascunho = await carregarRascunho(telefone);
  return { rascunho, avaliacao, naoEncontrados };
}

async function limparRascunho(telefone) {
  await sb.from('pedido_rascunho').delete().eq('telefone', telefone);
}

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
  return Number.isFinite(t) ? t : 7;
}

async function buscarOuCriarCliente(nome, telefone, endereco) {
  const tel = String(telefone).replace(/\D/g, '');

  const { data: ex } = await sb
    .from('clientes')
    .select('id, total_pedidos, total_gasto, primeiro_pedido')
    .eq('telefone', tel)
    .maybeSingle();

  if (ex) {
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

async function verificarCupom(codigo, clienteId) {
  const { data, error } = await sb
    .from('cupons')
    .select('id, desconto_percentual, valido_ate, usado')
    .eq('codigo', codigo.toUpperCase().trim())
    .maybeSingle();

  if (error) throw new Error(`Supabase/verificarCupom: ${error.message}`);
  if (!data) return { valido: false, motivo: 'Cupom não encontrado.' };
  if (data.usado) return { valido: false, motivo: 'Cupom já foi utilizado.' };
  if (new Date(data.valido_ate) < new Date()) return { valido: false, motivo: 'Cupom expirado.' };

  return { valido: true, cupomId: data.id, desconto_percentual: data.desconto_percentual };
}

async function criarPedidoCompleto({ nomeCliente, telefone, tipoEntrega, endereco, formaPagamento, itens, cupomCodigo }) {
  const tel = String(telefone).replace(/\D/g, '');
  const listaItens = parseItens(itens);
  if (!listaItens.length) throw new Error('Pedido sem itens válidos.');

  const subtotal = calcularSubtotal(listaItens);
  const taxaConfig = await getTaxaEntrega();
  const taxaEntrega = tipoEntrega === 'delivery' ? taxaConfig : 0;

  let desconto = 0;
  let cupomId = null;

  if (cupomCodigo) {
    const cliente = await buscarOuCriarCliente(nomeCliente, tel, endereco);
    const validacao = await verificarCupom(cupomCodigo, cliente.id);
    if (validacao.valido) {
      cupomId = validacao.cupomId;
      desconto = parseFloat((subtotal * validacao.desconto_percentual / 100).toFixed(2));
    }
  }

  const total = parseFloat((subtotal + taxaEntrega - desconto).toFixed(2));

  const cliente = await buscarOuCriarCliente(nomeCliente, tel, endereco);

  const { data: pedido, error: pErr } = await sb
    .from('pedidos')
    .insert({
      cliente_id: cliente.id,
      status: 'confirmado',
      tipo_entrega: tipoEntrega,
      endereco_entrega: endereco || null,
      forma_pagamento: formaPagamento,
      subtotal,
      taxa_entrega: taxaEntrega,
      desconto,
      total,
      cupom_id: cupomId,
      observacao: null,
    })
    .select('id, numero_pedido, total')
    .single();
  if (pErr) throw new Error(`Supabase/criarPedido: ${pErr.message}`);

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

  // Marcar cupom como usado
  if (cupomId) {
    await sb.from('cupons').update({ usado: true, pedido_id: pedido.id }).eq('id', cupomId);
  }

  await atualizarStatsCliente(cliente, total);

  return { numeroPedido: pedido.numero_pedido, total, subtotal, taxaEntrega, desconto, formaPagamento };
}

async function atualizarStatusPedido(telefone, novoStatus) {
  const tel = String(telefone).replace(/\D/g, '');

  const { data: cli } = await sb.from('clientes').select('id').eq('telefone', tel).maybeSingle();
  if (!cli?.id) throw new Error('Cliente não encontrado.');

  const { data: pedidos, error } = await sb
    .from('pedidos')
    .select('id, numero_pedido, total')
    .eq('cliente_id', cli.id)
    .in('status', ['confirmado', 'pendente'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Supabase/buscarPedido: ${error.message}`);
  if (!pedidos?.length) throw new Error('Nenhum pedido encontrado para este cliente.');

  const pedido = pedidos[0];
  const { error: uErr } = await sb.from('pedidos').update({ status: novoStatus }).eq('id', pedido.id);
  if (uErr) throw new Error(`Supabase/atualizarStatus: ${uErr.message}`);

  return pedido;
}

module.exports = {
  carregarHistorico, salvarMensagem,
  carregarRascunho, salvarRascunho, atualizarRascunho, limparRascunho,
  buscarProdutos, validarItens, buscarMistura, buscarInfo, getTaxaEntrega,
  buscarOuCriarCliente, criarPedidoCompleto, atualizarStatusPedido, verificarCupom,
};
