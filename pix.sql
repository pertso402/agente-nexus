-- Choppatinhas: Pix assistido, sem integração bancária.
-- Versão 2: funções com delimitadores nomeados e encerramentos explícitos.
-- Substitua todo o conteúdo da consulta no SQL Editor por este arquivo completo.
-- Pode ser reaplicado: preserva pedidos, comprovantes e o código privado da equipe.
BEGIN;
CREATE SCHEMA IF NOT EXISTS pix_privado;
REVOKE ALL ON SCHEMA pix_privado FROM PUBLIC, anon, authenticated;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS pix_status text;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS pix_resumo jsonb;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS pix_recebido_em timestamptz;
ALTER TABLE public.pedido_rascunho ADD COLUMN IF NOT EXISTS pedido_id uuid;
-- Rascunhos Pix ficam separados de pedidos: impressoras antigas não os recebem.
CREATE TABLE IF NOT EXISTS public.pix_pedidos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), numero_pedido integer NOT NULL DEFAULT nextval('public.pedidos_numero_pedido_seq'),
 cliente_id uuid NOT NULL REFERENCES public.clientes(id), status text NOT NULL DEFAULT 'aguardando_pix',
 tipo_entrega text NOT NULL, endereco_entrega text, forma_pagamento text NOT NULL DEFAULT 'pix',
 subtotal numeric NOT NULL,taxa_entrega numeric NOT NULL,total numeric NOT NULL,observacao text,canal text,
 pix_status text,pix_resumo jsonb,pix_recebido_em timestamptz,itens jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pix_pedidos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pix_pedidos FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.pix_pedidos TO anon,authenticated;
DROP POLICY IF EXISTS pix_painel_leitura ON public.pix_pedidos;
CREATE POLICY pix_painel_leitura ON public.pix_pedidos FOR SELECT TO anon,authenticated USING(true);
CREATE TABLE IF NOT EXISTS pix_privado.config (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), chave_painel text NOT NULL, ultimo_ciclo timestamptz
);
ALTER TABLE pix_privado.config ADD COLUMN IF NOT EXISTS ultimo_ciclo timestamptz;
INSERT INTO pix_privado.config(id,chave_painel) VALUES(true,replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS pix_privado.cobrancas (
 pedido_id uuid PRIMARY KEY REFERENCES public.pix_pedidos(id), requisicao uuid UNIQUE, token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 chave text NOT NULL, recebedor text NOT NULL, jid text, criado_em timestamptz NOT NULL DEFAULT now(),
 confirmado_em timestamptz, lembrete_enviado_em timestamptz, confirmacao_enviada_em timestamptz
);
ALTER TABLE pix_privado.cobrancas ADD COLUMN IF NOT EXISTS jid text;
CREATE TABLE IF NOT EXISTS pix_privado.comprovantes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pedido_id uuid NOT NULL REFERENCES public.pix_pedidos(id),
 arquivo text UNIQUE NOT NULL, nome text NOT NULL, mimetype text NOT NULL,
 origem text NOT NULL CHECK(origem IN ('cardapio','whatsapp')), criado_em timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pendente', tentativas integer NOT NULL DEFAULT 0, reserva uuid, reservado_ate timestamptz,
 hash text, transacao text, leitura jsonb, resultado jsonb, erro text, notificado_em timestamptz
);
CREATE INDEX IF NOT EXISTS pix_comprovantes_fila ON pix_privado.comprovantes(status,criado_em);
CREATE INDEX IF NOT EXISTS pix_comprovantes_hash ON pix_privado.comprovantes(hash);
CREATE INDEX IF NOT EXISTS pix_comprovantes_transacao ON pix_privado.comprovantes(transacao);
ALTER TABLE pix_privado.cobrancas ENABLE ROW LEVEL SECURITY;
ALTER TABLE pix_privado.comprovantes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA pix_privado FROM PUBLIC,anon,authenticated;
INSERT INTO public.info_restaurante(chave,valor) VALUES ('chave_pix','02668346000198') ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor;
INSERT INTO public.info_restaurante(chave,valor) VALUES ('pix_habilitado','false') ON CONFLICT(chave) DO NOTHING;

