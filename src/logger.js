'use strict';

// ─── LOGGER ESTRUTURADO ────────────────────────────────────────────────────────
// Loga em JSON no stdout (EasyPanel/Docker captura automaticamente)
// Erros e warnings também são salvos na tabela agent_logs do Supabase
// para consulta no dashboard sem precisar entrar no servidor.

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

let supabase = null;

function getSupabase() {
  if (!supabase && process.env.SUPA_URL && process.env.SUPA_SERVICE_KEY) {
    supabase = createClient(process.env.SUPA_URL, process.env.SUPA_SERVICE_KEY, {
      realtime: { transport: ws },
    });
  }
  return supabase;
}

function salvarNoSupabase(nivel, etapa, mensagem, dados) {
  const sb = getSupabase();
  if (!sb) return;
  if (nivel !== 'error' && nivel !== 'warn') return;

  sb.from('agent_logs')
    .insert({
      request_id: dados?.requestId || null,
      telefone: dados?.telefone || null,
      nivel,
      etapa,
      mensagem,
      dados: dados ? JSON.parse(JSON.stringify(dados, omitStack)) : null,
      erro_stack: dados?.stack || null,
    })
    .then(() => {})
    .catch(() => {}); // nunca travar o fluxo principal por causa do log
}

function omitStack(key, val) {
  return key === 'stack' ? undefined : val;
}

function formatar(nivel, etapa, mensagem, dados) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    nivel,
    etapa,
    mensagem,
    ...(dados || {}),
  });
}

const logger = {
  info(etapa, mensagem, dados) {
    console.log(formatar('info', etapa, mensagem, dados));
  },

  warn(etapa, mensagem, dados) {
    console.warn(formatar('warn', etapa, mensagem, dados));
    salvarNoSupabase('warn', etapa, mensagem, dados);
  },

  error(etapa, mensagem, dados) {
    // Extrair stack se vier um Error
    if (dados instanceof Error) {
      dados = { message: dados.message, stack: dados.stack };
    } else if (dados?.error instanceof Error) {
      dados = { ...dados, stack: dados.error.stack, errMsg: dados.error.message };
    }
    console.error(formatar('error', etapa, mensagem, dados));
    salvarNoSupabase('error', etapa, mensagem, dados);
  },

  // Loga início/fim de cada etapa do fluxo
  step(requestId, telefone, etapa, extra = {}) {
    console.log(formatar('info', etapa, `▶ ${etapa}`, { requestId, telefone, ...extra }));
  },
};

module.exports = logger;
