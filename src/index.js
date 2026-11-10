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
  carregarRascunhoAtivo, limparRascunho,
  buscarInfo, atualizarStatusPedido, registrarOrigemAnuncio,
  mensagemJaRegistrada,
  contatoIgnorado, conversaIniciadaPelaLoja, semConversaRecente,
  carregarFaq, mensagensRecentes, reabrirLojaSeEsquecida,
  pedidosEmAndamento, anotarComprovantePix,
} = require('./services/supabase');
const { rodarAgente, confirmarPedido } = require('./agent');
const { comRetry } = require('./utils/retry');
const cfg = require('./config/restaurante');
const { iniciarNotificacoes } = require('./notificacoes');
const { iniciarPix, tratarComprovantesWhatsApp } = require('./services/pix');
const { criarAgrupador } = require('./utils/agrupador');
const { avaliarFuncionamento } = require('./utils/horarios');
const { proximaAbertura } = require('./utils/funcionamento');
const { apenasSaudacao, ehConfirmacao } = require('./utils/texto');
const { mensagensPedidoFechado } = require('./utils/mensagens');
const ESPERA_MENSAGENS_MS = Math.max(1, Number(process.env.AGRUPAR_MENSAGENS_SEGUNDOS) || 10) * 1000;
const agrupador = criarAgrupador({
  esperaMs: ESPERA_MENSAGENS_MS,
  processar: processarMensagens,
  onError: (err, telefone) => logger.error('mensagens/lote', err.message, { telefone }),
});

