'use strict';
/* server/tools/browser.js — navegador de verdade para os tripulantes (Chromium sem tela), sem dependências:
   fala o protocolo DevTools (CDP) por WebSocket.
   - browser (open/read/screenshot): abre e lê páginas que precisam de JavaScript e tira fotos (livre, como fetch_url).
   - browser_act (click/type): clicar e preencher formulários — pede permissão (escopo externo, chave "navegador";
     o comandante pode liberar "sempre"). Em execução automática, só com "sempre".
   Segurança: TODO o tráfego do Chromium passa por um proxy local que resolve o DNS e recusa rede interna
   (containers, 127.0.0.1, 10.x, 192.168.x…) — inclusive WebSocket e redirecionamentos. Cada tripulante tem
   um contexto separado (cookies próprios), fechado após 10 min parado. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { assertPublicHost } = require('./basic.js');

const IDLE_MS = 10 * 60 * 1000;
const NAV_TIMEOUT = 30000;
const MAX_TEXT = 12000;

function findChrome() {
  const cands = [process.env.CHROME_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'];
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) cands.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'));
  } catch (_) { /* sem playwright */ }
  return cands.find(p => p && fs.existsSync(p)) || null;
}

// ---- proxy que só deixa passar destinos públicos
function startGuardProxy(check) {
  check = check || assertPublicHost;
  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url); } catch (_) { res.writeHead(400); return res.end(); }
    try { await check(u.hostname); } catch (e) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Bloqueado pela estação: ' + e.message); }
    const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch (_) { /* já respondeu */ } });
    req.pipe(up);
  });
  server.on('connect', async (req, sock, head) => {
    const [host, port] = String(req.url).split(':');
    try { await check(host); } catch (_) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(Number(port) || 443, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- cliente CDP mínimo
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map(), listeners = new Set();
    ws.onopen = () => resolve({
      send(method, params, sessionId) {
        const msg = { id: ++id, method, params: params || {} };
        if (sessionId) msg.sessionId = sessionId;
        return new Promise((res, rej) => { pending.set(msg.id, { res, rej, method }); ws.send(JSON.stringify(msg)); });
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { try { ws.close(); } catch (_) { /* fechado */ } }
    });
    ws.onerror = (e) => reject(new Error('não conectei ao navegador: ' + (e.message || 'erro')));
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.rej(new Error(p.method + ': ' + m.error.message)); else p.res(m.result); return; }
      for (const fn of listeners) fn(m);
    };
    ws.onclose = () => { for (const p of pending.values()) p.rej(new Error('navegador fechou')); pending.clear(); };
  });
}

