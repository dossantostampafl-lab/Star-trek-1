'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfig } = require('../server/config.js');
const { start } = require('../server/index.js');
const { inWindow } = require('../server/missions.js');
const { levelOf, autonomyOf } = require('../server/growth.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st1m-'));

function scripted(scripts, seen) {
  return (agent) => ({
    name: 'freellmapi', model: 'auto',
    async chat(req) {
      seen.push({ agent: agent.name, messages: req.messages.slice(), tools: req.tools.map(t => t.name) });
      const q = scripts[agent.name] || [];
      const step = q.length ? q.shift() : { text: '(fim)' };
      if (step.text && req.onText) req.onText(step.text);
      return { text: step.text || '', toolCalls: (step.tools || []).map((t, i) => ({ id: 'c' + Math.random() + i, name: t.name, args: JSON.stringify(t.args) })), usage: { input: 3, output: 2 }, model: 'auto', routedVia: '', provider: 'freellmapi' };
    }
  });
}

async function boot(scripts, extra) {
  const dir = tmp();
  const seen = [], events = [], waiters = [];
  let clock = (extra && extra.clock) || null;
  const srv = await start(Object.assign({
    config: getConfig({ WORKSPACE: dir + '/ws', DATA_DIR: dir + '/data', SEED_CREW: '1' }),
    port: 0, log: () => {}, retries: 0, tickMs: 60000, nightTickMs: 3600e3, shellAvailable: false,
    providerFor: scripted(scripts, seen), now: clock ? () => clock.t : undefined
  }, extra && extra.overrides));
  const api = async (method, p, body) => {
    const r = await fetch(srv.url + p, { method, headers: { 'x-st1-token': srv.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ctrl = new AbortController();
  const sse = await fetch(srv.url + '/api/events', { headers: { 'x-st1-token': srv.token }, signal: ctrl.signal });
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try { for await (const c of sse.body) { buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const bl = buf.slice(0, i); buf = buf.slice(i + 2); const ln = bl.split('\n').find(l => l.startsWith('data: ')); if (!ln) continue;
        const ev = JSON.parse(ln.slice(6)); events.push(ev); for (const w of waiters.slice()) if (w.p(ev)) { waiters.splice(waiters.indexOf(w), 1); w.r(ev); } } } } catch (_) { /* fim */ }
  })();
  const waitFor = (p, ms) => { const f = events.find(p); if (f) return Promise.resolve(f); return new Promise((r, j) => { waiters.push({ p, r }); setTimeout(() => j(new Error('evento não chegou: ' + JSON.stringify(events.slice(-4)))), ms || 5000); }); };
  await new Promise(r => setTimeout(r, 50));
  const st = (await api('GET', '/api/state')).body;
  const id = Object.fromEntries(st.agents.map(a => [a.name, a.id]));
  return { srv, api, events, waitFor, seen, id, dir, close: async () => { ctrl.abort(); await srv.close(); } };
}

test('janela do turno da noite atravessa a meia-noite', () => {
  const at = (h, m) => new Date(2026, 8, 29, h, m);
  assert.ok(inWindow(at(23, 30), '23:00', '07:00'));
  assert.ok(inWindow(at(3, 0), '23:00', '07:00'));
  assert.ok(!inWindow(at(7, 0), '23:00', '07:00'));
  assert.ok(!inWindow(at(12, 0), '23:00', '07:00'));
  assert.ok(inWindow(at(14, 0), '13:00', '15:00'));
  assert.ok(!inWindow(at(14, 0), 'xx', '15:00'));
});

test('nível e autonomia', () => {
  assert.equal(levelOf(0), 1); assert.equal(levelOf(25), 2); assert.equal(levelOf(100), 3);
  assert.equal(autonomyOf(30), 'supervisionado'); assert.equal(autonomyOf(50), 'confiável'); assert.equal(autonomyOf(80), 'autônomo');
});

test('missões: Capitão cria, Pesquisadora conclui etapas, missão fecha e dá troféu', async () => {
  const t = await boot({
    'Capitão': [
      { tools: [{ name: 'mission_create', args: { title: 'Guia de IA', goal: 'um guia', steps: ['pesquisar', 'escrever'] } }] },
      { tools: [{ name: 'pass_work', args: { to: 'Pesquisadora', task: 'faça M1' } }] }, { text: 'Criei a M1 e delegue.' }
    ],
    Pesquisadora: [
      { tools: [{ name: 'mission_update', args: { mission: 'M1', step: 1, done: true, note: 'fontes em shared' } }, { name: 'mission_update', args: { mission: '1', step: 2, done: true } }] },
      { text: 'Pronto.' }
    ]
  });
  try {
    await t.api('POST', '/api/agents/' + t.id['Capitão'] + '/message', { text: 'faça um guia de IA' });
    await t.waitFor(e => e.type === 'run_end' && e.agentId === t.id.Pesquisadora, 6000);
    const ms = (await t.api('GET', '/api/missions')).body;
    assert.equal(ms.length, 1);
    assert.equal(ms[0].status, 'concluida');
    assert.equal(ms[0].steps[0].note, 'fontes em shared');
    assert.equal(ms[0].steps[0].agent, 'Pesquisadora');
    await t.waitFor(e => e.type === 'trophy' && e.key === 'missao' && e.agentId === t.id.Pesquisadora);
    const capTools = t.seen.find(s => s.agent === 'Capitão').tools;
    assert.ok(capTools.includes('mission_create') && capTools.includes('propose_belief'));
    assert.ok(!t.seen.find(s => s.agent === 'Pesquisadora').tools.includes('mission_create'), 'só o Capitão cria missões');
  } finally { await t.close(); }
});

test('missão criada pelo painel é despachada ao Capitão; comandante marca etapa', async () => {
  const t = await boot({ 'Capitão': [{ text: 'Recebido, começando.' }] });
  try {
    const r = (await t.api('POST', '/api/missions', { title: 'Loja', goal: 'abrir', steps: 'pesquisar\ndefinir preços' })).body;
    assert.equal(r.mission.num, 1);
    assert.equal(r.mission.steps.length, 2);
    await t.waitFor(e => e.type === 'run_end' && e.agentId === t.id['Capitão']);
    assert.match(t.seen[0].messages.find(x => x.role === 'user').content, /M1 — Loja/);
    const upd = (await t.api('PATCH', '/api/missions/' + r.mission.id, { toggleStep: 2 })).body;
    assert.equal(upd.steps[1].done, true);
    assert.equal((await t.api('PATCH', '/api/missions/' + r.mission.id, { status: 'xyz' })).status, 400);
    assert.equal((await t.api('POST', '/api/missions', { title: '' })).status, 400);
  } finally { await t.close(); }
});

test('turno da noite: dispara na janela, respeita confiança e gera relatório da manhã', async () => {
  const clock = { t: new Date(2026, 8, 29, 22, 0) };
  const t = await boot({
    'Capitão': [{ text: 'ok' }, { tools: [{ name: 'pass_work', args: { to: 'Redator', task: 'escreva' } }, { name: 'pass_work', args: { to: 'Pesquisadora', task: 'pesquise' } }] }, { text: 'Delegado.' }],
    Pesquisadora: [{ tools: [{ name: 'mission_update', args: { mission: 'M1', step: 1, done: true, note: 'feito à noite' } }] }, { text: 'Avancei a M1.' }]
  }, { clock });
  try {
    await t.api('POST', '/api/missions', { title: 'Relatório', steps: ['coletar', 'aguardando o comandante aprovar'] });
    await t.waitFor(e => e.type === 'run_end' && e.agentId === t.id['Capitão']);
    t.srv.db.updateAgent(t.id.Redator, { trust: 20 });   // Redator sem confiança para a noite
    t.srv.station.invalidate();
    assert.equal((await t.api('PUT', '/api/night', { enabled: true, start: '23:00', end: '07:00', interval_h: 2, max_runs: 3 })).body.enabled, true);
    assert.equal((await t.api('PUT', '/api/night', { start: '25:00' })).status, 400);
    clock.t = new Date(2026, 8, 29, 23, 5);
    // força um tick do turno (em vez de esperar o relógio)
    await t.api('POST', '/api/night/run');
    const endCap = await t.waitFor(e => e.type === 'run_end' && e.agentId === t.id['Capitão'] && e.output === 'Delegado.', 6000);
    assert.ok(endCap);
    const capMsg = t.seen.filter(s => s.agent === 'Capitão')[1].messages.filter(x => x.role === 'user').pop().content;
    assert.match(capMsg, /TURNO DA NOITE/);
    assert.ok(!/Redator/.test(capMsg.split('(apenas:')[1].split(')')[0]), 'Redator fora da lista da noite');
    const results = t.events.filter(e => e.type === 'agent_event' && e.agentId === t.id['Capitão'] && e.event.type === 'tool_result').map(e => e.event);
    assert.match(results[results.length - 2].output, /confiança para o turno da noite/);
    await t.waitFor(e => e.type === 'run_end' && e.agentId === t.id.Pesquisadora, 6000);
    await t.waitFor(e => e.type === 'trophy' && e.key === 'noturno' && e.agentId === t.id.Pesquisadora);
    const rep = (await t.api('POST', '/api/night/report')).body;
    assert.match(rep.body, /Relatório da manhã/);
    assert.match(rep.body, /M1 — Relatório \(1\/2\)/);
    assert.match(rep.body, /feito à noite/);
    assert.match(rep.body, /Avancei a M1/);
    assert.equal((await t.api('GET', '/api/reports')).body.length, 1);
    const files = fs.readdirSync(path.join(t.dir, 'ws', '_compartilhado', 'relatorios'));
    assert.equal(files.length, 1);
  } finally { await t.close(); }
});

test('turno da noite pelo relógio: começa na janela e fecha com relatório', async () => {
  const clock = { t: new Date(2026, 8, 29, 22, 0) };
  const t = await boot({ 'Capitão': [{ text: 'ok' }, { text: 'Trabalhei.' }] }, { clock });
  try {
    await t.api('POST', '/api/missions', { title: 'X', steps: ['a'], dispatch: false });
    await t.api('PUT', '/api/night', { enabled: true, start: '23:00', end: '07:00', interval_h: 2, max_runs: 2 });
    // acessa o tick via módulo interno: dispara pelo relógio
    const { makeNightShift } = require('../server/missions.js');
    const ns = makeNightShift({ db: t.srv.db, station: t.srv.station, bus: t.srv.bus, now: () => clock.t, log: () => {} });
    ns.tick();                                 // 22h: nada
    assert.equal(t.events.filter(e => e.type === 'night_fired').length, 0);
    clock.t = new Date(2026, 8, 29, 23, 1); ns.tick();
    await t.waitFor(e => e.type === 'night_fired');
    ns.tick();                                 // mesmo horário: não repete
    assert.equal(t.events.filter(e => e.type === 'night_fired').length, 1);
    clock.t = new Date(2026, 8, 30, 1, 2); ns.tick();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(t.events.filter(e => e.type === 'night_fired').length, 2);
    clock.t = new Date(2026, 8, 30, 3, 5); ns.tick();   // max_runs = 2
    assert.equal(t.events.filter(e => e.type === 'night_fired').length, 2);
    clock.t = new Date(2026, 8, 30, 7, 1); ns.tick();
    await t.waitFor(e => e.type === 'report');
    assert.equal(t.srv.db.getSetting('night_active_since'), '');
  } finally { await t.close(); }
});

test('crescimento: XP, confiança com 👍/👎 e dossiê só com crenças aceitas', async () => {
  const t = await boot({
    Redator: [{ tools: [{ name: 'propose_belief', args: { text: 'Prefere respostas curtas' } }] }, { text: 'Anotado.' }, { text: 'Segunda.' }]
  });
  try {
    const R = t.id.Redator;
    await t.api('POST', '/api/agents/' + R + '/message', { text: 'oi' });
    const end = await t.waitFor(e => e.type === 'run_end' && e.agentId === R);
    let g = (await t.api('GET', '/api/state')).body.growth.find(x => x.id === R);
    assert.equal(g.xp, 12); assert.equal(g.trust, 51);
    assert.ok(g.trophies.some(x => x.key === 'primeira'));
    await t.api('POST', '/api/runs/' + end.runId + '/rate', { rating: 1 });
    g = (await t.api('GET', '/api/state')).body.growth.find(x => x.id === R);
    assert.equal(g.trust, 56); assert.equal(g.xp, 27); assert.equal(g.level, 2);
    await t.api('POST', '/api/runs/' + end.runId + '/rate', { rating: -1 });
    g = (await t.api('GET', '/api/state')).body.growth.find(x => x.id === R);
    assert.equal(g.trust, 46, '👎 desfaz o 👍 e ainda tira'); assert.equal(g.xp, 12);
    const bel = (await t.api('GET', '/api/beliefs')).body;
    assert.equal(bel.length, 1); assert.equal(bel[0].status, 'proposta');
    assert.equal((await t.api('GET', '/api/state')).body.pendingBeliefs, 1);
    // proposta ainda não entra no contexto
    await t.api('POST', '/api/agents/' + R + '/message', { text: 'de novo' });
    await t.waitFor(e => e.type === 'run_end' && e.agentId === R && e.output === 'Anotado.' ? false : e.type === 'run_end' && e.agentId === R && e.runId !== end.runId);
    let sys = t.seen.filter(s => s.agent === 'Redator').pop().messages[0].content;
    assert.ok(!sys.includes('Prefere respostas curtas'));
    await t.api('PATCH', '/api/beliefs/' + bel[0].id, { status: 'aceita' });
    await t.api('POST', '/api/agents/' + R + '/message', { text: 'terceira' });
    await new Promise(r => setTimeout(r, 300));
    sys = t.seen.filter(s => s.agent === 'Redator').pop().messages[0].content;
    assert.match(sys, /Prefere respostas curtas/);
    assert.ok((await t.api('GET', '/api/state')).body.growth.find(x => x.id === R).trophies.some(x => x.key === 'observador'));
  } finally { await t.close(); }
});