const app = express();
app.use(express.json({ limit: '10mb' }));

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

  // Equipe, fornecedores e família usam o mesmo número. Esses contatos não
  // passam pela IA nem vão para o banco (áudios pessoais eram transcritos).
  try {
    if (await contatoIgnorado(msg.telefone)) {
      logger.info('webhook/contato-ignorado', 'Contato da equipe/fornecedor — não processado', { requestId });
      return;
    }
  } catch (err) {
    logger.error('webhook/contatos-ignorados', err.message, { requestId });
  }

  // ── Mensagem com fromMe: ou é o eco do que o agente mandou (já gravado), ou
  // é um humano respondendo pelo celular. O humano precisa ficar no histórico:
  // é onde o agente não deu conta, que é justamente o que se quer melhorar.
  if (msg.fromMe) {
    try {
      if (await mensagemJaRegistrada(msg.msgId)) return;       // foi o próprio agente
      // Mensagem da loja abrindo conversa (ou dentro de uma que ela abriu) é
      // assunto da equipe: guarda o texto, mas não manda áudio/foto para a IA.
      const daLoja = await semConversaRecente(msg.telefone) || await conversaIniciadaPelaLoja(msg.telefone);
      await pausarAtendimento(msg.telefone, 'humano: atendente respondeu na conversa');
      const tipoHumano = msg.tipo === 'audioMessage' ? 'audio' : msg.tipo === 'imageMessage' ? 'imagem' : 'texto';
      let textoHumano = msg.texto?.trim() || (tipoHumano === 'audio'
        ? '[Áudio enviado pela atendente]'
        : tipoHumano === 'imagem' ? '[Imagem enviada pela atendente]' : '');
      let transcricaoHumana = null, analiseImagemHumana = null;
      if (daLoja) {
        // texto/legenda já está em textoHumano
      } else if (tipoHumano === 'audio') {
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

const ROTULO_MIDIA = { audioMessage: '[Áudio]', imageMessage: '[Imagem]', documentMessage: '[Documento]' };

async function processarMensagens(entradas) {
  const { msg, requestId } = entradas[entradas.length - 1];
  const { telefone, jid, pushName } = msg;

  // Conversa que a equipe começou (motoboy, fornecedor, "qual o número da sua
  // casa?"): grava o que o contato disse, sem IA e sem transcrever mídia.
  let daLoja = false;
  try { daLoja = await conversaIniciadaPelaLoja(telefone); }
  catch (err) { logger.error('atendimento/conversa-da-loja', err.message, { requestId, telefone }); }
  if (daLoja) {
    for (const { msg: m, requestId: rid } of entradas) {
      const texto = [ROTULO_MIDIA[m.tipo], m.texto?.trim()].filter(Boolean).join(' ');
      if (texto) await salvarMensagem(telefone, 'user', texto, {
        origem: 'cliente', tipo: m.tipo === 'audioMessage' ? 'audio' : m.tipo === 'imageMessage' ? 'imagem' : 'texto',
        msgId: m.msgId, requestId: rid, etapa: 'conversa_da_loja',
      });
    }
    logger.info('atendimento/conversa-da-loja', 'Conversa iniciada pela equipe — agente fora', { requestId, telefone });
    return;
  }
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

    // Comprovante de Pix (sem o pix.sql, que tem fluxo próprio): anota no pedido
    // em aberto para a equipe conferir e avisa o cliente — mesmo com a loja já
    // fechada (cliente pagou às 22:46 e recebeu "atendimento indisponível").
    if (isComprovante) {
      const [pedidoPix] = (await pedidosEmAndamento(telefone, 6).catch(() => []))
        .filter(p => String(p.forma_pagamento).toLowerCase() === 'pix');
      if (pedidoPix) {
        await salvarEntradas();
        const leitura = preparadas.find(e => e.isComprovante)?.meta?.analiseImagem;
        await anotarComprovantePix(pedidoPix, leitura)
          .catch(err => logger.error('pix/anotar-comprovante', err.message, { requestId, telefone }));
        await limparRascunho(telefone).catch(() => {});
        const texto = `Recebi o comprovante do pedido *#${pedidoPix.numero_pedido}* ✅\n\nA equipe confere o recebimento na conta e libera pra cozinha. Assim que entrar em preparo, te aviso por aqui 🍻`;
        const id = await comRetry(() => enviarTexto(jid, texto), { tentativas: 3, requestId, etapa: 'enviarComprovanteRecebido' });
        await salvarMensagem(telefone, 'assistant', texto, { origem: 'agente', tipo: 'texto', msgId: id, requestId, etapa: 'pix/comprovante' });
        return;
      }
    }

    // O bloqueio é determinístico: vale antes da saudação, IA e confirmação.
    // Exceção: quem tem pedido em andamento continua sendo atendido sobre ele
    // (pedido novo continua bloqueado no banco e em criarPedidoCompleto).
    const info = await buscarInfo();
    const disponibilidade = avaliarFuncionamento(info);
    const emAndamento = !disponibilidade.aberto &&
      (await pedidosEmAndamento(telefone, 6).catch(() => [])).length > 0;
    if (!disponibilidade.aberto && !emAndamento) {
      await salvarEntradas();
      // Um aviso basta: teve cliente recebendo o mesmo texto 4 vezes seguidas.
      const recentes = await mensagensRecentes(telefone, 3).catch(() => []);
      if (recentes.some(m => m.origem === 'agente' && m.etapa_pedido === 'fora_horario')) {
        logger.info('atendimento/fechado', 'Aviso de fechado já enviado — só registrado', { requestId, telefone });
        return;
      }
      const texto = mensagemFechado(disponibilidade, info);
      const idEnviado = await comRetry(() => enviarTexto(jid, texto), { tentativas: 3, requestId, etapa: 'enviarForaHorario' });
      await salvarMensagem(telefone, 'assistant', texto, { origem: 'agente', tipo: 'texto', msgId: idEnviado, requestId, etapa: 'fora_horario' });
      return;
    }

    // ── Estado ──────────────────────────────────────────────────────────────
    const [historico, rascunho] = await Promise.all([
      comRetry(() => carregarHistorico(telefone), { tentativas: 2, requestId, etapa: 'carregarHistorico' }),
      carregarRascunhoAtivo(telefone),
    ]);
    logger.info('estado/ok', 'Estado carregado', {
      requestId, telefone, historico_msgs: historico.length, etapa: rascunho?.etapa_atual || 'sem rascunho',
    });

    // Grava o lote inteiro na ordem antes da resposta, sem duplicar no contexto.
    await salvarEntradas();

    // ── FLUXO 2: fechar o pedido (o código cria; o cliente ou a IA confirmam) ─
    const fecharPedido = async (rascunhoAtual) => {
      await enviarDigitando(jid, 1500);
      try {
        const r = await confirmarPedido(rascunhoAtual, telefone, requestId);
        const prazo = rascunhoAtual.tipo_entrega === 'delivery' ? cfg.prazoDelivery : cfg.prazoRetirada;
        const { mensagens, semChave } = mensagensPedidoFechado({
          resultado: r, rascunho: rascunhoAtual, info, prazo, nome: rascunhoAtual.nome_cliente || pushName,
        });
        await salvarEntradas();
        for (const [i, txt] of mensagens.entries()) {
          // o id evita que o eco desta mensagem seja lido como atendente humana
          const id = await comRetry(() => enviarTexto(jid, txt), { tentativas: 3, requestId, etapa: 'enviarConfirmacao' });
          await salvarMensagem(telefone, 'assistant', txt, { origem: 'agente', tipo: 'texto', msgId: id, requestId, etapa: i ? 'pix/chave' : rascunhoAtual.etapa_atual });
        }
        if (semChave) await pausarAtendimento(telefone, `handoff: pedido #${r.numeroPedido} em Pix — enviar a chave ao cliente (chave não cadastrada no sistema)`);
      } catch (err) {
        logger.error('pedido/confirmar/erro', err.message, { requestId, telefone, faltando: err.faltando, stack: err.stack });
        const falta = ['LOJA_FECHADA', 'PIX_INDISPONIVEL'].includes(err.code) ? err.message : err.faltando?.length
          ? `Ainda preciso de: ${err.faltando.join(', ')}. Vamos completar?`
          : 'Tive um probleminha pra fechar o pedido. Pode me confirmar os dados de novo?';
        const idFalta = await enviarTexto(jid, `Opa! ${falta}`);
        await Promise.all([
          salvarEntradas(),
          salvarMensagem(telefone, 'assistant', `Opa! ${falta}`, { origem: 'agente', tipo: 'texto', msgId: idFalta, requestId, erro: err.message }),
        ]);
      }
    };
    if (ehConfirmacao(conteudo) && rascunho?.etapa_atual === 'aguardando_confirmacao') {
      logger.step(requestId, telefone, 'pedido/confirmando-via-SIM');
      return fecharPedido(rascunho);
    }

    // ── FLUXO 3: agente conversacional ───────────────────────────────────────
    await enviarDigitando(jid, 2500);
    const msgParaAgente = `[Cliente: ${pushName} | WhatsApp: ${telefone}]\n${conteudo}`;
    const faq = await carregarFaq().catch(() => []);
    const r = await rodarAgente(msgParaAgente, historico, rascunho, requestId, telefone, disponibilidade, { faq });

    // "Pode mandar o pix", "confirmei com a patroa": a IA reconheceu o aceite.
    if (r.confirmar) {
      const atual = await carregarRascunhoAtivo(telefone);
      if (atual?.etapa_atual === 'aguardando_confirmacao') return fecharPedido(atual);
      r.texto = 'Me confirma de novo, por favor: posso fechar o pedido?';
    }

    // Envia uma resposta do agente. Devolve true quando a conversa deve parar.
    const responder = async (r) => {
      // A atendente ou o fechamento podem ter ocorrido enquanto a IA respondia.
      if (await carregarPausaAtiva(telefone)) return true;
      const funcionamentoAtual = avaliarFuncionamento(await buscarInfo());
      if (!funcionamentoAtual.aberto && !emAndamento) {
        r.texto = funcionamentoAtual.mensagem;
        r.handoff = null;
      }

      if (r.handoff) {
        // O cliente que seguia escrevendo recebia "Vou chamar uma atendente" a
        // cada mensagem. Segunda vez: avisa que já chamou. Depois: só registra.
        const recentes = await mensagensRecentes(telefone, 2).catch(() => []);
        let jaChamou = 0;
        for (const m of recentes) {
          if (m.origem === 'humano') break;
          if (m.etapa_pedido === 'atendimento/handoff') jaChamou++;
        }
        await pausarAtendimento(telefone, `handoff: ${r.handoff.motivo}`);
        if (jaChamou >= 2) {
          await salvarEntradas();
          logger.info('atendimento/handoff', 'Atendente já chamada — sem nova mensagem ao cliente', { requestId, telefone, motivo: r.handoff.motivo });
          return true;
        }
        if (jaChamou === 1) r.texto = 'Já avisei a equipe 🙏 Assim que alguém estiver livre, continua com você por aqui.';
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
        return true;
      }

      if (!r.texto) {
        logger.warn('agente/vazio', 'Agente retornou vazio', { requestId, telefone });
        await enviarTexto(jid, 'Desculpa, não entendi bem 😅 Pode repetir?');
        await salvarEntradas('agente retornou vazio');
        return true;
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
      return false;
    };

    if (await responder(r)) return;

    // Primeiro contato recebe sempre o texto fixo (PR #1). Se a pessoa já veio
    // com uma pergunta ("vocês entregam?", "aceitam ticket?"), ela ficava sem
    // resposta — agora a IA responde logo depois, numa segunda mensagem.
    const ehAbertura = r.modelo == null && r.texto === cfg.mensagemInicial;
    if (ehAbertura && !apenasSaudacao(conteudo)) {
      await enviarDigitando(jid, 2500);
      await responder(await rodarAgente(msgParaAgente, [{ role: 'assistant', content: r.texto }], rascunho, requestId, telefone, disponibilidade, { faq }));
    }

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


// "Estamos fora do horário" + quando abre. Pausa manual não tem previsão.
function mensagemFechado(disponibilidade, info) {
  const prox = disponibilidade.motivo === 'horario' ? proximaAbertura(info) : null;
  if (!prox) return disponibilidade.mensagem;
  const partes = disponibilidade.mensagem.split('\n\n');
  partes.splice(partes.length - 1, 0, prox.texto);
  return partes.join('\n\n');
}

// Reabre a loja quando alguém fechou no painel num dia anterior e esqueceu.
function iniciarAberturaAutomatica() {
  if (String(process.env.REABRIR_LOJA_AUTOMATICO ?? 'true') === 'false') return;
  const rodar = () => reabrirLojaSeEsquecida()
    .then(r => { if (r) logger.warn('loja/reaberta', 'Loja reaberta pela agenda (estava fechada desde outro dia)', { fechadaEm: r.fechadaEm }); })
    .catch(err => logger.error('loja/reabertura', err.message, {}));
  rodar();
  setInterval(rodar, 60_000).unref?.();
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
  iniciarAberturaAutomatica();
  iniciarNotificacoes();   // avisa o cliente quando a cozinha move o pedido no painel
});
