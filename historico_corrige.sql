-- ═══════════════════════════════════════════════════════════════════════════
-- CORREÇÃO do historico.sql
--
-- A coluna "message" é jsonb, mas o agente grava JSON.stringify(...) — ou seja,
-- uma STRING JSON dentro do jsonb, não um objeto. Com isso message->>'role' e
-- message->>'content' devolvem NULL: o backfill marcou tudo como 'agente' e a
-- coluna "texto" da vw_conversas veio vazia.
--
-- Aqui o conteúdo é desempacotado antes de ler. Trata os dois formatos, caso
-- alguma linha venha como objeto de verdade.
--
-- Rode inteiro no SQL Editor. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- Desempacota o message, seja ele string JSON ou objeto
CREATE OR REPLACE FUNCTION public.hist_json(m jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(m)
           WHEN 'string' THEN (m #>> '{}')::jsonb
           ELSE m
         END;
$$;

-- Corrige o rótulo das linhas antigas (tinham virado 'agente' por causa do NULL)
UPDATE public.n8n_chat_histories
SET origem = CASE WHEN public.hist_json(message)->>'role' = 'user' THEN 'cliente' ELSE 'agente' END
WHERE whatsapp_message_id IS NULL        -- só as antigas; as novas o agente já rotula
  AND public.hist_json(message)->>'role' IS NOT NULL;

-- View com o texto saindo de verdade
CREATE OR REPLACE VIEW public.vw_conversas AS
SELECT
  h.id,
  h.session_id AS telefone,
  c.nome AS cliente,
  h.created_at,
  (h.created_at AT TIME ZONE COALESCE(public.dash_cfg('timezone'), 'America/Sao_Paulo')) AS quando_local,
  h.origem,
  h.tipo,
  public.hist_json(h.message)->>'content' AS texto,
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

-- Confere: deve mostrar texto preenchido e origem coerente
-- select origem, left(texto, 60) from vw_conversas order by created_at;
