import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/lib/engine.js';
import { parseCost, planPayment, manaOptions, manaSources } from '../public/lib/mana.js';
import { GameSession } from '../public/lib/session.js';

// ---------- Fixtures ----------

const forest = { name: 'Forest', typeLine: 'Basic Land — Forest', cmc: 0, manaCost: '', oracle: '({T}: Add {G}.)', keywords: [], colorIdentity: ['G'] };
const island = { name: 'Island', typeLine: 'Basic Land — Island', cmc: 0, manaCost: '', oracle: '({T}: Add {U}.)', keywords: [], colorIdentity: ['U'] };
const solRing = { name: 'Sol Ring', typeLine: 'Artifact', cmc: 1, manaCost: '{1}', oracle: '{T}: Add {C}{C}.', keywords: [], colorIdentity: [] };
const creature = (name, cost, p, t, keywords = [], oracle = '', typeLine = 'Creature — Bear') => ({
  name, typeLine, cmc: parseCost(cost).generic + parseCost(cost).pips.length, manaCost: cost, oracle, keywords, power: String(p), toughness: String(t), colorIdentity: ['G'],
});
const spell = (name, cost, typeLine, oracle) => ({ name, typeLine, cmc: parseCost(cost).generic + parseCost(cost).pips.length, manaCost: cost, oracle, keywords: [] });
const counterspell = spell('Counterspell', '{U}{U}', 'Instant', 'Counter target spell.');
const murder = spell('Murder', '{1}{G}', 'Instant', 'Destroy target creature.');
const divination = spell('Divination', '{2}{G}', 'Sorcery', 'Draw two cards.');

function deck(cmdrName = 'Cmdr') {
  return [
    { info: creature(cmdrName, '{2}{G}', 3, 3, [], '', 'Legendary Creature — Squirrel'), qty: 1, board: 'commander' },
    { info: forest, qty: 40, board: 'main' },
    { info: creature('Grizzly Bears', '{1}{G}', 2, 2), qty: 30, board: 'main' },
    { info: creature('Hill Giant', '{3}{G}', 3, 3), qty: 20, board: 'main' },
    { info: divination, qty: 9, board: 'main' },
  ];
}

/** io de pruebas: los humanos pasan prioridad y aceptan respuestas por defecto (configurable). */
function makeIO(answers = {}) {
  return {
    step: async () => {},
    decide: async (p, req) => {
      const a = answers[req.kind];
      if (typeof a === 'function') return a(p, req);
      if (a !== undefined) return a;
      if (req.kind === 'priority') return { type: 'pass' };
      if (req.kind === 'mulligan') return 'keep';
      if (req.kind === 'target') return req.targets[0];
      if (req.kind === 'payUnless') return false;
      return [];
    },
  };
}
const io = makeIO();

/** Partida de prueba: todos humanos (controlados por io) salvo que se indique. */
function newGame(n = 2, { ai = [] } = {}) {
  const g = E.createGame(Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isAI: ai.includes(i), entries: deck(`Cmdr ${i}`) })));
  g.active = 0;
  g.firstPlayer = 0;
  g.step = 'main1';
  return g;
}

function put(g, p, info, zone = 'battlefield') {
  const c = E.makeCard(info, p.idx);
  c.sick = false;
  p[zone].push(c);
  return c;
}

async function castAndResolve(g, p, card, ioX = io, opts = {}) {
  const res = await E.castSpell(g, p, card, ioX, opts);
  if (res.ok) await E.priorityLoop(g, ioX);
  return res;
}

// ---------- Maná ----------

test('CR 107.4 / 202: parseCost lee genérico, color, híbrido, pirexiano y X', () => {
  assert.deepEqual(parseCost('{2}{G}{G}'), { generic: 2, pips: [{ any: ['G'] }, { any: ['G'] }], x: 0 });
  assert.equal(parseCost('{X}{R}').x, 1);
  assert.deepEqual(parseCost('{G/W}').pips[0].any, ['G', 'W']);
  assert.ok(parseCost('{B/P}').pips[0].phyrexian);
});

