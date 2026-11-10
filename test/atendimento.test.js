'use strict';
// Regras do atendimento, testadas com frases que chegaram de verdade no WhatsApp.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const { apenasSaudacao, ehConfirmacao, chavePixValida } = require('../src/utils/texto');
const { proximaAbertura, deveReabrir } = require('../src/utils/funcionamento');

test('saudação pura x mensagem que precisa de resposta', () => {
  for (const t of ['Oi', 'Boa noite', 'Oi\nBoa noite', 'Boa noite, tudo bem?', 'Olá boa tarde', 'Oiie\nTudo bem',
    'helloowwww', 'Bom dia.', 'Oii', '🍻', '🎙️ [Áudio]: Boa noite']) {
    assert.equal(apenasSaudacao(t), true, t);
  }
  for (const t of ['Bom dia, vcs entregam ?', 'Boa noite vocês não está atendendo hoje',
    'Boa noite!! Gostaria de saber se vocês aceitam ticket alimentação?', 'Olá … vcs tem cardápio ?',
    'Boa tarde vocês estão contratando auxiliar de cozinha', 'Tem tábua de frios?', '📎 [Imagem]: foto de uma pizza']) {
    assert.equal(apenasSaudacao(t), false, t);
  }
});

test('confirmação do resumo aceita lote agrupado e recusa mudança', () => {
  for (const t of ['Sim', 'SIM', 'sim!', 'Sim\nPode fechar', 'Pode fechar', 'Isso mesmo', 'ok pode confirmar',
    'Sim, pode mandar', 'Confirmo', 'Fechado', '👍', 'Sim por favor']) {
    assert.equal(ehConfirmacao(t), true, t);
  }
  for (const t of ['Dinheiro\nNão precisa de troco', 'Sim mas tira a cebola', 'Não', 'Quero mudar o endereço',
    'Aguardo', 'Obrigada', 'Com quem eu falo', '']) {
    assert.equal(ehConfirmacao(t), false, t);
  }
});

test('chave Pix de exemplo nunca vale como chave', () => {
  assert.equal(chavePixValida('PENDENTE-chave-pix'), false);
  assert.equal(chavePixValida(''), false);
  assert.equal(chavePixValida(null), false);
  assert.equal(chavePixValida('02668346000198'), true);
  assert.equal(chavePixValida('contato@loja.com.br'), true);
});

test('próxima abertura responde o "abrem hoje?"', () => {
  assert.equal(proximaAbertura({}, new Date('2026-10-26T20:29:00Z')).texto, 'Abrimos hoje às 17h30.');      // seg 17:29
  assert.equal(proximaAbertura({}, new Date('2026-10-27T02:30:00Z')).texto, 'Abrimos amanhã às 17h30.');    // seg 23:30
  assert.equal(proximaAbertura({}, new Date('2026-10-25T15:00:00Z')).texto, 'Abrimos amanhã às 17h30.');     // dom
  assert.equal(proximaAbertura({}, new Date('2026-10-25T02:30:00Z')).texto, 'Abrimos na segunda às 17h30.'); // sáb 23:30
  assert.equal(proximaAbertura({}, new Date('2026-10-24T02:30:00Z')).texto, 'Abrimos amanhã às 11h.');      // sex 23:30 → sáb
  assert.equal(proximaAbertura({ horarios_funcionamento: '{}' }), null);
});

test('reabertura automática: só quando fecharam em outro dia e é horário de abrir', () => {
  const fechada = { loja_aberta: 'false' };
  const seg1730 = new Date('2026-10-26T20:30:00Z');
  assert.equal(deveReabrir(fechada, '2026-10-25T02:10:00Z', seg1730), true);   // fechou sábado à noite
  assert.equal(deveReabrir(fechada, '2026-10-26T15:00:00Z', seg1730), false);  // fechou hoje cedo (folga)
  assert.equal(deveReabrir(fechada, '2026-10-25T02:10:00Z', new Date('2026-10-26T18:00:00Z')), false); // antes de abrir
  assert.equal(deveReabrir({ loja_aberta: 'true' }, '2026-10-20T00:00:00Z', seg1730), false);
  assert.equal(deveReabrir(fechada, null, seg1730), false);
});

