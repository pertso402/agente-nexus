'use strict';

const db = require('../services/supabase');
const cfg = require('../config/restaurante');
const { descreverFaltando, calcularSubtotal, parseItens } = require('../utils/pedido');

const ORDEM_CATEGORIA = {
  'pizzas': 0, 'pizza': 0,
  'hambúrgueres': 0, 'hamburgueres': 0, 'burgers': 0,
  'pratos': 1,
  'combos': 2,
  'sobremesas': 8, 'bebidas': 9,
};
function prioridadeCategoria(cat) {
  const k = String(cat || '').toLowerCase().trim()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return ORDEM_CATEGORIA[k] ?? 5;
}

const TOOL_CARDAPIO = {
  type: 'function',
  function: {
    name: 'buscar_cardapio',
    description: 'Retorna todos os produtos disponíveis com preços REAIS. Use SEMPRE antes de citar qualquer produto, preço ou quando o cliente quiser pedir.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const TOOL_INFO = {
  type: 'function',
  function: {
    name: 'info_restaurante',
    description: 'Retorna chave PIX, endereço, horário, taxa de entrega e status (aberta/fechada).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const TOOL_SALVAR = {
  type: 'function',
  function: {
    name: 'salvar_dados_pedido',
    description: 'Salva/atualiza os dados do pedido. Chame SEMPRE que coletar qualquer informação. Retorna o que ainda falta e se está pronto para confirmação.',
    parameters: {
      type: 'object',
      properties: {
        nome_cliente: { type: 'string' },
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nome:       { type: 'string', description: 'Nome exato do produto conforme cardápio' },
              quantidade: { type: 'number' },
              observacao: { type: 'string', description: 'Personalização: sabor, ponto, sem ingrediente, etc.' },
            },
            required: ['nome', 'quantidade'],
          },
        },
        tipo_entrega:    { type: 'string', enum: ['delivery', 'retirada'] },
        endereco:        { type: 'string' },
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
    description: 'Atualiza o status do pedido. Use "aguardando_preparo" após confirmar comprovante PIX.',
    parameters: {
      type: 'object',
      properties: { novo_status: { type: 'string', enum: ['aguardando_preparo', 'cancelado'] } },
      required: ['novo_status'],
    },
  },
};

const TOOLS = [TOOL_CARDAPIO, TOOL_INFO, TOOL_SALVAR, TOOL_STATUS];

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

    case 'info_restaurante': {
      const info = await db.buscarInfo();
      return JSON.stringify({
        nome: info.nome || cfg.nome,
        endereco: info.endereco || '',
        chave_pix: info.chave_pix || '',
        horario: info.horario || '',
        loja_aberta: String(info.loja_aberta) !== 'false',
        taxa_entrega_reais: Number(info.taxa_entrega || 7),
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
        return 'Nada para salvar. Envie pelo menos um campo.';
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
        resumo.instrucao_final = 'Todos os dados foram coletados. Apresente o RESUMO FINAL e peça para o cliente responder *SIM* para confirmar.';
      } else {
        resumo.status = 'FALTA_COLETAR';
        resumo.falta = descreverFaltando(avaliacao.faltando);
        resumo.instrucao_final = `Ainda falta coletar: ${descreverFaltando(avaliacao.faltando)}.`;
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
