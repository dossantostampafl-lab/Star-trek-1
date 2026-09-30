'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfig } = require('../server/config.js');
const { start } = require('../server/index.js');
const { library, defaultSkills } = require('../server/skills.js');
const { rank } = require('../server/notebook.js');
const { CATALOG, fill, paramsFromText } = require('../server/recipes.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st1l-'));

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


test('biblioteca de habilidades: 64 métodos em português, com crédito e nomes de ferramenta da estação', () => {
  const lib = library();
  assert.ok(lib.length >= 60, 'poucas habilidades: ' + lib.length);
  for (const s of lib) {
    assert.equal(s.license, 'MIT', s.slug);
    assert.ok(s.source, 'sem origem: ' + s.slug);
    assert.ok(s.name && s.description && s.body.length > 200, 'incompleta: ' + s.slug);
    assert.ok(!/\bfs\.write\b|\bweb_fetch\b|\bshell\.exec\b|WORKBENCH|CABINET/.test(s.body), 'ferramenta do StarNet sobrou em ' + s.slug);
    for (const r of s.requires) assert.ok(['web', 'shell', 'notebook', 'captain'].includes(r), s.slug + ' requer ' + r);
  }
  const slugs = new Set(lib.map(s => s.slug));
  for (const name of ['Capitão', 'Pesquisadora', 'Redator', 'Revisor', 'Engenheira', 'Qualquer um']) {
    const d = defaultSkills({ name, captain: name === 'Capitão', role: name === 'Redator' ? 'transforma pesquisas em textos' : '' });
    assert.ok(d.length >= 3, name);
    for (const x of d) assert.ok(slugs.has(x), name + ' → ' + x + ' não existe');
  }
  assert.ok(defaultSkills({ name: 'Redator', role: 'transforma pesquisas' }).includes('humanizer'));
});

test('receitas: catálogo válido, preenchimento e campos de receita própria', () => {
  const ids = new Set();
  const slugs = new Set(library().map(s => s.slug));
  for (const r of CATALOG) {
    assert.ok(!ids.has(r.id), 'id repetido ' + r.id); ids.add(r.id);
    assert.ok(r.name && r.emoji && r.category && r.task && r.blurb, r.id);
    const keys = new Set(r.params.map(p => p.key));
    for (const k of (r.task.match(/\{([a-z0-9_]+)\}/g) || [])) assert.ok(keys.has(k.slice(1, -1)), r.id + ' usa ' + k + ' sem campo');
    for (const s of r.skills) assert.ok(slugs.has(s), r.id + ' cita habilidade inexistente ' + s);
  }
  assert.ok(CATALOG.length >= 30);
  assert.equal(fill('Oi {nome}, {x}', { nome: 'Marcio' }), 'Oi Marcio, (não informado)');
  assert.deepEqual(paramsFromText('Leia {arquivo} de {periodo} e {arquivo}').map(p => p.key), ['arquivo', 'periodo']);
});

test('ranking do caderno acha pela palavra e prefere a mais relevante', () => {
  const n = (id, title, body) => ({ id, title, body, pinned: false, updated_at: '2026-01-0' + id.length });
  const r = rank([n('a', 'Frete', 'Frete grátis acima de R$ 199 na loja K2e'), n('bb', 'Senha do wifi', 'trocar em outubro'), n('ccc', 'Loja', 'A loja usa frete por transportadora')], 'frete grátis');
  assert.equal(r[0].id, 'a');
  assert.equal(r.length, 2);
  assert.equal(rank([n('a', 'x', 'y')], 'nada').length, 0);
});

