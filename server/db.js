'use strict';
/* server/db.js — banco SQLite embutido no Node (node:sqlite). Um arquivo: data/star-trek-1.db.
   Tabelas: agentes, conversas (mensagens por agente), execuções, esteiras, agendamentos,
   permissões "sempre" e conectores MCP. */
const fs = require('node:fs');
const path = require('node:path');

// node:sqlite ainda imprime um aviso "experimental" — silencia só esse aviso.
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite is an experimental feature/.test(msg)) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
const decor = require('./decor.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT DEFAULT '', instructions TEXT DEFAULT '',
  provider TEXT DEFAULT '', model TEXT DEFAULT '', color TEXT DEFAULT '#5ec8ff',
  room_x INTEGER DEFAULT 0, room_y INTEGER DEFAULT 0,
  budget_usd REAL DEFAULT 0, shell INTEGER DEFAULT 0, mcp TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, seq);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source TEXT NOT NULL, input TEXT NOT NULL,
  output TEXT DEFAULT '', status TEXT NOT NULL, error TEXT DEFAULT '',
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
  provider TEXT DEFAULT '', model TEXT DEFAULT '', steps INTEGER DEFAULT 0,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, started_at);
CREATE TABLE IF NOT EXISTS conveyors (
  id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
  auto INTEGER DEFAULT 1, note TEXT DEFAULT '', created_at TEXT NOT NULL,
  UNIQUE(from_agent, to_agent)
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, cron TEXT NOT NULL, prompt TEXT NOT NULL,
  enabled INTEGER DEFAULT 1, last_run TEXT, next_run TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  agent_id TEXT NOT NULL, key TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(agent_id, key)
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, num INTEGER NOT NULL, title TEXT NOT NULL, goal TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'ativa',
  owner TEXT DEFAULT '', steps TEXT DEFAULT '[]', log TEXT DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS beliefs (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, agent_id TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'proposta', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trophies (
  agent_id TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(agent_id, key)
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
  command TEXT DEFAULT '', args TEXT DEFAULT '[]', env TEXT DEFAULT '{}',
  url TEXT DEFAULT '', headers TEXT DEFAULT '{}', enabled INTEGER DEFAULT 1, created_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();
let idSeq = 0;
const newId = (p) => p + '_' + Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 6);

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // migração: coluna "captain" (versões antigas do banco não têm)
  const addCol = (table, col, def) => { if (!db.prepare('PRAGMA table_info(' + table + ')').all().some(c => c.name === col)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def); };
  addCol('agents', 'captain', 'INTEGER DEFAULT 0');
  addCol('agents', 'xp', 'INTEGER DEFAULT 0');
  addCol('agents', 'trust', 'INTEGER DEFAULT 50');
  addCol('agents', 'props', "TEXT DEFAULT '[]'");
  addCol('agents', 'sprite', "TEXT DEFAULT ''");
  addCol('runs', 'rating', 'INTEGER DEFAULT 0');

  const q = (sql) => db.prepare(sql);
  const json = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };
  const plain = (r) => r ? Object.assign({}, r) : null;
  const agentRow = (r) => r && Object.assign(plain(r), { shell: !!r.shell, captain: !!r.captain, mcp: json(r.mcp, []), props: json(r.props, []) });

  const missionRow = (r) => r && Object.assign(plain(r), { steps: json(r.steps, []), log: json(r.log, []) });
  const AGENT_FIELDS = ['name', 'role', 'instructions', 'provider', 'model', 'color', 'room_x', 'room_y', 'budget_usd', 'shell', 'captain', 'mcp', 'xp', 'trust', 'props', 'sprite'];

  const api = {
    raw: db,

    // ---- agentes
    listAgents: () => q('SELECT * FROM agents ORDER BY created_at').all().map(agentRow),
    getAgent: (id) => agentRow(q('SELECT * FROM agents WHERE id = ?').get(id)),
    createAgent(a) {
      const id = a.id || newId('ag');
      q(`INSERT INTO agents (id, name, role, instructions, provider, model, color, room_x, room_y, budget_usd, shell, captain, mcp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, String(a.name || 'Tripulante').slice(0, 40), a.role || '', a.instructions || '', a.provider || '', a.model || '',
        a.color || '#5ec8ff', a.room_x | 0, a.room_y | 0, Number(a.budget_usd) || 0, a.shell ? 1 : 0, a.captain ? 1 : 0, JSON.stringify(a.mcp || []), now());
      // aparência: personagem e móveis padrão pelo tipo de tripulante (o comandante troca no editor)
      const look = decor.defaultLook(Object.assign({ id }, a));
      return api.updateAgent(id, { sprite: a.sprite || look.sprite, props: Array.isArray(a.props) ? a.props : look.props });
    },
    updateAgent(id, patch) {
      const sets = [], vals = [];
      for (const k of AGENT_FIELDS) if (patch[k] !== undefined) {
        sets.push(k + ' = ?');
        vals.push((k === 'shell' || k === 'captain') ? (patch[k] ? 1 : 0) : (k === 'mcp' || k === 'props') ? JSON.stringify(patch[k] || []) : k === 'name' ? String(patch[k]).slice(0, 40) : patch[k]);
      }
      if (sets.length) q('UPDATE agents SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, id);
      return api.getAgent(id);
    },
    deleteAgent(id) {
      for (const t of ['messages', 'runs', 'schedules', 'grants', 'trophies']) q('DELETE FROM ' + t + ' WHERE agent_id = ?').run(id);
      q('DELETE FROM conveyors WHERE from_agent = ? OR to_agent = ?').run(id, id);
      q('DELETE FROM agents WHERE id = ?').run(id);
    },

    // ---- conversa (histórico sem a mensagem de sistema)
    getHistory: (agentId) => q('SELECT data FROM messages WHERE agent_id = ? ORDER BY seq').all(agentId).map(r => JSON.parse(r.data)),
    saveHistory(agentId, msgs) {
      db.exec('BEGIN');
      try {
        q('DELETE FROM messages WHERE agent_id = ?').run(agentId);
        const ins = q('INSERT INTO messages (agent_id, seq, data) VALUES (?, ?, ?)');
        msgs.forEach((m, i) => ins.run(agentId, i, JSON.stringify(m)));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    // ---- execuções
    startRun(r) {
      const id = newId('run');
      q('INSERT INTO runs (id, agent_id, source, input, status, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, r.agent_id, r.source, String(r.input).slice(0, 20000), 'running', now());
      return id;
    },
    finishRun(id, f) {
      q(`UPDATE runs SET status = ?, output = ?, error = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, provider = ?, model = ?, steps = ?, ended_at = ? WHERE id = ?`)
        .run(f.status, String(f.output || '').slice(0, 50000), f.error || '', f.tokens_in | 0, f.tokens_out | 0, Number(f.cost_usd) || 0, f.provider || '', f.model || '', f.steps | 0, now(), id);
    },
    listRuns: (agentId, limit) => (agentId
      ? q('SELECT * FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?').all(agentId, limit || 50)
      : q('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit || 50)).map(plain),
    spentUsd: (agentId) => (q('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE agent_id = ?').get(agentId) || {}).s || 0,
    totals: () => plain(q('SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out, COALESCE(SUM(cost_usd),0) AS cost_usd FROM runs').get()),
    failStaleRuns: () => q("UPDATE runs SET status = 'error', error = 'interrompida (servidor reiniciado)', ended_at = ? WHERE status = 'running'").run(now()),

    // ---- esteiras
    listConveyors: () => q('SELECT * FROM conveyors ORDER BY created_at').all().map(r => Object.assign(plain(r), { auto: !!r.auto })),
    conveyorsFrom: (agentId) => q('SELECT * FROM conveyors WHERE from_agent = ?').all(agentId).map(r => Object.assign(plain(r), { auto: !!r.auto })),
    createConveyor(c) {
      if (c.from_agent === c.to_agent) throw new Error('a esteira precisa ligar dois agentes diferentes');
      const id = newId('cv');
      q('INSERT INTO conveyors (id, from_agent, to_agent, auto, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, c.from_agent, c.to_agent, c.auto === false ? 0 : 1, c.note || '', now());
      return plain(q('SELECT * FROM conveyors WHERE id = ?').get(id));
    },
    deleteConveyor: (id) => q('DELETE FROM conveyors WHERE id = ?').run(id),

    // ---- agendamentos
    listSchedules: () => q('SELECT * FROM schedules ORDER BY created_at').all().map(r => Object.assign(plain(r), { enabled: !!r.enabled })),
    createSchedule(s) {
      const id = newId('sch');
      q('INSERT INTO schedules (id, agent_id, cron, prompt, enabled, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, s.agent_id, s.cron, s.prompt, s.enabled === false ? 0 : 1, s.next_run || null, now());
      return plain(q('SELECT * FROM schedules WHERE id = ?').get(id));
    },
    updateSchedule(id, patch) {
      const sets = [], vals = [];
      for (const k of ['cron', 'prompt', 'enabled', 'last_run', 'next_run']) if (patch[k] !== undefined) { sets.push(k + ' = ?'); vals.push(k === 'enabled' ? (patch[k] ? 1 : 0) : patch[k]); }
      if (sets.length) q('UPDATE schedules SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, id);
      return plain(q('SELECT * FROM schedules WHERE id = ?').get(id));
    },
    deleteSchedule: (id) => q('DELETE FROM schedules WHERE id = ?').run(id),

    // ---- permissões "sempre"
    grants: {
      has: (agentId, key) => !!q('SELECT 1 FROM grants WHERE agent_id = ? AND key = ?').get(agentId, key),
      add: (agentId, key) => { q('INSERT OR IGNORE INTO grants (agent_id, key, created_at) VALUES (?, ?, ?)').run(agentId, key, now()); }
    },
    listGrants: () => q('SELECT * FROM grants ORDER BY created_at').all().map(plain),
    revokeGrant: (agentId, key) => q('DELETE FROM grants WHERE agent_id = ? AND key = ?').run(agentId, key),

    // ---- conectores MCP
    listMcp: () => q('SELECT * FROM mcp_servers ORDER BY created_at').all().map(r => Object.assign(plain(r), { args: json(r.args, []), env: json(r.env, {}), headers: json(r.headers, {}), enabled: !!r.enabled })),
    createMcp(m) {
      if (!/^[a-z0-9_-]{1,32}$/.test(m.name || '')) throw new Error('nome do conector: só minúsculas, números, _ e - (até 32)');
      if (m.transport !== 'stdio' && m.transport !== 'http') throw new Error('transporte deve ser stdio ou http');
      const id = newId('mcp');
      q('INSERT INTO mcp_servers (id, name, transport, command, args, env, url, headers, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, m.name, m.transport, m.command || '', JSON.stringify(m.args || []), JSON.stringify(m.env || {}), m.url || '', JSON.stringify(m.headers || {}), m.enabled === false ? 0 : 1, now());
      return api.listMcp().find(x => x.id === id);
    },
    deleteMcp: (id) => q('DELETE FROM mcp_servers WHERE id = ?').run(id),

    // ---- missões
    listMissions: () => q('SELECT * FROM missions ORDER BY num').all().map(missionRow),
    getMission: (id) => missionRow(q('SELECT * FROM missions WHERE id = ? OR num = ?').get(id, Number(String(id).replace(/^m/i, '')) || -1)),
    createMission(m) {
      const id = newId('mis');
      const num = ((q('SELECT MAX(num) AS n FROM missions').get() || {}).n || 0) + 1;
      const steps = (m.steps || []).map((t, i) => ({ id: i + 1, text: String(t).slice(0, 300), done: false, agent: '', note: '' })).slice(0, 30);
      q('INSERT INTO missions (id, num, title, goal, status, owner, steps, log, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, num, String(m.title).slice(0, 120), String(m.goal || '').slice(0, 2000), 'ativa', m.owner || '', JSON.stringify(steps), '[]', now(), now());
      return api.getMission(id);
    },
    saveMission(m) {
      q('UPDATE missions SET title = ?, goal = ?, status = ?, owner = ?, steps = ?, log = ?, updated_at = ?, completed_at = ? WHERE id = ?')
        .run(m.title, m.goal, m.status, m.owner || '', JSON.stringify(m.steps || []), JSON.stringify((m.log || []).slice(-200)), now(), m.status === 'concluida' ? (m.completed_at || now()) : null, m.id);
      return api.getMission(m.id);
    },
    deleteMission: (id) => q('DELETE FROM missions WHERE id = ?').run(id),

    // ---- configurações (chave/valor)
    getSetting: (k, d) => { const r = q('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : d; },
    setSetting: (k, v) => q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v == null ? null : String(v)),

    // ---- relatórios
    addReport(r) { const id = newId('rep'); q('INSERT INTO reports (id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, r.kind, r.title, r.body, now()); return id; },
    listReports: (limit) => q('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(limit || 20).map(plain),
    runsSince: (iso) => q('SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at').all(iso).map(plain),

    // ---- crenças sobre o comandante (dossiê)
    listBeliefs: () => q('SELECT * FROM beliefs ORDER BY created_at DESC').all().map(plain),
    addBelief(b) {
      const text = String(b.text || '').trim().slice(0, 300);
      if (!text) throw new Error('crença vazia');
      const dup = q("SELECT id FROM beliefs WHERE lower(text) = lower(?) AND status != 'rejeitada'").get(text);
      if (dup) return null;
      const id = newId('bel');
      q('INSERT INTO beliefs (id, text, agent_id, status, created_at) VALUES (?, ?, ?, ?, ?)').run(id, text, b.agent_id || '', b.status || 'proposta', now());
      return id;
    },
    setBelief: (id, status) => q('UPDATE beliefs SET status = ? WHERE id = ?').run(status, id),
    deleteBelief: (id) => q('DELETE FROM beliefs WHERE id = ?').run(id),

    // ---- troféus e avaliações
    addTrophy: (agentId, key) => q('INSERT OR IGNORE INTO trophies (agent_id, key, at) VALUES (?, ?, ?)').run(agentId, key, now()).changes > 0,
    listTrophies: () => q('SELECT * FROM trophies ORDER BY at').all().map(plain),
    getRun: (id) => plain(q('SELECT * FROM runs WHERE id = ?').get(id)),
    rateRun: (id, rating) => q('UPDATE runs SET rating = ? WHERE id = ?').run(rating, id),
    countRuns: (agentId, status) => (q('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = ?').get(agentId, status) || {}).n || 0,

    close: () => db.close()
  };
  return api;
}

module.exports = { openDb, newId };
