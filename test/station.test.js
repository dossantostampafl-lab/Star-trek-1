'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfig } = require('../server/config.js');
const { start } = require('../server/index.js');
const { parseCron, nextRun, makeScheduler } = require('../server/cron.js');
const { makeMcpManager } = require('../server/mcp.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st1s-'));
const FAKE_MCP = path.join(__dirname, 'fixtures', 'fake-mcp.js');

// Provedor roteirizado por agente: cada nome de agente tem sua fila de respostas.
function scripted(scripts, seen) {
  return (agent) => ({
    name: agent.provider || 'freellmapi', model: agent.model || 'auto',
    async chat(req) {
      seen && seen.push({ agent: agent.name, messages: req.messages.slice(), tools: req.tools.map(t => t.name) });
      const q = scripts[agent.name] || [];
      const step = q.length ? q.shift() : { text: '(sem roteiro)' };
      if (step.text && req.onText) req.onText(step.text);
      return { text: step.text || '', toolCalls: (step.tools || []).map((t, i) => ({ id: 'c' + Date.now() + i, name: t.name, args: JSON.stringify(t.args) })), usage: step.usage || { input: 3, output: 2 }, model: agent.model || 'auto', routedVia: '', provider: agent.provider || 'freellmapi' };
    }
  });
}

async function boot(scripts, extra) {
  const dir = tmp();
  const config = getConfig({ WORKSPACE: path.join(dir, 'ws'), DATA_DIR: path.join(dir, 'data'), MAX_STEPS: '5' });
  const shellCalls = [];
  const seen = [];
  const srv = await start(Object.assign({
    config, port: 0, log: () => {}, retries: 0, tickMs: 60000,
    shellAvailable: true,
    shellRunner: async (o) => { shellCalls.push(o); return { code: 0, output: 'saida do container' }; },
    providerFor: scripted(scripts, seen)
  }, extra || {}));
  const api = async (method, p, body, headers) => {
    const res = await fetch(srv.url + p, { method, headers: Object.assign({ 'x-st1-token': srv.token, 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => null);
    return { status: res.status, body: j };
  };
  // cliente SSE (fetch com cabeçalho, como a interface faz)
  const events = [];
  const waiters = [];
  const ctrl = new AbortController();
  const sse = await fetch(srv.url + '/api/events', { headers: { 'x-st1-token': srv.token }, signal: ctrl.signal });
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const c of sse.body) {
        buf += dec.decode(c, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          events.push(ev);
          for (const w of waiters.slice()) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
        }
      }
    } catch (_) { /* fechado */ }
  })();
  const waitFor = (pred, ms) => {
    const found = events.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('evento não chegou; últimos: ' + JSON.stringify(events.slice(-5)))), ms || 4000);
    });
  };
  await new Promise(r => setTimeout(r, 50));
  return { srv, api, events, waitFor, shellCalls, seen, config, close: async () => { ctrl.abort(); await srv.close(); } };
}

test('cron: expressões e próximo disparo', () => {
  const base = new Date(2026, 8, 29, 15, 7, 30);   // ter 29/09/2026 15:07:30 (local)
  assert.deepEqual(nextRun('*/15 * * * *', base).getMinutes(), 15);
  const d = nextRun('0 9 * * 1-5', base);
  assert.equal(d.getDate(), 30); assert.equal(d.getHours(), 9); assert.equal(d.getMinutes(), 0);
  const w = nextRun('30 8 * * sat', base);
  assert.equal(w.getDay(), 6);
  const m = nextRun('@monthly', base);
  assert.equal(m.getDate(), 1); assert.equal(m.getMonth(), 9);
  assert.equal(nextRun('0 0 * * 7', base).getDay(), 0);
  assert.throws(() => parseCron('0 9 * *'), /5 campos/);
  assert.throws(() => parseCron('61 * * * *'), /intervalo/);
  assert.throws(() => parseCron('0 9 * * funday'), /inválido/);
});

test('cron: o relógio dispara uma vez e agenda o próximo', async () => {
  const s = { id: 's1', cron: '* * * * *', enabled: true, next_run: new Date(2026, 0, 1, 10, 0).toISOString() };
  const fired = [];
  const sch = makeScheduler({ list: () => [s], update: (id, p) => Object.assign(s, p), fire: (x) => fired.push(x.id), now: () => new Date(2026, 0, 1, 10, 0, 20) });
  sch.tick(); sch.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(fired.length, 1);
  assert.equal(new Date(s.next_run).getMinutes(), 1);
});

