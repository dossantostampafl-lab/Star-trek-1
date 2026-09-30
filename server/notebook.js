'use strict';
/* server/notebook.js — caderno de anotações: a memória de longo prazo de cada tripulante.
   - Cada tripulante anota fatos, decisões e jeitos de fazer com notebook_write; notas "da tripulação" (shared)
     valem para todos. Notas FIXADAS entram sozinhas no prompt; as outras ele busca com notebook_read.
   - Corrigir uma nota exige mandar o texto anterior exato (previous_body): evita sobrescrever o que mudou.
     A versão antiga vai para o histórico da nota.
   - Segredos (chaves de API, tokens) são apagados antes de salvar.
   - O comandante vê, edita, fixa e apaga tudo na aba Caderno, e pode exportar/restaurar
     (restaurar só ACRESCENTA: nota com o mesmo id que já existe fica como está). */
const { redact } = require('./tools/shell.js');

const MAX_BODY = 8000, MAX_TITLE = 120, MAX_PINNED_CTX = 8, MAX_NOTES_PER_AGENT = 500;
const SHARED = '*';

const tokens = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{2,}/g) || [];

// ranking simples (BM25 reduzido) — suficiente para algumas centenas de notas
function rank(notes, query) {
  const q = [...new Set(tokens(query))];
  if (!q.length) return notes.slice().sort((a, b) => (b.pinned - a.pinned) || b.updated_at.localeCompare(a.updated_at));
  const docs = notes.map(n => ({ n, t: tokens(n.title + ' ' + n.title + ' ' + n.body) }));
  const avg = docs.reduce((s, d) => s + d.t.length, 0) / Math.max(1, docs.length);
  const df = {};
  for (const w of q) df[w] = docs.filter(d => d.t.includes(w)).length;
  const N = docs.length;
  return docs.map(d => {
    let score = 0;
    for (const w of q) {
      const tf = d.t.filter(x => x === w || (w.length >= 4 && x.startsWith(w))).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * d.t.length / (avg || 1)));
    }
    return { n: d.n, score: score + (score > 0 && d.n.pinned ? 0.5 : 0) };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.n);
}

