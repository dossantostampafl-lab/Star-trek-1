'use strict';
/* server/missions.js — missões (objetivos longos com etapas), turno da noite e relatório da manhã.
   - Missões: o Capitão cria e divide em etapas; qualquer tripulante marca etapas e anota progresso.
   - Turno da noite: numa janela de horário (ex.: 23h–7h), a estação acorda o Capitão a cada N horas para
     avançar as missões ativas — sem ninguém olhando (execução automática: terminal sempre negado).
     Só tripulantes "confiáveis" (confiança ≥ NIGHT_MIN_TRUST) recebem trabalho da noite.
   - Relatório da manhã: ao fim da janela, junta tudo o que rodou à noite num relatório (sem gastar modelo),
     salva na pasta compartilhada (relatorios/) e mostra no painel. */
const fs = require('node:fs');
const path = require('node:path');

const STATUS = ['ativa', 'pausada', 'concluida', 'cancelada'];
const NIGHT_MIN_TRUST = 40;
const NIGHT_DEFAULTS = { enabled: '0', start: '23:00', end: '07:00', interval_h: '2', max_runs: '6' };

// ---------------- ferramentas dos tripulantes ----------------
function missionTools(ctx) {
  const { db, bus, agent } = ctx;
  const find = (id) => {
    const m = db.getMission(String(id || '').trim());
    if (!m) throw new Error('missão não encontrada: ' + id + '. Use mission_list para ver os números.');
    return m;
  };
  const fmt = (m) => {
    const done = m.steps.filter(s => s.done).length;
    return 'M' + m.num + ' [' + m.status + '] ' + m.title + ' — ' + done + '/' + m.steps.length + ' etapas\n' +
      (m.goal ? '   objetivo: ' + m.goal.slice(0, 300) + '\n' : '') +
      m.steps.map(s => '   ' + (s.done ? '[x]' : '[ ]') + ' ' + s.id + '. ' + s.text + (s.agent ? ' (' + s.agent + ')' : '') + (s.note ? ' — ' + s.note.slice(0, 160) : '')).join('\n');
  };
  const changed = (m) => bus.emit({ type: 'missions_changed', id: m.id });

  const list = {
    name: 'mission_list', scope: 'read',
    description: 'Lista as missões da estação (objetivos longos com etapas). Sem filtro, mostra as ativas.',
    parameters: { type: 'object', properties: { status: { type: 'string', description: 'ativa | pausada | concluida | cancelada | todas' } } },
    run(a) {
      const st = a.status || 'ativa';
      const ms = db.listMissions().filter(m => st === 'todas' || m.status === st);
      return ms.length ? ms.map(fmt).join('\n\n') : 'Nenhuma missão ' + (st === 'todas' ? '' : st) + '.';
    }
  };

  const update = {
    name: 'mission_update', scope: 'read',
    description: 'Atualiza uma missão: marque uma etapa como feita (step + done), anote progresso (note), acrescente etapa (add_step) ou mude o status. Use o número (ex.: "M2" ou 2).',
    parameters: { type: 'object', properties: {
      mission: { type: 'string', description: 'Número da missão, ex.: M2' },
      step: { type: 'integer', description: 'Número da etapa' },
      done: { type: 'boolean' },
      note: { type: 'string', description: 'O que foi feito / onde está o resultado' },
      add_step: { type: 'string' },
      status: { type: 'string', description: 'ativa | pausada | concluida | cancelada' }
    }, required: ['mission'] },
    run(a) {
      const m = find(a.mission);
      const who = agent.name;
      if (a.step != null) {
        const s = m.steps.find(x => x.id === Number(a.step));
        if (!s) throw new Error('etapa ' + a.step + ' não existe em M' + m.num);
        if (a.done != null) s.done = !!a.done;
        s.agent = who;
        if (a.note) s.note = String(a.note).slice(0, 500);
      }
      if (a.add_step) m.steps.push({ id: m.steps.reduce((x, s) => Math.max(x, s.id), 0) + 1, text: String(a.add_step).slice(0, 300), done: false, agent: '', note: '' });
      if (a.status) { if (!STATUS.includes(a.status)) throw new Error('status inválido'); m.status = a.status; }
      if (m.steps.length && m.steps.every(s => s.done) && m.status === 'ativa') m.status = 'concluida';
      m.log.push({ at: new Date().toISOString(), agent: who, text: [a.step != null ? 'etapa ' + a.step + (a.done ? ' feita' : '') : '', a.note || '', a.add_step ? '+ etapa: ' + a.add_step : '', a.status ? 'status: ' + a.status : ''].filter(Boolean).join(' · ') });
      const saved = db.saveMission(m);
      changed(saved);
      if (saved.status === 'concluida' && ctx.onMissionDone) ctx.onMissionDone(saved, agent);
      return 'Atualizado.\n' + fmt(saved);
    }
  };

  const tools = [list, update];
  if (agent.captain) {
    tools.push({
      name: 'mission_create', scope: 'read',
      description: 'Cria uma missão (objetivo que leva várias etapas ou dias). Divida em 3 a 8 etapas concretas. O turno da noite avança as missões ativas.',
      parameters: { type: 'object', properties: {
        title: { type: 'string' }, goal: { type: 'string', description: 'O resultado esperado, com critérios de pronto' },
        steps: { type: 'array', items: { type: 'string' } }
      }, required: ['title', 'steps'] },
      run(a) {
        if (!Array.isArray(a.steps) || !a.steps.length) throw new Error('informe as etapas');
        const m = db.createMission({ title: a.title, goal: a.goal, steps: a.steps, owner: agent.id });
        changed(m);
        return 'Missão criada.\n' + fmt(m);
      }
    });
  }
  return tools;
}

