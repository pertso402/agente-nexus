'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');

function carregarModulo(banco, enviar = async () => 'wamid-teste') {
  const enviados = [], historico = [], logs = [], eventos = {};
  const canal = {
    on(tipo, filtro, callback) { eventos.mudanca = callback; return this; },
    subscribe(callback) { eventos.conexao = callback; return this; },
  };
  const cliente = {
    async rpc(nome) {
      assert.equal(nome, 'reservar_aviso_pedido');
      return { data: (await banco.query('SELECT * FROM public.reservar_aviso_pedido()')).rows };
    },
    from(tabela) {
      let campos, filtros = {};
      const builder = {
        update(valores) { campos = valores; return this; },
        eq(chave, valor) { filtros[chave] = valor; return this; },
        select() {
          if (!campos) return this;
          const chaves = Object.keys(campos);
          const sql = chaves.map((chave, i) => `${chave} = $${i + 1}`).join(', ');
          return banco.query(`UPDATE public.notificacoes_pedido_enviadas SET ${sql}
            WHERE id = $${chaves.length + 1} AND reserva_token = $${chaves.length + 2} RETURNING id`,
          [...Object.values(campos), filtros.id, filtros.reserva_token])
            .then(r => ({ data: r.rows }));
        },
        async maybeSingle() {
          assert.equal(tabela, 'clientes');
          return { data: (await banco.query('SELECT nome, telefone FROM public.clientes WHERE id = $1', [filtros.id])).rows[0] };
        },
      };
      return builder;
    },
    channel() { return canal; },
    async removeChannel() {},
  };
  const mocks = {
    '@supabase/supabase-js': { createClient: () => cliente },
    ws: {},
    './services/evolution': { enviarTexto: async (tel, texto) => {
      enviados.push({ tel, texto }); return enviar(tel, texto);
    } },
    './services/supabase': { salvarMensagem: async (...args) => historico.push(args) },
    './logger': Object.fromEntries(['info', 'warn', 'error'].map(nivel => [nivel, (...args) => logs.push({ nivel, args })])),
  };
  const modulo = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/notificacoes.js'), 'utf8'), {
    module: modulo, require: nome => {
      assert.ok(Object.hasOwn(mocks, nome), `Dependência inesperada: ${nome}`); return mocks[nome];
    },
    process: { env: Object.fromEntries(['SUPA_URL', 'SUPA_SERVICE_KEY', 'EVOLUTION_URL', 'EVOLUTION_KEY', 'EVOLUTION_INSTANCE'].map(c => [c, 'teste'])) },
    setInterval: callback => { eventos.intervalo = callback; return { unref() {} }; },
    clearInterval() {},
  });
  return { ...modulo.exports, enviados, historico, logs, eventos };
}

test('mensagens distinguem preparo, pronto, entrega e retirada sem oferecer pedido no chat', () => {
  const { montarMensagem } = carregarModulo(null);
  const pedido = { numero_pedido: 7, total: 42.5, tipo_entrega: 'delivery' };
  assert.match(montarMensagem({ ...pedido, status: 'Preparando' }), /entrou em preparo/);
  assert.match(montarMensagem({ ...pedido, status: 'aguardando_preparo' }), /fila de preparo/);
  assert.match(montarMensagem({ ...pedido, status: 'pronto' }), /está \*pronto\*/);
  assert.match(montarMensagem({ ...pedido, status: 'Saiu Entrega' }), /saiu para entrega/);
  assert.match(montarMensagem({ ...pedido, status: 'saiu_entrega', tipo_entrega: 'retirada' }), /pronto para retirada/);
  assert.doesNotMatch(montarMensagem({ ...pedido, status: 'saiu_entrega', tipo_entrega: 'retirada' }), /saiu para entrega/);
  assert.match(montarMensagem({ ...pedido, status: 'entregue', tipo_entrega: 'retirada' }), /retirado/);
  assert.match(montarMensagem({ ...pedido, status: 'cancelado' }), /cancelado/);
  assert.equal(montarMensagem({ ...pedido, status: 'pendente' }), null);
  assert.equal(montarMensagem({ ...pedido, status: 'desconhecido' }), null);
});

