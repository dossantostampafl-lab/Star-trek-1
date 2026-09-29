'use strict';
/* server/checkpoint.js — foto da pasta de trabalho do agente antes de cada ação que muda arquivos
   (escrita e terminal). Restaurar = voltar a pasta exatamente para aquela foto.
   Guarda os últimos KEEP checkpoints por agente; pastas acima de MAX_BYTES não são fotografadas. */
const fs = require('node:fs');
const path = require('node:path');

const KEEP = 10;
const MAX_BYTES = 100 * 1024 * 1024;

function dirSize(dir, limit) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (total > limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

function makeCheckpoints(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  let seq = 0;
  const agentDir = (agentId) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) throw new Error('agentId inválido');
    return path.join(baseDir, agentId);
  };

  function create(agentId, workspace, label) {
    const size = dirSize(workspace, MAX_BYTES);
    if (size > MAX_BYTES) return { skipped: true, reason: 'pasta maior que 100 MB — sem checkpoint' };
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '_' + (seq++).toString(36);
    const dest = path.join(agentDir(agentId), id);
    fs.mkdirSync(dest, { recursive: true });
    if (fs.existsSync(workspace)) fs.cpSync(workspace, path.join(dest, 'files'), { recursive: true, verbatimSymlinks: true });
    else fs.mkdirSync(path.join(dest, 'files'));
    fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify({ id, label: String(label || '').slice(0, 200), at: new Date().toISOString(), bytes: size }));
    prune(agentId);
    return { id };
  }

  function list(agentId) {
    const d = agentDir(agentId);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).sort().reverse().map(id => {
      try { return JSON.parse(fs.readFileSync(path.join(d, id, 'meta.json'), 'utf8')); } catch (_) { return null; }
    }).filter(Boolean);
  }

  function prune(agentId) {
    const d = agentDir(agentId);
    const ids = fs.readdirSync(d).sort();
    while (ids.length > KEEP) fs.rmSync(path.join(d, ids.shift()), { recursive: true, force: true });
  }

  function restore(agentId, id, workspace) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('checkpoint inválido');
    const src = path.join(agentDir(agentId), id, 'files');
    if (!fs.existsSync(src)) throw new Error('checkpoint não encontrado');
    create(agentId, workspace, 'antes de restaurar ' + id);   // restaurar também é desfazível
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.cpSync(src, workspace, { recursive: true, verbatimSymlinks: true });
    return { restored: id };
  }

  return { create, list, restore };
}

module.exports = { makeCheckpoints, dirSize };
