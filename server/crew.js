'use strict';
/* server/crew.js — a tripulação pronta: agentes, esteiras e agenda que a estação cria sozinha.
   Fluxo: você fala com o Capitão → ele delega (pass_work) → Pesquisadora → Redator → Revisor → volta ao
   Capitão, que entrega o resultado final. Se faltar um especialista, o Capitão recruta um (ferramenta recruit).
   applyPreset é idempotente: só cria o que ainda não existe (compara pelo nome). */
const { nextRun } = require('./cron.js');

const COLORS = ['#5ec8ff', '#ffb347', '#7dffa8', '#ff6b9a', '#c49bff', '#ffe066', '#6bf0e0', '#ff8f6b'];
const MAX_CREW = 12;

const CAPTAIN_INSTRUCTIONS = [
  'Você coordena a tripulação. Nunca faça sozinho o trabalho de um especialista: delegue com pass_work.',
  'Para cada pedido: 1) entenda o objetivo; 2) escolha o tripulante certo (veja os destinos e funções no pass_work);',
  '3) mande a tarefa com todo o contexto necessário; 4) responda ao comandante dizendo quem está cuidando do quê.',
  'Pesquisas e textos: mande para a Pesquisadora — o trabalho segue sozinho para Redator e Revisor e volta para você.',
  'Código, scripts e automações: mande para a Engenheira.',
  'Se nenhum tripulante serve para a tarefa, use recruit para recrutar um especialista novo e depois pass_work para ele.',
  'Quando receber um resultado de volta pela esteira, NÃO delegue de novo: entregue ao comandante um resumo final claro.'
].join('\n');

const PRESET = {
  agents: [
    { key: 'captain', name: 'Capitão', captain: true, color: '#ffb347',
      role: 'coordena a tripulação: entende o pedido, divide em tarefas, delega e entrega o resultado final',
      instructions: CAPTAIN_INSTRUCTIONS },
    { key: 'research', name: 'Pesquisadora', color: '#5ec8ff',
      role: 'pesquisa na web e resume os fatos com as fontes',
      instructions: 'Use web_search para achar fontes e fetch_url para ler as páginas. Prefira fontes oficiais e recentes. ' +
        'Entregue os fatos principais em tópicos, cada um com o link da fonte. Não invente dados: se não achar, diga.' },
    { key: 'writer', name: 'Redator', color: '#7dffa8',
      role: 'transforma pesquisas em textos claros em português',
      instructions: 'Escreva de forma direta e organizada (título, resumo curto, tópicos). Mantenha os links das fontes. ' +
        'Quando a tarefa pedir um arquivo, salve com write_file (ex.: relatorios/AAAA-MM-DD-assunto.md).' },
    { key: 'reviewer', name: 'Revisor', color: '#c49bff',
      role: 'revisa textos e código, corrige erros e entrega a versão final',
      instructions: 'Confira fatos contra as fontes citadas, corrija português e clareza, aponte o que estiver fraco. ' +
        'Entregue a versão final pronta, seguida de uma lista curta do que você corrigiu.' },
    { key: 'engineer', name: 'Engenheira', color: '#6bf0e0', shell: true,
      role: 'escreve, testa e corrige código e scripts',
      instructions: 'Escreva o código em arquivos na sua pasta (write_file). Quando possível, teste no terminal (shell) antes de entregar. ' +
        'Explique em poucas linhas o que fez e como usar.' }
  ],
  // esteiras: auto = o resultado final segue sozinho; manual = só via pass_work
  conveyors: [
    { from: 'captain', to: 'research', auto: false, note: 'Capitão delega pesquisas' },
    { from: 'captain', to: 'writer', auto: false, note: 'Capitão delega textos' },
    { from: 'captain', to: 'reviewer', auto: false, note: 'Capitão pede revisões' },
    { from: 'captain', to: 'engineer', auto: false, note: 'Capitão delega código' },
    { from: 'research', to: 'writer', auto: true, note: 'pesquisa vira texto' },
    { from: 'writer', to: 'reviewer', auto: true, note: 'texto vai para revisão' },
    { from: 'engineer', to: 'reviewer', auto: true, note: 'código vai para revisão' },
    { from: 'reviewer', to: 'captain', auto: true, note: 'resultado final volta ao Capitão' }
  ],
  schedules: [
    { agent: 'research', cron: '0 9 * * 1-5',
      prompt: 'Pesquise as 3 novidades mais importantes sobre agentes de IA publicadas nas últimas 24 horas. Resuma cada uma com o link da fonte.' }
  ]
};

function freeRoom(db) {
  const used = new Set(db.listAgents().map(a => a.room_x + ',' + a.room_y));
  for (let y = 0; y < 20; y++) for (let x = 0; x < 3; x++) if (!used.has(x + ',' + y)) return { room_x: x, room_y: y };
  return { room_x: 0, room_y: 0 };
}

function nextColor(db) { return COLORS[db.listAgents().length % COLORS.length]; }

// Cria o que falta da tripulação pronta. Retorna { created, conveyors, schedules } (só o que foi criado agora).
function applyPreset(db) {
  const byName = (n) => db.listAgents().find(a => a.name.toLowerCase() === n.toLowerCase());
  const ids = {};
  const created = [];
  for (const p of PRESET.agents) {
    let a = byName(p.name);
    if (!a) {
      a = db.createAgent(Object.assign(freeRoom(db), { name: p.name, role: p.role, instructions: p.instructions, color: p.color, shell: !!p.shell, captain: !!p.captain }));
      created.push(a.name);
    } else if (p.captain && !a.captain) {
      a = db.updateAgent(a.id, { captain: true });
    }
    ids[p.key] = a.id;
  }
  const existing = new Set(db.listConveyors().map(c => c.from_agent + '>' + c.to_agent));
  let conveyors = 0;
  for (const c of PRESET.conveyors) {
    const k = ids[c.from] + '>' + ids[c.to];
    if (existing.has(k)) continue;
    db.createConveyor({ from_agent: ids[c.from], to_agent: ids[c.to], auto: c.auto, note: c.note });
    conveyors++;
  }
  let schedules = 0;
  const sched = db.listSchedules();
  for (const s of PRESET.schedules) {
    if (sched.some(x => x.agent_id === ids[s.agent] && x.cron === s.cron)) continue;
    const n = nextRun(s.cron, new Date());
    db.createSchedule({ agent_id: ids[s.agent], cron: s.cron, prompt: s.prompt, next_run: n && n.toISOString() });
    schedules++;
  }
  return { created, conveyors, schedules };
}

module.exports = { PRESET, applyPreset, freeRoom, nextColor, MAX_CREW, COLORS };
