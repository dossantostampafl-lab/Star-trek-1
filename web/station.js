/* web/station.js — mapa da estação em canvas: salas com móveis, tripulantes animados (sprites), esteiras
   e o EDITOR (mover salas, pôr/arrastar/espelhar/remover móveis, trocar o personagem).
   Arte dos personagens e móveis: StarNet (MIT, Andrew Sims) — ver assets/NOTICE.md.
   Unidades: "pixels de estação"; 1 unidade = 4 px da arte original. */
'use strict';
(function () {
  let ROOM_W = 96, ROOM_H = 60, WALL_H = 12;
  const GAP = 14, PAD = 10, PITCH_X = () => ROOM_W + GAP, PITCH_Y = () => ROOM_H + GAP;
  const SPR_W = 16, SPR_H = 24, FEET = 22;       // sprite 64×96 px → 16×24 unidades; pés ~22 abaixo do topo
  const FLOOR_ITEMS = new Set(['rug']);
  let cv, ctx, cb = {};
  let agents = [], belts = [], status = {}, selected = null;
  let FURN = {}, CHARS = {};
  const activity = {};          // agentId → { label, until }
  const packets = [];           // { from, to, t0 }
  const walkers = {};           // agentId → { x, y, tx, ty, dir, wait }
  const imgs = {};              // cache de imagens
  let layout = { S: 2, ox: 0, oy: 0, rooms: {}, ghosts: [] };
  let stars = [], reduced = false;
  // editor
  let edit = false, editRoom = null, editProp = -1, drag = null, downAt = null;

  function img(src) {
    let i = imgs[src];
    if (!i) { i = imgs[src] = new Image(); i.src = src; }
    return i.complete && i.naturalWidth ? i : null;
  }

  function init(canvas, opts) {
    cv = canvas; ctx = cv.getContext('2d'); cb = opts || {};
    reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    stars = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() }));
    new ResizeObserver(resize).observe(cv);
    cv.addEventListener('pointerdown', pdown);
    cv.addEventListener('pointermove', pmove);
    cv.addEventListener('pointerup', pup);
    cv.addEventListener('pointercancel', () => { drag = null; downAt = null; });
    resize();
    requestAnimationFrame(frame);
  }

  function resize() {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    computeLayout();
  }

  function computeLayout() {
    const W = cv.width, H = cv.height;
    let minX = 0, minY = 0, maxX = 0, maxY = 0;
    if (agents.length) {
      minX = Math.min(...agents.map(a => a.room_x)); maxX = Math.max(...agents.map(a => a.room_x));
      minY = Math.min(...agents.map(a => a.room_y)); maxY = Math.max(...agents.map(a => a.room_y));
    }
    if (edit) { minX = Math.max(0, minX - 1); minY = Math.max(0, minY - 1); maxX = Math.min(20, maxX + 1); maxY = Math.min(20, maxY + 1); }
    const cols = maxX - minX + 1, rows = maxY - minY + 1;
    const tw = cols * PITCH_X() - GAP + PAD * 2, th = rows * PITCH_Y() - GAP + PAD * 2;
    let S = Math.min(W / tw, H / th);
    S = S >= 4 ? Math.floor(S) : Math.max(0.5, Math.floor(S * 4) / 4);
    const rooms = {}, taken = new Set();
    for (const a of agents) {
      rooms[a.id] = { x: PAD + (a.room_x - minX) * PITCH_X(), y: PAD + (a.room_y - minY) * PITCH_Y(), gx: a.room_x, gy: a.room_y };
      taken.add(a.room_x + ',' + a.room_y);
    }
    const ghosts = [];
    if (edit) for (let gy = minY; gy <= maxY; gy++) for (let gx = minX; gx <= maxX; gx++) {
      if (!taken.has(gx + ',' + gy)) ghosts.push({ gx, gy, x: PAD + (gx - minX) * PITCH_X(), y: PAD + (gy - minY) * PITCH_Y() });
    }
    layout = { S, ox: Math.floor((W - tw * S) / 2), oy: Math.floor((H - th * S) / 2), rooms, ghosts };
  }

  function setData(a, b, s) {
    const sig = (list) => (list || []).map(x => x.id + ':' + x.room_x + ',' + x.room_y).join();
    const before = sig(agents);
    agents = a || []; belts = b || []; status = s || {};
    if (drag) {   // não deixa uma atualização do servidor desfazer o arrasto em andamento
      const ag = agents.find(x => x.id === drag.agentId);
      if (ag) ag.props = drag.props;
    }
    if (before !== sig(agents)) computeLayout();
  }
  function setDecor(d) {
    if (!d) return;
    FURN = d.furniture || {}; CHARS = d.characters || {};
    if (d.room) { [ROOM_W, ROOM_H, WALL_H] = d.room; computeLayout(); }
  }
  function setSelected(id) { selected = id; }
  function setActivity(id, label, ms) { activity[id] = { label, until: performance.now() + (ms || 60000) }; }
  function clearActivity(id) { delete activity[id]; }
  function pulse(from, to) { packets.push({ from, to, t0: performance.now() }); }

  // ---------- desenho ----------
  const S_ = () => layout.S;
  const X = (u) => layout.ox + u * layout.S, Y = (u) => layout.oy + u * layout.S;
  const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(X(x)), Math.round(Y(y)), Math.ceil(w * layout.S), Math.ceil(h * layout.S)); };

  function frame(t) {
    const W = cv.width, H = cv.height;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#070b12'; ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      const x = (s.x * W + (reduced ? 0 : t * 0.004 * (0.3 + s.z))) % W;
      ctx.fillStyle = s.z > 0.8 ? '#cfe8ff' : s.z > 0.5 ? '#6f88a8' : '#34465e';
      ctx.fillRect(Math.floor(x), Math.floor(s.y * H), s.z > 0.8 ? 2 : 1, s.z > 0.8 ? 2 : 1);
    }
    if (!agents.length) {
      ctx.fillStyle = '#7f95ad';
      ctx.font = Math.max(12, Math.round(W / 50)) + 'px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Estação vazia — embarque a tripulação na aba Tripulação', W / 2, H / 2);
    } else {
      for (const g of layout.ghosts) drawGhost(g);
      for (const b of belts) drawBelt(b, t);
      for (const a of agents) drawRoom(a, t);
      drawPackets(t);
      for (const a of agents) drawLabels(a);
    }
    requestAnimationFrame(frame);
  }

  function drawGhost(g) {
    const S = S_();
    ctx.save();
    ctx.strokeStyle = editRoom ? '#ffb34799' : '#2a3d57';
    ctx.setLineDash([4 * S, 3 * S]); ctx.lineWidth = Math.max(1, S);
    ctx.strokeRect(X(g.x) + 0.5, Y(g.y) + 0.5, ROOM_W * S, ROOM_H * S);
    ctx.restore();
    if (editRoom) {
      ctx.fillStyle = '#ffb34799'; ctx.textAlign = 'center';
      ctx.font = Math.max(10, Math.round(S * 4)) + 'px ui-monospace, monospace';
      ctx.fillText('mover para cá', X(g.x + ROOM_W / 2), Y(g.y + ROOM_H / 2));
    }
  }

  function center(id) { const r = layout.rooms[id]; return r && { x: r.x + ROOM_W / 2, y: r.y + ROOM_H / 2 }; }
  function lane(fromId, toId) {
    const i = belts.findIndex(b => b.from_agent === fromId && b.to_agent === toId);
    return ((Math.max(i, 0) % 3) - 1) * 3;
  }
  function beltPath(fromId, toId) {
    const a = center(fromId), b = center(toId);
    if (!a || !b) return null;
    const ra = layout.rooms[fromId], rb = layout.rooms[toId];
    const L = lane(fromId, toId);
    a.x += L; b.x += L;
    if (Math.abs(ra.y - rb.y) < 1) {   // mesma linha: corredor por baixo
      const midY = ra.y + ROOM_H + GAP / 2 + L;
      return [{ x: a.x, y: ra.y + ROOM_H }, { x: a.x, y: midY }, { x: b.x, y: midY }, { x: b.x, y: rb.y + ROOM_H }];
    }
    const down = rb.y > ra.y;
    const yA = down ? ra.y + ROOM_H : ra.y;
    const yMid = (down ? ra.y + ROOM_H + GAP / 2 : ra.y - GAP / 2) + L;
    const xSide = (b.x >= a.x ? ra.x + ROOM_W + GAP / 2 : ra.x - GAP / 2) + L;
    const yB = down ? rb.y : rb.y + ROOM_H;
    const yMidB = (down ? rb.y - GAP / 2 : rb.y + ROOM_H + GAP / 2) + L;
    return [{ x: a.x, y: yA }, { x: a.x, y: yMid }, { x: xSide, y: yMid }, { x: xSide, y: yMidB }, { x: b.x, y: yMidB }, { x: b.x, y: yB }];
  }
  function pathLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y); return L; }
  function pointAt(p, d) {
    for (let i = 1; i < p.length; i++) {
      const seg = Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y);
      if (d <= seg) { const f = seg ? d / seg : 0; return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * f, y: p[i - 1].y + (p[i].y - p[i - 1].y) * f }; }
      d -= seg;
    }
    return p[p.length - 1];
  }
  function drawBelt(b, t) {
    const p = beltPath(b.from_agent, b.to_agent);
    if (!p) return;
    const L = pathLen(p);
    for (let d = 0; d <= L; d += 1) { const q = pointAt(p, d); px(q.x - 1.5, q.y - 1.5, 3, 3, '#1b2a3f'); }
    const off = reduced ? 0 : (t / 90) % 4;
    for (let d = off; d <= L; d += 4) { const q = pointAt(p, d); px(q.x - 0.5, q.y - 0.5, 1, 1, b.auto ? '#ffb347' : '#5b6f88'); }
  }
  function drawPackets(t) {
    for (let i = packets.length - 1; i >= 0; i--) {
      const k = packets[i];
      const f = (t - k.t0) / 1600;
      if (f >= 1) { packets.splice(i, 1); continue; }
      const p = beltPath(k.from, k.to);
      if (!p) { packets.splice(i, 1); continue; }
      const q = pointAt(p, pathLen(p) * f);
      px(q.x - 2.5, q.y - 2.5, 5, 5, 'rgba(126,255,168,.25)');
      px(q.x - 1.5, q.y - 1.5, 3, 3, '#7dffa8');
    }
  }

  function drawProp(r, p, highlight) {
    const f = FURN[p.k]; if (!f) return;
    const im = img('assets/furniture/' + p.k + '.png');
    const S = S_(), dx = X(r.x + p.x), dy = Y(r.y + p.y), dw = f[0] * S, dh = f[1] * S;
    if (im) {
      ctx.imageSmoothingEnabled = S < 4;   // abaixo de 1:1 da arte, suaviza para não serrilhar
      if (p.flip) { ctx.save(); ctx.translate(dx + dw, dy); ctx.scale(-1, 1); ctx.drawImage(im, 0, 0, dw, dh); ctx.restore(); }
      else ctx.drawImage(im, dx, dy, dw, dh);
      ctx.imageSmoothingEnabled = false;
    } else px(r.x + p.x, r.y + p.y, f[0], f[1], '#1b2a3f');
    if (highlight) { ctx.strokeStyle = '#ffb347'; ctx.lineWidth = Math.max(1, S / 2); ctx.strokeRect(dx, dy, dw, dh); }
  }

  function workstation(a) {
    const props = a.props || [];
    for (const p of props) {
      const f = FURN[p.k];
      if (f && f[4]) return { x: p.x + f[0] / 2, y: Math.min(ROOM_H - 2, p.y + f[1] + 4) };
    }
    return { x: ROOM_W / 2, y: ROOM_H - 10 };
  }

  function stepWalker(a, busy) {
    const w = walkers[a.id] || (walkers[a.id] = { x: ROOM_W / 2, y: ROOM_H - 8, tx: ROOM_W / 2, ty: ROOM_H - 8, dir: 'south', wait: 60 });
    const ws = busy ? workstation(a) : null;
    if (ws) { w.tx = ws.x; w.ty = ws.y; }
    else if (Math.abs(w.x - w.tx) < 0.5 && Math.abs(w.y - w.ty) < 0.5 && --w.wait <= 0) {
      w.tx = 8 + Math.random() * (ROOM_W - 16);
      w.ty = WALL_H + 26 + Math.random() * (ROOM_H - WALL_H - 28);
      w.wait = 120 + Math.random() * 360;
    }
    const sp = reduced ? 999 : 0.28;
    let moving = false;
    if (Math.abs(w.x - w.tx) >= 0.5) { const d = Math.sign(w.tx - w.x); w.x += d * Math.min(sp, Math.abs(w.tx - w.x)); w.dir = d > 0 ? 'east' : 'west'; moving = true; }
    else if (Math.abs(w.y - w.ty) >= 0.5) { const d = Math.sign(w.ty - w.y); w.y += d * Math.min(sp, Math.abs(w.ty - w.y)); w.dir = d > 0 ? 'south' : 'north'; moving = true; }
    if (reduced) moving = false;
    return { w, moving, working: !!ws && !moving };
  }

  const ROW = { east: 1, west: 2, south: 3, north: 4 };
  const IDLE = { south: 0, east: 1, west: 2, north: 3 };
  function drawCrew(a, r, st, t) {
    const S = S_();
    const im = img('assets/crew/' + (a.sprite || 'blank_blue') + '.png');
    let col, row;
    if (st.working) { row = 5; col = reduced ? 0 : ((t / 160) | 0) % 4; }
    else if (st.moving) { row = ROW[st.w.dir]; col = ((t / 90) | 0) % 8; }
    else { row = 0; col = IDLE[st.w.dir] || 0; }
    const x = r.x + st.w.x - SPR_W / 2, y = r.y + st.w.y - FEET;
    // sombra
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(X(r.x + st.w.x), Y(r.y + st.w.y), 5 * S, 1.6 * S, 0, 0, Math.PI * 2); ctx.fill();
    if (im) {
      ctx.imageSmoothingEnabled = S < 4;
      ctx.drawImage(im, col * 64, row * 96, 64, 96, X(x), Y(y), SPR_W * S, SPR_H * S);
      ctx.imageSmoothingEnabled = false;
    } else px(x + 4, y + 4, 8, 18, a.color);
  }

  function drawRoom(a, t) {
    const r = layout.rooms[a.id];
    if (!r) return;
    const st = status[a.id] || {};
    const busy = !!st.busy;
    const sel = edit ? a.id === editRoom : a.id === selected;
    // casco, piso e parede
    px(r.x - 1, r.y - 1, ROOM_W + 2, ROOM_H + 2, sel ? '#ffb347' : '#22344d');
    px(r.x, r.y, ROOM_W, ROOM_H, '#0d1420');
    for (let yy = WALL_H; yy < ROOM_H; yy += 6) for (let xx = ((yy - WALL_H) / 6) % 2 ? 0 : 6; xx < ROOM_W; xx += 12) px(r.x + xx, r.y + yy, 6, 6, '#101a29');
    px(r.x, r.y, ROOM_W, WALL_H, '#152235');
    px(r.x, r.y + WALL_H - 1, ROOM_W, 1, a.color);
    px(r.x + ROOM_W - 22, r.y + 2, 18, 6, '#050810');   // janela
    if (((t / 700) | 0) % 3 === 0) px(r.x + ROOM_W - 16, r.y + 4, 1, 1, '#cfe8ff');
    px(r.x + ROOM_W - 9, r.y + 6, 1, 1, '#6f88a8');
    // luz de estado no batente
    px(r.x + 2, r.y + WALL_H - 3, 2, 1, busy ? (((t / 200) | 0) % 2 ? '#7dffa8' : '#3fae6e') : '#1d3a52');

    const props = a.props || [];
    const crew = stepWalker(a, busy);
    // ordem de desenho: parede → piso (tapetes) → móveis e tripulante por profundidade
    const items = [];
    props.forEach((p, i) => {
      const f = FURN[p.k]; if (!f) return;
      const z = f[3] ? -2 : FLOOR_ITEMS.has(p.k) ? -1 : p.y + f[1];
      items.push({ z, draw: () => drawProp(r, p, edit && a.id === editRoom && i === editProp) });
    });
    items.push({ z: crew.w.y + (crew.working ? 0.5 : 0), draw: () => drawCrew(a, r, crew, t) });
    items.sort((p, q) => p.z - q.z);
    ctx.save();
    ctx.beginPath(); ctx.rect(X(r.x), Y(r.y), ROOM_W * S_(), ROOM_H * S_()); ctx.clip();
    for (const it of items) it.draw();
    ctx.restore();
    r.crew = crew;
  }

  function drawLabels(a) {
    const r = layout.rooms[a.id]; if (!r) return;
    const S = S_(), st = status[a.id] || {};
    const sel = edit ? a.id === editRoom : a.id === selected;
    const fs = Math.max(10, Math.round(S * 4));
    ctx.font = 'bold ' + fs + 'px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const label = (a.captain ? '★ ' : '') + a.name;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(7,11,18,.8)';
    ctx.fillRect(X(r.x + 1), Y(r.y + ROOM_H) - fs - 6, tw + 8, fs + 5);
    ctx.fillStyle = sel ? '#ffb347' : '#d7e6f5';
    ctx.fillText(label, X(r.x + 1) + 4, Y(r.y + ROOM_H) - 5);
    if (edit) return;
    const act = activity[a.id];
    let text = act && act.until > performance.now() ? act.label : '';
    if (!text && st.busy) text = 'trabalhando…';
    if (!text && st.queued) text = st.queued + ' na fila';
    const c = r.crew;
    if (text && c) bubble(r.x + Math.min(Math.max(c.w.x, 20), ROOM_W - 20), r.y + c.w.y - FEET - 1, text);
    if (a.budget_usd > 0 && a.spent_usd >= a.budget_usd) bubble(r.x + ROOM_W / 2, r.y + WALL_H + 6, 'orçamento esgotado', '#ff6b7a');
  }

  function bubble(cx, y, text, color) {
    const S = S_();
    const fs = Math.max(10, Math.round(S * 3.6));
    ctx.font = fs + 'px ui-monospace, monospace';
    const w = ctx.measureText(text).width + 10;
    const x = X(cx) - w / 2, yy = Math.max(2, Y(y) - fs - 6);
    ctx.fillStyle = 'rgba(7,11,18,.9)'; ctx.fillRect(x, yy, w, fs + 6);
    ctx.fillStyle = color || '#ffb347'; ctx.fillRect(x, yy + fs + 5, w, 1);
    ctx.textAlign = 'left'; ctx.fillText(text, x + 5, yy + fs + 1);
  }

  // ---------- toque / editor ----------
  function toUnits(ev) {
    const r = cv.getBoundingClientRect();
    const dpr = cv.width / r.width;
    return { x: ((ev.clientX - r.left) * dpr - layout.ox) / layout.S, y: ((ev.clientY - r.top) * dpr - layout.oy) / layout.S };
  }
  function roomAt(u) {
    for (const a of agents) {
      const r = layout.rooms[a.id];
      if (r && u.x >= r.x && u.x <= r.x + ROOM_W && u.y >= r.y && u.y <= r.y + ROOM_H) return { a, r };
    }
    return null;
  }
  function propAt(a, r, u) {
    const props = a.props || [];
    const lx = u.x - r.x, ly = u.y - r.y;
    // o de cima primeiro: mesma ordem do desenho, invertida
    const order = props.map((p, i) => ({ p, i, f: FURN[p.k] })).filter(o => o.f)
      .sort((m, n) => (n.f[3] ? -2 : FLOOR_ITEMS.has(n.p.k) ? -1 : n.p.y + n.f[1]) - (m.f[3] ? -2 : FLOOR_ITEMS.has(m.p.k) ? -1 : m.p.y + m.f[1]));
    for (const o of order) if (lx >= o.p.x && lx <= o.p.x + o.f[0] && ly >= o.p.y && ly <= o.p.y + o.f[1]) return o.i;
    return -1;
  }

  function pdown(ev) {
    const u = toUnits(ev);
    downAt = { u, t: performance.now() };
    if (!edit) return;
    const hit = roomAt(u);
    if (!hit) return;
    const i = propAt(hit.a, hit.r, u);
    selectEdit(hit.a.id, i);
    if (i >= 0) {
      const p = hit.a.props[i];
      drag = { agentId: hit.a.id, idx: i, offx: u.x - hit.r.x - p.x, offy: u.y - hit.r.y - p.y, props: hit.a.props.map(o => Object.assign({}, o)), moved: false };
      hit.a.props = drag.props;
      cv.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  }
  function pmove(ev) {
    if (!drag) return;
    const a = agents.find(x => x.id === drag.agentId), r = layout.rooms[drag.agentId];
    if (!a || !r) return;
    const u = toUnits(ev), p = drag.props[drag.idx], f = FURN[p.k];
    const nx = Math.round((u.x - r.x - drag.offx) / 2) * 2, ny = Math.round((u.y - r.y - drag.offy) / 2) * 2;
    p.x = Math.max(0, Math.min(ROOM_W - f[0], nx));
    p.y = Math.max(0, Math.min(ROOM_H - f[1], ny));
    drag.moved = true;
  }
  function pup(ev) {
    const u = toUnits(ev);
    if (drag) {
      const d = drag; drag = null;
      if (d.moved && cb.onPropsChange) cb.onPropsChange(d.agentId, d.props);
      return;
    }
    if (!downAt) return;
    const tap = Math.abs(u.x - downAt.u.x) < 4 && Math.abs(u.y - downAt.u.y) < 4;
    downAt = null;
    if (!tap) return;
    const hit = roomAt(u);
    if (!edit) { if (hit && cb.onSelect) cb.onSelect(hit.a.id); return; }
    if (hit) return;   // já tratado no pdown
    const g = layout.ghosts.find(g => u.x >= g.x && u.x <= g.x + ROOM_W && u.y >= g.y && u.y <= g.y + ROOM_H);
    if (g && editRoom && cb.onMoveRoom) cb.onMoveRoom(editRoom, g.gx, g.gy);
  }

  function selectEdit(agentId, propIdx) {
    editRoom = agentId; editProp = propIdx;
    if (cb.onEditSelect) cb.onEditSelect(agentId, propIdx);
  }

  function setEditMode(on) {
    edit = !!on; drag = null;
    if (edit && !editRoom && agents.length) editRoom = selected || agents[0].id;
    editProp = -1;
    cv.style.touchAction = edit ? 'none' : '';
    computeLayout();
    if (edit && cb.onEditSelect) cb.onEditSelect(editRoom, -1);
  }

  function editTarget() { return agents.find(a => a.id === editRoom) || null; }

  // Devolve a nova lista de móveis da sala em edição (o painel salva no servidor).
  function addProp(k) {
    const a = editTarget(), f = FURN[k];
    if (!a || !f) return null;
    const props = (a.props || []).map(o => Object.assign({}, o));
    const wall = !!f[3];
    const n = props.length;
    const x = Math.max(0, Math.min(ROOM_W - f[0], Math.round((ROOM_W - f[0]) / 2) + ((n * 7) % 21) - 10));
    const y = wall ? 0 : Math.max(WALL_H, Math.min(ROOM_H - f[1], Math.round(WALL_H + (ROOM_H - WALL_H - f[1]) / 2)));
    props.push({ k, x, y });
    a.props = props; editProp = props.length - 1;
    return props;
  }
  function removeProp() {
    const a = editTarget();
    if (!a || editProp < 0) return null;
    const props = (a.props || []).filter((_, i) => i !== editProp);
    a.props = props; editProp = -1;
    return props;
  }
  function flipProp() {
    const a = editTarget();
    if (!a || editProp < 0) return null;
    const props = (a.props || []).map((o, i) => i === editProp ? Object.assign({}, o, { flip: !o.flip }) : Object.assign({}, o));
    if (!props[editProp].flip) delete props[editProp].flip;
    a.props = props;
    return props;
  }

  window.Station = { init, setData, setDecor, setSelected, setActivity, clearActivity, pulse, setEditMode, addProp, removeProp, flipProp, get editRoom() { return editRoom; }, get editProp() { return editProp; }, isEditing: () => edit };
})();