test('servidor: segurança básica (token, host, origem, health)', async () => {
  const t = await boot({});
  try {
    assert.equal((await fetch(t.srv.url + '/api/health')).status, 200);
    assert.equal((await fetch(t.srv.url + '/api/state')).status, 401);
    assert.equal((await t.api('GET', '/api/state', null, { 'x-st1-token': 'errado' })).status, 401);
    assert.equal((await t.api('GET', '/api/state', null, { origin: 'https://site-malicioso.com' })).status, 403);
    const html = await (await fetch(t.srv.url + '/')).text();
    assert.ok(html.includes(t.srv.token), 'token injetado na página');
    assert.equal((await fetch(t.srv.url + '/../server/db.js')).status, 404);
  } finally { await t.close(); }
});

test('estação: chat com terminal (pede permissão) → esteira automática → próximo agente', async () => {
  const t = await boot({
    Analista: [{ tools: [{ name: 'shell', args: { command: 'ls' } }] }, { text: 'Relatório: 3 arquivos.' }],
    Revisor: [{ text: 'Revisado: ok.' }]
  });
  try {
    const A = (await t.api('POST', '/api/agents', { name: 'Analista', role: 'analisa', shell: true })).body;
    const B = (await t.api('POST', '/api/agents', { name: 'Revisor' })).body;
    assert.notDeepEqual([A.room_x, A.room_y], [B.room_x, B.room_y], 'cada agente numa sala');
    assert.equal((await t.api('POST', '/api/conveyors', { from_agent: A.id, to_agent: B.id })).status, 201);
    assert.equal((await t.api('POST', '/api/conveyors', { from_agent: A.id, to_agent: B.id })).status, 400);

    const r = await t.api('POST', '/api/agents/' + A.id + '/message', { text: 'liste os arquivos' });
    assert.equal(r.status, 202);
    const ask = await t.waitFor(e => e.type === 'consent_request');
    assert.equal(ask.tool.name, 'shell');
    assert.deepEqual(ask.choices, ['once', 'session', 'deny']);
    assert.equal((await t.api('POST', '/api/consent', { id: ask.id, decision: 'once' })).status, 200);

    await t.waitFor(e => e.type === 'run_end' && e.agentId === A.id);
    assert.equal(t.shellCalls.length, 1);
    assert.ok(t.shellCalls[0].workspace.endsWith(A.id), 'terminal só vê a pasta do agente');
    const endB = await t.waitFor(e => e.type === 'run_end' && e.agentId === B.id);
    assert.equal(endB.output, 'Revisado: ok.');
    const bInput = t.seen.find(s => s.agent === 'Revisor').messages.find(m => m.role === 'user').content;
    assert.match(bInput, /Relatório: 3 arquivos/);
    assert.ok(t.events.some(e => e.type === 'conveyor' && e.from === A.id && e.to === B.id));

    const hist = (await t.api('GET', '/api/agents/' + A.id + '/history')).body;
    assert.deepEqual(hist.map(h => h.role), ['user', 'tool', 'assistant']);
    const runs = (await t.api('GET', '/api/runs')).body;
    assert.equal(runs.filter(x => x.status === 'done').length, 2);
    assert.ok(t.seen.find(s => s.agent === 'Analista').tools.includes('pass_work'));
  } finally { await t.close(); }
});

test('estação: agendamento é automático → terminal negado sem perguntar', async () => {
  const t = await boot({ Vigia: [{ tools: [{ name: 'shell', args: { command: 'rm -rf /work' } }] }, { text: 'Não pude rodar.' }] });
  try {
    const A = (await t.api('POST', '/api/agents', { name: 'Vigia', shell: true })).body;
    assert.equal((await t.api('POST', '/api/schedules', { agent_id: A.id, cron: 'toda hora', prompt: 'x' })).status, 400);
    const s = (await t.api('POST', '/api/schedules', { agent_id: A.id, cron: '0 9 * * 1-5', prompt: 'verifique' })).body;
    assert.ok(s.next_run);
    await t.api('POST', '/api/schedules/' + s.id + '/run');
    const end = await t.waitFor(e => e.type === 'run_end' && e.agentId === A.id);
    assert.equal(end.output, 'Não pude rodar.');
    assert.equal(t.shellCalls.length, 0);
    assert.ok(!t.events.some(e => e.type === 'consent_request'));
    assert.ok(t.events.some(e => e.type === 'agent_event' && e.event.type === 'denied'));
    const st = (await t.api('GET', '/api/state')).body;
    assert.match(st.schedules[0].info, /próxima/);
  } finally { await t.close(); }
});

