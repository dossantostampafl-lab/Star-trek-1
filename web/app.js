/* web/app.js — painel da estação: estado, eventos em tempo real, tripulação, canal (chat), esteiras,
   agenda, conectores, permissões e registro. Todo texto vindo do servidor entra como textContent (sem HTML). */
'use strict';
(function () {
  const TOKEN = document.querySelector('meta[name="st1-token"]').content;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  // ---------- utilidades ----------
  function h(tag, attrs) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.setAttribute('style', v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const usd = (v) => 'US$ ' + (v > 0 && v < 0.01 ? Number(v).toFixed(4) : Number(v || 0).toFixed(2));
  const when = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const agentName = (id) => (S.agents.find(a => a.id === id) || {}).name || '?';
  const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: { 'x-st1-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && j.login) { location.href = '/login'; throw new Error('sessão expirada'); }
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    return j;
  }
  const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  // ---------- estado ----------
  const S = { agents: [], conveyors: [], schedules: [], status: {}, totals: {}, mcp: { configured: [], live: [] }, grants: [], shellAvailable: false, provider: {} };
  let selected = null;
  let editing = null;
  let refreshTimer = null;
  const live = {};   // agentId → { bubble, text } da resposta em andamento

  async function refresh() {
    try {
      Object.assign(S, await api('GET', '/api/state'));
      if (selected && !S.agents.some(a => a.id === selected)) selected = null;
      if (!selected && S.agents.length) selected = (S.agents.find(a => a.captain) || S.agents[0]).id;
      renderAll();
    } catch (e) { toast('Falha ao ler a estação: ' + e.message, true); }
  }
  function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 120); }

  function renderAll() {
    Station.setDecor(S.decor);
    Station.setData(S.agents, S.conveyors, S.status);
    if (Station.isEditing()) renderEditor();
    Station.setSelected(selected);
    renderTop(); renderCrew(); renderAgentSelects(); renderChatHead(); renderBelts(); renderSchedules(); renderMcp(); renderLog(); renderFilesScope();
  }

  function renderTop() {
    const p = S.provider || {};
    $('#chip-provider').textContent = (p.name || '—') + ' · ' + (p.model || '') + (p.fallback ? ' ↺ ' + p.fallback : '');
    $('#chip-cost').textContent = usd((S.totals || {}).cost_usd || 0);
    const sh = $('#chip-shell');
    sh.textContent = S.shellAvailable ? 'terminal: docker ok' : 'terminal: sem docker';
    sh.className = 'chip ' + (S.shellAvailable ? 'ok' : 'warn');
    $('#chip-logout').hidden = !S.authEnabled;
  }
  $('#chip-logout').addEventListener('click', safe(async () => {
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  }));

  // ---------- tripulação ----------
  function renderCrew() {
    const box = $('#crew-list');
    box.replaceChildren();
    if (!S.agents.length) box.append(h('div', { class: 'empty', text: 'Nenhum tripulante ainda. Recrute o primeiro abaixo — ele já usa o FreeLLMAPI, sem custo.' }));
    for (const a of S.agents) {
      const st = S.status[a.id] || {};
      const g = (S.growth || []).find(x => x.id === a.id);
      box.append(h('div', { class: 'item' + (a.id === selected ? ' sel' : '') },
        h('span', { class: 'swatch', style: 'background:' + a.color + ';color:' + a.color }),
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, a.captain ? h('span', { class: 'badge-cap', text: '★', title: 'Capitão' }) : null, a.name,
            g ? h('span', { class: 'lv', title: g.xp + ' XP · próximo nível em ' + g.next + ' XP', text: 'Nv ' + g.level }) : null),
          g ? h('div', { class: 'sub' },
            'confiança ', h('span', { class: 'meter', title: g.trust + '/100 — ' + g.autonomy }, h('i', { style: 'width:' + g.trust + '%;background:' + (g.trust >= 70 ? 'var(--green)' : g.trust >= 40 ? 'var(--cyan)' : 'var(--red)') })),
            ' ' + g.autonomy + ' ', h('span', { class: 'trophies', title: g.trophies.map(t => t.title).join(' · '), text: g.trophies.map(t => t.icon).join('') })) : null,
          h('div', { class: 'sub', text: [a.role || 'sem função definida', (a.provider || 'padrão') + (a.model ? '/' + a.model : ''), a.shell ? 'terminal' : '', (a.mcp || []).length ? (a.mcp.length + ' conector(es)') : '', a.budget_usd > 0 ? usd(a.spent_usd) + ' de ' + usd(a.budget_usd) : (a.spent_usd > 0 ? usd(a.spent_usd) : '')].filter(Boolean).join(' · ') })),
        h('span', { class: 'state' + (st.busy ? ' busy' : ''), text: st.busy ? 'trabalhando' : st.queued ? st.queued + ' na fila' : 'livre' }),
        h('button', { class: 'btn small', text: 'Falar', onclick: () => openChat(a.id) }),
        h('button', { class: 'btn small ghost', text: 'Editar', onclick: () => editAgent(a) })));
    }
    renderAgentMcpPicker();
  }

  function renderAgentMcpPicker() {
    const box = $('#agent-mcp-list');
    const current = editing ? (editing.mcp || []) : [];
    box.replaceChildren();
    if (!S.mcp.configured.length) { box.textContent = 'nenhum conector cadastrado (aba Conectores)'; box.className = 'muted'; return; }
    box.className = '';
    for (const m of S.mcp.configured) {
      box.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'mcp', value: m.name, checked: current.includes(m.name) }), m.name));
    }
  }

  function editAgent(a) {
    editing = a;
    const f = $('#agent-form');
    f.id.value = a.id; f.name.value = a.name; f.role.value = a.role || ''; f.instructions.value = a.instructions || '';
    f.provider.value = a.provider || ''; f.model.value = a.model || ''; f.budget_usd.value = a.budget_usd || ''; f.color.value = a.color || '#5ec8ff';
    f.shell.checked = !!a.shell;
    $('#agent-form-title').textContent = 'Editar ' + a.name;
    $('#agent-save').textContent = 'Salvar';
    $('#agent-cancel').hidden = false; $('#agent-delete').hidden = false;
    renderAgentMcpPicker();
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.name.focus();
  }
  function resetAgentForm() {
    editing = null;
    const f = $('#agent-form');
    f.reset(); f.id.value = '';
    $('#agent-form-title').textContent = 'Recrutar tripulante';
    $('#agent-save').textContent = 'Recrutar';
    $('#agent-cancel').hidden = true; $('#agent-delete').hidden = true;
    renderAgentMcpPicker();
  }

  $('#agent-form').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      name: f.name.value.trim(), role: f.role.value.trim(), instructions: f.instructions.value.trim(),
      provider: f.provider.value, model: f.model.value.trim(), budget_usd: Number(f.budget_usd.value) || 0,
      color: f.color.value, shell: f.shell.checked, mcp: $$('input[name=mcp]:checked', f).map(i => i.value)
    };
    if (body.shell && !S.shellAvailable) toast('Terminal marcado, mas o Docker não foi encontrado — ele só funciona com o Docker rodando.');
    if (f.id.value) { await api('PATCH', '/api/agents/' + f.id.value, body); toast(body.name + ' atualizado.'); }
    else { const a = await api('POST', '/api/agents', body); selected = a.id; toast(a.name + ' embarcou na estação.'); }
    resetAgentForm();
    await refresh();
  }));
  $('#agent-cancel').addEventListener('click', resetAgentForm);
  $('#crew-preset').addEventListener('click', safe(async () => {
    const r = await api('POST', '/api/crew/preset');
    toast(r.created.length ? 'Embarcaram: ' + r.created.join(', ') + '.' : 'A tripulação pronta já está completa.');
    await refresh();
    const cap = S.agents.find(a => a.captain);
    if (cap) openChat(cap.id);
  }));
  $('#agent-delete').addEventListener('click', safe(async () => {
    if (!editing || !confirm('Dispensar ' + editing.name + '? O histórico, a agenda e as esteiras dele serão apagados (a pasta de arquivos fica).')) return;
    await api('DELETE', '/api/agents/' + editing.id);
    resetAgentForm();
    await refresh();
  }));

  function renderAgentSelects() {
    for (const sel of $$('.agent-select, #chat-agent')) {
      const v = sel.value || (sel.id === 'chat-agent' ? selected : '');
      sel.replaceChildren(...S.agents.map(a => h('option', { value: a.id, text: a.name })));
      if (S.agents.some(a => a.id === v)) sel.value = v;
    }
    if (selected) $('#chat-agent').value = selected;
  }

  // ---------- canal (chat) ----------
  function switchTab(name) {
    $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    $$('.tab-body').forEach(b => b.classList.toggle('on', b.dataset.body === name));
    if (name === 'log') loadRuns();
    if (name === 'files') loadFiles();
    if (name === 'mcp') loadCatalog();
    if (name === 'missions') loadMissions();
  }
  $$('.tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  function openChat(id) {
    const changed = id !== selected;
    selected = id;
    Station.setSelected(id);
    switchTab('chat');
    renderCrew(); renderChatHead();
    if (changed || !$('#chat-log').childElementCount) loadHistory();
    setTimeout(() => $('#chat-input').focus(), 50);
  }
  $('#chat-agent').addEventListener('change', (e) => openChat(e.target.value));

  function renderChatHead() {
    const st = S.status[selected] || {};
    $('#chat-cancel').hidden = !(st.busy || st.queued);
  }

  const log = () => $('#chat-log');
  function scrollChat() { const l = log(); l.scrollTop = l.scrollHeight; }
  function addMsg(role, text, extra) {
    const el = h('div', { class: 'msg ' + role }, text);
    if (extra) el.append(extra);
    log().append(el); scrollChat();
    return el;
  }
  function addTool(name, args) {
    let pretty = args;
    try { const o = JSON.parse(args); pretty = o.command || o.path || o.url || o.task || JSON.stringify(o); } catch (_) { /* texto cru */ }
    const el = h('div', { class: 'msg tool' }, '⚙ ' + name + ' ', h('span', { text: short(pretty, 160) }));
    log().append(el); scrollChat();
    return el;
  }

  const loadHistory = safe(async () => {
    const l = log();
    l.replaceChildren();
    if (!selected) { l.append(h('div', { class: 'empty', text: 'Recrute um tripulante para abrir um canal.' })); return; }
    const hist = await api('GET', '/api/agents/' + selected + '/history');
    if (!hist.length) addMsg('system', 'Canal aberto com ' + agentName(selected) + '. Diga o que precisa.');
    for (const m of hist) {
      if (m.role === 'tool') addTool(m.name, m.args);
      else addMsg(m.role, m.text);
    }
    const lv = live[selected];
    if (lv) { lv.bubble = addMsg('assistant', lv.text); lv.bubble.classList.add('cursor'); }
  });

  $('#chat-form').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || !selected) return;
    input.value = ''; autoGrow();
    addMsg('user', text);
    await api('POST', '/api/agents/' + selected + '/message', { text });
  }));
  const input = $('#chat-input');
  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; }
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); } });

  $('#chat-cancel').addEventListener('click', safe(() => api('POST', '/api/agents/' + selected + '/cancel')));
  $('#chat-reset').addEventListener('click', safe(async () => {
    if (!selected || !confirm('Apagar o histórico de ' + agentName(selected) + '? Os arquivos dele continuam.')) return;
    await api('POST', '/api/agents/' + selected + '/reset');
    await loadHistory();
  }));
  $('#chat-undo').addEventListener('click', safe(async () => {
    if (!selected) return;
    const cps = await api('GET', '/api/agents/' + selected + '/checkpoints');
    if (!cps.length) return toast('Nenhum checkpoint ainda — eles são criados antes de cada escrita ou comando.');
    if (!confirm('Restaurar a pasta de ' + agentName(selected) + ' para antes de:\n' + cps[0].label + '\n(' + when(cps[0].at) + ')?')) return;
    await api('POST', '/api/agents/' + selected + '/checkpoints/' + cps[0].id + '/restore');
    toast('Pasta restaurada.');
  }));

  // voz
  const mic = $('#mic');
  if (!Voice.canListen) { mic.disabled = true; mic.title = 'Este navegador não reconhece voz (use Chrome ou Edge)'; }
  mic.addEventListener('click', () => {
    Voice.listen((text, final) => {
      input.value = text; autoGrow();
      if (final && text) $('#chat-form').requestSubmit();
    }, (state, err) => {
      mic.classList.toggle('listening', state === 'listening');
      if (state === 'error') toast('Microfone: ' + err, true);
    });
  });
  const tts = $('#tts');
  if (!Voice.canSpeak) tts.disabled = true;
  try { tts.checked = localStorage.getItem('st1-tts') === '1'; } catch (_) { /* sem storage */ }
  tts.addEventListener('change', () => { try { localStorage.setItem('st1-tts', tts.checked ? '1' : '0'); } catch (_) { /* ok */ } if (!tts.checked) Voice.stop(); });

  // ---------- esteiras ----------
  function renderBelts() {
    const box = $('#belt-list');
    box.replaceChildren();
    if (!S.conveyors.length) box.append(h('div', { class: 'empty', text: 'Nenhuma esteira. Ligue dois tripulantes para o trabalho fluir entre eles.' }));
    for (const c of S.conveyors) {
      box.append(h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 'title', text: agentName(c.from_agent) + ' → ' + agentName(c.to_agent) }), h('div', { class: 'sub', text: (c.auto ? 'automática' : 'manual (pass_work)') + (c.note ? ' · ' + c.note : '') })),
        h('button', { class: 'btn small danger', text: 'Desligar', onclick: safe(async () => { await api('DELETE', '/api/conveyors/' + c.id); await refresh(); }) })));
    }
  }
  $('#belt-form').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const f = e.target;
    await api('POST', '/api/conveyors', { from_agent: f.from_agent.value, to_agent: f.to_agent.value, note: f.note.value.trim(), auto: f.auto.checked });
    f.note.value = '';
    await refresh();
  }));

  // ---------- agenda ----------
  $('#cron-preset').addEventListener('change', (e) => { const f = $('#sched-form'); if (e.target.value) f.cron.value = e.target.value; else f.cron.focus(); });
  function renderSchedules() {
    const box = $('#sched-list');
    box.replaceChildren();
    if (!S.schedules.length) box.append(h('div', { class: 'empty', text: 'Nada agendado.' }));
    for (const s of S.schedules) {
      box.append(h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 'title', text: agentName(s.agent_id) + ' · ' + s.cron }), h('div', { class: 'sub', text: short(s.prompt, 90) }), h('div', { class: 'sub', text: (s.enabled ? s.info : 'pausado') + (s.last_run ? ' · última: ' + when(s.last_run) : '') })),
        h('button', { class: 'btn small', text: 'Rodar', title: 'Rodar agora', onclick: safe(async () => { await api('POST', '/api/schedules/' + s.id + '/run'); toast('Enviado para ' + agentName(s.agent_id) + '.'); }) }),
        h('button', { class: 'btn small ghost', text: s.enabled ? 'Pausar' : 'Ativar', onclick: safe(async () => { await api('PATCH', '/api/schedules/' + s.id, { enabled: !s.enabled }); await refresh(); }) }),
        h('button', { class: 'btn small danger', text: '✕', title: 'Apagar', onclick: safe(async () => { await api('DELETE', '/api/schedules/' + s.id); await refresh(); }) })));
    }
  }
  $('#sched-form').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const f = e.target;
    await api('POST', '/api/schedules', { agent_id: f.agent_id.value, cron: f.cron.value.trim(), prompt: f.prompt.value.trim() });
    f.prompt.value = '';
    toast('Agendado.');
    await refresh();
  }));

  // ---------- conectores ----------
  const mcpForm = $('#mcp-form');
  mcpForm.transport.addEventListener('change', () => {
    const http = mcpForm.transport.value === 'http';
    $$('.only-http', mcpForm).forEach(el => { el.hidden = !http; });
    $$('.only-stdio', mcpForm).forEach(el => { el.hidden = http; });
  });
  mcpForm.addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.name.value.trim(), transport: f.transport.value };
    if (body.transport === 'stdio') { body.command = f.command.value.trim(); body.args = f.args.value.trim(); }
    else { body.url = f.url.value.trim(); if (f.token.value.trim()) body.headers = { authorization: /^bearer /i.test(f.token.value.trim()) ? f.token.value.trim() : 'Bearer ' + f.token.value.trim() }; }
    toast('Conectando ' + body.name + '…');
    const r = await api('POST', '/api/mcp', body);
    if (r.status && r.status.status === 'conectado') toast(body.name + ': ' + r.status.tools.length + ' ferramenta(s). Marque o conector no tripulante.');
    else toast(body.name + ': ' + ((r.status && r.status.error) || 'falhou'), true);
    f.reset(); f.transport.dispatchEvent(new Event('change'));
    await refresh();
  }));
  function renderMcp() {
    const box = $('#mcp-list');
    box.replaceChildren();
    if (!S.mcp.configured.length) box.append(h('div', { class: 'empty', text: 'Nenhum conector. Exemplo local: comando npx, argumentos -y @modelcontextprotocol/server-filesystem C:\\pasta' }));
    for (const m of S.mcp.configured) {
      const st = S.mcp.live.find(x => x.name === m.name) || { status: 'desconectado', tools: [] };
      box.append(h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 'title', text: m.name + ' (' + (m.transport === 'http' ? 'remoto' : 'local') + ')' }),
          h('div', { class: 'sub', text: st.status === 'conectado' ? st.tools.length + ' ferramenta(s): ' + short(st.tools.join(', '), 120) : (st.error || st.status) })),
        h('span', { class: 'state ' + (st.status === 'conectado' ? 'done' : 'error'), text: st.status }),
        h('button', { class: 'btn small ghost', text: 'Reconectar', onclick: safe(async () => { await api('POST', '/api/mcp/' + m.id + '/reconnect'); await refresh(); }) }),
        h('button', { class: 'btn small danger', text: '✕', onclick: safe(async () => { if (confirm('Remover o conector ' + m.name + '?')) { await api('DELETE', '/api/mcp/' + m.id); await refresh(); } }) })));
    }
    const g = $('#grant-list');
    g.replaceChildren();
    if (!S.grants.length) g.append(h('div', { class: 'empty', text: 'Nenhuma permissão permanente.' }));
    for (const x of S.grants) {
      g.append(h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 'title', text: agentName(x.agent_id) + ' · ' + x.key }), h('div', { class: 'sub', text: 'desde ' + when(x.created_at) })),
        h('button', { class: 'btn small danger', text: 'Revogar', onclick: safe(async () => { await api('DELETE', '/api/grants', { agent_id: x.agent_id, key: x.key }); await refresh(); }) })));
    }
  }

  // ---------- avaliações (👍/👎 mexem na confiança e no XP) ----------
  function rateButtons(runId) {
    if (!runId) return '';
    const box = h('span', { class: 'rate' });
    const mk = (v, t, label) => h('button', { type: 'button', text: t, title: label, onclick: safe(async (e) => {
      const was = e.currentTarget.classList.contains('on');
      await api('POST', '/api/runs/' + runId + '/rate', { rating: was ? 0 : v });
      [...box.children].forEach(b => b.classList.remove('on'));
      if (!was) e.currentTarget.classList.add('on');
    }) });
    box.append(mk(1, '👍', 'Boa resposta (+confiança)'), mk(-1, '👎', 'Resposta ruim (−confiança)'));
    return box;
  }

  // ---------- dossiê do comandante ----------
  const loadBeliefs = safe(async () => {
    const list = await api('GET', '/api/beliefs');
    const box = $('#belief-list');
    box.replaceChildren();
    const pend = list.filter(b => b.status === 'proposta');
    const badge = $('#dossier-badge');
    badge.hidden = !pend.length; badge.textContent = pend.length + ' nova(s)';
    if (!list.length) box.append(h('div', { class: 'empty', text: 'Nada ainda. Os tripulantes propõem o que percebem sobre você.' }));
    for (const b of list.filter(b => b.status !== 'rejeitada')) {
      const by = agentName(b.agent_id);
      box.append(h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { text: b.text }), h('div', { class: 'sub', text: (b.status === 'proposta' ? 'proposta' : 'aceita') + (b.agent_id ? ' · por ' + by : ' · por você') })),
        b.status === 'proposta' ? h('button', { class: 'btn small primary', text: 'Aceitar', onclick: safe(async () => { await api('PATCH', '/api/beliefs/' + b.id, { status: 'aceita' }); loadBeliefs(); }) }) : null,
        b.status === 'proposta' ? h('button', { class: 'btn small ghost', text: 'Recusar', onclick: safe(async () => { await api('PATCH', '/api/beliefs/' + b.id, { status: 'rejeitada' }); loadBeliefs(); }) }) : null,
        b.status === 'aceita' ? h('button', { class: 'btn small danger', text: '✕', title: 'Esquecer', onclick: safe(async () => { await api('DELETE', '/api/beliefs/' + b.id); loadBeliefs(); }) }) : null));
    }
  });
  $('#belief-form').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const t = e.target.text.value.trim();
    if (!t) return;
    await api('POST', '/api/beliefs', { text: t });
    e.target.text.value = '';
    loadBeliefs();
  }));

  // ---------- missões, turno da noite, relatórios ----------
  const STATUS_LABEL = { ativa: 'ativa', pausada: 'pausada', concluida: 'concluída', cancelada: 'cancelada' };
  const loadMissions = safe(async () => {
    const [ms, nightCfg, reports] = await Promise.all([api('GET', '/api/missions'), api('GET', '/api/night'), api('GET', '/api/reports')]);
    const box = $('#mission-list');
    box.replaceChildren();
    if (!ms.length) box.append(h('div', { class: 'empty', text: 'Nenhuma missão. Crie uma acima — o Capitão divide em etapas e a tripulação avança, inclusive à noite.' }));
    const order = { ativa: 0, pausada: 1, concluida: 2, cancelada: 3 };
    for (const m of ms.slice().sort((a, b) => (order[a.status] - order[b.status]) || b.num - a.num)) {
      const done = m.steps.filter(x => x.done).length;
      const pct = m.steps.length ? Math.round(100 * done / m.steps.length) : 0;
      const steps = h('div', { class: 'steps' }, ...m.steps.map(st => h('label', null,
        h('input', { type: 'checkbox', checked: st.done, onchange: safe(async () => { await api('PATCH', '/api/missions/' + m.id, { toggleStep: st.id }); loadMissions(); }) }),
        h('span', null, st.id + '. ' + st.text, st.agent ? h('span', { class: 'note', text: ' · ' + st.agent }) : null, st.note ? h('div', { class: 'note', text: st.note }) : null))));
      const addInput = h('input', { placeholder: '+ etapa', style: 'flex:1;background:var(--hull);border:1px solid var(--line);border-radius:4px;padding:4px 6px;color:var(--ink)' });
      const statusBtn = (st, label) => h('button', { class: 'btn small ghost', text: label, onclick: safe(async () => { await api('PATCH', '/api/missions/' + m.id, { status: st }); loadMissions(); }) });
      box.append(h('div', { class: 'item mission' + (m.status === 'ativa' ? '' : ' muted') },
        h('div', { class: 'row' }, h('div', { class: 'title grow', text: 'M' + m.num + ' — ' + m.title }), h('span', { class: 'state ' + (m.status === 'concluida' ? 'done' : m.status === 'ativa' ? 'busy' : ''), text: STATUS_LABEL[m.status] })),
        m.goal ? h('div', { class: 'sub', text: m.goal }) : null,
        h('div', { class: 'progress', title: done + '/' + m.steps.length }, h('i', { style: 'width:' + pct + '%' })),
        steps,
        h('div', { class: 'row' }, addInput,
          h('button', { class: 'btn small', text: 'Adicionar', onclick: safe(async () => { if (!addInput.value.trim()) return; await api('PATCH', '/api/missions/' + m.id, { addStep: addInput.value.trim() }); loadMissions(); }) }),
          m.status === 'ativa' ? statusBtn('pausada', 'Pausar') : statusBtn('ativa', 'Reativar'),
          m.status !== 'concluida' ? statusBtn('concluida', 'Concluir') : null,
          h('button', { class: 'btn small danger', text: '✕', title: 'Apagar', onclick: safe(async () => { if (confirm('Apagar M' + m.num + '?')) { await api('DELETE', '/api/missions/' + m.id); loadMissions(); } }) }))));
    }
    // turno da noite
    const nc = $('#night-card');
    nc.querySelector('[name=enabled]').checked = nightCfg.enabled;
    for (const k of ['start', 'end', 'interval_h', 'max_runs']) nc.querySelector('[name=' + k + ']').value = nightCfg[k];
    $('#night-status').textContent = nightCfg.active_since ? '🌙 Turno em andamento desde ' + when(nightCfg.active_since) + ' · ' + nightCfg.runs + ' rodada(s)' :
      nightCfg.enabled ? 'Ligado: das ' + nightCfg.start + ' às ' + nightCfg.end + ', a cada ' + nightCfg.interval_h + 'h.' : 'Desligado.';
    // relatórios
    const latest = reports[0];
    const lbox = $('#report-latest');
    lbox.replaceChildren();
    if (latest && Date.now() - new Date(latest.created_at) < 20 * 3600e3) lbox.append(h('details', { class: 'card report-card', open: true }, h('summary', null, h('b', { text: '☀ ' + latest.title })), h('div', { class: 'report', text: latest.body })));
    const rl = $('#report-list');
    rl.replaceChildren();
    if (!reports.length) rl.append(h('div', { class: 'empty', text: 'Nenhum relatório ainda.' }));
    for (const r of reports) rl.append(h('details', { class: 'card' }, h('summary', { text: r.title + ' · ' + when(r.created_at) }), h('div', { class: 'report', text: r.body })));
  });
  $('#mission-form').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const f = e.target;
    const r = await api('POST', '/api/missions', { title: f.title.value.trim(), goal: f.goal.value.trim(), steps: f.steps.value });
    f.reset();
    toast('M' + r.mission.num + ' criada' + (r.runId ? ' e entregue ao Capitão.' : '.'));
    loadMissions();
  }));
  const nightBody = () => { const nc = $('#night-card'); return { enabled: nc.querySelector('[name=enabled]').checked, start: nc.querySelector('[name=start]').value, end: nc.querySelector('[name=end]').value, interval_h: Number(nc.querySelector('[name=interval_h]').value), max_runs: Number(nc.querySelector('[name=max_runs]').value) }; };
  $('#night-save').addEventListener('click', safe(async () => { await api('PUT', '/api/night', nightBody()); toast('Turno da noite salvo.'); loadMissions(); }));
  $('#night-run').addEventListener('click', safe(async () => { await api('POST', '/api/night/run'); toast('Rodada do turno enviada ao Capitão.'); }));
  $('#night-report').addEventListener('click', safe(async () => { await api('POST', '/api/night/report'); toast('Relatório gerado (também salvo em relatorios/ na pasta compartilhada).'); loadMissions(); }));

  // ---------- arquivos ----------
  const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  function renderFilesScope() {
    const sel = $('#files-scope');
    const v = sel.value || 'shared';
    sel.replaceChildren(h('option', { value: 'shared', text: 'Pasta compartilhada (tripulação)' }), ...S.agents.map(a => h('option', { value: a.id, text: 'Pasta de ' + a.name })));
    sel.value = [...sel.options].some(o => o.value === v) ? v : 'shared';
  }
  const loadFiles = safe(async () => {
    renderFilesScope();
    const scope = $('#files-scope').value;
    const files = await api('GET', '/api/files?scope=' + encodeURIComponent(scope));
    const box = $('#files-list');
    box.replaceChildren();
    if (!files.length) box.append(h('div', { class: 'empty', text: 'Nenhum arquivo nesta pasta.' }));
    for (const f of files.sort((a, b) => b.mtime.localeCompare(a.mtime))) {
      box.append(h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 'title', text: f.path }), h('div', { class: 'sub', text: fmtSize(f.size) + ' · ' + when(f.mtime) })),
        h('button', { class: 'btn small', text: 'Baixar', onclick: safe(() => download(scope, f.path)) }),
        h('button', { class: 'btn small danger', text: '✕', title: 'Apagar', onclick: safe(async () => { if (confirm('Apagar ' + f.path + '?')) { await api('DELETE', '/api/files?scope=' + encodeURIComponent(scope) + '&path=' + encodeURIComponent(f.path)); loadFiles(); } }) })));
    }
  });
  $('#files-scope').addEventListener('change', loadFiles);
  $('#files-refresh').addEventListener('click', loadFiles);

  async function download(scope, p) {
    const res = await fetch('/api/files/download?scope=' + encodeURIComponent(scope) + '&path=' + encodeURIComponent(p), { headers: { 'x-st1-token': TOKEN } });
    if (!res.ok) throw new Error('não consegui baixar (' + res.status + ')');
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: p.split('/').pop() });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // envia para a pasta compartilhada; devolve os caminhos salvos
  async function uploadFiles(list) {
    const done = [];
    const status = $('#upload-status');
    for (const f of list) {
      if (f.size > 25 * 1024 * 1024) { toast(f.name + ': maior que 25 MB', true); continue; }
      status.textContent = 'Enviando ' + f.name + '…';
      const res = await fetch('/api/files/upload?scope=shared&name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'x-st1-token': TOKEN, 'content-type': 'application/octet-stream' }, body: f });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(f.name + ': ' + (j.error || res.status), true); continue; }
      done.push(j.path);
    }
    status.textContent = done.length ? 'Enviado: ' + done.join(', ') : '';
    if (done.length) toast(done.length + ' arquivo(s) na pasta compartilhada.');
    return done;
  }
  let attachToChat = false;
  const fileInput = $('#file-input');
  $('#pick').addEventListener('click', () => { attachToChat = false; fileInput.click(); });
  $('#attach').addEventListener('click', () => { attachToChat = true; fileInput.click(); });
  fileInput.addEventListener('change', safe(async () => {
    const paths = await uploadFiles([...fileInput.files]);
    fileInput.value = '';
    if (attachToChat && paths.length) {
      const inp = $('#chat-input');
      inp.value = (inp.value ? inp.value + '\n' : '') + 'Anexei na pasta compartilhada: ' + paths.join(', ') + '. Leia com shared_read_file.';
      inp.dispatchEvent(new Event('input')); inp.focus();
    }
    loadFiles();
  }));
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', safe(async (e) => { await uploadFiles([...e.dataTransfer.files]); loadFiles(); }));

  // ---------- catálogo de conectores ----------
  const loadCatalog = safe(async () => {
    const cat = await api('GET', '/api/mcp/catalog');
    const box = $('#mcp-catalog');
    box.replaceChildren();
    for (const c of cat) {
      const inputs = c.fields.map(f => h('input', { type: f.secret ? 'password' : 'text', placeholder: f.label + (f.optional ? '' : ' *'), 'data-key': f.key, autocomplete: 'off' }));
      const links = c.fields.filter(f => f.link).map(f => h('a', { class: 'link', href: f.link, target: '_blank', rel: 'noopener noreferrer', text: 'pegar a chave ↗' }));
      const btn = h('button', { class: 'btn ' + (c.installed ? 'small' : 'primary small'), text: c.installed ? (c.fields.length ? 'Trocar chave' : 'Reinstalar') : 'Instalar' });
      btn.addEventListener('click', safe(async () => {
        const values = {};
        for (const i of inputs) values[i.dataset.key] = i.value;
        btn.disabled = true; btn.textContent = 'Conectando…';
        try {
          const r = await api('POST', '/api/mcp/install', { id: c.id, values });
          const ok = r.status && r.status.status === 'conectado';
          toast(c.title + ': ' + (ok ? r.status.tools.length + ' ferramenta(s), ligado em ' + (r.assigned.join(', ') || 'ninguém ainda') : (r.status && r.status.error) || 'falhou'), !ok);
        } finally { btn.disabled = false; }
        await refresh(); loadCatalog();
      }));
      box.append(h('div', { class: 'item cat' },
        h('div', { class: 'head' }, h('div', { class: 'title', text: c.title }),
          h('span', { class: 'tag ' + (c.safe ? 'safe' : 'ask'), text: c.safe ? 'leitura' : 'pede permissão' }),
          h('span', { class: 'tag', text: c.badge }), c.installed ? h('span', { class: 'state done', text: 'instalado' }) : null),
        h('div', { class: 'sub', text: c.description }),
        h('div', { class: 'sub', text: 'Vai para: ' + c.crew.join(', ') }),
        ...inputs,
        h('div', { class: 'row' }, btn, ...links)));
    }
  });

  // ---------- registro ----------
  function renderLog() {
    const t = S.totals || {};
    $('#totals').replaceChildren(
      h('div', null, h('b', { text: String(t.runs || 0) }), h('span', { text: 'execuções' })),
      h('div', null, h('b', { text: ((t.tokens_in || 0) + (t.tokens_out || 0)).toLocaleString('pt-BR') }), h('span', { text: 'tokens' })),
      h('div', null, h('b', { text: usd(t.cost_usd || 0) }), h('span', { text: 'custo' })));
    if ($('.tab-body[data-body=log]').classList.contains('on')) loadRuns();
  }
  const SRC = { chat: 'canal', schedule: 'agenda', conveyor: 'esteira', handoff: 'passado' };
  const STATUS = { done: 'concluída', error: 'erro', cancelled: 'cancelada', running: 'rodando', queued: 'na fila' };
  const loadRuns = safe(async () => {
    const runs = await api('GET', '/api/runs?limit=60');
    const box = $('#run-list');
    box.replaceChildren();
    if (!runs.length) box.append(h('div', { class: 'empty', text: 'Nenhuma execução ainda.' }));
    for (const r of runs) {
      box.append(h('div', { class: 'item' },
        h('div', { class: 'grow' },
          h('div', { class: 'title', text: agentName(r.agent_id) + ' · ' + (SRC[r.source] || r.source) }),
          h('div', { class: 'sub', text: short(r.error || r.output || r.input, 120) }),
          h('div', { class: 'sub', text: when(r.started_at) + ' · ' + (r.tokens_in + r.tokens_out) + ' tokens · ' + usd(r.cost_usd) + (r.model ? ' · ' + r.provider + '/' + r.model : '') })),
        h('span', { class: 'state ' + r.status, text: STATUS[r.status] || r.status })));
    }
  });

  // ---------- permissão ----------
  const consentQueue = [];
  let consentOpen = null;
  const LABEL = { once: 'Permitir uma vez', session: 'Nesta sessão', always: 'Sempre', deny: 'Negar' };
  function showConsent() {
    if (consentOpen || !consentQueue.length) return;
    const c = consentOpen = consentQueue.shift();
    const d = $('#consent');
    $('#consent-who').textContent = (c.agentName || agentName(c.agentId)) + ' quer usar ' + c.tool.name + (c.tool.scope === 'execute' ? ' (terminal no container)' : c.tool.scope === 'external' ? ' (conector externo)' : '');
    let args = c.args;
    try { const o = JSON.parse(args); args = o.command ? o.command : JSON.stringify(o, null, 2); } catch (_) { /* cru */ }
    $('#consent-args').textContent = args;
    $('#consent-note').textContent = c.tool.scope === 'execute'
      ? 'Roda isolado num container, só com a pasta deste tripulante. Um checkpoint é criado antes.'
      : '“Sempre” libera este conector para este tripulante, inclusive em tarefas automáticas.';
    const acts = $('#consent-actions');
    acts.replaceChildren(...c.choices.map(ch => h('button', { class: 'btn ' + (ch === 'deny' ? 'danger' : ch === 'once' ? 'primary' : ''), value: ch, text: LABEL[ch] })));
    d.onclose = safe(async () => {
      const decision = d.returnValue && c.choices.includes(d.returnValue) ? d.returnValue : 'deny';
      d.returnValue = '';
      consentOpen = null;
      try { await api('POST', '/api/consent', { id: c.id, decision }); } catch (_) { /* expirou */ }
      showConsent();
    });
    d.showModal();
  }

  // ---------- eventos em tempo real ----------
  function onEvent(ev) {
    switch (ev.type) {
      case 'state_changed': case 'mcp_changed': case 'run_queued': refreshSoon(); break;
      case 'missions_changed': if ($('.tab-body[data-body=missions]').classList.contains('on')) loadMissions(); break;
      case 'report': toast('☀ ' + ev.title + ' pronto — aba Missões.'); if ($('.tab-body[data-body=missions]').classList.contains('on')) loadMissions(); break;
      case 'night_fired': Station.setActivity(ev.agentId, '🌙 turno da noite', 20000); break;
      case 'trophy': toast(ev.icon + ' ' + ev.name + ': ' + ev.title); refreshSoon(); break;
      case 'level_up': toast('⬆ ' + ev.name + ' subiu para o nível ' + ev.level + '!'); refreshSoon(); break;
      case 'belief_proposed': toast('📓 ' + agentName(ev.agentId) + ' anotou algo sobre você — veja o Dossiê.'); loadBeliefs(); break;
      case 'files_changed': if ($('.tab-body[data-body=files]').classList.contains('on')) loadFiles(); break;
      case 'history_reset': if (ev.agentId === selected) loadHistory(); break;
      case 'run_start':
        Station.setActivity(ev.agentId, ev.source === 'chat' ? 'pensando…' : ev.source === 'schedule' ? 'tarefa agendada' : 'recebeu da esteira', 8000);
        live[ev.agentId] = { text: '', bubble: null };
        if (ev.agentId === selected && ev.source !== 'chat') addMsg('system', '▶ ' + (SRC[ev.source] || ev.source) + ': ' + short(ev.input, 300));
        refreshSoon();
        break;
      case 'agent_event': {
        const e = ev.event;
        const lv = live[ev.agentId] || (live[ev.agentId] = { text: '', bubble: null });
        const here = ev.agentId === selected;
        if (e.type === 'text') {
          lv.text += e.text;
          if (here) { if (!lv.bubble) { lv.bubble = addMsg('assistant', ''); lv.bubble.classList.add('cursor'); } lv.bubble.firstChild ? (lv.bubble.firstChild.nodeValue = lv.text) : lv.bubble.append(lv.text); scrollChat(); }
          Station.setActivity(ev.agentId, 'respondendo…', 4000);
        } else if (e.type === 'tool_call') {
          if (here) { if (lv.bubble) lv.bubble.classList.remove('cursor'); lv.bubble = null; lv.text = ''; lv.toolEl = addTool(e.name, e.args); }
          else { lv.bubble = null; lv.text = ''; }
          Station.setActivity(ev.agentId, '⚙ ' + e.name.replace(/^mcp__/, ''), 30000);
        } else if (e.type === 'tool_result') {
          if (here && lv.toolEl) { lv.toolEl.append(h('span', { class: 'out', text: (e.ok ? '✓ ' : '✗ ') + short(e.output, 300) })); if (!e.ok) lv.toolEl.classList.add('bad'); scrollChat(); }
        } else if (e.type === 'denied') {
          Station.setActivity(ev.agentId, '⛔ negado', 4000);
        } else if (e.type === 'step' && e.step > 1) {
          Station.setActivity(ev.agentId, 'passo ' + e.step, 4000);
        }
        break;
      }
      case 'run_end': {
        const lv = live[ev.agentId];
        if (lv && lv.bubble) lv.bubble.classList.remove('cursor');
        if (ev.agentId === selected) {
          if (ev.status === 'done') {
            if (!lv || !lv.text) { if (ev.output) addMsg('assistant', ev.output); }
            const meta = h('span', { class: 'meta', text: (ev.usage ? (ev.usage.input + ev.usage.output) + ' tokens' : '') + (ev.cost_known && ev.cost_usd ? ' · ' + usd(ev.cost_usd) : ev.cost_usd === 0 ? ' · grátis' : '') });
            const last = $$('.msg.assistant', log()).pop();
            if (last) { last.append(meta); meta.append(rateButtons(ev.runId)); }
            if (tts.checked && ev.output) Voice.speak(ev.output);
          } else if (ev.status === 'error') addMsg('err', 'Erro: ' + ev.error);
          else if (ev.status === 'cancelled') addMsg('system', '(cancelado)');
        }
        delete live[ev.agentId];
        Station.clearActivity(ev.agentId);
        if (ev.status === 'error') Station.setActivity(ev.agentId, '⚠ erro', 6000);
        refreshSoon();
        break;
      }
      case 'conveyor': Station.pulse(ev.from, ev.to); break;
      case 'consent_request':
        if (!consentQueue.some(c => c.id === ev.id) && (!consentOpen || consentOpen.id !== ev.id)) { consentQueue.push(ev); showConsent(); }
        Station.setActivity(ev.agentId, '⚠ aguardando permissão', 300000);
        break;
      case 'consent_closed': {
        const i = consentQueue.findIndex(c => c.id === ev.id);
        if (i >= 0) consentQueue.splice(i, 1);
        if (consentOpen && consentOpen.id === ev.id) { consentOpen = null; const d = $('#consent'); d.onclose = null; if (d.open) d.close(); showConsent(); }
        break;
      }
      case 'warning': toast(ev.message, true); break;
      case 'recruited': toast(agentName(ev.by) + ' recrutou ' + ev.name + '.'); refreshSoon(); break;
      case 'schedule_fired': toast('Agenda: tarefa enviada para ' + agentName(ev.agentId) + '.'); break;
      default: break;
    }
  }

  async function connect(attempt) {
    const chip = $('#chip-conn');
    try {
      const res = await fetch('/api/events', { headers: { 'x-st1-token': TOKEN } });
      if (res.status === 401 && (await res.clone().json().catch(() => ({}))).login) { location.href = '/login'; return; }
      if (res.status === 401) { chip.textContent = '● recarregue a página'; chip.className = 'chip bad'; toast('A estação reiniciou — recarregue a página.', true); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      chip.textContent = '● online'; chip.className = 'chip ok';
      attempt = 0;
      await refresh();
      if (selected) loadHistory();
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of block.split('\n')) if (line.startsWith('data: ')) { try { onEvent(JSON.parse(line.slice(6))); } catch (e) { console.error(e); } }
        }
      }
    } catch (e) { /* cai para reconexão */ }
    chip.textContent = '● offline'; chip.className = 'chip bad';
    setTimeout(() => connect((attempt || 0) + 1), Math.min(10000, 800 * Math.pow(2, attempt || 0)));
  }

  // ---------- editor da estação ----------
  let edPalette = false;
  const edAgent = () => S.agents.find(a => a.id === Station.editRoom);
  function renderEditor() {
    const a = edAgent();
    $('#ed-room').textContent = a ? 'Sala: ' + a.name : 'Toque numa sala';
    const hasProp = Station.editProp >= 0;
    $('#ed-flip').disabled = !hasProp; $('#ed-del').disabled = !hasProp;
    $('#ed-reset').disabled = !a;
    const d = S.decor || { characters: {}, furniture: {} };
    if (!edPalette) {
      edPalette = true;
      $('#ed-chars').replaceChildren(...Object.entries(d.characters).map(([k, label]) => h('button', { type: 'button', 'data-k': k, title: label, 'aria-label': label, onclick: safe(() => setLook({ sprite: k })) },
        h('span', { class: 'ed-char', style: "background-image:url('assets/crew/" + k + ".png')" }))));
      $('#ed-furn').replaceChildren(...Object.entries(d.furniture).map(([k, f]) => h('button', { type: 'button', class: 'ed-furn', title: f[2], 'aria-label': 'Pôr ' + f[2], onclick: safe(() => saveProps(Station.addProp(k))) },
        h('img', { src: 'assets/furniture/' + k + '.png', alt: '' }))));
    }
    for (const b of $$('#ed-chars button')) b.classList.toggle('on', !!a && a.sprite === b.dataset.k);
  }
  async function setLook(patch) {
    const a = edAgent(); if (!a) return toast('Toque numa sala primeiro.', true);
    Object.assign(a, patch);
    await api('PATCH', '/api/agents/' + a.id, patch);
    refreshSoon();
  }
  async function saveProps(props) {
    if (!props) return toast('Toque numa sala primeiro.', true);
    renderEditor();
    await setLook({ props });
  }
  function toggleEdit(on) {
    Station.setEditMode(on);
    $('#editor').hidden = !on;
    $('#deck-edit').classList.toggle('on', on);
    $('#deck-edit').textContent = on ? '✏️ Editando…' : '✏️ Editar estação';
    $('.deck').classList.toggle('editing', on);
    $('.layout').classList.toggle('editing', on);
    if (on) renderEditor();
  }
  $('#deck-edit').addEventListener('click', () => toggleEdit(!Station.isEditing()));
  $('#ed-done').addEventListener('click', () => toggleEdit(false));
  $('#ed-flip').addEventListener('click', safe(() => saveProps(Station.flipProp())));
  $('#ed-del').addEventListener('click', safe(() => saveProps(Station.removeProp())));
  $('#ed-reset').addEventListener('click', safe(async () => {
    const a = edAgent(); if (!a || !confirm('Voltar a sala de ' + a.name + ' ao visual padrão?')) return;
    await api('PATCH', '/api/agents/' + a.id, { reset_look: true });
    await refresh();
  }));

  // ---------- início ----------
  Station.init($('#station'), {
    onSelect: openChat,
    onEditSelect: () => renderEditor(),
    onPropsChange: safe((id, props) => api('PATCH', '/api/agents/' + id, { props }).then(refreshSoon)),
    onMoveRoom: safe(async (id, x, y) => { await api('PATCH', '/api/agents/' + id, { room_x: x, room_y: y }); await refresh(); })
  });
  resetAgentForm();
  loadBeliefs();
  const initialTab = location.hash.slice(1);
  if ($('.tabs button[data-tab="' + initialTab + '"]')) switchTab(initialTab);
  connect(0);
})();
