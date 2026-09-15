'use strict';

const db = require('../services/supabase');
const cfg = require('../config/restaurante');
const { descreverFaltando, calcularSubtotal, parseItens } = require('../utils/pedido');

// Ordem das categorias: comida primeiro, bebidas/condimentos por último
const ORDEM_CATEGORIA = {
  'pizzas': 0, 'pizza': 0, 'burgers': 0, 'hamburgueres': 0, 'lanches': 0,
  'marmitex': 0, 'marmitas': 0, 'combos': 1, 'combo': 1,
  'adicionais': 6, 'acompanhamentos': 7, 'maioneses': 8, 'sobremesas': 8, 'bebidas': 9,
};
function prioridadeCategoria(cat) {
  const k = String(cat || '').toLowerCase().trim();
  return ORDEM_CATEGORIA[k] ?? 5;
}

// ─── DEFINIÇÃO DAS TOOLS (formato OpenAI function calling) ───────────────────

const TOOL_CARDAPIO = {
  type: 'function',
  function: {
    name: 'buscar_cardapio',
    description: 'Retorna todos os produtos disponíveis com preços REAIS. Use SEMPRE antes de citar qualquer produto, preço ou quando o cliente quiser pedir. Nunca invente itens.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const TOOL_MISTURA = {
  type: 'function',
  function: {
    name: 'buscar_mistura_do_dia',
    description: 'Retorna a mistura/acompanhamentos da marmitex de hoje. Use sempre que falar de marmitex.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const TOOL_INFO = {
  type: 'function',
  function: {
    name: 'info_restaurante',
    description: 'Retorna chave PIX, endereço, horário, taxa de entrega e status (aberta/fechada). Use para enviar PIX ou verificar horário/taxa.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const TOOL_SALVAR = {
  type: 'function',
  function: {
    name: 'salvar_dados_pedido',
    description: 'Salva/atualiza os dados do pedido no rascunho. Chame SEMPRE que coletar qualquer informação (itens, nome, entrega, endereço, pagamento) — pode chamar com um campo só. O retorno diz o que ainda falta e se o pedido está pronto para confirmação. NÃO precisa enviar tudo de uma vez.',
    parameters: {
      type: 'object',
      properties: {
        nome_cliente: { type: 'string', description: 'Nome do cliente' },
        itens: {
          type: 'array',
          description: 'Itens do pedido. Use os NOMES EXATOS do cardápio. O preço será preenchido pelo sistema.',
          items: {
            type: 'object',
            properties: {
              nome:       { type: 'string', description: 'Nome do produto exatamente como no cardápio' },
              quantidade: { type: 'number' },
              observacao: { type: 'string', description: 'Personalização do item: sabor(es) da pizza (incl. meio a meio), ponto da carne, "sem cebola", borda recheada, etc. Opcional.' },
            },
            required: ['nome', 'quantidade'],
          },
        },
        tipo_entrega:    { type: 'string', enum: ['delivery', 'retirada'] },
        endereco:        { type: 'string', description: 'Endereço completo (só se delivery)' },
        forma_pagamento: { type: 'string', enum: ['pix', 'dinheiro', 'cartao'] },
      },
      required: [],
    },
  },
};

const TOOL_STATUS = {
  type: 'function',
  function: {
    name: 'atualizar_status_pedido',
    description: 'Atualiza o status do pedido. Use "preparando" após confirmar comprovante PIX.',
    parameters: {
      type: 'object',
      properties: { novo_status: { type: 'string', enum: ['preparando', 'cancelado'] } },
      required: ['novo_status'],
    },
  },
};

// Monta a lista de tools conforme o tipo de restaurante
const TOOLS = [
  TOOL_CARDAPIO,
  ...(cfg.usaMistura ? [TOOL_MISTURA] : []),
  TOOL_INFO,
  TOOL_SALVAR,
  TOOL_STATUS,
];

// ─── EXECUTOR ─────────────────────────────────────────────────────────────────

async function executarTool(nome, args, contexto = {}) {
  const { telefone } = contexto;

  switch (nome) {

    case 'buscar_cardapio': {
      const produtos = await db.buscarProdutos();
      if (!produtos.length) return 'Cardápio indisponível no momento.';

      const cats = {};
      for (const p of produtos) {
        const c = (p.categoria || 'Outros').trim();
        (cats[c] = cats[c] || []).push(p);
      }
      const ordenadas = Object.keys(cats).sort((a, b) => prioridadeCategoria(a) - prioridadeCategoria(b));

      let txt = `📋 CARDÁPIO ${cfg.nome.toUpperCase()}\n\n`;
      for (const cat of ordenadas) {
        txt += `${cat.toUpperCase()}\n`;
        for (const p of cats[cat]) {
          const preco = p.preco_promocional != null ? p.preco_promocional : p.preco;
          txt += `• ${p.nome.trim()} — R$ ${Number(preco).toFixed(2).replace('.', ',')}`;
          if (p.descricao) txt += ` (${p.descricao})`;
          txt += '\n';
        }
        txt += '\n';
      }
      return txt.trim();
    }

    case 'buscar_mistura_do_dia': {
      const m = await db.buscarMistura();
      if (!m) return 'Hoje não há mistura especial cadastrada. Ofereça a marmitex normal.';
      return `🌶️ MISTURA DE HOJE\n\n${m.titulo}\n${m.descricao || ''}`;
    }

    case 'info_restaurante': {
      const info = await db.buscarInfo();
      return JSON.stringify({
        nome: info.nome || cfg.nome,
        endereco: info.endereco || '',
        chave_pix: info.chave_pix || '',
        horario: info.horario || '',
        loja_aberta: String(info.loja_aberta) !== 'false',
        taxa_entrega_reais: Number(info.taxa_entrega || 5),
        pedido_minimo_reais: Number(info.pedido_minimo || 0),
      });
    }

    case 'salvar_dados_pedido': {
      if (!telefone) return 'ERRO: telefone não disponível no contexto.';

      const campos = {};
      if (args.nome_cliente)    campos.nome_cliente    = args.nome_cliente;
      if (args.itens)           campos.itens           = args.itens;
      if (args.tipo_entrega)    campos.tipo_entrega    = args.tipo_entrega;
      if (args.endereco)        campos.endereco        = args.endereco;
      if (args.forma_pagamento) campos.forma_pagamento = args.forma_pagamento;

      if (!Object.keys(campos).length) {
        return 'Nada para salvar. Envie pelo menos um campo (itens, nome_cliente, tipo_entrega, endereco ou forma_pagamento).';
      }

      const { rascunho, avaliacao, naoEncontrados } = await db.atualizarRascunho(telefone, campos);
      const itens = parseItens(rascunho.itens);
      const subtotal = calcularSubtotal(itens);

      const resumo = {
        salvo: true,
        itens: itens.map(i => `${i.quantidade}x ${i.nome}${i.observacao ? ` [${i.observacao}]` : ''} (R$ ${Number(i.preco_unitario).toFixed(2)})`),
        subtotal_itens: `R$ ${subtotal.toFixed(2)}`,
        nome: rascunho.nome_cliente || null,
        tipo_entrega: rascunho.tipo_entrega || null,
        endereco: rascunho.endereco || null,
        forma_pagamento: rascunho.forma_pagamento || null,
      };

      if (naoEncontrados.length) {
        resumo.ATENCAO_itens_nao_encontrados = naoEncontrados;
        resumo.instrucao = `Estes itens NÃO existem no cardápio: ${naoEncontrados.join(', ')}. Confirme com o cliente o nome correto.`;
      }

      if (avaliacao.completo) {
        resumo.status = 'PRONTO_PARA_CONFIRMACAO';
        resumo.instrucao_final = 'Todos os dados foram coletados. Apresente o RESUMO FINAL e peça para o cliente responder *SIM* para confirmar. O SISTEMA criará o pedido automaticamente — você NÃO deve criar.';
      } else {
        resumo.status = 'FALTA_COLETAR';
        resumo.falta = descreverFaltando(avaliacao.faltando);
        resumo.instrucao_final = `Ainda falta coletar: ${descreverFaltando(avaliacao.faltando)}. Continue a conversa naturalmente para obter isso.`;
      }

      return JSON.stringify(resumo);
    }

    case 'atualizar_status_pedido': {
      if (!telefone) return 'ERRO: telefone não disponível.';
      const pedido = await db.atualizarStatusPedido(telefone, args.novo_status);
      return JSON.stringify({ sucesso: true, numero_pedido: pedido.numero_pedido, novo_status: args.novo_status });
    }

    default:
      throw new Error(`Tool desconhecida: ${nome}`);
  }
}

module.exports = { TOOLS, executarTool };
