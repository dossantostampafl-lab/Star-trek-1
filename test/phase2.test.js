'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-server.js');
const { getConfig } = require('../server/config.js');
const { createAgent } = require('../server/agent.js');
const { makeConsentBroker } = require('../server/permissions.js');
const { makeCheckpoints } = require('../server/checkpoint.js');
const { makeShellTool, redact } = require('../server/tools/shell.js');
const { costOf } = require('../server/cost.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st1p2-'));
const cfgFor = (url, extra) => getConfig(Object.assign({ FREELLMAPI_BASE_URL: url + '/v1', WORKSPACE: tmp(), MAX_STEPS: '6' }, extra || {}));
const shellTool = { name: 'shell', scope: 'execute' };
const mcpTool = { name: 'mcp__git__log', scope: 'external', server: 'git' };

test('permissões: leitura e escrita livres; terminal pergunta; automático nega', async () => {
  const asked = [];
  const b = makeConsentBroker({ prompt: async (q) => { asked.push(q); return 'once'; } });
  assert.equal((await b.authorize({ agentId: 'a' }, { name: 'read_file', scope: 'read' }, {})).allow, true);
  assert.equal((await b.authorize({ agentId: 'a' }, { name: 'write_file', scope: 'write' }, {})).allow, true);
  assert.equal((await b.authorize({ agentId: 'a', surface: 'interactive' }, shellTool, { args: '{}' })).allow, true);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].choices, ['once', 'session', 'deny'], 'terminal nunca oferece "sempre"');
  const auto = await b.authorize({ agentId: 'a', surface: 'autonomous' }, shellTool, {});
  assert.equal(auto.allow, false);
  assert.equal(asked.length, 1, 'automático não pergunta');
});

test('permissões: "sessão" vale só para aquele agente; "sempre" libera conector no automático', async () => {
  let answer = 'session';
  const b = makeConsentBroker({ prompt: async () => answer });
  await b.authorize({ agentId: 'a' }, shellTool, {});
  let n = 0;
  const b2prompt = makeConsentBroker({ prompt: async () => { n++; return 'deny'; } });
  assert.equal((await b2prompt.authorize({ agentId: 'x' }, shellTool, {})).allow, false);
  assert.equal(n, 1);
  // mesma sessão, mesmo agente → sem perguntar de novo
  answer = 'deny';
  assert.equal((await b.authorize({ agentId: 'a' }, shellTool, {})).allow, true);
  assert.equal((await b.authorize({ agentId: 'b' }, shellTool, {})).allow, false);
  // conector
  answer = 'always';
  assert.equal((await b.authorize({ agentId: 'a', surface: 'autonomous' }, mcpTool, {})).allow, false);
  assert.equal((await b.authorize({ agentId: 'a' }, mcpTool, {})).allow, true);
  assert.equal((await b.authorize({ agentId: 'a', surface: 'autonomous' }, mcpTool, {})).allow, true);
});

test('permissões: resposta inválida ou sem canal = negado', async () => {
  const b = makeConsentBroker({ prompt: async () => 'always' });   // "sempre" não é opção para terminal
  assert.equal((await b.authorize({ agentId: 'a' }, shellTool, {})).allow, false);
  const none = makeConsentBroker({});
  assert.equal((await none.authorize({ agentId: 'a' }, shellTool, {})).allow, false);
});

test('checkpoint: foto e restauração da pasta', () => {
  const ws = tmp();
  const cp = makeCheckpoints(tmp());
  fs.writeFileSync(path.join(ws, 'a.txt'), 'versão 1');
  const { id } = cp.create('ag1', ws, 'antes de mudar');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'versão 2');
  fs.writeFileSync(path.join(ws, 'lixo.txt'), 'x');
  cp.restore('ag1', id, ws);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'versão 1');
  assert.ok(!fs.existsSync(path.join(ws, 'lixo.txt')));
  assert.ok(cp.list('ag1').length >= 2, 'restaurar também cria checkpoint');
  for (let i = 0; i < 15; i++) cp.create('ag1', ws, 'n' + i);
  assert.equal(cp.list('ag1').length, 10);
});

