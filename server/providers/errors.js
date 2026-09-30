'use strict';
/* server/providers/errors.js — erro padronizado dos provedores; diz se vale tentar de novo / cair no fallback. */

class ProviderError extends Error {
  constructor(provider, message, opts) {
    opts = opts || {};
    super('[' + provider + '] ' + message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = opts.status || 0;
    // 0 = falha de rede; 408/409/429/5xx = transitórios
    this.retryable = opts.retryable != null ? opts.retryable
      : (this.status === 0 || this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500);
  }
}

async function httpError(provider, res) {
  let detail = '';
  try {
    const txt = await res.text();
    try { const j = JSON.parse(txt); detail = (j.error && (j.error.message || j.error.type)) || j.message || txt; }
    catch (_) { detail = txt; }
  } catch (_) { /* sem corpo */ }
  const hint = res.status === 401 ? ' — confira a chave de API no .env'
    : res.status === 404 ? ' — confira a URL base e o nome do modelo'
    : res.status === 429 ? ' — limite/cota atingido'
    : '';
  const err = new ProviderError(provider, 'HTTP ' + res.status + ': ' + String(detail).slice(0, 400) + hint, { status: res.status });
  // quanto esperar antes de tentar de novo: cabeçalho Retry-After ou "reset ~15s" no texto (FreeLLMAPI)
  const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
  const m = String(detail).match(/reset\s*~?\s*(\d+)\s*s/i);
  err.retryAfterMs = ra > 0 ? ra * 1000 : m ? Number(m[1]) * 1000 : 0;
  // o pedido ficou grande demais para os modelos disponíveis: vale tentar de novo com menos contexto
  err.tooLarge = /too large|context length|maximum context|prompt is too long|too many tokens/i.test(String(detail));
  return err;
}

function networkError(provider, err, baseUrl) {
  if (err && err.name === 'AbortError') return err;
  const cause = (err && err.cause && err.cause.code) || (err && err.code) || '';
  const hint = cause === 'ECONNREFUSED' ? ' — o servidor em ' + baseUrl + ' está rodando?' : '';
  return new ProviderError(provider, 'falha de conexão (' + (cause || (err && err.message) || 'erro') + ')' + hint, { status: 0 });
}

module.exports = { ProviderError, httpError, networkError };
