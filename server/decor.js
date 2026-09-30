'use strict';
/* server/decor.js — aparência da estação: personagem de cada tripulante e móveis de cada sala.
   Os desenhos (sprites e móveis) vêm do StarNet (MIT, Andrew Sims) — ver web/assets/NOTICE.md.
   Unidades: a sala mede ROOM_W × ROOM_H "pixels de estação"; cada unidade = 4 px da arte original.
   A faixa de cima (WALL_H) é a parede: quadros, telas e painéis ficam nela. */

const ROOM_W = 96, ROOM_H = 60, WALL_H = 12;

// chave → [largura, altura] em unidades de estação, nome em português, se é de parede, se é posto de trabalho
const FURNITURE = {
  desk: [24, 18, 'Mesa', 0, 1], desk2: [24, 18, 'Mesa com monitor', 0, 1], pixelrig: [24, 18, 'Estação de pixel', 0, 1],
  console: [12, 24, 'Console', 0, 1], consoleL: [48, 12, 'Console longo', 0, 1], holotable: [48, 24, 'Mesa holográfica', 0, 1],
  wartable: [60, 24, 'Mesa de estratégia', 0, 1], djbooth: [48, 24, 'Cabine de som', 0, 1], fabricator: [36, 24, 'Fabricador', 0, 1],
  easel: [36, 24, 'Cavalete', 0, 1], rack: [24, 17, 'Rack de servidores', 0, 1],
  chair: [12, 12, 'Cadeira', 0, 0], chairbig: [12, 14, 'Poltrona', 0, 0], stool: [12, 12, 'Banquinho', 0, 0],
  couch: [60, 15, 'Sofá', 0, 0], bench: [72, 12, 'Bancada', 0, 0], bunk: [24, 24, 'Beliche', 0, 0], rug: [60, 24, 'Tapete', 0, 0],
  plant: [12, 12, 'Planta', 0, 0], coffee: [12, 12, 'Cafeteira', 0, 0], cans: [12, 12, 'Latas', 0, 0], crate: [12, 12, 'Caixote', 0, 0],
  boxes: [24, 12, 'Caixas', 0, 0], parcels: [12, 14, 'Pacotes', 0, 0], goldcrate: [24, 12, 'Caixa de ouro', 0, 0],
  speaker: [12, 12, 'Caixa de som', 0, 0], jukebox: [12, 26, 'Jukebox', 0, 0], arcade: [20, 26, 'Fliperama', 0, 0],
  arcade2: [20, 26, 'Fliperama 2', 0, 0], tv: [36, 17, 'TV', 0, 0], tank: [24, 16, 'Aquário', 0, 0], tube: [24, 20, 'Tubo de ensaio', 0, 0],
  vat: [36, 24, 'Tanque', 0, 0], vault: [36, 27, 'Cofre-forte', 0, 0], safe: [12, 32, 'Cofre', 0, 0], core: [12, 34, 'Núcleo de energia', 0, 0],
  rackV: [12, 24, 'Rack vertical', 0, 0], beltH: [24, 12, 'Esteira', 0, 0], bar: [84, 15, 'Balcão', 0, 0], shelf: [84, 16, 'Prateleira', 0, 0],
  bigscreen: [96, 12, 'Telão', 1, 0], commswall: [84, 8, 'Painel de comunicação', 1, 0], chartwall: [60, 8, 'Painel de gráficos', 1, 0],
  calwall: [54, 8, 'Calendário', 1, 0], screens: [48, 12, 'Telas', 1, 0], whiteboard: [48, 14, 'Quadro branco', 1, 0],
  ticker: [60, 16, 'Letreiro', 1, 0], poster: [12, 12, 'Pôster', 1, 0]
};

const CHARACTERS = {
  astronaut: 'Astronauta', android: 'Androide', robot: 'Robô', blank_blue: 'Tripulante azul', blank_amber: 'Tripulante âmbar',
  blank_green: 'Tripulante verde', blank_red: 'Tripulante vermelho', capybara: 'Capivara', plaguedoctor: 'Médico da peste',
  voidwizard: 'Mago do vazio', secretagent: 'Agente secreto', crthead: 'Cabeça de monitor', alien: 'Alienígena', bear: 'Urso',
  skeleton: 'Esqueleto', grimreaper: 'Ceifador', reptilian: 'Reptiliano'
};

