'use strict';
const crypto = require('node:crypto');
const MAX_ARQUIVO = 5 * 1024 * 1024;
function validarArquivo(buffer, mime) {
 if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_ARQUIVO) throw new Error('Envie um PDF ou imagem de até 5 MB.');
 const tipos = [
  ['application/pdf', buffer.subarray(0,5).toString() === '%PDF-'],
  ['image/jpeg', buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff],
  ['image/png', buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))],
  ['image/webp', buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP'],
 ];
 const real = tipos.find(([,ok]) => ok)?.[0];
 if (!real || mime?.split(';')[0] !== real) throw new Error('Formato inválido. Envie PDF, JPG, PNG ou WebP.');
 return { mime: real, extensao: { 'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','image/webp':'webp' }[real], hash: crypto.createHash('sha256').update(buffer).digest('hex') };
}
const digitos = v => String(v || '').replace(/[^0-9]/g,'');
// A chave pode ser CNPJ, CPF, celular, e-mail ou aleatória. Em chave de celular
// o comprovante traz o CPF do titular em documento_destino — também 11 dígitos —,
// então ali só a própria chave lida no comprovante serve para comparar.
function tipoChave(chave) {
 const s=String(chave||'').trim();
 if (s.includes('@')) return 'email';
 if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return 'aleatoria';
 const d=digitos(s);
 if (d.length===14) return 'cnpj';
 if (/^(55)?[1-9]{2}9[0-9]{8}$/.test(d)) return 'celular';
 return d.length===11 ? 'cpf' : 'outra';
}
function normalizarChave(valor, tipo) {
 const s=String(valor||'').trim().toLowerCase();
 if (!s || s.includes('*')) return null;          // mascarado: não dá para conferir
 if (tipo==='email' || tipo==='aleatoria') return s;
 const d=digitos(s);
 return tipo==='celular' && d.length===13 && d.startsWith('55') ? d.slice(2) : d;
}
function compararComprovante(leitura, pedido, agora = new Date()) {
 const divergencias=[], faltas=[];
 if (leitura?.comprovante !== true) return { status:'inconclusivo', motivos:['O arquivo não pôde ser identificado como comprovante de Pix.'] };
 if (leitura.tipo_pagamento !== 'pix') faltas.push('Não foi possível identificar que o pagamento é Pix.');
 if (leitura.situacao === 'agendado') divergencias.push('O documento mostra um agendamento, não uma transferência realizada.');
 else if (leitura.situacao !== 'efetuado') faltas.push('O documento não informa claramente uma transferência realizada.');
 const valor = leitura.valor;
 if (typeof valor !== 'number' || !Number.isFinite(valor) || valor<=0) faltas.push('Não foi possível ler o valor.');
 else if (Math.round(valor*100)!==Math.round(Number(pedido.total)*100)) divergencias.push('O valor do comprovante difere do total do pedido.');
 const tipo=tipoChave(pedido.chave), esperado=normalizarChave(pedido.chave,tipo);
 const campos=tipo==='cnpj'||tipo==='cpf' ? [leitura.chave_destino,leitura.documento_destino] : [leitura.chave_destino];
 const lidos=campos.map(v=>normalizarChave(v,tipo)).filter(v=>v && esperado && v.length===esperado.length);
 if (!esperado || !lidos.length) faltas.push('Não foi possível conferir a chave Pix do destinatário.');
 else if (!lidos.includes(esperado)) divergencias.push('O destinatário do comprovante difere da chave Pix do restaurante.');
 const textoData=String(leitura.data_hora || '');
 const data = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(textoData) ? new Date(textoData) : new Date(NaN);
 if (!Number.isFinite(data.getTime())) faltas.push('Não foi possível conferir a data e a hora do pagamento.');
 else if (data.getTime()<new Date(pedido.criado_em).getTime()-10*60_000) divergencias.push('O comprovante é anterior a este pedido.');
 else if (data.getTime()>agora.getTime()+5*60_000) divergencias.push('A data do comprovante está no futuro.');
 if (!String(leitura.transacao || '').trim()) faltas.push('Não foi possível ler a identificação da transação.');
 return {status:divergencias.length?'divergente':faltas.length?'inconclusivo':'compativel',motivos:divergencias.length?divergencias:faltas};
}
function escolherPedido(pedidos, texto) {
 const m=String(texto||'').match(/(?:pedido\s*#?\s*|#)([0-9]+)/i);
 if(m) return pedidos.find(p=>String(p.numero_pedido)===String(Number(m[1]))) || null;
 return pedidos.length===1?pedidos[0]:null;
}
module.exports={MAX_ARQUIVO,validarArquivo,compararComprovante,escolherPedido,tipoChave};
