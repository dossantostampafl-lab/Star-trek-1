'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfig } = require('../server/config.js');
const { start } = require('../server/index.js');
const { checkFile, mentionedFiles } = require('../server/verify.js');
const { excerptFor, diffLines, DONE_RE } = require('../server/jobs.js');
const { assertPublicHost } = require('../server/tools/basic.js');
const voice = require('../server/voice.js');
const { chunk } = require('../server/channels/hub.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st1w-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  extra = extra || {};
  const dir = tmp();
  const seen = [], events = [], waiters = [];
  let clock = (extra && extra.clock) || null;
  const srv = await start(Object.assign({
    config: getConfig({ WORKSPACE: dir + '/ws', DATA_DIR: dir + '/data', SEED_CREW: '1' }),
    port: 0, log: () => {}, retries: 0, tickMs: 60000, nightTickMs: 3600e3, shellAvailable: false,
    providerFor: scripted(scripts, seen), now: clock ? () => clock.t : undefined, noChannels: true, browser: null, questionWaitMs: 3000
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


test('conferência de arquivos: vazio, formato falso, marcadores, CSV, links', () => {
  const d = tmp();
  const f = (n, c) => { fs.writeFileSync(path.join(d, n), c); return path.join(d, n); };
  assert.equal(checkFile(path.join(d, 'nao.md')).verdict, 'falhou');
  assert.equal(checkFile(f('vazio.md', '')).verdict, 'falhou');
  assert.equal(checkFile(f('falso.pdf', 'isto não é pdf')).verdict, 'falhou');
  assert.equal(checkFile(f('bom.md', '# Relatório\n\nTexto completo com conteúdo suficiente, fonte: https://ibge.gov.br')).verdict, 'ok');
  assert.equal(checkFile(f('todo.md', '# Relatório\n\nTODO escrever a conclusão aqui depois de revisar tudo')).verdict, 'aviso');
  assert.equal(checkFile(f('x.json', '{quebrado')).verdict, 'falhou');
  assert.equal(checkFile(f('t.csv', 'a,b,c\n1,2,3\n4,5\n6,7,8\n9\n')).verdict, 'aviso');
  assert.equal(checkFile(f('s.md', 'Resumo sem nenhum link mas com texto suficiente para passar.'), { promisesLinks: true }).verdict, 'aviso');
  assert.deepEqual(mentionedFiles('Salvei em relatorios/2026-ia.md e `dados.csv`. Veja https://site.com/x.html'), ['relatorios/2026-ia.md', 'dados.csv']);
});

test('vigia: trecho por palavra-chave, linhas novas e marcador de concluído', () => {
  assert.equal(excerptFor('a\nPreço R$ 10\nb\nc\nd', 'preço'), 'a\nPreço R$ 10\nb');
  assert.deepEqual(diffLines('a\nb', 'a\nb\nc'), ['c']);
  assert.ok(DONE_RE.test('Terminei o capítulo 12.\n\nCONCLUÍDO'));
  assert.ok(DONE_RE.test('ok\n**CONCLUIDO**'));
  assert.ok(!DONE_RE.test('ainda não CONCLUÍDO, falta revisar'));
});

test('rede interna bloqueada (nomes de container, localhost, IPs privados)', async () => {
  for (const h of ['star-trek-freellmapi', 'localhost', '127.0.0.1', '10.0.0.5', '192.168.0.1', '[::1]', 'caddy']) {
    await assert.rejects(assertPublicHost(h), /interno|locais|privados|rede interna/, h);
  }
  await assertPublicHost('8.8.8.8');
});

test('voz: texto falável, token do Edge e transcrição num endpoint compatível', async () => {
  assert.equal(voice.speakable('# Título\n**negrito** [site](https://x.com) `x`'), 'Título negrito site x');
  assert.match(voice.secMsGec(1790000000000), /^[0-9A-F]{64}$/);
  assert.equal(voice.secMsGec(1790000000000), voice.secMsGec(1790000050000), 'mesma janela de 5 min');
  const db = { s: { stt_api_key: 'gsk_teste' }, getSetting(k, d) { return this.s[k] || d; } };
  let got;
  const text = await voice.transcribe(db, Buffer.from('audio'), 'audio/ogg', { fetch: async (url, o) => { got = { url, o }; return new Response(JSON.stringify({ text: ' olá estação ' }), { status: 200 }); } });
  assert.equal(text, 'olá estação');
  assert.match(got.url, /api\.groq\.com\/openai\/v1\/audio\/transcriptions$/);
  assert.equal(got.o.headers.authorization, 'Bearer gsk_teste');
  await assert.rejects(voice.transcribe({ getSetting: (k, d) => d }, Buffer.from('x'), 'audio/ogg'), /sem chave/);
  assert.deepEqual(chunk('a'.repeat(10), 4).map(x => x.length), [4, 4, 2]);
});

test('pergunta antes de adivinhar: espera resposta, expira com padrão, noite não espera', async () => {
  const t = await boot({
    Pesquisadora: [
      { tools: [{ name: 'ask_commander', args: { question: 'Relatório para qual público?', options: ['Técnico', 'Executivo'], default: 'Executivo' } }] },
      { text: 'Ok, versão técnica.' },
      { tools: [{ name: 'ask_commander', args: { question: 'Formato?', options: ['PDF', 'MD'], default: 'MD' } }] },
      { text: 'Segui com MD.' }
    ]
  }, { overrides: { questionWaitMs: 1500 } });
  try {
    const P = t.id.Pesquisadora;
    await t.api('POST', '/api/agents/' + P + '/message', { text: 'faça o relatório' });
    const q = await t.waitFor(e => e.type === 'question', 4000);
    assert.deepEqual(q.options, ['Técnico', 'Executivo']);
    assert.equal((await t.api('GET', '/api/state')).body.questionsOpen, 1);
    const r = await t.api('POST', '/api/questions/' + q.id + '/answer', { answer: 'Técnico' });
    assert.equal(r.body.status, 'respondida');
    await t.waitFor(e => e.type === 'run_end' && e.agentId === P, 4000);
    const msgs = t.seen.filter(s => s.agent === 'Pesquisadora')[1].messages;
    assert.ok(msgs.some(m => m.role === 'tool' && /Resposta do comandante: Técnico/.test(m.content)));
    // segunda: ninguém responde → segue com o padrão
    await t.api('POST', '/api/agents/' + P + '/message', { text: 'outro' });
    await t.waitFor(e => e.type === 'question_expired', 5000);
    await t.waitFor(e => e.type === 'run_end' && e.agentId === P && t.events.filter(x => x.type === 'run_end' && x.agentId === P).length >= 2, 5000);
    const last = t.seen.filter(s => s.agent === 'Pesquisadora').pop().messages;
    assert.ok(last.some(m => m.role === 'tool' && /Siga com "MD"/.test(m.content)));
    assert.equal((await t.api('POST', '/api/questions/' + q.id + '/answer', { answer: 'x' })).status, 400, 'não responde duas vezes');
  } finally { await t.close(); }
});

test('entregas: deliver confere o arquivo, avisa arquivo prometido que não existe e refazer volta ao tripulante', async () => {
  const t = await boot({
    Redator: [
      { tools: [{ name: 'write_file', args: { path: 'relatorios/guia.md', content: '# Guia\n\nTODO terminar esta parte com calma depois.' } }, { name: 'deliver', args: { path: 'relatorios/guia.md', title: 'Guia de IA', summary: 'guia com fontes' } }] },
      { text: 'Entreguei. Também salvei em relatorios/extra.md.' },
      { tools: [{ name: 'write_file', args: { path: 'relatorios/guia.md', content: '# Guia\n\nVersão final completa com fonte https://exemplo.org e conclusão.' } }, { name: 'deliver', args: { path: 'relatorios/guia.md', title: 'Guia de IA', summary: 'guia com fontes' } }] },
      { text: 'Refeito.' }
    ]
  });
  try {
    const R = t.id.Redator;
    await t.api('POST', '/api/agents/' + R + '/message', { text: 'escreva o guia' });
    const ev = await t.waitFor(e => e.type === 'deliverable', 5000);
    assert.equal(ev.verdict, 'aviso');
    const miss = await t.waitFor(e => e.type === 'claim_missing', 5000);
    assert.deepEqual(miss.files, ['relatorios/extra.md']);
    let list = (await t.api('GET', '/api/deliverables')).body;
    assert.equal(list.length, 1);
    assert.ok(list[0].checks.some(c => c.name === 'sem marcadores esquecidos' && !c.ok));
    const dl = await fetch(t.srv.url + '/api/deliverables/' + list[0].id + '/download', { headers: { 'x-st1-token': t.srv.token } });
    assert.match(await dl.text(), /TODO terminar/);
    assert.equal((await t.api('GET', '/api/state')).body.deliverablesNew, 1);
    // refazer → o pedido volta com o motivo e a conferência
    await t.api('POST', '/api/deliverables/' + list[0].id + '/redo', { feedback: 'termine a conclusão' });
    await t.waitFor(e => e.type === 'deliverable' && e.updated, 5000);
    list = (await t.api('GET', '/api/deliverables')).body;
    assert.equal(list.length, 1, 'mesma entrega atualizada, não duplicada');
    assert.equal(list[0].verdict, 'ok');
    const redoMsg = t.seen.filter(s => s.agent === 'Redator')[2].messages.find(m => m.role === 'user' && /REFAZER/.test(m.content));
    assert.ok(redoMsg && /termine a conclusão/.test(redoMsg.content) && /marcadores/.test(redoMsg.content));
    await t.api('POST', '/api/deliverables/' + list[0].id + '/accept');
    assert.equal((await t.api('GET', '/api/deliverables')).body[0].status, 'aceita');
  } finally { await t.close(); }
});

test('agenda: repetir até CONCLUÍDO e vigiar site com mudança', async () => {
  let page = 'Loja\nPreço: R$ 100\nrodapé';
  const t = await boot({
    Engenheira: [{ text: 'Fiz a parte 1.' }, { text: 'Fiz a parte 2.\n\nCONCLUÍDO' }],
    Pesquisadora: [{ text: 'O preço caiu, vale comprar.' }]
  }, { overrides: { jobsTickMs: 3600e3, fetchPage: async () => page } });
  try {
    const E = t.id.Engenheira, P = t.id.Pesquisadora;
    const j = (await t.api('POST', '/api/jobs', { kind: 'loop', agent_id: E, prompt: 'traduza o livro', interval_min: 5, max_runs: 5 })).body;
    assert.equal(j.interval_min, 5);
    await t.api('POST', '/api/jobs/' + j.id + '/run');
    await t.waitFor(e => e.type === 'run_end' && e.agentId === E, 4000);
    await sleep(50);
    let jj = (await t.api('GET', '/api/jobs')).body.find(x => x.id === j.id);
    assert.equal(jj.runs, 1); assert.equal(jj.status, 'ativo'); assert.equal(jj.last_run_id, null);
    await t.api('POST', '/api/jobs/' + j.id + '/run');
    await t.waitFor(e => e.type === 'job_update' && e.status === 'concluido', 4000);
    jj = (await t.api('GET', '/api/jobs')).body.find(x => x.id === j.id);
    assert.equal(jj.status, 'concluido');
    assert.match(t.seen.filter(s => s.agent === 'Engenheira')[0].messages.find(m => m.role === 'user').content, /rodada 1 de no máximo 5/);
    // vigia
    assert.equal((await t.api('POST', '/api/jobs', { kind: 'watch', url: 'nada' })).status, 400);
    const w = (await t.api('POST', '/api/jobs', { kind: 'watch', url: 'https://loja.exemplo.com/produto', keyword: 'preço', interval_min: 10, agent_id: P, prompt: 'diga se vale comprar' })).body;
    await t.api('POST', '/api/jobs/' + w.id + '/run');
    await t.waitFor(e => e.type === 'job_update' && /ligada/.test(e.message), 3000);
    await t.api('POST', '/api/jobs/' + w.id + '/run');
    assert.ok(!t.events.some(e => e.type === 'job_update' && e.status === 'mudou'), 'sem mudança, sem aviso');
    page = 'Loja NOVA\nPreço: R$ 80\nrodapé';
    await t.api('POST', '/api/jobs/' + w.id + '/run');
    const ch = await t.waitFor(e => e.type === 'job_update' && e.status === 'mudou', 3000);
    assert.match(ch.message, /R\$ 80/);
    await t.waitFor(e => e.type === 'run_end' && e.agentId === P, 4000);
    const um = t.seen.find(s => s.agent === 'Pesquisadora').messages.find(m => m.role === 'user').content;
    assert.match(um, /MUDOU[\s\S]*R\$ 80[\s\S]*diga se vale comprar/);
  } finally { await t.close(); }
});

// Telegram falso: guarda o que a estação manda e entrega as mensagens que o "comandante" escreve
function fakeTelegram() {
  const inbox = [], sent = [];
  let id = 100, upd = 1;
  const api = async (method, params) => {
    if (method === 'getMe') return { username: 'estacao_bot', first_name: 'Estação' };
    if (method === 'getUpdates') { const out = inbox.splice(0); if (!out.length) await sleep(15); return out; }
    if (method === 'getFile') return { file_path: 'voice/1.ogg' };
    const p = params instanceof FormData ? Object.fromEntries([...params.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '[arquivo]'])) : params;
    sent.push({ method, params: p });
    return { message_id: ++id };
  };
  const push = (msg) => inbox.push(Object.assign({ update_id: upd++ }, msg));
  const say = (text, extra) => push({ message: Object.assign({ message_id: 1, from: { id: 42, first_name: 'Marcio' }, chat: { id: 42 }, text }, extra || {}) });
  const click = (data) => push({ callback_query: { id: 'cb' + upd, from: { id: 42 }, message: { chat: { id: 42 }, message_id: 5 }, data } });
  const waitSent = async (pred, ms) => { const end = Date.now() + (ms || 4000); while (Date.now() < end) { const f = sent.find(pred); if (f) return f; await sleep(20); } throw new Error('Telegram não recebeu: ' + JSON.stringify(sent.slice(-3))); };
  return { api, download: async () => Buffer.from('OggS audio'), say, click, push, sent, waitSent };
}

test('Telegram: pareia, conversa com o Capitão, recebe resultado da esteira, responde pergunta e aceita entrega por botão', async () => {
  const tg = fakeTelegram();
  const t = await boot({
    'Capitão': [{ text: 'Oi, comandante!' }, { text: 'Entendi o áudio.' }, { text: 'Resultado final: tudo pronto.' }],
    Pesquisadora: [
      { tools: [{ name: 'ask_commander', args: { question: 'Qual país?', options: ['Brasil', 'EUA'] } }] },
      { tools: [{ name: 'write_file', args: { path: 'r.md', content: '# Pesquisa\n\nConteúdo completo com fontes https://ibge.gov.br e mais texto.' } }, { name: 'deliver', args: { path: 'r.md', title: 'Pesquisa' } }] },
      { text: 'Pesquisa entregue.' }
    ]
  }, { overrides: { noChannels: false, telegram: { api: tg.api, download: tg.download, pollTimeout: 0 }, transcribe: async () => 'status da estação', questionWaitMs: 4000 } });
  try {
    // sem token não conecta; com token, conecta
    let r = await t.api('PUT', '/api/channels/telegram', { token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    assert.equal(r.status, 200); assert.equal(r.body.connected, true); assert.equal(r.body.bot, '@estacao_bot');
    // estranho sem código: ignorado
    tg.say('olá');
    await tg.waitSent(s => /parear/.test(s.params.text || ''));
    const code = (await t.api('POST', '/api/channels/telegram/pair')).body.code;
    tg.say('/start ' + code);
    await tg.waitSent(s => /Estação pareada/.test(s.params.text || ''));
    assert.equal((await t.api('GET', '/api/state')).body.channels.telegram.paired, true);
    // conversa comum → Capitão → resposta volta
    tg.say('bom dia');
    await tg.waitSent(s => /Oi, comandante!/.test(s.params.text || ''));
    // áudio → transcrito
    tg.push({ message: { message_id: 3, from: { id: 42 }, chat: { id: 42 }, voice: { file_id: 'v1', mime_type: 'audio/ogg' } } });
    await tg.waitSent(s => /🎙 “status da estação”/.test(s.params.text || ''));
    await tg.waitSent(s => /Entendi o áudio/.test(s.params.text || ''));
    // /status
    tg.say('/status');
    await tg.waitSent(s => /Você está falando com: Capitão/.test(s.params.text || ''));
    // /para Pesquisadora → pergunta com botões → clique responde
    tg.say('/para Pesquisadora pesquise mercado');
    const qmsg = await tg.waitSent(s => /Qual país\?/.test(s.params.text || ''));
    assert.equal(qmsg.params.reply_markup.inline_keyboard[0][0].text, 'Brasil');
    tg.click(qmsg.params.reply_markup.inline_keyboard[0][0].callback_data);
    await tg.waitSent(s => s.method === 'answerCallbackQuery' && /Resposta enviada/.test(s.params.text));
    // entrega chega como documento com botões; Aceitar pelo botão
    const doc = await tg.waitSent(s => s.method === 'sendDocument', 5000);
    assert.match(doc.params.caption, /Entrega de Pesquisadora: Pesquisa/);
    const kb = JSON.parse(doc.params.reply_markup);
    tg.click(kb.inline_keyboard[0][0].callback_data);
    await tg.waitSent(s => s.method === 'answerCallbackQuery' && s.params.text === 'Aceita');
    assert.equal((await t.api('GET', '/api/deliverables')).body[0].status, 'aceita');
    // a pesquisa respondeu direto ao canal (fonte "channel")
    await tg.waitSent(s => /Pesquisa entregue/.test(s.params.text || ''));
    // resultado que volta pela esteira ao Capitão também chega
    await tg.waitSent(s => /Resultado final — Capitão/.test(s.params.text || '') || /Resultado final: tudo pronto/.test(s.params.text || ''), 6000);
    // arquivo enviado pelo Telegram vai para entrada/
    tg.push({ message: { message_id: 9, from: { id: 42 }, chat: { id: 42 }, document: { file_id: 'd1', file_name: 'nota.txt' } } });
    await tg.waitSent(s => /Salvo em entrada\/nota\.txt/.test(s.params.text || ''));
    assert.ok(fs.existsSync(path.join(t.dir, 'ws', '_compartilhado', 'entrada', 'nota.txt')));
  } finally { await t.close(); }
});

test('Discord: pareia por mensagem direta e conversa', async () => {
  const sent = []; let gw = null; let mid = 500;
  const rest = async (method, p, body) => {
    if (p === '/users/@me') return { id: '999', username: 'estacao' };
    if (p === '/gateway/bot') return { url: 'wss://fake' };
    const b = body instanceof FormData ? { form: true } : body;
    sent.push({ method, p, body: b });
    return { id: String(++mid) };
  };
  const connectGateway = () => {
    gw = { sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} };
    setTimeout(() => { gw.onmessage({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }) }); gw.onmessage({ data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { user: { id: '999', username: 'estacao' } } }) }); }, 5);
    return gw;
  };
  const dm = (content) => gw.onmessage({ data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm' + Math.random(), channel_id: 'dm1', content, author: { id: '77', username: 'marcio' } } }) });
  const t = await boot({ 'Capitão': [{ text: 'Olá pelo Discord!' }] }, { overrides: { noChannels: false, discord: { rest, connectGateway } } });
  try {
    const r = await t.api('PUT', '/api/channels/discord', { token: 'x'.repeat(60) });
    assert.equal(r.status, 200);
    await sleep(40);
    assert.equal(gw.sent[0].op, 2, 'identificou no gateway');
    assert.equal((await t.api('GET', '/api/state')).body.channels.discord.connected, true);
    const code = (await t.api('POST', '/api/channels/discord/pair')).body.code;
    dm('meu código ' + code);
    await sleep(80);
    assert.ok(sent.some(s => /Estação pareada/.test((s.body && s.body.content) || '')));
    dm('oi');
    const end = Date.now() + 4000;
    while (Date.now() < end && !sent.some(s => /Olá pelo Discord!/.test((s.body && s.body.content) || ''))) await sleep(30);
    assert.ok(sent.some(s => s.p === '/channels/dm1/messages' && /Olá pelo Discord!/.test(s.body.content)));
  } finally { await t.close(); }
});

test('navegador: abre página com JavaScript, preenche formulário, tira foto e bloqueia rede interna', { skip: process.env.ST1_SKIP_BROWSER_TEST === '1' ? 'pulado no build' : !require('../server/tools/browser.js').findChrome() && 'Chromium não instalado' }, async () => {
  const http = require('node:http');
  const { makeBrowser, browserTools } = require('../server/tools/browser.js');
  const { makeJail } = require('../server/tools/fs.js');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url.startsWith('/busca')) return res.end('<p>Você buscou: ' + decodeURIComponent(req.url.split('q=')[1] || '') + '</p>');
    res.end('<title>Loja</title><div id=x></div><script>x.textContent="Preço via JS: R$ 99"</script><form action="/busca"><input name=q placeholder="Buscar"><button>Ir</button></form>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const real = makeBrowser();
  await assert.rejects(real.open('a', 'http://127.0.0.1:' + srv.address().port + '/'), /locais|privados|interna/);
  const b = makeBrowser({ check: async (h) => { if (h !== '127.0.0.1') throw new Error('bloqueado'); } });
  const dir = tmp();
  const [browse, act] = browserTools(b, { id: 'ag1' }, makeJail(dir));
  try {
    assert.equal(act.scope, 'external');
    assert.equal(act.server, 'navegador');
    const page = await browse.run({ action: 'open', url: 'http://127.0.0.1:' + srv.address().port + '/' });
    assert.match(page, /Preço via JS: R\$ 99/);
    assert.match(page, /\[1\] campo texto "Buscar"/);
    const after = await act.run({ action: 'type', ref: 1, text: 'capivara', submit: true });
    assert.match(after, /Você buscou: capivara/);
    assert.match(await browse.run({ action: 'screenshot', path: 'capturas/loja' }), /capturas\/loja\.png/);
    assert.ok(fs.statSync(path.join(dir, 'capturas', 'loja.png')).size > 1000);
  } finally { b.shutdown(); real.shutdown(); srv.close(); }
});
