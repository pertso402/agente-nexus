-- ═══════════════════════════════════════════════════════════════════════════
-- CHOPPATINHAS — ATRIBUIÇÃO E MÉTRICAS  (CAC, ROAS, LTV, taxa de recompra)
--
-- Baseado na estrutura do Chapelão, tirando o que é só de lá (roleta, iFood,
-- ERP/estoque/B2B) e adaptando ao que o Choppatinhas já tem.
--
-- Rode inteiro no SQL Editor do Supabase do Choppatinhas. É idempotente:
-- pode rodar de novo sem duplicar nada.
--
-- A ideia central: cada pedido sabe de que CANAL veio, e a view marca a
-- posição dele na vida do cliente (1º pedido = aquisição, 2º+ = recompra).
-- Todo o resto (CAC, LTV, coorte) sai dessas duas informações.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- PARTE 1 — DE ONDE VEM CADA PEDIDO E CADA CLIENTE
-- ───────────────────────────────────────────────────────────────────────────

-- Canal do pedido. Valores usados:
--   whatsapp_anuncio  → clicou no anúncio e caiu no WhatsApp
--   whatsapp_organico → chamou no WhatsApp por conta própria
--   recompra          → o agente de recompra trouxe de volta
--   indicacao         → veio indicado por outro cliente
--   balcao            → pedido feito no balcão
--   instagram         → veio da bio/story
--   painel            → lançado à mão no painel
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'whatsapp_organico';
CREATE INDEX IF NOT EXISTS idx_pedidos_canal   ON public.pedidos (canal);
CREATE INDEX IF NOT EXISTS idx_pedidos_criado  ON public.pedidos (created_at);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON public.pedidos (cliente_id);

-- Origem do cliente. anuncio_meta guarda o payload que o Meta manda junto do
-- primeiro contato de um anúncio "Click to WhatsApp" (id da campanha, do
-- conjunto e do criativo) — é o que permite abrir o CAC por campanha depois.
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS veio_de_anuncio boolean DEFAULT false;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS anuncio_meta jsonb;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS tag text;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS demonstrou_interesse_em timestamptz;
CREATE INDEX IF NOT EXISTS idx_clientes_anuncio ON public.clientes (veio_de_anuncio);


-- ───────────────────────────────────────────────────────────────────────────
-- PARTE 2 — QUANTO FOI INVESTIDO (sem isso não existe CAC nem ROAS)
-- ───────────────────────────────────────────────────────────────────────────

-- Uma linha por canal e período. Pode lançar diário ou por campanha inteira —
-- o cálculo rateia por dia quando o período do lançamento passa do filtro.
CREATE TABLE IF NOT EXISTS public.marketing_investimentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canal text NOT NULL,                       -- meta_ads, google_ads, influencer, panfleto...
  periodo_inicio date NOT NULL,
  periodo_fim date NOT NULL,
  investido numeric NOT NULL DEFAULT 0,
  vendas_atribuidas numeric,                 -- opcional: o que a plataforma reporta
  pedidos_atribuidos integer,
  observacao text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT marketing_periodo_valido CHECK (periodo_fim >= periodo_inicio)
);
CREATE INDEX IF NOT EXISTS idx_mkt_periodo ON public.marketing_investimentos (periodo_inicio, periodo_fim);

-- Receita que não passou pelo fluxo do WhatsApp (iFood, salão, evento).
-- "atribuida" define se entra ou não na conta do marketing.
CREATE TABLE IF NOT EXISTS public.receitas_externas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canal text NOT NULL,
  periodo_inicio date NOT NULL,
  periodo_fim date NOT NULL,
  valor numeric NOT NULL DEFAULT 0,
  pedidos integer,
  ticket_medio numeric,
  atribuida boolean DEFAULT true,
  observacao text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT receita_periodo_valido CHECK (periodo_fim >= periodo_inicio)
);

-- Venda fechada na mão (fora do agente) que você quer contar no resultado.
CREATE TABLE IF NOT EXISTS public.vendas_manuais_atribuidas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_venda date NOT NULL,
  descricao text,
  cliente_nome text,
  quantidade_itens integer,
  valor numeric NOT NULL DEFAULT 0,
  tipo text DEFAULT 'venda_direta',
  observacao text,
  created_at timestamptz DEFAULT now()
);


