'use strict';
/* server/jobs.js — agenda além do horário fixo:
   - REPETIR ATÉ TERMINAR ("loop"): manda a mesma tarefa ao tripulante a cada N minutos, uma rodada por vez,
     até ele responder com a linha CONCLUÍDO (ou bater o limite de rodadas). Ex.: "vá traduzindo o livro,
     um capítulo por rodada".
   - VIGIAR SITE ("watch"): baixa a página a cada N minutos e compara com a última vez. Se mudou (ou, com
     palavra-chave, se mudou o trecho em volta dela), avisa no painel e nos canais — e, se houver tarefa,
     manda para o tripulante com o que mudou. Ex.: "avise quando o preço mudar", "quando abrir inscrição".
   Rodam sozinhas (superfície automática): nunca usam terminal. */
const crypto = require('node:crypto');
const { assertPublicHost, htmlToText } = require('./tools/basic.js');

const DONE_RE = /(^|\n)\s*\**\s*CONCLU[IÍ]DO\s*\**\s*\.?\s*$/i;
const MIN_INTERVAL = { loop: 5, watch: 10 };
const MAX_JOBS = 30;

function excerptFor(text, keyword) {
  if (!keyword) return text;
  const k = keyword.toLowerCase();
  const lines = text.split('\n');
  const keep = new Set();
  lines.forEach((l, i) => { if (l.toLowerCase().includes(k)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) keep.add(j); });
  return [...keep].sort((a, b) => a - b).map(i => lines[i]).join('\n');
}
function diffLines(before, after) {
  const old = new Set(String(before || '').split('\n').map(s => s.trim()).filter(Boolean));
  return String(after || '').split('\n').map(s => s.trim()).filter(s => s && !old.has(s)).slice(0, 15);
}

