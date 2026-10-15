'use strict';

// Uma fila por conversa. Mensagens durante o processamento formam o próximo lote.
// Cada processo atende uma instância da Evolution; não executar réplicas concorrentes.
function criarAgrupador({ processar, esperaMs = 10_000, onError = () => {},
  agora = Date.now, agendar = setTimeout, cancelar = clearTimeout }) {
  const filas = new Map();
  function programar(chave, fila) {
    if (fila.timer) cancelar(fila.timer);
    fila.timer = agendar(() => executar(chave, fila), Math.max(0, fila.ultima + esperaMs - agora()));
  }
  async function executar(chave, fila) {
    fila.timer = null;
    if (fila.executando) return;
    fila.executando = true;
    const lote = fila.entradas.splice(0);
    try { await processar(lote); }
    catch (err) { onError(err, chave); }
    finally {
      fila.executando = false;
      if (fila.entradas.length) programar(chave, fila);
      else filas.delete(chave);
    }
  }
  return {
    adicionar(chave, entrada) {
      let fila = filas.get(chave);
      if (!fila) { fila = { entradas: [], ultima: 0, executando: false, timer: null }; filas.set(chave, fila); }
      fila.entradas.push(entrada);
      fila.ultima = agora();
      if (!fila.executando) programar(chave, fila);
    },
  };
}
module.exports = { criarAgrupador };