// ---------------- turno da noite ----------------
function toMinutes(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}
function inWindow(date, start, end) {
  const s = toMinutes(start), e = toMinutes(end);
  if (s == null || e == null || s === e) return false;
  const t = date.getHours() * 60 + date.getMinutes();
  return s < e ? (t >= s && t < e) : (t >= s || t < e);   // janela que atravessa a meia-noite
}

function nightSettings(db) {
  const o = {};
  for (const k of Object.keys(NIGHT_DEFAULTS)) o[k] = db.getSetting('night_' + k, NIGHT_DEFAULTS[k]);
  return { enabled: o.enabled === '1', start: o.start, end: o.end, interval_h: Math.max(1, Number(o.interval_h) || 2), max_runs: Math.max(1, Number(o.max_runs) || 6),
    active_since: db.getSetting('night_active_since', ''), runs: Number(db.getSetting('night_runs', '0')) || 0, last_fire: db.getSetting('night_last_fire', '') };
}
function saveNightSettings(db, patch) {
  if (patch.enabled != null) db.setSetting('night_enabled', patch.enabled ? '1' : '0');
  for (const k of ['start', 'end']) if (patch[k] != null) { if (toMinutes(patch[k]) == null) throw new Error('horário inválido: ' + patch[k] + ' (use HH:MM)'); db.setSetting('night_' + k, patch[k]); }
  if (patch.interval_h != null) db.setSetting('night_interval_h', String(Math.min(12, Math.max(1, Number(patch.interval_h) || 2))));
  if (patch.max_runs != null) db.setSetting('night_max_runs', String(Math.min(24, Math.max(1, Number(patch.max_runs) || 6))));
  return nightSettings(db);
}

function nightPrompt(db) {
  const active = db.listMissions().filter(m => m.status === 'ativa');
  const trusted = db.listAgents().filter(a => !a.captain && (a.trust == null || a.trust >= NIGHT_MIN_TRUST)).map(a => a.name);
  const lines = active.map(m => {
    const pend = m.steps.filter(s => !s.done);
    return 'M' + m.num + ' — ' + m.title + ' (' + (m.steps.length - pend.length) + '/' + m.steps.length + '). Próximas: ' + pend.slice(0, 3).map(s => s.id + '. ' + s.text).join(' | ');
  });
  return [
    'TURNO DA NOITE. O comandante está dormindo; ninguém vai responder perguntas até de manhã.',
    'Avance as missões ativas abaixo: escolha no máximo 2 etapas pendentes, delegue com pass_work a quem sabe fazer',
    '(apenas: ' + (trusted.join(', ') || 'ninguém — faça você mesmo o que der') + '), e registre o progresso com mission_update.',
    'Não use o terminal. Não invente resultados. Se uma etapa depender do comandante, anote isso na etapa e siga para outra.',
    '',
    lines.join('\n')
  ].join('\n');
}

