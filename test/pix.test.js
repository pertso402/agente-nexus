'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const {createRequire}=require('node:module');const {PGlite}=require('@electric-sql/pglite');
const {validarArquivo,compararComprovante,escolherPedido}=require('../src/utils/pix');
const pedido={total:110,chave:'02668346000198',criado_em:'2026-10-15T21:00:00Z'};
const leitura={comprovante:true,tipo_pagamento:'pix',situacao:'efetuado',valor:110,data_hora:'2026-10-15T18:02:00-03:00',documento_destino:'02.668.346/0001-98',transacao:'E12345678901234567890'};
test('compara valor, destinatário, data e situação sem confirmar crédito',()=>{
 const agora=new Date('2026-10-15T21:03:00Z');assert.equal(compararComprovante(leitura,pedido,agora).status,'compativel');
 for(const mudanca of [{valor:109.99},{documento_destino:'11111111000111'},{situacao:'agendado'},{data_hora:'2026-10-14T18:00:00-03:00'},{data_hora:'2026-10-16T18:00:00-03:00'}]) assert.equal(compararComprovante({...leitura,...mudanca},pedido,agora).status,'divergente');
 for(const mudanca of [{documento_destino:'02.***.***/0001-98'},{data_hora:null},{valor:null},{transacao:null},{comprovante:false}])assert.equal(compararComprovante({...leitura,...mudanca},pedido,agora).status,'inconclusivo');
});
test('aceita PDF e imagens reais, recusa MIME falso e arquivo grande',()=>{
 assert.equal(validarArquivo(Buffer.from('%PDF-1.4 teste'),'application/pdf').extensao,'pdf');
 assert.equal(validarArquivo(Buffer.from([255,216,255,1]),'image/jpeg').mime,'image/jpeg');
 assert.equal(validarArquivo(Buffer.from([137,80,78,71,13,10,26,10]),'image/png').mime,'image/png');
 assert.throws(()=>validarArquivo(Buffer.from('nao e pdf'),'application/pdf'));
 assert.throws(()=>validarArquivo(Buffer.alloc(5242881),'application/pdf'));
 assert.throws(()=>validarArquivo(Buffer.from('%PDF-1.4'),'image/png'));
});
test('não escolhe pedido pela recência quando há mais de um pendente',()=>{
 const ps=[{id:'a',numero_pedido:12},{id:'b',numero_pedido:13}];assert.equal(escolherPedido(ps,''),null);assert.equal(escolherPedido(ps,'comprovante pedido #012').id,'a');assert.equal(escolherPedido(ps,'pedido 99'),null);assert.equal(escolherPedido([ps[1]],'').id,'b');
});
test('Evolution preserva PDF, legenda e metadados de documento',()=>{
 const file=path.join(__dirname,'../src/services/evolution.js');const req=createRequire(file),mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:mod,require:req,process:{env:{}}});
 const m=mod.exports.extrairMensagem({data:{key:{id:'pdf1',remoteJid:'5544999999999@s.whatsapp.net'},messageType:'documentMessage',message:{documentMessage:{fileName:'pix.pdf',mimetype:'application/pdf',caption:'pedido #12'}},base64:'JVBERg=='}});
 assert.equal(m.tipo,'documentMessage');assert.equal(m.mimetype,'application/pdf');assert.equal(m.nomeArquivo,'pix.pdf');assert.equal(m.texto,'pedido #12');
});
async function fixture(){
 const pg=new PGlite();await pg.exec(
  "CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA storage;"+
  "CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb);ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;GRANT USAGE ON SCHEMA storage TO anon;GRANT INSERT,SELECT ON storage.objects TO anon;"+
  "CREATE SEQUENCE public.pedidos_numero_pedido_seq;CREATE TABLE clientes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),nome text NOT NULL,telefone text UNIQUE NOT NULL,endereco text,total_pedidos integer DEFAULT 0,total_gasto numeric DEFAULT 0,primeiro_pedido timestamptz,ultimo_pedido timestamptz,data_ultima_interacao date);"+
  "CREATE TABLE produtos(id uuid PRIMARY KEY,nome text,categoria text,preco numeric,preco_promocional numeric,disponivel boolean);"+
  "CREATE TABLE pedidos(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),numero_pedido integer DEFAULT nextval('pedidos_numero_pedido_seq'),cliente_id uuid,status text CHECK(status IN ('pendente','preparando','cancelado')),tipo_entrega text,endereco_entrega text,forma_pagamento text,subtotal numeric,taxa_entrega numeric,total numeric,observacao text,canal text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());"+
  "CREATE TABLE itens_pedido(id uuid DEFAULT gen_random_uuid(),pedido_id uuid,produto_id uuid,nome_produto text,quantidade integer,preco_unitario numeric,observacao text,total numeric);"+
  "CREATE TABLE pedido_rascunho(telefone text PRIMARY KEY,nome_cliente text,itens jsonb,tipo_entrega text,endereco text,forma_pagamento text,etapa_atual text,updated_at timestamptz);CREATE TABLE info_restaurante(chave text PRIMARY KEY,valor text NOT NULL);"
 );
 // Relógio controlado apenas no Postgres isolado do teste.
 await pg.exec("CREATE OR REPLACE FUNCTION pg_catalog.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$ SELECT '2026-10-15T21:00:00Z'::timestamptz $$;");
 await pg.exec(fs.readFileSync(path.join(__dirname,'../horarios.sql'),'utf8'));
 const sql=fs.readFileSync(path.join(__dirname,'../pix.sql'),'utf8');await pg.exec(sql);await pg.exec(sql);
 await pg.exec("UPDATE info_restaurante SET valor='true' WHERE chave='pix_habilitado';INSERT INTO info_restaurante VALUES('taxa_entrega','10'),('pedido_minimo','20');INSERT INTO produtos VALUES('11111111-1111-4111-8111-111111111111','Porção','Porções',50,NULL,true);");
 const dados={nome:'Cliente Teste',telefone:'(44) 99999-9999',tipo_entrega:'delivery',endereco:'Rua Teste, 123',itens:[{produto_id:'11111111-1111-4111-8111-111111111111',quantidade:2,preco_unitario:0}],requisicao:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 const criar=async(extra={})=>(await pg.query('SELECT pix_criar_pedido($1::jsonb) AS p',[JSON.stringify({...dados,...extra})])).rows[0].p;
 const anexar=async(pedido,sufixo='recibo')=>{const arquivo=pedido.id+'/'+pedido.pix_token+'/'+sufixo+'.pdf';await pg.query("INSERT INTO storage.objects(bucket_id,name) VALUES('comprovantes-pix',$1)",[arquivo]);return(await pg.query("SELECT pix_anexar($1,$2,$3,'recibo.pdf','application/pdf') AS id",[pedido.id,pedido.pix_token,arquivo])).rows[0].id;};
 const codigo=(await pg.query('SELECT chave_painel FROM pix_privado.config')).rows[0].chave_painel;
 return {pg,criar,anexar,codigo};
}
test('SQL cria rascunho atômico sem imprimir, precifica no banco e só libera após conferência',async()=>{
 const f=await fixture();try{
  assert.equal((await f.pg.query('SELECT pix_integracao_pronta() AS ok')).rows[0].ok,false);
  await f.pg.exec('SELECT pix_registrar_atividade()');
  assert.equal((await f.pg.query('SELECT pix_integracao_pronta() AS ok')).rows[0].ok,true);
  const p=await f.criar();assert.equal(p.total,110);assert.equal(p.status,'aguardando_pix');assert.equal((await f.pg.query('SELECT count(*) AS n FROM pedidos')).rows[0].n,0);
  const repetido=await f.criar();assert.equal(repetido.id,p.id);assert.equal((await f.pg.query('SELECT count(*) AS n FROM pix_pedidos')).rows[0].n,1);
  const r=(await f.pg.query('SELECT * FROM pedido_rascunho')).rows[0];assert.equal(r.pedido_id,p.id);assert.equal(r.itens[0].preco_unitario,50);
  assert.equal((await f.pg.query('SELECT pix_confirmar_recebimento($1,$2) AS ok',[p.id,f.codigo])).rows[0].ok,false);
  await assert.rejects(f.pg.query('SELECT pix_confirmar_recebimento($1,$2)',[p.id,'codigo-errado']),/inválido/);
  await assert.rejects(f.pg.query("INSERT INTO pedidos(id,status) VALUES($1,'pendente')",[p.id]),/aguarda conferência/);
  await f.anexar(p);const job=(await f.pg.query('SELECT pix_reservar_comprovante() AS j')).rows[0].j;
  await f.pg.query('SELECT pix_finalizar_analise($1,$2,$3,$4::jsonb,$5::jsonb)',[job.id,job.reserva,'hash1',JSON.stringify(leitura),JSON.stringify({status:'compativel',motivos:[]})]);
  assert.equal((await f.pg.query('SELECT pix_status FROM pix_pedidos')).rows[0].pix_status,'em_conferencia');assert.equal((await f.pg.query('SELECT count(*) AS n FROM pedidos')).rows[0].n,0);
  await f.pg.exec("INSERT INTO info_restaurante VALUES('loja_aberta','false') ON CONFLICT(chave) DO UPDATE SET valor='false'");
  assert.equal((await f.pg.query('SELECT pix_confirmar_recebimento($1,$2) AS ok',[p.id,f.codigo])).rows[0].ok,true);assert.equal((await f.pg.query('SELECT pix_confirmar_recebimento($1,$2) AS ok',[p.id,f.codigo])).rows[0].ok,false);
  assert.equal((await f.pg.query('SELECT id FROM pedidos')).rows[0].id,p.id);assert.equal((await f.pg.query('SELECT count(*) AS n FROM itens_pedido')).rows[0].n,1);assert.equal((await f.pg.query('SELECT total_pedidos FROM clientes')).rows[0].total_pedidos,1);assert.equal((await f.pg.query('SELECT count(*) AS n FROM pedido_rascunho')).rows[0].n,0);
 }finally{await f.pg.close();}
});
test('SQL separa tokens, bloqueia leitura pública e detecta reaproveitamento de comprovante',async()=>{
 const f=await fixture();try{
  const p1=await f.criar(),p2=await f.criar({requisicao:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});
  await assert.rejects(f.pg.query('SELECT pix_consultar($1,$2)',[p1.id,p2.pix_token]),/Pedido não encontrado/);
  await f.pg.exec('SET ROLE anon');await assert.rejects(f.pg.exec('SELECT * FROM pix_privado.cobrancas'),/permission denied/);await f.pg.exec('RESET ROLE');
  for(const [p,hash]of [[p1,'mesmo-hash'],[p2,'mesmo-hash']]){await f.anexar(p);const j=(await f.pg.query('SELECT pix_reservar_comprovante() AS j')).rows[0].j;await f.pg.query('SELECT pix_finalizar_analise($1,$2,$3,$4::jsonb,$5::jsonb)',[j.id,j.reserva,hash,JSON.stringify(leitura),JSON.stringify({status:'compativel',motivos:[]})]);}
  assert.equal((await f.pg.query('SELECT pix_status FROM pix_pedidos WHERE id=$1',[p2.id])).rows[0].pix_status,'divergente');
  await f.pg.exec('SET ROLE anon');assert.equal((await f.pg.query('SELECT count(*) AS n FROM storage.objects')).rows[0].n,0);await assert.rejects(f.pg.exec('SELECT pix_reservar_comprovante()'),/permission denied/);await f.pg.exec('RESET ROLE');
 }finally{await f.pg.close();}
});
test('SQL falha fecha sem pedido parcial e lembrete para quando chega comprovante',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.criar({itens:[{produto_id:'22222222-2222-4222-8222-222222222222',quantidade:1}]}),/indisponível/);assert.equal((await f.pg.query('SELECT count(*) AS n FROM pix_pedidos')).rows[0].n,0);
  const p=await f.criar();await f.pg.exec("UPDATE pix_privado.cobrancas SET criado_em=now()-interval '11 minutes'");
  assert.equal((await f.pg.query('SELECT pix_proximos_avisos(false) AS a')).rows[0].a.length,0);assert.equal((await f.pg.query('SELECT pix_proximos_avisos(true) AS a')).rows[0].a[0].tipo,'lembrete');
  await f.anexar(p);assert.equal((await f.pg.query('SELECT pix_proximos_avisos(true) AS a')).rows[0].a.length,0);
 }finally{await f.pg.close();}
});