-- O pedido e os itens nascem juntos. O token é devolvido somente a quem o criou.
CREATE OR REPLACE FUNCTION public.pix_criar_pedido(dados jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_01$
DECLARE cli uuid; ped public.pix_pedidos; tok uuid; tel text; tipo text; sub numeric:=0; taxa numeric:=0; minimo numeric:=0;
 it jsonb; prod public.produtos; qtd integer; lista jsonb:='[]'; chave text; nome_loja text; liberada text; req uuid; anterior pix_privado.cobrancas; agenda jsonb; faixa jsonb;
 local_agora timestamp := clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'; aberto boolean:=false;
BEGIN
 req:=coalesce(nullif(dados->>'requisicao','')::uuid,gen_random_uuid());
 PERFORM pg_advisory_xact_lock(hashtextextended(req::text,0));
 SELECT * INTO anterior FROM pix_privado.cobrancas WHERE requisicao=req;
 IF FOUND THEN
  SELECT * INTO ped FROM public.pix_pedidos WHERE id=anterior.pedido_id;
  RETURN jsonb_build_object('id',ped.id,'numero_pedido',ped.numero_pedido,'subtotal',ped.subtotal,'taxa_entrega',ped.taxa_entrega,'total',ped.total,'status',ped.status,'pix_token',anterior.token,'chave_pix',anterior.chave,'recebedor',anterior.recebedor,'criado_em',ped.created_at);
 END IF;
 SELECT valor INTO liberada FROM public.info_restaurante info WHERE info.chave='loja_aberta';
 SELECT valor::jsonb INTO agenda FROM public.info_restaurante info WHERE info.chave='horarios_funcionamento';
 IF agenda IS NULL THEN agenda:='{"0":[],"1":[["17:30","23:00"]],"2":[["17:30","23:00"]],"3":[["17:30","23:00"]],"4":[["17:30","23:00"]],"5":[["17:30","23:00"]],"6":[["11:00","23:00"]]}'::jsonb; END IF;
 FOR faixa IN SELECT value FROM jsonb_array_elements(agenda->extract(dow FROM local_agora)::integer::text) LOOP
  IF local_agora::time >= (faixa->>0)::time AND local_agora::time < (faixa->>1)::time THEN aberto:=true; END IF;
 END LOOP;
 IF NOT aberto OR coalesce(liberada,'true')<>'true' THEN RAISE EXCEPTION 'LOJA_FECHADA'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.info_restaurante info WHERE info.chave='pix_habilitado' AND valor='true') THEN RAISE EXCEPTION 'PIX_INDISPONIVEL'; END IF;
 tel:=regexp_replace(coalesce(dados->>'telefone',''),'[^0-9]','','g');
 IF length(tel) IN (10,11) THEN tel:='55'||tel; END IF;
 tipo:=dados->>'tipo_entrega';
 IF length(trim(coalesce(dados->>'nome','')))<2 OR tel !~ '^55[0-9]{10,11}$' OR tipo NOT IN ('delivery','retirada') OR tipo IS NULL THEN RAISE EXCEPTION 'Dados do cliente incompletos'; END IF;
 IF tipo='delivery' AND length(trim(coalesce(dados->>'endereco','')))<5 THEN RAISE EXCEPTION 'Endereço incompleto'; END IF;
 IF jsonb_typeof(dados->'itens') IS DISTINCT FROM 'array' OR jsonb_array_length(dados->'itens')=0 OR jsonb_array_length(dados->'itens')>60 THEN RAISE EXCEPTION 'Pedido sem itens válidos'; END IF;
 FOR it IN SELECT value FROM jsonb_array_elements(dados->'itens') LOOP
  SELECT * INTO prod FROM public.produtos WHERE id=(it->>'produto_id')::uuid AND disponivel=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Produto indisponível'; END IF;
  qtd:=(it->>'quantidade')::integer;
  IF qtd IS NULL OR qtd<1 OR qtd>99 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;
  IF lower(coalesce(prod.categoria,'')) LIKE '%marmit%' AND NOT(local_agora::time>='11:00' AND local_agora::time<'14:00') THEN RAISE EXCEPTION 'MARMITEX'; END IF;
  sub:=sub+round(coalesce(prod.preco_promocional,prod.preco)*qtd,2);
  lista:=lista||jsonb_build_array(jsonb_build_object('produto_id',prod.id,'nome',trim(prod.nome),'quantidade',qtd,'preco_unitario',coalesce(prod.preco_promocional,prod.preco),'observacao',left(coalesce(it->>'observacao',''),500)));
 END LOOP;
 SELECT coalesce(nullif(valor,''),'0')::numeric INTO minimo FROM public.info_restaurante info WHERE info.chave='pedido_minimo';
 IF sub<coalesce(minimo,0) THEN RAISE EXCEPTION 'Pedido abaixo do valor mínimo'; END IF;
 IF tipo='delivery' THEN SELECT coalesce(nullif(valor,''),'10')::numeric INTO taxa FROM public.info_restaurante info WHERE info.chave='taxa_entrega'; taxa:=coalesce(taxa,10); END IF;
 SELECT id INTO cli FROM public.clientes WHERE telefone=tel;
 IF cli IS NULL THEN INSERT INTO public.clientes(nome,telefone,endereco) VALUES(left(trim(dados->>'nome'),120),tel,left(dados->>'endereco',500)) RETURNING id INTO cli;
 ELSE UPDATE public.clientes SET nome=left(trim(dados->>'nome'),120),endereco=coalesce(nullif(dados->>'endereco',''),endereco) WHERE id=cli; END IF;
 INSERT INTO public.pix_pedidos(cliente_id,status,tipo_entrega,endereco_entrega,forma_pagamento,subtotal,taxa_entrega,total,observacao,canal,pix_status)
 VALUES(cli,'aguardando_pix',tipo,CASE WHEN tipo='delivery' THEN left(dados->>'endereco',500) END,'pix',sub,taxa,sub+taxa,left(coalesce(dados->>'observacao',''),1000),CASE WHEN dados->>'origem'='whatsapp' THEN 'whatsapp_organico' ELSE 'cardapio_v3' END,'aguardando_comprovante') RETURNING * INTO ped;
 UPDATE public.pix_pedidos SET itens=lista WHERE id=ped.id;
 SELECT valor INTO chave FROM public.info_restaurante info WHERE info.chave='chave_pix';
 SELECT valor INTO nome_loja FROM public.info_restaurante info WHERE info.chave='nome';
 IF coalesce(chave,'')='' THEN RAISE EXCEPTION 'Chave Pix não cadastrada'; END IF;
 INSERT INTO pix_privado.cobrancas(pedido_id,requisicao,chave,recebedor) VALUES(ped.id,req,chave,coalesce(nome_loja,'Choppatinhas')) RETURNING token INTO tok;
 -- Não substitui rascunho de outro pedido pendente do mesmo cliente.
 INSERT INTO public.pedido_rascunho(telefone,nome_cliente,itens,tipo_entrega,endereco,forma_pagamento,etapa_atual,updated_at,pedido_id)
 VALUES(tel,dados->>'nome',lista,tipo,dados->>'endereco','pix','aguardando_pix',now(),ped.id)
 ON CONFLICT(telefone) DO UPDATE SET nome_cliente=excluded.nome_cliente,itens=excluded.itens,tipo_entrega=excluded.tipo_entrega,endereco=excluded.endereco,forma_pagamento='pix',etapa_atual='aguardando_pix',updated_at=now(),pedido_id=ped.id
 WHERE public.pedido_rascunho.pedido_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.pix_pedidos pedido_anterior WHERE pedido_anterior.id=public.pedido_rascunho.pedido_id AND pedido_anterior.status='aguardando_pix');
 RETURN jsonb_build_object('id',ped.id,'numero_pedido',ped.numero_pedido,'subtotal',sub,'taxa_entrega',taxa,'total',sub+taxa,'status',ped.status,'pix_token',tok,'chave_pix',chave,'recebedor',coalesce(nome_loja,'Choppatinhas'),'criado_em',ped.created_at);
