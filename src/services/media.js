'use strict';

// Tudo via OpenAI: Whisper para áudio, GPT-4o para análise de imagem.

const OpenAI = require('openai');
const FormData = require('form-data');
const axios = require('axios');

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── TRANSCRIÇÃO DE ÁUDIO (Whisper) ──────────────────────────────────────────

async function transcreverAudio(base64, mimetype = 'audio/ogg') {
  const buffer = Buffer.from(base64, 'base64');

  const form = new FormData();
  form.append('file', buffer, {
    filename: 'audio.ogg',
    contentType: mimetype.split(';')[0],
  });
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const { data } = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      timeout: 30000,
    }
  );

  if (!data?.text) throw new Error('Whisper não retornou transcrição.');
  return data.text.trim();
}

// ─── ANÁLISE DE IMAGEM (GPT-4o Vision) ───────────────────────────────────────

async function analisarImagem(base64, mimetype = 'image/jpeg') {
  const openai = getClient();

  const resposta = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 400,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimetype};base64,${base64}`, detail: 'low' },
          },
          {
            type: 'text',
            text: 'Analise esta imagem. Responda em português:\n1. É um comprovante de pagamento PIX? (sim/não)\n2. Se sim: valor transferido, data/hora e nome do destinatário (se visível).\n3. Se não: descreva em 1 linha o que é.\nSeja direto e objetivo.',
          },
        ],
      },
    ],
  });

  const analise = resposta.choices[0]?.message?.content || 'Não foi possível analisar a imagem.';
  const lower = analise.toLowerCase();
  const isComprovante =
    (lower.includes('sim') && lower.includes('pix')) ||
    lower.includes('comprovante') ||
    lower.includes('transferência');

  return { analise, isComprovante };
}

module.exports = { transcreverAudio, analisarImagem };
