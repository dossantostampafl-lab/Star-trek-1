/* web/station.js — mapa da estação em canvas: salas, tripulantes em pixel-art (desenhados por código,
   sem imagens), consoles e esteiras animadas. Nenhum asset externo. */
'use strict';
(function () {
  const ROOM_W = 60, ROOM_H = 40, GAP = 12, PAD = 8;   // em "pixels de estação"
  let cv, ctx, onSelect;
  let agents = [], belts = [], status = {}, selected = null;
  const activity = {};          // agentId → { label, until }
  const packets = [];           // { from, to, t0 }
  const walkers = {};           // agentId → { x, tx, phase }
  let layout = { S: 3, ox: 0, oy: 0, rooms: {} };
  let stars = [];
  let reduced = false;

  function init(canvas, opts) {
    cv = canvas; ctx = cv.getContext('2d'); onSelect = opts.onSelect;
    reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    stars = Array.from({ length: 120 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() }));
    new ResizeObserver(resize).observe(cv);
    cv.addEventListener('click', click);
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
    const n = Math.max(agents.length, 1);
    let best = null;
    for (let cols = 1; cols <= Math.min(n, 6); cols++) {
      const rows = Math.ceil(n / cols);
      const tw = cols * ROOM_W + (cols - 1) * GAP + PAD * 2;
      const th = rows * ROOM_H + (rows - 1) * GAP + PAD * 2;
      const S = Math.min(W / tw, H / th);
      if (!best || S > best.S) best = { S, cols, rows, tw, th };
    }
    const S = Math.max(1, Math.min(8, Math.floor(best.S)));
    const rooms = {};
    const sorted = agents.slice().sort((a, b) => (a.room_y - b.room_y) || (a.room_x - b.room_x) || a.created_at.localeCompare(b.created_at));
    sorted.forEach((a, i) => {
      const cx = i % best.cols, cy = Math.floor(i / best.cols);
      rooms[a.id] = { x: PAD + cx * (ROOM_W + GAP), y: PAD + cy * (ROOM_H + GAP) };
    });
    layout = { S, ox: Math.floor((W - best.tw * S) / 2), oy: Math.floor((H - best.th * S) / 2), rooms, cols: best.cols };
  }

  function setData(a, b, s) {
    const before = agents.map(x => x.id).join();
    agents = a || []; belts = b || []; status = s || {};
    if (before !== agents.map(x => x.id).join()) computeLayout();
  }
  function setSelected(id) { selected = id; }
  function setActivity(id, label, ms) { activity[id] = { label, until: performance.now() + (ms || 60000) }; }
  function clearActivity(id) { delete activity[id]; }
  function pulse(from, to) { packets.push({ from, to, t0: performance.now() }); }

  // ---------- desenho ----------
  const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(layout.ox + Math.round(x * layout.S), layout.oy + Math.round(y * layout.S), Math.ceil(w * layout.S), Math.ceil(h * layout.S)); };

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
      ctx.fillText('Estação vazia — recrute o primeiro tripulante', W / 2, H / 2);
    } else {
      for (const b of belts) drawBelt(b, t);
      for (const a of agents) drawRoom(a, t);
      drawPackets(t);
    }
    requestAnimationFrame(frame);
  }

  function center(id) { const r = layout.rooms[id]; return r && { x: r.x + ROOM_W / 2, y: r.y + ROOM_H / 2 }; }

  // cada esteira ganha uma "faixa" no corredor, para duas esteiras não se sobreporem
  function lane(fromId, toId) {
    const i = belts.findIndex(b => b.from_agent === fromId && b.to_agent === toId);
    return ((Math.max(i, 0) % 3) - 1) * 3;
  }

  function beltPath(fromId, toId) {
    const a = center(fromId), b = center(toId);
    if (!a || !b) return null;
    const ra = layout.rooms[fromId];
    const L = lane(fromId, toId);
    a.x += L; b.x += L;
    const midY = ra.y + ROOM_H + GAP / 2 + L;
    if (Math.abs(a.y - b.y) < 1) {   // mesma linha: corredor por baixo
      return [{ x: a.x, y: a.y + ROOM_H / 2 }, { x: a.x, y: midY }, { x: b.x, y: midY }, { x: b.x, y: b.y + ROOM_H / 2 }];
    }
    const down = b.y > a.y;
    const yA = down ? ra.y + ROOM_H : ra.y;
    const yMid = (down ? ra.y + ROOM_H + GAP / 2 : ra.y - GAP / 2) + L;
    const xSide = (b.x >= a.x ? ra.x + ROOM_W + GAP / 2 : ra.x - GAP / 2) + L;
    const rb = layout.rooms[toId];
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
    const end = p[p.length - 1], pre = p[p.length - 2];
    const dx = Math.sign(end.x - pre.x), dy = Math.sign(end.y - pre.y);
    px(end.x - 1.5 - dx, end.y - 1.5 - dy, 3, 3, b.auto ? '#ffb347' : '#8aa0b8');
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

  function drawRoom(a, t) {
    const r = layout.rooms[a.id];
    if (!r) return;
    const st = status[a.id] || {};
    const busy = !!st.busy;
    const sel = a.id === selected;
    // casco
    px(r.x - 1, r.y - 1, ROOM_W + 2, ROOM_H + 2, sel ? '#ffb347' : '#22344d');
    px(r.x, r.y, ROOM_W, ROOM_H, '#0d1420');
    // piso quadriculado
    for (let yy = 4; yy < ROOM_H; yy += 4) for (let xx = (yy / 4) % 2 ? 0 : 4; xx < ROOM_W; xx += 8) px(r.x + xx, r.y + yy, 4, 4, '#101a29');
    // parede de fundo com faixa na cor do tripulante
    px(r.x, r.y, ROOM_W, 6, '#152235');
    px(r.x, r.y + 5, ROOM_W, 1, a.color);
    // janela com estrelas
    px(r.x + 4, r.y + 1, 14, 4, '#050810');
    if (((t / 700) | 0) % 3 === 0) px(r.x + 8, r.y + 2, 1, 1, '#cfe8ff');
    px(r.x + 13, r.y + 3, 1, 1, '#6f88a8');
    // console
    const cx = r.x + ROOM_W - 16, cy = r.y + 9;
    px(cx, cy + 6, 12, 5, '#22344d');
    px(cx + 1, cy, 10, 6, '#0a121d');
    const flick = busy && !reduced ? (((t / 120) | 0) % 2) : 0;
    px(cx + 2, cy + 1, 8, 4, busy ? (flick ? '#7dffa8' : '#3fae6e') : '#1d3a52');
    if (busy) for (let i = 0; i < 3; i++) px(cx + 3, cy + 2 + i, ((t / 80 + i * 3) % 6) | 0, 0.6, '#0a121d');
    // tripulante
    const w = walkers[a.id] || (walkers[a.id] = { x: r.x + 14, tx: r.x + 14, phase: Math.random() * 10 });
    const target = busy ? cx - 6 : w.tx;
    if (!busy && Math.abs(w.x - w.tx) < 0.5 && Math.random() < 0.004) w.tx = r.x + 6 + Math.random() * (ROOM_W - 30);
    const speed = reduced ? 99 : 0.12;
    const moving = Math.abs(w.x - target) > 0.5;
    if (moving) w.x += Math.sign(target - w.x) * Math.min(speed, Math.abs(target - w.x));
    else if (reduced) w.x = target;
    drawCrew(w.x, r.y + 18, a.color, t, moving, busy, target >= w.x);
    // placa com nome
    const S = layout.S;
    ctx.font = 'bold ' + Math.max(10, Math.round(S * 3.2)) + 'px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = sel ? '#ffb347' : '#d7e6f5';
    ctx.fillText(a.name, layout.ox + (r.x + 3) * S, layout.oy + (r.y + ROOM_H - 3) * S);
    // estado
    const act = activity[a.id];
    let label = act && act.until > performance.now() ? act.label : '';
    if (!label && busy) label = 'trabalhando…';
    if (!label && st.queued) label = st.queued + ' na fila';
    if (label) bubble(r.x + ROOM_W / 2, r.y + 12, label);
    if (a.budget_usd > 0 && a.spent_usd >= a.budget_usd) bubble(r.x + ROOM_W / 2, r.y + 30, 'orçamento esgotado', '#ff6b7a');
  }

  function drawCrew(x, y, color, t, moving, busy, facingRight) {
    const bob = moving && !reduced ? (((t / 140) | 0) % 2) : 0;
    const X = Math.round(x), Y = y - bob;
    px(X + 1, Y, 6, 5, '#e8eef5');           // capacete
    px(X + (facingRight ? 3 : 2), Y + 1, 3, 2, busy ? '#7dffa8' : '#5ec8ff');   // viseira
    px(X, Y + 5, 8, 7, color);               // traje
    px(X + 3, Y + 6, 2, 2, '#ffe066');       // insígnia
    const legA = moving && !reduced && ((t / 140) | 0) % 2 ? 1 : 0;
    px(X + 1, Y + 12, 2, 3 - legA, '#22344d');
    px(X + 5, Y + 12, 2, 2 + legA, '#22344d');
    if (busy) px(X + (facingRight ? 8 : -1), Y + 7, 1, 2, color);   // braço no console
  }

  function bubble(cx, y, text, color) {
    const S = layout.S;
    ctx.font = Math.max(9, Math.round(S * 2.8)) + 'px ui-monospace, monospace';
    const w = ctx.measureText(text).width / S + 4;
    const x = cx - w / 2;
    px(x, y - 5, w, 6, 'rgba(7,11,18,.88)');
    px(x, y + 1, w, 0.5, color || '#ffb347');
    ctx.fillStyle = color || '#ffb347';
    ctx.textAlign = 'left';
    ctx.fillText(text, layout.ox + (x + 2) * S, layout.oy + (y - 0.6) * S);
  }

  function click(ev) {
    const r = cv.getBoundingClientRect();
    const dpr = cv.width / r.width;
    const x = ((ev.clientX - r.left) * dpr - layout.ox) / layout.S;
    const y = ((ev.clientY - r.top) * dpr - layout.oy) / layout.S;
    for (const a of agents) {
      const room = layout.rooms[a.id];
      if (room && x >= room.x && x <= room.x + ROOM_W && y >= room.y && y <= room.y + ROOM_H) { onSelect && onSelect(a.id); return; }
    }
  }

  window.Station = { init, setData, setSelected, setActivity, clearActivity, pulse };
})();