-- ───────────────────────────────────────────────────────────────────────────
-- PARTE 3 — PARÂMETROS DO PAINEL (ajustáveis sem mexer em código)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dash_config (
  chave text PRIMARY KEY,
  valor text NOT NULL,
  descricao text,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO public.dash_config (chave, valor, descricao) VALUES
('timezone',             'America/Sao_Paulo', 'Fuso para fechar o dia. Sem isso, pedido da madrugada cai no dia errado.'),
('janela_recompra_dias', '21',                'Prazo considerado para dizer que o cliente recomprou. Bar/petiscaria gira mais devagar que marmita.'),
('base_legada_data',     '2026-09-15',        'Data da carga inicial. Clientes cadastrados neste dia não contam como aquisição.')
ON CONFLICT (chave) DO NOTHING;

CREATE OR REPLACE FUNCTION public.dash_cfg(p_chave text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT valor FROM public.dash_config WHERE chave = p_chave;
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- PARTE 4 — HISTÓRICO DE STATUS (tempo de preparo, gargalo da cozinha)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  status_anterior text,
  status_novo text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osh_pedido ON public.order_status_history (pedido_id, created_at);

-- Grava sozinho a cada mudança de status — não depende do painel nem do agente.
CREATE OR REPLACE FUNCTION public.fn_log_status_pedido()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.order_status_history (pedido_id, status_anterior, status_novo)
    VALUES (NEW.id, NULL, NEW.status);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.order_status_history (pedido_id, status_anterior, status_novo)
    VALUES (NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_log_status_pedido ON public.pedidos;
CREATE TRIGGER trg_log_status_pedido
AFTER INSERT OR UPDATE OF status ON public.pedidos
FOR EACH ROW EXECUTE FUNCTION public.fn_log_status_pedido();


-- ───────────────────────────────────────────────────────────────────────────
-- PARTE 5 — RASTREIO DO AGENTE DE RECOMPRA
-- A tabela ofertas_enviadas já existe; aqui entram as colunas que dizem se a
-- mensagem foi entregue, lida e respondida — é o que mede a campanha.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ofertas_enviadas ADD COLUMN IF NOT EXISTS etapa_sequencia integer DEFAULT 0;
ALTER TABLE public.ofertas_enviadas ADD COLUMN IF NOT EXISTS whatsapp_message_id text;
ALTER TABLE public.ofertas_enviadas ADD COLUMN IF NOT EXISTS status_entrega text;   -- enviada|entregue|lida|erro
ALTER TABLE public.ofertas_enviadas ADD COLUMN IF NOT EXISTS entregue_em timestamptz;
ALTER TABLE public.ofertas_enviadas ADD COLUMN IF NOT EXISTS lida_em timestamptz;
ALTER TABLE public.ofertas_enviadas ADD COLUMN IF NOT EXISTS respondeu_em timestamptz;
ALTER TABLE public.ofertas_enviadas ADD COLUMN IF NOT EXISTS resposta_texto text;
ALTER TABLE public.ofertas_enviadas ADD COLUMN IF NOT EXISTS status_checado_em timestamptz;
CREATE INDEX IF NOT EXISTS idx_ofertas_cliente ON public.ofertas_enviadas (cliente_id, enviado_em);

-- Pausa do agente por cliente (cliente pediu pra parar, ou está em atendimento).
CREATE TABLE IF NOT EXISTS public.agente_pausas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid REFERENCES public.clientes(id) ON DELETE CASCADE,
  telefone text,
  motivo text,
  pausado_ate timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pausas_tel ON public.agente_pausas (telefone);


-- ───────────────────────────────────────────────────────────────────────────
-- PARTE 6 — AS VIEWS (é aqui que a métrica nasce)
-- ───────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.vw_pedidos_atrib;
DROP VIEW IF EXISTS public.vw_clientes_dash;
DROP VIEW IF EXISTS public.vw_pedidos_dash;

-- Pedidos válidos (cancelado não conta como venda), com:
--   data_local  → data já no fuso certo
--   seq_cliente → 1 = primeira compra do cliente, 2+ = recompra
-- O seq_cliente é a peça que faz aquisição e recompra não se misturarem.
CREATE VIEW public.vw_pedidos_dash AS
SELECT
  p.id, p.cliente_id, p.numero_pedido, p.status, p.canal,
  p.total, p.subtotal, p.desconto, p.taxa_entrega, p.cupom_id, p.created_at,
  ((p.created_at AT TIME ZONE COALESCE(public.dash_cfg('timezone'), 'America/Sao_Paulo')))::date AS data_local,
  row_number() OVER (PARTITION BY p.cliente_id ORDER BY p.created_at, p.id) AS seq_cliente,
  count(*)     OVER (PARTITION BY p.cliente_id)                             AS total_pedidos_cliente
FROM public.pedidos p
WHERE lower(p.status) <> 'cancelado';

-- Um retrato por cliente: origem, quantos pedidos fez, quanto gastou na vida,
-- quanto tempo levou pra voltar. É a base de LTV e taxa de recompra.
CREATE VIEW public.vw_clientes_dash AS
WITH prim AS (
  SELECT cliente_id, canal, created_at, data_local
  FROM public.vw_pedidos_dash WHERE seq_cliente = 1
), seg AS (
  SELECT cliente_id, created_at AS dt_segundo
  FROM public.vw_pedidos_dash WHERE seq_cliente = 2
), agg AS (
  SELECT cliente_id, count(*) AS n_pedidos, sum(total) AS receita_total, max(created_at) AS dt_ultimo
  FROM public.vw_pedidos_dash GROUP BY cliente_id
), tocado_anuncio AS (
  SELECT DISTINCT cliente_id FROM public.vw_pedidos_dash WHERE canal = 'whatsapp_anuncio'
)
SELECT
  c.id, c.nome, c.telefone, c.tag, c.tags, c.veio_de_anuncio, c.anuncio_meta,
  c.status_cadencia,
  c.created_at AS cadastrado_em,
  ((c.created_at AT TIME ZONE COALESCE(public.dash_cfg('timezone'), 'America/Sao_Paulo')))::date AS data_cadastro,
  COALESCE(a.n_pedidos, 0)        AS n_pedidos,
  COALESCE(a.receita_total, 0)    AS receita_total,
  pr.created_at                   AS dt_primeiro_pedido,
  pr.data_local                   AS data_primeiro_pedido,
  s.dt_segundo                    AS dt_segundo_pedido,
  a.dt_ultimo                     AS dt_ultimo_pedido,
  pr.canal                        AS canal_primeiro_pedido,

  -- quantos dias o cliente levou entre a 1ª e a 2ª compra
  CASE WHEN s.dt_segundo IS NOT NULL
       THEN round((EXTRACT(epoch FROM (s.dt_segundo - pr.created_at)) / 86400.0), 1) END AS dias_ate_recompra,

  -- idade do cliente: sem isso a taxa de recompra fica injusta, porque quem
  -- comprou ontem ainda nem teve tempo de voltar
  CASE WHEN pr.created_at IS NOT NULL
       THEN floor(EXTRACT(epoch FROM (now() - pr.created_at)) / 86400.0)::int END AS dias_desde_primeiro,

  (c.veio_de_anuncio OR ta.cliente_id IS NOT NULL) AS tocado_por_anuncio,

  CASE
    WHEN c.veio_de_anuncio OR pr.canal = 'whatsapp_anuncio'                 THEN 'anuncio'
    WHEN c.foi_indicado_por IS NOT NULL OR pr.canal = 'indicacao'           THEN 'indicacao'
    WHEN pr.canal = 'recompra'                                              THEN 'reativacao_agente'
    WHEN ((c.created_at AT TIME ZONE COALESCE(public.dash_cfg('timezone'), 'America/Sao_Paulo')))::date
         = (public.dash_cfg('base_legada_data'))::date                      THEN 'base_legada'
    WHEN pr.canal = 'instagram'                                             THEN 'instagram'
    WHEN pr.canal = 'balcao'                                                THEN 'balcao'
    WHEN pr.canal IS NOT NULL                                               THEN 'organico'
    ELSE 'lead_sem_compra'
  END AS origem,

  -- "atribuido" = veio de algo que você fez (anúncio, agente, indicação),
  -- em oposição a quem apareceu sozinho
  (c.veio_de_anuncio
   OR c.foi_indicado_por IS NOT NULL
   OR pr.canal IN ('whatsapp_anuncio', 'recompra', 'indicacao')) AS atribuido
FROM public.clientes c
LEFT JOIN prim pr           ON pr.cliente_id = c.id
LEFT JOIN seg s             ON s.cliente_id  = c.id
LEFT JOIN agg a             ON a.cliente_id  = c.id
LEFT JOIN tocado_anuncio ta ON ta.cliente_id = c.id;

-- Classifica CADA pedido: foi conquista nova ou cliente voltando? E por quê?
-- É a resposta direta de "de onde vem esse pedido".
CREATE VIEW public.vw_pedidos_atrib AS
SELECT
  p.id, p.cliente_id, p.numero_pedido, p.canal, p.total, p.desconto,
  p.created_at, p.data_local, p.seq_cliente,
  c.origem AS origem_cliente,
  (c.atribuido OR p.canal = 'recompra') AS atribuido,
  CASE
    WHEN p.seq_cliente = 1 AND c.origem = 'anuncio'    THEN 'aquisicao_anuncio'
    WHEN p.seq_cliente = 1 AND c.origem = 'indicacao'  THEN 'aquisicao_indicacao'
    WHEN p.seq_cliente = 1 AND p.canal  = 'recompra'   THEN 'reativacao_agente'
    WHEN p.seq_cliente = 1                             THEN 'aquisicao_organica'
    WHEN p.canal = 'recompra'                          THEN 'recompra_agente'
    ELSE                                                    'recompra_espontanea'
  END AS tipo_venda
FROM public.vw_pedidos_dash p
JOIN public.vw_clientes_dash c ON c.id = p.cliente_id;


-- ───────────────────────────────────────────────────────────────────────────
-- PARTE 7 — FUNÇÕES DE MÉTRICA (o painel chama estas)
-- ───────────────────────────────────────────────────────────────────────────

-- KPIs de um período: faturamento, ticket, novos x recorrentes, recompra.
CREATE OR REPLACE FUNCTION public.dash_kpis_bloco(p_inicio date, p_fim date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
WITH janela AS (SELECT COALESCE(public.dash_cfg('janela_recompra_dias')::int, 21) AS dias),
ped AS (SELECT * FROM public.vw_pedidos_dash WHERE data_local BETWEEN p_inicio AND p_fim),
novos AS (SELECT * FROM public.vw_clientes_dash WHERE data_primeiro_pedido BETWEEN p_inicio AND p_fim)
SELECT jsonb_build_object(
  'pedidos',        (SELECT count(*) FROM ped),
  'receita',        (SELECT COALESCE(sum(total),0) FROM ped),
  'ticket_medio',   (SELECT CASE WHEN count(*)>0 THEN round(COALESCE(sum(total),0)/count(*),2) ELSE 0 END FROM ped),
  'desconto_total', (SELECT COALESCE(sum(desconto),0) FROM ped),
  'clientes_ativos',(SELECT count(DISTINCT cliente_id) FROM ped),
  'novos_clientes', (SELECT count(*) FROM novos),

  'pedidos_primeira_compra', (SELECT count(*) FROM ped WHERE seq_cliente = 1),
  'pedidos_recompra',        (SELECT count(*) FROM ped WHERE seq_cliente >= 2),
  'pct_pedidos_recompra',    (SELECT CASE WHEN count(*)>0
                                     THEN round(100.0*count(*) FILTER (WHERE seq_cliente>=2)/count(*),1) ELSE 0 END FROM ped),
  'receita_recompra',        (SELECT COALESCE(sum(total),0) FROM ped WHERE seq_cliente >= 2),

  -- Coorte: dos clientes conquistados NO período, quantos já voltaram alguma vez
  'coorte_total',        (SELECT count(*) FROM novos),
  'coorte_recompraram',  (SELECT count(*) FROM novos WHERE n_pedidos >= 2),
  'taxa_recompra_coorte',(SELECT CASE WHEN count(*)>0
                                 THEN round(100.0*count(*) FILTER (WHERE n_pedidos>=2)/count(*),1) END FROM novos),

  -- Coorte madura: só quem já teve tempo de voltar dentro da janela.
  -- É a taxa honesta — a de cima fica subestimada quando o período é recente.
  'taxa_recompra_janela',(SELECT CASE WHEN count(*)>0
                                 THEN round(100.0*count(*) FILTER (WHERE n.dias_ate_recompra <= j.dias)/count(*),1) END
                            FROM novos n, janela j WHERE n.dias_desde_primeiro >= j.dias),
  'dias_medio_recompra', (SELECT round(avg(dias_ate_recompra)::numeric,1) FROM novos WHERE dias_ate_recompra IS NOT NULL),
  'ltv_medio',           (SELECT CASE WHEN count(*)>0 THEN round(avg(receita_total),2) END FROM novos)
);
$$;

-- Mesma coisa, já comparando com o período anterior de mesmo tamanho.
CREATE OR REPLACE FUNCTION public.dash_kpis(p_inicio date, p_fim date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
WITH dur AS (SELECT (p_fim - p_inicio) + 1 AS dias)
SELECT jsonb_build_object(
  'periodo',  jsonb_build_object('inicio', p_inicio, 'fim', p_fim, 'dias', (SELECT dias FROM dur)),
  'atual',    public.dash_kpis_bloco(p_inicio, p_fim),
  'anterior', public.dash_kpis_bloco(p_inicio - (SELECT dias FROM dur), p_inicio - 1),
  'janela_recompra_dias', COALESCE(public.dash_cfg('janela_recompra_dias')::int, 21)
);
$$;

-- CAC, ROAS, ROI e LTV do que foi pago.
-- CAC  = investido ÷ clientes novos vindos de anúncio
-- ROAS = receita VITALÍCIA desses clientes ÷ investido  (não só a 1ª compra —
--        num bar o retorno vem da recompra; olhar só o 1º pedido subestima)
CREATE OR REPLACE FUNCTION public.dash_cac_roas(p_inicio date, p_fim date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
WITH inv AS (
  SELECT m.canal, m.periodo_inicio, m.periodo_fim, m.investido AS investido_total,
         (m.periodo_fim - m.periodo_inicio) + 1 AS dias_registro,
         greatest(0, (least(m.periodo_fim, p_fim) - greatest(m.periodo_inicio, p_inicio)) + 1) AS dias_sobrepostos
  FROM public.marketing_investimentos m
  WHERE m.periodo_inicio <= p_fim AND m.periodo_fim >= p_inicio
),
-- rateia por dia: lançamento de campanha longa só entra na fatia do filtro
inv_rateado AS (
  SELECT *, round(investido_total * dias_sobrepostos::numeric / nullif(dias_registro,0), 2) AS investido_periodo
  FROM inv
),
anuncio AS (
  SELECT count(*) AS clientes_adquiridos,
         count(*) FILTER (WHERE n_pedidos >= 2) AS recompraram,
         COALESCE(sum(receita_total), 0) AS receita_vitalicia
  FROM public.vw_clientes_dash
  WHERE origem = 'anuncio' AND data_primeiro_pedido BETWEEN p_inicio AND p_fim
),
canal_periodo AS (
  SELECT COALESCE(sum(total),0) AS receita_periodo, count(*) AS pedidos_periodo
  FROM public.vw_pedidos_dash
  WHERE canal = 'whatsapp_anuncio' AND data_local BETWEEN p_inicio AND p_fim
),
pago AS (SELECT COALESCE(sum(investido_periodo),0) AS investido FROM inv_rateado)
SELECT jsonb_build_object(
  'investido_total',       (SELECT investido FROM pago),
  'clientes_adquiridos',   (SELECT clientes_adquiridos FROM anuncio),
  'recompraram',           (SELECT recompraram FROM anuncio),
  'receita_vitalicia',     (SELECT receita_vitalicia FROM anuncio),
  'receita_periodo_canal', (SELECT receita_periodo FROM canal_periodo),
  'pedidos_periodo_canal', (SELECT pedidos_periodo FROM canal_periodo),
  'cac',      round((SELECT investido FROM pago) / nullif((SELECT clientes_adquiridos FROM anuncio),0), 2),
  'roas',     round((SELECT receita_vitalicia FROM anuncio) / nullif((SELECT investido FROM pago),0), 2),
  'roi_pct',  round(100.0 * ((SELECT receita_vitalicia FROM anuncio) - (SELECT investido FROM pago))
                    / nullif((SELECT investido FROM pago),0), 1),
  'ltv_anuncio', round((SELECT receita_vitalicia FROM anuncio) / nullif((SELECT clientes_adquiridos FROM anuncio),0), 2),
  'canais', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.investido_periodo DESC), '[]'::jsonb) FROM inv_rateado i),
  -- avisa quando não há lançamento cobrindo o período todo: sem isso você lê
  -- um CAC ótimo que na verdade é investimento faltando
  'cobertura_investimento',
    (SELECT CASE WHEN count(*) = 0 THEN 'sem_dados'
                 WHEN min(periodo_inicio) > p_inicio OR max(periodo_fim) < p_fim THEN 'parcial'
                 ELSE 'completa' END FROM inv_rateado)
);
$$;

-- Quebra por origem: quanto cada porta de entrada traz, com LTV e recompra.
CREATE OR REPLACE FUNCTION public.dash_origens(p_inicio date, p_fim date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
WITH novos AS (
  SELECT * FROM public.vw_clientes_dash WHERE data_primeiro_pedido BETWEEN p_inicio AND p_fim
)
SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.receita_vitalicia DESC), '[]'::jsonb)
FROM (
  SELECT origem,
         count(*)                                   AS clientes_novos,
         count(*) FILTER (WHERE n_pedidos >= 2)     AS recompraram,
         round(100.0 * count(*) FILTER (WHERE n_pedidos >= 2) / nullif(count(*),0), 1) AS taxa_recompra_pct,
         COALESCE(sum(receita_total), 0)            AS receita_vitalicia,
         round(avg(receita_total), 2)               AS ltv_medio,
         round(avg(dias_ate_recompra), 1)           AS dias_medio_recompra
  FROM novos GROUP BY origem
) x;
$$;

-- Como cada pedido do período se classifica (aquisição x recompra, e por qual via).
CREATE OR REPLACE FUNCTION public.dash_atribuicao(p_inicio date, p_fim date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
SELECT jsonb_build_object(
  'por_tipo', (
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.receita DESC), '[]'::jsonb) FROM (
      SELECT tipo_venda, count(*) AS pedidos, COALESCE(sum(total),0) AS receita,
             round(COALESCE(sum(total),0)/nullif(count(*),0),2) AS ticket_medio
      FROM public.vw_pedidos_atrib WHERE data_local BETWEEN p_inicio AND p_fim
      GROUP BY tipo_venda) t),
  'por_canal', (
    SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.receita DESC), '[]'::jsonb) FROM (
      SELECT canal, count(*) AS pedidos, COALESCE(sum(total),0) AS receita
      FROM public.vw_pedidos_atrib WHERE data_local BETWEEN p_inicio AND p_fim
      GROUP BY canal) c),
  'receita_manual', (SELECT COALESCE(sum(valor),0) FROM public.vendas_manuais_atribuidas
                      WHERE data_venda BETWEEN p_inicio AND p_fim),
  'receita_externa', (SELECT COALESCE(sum(
      valor * greatest(0,(least(periodo_fim,p_fim)-greatest(periodo_inicio,p_inicio))+1)::numeric
            / nullif((periodo_fim-periodo_inicio)+1,0)), 0)
      FROM public.receitas_externas WHERE periodo_inicio <= p_fim AND periodo_fim >= p_inicio)
);
$$;

