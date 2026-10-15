'use strict';
const {randomUUID}=require('node:crypto');
const db=require('./supabase');
const {downloadMidia,enviarTexto}=require('./evolution');
const {analisarComprovante}=require('./media');
const {validarArquivo,compararComprovante,escolherPedido}=require('../utils/pix');
const {avaliarFuncionamento}=require('../utils/horarios');
const logger=require('../logger');
const BUCKET='comprovantes-pix';
const linkPedido=p=>'https://choppatinhas-v3.vercel.app/#pix='+p.id+'.'+p.token;
async function rpc(nome,params={}){const r=await db.sb.rpc(nome,params);if(r.error)throw Object.assign(new Error(r.error.message==='PIX_INDISPONIVEL'?'O Pix antecipado ainda não está habilitado. Escolha cartão ou dinheiro, ou fale com a atendente.':r.error.message),{code:r.error.message==='PIX_INDISPONIVEL'?'PIX_INDISPONIVEL':r.error.code});return r.data;}
async function criarPedidoPix({nomeCliente,telefone,tipoEntrega,endereco,itens,observacao,requisicao,origem='whatsapp'}) {
 const p=await rpc('pix_criar_pedido',{dados:{nome:nomeCliente,telefone,tipo_entrega:tipoEntrega,endereco,itens,observacao,requisicao,origem}});
 return {numeroPedido:p.numero_pedido,pedidoId:p.id,total:Number(p.total),subtotal:Number(p.subtotal),taxaEntrega:Number(p.taxa_entrega),formaPagamento:'pix',chavePix:p.chave_pix,linkPix:linkPedido({id:p.id,token:p.pix_token})};
}
async function registrarArquivo(pedido,buffer,mime,nome,origem){
 const validado=validarArquivo(buffer,mime);const arquivo=pedido.id+'/'+pedido.token+'/'+randomUUID()+'.'+validado.extensao;
 const {error}=await db.sb.storage.from(BUCKET).upload(arquivo,buffer,{contentType:validado.mime,upsert:false});if(error)throw new Error(error.message);
 try{return await rpc('pix_anexar',{p_pedido:pedido.id,p_token:pedido.token,p_arquivo:arquivo,p_nome:nome||'Comprovante.'+validado.extensao,p_mimetype:validado.mime,p_origem:origem});}
 catch(err){await db.sb.storage.from(BUCKET).remove([arquivo]);throw err;}
}
function variantes(t){const n=String(t).replace(/[^0-9]/g,'');const vs=new Set([n]);const m=n.match(/^55([0-9]{2})([0-9]{8,9})$/);if(m){if(m[2].length===8)vs.add('55'+m[1]+'9'+m[2]);else if(m[2][0]==='9')vs.add('55'+m[1]+m[2].slice(1));}return [...vs];}
async function tratarComprovantesWhatsApp(entradas){
 const arquivos=entradas.filter(e=>e.msg.tipo==='imageMessage'||e.msg.tipo==='documentMessage');
 if(!arquivos.length)return false;
 const ultima=entradas[entradas.length-1];const {telefone,jid}=ultima.msg;
 let pedidos;try{pedidos=await rpc('pix_buscar_pendentes',{p_telefones:variantes(telefone)});}catch(err){if(/PGRST202|42883/.test(err.code||''))return false;throw err;}
 if(!pedidos.length){
  if(!arquivos.some(e=>e.msg.tipo==='documentMessage'))return false;
  const texto='Recebi o documento, mas não encontrei um pedido Pix pendente vinculado a este WhatsApp. Informe o número do pedido para a atendente conferir.';
  for(const e of entradas)await db.salvarMensagem(telefone,'user',e.msg.texto||'[Documento recebido]',{origem:'cliente',tipo:'documento',msgId:e.msg.msgId});
  if(!await db.carregarPausaAtiva(telefone)){const id=await enviarTexto(jid,texto);await db.salvarMensagem(telefone,'assistant',texto,{origem:'agente',msgId:id});}
  return true;
 }
 const pedido=escolherPedido(pedidos,entradas.map(e=>e.msg.texto||'').join('\n'));
 let texto;
 if(!pedido){texto='Encontrei pedido(s) Pix pendente(s): '+pedidos.map(p=>'#'+p.numero_pedido).join(', ')+'. Reenvie o comprovante com o número do pedido na legenda para eu associar corretamente.';}
 else {
  await rpc('pix_definir_jid',{p_pedido:pedido.id,p_jid:jid});
  let recebidos=0;const erros=[];
  for(const entrada of arquivos){try{
   const m=entrada.msg;const midia=m.base64?{base64:m.base64,mimetype:m.mimetype}:await downloadMidia(m.mensagemRaw);
   const mime=midia.mimetype||m.mimetype;const b64=String(midia.base64||'').replace(/^data:[^,]+,/,'');
   await registrarArquivo(pedido,Buffer.from(b64,'base64'),mime,m.nomeArquivo,'whatsapp');recebidos++;
  }catch(err){erros.push(err.message);}}
  texto=recebidos?'Recebi o comprovante do pedido *#'+pedido.numero_pedido+'*. Vou comparar os dados com o pedido. A liberação acontece após a equipe conferir o recebimento na conta.':erros[0]||'Não consegui receber o arquivo. Envie PDF, JPG, PNG ou WebP de até 5 MB.';
 }
 for(const e of entradas)await db.salvarMensagem(telefone,'user',e.msg.texto||'[Comprovante recebido pelo WhatsApp]',{origem:'cliente',tipo:e.msg.tipo==='documentMessage'?'documento':e.msg.tipo==='imageMessage'?'imagem':'texto',msgId:e.msg.msgId,requestId:e.requestId});
 if(!await db.carregarPausaAtiva(telefone)){const id=await enviarTexto(jid,texto);await db.salvarMensagem(telefone,'assistant',texto,{origem:'agente',msgId:id,etapa:'pix/comprovante'});}
 return true;
}
function mensagemAviso(a){
 const numero='*#'+a.numero_pedido+'*';
 if(a.tipo==='confirmacao')return '✅ A equipe conferiu o pagamento do pedido '+numero+'. Seu pedido entrou na fila de atendimento! 🍻';
 if(a.tipo==='lembrete')return 'Oi! O pedido '+numero+' ainda está aguardando o comprovante do Pix. Se já pagou, pode enviar o PDF ou a imagem aqui, ou anexar pelo link:\n'+linkPedido({id:a.pedido_id,token:a.token})+'\n\nSe precisar de ajuda, é só falar.';
 const r=a.resultado||{};
 if(r.status==='compativel')return 'Os dados do comprovante do pedido '+numero+' estão compatíveis com o pedido. A equipe vai conferir o recebimento na conta para liberar. Não precisa enviar o comprovante novamente.';
 return 'Recebi o arquivo do pedido '+numero+', mas '+(r.motivos||['não consegui concluir a leitura.']).join(' ')+'\nPode reenviar um comprovante legível em PDF ou imagem. A equipe também pode ajudar na conferência.';
}
let ocupado=false,timer=null,indisponivelAvisado=false;
async function processarPix(){
 if(ocupado)return;ocupado=true;
 try{
  for(let i=0;i<5;i++){
   const job=await rpc('pix_reservar_comprovante');if(!job)break;
   try{
    const {data,error}=await db.sb.storage.from(BUCKET).download(job.arquivo);if(error)throw new Error(error.message);
    const buffer=Buffer.from(await data.arrayBuffer());const arquivo=validarArquivo(buffer,job.mimetype);
    const leitura=await analisarComprovante(buffer.toString('base64'),job.mimetype);
    const resultado=compararComprovante(leitura,job.pedido);
    await rpc('pix_finalizar_analise',{p_id:job.id,p_reserva:job.reserva,p_hash:arquivo.hash,p_leitura:leitura,p_resultado:resultado});
   }catch(err){await rpc('pix_falhar_analise',{p_id:job.id,p_reserva:job.reserva,p_erro:err.message});logger.warn('pix/analise',err.message,{pedido_id:job.pedido_id});}
  }
  const aberto=avaliarFuncionamento(await db.buscarInfo()).aberto;
  const avisos=await rpc('pix_proximos_avisos',{p_aberto:aberto});
  for(const a of avisos){
   if(a.tipo !== 'confirmacao' && await db.carregarPausaAtiva(a.telefone))continue;
   if(a.tipo==='lembrete'){
    if(!avaliarFuncionamento(await db.buscarInfo()).aberto)continue;
    const atual=await rpc('pix_consultar',{p_pedido:a.pedido_id,p_token:a.token});
    if(atual.status!=='aguardando_pix'||atual.pix_status!=='aguardando_comprovante')continue;
   }
   try{const texto=mensagemAviso(a);const id=await enviarTexto(a.jid||a.telefone,texto);await db.salvarMensagem(a.telefone,'assistant',texto,{origem:'agente',msgId:id,etapa:'pix/'+a.tipo});await rpc('pix_marcar_aviso',{p_tipo:a.tipo,p_referencia:a.referencia});}
   catch(err){logger.warn('pix/aviso',err.message,{pedido_id:a.pedido_id,tipo:a.tipo});}
  }
  await rpc('pix_registrar_atividade');
  indisponivelAvisado=false;
 }catch(err){if(!indisponivelAvisado){logger.warn('pix/indisponivel',err.message);indisponivelAvisado=true;}}
 finally{ocupado=false;}
}
function iniciarPix(){if(timer)return;processarPix();timer=setInterval(processarPix,5000);timer.unref?.();}
module.exports={criarPedidoPix,tratarComprovantesWhatsApp,processarPix,iniciarPix,registrarArquivo,mensagemAviso};
