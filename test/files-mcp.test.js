'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { getConfig } = require('../server/config.js');
const { start } = require('../server/index.js');
const { fsTools } = require('../server/tools/fs.js');
const { buildServer, publicCatalog, CATALOG } = require('../server/mcp-catalog.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st1f-'));

// ZIP mínimo (sem compressão) para simular um .docx
function zipStore(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), nm = Buffer.from(name), c = crc(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
// PDF mínimo de uma página com texto
function tinyPdf(text) {
  const stream = 'BT /F1 18 Tf 50 700 Td (' + text + ') Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const x = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(out + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + x + '\n%%EOF\n');
}
void zlib;

test('read_file converte DOCX e PDF em texto e recusa binário cru', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'contrato.docx'), zipStore({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Cláusula primeira &amp; única</w:t></w:r></w:p><w:p><w:r><w:t>Valor: R$ 10</w:t></w:r></w:p></w:body></w:document>' }));
  fs.writeFileSync(path.join(dir, 'nota.pdf'), tinyPdf('Relatorio trimestral 2026'));
  fs.writeFileSync(path.join(dir, 'foto.bin'), Buffer.from([0, 1, 2, 0, 255]));
  const read = fsTools(dir).find(t => t.name === 'read_file');
  assert.match(await read.run({ path: 'contrato.docx' }), /Cláusula primeira & única\nValor: R\$ 10/);
  assert.match(await read.run({ path: 'nota.pdf' }), /Relatorio trimestral 2026/);
  assert.match(await read.run({ path: 'foto.bin' }), /arquivo binário/);
});

test('pasta compartilhada: ferramentas shared_* separadas da pasta do agente', () => {
  const tools = fsTools(tmp(), { prefix: 'shared_', label: 'pasta compartilhada' });
  assert.deepEqual(tools.map(t => t.name), ['shared_list_files', 'shared_read_file', 'shared_write_file']);
  assert.match(tools[0].description, /compartilhada/);
});

async function boot() {
  const dir = tmp();
  const config = getConfig({ WORKSPACE: dir + '/ws', DATA_DIR: dir + '/data', SEED_CREW: '0' });
  const srv = await start({ config, port: 0, log: () => {}, shellAvailable: false });
  const call = (method, p, body, headers) => fetch(srv.url + p, { method, headers: Object.assign({ 'x-st1-token': srv.token }, headers || {}), body });
  return { srv, call, dir };
}

test('arquivos: enviar, listar, baixar, apagar — e sem sair da pasta', async () => {
  const { srv, call, dir } = await boot();
  try {
    let r = await call('POST', '/api/files/upload?scope=shared&name=' + encodeURIComponent('relatório final.txt'), 'olá tripulação', { 'content-type': 'application/octet-stream' });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).path, 'entrada/relatório final.txt');
    r = await call('POST', '/api/files/upload?scope=shared&name=' + encodeURIComponent('relatório final.txt'), 'segunda', {});
    assert.equal((await r.json()).path, 'entrada/relatório final (2).txt', 'não sobrescreve');
    r = await call('POST', '/api/files/upload?scope=shared&name=' + encodeURIComponent('../../fuga.txt'), 'x', {});
    const esc = (await r.json()).path;
    assert.ok(esc.startsWith('entrada/') && !esc.includes('/../'), 'nome com ../ vira nome comum: ' + esc);
    assert.ok(fs.existsSync(path.join(dir, 'ws', '_compartilhado', 'entrada', 'relatório final.txt')));
    const list = await (await call('GET', '/api/files?scope=shared')).json();
    assert.equal(list.length, 3);
    r = await call('GET', '/api/files/download?scope=shared&path=' + encodeURIComponent('entrada/relatório final.txt'));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'olá tripulação');
    assert.match(r.headers.get('content-disposition'), /attachment/);
    assert.equal((await call('GET', '/api/files/download?scope=shared&path=' + encodeURIComponent('../../data/star-trek-1.db'))).status, 400);
    assert.equal((await call('GET', '/api/files?scope=ag_naoexiste')).status, 404);
    assert.equal((await call('DELETE', '/api/files?scope=shared&path=' + encodeURIComponent('entrada/relatório final.txt'))).status, 200);
    assert.equal((await (await call('GET', '/api/files?scope=shared')).json()).length, 2);
    assert.equal((await fetch(srv.url + '/api/files?scope=shared')).status, 401, 'sem token não lista');
  } finally { await srv.close(); }
});

test('catálogo MCP: pacotes, chaves obrigatórias e cabeçalho do GitHub', async () => {
  assert.ok(CATALOG.length >= 8);
  assert.ok(CATALOG.every(c => /^[a-z0-9_-]+$/.test(c.id)));
  const mem = buildServer('memoria', {}, { dataDir: '/d' });
  assert.equal(mem.row.env.MEMORY_FILE_PATH, '/d/mcp-memoria.jsonl');
  assert.deepEqual(mem.row.args, ['-y', '@modelcontextprotocol/server-memory']);
  assert.throws(() => buildServer('tavily', {}, { dataDir: '/d' }), /preencha/);
  assert.equal(buildServer('tavily', { TAVILY_API_KEY: 'tvly-x' }, { dataDir: '/d' }).row.env.TAVILY_API_KEY, 'tvly-x');
  assert.equal(buildServer('github', { authorization: 'ghp_abc' }, {}).row.headers.authorization, 'Bearer ghp_abc');
  assert.throws(() => buildServer('github', { authorization: 'a\nb' }, {}), /inválido/);
  assert.ok(buildServer('supabase', { SUPABASE_ACCESS_TOKEN: 's' }, {}).row.args.includes('--read-only'));
  const pub = publicCatalog(['memoria']);
  assert.equal(pub.find(c => c.id === 'memoria').installed, true);
  assert.ok(!JSON.stringify(pub).includes('MEMORY_FILE_PATH'), 'catálogo público não expõe configuração interna');

  const { srv, call } = await boot();
  try {
    const r = await call('POST', '/api/mcp/install', JSON.stringify({ id: 'tavily', values: {} }), { 'content-type': 'application/json' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /preencha/);
    const cat = await (await call('GET', '/api/mcp/catalog')).json();
    assert.equal(cat.length, CATALOG.length);
  } finally { await srv.close(); }
});
