'use strict';

// ─── MENSAGEM DE PEDIDO FECHADO ───────────────────────────────────────────────
// O cliente precisa ver o que pediu, quanto deu e — no Pix — a chave. Antes a
// confirmação só trazia subtotal e total; no Pix a chave vinha no meio do texto
// e ninguém conseguia copiar só ela. Agora a chave vai sozinha na 2ª mensagem.
const { parseItens } = require('./pedido');
const { chavePixValida } = require('./texto');
const { tipoChave } = require('./pix');

const fmt = v => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
const ROTULO_CHAVE = { celular: 'celular', cnpj: 'CNPJ', cpf: 'CPF', email: 'e-mail', aleatoria: 'chave aleatória' };
const ROTULO_PAGAMENTO = { pix: 'PIX', dinheiro: 'dinheiro', cartao: 'cartão' };

function linhasItens(itens) {
  return parseItens(itens).map(i => {
    const linha = `${i.quantidade}x ${i.nome} — ${fmt(Number(i.preco_unitario) * Number(i.quantidade))}`;
    return i.observacao ? `${linha}\n   _${i.observacao}_` : linha;
  }).join('\n');
}

// Devolve as mensagens a enviar, em ordem, e se a chave Pix faltou.
function mensagensPedidoFechado({ resultado: r, rascunho, info = {}, prazo, nome }) {
  const entrega = rascunho.tipo_entrega === 'delivery'
    ? `📍 Entrega: ${rascunho.endereco}`
    : '📍 Retirada no local';
  const pagamento = ROTULO_PAGAMENTO[r.formaPagamento] || r.formaPagamento;
  const totais = [
    `🛍️ Subtotal: ${fmt(r.subtotal)}`,
    r.taxaEntrega > 0 && `🚴 Taxa de entrega: ${fmt(r.taxaEntrega)}`,
    `💰 *Total: ${fmt(r.total)}*`,
  ].filter(Boolean).join('\n');
  const resumo = `${linhasItens(rascunho.itens)}\n\n${entrega}\n💳 Pagamento: ${pagamento}\n${totais}`;
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0];

  if (r.formaPagamento !== 'pix') {
    return {
      mensagens: [`✅ Pedido *#${r.numeroPedido}* confirmado!\n\n${resumo}\n\nJá tá indo pra cozinha! ⏱️ Previsão: ${prazo}.${primeiroNome ? ` Bom apetite, ${primeiroNome}!` : ''} 🍻`],
      semChave: false,
    };
  }

  const chave = [r.chavePix, info.chave_pix].find(chavePixValida);
  if (!chave) {
    return {
      mensagens: [`✅ Pedido *#${r.numeroPedido}* registrado!\n\n${resumo}\n\n📱 A equipe já te manda a chave PIX por aqui.`],
      semChave: true,
    };
  }
  const tipo = ROTULO_CHAVE[tipoChave(chave)];
  const titular = String(info.pix_titular || '').trim();
  const envio = r.linkPix
    ? `Pagou? Manda o comprovante aqui (imagem ou PDF) ou anexe no link:\n${r.linkPix}`
    : 'Pagou? É só mandar o comprovante aqui (imagem ou PDF).';
  return {
    mensagens: [
      `✅ Pedido *#${r.numeroPedido}* registrado!\n\n${resumo}\n\n` +
      `💠 Pague *${fmt(r.total)}* no PIX${tipo ? ` (chave ${tipo})` : ''} — mando a chave sozinha aqui embaixo pra copiar fácil 👇` +
      (titular ? `\nTitular: *${titular}*` : '') +
      `\n\n${envio} A equipe confere o recebimento e libera pra cozinha 😊`,
      String(chave).trim(),
    ],
    semChave: false,
  };
}

module.exports = { mensagensPedidoFechado, linhasItens };
