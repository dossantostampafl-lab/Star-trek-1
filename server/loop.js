'use strict';
/* server/loop.js — o loop do agente.
   Modelo responde → se pediu ferramentas, executa e devolve os resultados → repete,
   até o modelo responder sem ferramentas ou atingir o limite de passos.
   Sem estado entre execuções: tudo vive no array `messages` que entra e sai. */

const MAX_TOOL_OUTPUT = 20000;   // caracteres por resultado de ferramenta devolvido ao modelo

async function runAgent(opts) {
  const { provider, registry, signal } = opts;
  const maxSteps = opts.maxSteps || 12;
  const emit = opts.onEvent || (() => {});
  const messages = opts.messages.slice();
  const usage = { input: 0, output: 0 };
  const tools = registry ? registry.list() : [];
  let finalText = '';
  let lastSignature = '';
  let repeats = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal && signal.aborted) throw Object.assign(new Error('cancelado'), { name: 'AbortError' });
    if (opts.beforeStep) await opts.beforeStep(usage);   // ex.: orçamento — lança erro para parar
    emit({ type: 'step', step });

    const r = await provider.chat({ messages: compactForModel(messages, opts.contextMessages), tools, signal, onText: (t) => emit({ type: 'text', text: t }) });
    usage.input += r.usage.input || 0;
    usage.output += r.usage.output || 0;
    emit({ type: 'model', provider: r.provider || provider.name, model: r.model, routedVia: r.routedVia || '' });

    const assistant = { role: 'assistant', content: r.text || '' };
    if (r.toolCalls.length) assistant.tool_calls = r.toolCalls;
    messages.push(assistant);

    if (!r.toolCalls.length) {
      finalText = r.text || '';
      emit({ type: 'done', steps: step, usage });
      return { text: finalText, messages, steps: step, usage, stopped: 'answer' };
    }

    // Trava contra loop infinito: o mesmo conjunto de chamadas repetido 3x seguidas.
    const sig = r.toolCalls.map(c => c.name + ':' + c.args).join('|');
    repeats = sig === lastSignature ? repeats + 1 : 0;
    lastSignature = sig;

    for (const call of r.toolCalls) {
      emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
      let res;
      if (repeats >= 2) res = { ok: false, output: 'Chamada repetida 3 vezes com os mesmos argumentos. Mude de abordagem ou responda com o que já tem.' };
      else res = await guardedRun(opts, call, signal, emit);
      const out = res.output.length > MAX_TOOL_OUTPUT ? res.output.slice(0, MAX_TOOL_OUTPUT) + '\n… (cortado)' : res.output;
      emit({ type: 'tool_result', id: call.id, name: call.name, ok: res.ok, output: out });
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: out, is_error: !res.ok });
    }
  }

  // Limite de passos: pede um fechamento sem ferramentas para não terminar mudo.
  messages.push({ role: 'user', content: 'Limite de passos atingido. Resuma em poucas linhas o que foi feito e o que falta, sem usar ferramentas.' });
  const r = await provider.chat({ messages: compactForModel(messages, opts.contextMessages), tools: [], signal, onText: (t) => emit({ type: 'text', text: t }) });
  usage.input += r.usage.input || 0;
  usage.output += r.usage.output || 0;
  messages.push({ role: 'assistant', content: r.text || '' });
  emit({ type: 'done', steps: maxSteps, usage, limit: true });
  return { text: r.text || '', messages, steps: maxSteps, usage, stopped: 'limit' };
}

/* Permissão → checkpoint (se muda arquivos) → execução. Negação vira resultado de erro para o modelo,
   que pode seguir por outro caminho em vez de a execução inteira quebrar. */
async function guardedRun(opts, call, signal, emit) {
  const { registry } = opts;
  const tool = registry.get ? registry.get(call.name) : null;
  if (tool && opts.authorize) {
    const d = await opts.authorize(tool, call, signal);
    if (!d.allow) {
      emit({ type: 'denied', id: call.id, name: call.name, reason: d.reason });
      return { ok: false, output: 'Permissão negada (' + d.reason + '). Não tente de novo a mesma ação; siga de outro jeito ou explique ao comandante.' };
    }
  }
  if (tool && opts.beforeMutate && (tool.scope === 'write' || tool.scope === 'execute')) {
    try { const cp = await opts.beforeMutate(tool, call); if (cp && cp.id) emit({ type: 'checkpoint', id: cp.id, tool: call.name }); }
    catch (e) { emit({ type: 'warning', message: 'checkpoint falhou: ' + e.message }); }
  }
  return registry.run(call.name, call.args, Object.assign({ signal }, opts.toolCtx || {}));
}

/* Contexto enxuto para o modelo (o histórico completo continua salvo):
   - só as últimas `keep` mensagens, sempre começando numa pergunta do usuário (tool_calls nunca ficam órfãs);
   - resultados de ferramentas de turnos antigos encolhem para 600 caracteres.
   Menos tokens = resposta bem mais rápida, principalmente em modelos grátis. */
const OLD_TOOL_CHARS = 600;
function compactForModel(messages, keep) {
  keep = keep || 30;
  const system = messages[0] && messages[0].role === 'system' ? [messages[0]] : [];
  let rest = messages.slice(system.length);
  if (rest.length > keep) {
    let cut = rest.length - keep;
    while (cut < rest.length && rest[cut].role !== 'user') cut++;
    if (cut >= rest.length) cut = rest.length - 1;
    rest = rest.slice(cut);
  }
  // posição da última pergunta do usuário: o que vem depois dela é o turno atual (não encolhe)
  let lastUser = -1;
  for (let i = rest.length - 1; i >= 0; i--) if (rest[i].role === 'user') { lastUser = i; break; }
  rest = rest.map((m, i) => {
    if (i >= lastUser || m.role !== 'tool') return m;
    const c = String(m.content || '');
    return c.length > OLD_TOOL_CHARS ? Object.assign({}, m, { content: c.slice(0, OLD_TOOL_CHARS) + '\n… (resultado antigo resumido)' }) : m;
  });
  return system.concat(rest);
}

module.exports = { runAgent, compactForModel };
