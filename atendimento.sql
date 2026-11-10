-- ═══════════════════════════════════════════════════════════════════════════
-- CHOPPATINHAS — MELHORIAS DO ATENDIMENTO
--
-- 1. info_restaurante.atualizado_em: o agente reabre a loja sozinho quando
--    alguém fechou no painel num dia anterior e esqueceu de reabrir.
-- 2. contatos_ignorados: equipe, fornecedores e família que usam o mesmo
--    número. O agente não responde nem grava essas conversas.
-- 3. faq_atendimento: respostas que a equipe já deu e o agente não sabia.
--
-- Rode no SQL Editor. Idempotente. Sem este arquivo o agente funciona; só
-- ficam desligadas a reabertura automática, a lista e as respostas prontas.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Quando cada configuração mudou ────────────────────────────────────────
ALTER TABLE public.info_restaurante
  ADD COLUMN IF NOT EXISTS atualizado_em timestamptz NOT NULL DEFAULT now();

-- Só conta mudança de valor: o painel salvando "false" de novo não pode
-- empurrar a data do fechamento para hoje.
CREATE OR REPLACE FUNCTION public.info_restaurante_marcar_atualizacao()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.valor IS DISTINCT FROM OLD.valor THEN
    NEW.atualizado_em := now();
  ELSE
    NEW.atualizado_em := OLD.atualizado_em;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS info_restaurante_atualizado_em ON public.info_restaurante;
CREATE TRIGGER info_restaurante_atualizado_em
  BEFORE INSERT OR UPDATE ON public.info_restaurante
  FOR EACH ROW EXECUTE FUNCTION public.info_restaurante_marcar_atualizacao();

-- ── 2. Contatos que não são clientes ─────────────────────────────────────────
-- Telefone só com dígitos, com ou sem o 9 — o agente compara as duas formas.
CREATE TABLE IF NOT EXISTS public.contatos_ignorados (
  telefone  text PRIMARY KEY CHECK (telefone ~ '^[0-9]{10,13}$'),
  nome      text,
  motivo    text,
  criado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.contatos_ignorados ENABLE ROW LEVEL SECURITY;
-- Telefones pessoais da equipe: nada de acesso pela chave pública do cardápio.
REVOKE ALL ON public.contatos_ignorados FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contatos_ignorados TO service_role;

-- ── 3. Respostas da casa ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.faq_atendimento (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pergunta      text NOT NULL UNIQUE,
  resposta      text NOT NULL,
  ativo         boolean NOT NULL DEFAULT true,
  ordem         integer NOT NULL DEFAULT 100,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.faq_atendimento ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.faq_atendimento FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.faq_atendimento TO service_role;

-- Tiradas das respostas da equipe nas conversas de 15 a 26/10. Revise e
-- desative (ativo = false) o que não valer mais. Não sobrescreve edições.
INSERT INTO public.faq_atendimento (pergunta, resposta, ordem) VALUES
  ('Frango Frito Especial x Combo',
   'O Frango Frito Especial é só o frango com molho branco. Com arroz e salada é o Combo Frango Frito Especial C/ Arroz E Salada. Na dúvida, confirme com o cliente qual dos dois ele quer.', 10),
  ('Peito de frango é sem osso?',
   'Não. O peito não é desossado: é a parte com menos osso. Nunca diga que vem sem osso.', 15),
  ('Frango frito misto (coxa/sobrecoxa e peito juntos)',
   'Dá pra fazer a porção mista: é só pedir e escrever "misto" na observação do item.', 20),
  ('Reserva de mesa',
   'Reservamos mesa só para grupos acima de 10 pessoas. Para grupos menores não precisa reservar; até umas 20h costuma estar mais tranquilo.', 30),
  ('Aniversário / levar bolo',
   'Pode trazer o bolo e cantar parabéns aqui, sem problema.', 40),
  ('Cartão na entrega',
   'Sim, o motoboy leva a maquininha de cartão (crédito e débito).', 50),
  ('Entrega na região do shopping / rodovia',
   'Não fazemos entrega na região do shopping, na rodovia.', 60),
  ('Vagas e currículo',
   'Pode mandar o currículo por aqui que a gente repassa ao responsável. Depois de responder, chame chamar_atendente com o resumo para a equipe ver.', 70),
  ('Fornecedores, parcerias e músicos',
   'Pode deixar a proposta ou o contato por aqui que a gente repassa ao responsável. Depois de responder, chame chamar_atendente com o resumo para a equipe ver.', 80)
ON CONFLICT (pergunta) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
