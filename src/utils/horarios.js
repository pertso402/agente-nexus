/* Regra compartilhada pelo agente e pelo cardápio v3. Manter as cópias iguais. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HorariosRestaurante = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const FUSO = 'America/Sao_Paulo';
  const PADRAO = { 0: [], 1: [['17:30', '23:00']], 2: [['17:30', '23:00']], 3: [['17:30', '23:00']], 4: [['17:30', '23:00']], 5: [['17:30', '23:00']], 6: [['11:00', '23:00']] };
  const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  function minutos(texto) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(texto)) return NaN;
    const [h, m] = texto.split(':').map(Number);
    return h * 60 + m;
  }
  function lerHorarios(info = {}) {
    const bruto = info.horarios_funcionamento;
    const dias = bruto == null ? PADRAO : typeof bruto === 'string' ? JSON.parse(bruto) : bruto;
    for (let dia = 0; dia < 7; dia++) {
      if (!Array.isArray(dias?.[dia])) throw new Error('Informe os sete dias da semana.');
      for (const faixa of dias[dia]) {
        if (!Array.isArray(faixa) || faixa.length !== 2 || !Number.isFinite(minutos(faixa[0])) || !Number.isFinite(minutos(faixa[1])) || minutos(faixa[1]) <= minutos(faixa[0])) throw new Error('Horário de funcionamento inválido.');
      }
    }
    return dias;
  }
  const horaTexto = hora => hora.replace(':00', 'h').replace(':', 'h');
  function descrever(dias) {
    const partes = [];
    for (let dia = 1; dia <= 7;) {
      let fim = dia;
      while (fim < 7 && JSON.stringify(dias[fim % 7]) === JSON.stringify(dias[(fim + 1) % 7])) fim++;
      const nome = DIAS[dia % 7] + (fim > dia ? ' a ' + DIAS[fim % 7].toLowerCase() : '');
      const faixas = dias[dia % 7];
      partes.push(nome + ': ' + (faixas.length ? faixas.map(([a, b]) => horaTexto(a) + ' às ' + horaTexto(b)).join(' e ') : 'fechado'));
      dia = fim + 1;
    }
    return partes.join('; ');
  }
  function avaliarFuncionamento(info = {}, agora = new Date()) {
    let dias;
    try { dias = lerHorarios(info); }
    catch {
      return { aberto: false, configuracaoValida: false, horario: '', motivo: 'configuracao', mensagem: 'Nosso atendimento está indisponível no momento. Por favor, tente novamente mais tarde.' };
    }
    const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: FUSO, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(agora).map(p => [p.type, p.value]));
    const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(partes.weekday);
    const agoraMin = Number(partes.hour) * 60 + Number(partes.minute);
    const faixa = dias[dia].find(([inicio, fim]) => agoraMin >= minutos(inicio) && agoraMin < minutos(fim));
    const manual = String(info.loja_aberta ?? 'true') === 'true';
    const aberto = manual && !!faixa;
    const horario = descrever(dias);
    const motivo = !manual ? 'manual' : faixa ? null : 'horario';
    const mensagem = (motivo === 'manual' ? 'Nosso atendimento está indisponível no momento.' : 'Estamos fora do horário de atendimento no momento.') + '\n\nHorário de funcionamento:\n' + horario + '.\n\nVolte a falar com a gente durante o expediente. 🍻';
    return { aberto, configuracaoValida: true, horario, motivo, mensagem, fechaAs: faixa?.[1] || null };
  }
  return { FUSO, PADRAO, DIAS, lerHorarios, descrever, avaliarFuncionamento };
});
