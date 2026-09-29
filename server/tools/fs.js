'use strict';
/* server/tools/fs.js — arquivos dentro da pasta de trabalho do agente (a "cela").
   Toda rota é resolvida com realpath e precisa ficar dentro da raiz — '..', caminhos absolutos
   e links simbólicos que apontam para fora são recusados. */
const fs = require('node:fs');
const path = require('node:path');

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

function fsTools(root) {
  const jail = makeJail(root);

  const listFiles = {
    name: 'list_files',
    scope: 'read',
    description: 'Lista arquivos e pastas dentro da pasta de trabalho. Use "." para a raiz.',
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
    name: 'read_file',
    scope: 'read',
    description: 'Lê um arquivo de texto da pasta de trabalho.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run(args) {
      const abs = jail.resolve(args.path);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('arquivo não encontrado: ' + args.path);
      const buf = fs.readFileSync(abs);
      const cut = buf.length > MAX_READ;
      return buf.subarray(0, MAX_READ).toString('utf8') + (cut ? '\n… (cortado em 200 KB de ' + buf.length + ' bytes)' : '');
    }
  };

  const writeFile = {
    name: 'write_file',
    scope: 'write',
    description: 'Cria ou sobrescreve um arquivo de texto na pasta de trabalho (cria as pastas necessárias).',
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

module.exports = { fsTools, makeJail };
