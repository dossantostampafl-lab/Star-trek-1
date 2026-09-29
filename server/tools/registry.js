'use strict';
/* server/tools/registry.js — registro de ferramentas: nome, descrição, esquema JSON e execução.
   Valida argumentos (campos obrigatórios e tipos básicos) antes de executar. */

function makeRegistry() {
  const tools = new Map();

  function register(tool) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error('nome de ferramenta inválido: ' + tool.name);
    tools.set(tool.name, tool);
  }

  function list() {
    return Array.from(tools.values()).map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  async function run(name, rawArgs, ctx) {
    const tool = tools.get(name);
    if (!tool) return { ok: false, output: 'Ferramenta inexistente: "' + name + '". Disponíveis: ' + Array.from(tools.keys()).join(', ') };
    let args;
    try { args = rawArgs && String(rawArgs).trim() ? JSON.parse(rawArgs) : {}; }
    catch (_) { return { ok: false, output: 'Argumentos não são JSON válido: ' + String(rawArgs).slice(0, 200) }; }
    const problem = validate(tool.parameters, args);
    if (problem) return { ok: false, output: 'Argumentos inválidos para ' + name + ': ' + problem };
    try {
      const out = await tool.run(args, ctx || {});
      return { ok: true, output: typeof out === 'string' ? out : JSON.stringify(out, null, 2) };
    } catch (e) {
      return { ok: false, output: 'Erro em ' + name + ': ' + (e && e.message ? e.message : String(e)) };
    }
  }

  function unregister(name) { tools.delete(name); }

  return { register, unregister, list, run, has: (n) => tools.has(n), get: (n) => tools.get(n) };
}

function validate(schema, args) {
  if (!schema || schema.type !== 'object') return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'esperado um objeto';
  for (const k of schema.required || []) if (args[k] == null) return 'falta o campo "' + k + '"';
  for (const [k, spec] of Object.entries(schema.properties || {})) {
    if (args[k] == null || !spec.type) continue;
    const t = Array.isArray(args[k]) ? 'array' : typeof args[k];
    const want = spec.type === 'integer' ? 'number' : spec.type;
    if (t !== want) return 'campo "' + k + '" deveria ser ' + spec.type;
  }
  return null;
}

module.exports = { makeRegistry, validate };
