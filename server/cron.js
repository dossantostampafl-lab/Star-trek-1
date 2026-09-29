'use strict';
/* server/cron.js — expressões cron de 5 campos (minuto hora dia mês dia-da-semana), no horário local.
   Suporta: asterisco, 5, 1-5, 1,15, passos com barra (asterisco/10, 1-30/5), nomes (jan…dec, sun…sat) e atalhos @hourly @daily @weekly @monthly.
   Dia do mês e dia da semana: se os dois forem restritos, vale qualquer um (regra clássica do cron). */

const PRESETS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const NAMES = {
  month: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  dow: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
};
const FIELDS = [
  { name: 'minuto', min: 0, max: 59 },
  { name: 'hora', min: 0, max: 23 },
  { name: 'dia', min: 1, max: 31 },
  { name: 'mês', min: 1, max: 12, names: NAMES.month },
  { name: 'dia da semana', min: 0, max: 7, names: NAMES.dow }
];

function parseField(src, f) {
  const set = new Set();
  const val = (s) => {
    const k = s.toLowerCase();
    if (f.names && f.names[k] != null) return f.names[k];
    if (!/^\d+$/.test(s)) throw new Error('valor inválido "' + s + '" no campo ' + f.name);
    return Number(s);
  };
  for (const part of src.split(',')) {
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) throw new Error('parte inválida "' + part + '" no campo ' + f.name);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error('passo inválido no campo ' + f.name);
    let lo, hi;
    if (m[1] === '*') { lo = f.min; hi = f.max; }
    else if (m[1].includes('-')) { const [a, b] = m[1].split('-'); lo = val(a); hi = val(b); }
    else { lo = val(m[1]); hi = m[2] ? f.max : lo; }
    if (lo < f.min || hi > f.max || lo > hi) throw new Error('fora do intervalo ' + f.min + '-' + f.max + ' no campo ' + f.name);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function parseCron(expr) {
  const src = PRESETS[String(expr).trim().toLowerCase()] || String(expr).trim();
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw new Error('use 5 campos: minuto hora dia mês dia-da-semana (ex.: "0 9 * * 1-5")');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) { dow.delete(7); dow.add(0); }   // 7 também é domingo
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(c, d) {
  if (!c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

// Próximo horário (estritamente depois de `from`) em que a expressão dispara.
function nextRun(expr, from) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(from ? from.getTime() : Date.now());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = d.getTime() + 5 * 366 * 24 * 3600 * 1000;
  while (d.getTime() < limit) {
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return new Date(d);
  }
  return null;
}

// Relógio que dispara os agendamentos. Checa a cada `tickMs`; não dispara atrasados de quando estava desligado.
function makeScheduler(deps) {
  const tickMs = deps.tickMs || 15000;
  let timer = null;

  function tick() {
    const now = deps.now ? deps.now() : new Date();
    for (const s of deps.list()) {
      if (!s.enabled) continue;
      let next = s.next_run ? new Date(s.next_run) : null;
      if (!next || isNaN(next)) {
        try { next = nextRun(s.cron, now); } catch (_) { continue; }
        deps.update(s.id, { next_run: next && next.toISOString() });
        continue;
      }
      if (next <= now) {
        let after = null;
        try { after = nextRun(s.cron, now); } catch (_) { /* expressão quebrada: para */ }
        deps.update(s.id, { last_run: now.toISOString(), next_run: after && after.toISOString() });
        // se ficou desligado por mais de 1 intervalo, só dispara uma vez (não "recupera" tudo)
        Promise.resolve().then(() => deps.fire(s)).catch(e => deps.log && deps.log('agendamento ' + s.id + ' falhou: ' + e.message));
      }
    }
  }

  return {
    start() { if (!timer) { tick(); timer = setInterval(tick, tickMs); if (timer.unref) timer.unref(); } },
    stop() { clearInterval(timer); timer = null; },
    tick
  };
}

function describe(expr) {
  try {
    const n = nextRun(expr, new Date());
    return n ? 'próxima: ' + n.toLocaleString('pt-BR') : 'nunca dispara';
  } catch (e) { return 'inválida: ' + e.message; }
}

module.exports = { parseCron, nextRun, makeScheduler, describe };
