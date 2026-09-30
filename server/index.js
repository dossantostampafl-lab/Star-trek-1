'use strict';
/* server/index.js — servidor da estação: API HTTP + eventos em tempo real (SSE) + interface web.
   Escuta só em 127.0.0.1. Toda rota /api/* (menos /api/health) exige o token gerado a cada inicialização,
   enviado no cabeçalho x-st1-token — um site malicioso aberto no seu navegador não consegue lê-lo nem forjá-lo. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadEnv, getConfig, ROOT } = require('./config.js');
const { openDb } = require('./db.js');
const { makeConsentBroker } = require('./permissions.js');
const { makeCheckpoints } = require('./checkpoint.js');
const { makeStation } = require('./station.js');
const { makeScheduler, nextRun, describe } = require('./cron.js');
const { makeMcpManager } = require('./mcp.js');
const { dockerAvailable } = require('./tools/shell.js');
const { makeAuth } = require('./auth.js');
const crew = require('./crew.js');
const { makeJail } = require('./tools/fs.js');
const mcpCatalog = require('./mcp-catalog.js');
const missionsMod = require('./missions.js');
const { makeGrowth } = require('./growth.js');
const decor = require('./decor.js');

const WEB = path.join(ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const COLORS = ['#5ec8ff', '#ffb347', '#7dffa8', '#ff6b9a', '#c49bff', '#ffe066', '#6bf0e0', '#ff8f6b'];

function makeBus() {
  const clients = new Set();
  return {
    emit(ev) {
      const line = 'data: ' + JSON.stringify(Object.assign({ at: Date.now() }, ev)) + '\n\n';
      for (const res of clients) { try { res.write(line); } catch (_) { clients.delete(res); } }
    },
    add(res) { clients.add(res); res.on('close', () => clients.delete(res)); },
    count: () => clients.size
  };
}

async function start(overrides) {
  overrides = overrides || {};
  if (!overrides.config) loadEnv();
  const config = overrides.config || getConfig();
  const token = overrides.token || crypto.randomBytes(24).toString('hex');

  // ---- acesso pela internet: exige senha e só aceita o endereço público configurado
  let publicOrigin = '', publicHost = '';
  if (config.publicUrl) {
    let u;
    try { u = new URL(config.publicUrl); } catch (_) { throw new Error('PUBLIC_URL inválida: ' + config.publicUrl); }
    publicOrigin = u.origin; publicHost = u.hostname.toLowerCase();
    if (!config.accessPassword || config.accessPassword.length < 12) throw new Error('Com PUBLIC_URL definida, ACCESS_PASSWORD é obrigatória (mínimo 12 caracteres).');
  }
  const auth = makeAuth({ password: config.accessPassword, dataDir: config.dataDir, secure: publicOrigin.startsWith('https:') });
  const log = overrides.log || ((m) => console.log('  ' + m));
  const db = overrides.db || openDb(path.join(config.dataDir, 'star-trek-1.db'));
  db.failStaleRuns();
  const bus = makeBus();
  // Primeira vez (banco vazio): a tripulação pronta já embarca, com esteiras e agenda.
  if (config.seedCrew && !db.listAgents().length) {
    const r = crew.applyPreset(db);
    log('tripulação pronta: ' + r.created.join(', '));
  }
  decor.ensureLooks(db);   // bancos antigos: dá personagem e móveis a quem ainda não tem

  // ---- permissões: pedidos vão para a interface; sem interface aberta = negado
  const pendingConsent = new Map();
  const consent = makeConsentBroker({
    grants: db.grants,
    prompt: (req) => new Promise((resolve) => {
      if (!bus.count()) return resolve('deny');
      const id = crypto.randomBytes(8).toString('hex');
      pendingConsent.set(id, { resolve, req });
      bus.emit({ type: 'consent_request', id, agentId: req.agentId, agentName: req.agentName, tool: req.tool, args: req.call.args, choices: req.choices });
      setTimeout(() => { if (pendingConsent.has(id)) { pendingConsent.delete(id); bus.emit({ type: 'consent_closed', id }); resolve('deny'); } }, 5 * 60 * 1000).unref();
    })
  });

  const checkpoints = makeCheckpoints(path.join(config.dataDir, 'checkpoints'));
  const shellAvailable = overrides.shellAvailable != null ? overrides.shellAvailable : await dockerAvailable();
  let station = null;
  const mcp = makeMcpManager({ log, onChange: () => { if (station) station.invalidate(); bus.emit({ type: 'mcp_changed' }); } });
  const growth = makeGrowth({ db, bus, invalidate: () => station && station.invalidate() });
  station = makeStation({ config, db, bus, consent, checkpoints, shellAvailable, shellRunner: overrides.shellRunner, log, retries: overrides.retries, providerFor: overrides.providerFor, mcp,
    onRunEnd: growth.onRunEnd, onMissionDone: growth.onMissionDone, growthTools: (a) => [growth.beliefTool(a)], extraContext: growth.extraContext });
  const night = missionsMod.makeNightShift({ db, station, bus, log, tickMs: overrides.nightTickMs, now: overrides.now });
  const scheduler = makeScheduler({
    list: () => db.listSchedules(),
    update: (id, patch) => db.updateSchedule(id, patch),
    fire: (s) => { bus.emit({ type: 'schedule_fired', id: s.id, agentId: s.agent_id }); station.enqueue(s.agent_id, s.prompt, 'schedule', { scheduleId: s.id }); bus.emit({ type: 'state_changed' }); },
    log,
    tickMs: overrides.tickMs
  });

  // ---- HTTP
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
      else res.end();
    });
  });

  function sendJson(res, status, body) {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(s);
  }
  const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

  const MAX_UPLOAD = 25 * 1024 * 1024;
  async function readRaw(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_UPLOAD) throw httpErr(413, 'arquivo maior que 25 MB'); chunks.push(c); }
    return Buffer.concat(chunks);
  }
  const cleanName = (n) => String(n || '').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'arquivo';
  // scope = 'shared' (pasta da tripulação) ou o id de um tripulante
  function scopeJail(scope) {
    if (!scope || scope === 'shared') return makeJail(station.sharedDir());
    agentOr404(scope);
    return makeJail(station.workspaceOf(scope));
  }
  function listTree(jail) {
    const out = [];
    const walk = (dir, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= 500 || e.isSymbolicLink()) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 6) walk(abs, depth + 1); continue; }
        if (!e.isFile() || /\.tmp-\d+$/.test(e.name)) continue;
        const st = fs.statSync(abs);
        out.push({ path: jail.relOf(abs), size: st.size, mtime: st.mtime.toISOString() });
      }
    };
    walk(jail.root, 0);
    return out;
  }
  const DL_MIME = { '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.html': 'text/plain; charset=utf-8' };

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) { size += c.length; if (size > 1024 * 1024) throw httpErr(413, 'corpo grande demais'); chunks.push(c); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw httpErr(400, 'JSON inválido'); }
  }

  function hostOk(req) {
    const h = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || (!!publicHost && h === publicHost);
  }
  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    return /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o) || (!!publicOrigin && o === publicOrigin);
  }
  function tokenOk(req) {
    const t = String(req.headers['x-st1-token'] || '');
    return t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  }

  function state() {
    const agents = db.listAgents();
    return {
      agents: agents.map(a => Object.assign(a, { spent_usd: db.spentUsd(a.id) })),
      conveyors: db.listConveyors(),
      schedules: db.listSchedules().map(s => Object.assign(s, { info: describe(s.cron) })),
      status: station.status(),
      totals: db.totals(),
      mcp: { configured: db.listMcp().map(x => ({ id: x.id, name: x.name, transport: x.transport, command: x.command, url: x.url, enabled: x.enabled })), live: mcp.status() },
      grants: db.listGrants(),
      growth: growth.summary(),
      pendingBeliefs: db.listBeliefs().filter(b => b.status === 'proposta').length,
      shellAvailable,
      decor: { room: [decor.ROOM_W, decor.ROOM_H, decor.WALL_H], furniture: decor.FURNITURE, characters: decor.CHARACTERS },
      authEnabled: auth.enabled,
      provider: { name: config.provider.name, model: config.provider.model, fallback: config.fallback ? config.fallback.name : null }
    };
  }

  function visibleHistory(agentId) {
    const out = [];
    for (const m of db.getHistory(agentId)) {
      if (m.role === 'user') out.push({ role: 'user', text: m.content });
      else if (m.role === 'assistant') {
        if (m.tool_calls) for (const c of m.tool_calls) out.push({ role: 'tool', name: c.name, args: c.args });
        if (m.content) out.push({ role: 'assistant', text: m.content });
      }
    }
    return out;
  }

  const agentOr404 = (id) => { const a = db.getAgent(id); if (!a) throw httpErr(404, 'agente não encontrado'); return a; };

  function cleanAgent(b, partial) {
    const out = {};
    for (const k of ['name', 'role', 'instructions', 'provider', 'model', 'color']) if (b[k] !== undefined) out[k] = String(b[k]).slice(0, k === 'instructions' ? 4000 : 200);
    if (out.provider && !['freellmapi', 'anthropic', 'openai', ''].includes(out.provider)) throw httpErr(400, 'provedor inválido');
    if (b.room_x !== undefined) out.room_x = Math.max(0, Math.min(20, b.room_x | 0));
    if (b.room_y !== undefined) out.room_y = Math.max(0, Math.min(20, b.room_y | 0));
    if (b.budget_usd !== undefined) out.budget_usd = Math.max(0, Number(b.budget_usd) || 0);
    if (b.shell !== undefined) out.shell = !!b.shell;
    if (b.captain !== undefined) out.captain = !!b.captain;
    if (b.mcp !== undefined) out.mcp = Array.isArray(b.mcp) ? b.mcp.map(String).slice(0, 20) : [];
    try {
      if (b.sprite !== undefined && b.sprite !== '') out.sprite = decor.cleanSprite(b.sprite);
      if (b.props !== undefined) out.props = decor.cleanProps(b.props);
    } catch (e) { throw httpErr(400, e.message); }
    if (!partial && !out.name) throw httpErr(400, 'dê um nome ao agente');
    return out;
  }

  const freeRoom = () => crew.freeRoom(db);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    if (!hostOk(req)) return sendJson(res, 421, { error: 'host não permitido' });
    if (p === '/api/health') return sendJson(res, 200, { ok: true });

    // ---- login (só quando ACCESS_PASSWORD está definida)
    if (auth.enabled) {
      if (p === '/login' && req.method === 'GET') return serveFile(path.join(WEB, 'login.html'), res);
      if (p === '/login.js' && req.method === 'GET') return serveFile(path.join(WEB, 'login.js'), res);
      if (p === '/login' && req.method === 'POST') {
        if (!originOk(req)) return sendJson(res, 403, { error: 'origem não permitida' });
        const b = await readBody(req);
        const r = auth.login(req, String(b.password || ''));
        if (!r.ok) return sendJson(res, r.status, { error: r.error });
        res.setHeader('set-cookie', r.cookie);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/logout' && req.method === 'POST') {
        if (!originOk(req)) return sendJson(res, 403, { error: 'origem não permitida' });
        res.setHeader('set-cookie', auth.logoutCookie());
        return sendJson(res, 200, { ok: true });
      }
      if (!auth.isLoggedIn(req)) {
        if (p.startsWith('/api/')) return sendJson(res, 401, { error: 'faça login', login: true });
        res.writeHead(302, { location: '/login', 'cache-control': 'no-store' });
        return res.end();
      }
    }

    if (!p.startsWith('/api/')) return serveStatic(p, res);
    if (!originOk(req)) return sendJson(res, 403, { error: 'origem não permitida' });
    if (!tokenOk(req)) return sendJson(res, 401, { error: 'token inválido' });

    const m = req.method;
    const seg = p.split('/').filter(Boolean).slice(1);   // sem "api"

    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': conectado\n\n');
      bus.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      res.on('close', () => clearInterval(ping));
      for (const [id, pc] of pendingConsent) res.write('data: ' + JSON.stringify({ type: 'consent_request', id, agentId: pc.req.agentId, agentName: pc.req.agentName, tool: pc.req.tool, args: pc.req.call.args, choices: pc.req.choices }) + '\n\n');
      return;
    }
    if (p === '/api/state' && m === 'GET') return sendJson(res, 200, state());

    // ---- agentes
    if (seg[0] === 'agents') {
      if (seg.length === 1 && m === 'POST') {
        const b = await readBody(req);
        const data = Object.assign(freeRoom(), { color: COLORS[db.listAgents().length % COLORS.length] }, cleanAgent(b));
        const a = db.createAgent(data);
        bus.emit({ type: 'state_changed' });
        return sendJson(res, 201, a);
      }
      const a = agentOr404(seg[1]);
      if (seg.length === 2 && m === 'PATCH') {
        const raw = await readBody(req);
        const b = cleanAgent(raw, true);
        if (raw.reset_look) Object.assign(b, decor.defaultLook(a));   // "↺ padrão" no editor
        // mover sala: se o lugar já tem alguém, os dois trocam de lugar
        if (b.room_x !== undefined || b.room_y !== undefined) {
          const nx = b.room_x !== undefined ? b.room_x : a.room_x, ny = b.room_y !== undefined ? b.room_y : a.room_y;
          const other = db.listAgents().find(o => o.id !== a.id && o.room_x === nx && o.room_y === ny);
          if (other) db.updateAgent(other.id, { room_x: a.room_x, room_y: a.room_y });
        }
        const upd = db.updateAgent(a.id, b);
        station.invalidate(a.id);
        bus.emit({ type: 'state_changed' });
        return sendJson(res, 200, upd);
      }
      if (seg.length === 2 && m === 'DELETE') { station.cancel(a.id); db.deleteAgent(a.id); station.invalidate(); bus.emit({ type: 'state_changed' }); return sendJson(res, 200, { ok: true }); }
      if (seg[2] === 'history' && m === 'GET') return sendJson(res, 200, visibleHistory(a.id));
      if (seg[2] === 'message' && m === 'POST') {
        const b = await readBody(req);
        const text = String(b.text || '').trim();
        if (!text) throw httpErr(400, 'mensagem vazia');
        return sendJson(res, 202, { runId: station.enqueue(a.id, text.slice(0, 20000), 'chat') });
      }
      if (seg[2] === 'cancel' && m === 'POST') { station.cancel(a.id); return sendJson(res, 200, { ok: true }); }
      if (seg[2] === 'reset' && m === 'POST') { station.reset(a.id); bus.emit({ type: 'history_reset', agentId: a.id }); return sendJson(res, 200, { ok: true }); }
      if (seg[2] === 'checkpoints' && seg.length === 3 && m === 'GET') return sendJson(res, 200, checkpoints.list(a.id));
      if (seg[2] === 'checkpoints' && seg[4] === 'restore' && m === 'POST') {
        if (station.status()[a.id] && station.status()[a.id].busy) throw httpErr(409, 'o agente está trabalhando — cancele antes de restaurar');
        return sendJson(res, 200, checkpoints.restore(a.id, seg[3], station.workspaceOf(a.id)));
      }
      throw httpErr(404, 'rota não encontrada');
    }

    if (p === '/api/runs' && m === 'GET') return sendJson(res, 200, db.listRuns(url.searchParams.get('agent'), Math.min(200, Number(url.searchParams.get('limit')) || 50)));

    // ---- missões
    if (seg[0] === 'missions') {
      if (seg.length === 1 && m === 'GET') return sendJson(res, 200, db.listMissions());
      if (seg.length === 1 && m === 'POST') {
        const b = await readBody(req);
        const title = String(b.title || '').trim();
        if (!title) throw httpErr(400, 'dê um título à missão');
        const steps = (Array.isArray(b.steps) ? b.steps : String(b.steps || '').split('\n')).map(x => String(x).trim()).filter(Boolean);
        const mission = db.createMission({ title, goal: String(b.goal || ''), steps });
        bus.emit({ type: 'missions_changed' });
        let runId = null;
        const cap = db.listAgents().find(a => a.captain);
        if (b.dispatch !== false && cap) {
          runId = station.enqueue(cap.id, 'Nova missão do comandante: M' + mission.num + ' — ' + title + (b.goal ? '\nObjetivo: ' + b.goal : '') +
            (steps.length ? '\nEtapas sugeridas:\n' + steps.map((x, i) => (i + 1) + '. ' + x).join('\n') : '\nAinda sem etapas: divida em etapas com mission_update (add_step).') +
            '\nComece agora: delegue a primeira etapa e registre o progresso com mission_update.', 'chat');
        }
        return sendJson(res, 201, { mission, runId });
      }
      const mi = db.getMission(seg[1]);
      if (!mi) throw httpErr(404, 'missão não encontrada');
      if (seg.length === 2 && m === 'PATCH') {
        const b = await readBody(req);
        if (b.status) { if (!missionsMod.STATUS.includes(b.status)) throw httpErr(400, 'status inválido'); mi.status = b.status; }
        if (b.title) mi.title = String(b.title).slice(0, 120);
        if (b.goal != null) mi.goal = String(b.goal).slice(0, 2000);
        if (b.toggleStep != null) { const st = mi.steps.find(x => x.id === Number(b.toggleStep)); if (st) { st.done = !st.done; st.agent = 'Comandante'; } }
        if (b.addStep) mi.steps.push({ id: mi.steps.reduce((x, st) => Math.max(x, st.id), 0) + 1, text: String(b.addStep).slice(0, 300), done: false, agent: '', note: '' });
        mi.log.push({ at: new Date().toISOString(), agent: 'Comandante', text: [b.status && 'status: ' + b.status, b.toggleStep != null && 'etapa ' + b.toggleStep, b.addStep && '+ etapa: ' + b.addStep].filter(Boolean).join(' · ') || 'editou' });
        const saved = db.saveMission(mi);
        bus.emit({ type: 'missions_changed' });
        return sendJson(res, 200, saved);
      }
      if (seg.length === 2 && m === 'DELETE') { db.deleteMission(mi.id); bus.emit({ type: 'missions_changed' }); return sendJson(res, 200, { ok: true }); }
    }

    // ---- turno da noite e relatórios
    if (p === '/api/night' && m === 'GET') return sendJson(res, 200, missionsMod.nightSettings(db));
    if (p === '/api/night' && m === 'PUT') {
      try { return sendJson(res, 200, missionsMod.saveNightSettings(db, await readBody(req))); }
      catch (e) { throw httpErr(400, e.message); }
    }
    if (p === '/api/night/run' && m === 'POST') {
      const r = night.fire('manual');
      if (!r.ok) throw httpErr(400, r.reason);
      return sendJson(res, 202, r);
    }
    if (p === '/api/night/report' && m === 'POST') {
      const since = db.getSetting('night_active_since', '') || null;
      return sendJson(res, 201, night.morningReport(since));
    }
    if (p === '/api/reports' && m === 'GET') return sendJson(res, 200, db.listReports(20));

    // ---- crescimento: dossiê, avaliações
    if (p === '/api/beliefs' && m === 'GET') return sendJson(res, 200, db.listBeliefs());
    if (p === '/api/beliefs' && m === 'POST') {
      const b = await readBody(req);
      const id = db.addBelief({ text: b.text, status: 'aceita' });
      station.invalidate(); bus.emit({ type: 'state_changed' });
      return sendJson(res, 201, { id });
    }
    if (seg[0] === 'beliefs' && seg.length === 2 && m === 'PATCH') {
      const b = await readBody(req);
      if (!['aceita', 'rejeitada', 'proposta'].includes(b.status)) throw httpErr(400, 'status inválido');
      try { growth.setBelief(seg[1], b.status); } catch (e) { throw httpErr(404, e.message); }
      return sendJson(res, 200, { ok: true });
    }
    if (seg[0] === 'beliefs' && seg.length === 2 && m === 'DELETE') { db.deleteBelief(seg[1]); station.invalidate(); bus.emit({ type: 'state_changed' }); return sendJson(res, 200, { ok: true }); }
    if (seg[0] === 'runs' && seg[2] === 'rate' && m === 'POST') {
      const b = await readBody(req);
      try { return sendJson(res, 200, growth.rate(seg[1], Number(b.rating) || 0)); } catch (e) { throw httpErr(404, e.message); }
    }

    // ---- tripulação pronta
    if (p === '/api/crew/preset' && m === 'POST') {
      const r = crew.applyPreset(db);
      station.invalidate();
      bus.emit({ type: 'state_changed' });
      return sendJson(res, 200, r);
    }

    // ---- esteiras
    if (seg[0] === 'conveyors') {
      if (seg.length === 1 && m === 'POST') {
        const b = await readBody(req);
        agentOr404(b.from_agent); agentOr404(b.to_agent);
        let c;
        try { c = db.createConveyor({ from_agent: b.from_agent, to_agent: b.to_agent, auto: b.auto !== false, note: String(b.note || '').slice(0, 200) }); }
        catch (e) { throw httpErr(400, /UNIQUE/.test(e.message) ? 'essa esteira já existe' : e.message); }
        station.invalidate(b.from_agent);
        bus.emit({ type: 'state_changed' });
        return sendJson(res, 201, c);
      }
      if (seg.length === 2 && m === 'DELETE') { db.deleteConveyor(seg[1]); station.invalidate(); bus.emit({ type: 'state_changed' }); return sendJson(res, 200, { ok: true }); }
    }

    // ---- agendamentos
    if (seg[0] === 'schedules') {
      if (seg.length === 1 && m === 'POST') {
        const b = await readBody(req);
        agentOr404(b.agent_id);
        let next;
        try { next = nextRun(String(b.cron || ''), new Date()); } catch (e) { throw httpErr(400, 'cron inválido: ' + e.message); }
        if (!String(b.prompt || '').trim()) throw httpErr(400, 'escreva a tarefa do agendamento');
        const s = db.createSchedule({ agent_id: b.agent_id, cron: String(b.cron).trim(), prompt: String(b.prompt).slice(0, 4000), next_run: next && next.toISOString() });
        bus.emit({ type: 'state_changed' });
        return sendJson(res, 201, s);
      }
      if (seg.length === 2 && m === 'PATCH') {
        const b = await readBody(req);
        const patch = {};
        if (b.enabled !== undefined) patch.enabled = !!b.enabled;
        if (b.prompt !== undefined) patch.prompt = String(b.prompt).slice(0, 4000);
        if (b.cron !== undefined) {
          try { const n = nextRun(String(b.cron), new Date()); patch.cron = String(b.cron).trim(); patch.next_run = n && n.toISOString(); }
          catch (e) { throw httpErr(400, 'cron inválido: ' + e.message); }
        }
        const s = db.updateSchedule(seg[1], patch);
        bus.emit({ type: 'state_changed' });
        return sendJson(res, 200, s);
      }
      if (seg.length === 2 && m === 'DELETE') { db.deleteSchedule(seg[1]); bus.emit({ type: 'state_changed' }); return sendJson(res, 200, { ok: true }); }
      if (seg[2] === 'run' && m === 'POST') {
        const s = db.listSchedules().find(x => x.id === seg[1]);
        if (!s) throw httpErr(404, 'agendamento não encontrado');
        return sendJson(res, 202, { runId: station.enqueue(s.agent_id, s.prompt, 'schedule', { scheduleId: s.id }) });
      }
    }

    // ---- conectores MCP
    if (seg[0] === 'mcp') {
      if (seg[1] === 'catalog' && m === 'GET') return sendJson(res, 200, mcpCatalog.publicCatalog(db.listMcp().map(x => x.name)));
      if (seg[1] === 'install' && m === 'POST') {
        const b = await readBody(req);
        let built;
        try { built = mcpCatalog.buildServer(String(b.id || ''), b.values, { dataDir: config.dataDir }); }
        catch (e) { throw httpErr(400, e.message); }
        const old = db.listMcp().find(x => x.name === built.row.name);
        if (old) { await mcp.disconnect(old.name); db.deleteMcp(old.id); }   // reinstalar = trocar a chave
        const row = db.createMcp(built.row);
        // liga nos tripulantes indicados (ou nos padrões do catálogo que existirem)
        const names = Array.isArray(b.crew) ? b.crew.map(String) : built.entry.crew;
        const assigned = [];
        for (const a of db.listAgents()) {
          if (!names.some(n => n === a.id || n.toLowerCase() === a.name.toLowerCase())) continue;
          if (!(a.mcp || []).includes(row.name)) db.updateAgent(a.id, { mcp: (a.mcp || []).concat(row.name) });
          // conectores só-leitura: liberar sem perguntar, se o comandante marcou
          if (b.autoGrant !== false && built.entry.safe) db.grants.add(a.id, 'mcp:' + row.name);
          assigned.push(a.name);
        }
        const st = await mcp.connect(row);
        station.invalidate();
        bus.emit({ type: 'state_changed' });
        return sendJson(res, 201, { server: { id: row.id, name: row.name }, status: st, assigned });
      }
      if (seg.length === 1 && m === 'POST') {
        const b = await readBody(req);
        let row;
        try {
          row = db.createMcp({
            name: String(b.name || '').trim(), transport: b.transport, command: String(b.command || ''),
            args: Array.isArray(b.args) ? b.args.map(String) : String(b.args || '').split(/\s+/).filter(Boolean),
            env: b.env && typeof b.env === 'object' ? b.env : {}, url: String(b.url || ''), headers: b.headers && typeof b.headers === 'object' ? b.headers : {}
          });
        } catch (e) { throw httpErr(400, /UNIQUE/.test(e.message) ? 'já existe um conector com esse nome' : e.message); }
        const st = await mcp.connect(row);
        return sendJson(res, 201, { server: row, status: st });
      }
      const row = db.listMcp().find(x => x.id === seg[1]);
      if (!row) throw httpErr(404, 'conector não encontrado');
      if (seg.length === 2 && m === 'DELETE') { await mcp.disconnect(row.name); db.deleteMcp(row.id); station.invalidate(); bus.emit({ type: 'mcp_changed' }); return sendJson(res, 200, { ok: true }); }
      if (seg[2] === 'reconnect' && m === 'POST') return sendJson(res, 200, await mcp.connect(row));
    }

    // ---- arquivos: enviar, listar, baixar, apagar
    if (seg[0] === 'files') {
      const jail0 = scopeJail(url.searchParams.get('scope'));
      const jail = Object.assign({}, jail0, { resolve: (p) => { try { return jail0.resolve(p); } catch (e) { throw httpErr(400, e.message); } } });
      if (seg.length === 1 && m === 'GET') return sendJson(res, 200, listTree(jail));
      if (seg[1] === 'upload' && m === 'POST') {
        const name = cleanName(url.searchParams.get('name'));
        const buf = await readRaw(req);
        if (!buf.length) throw httpErr(400, 'arquivo vazio');
        let rel = 'entrada/' + name;
        const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
        for (let i = 2; fs.existsSync(jail.resolve(rel)) && i < 1000; i++) rel = 'entrada/' + base + ' (' + i + ')' + ext;
        const abs = jail.resolve(rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        bus.emit({ type: 'files_changed', scope: url.searchParams.get('scope') || 'shared' });
        return sendJson(res, 201, { path: rel, size: buf.length });
      }
      if (seg[1] === 'download' && m === 'GET') {
        const abs = jail.resolve(url.searchParams.get('path'));
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpErr(404, 'arquivo não encontrado');
        res.writeHead(200, {
          'content-type': DL_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
          'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(abs)),
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
        });
        return fs.createReadStream(abs).pipe(res);
      }
      if (seg.length === 1 && m === 'DELETE') {
        const abs = jail.resolve(url.searchParams.get('path'));
        if (abs === jail.root || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpErr(404, 'arquivo não encontrado');
        fs.unlinkSync(abs);
        bus.emit({ type: 'files_changed' });
        return sendJson(res, 200, { ok: true });
      }
    }

    // ---- permissões
    if (p === '/api/consent' && m === 'POST') {
      const b = await readBody(req);
      const pc = pendingConsent.get(b.id);
      if (!pc) throw httpErr(404, 'pedido não encontrado (já respondido ou expirado)');
      pendingConsent.delete(b.id);
      pc.resolve(pc.req.choices.includes(b.decision) ? b.decision : 'deny');
      bus.emit({ type: 'consent_closed', id: b.id });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/grants' && m === 'DELETE') {
      const b = await readBody(req);
      db.revokeGrant(String(b.agent_id), String(b.key));
      bus.emit({ type: 'state_changed' });
      return sendJson(res, 200, { ok: true });
    }

    throw httpErr(404, 'rota não encontrada');
  }

  function serveStatic(p, res) {
    let rel;
    try { rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, ''); } catch (_) { rel = ''; }
    const file = path.resolve(WEB, rel);
    if (!rel || !file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('não encontrado');
    }
    return serveFile(file, res);
  }

  function serveFile(file, res) {
    const rel = path.basename(file);
    const headers = {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': file.includes(path.sep + 'assets' + path.sep) ? 'public, max-age=86400' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'referrer-policy': 'no-referrer'
    };
    if (rel === 'index.html') {
      const html = fs.readFileSync(file, 'utf8').replace('__ST1_TOKEN__', token);
      res.writeHead(200, headers);
      return res.end(html);
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }

  // conecta os MCP salvos
  for (const row of db.listMcp()) if (row.enabled) mcp.connect(row);

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(overrides.port != null ? overrides.port : config.port, overrides.host || config.host, resolve); });
  scheduler.start();
  night.start();
  const url = 'http://127.0.0.1:' + server.address().port;
  return {
    url, token, db, station, mcp, bus,
    async close() { scheduler.stop(); night.stop(); await mcp.closeAll(); for (const a of db.listAgents()) station.cancel(a.id); await new Promise(r => server.close(r)); server.closeAllConnections && server.closeAllConnections(); if (!overrides.db) db.close(); }
  };
}

if (require.main === module) {
  start().then(({ url }) => {
    console.log('\n  ★ Star Trek 1 — estação no ar');
    console.log('  Abra: ' + url + '\n');
  }).catch((e) => {
    if (e.code === 'EADDRINUSE') console.error('  A porta já está em uso. Feche a outra estação ou mude PORT no .env.');
    else console.error(e);
    process.exit(1);
  });
}

module.exports = { start };
