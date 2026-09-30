'use strict';
/* server/verify.js — conferência automática de uma entrega. Não usa o modelo: só fatos que dá para provar.
   Veredito: ok (tudo certo) · aviso (entregue, mas algo merece olhar) · falhou (não dá para usar como está).
   Checagens:
   - o arquivo existe e não está vazio
   - o formato bate com a extensão (PDF começa com %PDF, PNG/JPG/ZIP com a assinatura certa, JSON válido)
   - texto: tamanho mínimo, sem marcadores esquecidos (TODO, lorem ipsum, [inserir…]), CSV com colunas consistentes
   - se a entrega promete fontes/links, o texto precisa ter links
   Também acha, na resposta final do tripulante, caminhos de arquivo que ele diz ter salvo e que não existem. */
const fs = require('node:fs');
const path = require('node:path');

const TEXT = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml', '.js', '.ts', '.py', '.sql', '.css', '.sh', '.svg', '.ini', '.log']);
const PLACEHOLDER = /\b(TODO|TBD|FIXME|lorem ipsum)\b|\[(inserir|insira|preencher|insert|placeholder|seu nome|nome da empresa)[^\]]*\]|XXX{2,}/i;
const MAGIC = {
  '.pdf': [0x25, 0x50, 0x44, 0x46], '.png': [0x89, 0x50, 0x4e, 0x47], '.jpg': [0xff, 0xd8, 0xff], '.jpeg': [0xff, 0xd8, 0xff],
  '.gif': [0x47, 0x49, 0x46], '.zip': [0x50, 0x4b], '.docx': [0x50, 0x4b], '.xlsx': [0x50, 0x4b], '.pptx': [0x50, 0x4b], '.odt': [0x50, 0x4b]
};

function csvConsistent(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 200);
  if (lines.length < 2) return true;
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const count = (l) => { let n = 1, q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) n++; } return n; };
  const head = count(lines[0]);
  return lines.filter(l => count(l) !== head).length <= Math.max(1, Math.floor(lines.length * 0.05));
}

// abs: caminho absoluto já validado (dentro da cela). expect: { promisesLinks, minChars }
function checkFile(abs, expect) {
  expect = expect || {};
  const checks = [];
  const add = (name, ok, level, detail) => checks.push({ name, ok, level: ok ? 'ok' : level, detail: detail || '' });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    add('existe', false, 'falhou', 'arquivo não encontrado');
    return { verdict: 'falhou', checks };
  }
  const st = fs.statSync(abs);
  add('existe', true);
  if (!st.size) { add('não vazio', false, 'falhou', '0 bytes'); return { verdict: 'falhou', checks }; }
  add('não vazio', true, 'ok', st.size + ' bytes');
  const ext = path.extname(abs).toLowerCase();
  const head = Buffer.alloc(8);
  const fd = fs.openSync(abs, 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
  if (MAGIC[ext]) add('formato ' + ext, MAGIC[ext].every((b, i) => head[i] === b), 'falhou', 'o conteúdo não é um ' + ext + ' de verdade');
  if (TEXT.has(ext) || !ext) {
    const text = fs.readFileSync(abs, 'utf8').slice(0, 400000);
    const min = expect.minChars || 40;
    add('conteúdo', text.trim().length >= min, 'aviso', text.trim().length + ' caracteres');
    const ph = text.match(PLACEHOLDER);
    add('sem marcadores esquecidos', !ph, 'aviso', ph ? 'achei "' + ph[0] + '"' : '');
    if (ext === '.json') { let okJ = true; try { JSON.parse(text); } catch (_) { okJ = false; } add('JSON válido', okJ, 'falhou', okJ ? '' : 'não abre como JSON'); }
    if (ext === '.csv' || ext === '.tsv') add('colunas consistentes', csvConsistent(text), 'aviso', 'linhas com número diferente de colunas');
    if (expect.promisesLinks) add('tem fontes/links', /https?:\/\/\S+/.test(text), 'aviso', 'a entrega fala em fontes, mas o arquivo não tem links');
  }
  const levels = checks.map(c => c.level);
  return { verdict: levels.includes('falhou') ? 'falhou' : levels.includes('aviso') ? 'aviso' : 'ok', checks };
}

// caminhos de arquivo citados num texto (ex.: "salvei em relatorios/2026-09-29-ia.md")
const PATH_RE = /(?:^|[\s`'"(\[])((?:[\w.\-]+\/)*[\w\-][\w.\-]*\.(?:md|txt|csv|tsv|json|html|pdf|py|js|ts|sql|xlsx|docx|pptx|png|jpg|svg|yaml|yml|sh))(?=$|[\s`'")\],.;:!?])/gim;
function mentionedFiles(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, '');
    if (/^(https?|www)\b/i.test(p) || /\w\.(com|org|net|br|io)\//.test(p)) continue;
    out.add(p);
  }
  return [...out].slice(0, 20);
}

module.exports = { checkFile, mentionedFiles, csvConsistent, PLACEHOLDER };