test('CR 305.6 / 106: opciones de maná de tierras, artefactos y Treasure', () => {
  assert.deepEqual(manaOptions(forest), [['G']]);
  assert.deepEqual(manaOptions(solRing), [['C', 'C']]);
  assert.deepEqual(manaOptions({ name: 'Overgrown Tomb', typeLine: 'Land — Swamp Forest', oracle: '({T}: Add {B} or {G}.)' }), [['B'], ['G']]);
  assert.deepEqual(
    manaOptions({ name: 'Command Tower', typeLine: 'Land', oracle: "{T}: Add one mana of any color in your commander's color identity." }, ['B', 'G']),
    [['B'], ['G']]
  );
  assert.deepEqual(manaOptions({ name: 'Treasure', typeLine: 'Token Artifact — Treasure', oracle: '{T}, Sacrifice this token: Add one mana of any color.' }), [['*']]);
});

test('CR 601.2h: el pago respeta colores; Sol Ring paga 2 genéricos', () => {
  const p = { battlefield: [forest, forest, solRing].map((i) => ({ ...i, tapped: false })) };
  assert.ok(planPayment(manaSources(p), [], parseCost('{2}{G}{G}')).ok);
  p.battlefield = [forest, island, solRing].map((i) => ({ ...i, tapped: false }));
  assert.equal(planPayment(manaSources(p), [], parseCost('{2}{G}{G}')).ok, false);
  assert.ok(planPayment([], [], parseCost('{G/P}'), { life: 20 }).ok);
});

// ---------- Inicio y turnos ----------

test('CR 903.7 / 103.4: 40 de vida, 7 cartas y comandante en zona de mando', () => {
  const g = newGame(4);
  for (const p of g.players) {
    assert.equal(p.life, 40);
    assert.equal(p.hand.length, 7);
    assert.equal(p.command.length, 1);
  }
});

test('CR 103.5: mulligan de Londres con el primero gratis en multijugador (103.5c)', async () => {
  const g = newGame(4);
  let asked = 0;
  const mullOnce = makeIO({ mulligan: () => (asked++ === 0 ? 'mulligan' : 'keep') });
  // Solo P0 hace mulligan una vez; el resto se queda
  await E.pregame(g, { ...mullOnce, decide: (p, req) => (p.idx === 0 ? mullOnce.decide(p, req) : io.decide(p, req)) });
  assert.equal(g.players[0].mulligans, 1);
  assert.equal(g.players[0].hand.length, 7); // gratis en multijugador
  const duel = newGame(2);
  let k = 0;
  await E.pregame(duel, makeIO({ mulligan: (p) => (p.idx === 0 && k++ === 0 ? 'mulligan' : 'keep') }));
  assert.equal(duel.players[0].hand.length, 6); // en duelo pone 1 al fondo
});

test('CR 103.8a: en duelo quien empieza no roba; CR 103.8c: en multijugador sí roba', async () => {
  const duel = newGame(2);
  const before = duel.players[0].hand.length;
  await E.takeTurn(duel, io);
  assert.equal(duel.players[0].hand.length, before);
  const pod = newGame(4);
  const before4 = pod.players[0].hand.length;
  let atDraw = null;
  await E.takeTurn(pod, { ...io, step: async (label) => { if (label === 'DRAW') atDraw = pod.players[0].hand.length; } });
  assert.equal(atDraw, before4 + 1); // (después la limpieza descarta a 7)
});

test('CR 500: un turno completo recorre todos los pasos y pasa al siguiente jugador', async () => {
  const g = newGame(3);
  const steps = [];
  const spy = { ...io, step: async () => steps.push(g.step) };
  await E.takeTurn(g, spy);
  assert.ok(steps.includes('upkeep') && steps.includes('draw') && steps.includes('end'));
  assert.equal(g.active, 1);
  assert.equal(g.step, 'untap');
});

test('CR 305.2: una tierra por turno y solo en fase principal', () => {
  const g = newGame();
  const p = g.players[0];
  const lands = [put(g, p, forest, 'hand'), put(g, p, forest, 'hand')];
  assert.ok(E.playLand(g, p, lands[0]).ok);
  assert.equal(E.playLand(g, p, lands[1]).ok, false);
  const l = put(g, g.players[1], forest, 'hand');
  assert.equal(E.playLand(g, g.players[1], l).ok, false);
});

