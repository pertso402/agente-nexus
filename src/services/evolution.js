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

const INSTANCE = () => process.env.EVOLUTION_INSTANCE;

function extrairMensagem(body) {
  const data = body.data || body;
  const key = data.key || {};
  const message = data.message || {};
  const messageType = data.messageType || Object.keys(message)[0] || 'conversation';

  if (key.fromMe === true) return null;
  const remoteJid = key.remoteJid || '';
  if (remoteJid.includes('@g.us')) return null;

  const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
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
    return null;
  }

  const base64   = data.base64   || message.base64   || null;
  const mimetype = data.mimetype || message.mimetype ||
    message.audioMessage?.mimetype || message.imageMessage?.mimetype || null;

  return { telefone, pushName, tipo, texto, mensagemRaw: message, base64, mimetype };
}

async function downloadMidia(mensagemRaw) {
  const { data } = await cliente().post(
    `/message/downloadMediaMessage/${INSTANCE()}`,
    { message: mensagemRaw }
  );
  if (!data?.base64) throw new Error('Evolution não retornou base64 da mídia.');
  return data;
}

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
