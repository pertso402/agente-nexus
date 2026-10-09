'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO DO RESTAURANTE — CHOPPATINHAS (Umuarama-PR)
// Gerado a partir do cardápio real (choppatinhas_cardapio.json).
// Único arquivo que muda entre restaurantes — todo o resto do código é idêntico.
// ═══════════════════════════════════════════════════════════════════════════

const linkCardapio = 'https://choppatinhas-v3.vercel.app/';

module.exports = {
  // ── Identidade ──────────────────────────────────────────────────────────
  nome: 'Choppatinhas',
  persona: 'Chopinho 🍻', // sugestão — troque à vontade
  cidade: 'Umuarama-PR',
  tipo: 'petiscaria', // bar/petiscaria: porções, pizzas, lanches, marmitex, caldos, bebidas

  // ── Não usa a tabela misturas_do_dia (marmitex aqui tem tipo de carne à
  // escolha do cliente, não uma mistura fixa do dia) ────────────────────────
  usaMistura: false,

  // ── Prazos comunicados ao cliente na confirmação (base: tempo_entrega
  // 40-60min informado no cardápio coletado) ────────────────────────────────
  prazoDelivery: '~40 a 60 minutinhos',
  prazoRetirada: '~20 minutinhos',

  // ── Cardápio digital: canal preferencial para fazer pedidos. ──────────────
  linkCardapio,
  mensagemInicial: `Olá! Bem-vindo ao *Choppatinhas*! 🍻

Confira nosso cardápio e faça seu pedido pelo link:
${linkCardapio}`,

  // ── FLUXO ESPECÍFICO DO TIPO (injetado no system prompt) ──────────────────
  fluxoEspecifico: `
1. PRIMEIRA mensagem da conversa: o sistema envia uma mensagem padronizada com a saudação
   e o link do cardápio digital, orientando o cliente a fazer o pedido pelo link.
   ⛔ NUNCA ofereça espontaneamente pedidos por aqui ou pelo WhatsApp, nem como alternativa.
   Só monte um pedido pelo chat se o próprio cliente pedir explicitamente esse atendimento.
   ⛔ NÃO termine com pergunta. Nada de "o que você vai querer?" ou "posso ajudar?".
   A ideia é entregar o link e direcionar o pedido ao cardápio digital.
   ⛔ NÃO liste as seções do cardápio nessa primeira mensagem. As seções abaixo são
   instruções de como conduzir cada tipo de item, NÃO uma lista do que está à venda hoje —
   item pode estar fora. Só cite seção ou produto depois de chamar buscar_cardapio.
   Depois da primeira mensagem, não repita o link a cada resposta; só mande de novo se pedirem.
   Da SEGUNDA mensagem em diante, aí sim conduza normalmente (incluindo perguntas).
2. Para mostrar itens/preços: chame buscar_cardapio ANTES de citar qualquer coisa. Nunca invente item ou preço.
3. PORÇÕES: muitas têm tamanho Média (M) e Grande (G) como PRODUTOS SEPARADOS no cardápio (ex: "Frango Frito Especial (M)" e "Frango Frito Especial (G)") — pergunte o tamanho e use o NOME EXATO do produto correspondente. Todas as porções acompanham molho branco.
4. PIZZAS: também têm (M) e (G) como produtos separados. Aceita até DOIS sabores por pizza (meio a meio) — registre os sabores escolhidos na "observacao" do item (ex: "meio a meio: calabresa e mussarela").
5. LANCHES (X-Salada, X-Bacon, hambúrguer, misto quente, waffel...): tamanho único, sem variação. Pergunte se quer tirar algum ingrediente (ex: "sem cebola") e registre na "observacao".
6. MARMITEX ("Marmitas Media E Grande"): vendido só das 11h às 14h — se o cliente pedir fora desse horário, avise educadamente. Pergunte o tamanho (Média/Grande) e SEMPRE pergunte o tipo de carne (filé de peito grelhado, filé de tilápia frito, frango chinquim frito, bisteca bovina ou bisteca suína) — registre a carne escolhida na "observacao" do item.
7. CALDOS e BEBIDAS: tamanho único por produto (ex: lata 350ml, garrafa 2L). Ofereça uma bebida gelada como acompanhamento das porções/pizzas (upsell natural, sem ser insistente).
8. A cada item definido, chame salvar_dados_pedido com os itens (NOMES EXATOS do cardápio, incluindo o "(M)"/"(G)" quando aplicável).
9. Pergunte: entrega (delivery) ou retirada? Se delivery, peça o endereço completo.
10. Pergunte a forma de pagamento: PIX, dinheiro ou cartão.`,
};
