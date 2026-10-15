'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { avaliarFuncionamento, PADRAO } = require('../src/utils/horarios');
const { criarAgrupador } = require('../src/utils/agrupador');
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
  const clock = relogio(), salvas = [], envios = [], agentes = [], criados = [];
  let handler, pausa = null, info = {}, rascunho = null, onAgente = null;
  const db = {
    buscarInfo: async () => info,
    carregarHistorico: async () => salvas.map(e => ({ role: e.role, content: e.content })),
    salvarMensagem: async (telefone, role, content, meta) => { salvas.push({ telefone, role, content, meta }); return true; },
    carregarPausaAtiva: async () => pausa,
    pausarAtendimento: async () => { pausa = { pausado_ate: '2099-01-01' }; },
    carregarRascunho: async () => rascunho,
    mensagemJaRegistrada: async () => false,
  };
  const express = () => ({ use() {}, get() {}, post: (_route, fn) => { handler = fn; }, listen: (_port, fn) => fn() });
  express.json = () => ({});
  const mocks = {
    dotenv: { config() {} }, express, uuid: { v4: () => 'teste-uuid' },
    './logger': { step() {}, info() {}, error() {}, warn() {} },
    './services/evolution': { extrairMensagem: body => body.msg, enviarTexto: async (jid, texto) => { envios.push({ jid, texto }); return 'id-' + envios.length; }, enviarDigitando: async () => {} },
    './services/media': { transcreverAudio: async () => 'Áudio de teste', analisarImagem: async () => ({ isComprovante: false, analise: 'Imagem de teste' }) },
    './services/supabase': db,
    './agent': { rodarAgente: async (...args) => { agentes.push(args); if (onAgente) await onAgente(); return { texto: 'Resposta única' }; }, confirmarPedido: async (...args) => { criados.push(args); throw new Error('Não deveria confirmar'); } },
    './utils/retry': { comRetry: fn => fn() },
    './utils/agrupador': { criarAgrupador: options => criarAgrupador({ ...options, ...clock }) },
    './utils/horarios': { avaliarFuncionamento: info => avaliarFuncionamento(info, new Date(data)) },
    './notificacoes': { iniciarNotificacoes() {} },
    './services/pix': { iniciarPix() {}, tratarComprovantesWhatsApp: async () => false },
  };
  vm.runInNewContext(fs.readFileSync(arquivo,'utf8'), { require: nome => mocks[nome] || requireReal(nome), process: { env: {} }, module: { exports: {} } }, { filename: arquivo });
  return {
    clock, salvas, envios, agentes, criados,
    setOnAgente: value => { onAgente = value; },
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
