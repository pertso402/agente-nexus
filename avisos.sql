-- ═══════════════════════════════════════════════════════════════════════════
-- CHOPPATINHAS — AVISOS DE STATUS NO WHATSAPP
--
-- Quando a cozinha move o pedido no painel, o cliente recebe uma mensagem.
-- Esta tabela é a trava que impede o mesmo aviso de sair duas vezes (o evento
-- de tempo real pode repetir, e o painel pode receber clique duplo).
--
-- Rode no SQL Editor. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.notificacoes_pedido_enviadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  status text NOT NULL,
  telefone text,
  enviado_em timestamptz DEFAULT now(),
  -- é esta restrição que garante um aviso por status de cada pedido
  CONSTRAINT notif_pedido_status_unico UNIQUE (pedido_id, status)
);
CREATE INDEX IF NOT EXISTS idx_notif_pedido ON public.notificacoes_pedido_enviadas (pedido_id);

ALTER TABLE public.notificacoes_pedido_enviadas ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY all_notificacoes_pedido_enviadas ON public.notificacoes_pedido_enviadas
    FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- O agente escuta mudanças de pedidos em tempo real. Sem a tabela publicada,
-- o evento não chega e nenhum aviso é disparado.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.pedidos;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
