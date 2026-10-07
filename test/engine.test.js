import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/lib/engine.js';
import { parseCost, planPayment, manaOptions, manaSources } from '../public/lib/mana.js';

// ---------- Fixtures ----------

const forest = { name: 'Forest', typeLine: 'Basic Land — Forest', cmc: 0, manaCost: '', oracle: '({T}: Add {G}.)', keywords: [], colorIdentity: ['G'] };
const island = { name: 'Island', typeLine: 'Basic Land — Island', cmc: 0, manaCost: '', oracle: '({T}: Add {U}.)', keywords: [], colorIdentity: ['U'] };
const solRing = { name: 'Sol Ring', typeLine: 'Artifact', cmc: 1, manaCost: '{1}', oracle: '{T}: Add {C}{C}.', keywords: [], colorIdentity: [] };
const creature = (name, cost, p, t, keywords = [], oracle = '', typeLine = 'Creature — Bear') => ({
  name, typeLine, cmc: parseCost(cost).generic + parseCost(cost).pips.length, manaCost: cost, oracle, keywords, power: String(p), toughness: String(t), colorIdentity: ['G'],
});
const bolt = { name: 'Lightning Bolt', typeLine: 'Instant', cmc: 1, manaCost: '{R}', oracle: 'Lightning Bolt deals 3 damage to any target.', keywords: [] };
const counterspell = { name: 'Counterspell', typeLine: 'Instant', cmc: 2, manaCost: '{U}{U}', oracle: 'Counter target spell.', keywords: [] };

function deck(cmdrName = 'Cmdr') {
  return [
    { info: creature(cmdrName, '{2}{G}', 3, 3, [], '', 'Legendary Creature — Squirrel'), qty: 1, board: 'commander' },
    { info: forest, qty: 40, board: 'main' },
    { info: creature('Grizzly Bears', '{1}{G}', 2, 2), qty: 30, board: 'main' },
    { info: creature('Hill Giant', '{3}{G}', 3, 3), qty: 20, board: 'main' },
    { info: { name: 'Divination', typeLine: 'Sorcery', cmc: 3, manaCost: '{2}{G}', oracle: 'Draw two cards.', keywords: [] }, qty: 9, board: 'main' },
  ];
}

const io = {
  step: async () => {},
  chooseBlocks: async (g, d, atks) => E.aiChooseBlocks(g, d, atks),
  respond: async () => null,
  chooseDiscard: async (g, p, n) => p.hand.slice(0, n),
};

function newGame(n = 2) {
  const g = E.createGame(Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isAI: true, entries: deck(`Cmdr ${i}`) })));
  g.active = 0;
  g.firstPlayer = 0;
  return g;
}

function put(g, p, info, zone = 'battlefield', extra = {}) {
  const c = E.makeCard(info, p.idx, extra);
  c.sick = false;
  p[zone].push(c);
  return c;
}

// ---------- Mana ----------

test('CR 107.4 / 202: parseCost lee genérico, color, híbrido, pirexiano y X', () => {
  assert.deepEqual(parseCost('{2}{G}{G}'), { generic: 2, pips: [{ any: ['G'] }, { any: ['G'] }], x: 0 });
  assert.equal(parseCost('{X}{R}').x, 1);
  assert.deepEqual(parseCost('{G/W}').pips[0].any, ['G', 'W']);
  assert.ok(parseCost('{B/P}').pips[0].phyrexian);
});

test('CR 305.6 / 106: opciones de maná de tierras y artefactos', () => {
  assert.deepEqual(manaOptions(forest), [['G']]);
  assert.deepEqual(manaOptions(solRing), [['C', 'C']]);
  assert.deepEqual(
    manaOptions({ name: 'Overgrown Tomb', typeLine: 'Land — Swamp Forest', oracle: '({T}: Add {B} or {G}.)' }),
    [['B'], ['G']]
  );
  assert.deepEqual(
    manaOptions({ name: 'Command Tower', typeLine: 'Land', oracle: "{T}: Add one mana of any color in your commander's color identity." }, ['B', 'G']),
    [['B'], ['G']]
  );
});