// script injetado: numera os elementos clicáveis e devolve texto + lista
const SNAPSHOT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
  document.querySelectorAll('[data-st1]').forEach(e => e.removeAttribute('data-st1'));
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=checkbox], [onclick], summary, label[for]';
  const out = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= 90 || !vis(el)) continue;
    n++; el.setAttribute('data-st1', String(n));
    const tag = el.tagName.toLowerCase(); const type = (el.getAttribute('type') || '').toLowerCase();
    let label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const kind = tag === 'a' ? 'link' : tag === 'input' ? 'campo ' + (type || 'texto') : tag === 'textarea' ? 'campo texto' : tag === 'select' ? 'lista' : 'botão';
    out.push('[' + n + '] ' + kind + (label ? ' "' + label + '"' : '') + (tag === 'a' && el.href ? ' → ' + el.href.slice(0, 100) : '') + (tag === 'input' && el.value && type !== 'password' ? ' = "' + String(el.value).slice(0, 40) + '"' : ''));
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
  return JSON.stringify({ title: document.title, url: location.href, text, elements: out });
})()`;

function makeBrowser(opts) {
  opts = opts || {};
  const chromePath = opts.chromePath || findChrome();
  let proc = null, cdp = null, proxy = null, starting = null, userDir = null;
  const ctxs = new Map();   // agentId → { contextId, targetId, sessionId, last, timer }

  async function ensureBrowser() {
    if (cdp) return cdp;
    if (starting) return starting;
    if (!chromePath) throw new Error('navegador não instalado nesta estação (Chromium não encontrado)');
    starting = (async () => {
      proxy = await startGuardProxy(opts.check);
      userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st1-chrome-'));
      const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
        '--mute-audio', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--metrics-recording-only',
        '--proxy-server=http://127.0.0.1:' + proxy.address().port, '--proxy-bypass-list=<-loopback>',
        '--remote-debugging-port=0', '--user-data-dir=' + userDir, '--window-size=1280,900', '--lang=pt-BR', 'about:blank'];
      proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const wsUrl = await new Promise((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error('o navegador não abriu a tempo')), 45000);
        proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
        proc.on('exit', (code) => { clearTimeout(t); reject(new Error('o navegador fechou (código ' + code + '): ' + buf.slice(-300))); });
      });
      proc.on('exit', () => { cdp = null; proc = null; ctxs.clear(); });
      cdp = await cdpConnect(wsUrl);
      return cdp;
    })();
    try { return await starting; } catch (e) { shutdown(); throw e; } finally { starting = null; }
  }

  async function page(agentId) {
    const c = await ensureBrowser();
    let s = ctxs.get(agentId);
    if (!s) {
      const { browserContextId } = await c.send('Target.createBrowserContext', { disposeOnDetach: true });
      const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
      await c.send('Page.enable', {}, sessionId);
      await c.send('Runtime.enable', {}, sessionId);
      s = { contextId: browserContextId, targetId, sessionId };
      ctxs.set(agentId, s);
    }
    s.last = Date.now();
    clearTimeout(s.timer);
    s.timer = setTimeout(() => closeAgent(agentId), IDLE_MS);
    if (s.timer.unref) s.timer.unref();
    return { c, s };
  }

  async function closeAgent(agentId) {
    const s = ctxs.get(agentId);
    if (!s) return;
    ctxs.delete(agentId);
    clearTimeout(s.timer);
    try { await cdp.send('Target.disposeBrowserContext', { browserContextId: s.contextId }); } catch (_) { /* já fechado */ }
    if (!ctxs.size) shutdown();
  }

  function shutdown() {
    for (const s of ctxs.values()) clearTimeout(s.timer);
    ctxs.clear();
    if (cdp) cdp.close();
    if (proc) try { proc.kill('SIGKILL'); } catch (_) { /* morto */ }
    if (proxy) try { proxy.close(); } catch (_) { /* fechado */ }
    if (userDir) try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) { /* ok */ }
    cdp = null; proc = null; proxy = null; userDir = null;
  }

  function waitLoad(c, sessionId, ms) {
    return new Promise((resolve) => {
      const off = c.on((m) => { if (m.sessionId === sessionId && (m.method === 'Page.loadEventFired' || m.method === 'Page.frameStoppedLoading')) { done(); } });
      const t = setTimeout(done, ms);
      function done() { off(); clearTimeout(t); setTimeout(resolve, 600); }
    });
  }

  async function snapshot(c, s) {
    const r = await c.send('Runtime.evaluate', { expression: SNAPSHOT_JS, returnByValue: true }, s.sessionId);
    const v = JSON.parse(r.result.value || '{}');
    const text = String(v.text || '');
    return 'Página: ' + (v.title || '(sem título)') + '\n' + v.url + '\n\n' + (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n… (texto cortado)' : text) +
      '\n\nElementos (use o número em browser_act):\n' + ((v.elements || []).join('\n') || '(nenhum)');
  }

  async function open(agentId, url) {
    let u;
    try { u = new URL(String(url || '').trim()); } catch (_) { throw new Error('URL inválida'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('só http/https');
    await (opts.check || assertPublicHost)(u.hostname);
    const { c, s } = await page(agentId);
    const loaded = waitLoad(c, s.sessionId, NAV_TIMEOUT);
    const nav = await c.send('Page.navigate', { url: u.href }, s.sessionId);
    if (nav.errorText) throw new Error('não abriu: ' + nav.errorText);
    await loaded;
    return snapshot(c, s);
  }

  async function read(agentId) {
    const { c, s } = await page(agentId);
    return snapshot(c, s);
  }

  async function elementCenter(c, s, ref) {
    const r = await c.send('Runtime.evaluate', { returnByValue: true, expression:
      '(() => { const el = document.querySelector(\'[data-st1="' + Number(ref) + '"]\'); if (!el) return null; el.scrollIntoView({block:"center"}); const b = el.getBoundingClientRect(); return {x: b.x + b.width/2, y: b.y + b.height/2}; })()' }, s.sessionId);
    if (!r.result.value) throw new Error('elemento [' + ref + '] não existe — leia a página de novo (browser com action read)');
    return r.result.value;
  }

  async function click(agentId, ref) {
    const { c, s } = await page(agentId);
    const p = await elementCenter(c, s, ref);
    const loaded = waitLoad(c, s.sessionId, 8000);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }, s.sessionId);
    await loaded;
    return snapshot(c, s);
  }

  async function type(agentId, ref, text, submit) {
    const { c, s } = await page(agentId);
    await elementCenter(c, s, ref);
    await c.send('Runtime.evaluate', { expression: '(() => { const el = document.querySelector(\'[data-st1="' + Number(ref) + '"]\'); el.focus(); if (el.select) el.select(); })()' }, s.sessionId);
    await c.send('Input.insertText', { text: String(text || '') }, s.sessionId);
    if (submit) {
      const loaded = waitLoad(c, s.sessionId, 10000);
      for (const t of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: t === 'keyDown' ? '\r' : undefined }, s.sessionId);
      await loaded;
    }
    return snapshot(c, s);
  }

  async function screenshot(agentId, absPath) {
    const { c, s } = await page(agentId);
    const r = await c.send('Page.captureScreenshot', { format: 'png' }, s.sessionId);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, Buffer.from(r.data, 'base64'));
  }

  return { available: !!chromePath, chromePath, open, read, click, type, screenshot, closeAgent, shutdown };
}

// ferramentas de um tripulante (jail = cela da pasta dele, para salvar fotos). Só duas, para o prompt ficar leve:
// browser (abrir/ler/foto — livre) e browser_act (clicar/digitar — pede permissão).
function browserTools(browser, agent, jail) {
  if (!browser || !browser.available) return [];
  return [
    { name: 'browser', scope: 'network',
      description: 'Navegador de verdade (executa JavaScript). action: "open" (com url), "read" (lê de novo a página aberta) ou "screenshot" (salva PNG em path). ' +
        'Devolve o texto e a lista NUMERADA de links/botões/campos para usar em browser_act. Prefira fetch_url para páginas simples.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['open', 'read', 'screenshot'] }, url: { type: 'string' }, path: { type: 'string' } }, required: ['action'] },
      async run(a) {
        if (a.action === 'open') return browser.open(agent.id, a.url);
        if (a.action === 'screenshot') {
          const rel = /\.png$/i.test(a.path || '') ? a.path : (a.path || 'capturas/pagina') + '.png';
          const abs = jail.resolve(rel);
          await browser.screenshot(agent.id, abs);
          return 'Foto salva em ' + jail.relOf(abs) + ' (' + fs.statSync(abs).size + ' bytes).';
        }
        return browser.read(agent.id);
      } },
    { name: 'browser_act', scope: 'external', server: 'navegador',
      description: 'Interage com a página aberta: action "click" (ref = número do elemento) ou "type" (ref + text; submit=true aperta Enter). ' +
        'Pede permissão ao comandante. Nunca digite senhas nem dados de cartão.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'type'] }, ref: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['action', 'ref'] },
      run: (a) => a.action === 'type' ? browser.type(agent.id, a.ref, a.text, a.submit) : browser.click(agent.id, a.ref) }
  ];
}

module.exports = { makeBrowser, browserTools, findChrome, startGuardProxy, cdpConnect };
