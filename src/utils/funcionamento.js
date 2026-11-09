'use strict';

// Complementos do agente para utils/horarios.js. Aquele arquivo é cópia exata
// do cardápio v3 ("manter as cópias iguais"); o que é só do agente fica aqui.
const { FUSO, lerHorarios, avaliarFuncionamento } = require('./horarios');

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function partesLocais(data) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(data).map(x => [x.type, x.value]));
  return {
    dia: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    minutos: Number(p.hour) * 60 + Number(p.minute),
    data: `${p.year}-${p.month}-${p.day}`,
  };
}
const minutos = h => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
const horaTexto = h => h.replace(':00', 'h').replace(':', 'h');

// "Abrimos hoje às 17h30" — responde o "abrem hoje?" que o aviso de fechado
// deixava sem resposta. Devolve null se a agenda for inválida ou vazia.
function proximaAbertura(info = {}, agora = new Date()) {
  let dias;
  try { dias = lerHorarios(info); } catch { return null; }
  const hoje = partesLocais(agora);
  for (let i = 0; i < 7; i++) {
    const dia = (hoje.dia + i) % 7;
    const faixa = dias[dia]
      .filter(([inicio]) => i > 0 || minutos(inicio) > hoje.minutos)
      .sort((a, b) => minutos(a[0]) - minutos(b[0]))[0];
    if (faixa) {
      const quando = i === 0 ? 'hoje' : i === 1 ? 'amanhã' : DIAS[dia];
      return { quando, hora: horaTexto(faixa[0]), texto: `Abrimos ${quando === 'hoje' || quando === 'amanhã' ? quando : (dia === 6 || dia === 0 ? 'no ' : 'na ') + quando} às ${horaTexto(faixa[0])}.` };
    }
  }
  return null;
}

// A loja é aberta à mão no painel. Quando alguém fecha no fim do expediente e
// esquece de reabrir, os clientes do dia seguinte recebem "indisponível" em
// pleno horário (aconteceu em 19, 20 e 26/10).
//
// Regra: fechamento feito em um dia ANTERIOR vale até a próxima abertura da
// agenda. Fechar no próprio dia (feriado, falta de gás) continua respeitado
// até o dia seguinte.
function deveReabrir(info = {}, fechadoEm, agora = new Date()) {
  if (String(info.loja_aberta ?? 'true') === 'true') return false;
  if (!fechadoEm || Number.isNaN(new Date(fechadoEm).getTime())) return false;
  const pelaAgenda = avaliarFuncionamento({ ...info, loja_aberta: 'true' }, agora);
  if (!pelaAgenda.aberto) return false;
  return partesLocais(new Date(fechadoEm)).data < partesLocais(agora).data;
}

module.exports = { proximaAbertura, deveReabrir, partesLocais };