test('CR 601.2h: el pago respeta colores; Sol Ring paga 2 genéricos', () => {
  const p = { battlefield: [] };
  p.battlefield = [forest, forest, solRing].map((i) => ({ ...i, tapped: false }));
  const ok = planPayment(manaSources(p), [], parseCost('{2}{G}{G}'));
  assert.ok(ok.ok);
  p.battlefield = [forest, island, solRing].map((i) => ({ ...i, tapped: false }));
  assert.equal(planPayment(manaSources(p), [], parseCost('{2}{G}{G}')).ok, false);
  // pirexiano: se puede pagar con 2 vidas
  assert.ok(planPayment([], [], parseCost('{G/P}'), { life: 20 }).ok);
});

// ---------- Inicio y turnos ----------

test('CR 903.7 / 103.4: 40 de vida, 7 cartas y comandante en zona de mando', () => {
  const g = newGame(4);
  for (const p of g.players) {
    assert.equal(p.life, 40);
    // CR 103.5 / 103.5c: mulligan de Londres, el primero gratis en multijugador
    assert.equal(p.hand.length, 7 - Math.max(0, p.mulligans - 1));
    assert.equal(p.command.length, 1);
    assert.equal(p.library.length + p.hand.length, 99);
  }
});

test('CR 103.8a: en duelo quien empieza no roba; CR 103.8c: en multijugador sí roba', async () => {
  const duel = newGame(2);
  await E.beginTurn(duel, io);
  assert.equal(duel.players[0].hand.length, 7);
  const pod = newGame(4);
  await E.beginTurn(pod, io);
  assert.equal(pod.players[0].hand.length, 8);
});

test('CR 305.2: una tierra por turno y solo en fase principal', async () => {
  const g = newGame();
  await E.beginTurn(g, io);
  const p = g.players[0];
  const lands = [put(g, p, forest, 'hand'), put(g, p, forest, 'hand')];
  assert.ok(E.playLand(g, p, lands[0]).ok);
  assert.equal(E.playLand(g, p, lands[1]).ok, false);
  const other = g.players[1];
  const l = put(g, other, forest, 'hand');
  assert.equal(E.playLand(g, other, l).ok, false); // no es su turno
});

test('CR 307.1: criaturas a velocidad de conjuro; instantáneos en cualquier momento', () => {
  const g = newGame();
  g.step = 'main1';
  const opp = g.players[1];
  const bear = put(g, opp, creature('Bear', '{1}{G}', 2, 2), 'hand');
  const instant = put(g, opp, bolt, 'hand');
  assert.match(E.castBlockReason(g, opp, bear), /307\.1/);
  assert.equal(E.castBlockReason(g, opp, instant), null);
});

test('CR 903.8: impuesto de comandante +2 por cada lanzamiento previo', async () => {
  const g = newGame();
  g.step = 'main1';
  const p = g.players[0];
  for (let i = 0; i < 8; i++) put(g, p, forest);
  const cmdr = p.command[0];
  assert.ok((await E.castSpell(g, p, cmdr, io)).ok);
  E.moveCard(g, cmdr, 'graveyard');
  E.runSBA(g); // CR 903.9a
  assert.ok(p.command.includes(cmdr));
  assert.equal(E.commanderCost(p, cmdr), 5);
});

// ---------- Pila ----------

test('CR 405 / 701.6: la IA contrarresta un hechizo amenazante', async () => {
  const g = newGame();
  g.step = 'main1';
  const [a, b] = g.players;
  for (let i = 0; i < 7; i++) put(g, a, forest);
  put(g, b, island);
  put(g, b, island);
  put(g, b, counterspell, 'hand');
  const big = put(g, a, creature('Big Thing', '{5}{G}', 6, 6), 'hand');
  const res = await E.castSpell(g, a, big, io);
  assert.ok(res.countered);
  assert.ok(a.graveyard.includes(big));
});

// ---------- Combate ----------

