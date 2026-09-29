'use strict';
/* server/permissions.js — quem pode rodar o quê.
   Escopos de ferramenta:
     read     → livre (leitura, hora)
     network  → livre (leitura de páginas públicas; endereços locais já são bloqueados na ferramenta)
     write    → livre, mas só dentro da cela do agente e com checkpoint antes
     execute  → terminal: SEMPRE pergunta numa sessão interativa (uma vez / sessão / negar).
                Em execução automática (agendamento, esteira) é NEGADO — sem exceção, não existe "sempre".
     external → conectores MCP: pergunta (uma vez / sessão / sempre / negar).
                Execução automática só com permissão "sempre" já dada para aquele conector.
   Silêncio não é consentimento: sem resposta em PROMPT_TIMEOUT_MS → negado. */

const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

function dangerKey(tool) {
  if (tool.scope === 'execute') return 'shell';
  if (tool.scope === 'external') return 'mcp:' + (tool.server || tool.name);
  return tool.scope;
}

/* grants: { has(agentId, key) → bool, add(agentId, key) } — persistência das permissões "sempre".
   prompt: async ({agentId, tool, call, choices}) → 'once' | 'session' | 'always' | 'deny' */
function makeConsentBroker(deps) {
  deps = deps || {};
  const grants = deps.grants || memoryGrants();
  const session = new Map();   // agentId → Set(keys)

  const sessionHas = (a, k) => !!(session.get(a) && session.get(a).has(k));
  const sessionAdd = (a, k) => { if (!session.has(a)) session.set(a, new Set()); session.get(a).add(k); };

  async function authorize(ctx, tool, call) {
    const scope = tool.scope || 'read';
    const agentId = ctx.agentId || 'cli';
    const auto = ctx.surface === 'autonomous';
    const key = dangerKey(tool);

    if (scope === 'read' || scope === 'network' || scope === 'write') return { allow: true, reason: scope };

    if (scope === 'execute') {
      if (auto) return { allow: false, reason: 'terminal não roda em execução automática — peça a um humano' };
      if (sessionHas(agentId, key)) return { allow: true, reason: 'permitido nesta sessão' };
      return ask(ctx, tool, call, ['once', 'session', 'deny']);
    }

    if (scope === 'external') {
      if (grants.has(agentId, key)) return { allow: true, reason: 'permitido sempre' };
      if (auto) return { allow: false, reason: 'conector sem permissão "sempre" para execução automática' };
      if (sessionHas(agentId, key)) return { allow: true, reason: 'permitido nesta sessão' };
      return ask(ctx, tool, call, ['once', 'session', 'always', 'deny']);
    }
    return { allow: false, reason: 'escopo desconhecido: ' + scope };
  }

  async function ask(ctx, tool, call, choices) {
    if (!deps.prompt) return { allow: false, reason: 'sem canal para pedir permissão' };
    let decision;
    try {
      decision = await withTimeout(deps.prompt({ agentId: ctx.agentId || 'cli', agentName: ctx.agentName, tool: { name: tool.name, scope: tool.scope, description: tool.description }, call, choices }), PROMPT_TIMEOUT_MS, ctx.signal);
    } catch (e) {
      return { allow: false, reason: e && e.name === 'AbortError' ? 'cancelado' : 'sem resposta — negado' };
    }
    if (!choices.includes(decision) || decision === 'deny') return { allow: false, reason: 'negado pelo comandante' };
    const agentId = ctx.agentId || 'cli';
    const key = dangerKey(tool);
    if (decision === 'session') sessionAdd(agentId, key);
    if (decision === 'always') grants.add(agentId, key);
    return { allow: true, reason: decision };
  }

  function revokeSession(agentId) { if (agentId) session.delete(agentId); else session.clear(); }

  return { authorize, revokeSession };
}

function memoryGrants() {
  const s = new Set();
  return { has: (a, k) => s.has(a + '|' + k), add: (a, k) => { s.add(a + '|' + k); } };
}

function withTimeout(p, ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('cancelado'), { name: 'AbortError' })); }, { once: true });
    Promise.resolve(p).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

module.exports = { makeConsentBroker, dangerKey, memoryGrants, PROMPT_TIMEOUT_MS };
