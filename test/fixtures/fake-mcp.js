'use strict';
/* test/fixtures/fake-mcp.js — servidor MCP mínimo (stdio) para testes: ferramentas "echo" e "soma". */
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
console.log('isto é um log no stdout que o cliente deve ignorar');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;   // notificação
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (msg.method === 'tools/list') {
    if (!msg.params.cursor) return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Repete o texto', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }], nextCursor: 'p2' } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'soma', description: 'Soma a e b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] } });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: a } = msg.params;
    if (name === 'echo') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'eco: ' + a.text }] } });
    if (name === 'soma') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(a.a + a.b) }] } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'desconhecida' }] } });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'método não existe' } });
});