END;
$pix_01$;

CREATE OR REPLACE FUNCTION public.pix_arquivo_autorizado(arquivo text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $pix_02$
 SELECT EXISTS(SELECT 1 FROM pix_privado.cobrancas c JOIN public.pix_pedidos p ON p.id=c.pedido_id
 WHERE split_part(arquivo,'/',1)=c.pedido_id::text AND split_part(arquivo,'/',2)=c.token::text
 AND p.status='aguardando_pix' AND c.criado_em>now()-interval '7 days');
$pix_02$;
CREATE OR REPLACE FUNCTION public.pix_consultar(p_pedido uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $pix_03$
DECLARE p public.pix_pedidos; c pix_privado.cobrancas; BEGIN
 SELECT * INTO c FROM pix_privado.cobrancas WHERE pedido_id=p_pedido AND token=p_token;
 IF NOT FOUND THEN RAISE EXCEPTION 'Pedido não encontrado'; END IF;
 SELECT * INTO p FROM public.pix_pedidos WHERE id=p_pedido;
 RETURN jsonb_build_object('status',coalesce((SELECT status FROM public.pedidos WHERE id=p.id),p.status),'tipo_entrega',p.tipo_entrega,'endereco',p.endereco_entrega,'subtotal',p.subtotal,'taxa_entrega',p.taxa_entrega,'itens',p.itens,'pix_status',p.pix_status,'pix_resumo',p.pix_resumo,'chave_pix',c.chave,'recebedor',c.recebedor,'total',p.total,'numero_pedido',p.numero_pedido);
END;
$pix_03$;
CREATE OR REPLACE FUNCTION public.pix_anexar(p_pedido uuid,p_token uuid,p_arquivo text,p_nome text,p_mimetype text,p_origem text DEFAULT 'cardapio')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_04$
DECLARE anexo uuid; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pix_privado.cobrancas WHERE pedido_id=p_pedido AND token=p_token) OR NOT public.pix_arquivo_autorizado(p_arquivo) THEN RAISE EXCEPTION 'Pedido indisponível'; END IF;
 IF p_arquivo NOT LIKE p_pedido::text||'/'||p_token::text||'/%' OR p_mimetype NOT IN ('application/pdf','image/jpeg','image/png','image/webp') THEN RAISE EXCEPTION 'Arquivo inválido'; END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='comprovantes-pix' AND name=p_arquivo) THEN RAISE EXCEPTION 'Arquivo não recebido'; END IF;
 IF (SELECT count(*) FROM pix_privado.comprovantes WHERE pedido_id=p_pedido)>=8 THEN RAISE EXCEPTION 'Limite de anexos atingido. Fale com a atendente.'; END IF;
 INSERT INTO pix_privado.comprovantes(pedido_id,arquivo,nome,mimetype,origem) VALUES(p_pedido,p_arquivo,left(p_nome,160),p_mimetype,CASE WHEN p_origem='whatsapp' THEN 'whatsapp' ELSE 'cardapio' END) ON CONFLICT(arquivo) DO NOTHING RETURNING id INTO anexo;
 IF anexo IS NOT NULL THEN UPDATE public.pix_pedidos SET pix_status='em_analise',pix_recebido_em=now(),updated_at=now() WHERE id=p_pedido AND status='aguardando_pix'; END IF;
 RETURN anexo;
