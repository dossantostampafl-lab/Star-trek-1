'use strict';
/* server/providers/anthropic.js — API de Mensagens da Anthropic (Claude), com streaming e ferramentas.
   Traduz o formato interno (estilo OpenAI) para blocos de conteúdo da Anthropic. */
const { readSSE } = require('./sse.js');
const { ProviderError, httpError, networkError } = require('./errors.js');

const API_VERSION = '2023-06-01';

function makeAnthropic(cfg) {
  const base = String(cfg.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');

  async function chat({ messages, tools, signal, onText }) {
    if (!cfg.apiKey) throw new ProviderError('anthropic', 'ANTHROPIC_API_KEY vazio no .env', { retryable: false });
    const { system, wire } = toWire(messages);
    const body = { model: cfg.model, max_tokens: cfg.maxTokens || 8192, messages: wire, stream: true };
    if (system) body.system = system;
    if (tools && tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

    let res;
    try {
      res = await fetch(base + '/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': API_VERSION },
        body: JSON.stringify(body),
        signal
      });
    } catch (e) { throw networkError('anthropic', e, base); }
    if (!res.ok) throw await httpError('anthropic', res);

    let text = '';
    let model = cfg.model;
    let finish = '';
    const usage = { input: 0, output: 0 };
    const blocks = [];   // por índice: {type, id, name, args}
    for await (const ev of readSSE(res.body)) {
      let j;
      try { j = JSON.parse(ev.data); } catch (_) { continue; }
      switch (j.type) {
        case 'message_start':
          if (j.message) { model = j.message.model || model; if (j.message.usage) usage.input = j.message.usage.input_tokens || 0; }
          break;
        case 'content_block_start': {
          const b = j.content_block || {};
          blocks[j.index] = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, args: '' } : { type: b.type };
          break;
        }
        case 'content_block_delta': {
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) { text += d.text; if (onText) onText(d.text); }
          else if (d.type === 'input_json_delta' && blocks[j.index]) blocks[j.index].args += d.partial_json || '';
          break;
        }
        case 'message_delta':
          if (j.delta && j.delta.stop_reason) finish = j.delta.stop_reason;
          if (j.usage && j.usage.output_tokens != null) usage.output = j.usage.output_tokens;
          break;
        case 'error':
          throw new ProviderError('anthropic', 'erro no stream: ' + ((j.error && j.error.message) || 'desconhecido'), { retryable: true });
        default: break;
      }
    }
    const toolCalls = blocks.filter(b => b && b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.args || '{}' }));
    return { text, toolCalls, usage, model, routedVia: '', finish };
  }

  return { name: 'anthropic', model: cfg.model, chat };
}

function toWire(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const wire = [];
  const push = (role, blocks) => {
    const last = wire[wire.length - 1];
    if (last && last.role === role) last.content.push(...blocks);   // a API exige alternância user/assistant
    else wire.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') push('user', [{ type: 'text', text: String(m.content || '') }]);
    else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content), is_error: !!m.is_error }]);
    else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: safeJson(c.args) });
      if (blocks.length) push('assistant', blocks);
    }
  }
  return { system, wire };
}

function safeJson(s) { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; } }

module.exports = { makeAnthropic, _toWire: toWire };