test('CR 307.1: criaturas a velocidad de conjuro; instantáneos en cualquier momento', () => {
  const g = newGame();
  const opp = g.players[1];
  assert.match(E.castBlockReason(g, opp, put(g, opp, creature('Bear', '{1}{G}', 2, 2), 'hand')), /307\.1/);
  assert.equal(E.castBlockReason(g, opp, put(g, opp, murder, 'hand')), null);
});

test('CR 903.8: impuesto de comandante +2 por cada lanzamiento previo', async () => {
  const g = newGame();
  const p = g.players[0];
  for (let i = 0; i < 8; i++) put(g, p, forest);
  const cmdr = p.command[0];
  assert.ok((await castAndResolve(g, p, cmdr)).ok);
  assert.ok(p.battlefield.includes(cmdr));
  E.moveCard(g, cmdr, 'graveyard');
  E.runSBA(g); // CR 903.9a
  assert.ok(p.command.includes(cmdr));
  assert.equal(E.commanderCost(p, cmdr), 5);
});

// ---------- Costes y avisos automáticos ----------

const thalia = creature('Thalia, Guardian of Thraben', '{1}{W}', 2, 1, ['First strike'], 'First strike\nNoncreature spells cost {1} more to cast.', 'Legendary Creature — Human Soldier');
const rhystic = spell('Rhystic Study', '{2}{U}', 'Enchantment', 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.');
const sentinel = creature('Esper Sentinel', '{W}', 1, 1, [], "Whenever an opponent casts their first noncreature spell each turn, draw a card unless that player pays {X}, where X is Esper Sentinel's power.", 'Artifact Creature — Human Soldier');

test('CR 601.2f: Thalia hace que los hechizos no criatura cuesten {1} más (y avisa)', () => {
  const g = newGame();
  const [a, b] = g.players;
  put(g, b, thalia);
  const div = put(g, a, divination, 'hand');
  const bear = put(g, a, creature('Bear', '{1}{G}', 2, 2), 'hand');
  assert.equal(E.costOf(g, a, div).generic, 3);
  assert.equal(E.costOf(g, a, bear).generic, 1);
  for (let i = 0; i < 3; i++) put(g, a, forest);
  assert.equal(E.canPay(g, a, div), false); // necesita 4
  assert.ok(E.activeEffects(g, a).some((e) => /Thalia.*\{1\} más/.test(e.text)));
});

test('CR 603.2: Rhystic Study — si no pagas {1}, el rival roba', async () => {
  const g = newGame();
  const [a, b] = g.players;
  put(g, b, rhystic);
  for (let i = 0; i < 5; i++) put(g, a, forest);
  const handB = b.hand.length;
  await castAndResolve(g, a, put(g, a, divination, 'hand'), makeIO({ payUnless: false }));
  assert.equal(b.hand.length, handB + 1);
  // Esta vez sí paga
  g.players[0].castsThisTurn = [];
  for (const c of a.battlefield) c.tapped = false;
  const handB2 = b.hand.length;
  await castAndResolve(g, a, put(g, a, divination, 'hand'), makeIO({ payUnless: true }));
  assert.equal(b.hand.length, handB2);
  assert.equal(a.battlefield.filter((c) => c.tapped).length, 4); // 3 del hechizo + 1 del impuesto
});

test('Esper Sentinel solo se dispara con el primer hechizo no criatura del turno', async () => {
  const g = newGame();
  const [a, b] = g.players;
  put(g, b, sentinel);
  for (let i = 0; i < 9; i++) put(g, a, forest);
  const start = b.hand.length;
  await castAndResolve(g, a, put(g, a, divination, 'hand'));
  await castAndResolve(g, a, put(g, a, divination, 'hand'));
  assert.equal(b.hand.length, start + 1);
});

test('CR 101.2: Rule of Law impide un segundo hechizo en el turno', async () => {
  const g = newGame();
  const [a] = g.players;
  put(g, g.players[1], spell('Rule of Law', '{2}{W}', 'Enchantment', "Each player can't cast more than one spell each turn."));
  for (let i = 0; i < 9; i++) put(g, a, forest);
  assert.ok((await castAndResolve(g, a, put(g, a, divination, 'hand'))).ok);
  const second = await E.castSpell(g, a, put(g, a, divination, 'hand'), io);
  assert.equal(second.ok, false);
  assert.match(second.reason, /un hechizo por turno/);
});

// ---------- Pila y prioridad ----------

test('CR 405 / 117: la IA contrarresta un hechizo amenazante durante la ronda de prioridad', async () => {
  const g = newGame(2, { ai: [1] });
  const [a, b] = g.players;
  for (let i = 0; i < 7; i++) put(g, a, forest);
  put(g, b, island);
  put(g, b, island);
  put(g, b, counterspell, 'hand');
  const big = put(g, a, creature('Big Thing', '{5}{G}', 6, 6), 'hand');
  await castAndResolve(g, a, big);
  assert.ok(a.graveyard.includes(big));
  assert.equal(g.stack.length, 0);
});

test('CR 608.2b: un hechizo cuyo objetivo desaparece no se resuelve', async () => {
  const g = newGame();
  const [a, b] = g.players;
  for (let i = 0; i < 2; i++) put(g, a, forest);
  const bear = put(g, b, creature('Bear', '{1}{G}', 2, 2));
  const m = put(g, a, murder, 'hand');
  const res = await E.castSpell(g, a, m, io, { target: { type: 'card', iid: bear.iid } });
  assert.ok(res.ok);
  E.moveCard(g, bear, 'exile'); // el objetivo se va antes de resolver
  await E.priorityLoop(g, io);
  assert.ok(a.graveyard.includes(m));
  assert.ok(g.log.some((l) => /608\.2b/.test(l.msg)));
});

test('CR 702.11b: hexproof impide ser objetivo de oponentes', () => {
  const g = newGame();
  const [a, b] = g.players;
  const hexy = put(g, b, creature('Troll', '{2}', 2, 2, ['Hexproof']));
  const targets = E.legalTargets(g, a, E.targetSpec(murder));
  assert.ok(!targets.some((t) => t.iid === hexy.iid));
  assert.ok(E.legalTargets(g, b, E.targetSpec(murder)).some((t) => t.iid === hexy.iid));
});

test('Treasure: se sacrifica al usarlo para pagar', async () => {
  const g = newGame();
  const a = g.players[0];
  E.resolveText(g, a, 'Create a Treasure token.');
  put(g, a, forest);
  put(g, a, forest);
  assert.ok((await castAndResolve(g, a, put(g, a, divination, 'hand'))).ok);
  assert.equal(a.battlefield.filter((c) => c.name === 'Treasure').length, 0);
});

test('"Whenever you cast": Talrand crea un Drake al lanzar un instantáneo', async () => {
  const g = newGame();
  const a = g.players[0];
  put(g, a, creature('Talrand, Sky Summoner', '{2}{U}{U}', 2, 2, [], 'Whenever you cast an instant or sorcery spell, create a 2/2 blue Drake creature token with flying.', 'Legendary Creature — Merfolk Wizard'));
  for (let i = 0; i < 3; i++) put(g, a, forest);
  await castAndResolve(g, a, put(g, a, divination, 'hand'));
  const drake = a.battlefield.find((c) => c.isToken);
  assert.ok(drake && E.has(drake, 'flying'));
});

// ---------- Combate ----------

async function fight(attackerInfo, blockerInfos, { life = 40 } = {}) {
  const g = newGame();
  const [a, d] = g.players;
  d.life = life;
  const atk = put(g, a, attackerInfo);
  const blockers = blockerInfos.map((b) => put(g, d, b));
  const cio = makeIO({
    attackers: [{ attacker: atk.iid, defender: d.idx }],
    blockers: blockers.length ? [{ attacker: atk.iid, blockers: blockers.map((b) => b.iid) }] : [],
  });
  await E.combatPhase(g, a, cio);
  return { g, atk, blockers, a, d };
}

test('CR 702.7 / 510.4: first strike mata al bloqueador antes de que dañe', async () => {
  const { atk, blockers, a, d } = await fight(creature('Knight', '{2}', 2, 2, ['First strike']), [creature('Bear', '{2}', 2, 2)]);
  assert.ok(a.battlefield.includes(atk));
  assert.ok(!d.battlefield.includes(blockers[0]));
});

test('CR 702.4: double strike golpea dos veces al jugador', async () => {
  const { d } = await fight(creature('Duelist', '{2}', 3, 3, ['Double strike']), []);
  assert.equal(d.life, 34);
});

test('CR 702.111b: menace no puede ser bloqueada por una sola criatura', async () => {
  const { d } = await fight(creature('Thug', '{2}', 3, 3, ['Menace']), [creature('Wall', '{2}', 0, 5)]);
  assert.equal(d.life, 37);
});

test('CR 702.19 + 702.2c: arrollar con toque mortal asigna 1 y el resto al jugador', async () => {
  const { d } = await fight(creature('Wurm', '{4}', 6, 6, ['Trample', 'Deathtouch']), [creature('Wall', '{2}', 0, 5)]);
  assert.equal(d.life, 35);
});

test('CR 702.15: lifelink gana vida al hacer daño', async () => {
  const { a } = await fight(creature('Vampire', '{2}', 3, 3, ['Lifelink']), []);
  assert.equal(a.life, 43);
});

test('CR 702.9b: una criatura sin vuelo/alcance no puede bloquear a una voladora', () => {
  const g = newGame();
  const flyer = put(g, g.players[0], creature('Bird', '{1}', 1, 1, ['Flying']));
  assert.equal(E.canBlock(g, put(g, g.players[1], creature('Bear', '{2}', 2, 2)), flyer), false);
  assert.equal(E.canBlock(g, put(g, g.players[1], creature('Spider', '{2}', 1, 3, ['Reach'])), flyer), true);
});

test('CR 508.8: sin atacantes se saltan bloqueos y daño', async () => {
  const g = newGame();
  put(g, g.players[0], creature('Bear', '{2}', 2, 2));
  const steps = [];
  await E.combatPhase(g, g.players[0], { ...makeIO({ attackers: [] }), step: async () => steps.push(g.step) });
  assert.ok(!steps.includes('combatDamage'));
  assert.equal(g.players[1].life, 40);
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
    await E.combatPhase(g, a, makeIO({ attackers: [{ attacker: cmdr.iid, defender: d.idx }] }));
  }
  assert.equal(d.alive, false);
  assert.equal(d.life, 19);
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
  const c = put(g, g.players[0], creature('Golem', '{2}', 2, 2, ['Indestructible']));
  c.counters.m1 = 2;
  E.runSBA(g);
  assert.ok(!g.players[0].battlefield.includes(c));
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
  E.moveCard(g, put(g, a, creature('Bear', '{2}', 2, 2)), 'graveyard');
  await E.flushTriggers(g, io);
  assert.equal(b.life, 39);
  assert.equal(c.life, 39);
  assert.equal(a.life, 41);
  E.moveCard(g, put(g, b, creature('Bear', '{2}', 2, 2)), 'graveyard');
  await E.flushTriggers(g, io);
  assert.equal(c.life, 39);
});

