'use strict';
/* server/station.js — a estação: vários agentes, cada um com sua pasta, histórico, fila e orçamento.
   - Uma execução por agente de cada vez (fila por agente) e no máximo MAX_CONCURRENT agentes rodando juntos.
   - Esteiras: quando um agente termina, o resultado segue automaticamente para os agentes ligados a ele
     (esteira "auto"), ou o próprio agente passa trabalho com a ferramenta pass_work.
   - Execuções vindas de agendamento/esteira são "automáticas": terminal é sempre negado nelas. */
const path = require('node:path');
const fs = require('node:fs');
const { createAgent } = require('./agent.js');
const { makeShellTool } = require('./tools/shell.js');
const { costOf } = require('./cost.js');
const crew = require('./crew.js');
const { missionTools, NIGHT_MIN_TRUST } = require('./missions.js');

const MAX_HISTORY = 80;     // mensagens guardadas por agente
const MAX_CHAIN = 5;        // saltos máximos numa cadeia de esteiras (evita ciclo infinito)
const MAX_QUEUE = 20;       // itens na fila de cada agente

function trimHistory(msgs) {
  if (msgs.length <= MAX_HISTORY) return msgs;
  let cut = msgs.length - MAX_HISTORY;
  while (cut < msgs.length && msgs[cut].role !== 'user') cut++;   // começa sempre numa pergunta do usuário
  return msgs.slice(cut);
}

