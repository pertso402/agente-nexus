-- ═══════════════════════════════════════════════════════════════════════════
-- SETUP SUPABASE — CHOPPATINHAS
-- Cole este arquivo inteiro no SQL Editor do Supabase e rode.
-- É idempotente (pode rodar de novo sem medo).
--
-- ATENÇÃO: se este Supabase já tinha outro restaurante (ex: Chapelão), este
-- script NÃO apaga pedidos/clientes antigos automaticamente. Antes de rodar,
-- veja o bloco "LIMPEZA (OPCIONAL)" no final do arquivo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── ENUMS ──────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE status_cadencia_enum AS ENUM ('ativo','pausado','inativo','bloqueado'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sessao_status_enum AS ENUM ('aguardando','em_atendimento','finalizado','pausado'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE motivo_saida_indicacao_enum AS ENUM ('recusou','sem_resposta','convertido','invalido'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── SEQUENCES ───────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS pedidos_numero_pedido_seq START 1;
CREATE SEQUENCE IF NOT EXISTS n8n_chat_histories_id_seq START 1;

-- ─── clientes ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clientes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  telefone text NOT NULL UNIQUE,
  endereco text,
  total_pedidos integer DEFAULT 0,
  total_gasto numeric DEFAULT 0,
  primeiro_pedido timestamptz,
  ultimo_pedido timestamptz,
  status_cadencia status_cadencia_enum NOT NULL DEFAULT 'ativo',
  ultima_faixa_enviada integer DEFAULT 0,
  ultima_oferta_enviada_em timestamptz,
  cadencia_pausada_ate timestamptz,
  foi_indicado_por uuid,
  indicacao_solicitada_em timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  sessao_status sessao_status_enum NOT NULL DEFAULT 'aguardando',
  indicacoes_coletadas integer NOT NULL DEFAULT 0,
  proxima_indicacao_em date,
  motivo_saida_indicacao motivo_saida_indicacao_enum,
  ultima_interacao_indicacao_em timestamptz,
  data_ultima_interacao date,
  CONSTRAINT clientes_pkey PRIMARY KEY (id)
);
DO $$ BEGIN ALTER TABLE public.clientes ADD CONSTRAINT clientes_foi_indicado_por_fkey FOREIGN KEY (foi_indicado_por) REFERENCES public.clientes(id) NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── produtos ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.produtos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  descricao text,
  categoria text,
  preco numeric NOT NULL,
  preco_promocional numeric,
  disponivel boolean DEFAULT true,
  destaque boolean DEFAULT false,
  imagem_url text,
  video_url text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT produtos_pkey PRIMARY KEY (id)
);

-- ─── cupons (antes de pedidos por FK) ────────────────────────
CREATE TABLE IF NOT EXISTS public.cupons (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL,
  codigo text NOT NULL UNIQUE,
  desconto_percentual integer NOT NULL,
  valido_ate date NOT NULL,
  usado boolean DEFAULT false,
  pedido_id uuid,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT cupons_pkey PRIMARY KEY (id)
);

-- ─── pedidos ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pedidos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL,
  numero_pedido integer NOT NULL DEFAULT nextval('pedidos_numero_pedido_seq'),
  status text DEFAULT 'pendente' CHECK (status = ANY (ARRAY['pendente','Pendente','confirmado','Confirmado','preparando','Preparando','aguardando_preparo','saiu_entrega','Saiu_entrega','saiu entrega','Saiu Entrega','entregue','Entregue','cancelado','Cancelado','pronto','Pronto'])),
  tipo_entrega text DEFAULT 'delivery' CHECK (tipo_entrega = ANY (ARRAY['delivery','retirada'])),
  endereco_entrega text,
  forma_pagamento text CHECK (forma_pagamento = ANY (ARRAY['pix','PIX','dinheiro','Dinheiro','cartao','cartão','Cartao','Cartão','credito','crédito','debito','débito','cartao_credito','cartao_debito'])),
  troco_para numeric,
  subtotal numeric DEFAULT 0,
  taxa_entrega numeric DEFAULT 0,
  desconto numeric DEFAULT 0,
  total numeric DEFAULT 0,
  cupom_id uuid,
  observacao text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT pedidos_pkey PRIMARY KEY (id),
  CONSTRAINT pedidos_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id)
);
DO $$ BEGIN ALTER TABLE public.cupons ADD CONSTRAINT cupons_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.cupons ADD CONSTRAINT cupons_pedido_id_fkey FOREIGN KEY (pedido_id) REFERENCES public.pedidos(id) NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.pedidos ADD CONSTRAINT fk_pedido_cupom FOREIGN KEY (cupom_id) REFERENCES public.cupons(id) NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ⚠️ Se a tabela pedidos JÁ EXISTIA (de outro restaurante neste mesmo projeto),
-- o CREATE TABLE IF NOT EXISTS acima não fez nada e a CHECK antiga continuou
-- valendo — foi o que aconteceu no Choppatinhas: o banco recusava 'pronto' e
-- 'aguardando_preparo', e o painel não avançava o pedido. Este bloco força a
-- constraint a bater com os status que o agente e o painel usam.
ALTER TABLE public.pedidos DROP CONSTRAINT IF EXISTS pedidos_status_check;
ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_status_check CHECK (status = ANY (ARRAY[
  'pendente','Pendente','confirmado','Confirmado','preparando','Preparando','aguardando_preparo',
  'saiu_entrega','Saiu_entrega','saiu entrega','Saiu Entrega','entregue','Entregue',
  'cancelado','Cancelado','pronto','Pronto']));

