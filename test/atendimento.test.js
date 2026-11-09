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
