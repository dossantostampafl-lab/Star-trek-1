'use strict';
/* server/growth.js — crescimento da tripulação.
   - Dossiê do comandante: tripulantes propõem "crenças" (preferências, contexto) com propose_belief;
     só as que o comandante ACEITA entram no contexto de todos.
   - XP e nível: cada execução concluída rende XP (mais pelas ferramentas usadas com sucesso).
   - Confiança (0–100): sobe com trabalho concluído e 👍, desce com erros e 👎.
     Autonomia: só quem tem confiança ≥ 40 recebe trabalho do turno da noite.
   - Troféus: marcos (primeira tarefa, 10 tarefas, missão concluída, turno da noite, recrutou alguém…). */

const TROPHIES = {
  primeira: { title: 'Primeira tarefa', icon: '🎖' },
  dez: { title: '10 tarefas', icon: '🏅' },
  cinquenta: { title: '50 tarefas', icon: '🏆' },
  ferramenteiro: { title: 'Usou 5+ ferramentas numa tarefa', icon: '🛠' },
  noturno: { title: 'Trabalhou no turno da noite', icon: '🌙' },
  missao: { title: 'Concluiu uma missão', icon: '🚀' },
  aprovado: { title: 'Recebeu 👍 do comandante', icon: '👍' },
  recrutador: { title: 'Recrutou um tripulante', icon: '🧑‍🚀' },
  observador: { title: 'Teve uma crença aceita no dossiê', icon: '📓' }
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const levelOf = (xp) => Math.floor(Math.sqrt(Math.max(0, xp || 0) / 25)) + 1;
const nextLevelXp = (lvl) => lvl * lvl * 25;
const autonomyOf = (trust) => trust >= 70 ? 'autônomo' : trust >= 40 ? 'confiável' : 'supervisionado';

function makeGrowth(deps) {
  const { db, bus } = deps;
  const invalidate = deps.invalidate || (() => {});

  function award(agentId, key) {
    if (!TROPHIES[key]) return;
    if (db.addTrophy(agentId, key)) {
      const a = db.getAgent(agentId);
      bus.emit({ type: 'trophy', agentId, key, title: TROPHIES[key].title, icon: TROPHIES[key].icon, name: a && a.name });
    }
  }

  function bump(agentId, dxp, dtrust) {
    const a = db.getAgent(agentId);
    if (!a) return;
    const before = levelOf(a.xp);
    const xp = Math.max(0, (a.xp || 0) + dxp);
    const trust = clamp((a.trust == null ? 50 : a.trust) + dtrust, 0, 100);
    db.updateAgent(agentId, { xp, trust });
    const after = levelOf(xp);
    if (after > before) bus.emit({ type: 'level_up', agentId, level: after, name: a.name });
  }

  // chamado pela estação ao fim de cada execução
  function onRunEnd(agent, info) {
    if (info.status === 'done') {
      bump(agent.id, 10 + Math.min(10, 2 * (info.toolsOk || 0)), 1);
      const n = db.countRuns(agent.id, 'done');
      if (n >= 1) award(agent.id, 'primeira');
      if (n >= 10) award(agent.id, 'dez');
      if (n >= 50) award(agent.id, 'cinquenta');
      if ((info.toolsOk || 0) >= 5) award(agent.id, 'ferramenteiro');
      if (info.night) award(agent.id, 'noturno');
    } else if (info.status === 'error') {
      bump(agent.id, 0, -3);
    }
    if (info.recruited) award(agent.id, 'recrutador');
  }

  function onMissionDone(mission, agent) {
    bump(agent.id, 30, 3);
    award(agent.id, 'missao');
  }

  // 👍 = +1, 👎 = -1, 0 = remover. Refazer a avaliação desfaz a anterior.
  function rate(runId, rating) {
    const run = db.getRun(runId);
    if (!run) throw new Error('execução não encontrada');
    rating = rating > 0 ? 1 : rating < 0 ? -1 : 0;
    const prev = run.rating || 0;
    if (prev === rating) return run;
    const dTrust = 5 * (rating - prev);
    const dXp = 15 * ((rating > 0 ? 1 : 0) - (prev > 0 ? 1 : 0));
    db.rateRun(runId, rating);
    bump(run.agent_id, dXp, dTrust);
    if (rating > 0) award(run.agent_id, 'aprovado');
    bus.emit({ type: 'state_changed' });
    return db.getRun(runId);
  }

  function setBelief(id, status) {
    const b = db.listBeliefs().find(x => x.id === id);
    if (!b) throw new Error('crença não encontrada');
    db.setBelief(id, status);
    if (status === 'aceita' && b.agent_id) { award(b.agent_id, 'observador'); bump(b.agent_id, 10, 2); }
    invalidate();   // o contexto de todos muda
    bus.emit({ type: 'state_changed' });
  }

  function beliefTool(agent) {
    return {
      name: 'propose_belief', scope: 'read',
      description: 'Registre no dossiê algo que você percebeu sobre o comandante (preferência, contexto, forma de trabalhar). ' +
        'Fica como PROPOSTA até ele aceitar. Frase curta e factual, ex.: "Prefere respostas curtas em tópicos".',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run(a) {
        const id = db.addBelief({ text: a.text, agent_id: agent.id });
        if (!id) return 'Essa crença já está no dossiê.';
        bus.emit({ type: 'belief_proposed', agentId: agent.id, text: String(a.text).slice(0, 300) });
        return 'Proposta registrada. O comandante vai aceitar ou recusar.';
      }
    };
  }

  // texto extra no prompt de sistema: crenças aceitas + situação do tripulante
  function extraContext(agent) {
    const acc = db.listBeliefs().filter(b => b.status === 'aceita').slice(0, 25);
    const lines = [];
    if (acc.length) { lines.push('O que a tripulação sabe sobre o comandante (dossiê aceito por ele):'); for (const b of acc) lines.push('- ' + b.text); }
    lines.push('Seu nível: ' + levelOf(agent.xp) + ' · confiança ' + (agent.trust == null ? 50 : agent.trust) + '/100 (' + autonomyOf(agent.trust == null ? 50 : agent.trust) + ').');
    lines.push('Se perceber uma preferência do comandante que vale lembrar, use propose_belief.');
    return lines.join('\n');
  }

  function summary() {
    const trophies = db.listTrophies();
    return db.listAgents().map(a => ({
      id: a.id, xp: a.xp || 0, level: levelOf(a.xp), next: nextLevelXp(levelOf(a.xp)), trust: a.trust == null ? 50 : a.trust,
      autonomy: autonomyOf(a.trust == null ? 50 : a.trust),
      trophies: trophies.filter(t => t.agent_id === a.id).map(t => Object.assign({ key: t.key, at: t.at }, TROPHIES[t.key] || {}))
    }));
  }

  return { onRunEnd, onMissionDone, rate, setBelief, beliefTool, extraContext, summary, award };
}

module.exports = { makeGrowth, levelOf, nextLevelXp, autonomyOf, TROPHIES };