test('estação: pass_work só para agentes ligados por esteira; limite de cadeia', async () => {
  const t = await boot({
    Chefe: [{ tools: [{ name: 'pass_work', args: { to: 'Estranho', task: 'x' } }, { name: 'pass_work', args: { to: 'ajudante', task: 'pesquise X' } }] }, { text: 'Delegado.' }],
    Ajudante: [{ text: 'Pesquisei X.' }]
  });
  try {
    const A = (await t.api('POST', '/api/agents', { name: 'Chefe' })).body;
    const B = (await t.api('POST', '/api/agents', { name: 'Ajudante' })).body;
    await t.api('POST', '/api/agents', { name: 'Estranho' });
    await t.api('POST', '/api/conveyors', { from_agent: A.id, to_agent: B.id, auto: false });
    await t.api('POST', '/api/agents/' + A.id + '/message', { text: 'delegue' });
    const endB = await t.waitFor(e => e.type === 'run_end' && e.agentId === B.id);
    assert.equal(endB.output, 'Pesquisei X.');
    const results = t.events.filter(e => e.type === 'agent_event' && e.event.type === 'tool_result').map(e => e.event);
    assert.equal(results[0].ok, false);
    assert.match(results[0].output, /sem esteira/);
    assert.equal(results[1].ok, true);
    // esteira manual (auto:false) não encaminha o resultado final do Ajudante de volta a ninguém
    await new Promise(r => setTimeout(r, 100));
    assert.equal(t.events.filter(e => e.type === 'run_start').length, 2);
  } finally { await t.close(); }
});

test('estação: orçamento para o agente quando o gasto chega ao limite', async () => {
  const big = { input: 1e6, output: 0 };   // 1M tokens de entrada no Sonnet = US$ 3
  const t = await boot({ Caro: [{ tools: [{ name: 'get_time', args: {} }], usage: big }, { text: 'nunca' }] });
  try {
    const A = (await t.api('POST', '/api/agents', { name: 'Caro', provider: 'anthropic', model: 'claude-sonnet-5-5', budget_usd: 1 })).body;
    await t.api('POST', '/api/agents/' + A.id + '/message', { text: 'gaste' });
    const end = await t.waitFor(e => e.type === 'run_end' && e.agentId === A.id);
    assert.equal(end.status, 'error');
    assert.match(end.error, /orçamento/);
    const run = (await t.api('GET', '/api/runs?agent=' + A.id)).body[0];
    assert.equal(run.tokens_in, 1e6, 'o que foi gasto fica registrado');
  } finally { await t.close(); }
});

test('estação: cancelar e limpar histórico', async () => {
  let release;
  const t = await boot({}, {
    providerFor: () => ({ name: 'freellmapi', model: 'auto', chat: (req) => new Promise((res, rej) => { release = res; req.signal.addEventListener('abort', () => rej(Object.assign(new Error('cancelado'), { name: 'AbortError' }))); }) })
  });
  try {
    const A = (await t.api('POST', '/api/agents', { name: 'Lento' })).body;
    await t.api('POST', '/api/agents/' + A.id + '/message', { text: 'demore' });
    await t.waitFor(e => e.type === 'run_start');
    await t.api('POST', '/api/agents/' + A.id + '/cancel');
    const end = await t.waitFor(e => e.type === 'run_end');
    assert.equal(end.status, 'cancelled');
    void release;
    assert.equal((await t.api('POST', '/api/agents/' + A.id + '/reset')).status, 200);
    assert.deepEqual((await t.api('GET', '/api/agents/' + A.id + '/history')).body, []);
  } finally { await t.close(); }
});

