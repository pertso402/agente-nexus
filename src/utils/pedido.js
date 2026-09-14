'use strict';

// ─── LÓGICA DE DOMÍNIO PURA DO PEDIDO ─────────────────────────────────────────
// Sem acesso a banco. Funções determinísticas usadas para decidir o estado
// do pedido. O CÓDIGO (não a LLM) é a fonte da verdade sobre o que falta.

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '') // remove acentos
    .replace(/\s+/g, ' ')
    .trim();
}

function parseItens(itens) {
  if (Array.isArray(itens)) return itens;
  if (typeof itens === 'string') {
    try { const v = JSON.parse(itens); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  return [];
}

// Avalia o rascunho e decide a etapa DETERMINISTICAMENTE.
// etapa "aguardando_confirmacao" SÓ é atingida quando TUDO está presente.
function avaliarRascunho(r = {}) {
  const itens = parseItens(r.itens);
  const faltando = [];

  if (!itens.length)                                    faltando.push('itens');
  if (!r.nome_cliente)                                  faltando.push('nome');
  if (!r.tipo_entrega)                                  faltando.push('tipo_entrega');
  if (r.tipo_entrega === 'delivery' && !r.endereco)     faltando.push('endereco');
  if (!r.forma_pagamento)                               faltando.push('forma_pagamento');

  const completo = faltando.length === 0;

  let etapa;
  if (completo)            etapa = 'aguardando_confirmacao';
  else if (itens.length)   etapa = 'coletando_dados';
  else                     etapa = 'coletando_itens';

  return { completo, faltando, etapa, itens };
}

const LABEL_FALTANDO = {
  itens:           'os itens do pedido',
  nome:            'o nome completo do cliente',
  tipo_entrega:    'se é entrega (delivery) ou retirada',
  endereco:        'o endereço de entrega',
  forma_pagamento: 'a forma de pagamento (pix, dinheiro ou cartão)',
};

function descreverFaltando(faltando) {
  return faltando.map(f => LABEL_FALTANDO[f] || f).join(', ');
}

function calcularSubtotal(itens) {
  return parseItens(itens).reduce(
    (s, i) => s + Number(i.preco_unitario || 0) * Number(i.quantidade || 0),
    0
  );
}

module.exports = { normalizar, parseItens, avaliarRascunho, descreverFaltando, calcularSubtotal, LABEL_FALTANDO };
