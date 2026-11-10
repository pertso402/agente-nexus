'use strict';

const db = require('../services/supabase');
const cfg = require('../config/restaurante');
const { avaliarFuncionamento } = require('../utils/horarios');
const { descreverFaltando, calcularSubtotal, parseItens, normalizar } = require('../utils/pedido');
const { chavePixValida } = require('../utils/texto');
const { tipoChave } = require('../utils/pix');

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

const moeda = v => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
const precoDe = p => Number(p.preco_promocional != null ? p.preco_promocional : p.preco);

// Os tamanhos viram produtos separados no banco ("Calabresa (M)" e "Calabresa (G)").
// Aqui eles voltam a ser um produto só com dois preços, que é como se lê num cardápio.
function agruparPorTamanho(produtos) {
  const grupos = new Map();
  for (const p of produtos) {
    const nome = String(p.nome || '').trim();
    const m = nome.match(/^(.*?)\s*\(([^()]+)\)$/);
    const base = m ? m[1].trim() : nome;
    const tam = m ? m[2].trim() : null;
    if (!grupos.has(base)) grupos.set(base, { base, descricao: p.descricao || '', variantes: [] });
    grupos.get(base).variantes.push({ tam, preco: precoDe(p) });
  }
  const ordem = { M: 0, P: 0, 'Media': 0, 'Média': 0, G: 1, 'Grande': 1 };
  for (const g of grupos.values()) {
    g.variantes.sort((a, b) => (ordem[a.tam] ?? 9) - (ordem[b.tam] ?? 9) || a.preco - b.preco);
  }
  return [...grupos.values()];
}

// ─── DEFINIÇÃO DAS TOOLS (formato OpenAI function calling) ───────────────────

const TOOL_CARDAPIO = {
  type: 'function',
  function: {
    name: 'buscar_cardapio',
    description: 'Preços REAIS do cardápio. Use SEMPRE antes de citar qualquer produto ou preço — nunca invente. Sem "categoria", devolve o resumo das seções (use quando pedirem "o cardápio", para o cliente escolher a seção). Com "categoria", devolve os itens daquela seção.',
    parameters: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
          description: 'Seção do cardápio: Porções, Pizzas, Lanches, Caldos, Bebidas ou Marmitex. Omita para ver o resumo das seções.',
        },
      },
      required: [],
    },
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
    description: 'Retorna chave PIX, endereço, horário, taxa de entrega e status (aberta/fechada). Use para enviar PIX ou verificar horário/taxa. Se chave_pix vier null, a chave NÃO está cadastrada: nunca invente uma — diga que a atendente envia e chame chamar_atendente.',
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
    description: 'Atualiza o status do pedido. Não confirma Pix; pagamentos Pix dependem da conferência humana no painel.',
    parameters: {
      type: 'object',
      properties: { novo_status: { type: 'string', enum: ['preparando', 'cancelado'] } },
      required: ['novo_status'],
    },
  },
};

const TOOL_PEDIDOS = {
  type: 'function',
  function: {
    name: 'consultar_pedido',
    description: 'Situação dos pedidos recentes deste cliente (feitos pelo cardápio, pelo WhatsApp ou lançados pela equipe). Use SEMPRE que perguntarem do pedido: "já saiu?", "tá pronto?", "quanto falta?", "quero acompanhar". Responda com base nisso em vez de chamar a atendente.',
    parameters: {
      type: 'object',
      properties: { numero_pedido: { type: 'number', description: 'Número do pedido, se o cliente informar (ex: 82).' } },
      required: [],
    },
  },
};