-- Série temporal pra desenhar gráfico (dia ou semana).
CREATE OR REPLACE FUNCTION public.dash_serie(p_inicio date, p_fim date, p_gran text DEFAULT 'dia')
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
WITH grid AS (
  SELECT generate_series(
    CASE WHEN p_gran='semana' THEN date_trunc('week', p_inicio)::date ELSE p_inicio END,
    p_fim,
    CASE WHEN p_gran='semana' THEN interval '1 week' ELSE interval '1 day' END)::date AS bucket
),
ped AS (
  SELECT CASE WHEN p_gran='semana' THEN date_trunc('week', data_local)::date ELSE data_local END AS bucket,
         count(*) AS pedidos, COALESCE(sum(total),0) AS receita,
         count(*) FILTER (WHERE seq_cliente = 1) AS novos,
         count(*) FILTER (WHERE seq_cliente >= 2) AS recompras
  FROM public.vw_pedidos_dash WHERE data_local BETWEEN p_inicio AND p_fim GROUP BY 1
)
SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.bucket), '[]'::jsonb)
FROM (SELECT g.bucket,
             COALESCE(p.pedidos,0) AS pedidos, COALESCE(p.receita,0) AS receita,
             COALESCE(p.novos,0) AS novos, COALESCE(p.recompras,0) AS recompras
      FROM grid g LEFT JOIN ped p ON p.bucket = g.bucket) x;
