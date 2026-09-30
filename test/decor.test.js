'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfig } = require('../server/config.js');
const { start } = require('../server/index.js');
const decor = require('../server/decor.js');

const ROOT = path.join(__dirname, '..');

test('todo móvel e personagem do catálogo tem imagem em web/assets', () => {
  for (const k of Object.keys(decor.FURNITURE)) assert.ok(fs.existsSync(path.join(ROOT, 'web/assets/furniture', k + '.png')), 'falta móvel ' + k);
  for (const k of Object.keys(decor.CHARACTERS)) assert.ok(fs.existsSync(path.join(ROOT, 'web/assets/crew', k + '.png')), 'falta personagem ' + k);
  assert.ok(fs.existsSync(path.join(ROOT, 'web/assets/NOTICE.md')));
});

test('cleanProps descarta móveis desconhecidos e prende dentro da sala; visual padrão por nome', () => {
  const out = decor.cleanProps([{ k: 'desk', x: 999, y: -5 }, { k: 'foguete', x: 1, y: 1 }, { k: 'plant', x: 3.4, y: 20, flip: 1, extra: 'x' }]);
  assert.deepEqual(out, [{ k: 'desk', x: decor.ROOM_W - 24, y: 0 }, { k: 'plant', x: 3, y: 20, flip: true }]);
  assert.throws(() => decor.cleanProps('nada'));
  assert.throws(() => decor.cleanSprite('pikachu'));
  assert.equal(decor.defaultLook({ name: 'Redator', role: 'transforma pesquisas em textos' }).sprite, 'secretagent');
  assert.equal(decor.defaultLook({ name: 'Capitão', captain: true }).sprite, 'astronaut');
  assert.ok(decor.CHARACTERS[decor.defaultLook({ id: 'ag_x', name: 'Contadora' }).sprite]);
  for (const kind of ['Capitão', 'Pesquisadora', 'Redator', 'Revisor', 'Engenheira', 'Qualquer']) {
    const props = decor.defaultLook({ name: kind, captain: kind === 'Capitão' }).props;
    assert.deepEqual(decor.cleanProps(props), props, 'móveis padrão fora da sala: ' + kind);
  }
});

test('API: tripulação nasce decorada, editor troca personagem/móveis, mover sala troca de lugar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st1d-'));
  const srv = await start({ config: getConfig({ WORKSPACE: dir + '/ws', DATA_DIR: dir + '/data', SEED_CREW: '1' }), port: 0, log: () => {}, shellAvailable: false, tickMs: 60000, nightTickMs: 3600e3 });
  const api = async (method, p, body) => {
    const r = await fetch(srv.url + p, { method, headers: { 'x-st1-token': srv.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const st = (await api('GET', '/api/state')).body;
    assert.ok(st.decor.furniture.desk && st.decor.characters.astronaut);
    const cap = st.agents.find(a => a.captain), red = st.agents.find(a => a.name === 'Redator');
    assert.equal(cap.sprite, 'astronaut');
    assert.ok(cap.props.length >= 3);

    let r = await api('PATCH', '/api/agents/' + cap.id, { sprite: 'capybara', props: [{ k: 'rug', x: 10, y: 20 }, { k: 'inexistente', x: 0, y: 0 }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.sprite, 'capybara');
    assert.deepEqual(r.body.props, [{ k: 'rug', x: 10, y: 20 }]);
    assert.equal((await api('PATCH', '/api/agents/' + cap.id, { sprite: 'personagem-famoso' })).status, 400);

    // mover o Capitão para o lugar do Redator: os dois trocam
    const [cx, cy, rx, ry] = [cap.room_x, cap.room_y, red.room_x, red.room_y];
    await api('PATCH', '/api/agents/' + cap.id, { room_x: rx, room_y: ry });
    const after = (await api('GET', '/api/state')).body.agents;
    assert.deepEqual([after.find(a => a.id === cap.id).room_x, after.find(a => a.id === cap.id).room_y], [rx, ry]);
    assert.deepEqual([after.find(a => a.id === red.id).room_x, after.find(a => a.id === red.id).room_y], [cx, cy]);

    // esvaziar a sala fica vazio mesmo após reiniciar; "↺ padrão" devolve o visual
    await api('PATCH', '/api/agents/' + cap.id, { props: [] });
    r = await api('PATCH', '/api/agents/' + cap.id, { reset_look: true });
    assert.equal(r.body.sprite, 'astronaut');
    assert.ok(r.body.props.length >= 3);

    // tripulante novo já nasce com personagem e móveis
    r = await api('POST', '/api/agents', { name: 'Contadora', role: 'cuida das contas' });
    assert.ok(decor.CHARACTERS[r.body.sprite]);
    assert.ok(r.body.props.length > 0);

    // arquivos da arte são servidos
    const img = await fetch(srv.url + '/assets/crew/astronaut.png');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
  } finally { await srv.close(); }
});