-- ─── itens_pedido ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.itens_pedido (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  pedido_id uuid NOT NULL,
  produto_id uuid,
  nome_produto text NOT NULL,
  preco_unitario numeric NOT NULL,
  quantidade integer NOT NULL DEFAULT 1,
  observacao text,
  total numeric NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT itens_pedido_pkey PRIMARY KEY (id),
  CONSTRAINT itens_pedido_pedido_id_fkey FOREIGN KEY (pedido_id) REFERENCES public.pedidos(id),
  CONSTRAINT itens_pedido_produto_id_fkey FOREIGN KEY (produto_id) REFERENCES public.produtos(id)
);

-- ─── ofertas_enviadas (agente vendedor — fase 2) ─────────────
CREATE TABLE IF NOT EXISTS public.ofertas_enviadas (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL,
  faixa_cadencia integer NOT NULL,
  dias_sem_comprar integer NOT NULL,
  tipo_oferta text NOT NULL CHECK (tipo_oferta = ANY (ARRAY['desconto_percentual','frete_gratis','brinde','reconexao','nurturing'])),
  desconto_percentual integer DEFAULT 0,
  cupom_id uuid,
  cupom_codigo text,
  mensagem_audio text,
  mensagem_video text,
  mensagem_cta text,
  converteu boolean DEFAULT false,
  pedido_convertido_id uuid,
  enviado_em timestamptz DEFAULT now(),
  CONSTRAINT ofertas_enviadas_pkey PRIMARY KEY (id),
  CONSTRAINT ofertas_enviadas_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id),
  CONSTRAINT ofertas_enviadas_cupom_id_fkey FOREIGN KEY (cupom_id) REFERENCES public.cupons(id),
  CONSTRAINT ofertas_enviadas_pedido_convertido_id_fkey FOREIGN KEY (pedido_convertido_id) REFERENCES public.pedidos(id)
);

-- ─── indicacoes (programa de indicação — fase 2) ─────────────
CREATE TABLE IF NOT EXISTS public.indicacoes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  indicado_por uuid NOT NULL,
  cliente_id uuid,
  nome_indicado text NOT NULL,
  telefone_indicado text NOT NULL,
  status text DEFAULT 'pendente' CHECK (status = ANY (ARRAY['pendente','contatado','convertido','nao_convertido'])),
  convertido_em timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT indicacoes_pkey PRIMARY KEY (id),
  CONSTRAINT indicacoes_indicado_por_fkey FOREIGN KEY (indicado_por) REFERENCES public.clientes(id),
  CONSTRAINT indicacoes_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id)
);

-- ─── conversas (contexto multiagente) ────────────────────────
CREATE TABLE IF NOT EXISTS public.conversas (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cliente_id uuid,
  telefone text NOT NULL,
  agente text NOT NULL CHECK (agente = ANY (ARRAY['atendimento','indicacao','vendedor'])),
  mensagens jsonb DEFAULT '[]'::jsonb,
  updated_at timestamptz DEFAULT now(),
  oferta_contexto_id uuid,
  cupom_contexto_id uuid,
  CONSTRAINT conversas_pkey PRIMARY KEY (id),
  CONSTRAINT conversas_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id),
  CONSTRAINT conversas_cupom_contexto_id_fkey FOREIGN KEY (cupom_contexto_id) REFERENCES public.cupons(id),
  CONSTRAINT conversas_oferta_contexto_id_fkey FOREIGN KEY (oferta_contexto_id) REFERENCES public.ofertas_enviadas(id)
);