function makeJobs(deps) {
  const { db, bus, station } = deps;
  const log = deps.log || (() => {});
  const nowFn = deps.now || (() => new Date());
  const fetchPage = deps.fetchPage || defaultFetch;
  const raw = db.raw;
  raw.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent_id TEXT, title TEXT NOT NULL, prompt TEXT DEFAULT '', url TEXT DEFAULT '',
    keyword TEXT DEFAULT '', interval_min INTEGER NOT NULL, max_runs INTEGER DEFAULT 20, runs INTEGER DEFAULT 0,
    status TEXT DEFAULT 'ativo', last_run_id TEXT, last_hash TEXT, last_excerpt TEXT, last_check TEXT, last_change TEXT,
    last_error TEXT DEFAULT '', errors INTEGER DEFAULT 0, result TEXT DEFAULT '', created_at TEXT)`);
  const get = (id) => raw.prepare('SELECT * FROM jobs WHERE id = ?').get(String(id)) || null;
  const list = () => raw.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  const set = (id, patch) => {
    const keys = Object.keys(patch);
    raw.prepare('UPDATE jobs SET ' + keys.map(k => k + ' = ?').join(', ') + ' WHERE id = ?').run(...keys.map(k => patch[k]), id);
  };
  let seq = 0;

  async function defaultFetch(url) {
    let u = new URL(url);
    let res;
    for (let hop = 0; ; hop++) {
      await assertPublicHost(u.hostname);
      res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Mozilla/5.0 (StarTrek1 vigia)' } });
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) break;
      if (hop >= 5) throw new Error('redirecionamentos demais');
      u = new URL(loc, u);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = (await res.text()).slice(0, 2000000);
    return /html/i.test(res.headers.get('content-type') || '') ? htmlToText(body) : body;
  }

  function create(b) {
    const kind = b.kind === 'watch' ? 'watch' : b.kind === 'loop' ? 'loop' : null;
    if (!kind) throw new Error('tipo inválido (loop ou watch)');
    if (list().length >= MAX_JOBS) throw new Error('limite de ' + MAX_JOBS + ' tarefas contínuas');
    const interval = Math.max(MIN_INTERVAL[kind], Math.min(24 * 60, Math.round(Number(b.interval_min) || (kind === 'loop' ? 15 : 60))));
    const prompt = String(b.prompt || '').trim().slice(0, 4000);
    let agent = b.agent_id ? db.getAgent(b.agent_id) : null;
    let url = '';
    if (kind === 'loop') {
      if (!agent) throw new Error('escolha o tripulante');
      if (!prompt) throw new Error('escreva a tarefa');
    } else {
      try { const u = new URL(String(b.url || '').trim()); if (!/^https?:$/.test(u.protocol)) throw new Error(); url = u.href; } catch (_) { throw new Error('endereço (URL) inválido'); }
      if (prompt && !agent) throw new Error('escolha quem recebe a tarefa quando o site mudar');
    }
    const id = 'j' + Date.now().toString(36) + (seq++).toString(36);
    const title = String(b.title || '').trim().slice(0, 100) || (kind === 'loop' ? prompt.slice(0, 60) : new URL(url).hostname + (b.keyword ? ' · ' + b.keyword : ''));
    raw.prepare('INSERT INTO jobs (id, kind, agent_id, title, prompt, url, keyword, interval_min, max_runs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, kind, agent ? agent.id : null, title, prompt, url, String(b.keyword || '').trim().slice(0, 100), interval,
        Math.max(1, Math.min(200, Number(b.max_runs) || 20)), nowFn().toISOString());
    bus.emit({ type: 'jobs_changed' });
    return get(id);
  }

  function update(id, b) {
    const j = get(id);
    if (!j) throw new Error('tarefa não encontrada');
    const patch = {};
    if (b.status === 'pausado' || b.status === 'ativo') { patch.status = b.status; if (b.status === 'ativo') { patch.errors = 0; patch.last_error = ''; if (j.kind === 'loop' && j.status !== 'ativo') patch.runs = 0; } }
    if (b.interval_min) patch.interval_min = Math.max(MIN_INTERVAL[j.kind], Math.min(1440, Math.round(Number(b.interval_min))));
    if (Object.keys(patch).length) set(j.id, patch);
    bus.emit({ type: 'jobs_changed' });
    return get(j.id);
  }
  function remove(id) { raw.prepare('DELETE FROM jobs WHERE id = ?').run(String(id)); bus.emit({ type: 'jobs_changed' }); }

  const due = (j, t) => !j.last_check || (t - new Date(j.last_check)) >= j.interval_min * 60000 - 20000;

  function fireLoop(j, t) {
    if (j.last_run_id) return;   // rodada anterior ainda não terminou
    const a = db.getAgent(j.agent_id);
    if (!a) { set(j.id, { status: 'falhou', last_error: 'tripulante não existe mais' }); return; }
    const n = j.runs + 1;
    const text = '[Tarefa contínua "' + j.title + '" — rodada ' + n + ' de no máximo ' + j.max_runs + ']\n' + j.prompt +
      '\n\nFaça a PRÓXIMA parte (confira no caderno/arquivos o que já foi feito e anote o progresso com notebook_write). ' +
      'Quando o trabalho inteiro estiver pronto, termine a resposta com a linha: CONCLUÍDO';
    try {
      const runId = station.enqueue(a.id, text, 'job', { jobId: j.id });
      set(j.id, { runs: n, last_run_id: runId, last_check: t.toISOString() });
    } catch (e) { set(j.id, { last_error: e.message, last_check: t.toISOString() }); }
  }

  async function fireWatch(j, t) {
    set(j.id, { last_check: t.toISOString() });
    let text;
    try { text = await fetchPage(j.url); }
    catch (e) {
      const errors = j.errors + 1;
      set(j.id, { errors, last_error: e.message, status: errors >= 5 ? 'falhou' : j.status });
      if (errors >= 5) bus.emit({ type: 'job_update', id: j.id, kind: j.kind, title: j.title, status: 'falhou', message: 'Vigia "' + j.title + '" parou: ' + e.message });
      return;
    }
    const ex = excerptFor(String(text).replace(/\r/g, ''), j.keyword).slice(0, 20000);
    const hash = crypto.createHash('sha256').update(ex.replace(/\s+/g, ' ').trim()).digest('hex');
    if (!j.last_hash) {
      set(j.id, { last_hash: hash, last_excerpt: ex.slice(0, 4000), errors: 0, last_error: '' });
      bus.emit({ type: 'job_update', id: j.id, kind: 'watch', title: j.title, status: 'ativo', message: '👁 Vigia "' + j.title + '" ligada — primeira leitura guardada.' + (j.keyword && !ex ? ' (a palavra-chave não aparece na página)' : '') });
      return;
    }
    if (hash === j.last_hash) { set(j.id, { errors: 0, last_error: '' }); return; }
    const changes = diffLines(j.last_excerpt, ex);
    set(j.id, { last_hash: hash, last_excerpt: ex.slice(0, 4000), last_change: t.toISOString(), errors: 0, last_error: '', runs: j.runs + 1 });
    bus.emit({ type: 'job_update', id: j.id, kind: 'watch', title: j.title, status: 'mudou', url: j.url,
      message: '🔔 "' + j.title + '" mudou: ' + (changes.length ? changes.slice(0, 3).join(' | ').slice(0, 300) : 'o conteúdo foi alterado') });
    if (j.prompt && j.agent_id && db.getAgent(j.agent_id)) {
      try {
        station.enqueue(j.agent_id, 'A página vigiada "' + j.title + '" (' + j.url + ') MUDOU.\n' +
          (changes.length ? 'Linhas novas:\n' + changes.map(c => '- ' + c).join('\n') + '\n' : '') + '\nTarefa: ' + j.prompt, 'job', { jobId: j.id, watch: true });
      } catch (e) { log('vigia: ' + e.message); }
    }
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const t = nowFn();
      for (const j of list()) {
        if (j.status !== 'ativo' || !due(j, t)) continue;
        if (j.kind === 'loop') fireLoop(j, t);
        else await fireWatch(j, t);
      }
    } catch (e) { log('tarefas contínuas: ' + e.message); }
    finally { busy = false; }
  }

  // fim de uma rodada de "repetir até terminar"
  function onRunEnd(agent, info) {
    const jobId = info.meta && info.meta.jobId;
    if (!jobId || info.meta.watch) return;
    const j = get(jobId);
    if (!j || j.kind !== 'loop' || j.last_run_id !== info.runId) return;
    const patch = { last_run_id: null };
    if (info.status === 'done' && DONE_RE.test(String(info.output || '').trim())) {
      patch.status = 'concluido'; patch.result = String(info.output).slice(0, 2000);
      bus.emit({ type: 'job_update', id: j.id, kind: 'loop', title: j.title, status: 'concluido', message: '✅ "' + j.title + '" concluída por ' + agent.name + ' em ' + j.runs + ' rodada(s).' });
    } else if (info.status === 'error') {
      patch.errors = j.errors + 1; patch.last_error = String(info.error || '').slice(0, 300);
      if (patch.errors >= 3) { patch.status = 'falhou'; bus.emit({ type: 'job_update', id: j.id, kind: 'loop', title: j.title, status: 'falhou', message: '⚠ "' + j.title + '" parou após 3 erros: ' + patch.last_error }); }
    } else if (info.status === 'cancelled') {
      patch.status = 'pausado';
    } else {
      patch.errors = 0;
      if (j.runs >= j.max_runs) { patch.status = 'limite'; bus.emit({ type: 'job_update', id: j.id, kind: 'loop', title: j.title, status: 'limite', message: '⏸ "' + j.title + '" chegou ao limite de ' + j.max_runs + ' rodadas sem terminar.' }); }
    }
    set(j.id, patch);
    bus.emit({ type: 'jobs_changed' });
  }

  let timer = null;
  function start() { if (!timer) { timer = setInterval(tick, deps.tickMs || 60000); if (timer.unref) timer.unref(); } }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  async function runNow(id) {
    const j = get(id);
    if (!j) throw new Error('tarefa não encontrada');
    if (j.kind === 'loop') { if (j.last_run_id) throw new Error('a rodada anterior ainda está em andamento'); fireLoop(Object.assign({}, j, { status: 'ativo' }), nowFn()); }
    else await fireWatch(j, nowFn());
    bus.emit({ type: 'jobs_changed' });
    return get(j.id);
  }

  return { create, update, remove, list, get, tick, onRunEnd, start, stop, runNow };
}

module.exports = { makeJobs, excerptFor, diffLines, DONE_RE };
