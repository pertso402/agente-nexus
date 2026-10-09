-- ═══════════════════════════════════════════════════════════════════════════
-- CHOPPATINHAS — AVISOS DE STATUS NO WHATSAPP
--
-- Quando a cozinha move o pedido no painel, o cliente recebe uma mensagem.
-- Cada mudança de status cria um aviso na mesma transação do pedido. O agente
-- consome a fila e só marca enviado após a Evolution aceitar a mensagem.
-- Avisos pendentes sobrevivem a reinícios e falhas de conexão/envio.
--
-- Rode no SQL Editor. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.notificacoes_pedido_enviadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  status text NOT NULL,
  telefone text,
  enviado_em timestamptz,
  -- é esta restrição que garante um aviso por status de cada pedido
  CONSTRAINT notif_pedido_status_unico UNIQUE (pedido_id, status)
);
CREATE INDEX IF NOT EXISTS idx_notif_pedido ON public.notificacoes_pedido_enviadas (pedido_id);

ALTER TABLE public.notificacoes_pedido_enviadas ENABLE ROW LEVEL SECURITY;
-- Compatível com instalações anteriores: registros antigos continuam enviados.
ALTER TABLE public.notificacoes_pedido_enviadas ALTER COLUMN enviado_em DROP DEFAULT;
ALTER TABLE public.notificacoes_pedido_enviadas ADD COLUMN IF NOT EXISTS pedido jsonb;
ALTER TABLE public.notificacoes_pedido_enviadas ADD COLUMN IF NOT EXISTS criado_em timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.notificacoes_pedido_enviadas ADD COLUMN IF NOT EXISTS ordem bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.notificacoes_pedido_enviadas ADD COLUMN IF NOT EXISTS tentativas integer NOT NULL DEFAULT 0;
ALTER TABLE public.notificacoes_pedido_enviadas ADD COLUMN IF NOT EXISTS disponivel_em timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.notificacoes_pedido_enviadas ADD COLUMN IF NOT EXISTS reserva_token uuid;
ALTER TABLE public.notificacoes_pedido_enviadas ADD COLUMN IF NOT EXISTS reservado_ate timestamptz;
ALTER TABLE public.notificacoes_pedido_enviadas ADD COLUMN IF NOT EXISTS whatsapp_message_id text;
ALTER TABLE public.notificacoes_pedido_enviadas ADD COLUMN IF NOT EXISTS ultimo_erro text;
CREATE INDEX IF NOT EXISTS idx_notif_pendentes ON public.notificacoes_pedido_enviadas (disponivel_em, criado_em)
  WHERE enviado_em IS NULL;

-- A fila contém telefones e é interna ao servidor. Nunca liberar ao painel.
DROP POLICY IF EXISTS all_notificacoes_pedido_enviadas ON public.notificacoes_pedido_enviadas;
REVOKE ALL ON public.notificacoes_pedido_enviadas FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notificacoes_pedido_enviadas TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.notificacoes_pedido_enviadas_ordem_seq TO service_role;

CREATE SCHEMA IF NOT EXISTS agente_privado;
REVOKE ALL ON SCHEMA agente_privado FROM PUBLIC, anon, authenticated;

-- SECURITY DEFINER é necessário apenas neste gatilho interno: o painel pode
-- atualizar pedidos, mas não pode escrever/ler diretamente a fila. Não é RPC,
-- não aceita parâmetros externos e só copia campos de NEW após a atualização.
CREATE OR REPLACE FUNCTION agente_privado.enfileirar_aviso_pedido()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  novo_status text := lower(regexp_replace(trim(NEW.status), '\s+', '_', 'g'));
  antigo_status text := lower(regexp_replace(trim(OLD.status), '\s+', '_', 'g'));
BEGIN
  IF novo_status IS NULL OR novo_status IS NOT DISTINCT FROM antigo_status OR novo_status NOT IN
    ('confirmado', 'aguardando_preparo', 'preparando', 'pronto', 'saiu_entrega', 'entregue', 'cancelado') THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notificacoes_pedido_enviadas (pedido_id, status, pedido)
  VALUES (NEW.id, novo_status, jsonb_build_object(
    'id', NEW.id, 'cliente_id', NEW.cliente_id, 'numero_pedido', NEW.numero_pedido,
    'status', novo_status, 'tipo_entrega', NEW.tipo_entrega, 'total', NEW.total
  )) ON CONFLICT (pedido_id, status) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION agente_privado.enfileirar_aviso_pedido() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enfileirar_aviso_pedido ON public.pedidos;
CREATE TRIGGER enfileirar_aviso_pedido AFTER UPDATE OF status ON public.pedidos
  FOR EACH ROW EXECUTE FUNCTION agente_privado.enfileirar_aviso_pedido();

-- Reserva atômica: duas instâncias não enviam o mesmo aviso ao mesmo tempo.
-- Mantém a ordem das etapas de cada pedido, inclusive durante as retentativas.
CREATE OR REPLACE FUNCTION public.reservar_aviso_pedido()
RETURNS SETOF public.notificacoes_pedido_enviadas
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  UPDATE public.notificacoes_pedido_enviadas n
  SET reserva_token = gen_random_uuid(), reservado_ate = now() + interval '90 seconds',
      tentativas = n.tentativas + 1
  WHERE n.id = (
    SELECT f.id FROM public.notificacoes_pedido_enviadas f
    WHERE f.enviado_em IS NULL AND f.pedido IS NOT NULL
      AND f.disponivel_em <= now()
      AND (f.reservado_ate IS NULL OR f.reservado_ate < now())
      AND NOT EXISTS (
        SELECT 1 FROM public.notificacoes_pedido_enviadas anterior
        WHERE anterior.pedido_id = f.pedido_id AND anterior.enviado_em IS NULL
          AND anterior.pedido IS NOT NULL
          AND anterior.ordem < f.ordem
      )
    ORDER BY f.ordem LIMIT 1 FOR UPDATE OF f SKIP LOCKED
  ) RETURNING n.*;
$$;
REVOKE ALL ON FUNCTION public.reservar_aviso_pedido() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reservar_aviso_pedido() TO service_role;

-- O agente escuta mudanças de pedidos em tempo real. Sem a tabela publicada,
-- o evento não chega e nenhum aviso é disparado.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.pedidos;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