test('Smothering Tithe: si no pagas {2} al robar, el dueño crea un Treasure', async () => {
  const g = newGame();
  const [a, b] = g.players;
  put(g, b, spell('Smothering Tithe', '{3}{W}', 'Enchantment', "Whenever an opponent draws a card, that player may pay {2}. If the player doesn't, you create a Treasure token."));
  E.draw(g, a, 1);
  await E.flushTriggers(g, makeIO({ payUnless: false }));
  assert.equal(b.battlefield.filter((c) => c.name === 'Treasure').length, 1);
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

test('CR 514.1: en la limpieza el humano elige qué descartar hasta 7', async () => {
  const g = newGame();
  const p = g.players[0];
  for (let i = 0; i < 4; i++) put(g, p, forest, 'hand');
  const chosen = p.hand.slice(0, 4).map((c) => c.iid);
  await E.takeTurn(g, makeIO({ discard: chosen }));
  assert.equal(p.hand.length, 7);
  assert.ok(chosen.every((id) => p.graveyard.some((c) => c.iid === id)));
});

// ---------- Partida completa ----------

test('una partida de 4 IAs (sesión completa) termina con un ganador', async () => {
  const s = new GameSession(['A', 'B', 'C', 'D'].map((n) => ({ name: n, isAI: true, entries: deck(`Cmdr ${n}`) })), { speed: 'x' });
  s.step = async () => {};
  s.io.step = async () => {};
  await s.run();
  assert.notEqual(s.game.winner, null, `sin ganador tras ${s.game.turn} turnos (${s.error || ''})`);
  assert.equal(s.game.players.filter((p) => p.alive).length, 1);
});

test('la vista de un jugador oculta las manos rivales', () => {
  const s = new GameSession(['A', 'B'].map((n) => ({ name: n, isAI: n === 'B', entries: deck(n) })));
  const v = s.view(0);
  assert.ok(Array.isArray(v.players[0].hand));
  assert.equal(v.players[1].hand, null);
  assert.equal(v.players[1].handCount, 7);
});

// ---------- Análisis de la partida ----------

import { matchAnalysis } from '../public/lib/analysis.js';

test('el análisis registra daño, hechizos, MVP e historial de vida', async () => {
  const g = newGame();
  const [a, d] = g.players;
  for (let i = 0; i < 3; i++) put(g, a, forest);
  await castAndResolve(g, a, put(g, a, divination, 'hand'));
  const atk = put(g, a, creature('Wurm', '{4}', 6, 6));
  await E.combatPhase(g, a, makeIO({ attackers: [{ attacker: atk.iid, defender: d.idx }] }));
  await E.takeTurn(g, io);
  const an = matchAnalysis(g);
  const pa = an.players[0];
  assert.equal(pa.spells, 1);
  assert.equal(pa.manaSpent, 3);
  assert.equal(pa.combatDamage, 6);
  assert.deepEqual(pa.mvp, { name: 'Wurm', damage: 6 });
  assert.ok(an.lifeHistory.length >= 2);
  assert.ok(an.insights.some((t) => /más daño/.test(t)));
});

// ---------- Planeswalkers (CR 306, 606, 506.3, 120.3c) ----------

const garruk = {
  name: 'Garruk, Primal Hunter', typeLine: 'Legendary Planeswalker — Garruk', cmc: 5, manaCost: '{2}{G}{G}{G}', loyalty: '3', keywords: [],
  oracle: '+1: Create a 3/3 green Beast creature token.\n−3: Draw cards equal to the greatest power among creatures you control.\n−6: Create a 6/6 green Wurm creature token for each land you control.',
};
const liliana = {
  name: 'Liliana, Death Wielder', typeLine: 'Legendary Planeswalker — Liliana', cmc: 5, manaCost: '{3}{B}{B}', loyalty: '5', keywords: [],
  oracle: '+2: Put a -1/-1 counter on up to one target creature.\n−3: Destroy target creature.\n−10: Return all creature cards from your graveyard to the battlefield.',
};

function putPW(g, p, info) {
  const c = put(g, p, info);
  c.counters.loyalty = +info.loyalty;
  return c;
}

test('CR 606: +1 de Garruk crea una Bestia 3/3 y sube la lealtad; solo una vez por turno', async () => {
  const g = newGame();
  const a = g.players[0];
  const w = putPW(g, a, garruk);
  const abs = E.activatedAbilities(g, a, w);
  assert.equal(abs.length, 3);
  assert.equal(abs[0].loyalty, 1);
  assert.ok((await E.activateAbility(g, a, w, 0, io)).ok);
  await E.priorityLoop(g, io);
  assert.equal(w.counters.loyalty, 4);
  assert.ok(a.battlefield.some((c) => c.isToken && c.name.includes('Beast')));
  const again = await E.activateAbility(g, a, w, 0, io);
  assert.equal(again.ok, false);
  assert.match(again.reason, /606\.3/);
});

test('CR 606.6: no se puede activar un "−" sin lealtad suficiente; CR 606.3 solo a velocidad de conjuro', () => {
  const g = newGame();
  const [a, b] = g.players;
  const w = putPW(g, a, garruk);
  assert.match(E.activatedAbilities(g, a, w)[2].reason, /606\.6/);
  const theirs = putPW(g, b, garruk);
  assert.match(E.activatedAbilities(g, b, theirs)[0].reason, /606\.3/); // no es su turno
});

test('−3 de Liliana destruye la criatura objetivo y Garruk −3 roba según la mayor fuerza', async () => {
  const g = newGame();
  const [a, b] = g.players;
  const lili = putPW(g, a, liliana);
  const bear = put(g, b, creature('Bear', '{2}', 2, 2));
  assert.ok((await E.activateAbility(g, a, lili, 1, io, { target: { type: 'card', iid: bear.iid } })).ok);
  await E.priorityLoop(g, io);
  assert.ok(!b.battlefield.includes(bear));
  assert.equal(lili.counters.loyalty, 2);
  const gk = putPW(g, a, garruk);
  gk.counters.loyalty = 3;
  put(g, a, creature('Big', '{5}', 5, 5));
  const hand = a.hand.length;
  await E.activateAbility(g, a, gk, 1, io);
  await E.priorityLoop(g, io);
  assert.equal(a.hand.length, hand + 5);
});

test('CR 506.3 / 120.3c: atacar a un planeswalker le quita lealtad, no vida al jugador', async () => {
  const g = newGame();
  const [a, d] = g.players;
  const w = putPW(g, d, garruk);
  const atk = put(g, a, creature('Ogre', '{3}', 2, 2));
  await E.combatPhase(g, a, makeIO({ attackers: [{ attacker: atk.iid, defender: d.idx, pw: w.iid }] }));
  assert.equal(w.counters.loyalty, 1);
  assert.equal(d.life, 40);
  const atk2 = put(g, a, creature('Ogre 2', '{3}', 2, 2));
  await E.combatPhase(g, a, makeIO({ attackers: [{ attacker: atk2.iid, defender: d.idx, pw: w.iid }] }));
  assert.ok(!d.battlefield.includes(w)); // CR 704.5i
});

// ---------- Generadores de tokens y habilidades activadas (CR 602) ----------

test('habilidad con coste de maná "{2}: Create…" paga y crea el token al resolverse', async () => {
  const g = newGame();
  const a = g.players[0];
  const maker = put(g, a, spell('Token Factory', '{3}', 'Artifact', '{2}: Create a 1/1 colorless Thopter artifact creature token with flying.'));
  put(g, a, forest);
  put(g, a, forest);
  assert.ok((await E.activateAbility(g, a, maker, 0, io)).ok);
  await E.priorityLoop(g, io);
  const t = a.battlefield.find((c) => c.isToken);
  assert.ok(t && E.has(t, 'flying'));
  assert.equal(a.battlefield.filter((c) => c.tapped).length, 2);
  assert.match(E.activatedAbilities(g, a, maker)[0].reason, /Maná/);
});

test('outlet de sacrificio: "Sacrifice a creature: deals 1 damage to any target"', async () => {
  const g = newGame();
  const [a, b] = g.players;
  const bomb = put(g, a, spell('Goblin Bombardment', '{1}{R}', 'Enchantment', 'Sacrifice a creature: Goblin Bombardment deals 1 damage to any target.'));
  const goblin = put(g, a, creature('Goblin', '{1}', 1, 1));
  const choose = makeIO({ target: (p, req) => (req.spec.type === 'sacrifice' ? { type: 'card', iid: goblin.iid } : { type: 'player', idx: b.idx }) });
  assert.ok((await E.activateAbility(g, a, bomb, 0, choose)).ok);
  await E.priorityLoop(g, choose);
  assert.ok(!a.battlefield.includes(goblin));
  assert.equal(b.life, 39);
});

test('Clue: "{2}, Sacrifice this token: Draw a card."', async () => {
  const g = newGame();
  const a = g.players[0];
  E.resolveText(g, a, 'Create a Clue token.');
  put(g, a, forest);
  put(g, a, forest);
  const clue = a.battlefield.find((c) => c.name === 'Clue');
  const hand = a.hand.length;
  assert.ok((await E.activateAbility(g, a, clue, 0, io)).ok);
  await E.priorityLoop(g, io);
  assert.equal(a.hand.length, hand + 1);
  assert.ok(!a.battlefield.includes(clue));
});

test('tokens "for each" y "equal to the number of"', () => {
  const g = newGame();
  const a = g.players[0];
  for (let i = 0; i < 3; i++) put(g, a, forest);
  E.resolveText(g, a, 'Create a 6/6 green Wurm creature token for each land you control.');
  assert.equal(a.battlefield.filter((c) => c.name.includes('Wurm')).length, 3);
  E.resolveText(g, a, 'Create a number of 1/1 green Saproling creature tokens equal to the number of lands you control.');
  assert.equal(a.battlefield.filter((c) => c.name.includes('Saproling')).length, 3);
  E.resolveText(g, a, 'Create an X/X green Hydra creature token.', { x: 4 });
  assert.ok(a.battlefield.some((c) => c.name === 'Hydra 4/4'));
});

test('"At the beginning of each upkeep" se dispara también en el turno rival', async () => {
  const g = newGame();
  const [a, b] = g.players;
  put(g, b, creature('Tendershoot Dryad', '{4}{G}', 2, 2, [], 'Ascend\nAt the beginning of each upkeep, create a 1/1 green Saproling creature token.'));
  await E.takeTurn(g, io); // turno de A
  assert.equal(b.battlefield.filter((c) => c.isToken).length, 1);
});

test('fetchland con el nuevo parser: paga 1 vida, se sacrifica y busca', async () => {
  const g = newGame();
  const a = g.players[0];
  const fetch = put(g, a, { name: 'Wooded Foothills', typeLine: 'Land', cmc: 0, manaCost: '', keywords: [], oracle: '{T}, Pay 1 life, Sacrifice Wooded Foothills: Search your library for a Mountain or Forest card, put it onto the battlefield, then shuffle.' });
  assert.ok((await E.activateAbility(g, a, fetch, 0, io)).ok);
  await E.priorityLoop(g, io);
  assert.equal(a.life, 39);
  assert.ok(!a.battlefield.includes(fetch));
  assert.ok(a.battlefield.some((c) => c.name === 'Forest'));
});

test('partida de 4 IAs con planeswalkers y generadores de tokens termina sin errores', async () => {
  const pwDeck = (n) => [...deck(`Cmdr ${n}`).map((e) => (e.info.name === 'Divination' ? { ...e, qty: 4 } : e)),
    { info: garruk, qty: 1, board: 'main' }, { info: liliana, qty: 1, board: 'main' },
    { info: spell('Token Factory', '{3}', 'Artifact', '{2}: Create a 1/1 colorless Thopter artifact creature token with flying.'), qty: 3, board: 'main' }];
  const s = new GameSession(['A', 'B', 'C', 'D'].map((n) => ({ name: n, isAI: true, entries: pwDeck(n) })));
  s.io.step = async () => {};
  await s.run();
  assert.equal(s.error, null);
  assert.notEqual(s.game.winner, null, `sin ganador tras ${s.game.turn} turnos`);
  assert.ok(s.game.log.some((l) => /Garruk|Liliana|Token Factory/.test(l.msg)), 'la IA debería usar planeswalkers o generadores');
});

test('CR 601.2c: un planeswalker con "−3: Destroy target creature" se puede lanzar sin objetivos en mesa', async () => {
  const g = newGame();
  const a = g.players[0];
  for (let i = 0; i < 5; i++) put(g, a, forest);
  const lili = put(g, a, { ...liliana, manaCost: '{5}' }, 'hand');
  assert.equal(E.castBlockReason(g, a, lili), null);
  assert.ok((await castAndResolve(g, a, lili)).ok);
  assert.ok(a.battlefield.includes(lili));
  assert.equal(lili.counters.loyalty, 5); // CR 306.5b: entra con su lealtad impresa
});

test('CR 603.3d: "When ~ enters, destroy target creature" elige objetivo al entrar', async () => {
  const g = newGame();
  const [a, b] = g.players;
  for (let i = 0; i < 4; i++) put(g, a, forest);
  const bear = put(g, b, creature('Bear', '{2}', 2, 2));
  const chupa = put(g, a, creature('Ravenous Chupacabra', '{4}', 2, 2, [], 'When Ravenous Chupacabra enters, destroy target creature an opponent controls.'), 'hand');
  await castAndResolve(g, a, chupa, makeIO({ target: { type: 'card', iid: bear.iid } }));
  assert.ok(!b.battlefield.includes(bear));
});
