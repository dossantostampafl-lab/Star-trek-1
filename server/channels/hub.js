'use strict';
/* server/channels/hub.js — a central dos canais (Telegram, Discord): o comandante fala com a estação de qualquer lugar.
   - Pareamento: o painel mostra um código; quem mandar esse código ao bot vira o DONO. Mensagens de outras pessoas
     são ignoradas (a estação é privada).
   - Mensagem comum → vai para o Capitão (ou para quem você escolheu com /falar). A resposta volta no canal, inclusive
     o resultado final que percorre as esteiras e volta ao Capitão.
   - Áudio → transcrito (Whisper) e tratado como texto. Arquivo → salvo em entrada/ da pasta compartilhada.
   - A estação avisa no canal: perguntas dos tripulantes (com botões), pedidos de permissão, entregas (com o arquivo
     e botões Aceitar/Refazer), relatório da manhã, vigias de site e tarefas contínuas.
   Cada adaptador (telegram.js, discord.js) só traduz mensagens; a lógica fica aqui. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HELP = [
  'Comandos:',
  '/status — quem está trabalhando',
  '/tripulacao — lista de tripulantes',
  '/falar Nome — passa a conversar com esse tripulante (padrão: Capitão)',
  '/para Nome texto — manda só esta mensagem para um tripulante',
  '/parar — interrompe o trabalho de quem você está falando',
  '/perguntas — perguntas esperando você',
  '/entregas — últimas entregas',
  '/missoes — missões ativas',
  '/relatorio — último relatório da manhã',
  'Mensagem comum vai para o Capitão (ou quem você escolheu). Áudio e arquivos também funcionam.'
].join('\n');

const NOTIFY_KEYS = ['perguntas', 'permissoes', 'entregas', 'relatorios', 'vigias'];

function chunk(text, max) {
  const out = [];
  let t = String(text || '');
  while (t.length > max) {
    let cut = t.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = t.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(t.slice(0, cut)); t = t.slice(cut).replace(/^\s+/, '');
  }
  if (t) out.push(t);
  return out;
}

function makeHub(deps) {
  const { db, bus, station } = deps;
  const log = deps.log || (() => {});
  const adapters = new Map();          // nome → adaptador
  const refs = new Map();              // "canal:msg" → { kind, id }
  const sentFor = new Map();           // "question:ID" / "consent:ID" / "deliverable:ID" → [{ch, ref}]
  const awaiting = new Map();          // canal → { kind: 'redo', id, until }
  const warnedStrangers = new Set();

  const S = (ch, k, d) => db.getSetting(ch + '_' + k, d);
  const setS = (ch, k, v) => db.setSetting(ch + '_' + k, v);
  const notifyOn = (ch, key) => S(ch, 'notify_' + key, '1') !== '0';
  const agents = () => db.listAgents();
  const captain = () => agents().find(a => a.captain) || agents()[0] || null;
  const byName = (name) => { const n = String(name || '').trim().toLowerCase(); return agents().find(a => a.name.toLowerCase() === n) || agents().find(a => a.name.toLowerCase().startsWith(n)) || null; };
  const target = (ch) => (S(ch, 'target', '') && db.getAgent(S(ch, 'target', ''))) || captain();

  function register(adapter) { adapters.set(adapter.name, adapter); }
  const paired = (ch) => !!S(ch, 'owner', '');
  const live = () => [...adapters.values()].filter(a => a.connected && a.connected() && paired(a.name));
  function canAsk() { return live().length > 0; }

  // ---- pareamento
  function newPairCode(ch) {
    const code = String(crypto.randomInt(100000, 999999));
    setS(ch, 'pair_code', code);
    setS(ch, 'pair_until', String(Date.now() + 15 * 60000));
    setS(ch, 'pair_tries', '0');
    return code;
  }
  function unpair(ch) { setS(ch, 'owner', ''); setS(ch, 'chat', ''); }

  // ---- envio
  async function send(ch, text, opts) {
    const ad = adapters.get(ch);
    if (!ad || !ad.connected() || !paired(ch)) return [];
    const parts = chunk(text, ad.maxText || 3500);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      try { out.push(await ad.send(S(ch, 'chat', ''), parts[i], i === parts.length - 1 ? opts : undefined)); }
      catch (e) { log(ch + ': falha ao enviar — ' + e.message); }
    }
    return out.filter(Boolean);
  }
  async function broadcast(key, text, opts, track) {
    for (const ad of live()) {
      if (key && !notifyOn(ad.name, key)) continue;
      const res = await send(ad.name, text, opts);
      const last = res[res.length - 1];
      if (last && track) {
        refs.set(ad.name + ':' + last, track);
        const k = track.kind + ':' + track.id;
        if (!sentFor.has(k)) sentFor.set(k, []);
        sentFor.get(k).push({ ch: ad.name, ref: last });
      }
    }
  }
  async function closeButtons(kind, id, note) {
    const list = sentFor.get(kind + ':' + id) || [];
    sentFor.delete(kind + ':' + id);
    for (const { ch, ref } of list) {
      const ad = adapters.get(ch);
      try { if (ad && ad.clearButtons) await ad.clearButtons(S(ch, 'chat', ''), ref, note); } catch (_) { /* mensagem antiga */ }
    }
  }

  // ---- entrada
  async function incoming(ch, m) {
    const ad = adapters.get(ch);
    const owner = S(ch, 'owner', '');
    if (!owner || String(m.sender) !== owner) {
      const code = S(ch, 'pair_code', '');
      const valid = code && Number(S(ch, 'pair_until', '0')) > Date.now();
      if (valid && String(m.text || '').includes(code)) {
        setS(ch, 'owner', String(m.sender)); setS(ch, 'chat', String(m.chat)); setS(ch, 'pair_code', '');
        bus.emit({ type: 'channel_paired', channel: ch, name: m.senderName || '' });
        const cap = captain();
        await send(ch, '✅ Estação pareada. Olá, comandante' + (m.senderName ? ' ' + m.senderName : '') + '!\n' +
          'Suas mensagens vão para ' + (cap ? cap.name : 'a tripulação') + '.\n\n' + HELP);
        return;
      }
      // tentativas erradas de código: depois de 5, o código é cancelado (evita chute)
      if (valid && /\d{4,}/.test(String(m.text || ''))) {
        const tries = Number(S(ch, 'pair_tries', '0')) + 1;
        setS(ch, 'pair_tries', String(tries));
        if (tries >= 5) { setS(ch, 'pair_code', ''); setS(ch, 'pair_tries', '0'); bus.emit({ type: 'warning', message: ch + ': código de pareamento cancelado depois de 5 tentativas erradas. Gere outro.' }); }
      }
      if (!warnedStrangers.has(ch + m.sender)) {
        warnedStrangers.add(ch + m.sender);
        try { await ad.send(String(m.chat), owner ? 'Esta estação é privada.' : 'Para parear, mande o código que aparece no painel da estação (aba Canais).'); } catch (_) { /* ok */ }
      }
      return;
    }
    if (String(m.chat) !== S(ch, 'chat', '')) setS(ch, 'chat', String(m.chat));   // dono mudou de conversa

    if (m.kind === 'button') return onButton(ch, m);
    if (m.kind === 'voice') {
      let text;
      try { text = await deps.transcribe(m.buf, m.mime); }
      catch (e) { await send(ch, '🎙 Não consegui transcrever: ' + e.message); return; }
      if (!text) { await send(ch, '🎙 Não entendi o áudio.'); return; }
      await send(ch, '🎙 “' + text + '”');
      return onText(ch, Object.assign({}, m, { text }));
    }
    if (m.kind === 'file') {
      let rel;
      try { rel = saveUpload(m.fileName, m.buf); } catch (e) { await send(ch, '📎 Não salvei o arquivo: ' + e.message); return; }
      bus.emit({ type: 'files_changed', scope: 'shared' });
      if (!String(m.text || '').trim()) { await send(ch, '📎 Salvo em ' + rel + ' (pasta compartilhada). Diga o que fazer com ele.'); return; }
      return onText(ch, Object.assign({}, m, { text: m.text + '\n\n(Arquivo enviado pelo comandante: ' + rel + ' — leia com shared_read_file)' }));
    }
    return onText(ch, m);
  }

  function saveUpload(name, buf) {
    if (!buf || !buf.length) throw new Error('arquivo vazio');
    if (buf.length > 25 * 1024 * 1024) throw new Error('maior que 25 MB');
    const clean = String(name || 'arquivo').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'arquivo';
    const dir = path.join(station.sharedDir(), 'entrada');
    fs.mkdirSync(dir, { recursive: true });
    let finalName = clean, n = 2;
    const ext = path.extname(clean), base = clean.slice(0, clean.length - ext.length);
    while (fs.existsSync(path.join(dir, finalName))) finalName = base + '-' + n++ + ext;
    fs.writeFileSync(path.join(dir, finalName), buf);
    return 'entrada/' + finalName;
  }

  async function onText(ch, m) {
    const text = String(m.text || '').trim();
    if (!text) return;
    // resposta a uma pergunta (respondendo a mensagem dela)
    if (m.replyTo) {
      const tr = refs.get(ch + ':' + m.replyTo);
      if (tr && tr.kind === 'question') {
        try { deps.questions.answer(tr.id, text, ch); await send(ch, '✅ Resposta enviada.'); } catch (e) { await send(ch, e.message); }
        return;
      }
    }
    const wait = awaiting.get(ch);
    if (wait && wait.until > Date.now() && !text.startsWith('/')) {
      awaiting.delete(ch);
      if (wait.kind === 'redo') {
        try { deps.deliverables.redo(wait.id, text); await send(ch, '🔁 Pedido de refazer enviado.'); } catch (e) { await send(ch, e.message); }
        return;
      }
    }
    if (text.startsWith('/')) return command(ch, text);
    const m2 = text.match(/^@([^\s:]+(?:\s[^\s:]+)?)[:\s]\s*([\s\S]+)$/);
    if (m2 && byName(m2[1])) return dispatch(ch, byName(m2[1]), m2[2]);
    return dispatch(ch, target(ch), text);
  }

  async function dispatch(ch, agent, text) {
    if (!agent) { await send(ch, 'A estação não tem tripulantes. Embarque a tripulação no painel.'); return; }
    try {
      const st = station.status()[agent.id] || {};
      station.enqueue(agent.id, text.slice(0, 20000), 'channel', { origin: { channel: ch } });
      const ad = adapters.get(ch);
      if (ad && ad.typing) ad.typing(S(ch, 'chat', '')).catch(() => {});
      if (st.busy || st.queued) await send(ch, '📨 ' + agent.name + ' está ocupado — sua mensagem entrou na fila (' + ((st.queued || 0) + 1) + ').');
    } catch (e) { await send(ch, '⚠ ' + e.message); }
  }

  async function command(ch, text) {
    const [cmd0, ...rest] = text.split(/\s+/);
    const cmd = cmd0.toLowerCase().replace(/@\S+$/, '');
    const arg = rest.join(' ').trim();
    const st = station.status();
    if (cmd === '/start' || cmd === '/ajuda' || cmd === '/help') return send(ch, HELP);
    if (cmd === '/status') {
      const lines = agents().map(a => (st[a.id] && st[a.id].busy ? '🟢 ' : '⚪ ') + a.name + (st[a.id] && st[a.id].busy ? ' — trabalhando' : '') + (st[a.id] && st[a.id].queued ? ' · ' + st[a.id].queued + ' na fila' : ''));
      const t = target(ch);
      return send(ch, lines.join('\n') + '\n\nVocê está falando com: ' + (t ? t.name : '—') +
        (deps.questions.pending() ? '\n❓ ' + deps.questions.pending() + ' pergunta(s) esperando você — /perguntas' : ''));
    }
    if (cmd === '/tripulacao') return send(ch, agents().map(a => (a.captain ? '★ ' : '• ') + a.name + (a.role ? ' — ' + a.role : '')).join('\n'));
    if (cmd === '/falar') {
      const a = arg ? byName(arg) : captain();
      if (!a) return send(ch, 'Não achei "' + arg + '". Use /tripulacao.');
      setS(ch, 'target', a.captain ? '' : a.id);
      return send(ch, '🔀 Agora você fala com ' + a.name + '.');
    }
    if (cmd === '/para') {
      const names = agents().map(a => a.name).sort((x, y) => y.length - x.length);
      const hit = names.find(n => arg.toLowerCase().startsWith(n.toLowerCase()));
      if (!hit) return send(ch, 'Use: /para Nome texto');
      return dispatch(ch, byName(hit), arg.slice(hit.length).replace(/^[:\s]+/, ''));
    }
    if (cmd === '/parar') { const a = arg ? byName(arg) : target(ch); if (!a) return send(ch, 'Quem?'); station.cancel(a.id); return send(ch, '⏹ Parei o trabalho de ' + a.name + '.'); }
    if (cmd === '/perguntas') {
      const open = deps.questions.list('aberta');
      if (!open.length) return send(ch, 'Nenhuma pergunta esperando você.');
      for (const q of open.slice(0, 5)) await sendQuestion(ch, q);
      return;
    }
    if (cmd === '/entregas') {
      const ds = deps.deliverables.list(5);
      if (!ds.length) return send(ch, 'Nenhuma entrega ainda.');
      return send(ch, ds.map(d => verdictIcon(d.verdict) + ' ' + d.title + ' — ' + agentName(d.agent_id) + ' (' + (d.scope === 'shared' ? 'shared/' : '') + d.rel + ')').join('\n'));
    }
    if (cmd === '/missoes') {
      const ms = db.listMissions().filter(m => m.status === 'ativa');
      if (!ms.length) return send(ch, 'Nenhuma missão ativa.');
      return send(ch, ms.map(m => 'M' + m.num + ' — ' + m.title + ' (' + m.steps.filter(s => s.done).length + '/' + m.steps.length + ')').join('\n'));
    }
    if (cmd === '/relatorio') {
      const r = db.listReports(1)[0];
      if (!r) return send(ch, 'Ainda não há relatório da manhã.');
      return send(ch, r.body || r.title);
    }
    if (cmd === '/pular') { awaiting.delete(ch); return send(ch, 'Ok.'); }
    return send(ch, 'Comando desconhecido.\n\n' + HELP);
  }

  const agentName = (id) => (db.getAgent(id) || {}).name || '?';
  const verdictIcon = (v) => v === 'ok' ? '✅' : v === 'aviso' ? '⚠️' : '❌';

  async function sendQuestion(ch, q) {
    const buttons = q.options.map((o, i) => [{ label: o, data: 'q:' + q.id + ':' + i }]);
    buttons.push([{ label: 'Descartar', data: 'q:' + q.id + ':x' }]);
    const res = await send(ch, '❓ ' + agentName(q.agent_id) + ' pergunta:\n' + q.question + (q.context ? '\n(' + q.context + ')' : '') +
      (q.default_option ? '\nSe você não responder, segue com: ' + q.default_option : '') + '\n\nToque numa opção ou RESPONDA esta mensagem com outra resposta.', { buttons });
    const last = res[res.length - 1];
    if (last) {
      refs.set(ch + ':' + last, { kind: 'question', id: q.id });
      if (!sentFor.has('question:' + q.id)) sentFor.set('question:' + q.id, []);
      sentFor.get('question:' + q.id).push({ ch, ref: last });
    }
  }

  async function onButton(ch, m) {
    const [kind, id, val] = String(m.data || '').split(':');
    const ack = (t) => m.ack ? m.ack(t).catch(() => {}) : null;
    try {
      if (kind === 'noop') { ack(''); return; }
      if (kind === 'q') {
        if (val === 'x') { deps.questions.dismiss(id); ack('Descartada'); return; }
        const q = deps.questions.get(id);
        if (!q) return ack('Pergunta não existe mais');
        deps.questions.answer(id, q.options[Number(val)] || val, ch);
        ack('Resposta enviada');
      } else if (kind === 'c') {
        const ok = deps.resolveConsent(id, val);
        ack(ok ? (val === 'deny' ? 'Negado' : 'Permitido') : 'Pedido já encerrado');
      } else if (kind === 'd') {
        if (val === 'ok') { deps.deliverables.setStatus(id, 'aceita'); ack('Aceita'); await closeButtons('deliverable', id, '✅ Aceita'); }
        else { awaiting.set(ch, { kind: 'redo', id, until: Date.now() + 15 * 60000 }); ack('Diga o motivo'); await send(ch, '🔁 O que precisa mudar? Responda em uma mensagem (ou /pular para refazer sem motivo).'); }
      }
    } catch (e) { ack(e.message.slice(0, 180)); }
  }

  // ---- eventos da estação → canais
  async function onEvent(ev) {
    if (!live().length) return;
    try {
      if (ev.type === 'run_end' && ev.meta && ev.meta.origin && ev.meta.origin.channel && adapters.has(ev.meta.origin.channel)) {
        const a = db.getAgent(ev.agentId);
        const ch = ev.meta.origin.channel;
        const direct = ev.source === 'channel';
        if (!a || (!direct && !a.captain)) return;   // do meio da esteira: só o Capitão fecha o assunto
        if (ev.status === 'done') await send(ch, (direct ? '' : '📦 Resultado final — ') + a.name + ':\n\n' + (ev.output || '(sem texto)'));
        else if (ev.status === 'error') await send(ch, '⚠ ' + a.name + ' parou com erro: ' + String(ev.error || '').slice(0, 400));
        return;
      }
      if (ev.type === 'question') { const q = deps.questions.get(ev.id); if (q) for (const ad of live()) if (notifyOn(ad.name, 'perguntas')) await sendQuestion(ad.name, q); return; }
      if (ev.type === 'question_answered' || ev.type === 'question_expired') {
        return closeButtons('question', ev.id, ev.type === 'question_expired' ? '⌛ Sem resposta — seguiu pelo padrão' : ev.answer == null ? '✖ Descartada' : '✅ Respondida: ' + String(ev.answer).slice(0, 100));
      }
      if (ev.type === 'consent_request') {
        const labels = { once: 'Permitir uma vez', session: 'Nesta sessão', always: 'Sempre', deny: 'Negar' };
        const args = JSON.stringify(ev.args || {}).slice(0, 500);
        return broadcast('permissoes', '🔐 ' + (ev.agentName || agentName(ev.agentId)) + ' pede permissão para usar ' + (ev.tool && ev.tool.name) + ':\n' + args,
          { buttons: (ev.choices || []).map(c => [{ label: labels[c] || c, data: 'c:' + ev.id + ':' + c }]) }, { kind: 'consent', id: ev.id });
      }
      if (ev.type === 'consent_closed') return closeButtons('consent', ev.id, '🔐 Encerrado');
      if (ev.type === 'deliverable') {
        const d = deps.deliverables.get(ev.id);
        if (!d) return;
        const caption = '📦 Entrega de ' + ev.agentName + ': ' + d.title + '\n' + verdictIcon(d.verdict) + ' conferência: ' + d.verdict +
          (d.summary ? '\n' + d.summary : '') + d.checks.filter(c => c.level !== 'ok').map(c => '\n• ' + c.name + (c.detail ? ' — ' + c.detail : '')).join('');
        const buttons = [[{ label: '✅ Aceitar', data: 'd:' + d.id + ':ok' }, { label: '🔁 Refazer', data: 'd:' + d.id + ':redo' }]];
        for (const ad of live()) {
          if (!notifyOn(ad.name, 'entregas')) continue;
          let ref = null;
          try {
            const abs = deps.deliverables.absOf(d);
            const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
            if (size && size <= (ad.maxFile || 20 * 1024 * 1024) && ad.sendFile) ref = await ad.sendFile(S(ad.name, 'chat', ''), abs, caption.slice(0, 1000), { buttons });
          } catch (e) { log(ad.name + ': arquivo — ' + e.message); }
          if (!ref) { const r = await send(ad.name, caption, { buttons }); ref = r[r.length - 1]; }
          if (ref) { if (!sentFor.has('deliverable:' + d.id)) sentFor.set('deliverable:' + d.id, []); sentFor.get('deliverable:' + d.id).push({ ch: ad.name, ref }); }
        }
        return;
      }
      if (ev.type === 'report') return broadcast('relatorios', '☀ ' + (ev.body || ev.title));
      if (ev.type === 'job_update') return broadcast('vigias', ev.message + (ev.url ? '\n' + ev.url : ''));
      if (ev.type === 'claim_missing') return broadcast('entregas', '⚠ ' + ev.agentName + ' disse ter salvo ' + ev.files.join(', ') + ', mas o arquivo não existe.');
    } catch (e) { log('canais: ' + e.message); }
  }
  bus.on((ev) => { onEvent(ev); });

  async function startAll() {
    for (const ad of adapters.values()) {
      if (!ad.configured()) continue;
      try { await ad.start((m) => incoming(ad.name, m).catch(e => log(ad.name + ': ' + e.message))); }
      catch (e) { log(ad.name + ': não conectou — ' + e.message); }
    }
  }
  async function restart(ch) {
    const ad = adapters.get(ch);
    if (!ad) throw new Error('canal desconhecido');
    await ad.stop();
    if (ad.configured()) await ad.start((m) => incoming(ch, m).catch(e => log(ch + ': ' + e.message)));
  }
  function stopAll() { for (const ad of adapters.values()) ad.stop(); }

  function status() {
    const out = {};
    for (const ad of adapters.values()) {
      const s = ad.status();
      out[ad.name] = Object.assign({}, s, {
        configured: ad.configured(), paired: paired(ad.name),
        pairCode: Number(S(ad.name, 'pair_until', '0')) > Date.now() ? S(ad.name, 'pair_code', '') : '',
        notify: Object.fromEntries(NOTIFY_KEYS.map(k => [k, notifyOn(ad.name, k)])),
        target: (target(ad.name) || {}).name || ''
      });
    }
    return out;
  }
  function setNotify(ch, key, on) { if (!NOTIFY_KEYS.includes(key)) throw new Error('aviso desconhecido'); setS(ch, 'notify_' + key, on ? '1' : '0'); }

  return { register, incoming, send, broadcast, canAsk, newPairCode, unpair, startAll, stopAll, restart, status, setNotify, adapters, onEvent };
}

module.exports = { makeHub, chunk, HELP };
