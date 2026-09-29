'use strict';
/* server/providers/openai-compat.js — qualquer endpoint no formato da OpenAI (/v1/chat/completions).
   Cobre FreeLLMAPI (padrão), Ollama, OpenRouter, Groq, DeepSeek etc.
   Formato interno de mensagens = formato OpenAI, então aqui quase não há tradução. */
const { readSSE } = require('./sse.js');
const { ProviderError, httpError, networkError } = require('./errors.js');

function makeOpenAICompat(cfg) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');

  async function chat({ messages, tools, signal, onText }) {
    const body = { model: cfg.model, messages: messages.map(toWire), stream: true, stream_options: { include_usage: true } };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;

    let res;
    try { res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal }); }
    catch (e) { throw networkError(cfg.name, e, base); }
    if (!res.ok) throw await httpError(cfg.name, res);

    const routedVia = res.headers.get('x-routed-via') || '';
    const ctype = res.headers.get('content-type') || '';
    // Alguns servidores ignoram stream:true e devolvem JSON normal — aceitamos os dois.
    if (!ctype.includes('text/event-stream')) return fromJson(await res.json(), routedVia, onText);

    let text = '';
    let model = cfg.model;
    let usage = { input: 0, output: 0 };
    let finish = '';
    const calls = [];   // acumulador por índice
    for await (const ev of readSSE(res.body)) {
      if (ev.data === '[DONE]') break;
      let j;
      try { j = JSON.parse(ev.data); } catch (_) { continue; }
      if (j.error) throw new ProviderError(cfg.name, 'erro no stream: ' + (j.error.message || JSON.stringify(j.error)), { retryable: true });
      if (j.model) model = j.model;
      if (j.usage) usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) { text += d.content; if (onText) onText(d.content); }
      for (const tc of d.tool_calls || []) {
        const i = tc.index != null ? tc.index : calls.length;
        const slot = calls[i] || (calls[i] = { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function && tc.function.name) slot.name += tc.function.name;
        if (tc.function && tc.function.arguments) slot.args += tc.function.arguments;
      }
    }
    return { text, toolCalls: finalizeCalls(calls), usage, model, routedVia, finish };
  }

  return { name: cfg.name, model: cfg.model, chat };
}

function toWire(m) {
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))
    };
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content) };
  return { role: m.role, content: m.content };
}

function fromJson(j, routedVia, onText) {
  const ch = (j.choices && j.choices[0]) || {};
  const msg = ch.message || {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text && onText) onText(text);
  const calls = (msg.tool_calls || []).map(tc => ({ id: tc.id || '', name: (tc.function && tc.function.name) || '', args: (tc.function && tc.function.arguments) || '' }));
  const u = j.usage || {};
  return { text, toolCalls: finalizeCalls(calls), usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 }, model: j.model || '', routedVia, finish: ch.finish_reason || '' };
}

let seq = 0;
function finalizeCalls(calls) {
  return calls.filter(c => c && c.name).map(c => ({ id: c.id || ('call_' + Date.now().toString(36) + '_' + (seq++)), name: c.name.trim(), args: c.args || '{}' }));
}

module.exports = { makeOpenAICompat };