$$;

-- Coortes semanais: cada semana de clientes novos e quanto eles voltaram.
CREATE OR REPLACE FUNCTION public.dash_coortes(p_inicio date, p_fim date, p_origem text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
WITH novos AS (
  SELECT *, date_trunc('week', data_primeiro_pedido)::date AS semana
  FROM public.vw_clientes_dash
  WHERE data_primeiro_pedido BETWEEN p_inicio AND p_fim
    AND (p_origem IS NULL OR origem = p_origem)
)
SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.semana), '[]'::jsonb)
FROM (
  SELECT semana,
         count(*)                                AS clientes,
         count(*) FILTER (WHERE n_pedidos >= 2)  AS recompraram,
         round(100.0*count(*) FILTER (WHERE n_pedidos>=2)/nullif(count(*),0),1) AS taxa_pct,
         COALESCE(sum(receita_total),0)          AS receita,
         round(avg(receita_total),2)             AS ltv_medio
  FROM novos GROUP BY semana
) x;
$$;

-- Intervalo de datas com dados (pro painel não deixar escolher período vazio).
CREATE OR REPLACE FUNCTION public.dash_limites()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT jsonb_build_object('min', min(data_local), 'max', max(data_local)) FROM public.vw_pedidos_dash;
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- PARTE 8 — RLS nas tabelas novas (mesmo padrão do resto do projeto)
-- ───────────────────────────────────────────────────────────────────────────