END;
$pix_04$;
-- Uma confirmação deliberada da atendente é necessária. Nunca chamada pela IA.
DROP FUNCTION IF EXISTS public.pix_confirmar_recebimento(uuid);
DROP FUNCTION IF EXISTS public.pix_cancelar(uuid);
CREATE OR REPLACE FUNCTION public.pix_confirmar_recebimento(p_pedido uuid,p_autorizacao text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_05$
DECLARE p public.pix_pedidos; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pix_privado.config WHERE chave_painel=p_autorizacao) THEN RAISE EXCEPTION 'Código de conferência inválido'; END IF;
 SELECT * INTO p FROM public.pix_pedidos WHERE id=p_pedido AND status='aguardando_pix' AND pix_recebido_em IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE pix_privado.cobrancas SET confirmado_em=now() WHERE pedido_id=p_pedido;
 INSERT INTO public.pedidos(id,numero_pedido,cliente_id,status,tipo_entrega,endereco_entrega,forma_pagamento,subtotal,taxa_entrega,total,observacao,canal,pix_status,pix_resumo,pix_recebido_em)
 VALUES(p.id,p.numero_pedido,p.cliente_id,'pendente',p.tipo_entrega,p.endereco_entrega,'pix',p.subtotal,p.taxa_entrega,p.total,p.observacao,p.canal,'confirmado',p.pix_resumo,p.pix_recebido_em);
 INSERT INTO public.itens_pedido(pedido_id,produto_id,nome_produto,quantidade,preco_unitario,observacao,total)
 SELECT p.id,(x->>'produto_id')::uuid,x->>'nome',(x->>'quantidade')::integer,(x->>'preco_unitario')::numeric,x->>'observacao',round((x->>'quantidade')::integer*(x->>'preco_unitario')::numeric,2) FROM jsonb_array_elements(p.itens) x;
 UPDATE public.pix_pedidos SET status='pendente',pix_status='confirmado',updated_at=now() WHERE id=p_pedido;
 UPDATE pix_privado.cobrancas SET confirmado_em=now() WHERE pedido_id=p_pedido;
 DELETE FROM public.pedido_rascunho WHERE pedido_id=p_pedido;
 UPDATE public.clientes SET total_pedidos=coalesce(total_pedidos,0)+1,total_gasto=coalesce(total_gasto,0)+p.total,ultimo_pedido=now(),primeiro_pedido=coalesce(primeiro_pedido,now()),data_ultima_interacao=now() WHERE id=p.cliente_id;
 RETURN true;