test('leitura de PDF usa arquivo nativo e imagem usa visão, sem aprovar pagamento',async()=>{
 const file=path.join(__dirname,'../src/services/media.js'),req=createRequire(file),mod={exports:{}},chamadas=[];
 class OpenAI{constructor(){this.chat={completions:{create:async p=>{chamadas.push(p);return{choices:[{message:{content:JSON.stringify(leitura)}}]};}}};}}
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:mod,require:n=>n==='openai'?OpenAI:req(n),process:{env:{}}});
 await mod.exports.analisarComprovante('JVBERg==','application/pdf');assert.equal(chamadas[0].messages[1].content[0].type,'file');assert.match(chamadas[0].messages[1].content[0].file.file_data,/^data:application\/pdf;base64,/);
 await mod.exports.analisarComprovante('abc','image/jpeg');assert.equal(chamadas[1].messages[1].content[0].type,'image_url');
});
function servicoFixture(pendentes){
 const file=path.join(__dirname,'../src/services/pix.js'),req=createRequire(file),mod={exports:{}},envios=[],gravadas=[],uploads=[],chamadas=[];
 const db={sb:{rpc:async(nome,args)=>{chamadas.push({nome,args});return{data:nome==='pix_buscar_pendentes'?pendentes:nome==='pix_anexar'?'id':null};},storage:{from:()=>({upload:async(...args)=>{uploads.push(args);return{};},remove:async()=>({})})}},salvarMensagem:async(...args)=>gravadas.push(args),carregarPausaAtiva:async()=>null};
 const mocks={'./supabase':db,'./evolution':{enviarTexto:async(jid,texto)=>{envios.push({jid,texto});return'enviado';}},'./media':{},'../logger':{warn(){}}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:mod,require:n=>mocks[n]||req(n),Buffer,setInterval,Date});return{...mod.exports,envios,gravadas,uploads,chamadas};
}
test('WhatsApp recebe PDF no mesmo pedido e responde no JID correto',async()=>{
 const p={id:'pedido1',token:'token1',numero_pedido:12};const f=servicoFixture([p]);
 const tratado=await f.tratarComprovantesWhatsApp([{requestId:'r',msg:{telefone:'5544999999999',jid:'contato@lid',tipo:'documentMessage',mimetype:'application/pdf',nomeArquivo:'pix.pdf',base64:Buffer.from('%PDF-1.4 teste').toString('base64'),msgId:'whats1',texto:'pedido #12'}}]);
 assert.equal(tratado,true);assert.match(f.uploads[0][0],/^pedido1\/token1\//);assert.equal(f.envios[0].jid,'contato@lid');assert.doesNotMatch(f.envios[0].texto,/pagamento confirmado|já libero/);assert.equal(f.gravadas[0][3].msgId,'whats1');
});
test('WhatsApp pede o número quando há dois rascunhos e não atribui o arquivo por chute',async()=>{
 const f=servicoFixture([{id:'1',numero_pedido:12},{id:'2',numero_pedido:13}]);await f.tratarComprovantesWhatsApp([{msg:{telefone:'5544999999999',jid:'c',tipo:'documentMessage',mimetype:'application/pdf',base64:'JVBERg==',texto:''}}]);assert.equal(f.uploads.length,0);assert.match(f.envios[0].texto,/#12, #13/);
});