function makeNightShift(deps) {
  const { db, station, bus } = deps;
  const log = deps.log || (() => {});
  const now = deps.now || (() => new Date());
  const reportsDir = () => { const d = path.join(station.sharedDir(), 'relatorios'); fs.mkdirSync(d, { recursive: true }); return d; };

  function captain() { return db.listAgents().find(a => a.captain) || null; }

  function fire(reason) {
    const cap = captain();
    if (!cap) return { ok: false, reason: 'sem Capitão na tripulação' };
    if (!db.listMissions().some(m => m.status === 'ativa')) return { ok: false, reason: 'nenhuma missão ativa' };
    const runId = station.enqueue(cap.id, nightPrompt(db), 'night', { night: true });
    db.setSetting('night_last_fire', now().toISOString());
    db.setSetting('night_runs', String((Number(db.getSetting('night_runs', '0')) || 0) + 1));
    bus.emit({ type: 'night_fired', agentId: cap.id, reason });
    return { ok: true, runId };
  }

  // Relatório determinístico (não gasta cota): execuções da noite + progresso das missões.
  function morningReport(sinceIso) {
    const since = sinceIso || new Date(now().getTime() - 12 * 3600e3).toISOString();
    const runs = db.runsSince(since);
    const agents = Object.fromEntries(db.listAgents().map(a => [a.id, a.name]));
    const ms = db.listMissions();
    const moved = ms.map(m => ({ m, entries: m.log.filter(e => e.at >= since) })).filter(x => x.entries.length);
    const done = runs.filter(r => r.status === 'done'), failed = runs.filter(r => r.status === 'error');
    const cost = runs.reduce((s, r) => s + (r.cost_usd || 0), 0);
    const d = now();
    const title = 'Relatório da manhã — ' + d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    const out = ['# ' + title, '',
      '**Resumo:** ' + runs.length + ' execuções (' + done.length + ' concluídas, ' + failed.length + ' com erro) · ' +
        ms.filter(m => m.status === 'ativa').length + ' missões ativas · custo US$ ' + cost.toFixed(2), ''];
    out.push('## Missões');
    if (!moved.length) out.push('Nenhuma missão avançou esta noite.');
    for (const { m, entries } of moved) {
      const n = m.steps.filter(s => s.done).length;
      out.push('### M' + m.num + ' — ' + m.title + ' (' + n + '/' + m.steps.length + (m.status === 'concluida' ? ', **concluída**' : '') + ')');
      for (const e of entries) out.push('- ' + e.agent + ': ' + e.text);
    }
    out.push('', '## O que a tripulação entregou');
    if (!done.length) out.push('Nada concluído.');
    for (const r of done.filter(r => (r.output || '').trim())) {
      out.push('**' + (agents[r.agent_id] || '?') + '** (' + new Date(r.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '): ' + r.output.replace(/\s+/g, ' ').slice(0, 400) + (r.output.length > 400 ? '…' : ''));
    }
    if (failed.length) {
      out.push('', '## Problemas');
      for (const r of failed) out.push('- ' + (agents[r.agent_id] || '?') + ': ' + (r.error || 'erro').slice(0, 200));
    }
    const pendingOnYou = ms.filter(m => m.status === 'ativa').flatMap(m => m.steps.filter(s => !s.done && /comandante/i.test(s.note || '')).map(s => 'M' + m.num + ' etapa ' + s.id + ': ' + s.note));
    if (pendingOnYou.length) { out.push('', '## Esperando você'); for (const p of pendingOnYou) out.push('- ' + p); }
    const body = out.join('\n');
    const id = db.addReport({ kind: 'manha', title, body });
    try { fs.writeFileSync(path.join(reportsDir(), 'manha-' + d.toISOString().slice(0, 10) + '.md'), body); } catch (e) { log('relatório: ' + e.message); }
    bus.emit({ type: 'report', id, title });
    return { id, title, body };
  }

  function tick() {
    const s = nightSettings(db);
    const t = now();
    const inside = s.enabled && inWindow(t, s.start, s.end);
    if (inside) {
      if (!s.active_since) { db.setSetting('night_active_since', t.toISOString()); db.setSetting('night_runs', '0'); db.setSetting('night_last_fire', ''); bus.emit({ type: 'night_started' }); }
      const cur = nightSettings(db);
      const due = !cur.last_fire || (t - new Date(cur.last_fire)) >= cur.interval_h * 3600e3 - 30e3;
      if (due && cur.runs < cur.max_runs) { const r = fire('agenda'); if (!r.ok) db.setSetting('night_last_fire', t.toISOString()); }
    } else if (s.active_since) {
      try { morningReport(s.active_since); } catch (e) { log('relatório da manhã falhou: ' + e.message); }
      db.setSetting('night_active_since', '');
      bus.emit({ type: 'night_ended' });
    }
  }

  let timer = null;
  return {
    start() { if (!timer) { timer = setInterval(() => { try { tick(); } catch (e) { log('turno da noite: ' + e.message); } }, deps.tickMs || 30000); if (timer.unref) timer.unref(); } },
    stop() { clearInterval(timer); timer = null; },
    tick, fire, morningReport
  };
}

module.exports = { missionTools, makeNightShift, nightSettings, saveNightSettings, inWindow, toMinutes, nightPrompt, STATUS, NIGHT_MIN_TRUST };
