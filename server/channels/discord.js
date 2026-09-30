'use strict';
/* server/channels/discord.js — adaptador do Discord (Gateway por WebSocket + API REST), sem dependências.
   Crie um aplicativo em discord.com/developers, adicione um Bot, LIGUE "Message Content Intent", copie o token
   e cole no painel. Converse com o bot por mensagem direta (DM) e mande o código de pareamento. */

const API = 'https://discord.com/api/v10';
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);   // mensagens em servidores, DMs e conteúdo das mensagens

function makeDiscord(deps) {
  const { db } = deps;
  const log = deps.log || (() => {});
  const token = () => db.getSetting('discord_token', '') || process.env.DISCORD_BOT_TOKEN || '';
  let ws = null, hb = null, seq = null, running = false, connected = false, botName = '', botId = '', lastError = '', onMsg = null, retry = null;

  async function rest(method, p, body) {
    if (deps.rest) return deps.rest(method, p, body);
    const isForm = body instanceof FormData;
    const res = await fetch(API + p, {
      method, signal: AbortSignal.timeout(30000),
      headers: Object.assign({ authorization: 'Bot ' + token(), 'user-agent': 'DiscordBot (star-trek-1, 1.0)' }, isForm || !body ? {} : { 'content-type': 'application/json' }),
      body: isForm ? body : body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return null;
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.message || ('HTTP ' + res.status)); e.code = res.status; throw e; }
    return j;
  }

  const components = (buttons) => buttons && buttons.length
    ? buttons.slice(0, 5).map(row => ({ type: 1, components: row.slice(0, 5).map(b => ({ type: 2, style: /negar|descartar|refazer/i.test(b.label) ? 2 : 1, label: String(b.label).slice(0, 80), custom_id: String(b.data).slice(0, 100) })) }))
    : [];

  function connect(url) {
    const sock = deps.connectGateway ? deps.connectGateway(url) : new WebSocket(url + '?v=10&encoding=json');
    ws = sock;
    sock.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (_) { return; }
      if (m.s != null) seq = m.s;
      if (m.op === 10) {
        clearInterval(hb);
        hb = setInterval(() => { try { sock.send(JSON.stringify({ op: 1, d: seq })); } catch (_) { /* caiu */ } }, m.d.heartbeat_interval);
        if (hb.unref) hb.unref();
        sock.send(JSON.stringify({ op: 2, d: { token: token(), intents: INTENTS, properties: { os: 'linux', browser: 'star-trek-1', device: 'star-trek-1' } } }));
      } else if (m.op === 1) { sock.send(JSON.stringify({ op: 1, d: seq })); }
      else if (m.op === 7 || m.op === 9) { try { sock.close(); } catch (_) { /* ok */ } }
      else if (m.op === 0) dispatch(m.t, m.d).catch(e => log('discord: ' + e.message));
    };
    sock.onclose = (ev) => {
      clearInterval(hb); connected = false;
      if (ev && ev.code === 4004) { lastError = 'token inválido'; running = false; return; }
      if (ev && ev.code === 4014) { lastError = 'ligue "Message Content Intent" no portal do Discord (Bot → Privileged Gateway Intents)'; running = false; return; }
      if (running) { retry = setTimeout(() => connect(url), 5000); if (retry.unref) retry.unref(); }
    };
    sock.onerror = () => { lastError = 'falha na conexão com o Discord'; };
  }

  async function fetchAttachment(a) {
    if (deps.download) return deps.download(a.url);
    const res = await fetch(a.url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('download falhou: HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  async function dispatch(t, d) {
    if (t === 'READY') { connected = true; lastError = ''; botId = d.user.id; botName = d.user.username; return; }
    if (t === 'MESSAGE_CREATE') {
      if (!d.author || d.author.bot || d.guild_id) return;   // só mensagens diretas (DM) de pessoas
      const base = { sender: d.author.id, senderName: d.author.global_name || d.author.username, chat: d.channel_id, text: d.content || '',
        replyTo: d.message_reference && d.message_reference.message_id ? String(d.message_reference.message_id) : null };
      const att = (d.attachments || [])[0];
      if (att) {
        if (att.size > 25 * 1024 * 1024) { await rest('POST', '/channels/' + d.channel_id + '/messages', { content: 'Arquivo grande demais (máx. 25 MB).' }); return; }
        let buf;
        try { buf = await fetchAttachment(att); } catch (e) { await rest('POST', '/channels/' + d.channel_id + '/messages', { content: 'Não baixei o arquivo: ' + e.message }); return; }
        const isVoice = /^audio\//.test(att.content_type || '') && ((d.flags || 0) & 8192 || !base.text);
        if (isVoice) return onMsg(Object.assign(base, { kind: 'voice', buf, mime: att.content_type }));
        return onMsg(Object.assign(base, { kind: 'file', buf, fileName: att.filename }));
      }
      return onMsg(Object.assign(base, { kind: 'text' }));
    }
    if (t === 'INTERACTION_CREATE' && d.type === 3) {
      const user = d.user || (d.member && d.member.user) || {};
      return onMsg({ kind: 'button', sender: user.id, senderName: user.username, chat: d.channel_id, data: d.data.custom_id,
        ack: (text) => rest('POST', '/interactions/' + d.id + '/' + d.token + '/callback', { type: 4, data: { content: String(text || 'ok').slice(0, 1900), flags: 64 } }) });
    }
  }

  async function start(onMessage) {
    if (running) return;
    if (!token()) throw new Error('sem token');
    onMsg = onMessage; lastError = '';
    try {
      const me = await rest('GET', '/users/@me');
      botName = me.username; botId = me.id;
      const g = await rest('GET', '/gateway/bot');
      running = true;
      connect(g.url);
    } catch (e) {
      running = false; lastError = e.code === 401 ? 'token inválido' : e.message;
      throw new Error(lastError);
    }
  }
  async function stop() {
    running = false; connected = false;
    clearInterval(hb); clearTimeout(retry);
    if (ws) { try { ws.close(); } catch (_) { /* fechado */ } ws = null; }
  }

  return {
    name: 'discord', label: 'Discord', maxText: 1900, maxFile: 24 * 1024 * 1024,
    configured: () => !!token(), connected: () => connected && running,
    start, stop,
    async send(chat, text, opts) {
      const r = await rest('POST', '/channels/' + chat + '/messages', { content: text, components: components(opts && opts.buttons), allowed_mentions: { parse: [] } });
      return String(r.id);
    },
    async sendFile(chat, abs, caption, opts) {
      const fs = require('node:fs'), path = require('node:path');
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content: (caption || '').slice(0, 1900), components: components(opts && opts.buttons), allowed_mentions: { parse: [] } }));
      form.append('files[0]', new Blob([fs.readFileSync(abs)]), path.basename(abs));
      const r = await rest('POST', '/channels/' + chat + '/messages', form);
      return String(r.id);
    },
    async clearButtons(chat, ref, note) {
      await rest('PATCH', '/channels/' + chat + '/messages/' + ref, { components: note ? [{ type: 1, components: [{ type: 2, style: 2, label: note.slice(0, 80), custom_id: 'noop', disabled: true }] }] : [] });
    },
    typing: (chat) => rest('POST', '/channels/' + chat + '/typing'),
    status: () => ({ connected: connected && running, bot: botName, error: lastError, id: botId })
  };
}

module.exports = { makeDiscord, INTENTS };