-- ─── info_restaurante ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.info_restaurante (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  chave text NOT NULL UNIQUE,
  valor text NOT NULL,
  descricao text,
  CONSTRAINT info_restaurante_pkey PRIMARY KEY (id)
);

-- ─── n8n_chat_histories (histórico do atendimento) ───────────
CREATE TABLE IF NOT EXISTS public.n8n_chat_histories (
  id integer NOT NULL DEFAULT nextval('n8n_chat_histories_id_seq'),
  session_id text NOT NULL,
  message jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT n8n_chat_histories_pkey PRIMARY KEY (id)
);

-- ─── misturas_do_dia (não usada pelo Choppatinhas; criada por compatibilidade) ─
CREATE TABLE IF NOT EXISTS public.misturas_do_dia (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  titulo text NOT NULL DEFAULT '🌶️ Mistura do Dia',
  descricao text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT misturas_do_dia_pkey PRIMARY KEY (id)
);

-- ─── pedido_rascunho (estado do pedido — usado pelo agente) ──
CREATE TABLE IF NOT EXISTS public.pedido_rascunho (
  telefone text PRIMARY KEY,
  nome_cliente text,
  itens jsonb,
  tipo_entrega text,
  endereco text,
  forma_pagamento text,
  etapa_atual text DEFAULT 'inicio',
  updated_at timestamptz DEFAULT now()
);

-- ─── agent_logs (observabilidade do agente) ──────────────────
CREATE TABLE IF NOT EXISTS public.agent_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text, telefone text,
  nivel text CHECK (nivel IN ('info','warn','error')),
  etapa text NOT NULL, mensagem text,
  dados jsonb, erro_stack text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_created ON public.agent_logs (created_at DESC);

-- ─── RLS (libera leitura/escrita; ajuste se quiser endurecer) ─
DO $$ DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['clientes','produtos','pedidos','itens_pedido','cupons','ofertas_enviadas','indicacoes','conversas','info_restaurante','n8n_chat_histories','misturas_do_dia','pedido_rascunho','agent_logs']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DO $p$ BEGIN CREATE POLICY %I ON public.%I FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $p$;', 'all_'||t, t);
  END LOOP;
END $$;

