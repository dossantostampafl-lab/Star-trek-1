'use strict';
/* server/mcp.js — cliente MCP (Model Context Protocol) sem dependências.
   Transportes: stdio (processo local, JSON-RPC por linha) e HTTP "streamable" (POST com resposta JSON ou SSE).
   Cada ferramenta do conector vira uma ferramenta do agente chamada mcp__<conector>__<ferramenta>,
   com escopo "external" (pede permissão ao comandante). */
const { spawn } = require('node:child_process');
const { readSSE } = require('./providers/sse.js');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'star-trek-1', version: '0.1.0' };
const CALL_TIMEOUT_MS = 120000;
const MAX_RESULT = 30000;

// ---------- transporte stdio ----------
function stdioTransport(cfg, log) {
  const env = Object.assign({}, process.env, cfg.env || {});
  const child = spawn(cfg.command, cfg.args || [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
  const pending = new Map();
  let buf = '';
  let closed = false;
  let seq = 1;

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }   // servidores às vezes imprimem log no stdout
      if (msg.id != null && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); p(msg); }
    }
  });
  child.stderr.on('data', (d) => log && log('[mcp ' + cfg.name + '] ' + String(d).trim().slice(0, 300)));
  const fail = (why) => { closed = true; for (const [, p] of pending) p({ error: { message: why } }); pending.clear(); };
  child.on('error', (e) => fail('não iniciou: ' + e.message));
  child.on('exit', (code) => fail('processo terminou (código ' + code + ')'));

  return {
    request(method, params, signal) {
      if (closed) return Promise.reject(new Error('conector ' + cfg.name + ' desconectado'));
      const id = seq++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error('tempo esgotado em ' + method)); }, CALL_TIMEOUT_MS);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(t); pending.delete(id); reject(Object.assign(new Error('cancelado'), { name: 'AbortError' })); }, { once: true });
        pending.set(id, (msg) => { clearTimeout(t); msg.error ? reject(new Error(msg.error.message || 'erro MCP')) : resolve(msg.result); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
      });
    },
    notify(method, params) { if (!closed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n'); },
    close() { closed = true; try { child.kill(); } catch (_) { /* já saiu */ } },
    get closed() { return closed; }
  };
}

// ---------- transporte HTTP (streamable) ----------
function httpTransport(cfg) {
  let sessionId = '';
  let seq = 1;
  let closed = false;
  async function post(body, signal) {
    const headers = Object.assign({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION }, cfg.headers || {});
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(CALL_TIMEOUT_MS) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    return res;
  }
  return {
    async request(method, params, signal) {
      const id = seq++;
      const res = await post({ jsonrpc: '2.0', id, method, params: params || {} }, signal);
      if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 401 ? ' — confira o token nos cabeçalhos do conector' : ''));
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/event-stream')) {
        for await (const ev of readSSE(res.body)) {
          let msg; try { msg = JSON.parse(ev.data); } catch (_) { continue; }
          if (msg.id === id) { if (msg.error) throw new Error(msg.error.message || 'erro MCP'); return msg.result; }
        }
        throw new Error('stream terminou sem resposta para ' + method);
      }
      const msg = await res.json();
      if (msg.error) throw new Error(msg.error.message || 'erro MCP');
      return msg.result;
    },
    notify(method, params) { post({ jsonrpc: '2.0', method, params: params || {} }).catch(() => {}); },
    close() { closed = true; },
    get closed() { return closed; }
  };
}

function safeName(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }

function toText(result) {
  const parts = [];
  for (const c of (result && result.content) || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource' && c.resource) parts.push(c.resource.text || ('[recurso ' + c.resource.uri + ']'));
    else if (c.type === 'image') parts.push('[imagem ' + (c.mimeType || '') + ']');
    else parts.push('[' + c.type + ']');
  }
  if (!parts.length && result && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  const s = parts.join('\n');
  return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + '\n… (cortado)' : s;
}

// ---------- gerenciador ----------
function makeMcpManager(deps) {
  deps = deps || {};
  const log = deps.log || (() => {});
  const conns = new Map();   // nome → { cfg, transport, tools, status, error }

  async function connect(cfg) {
    await disconnect(cfg.name);
    const entry = { cfg, transport: null, tools: [], status: 'conectando', error: '' };
    conns.set(cfg.name, entry);
    try {
      entry.transport = cfg.transport === 'http' ? httpTransport(cfg) : stdioTransport(cfg, log);
      await entry.transport.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
      entry.transport.notify('notifications/initialized');
      const tools = [];
      let cursor;
      for (let page = 0; page < 20; page++) {
        const r = await entry.transport.request('tools/list', cursor ? { cursor } : {});
        tools.push(...(r.tools || []));
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      entry.tools = tools;
      entry.status = 'conectado';
      log('MCP ' + cfg.name + ': ' + tools.length + ' ferramenta(s)');
    } catch (e) {
      entry.status = 'erro';
      entry.error = e.message;
      if (entry.transport) entry.transport.close();
      log('MCP ' + cfg.name + ' falhou: ' + e.message);
    }
    if (deps.onChange) deps.onChange();
    return status().find(s => s.name === cfg.name);
  }

  async function disconnect(name) {
    const e = conns.get(name);
    if (e && e.transport) e.transport.close();
    conns.delete(name);
  }

  function toolsFor(names) {
    const out = [];
    for (const name of names || []) {
      const e = conns.get(name);
      if (!e || e.status !== 'conectado') continue;
      for (const t of e.tools) {
        out.push({
          name: ('mcp__' + safeName(name) + '__' + safeName(t.name)).slice(0, 64),
          scope: 'external',
          server: name,
          description: '[' + name + '] ' + (t.description || t.name).slice(0, 900),
          parameters: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
          async run(args, ctx) {
            const cur = conns.get(name);
            if (!cur || cur.status !== 'conectado' || cur.transport.closed) throw new Error('conector ' + name + ' desconectado');
            const r = await cur.transport.request('tools/call', { name: t.name, arguments: args }, ctx.signal);
            const text = toText(r);
            if (r && r.isError) throw new Error(text || 'o conector devolveu erro');
            return text || '(sem conteúdo)';
          }
        });
      }
    }
    return out;
  }

  function status() {
    return Array.from(conns.values()).map(e => ({ name: e.cfg.name, transport: e.cfg.transport, status: e.status, error: e.error, tools: e.tools.map(t => t.name) }));
  }

  async function closeAll() { for (const n of Array.from(conns.keys())) await disconnect(n); }

  return { connect, disconnect, toolsFor, status, closeAll };
}

module.exports = { makeMcpManager, toText, PROTOCOL_VERSION };
