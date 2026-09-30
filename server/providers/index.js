'use strict';
/* server/providers/index.js — cria o provedor e embrulha com retentativa + fallback.
   Regra: só troca de provedor se nada foi transmitido ainda (evita resposta duplicada/misturada). */
const { makeOpenAICompat } = require('./openai-compat.js');
const { makeAnthropic } = require('./anthropic.js');
const { ProviderError } = require('./errors.js');

function makeProvider(cfg) {
  if (cfg.kind === 'anthropic') return makeAnthropic(cfg);
  if (cfg.kind === 'openai') return makeOpenAICompat(cfg);
  throw new Error('tipo de provedor desconhecido: ' + cfg.kind);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('cancelado'), { name: 'AbortError' })); }, { once: true });
});

function withResilience(primary, fallback, opts) {
  opts = opts || {};
  const retries = opts.retries != null ? opts.retries : 2;
  const timeoutMs = opts.timeoutMs || Number(process.env.MODEL_TIMEOUT_MS) || 120000;
  const log = opts.log || (() => {});

  async function attempt(p, req) {
    let streamed = false;
    const onText = req.onText ? (t) => { streamed = true; req.onText(t); } : null;
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      // tempo limite por chamada: sem isso, um provedor travado deixa o tripulante esperando para sempre
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      try { return await p.chat(Object.assign({}, req, { onText, signal })); }
      catch (e) {
        if (timeout.aborted && !(req.signal && req.signal.aborted)) {
          e = new ProviderError(p.name, 'sem resposta em ' + Math.round(timeoutMs / 1000) + 's (provedor lento ou cota esgotada)', { retryable: true });
        }
        lastErr = e;
        if (e.name === 'AbortError' || !e.retryable || streamed || i === retries) throw Object.assign(e, { streamed });
        const wait = 800 * Math.pow(2, i);
        log('aviso: ' + e.message + ' — tentando de novo em ' + (wait / 1000) + 's');
        await sleep(wait, req.signal);
      }
    }
    throw lastErr;
  }

  async function chat(req) {
    try {
      const r = await attempt(primary, req);
      r.provider = primary.name;
      return r;
    } catch (e) {
      if (!fallback || e.name === 'AbortError' || e.streamed) throw e;
      log('aviso: ' + primary.name + ' falhou (' + e.message + ') — usando fallback ' + fallback.name);
      const r = await attempt(fallback, req);
      r.provider = fallback.name;
      return r;
    }
  }

  return { name: primary.name, model: primary.model, fallbackName: fallback ? fallback.name : null, chat };
}

function buildProvider(config, opts) {
  const primary = makeProvider(config.provider);
  const fallback = config.fallback ? makeProvider(config.fallback) : null;
  return withResilience(primary, fallback, opts);
}

module.exports = { makeProvider, withResilience, buildProvider };