test('terminal: roda no executor com a pasta do agente e remove segredos da saída', async () => {
  const seen = [];
  const tool = makeShellTool({ workspaceFor: (ctx) => ctx.workspace, runner: async (o) => { seen.push(o); return { code: 0, output: 'chave=sk-ant-abcdefghijklmnop123' }; } });
  const out = await tool.run({ command: 'env' }, { workspace: '/w/a1' });
  assert.equal(seen[0].workspace, '/w/a1');
  assert.match(out, /código de saída 0/);
  assert.ok(!out.includes('sk-ant-abcdefghijklmnop123'));
  assert.equal(redact('freellmapi-abc123456789'), '[segredo removido]');
});

test('loop: terminal negado vira erro para o modelo, com checkpoint só quando permitido', async () => {
  const mock = await startMock([
    { tools: [{ name: 'shell', args: { command: 'rm -rf *' } }] },
    { text: 'Entendido, não vou rodar.' }
  ]);
  try {
    const ran = [];
    const shell = makeShellTool({ workspaceFor: (c) => c.workspace, runner: async (o) => { ran.push(o); return { code: 0, output: '' }; } });
    const cps = [];
    const agent = createAgent(cfgFor(mock.url), {
      consent: makeConsentBroker({ prompt: async () => 'deny' }),
      checkpoints: { create: (...a) => { cps.push(a); return { id: 'x' }; } },
      extraTools: [shell]
    });
    const events = [];
    const r = await agent.send('apague tudo', { onEvent: e => events.push(e) });
    assert.equal(r.text, 'Entendido, não vou rodar.');
    assert.equal(ran.length, 0);
    assert.equal(cps.length, 0);
    assert.ok(events.some(e => e.type === 'denied'));
    const toolMsg = mock.calls[1].body.messages.find(m => m.role === 'tool');
    assert.match(toolMsg.content, /Permissão negada/);
  } finally { await mock.close(); }
});

test('loop: escrita cria checkpoint antes de executar', async () => {
  const mock = await startMock([{ tools: [{ name: 'write_file', args: { path: 'x.txt', content: 'novo' } }] }, { text: 'feito' }]);
  try {
    const cfg = cfgFor(mock.url);
    fs.writeFileSync(path.join(cfg.workspace, 'x.txt'), 'antigo');
    const cp = makeCheckpoints(tmp());
    const agent = createAgent(cfg, { checkpoints: cp, consent: makeConsentBroker({}) });
    await agent.send('escreva');
    const list = cp.list('cli');
    assert.equal(list.length, 1);
    cp.restore('cli', list[0].id, cfg.workspace);
    assert.equal(fs.readFileSync(path.join(cfg.workspace, 'x.txt'), 'utf8'), 'antigo');
  } finally { await mock.close(); }
});

test('orçamento: beforeStep interrompe a execução', async () => {
  const mock = await startMock([{ tools: [{ name: 'get_time', args: {} }] }, { text: 'nunca chega' }]);
  try {
    let steps = 0;
    const agent = createAgent(cfgFor(mock.url), { beforeStep: () => { if (++steps > 1) throw new Error('orçamento esgotado'); } });
    await assert.rejects(agent.send('oi'), /orçamento esgotado/);
    assert.equal(mock.calls.length, 1);
  } finally { await mock.close(); }
});

test('custo: FreeLLMAPI é zero; Sonnet cobra por token', () => {
  assert.equal(costOf('freellmapi', 'auto', { input: 1e6, output: 1e6 }).usd, 0);
  assert.equal(costOf('anthropic', 'claude-sonnet-5-5', { input: 1e6, output: 1e6 }).usd, 18);
  assert.equal(costOf('openai', 'modelo-desconhecido', { input: 5, output: 5 }).known, false);
});

test('provedor travado: a chamada desiste no tempo limite em vez de esperar para sempre', async () => {
  const http = require('node:http');
  const srv = http.createServer(() => { /* nunca responde */ });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const url = 'http://127.0.0.1:' + srv.address().port;
    const agent = createAgent(cfgFor(url), { retries: 0, timeoutMs: 300, log: () => {} });
    const t0 = Date.now();
    await assert.rejects(agent.send('oi'), /sem resposta em 0s|sem resposta/);
    assert.ok(Date.now() - t0 < 3000);
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});
