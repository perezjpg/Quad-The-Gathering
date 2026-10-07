import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeckText, cleanCardName } from '../public/lib/deckText.js';
import { detectSource, normalizeArchidekt, normalizeMoxfield, finalize } from '../src/sources.js';
import { DEMO_DECKS } from '../public/lib/demo.js';

test('cleanCardName quita set, foil, categorías y normaliza caras dobles', () => {
  assert.equal(cleanCardName('Sol Ring (CMM) 410 *F*'), 'Sol Ring');
  assert.equal(cleanCardName('Command Tower [Land]'), 'Command Tower');
  assert.equal(cleanCardName('Valakut Awakening / Valakut Stoneforge'), 'Valakut Awakening // Valakut Stoneforge');
});

test('parseDeckText reconoce secciones y cantidades', () => {
  const { cards, commanders } = parseDeckText(`Commander
1 Chatterfang, Squirrel General

Deck
1x Sol Ring (C21) 263
10 Forest
SB: 1 Swords to Plowshares
Maybeboard
1 Rhystic Study`);
  assert.deepEqual(commanders, ['Chatterfang, Squirrel General']);
  assert.equal(cards.find((c) => c.name === 'Forest').qty, 10);
  assert.equal(cards.find((c) => c.name === 'Swords to Plowshares').board, 'side');
  assert.equal(cards.find((c) => c.name === 'Rhystic Study').board, 'maybe');
});

test('parseDeckText detecta comandante en exports de Archidekt', () => {
  const { commanders } = parseDeckText('1x Krenko, Mob Boss (ddt) 52 [Commander{top}]\n1x Sol Ring (cmm) 410 [Ramp]');
  assert.deepEqual(commanders, ['Krenko, Mob Boss']);
});

test('heurística MTGGoldfish: sideboard de 1 carta con 99 en main => comandante', () => {
  const text = `99 Mountain\n\n1 Krenko, Mob Boss`;
  const { commanders } = parseDeckText(text, { blankLineIsSideboard: true });
  assert.deepEqual(commanders, ['Krenko, Mob Boss']);
});

test('detectSource reconoce los sitios soportados', () => {
  assert.equal(detectSource('https://archidekt.com/decks/123456/my-deck').source.id, 'archidekt');
  assert.equal(detectSource('https://www.moxfield.com/decks/AbC-123_x').source.id, 'moxfield');
  assert.equal(detectSource('https://deckstats.net/decks/12345/678901-my-deck/en').source.id, 'deckstats');
  assert.equal(detectSource('https://tappedout.net/mtg-decks/my-krenko/').source.id, 'tappedout');
  assert.equal(detectSource('https://www.mtggoldfish.com/deck/6543210').source.id, 'mtggoldfish');
  assert.equal(detectSource('https://evil.example.com/decks/1'), null);
  assert.equal(detectSource('file:///etc/passwd'), null);
});

test('normalizeArchidekt separa comandante y excluye maybeboard', () => {
  const deck = finalize(
    normalizeArchidekt({
      name: 'Squirrels',
      deckFormat: 3,
      owner: { username: 'perez' },
      categories: [
        { name: 'Commander', includedInDeck: true, isPremier: true },
        { name: 'Maybeboard', includedInDeck: false },
        { name: 'Ramp', includedInDeck: true },
      ],
      cards: [
        { quantity: 1, categories: ['Commander'], card: { oracleCard: { name: 'Chatterfang, Squirrel General' } } },
        { quantity: 1, categories: ['Ramp'], card: { oracleCard: { name: 'Sol Ring' } } },
        { quantity: 1, categories: ['Maybeboard'], card: { oracleCard: { name: 'Rhystic Study' } } },
      ],
    })
  );
  assert.equal(deck.format, 'Commander');
  assert.deepEqual(deck.commanders, ['Chatterfang, Squirrel General']);
  assert.equal(deck.cards.find((c) => c.name === 'Rhystic Study').board, 'maybe');
});

test('normalizeMoxfield soporta v3 (boards) y v2', () => {
  const v3 = normalizeMoxfield({
    name: 'Goblins',
    format: 'commander',
    boards: {
      commanders: { cards: { a: { quantity: 1, card: { name: 'Krenko, Mob Boss' } } } },
      mainboard: { cards: { b: { quantity: 30, card: { name: 'Mountain' } } } },
    },
  });
  assert.deepEqual(finalize(v3).commanders, ['Krenko, Mob Boss']);
  const v2 = normalizeMoxfield({
    name: 'Goblins',
    commanders: { 'Krenko, Mob Boss': { quantity: 1, card: { name: 'Krenko, Mob Boss' } } },
    mainboard: { Mountain: { quantity: 30, card: { name: 'Mountain' } } },
  });
  assert.equal(finalize(v2).cards.find((c) => c.name === 'Mountain').qty, 30);
});

test('los decks demo tienen 100 cartas con comandante', () => {
  for (const d of DEMO_DECKS) {
    const { cards, commanders } = parseDeckText(d.text);
    const total = cards.reduce((n, c) => n + c.qty, 0);
    assert.equal(commanders.length, 1, d.name);
    assert.equal(total, 100, `${d.name}: ${total}`);
  }
});
