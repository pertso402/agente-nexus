-- Execute uma vez no Supabase do Choppatinhas. Pode ser reaplicado.
-- Altera somente as duas configurações de horário e bloqueia NOVOS pedidos.
-- Não altera a pausa manual, pedidos existentes, produtos ou pagamentos.
BEGIN;
INSERT INTO public.info_restaurante (chave, valor) VALUES
  ('horarios_funcionamento', '{"0":[],"1":[["17:30","23:00"]],"2":[["17:30","23:00"]],"3":[["17:30","23:00"]],"4":[["17:30","23:00"]],"5":[["17:30","23:00"]],"6":[["11:00","23:00"]]}'),
  ('horario', 'Segunda a sexta: 17h30 às 23h; Sábado: 11h às 23h; Domingo: fechado')
ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;

CREATE OR REPLACE FUNCTION public.restaurante_aberto_em(instante timestamptz DEFAULT now())
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  liberada text;
  horarios jsonb;
  faixa jsonb;
  dia integer;
  local_agora timestamp := instante AT TIME ZONE 'America/Sao_Paulo';
BEGIN
  SELECT valor INTO liberada FROM public.info_restaurante WHERE chave = 'loja_aberta';
  IF coalesce(liberada, 'true') <> 'true' THEN RETURN false; END IF;
  SELECT valor::jsonb INTO horarios FROM public.info_restaurante WHERE chave = 'horarios_funcionamento';
  IF horarios IS NULL THEN RETURN false; END IF;
  FOR dia IN 0..6 LOOP
    IF jsonb_typeof(horarios -> dia::text) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    FOR faixa IN SELECT value FROM jsonb_array_elements(horarios -> dia::text) LOOP
      IF jsonb_typeof(faixa) IS DISTINCT FROM 'array' OR jsonb_array_length(faixa) <> 2
        OR (faixa ->> 0) IS NULL OR (faixa ->> 1) IS NULL
        OR (faixa ->> 0) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        OR (faixa ->> 1) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        OR (faixa ->> 1)::time <= (faixa ->> 0)::time THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  FOR faixa IN SELECT value FROM jsonb_array_elements(horarios -> extract(dow FROM local_agora)::int::text) LOOP
    IF local_agora::time >= (faixa ->> 0)::time AND local_agora::time < (faixa ->> 1)::time THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.validar_horario_pedido()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.restaurante_aberto_em(clock_timestamp()) THEN
    RAISE EXCEPTION 'LOJA_FECHADA: pedidos disponíveis somente durante o horário de funcionamento.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pedidos_horario_funcionamento ON public.pedidos;
CREATE TRIGGER pedidos_horario_funcionamento BEFORE INSERT ON public.pedidos
FOR EACH ROW EXECUTE FUNCTION public.validar_horario_pedido();
COMMIT;
