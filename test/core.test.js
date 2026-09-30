'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-server.js');
const { getConfig } = require('../server/config.js');
const { createAgent } = require('../server/agent.js');
const { makeJail } = require('../server/tools/fs.js');
const { isPrivateHost } = require('../server/tools/basic.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'st1-')); }

function cfgFor(url, extra) {
  return getConfig(Object.assign({
    PROVIDER: 'freellmapi', FREELLMAPI_BASE_URL: url + '/v1', FREELLMAPI_KEY: 'freellmapi-teste', FREELLMAPI_MODEL: 'auto',
    WORKSPACE: tmpDir(), MAX_STEPS: '6'
  }, extra || {}));
}

test('FreeLLMAPI é o provedor padrão', () => {
  const c = getConfig({});
  assert.equal(c.provider.name, 'freellmapi');
  assert.equal(c.provider.baseUrl, 'http://localhost:3001/v1');
  assert.equal(c.provider.model, 'auto:smart');
});

test('loop: ferramenta em streaming (args em pedaços) → resultado → resposta final', async () => {
  const mock = await startMock([
    { tools: [{ name: 'write_file', args: { path: 'notas/oi.txt', content: 'olá, estação' } }] },
    { text: 'Arquivo criado com sucesso.' }
  ]);
  try {
    const cfg = cfgFor(mock.url);
    const agent = createAgent(cfg);
    const events = [];
    const r = await agent.send('crie o arquivo', { onEvent: e => events.push(e) });
    assert.equal(r.text, 'Arquivo criado com sucesso.');
    assert.equal(r.steps, 2);
    assert.equal(fs.readFileSync(path.join(cfg.workspace, 'notas/oi.txt'), 'utf8'), 'olá, estação');
    assert.ok(events.some(e => e.type === 'tool_result' && e.ok));
    assert.deepEqual(r.usage, { input: 20, output: 10 });
    // a chave vai no header e o resultado da ferramenta volta no formato OpenAI
    assert.equal(mock.calls[0].headers.authorization, 'Bearer freellmapi-teste');
    const second = mock.calls[1].body.messages;
    assert.equal(second[second.length - 1].role, 'tool');
    assert.equal(second[second.length - 2].tool_calls[0].function.name, 'write_file');
    assert.ok(events.some(e => e.type === 'model' && e.routedVia === 'mock/mock-model'));
  } finally { await mock.close(); }
});

test('histórico continua entre mensagens', async () => {
  const mock = await startMock([{ text: 'Primeira.' }, { text: 'Segunda.' }]);
  try {
    const agent = createAgent(cfgFor(mock.url));
    await agent.send('um');
    await agent.send('dois');
    const msgs = mock.calls[1].body.messages.map(m => m.role);
    assert.deepEqual(msgs, ['system', 'user', 'assistant', 'user']);
  } finally { await mock.close(); }
});

test('Anthropic: tool_use em streaming e tool_result de volta', async () => {
  const mock = await startMock([
    { text: 'Vou ver a hora.', tools: [{ name: 'get_time', args: { timezone: 'America/Sao_Paulo' } }] },
    { text: 'Pronto.' }
  ]);
  try {
    const cfg = cfgFor(mock.url, { PROVIDER: 'anthropic', ANTHROPIC_BASE_URL: mock.url + '/v1', ANTHROPIC_API_KEY: 'sk-teste' });
    const r = await createAgent(cfg).send('que horas são?');
    assert.equal(r.text, 'Pronto.');
    const body = mock.calls[1].body;
    assert.ok(body.system.includes('Star Trek 1'));
    const last = body.messages[body.messages.length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.content[0].type, 'tool_result');
    assert.equal(last.content[0].tool_use_id, 'toolu_1');
    assert.equal(mock.calls[0].headers['x-api-key'], 'sk-teste');
  } finally { await mock.close(); }
});

test('fallback: provedor principal com 500 → cai no secundário', async () => {
  const bad = await startMock([{ status: 500, message: 'caiu' }]);
  const good = await startMock([{ text: 'Respondi pelo fallback.' }]);
  try {
    const cfg = cfgFor(bad.url, { FALLBACK_PROVIDER: 'openai', OPENAI_BASE_URL: good.url + '/v1', OPENAI_MODEL: 'mock' });
    const agent = createAgent(cfg, { log: () => {}, retries: 0 });   // sem espera de retentativa no teste
    const events = [];
    const r = await agent.send('oi', { onEvent: e => events.push(e) });
    assert.equal(r.text, 'Respondi pelo fallback.');
    assert.ok(events.some(e => e.type === 'model' && e.provider === 'openai'));
  } finally { await bad.close(); await good.close(); }
});

test('erro 401 não fica tentando de novo e explica o motivo', async () => {
  const mock = await startMock([{ status: 401, message: 'chave inválida' }]);
  try {
    const agent = createAgent(cfgFor(mock.url), { log: () => {} });
    await assert.rejects(agent.send('oi'), /HTTP 401.*chave/);
    assert.equal(mock.calls.length, 1);
    assert.equal(agent.messages.length, 1, 'pergunta que falhou sai do histórico');
  } finally { await mock.close(); }
});

test('limite de passos: para e pede um resumo sem ferramentas', async () => {
  const mock = await startMock([
    { tools: [{ name: 'list_files', args: { path: '.' } }] },
    { tools: [{ name: 'get_time', args: {} }] },
    { text: 'Resumo final.' }
  ]);
  try {
    const cfg = cfgFor(mock.url, { MAX_STEPS: '2' });
    const r = await createAgent(cfg).send('faça algo');
    assert.equal(r.stopped, 'limit');
    assert.equal(r.text, 'Resumo final.');
    assert.equal(mock.calls[2].body.tools, undefined);
  } finally { await mock.close(); }
});

test('cela de arquivos recusa fugas', () => {
  const root = tmpDir();
  const jail = makeJail(root);
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'C:\\Windows']) assert.throws(() => jail.resolve(bad), /fora|relativos/, bad);
  assert.ok(jail.resolve('sub/novo.txt').startsWith(jail.root));
  const outside = tmpDir();
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => jail.resolve('link/segredo.txt'), /link simbólico/);
});