async function fight(g, attackerInfo, blockerInfos, defenderLife = 40) {
  g.step = 'main1';
  const [a, d] = g.players;
  d.life = defenderLife;
  const atk = put(g, a, attackerInfo);
  const blockers = blockerInfos.map((b) => put(g, d, b));
  const forced = { ...io, chooseBlocks: async () => new Map(blockers.length ? [[atk, blockers]] : []) };
  d.isAI = false;
  await E.runCombat(g, a, [{ attacker: atk, defender: d }], forced);
  return { atk, blockers, a, d };
}

test('CR 702.7 / 510.4: first strike mata al bloqueador antes de que dañe', async () => {
  const { atk, blockers, a } = await fight(newGame(), creature('Knight', '{2}', 2, 2, ['First strike']), [creature('Bear', '{2}', 2, 2)]);
  assert.ok(a.battlefield.includes(atk));
  assert.equal(blockers[0].damage, 0); // ya está en el cementerio (daño se limpia)
});

test('CR 702.4: double strike golpea dos veces al jugador', async () => {
  const { d } = await fight(newGame(), creature('Duelist', '{2}', 3, 3, ['Double strike']), []);
  assert.equal(d.life, 34);
});

test('CR 702.111b: menace no puede ser bloqueada por una sola criatura', async () => {
  const { d } = await fight(newGame(), creature('Thug', '{2}', 3, 3, ['Menace']), [creature('Wall', '{2}', 0, 5)]);
  assert.equal(d.life, 37);
});

test('CR 702.19 + 702.2c: arrollar con toque mortal asigna 1 y el resto al jugador', async () => {
  const { d } = await fight(newGame(), creature('Wurm', '{4}', 6, 6, ['Trample', 'Deathtouch']), [creature('Wall', '{2}', 0, 5)]);
  assert.equal(d.life, 35);
});

test('CR 702.15: lifelink gana vida al hacer daño', async () => {
  const { a } = await fight(newGame(), creature('Vampire', '{2}', 3, 3, ['Lifelink']), []);
  assert.equal(a.life, 43);
});

test('CR 702.9b: una criatura sin vuelo/alcance no puede bloquear a una voladora', () => {
  const g = newGame();
  const flyer = put(g, g.players[0], creature('Bird', '{1}', 1, 1, ['Flying']));
  const bear = put(g, g.players[1], creature('Bear', '{2}', 2, 2));
  const spider = put(g, g.players[1], creature('Spider', '{2}', 1, 3, ['Reach']));
  assert.equal(E.canBlock(g, bear, flyer), false);
  assert.equal(E.canBlock(g, spider, flyer), true);
});

test('CR 704.6c / 903.10a: 21 de daño de combate del mismo comandante elimina', async () => {
  const g = newGame(3);
  const [a, d] = g.players;
  const cmdr = a.command[0];
  a.command = [];
  cmdr.sick = false;
  cmdr.power = '7';
  a.battlefield.push(cmdr);
  for (let i = 0; i < 3; i++) {
    cmdr.tapped = false;
    g.step = 'main1';
    await E.runCombat(g, a, [{ attacker: cmdr, defender: d }], io);
  }
  assert.equal(d.alive, false);
  assert.equal(d.life, 19); // perdió por daño de comandante, no por vida
});

test('CR 302.6: una criatura recién llegada no puede atacar (salvo prisa)', () => {
  const g = newGame();
  const p = g.players[0];
  const fresh = put(g, p, creature('Bear', '{2}', 2, 2));
  fresh.sick = true;
  const hasty = put(g, p, creature('Goblin', '{1}', 1, 1, ['Haste']));
  hasty.sick = true;
  assert.equal(E.canAttack(g, fresh), false);
  assert.equal(E.canAttack(g, hasty), true);
});

// ---------- Acciones basadas en estado ----------

test('CR 704.5j: regla de leyenda', () => {
  const g = newGame();
  const p = g.players[0];
  const legend = creature('Toski', '{1}{G}', 1, 1, [], '', 'Legendary Creature — Squirrel');
  put(g, p, legend);
  put(g, p, legend);
  E.runSBA(g);
  assert.equal(p.battlefield.filter((c) => c.name === 'Toski').length, 1);
});

