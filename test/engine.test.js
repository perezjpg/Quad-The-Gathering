import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/lib/engine.js';

const land = (name = 'Forest') => ({ name, typeLine: 'Basic Land — Forest', cmc: 0, oracle: '({T}: Add {G}.)', keywords: [] });
const bear = (name, cmc = 2, p = 2, t = 2, keywords = []) => ({
  name, typeLine: 'Creature — Bear', cmc, oracle: '', keywords, power: String(p), toughness: String(t),
});

function deck(cmdr) {
  return [
    { info: { ...bear(cmdr, 3, 3, 3), typeLine: 'Legendary Creature — Squirrel' }, qty: 1, board: 'commander' },
    { info: land(), qty: 38, board: 'main' },
    { info: bear('Grizzly Bears'), qty: 30, board: 'main' },
    { info: bear('Hill Giant', 4, 3, 3), qty: 20, board: 'main' },
    { info: { name: 'Lightning Bolt', typeLine: 'Instant', cmc: 1, oracle: 'Lightning Bolt deals 3 damage to any target.', keywords: [] }, qty: 5, board: 'main' },
    { info: { name: 'Divination', typeLine: 'Sorcery', cmc: 3, oracle: 'Draw two cards.', keywords: [] }, qty: 6, board: 'main' },
  ];
}

test('createGame reparte 7 cartas y pone comandantes en la zona de mando', () => {
  const g = E.createGame([
    { name: 'A', isAI: true, entries: deck('Cmdr A') },
    { name: 'B', isAI: true, entries: deck('Cmdr B') },
  ]);
  for (const p of g.players) {
    assert.equal(p.hand.length, 7);
    assert.equal(p.command.length, 1);
    assert.equal(p.life, 40);
    assert.equal(p.library.length + p.hand.length, 99);
  }
});

test('resolveText: daño, robo y tokens', () => {
  const g = E.createGame([
    { name: 'A', isAI: true, entries: deck('X') },
    { name: 'B', isAI: true, entries: deck('Y') },
  ]);
  const [a, b] = g.players;
  const hand = a.hand.length;
  E.resolveText(g, a, 'Draw two cards.');
  assert.equal(a.hand.length, hand + 2);
  E.resolveText(g, a, 'Deals 3 damage to any target.');
  assert.equal(b.life, 37);
  E.resolveText(g, a, 'Create two 1/1 green Squirrel creature tokens.');
  assert.equal(a.battlefield.filter((c) => c.isToken).length, 2);
});

test('el comandante vuelve a la zona de mando y paga impuesto', () => {
  const g = E.createGame([
    { name: 'A', isAI: true, entries: deck('X') },
    { name: 'B', isAI: true, entries: deck('Y') },
  ]);
  const a = g.players[0];
  const cmdr = a.command[0];
  E.castCard(g, a, cmdr, { pay: false });
  assert.ok(a.battlefield.includes(cmdr));
  E.moveCard(g, cmdr, 'graveyard');
  assert.ok(a.command.includes(cmdr));
  assert.equal(E.commanderCost(a, cmdr), 5);
});

test('una partida de 4 IAs termina con un ganador', async () => {
  const g = E.createGame(['A', 'B', 'C', 'D'].map((n) => ({ name: n, isAI: true, entries: deck(`Cmdr ${n}`) })));
  let guard = 0;
  while (g.winner == null && g.turn <= 80 && guard++ < 1000) {
    await E.aiTurn(g, async () => {});
  }
  assert.notEqual(g.winner, null, `sin ganador tras ${g.turn} turnos`);
  const alive = g.players.filter((p) => p.alive);
  assert.equal(alive.length, 1);
});