END;
$pix_05$;
CREATE OR REPLACE FUNCTION public.pix_cancelar(p_pedido uuid,p_autorizacao text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_06$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pix_privado.config WHERE chave_painel=p_autorizacao) THEN RAISE EXCEPTION 'Código de conferência inválido'; END IF;
 UPDATE public.pix_pedidos SET status='cancelado',updated_at=now() WHERE id=p_pedido AND status='aguardando_pix';
 IF NOT FOUND THEN RETURN false; END IF;
 DELETE FROM public.pedido_rascunho WHERE pedido_id=p_pedido;
 RETURN true;
END;
$pix_06$;

-- Um rascunho Pix não pode ser inserido na fila real sem a conferência autorizada.
CREATE OR REPLACE FUNCTION pix_privado.proteger_liberacao()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_07$ BEGIN
 IF EXISTS(SELECT 1 FROM pix_privado.cobrancas WHERE pedido_id=NEW.id AND confirmado_em IS NULL) THEN RAISE EXCEPTION 'Pix ainda aguarda conferência'; END IF;
 RETURN NEW;
END;
$pix_07$;
DROP TRIGGER IF EXISTS pix_proteger_liberacao ON public.pedidos;
CREATE TRIGGER pix_proteger_liberacao BEFORE INSERT ON public.pedidos FOR EACH ROW EXECUTE FUNCTION pix_privado.proteger_liberacao();

CREATE OR REPLACE FUNCTION public.pix_registrar_atividade()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $pix_08$ UPDATE pix_privado.config SET ultimo_ciclo=now() WHERE id=true; $pix_08$;
CREATE OR REPLACE FUNCTION public.pix_integracao_pronta()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $pix_09$ SELECT coalesce((SELECT ultimo_ciclo>now()-interval '2 minutes' FROM pix_privado.config WHERE id=true),false); $pix_09$;

-- Operações exclusivas do agente: associar WhatsApp, reservar análise e gravar resultado.
CREATE OR REPLACE FUNCTION public.pix_buscar_pendentes(p_telefones text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $pix_10$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'numero_pedido',p.numero_pedido,'total',p.total,'criado_em',p.created_at,'token',c.token,'chave',c.chave,'recebedor',c.recebedor,'telefone',cl.telefone,'nome',cl.nome,'pix_status',p.pix_status)),'[]'::jsonb)
 FROM pix_privado.cobrancas c JOIN public.pix_pedidos p ON p.id=c.pedido_id JOIN public.clientes cl ON cl.id=p.cliente_id
 WHERE cl.telefone=ANY(p_telefones) AND p.status='aguardando_pix' AND c.criado_em>now()-interval '7 days';
