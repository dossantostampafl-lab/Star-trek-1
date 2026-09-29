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

/* Busca na web sem chave de API: usa a versão HTML do DuckDuckGo. Pode falhar se o DuckDuckGo pedir
   verificação anti-robô; nesse caso o agente recebe o aviso e pode usar fetch_url num site conhecido. */
const webSearch = {
  name: 'web_search',
  scope: 'network',
  description: 'Busca na web e devolve até 8 resultados (título, link e trecho). Depois use fetch_url para ler a página.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'O que buscar' } }, required: ['query'] },
  async run(args, ctx) {
    const q = String(args.query || '').trim().slice(0, 300);
    if (!q) throw new Error('busca vazia');
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=br-pt', {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) StarTrek1-Agent/0.2', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      signal: ctx.signal || AbortSignal.timeout(20000)
    });
    if (!res.ok) throw new Error('busca respondeu HTTP ' + res.status + ' — tente fetch_url num site conhecido');
    const results = parseDuckResults(await res.text());
    if (!results.length) return 'Nenhum resultado (ou a busca pediu verificação anti-robô). Tente outras palavras ou fetch_url num site conhecido.';
    return results.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snippet ? '\n   ' + r.snippet : '')).join('\n');
  }
};

function decodeEntities(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDuckResults(html) {
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    let url = m[1].replace(/&amp;/g, '&');
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;   // anúncios
    const sn = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: decodeEntities(m[2]), url, snippet: sn ? decodeEntities(sn[1]).slice(0, 300) : '' });
  }
  return out;
}

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

module.exports = { getTime, fetchUrl, webSearch, parseDuckResults, isPrivateHost, htmlToText };
