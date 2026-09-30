'use strict';
/* server/agent.js — monta um agente pronto: provedor (com fallback) + ferramentas + permissões + histórico.
   Usado tanto pela linha de comando quanto pela estação (servidor). */
const { buildProvider } = require('./providers/index.js');
const { providerConfig } = require('./config.js');
const { makeRegistry } = require('./tools/registry.js');
const { fsTools } = require('./tools/fs.js');
const { getTime, fetchUrl, webSearch } = require('./tools/basic.js');
const { runAgent } = require('./loop.js');

function systemPrompt(profile) {
  profile = profile || {};
  const lines = [
    'Você é ' + (profile.name || 'Tripulante') + ', um agente da estação Star Trek 1.' + (profile.role ? ' Sua função: ' + profile.role + '.' : ''),
    'Responda em português do Brasil, de forma direta.',
    'Use ferramentas quando precisar de fatos (data/hora, busca na web, páginas) ou de arquivos.',
    'Você tem a sua pasta de trabalho (list_files/read_file/write_file) e, se houver, a pasta compartilhada da tripulação',
    '(shared_list_files/shared_read_file/shared_write_file). Arquivos enviados pelo comandante chegam na compartilhada, em entrada/.',
    'Para entregar algo que outro tripulante precise ler, salve na pasta compartilhada. Use sempre caminhos relativos.',
    'Se uma permissão for negada, não insista: siga de outro jeito ou explique.',
    'Quando a tarefa estiver concluída, responda sem chamar ferramentas.'
  ];
  if (profile.instructions) lines.push('', 'Instruções do comandante:', profile.instructions);
  return lines.join('\n');
}

// Configuração do provedor deste agente: o padrão do .env, ou o que o agente escolheu (provedor/modelo).
function agentProviderConfig(config, profile) {
  if (!profile || (!profile.provider && !profile.model)) return config;
  const base = profile.provider ? providerConfig(profile.provider) : Object.assign({}, config.provider);
  if (profile.model) base.model = profile.model;
  return Object.assign({}, config, { provider: base });
}

/* opts:
   profile      { id, name, role, instructions, provider, model }
   workspace    pasta do agente (padrão: config.workspace)
   consent      broker de permissões (server/permissions.js)
   surface      'interactive' | 'autonomous'
   checkpoints  (server/checkpoint.js)
   extraTools   ferramentas adicionais (shell, handoff, MCP…)
   beforeStep   (usage) → lança erro para parar (orçamento)
   history      mensagens anteriores (sem o system) para continuar uma conversa */
function createAgent(config, opts) {
  opts = opts || {};
  const profile = opts.profile || {};
  const agentId = profile.id || 'cli';
  const workspace = opts.workspace || config.workspace;
  const provider = opts.provider || buildProvider(agentProviderConfig(config, profile), { log: opts.log, retries: opts.retries, timeoutMs: opts.timeoutMs });
  const registry = makeRegistry();
  const shared = opts.sharedDir ? fsTools(opts.sharedDir, { prefix: 'shared_', label: 'pasta COMPARTILHADA da tripulação (arquivos enviados pelo comandante ficam em entrada/)' }) : [];
  for (const t of [getTime, webSearch, fetchUrl, ...fsTools(workspace), ...shared, ...(opts.extraTools || [])]) registry.register(t);

  const messages = [{ role: 'system', content: opts.system || systemPrompt(profile) }];
  if (opts.history) messages.push(...opts.history);

  async function send(text, runOpts) {
    runOpts = runOpts || {};
    const surface = runOpts.surface || opts.surface || 'interactive';
    messages[0] = { role: 'system', content: opts.system || systemPrompt(profile) };
    messages.push({ role: 'user', content: text });
    const authorize = opts.consent
      ? (tool, call, signal) => opts.consent.authorize({ agentId, agentName: profile.name, surface, signal }, tool, call)
      : null;
    const beforeMutate = opts.checkpoints
      ? (tool, call) => opts.checkpoints.create(agentId, workspace, tool.name + ' ' + String(call.args).slice(0, 120))
      : null;
    let res;
    try {
      res = await runAgent({
        provider, registry, messages, maxSteps: config.maxSteps, signal: runOpts.signal, onEvent: runOpts.onEvent,
        authorize, beforeMutate, beforeStep: runOpts.beforeStep || opts.beforeStep, toolCtx: { agentId, workspace, surface, meta: runOpts.meta || {} }
      });
    } catch (e) {
      messages.pop();                   // falhou: tira a pergunta para o histórico continuar consistente
      throw e;
    }
    messages.length = 0;
    messages.push(...res.messages);   // guarda o histórico para a próxima mensagem
    return res;
  }

  function reset() { messages.splice(1); }

  return { id: agentId, send, reset, provider, registry, messages, workspace };
}

module.exports = { createAgent, systemPrompt, agentProviderConfig };