test('MCP: cliente stdio lista ferramentas (com paginação) e chama', async () => {
  const m = makeMcpManager({});
  try {
    const st = await m.connect({ name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE_MCP] });
    assert.equal(st.status, 'conectado', st.error);
    assert.deepEqual(st.tools, ['echo', 'soma']);
    const tools = m.toolsFor(['fake']);
    assert.deepEqual(tools.map(t => t.name), ['mcp__fake__echo', 'mcp__fake__soma']);
    assert.equal(tools[0].scope, 'external');
    assert.equal(await tools[1].run({ a: 2, b: 3 }, {}), '5');
    const bad = await m.connect({ name: 'quebrado', transport: 'stdio', command: 'comando-que-nao-existe-st1' });
    assert.equal(bad.status, 'erro');
  } finally { await m.closeAll(); }
});

test('MCP: cliente HTTP (resposta em SSE e sessão)', async () => {
  const http = require('node:http');
  let sessionSeen = '';
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const msg = JSON.parse(b);
      if (msg.id == null) { res.writeHead(202); return res.end(); }
      sessionSeen = req.headers['mcp-session-id'] || sessionSeen;
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
        : msg.method === 'tools/list' ? { tools: [{ name: 'hora', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'meio-dia' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
      res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n\n');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const m = makeMcpManager({});
  try {
    const st = await m.connect({ name: 'web', transport: 'http', url: 'http://127.0.0.1:' + srv.address().port + '/mcp' });
    assert.equal(st.status, 'conectado', st.error);
    assert.equal(await m.toolsFor(['web'])[0].run({}, {}), 'meio-dia');
    assert.equal(sessionSeen, 'sess-1');
  } finally { await m.closeAll(); await new Promise(r => srv.close(r)); }
});

test('estação + MCP: permissão "sempre" libera o conector também no automático', async () => {
  const t = await boot({
    Operador: [
      { tools: [{ name: 'mcp__fake__soma', args: { a: 2, b: 3 } }] }, { text: 'Deu 5.' },
      { tools: [{ name: 'mcp__fake__echo', args: { text: 'oi' } }] }, { text: 'Eco feito.' }
    ]
  });
  try {
    const add = await t.api('POST', '/api/mcp', { name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE_MCP] });
    assert.equal(add.status, 201);
    assert.equal(add.body.status.status, 'conectado');
    const A = (await t.api('POST', '/api/agents', { name: 'Operador', mcp: ['fake'] })).body;
    await t.api('POST', '/api/agents/' + A.id + '/message', { text: 'some' });
    const ask = await t.waitFor(e => e.type === 'consent_request');
    assert.deepEqual(ask.choices, ['once', 'session', 'always', 'deny']);
    await t.api('POST', '/api/consent', { id: ask.id, decision: 'always' });
    const end = await t.waitFor(e => e.type === 'run_end' && e.agentId === A.id);
    assert.equal(end.output, 'Deu 5.');
    const s = (await t.api('POST', '/api/schedules', { agent_id: A.id, cron: '@daily', prompt: 'eco' })).body;
    await t.api('POST', '/api/schedules/' + s.id + '/run');
    const end2 = await t.waitFor(e => e.type === 'run_end' && e.agentId === A.id && e.runId !== end.runId);
    assert.equal(end2.output, 'Eco feito.');
    assert.equal(t.events.filter(e => e.type === 'consent_request').length, 1);
    assert.equal((await t.api('GET', '/api/state')).body.grants[0].key, 'mcp:fake');
  } finally { await t.close(); }
});

test('checkpoints pela API: lista e restaura a pasta do agente', async () => {
  const t = await boot({ Escritor: [{ tools: [{ name: 'write_file', args: { path: 'a.txt', content: 'novo' } }] }, { text: 'ok' }] });
  try {
    const A = (await t.api('POST', '/api/agents', { name: 'Escritor' })).body;
    const ws = t.srv.station.workspaceOf(A.id);
    fs.writeFileSync(path.join(ws, 'a.txt'), 'original');
    await t.api('POST', '/api/agents/' + A.id + '/message', { text: 'escreva' });
    await t.waitFor(e => e.type === 'run_end');
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'novo');
    const cps = (await t.api('GET', '/api/agents/' + A.id + '/checkpoints')).body;
    assert.equal(cps.length, 1);
    assert.equal((await t.api('POST', '/api/agents/' + A.id + '/checkpoints/' + cps[0].id + '/restore')).status, 200);
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'original');
  } finally { await t.close(); }
});
