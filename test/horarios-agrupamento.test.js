'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { avaliarFuncionamento, PADRAO } = require('../src/utils/horarios');
const { criarAgrupador } = require('../src/utils/agrupador');
const { proximaAbertura } = require('../src/utils/funcionamento');
const cfg = require('../src/config/restaurante');
const { PGlite } = require('@electric-sql/pglite');

const datas = [
  ['2026-10-12T20:29:59Z', false], ['2026-10-12T20:30:00Z', true],
  ['2026-10-13T01:59:59Z', true], ['2026-10-13T02:00:00Z', false],
  ['2026-10-16T20:30:00Z', true], ['2026-10-17T13:59:59Z', false],
  ['2026-10-17T14:00:00Z', true], ['2026-10-18T01:59:59Z', true],
  ['2026-10-18T02:00:00Z', false], ['2026-10-18T15:00:00Z', false],
];
test('expediente usa São Paulo, incluindo abertura, fechamento e domingo', () => {
  for (const [data, esperado] of datas) assert.equal(avaliarFuncionamento({}, new Date(data)).aberto, esperado, data);
  assert.equal(avaliarFuncionamento({ loja_aberta: 'false' }, new Date('2026-10-17T15:00:00Z')).aberto, false);
});
test('configuração do banco prevalece e configuração inválida fecha a loja', () => {
  const dias = structuredClone(PADRAO); dias[0] = [['09:00', '12:00']];
  assert.equal(avaliarFuncionamento({ horarios_funcionamento: JSON.stringify(dias) }, new Date('2026-10-18T13:00:00Z')).aberto, true);
  for (const valor of ['{', '{}', JSON.stringify({ ...PADRAO, 1: [['18:00','17:00']] }), JSON.stringify({ ...PADRAO, 1: [['25:00','26:00']] })]) {
    assert.equal(avaliarFuncionamento({ horarios_funcionamento: valor }).aberto, false);
  }
});
function relogio() {
  let agora = 0, id = 0;
  const tarefas = new Map();
  return {
    agora: () => agora,
    agendar: (fn, ms) => { tarefas.set(++id, { fn, ate: agora + ms }); return id; },
    cancelar: id => tarefas.delete(id),
    async avancar(ms) {
      agora += ms;
      for (const [id, tarefa] of [...tarefas]) if (tarefa.ate <= agora) { tarefas.delete(id); await tarefa.fn(); }
    },
  };
}
test('espera 10 segundos após a última mensagem, separando conversas', async () => {
  const clock = relogio(), lotes = [];
  const fila = criarAgrupador({ ...clock, processar: async lote => lotes.push(lote) });
  fila.adicionar('a', 'Oi'); await clock.avancar(9000);
  fila.adicionar('a', 'Quero pizza'); fila.adicionar('b', 'Olá');
  await clock.avancar(9999); assert.equal(lotes.length, 0);
  await clock.avancar(1); assert.deepEqual(lotes, [['Oi', 'Quero pizza'], ['Olá']]);
});
test('uma conversa não processa dois lotes simultaneamente e continua após falhas', async () => {
  const clock = relogio(), lotes = []; let liberar;
  const fila = criarAgrupador({ ...clock, processar: async lote => { lotes.push(lote); if (lotes.length === 1) await new Promise(r => { liberar = r; }); else if (lotes.length === 2) throw new Error('falha simulada'); } });
  fila.adicionar('a', 1); const primeiro = clock.avancar(10000);
  fila.adicionar('a', 2); await clock.avancar(10000); assert.equal(lotes.length, 1);
  liberar(); await primeiro; await clock.avancar(0); assert.deepEqual(lotes, [[1], [2]]);
  fila.adicionar('a', 3); await clock.avancar(10000); assert.deepEqual(lotes, [[1], [2], [3]]);
});
function webhookFixture(data = '2026-10-15T21:00:00Z') {
  const arquivo = path.join(__dirname, '../src/index.js'), requireReal = createRequire(arquivo);
  const clock = relogio(), salvas = [], envios = [], agentes = [], criados = [], pausas = [];
  const ignorados = new Set();
  let handler, pausa = null, info = {}, rascunho = null, onAgente = null, daLoja = false, andamento = [];
  let imagem = { isComprovante: false, analise: 'Imagem de teste' };
  const anotados = [];
  let resposta = () => ({ texto: 'Resposta única' });
  let confirmar = async () => { throw new Error('Não deveria confirmar'); };
  const db = {
    buscarInfo: async () => info,
    carregarHistorico: async () => salvas.map(e => ({ role: e.role, content: e.content })),
    salvarMensagem: async (telefone, role, content, meta) => { salvas.push({ telefone, role, content, meta }); return true; },
    carregarPausaAtiva: async () => pausa,
    pausarAtendimento: async (_tel, motivo) => { pausas.push(motivo); pausa = { pausado_ate: '2099-01-01' }; },
    carregarRascunhoAtivo: async () => rascunho,
    mensagemJaRegistrada: async () => false,
    contatoIgnorado: async tel => ignorados.has(tel),
    conversaIniciadaPelaLoja: async () => daLoja,
    semConversaRecente: async () => false,
    carregarFaq: async () => [],
    // mais nova primeiro, como no banco
    mensagensRecentes: async () => salvas.slice().reverse().map(e => ({ origem: e.meta?.origem, etapa_pedido: e.meta?.etapa || null })),
    reabrirLojaSeEsquecida: async () => null,
    pedidosEmAndamento: async () => andamento,
    anotarComprovantePix: async (pedido, leitura) => { anotados.push({ pedido, leitura }); },
    limparRascunho: async () => { rascunho = null; },
  };
  const express = () => ({ use() {}, get() {}, post: (_route, fn) => { handler = fn; }, listen: (_port, fn) => fn() });
  express.json = () => ({});
  const mocks = {
    dotenv: { config() {} }, express, uuid: { v4: () => 'teste-uuid' },
    './logger': { step() {}, info() {}, error() {}, warn() {} },
    './services/evolution': { extrairMensagem: body => body.msg, enviarTexto: async (jid, texto) => { envios.push({ jid, texto }); return 'id-' + envios.length; }, enviarDigitando: async () => {} },
    './services/media': { transcreverAudio: async () => 'Áudio de teste', analisarImagem: async () => imagem },
    './services/supabase': db,
    './agent': { rodarAgente: async (...args) => { agentes.push(args); if (onAgente) await onAgente(); return resposta(...args); }, confirmarPedido: async (...args) => { criados.push(args); return confirmar(...args); } },
    './utils/retry': { comRetry: fn => fn() },
    './utils/agrupador': { criarAgrupador: options => criarAgrupador({ ...options, ...clock }) },
    './utils/horarios': { avaliarFuncionamento: info => avaliarFuncionamento(info, new Date(data)) },
    './utils/funcionamento': { proximaAbertura: info => proximaAbertura(info, new Date(data)) },
    './notificacoes': { iniciarNotificacoes() {} },
    './services/pix': { iniciarPix() {}, tratarComprovantesWhatsApp: async () => false },
  };
  vm.runInNewContext(fs.readFileSync(arquivo,'utf8'), { require: nome => mocks[nome] || requireReal(nome), process: { env: {} }, module: { exports: {} }, setInterval: () => ({ unref() {} }) }, { filename: arquivo });
  return {
    clock, salvas, envios, agentes, criados, pausas, ignorados,
    setOnAgente: value => { onAgente = value; },
    setResposta: value => { resposta = value; }, setConfirmar: value => { confirmar = value; },
    setDaLoja: value => { daLoja = value; }, liberarPausa: () => { pausa = null; },
    setAndamento: value => { andamento = value; }, setImagem: value => { imagem = value; }, anotados,
    setInfo: value => { info = value; }, setRascunho: value => { rascunho = value; },
    receber: async (texto, id, extra = {}) => handler({ body: { msg: { telefone: '5544000000000', jid: 'cliente', pushName: 'Cliente', tipo: 'conversation', texto, msgId: id, ...extra }, data: { key: { id } } } }, { status() { return this; }, json() {} }),
  };
}
test('webhook reúne texto e áudio em uma resposta, preservando mensagens individuais', async () => {
  const f = webhookFixture();
  await f.receber('Oi', '1'); await f.clock.avancar(9000);
  await f.receber('', '2', { tipo: 'audioMessage', base64: 'fake' }); await f.clock.avancar(9000);
  await f.receber('Sem cebola', '3'); await f.clock.avancar(10000);
  assert.equal(f.agentes.length, 1); assert.match(f.agentes[0][0], /Oi\n🎙️ \[Áudio\]: Áudio de teste\nSem cebola/);
  assert.equal(f.envios.length, 1);
  assert.deepEqual(f.salvas.filter(e => e.role === 'user').map(e => e.meta.msgId), ['1','2','3']);
  assert.equal(f.salvas[1].meta.transcricao, 'Áudio de teste');
  await f.receber('Sem cebola', '3'); await f.clock.avancar(10000); assert.equal(f.envios.length, 1);
});
test('webhook bloqueia primeiro contato e confirmação de pedido fora do horário', async () => {
  for (const data of ['2026-10-15T20:29:00Z', '2026-10-16T02:00:00Z', '2026-10-18T15:00:00Z']) {
    const f = webhookFixture(data); f.setRascunho({ etapa_atual: 'aguardando_confirmacao' });
    await f.receber('sim', data); await f.receber('obrigado', data + '2'); await f.clock.avancar(10000);
    assert.equal(f.agentes.length, 0); assert.equal(f.criados.length, 0); assert.equal(f.envios.length, 1);
    assert.match(f.envios[0].texto, /fora do horário/); assert.match(f.envios[0].texto, /Domingo: fechado/);
    assert.equal(f.salvas.filter(e => e.role === 'user').length, 2);
  }
});
test('pausa humana prevalece sobre lote pendente e não perde a fala do cliente', async () => {
  const f = webhookFixture(); await f.receber('Oi', '1');
  await f.receber('Eu atendo', '2', { fromMe: true }); await f.clock.avancar(10000);
  assert.equal(f.envios.length, 0); assert.equal(f.agentes.length, 0);
  assert.equal(f.salvas.filter(e => e.role === 'user').length, 1);
  assert.equal(f.salvas[0].meta.origem, 'humano');
});
test('pausa manual fecha o atendimento mesmo em expediente', async () => {
  const f = webhookFixture(); f.setInfo({ loja_aberta: 'false' });
  await f.receber('Oi','1'); await f.clock.avancar(10000);
  assert.equal(f.agentes.length, 0); assert.match(f.envios[0].texto, /indisponível/);
});
test('SQL usa a mesma agenda e impede INSERT quando a loja está pausada', async () => {
  const pg = new PGlite();
  try {
    await pg.exec('CREATE TABLE info_restaurante(chave text PRIMARY KEY, valor text NOT NULL); CREATE TABLE pedidos(id integer);');
    const sql = fs.readFileSync(path.join(__dirname,'../horarios.sql'),'utf8');
    await pg.exec(sql); await pg.exec(sql);
    for (const [data, esperado] of datas) {
      const result = await pg.query('SELECT restaurante_aberto_em($1::timestamptz) AS aberto', [data]);
      assert.equal(result.rows[0].aberto, esperado, data);
    }
    await pg.exec("INSERT INTO info_restaurante VALUES ('loja_aberta','false')");
    await assert.rejects(pg.exec('INSERT INTO pedidos VALUES (1)'), /LOJA_FECHADA/);
    await pg.exec('ALTER TABLE pedidos DISABLE TRIGGER pedidos_horario_funcionamento; INSERT INTO pedidos VALUES(2); ALTER TABLE pedidos ENABLE TRIGGER pedidos_horario_funcionamento; UPDATE pedidos SET id=3;');
    assert.equal((await pg.query('SELECT id FROM pedidos')).rows[0].id, 3);
  } finally { await pg.close(); }
});

