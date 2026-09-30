'use strict';
/* server/questions.js — "pergunta antes de adivinhar".
   Quando o pedido é ambíguo e um palpite errado custaria caro, o tripulante chama ask_commander com UMA pergunta
   concreta e 2–4 opções. A pergunta aparece no painel e nos canais (Telegram/Discord) com botões.
   - Com o comandante por perto (chat/canal/tarefa de dia): o tripulante ESPERA a resposta (até QUESTION_WAIT_MIN).
     Sem resposta no prazo, segue com a opção indicada como padrão e diz isso na entrega.
   - No turno da noite: não espera — a pergunta fica aberta para a manhã (entra no relatório) e ele segue pelo padrão.
   Uma resposta que chega depois do prazo fica registrada e é enviada ao tripulante como nova mensagem. */

const DEFAULT_WAIT_MIN = 20;
const MAX_OPEN_PER_AGENT = 3;

function makeQuestions(deps) {
  const { db, bus } = deps;
  const raw = db.raw;
  const waitMs = deps.waitMs != null ? deps.waitMs : (Number(process.env.QUESTION_WAIT_MIN) || DEFAULT_WAIT_MIN) * 60000;
  raw.exec(`CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, run_id TEXT, question TEXT NOT NULL, options TEXT DEFAULT '[]',
    default_option TEXT DEFAULT '', context TEXT DEFAULT '', status TEXT DEFAULT 'aberta', answer TEXT, via TEXT,
    night INTEGER DEFAULT 0, created_at TEXT, answered_at TEXT)`);
  const waiters = new Map();   // id → resolve
  const now = () => new Date().toISOString();
  let seq = 0;
  const row = (r) => r && Object.assign({}, r, { options: JSON.parse(r.options || '[]'), night: !!r.night });

  const get = (id) => row(raw.prepare('SELECT * FROM questions WHERE id = ?').get(String(id)));
  const list = (status) => (status
    ? raw.prepare('SELECT * FROM questions WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(status)
    : raw.prepare('SELECT * FROM questions ORDER BY created_at DESC LIMIT 100').all()).map(row);

  function create(agent, args, meta) {
    const question = String(args.question || '').trim().slice(0, 600);
    if (!question) throw new Error('escreva a pergunta');
    let options = Array.isArray(args.options) ? args.options.map(o => String(o).trim().slice(0, 120)).filter(Boolean).slice(0, 4) : [];
    const open = raw.prepare("SELECT COUNT(*) AS n FROM questions WHERE agent_id = ? AND status = 'aberta'").get(agent.id).n;
    if (open >= MAX_OPEN_PER_AGENT) throw new Error('você já tem ' + open + ' perguntas abertas — siga com o melhor palpite e explique na entrega');
    const def = String(args.default || options[0] || '').slice(0, 120);
    const id = 'q' + Date.now().toString(36) + (seq++).toString(36);
    raw.prepare('INSERT INTO questions (id, agent_id, run_id, question, options, default_option, context, night, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, agent.id, (meta && meta.runId) || null, question, JSON.stringify(options), def, String(args.context || '').slice(0, 1000), meta && meta.night ? 1 : 0, now());
    const q = get(id);
    bus.emit({ type: 'question', id, agentId: agent.id, agentName: agent.name, question, options, default: def, night: q.night });
    return q;
  }

  // Resposta do comandante (painel, Telegram, Discord). Devolve a pergunta atualizada.
  function answer(id, text, via) {
    const q = get(id);
    if (!q) throw new Error('pergunta não encontrada');
    if (q.status !== 'aberta' && q.status !== 'expirada') throw new Error('essa pergunta já foi respondida');
    const ans = String(text || '').trim().slice(0, 2000);
    if (!ans) throw new Error('resposta vazia');
    const late = q.status === 'expirada' || !waiters.has(q.id);
    raw.prepare("UPDATE questions SET status = 'respondida', answer = ?, via = ?, answered_at = ? WHERE id = ?").run(ans, via || 'painel', now(), q.id);
    bus.emit({ type: 'question_answered', id: q.id, agentId: q.agent_id, answer: ans, via: via || 'painel' });
    const w = waiters.get(q.id);
    if (w) { waiters.delete(q.id); w(ans); }
    else if (late && deps.deliverLate) deps.deliverLate(q, ans);   // chega como nova mensagem para o tripulante
    return get(q.id);
  }

  function dismiss(id) {
    const q = get(id);
    if (!q) throw new Error('pergunta não encontrada');
    raw.prepare("UPDATE questions SET status = 'descartada', answered_at = ? WHERE id = ?").run(now(), q.id);
    const w = waiters.get(q.id);
    if (w) { waiters.delete(q.id); w(null); }
    bus.emit({ type: 'question_answered', id: q.id, agentId: q.agent_id, answer: null });
  }

  function tool(agent) {
    return {
      name: 'ask_commander', scope: 'read',
      description: 'Pergunte ao comandante ANTES de adivinhar, quando o pedido é ambíguo e um palpite errado desperdiçaria o trabalho ' +
        '(ex.: qual público, qual formato, qual de duas interpretações). UMA pergunta curta, 2–4 opções concretas e default = a opção ' +
        'que você seguirá se ele não responder. Não pergunte o que dá para descobrir sozinho.',
      parameters: { type: 'object', properties: {
        question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
        default: { type: 'string', description: 'opção que você segue se não houver resposta' },
        context: { type: 'string', description: 'uma linha dizendo por que a dúvida importa' } }, required: ['question'] },
      async run(args, ctx) {
        const meta = (ctx && ctx.meta) || {};
        let q;
        try { q = create(agent, args, meta); } catch (e) { return 'Não perguntei: ' + e.message; }
        if (meta.night) {
          return 'Turno da noite: o comandante está dormindo. A pergunta (' + q.id + ') fica para a manhã. ' +
            'Siga agora com "' + (q.default_option || 'o palpite mais seguro') + '" e deixe claro na entrega que foi uma suposição.';
        }
        const ans = await new Promise((resolve) => {
          waiters.set(q.id, resolve);
          const t = setTimeout(() => { if (waiters.has(q.id)) { waiters.delete(q.id); resolve(undefined); } }, waitMs);
          if (t.unref) t.unref();
          if (ctx && ctx.signal) ctx.signal.addEventListener('abort', () => { if (waiters.has(q.id)) { waiters.delete(q.id); resolve(undefined); } }, { once: true });
        });
        if (ans === null) return 'O comandante descartou a pergunta. Siga com "' + (q.default_option || 'seu melhor palpite') + '".';
        if (ans === undefined) {
          raw.prepare("UPDATE questions SET status = 'expirada' WHERE id = ? AND status = 'aberta'").run(q.id);
          bus.emit({ type: 'question_expired', id: q.id, agentId: agent.id });
          return 'Sem resposta em ' + Math.round(waitMs / 60000) + ' min. Siga com "' + (q.default_option || 'seu melhor palpite') +
            '" e diga na entrega que foi uma suposição (o comandante pode corrigir depois).';
        }
        return 'Resposta do comandante: ' + ans;
      }
    };
  }

  // perguntas abertas que o turno da noite deixou — entram no relatório da manhã
  function openForReport() {
    return list().filter(q => q.status === 'aberta' || (q.status === 'expirada' && q.night));
  }

  return { create, answer, dismiss, tool, list, get, openForReport, pending: () => list('aberta').length };
}

module.exports = { makeQuestions };
