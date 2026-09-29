'use strict';
/* server/tools/basic.js — ferramentas simples e seguras: data/hora e busca de página web (somente leitura). */

const MAX_FETCH = 60 * 1024;

const getTime = {
  name: 'get_time',
  scope: 'read',
  description: 'Retorna a data e hora atuais (fuso opcional, ex.: "America/Sao_Paulo").',
  parameters: { type: 'object', properties: { timezone: { type: 'string' } } },
  run(args) {
    const tz = args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    return now.toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }) + ' (' + tz + ') — ISO ' + now.toISOString();
  }
};

const fetchUrl = {
  name: 'fetch_url',
  scope: 'network',
  description: 'Baixa uma página web pública (http/https) e retorna o texto sem HTML. Somente leitura.',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  async run(args, ctx) {
    let u;
    try { u = new URL(args.url); } catch (_) { throw new Error('URL inválida'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('só http/https');
    const signal = ctx.signal || AbortSignal.timeout(20000);
    let res;
    for (let hop = 0; ; hop++) {             // segue redirecionamentos checando cada destino
      if (isPrivateHost(u.hostname)) throw new Error('endereços locais/privados não são permitidos');
      res = await fetch(u, { redirect: 'manual', signal, headers: { 'user-agent': 'StarTrek1-Agent/0.1' } });
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) break;
      if (hop >= 5) throw new Error('redirecionamentos demais');
      u = new URL(loc, u);
      if (!/^https?:$/.test(u.protocol)) throw new Error('redirecionamento para protocolo não permitido');
    }
    const type = res.headers.get('content-type') || '';
    const raw = (await res.text()).slice(0, MAX_FETCH * 4);
    const text = type.includes('html') ? htmlToText(raw) : raw;
    return 'HTTP ' + res.status + ' ' + u.href + '\n\n' + text.slice(0, MAX_FETCH) + (text.length > MAX_FETCH ? '\n… (cortado)' : '');
  }
};

function isPrivateHost(h) {
  h = h.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0' || h === '::1' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

module.exports = { getTime, fetchUrl, isPrivateHost, htmlToText };