function makeNotebook(deps) {
  const { db, bus } = deps;
  const invalidate = deps.invalidate || (() => {});
  const raw = db.raw;
  raw.exec(`CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, pinned INTEGER DEFAULT 0,
    history TEXT DEFAULT '[]', use_count INTEGER DEFAULT 0, source TEXT DEFAULT '', created_at TEXT, updated_at TEXT)`);
  raw.exec('CREATE INDEX IF NOT EXISTS notes_agent ON notes(agent_id)');
  const now = () => new Date().toISOString();
  let seq = 0;
  const newId = () => 'note_' + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 5);
  const row = (r) => r && Object.assign({}, r, { pinned: !!r.pinned, history: JSON.parse(r.history || '[]'), shared: r.agent_id === SHARED });

  function list(agentId, opts) {
    opts = opts || {};
    let rows;
    if (agentId === 'all') rows = raw.prepare('SELECT * FROM notes').all();
    else if (opts.withShared) rows = raw.prepare('SELECT * FROM notes WHERE agent_id = ? OR agent_id = ?').all(agentId, SHARED);
    else rows = raw.prepare('SELECT * FROM notes WHERE agent_id = ?').all(agentId);
    return rank(rows.map(row), opts.q || '');
  }
  const get = (id) => row(raw.prepare('SELECT * FROM notes WHERE id = ?').get(String(id)));

  function clean(b, partial) {
    const out = {};
    if (b.title !== undefined) out.title = redact(String(b.title).trim()).slice(0, MAX_TITLE);
    if (b.body !== undefined) out.body = redact(String(b.body).trim());
    if (out.body && out.body.length > MAX_BODY) out.body = out.body.slice(0, MAX_BODY);
    if (!partial && !out.body) throw new Error('a nota está vazia');
    if (!partial && !out.title) out.title = out.body.split('\n')[0].slice(0, 60);
    return out;
  }

  function create(agentId, b, source) {
    const c = clean(b);
    const count = raw.prepare('SELECT COUNT(*) AS n FROM notes WHERE agent_id = ?').get(agentId).n;
    if (count >= MAX_NOTES_PER_AGENT) throw new Error('caderno cheio (' + MAX_NOTES_PER_AGENT + ' notas) — apague notas antigas');
    const id = b.id && /^[A-Za-z0-9_-]{3,60}$/.test(b.id) && !get(b.id) ? b.id : newId();
    raw.prepare('INSERT INTO notes (id, agent_id, title, body, pinned, history, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, agentId, c.title, c.body, b.pinned ? 1 : 0, '[]', source || '', b.created_at || now(), now());
    changed(agentId);
    return get(id);
  }

  function update(id, b) {
    const n = get(id);
    if (!n) throw new Error('nota não encontrada');
    const c = clean(b, true);
    const hist = n.history;
    if ((c.body !== undefined && c.body !== n.body) || (c.title !== undefined && c.title !== n.title)) {
      hist.push({ title: n.title, body: n.body, at: n.updated_at });
      while (hist.length > 10) hist.shift();
    }
    const title = c.title !== undefined ? c.title : n.title, body = c.body !== undefined && c.body ? c.body : n.body;
    const pinned = b.pinned !== undefined ? (b.pinned ? 1 : 0) : (n.pinned ? 1 : 0);
    const agentId = b.shared !== undefined ? (b.shared ? SHARED : (b.agent_id || (n.agent_id === SHARED ? null : n.agent_id))) : n.agent_id;
    if (!agentId) throw new Error('escolha o tripulante dono da nota');
    raw.prepare('UPDATE notes SET title = ?, body = ?, pinned = ?, agent_id = ?, history = ?, updated_at = ? WHERE id = ?')
      .run(title, body, pinned, agentId, JSON.stringify(hist), now(), n.id);
    changed(n.agent_id); if (agentId !== n.agent_id) changed(agentId);
    return get(n.id);
  }

  function remove(id) {
    const n = get(id);
    if (!n) throw new Error('nota não encontrada');
    raw.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
    changed(n.agent_id);
  }

  function removeAgent(agentId) { raw.prepare('DELETE FROM notes WHERE agent_id = ?').run(agentId); }

  // notas fixadas mudam o prompt: descarta o tripulante em cache (ou todos, se a nota é da tripulação)
  function changed(agentId) {
    invalidate(agentId === SHARED ? undefined : agentId);
    bus.emit({ type: 'notes_changed', agentId });
  }

  // restaurar de um backup: só acrescenta, nunca sobrescreve
  function restore(agentId, notes) {
    if (!Array.isArray(notes)) throw new Error('backup inválido: esperava uma lista de notas');
    let added = 0, kept = 0, skipped = 0;
    notes.slice(0, MAX_NOTES_PER_AGENT).forEach((x, i) => {
      if (!x || !String(x.body || '').trim()) { skipped++; return; }
      const id = x.id && /^[A-Za-z0-9_-]{3,60}$/.test(x.id) ? x.id : 'note_r' + Date.parse(x.created_at || 0).toString(36) + '_' + i;
      if (get(id)) { kept++; return; }
      const owner = x.shared || x.agent_id === SHARED ? SHARED : agentId;
      try { create(owner, { id, title: x.title, body: x.body, pinned: x.pinned, created_at: x.created_at }, 'restaurada'); added++; }
      catch (_) { skipped++; }
    });
    return { added, kept, skipped };
  }

  function exportNotes(agentId) {
    return list(agentId, { withShared: agentId !== 'all' }).map(n => ({ id: n.id, title: n.title, body: n.body, pinned: n.pinned, shared: n.shared, created_at: n.created_at, updated_at: n.updated_at }));
  }

  // ---- ferramentas do tripulante
  function tools(a) {
    return [
      {
        name: 'notebook_write', scope: 'read',
        description: 'Anota no seu caderno algo que vale lembrar depois (fato, decisão, preferência, jeito de fazer). ' +
          'pinned=true para notas essenciais (entram sempre no seu contexto). shared=true grava no caderno da tripulação (todos veem). ' +
          'Para CORRIGIR uma nota: replace_id + previous_body com o texto atual exato. Nunca anote senhas ou chaves.',
        parameters: { type: 'object', properties: {
          title: { type: 'string' }, body: { type: 'string' }, pinned: { type: 'boolean' }, shared: { type: 'boolean' },
          replace_id: { type: 'string' }, previous_body: { type: 'string' } }, required: ['body'] },
        run(args) {
          if (args.replace_id) {
            const n = get(args.replace_id);
            if (!n || (n.agent_id !== a.id && n.agent_id !== SHARED)) return 'Nota não encontrada: ' + args.replace_id;
            if (String(args.previous_body || '').trim() !== n.body.trim()) return 'Recusado: a nota mudou desde que você leu. Leia de novo com notebook_read e mande previous_body igual ao texto atual.';
            const u = update(n.id, { title: args.title, body: args.body, pinned: args.pinned });
            return 'Nota ' + u.id + ' corrigida.';
          }
          const dup = list(args.shared ? SHARED : a.id).find(n => n.body.trim() === String(args.body).trim());
          if (dup) return 'Essa nota já existe (' + dup.id + ').';
          const n = create(args.shared ? SHARED : a.id, args, 'tripulante');
          return 'Anotado (' + n.id + (n.pinned ? ', fixada' : '') + (n.shared ? ', caderno da tripulação' : '') + ').';
        }
      },
      {
        name: 'notebook_read', scope: 'read',
        description: 'Busca no seu caderno e no da tripulação. Sem query, traz as mais recentes. Use antes de tarefas em que o passado pode importar.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        run(args) {
          const found = list(a.id, { withShared: true, q: args.query || '' }).slice(0, 8);
          if (!found.length) return args.query ? 'Nada no caderno sobre "' + args.query + '".' : 'Caderno vazio.';
          for (const n of found) raw.prepare('UPDATE notes SET use_count = use_count + 1 WHERE id = ?').run(n.id);
          return found.map(n => '[' + n.id + ']' + (n.pinned ? ' 📌' : '') + (n.shared ? ' (tripulação)' : '') + ' ' + n.title + '\n' +
            (n.body.length > 1200 ? n.body.slice(0, 1200) + '…' : n.body)).join('\n\n');
        }
      }
    ];
  }

  // notas fixadas no prompt de sistema
  function context(a) {
    const all = list(a.id, { withShared: true });
    const pinned = all.filter(n => n.pinned).slice(0, MAX_PINNED_CTX);
    const lines = [];
    if (pinned.length) {
      lines.push('Do seu caderno (notas fixadas):');
      for (const n of pinned) lines.push('- ' + n.title + (n.body !== n.title ? ': ' + (n.body.length > 300 ? n.body.slice(0, 300) + '…' : n.body).replace(/\s*\n\s*/g, ' ') : ''));
    }
    lines.push('Caderno: ' + all.length + ' nota(s). Busque com notebook_read; anote o que vale lembrar com notebook_write (antes de dizer que "vai lembrar").');
    return lines.join('\n');
  }

  function counts() {
    const out = {};
    for (const r of raw.prepare('SELECT agent_id, COUNT(*) AS n FROM notes GROUP BY agent_id').all()) out[r.agent_id] = r.n;
    return out;
  }

  return { list, get, create, update, remove, removeAgent, restore, exportNotes, tools, context, counts, SHARED };
}

module.exports = { makeNotebook, rank, SHARED };