$pix_10$;
CREATE OR REPLACE FUNCTION public.pix_definir_jid(p_pedido uuid,p_jid text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_11$ BEGIN
 IF length(p_jid)>100 OR p_jid !~ '@(lid|s.whatsapp.net)$' THEN RAISE EXCEPTION 'Endereço WhatsApp inválido'; END IF;
 UPDATE pix_privado.cobrancas SET jid=p_jid WHERE pedido_id=p_pedido;
END;
$pix_11$;
CREATE OR REPLACE FUNCTION public.pix_reservar_comprovante()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_12$
DECLARE r pix_privado.comprovantes; p public.pix_pedidos; c pix_privado.cobrancas; tel text; BEGIN
 SELECT * INTO r FROM pix_privado.comprovantes WHERE (status='pendente' OR status='analisando' AND reservado_ate<now()) AND tentativas<3 ORDER BY criado_em FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE pix_privado.comprovantes SET status='analisando',reserva=gen_random_uuid(),reservado_ate=now()+interval '3 minutes',tentativas=tentativas+1 WHERE id=r.id RETURNING * INTO r;
 SELECT * INTO p FROM public.pix_pedidos WHERE id=r.pedido_id;
 SELECT * INTO c FROM pix_privado.cobrancas WHERE pedido_id=p.id;
 SELECT telefone INTO tel FROM public.clientes WHERE id=p.cliente_id;
 RETURN to_jsonb(r)||jsonb_build_object('pedido',jsonb_build_object('id',p.id,'numero_pedido',p.numero_pedido,'total',p.total,'criado_em',p.created_at,'chave',c.chave,'recebedor',c.recebedor,'telefone',tel));
END;
$pix_12$;
CREATE OR REPLACE FUNCTION public.pix_finalizar_analise(p_id uuid,p_reserva uuid,p_hash text,p_leitura jsonb,p_resultado jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_13$
DECLARE r pix_privado.comprovantes; duplicado boolean; resumo jsonb; BEGIN
 SELECT * INTO r FROM pix_privado.comprovantes WHERE id=p_id AND reserva=p_reserva AND status='analisando' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 -- Serializa a verificação de hash/ID bancário, inclusive entre pedidos concorrentes.
 PERFORM pg_advisory_xact_lock(771204);
 duplicado:=EXISTS(SELECT 1 FROM pix_privado.comprovantes WHERE pedido_id<>r.pedido_id AND (hash=p_hash OR nullif(p_leitura->>'transacao','') IS NOT NULL AND transacao=p_leitura->>'transacao'));
 IF duplicado THEN p_resultado:=jsonb_build_object('status','divergente','motivos',jsonb_build_array('Este comprovante já está associado a outro pedido.')); END IF;
 UPDATE pix_privado.comprovantes SET status='analisado',hash=p_hash,transacao=nullif(p_leitura->>'transacao',''),leitura=p_leitura,resultado=p_resultado,reserva=NULL,reservado_ate=NULL WHERE id=p_id;
 resumo:=jsonb_build_object('status',p_resultado->>'status','motivos',p_resultado->'motivos','valor_lido',p_leitura->'valor','data_lida',p_leitura->'data_hora','origem',r.origem);
 -- Um resultado antigo não substitui o envio mais recente nem reabre pedido liberado.
 UPDATE public.pix_pedidos SET pix_status=CASE WHEN p_resultado->>'status'='compativel' THEN 'em_conferencia' ELSE p_resultado->>'status' END,pix_resumo=resumo,updated_at=now()
 WHERE id=r.pedido_id AND status='aguardando_pix' AND NOT EXISTS(SELECT 1 FROM pix_privado.comprovantes novo WHERE novo.pedido_id=r.pedido_id AND novo.criado_em>r.criado_em);
 RETURN true;
END;
$pix_13$;
CREATE OR REPLACE FUNCTION public.pix_falhar_analise(p_id uuid,p_reserva uuid,p_erro text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_14$
DECLARE r pix_privado.comprovantes; BEGIN
 UPDATE pix_privado.comprovantes SET status=CASE WHEN tentativas>=3 THEN 'analisado' ELSE 'pendente' END,erro=left(p_erro,500),resultado=CASE WHEN tentativas>=3 THEN '{"status":"inconclusivo","motivos":["Não foi possível ler o arquivo. A atendente fará a conferência."]}'::jsonb END,reserva=NULL,reservado_ate=NULL WHERE id=p_id AND reserva=p_reserva RETURNING * INTO r;
 IF r.tentativas>=3 THEN UPDATE public.pix_pedidos SET pix_status='inconclusivo',pix_resumo=r.resultado WHERE id=r.pedido_id AND status='aguardando_pix'; END IF;
END;
$pix_14$;
CREATE OR REPLACE FUNCTION public.pix_proximos_avisos(p_aberto boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $pix_15$
 SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (
 SELECT 'analise'::text tipo,a.id::text referencia,p.id pedido_id,p.numero_pedido,cl.telefone,coalesce(c.jid,cl.telefone) jid,c.token,p.total,a.resultado
 FROM pix_privado.comprovantes a JOIN public.pix_pedidos p ON p.id=a.pedido_id JOIN public.clientes cl ON cl.id=p.cliente_id JOIN pix_privado.cobrancas c ON c.pedido_id=p.id
 WHERE a.status='analisado' AND a.notificado_em IS NULL AND p.status='aguardando_pix' AND NOT EXISTS(SELECT 1 FROM pix_privado.comprovantes n WHERE n.pedido_id=p.id AND n.criado_em>a.criado_em)
 UNION ALL
 SELECT 'confirmacao',c.pedido_id::text,p.id,p.numero_pedido,cl.telefone,coalesce(c.jid,cl.telefone) jid,c.token,p.total,NULL::jsonb
 FROM pix_privado.cobrancas c JOIN public.pix_pedidos p ON p.id=c.pedido_id JOIN public.clientes cl ON cl.id=p.cliente_id WHERE c.confirmado_em IS NOT NULL AND c.confirmacao_enviada_em IS NULL
 UNION ALL
 SELECT 'lembrete',c.pedido_id::text,p.id,p.numero_pedido,cl.telefone,coalesce(c.jid,cl.telefone) jid,c.token,p.total,NULL::jsonb
 FROM pix_privado.cobrancas c JOIN public.pix_pedidos p ON p.id=c.pedido_id JOIN public.clientes cl ON cl.id=p.cliente_id
 WHERE p_aberto AND p.status='aguardando_pix' AND p.pix_status='aguardando_comprovante' AND c.lembrete_enviado_em IS NULL AND c.criado_em<now()-interval '10 minutes' AND c.criado_em>now()-interval '2 hours'
 ) x;
$pix_15$;
CREATE OR REPLACE FUNCTION public.pix_marcar_aviso(p_tipo text,p_referencia uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $pix_16$ BEGIN
 IF p_tipo='analise' THEN UPDATE pix_privado.comprovantes SET notificado_em=now() WHERE id=p_referencia;
 ELSIF p_tipo='lembrete' THEN UPDATE pix_privado.cobrancas SET lembrete_enviado_em=now() WHERE pedido_id=p_referencia;
 ELSIF p_tipo='confirmacao' THEN UPDATE pix_privado.cobrancas SET confirmacao_enviada_em=now() WHERE pedido_id=p_referencia; END IF;
END;
$pix_16$;

-- Os arquivos são privados. O cliente só envia/lê arquivos do próprio token.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('comprovantes-pix','comprovantes-pix',false,5242880,ARRAY['application/pdf','image/jpeg','image/png','image/webp'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=5242880,allowed_mime_types=excluded.allowed_mime_types;
DROP POLICY IF EXISTS pix_upload_proprio ON storage.objects;
CREATE POLICY pix_upload_proprio ON storage.objects FOR INSERT TO anon,authenticated WITH CHECK(bucket_id='comprovantes-pix' AND public.pix_arquivo_autorizado(name));
-- Sem política de listagem/leitura pública. Originais são acessíveis apenas ao servidor.
DO $pix_17$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure assinatura,p.proname nome FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pix_%' LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION '||r.assinatura||' FROM PUBLIC,anon,authenticated';
  IF r.nome IN ('pix_criar_pedido','pix_consultar','pix_anexar','pix_arquivo_autorizado','pix_integracao_pronta','pix_confirmar_recebimento','pix_cancelar') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION '||r.assinatura||' TO anon,authenticated,service_role';
  ELSE EXECUTE 'GRANT EXECUTE ON FUNCTION '||r.assinatura||' TO service_role'; END IF;
 END LOOP;
END;
$pix_17$;
DO $pix_18$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.pix_pedidos; EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END;
$pix_18$;
DO $ajuste$ BEGIN
 IF to_regprocedure('public.restaurante_aberto_em(timestamp with time zone)') IS NOT NULL THEN
  EXECUTE $func$CREATE OR REPLACE FUNCTION public.validar_horario_pedido()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $body$
  BEGIN
   IF EXISTS(SELECT 1 FROM pix_privado.cobrancas WHERE pedido_id=NEW.id AND confirmado_em IS NOT NULL) THEN RETURN NEW; END IF;
   IF NOT public.restaurante_aberto_em(clock_timestamp()) THEN RAISE EXCEPTION 'LOJA_FECHADA'; END IF;
   RETURN NEW;
  END; $body$ $func$;
 END IF;
END;
$ajuste$;
NOTIFY pgrst,'reload schema';
COMMIT;
-- Guarde este código somente com a equipe. Ele não vai para o site nem para clientes.
SELECT chave_painel AS codigo_conferencia_pix_do_painel FROM pix_privado.config;
-- Ative pix_habilitado=true SOMENTE depois de atualizar o agente e os sites.