// Só é oferecida quando o resumo final já foi apresentado (etapa
// aguardando_confirmacao). Antes o cliente dizia "pode mandar o pix",
// "confirmei com a patroa" e ouvia "responda exatamente SIM" três vezes.
const TOOL_CONFIRMAR = {
  type: 'function',
  function: {
    name: 'confirmar_pedido',
    description: 'Fecha o pedido do RESUMO FINAL já apresentado. Chame quando o cliente concordar com o resumo de qualquer jeito ("sim", "pode mandar", "manda o pix", "confirmei", "esse mesmo", "fechado"). NÃO chame se ele pediu mudança, fez pergunta ou ainda não viu o resumo atualizado.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const TOOL_ATENDENTE = {
  type: 'function',
  function: {
    name: 'chamar_atendente',
    description: 'Encaminha a conversa para uma atendente humana quando você não consegue resolver com segurança, quando o cliente pede uma pessoa ou quando há uma reclamação/problema que exige decisão humana. Informe um resumo curto do motivo. O sistema pausa o agente por 10 minutos e mostra o alerta no painel.',
    parameters: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Resumo objetivo para a atendente entender o que precisa resolver.' } },
      required: ['motivo'],
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
  TOOL_PEDIDOS,
  TOOL_ATENDENTE,
];

// Situação em linguagem de cliente. Retirada usa a mesma coluna "saiu" do painel.
function situacaoPedido(p) {
  const retirada = p.tipo_entrega === 'retirada';
  switch (String(p.status || '').toLowerCase()) {
    case 'pendente': return 'recebido, aguardando a cozinha aceitar';
    case 'confirmado': case 'aguardando_preparo': return 'confirmado, na fila da cozinha';
    case 'preparando': return 'em preparo';
    case 'pronto': return retirada ? 'pronto para retirada' : 'pronto, aguardando o motoboy';
    case 'saiu_entrega': return retirada ? 'pronto para retirada' : 'saiu para entrega';
    case 'entregue': return retirada ? 'já retirado' : 'entregue';
    case 'cancelado': return 'cancelado';
    default: return p.status;
  }
}

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

      // Sem categoria: resumo das seções. São ~96 produtos — despejar todos vira
      // uma parede de texto no WhatsApp e o cliente desiste.
      const alvo = args.categoria && ordenadas.find(c => normalizar(c) === normalizar(args.categoria));
      if (!args.categoria || !alvo) {
        let txt = `SEÇÕES DO CARDÁPIO (peça uma categoria para ver os itens)\n\n`;
        for (const cat of ordenadas) {
          const grupos = agruparPorTamanho(cats[cat]);
          const precos = cats[cat].map(precoDe);
          const min = Math.min(...precos), max = Math.max(...precos);
          const exemplos = grupos.slice(0, 3).map(g => g.base).join(', ');
          txt += `• ${cat} — ${grupos.length} opções, de ${moeda(min)} a ${moeda(max)}\n  ex: ${exemplos}\n`;
        }
        if (args.categoria) txt += `\n(categoria "${args.categoria}" não existe; use uma das acima)`;
        txt += `\n\nINSTRUÇÃO: apresente estas seções ao cliente e pergunte qual ele quer ver. NÃO liste produtos agora.`;
        return txt;
      }

      // Com categoria: itens daquela seção, com os tamanhos já juntos por produto.
      let txt = `${alvo.toUpperCase()}\n\n`;
      for (const g of agruparPorTamanho(cats[alvo])) {
        const precos = g.variantes.map(v => v.tam ? `${v.tam} ${moeda(v.preco)}` : moeda(v.preco)).join(' | ');
        txt += `• ${g.base} — ${precos}\n`;
        if (g.descricao) txt += `  ${g.descricao}\n`;
      }
      txt += `\nINSTRUÇÃO: use EXATAMENTE estes nomes e preços. Ao salvar o item, o nome precisa incluir o tamanho entre parênteses, como está no cardápio.`;
      return txt;
    }

    case 'buscar_mistura_do_dia': {
      const m = await db.buscarMistura();
      if (!m) return 'Hoje não há mistura especial cadastrada. Ofereça a marmitex normal.';
      return `🌶️ MISTURA DE HOJE\n\n${m.titulo}\n${m.descricao || ''}`;
    }

    case 'info_restaurante': {
      const info = await db.buscarInfo();
      const funcionamento = avaliarFuncionamento(info);
      return JSON.stringify({
        nome: info.nome || cfg.nome,
        endereco: info.endereco || '',
        // "PENDENTE-chave-pix" chegou a ser mostrado a clientes como chave real
        chave_pix: chavePixValida(info.chave_pix) ? String(info.chave_pix).trim() : null,
        tipo_chave_pix: chavePixValida(info.chave_pix) ? tipoChave(info.chave_pix) : null,
        titular_pix: String(info.pix_titular || '').trim() || null,
        horario: funcionamento.horario,
        loja_aberta: funcionamento.aberto,
        taxa_entrega_reais: Number(info.taxa_entrega || 5),
        // do config (o tempo_entrega do banco ainda é do restaurante anterior)
        prazo_delivery: cfg.prazoDelivery,
        prazo_retirada: cfg.prazoRetirada,
        pedido_minimo_reais: Number(info.pedido_minimo || 0),
      });
    }

    case 'salvar_dados_pedido': {
      if (!telefone) return 'ERRO: telefone não disponível no contexto.';
      const atual = await db.carregarRascunho(telefone);
      if (atual?.etapa_atual === 'aguardando_pix') return 'Este pedido já está reservado e aguarda comprovante/conferência do Pix. Não refaça nem confirme outro pedido. Oriente enviar PDF/imagem ou chamar a atendente.';

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
        resumo.instrucao_final = 'Todos os dados foram coletados. Apresente o RESUMO FINAL e peça a confirmação. Quando o cliente concordar, o SISTEMA cria o pedido (na próxima mensagem você terá a ferramenta confirmar_pedido) — você NÃO deve dizer que já fechou.';
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

    case 'consultar_pedido': {
      if (!telefone) return 'ERRO: telefone não disponível.';
      let pedidos = await db.consultarPedidosRecentes(telefone, 24);
      if (args.numero_pedido && !pedidos.some(p => p.numero_pedido === Number(args.numero_pedido))) {
        pedidos = [];   // número não é deste WhatsApp: não expõe pedido de outra pessoa
      } else if (args.numero_pedido) {
        pedidos = pedidos.filter(p => p.numero_pedido === Number(args.numero_pedido));
      }
      if (!pedidos.length) {
        return 'Nenhum pedido nas últimas 24h ligado a este WhatsApp. Pode ter sido feito com outro número ou por telefone: peça o nome usado no pedido e chame chamar_atendente para a equipe conferir.';
      }
      const agora = Date.now();
      return JSON.stringify({
        pedidos: pedidos.map(p => ({
          numero: p.numero_pedido,
          situacao: situacaoPedido(p),
          tipo: p.tipo_entrega,
          total: `R$ ${Number(p.total).toFixed(2).replace('.', ',')}`,
          feito_ha_minutos: Math.round((agora - Date.parse(p.created_at)) / 60000),
          ultima_mudanca_ha_minutos: Math.round((agora - Date.parse(p.updated_at || p.created_at)) / 60000),
          itens: (p.itens_pedido || []).map(i => `${i.quantidade}x ${i.nome_produto}`),
        })),
        instrucao: `Informe a situação com naturalidade. Prazos de referência a partir do aceite: delivery ${cfg.prazoDelivery}, retirada ${cfg.prazoRetirada} — não prometa horário exato. Se estiver "recebido" há mais de 10 min, "em preparo" há mais de 60 min, ou o cliente relatar problema, chame chamar_atendente.`,
      });
    }

    default:
      throw new Error(`Tool desconhecida: ${nome}`);
  }
}

module.exports = { TOOLS, TOOL_CONFIRMAR, executarTool };
