'use strict';
/* server/skills.js — biblioteca de habilidades: métodos prontos ("como fazer bem") que o tripulante lê antes de agir.
   - Biblioteca embutida: skills/library/*.md (portadas do StarNet, MIT — ver skills/NOTICE.md). Só leitura.
   - Habilidades próprias: criadas pelo comandante (ativas na hora) ou PROPOSTAS por um tripulante com skill_propose
     (só valem depois que o comandante aprova no painel).
   - Cada tripulante tem a sua lista de habilidades ligadas (coluna agents.skills; vazio = padrão da função).
   - No prompt entra só o ÍNDICE (nome + uma linha). O método completo vem sob demanda com skill_view — prompt enxuto. */
const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./tools/shell.js');

const LIB_DIR = path.join(__dirname, '..', 'skills', 'library');
const MAX_BODY = 20000;
const MAX_INDEX = 10;   // no máximo tantas linhas de habilidade no prompt

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function parseValue(v) {
  v = String(v == null ? '' : v).trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean);
  return v;
}
function parseSkill(text, fallbackSlug) {
  const m = String(text).replace(/^\uFEFF/, '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/); if (mm) meta[mm[1]] = parseValue(mm[2]); }
  return {
    slug: slugify(meta.slug || fallbackSlug), name: String(meta.name || fallbackSlug), description: String(meta.description || ''),
    category: String(meta.category || 'Geral'), requires: Array.isArray(meta.requires) ? meta.requires : [],
    source: String(meta.source || ''), license: String(meta.license || ''), default: meta.default === true,
    body: (m ? m[2] : String(text)).trim(), builtin: true, status: 'ativa'
  };
}

let LIBRARY = null;
function library() {
  if (LIBRARY) return LIBRARY;
  LIBRARY = [];
  let files = [];
  try { files = fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.md')); } catch (_) { /* sem biblioteca */ }
  for (const f of files) {
    try { LIBRARY.push(parseSkill(fs.readFileSync(path.join(LIB_DIR, f), 'utf8'), f.slice(0, -3))); } catch (_) { /* arquivo ruim: pula */ }
  }
  LIBRARY.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return LIBRARY;
}

// Habilidades padrão pela função (quando o comandante ainda não escolheu nenhuma para o tripulante).
const PRESETS = [
  [/capit/, ['decision-1-3-1', 'work-splitting', 'commitment-tracking', 'creative-ideation']],
  [/pesquis|research/, ['web-research', 'source-triangulation', 'digest-composer', 'arxiv-research', 'price-watch', 'feed-watch']],
  [/redat|escrit|writer/, ['humanizer', 'voice-match', 'translation-pass', 'announcement-kit', 'landing-copy', 'email-sequence']],
  [/revis|review/, ['humanizer', 'source-triangulation', 'adversarial-review-pass', 'code-review', 'contract-review']],
  [/engenh|código|codigo|dev|program|engineer/, ['plan', 'systematic-debugging', 'test-driven-development', 'simplify-code', 'security-sweep', 'spec-drafting', 'deploy-checklist']]
];
function defaultSkills(a) {
  if (a.captain) return PRESETS[0][1].slice();
  // o nome decide primeiro (a função do Redator fala em "pesquisas"); a função só desempata
  for (const txt of [String(a.name || '').toLowerCase(), String(a.role || '').toLowerCase()]) {
    for (const [re, list] of PRESETS) if (re.test(txt)) return list.slice();
  }
  return library().filter(s => s.default).map(s => s.slug);
}

function makeSkills(deps) {
  const { db, bus } = deps;
  const raw = db.raw;
  raw.exec(`CREATE TABLE IF NOT EXISTS skills (
    slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', category TEXT DEFAULT 'Minhas',
    body TEXT NOT NULL, status TEXT DEFAULT 'ativa', author TEXT DEFAULT '', created_at TEXT, updated_at TEXT)`);
  const now = () => new Date().toISOString();

  const customRows = () => raw.prepare('SELECT * FROM skills ORDER BY created_at').all()
    .map(r => Object.assign({}, r, { requires: [], builtin: false, source: r.author ? 'proposta por ' + r.author : 'comandante' }));

  function all() { return library().concat(customRows()); }
  function get(slug) { slug = slugify(slug); return all().find(s => s.slug === slug) || null; }
  const active = () => all().filter(s => s.status === 'ativa');

  function enabledFor(a) { return Array.isArray(a.skills) ? a.skills : defaultSkills(a); }
  function canUse(a, s) {
    return s.requires.every(r => r === 'shell' ? !!a.shell : r === 'captain' ? !!a.captain : true);
  }
  function forAgent(a) {
    const on = new Set(enabledFor(a));
    return active().filter(s => on.has(s.slug) && canUse(a, s));
  }

  function clean(b, partial) {
    const out = {};
    if (b.name !== undefined) out.name = String(b.name).trim().slice(0, 80);
    if (b.description !== undefined) out.description = String(b.description).trim().slice(0, 300);
    if (b.category !== undefined) out.category = String(b.category).trim().slice(0, 40) || 'Minhas';
    if (b.body !== undefined) {
      out.body = redact(String(b.body).trim());
      if (out.body.length > MAX_BODY) throw new Error('método grande demais (máx. 20 mil caracteres)');
    }
    if (!partial && (!out.name || !out.body)) throw new Error('dê um nome e escreva o método');
    return out;
  }

  function create(b, opts) {
    opts = opts || {};
    const c = clean(b);
    let slug = slugify(b.slug || c.name) || 'habilidade';
    if (library().some(s => s.slug === slug)) slug = 'minha-' + slug;
    let n = 2; const base = slug;
    while (get(slug)) slug = base + '-' + n++;
    raw.prepare('INSERT INTO skills (slug, name, description, category, body, status, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(slug, c.name, c.description || '', c.category || 'Minhas', c.body, opts.status || 'ativa', opts.author || '', now(), now());
    return get(slug);
  }
  function update(slug, b) {
    const s = get(slug);
    if (!s) throw new Error('habilidade não encontrada');
    if (s.builtin) throw new Error('as habilidades da biblioteca não mudam — crie uma sua a partir dela');
    const c = clean(b, true);
    const sets = Object.keys(c).map(k => k + ' = ?');
    if (b.status === 'ativa') { sets.push('status = ?'); c.status = 'ativa'; }
    if (!sets.length) return s;
    raw.prepare('UPDATE skills SET ' + sets.join(', ') + ', updated_at = ? WHERE slug = ?').run(...Object.values(c), now(), s.slug);
    return get(s.slug);
  }
  function remove(slug) {
    const s = get(slug);
    if (!s) throw new Error('habilidade não encontrada');
    if (s.builtin) throw new Error('as habilidades da biblioteca não podem ser apagadas — desligue-as no tripulante');
    raw.prepare('DELETE FROM skills WHERE slug = ?').run(s.slug);
  }

  // ---- ferramentas do tripulante
  function tools(a) {
    return [
      {
        name: 'skill_view', scope: 'read',
        description: 'Lê o método completo de uma habilidade pelo slug (ex.: web-research). Leia ANTES de fazer uma tarefa que combine com ela e siga o método.',
        parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
        run(args) {
          const s = get(args.slug);
          if (!s || s.status !== 'ativa') return 'Habilidade não encontrada: ' + args.slug + '. Ligadas para você: ' + (forAgent(db.getAgent(a.id) || a).map(x => x.slug).join(', ') || 'nenhuma') + '.';
          return '# ' + s.name + ' (' + s.slug + ')\n' + (s.description ? s.description + '\n' : '') + '\n' + s.body;
        }
      },
      {
        name: 'skill_propose', scope: 'read',
        description: 'Propõe uma habilidade nova para a biblioteca: um método que funcionou e vale repetir. ' +
          'Fica PENDENTE até o comandante aprovar. Escreva o método em passos curtos (Markdown).',
        parameters: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' } }, required: ['name', 'body'] },
        run(args) {
          const s = create(args, { status: 'proposta', author: a.name });
          bus.emit({ type: 'skill_proposed', agentId: a.id, slug: s.slug, name: s.name });
          bus.emit({ type: 'state_changed' });
          return 'Proposta registrada como "' + s.slug + '". O comandante vai revisar.';
        }
      }
    ];
  }

  // índice curto para o prompt de sistema
  function context(a) {
    const mine = forAgent(a).slice(0, MAX_INDEX);
    if (!mine.length) return '';
    return 'Suas habilidades (métodos prontos). Quando a tarefa combinar com uma delas, leia o método com skill_view ANTES de começar e siga-o:\n' +
      mine.map(s => '- ' + s.slug + ': ' + (s.description.length > 90 ? s.description.slice(0, 88) + '…' : s.description)).join('\n') +
      '\nSe descobrir um jeito de trabalhar que vale repetir, proponha com skill_propose.';
  }

  function summary() {
    return all().map(s => ({ slug: s.slug, name: s.name, description: s.description, category: s.category, requires: s.requires,
      source: s.source, builtin: s.builtin, status: s.status, default: !!s.default }));
  }

  return { all, get, create, update, remove, tools, context, summary, enabledFor, forAgent, canUse,
    pending: () => customRows().filter(s => s.status === 'proposta').length };
}

module.exports = { makeSkills, library, defaultSkills, parseSkill, slugify };
