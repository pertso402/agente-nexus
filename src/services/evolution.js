'use strict';

const axios = require('axios');

function cliente() {
  return axios.create({
    baseURL: process.env.EVOLUTION_URL,
    headers: {
      apikey: process.env.EVOLUTION_KEY,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

// encodeURIComponent: o nome da instância pode ter espaço/acento (ex: "Agente teste"),
// e o Node rejeita path com caractere não escapado (ERR_UNESCAPED_CHARACTERS).
const INSTANCE = () => encodeURIComponent(process.env.EVOLUTION_INSTANCE || '');

// ─── EXTRAIR CAMPOS DO PAYLOAD EVOLUTION API v2 ───────────────────────────────

function extrairMensagem(body) {
  const data = body.data || body;
  const key = data.key || {};
  const message = data.message || {};
  const messageType = data.messageType || Object.keys(message)[0] || 'conversation';

  if (key.fromMe === true) return null;                        // mensagem própria
  const remoteJid = key.remoteJid || '';
  if (remoteJid.includes('@g.us')) return null;                // grupo

  // Endereçamento LID: contatos migrados chegam com remoteJid = "<id>@lid" e o
  // telefone em remoteJidAlt. A sessão de criptografia válida é a do LID — responder
  // no JID de telefone falha na entrega (status ERROR), mesmo a API retornando 201.
  // Por isso: responder SEMPRE no remoteJid recebido; guardar o telefone para o banco.
  const jid = remoteJid;
  const jidTelefone = key.remoteJidAlt || remoteJid;
  const telefone = jidTelefone.replace(/@.*$/, '');
  const pushName = data.pushName || 'Cliente';

  let texto = '';
  let tipo = messageType;

  if (messageType === 'conversation') {
    texto = message.conversation || '';
  } else if (messageType === 'extendedTextMessage') {
    texto = message.extendedTextMessage?.text || '';
    tipo = 'text';
  } else if (messageType === 'audioMessage') {
    texto = '';
  } else if (messageType === 'imageMessage') {
    texto = message.imageMessage?.caption || '';
  } else if (messageType === 'documentMessage') {
    texto = '[Documento recebido]';
    tipo = 'text';
  } else {
    return null; // tipo não suportado
  }

  // Quando webhookBase64=true, Evolution já inclui o base64 no payload
  const base64   = data.base64   || message.base64   || null;
  const mimetype = data.mimetype || message.mimetype ||
    message.audioMessage?.mimetype || message.imageMessage?.mimetype || null;

  return { telefone, jid, pushName, tipo, texto, mensagemRaw: message, base64, mimetype };
}

// ─── DOWNLOAD DE MÍDIA ────────────────────────────────────────────────────────

async function downloadMidia(mensagemRaw) {
  const { data } = await cliente().post(
    `/message/downloadMediaMessage/${INSTANCE()}`,
    { message: mensagemRaw }
  );
  // Retorna { base64, mimetype }
  if (!data?.base64) throw new Error('Evolution não retornou base64 da mídia.');
  return data;
}

// ─── ENVIO DE MENSAGENS ───────────────────────────────────────────────────────

async function enviarTexto(telefone, texto) {
  await cliente().post(`/message/sendText/${INSTANCE()}`, {
    number: telefone,
    text: texto,
    delay: 800,
  });
}

async function enviarDigitando(telefone, duracaoMs = 2000) {
  try {
    await cliente().post(`/message/sendPresence/${INSTANCE()}`, {
      number: telefone,
      presence: 'composing',
      delay: duracaoMs,
    });
  } catch {
    // não crítico
  }
}

module.exports = { extrairMensagem, downloadMidia, enviarTexto, enviarDigitando };
