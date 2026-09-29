'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfig } = require('../server/config.js');
const { start } = require('../server/index.js');
const { makeAuth } = require('../server/auth.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st1a-'));
const PW = 'senha-bem-grande-123';

// http.request permite mandar o Host de verdade (como o Caddy faz).
function req(url, method, p, headers, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port, method, path: p, headers: Object.assign({ host: 'estacao.sslip.io' }, headers || {}) }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch (_) { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: data });
      });
    });
    r.on('error', reject);
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
}

async function boot(extra) {
  const dir = tmp();
  const config = getConfig(Object.assign({ WORKSPACE: dir + '/ws', DATA_DIR: dir + '/data', PUBLIC_URL: 'https://estacao.sslip.io', ACCESS_PASSWORD: PW }, extra || {}));
  return start({ config, port: 0, log: () => {}, shellAvailable: false });
}

test('acesso público exige senha forte', async () => {
  await assert.rejects(boot({ ACCESS_PASSWORD: '' }), /ACCESS_PASSWORD é obrigatória/);
  await assert.rejects(boot({ ACCESS_PASSWORD: 'curta' }), /mínimo 12/);
});

test('login: página, senha errada, bloqueio, sessão e logout', async () => {
  const srv = await boot();
  try {
    const home = await req(srv.url, 'GET', '/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.location, '/login');
    assert.ok(!home.text.includes(srv.token), 'o token não vaza sem login');
    assert.equal((await req(srv.url, 'GET', '/login')).status, 200);
    assert.equal((await req(srv.url, 'GET', '/login.js')).status, 200);
    assert.equal((await req(srv.url, 'GET', '/app.js')).status, 302, 'arquivos do painel exigem login');
    const api = await req(srv.url, 'GET', '/api/state', { 'x-st1-token': srv.token });
    assert.equal(api.status, 401);
    assert.equal(api.body.login, true, 'nem com o token passa sem sessão');
    assert.equal((await req(srv.url, 'GET', '/api/health')).status, 200);
    assert.equal((await req('http://127.0.0.1:' + new URL(srv.url).port, 'GET', '/', { host: 'outro-site.com' })).status, 421);

    // origem errada no login (CSRF)
    assert.equal((await req(srv.url, 'POST', '/login', { 'content-type': 'application/json', origin: 'https://malicioso.com' }, { password: PW })).status, 403);

    const bad = await req(srv.url, 'POST', '/login', { 'content-type': 'application/json', 'x-forwarded-for': '1.1.1.1' }, { password: 'errada' });
    assert.equal(bad.status, 401);
    const ok = await req(srv.url, 'POST', '/login', { 'content-type': 'application/json', origin: 'https://estacao.sslip.io', 'x-forwarded-for': '2.2.2.2' }, { password: PW });
    assert.equal(ok.status, 200);
    const cookie = ok.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
    const sess = cookie.split(';')[0];

    const page = await req(srv.url, 'GET', '/', { cookie: sess });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(srv.token));
    const st = await req(srv.url, 'GET', '/api/state', { cookie: sess, 'x-st1-token': srv.token, origin: 'https://estacao.sslip.io' });
    assert.equal(st.status, 200);
    assert.equal(st.body.authEnabled, true);
    assert.equal((await req(srv.url, 'GET', '/api/state', { cookie: sess })).status, 401, 'sessão sem token também não passa');

    // cookie adulterado
    assert.equal((await req(srv.url, 'GET', '/', { cookie: sess.replace(/.$/, c => c === 'a' ? 'b' : 'a') })).status, 302);

    const out = await req(srv.url, 'POST', '/logout', { cookie: sess });
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  } finally { await srv.close(); }
});

test('login: 5 erros bloqueiam o IP por 15 minutos', () => {
  let t = 1e12;
  const a = makeAuth({ password: PW, dataDir: tmp(), now: () => t });
  const r = { headers: { 'x-forwarded-for': '9.9.9.9' }, socket: {} };
  for (let i = 0; i < 5; i++) assert.equal(a.login(r, 'x').status, 401);
  assert.equal(a.login(r, PW).status, 429, 'nem a senha certa entra durante o bloqueio');
  assert.equal(a.login({ headers: { 'x-forwarded-for': '8.8.8.8' }, socket: {} }, PW).status, 200, 'outro IP não é afetado');
  t += 16 * 60 * 1000;
  assert.equal(a.login(r, PW).status, 200);
});

test('sessão sobrevive a reinício e cai se a senha mudar', () => {
  const dir = tmp();
  const a1 = makeAuth({ password: PW, dataDir: dir });
  const cookie = a1.login({ headers: {}, socket: {} }, PW).cookie.split(';')[0];
  const a2 = makeAuth({ password: PW, dataDir: dir });
  assert.ok(a2.isLoggedIn({ headers: { cookie } }));
  const a3 = makeAuth({ password: PW + 'x', dataDir: dir });
  assert.ok(!a3.isLoggedIn({ headers: { cookie } }));
});

test('uso local continua sem senha', async () => {
  const dir = tmp();
  const srv = await start({ config: getConfig({ WORKSPACE: dir + '/ws', DATA_DIR: dir + '/data' }), port: 0, log: () => {}, shellAvailable: false });
  try {
    const r = await fetch(srv.url + '/');
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes(srv.token));
  } finally { await srv.close(); }
});
