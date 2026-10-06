-- ═══════════════════════════════════════════════════════════════════════════
-- CHOPPATINHAS — HISTÓRICO COMPLETO DA CONVERSA
--
-- Hoje a tabela guarda só {role, content}. Isso basta pra memória do agente,
-- mas não dá pra otimizar nada: não se sabe se a resposta foi do agente ou de
-- um humano, quais tools foram chamadas, quanto demorou nem quanto custou.
--
-- Aqui as colunas são ADICIONADAS na tabela que já existe, então a função que
-- carrega a memória do agente continua lendo o mesmo "message" e nada quebra.
--
-- Rode inteiro no SQL Editor do Supabase. É idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- Quem falou e o que foi
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS origem text;   -- cliente | agente | humano
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS tipo text;     -- texto | audio | imagem | documento
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS telefone text; -- igual ao session_id, só que explícito

-- Id da mensagem no WhatsApp. É o que permite saber se um "fromMe" que volta
-- pelo webhook foi o agente (já gravado) ou um humano digitando no celular.
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS whatsapp_message_id text;

-- Conteúdo original de mídia: o "message" guarda o texto que a LLM viu,
-- aqui fica o que de fato chegou, pra auditar transcrição e leitura de imagem
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS transcricao text;
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS analise_imagem text;

-- Como o agente chegou na resposta — é isso que se olha pra ajustar o prompt
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS tool_calls jsonb;
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS etapa_pedido text;

-- Custo e velocidade
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS modelo text;
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS latencia_ms integer;
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS tokens_entrada integer;
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS tokens_saida integer;

ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS erro text;
ALTER TABLE public.n8n_chat_histories ADD COLUMN IF NOT EXISTS request_id text;

CREATE INDEX IF NOT EXISTS idx_hist_sessao  ON public.n8n_chat_histories (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hist_wamid   ON public.n8n_chat_histories (whatsapp_message_id);
CREATE INDEX IF NOT EXISTS idx_hist_origem  ON public.n8n_chat_histories (origem, created_at);

-- Linhas antigas não tinham origem: deduz pelo papel que está no JSON
UPDATE public.n8n_chat_histories
SET origem = CASE WHEN message->>'role' = 'user' THEN 'cliente' ELSE 'agente' END,
    tipo = COALESCE(tipo, 'texto'),
    telefone = COALESCE(telefone, session_id)
WHERE origem IS NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- LEITURA: conversa em ordem, legível
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.vw_conversas AS
SELECT
  h.id,
  h.session_id AS telefone,
  c.nome AS cliente,
  h.created_at,
  (h.created_at AT TIME ZONE COALESCE(public.dash_cfg('timezone'), 'America/Sao_Paulo')) AS quando_local,
  h.origem,
  h.tipo,
  h.message->>'content' AS texto,
  h.transcricao,
  h.analise_imagem,
  h.tool_calls,
  h.etapa_pedido,
  h.modelo,
  h.latencia_ms,
  h.tokens_entrada,
  h.tokens_saida,
  h.erro
FROM public.n8n_chat_histories h
LEFT JOIN public.clientes c ON c.telefone = h.session_id;

-- Uma linha por conversa: serve pra achar onde o agente trava.
-- "teve_humano" é o sinal mais útil: onde um humano precisou entrar, o agente
-- falhou — é por onde começar a otimizar.
CREATE OR REPLACE VIEW public.vw_conversas_resumo AS
WITH base AS (
  SELECT
    h.session_id,
    min(h.created_at) AS inicio,
    max(h.created_at) AS fim,
    count(*)                                        AS mensagens,
    count(*) FILTER (WHERE h.origem = 'cliente')    AS do_cliente,
    count(*) FILTER (WHERE h.origem = 'agente')     AS do_agente,
    count(*) FILTER (WHERE h.origem = 'humano')     AS do_humano,
    count(*) FILTER (WHERE h.tipo = 'audio')        AS audios,
    count(*) FILTER (WHERE h.tipo = 'imagem')       AS imagens,
    count(*) FILTER (WHERE h.erro IS NOT NULL)      AS erros,
    round(avg(h.latencia_ms) FILTER (WHERE h.origem = 'agente'))::int AS latencia_media_ms,
    sum(COALESCE(h.tokens_entrada,0) + COALESCE(h.tokens_saida,0))    AS tokens_total
  FROM public.n8n_chat_histories h
  GROUP BY h.session_id
)
SELECT
  b.*,
  c.nome AS cliente,
  (b.do_humano > 0) AS teve_humano,
  COALESCE(p.pedidos, 0) AS pedidos_fechados,
  (COALESCE(p.pedidos, 0) > 0) AS converteu
FROM base b
LEFT JOIN public.clientes c ON c.telefone = b.session_id
LEFT JOIN LATERAL (
  SELECT count(*) AS pedidos FROM public.pedidos pe
  WHERE pe.cliente_id = c.id AND pe.created_at BETWEEN b.inicio AND b.fim + interval '1 hour'
) p ON true;


-- ═══════════════════════════════════════════════════════════════════════════
-- COMO USAR
--
--   -- conversa inteira de um cliente
--   select quando_local, origem, tipo, texto from vw_conversas
--   where telefone = '554499877146' order by created_at;
--
--   -- onde um humano precisou entrar (agente não deu conta)
--   select * from vw_conversas_resumo where teve_humano order by inicio desc;
--
--   -- conversas que não viraram pedido
--   select * from vw_conversas_resumo where not converteu order by mensagens desc;
--
--   -- quais tools o agente mais chama
--   select tc->>'name' as tool, count(*) from n8n_chat_histories,
--          lateral jsonb_array_elements(tool_calls) tc
--   where tool_calls is not null group by 1 order by 2 desc;
-- ═══════════════════════════════════════════════════════════════════════════
