// Análisis rápido de un deck ya enriquecido: curva, tipos, precio y bracket estimado.

export const isLand = (c) => /\bLand\b/.test(c.typeLine);
export const isCreature = (c) => /\bCreature\b/.test(c.typeLine);

const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Land', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'];

/** @param {{info:object, qty:number, board:string}[]} entries */
export function analyze(entries) {
  const deck = entries.filter((e) => e.board === 'main' || e.board === 'commander');
  const count = deck.reduce((n, e) => n + e.qty, 0);
  const nonland = deck.filter((e) => !isLand(e.info));
  const nonlandCount = nonland.reduce((n, e) => n + e.qty, 0);
  const curve = Array(8).fill(0);
  let mvTotal = 0;
  for (const e of nonland) {
    const mv = Math.round(e.info.cmc || 0);
    curve[Math.min(mv, 7)] += e.qty;
    mvTotal += mv * e.qty;
  }

  const types = {};
  for (const e of deck) {
    const t = TYPE_ORDER.find((x) => e.info.typeLine.includes(x)) || 'Otro';
    types[t] = (types[t] || 0) + e.qty;
  }

  const text = (e) => (e.info.oracle || '').toLowerCase();
  const countIf = (fn) => deck.filter(fn).reduce((n, e) => n + e.qty, 0);

  const gameChangers = deck.filter((e) => e.info.gameChanger).map((e) => e.info.name);
  const tutors = countIf(
    (e) => /search your library for an? (card|instant|sorcery|creature|artifact|enchantment)/.test(text(e)) && !isLand(e.info)
  );
  const extraTurns = countIf((e) => /take an extra turn/.test(text(e)));
  const mld = countIf((e) => /destroy all lands|each player sacrifices .*lands|destroy all nonbasic/.test(text(e)));
  const ramp = countIf(
    (e) => !isLand(e.info) && (/\{t\}[^.]*: add/.test(text(e)) || /search your library for .*land/.test(text(e)))
  );
  const draw = countIf((e) => /draw (a|two|three|\w+) cards?/.test(text(e)));
  const removal = countIf((e) => /(destroy|exile) target/.test(text(e)));
  const wipes = countIf((e) => /(destroy|exile) all (creatures|nonland)|all creatures get -/.test(text(e)));

  let bracket = 2;
  if (gameChangers.length >= 1 || tutors >= 3) bracket = 3;
  if (gameChangers.length > 3 || mld > 0 || extraTurns >= 2) bracket = 4;

  const ci = new Set();
  const commanders = deck.filter((e) => e.board === 'commander');
  for (const e of commanders.length ? commanders : deck) e.info.colorIdentity.forEach((c) => ci.add(c));

  return {
    count,
    avgMV: nonlandCount ? +(mvTotal / nonlandCount).toFixed(2) : 0,
    curve,
    types,
    lands: types.Land || 0,
    price: +deck.reduce((n, e) => n + e.info.usd * e.qty, 0).toFixed(2),
    colorIdentity: ['W', 'U', 'B', 'R', 'G'].filter((c) => ci.has(c)),
    gameChangers,
    tutors,
    extraTurns,
    mld,
    ramp,
    draw,
    removal,
    wipes,
    bracket,
    missing: deck.filter((e) => e.info.missing).map((e) => e.info.name),
  };
}

export const BRACKET_NAMES = {
  1: 'Exhibition',
  2: 'Core',
  3: 'Upgraded',
  4: 'Optimized',
  5: 'cEDH',
};
