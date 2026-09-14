'use strict';

const logger = require('../logger');

/**
 * Executa fn com retry e backoff exponencial.
 * Só retenta em erros de rede/timeout, não em erros de negócio.
 */
async function comRetry(fn, { tentativas = 3, baseMs = 800, requestId, etapa } = {}) {
  let ultimoErro;

  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;
      const reretentavel = isRetentavel(err);

      logger.warn(`retry/${etapa}`, `Tentativa ${i + 1}/${tentativas} falhou${reretentavel ? ', tentando novamente' : ''}`, {
        requestId,
        etapa,
        tentativa: i + 1,
        erro: err.message,
        retentavel: reretentavel,
      });

      if (!reretentavel || i === tentativas - 1) break;

      const aguardar = baseMs * Math.pow(2, i); // 800ms, 1600ms, 3200ms
      await sleep(aguardar);
    }
  }

  throw ultimoErro;
}

function isRetentavel(err) {
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('rate limit') ||
    err.status === 429 ||
    err.status === 503 ||
    err.status === 502
  );
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { comRetry, sleep };