test('atendimento.sql: idempotente, data só muda com valor e tabelas fora da chave pública', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.info_restaurante (id serial PRIMARY KEY, chave text UNIQUE, valor text);
      INSERT INTO public.info_restaurante (chave, valor) VALUES ('loja_aberta', 'true');`);
    const sql = fs.readFileSync(path.join(__dirname, '../atendimento.sql'), 'utf8');
    await pg.exec(sql); await pg.exec(sql);
    // o gatilho não deixa mexer na data à mão; desliga só para montar o cenário
    await pg.exec("ALTER TABLE public.info_restaurante DISABLE TRIGGER info_restaurante_atualizado_em; UPDATE public.info_restaurante SET atualizado_em = '2026-10-01'; ALTER TABLE public.info_restaurante ENABLE TRIGGER info_restaurante_atualizado_em;");
    await pg.exec("UPDATE public.info_restaurante SET valor = 'true' WHERE chave = 'loja_aberta'");
    let r = (await pg.query("SELECT atualizado_em FROM public.info_restaurante WHERE chave = 'loja_aberta'")).rows[0];
    assert.equal(new Date(r.atualizado_em).toISOString().slice(0, 10), '2026-10-01');   // mesmo valor: não mexe
    await pg.exec("UPDATE public.info_restaurante SET valor = 'false' WHERE chave = 'loja_aberta'");
    r = (await pg.query("SELECT atualizado_em FROM public.info_restaurante WHERE chave = 'loja_aberta'")).rows[0];
    assert.ok(Date.now() - new Date(r.atualizado_em) < 60_000);
    assert.ok((await pg.query('SELECT count(*)::int AS n FROM public.faq_atendimento')).rows[0].n >= 8);
    const acesso = (await pg.query(`SELECT
      has_table_privilege('anon', 'public.contatos_ignorados', 'SELECT') AS contatos,
      has_table_privilege('anon', 'public.faq_atendimento', 'SELECT') AS faq`)).rows[0];
    assert.deepEqual(acesso, { contatos: false, faq: false });
    await assert.rejects(pg.exec("INSERT INTO public.contatos_ignorados (telefone) VALUES ('(44) 9999-0000')"));
  } finally { await pg.close(); }
});

function carregarTools(db, info = {}) {
  const arquivo = path.join(__dirname, '../src/tools/index.js');
  const requireReal = createRequire(arquivo);
  const modulo = { exports: {} };
  vm.runInNewContext(fs.readFileSync(arquivo, 'utf8'), {
    module: modulo, Date,
    require: nome => nome === '../services/supabase' ? { buscarInfo: async () => info, ...db } : requireReal(nome),
  }, { filename: arquivo });
  return modulo.exports;
}

test('consultar_pedido responde a situação na linguagem do cliente', async () => {
  const minutosAtras = m => new Date(Date.now() - m * 60_000).toISOString();
  const { executarTool, TOOLS } = carregarTools({
    consultarPedidosRecentes: async () => [
      { numero_pedido: 82, status: 'saiu_entrega', tipo_entrega: 'retirada', total: 85, created_at: minutosAtras(15),
        updated_at: minutosAtras(2), itens_pedido: [{ quantidade: 1, nome_produto: 'Frango Frito Especial (G)' }] },
    ],
  });
  assert.ok(TOOLS.some(t => t.function.name === 'consultar_pedido'));
  const r = JSON.parse(await executarTool('consultar_pedido', {}, { telefone: '554488060996' }));
  assert.equal(r.pedidos[0].situacao, 'pronto para retirada');
  assert.equal(r.pedidos[0].feito_ha_minutos, 15);
  assert.deepEqual(r.pedidos[0].itens, ['1x Frango Frito Especial (G)']);
  // número que não é deste WhatsApp não vaza o pedido de outra pessoa
  assert.match(await executarTool('consultar_pedido', { numero_pedido: 81 }, { telefone: '554488060996' }), /Nenhum pedido/);
});

test('info_restaurante não repassa chave Pix de exemplo', async () => {
  const { executarTool } = carregarTools({}, { chave_pix: 'PENDENTE-chave-pix', loja_aberta: 'true' });
  assert.equal(JSON.parse(await executarTool('info_restaurante', {}, {})).chave_pix, null);
});

// ─── confirmar_pedido: a IA reconhece o aceite, o código fecha ───────────────
function carregarAgenteComRespostas(respostas, executadas = []) {
  const arquivo = path.join(__dirname, '../src/agent.js');
  const requireReal = createRequire(arquivo);
  const pedidos = [];
  class OpenAIMock {
    constructor() { this.chat = { completions: { create: async (p) => { pedidos.push(p); return respostas.shift(); } } }; }
  }
  const real = carregarTools({});
  const mocks = {
    openai: OpenAIMock,
    './tools': { TOOLS: real.TOOLS, TOOL_CONFIRMAR: real.TOOL_CONFIRMAR, executarTool: async (nome) => { executadas.push(nome); return '{"salvo":true}'; } },
    './services/supabase': {}, './utils/retry': { comRetry: fn => fn() },
    './logger': { step() {}, info() {}, warn() {}, error() {} },
  };
  const modulo = { exports: {} };
  vm.runInNewContext(fs.readFileSync(arquivo, 'utf8'), { module: modulo, require: n => Object.hasOwn(mocks, n) ? mocks[n] : requireReal(n), process: { env: {} } }, { filename: arquivo });
  return { ...modulo.exports, pedidos };
}
const chamada = (name, id = 'c1') => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] } }], usage: {} });
const texto = t => ({ choices: [{ finish_reason: 'stop', message: { content: t } }], usage: {} });
const PRONTO = { etapa_atual: 'aguardando_confirmacao', nome_cliente: 'Eduardo', tipo_entrega: 'retirada', forma_pagamento: 'pix', itens: '[{"nome":"Frango Frito Especial (G)","quantidade":1,"preco_unitario":85}]' };
const ferramentas = p => p.tools.map(t => t.function.name);

test('confirmar_pedido só existe com o resumo pronto e devolve confirmar ao código', async () => {
  const a = carregarAgenteComRespostas([chamada('confirmar_pedido')]);
  const r = await a.rodarAgente('[Cliente: Eduardo]\nConfirmei com a patroa', [], PRONTO, 't', '554499000000');
  assert.equal(r.confirmar, true); assert.equal(r.texto, '');
  assert.ok(ferramentas(a.pedidos[0]).includes('confirmar_pedido'));
  const b = carregarAgenteComRespostas([texto('Qual tamanho?')]);
  await b.rodarAgente('Quero frango', [], { ...PRONTO, etapa_atual: 'coletando_dados' }, 't', '554499000000');
  assert.ok(!ferramentas(b.pedidos[0]).includes('confirmar_pedido'));
});

test('pedido alterado na mesma mensagem não fecha: a IA tem que mostrar o resumo novo', async () => {
  const executadas = [];
  const a = carregarAgenteComRespostas([chamada('salvar_dados_pedido', 'c1'), chamada('confirmar_pedido', 'c2'), texto('Atualizei: só peito. Confirma?')], executadas);
  const r = await a.rodarAgente('Peito mesmo, pode mandar', [], PRONTO, 't', '554499000000');
  assert.notEqual(r.confirmar, true);
  assert.equal(r.texto, 'Atualizei: só peito. Confirma?');
  assert.deepEqual(executadas, ['salvar_dados_pedido']);
  assert.match(a.pedidos[2].messages.at(-1).content, /alterado nesta mensagem/);
});

test('mensagem de pedido fechado: cartão com itens e prazo; Pix sem chave avisa a equipe', () => {
  const { mensagensPedidoFechado } = require('../src/utils/mensagens');
  const rascunho = { tipo_entrega: 'retirada', itens: [{ nome: 'Tábua De Frios (G)', quantidade: 2, preco_unitario: 102 }] };
  const cartao = mensagensPedidoFechado({ resultado: { numeroPedido: 9, subtotal: 204, taxaEntrega: 0, total: 204, formaPagamento: 'cartao' }, rascunho, prazo: '~20 minutinhos', nome: 'Ivete Nunes' });
  assert.equal(cartao.mensagens.length, 1);
  assert.match(cartao.mensagens[0], /2x Tábua De Frios \(G\) — R\$ 204,00/);
  assert.match(cartao.mensagens[0], /Retirada no local/); assert.match(cartao.mensagens[0], /Bom apetite, Ivete!/);
  assert.doesNotMatch(cartao.mensagens[0], /Taxa de entrega/);
  const semChave = mensagensPedidoFechado({ resultado: { numeroPedido: 9, subtotal: 204, taxaEntrega: 0, total: 204, formaPagamento: 'pix' }, rascunho, info: { chave_pix: 'PENDENTE-chave-pix' } });
  assert.equal(semChave.semChave, true); assert.equal(semChave.mensagens.length, 1);
  assert.doesNotMatch(semChave.mensagens[0], /PENDENTE/);
});

test('aceites reais depois do resumo', () => {
  for (const t of ['Pix\nAgora\nManda aí', 'Confirmei', 'Pode mandar a chave', 'manda o pix']) assert.equal(ehConfirmacao(t), true, t);
  for (const t of ['Pix', 'Esse mesmo\nManda o pix\nPeito mesmo', 'Quanto tempo?']) assert.equal(ehConfirmacao(t), false, t);
});
