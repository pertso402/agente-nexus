'use strict';

require('dotenv').config();

const express = require('express');
const { v4: uuid } = require('uuid');
const logger = require('./logger');
const { extrairMensagem, downloadMidia, enviarTexto, enviarDigitando } = require('./services/evolution');
const { transcreverAudio, analisarImagem } = require('./services/media');
const {
  carregarHistorico, salvarMensagem,
  carregarPausaAtiva, pausarAtendimento,
  carregarRascunho, limparRascunho,
  buscarInfo, atualizarStatusPedido, registrarOrigemAnuncio,
  mensagemJaRegistrada,
} = require('./services/supabase');
const { rodarAgente, confirmarPedido } = require('./agent');
const { comRetry } = require('./utils/retry');
const cfg = require('./config/restaurante');
const { iniciarNotificacoes } = require('./notificacoes');
const { iniciarPix, tratarComprovantesWhatsApp } = require('./services/pix');
const { criarAgrupador } = require('./utils/agrupador');
const { avaliarFuncionamento } = require('./utils/horarios');
const ESPERA_MENSAGENS_MS = Math.max(1, Number(process.env.AGRUPAR_MENSAGENS_SEGUNDOS) || 10) * 1000;
const agrupador = criarAgrupador({
  esperaMs: ESPERA_MENSAGENS_MS,
  processar: processarMensagens,
  onError: (err, telefone) => logger.error('mensagens/lote', err.message, { telefone }),
});

const app = express();
app.use(express.json({ limit: '10mb' }));

const fmt = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

// ─── DEDUPLICAÇÃO DE MENSAGENS ────────────────────────────────────────────────
const msgProcessadas = new Map();
function jaProcessada(msgId) {
  if (!msgId) return false;
  const agora = Date.now();
  for (const [id, ts] of msgProcessadas) {
    if (agora - ts > 120_000) msgProcessadas.delete(id);
  }
  if (msgProcessadas.has(msgId)) return true;
  msgProcessadas.set(msgId, agora);
  return false;
}

