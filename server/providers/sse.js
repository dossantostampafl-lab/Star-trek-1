'use strict';
/* server/providers/sse.js — lê um corpo de resposta em Server-Sent Events e entrega cada evento {event, data}. */

async function* readSSE(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
      const ev = parseBlock(raw);
      if (ev) yield ev;
    }
  }
  buf += decoder.decode();
  const last = parseBlock(buf);
  if (last) yield last;
}

function parseBlock(raw) {
  if (!raw || !raw.trim()) return null;
  let event = 'message';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;                 // comentário / keep-alive
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

module.exports = { readSSE };