test('ferramenta com argumentos inválidos devolve erro ao modelo em vez de quebrar', async () => {
  const mock = await startMock([
    { tools: [{ name: 'read_file', args: {} }] },
    { tools: [{ name: 'ferramenta_que_nao_existe', args: {} }] },
    { text: 'Ok, entendi.' }
  ]);
  try {
    const events = [];
    const r = await createAgent(cfgFor(mock.url)).send('leia', { onEvent: e => events.push(e) });
    assert.equal(r.text, 'Ok, entendi.');
    const results = events.filter(e => e.type === 'tool_result');
    assert.match(results[0].output, /falta o campo "path"/);
    assert.match(results[1].output, /Ferramenta inexistente/);
  } finally { await mock.close(); }
});

test('fetch_url bloqueia endereços locais', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '::1']) assert.ok(isPrivateHost(h), h);
  assert.ok(!isPrivateHost('example.com'));
});

test('web_search: lê os resultados do DuckDuckGo (links reais, sem anúncios)', () => {
  const { parseDuckResults } = require('../server/tools/basic.js');
  const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fa%3Fx%3D1&amp;rut=z">Título <b>A</b></a>' +
    '<a class="result__snippet" href="#">Trecho &amp; mais</a>' +
    '<a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Anúncio</a>' +
    '<a class="result__a" href="https://b.com/">B</a>';
  const r = parseDuckResults(html);
  assert.deepEqual(r.map(x => x.url), ['https://exemplo.com/a?x=1', 'https://b.com/']);
  assert.equal(r[0].title, 'Título A');
  assert.equal(r[0].snippet, 'Trecho & mais');
});

test('contexto enxuto: corta histórico antigo sem deixar ferramenta órfã e encolhe resultados velhos', () => {
  const { compactForModel } = require('../server/loop.js');
  const msgs = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: 'p' + i });
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, name: 'x', args: '{}' }] });
    msgs.push({ role: 'tool', tool_call_id: 'c' + i, content: 'R'.repeat(5000) });
    msgs.push({ role: 'assistant', content: 'r' + i });
  }
  const out = compactForModel(msgs, 10);
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].role, 'user', 'começa numa pergunta');
  assert.ok(out.length <= 11);
  const tools = out.filter(m => m.role === 'tool');
  assert.ok(tools.slice(0, -1).every(t => t.content.length < 700), 'antigos encolhidos');
  assert.equal(tools[tools.length - 1].content.length, 5000, 'turno atual intacto');
  assert.equal(msgs[3].content.length, 5000, 'histórico original não é alterado');
});