// ─── ALLOWLIST DE TELEFONES ───────────────────────────────────────────────────
// TELEFONES_PERMITIDOS vazio = atende todo mundo (produção normal).
// Com números listados, só esses são atendidos — os demais são ignorados em
// silêncio (sem "digitando", sem chamada à OpenAI, sem gravar nada). Serve para
// usar um chip que também recebe leads/contatos que NÃO devem falar com o bot.
const PERMITIDOS = String(process.env.TELEFONES_PERMITIDOS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Gera as formas equivalentes de um número BR (com e sem o 9º dígito), porque o
// JID do WhatsApp pode vir no formato antigo (5544 9877-146x) ou novo.
function variantesTelefone(num) {
  const d = String(num || '').replace(/\D/g, '');
  const vs = new Set([d]);
  const m = d.match(/^55(\d{2})(\d{8,9})$/);
  if (m) {
    const [, ddd, resto] = m;
    if (resto.length === 9 && resto[0] === '9') vs.add(`55${ddd}${resto.slice(1)}`);
    if (resto.length === 8) vs.add(`55${ddd}9${resto}`);
  }
  return vs;
}

function telefonePermitido(telefone) {
  if (!PERMITIDOS.length) return true;
  const vs = variantesTelefone(telefone);
  return PERMITIDOS.some(p => [...variantesTelefone(p)].some(v => vs.has(v)));
}

// Confirmações que disparam a criação do pedido
const CONFIRMACOES = new Set([
  'sim', 'simm', 'sim!', 's', '1', 'confirmar', 'confirma', 'confirmo',
  'pode confirmar', 'pode fechar', 'fechar', 'fechou', 'isso', 'isso mesmo',
  'ta certo', 'tá certo', 'certo', 'correto', 'ok', 'okay', 'beleza', 'blz', 'pode ser',
]);
function ehConfirmacao(texto) {
  const t = String(texto || '').trim().toLowerCase().replace(/[.!]+$/, '');
  return CONFIRMACOES.has(t);
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    agente: 'Choppatinhas v1',
    vars: {
      supa: !!process.env.SUPA_URL,
      openai: !!process.env.OPENAI_API_KEY,
      evolution: !!process.env.EVOLUTION_URL,
    },
  });
});

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).json({ ok: true });

  const requestId = uuid().slice(0, 8);
  const body = req.body;

  let msg;
  try {
    msg = extrairMensagem(body);
    if (!msg) return;
  } catch (err) {
    logger.error('webhook/extrair', err.message, { requestId, err });
    return;
  }

  if (!telefonePermitido(msg.telefone)) {
    logger.info('webhook/bloqueado', 'Telefone fora da allowlist — ignorado', {
      requestId, telefone: msg.telefone, pushName: msg.pushName,
    });
    return;
  }

  const msgId = body?.data?.key?.id;
  if (jaProcessada(msgId)) {
    logger.info('webhook/dedup', 'Mensagem duplicada ignorada', { requestId, msgId });
    return;
  }

  // ── Mensagem com fromMe: ou é o eco do que o agente mandou (já gravado), ou
  // é um humano respondendo pelo celular. O humano precisa ficar no histórico:
  // é onde o agente não deu conta, que é justamente o que se quer melhorar.
  if (msg.fromMe) {
    try {
      if (await mensagemJaRegistrada(msg.msgId)) return;       // foi o próprio agente
      await pausarAtendimento(msg.telefone, 'humano: atendente respondeu na conversa');
      const tipoHumano = msg.tipo === 'audioMessage' ? 'audio' : msg.tipo === 'imageMessage' ? 'imagem' : 'texto';
      let textoHumano = msg.texto?.trim() || (tipoHumano === 'audio'
        ? '[Áudio enviado pela atendente]'
        : tipoHumano === 'imagem' ? '[Imagem enviada pela atendente]' : '');
      let transcricaoHumana = null, analiseImagemHumana = null;
      if (tipoHumano === 'audio') {
        try {
          const midia = msg.base64
            ? { base64: msg.base64, mimetype: msg.mimetype || 'audio/ogg' }
            : await comRetry(() => downloadMidia(msg.mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadAudioHumano' });
          transcricaoHumana = await comRetry(
            () => transcreverAudio(midia.base64, midia.mimetype || 'audio/ogg'),
            { tentativas: 2, requestId, etapa: 'transcricaoAudioHumano' }
          );
          textoHumano = `🎙️ [Áudio da atendente]: ${transcricaoHumana}`;
        } catch (err) {
          logger.warn('historico/humano/audio', 'Mídia de áudio da atendente não pôde ser transcrita', { requestId, telefone: msg.telefone, erro: err.message });
        }
      } else if (tipoHumano === 'imagem') {
        try {
          const midia = msg.base64
            ? { base64: msg.base64, mimetype: msg.mimetype || 'image/jpeg' }
            : await comRetry(() => downloadMidia(msg.mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadImagemHumana' });
          const analise = await comRetry(
            () => analisarImagem(midia.base64, midia.mimetype || 'image/jpeg'),
            { tentativas: 2, requestId, etapa: 'analiseImagemHumana' }
          );
          analiseImagemHumana = analise.analise;
          textoHumano = `${msg.texto?.trim() ? msg.texto.trim() + ' — ' : ''}📎 [Imagem da atendente]: ${analiseImagemHumana}`;
        } catch (err) {
          logger.warn('historico/humano/imagem', 'Mídia de imagem da atendente não pôde ser analisada', { requestId, telefone: msg.telefone, erro: err.message });
        }
      }
      if (!textoHumano) return;
      await salvarMensagem(msg.telefone, 'assistant', textoHumano, {
        origem: 'humano', tipo: tipoHumano, msgId: msg.msgId, requestId,
        transcricao: transcricaoHumana, analiseImagem: analiseImagemHumana,
      });
      await pausarAtendimento(msg.telefone, 'humano: atendente respondeu na conversa');
      logger.info('historico/humano', 'Resposta humana registrada', {
        requestId, telefone: msg.telefone, preview: msg.texto.slice(0, 60),
      });
    } catch (err) {
      logger.error('historico/humano/erro', err.message, { requestId, stack: err.stack });
    }
    return;   // humano assumiu: o agente não responde por cima
  }

  agrupador.adicionar(msg.telefone, { msg, requestId });
});

async function prepararEntrada({ msg, requestId }) {
  // telefone = identidade no banco | jid = endereço de resposta no WhatsApp (pode ser @lid)
  const { telefone, jid, pushName, tipo, anuncio, mensagemRaw, base64: base64Inline, mimetype: mimetypeInline } = msg;
  let conteudo = msg.texto;

  logger.step(requestId, telefone, 'webhook/recebido', { tipo, pushName, preview: (conteudo || '').slice(0, 60) });

  // Veio de anúncio: marca a origem já na primeira mensagem, antes de existir
  // pedido. Não pode derrubar o atendimento se falhar.
  if (anuncio) {
    try {
      await registrarOrigemAnuncio(telefone, pushName, anuncio);
      logger.info('origem/anuncio', 'Lead de anúncio registrado', {
        requestId, telefone, plataforma: anuncio.plataforma, anuncio_id: anuncio.anuncio_id,
      });
    } catch (err) {
      logger.error('origem/anuncio/erro', err.message, { requestId, telefone, stack: err.stack });
    }
  }

  // O que será gravado junto da mensagem do cliente. Guardar a transcrição e a
  // leitura da imagem separadas do texto permite auditar depois se o erro foi
  // do Whisper/Vision ou do agente.
  let transcricaoAudio = null, analiseImg = null;
  const metaEntrada = () => ({
    origem: 'cliente',
    tipo: tipo === 'audioMessage' ? 'audio' : tipo === 'imageMessage' ? 'imagem' : 'texto',
    msgId: msg.msgId, requestId, transcricao: transcricaoAudio, analiseImagem: analiseImg,
  });

  let isComprovante = false;
  try {
    // ── Mídia: áudio ───────────────────────────────────────────────────────
    if (tipo === 'audioMessage') {
      logger.step(requestId, telefone, 'midia/audio');
      let b64 = base64Inline, mime = mimetypeInline || 'audio/ogg';
      if (!b64) {
        const m = await comRetry(() => downloadMidia(mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadAudio' });
        b64 = m.base64; mime = m.mimetype || 'audio/ogg';
      }
      const transcricao = await comRetry(() => transcreverAudio(b64, mime), { tentativas: 2, requestId, etapa: 'whisper' });
      transcricaoAudio = transcricao;
      conteudo = `🎙️ [Áudio]: ${transcricao}`;
      logger.info('midia/audio/ok', 'Transcrito', { requestId, telefone, chars: transcricao.length });
    }

    // ── Mídia: imagem ──────────────────────────────────────────────────────
    if (tipo === 'imageMessage') {
      logger.step(requestId, telefone, 'midia/imagem');
      let b64 = base64Inline, mime = mimetypeInline || 'image/jpeg';
      if (!b64) {
        const m = await comRetry(() => downloadMidia(mensagemRaw), { tentativas: 3, requestId, etapa: 'downloadImagem' });
        b64 = m.base64; mime = m.mimetype || 'image/jpeg';
      }
      const r = await comRetry(() => analisarImagem(b64, mime), { tentativas: 2, requestId, etapa: 'gptVision' });
      isComprovante = r.isComprovante;
      analiseImg = r.analise;
      conteudo = isComprovante
        ? `📎 [Possível comprovante recebido, pagamento não confirmado]: ${r.analise}${conteudo ? ' — Legenda: ' + conteudo : ''}`
        : `📎 [Imagem]: ${r.analise}${conteudo ? ' — Legenda: ' + conteudo : ''}`;
      logger.info('midia/imagem/ok', 'Analisada', { requestId, telefone, isComprovante });
    }

  } catch (err) {
    logger.error('midia/erro', err.message, { requestId, telefone });
    conteudo = conteudo || (tipo === 'audioMessage' ? '[Áudio não pôde ser transcrito]' : '[Imagem não pôde ser analisada]');
    return { conteudo, isComprovante: false, meta: { ...metaEntrada(), erro: err.message } };
  }
  return { conteudo, isComprovante, meta: metaEntrada() };
}

async function processarMensagens(entradas) {
  const { msg, requestId } = entradas[entradas.length - 1];
  const { telefone, jid, pushName } = msg;
  // Comprovantes de pedidos existentes são recebidos mesmo fora do expediente.
  try { if (await tratarComprovantesWhatsApp(entradas)) return; }
  catch (err) { logger.error('pix/recebimento', err.message, { telefone });
    const texto = 'Não consegui registrar o comprovante agora. Seu pedido continua aguardando conferência. Tente anexar pelo cardápio ou reenviar em instantes.';
    const id = await enviarTexto(jid, texto);
    await salvarMensagem(telefone, 'assistant', texto, { origem: 'agente', msgId: id, etapa: 'pix/erro' });
    return;
  }
  const preparadas = await Promise.all(entradas.map(prepararEntrada));
  const conteudo = preparadas.map(e => e.conteudo).filter(t => t?.trim()).join('\n');
  const isComprovante = preparadas.some(e => e.isComprovante);
  let entradasSalvas = false;
  async function salvarEntradas(erro) {
    if (entradasSalvas) return;
    entradasSalvas = true;
    for (const e of preparadas) {
      if (e.conteudo?.trim()) await salvarMensagem(telefone, 'user', e.conteudo, { ...e.meta, ...(erro ? { erro } : {}) });
    }
  }
  if (!conteudo) return;
  try {

    // Durante a pausa, grava a mensagem do cliente e não responde por cima da
    // atendente. Depois que a pausa expira, o próximo envio volta ao agente e
    // o histórico já inclui tudo o que o cliente e a equipe disseram.
    let pausaAtiva;
    try {
      pausaAtiva = await carregarPausaAtiva(telefone);
    } catch (err) {
      logger.error('atendimento/pausa/consulta', err.message, { requestId, telefone, stack: err.stack });
      await salvarEntradas('pausa consultada sem sucesso');
      return;
    }
    if (pausaAtiva) {
      await salvarEntradas();
      logger.info('atendimento/pausado', 'Mensagem registrada; agente aguardando atendente', {
        requestId, telefone, pausado_ate: pausaAtiva.pausado_ate,
      });
      return;
    }

    // O bloqueio é determinístico: vale antes da saudação, IA e confirmação.
    const disponibilidade = avaliarFuncionamento(await buscarInfo());
    if (!disponibilidade.aberto) {
      await salvarEntradas();
      const idEnviado = await comRetry(() => enviarTexto(jid, disponibilidade.mensagem), { tentativas: 3, requestId, etapa: 'enviarForaHorario' });
      await salvarMensagem(telefone, 'assistant', disponibilidade.mensagem, { origem: 'agente', tipo: 'texto', msgId: idEnviado, requestId, etapa: 'fora_horario' });
      return;
    }

    // ── Estado ──────────────────────────────────────────────────────────────
    const [historico, rascunho] = await Promise.all([
      comRetry(() => carregarHistorico(telefone), { tentativas: 2, requestId, etapa: 'carregarHistorico' }),
      carregarRascunho(telefone),
    ]);
    logger.info('estado/ok', 'Estado carregado', {
      requestId, telefone, historico_msgs: historico.length, etapa: rascunho?.etapa_atual || 'sem rascunho',
    });

    // Grava o lote inteiro na ordem antes da resposta, sem duplicar no contexto.
    await salvarEntradas();

    // ── FLUXO 2: confirmação SIM (código cria o pedido) ──────────────────────
    if (ehConfirmacao(conteudo) && rascunho?.etapa_atual === 'aguardando_confirmacao') {
      logger.step(requestId, telefone, 'pedido/confirmando-via-SIM');
      await enviarDigitando(jid, 1500);
      try {
        const r = await confirmarPedido(rascunho, telefone, requestId);

        let txt;
        const linhaTaxa = r.taxaEntrega > 0 ? `🚴 Taxa de entrega: ${fmt(r.taxaEntrega)}\n` : '';
        const corpo =
          `🛍️ Subtotal: ${fmt(r.subtotal)}\n` + linhaTaxa + `💰 *Total: ${fmt(r.total)}*\n\n`;

        if (r.formaPagamento === 'pix') {
          const info = await buscarInfo();
          const chave = r.chavePix || info.chave_pix || 'não cadastrada';
          txt = `✅ Pedido *#${r.numeroPedido}* registrado!\n\n` + corpo +
            `📱 *Chave PIX:* \`${chave}\`\n\n` +
            `Envie o comprovante em PDF ou imagem por aqui, ou anexe no link:\n${r.linkPix}\n\nA equipe confere o recebimento na conta para liberar o pedido. 😊`;
        } else {
          const prazo = rascunho.tipo_entrega === 'delivery' ? cfg.prazoDelivery : cfg.prazoRetirada;
          txt = `✅ Pedido *#${r.numeroPedido}* confirmado!\n\n` + corpo +
            `Já tá indo pra cozinha! ⏱️ Previsão: ${prazo}. Bom apetite, ${pushName}! 🍻`;
        }

        await comRetry(() => enviarTexto(jid, txt), { tentativas: 3, requestId, etapa: 'enviarConfirmacao' });
        await Promise.all([
          salvarEntradas(),
          salvarMensagem(telefone, 'assistant', txt, { origem: 'agente', tipo: 'texto', requestId, etapa: rascunho?.etapa_atual }),
        ]);
        return;
      } catch (err) {
        logger.error('pedido/confirmar/erro', err.message, { requestId, telefone, faltando: err.faltando, stack: err.stack });
        const falta = ['LOJA_FECHADA', 'PIX_INDISPONIVEL'].includes(err.code) ? err.message : err.faltando?.length
          ? `Ainda preciso de: ${err.faltando.join(', ')}. Vamos completar?`
          : 'Tive um probleminha pra fechar o pedido. Pode me confirmar os dados de novo?';
        await enviarTexto(jid, `Opa! ${falta}`);
        await Promise.all([
          salvarEntradas(),
          salvarMensagem(telefone, 'assistant', falta, { origem: 'agente', tipo: 'texto', requestId, erro: err.message }),
        ]);
        return;
      }
    }

    // ── FLUXO 3: agente conversacional ───────────────────────────────────────
    await enviarDigitando(jid, 2500);
    const msgParaAgente = `[Cliente: ${pushName} | WhatsApp: ${telefone}]\n${conteudo}`;
    const r = await rodarAgente(msgParaAgente, historico, rascunho, requestId, telefone, disponibilidade);

    // A atendente ou o fechamento podem ter ocorrido enquanto a IA respondia.
    if (await carregarPausaAtiva(telefone)) return;
    const funcionamentoAtual = avaliarFuncionamento(await buscarInfo());
    if (!funcionamentoAtual.aberto) {
      r.texto = funcionamentoAtual.mensagem;
      r.handoff = null;
    }

    if (r.handoff) {
      await pausarAtendimento(telefone, `handoff: ${r.handoff.motivo}`);
      const idEnviado = await comRetry(() => enviarTexto(jid, r.texto), { tentativas: 3, requestId, etapa: 'enviarHandoff' });
      await Promise.all([
        salvarEntradas(),
        salvarMensagem(telefone, 'assistant', r.texto, {
          origem: 'agente', tipo: 'texto', msgId: idEnviado, requestId,
          toolCalls: r.toolCalls, modelo: r.modelo, latenciaMs: r.latenciaMs,
          tokensEntrada: r.tokensEntrada, tokensSaida: r.tokensSaida, etapa: 'atendimento/handoff',
        }),
      ]);
      logger.info('atendimento/handoff', 'Atendente avisada no painel; agente pausado', {
        requestId, telefone, motivo: r.handoff.motivo,
      });
      return;
    }

    if (!r.texto) {
      logger.warn('agente/vazio', 'Agente retornou vazio', { requestId, telefone });
      await enviarTexto(jid, 'Desculpa, não entendi bem 😅 Pode repetir?');
      await salvarEntradas('agente retornou vazio');
      return;
    }

    const idEnviado = await comRetry(() => enviarTexto(jid, r.texto), { tentativas: 3, requestId, etapa: 'enviarResposta' });
    logger.info('whatsapp/ok', 'Resposta enviada', { requestId, telefone, chars: r.texto.length });

    await Promise.all([
      salvarEntradas(),
      salvarMensagem(telefone, 'assistant', r.texto, {
        origem: 'agente', tipo: 'texto', msgId: idEnviado, requestId,
        toolCalls: r.toolCalls, modelo: r.modelo, latenciaMs: r.latenciaMs,
        tokensEntrada: r.tokensEntrada, tokensSaida: r.tokensSaida,
        etapa: rascunho?.etapa_atual || 'inicio',
      }),
    ]);

  } catch (err) {
    logger.error('webhook/erro-geral', err.message, { requestId, telefone, stack: err.stack });
    // grava a mensagem do cliente mesmo quando o atendimento falha — senão a
    // conversa que mais interessa analisar é justamente a que some do histórico
    try {
      await salvarEntradas(err.message);
    } catch {}
    try { await enviarTexto(jid, 'Opa, tive um problema técnico aqui 😅 Tenta de novo em instantes!'); } catch {}
  }
}


// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info('servidor/start', `🍻 Agente ${cfg.nome} rodando na porta ${PORT}`, {
    port: PORT,
    supa_url:  process.env.SUPA_URL       ? '✓' : '✗ FALTANDO',
    openai:    process.env.OPENAI_API_KEY ? '✓' : '✗ FALTANDO',
    evolution: process.env.EVOLUTION_URL  ? '✓' : '✗ FALTANDO',
  });
  iniciarPix();
  iniciarNotificacoes();   // avisa o cliente quando a cozinha move o pedido no painel
});
