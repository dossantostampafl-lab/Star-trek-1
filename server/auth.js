'use strict';
/* server/auth.js — login por senha quando a estação fica acessível pela internet (ex.: Oracle Cloud atrás do Caddy).
   - Senha em ACCESS_PASSWORD (.env). Comparação em tempo constante.
   - Sessão = cookie assinado (HMAC-SHA256) com validade de 30 dias; o segredo fica em data/session.secret,
     então reiniciar a estação não desloga ninguém. Trocar a senha invalida todas as sessões.
   - Cookie HttpOnly + SameSite=Strict (+ Secure em HTTPS).
   - Limite de tentativas: 5 erros por IP a cada 15 minutos. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COOKIE = 'st1_session';
const MAX_AGE_S = 30 * 24 * 3600;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

function loadSecret(dataDir) {
  const file = path.join(dataDir, 'session.secret');
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function makeAuth(opts) {
  const password = opts.password || '';
  const enabled = !!password;
  const secret = enabled ? loadSecret(opts.dataDir) : '';
  // a chave de assinatura depende da senha: trocar a senha derruba as sessões antigas
  const key = enabled ? crypto.createHmac('sha256', secret).update('pw:' + password).digest() : null;
  const fails = new Map();   // ip → [timestamps]
  const now = opts.now || (() => Date.now());

  function sign(exp) { return crypto.createHmac('sha256', key).update('v1.' + exp).digest('base64url'); }

  function cookieValue(req) {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return '';
  }

  function isLoggedIn(req) {
    if (!enabled) return true;
    const v = cookieValue(req);
    const m = v.match(/^v1\.(\d+)\.([A-Za-z0-9_-]+)$/);
    if (!m) return false;
    const exp = Number(m[1]);
    if (exp * 1000 < now()) return false;
    const want = Buffer.from(sign(exp));
    const got = Buffer.from(m[2]);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  function clientIp(req) {
    // o Node só escuta em 127.0.0.1; quando há proxy (Caddy) na frente, o IP real vem no X-Forwarded-For
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xff || (req.socket && req.socket.remoteAddress) || '?';
  }

  function blocked(ip) {
    const list = (fails.get(ip) || []).filter(t => now() - t < WINDOW_MS);
    fails.set(ip, list);
    return list.length >= MAX_FAILS;
  }

  // → { ok, status, cookie?, error? }
  function login(req, given) {
    const ip = clientIp(req);
    if (blocked(ip)) return { ok: false, status: 429, error: 'muitas tentativas — espere 15 minutos' };
    const ok = crypto.timingSafeEqual(sha(given), sha(password));
    if (!ok) {
      fails.get(ip).push(now());
      return { ok: false, status: 401, error: 'senha incorreta' };
    }
    fails.delete(ip);
    const exp = Math.floor(now() / 1000) + MAX_AGE_S;
    return { ok: true, status: 200, cookie: cookieHeader('v1.' + exp + '.' + sign(exp), MAX_AGE_S) };
  }

  function cookieHeader(value, maxAge) {
    return COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (opts.secure ? '; Secure' : '');
  }

  function logoutCookie() { return cookieHeader('', 0); }

  return { enabled, isLoggedIn, login, logoutCookie, clientIp };
}

module.exports = { makeAuth, COOKIE };