test('habilidades, caderno e receitas funcionando com a tripulação', async () => {
  const t = await boot({
    Pesquisadora: [
      { tools: [{ name: 'skill_view', args: { slug: 'web-research' } }, { name: 'notebook_write', args: { title: 'Fonte boa', body: 'O IBGE publica dados de varejo todo mês. chave sk-ant-abcdefghijklmnop1234', pinned: true } }] },
      { tools: [{ name: 'notebook_read', args: { query: 'varejo IBGE' } }, { name: 'skill_propose', args: { name: 'Pesquisa de preço no Brasil', description: 'Comparar preços em lojas BR', body: '1. Buscar em 3 lojas\n2. Somar frete' } }] },
      { text: 'Feito.' },
      { text: 'Resumo pronto.' }
    ]
  });
  try {
    const P = t.id.Pesquisadora;
    // estado traz habilidades efetivas
    let st = (await t.api('GET', '/api/state')).body;
    const pesq = st.agents.find(a => a.id === P);
    assert.ok(pesq.skills_on.includes('web-research'));
    assert.equal(pesq.skills, null);
    assert.ok(!st.agents.find(a => a.name === 'Redator').skills_on.includes('systematic-debugging'));
    // Engenheira sem terminal disponível não recebe habilidade que exige shell? (ela tem shell=true, então recebe)
    assert.ok(st.agents.find(a => a.name === 'Engenheira').skills_on.includes('systematic-debugging'));

    await t.api('POST', '/api/agents/' + P + '/message', { text: 'pesquise varejo' });
    await t.waitFor(e => e.type === 'run_end' && e.agentId === P, 6000);
    const first = t.seen.find(s => s.agent === 'Pesquisadora');
    const sys = first.messages[0].content;
    assert.match(sys, /web-research:/, 'índice de habilidades no prompt');
    assert.ok(first.tools.includes('skill_view') && first.tools.includes('notebook_write') && first.tools.includes('skill_propose'));
    // a nota foi salva, sem o segredo
    let notes = (await t.api('GET', '/api/notes?agent=' + P)).body;
    assert.equal(notes.length, 1);
    assert.ok(notes[0].pinned);
    assert.ok(!notes[0].body.includes('sk-ant-'), 'segredo apagado');
    // notebook_read achou a nota; a proposta ficou pendente
    const toolMsgs = t.seen.filter(s => s.agent === 'Pesquisadora').pop().messages.filter(m => m.role === 'tool').map(m => m.content).join('\n');
    assert.match(toolMsgs, /IBGE/);
    assert.match(toolMsgs, /Método|Research|research/i, 'skill_view devolveu o método');
    st = (await t.api('GET', '/api/state')).body;
    assert.equal(st.skillsPending, 1);
    let lib = (await t.api('GET', '/api/skills')).body;
    const prop = lib.find(s => s.status === 'proposta');
    assert.equal(prop.slug, 'pesquisa-de-preco-no-brasil');
    await t.api('POST', '/api/skills/' + prop.slug + '/approve');
    lib = (await t.api('GET', '/api/skills')).body;
    assert.equal(lib.find(s => s.slug === prop.slug).status, 'ativa');
    assert.equal((await t.api('DELETE', '/api/skills/web-research')).status, 400, 'biblioteca não se apaga');

    // ligar/desligar habilidades por tripulante
    let r = await t.api('PATCH', '/api/agents/' + P, { skills: ['humanizer', 'nao-existe', prop.slug] });
    assert.deepEqual(r.body.skills, ['humanizer', prop.slug]);
    r = await t.api('PATCH', '/api/agents/' + P, { skills: null });
    assert.equal(r.body.skills, null);

    // na próxima conversa, a nota fixada entra no prompt
    await t.api('POST', '/api/agents/' + P + '/message', { text: 'de novo' });
    await t.waitFor(e => e.type === 'run_end' && e.agentId === P && e.runId !== undefined && t.events.filter(x => x.type === 'run_end' && x.agentId === P).length >= 2, 6000);
    const last = t.seen.filter(s => s.agent === 'Pesquisadora').pop();
    assert.match(last.messages[0].content, /notas fixadas[\s\S]*IBGE/);

    // caderno pelo painel: nota da tripulação, correção com histórico, exportar e restaurar só acrescentando
    const n2 = (await t.api('POST', '/api/notes', { shared: true, title: 'Fuso', body: 'O comandante está em São Paulo' })).body;
    assert.equal(n2.agent_id, '*');
    const up = (await t.api('PATCH', '/api/notes/' + n2.id, { body: 'O comandante está em São Paulo (UTC-3)' })).body;
    assert.equal(up.history.length, 1);
    const exp = (await t.api('GET', '/api/notes/export?agent=' + P)).body;
    assert.equal(exp.notes.length, 2, 'exporta as dele + as da tripulação');
    const res = (await t.api('POST', '/api/notes/restore', { agent_id: P, notes: exp.notes.concat([{ title: 'nova', body: 'nota vinda do backup' }, { body: '' }]) })).body;
    assert.deepEqual(res, { added: 1, kept: 2, skipped: 1 });
    assert.equal((await t.api('GET', '/api/notes?agent=all')).body.length, 3);

    // receitas: rodar manda para o tripulante certo; faltando campo = 400; rotina cria agendamento
    const recs = (await t.api('GET', '/api/recipes')).body;
    assert.ok(recs.length >= 30);
    assert.equal((await t.api('POST', '/api/recipes/checar-fato/run', { values: {} })).status, 400);
    const run = (await t.api('POST', '/api/recipes/checar-fato/run', { values: { afirmacao: 'O Brasil tem 27 unidades federativas' } }));
    assert.equal(run.status, 202);
    assert.equal(run.body.agentName, 'Pesquisadora');
    await t.waitFor(e => e.type === 'run_end' && e.runId === run.body.runId, 6000);
    const recipeMsg = t.seen.filter(s => s.agent === 'Pesquisadora').pop().messages.find(m => m.role === 'user' && /Receita: .*Checar um fato/.test(m.content));
    assert.ok(recipeMsg && /27 unidades/.test(recipeMsg.content) && /source-triangulation/.test(recipeMsg.content));
    const rot = await t.api('POST', '/api/recipes/boletim/run', { values: { assunto: 'IA', periodo: 'última semana' }, routine: { cron: '0 8 * * 1' } });
    assert.equal(rot.status, 201);
    assert.equal(rot.body.schedule.cron, '0 8 * * 1');
    assert.match(rot.body.schedule.prompt, /IA/);
    // receita própria com {campos}
    const mine = (await t.api('POST', '/api/recipes', { name: 'Vendas', task: 'Resuma as vendas de {periodo}', steps: 'somar\nordenar', to: 'captain' })).body;
    assert.deepEqual(mine.params.map(p => p.key), ['periodo']);
    assert.equal((await t.api('DELETE', '/api/recipes/resumir')).status, 400);
    assert.equal((await t.api('DELETE', '/api/recipes/' + mine.id)).status, 200);
  } finally { await t.close(); }
});