DO $$ DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['marketing_investimentos','receitas_externas','vendas_manuais_atribuidas',
                               'dash_config','order_status_history','agente_pausas']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DO $p$ BEGIN CREATE POLICY %I ON public.%I FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $p$;', 'all_'||t, t);
  END LOOP;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- PARTE 9 — Correção pendente: a CHECK de status ficou a do restaurante
-- anterior (recusa 'pronto' e 'aguardando_preparo'), porque o CREATE TABLE
-- IF NOT EXISTS do setup.sql não altera tabela que já existe.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.pedidos DROP CONSTRAINT IF EXISTS pedidos_status_check;
ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_status_check CHECK (status = ANY (ARRAY[
  'pendente','Pendente','confirmado','Confirmado','preparando','Preparando','aguardando_preparo',
  'saiu_entrega','Saiu_entrega','saiu entrega','Saiu Entrega','entregue','Entregue',
  'cancelado','Cancelado','pronto','Pronto']));


-- ═══════════════════════════════════════════════════════════════════════════
-- COMO USAR
--
--   select public.dash_kpis      ('2026-09-01','2026-09-30');  -- KPIs + comparativo
--   select public.dash_cac_roas  ('2026-09-01','2026-09-30');  -- CAC, ROAS, ROI, LTV
--   select public.dash_origens   ('2026-09-01','2026-09-30');  -- LTV e recompra por origem
--   select public.dash_atribuicao('2026-09-01','2026-09-30');  -- de onde veio cada pedido
--   select public.dash_serie     ('2026-09-01','2026-09-30','dia');
--   select public.dash_coortes   ('2026-09-01','2026-09-30');
--
-- Lançar investimento (sem isso CAC e ROAS ficam nulos):
--   insert into public.marketing_investimentos (canal, periodo_inicio, periodo_fim, investido)
--   values ('meta_ads','2026-09-01','2026-09-30', 450.00);
-- ═══════════════════════════════════════════════════════════════════════════
