'use strict';
/* server/tools/fs.js — arquivos dentro da pasta de trabalho do agente (a "cela").
   Toda rota é resolvida com realpath e precisa ficar dentro da raiz — '..', caminhos absolutos
   e links simbólicos que apontam para fora são recusados. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAX_READ = 200 * 1024;    // 200 KB por leitura
const MAX_WRITE = 1024 * 1024;  // 1 MB por escrita
const MAX_LIST = 500;

function makeJail(root) {
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);

  function inside(p) { return p === realRoot || p.startsWith(realRoot + path.sep); }

  // Resolve um caminho relativo; para arquivos que ainda não existem, valida o diretório pai existente mais próximo.
  function resolve(rel) {
    const s = String(rel == null ? '' : rel).trim() || '.';
    if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s)) throw new Error('use caminhos relativos à pasta de trabalho');
    const target = path.resolve(realRoot, s);
    if (!inside(target)) throw new Error('caminho fora da pasta de trabalho');
    let probe = target;
    while (!fs.existsSync(probe)) {
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    if (!inside(fs.realpathSync(probe))) throw new Error('caminho fora da pasta de trabalho (link simbólico)');
    return target;
  }

  const relOf = (abs) => path.relative(realRoot, abs).split(path.sep).join('/') || '.';
  return { root: realRoot, resolve, relOf };
}

/* Converte documentos em texto para o agente ler. PDF usa pdftotext (poppler); DOCX/XLSX/PPTX/ODT usam unzip.
   Os dois vêm na imagem Docker; fora dela, se faltarem, o agente recebe um aviso claro. */
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.js', '.ts', '.py', '.sql', '.log', '.ini', '.env', '.css', '.sh']);
function run(cmd, args) { return execFileSync(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 30000 }).toString('utf8'); }
function xmlText(xml) {
  return xml.replace(/<\/(w:p|a:p|text:p|row)>/g, '\n').replace(/<(w:tab|text:tab)[^>]*\/>/g, '\t').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}
function extractText(abs) {
  const ext = path.extname(abs).toLowerCase();
  try {
    if (ext === '.pdf') return run('pdftotext', ['-layout', '-q', abs, '-']);
    if (ext === '.docx') return xmlText(run('unzip', ['-p', abs, 'word/document.xml']));
    if (ext === '.odt') return xmlText(run('unzip', ['-p', abs, 'content.xml']));
    if (ext === '.pptx') return xmlText(run('unzip', ['-p', abs, 'ppt/slides/*.xml']));
    if (ext === '.xlsx') return xmlText(run('unzip', ['-p', abs, 'xl/sharedStrings.xml'])) + '\n(planilha: só os textos das células; números podem faltar)';
  } catch (e) {
    return null;
  }
  return undefined;   // não é documento conhecido
}
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/* prefix: '' para a pasta do agente; 'shared_' para a pasta compartilhada da tripulação */
function fsTools(root, opts) {
  opts = opts || {};
  const prefix = opts.prefix || '';
  const where = opts.label || 'pasta de trabalho';
  const jail = makeJail(root);

  const listFiles = {
    name: prefix + 'list_files',
    scope: 'read',
    description: 'Lista arquivos e pastas dentro da ' + where + '. Use "." para a raiz.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Pasta relativa (padrão ".")' }, recursive: { type: 'boolean' } } },
    run(args) {
      const start = jail.resolve(args.path || '.');
      if (!fs.existsSync(start)) throw new Error('pasta não existe: ' + (args.path || '.'));
      const out = [];
      const walk = (dir, depth) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (out.length >= MAX_LIST) return;
          const abs = path.join(dir, e.name);
          out.push(jail.relOf(abs) + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory() && args.recursive && depth < 8 && !e.isSymbolicLink()) walk(abs, depth + 1);
        }
      };
      walk(start, 0);
      if (!out.length) return '(vazia)';
      return out.join('\n') + (out.length >= MAX_LIST ? '\n… (lista cortada em ' + MAX_LIST + ')' : '');
    }
  };

  const readFile = {
    name: prefix + 'read_file',
    scope: 'read',
    description: 'Lê um arquivo da ' + where + '. Texto é lido direto; PDF, DOCX, PPTX, XLSX e ODT são convertidos em texto.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run(args) {
      const abs = jail.resolve(args.path);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('arquivo não encontrado: ' + args.path);
      const ext = path.extname(abs).toLowerCase();
      if (!TEXT_EXT.has(ext)) {
        const txt = extractText(abs);
        if (txt === null) throw new Error('não consegui converter ' + ext + ' em texto (falta pdftotext/unzip ou o arquivo está protegido)');
        if (typeof txt === 'string') {
          const t = txt || '(documento sem texto — pode ser só imagem/escaneado)';
          return t.length > MAX_READ ? t.slice(0, MAX_READ) + '\n… (cortado em 200 KB)' : t;
        }
      }
      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) return 'arquivo binário (' + (ext || 'sem extensão') + ', ' + buf.length + ' bytes) — não dá para ler como texto.';
      const cut = buf.length > MAX_READ;
      return buf.subarray(0, MAX_READ).toString('utf8') + (cut ? '\n… (cortado em 200 KB de ' + buf.length + ' bytes)' : '');
    }
  };

  const writeFile = {
    name: prefix + 'write_file',
    scope: 'write',
    description: 'Cria ou sobrescreve um arquivo de texto na ' + where + ' (cria as pastas necessárias).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    run(args) {
      if (Buffer.byteLength(args.content, 'utf8') > MAX_WRITE) throw new Error('conteúdo maior que 1 MB');
      const abs = jail.resolve(args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, args.content, 'utf8');
      fs.renameSync(tmp, abs);   // escrita atômica
      return 'ok: ' + jail.relOf(abs) + ' (' + Buffer.byteLength(args.content, 'utf8') + ' bytes)';
    }
  };

  return [listFiles, readFile, writeFile];
}

module.exports = { fsTools, makeJail, extractText, looksBinary };