test('fila e gatilho executam no Postgres e o agente envia as mudanças pelo WhatsApp', async t => {
  const banco = new PGlite();
  const clienteId = '00000000-0000-0000-0000-000000000001';
  const pedidoId = '00000000-0000-0000-0000-000000000002';
  const sqlAvisos = fs.readFileSync(path.join(__dirname, '../avisos.sql'), 'utf8');
  try {
    await banco.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.clientes (id uuid PRIMARY KEY, nome text, telefone text);
      CREATE TABLE public.pedidos (id uuid PRIMARY KEY, cliente_id uuid, numero_pedido int, status text,
        tipo_entrega text, total numeric);
      GRANT SELECT, UPDATE ON public.pedidos TO anon;
      CREATE PUBLICATION supabase_realtime;
      INSERT INTO public.clientes VALUES ('${clienteId}', 'Maria Cliente', '+55 (44) 90000-0000');
    `);
    await banco.exec(sqlAvisos);
    await banco.exec(sqlAvisos); // atualização idempotente no SQL Editor
    async function reiniciar() {
      await banco.exec('TRUNCATE public.pedidos CASCADE');
      await banco.query('INSERT INTO public.pedidos VALUES ($1, $2, 7, $3, $4, 42.5)', [pedidoId, clienteId, 'pendente', 'delivery']);
    }
    async function mudar(status) {
      await banco.query('UPDATE public.pedidos SET status = $1 WHERE id = $2', [status, pedidoId]);
    }
    async function fila() { return (await banco.query('SELECT * FROM public.notificacoes_pedido_enviadas ORDER BY ordem')).rows; }

    await t.test('painel anônimo enfileira sem acessar a fila; RPC exclusiva do servidor', async () => {
      await reiniciar();
      await banco.exec(`SET ROLE anon; UPDATE public.pedidos SET status = 'preparando'; RESET ROLE;`);
      assert.equal((await fila()).length, 1);
      const permissoes = (await banco.query(`SELECT
        has_table_privilege('anon', 'public.notificacoes_pedido_enviadas', 'SELECT') AS leitura,
        has_table_privilege('authenticated', 'public.notificacoes_pedido_enviadas', 'INSERT') AS escrita,
        has_function_privilege('anon', 'public.reservar_aviso_pedido()', 'EXECUTE') AS rpc,
        has_function_privilege('service_role', 'public.reservar_aviso_pedido()', 'EXECUTE') AS servidor`)).rows[0];
      assert.deepEqual(permissoes, { leitura: false, escrita: false, rpc: false, servidor: true });
      await banco.exec('SET ROLE service_role');
      assert.equal((await banco.query('SELECT * FROM public.reservar_aviso_pedido()')).rows.length, 1);
      await banco.exec('RESET ROLE');
    });

    await t.test('mudança sem status, cliques repetidos e rollback não geram avisos extras', async () => {
      await reiniciar();
      assert.equal((await fila()).length, 0);
      await banco.exec("BEGIN; UPDATE public.pedidos SET status = 'preparando'; ROLLBACK;");
      assert.equal((await fila()).length, 0);
      await mudar('preparando');
      await mudar('Preparando');
      await banco.exec('UPDATE public.pedidos SET total = 45');
      assert.equal((await fila()).length, 1);
      await mudar(null);
      assert.equal((await fila()).length, 1);
    });

    await t.test('recupera várias etapas com o agente desligado, na ordem e sem duplicar', async () => {
      await reiniciar();
      for (const status of ['confirmado', 'preparando', 'pronto', 'saiu_entrega', 'entregue']) await mudar(status);
      const agente = carregarModulo(banco);
      await Promise.all([agente.processarFila(), agente.processarFila()]);
      assert.equal(agente.enviados.length, 5);
      assert.match(agente.enviados[1].texto, /entrou em preparo/);
      assert.match(agente.enviados[2].texto, /está \*pronto\*/);
      assert.match(agente.enviados[3].texto, /saiu para entrega/);
      assert.ok((await fila()).every(aviso => aviso.enviado_em && aviso.whatsapp_message_id === 'wamid-teste'));
      assert.equal(agente.enviados[0].tel, '5544900000000');
      assert.equal(agente.historico.length, 5);
      assert.equal(agente.historico[0][3].msgId, 'wamid-teste');
      const reiniciado = carregarModulo(banco);
      await reiniciado.processarFila();
      assert.equal(reiniciado.enviados.length, 0);
      assert.equal(agente.enviados.length, 5);
    });

    await t.test('envio falho fica pendente e bloqueia etapa seguinte até a retentativa', async () => {
      await reiniciar(); await mudar('preparando'); await mudar('pronto');
      const falho = carregarModulo(banco, async () => { throw new Error('Evolution indisponível'); });
      await falho.processarFila();
      assert.equal(falho.enviados.length, 1);
      assert.equal(falho.historico.length, 0);
      const pendente = (await fila())[0];
      assert.equal(pendente.enviado_em, null);
      assert.equal(pendente.reserva_token, null);
      assert.match(pendente.ultimo_erro, /Evolution/);
      await banco.exec("UPDATE public.notificacoes_pedido_enviadas SET disponivel_em = now() - interval '1 second'");
      const recuperado = carregarModulo(banco); await recuperado.processarFila();
      assert.equal(recuperado.enviados.length, 2);
      assert.match(recuperado.enviados[0].texto, /preparo/);
      assert.match(recuperado.enviados[1].texto, /pronto/);
    });

    await t.test('reserva impede outro consumidor e é recuperada após reinício', async () => {
      await reiniciar(); await mudar('preparando');
      const primeira = (await banco.query('SELECT * FROM public.reservar_aviso_pedido()')).rows[0];
      assert.ok(primeira.reserva_token);
      assert.equal((await banco.query('SELECT * FROM public.reservar_aviso_pedido()')).rows.length, 0);
      await banco.exec("UPDATE public.notificacoes_pedido_enviadas SET reservado_ate = now() - interval '1 second'");
      const segunda = (await banco.query('SELECT * FROM public.reservar_aviso_pedido()')).rows[0];
      assert.notEqual(segunda.reserva_token, primeira.reserva_token);
      assert.equal(segunda.tentativas, 2);
    });

    await t.test('outro pedido avança mesmo quando o primeiro tem uma reserva ativa', async () => {
      await reiniciar(); await mudar('preparando'); await mudar('pronto');
      const primeiro = (await banco.query('SELECT * FROM public.reservar_aviso_pedido()')).rows[0];
      const outroId = '00000000-0000-0000-0000-000000000003';
      await banco.query('INSERT INTO public.pedidos VALUES ($1, $2, 8, $3, $4, 30)', [outroId, clienteId, 'pendente', 'retirada']);
      await banco.query("UPDATE public.pedidos SET status = 'preparando' WHERE id = $1", [outroId]);
      const segundo = (await banco.query('SELECT * FROM public.reservar_aviso_pedido()')).rows[0];
      assert.equal(primeiro.pedido_id, pedidoId);
      assert.equal(segundo.pedido_id, outroId);
    });

    await t.test('avisos antigos enviados não são reenviados após atualizar o SQL', async () => {
      await reiniciar(); await mudar('preparando');
      await banco.exec('UPDATE public.notificacoes_pedido_enviadas SET enviado_em = now(), pedido = NULL');
      await banco.exec(sqlAvisos);
      const agente = carregarModulo(banco); await agente.processarFila();
      assert.equal(agente.enviados.length, 0);
      assert.ok((await fila())[0].enviado_em);
    });

    await t.test('inicialização consome fila e reconexão/consulta periódica retomam o consumo', async () => {
      await reiniciar(); await mudar('preparando');
      const agente = carregarModulo(banco);
      agente.iniciarNotificacoes();
      await agente.processarFila();
      assert.equal(agente.enviados.length, 1);
      await mudar('pronto'); agente.eventos.conexao('SUBSCRIBED');
      await agente.processarFila();
      assert.equal(agente.enviados.length, 2);
      await mudar('saiu_entrega'); agente.eventos.intervalo();
      await agente.processarFila();
      assert.equal(agente.enviados.length, 3);
      await agente.pararNotificacoes();
    });
  } finally { await banco.close(); }
});
