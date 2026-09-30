'use strict';
/* server/deliverables.js — caixa de entregas: o que a tripulação produziu, num lugar só, já conferido.
   - O tripulante registra um arquivo pronto com a ferramenta deliver (da pasta dele ou da compartilhada).
   - Cada entrega passa pela conferência automática (server/verify.js) e ganha um veredito: ok · aviso · falhou.
   - O comandante aceita ou pede para refazer (o pedido volta para o tripulante com o motivo).
   - Ao fim de cada execução, os arquivos que o tripulante DIZ ter salvo são conferidos: se não existem, avisa. */
const fs = require('node:fs');
const path = require('node:path');
const { makeJail } = require('./tools/fs.js');
const { checkFile, mentionedFiles } = require('./verify.js');

function makeDeliverables(deps) {
  const { db, bus, station } = deps;
  const raw = db.raw;
  raw.exec(`CREATE TABLE IF NOT EXISTS deliverables (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, run_id TEXT, title TEXT NOT NULL, summary TEXT DEFAULT '',
    scope TEXT NOT NULL, rel TEXT NOT NULL, size INTEGER DEFAULT 0, verdict TEXT, checks TEXT DEFAULT '[]',
    status TEXT DEFAULT 'nova', feedback TEXT DEFAULT '', created_at TEXT, updated_at TEXT)`);
  const now = () => new Date().toISOString();
  let seq = 0;
  const row = (r) => r && Object.assign({}, r, { checks: JSON.parse(r.checks || '[]') });
  const get = (id) => row(raw.prepare('SELECT * FROM deliverables WHERE id = ?').get(String(id)));
  const list = (limit) => raw.prepare('SELECT * FROM deliverables ORDER BY created_at DESC LIMIT ?').all(limit || 200).map(row);

  const jailFor = (scope) => makeJail(scope === 'shared' ? station.sharedDir() : station.workspaceOf(scope));

  // confere de novo (o arquivo pode ter mudado)
  function recheck(id) {
    const d = get(id);
    if (!d) throw new Error('entrega não encontrada');
    let abs;
    try { abs = jailFor(d.scope).resolve(d.rel); } catch (_) { abs = null; }
    const r = abs ? checkFile(abs, { promisesLinks: /fonte|link|refer/i.test(d.title + ' ' + d.summary) }) : { verdict: 'falhou', checks: [{ name: 'existe', ok: false, level: 'falhou', detail: 'caminho inválido' }] };
    const size = abs && fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    raw.prepare('UPDATE deliverables SET verdict = ?, checks = ?, size = ?, updated_at = ? WHERE id = ?').run(r.verdict, JSON.stringify(r.checks), size, now(), d.id);
    return get(d.id);
  }

  function register(agent, args, meta) {
    let rel = String(args.path || '').trim().replace(/^\.\//, '');
    let scope = agent.id;
    if (args.shared || /^(shared|compartilhad[oa])\//i.test(rel)) { scope = 'shared'; rel = rel.replace(/^(shared|compartilhad[oa])\//i, ''); }
    if (!rel) throw new Error('diga o caminho do arquivo');
    const jail = jailFor(scope);
    const abs = jail.resolve(rel);   // lança se sair da cela
    rel = jail.relOf(abs);
    const title = String(args.title || path.basename(rel)).trim().slice(0, 140);
    const summary = String(args.summary || '').trim().slice(0, 1000);
    // mesma entrega de novo (ex.: depois de refazer) → atualiza em vez de duplicar
    const prev = raw.prepare('SELECT id FROM deliverables WHERE agent_id = ? AND scope = ? AND rel = ?').get(agent.id, scope, rel);
    const id = prev ? prev.id : 'd' + Date.now().toString(36) + (seq++).toString(36);
    if (prev) raw.prepare("UPDATE deliverables SET title = ?, summary = ?, run_id = ?, status = 'nova', updated_at = ? WHERE id = ?").run(title, summary, (meta && meta.runId) || null, now(), id);
    else raw.prepare('INSERT INTO deliverables (id, agent_id, run_id, title, summary, scope, rel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, agent.id, (meta && meta.runId) || null, title, summary, scope, rel, now(), now());
    const d = recheck(id);
    bus.emit({ type: 'deliverable', id: d.id, agentId: agent.id, agentName: agent.name, title: d.title, verdict: d.verdict, scope: d.scope, rel: d.rel, updated: !!prev });
    return d;
  }

  function absOf(d) { return jailFor(d.scope).resolve(d.rel); }

  function setStatus(id, status, feedback) {
    const d = get(id);
    if (!d) throw new Error('entrega não encontrada');
    raw.prepare('UPDATE deliverables SET status = ?, feedback = ?, updated_at = ? WHERE id = ?').run(status, String(feedback || '').slice(0, 2000), now(), d.id);
    bus.emit({ type: 'deliverables_changed' });
    return get(d.id);
  }

  function redo(id, feedback) {
    const d = setStatus(id, 'refazer', feedback);
    const where = d.scope === 'shared' ? 'shared/' + d.rel : d.rel;
    const fails = d.checks.filter(c => c.level !== 'ok').map(c => c.name + (c.detail ? ' (' + c.detail + ')' : ''));
    const text = 'O comandante pediu para REFAZER a entrega "' + d.title + '" (' + where + ').\n' +
      (feedback ? 'Motivo: ' + feedback + '\n' : '') + (fails.length ? 'A conferência automática apontou: ' + fails.join('; ') + '\n' : '') +
      'Corrija o arquivo e registre de novo com deliver (mesmo caminho).';
    const runId = station.enqueue(d.agent_id, text, 'chat', { redo: d.id });
    return { deliverable: d, runId };
  }

  function remove(id) { raw.prepare('DELETE FROM deliverables WHERE id = ?').run(String(id)); bus.emit({ type: 'deliverables_changed' }); }

  function tool(agent) {
    return {
      name: 'deliver', scope: 'read',
      description: 'Registra um arquivo PRONTO na caixa de entregas do comandante (ele recebe aviso, inclusive no Telegram). ' +
        'Use no fim de todo trabalho que gerou arquivo. path = caminho na sua pasta (ou "shared/…" / shared=true para a compartilhada). ' +
        'O arquivo é conferido automaticamente; se a conferência falhar, corrija e registre de novo.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string', description: '1–3 linhas: o que é e como usar' }, shared: { type: 'boolean' } }, required: ['path', 'title'] },
      run(args, ctx) {
        const d = register(agent, args, ctx && ctx.meta);
        const bad = d.checks.filter(c => c.level !== 'ok');
        return 'Entrega registrada (' + d.id + '): veredito ' + d.verdict.toUpperCase() +
          (bad.length ? '. Pontos: ' + bad.map(c => c.name + (c.detail ? ' — ' + c.detail : '')).join('; ') + '. Corrija se puder e registre de novo.' : '.');
      }
    };
  }

  // fim de execução: confere os arquivos que o tripulante diz ter salvo
  function onRunEnd(agent, info) {
    if (info.status !== 'done' || !info.output) return;
    const claims = mentionedFiles(info.output).filter(p => /salv|grav|cri|escrev|gere|arquivo|entreg|saved|wrote/i.test(info.output));
    if (!claims.length) return;
    const missing = [];
    for (const p of claims) {
      let found = false;
      for (const scope of [agent.id, 'shared']) {
        try { const rel = p.replace(/^(shared|compartilhad[oa])\//i, ''); if (fs.existsSync(jailFor(scope).resolve(rel))) { found = true; break; } } catch (_) { /* fora da cela */ }
      }
      if (!found) missing.push(p);
    }
    if (missing.length) {
      bus.emit({ type: 'claim_missing', agentId: agent.id, agentName: agent.name, runId: info.runId, files: missing });
      bus.emit({ type: 'warning', message: agent.name + ' disse ter salvo ' + missing.join(', ') + ', mas não achei o arquivo.' });
    }
  }

  function context() {
    return 'Terminou um trabalho que gerou arquivo? Registre com deliver (vai para a caixa de entregas do comandante, já conferido).';
  }

  function counts() {
    const r = raw.prepare("SELECT COUNT(*) AS n FROM deliverables WHERE status = 'nova'").get();
    return { novas: r.n };
  }

  return { register, recheck, list, get, absOf, setStatus, redo, remove, tool, onRunEnd, context, counts };
}

module.exports = { makeDeliverables };