const MAX_PROPS = 24;

function cleanProps(list) {
  if (!Array.isArray(list)) throw new Error('móveis inválidos');
  const out = [];
  for (const p of list.slice(0, MAX_PROPS)) {
    const f = p && FURNITURE[p.k];
    if (!f) continue;
    const x = Math.round(Number(p.x) || 0), y = Math.round(Number(p.y) || 0);
    out.push({ k: p.k, x: Math.max(0, Math.min(ROOM_W - f[0], x)), y: Math.max(0, Math.min(ROOM_H - f[1], y)), ...(p.flip ? { flip: true } : {}) });
  }
  return out;
}

function cleanSprite(s) {
  s = String(s || '');
  if (!CHARACTERS[s]) throw new Error('personagem desconhecido');
  return s;
}

// Aparência padrão pelo tipo de tripulante (nome/função). Móveis: posto de trabalho + um toque pessoal.
function defaultLook(a) {
  const W = WALL_H;
  // o nome decide primeiro (a função do Redator fala em "pesquisas", por exemplo); a função só desempata
  const look = kindOf(String(a.name || '').toLowerCase(), !!a.captain) || kindOf(String(a.role || '').toLowerCase(), false);
  if (look) return look;
  const pool = ['blank_blue', 'blank_amber', 'blank_green', 'blank_red', 'capybara', 'alien', 'bear', 'voidwizard', 'plaguedoctor'];
  let h = 0; for (const c of String(a.id || a.name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { sprite: pool[h % pool.length], props: [{ k: 'screens', x: 30, y: 0 }, { k: 'desk', x: 60, y: W + 2 }, { k: 'plant', x: 4, y: W + 4 }] };
}

function kindOf(txt, captain) {
  const W = WALL_H;
  if (captain || /capit/.test(txt)) return { sprite: 'astronaut', props: [
    { k: 'bigscreen', x: 0, y: 0 }, { k: 'holotable', x: 40, y: W + 6 }, { k: 'chairbig', x: 8, y: W + 8 }, { k: 'plant', x: 80, y: W + 2 }] };
  if (/pesquis|research/.test(txt)) return { sprite: 'android', props: [
    { k: 'screens', x: 40, y: 0 }, { k: 'desk2', x: 60, y: W + 2 }, { k: 'tank', x: 4, y: W + 4 }, { k: 'coffee', x: 80, y: W + 32 }, { k: 'parcels', x: 4, y: W + 30 }] };
  if (/redat|escrit|texto|writer/.test(txt)) return { sprite: 'secretagent', props: [
    { k: 'poster', x: 10, y: 0 }, { k: 'desk', x: 60, y: W + 2 }, { k: 'easel', x: 4, y: W + 4 }, { k: 'plant', x: 82, y: W + 30 }] };
  if (/revis|review/.test(txt)) return { sprite: 'crthead', props: [
    { k: 'whiteboard', x: 30, y: 0 }, { k: 'desk2', x: 60, y: W + 2 }, { k: 'crate', x: 4, y: W + 32 }, { k: 'cans', x: 18, y: W + 32 }] };
  if (/engenh|código|codigo|dev|program|engineer/.test(txt)) return { sprite: 'robot', props: [
    { k: 'commswall', x: 0, y: 0 }, { k: 'pixelrig', x: 60, y: W + 2 }, { k: 'rack', x: 4, y: W + 2 }, { k: 'rackV', x: 30, y: W + 2 }] };
  return null;
}

// Tripulante sem personagem ainda (bancos antigos ou recém-recrutado): recebe o visual padrão uma única vez.
// Depois disso, os móveis são do comandante — mesmo que ele esvazie a sala, não repomos nada.
function ensureLooks(db) {
  for (const a of db.listAgents()) {
    if (a.sprite) continue;
    const look = defaultLook(a);
    db.updateAgent(a.id, { sprite: look.sprite, props: (a.props && a.props.length) ? a.props : look.props });
  }
}

module.exports = { FURNITURE, CHARACTERS, ROOM_W, ROOM_H, WALL_H, cleanProps, cleanSprite, defaultLook, ensureLooks };
