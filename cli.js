#!/usr/bin/env node
'use strict';
/* cli.js — linha de comando do Star Trek 1.
   npm run chat                → conversa interativa
   npm run ask -- "pergunta"   → uma pergunta e sai
   npm run check               → testa a conexão com o provedor */
const readline = require('node:readline');
const path = require('node:path');
const { loadEnv, getConfig } = require('./server/config.js');
const { createAgent } = require('./server/agent.js');
const { makeConsentBroker } = require('./server/permissions.js');
const { makeCheckpoints } = require('./server/checkpoint.js');
const { makeShellTool, dockerAvailable } = require('./server/tools/shell.js');

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: s => '\x1b[2m' + s + '\x1b[0m', cyan: s => '\x1b[36m' + s + '\x1b[0m', yellow: s => '\x1b[33m' + s + '\x1b[0m', red: s => '\x1b[31m' + s + '\x1b[0m', green: s => '\x1b[32m' + s + '\x1b[0m', bold: s => '\x1b[1m' + s + '\x1b[0m' }
  : new Proxy({}, { get: () => (s) => s });

function short(s, n) { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; }

function printer() {
  let midLine = false;
  return function onEvent(ev) {
    switch (ev.type) {
      case 'text': process.stdout.write(ev.text); midLine = !ev.text.endsWith('\n'); break;
      case 'tool_call':
        if (midLine) { process.stdout.write('\n'); midLine = false; }
        console.log(C.yellow('  ⚙ ' + ev.name + ' ') + C.dim(short(ev.args, 120)));
        break;
      case 'tool_result':
        console.log((ev.ok ? C.green('    ✓ ') : C.red('    ✗ ')) + C.dim(short(ev.output, 160)));
        break;
      case 'model':
        if (process.env.DEBUG) console.log(C.dim('  [' + ev.provider + ' · ' + (ev.routedVia || ev.model) + ']'));
        break;
      case 'denied':
        console.log(C.red('    ⛔ negado: ') + C.dim(ev.reason));
        break;
      case 'checkpoint':
        if (process.env.DEBUG) console.log(C.dim('    ↺ checkpoint ' + ev.id));
        break;
      case 'done':
        if (midLine) process.stdout.write('\n');
        midLine = false;
        console.log(C.dim('  — ' + ev.steps + ' passo(s), tokens ' + ev.usage.input + ' entrada / ' + ev.usage.output + ' saída' + (ev.limit ? ' · limite de passos atingido' : '')));
        break;
      default: break;
    }
  };
}

async function check(config) {
  const p = config.provider;
  console.log('Provedor: ' + C.bold(p.name) + '  URL: ' + p.baseUrl + '  Modelo: ' + p.model);
  if (p.kind === 'openai') {
    try {
      const res = await fetch(p.baseUrl.replace(/\/+$/, '') + '/models', { headers: p.apiKey ? { authorization: 'Bearer ' + p.apiKey } : {}, signal: AbortSignal.timeout(8000) });
      if (res.ok) { const j = await res.json(); console.log(C.green('✓ servidor respondeu') + ' — ' + ((j.data && j.data.length) || 0) + ' modelos no catálogo'); }
      else {
        console.log(C.red('✗ /models respondeu HTTP ' + res.status) + (res.status === 401 ? ' — o servidor pede chave' : ''));
        if (res.status === 401 && p.name === 'freellmapi') console.log('  A chave unificada (freellmapi-...) aparece no topo do painel do FreeLLMAPI. Cole em FREELLMAPI_KEY no .env.');
        return false;
      }
    } catch (e) {
      console.log(C.red('✗ não conectou em ' + p.baseUrl) + ' — ' + ((e.cause && e.cause.code) || e.message));
      if (p.name === 'freellmapi') console.log('  Inicie o FreeLLMAPI primeiro (ele escuta na porta 3001).');
      return false;
    }
  }
  const agent = createAgent(config, { system: 'Responda apenas: OK' });
  try {
    const r = await agent.send('Diga OK.', { });
    console.log(C.green('✓ chat funcionando') + ' — resposta: ' + short(r.text, 60));
    return true;
  } catch (e) {
    console.log(C.red('✗ chat falhou: ') + e.message);
    return false;
  }
}

