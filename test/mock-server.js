'use strict';
/* test/mock-server.js — servidor falso compatível com OpenAI e Anthropic para testar sem internet e sem custo.
   Recebe um "roteiro": uma lista de respostas, uma por chamada. */
const http = require('node:http');

function startMock(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      calls.push({ url: req.url, headers: req.headers, body: parsed });
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'auto' }, { id: 'mock-model' }] }));
      }
      const step = script[Math.min(calls.filter(c => c.url.match(/completions|messages/)).length - 1, script.length - 1)];
      if (step.status) { res.writeHead(step.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: step.message || 'erro' } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-routed-via': 'mock/mock-model' });
      const events = req.url.endsWith('/messages') ? anthropicEvents(step) : openaiEvents(step);
      for (const e of events) res.write(e);
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ url: 'http://127.0.0.1:' + port, calls, close: () => new Promise(r => server.close(r)) });
  }));
}

// Divide texto e argumentos em pedaços pequenos, como um stream real.
function chunks(s, n) { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; }

function openaiEvents(step) {
  const ev = [];
  const send = (o) => ev.push('data: ' + JSON.stringify(o) + '\n\n');
  if (step.text) for (const c of chunks(step.text, 5)) send({ model: 'mock-model', choices: [{ index: 0, delta: { content: c } }] });
  (step.tools || []).forEach((t, i) => {
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: 'call_' + i, type: 'function', function: { name: t.name, arguments: '' } }] } }] });
    for (const c of chunks(JSON.stringify(t.args), 7)) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: c } }] } }] });
  });
  send({ choices: [{ index: 0, delta: {}, finish_reason: step.tools ? 'tool_calls' : 'stop' }] });
  send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  ev.push('data: [DONE]\n\n');
  return ev;
}

function anthropicEvents(step) {
  const ev = [];
  const send = (type, o) => ev.push('event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, o)) + '\n\n');
  send('message_start', { message: { model: 'claude-mock', usage: { input_tokens: 12 } } });
  let idx = 0;
  if (step.text) {
    send('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
    for (const c of chunks(step.text, 5)) send('content_block_delta', { index: idx, delta: { type: 'text_delta', text: c } });
    send('content_block_stop', { index: idx });
    idx++;
  }
  for (const t of step.tools || []) {
    send('content_block_start', { index: idx, content_block: { type: 'tool_use', id: 'toolu_' + idx, name: t.name, input: {} } });
    for (const c of chunks(JSON.stringify(t.args), 7)) send('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: c } });
    send('content_block_stop', { index: idx });
    idx++;
  }
  send('message_delta', { delta: { stop_reason: step.tools ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 7 } });
  send('message_stop', {});
  return ev;
}

module.exports = { startMock };
