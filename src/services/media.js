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
    model: 'gpt-5.5',
    max_completion_tokens: 400,
    response_format: { type: 'json_object' },
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
            text: 'Analise a imagem e responda em JSON: {"comprovante": true se for comprovante de pagamento (PIX/transferência) e false caso contrário, "resumo": "em português, 1 linha — se for comprovante, inclua valor, data/hora e destinatário visíveis; se não, descreva o que é"}',
          },
        ],
      },
    ],
  });

  // O modelo responde em JSON: antes a detecção era por palavra-chave e uma
  // resposta como "não é um comprovante" contava como comprovante válido,
  // dando o pedido como pago sem pagamento.
  const bruto = resposta.choices[0]?.message?.content || '';
  try {
    const j = JSON.parse(bruto);
    return { analise: String(j.resumo || bruto), isComprovante: j.comprovante === true };
  } catch {
    return { analise: bruto || 'Não foi possível analisar a imagem.', isComprovante: false };
  }
}

module.exports = { transcreverAudio, analisarImagem };
