'use strict';
/* server/channels/telegram.js — adaptador do Telegram (Bot API por long polling: não precisa de webhook nem porta aberta).
   Crie o bot com o @BotFather, cole o token no painel (aba Canais) e mande ao bot o código de pareamento. */

function makeTelegram(deps) {
  const { db } = deps;
  const log = deps.log || (() => {});
  const base = () => (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const token = () => db.getSetting('telegram_token', '') || process.env.TELEGRAM_BOT_TOKEN || '';
  let running = false, ctrl = null, connected = false, botName = '', lastError = '', offset = 0, loop = null;

  async function api(method, params, signal) {
    if (deps.api) return deps.api(method, params);
    const isForm = params instanceof FormData;
    const res = await fetch(base() + '/bot' + token() + '/' + method, {
      method: 'POST', signal: signal || AbortSignal.timeout(30000),
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? params : JSON.stringify(params || {})
    });
    const j = await res.json().catch(() => ({ ok: false, description: 'HTTP ' + res.status }));
    if (!j.ok) { const e = new Error(j.description || 'erro do Telegram'); e.code = j.error_code || res.status; throw e; }
    return j.result;
  }
  async function download(fileId) {
    const f = await api('getFile', { file_id: fileId });
    if (deps.download) return deps.download(f.file_path);
    const res = await fetch(base() + '/file/bot' + token() + '/' + f.file_path, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('download falhou: HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  const keyboard = (buttons) => buttons && buttons.length
    ? { inline_keyboard: buttons.map(row => row.map(b => ({ text: String(b.label).slice(0, 60), callback_data: String(b.data).slice(0, 64) }))) } : undefined;

  function parse(u) {
    if (u.callback_query) {
      const c = u.callback_query;
      return { kind: 'button', sender: c.from.id, senderName: c.from.first_name, chat: c.message ? c.message.chat.id : c.from.id, data: c.data,
        ack: (text) => api('answerCallbackQuery', { callback_query_id: c.id, text: String(text || '').slice(0, 190) }) };
    }
    const m = u.message;
    if (!m || !m.from) return null;
    const out = { sender: m.from.id, senderName: m.from.first_name, chat: m.chat.id, text: m.text || m.caption || '', replyTo: m.reply_to_message ? String(m.reply_to_message.message_id) : null };
    const voice = m.voice || m.audio || m.video_note;
    if (voice) return Object.assign(out, { kind: 'voice', fileId: voice.file_id, mime: voice.mime_type || 'audio/ogg', size: voice.file_size });
    if (m.document) return Object.assign(out, { kind: 'file', fileId: m.document.file_id, fileName: m.document.file_name || 'arquivo', size: m.document.file_size });
    if (m.photo && m.photo.length) { const p = m.photo[m.photo.length - 1]; return Object.assign(out, { kind: 'file', fileId: p.file_id, fileName: 'foto-' + m.message_id + '.jpg', size: p.file_size }); }
    return Object.assign(out, { kind: 'text' });
  }

  async function handle(u, onMessage) {
    const m = parse(u);
    if (!m) return;
    if ((m.kind === 'voice' || m.kind === 'file') && m.fileId) {
      if (m.size && m.size > 20 * 1024 * 1024) { await api('sendMessage', { chat_id: m.chat, text: 'Arquivo grande demais para o bot (limite do Telegram: 20 MB).' }).catch(() => {}); return; }
      try { m.buf = await download(m.fileId); } catch (e) { log('telegram: ' + e.message); await api('sendMessage', { chat_id: m.chat, text: 'Não consegui baixar o arquivo: ' + e.message }).catch(() => {}); return; }
    }
    await onMessage(m);
  }

  async function start(onMessage) {
    if (running) return;
    if (!token()) throw new Error('sem token');
    running = true; lastError = '';
    try {
      const me = await api('getMe', {});
      botName = me.username ? '@' + me.username : me.first_name;
      connected = true;
    } catch (e) {
      running = false; connected = false; lastError = e.code === 401 || e.code === 404 ? 'token inválido' : e.message;
      throw new Error(lastError);
    }
    loop = (async () => {
      let wait = 2000;
      while (running) {
        ctrl = new AbortController();
        try {
          const ups = await api('getUpdates', { offset, timeout: deps.pollTimeout != null ? deps.pollTimeout : 50, allowed_updates: ['message', 'callback_query'] }, AbortSignal.any([ctrl.signal, AbortSignal.timeout(70000)]));
          connected = true; lastError = ''; wait = 2000;
          for (const u of ups || []) {
            offset = u.update_id + 1;
            try { await handle(u, onMessage); } catch (e) { log('telegram: ' + e.message); }
          }
          if (deps.api && (!ups || !ups.length)) await new Promise(r => setTimeout(r, 20));   // transporte de teste
        } catch (e) {
          if (!running) break;
          lastError = e.code === 409 ? 'outro programa está lendo este bot (feche-o)' : e.code === 401 ? 'token inválido' : e.message;
          if (e.code === 401) { connected = false; running = false; break; }
          await new Promise(r => setTimeout(r, wait)); wait = Math.min(60000, wait * 2);
        }
      }
    })();
  }

  async function stop() {
    running = false; connected = false;
    if (ctrl) ctrl.abort();
    if (loop) { try { await loop; } catch (_) { /* parado */ } loop = null; }
  }

  return {
    name: 'telegram', label: 'Telegram', maxText: 4000, maxFile: 45 * 1024 * 1024,
    configured: () => !!token(), connected: () => connected && running,
    start, stop,
    async send(chat, text, opts) {
      const r = await api('sendMessage', { chat_id: chat, text, disable_web_page_preview: true, reply_markup: keyboard(opts && opts.buttons) });
      return String(r.message_id);
    },
    async sendFile(chat, abs, caption, opts) {
      const fs = require('node:fs'), path = require('node:path');
      const form = new FormData();
      form.append('chat_id', String(chat));
      form.append('document', new Blob([fs.readFileSync(abs)]), path.basename(abs));
      if (caption) form.append('caption', caption.slice(0, 1000));
      const kb = keyboard(opts && opts.buttons);
      if (kb) form.append('reply_markup', JSON.stringify(kb));
      const r = await api('sendDocument', form);
      return String(r.message_id);
    },
    async clearButtons(chat, ref, note) {
      await api('editMessageReplyMarkup', { chat_id: chat, message_id: Number(ref), reply_markup: note ? { inline_keyboard: [[{ text: note.slice(0, 60), callback_data: 'noop' }]] } : { inline_keyboard: [] } });
    },
    typing: (chat) => api('sendChatAction', { chat_id: chat, action: 'typing' }),
    status: () => ({ connected: connected && running, bot: botName, error: lastError })
  };
}

module.exports = { makeTelegram };