test('fechamento durante a resposta envia indisponibilidade em vez de continuar atendimento', async () => {
  const f = webhookFixture(); f.setOnAgente(() => f.setInfo({ loja_aberta: 'false' }));
  await f.receber('Quero uma pizza', '1'); await f.clock.avancar(10000);
  assert.equal(f.agentes.length, 1); assert.equal(f.envios.length, 1); assert.match(f.envios[0].texto, /indisponível/);
});
test('atendente assumindo enquanto a IA responde impede a resposta pendente', async () => {
  const f = webhookFixture(); f.setOnAgente(() => f.receber('Eu atendo', '2', { fromMe: true }));
  await f.receber('Quero falar com alguém', '1'); await f.clock.avancar(10000);
  assert.equal(f.agentes.length, 1); assert.equal(f.envios.length, 0);
});

// ─── Casos tirados das conversas reais de 19 a 26/10 ─────────────────────────
test('contato da equipe/fornecedor não passa pela IA nem é gravado', async () => {
  const f = webhookFixture(); f.ignorados.add('5544000000000');
  await f.receber('Manda 3 gelos e troco pra 100', '1'); await f.clock.avancar(10000);
  await f.receber('Pedido anotado!', '2', { fromMe: true });
  assert.equal(f.agentes.length, 0); assert.equal(f.envios.length, 0); assert.equal(f.salvas.length, 0);
});
test('conversa iniciada pela loja: grava o contato sem IA e sem transcrever áudio', async () => {
  const f = webhookFixture(); f.setDaLoja(true);
  await f.receber('Tou chegando', '1'); await f.receber('', '2', { tipo: 'audioMessage', base64: 'fake' });
  await f.clock.avancar(10000);
  assert.equal(f.agentes.length, 0); assert.equal(f.envios.length, 0);
  assert.deepEqual(f.salvas.map(e => e.content), ['Tou chegando', '[Áudio]']);
  assert.ok(f.salvas.every(e => e.meta.etapa === 'conversa_da_loja' && !e.meta.transcricao));
});
test('loja fechada avisa uma vez só e diz quando abre', async () => {
  const f = webhookFixture('2026-10-15T20:29:00Z');   // quinta, 17:29 em São Paulo
  await f.receber('Boa tarde', '1'); await f.clock.avancar(10000);
  await f.receber('Abrem hoje?', '2'); await f.clock.avancar(10000);
  assert.equal(f.envios.length, 1);
  assert.match(f.envios[0].texto, /Abrimos hoje às 17h30\./);
  assert.ok(f.envios[0].texto.indexOf('Abrimos') < f.envios[0].texto.indexOf('Volte a falar'));
  assert.equal(f.salvas.filter(e => e.role === 'user').length, 2);
});
test('pausa manual não inventa horário de abertura', async () => {
  const f = webhookFixture(); f.setInfo({ loja_aberta: 'false' });
  await f.receber('Oi', '1'); await f.clock.avancar(10000);
  assert.doesNotMatch(f.envios[0].texto, /Abrimos/);
});
test('primeira mensagem com pergunta recebe a saudação fixa e depois a resposta', async () => {
  const f = webhookFixture();
  f.setResposta((_msg, historico) => historico.length
    ? { texto: 'Entregamos sim! Taxa de R$ 10,00.' }
    : { texto: cfg.mensagemInicial, modelo: null });
  await f.receber('Bom dia, vcs entregam?', '1'); await f.clock.avancar(10000);
  assert.deepEqual(f.envios.map(e => e.texto), [cfg.mensagemInicial, 'Entregamos sim! Taxa de R$ 10,00.']);
  assert.equal(JSON.stringify(f.agentes[1][1]), JSON.stringify([{ role: 'assistant', content: cfg.mensagemInicial }]));
});
test('primeira mensagem só de cumprimento recebe apenas a saudação', async () => {
  const f = webhookFixture();
  f.setResposta(() => ({ texto: cfg.mensagemInicial, modelo: null }));
  await f.receber('Boa noite, tudo bem?', '1'); await f.clock.avancar(10000);
  assert.equal(f.envios.length, 1); assert.equal(f.agentes.length, 1);
});
test('atendente chamada: avisa uma vez, depois diz que já chamou, depois só registra', async () => {
  const f = webhookFixture();
  f.setResposta(() => ({ texto: 'Vou chamar uma atendente para te ajudar.', handoff: { motivo: 'chave pix' } }));
  for (const [i, texto] of ['Preciso do pix', 'Ok', 'Mandaram meu pedido errado'].entries()) {
    f.liberarPausa(); await f.receber(texto, String(i)); await f.clock.avancar(10000);
  }
  assert.deepEqual(f.envios.map(e => e.texto), [
    'Vou chamar uma atendente para te ajudar.',
    'Já avisei a equipe 🙏 Assim que alguém estiver livre, continua com você por aqui.',
  ]);
  assert.equal(f.pausas.length, 3);   // o painel é avisado nas três
  assert.equal(f.salvas.filter(e => e.role === 'user').length, 3);
  // depois que a atendente fala, um novo problema volta a ter aviso
  await f.receber('Já resolvo', 'h', { fromMe: true }); f.liberarPausa();
  await f.receber('Outra coisa', '9'); await f.clock.avancar(10000);
  assert.equal(f.envios.at(-1).texto, 'Vou chamar uma atendente para te ajudar.');
});
test('"Sim" + "Pode fechar" no mesmo lote fecha o pedido; Pix sem chave não mostra valor de exemplo', async () => {
  const f = webhookFixture();
  f.setRascunho({ etapa_atual: 'aguardando_confirmacao', tipo_entrega: 'retirada' });
  f.setInfo({ chave_pix: 'PENDENTE-chave-pix' });
  f.setConfirmar(async () => ({ numeroPedido: 99, subtotal: 81, taxaEntrega: 0, total: 81, formaPagamento: 'pix' }));
  await f.receber('Sim', '1'); await f.receber('Pode fechar', '2'); await f.clock.avancar(10000);
  assert.equal(f.criados.length, 1); assert.equal(f.agentes.length, 0);
  assert.match(f.envios[0].texto, /Pedido \*#99\* registrado/);
  assert.match(f.envios[0].texto, /A equipe já te manda a chave PIX/);
  assert.doesNotMatch(f.envios[0].texto, /PENDENTE|undefined/);
  assert.ok(f.pausas.some(m => /chave/.test(m)));
  assert.equal(f.salvas.find(e => e.role === 'assistant').meta.msgId, 'id-1');
});

// ─── Pix e fechamento (conversas de 27/10 a 10/11) ───────────────────────────
const RASCUNHO_PIX = {
  etapa_atual: 'aguardando_confirmacao', tipo_entrega: 'delivery', nome_cliente: 'Eduardo Silva',
  endereco: 'Rua Sebastião Ribas Machado e Silva, 2549 — Jardim Ibirapuera', forma_pagamento: 'pix',
  itens: JSON.stringify([{ nome: 'Frango Frito Especial (G)', quantidade: 1, preco_unitario: 85, observacao: 'só peito' }]),
};
const PEDIDO_PIX = async () => ({ numeroPedido: 168, subtotal: 85, taxaEntrega: 10, total: 95, formaPagamento: 'pix' });
test('Pix fechado: resumo com itens, endereço e total, e a chave sozinha na mensagem seguinte', async () => {
  const f = webhookFixture();
  f.setRascunho(RASCUNHO_PIX); f.setConfirmar(PEDIDO_PIX);
  f.setInfo({ chave_pix: '44999163854', pix_titular: 'Vicente Dias Russi' });
  await f.receber('Sim', '1'); await f.clock.avancar(10000);
  assert.equal(f.envios.length, 2);
  const [resumo, chave] = f.envios.map(e => e.texto);
  assert.match(resumo, /Pedido \*#168\* registrado/);
  assert.match(resumo, /1x Frango Frito Especial \(G\) — R\$ 85,00\n {3}_só peito_/);
  assert.match(resumo, /Entrega: Rua Sebastião Ribas Machado e Silva, 2549/);
  assert.match(resumo, /\*Total: R\$ 95,00\*/);
  assert.match(resumo, /chave celular/); assert.match(resumo, /Titular: \*Vicente Dias Russi\*/);
  assert.equal(chave, '44999163854');
  assert.deepEqual(f.salvas.filter(e => e.role === 'assistant').map(e => e.meta.msgId), ['id-1', 'id-2']);
  assert.equal(f.pausas.length, 0);
});
test('aceite em linguagem natural ("confirmei com a patroa") fecha pelo confirmar_pedido da IA', async () => {
  const f = webhookFixture();
  f.setRascunho(RASCUNHO_PIX); f.setConfirmar(PEDIDO_PIX); f.setInfo({ chave_pix: '44999163854' });
  f.setResposta(() => ({ texto: '', confirmar: true }));
  await f.receber('Confirmei com a patroa', '1'); await f.clock.avancar(10000);
  assert.equal(f.agentes.length, 1); assert.equal(f.criados.length, 1);
  assert.match(f.envios[0].texto, /#168/); assert.equal(f.envios[1].texto, '44999163854');
});
test('"Pix / Agora / Manda aí" depois do resumo já fecha, sem passar pela IA', async () => {
  const f = webhookFixture();
  f.setRascunho(RASCUNHO_PIX); f.setConfirmar(PEDIDO_PIX); f.setInfo({ chave_pix: '44999163854' });
  await f.receber('Pix', '1'); await f.receber('Agora', '2'); await f.receber('Manda aí', '3'); await f.clock.avancar(10000);
  assert.equal(f.agentes.length, 0); assert.equal(f.criados.length, 1);
});
test('comprovante com pedido Pix em aberto: anota no pedido e responde, mesmo com a loja fechada', async () => {
  const f = webhookFixture('2026-10-16T02:00:00Z');   // 23:00, fechado
  f.setAndamento([{ id: 'p1', numero_pedido: 127, forma_pagamento: 'pix', status: 'pendente', observacao: 'Pagamento na retirada' }]);
  f.setImagem({ isComprovante: true, analise: 'Comprovante Pix de R$ 85,00 para Vicente Dias Russi' });
  await f.receber('', '1', { tipo: 'imageMessage', base64: 'fake' }); await f.clock.avancar(10000);
  assert.equal(f.agentes.length, 0); assert.equal(f.envios.length, 1);
  assert.match(f.envios[0].texto, /Recebi o comprovante do pedido \*#127\*/);
  assert.doesNotMatch(f.envios[0].texto, /indisponível|fora do horário/);
  assert.equal(f.anotados.length, 1); assert.match(f.anotados[0].leitura, /R\$ 85,00/);
});
test('loja fechada: cliente com pedido em andamento continua sendo atendido sobre ele', async () => {
  const f = webhookFixture('2026-10-16T02:00:00Z');
  f.setAndamento([{ id: 'p1', numero_pedido: 127, forma_pagamento: 'cartao', status: 'preparando' }]);
  f.setResposta(() => ({ texto: 'Seu pedido #127 está em preparo.' }));
  await f.receber('Já saiu meu pedido?', '1'); await f.clock.avancar(10000);
  assert.equal(f.agentes.length, 1);
  assert.deepEqual(f.envios.map(e => e.texto), ['Seu pedido #127 está em preparo.']);
});