function makeStation(deps) {
  const { config, db, bus } = deps;
  const log = deps.log || (() => {});
  const runtimes = new Map();   // agentId → instância de createAgent
  const queues = new Map();     // agentId → [{text, source, meta, runId}]
  const active = new Map();     // agentId → {runId, controller}
  let running = 0;

  // Pasta compartilhada da tripulação: uploads do comandante (entrada/) e entregas entre tripulantes.
  const sharedDir = () => {
    const dir = path.join(config.workspace, '_compartilhado');
    fs.mkdirSync(path.join(dir, 'entrada'), { recursive: true });
    return dir;
  };

  const workspaceOf = (id) => {
    const dir = path.join(config.workspace, id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  function passWorkTool(agent) {
    return {
      name: 'pass_work',
      scope: 'read',
      description: 'Passa uma tarefa para outro tripulante ligado a você por esteira. Use o nome dele. ' +
        'Destinos possíveis: ' + (db.conveyorsFrom(agent.id).map(c => db.getAgent(c.to_agent)).filter(Boolean)
          .map(t => t.name + (t.role ? ' (' + t.role + ')' : '')).join('; ') || '(nenhum — sem esteiras saindo de você)'),
      parameters: { type: 'object', properties: { to: { type: 'string', description: 'Nome do agente de destino' }, task: { type: 'string', description: 'O que ele deve fazer, com todo o contexto necessário' } }, required: ['to', 'task'] },
      run(args, ctx) {
        const targets = db.conveyorsFrom(agent.id).map(c => db.getAgent(c.to_agent)).filter(Boolean);
        const to = targets.find(t => t.name.toLowerCase() === String(args.to).trim().toLowerCase() || t.id === args.to);
        if (!to) throw new Error('sem esteira para "' + args.to + '". Destinos: ' + (targets.map(t => t.name).join(', ') || 'nenhum'));
        const depth = (ctx.meta && ctx.meta.depth) || 0;
        const night = !!(ctx.meta && ctx.meta.night);
        if (depth + 1 > MAX_CHAIN) throw new Error('cadeia de esteiras longa demais (máx. ' + MAX_CHAIN + ')');
        if (night && to.trust != null && to.trust < NIGHT_MIN_TRUST) throw new Error(to.name + ' ainda não tem confiança para o turno da noite (' + to.trust + '/100, precisa de ' + NIGHT_MIN_TRUST + ')');
        enqueue(to.id, 'Tarefa passada por ' + agent.name + ':\n\n' + args.task, 'handoff', { from: agent.id, depth: depth + 1, night });
        bus.emit({ type: 'conveyor', from: agent.id, to: to.id, kind: 'handoff' });
        return 'Tarefa enviada para ' + to.name + '.';
      }
    };
  }

  // Só o Capitão: recruta um especialista novo e já liga uma esteira (manual) dele até o recruta.
  function recruitTool(captain) {
    return {
      name: 'recruit',
      scope: 'read',
      description: 'Recruta um novo tripulante especialista quando nenhum da equipe serve para a tarefa. ' +
        'Depois use pass_work com o nome dele para mandar a tarefa. Máximo de ' + crew.MAX_CREW + ' tripulantes.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'Nome curto (ex.: Analista de Dados)' },
        role: { type: 'string', description: 'Função em uma frase' },
        instructions: { type: 'string', description: 'Como ele deve trabalhar e entregar' }
      }, required: ['name', 'role'] },
      run(args) {
        const name = String(args.name || '').trim().slice(0, 40);
        if (!name) throw new Error('dê um nome ao recruta');
        const all = db.listAgents();
        const same = all.find(a => a.name.toLowerCase() === name.toLowerCase());
        if (same) throw new Error(same.name + ' já está na tripulação — use pass_work com esse nome');
        if (all.length >= crew.MAX_CREW) throw new Error('tripulação cheia (' + crew.MAX_CREW + '). Use quem já existe.');
        const a = db.createAgent(Object.assign(crew.freeRoom(db), {
          name, role: String(args.role || '').slice(0, 200), instructions: String(args.instructions || '').slice(0, 4000), color: crew.nextColor(db)
        }));
        db.createConveyor({ from_agent: captain.id, to_agent: a.id, auto: false, note: 'recrutado pelo Capitão' });
        const reviewer = all.find(x => x.name.toLowerCase() === 'revisor');
        if (reviewer) { try { db.createConveyor({ from_agent: a.id, to_agent: reviewer.id, auto: true, note: 'trabalho do recruta vai para revisão' }); } catch (_) { /* já existe */ } }
        invalidate(captain.id);
        bus.emit({ type: 'state_changed' });
        bus.emit({ type: 'recruited', agentId: a.id, by: captain.id, name: a.name });
        return a.name + ' recrutado(a) como "' + a.role + '". Agora use pass_work com to="' + a.name + '".';
      }
    };
  }

  function runtime(agentId) {
    if (runtimes.has(agentId)) return runtimes.get(agentId);
    const a = db.getAgent(agentId);
    if (!a) throw new Error('agente não encontrado');
    const workspace = workspaceOf(a.id);
    const extraTools = [passWorkTool(a)];
    if (a.captain) extraTools.push(recruitTool(a));
    for (const t of missionTools({ db, bus, agent: a, onMissionDone: deps.onMissionDone })) extraTools.push(t);
    for (const t of (deps.growthTools ? deps.growthTools(a) : [])) extraTools.push(t);
    if (a.shell && deps.shellAvailable) extraTools.push(makeShellTool({ workspaceFor: () => workspace, image: config.shellImage, network: config.shellNetwork, runner: deps.shellRunner }));
    if (deps.mcp) for (const t of deps.mcp.toolsFor(a.mcp || [])) extraTools.push(t);
    const rt = createAgent(config, {
      profile: { id: a.id, name: a.name, role: a.role, instructions: a.instructions, provider: a.provider, model: a.model, captain: a.captain, extraContext: deps.extraContext ? deps.extraContext(a) : '' },
      workspace, sharedDir: sharedDir(), consent: deps.consent, checkpoints: deps.checkpoints, extraTools,
      history: db.getHistory(a.id), log, retries: deps.retries,
      provider: deps.providerFor ? deps.providerFor(a) : undefined
    });
    runtimes.set(agentId, rt);
    return rt;
  }

  // Chamar sempre que o agente, as esteiras ou os conectores mudarem.
  function invalidate(agentId) { if (agentId) runtimes.delete(agentId); else runtimes.clear(); }

  function enqueue(agentId, text, source, meta) {
    const a = db.getAgent(agentId);
    if (!a) throw new Error('agente não encontrado');
    const q = queues.get(agentId) || [];
    if (q.length >= MAX_QUEUE) throw new Error('fila de ' + a.name + ' cheia');
    const runId = db.startRun({ agent_id: agentId, source, input: text });
    db.finishRun(runId, { status: 'queued' });
    q.push({ text, source, meta: meta || {}, runId });
    queues.set(agentId, q);
    bus.emit({ type: 'run_queued', agentId, runId, source, input: text.slice(0, 500) });
    pump();
    return runId;
  }

  function pump() {
    for (const [agentId, q] of queues) {
      if (running >= config.maxConcurrent) return;
      if (!q.length || active.has(agentId)) continue;
      const job = q.shift();
      execute(agentId, job);
    }
  }

  async function execute(agentId, job) {
    const a = db.getAgent(agentId);
    if (!a) return;
    const controller = new AbortController();
    active.set(agentId, { runId: job.runId, controller });
    running++;
    db.raw.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(job.runId);
    bus.emit({ type: 'run_start', agentId, runId: job.runId, source: job.source, input: job.text.slice(0, 2000) });
    const surface = job.source === 'chat' ? 'interactive' : 'autonomous';
    let lastModel = { provider: '', model: '' };
    let usageSoFar = { input: 0, output: 0 };
    let toolsOk = 0, recruited = false;
    const night = !!(job.meta && job.meta.night);
    const grow = (status) => { if (deps.onRunEnd) { try { deps.onRunEnd(a, { status, toolsOk, recruited, night, source: job.source }); } catch (err) { log('crescimento: ' + err.message); } } };
    try {
      const rt = runtime(agentId);
      const spentBefore = db.spentUsd(agentId);
      const res = await rt.send(job.text, {
        signal: controller.signal,
        surface,
        meta: job.meta,
        beforeStep: (usage) => {
          usageSoFar = usage;
          if (a.budget_usd > 0) {
            const now = spentBefore + costOf(lastModel.provider || rt.provider.name, lastModel.model || rt.provider.model, usage).usd;
            if (now >= a.budget_usd) throw new Error('orçamento de ' + a.name + ' esgotado (US$ ' + a.budget_usd.toFixed(2) + ')');
          }
        },
        onEvent: (ev) => {
          if (ev.type === 'model') lastModel = { provider: ev.provider, model: ev.model };
          if (ev.type === 'tool_result' && ev.ok) { toolsOk++; if (ev.name === 'recruit') recruited = true; }
          bus.emit({ type: 'agent_event', agentId, runId: job.runId, event: ev });
        }
      });
      const cost = costOf(lastModel.provider, lastModel.model, res.usage);
      db.finishRun(job.runId, { status: 'done', output: res.text, tokens_in: res.usage.input, tokens_out: res.usage.output, cost_usd: cost.usd, provider: lastModel.provider, model: lastModel.model, steps: res.steps });
      const hist = trimHistory(rt.messages.slice(1));
      db.saveHistory(agentId, hist);
      if (hist.length !== rt.messages.length - 1) rt.messages.splice(1, rt.messages.length - 1, ...hist);
      bus.emit({ type: 'run_end', agentId, runId: job.runId, status: 'done', output: res.text, usage: res.usage, cost_usd: cost.usd, cost_known: cost.known });
      grow('done');
      forward(a, res.text, job);
    } catch (e) {
      const status = e.name === 'AbortError' ? 'cancelled' : 'error';
      db.finishRun(job.runId, { status, error: e.message, tokens_in: usageSoFar.input, tokens_out: usageSoFar.output, provider: lastModel.provider, model: lastModel.model });
      bus.emit({ type: 'run_end', agentId, runId: job.runId, status, error: e.message });
      if (status === 'error') grow('error');
    } finally {
      active.delete(agentId);
      running--;
      pump();
    }
  }

  // Esteiras automáticas: o resultado final segue para os próximos agentes.
  function forward(agent, output, job) {
    if (!output || !output.trim()) return;
    const depth = (job.meta && job.meta.depth) || 0;
    for (const c of db.conveyorsFrom(agent.id)) {
      if (!c.auto) continue;
      if (depth + 1 > MAX_CHAIN) { bus.emit({ type: 'warning', message: 'esteira parada: cadeia com mais de ' + MAX_CHAIN + ' saltos' }); return; }
      try {
        enqueue(c.to_agent, 'Resultado recebido de ' + agent.name + ' pela esteira' + (c.note ? ' (' + c.note + ')' : '') + ':\n\n' + output, 'conveyor', { from: agent.id, depth: depth + 1, night: !!(job.meta && job.meta.night) });
        bus.emit({ type: 'conveyor', from: agent.id, to: c.to_agent, kind: 'auto' });
      } catch (e) { bus.emit({ type: 'warning', message: 'esteira: ' + e.message }); }
    }
  }

  function cancel(agentId) {
    const q = queues.get(agentId) || [];
    for (const job of q) { db.finishRun(job.runId, { status: 'cancelled', error: 'cancelado antes de começar' }); bus.emit({ type: 'run_end', agentId, runId: job.runId, status: 'cancelled' }); }
    queues.set(agentId, []);
    const act = active.get(agentId);
    if (act) act.controller.abort();
  }

  function reset(agentId) {
    cancel(agentId);
    db.saveHistory(agentId, []);
    invalidate(agentId);
    if (deps.consent) deps.consent.revokeSession(agentId);
  }

  function status() {
    const out = {};
    for (const a of db.listAgents()) out[a.id] = { busy: active.has(a.id), runId: (active.get(a.id) || {}).runId || null, queued: (queues.get(a.id) || []).length };
    return out;
  }

  return { enqueue, cancel, reset, invalidate, status, workspaceOf, sharedDir, runtime };
}

module.exports = { makeStation, trimHistory, MAX_CHAIN };
