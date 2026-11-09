'use strict';

// ─── LEITURA DE MENSAGENS DO CLIENTE ──────────────────────────────────────────
// Regras determinísticas (sem IA) para decidir o fluxo. Ficam aqui, puras,
// para serem testadas com as frases reais que chegaram no WhatsApp.

function limpar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, ' ')   // emojis
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Palavras que só cumprimentam. "Boa noite, tudo bem?" é saudação; "Boa noite,
// vocês entregam?" não é — tem uma pergunta que precisa de resposta.
const SAUDACAO = new Set([
  'oi', 'oii', 'oiii', 'oie', 'oiee', 'oiie', 'ola', 'olaa', 'alo', 'opa', 'opaa', 'eai', 'eae', 'e', 'ai', 'ae',
  'hey', 'hi', 'hello', 'salve', 'bom', 'boa', 'dia', 'tarde', 'noite', 'tudo', 'td', 'bem',
  'com', 'voce', 'voces', 'vc', 'vcs', 'como', 'vai', 'pessoal', 'gente', 'tranquilo', 'blz', 'beleza', 'e',
]);

function apenasSaudacao(texto) {
  // áudio transcrito chega como "🎙️ [Áudio]: boa noite" — vale o que foi dito
  const t = limpar(String(texto || '').replace(/🎙️?\s*\[Áudio\]:/gu, ''));
  if (!t) return true;                        // só emoji / figurinha
  return t.split(' ').every(p => SAUDACAO.has(p) || /^(o+i+e*|ol+a+|hel+o+w*|ki+)$/.test(p));
}

// Confirmação do resumo do pedido. As mensagens chegam agrupadas por 10s, então
// "Sim\nPode fechar" precisa valer — antes só "sim" sozinho era aceito e a IA
// respondia "vamos fechar" sem fechar nada.
const AFIRMA = new Set([
  'sim', 'simm', 'simmm', 's', 'isso', 'pode', 'confirmar', 'confirma', 'confirmo', 'confirmado',
  'fechar', 'fecha', 'fechado', 'fechou', 'ok', 'okay', 'okk', 'certo', 'correto', 'beleza', 'blz',
  'perfeito', 'manda', 'mandar', 'bora', 'finalizar', 'finaliza', '1',
]);
const NEUTRA = new Set([
  'mesmo', 'ser', 'ta', 'esta', 'tudo', 'por', 'favor', 'pf', 'pfv', 'obrigado', 'obrigada', 'obg', 'valeu',
  'vlw', 'pode', 'entao', 'ai', 'la', 'o', 'a', 'meu', 'pedido', 'show', 'top', 'otimo', 'certinho', 'sim',
]);

function ehConfirmacao(texto) {
  const original = String(texto || '');
  if (/👍|✅|👌/u.test(original) && !limpar(original)) return true;
  const palavras = limpar(original).split(' ').filter(Boolean);
  if (!palavras.length) return false;
  if (!palavras.some(p => AFIRMA.has(p))) return false;
  return palavras.every(p => AFIRMA.has(p) || NEUTRA.has(p));
}

// "PENDENTE-chave-pix" chegou a ser mostrado para três clientes como se fosse a
// chave. Qualquer valor de exemplo ou vazio é tratado como "não cadastrada".
function chavePixValida(valor) {
  const v = String(valor || '').trim();
  return v.length >= 5 && !/pendente|exemplo|xxx|sua[-_ ]?chave/i.test(v);
}

// Remove valores de exemplo que sobraram do restaurante anterior.
function valorConfiavel(valor) {
  const v = String(valor ?? '').trim();
  return v && !/^pendente|nexus/i.test(v) ? v : null;
}

module.exports = { limpar, apenasSaudacao, ehConfirmacao, chavePixValida, valorConfiavel };