-- ─── STORAGE (fotos de produto) ──────────────────────────────
INSERT INTO storage.buckets (id, name, public) VALUES ('produto-fotos','produto-fotos',true) ON CONFLICT (id) DO NOTHING;
DO $$ BEGIN CREATE POLICY "read_fotos" ON storage.objects FOR SELECT USING (bucket_id='produto-fotos'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "write_fotos" ON storage.objects FOR ALL USING (bucket_id='produto-fotos') WITH CHECK (bucket_id='produto-fotos'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SEED — INFO DO RESTAURANTE
-- ⚠️ Troque os valores marcados "PENDENTE" antes da demonstração.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.info_restaurante (chave, valor, descricao) VALUES
('nome',          'Choppatinhas',            'Nome do restaurante'),
('whatsapp',      'PENDENTE-whatsapp',       'WhatsApp de contato'),
('chave_pix',     'PENDENTE-chave-pix',      'Chave PIX'),
('taxa_entrega',  '6',                       'Taxa de entrega em reais (ajuste se necessário)'),
('pedido_minimo', '20',                      'Pedido mínimo (informado no cardápio coletado)'),
('loja_aberta',   'true',                    'Status da loja'),
('horario',       'Fecha às 22:30 (PENDENTE horário de abertura)', 'Horário de funcionamento'),
('endereco',      'PENDENTE-endereco',       'Endereço físico'),
('senha_admin',   '0402',                    'Senha do painel admin')
ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;


-- ═══════════════════════════════════════════════════════════════════════════
-- SEED — PRODUTOS (96 itens, gerados de choppatinhas_cardapio.json)
-- Apaga o cardápio anterior deste projeto (ex: Chapelão) antes de inserir o
-- cardápio do Choppatinhas — evita misturar os dois cardápios no atendimento.
-- ═══════════════════════════════════════════════════════════════════════════
DELETE FROM public.produtos;
DELETE FROM public.misturas_do_dia;

INSERT INTO public.produtos (nome, descricao, categoria, preco, disponivel, destaque) VALUES
('Combo Frango C/Batata', 'frango frito 1kg, batata 500gr, molho branco', 'Porções', 105, true, true),
('Combo Frango Com Mandioca', 'frango frito 1kg, mandioca 500gr, molho branco', 'Porções', 105, true, true),
('Frango Frito Especial (M)', 'coxas e sobrecoxas ou só peito; porção com 1,1kg (G) ou 850g (M)', 'Porções', 81, true, false),
('Frango Frito Especial (G)', 'coxas e sobrecoxas ou só peito; porção com 1,1kg (G) ou 850g (M)', 'Porções', 85, true, false),
('Combo Frango Frito Especial C/ Arroz E Salada (M)', 'frango 1kg, arroz, salada, molho branco', 'Porções', 99, true, false),
('Combo Frango Frito Especial C/ Arroz E Salada (G)', 'frango 1kg, arroz, salada, molho branco', 'Porções', 102, true, false),
('Combo Picanha Na Chapa Com Mandioca (M)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 85, true, false),
('Combo Picanha Na Chapa Com Mandioca (G)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 120, true, false),
('Combo Picanha Completa Com Salada E Arroz (M)', 'porção média 550gr (M) ou grande 700gr (G), com arroz e salada', 'Porções', 105, true, false),
('Combo Picanha Completa Com Salada E Arroz (G)', 'porção média 550gr (M) ou grande 700gr (G), com arroz e salada', 'Porções', 140, true, false),
('Combo Alcatra Na Chapa Com Mandioca E Cebola (M)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 85, true, false),
('Combo Alcatra Na Chapa Com Mandioca E Cebola (G)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 118, true, false),
('Combo Alcatra Completa Com Mandioca, Arroz E Salada (M)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 98, true, false),
('Combo Alcatra Completa Com Mandioca, Arroz E Salada (G)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 130, true, false),
('Combo Costelinha De Porco Com Mandioca (M)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 65, true, false),
('Combo Costelinha De Porco Com Mandioca (G)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 86, true, false),
('Combo Costelinha De Porco Completa Com Arroz E Salada (M)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 85, true, false),
('Combo Costelinha De Porco Completa Com Arroz E Salada (G)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 102, true, false),
('Filé De Tilápia (M)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 67, true, false),
('Filé De Tilápia (G)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 85, true, false),
('Filé De Tilápia Completa Com Arroz E Salada (M)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 83, true, false),
('Filé De Tilápia Completa Com Arroz E Salada (G)', 'porção média 550gr (M) ou grande 700gr (G)', 'Porções', 97, true, false),
('Lambari Frito', 'porção com 500g', 'Porções', 52, true, false),
('Tábua De Frios (M)', 'porção com 600gr', 'Porções', 75, true, false),
('Tábua De Frios (G)', 'porção com 600gr', 'Porções', 100, true, false),
('Porção De Bolinho De Bacalhau', '16 unidades', 'Porções', 94, true, false),
('Porção De Palmito', '400gr', 'Porções', 80, true, false),
('Porção De Calabresa (M)', 'porção com 500gr', 'Porções', 63, true, false),
('Porção De Calabresa (G)', 'porção com 500gr', 'Porções', 80, true, false),
('Porção De Presunto E Queijo (M)', 'porção com 500gr', 'Porções', 60, true, false),
('Porção De Presunto E Queijo (G)', 'porção com 500gr', 'Porções', 74, true, false),
('Porção De Batata Frita (M)', 'porção grande 600gr (G) ou média 400gr (M)', 'Porções', 19.5, true, false),
('Porção De Batata Frita (G)', 'porção grande 600gr (G) ou média 400gr (M)', 'Porções', 32, true, false),
('Porção De Polenta Frita', 'porção com 500gr', 'Porções', 30, true, false),
('Porção De Polenta Frita Recheada', 'porção com 400g', 'Porções', 43, true, false),
('Porção De Salame', 'porção com 100g', 'Porções', 33, true, false),
('Porção De Azeitona', 'porção com 300g', 'Porções', 25, true, false),
('Arroz', '500gr', 'Porções', 17, true, false),
('Salada', 'cebola, tomate, alface', 'Porções', 18, true, false),
('Combo Filé De Tilápia Grelhado Com Alcaparras', 'porção com 600gr', 'Porções', 115, true, false),
('Combo Filé De Tilápia Grelhado Com Alcaparras Completa', 'porção 600gr de filé de tilápia c/ arroz e salada', 'Porções', 110, true, false),
('Batata C/Bacon Cheddar', 'batata 500gr', 'Porções', 55, true, false),
('Marmitas Media E Grande (Media)', 'escolher tipo de carne na observação: filé de peito grelhado, filé de tilápia frito, frango chinquim frito, bisteca bovina ou bisteca suína — venda das 11h às 14h', 'Marmitex', 20, true, false),
('Marmitas Media E Grande (Grande)', 'escolher tipo de carne na observação: filé de peito grelhado, filé de tilápia frito, frango chinquim frito, bisteca bovina ou bisteca suína — venda das 11h às 14h', 'Marmitex', 24, true, false),
('À Moda Da Casa (M)', 'palmito, milho, mussarela, frango, ervilha, calabresa e bacon — até dois sabores por pizza', 'Pizzas', 66, true, false),
('À Moda Da Casa (G)', 'palmito, milho, mussarela, frango, ervilha, calabresa e bacon — até dois sabores por pizza', 'Pizzas', 75, true, false),
('Portuguesa (M)', 'milho, mussarela, ervilha, calabresa, ovo e cebola — até dois sabores por pizza', 'Pizzas', 62, true, false),
('Portuguesa (G)', 'milho, mussarela, ervilha, calabresa, ovo e cebola — até dois sabores por pizza', 'Pizzas', 75, true, false),
('Mussarela (M)', 'mussarela e tomate — até dois sabores por pizza', 'Pizzas', 60, true, false),
('Mussarela (G)', 'mussarela e tomate — até dois sabores por pizza', 'Pizzas', 73, true, false),
('Calabresa (M)', 'calabresa, mussarela e tomate — até dois sabores por pizza', 'Pizzas', 67, true, false),
('Calabresa (G)', 'calabresa, mussarela e tomate — até dois sabores por pizza', 'Pizzas', 80, true, false),
('Frango (M)', 'frango desfiado, mussarela, presunto, tomate e azeitona — até dois sabores por pizza', 'Pizzas', 66, true, false),
('Frango (G)', 'frango desfiado, mussarela, presunto, tomate e azeitona — até dois sabores por pizza', 'Pizzas', 78, true, false),
('Atum (M)', 'atum, mussarela e tomate — até dois sabores por pizza', 'Pizzas', 70, true, false),
('Atum (G)', 'atum, mussarela e tomate — até dois sabores por pizza', 'Pizzas', 80, true, false),
('Baiana (M)', 'ovos cozidos, mussarela, calabresa ralada, molho de pimentas, tomate, azeitonas e orégano — até dois sabores por pizza', 'Pizzas', 65, true, false),
('Baiana (G)', 'ovos cozidos, mussarela, calabresa ralada, molho de pimentas, tomate, azeitonas e orégano — até dois sabores por pizza', 'Pizzas', 79, true, false),
('Strogonoff De Carne (M)', 'mussarela, strogonoff de carne, batata palha, champignon, tomate e orégano — até dois sabores por pizza', 'Pizzas', 75, true, false),
('Strogonoff De Carne (G)', 'mussarela, strogonoff de carne, batata palha, champignon, tomate e orégano — até dois sabores por pizza', 'Pizzas', 85, true, false),
('Palmito (M)', 'palmito e mussarela — até dois sabores por pizza', 'Pizzas', 67, true, false),
('Palmito (G)', 'palmito e mussarela — até dois sabores por pizza', 'Pizzas', 80, true, false),
('Prestígio (M)', 'chocolate ao leite, coco ralado, mussarela e leite condensado — até dois sabores por pizza', 'Pizzas', 70, true, false),
('Prestígio (G)', 'chocolate ao leite, coco ralado, mussarela e leite condensado — até dois sabores por pizza', 'Pizzas', 80, true, false),
('Sensação (M)', 'mussarela, chocolate ao leite, leite moça e morango — até dois sabores por pizza', 'Pizzas', 74, true, false),
('Sensação (G)', 'mussarela, chocolate ao leite, leite moça e morango — até dois sabores por pizza', 'Pizzas', 80, true, false),
('Filé Mignon (M)', 'molho de tomate, mussarela, filé bovino na manteiga, catupiry e orégano — até dois sabores por pizza', 'Pizzas', 80, true, false),
('Filé Mignon (G)', 'molho de tomate, mussarela, filé bovino na manteiga, catupiry e orégano — até dois sabores por pizza', 'Pizzas', 93, true, false),
('Bauru (M)', 'presunto, mussarela, tomate e orégano — até dois sabores por pizza', 'Pizzas', 66, true, false),
('Bauru (G)', 'presunto, mussarela, tomate e orégano — até dois sabores por pizza', 'Pizzas', 75, true, false),
('Hambúrguer', 'hambúrguer e mussarela', 'Lanches', 32, true, false),
('Misto Quente', 'queijo, presunto, pão de hambúrguer', 'Lanches', 28, true, false),
('X-Bacon', 'hambúrguer, bacon, mussarela, tomate e alface', 'Lanches', 39, true, false),
('X-Calabresa', 'hambúrguer, calabresa, presunto, mussarela, tomate e alface', 'Lanches', 39, true, false),
('X-Egg', 'hambúrguer, ovo, mussarela, tomate e alface', 'Lanches', 39, true, false),
('X-Frango', 'frango, mussarela, tomate e alface', 'Lanches', 37, true, false),
('X-Picanha', 'picanha, mussarela, tomate e alface', 'Lanches', 62, true, false),
('X-Salada', 'hambúrguer, presunto, mussarela, tomate e alface', 'Lanches', 37, true, false),
('X-Tudo', 'hambúrguer, bacon, ovo, frango, calabresa, presunto, mussarela, tomate e alface', 'Lanches', 57, true, false),
('Waffel Especial', 'frango desfiado, milho, ervilha, palmito e mussarela', 'Lanches', 43, true, false),
('Waffel Simples', 'frango desfiado, milho, ervilha e mussarela', 'Lanches', 35, true, false),
('Caldo De Mandioca Com Carne Seca', NULL, 'Caldos', 30, true, false),
('Caldo De Cabotiá Com Carne Seca', NULL, 'Caldos', 30, true, false),
('Guaraná Zero Lata', NULL, 'Bebidas', 6, true, false),
('Pepsi Lata', NULL, 'Bebidas', 6, true, false),
('Sukita Lata', NULL, 'Bebidas', 6, true, false),
('Soda Lata', NULL, 'Bebidas', 6, true, false),
('Cerveja Skol', NULL, 'Bebidas', 7, true, false),
('Cerveja Brahma', NULL, 'Bebidas', 7, true, false),
('H2OH! Limoneto (350ml)', 'sabor limoneto (350ml) ou limão (500ml)', 'Bebidas', 7.5, true, false),
('H2OH! Limoneto (500ml)', 'sabor limoneto (350ml) ou limão (500ml)', 'Bebidas', 6, true, false),
('Água Com Gás', NULL, 'Bebidas', 4, true, false),
('Água Sem Gás', NULL, 'Bebidas', 4, true, false),
('Guaraná Antarctica', NULL, 'Bebidas', 13, true, false),
('Suco De Maracujá Polpa', NULL, 'Bebidas', 20, true, false),
('Suco De Acerola', NULL, 'Bebidas', 20, true, false);


-- ═══════════════════════════════════════════════════════════════════════════
-- LIMPEZA (OPCIONAL) — o cardápio (produtos/misturas_do_dia) já foi limpo acima.
-- Estes aqui removem HISTÓRICO (pedidos, clientes, conversas) do restaurante
-- antigo, caso este Supabase seja reaproveitado e você não queira manter esses
-- dados junto com o Choppatinhas. Descomente e rode manualmente se quiser.
-- ═══════════════════════════════════════════════════════════════════════════
-- DELETE FROM public.itens_pedido;           -- remove itens de pedidos antigos
-- DELETE FROM public.pedidos;                -- remove pedidos antigos
-- DELETE FROM public.pedido_rascunho;        -- remove rascunhos antigos
-- DELETE FROM public.clientes;               -- remove clientes antigos
-- DELETE FROM public.n8n_chat_histories;     -- remove histórico de conversas antigo