test('CR 704.5f: resistencia 0 va al cementerio aunque sea indestructible', () => {
  const g = newGame();
  const p = g.players[0];
  const c = put(g, p, creature('Golem', '{2}', 2, 2, ['Indestructible']));
  c.counters.m1 = 2;
  E.runSBA(g);
  assert.ok(!p.battlefield.includes(c));
});

test('CR 704.5c: 10 contadores de veneno eliminan', () => {
  const g = newGame(3);
  g.players[1].poison = 10;
  E.runSBA(g);
  assert.equal(g.players[1].alive, false);
});

test('CR 800.4a: los permanentes de un jugador eliminado dejan la partida', () => {
  const g = newGame(3);
  const p = g.players[1];
  put(g, p, creature('Bear', '{2}', 2, 2));
  p.life = 0;
  E.runSBA(g);
  assert.equal(p.battlefield.length, 0);
});

// ---------- Disparadores y reemplazos ----------

test('CR 603: Zulaport Cutthroat drena cuando muere una criatura propia', async () => {
  const g = newGame(3);
  const [a, b, c] = g.players;
  put(g, a, creature('Zulaport Cutthroat', '{1}{B}', 1, 1, [], 'Whenever Zulaport Cutthroat or another creature you control dies, each opponent loses 1 life and you gain 1 life.'));
  const bear = put(g, a, creature('Bear', '{2}', 2, 2));
  E.moveCard(g, bear, 'graveyard');
  await E.flushTriggers(g, io);
  assert.equal(b.life, 39);
  assert.equal(c.life, 39);
  assert.equal(a.life, 41);
  // una criatura del oponente no lo dispara
  const oppBear = put(g, b, creature('Bear', '{2}', 2, 2));
  E.moveCard(g, oppBear, 'graveyard');
  await E.flushTriggers(g, io);
  assert.equal(c.life, 39);
});

test('CR 614: Chatterfang agrega ardillas al crear tokens', () => {
  const g = newGame();
  const p = g.players[0];
  put(g, p, creature('Chatterfang, Squirrel General', '{2}{G}', 3, 3, ['Forestwalk'],
    'Forestwalk\nIf one or more tokens would be created under your control, those tokens plus that many 1/1 green Squirrel creature tokens are created instead.'));
  E.resolveText(g, p, 'Create two 1/1 green Elf Warrior creature tokens.');
  assert.equal(p.battlefield.filter((c) => c.isToken).length, 4);
});

test('CR 613: los "lords" suben la fuerza de su tipo', () => {
  const g = newGame();
  const p = g.players[0];
  put(g, p, creature('Goblin Chieftain', '{1}{R}{R}', 2, 2, ['Haste'], 'Haste\nOther Goblin creatures you control get +1/+1 and have haste.', 'Creature — Goblin'));
  const gob = put(g, p, creature('Goblin Guide', '{R}', 2, 2, [], '', 'Creature — Goblin Scout'));
  const bear = put(g, p, creature('Bear', '{2}', 2, 2));
  assert.equal(E.power(g, gob), 3);
  assert.equal(E.power(g, bear), 2);
});

test('CR 514.1: en la limpieza se descarta hasta 7', async () => {
  const g = newGame();
  const p = g.players[0];
  g.step = 'main2';
  for (let i = 0; i < 4; i++) put(g, p, forest, 'hand');
  await E.endTurn(g, io);
  assert.equal(p.hand.length, 7);
  assert.equal(g.active, 1);
});

// ---------- Partida completa ----------

test('una partida de 4 IAs termina con un ganador', async () => {
  const g = E.createGame(['A', 'B', 'C', 'D'].map((n) => ({ name: n, isAI: true, entries: deck(`Cmdr ${n}`) })));
  let guard = 0;
  while (g.winner == null && g.turn <= 80 && guard++ < 1000) await E.aiTurn(g, io);
  assert.notEqual(g.winner, null, `sin ganador tras ${g.turn} turnos`);
  assert.equal(g.players.filter((p) => p.alive).length, 1);
});