async function main() {
  loadEnv();
  const config = getConfig();
  const argv = process.argv.slice(2);
  const log = (m) => console.log(C.dim('  ' + m));

  if (argv.includes('--check')) process.exit((await check(config)) ? 0 : 1);

  // Pedidos de permissão chegam aqui; a próxima linha digitada responde.
  let pendingConsent = null;
  let rl = null;
  const consent = makeConsentBroker({
    prompt: ({ tool, call, choices }) => new Promise(resolve => {
      const labels = { once: '[1] uma vez', session: '[2] nesta sessão', always: '[3] sempre', deny: '[n] negar' };
      console.log('\n' + C.yellow('  ⚠ O agente quer usar ' + C.bold(tool.name) + ':'));
      console.log('    ' + short(prettyArgs(call.args), 400));
      console.log('    ' + choices.map(c => labels[c]).join('  '));
      if (!rl) return resolve('deny');                       // modo --once sem terminal interativo
      pendingConsent = { choices, resolve };
      rl.setPrompt(C.yellow('  permitir? › '));
      rl.prompt();
    })
  });
  const checkpoints = makeCheckpoints(path.join(config.dataDir, 'checkpoints'));
  const extraTools = [];
  const shellOn = await dockerAvailable();
  if (shellOn) extraTools.push(makeShellTool({ workspaceFor: () => config.workspace, network: config.shellNetwork, image: config.shellImage }));

  const agent = createAgent(config, { log, consent, checkpoints, extraTools });
  const onceIdx = argv.indexOf('--once');
  if (onceIdx >= 0) {
    const q = argv.slice(onceIdx + 1).join(' ').trim();
    if (!q) { console.error('Uso: npm run ask -- "sua pergunta"'); process.exit(2); }
    try { await agent.send(q, { onEvent: printer() }); }
    catch (e) { console.error(C.red('Erro: ') + e.message); process.exit(1); }
    return;
  }

  console.log(C.cyan(C.bold('★ Star Trek 1')) + C.dim('  ·  ' + config.provider.name + ' / ' + config.provider.model + (config.fallback ? '  ·  fallback: ' + config.fallback.name : '')));
  console.log(C.dim('  Pasta de trabalho: ' + config.workspace));
  console.log(C.dim('  Terminal: ' + (shellOn ? 'ligado (container Docker)' : 'desligado — Docker não encontrado')));
  console.log(C.dim('  Comandos: /limpar  /ferramentas  /desfazer  /sair   ·   Ctrl+C cancela a resposta em andamento\n'));

  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.cyan('você › ') });
  const mainPrompt = C.cyan('você › ');
  let running = null;
  const total = { input: 0, output: 0 };

  const finish = () => {
    console.log(C.dim('Até a próxima. Tokens na sessão: ' + total.input + ' entrada / ' + total.output + ' saída.'));
    process.exit(0);
  };

  rl.on('SIGINT', () => {
    if (pendingConsent) { const p = pendingConsent; pendingConsent = null; rl.setPrompt(mainPrompt); p.resolve('deny'); }
    if (running) { running.abort(); console.log(C.dim('\n  (cancelado)')); }
    else rl.close();
  });
  rl.on('close', finish);

  rl.on('line', async (line) => {
    const text = line.trim();
    if (pendingConsent) {
      const map = { '1': 'once', '2': 'session', '3': 'always', 'n': 'deny', 's': 'once', 'sim': 'once', 'nao': 'deny', 'não': 'deny' };
      const d = map[text.toLowerCase()] || 'deny';
      const p = pendingConsent; pendingConsent = null;
      rl.setPrompt(mainPrompt);
      p.resolve(p.choices.includes(d) ? d : 'deny');
      return;
    }
    if (running) { console.log(C.dim('  (aguarde a resposta atual ou Ctrl+C para cancelar)')); return; }
    if (!text) { rl.prompt(); return; }
    if (text === '/sair' || text === '/exit') { rl.close(); return; }
    if (text === '/limpar') { agent.reset(); consent.revokeSession(); console.log(C.dim('  histórico e permissões da sessão limpos')); rl.prompt(); return; }
    if (text === '/ferramentas') { for (const t of agent.registry.list()) console.log('  ' + C.yellow(t.name) + C.dim(' — ' + t.description)); rl.prompt(); return; }
    if (text === '/desfazer') {
      const list = checkpoints.list('cli');
      if (!list.length) console.log(C.dim('  nenhum checkpoint ainda'));
      else { checkpoints.restore('cli', list[0].id, config.workspace); console.log(C.green('  pasta restaurada para antes de: ') + list[0].label); }
      rl.prompt(); return;
    }

    running = new AbortController();
    process.stdout.write(C.cyan('agente › '));
    try {
      const r = await agent.send(text, { signal: running.signal, onEvent: printer() });
      total.input += r.usage.input; total.output += r.usage.output;
    } catch (e) {
      if (e.name !== 'AbortError') console.log('\n' + C.red('Erro: ') + e.message);
    }
    running = null;
    console.log();
    rl.setPrompt(mainPrompt);
    rl.prompt();
  });

  rl.prompt();
}

function prettyArgs(a) { try { const o = JSON.parse(a); return o.command || JSON.stringify(o); } catch (_) { return String(a); } }

main().catch(e => { console.error(e); process.exit(1); });
