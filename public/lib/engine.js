// Motor de Commander basado en las Reglas Completas de Magic (Comprehensive Rules).
// Los números "CR x.y" en comentarios y en el registro apuntan a la regla correspondiente.
// Ver docs/REGLAS.md para la cobertura completa.
//
// El motor conduce la partida completa (fases, pasos, prioridad). Cuando necesita una decisión
// de un jugador humano llama a `io.decide(player, request)` y espera la respuesta; para la IA decide solo.
//   io.step(label, detail) -> Promise          animación / ritmo
//   io.decide(player, req) -> Promise<value>   decisiones humanas (req es serializable)

import { isLand, isCreature } from './stats.js';
import { parseCost, costTotal, manaSources, planPayment, COLORS } from './mana.js';

export const STARTING_LIFE = 40; // CR 903.7
export const COMMANDER_DAMAGE_LETHAL = 21; // CR 704.6c / 903.10a
export const POISON_LETHAL = 10; // CR 704.5c
export const MAX_HAND = 7; // CR 402.2 / 514.1

export const STEPS = [
  { id: 'untap', label: 'Untap', cr: '502' },
  { id: 'upkeep', label: 'Upkeep', cr: '503' },
  { id: 'draw', label: 'Draw', cr: '504' },
  { id: 'main1', label: 'Main 1', cr: '505' },
  { id: 'beginCombat', label: 'Combat', cr: '507' },
  { id: 'declareAttackers', label: 'Attackers', cr: '508' },
  { id: 'declareBlockers', label: 'Blockers', cr: '509' },
  { id: 'combatDamage', label: 'Damage', cr: '510' },
  { id: 'endCombat', label: 'End combat', cr: '511' },
  { id: 'main2', label: 'Main 2', cr: '505' },
  { id: 'end', label: 'End', cr: '513' },
  { id: 'cleanup', label: 'Cleanup', cr: '514' },
];
const MAIN_STEPS = ['main1', 'main2'];

let iidSeq = 0;
let stackSeq = 0;

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, x: 0 };
const num = (s, x = 0) => (String(s).toLowerCase() === 'x' ? x : (NUM[String(s).toLowerCase()] ?? (parseInt(s, 10) || 1)));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export const has = (c, kw) => (c.keywords || []).some((k) => k.toLowerCase() === kw);
export const isInstantOrSorcery = (c) => /\b(Instant|Sorcery)\b/.test(c.typeLine);
const isInstantSpeed = (c) => /\bInstant\b/.test(c.typeLine) || has(c, 'flash');
const isLegendary = (c) => /\bLegendary\b/.test(c.typeLine);
const isPlaneswalker = (c) => /\bPlaneswalker\b/.test(c.typeLine);
const subtypes = (c) => (c.typeLine.split('—')[1] || '').trim().split(/\s+/).filter(Boolean);
const PASS = { type: 'pass' };

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Objetos ----------

export function makeCard(info, owner, extra = {}) {
  return {
    ...info,
    iid: ++iidSeq,
    owner,
    tapped: false,
    sick: true,
    damage: 0,
    deathtouched: false,
    counters: { p1: 0, m1: 0, loyalty: parseInt(info.loyalty, 10) || 0 },
    ...extra,
  };
}

function makeToken(owner, p, t, subtype = '', keywords = []) {
  return makeCard(
    {
      name: `${subtype || 'Token'} ${p}/${t}`.trim(),
      typeLine: `Token Creature${subtype ? ' — ' + subtype : ''}`,
      cmc: 0,
      manaCost: '',
      oracle: '',
      keywords,
      power: String(p),
      toughness: String(t),
      colorIdentity: [],
      img: null,
      imgSmall: null,
    },
    owner,
    { isToken: true }
  );
}

const ARTIFACT_TOKENS = {
  treasure: '{T}, Sacrifice this token: Add one mana of any color.',
  clue: '{2}, Sacrifice this token: Draw a card.',
  food: '{2}, {T}, Sacrifice this token: You gain 3 life.',
};

function makeArtifactToken(owner, kind) {
  return makeCard(
    {
      name: cap(kind),
      typeLine: `Token Artifact — ${cap(kind)}`,
      cmc: 0,
      manaCost: '',
      oracle: ARTIFACT_TOKENS[kind] || '',
      keywords: [],
      colorIdentity: [],
      img: null,
      imgSmall: null,
    },
    owner,
    { isToken: true, sick: false }
  );
}

/** Fuerza/resistencia actuales: base + contadores (CR 122) + "lords" (CR 613.4c) + efectos hasta fin de turno. */
export function power(game, c) {
  return base(c.power) + c.counters.p1 - c.counters.m1 + lordBonus(game, c).p + (c.tempP || 0);
}
export function toughness(game, c) {
  return base(c.toughness) + c.counters.p1 - c.counters.m1 + lordBonus(game, c).t + (c.tempT || 0);
}
function base(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? (v == null ? 0 : 1) : n;
}

function lordBonus(game, c) {
  const out = { p: 0, t: 0 };
  if (!game || !isCreature(c)) return out;
  for (const src of game.players[c.owner]?.battlefield || []) {
    for (const m of (src.oracle || '').matchAll(/(other )?(?:([a-z]+) )?creatures you control get \+(\d+)\/\+(\d+)(?![^.]*until end of turn)/gi)) {
      if (m[1] && src === c) continue;
      if (m[2] && !subtypes(c).some((t) => t.toLowerCase() === m[2].toLowerCase())) continue;
      out.p += +m[3];
      out.t += +m[4];
    }
  }
  return out;
}

// ---------- Partida ----------

/**
 * @param {{name:string, isAI:boolean, color:string, deckName?:string, entries:{info:object, qty:number, board:string}[]}[]} configs
 */
export function createGame(configs, settings = {}) {
  const players = configs.map((cfg, idx) => {
    const library = [];
    const command = [];
    for (const e of cfg.entries) {
      if (e.board === 'commander') command.push(makeCard(e.info, idx, { isCommander: true })); // CR 903.6
      else if (e.board === 'main') for (let i = 0; i < e.qty; i++) library.push(makeCard(e.info, idx));
    }
    const ci = new Set();
    command.forEach((c) => (c.colorIdentity || []).forEach((x) => ci.add(x)));
    return {
      idx,
      name: cfg.name,
      isAI: cfg.isAI,
      color: cfg.color,
      deckName: cfg.deckName || '',
      life: STARTING_LIFE,
      poison: 0,
      library: shuffle(library), // CR 103.3
      hand: [],
      battlefield: [],
      graveyard: [],
      exile: [],
      command,
      commanderCI: COLORS.filter((c) => ci.has(c)),
      commanderTax: {}, // CR 903.8
      commanderDamage: {}, // iid del comandante -> daño de combate (CR 903.10a)
      landsPlayed: 0,
      castsThisTurn: [],
      turnsTaken: 0,
      alive: true,
      drewFromEmpty: false,
      mulligans: 0,
      stats: newStats(),
      autoPassTurn: -1,
      aiTurn: -1,
      lastError: null,
    };
  });

  const game = {
    players,
    active: Math.floor(Math.random() * players.length), // CR 103.1
    firstPlayer: 0,
    turn: 1,
    turnId: 0,
    step: 'untap',
    stack: [],
    pools: players.map(() => []),
    combat: null,
    log: [],
    winner: null,
    banner: null,
    pendingTriggers: [],
    lifeHistory: [],
    settings: { fullStops: false, ...settings },
    aborted: false,
  };
  game.firstPlayer = game.active;
  for (const p of players) for (let i = 0; i < 7 && p.library.length; i++) p.hand.push(p.library.shift()); // CR 103.4
  snapshotLife(game, 'Inicio');
  log(game, `🎲 ${players[game.active].name} empieza la partida (CR 103.1).`);
  return game;
}

// ---------- Estadísticas de la partida ----------

function newStats() {
  return {
    spells: 0, manaSpent: 0, lands: 0, draws: 0, combatDamage: 0, otherDamage: 0, biggestHit: 0,
    creaturesLost: 0, removal: 0, counters: 0, lifeGained: 0, sources: {}, eliminatedTurn: null, eliminatedReason: null,
  };
}

function creditDamage(game, ownerIdx, sourceName, amount, combat) {
  const st = game.players[ownerIdx]?.stats;
  if (!st || amount <= 0) return;
  if (combat) st.combatDamage += amount;
  else st.otherDamage += amount;
  st.biggestHit = Math.max(st.biggestHit, amount);
  if (sourceName) st.sources[sourceName] = (st.sources[sourceName] || 0) + amount;
}

/** Guarda la vida de todos en este momento (para la gráfica de la partida). */
export function snapshotLife(game, label) {
  game.lifeHistory.push({ turn: game.turn, label, lives: game.players.map((p) => Math.max(0, p.life)) });
  if (game.lifeHistory.length > 400) game.lifeHistory.shift();
}

export function log(game, msg) {
  game.log.unshift({ turn: game.turn, msg });
  if (game.log.length > 300) game.log.pop();
}

export function setStep(game, step) {
  game.step = step;
  for (let i = 0; i < game.pools.length; i++) game.pools[i] = []; // CR 106.4
}

export const aiControlled = (game, p) => p.isAI || p.aiTurn === game.turnId;

export function draw(game, p, n = 1) {
  for (let i = 0; i < n; i++) {
    const c = p.library.shift();
    if (!c) {
      p.drewFromEmpty = true; // CR 704.5b
      break;
    }
    p.hand.push(c);
    p.stats.draws++;
    game.pendingTriggers.push({ type: 'draw', player: p.idx });
  }
  runSBA(game);
}

// ---------- Mulligan (CR 103.5) ----------

function mulliganOnce(game, p) {
  p.library.push(...p.hand);
  p.hand = [];
  shuffle(p.library);
  p.mulligans++;
  for (let i = 0; i < 7 && p.library.length; i++) p.hand.push(p.library.shift());
  log(game, `🔄 ${p.name} hace mulligan #${p.mulligans}.`);
}

/** Cartas a poner al fondo al quedarse con la mano: el primer mulligan es gratis en multijugador (CR 103.5c). */
export function mulliganBottomCount(game, p) {
  return Math.max(0, p.mulligans - (game.players.length > 2 ? 1 : 0));
}

/** Fase previa: cada jugador decide sus mulligans en orden de turno (CR 103.5). */
export async function pregame(game, io) {
  const n = game.players.length;
  for (let k = 0; k < n; k++) {
    const p = game.players[(game.firstPlayer + k) % n];
    if (p.isAI) {
      for (let tries = 0; tries < 2; tries++) {
        const lands = p.hand.filter(isLand).length;
        if (lands >= 2 && lands <= 5) break;
        mulliganOnce(game, p);
      }
    } else {
      while (p.mulligans < 6) {
        const v = await io.decide(p, { kind: 'mulligan', mulligans: p.mulligans, toBottom: mulliganBottomCount(game, p) });
        if (v !== 'mulligan') break;
        mulliganOnce(game, p);
      }
    }
    const nBottom = mulliganBottomCount(game, p);
    if (nBottom > 0) {
      let chosen = [];
      if (!p.isAI) {
        const ids = await io.decide(p, { kind: 'bottom', n: nBottom });
        chosen = (Array.isArray(ids) ? ids : []).map((id) => p.hand.find((c) => c.iid === id)).filter(Boolean).slice(0, nBottom);
      }
      if (chosen.length < nBottom) {
        const rest = [...p.hand].filter((c) => !chosen.includes(c)).sort((a, b) => (b.cmc || 0) - (a.cmc || 0));
        chosen.push(...rest.slice(0, nBottom - chosen.length));
      }
      for (const c of chosen) moveCard(game, c, 'library', { position: 'bottom' });
      log(game, `   ${p.name} pone ${nBottom} carta${nBottom > 1 ? 's' : ''} al fondo (mulligan de Londres).`);
    }
  }
}

// ---------- Zonas ----------

export function findCard(game, iid) {
  for (const p of game.players) {
    for (const zone of ['hand', 'battlefield', 'graveyard', 'exile', 'command', 'library']) {
      const i = p[zone].findIndex((c) => c.iid === iid);
      if (i >= 0) return { player: p, zone, index: i, card: p[zone][i] };
    }
  }
  const s = game.stack.findIndex((it) => it.card?.iid === iid);
  if (s >= 0) return { player: game.stack[s].controller, zone: 'stack', index: s, card: game.stack[s].card };
  return null;
}

/**
 * Mueve una carta. CR 400.7: al cambiar de zona es un objeto nuevo (se limpian estados).
 * CR 903.9b: un comandante que iría a la biblioteca va a la zona de mando.
 */
export function moveCard(game, card, toZone, { position = 'top' } = {}) {
  const loc = findCard(game, card.iid);
  if (!loc) return;
  const fromBattlefield = loc.zone === 'battlefield';
  if (loc.zone === 'stack') game.stack.splice(loc.index, 1);
  else loc.player[loc.zone].splice(loc.index, 1);

  if (fromBattlefield && toZone === 'graveyard' && isCreature(card)) {
    if (game.players[card.owner]) game.players[card.owner].stats.creaturesLost++;
    game.pendingTriggers.push({ type: 'dies', card: { ...card }, controller: card.owner }); // CR 700.4
  }
  if (game.combat) game.combat.remove(card);

  if (card.isToken && toZone !== 'battlefield') return; // CR 704.5d / 111.7
  if (card.isCommander && toZone === 'library') toZone = 'command'; // CR 903.9b

  const owner = game.players[card.owner];
  card.tapped = false;
  card.damage = 0;
  card.deathtouched = false;
  card.tempP = card.tempT = 0;
  if (!card.isToken) card.counters = { p1: 0, m1: 0, loyalty: parseInt(card.loyalty, 10) || 0 };
  if (toZone === 'battlefield') card.sick = true;
  if (toZone === 'library' && position === 'bottom') owner.library.push(card);
  else if (toZone === 'library') owner.library.unshift(card);
  else owner[toZone].push(card);
}

export function commanderCost(p, card) {
  return (card.cmc || 0) + (p.commanderTax[card.iid] || 0); // CR 903.8
}

// ---------- Maná y costes ----------

export function sourcesOf(p) {
  return manaSources(p, p.commanderCI.length ? p.commanderCI : []);
}

const TYPE_WORDS = ['creature', 'artifact', 'enchantment', 'instant', 'sorcery', 'planeswalker', 'legendary'];

function spellMatchesKind(card, kind) {
  if (!kind) return true;
  const k = kind.toLowerCase().trim();
  const tl = card.typeLine.toLowerCase();
  if (k.startsWith('non')) return !tl.includes(k.slice(3));
  return k.split(/ and | or /).some((w) => tl.includes(w.trim()));
}

/**
 * Efectos estáticos que modifican el coste (CR 601.2f): Thalia, Sphere of Resistance, Grand Arbiter,
 * Goblin Electromancer… Los aumentos/reducciones solo afectan el maná genérico.
 * @returns {{source:string, owner:string, amount:number}[]}
 */
export function costModifiers(game, p, card) {
  const mods = [];
  for (const pl of game.players) {
    for (const src of pl.battlefield) {
      const text = src.oracle || '';
      const re = /((?:non)?(?:creature|artifact|enchantment|instant|sorcery|planeswalker|legendary)(?: and (?:instant|sorcery))? )?spells( your opponents cast| you cast| each opponent casts)? costs? \{(\d+)\} (more|less) to cast/gi;
      for (const m of text.matchAll(re)) {
        const who = (m[2] || '').trim();
        if (who.includes('opponent') && pl === p) continue;
        if (who === 'you cast' && pl !== p) continue;
        if (!spellMatchesKind(card, m[1])) continue;
        mods.push({ source: src.name, owner: pl.name, amount: m[4].toLowerCase() === 'more' ? +m[3] : -m[3] });
      }
      const first = text.match(/the first ((?:non)?(?:creature )?)?spell each opponent casts (?:each|during each of your) turns? costs \{(\d+)\} more/i);
      if (first && pl !== p && spellMatchesKind(card, first[1]) && p.castsThisTurn.filter((t) => spellMatchesKind({ typeLine: t }, first[1])).length === 0)
        mods.push({ source: src.name, owner: pl.name, amount: +first[2] });
    }
  }
  return mods;
}

export function costOf(game, p, card) {
  const cost = parseCost(card.manaCost);
  if (p.command.includes(card)) cost.generic += p.commanderTax[card.iid] || 0;
  const delta = costModifiers(game, p, card).reduce((n, m) => n + m.amount, 0);
  cost.generic = Math.max(0, cost.generic + delta);
  return cost;
}

export function costText(cost, x = 0) {
  const parts = [];
  if (cost.x) parts.push('{X}'.repeat(cost.x));
  if (cost.generic || (!cost.pips.length && !cost.x)) parts.push(`{${cost.generic}}`);
  for (const pip of cost.pips) parts.push(`{${pip.any.join('/')}${pip.phyrexian ? '/P' : ''}}`);
  return parts.join('') + (x ? ` (X=${x})` : '');
}

export function canPay(game, p, card, x = 0) {
  return planPayment(sourcesOf(p), game.pools[p.idx], costOf(game, p, card), { x, life: p.life }).ok;
}

function canPayGeneric(game, p, n) {
  return planPayment(sourcesOf(p), game.pools[p.idx], { generic: n, pips: [], x: 0 }, { life: p.life }).ok;
}

function payCost(game, p, cost, x = 0) {
  const sources = sourcesOf(p);
  const plan = planPayment(sources, game.pools[p.idx], cost, { x, life: p.life });
  if (!plan.ok) return false;
  for (const c of plan.used) {
    c.tapped = true;
    if (sources.find((s) => s.card === c)?.sacrifice) moveCard(game, c, 'graveyard'); // Treasure
  }
  game.pools[p.idx] = plan.pool;
  if (plan.lifePaid) p.life -= plan.lifePaid;
  return true;
}

export function availableMana(p) {
  return sourcesOf(p).reduce((n, s) => n + Math.max(...s.options.map((o) => o.length)), 0);
}

// ---------- Restricciones y tiempos ----------

const sorcerySpeedOK = (game, p) => game.active === p.idx && MAIN_STEPS.includes(game.step) && game.stack.length === 0;

function restrictions(game, p, card) {
  for (const pl of game.players) {
    for (const src of pl.battlefield) {
      const t = (src.oracle || '').toLowerCase();
      if (/each player can't cast more than one spell each turn/.test(t) && p.castsThisTurn.length >= 1)
        return `${src.name}: solo un hechizo por turno.`;
      if (pl !== p && /each opponent can't cast more than one spell each turn/.test(t) && p.castsThisTurn.length >= 1)
        return `${src.name} (${pl.name}): solo un hechizo por turno.`;
      if (pl !== p && /your opponents can't cast spells during your turn/.test(t) && game.active === pl.idx)
        return `${src.name} (${pl.name}): no puedes lanzar hechizos en su turno.`;
      if (pl !== p && /each opponent can't cast noncreature spells with mana value greater than the number of lands that player controls/.test(t) &&
        !isCreature(card) && (card.cmc || 0) > p.battlefield.filter(isLand).length)
        return `${src.name} (${pl.name}): valor de maná mayor que tus tierras.`;
    }
  }
  return null;
}

/** Razón por la que no se puede lanzar (o null). CR 117.1a, 307.1, 601.3, 903.8, 101.2 */
export function castBlockReason(game, p, card) {
  if (isLand(card)) return 'Las tierras se juegan, no se lanzan (CR 305.9).';
  if (!p.hand.includes(card) && !p.command.includes(card)) return 'Solo puedes lanzar desde la mano o la zona de mando (CR 601.3).';
  if (!isInstantSpeed(card) && !sorcerySpeedOK(game, p))
    return 'Velocidad de conjuro: solo en tu fase principal con la pila vacía (CR 307.1).';
  const r = restrictions(game, p, card);
  if (r) return `${r} (CR 101.2)`;
  return null;
}

export function landBlockReason(game, p, card) {
  if (!isLand(card)) return 'No es una tierra.';
  if (!p.hand.includes(card)) return 'La tierra debe estar en tu mano.';
  if (!sorcerySpeedOK(game, p)) return 'Solo en tu fase principal con la pila vacía (CR 305.2 / 116.2a).';
  if (p.landsPlayed >= 1) return 'Ya jugaste una tierra este turno (CR 305.2).';
  return null;
}

// ---------- Objetivos (CR 115, 601.2c, 608.2b) ----------

/** Describe el tipo de objetivo que pide una carta, o null si no tiene objetivo. */
export function targetSpec(card) {
  const t = (card.oracle || '').toLowerCase();
  let m = t.match(/counter target ([a-z ,]*?)spell/);
  if (m) return { type: 'spell', kind: m[1].trim() };
  m = t.match(/(destroy|exile) target ((?:attacking |nonland |nontoken )?(?:creature or planeswalker|artifact or enchantment|artifact or creature|creature|artifact|enchantment|planeswalker|permanent))/);
  if (m) return { type: 'permanent', kind: m[2] };
  m = t.match(/deals? (\d+|x) damage to (any target|target creature or planeswalker|target creature|target attacking creature|target player|target opponent)/);
  if (m) return { type: m[2] === 'any target' ? 'any' : /player|opponent/.test(m[2]) ? 'player' : 'permanent', kind: m[2].replace('target ', ''), amount: m[1], opponentOnly: m[2] === 'target opponent' };
  return null;
}

const targetableBy = (c, p) => !has(c, 'shroud') && !(has(c, 'hexproof') && c.owner !== p.idx); // CR 702.11b, 702.18

function permFilter(kind) {
  kind = kind.toLowerCase();
  return (c) => {
    if (kind.includes('attacking')) return isCreature(c);
    if (kind.includes('nonland')) return !isLand(c);
    if (kind.includes('creature') && isCreature(c)) return true;
    if (kind.includes('artifact') && /Artifact/.test(c.typeLine)) return true;
    if (kind.includes('enchantment') && /Enchantment/.test(c.typeLine)) return true;
    if (kind.includes('planeswalker') && isPlaneswalker(c)) return true;
    return kind.trim() === 'permanent';
  };
}

/** Objetivos legales serializables: {type:'card', iid} | {type:'player', idx} | {type:'stack', id} */
export function legalTargets(game, p, spec) {
  if (!spec) return [];
  const out = [];
  if (spec.type === 'spell') {
    for (const it of game.stack) if (it.kind === 'spell' && counterMatches(spec.kind, it.card)) out.push({ type: 'stack', id: it.id });
    return out;
  }
  if (spec.type === 'player' || spec.type === 'any') {
    for (const pl of game.players) if (pl.alive && (!spec.opponentOnly || pl !== p)) out.push({ type: 'player', idx: pl.idx });
  }
  if (spec.type === 'permanent' || spec.type === 'any') {
    const attackers = game.combat ? game.combat.attacks.map((a) => a.attacker) : [];
    const filt = spec.type === 'any' ? (c) => isCreature(c) || isPlaneswalker(c) : permFilter(spec.kind);
    for (const pl of game.players) {
      for (const c of pl.battlefield) {
        if (!filt(c) || !targetableBy(c, p)) continue;
        if (spec.kind?.includes('attacking') && !attackers.includes(c)) continue;
        out.push({ type: 'card', iid: c.iid });
      }
    }
  }
  return out;
}

function sameTarget(a, b) {
  return a && b && a.type === b.type && (a.iid ?? a.idx ?? a.id) === (b.iid ?? b.idx ?? b.id);
}

function resolveTargetRef(game, ref) {
  if (!ref) return null;
  if (ref.type === 'player') return { type: 'player', player: game.players[ref.idx] };
  if (ref.type === 'card') {
    const loc = findCard(game, ref.iid);
    return loc && loc.zone === 'battlefield' ? { type: 'card', card: loc.card } : null;
  }
  if (ref.type === 'stack') {
    const item = game.stack.find((it) => it.id === ref.id);
    return item ? { type: 'stack', item } : null;
  }
  return null;
}

function counterMatches(kind, target) {
  if (!kind) return true;
  if (kind.includes('noncreature')) return !isCreature(target);
  if (kind.includes('creature')) return isCreature(target);
  if (kind.includes('instant or sorcery')) return isInstantOrSorcery(target);
  return true;
}

function threatScore(game, c) {
  return (isCreature(c) ? power(game, c) + toughness(game, c) : 2) + (c.isCommander ? 8 : 0) + (c.cmc || 0);
}

function aiChooseTarget(game, p, spec, legal) {
  if (!legal.length) return null;
  if (spec.type === 'spell') return [...legal].reverse().find((r) => game.stack.find((it) => it.id === r.id)?.controller !== p) || null;
  const n = num(spec.amount || 0);
  const cards = legal.filter((r) => r.type === 'card').map((r) => ({ r, c: findCard(game, r.iid)?.card })).filter((x) => x.c && x.c.owner !== p.idx);
  if (spec.type === 'any' || spec.type === 'permanent') {
    const killable = cards
      .filter(({ c }) => spec.amount == null || (isCreature(c) && toughness(game, c) - c.damage <= n))
      .sort((a, b) => threatScore(game, b.c) - threatScore(game, a.c));
    if (killable[0]) return killable[0].r;
  }
  const players = legal.filter((r) => r.type === 'player' && r.idx !== p.idx).sort((a, b) => game.players[a.idx].life - game.players[b.idx].life);
  return players[0] || null;
}

export function opponents(game, p) {
  return game.players.filter((o) => o !== p && o.alive);
}

function weakestOpponent(game, p) {
  return opponents(game, p).sort((a, b) => a.life - b.life || Math.random() - 0.5)[0];
}

// ---------- Acciones de prioridad ----------

export function playLand(game, p, card) {
  const why = landBlockReason(game, p, card);
  if (why) return { ok: false, reason: why };
  moveCard(game, card, 'battlefield'); // CR 305.1: jugar tierra no usa la pila
  if (/enters( the battlefield)? tapped/i.test(card.oracle || '') && !/unless/i.test(card.oracle || '')) card.tapped = true;
  p.landsPlayed++;
  p.stats.lands++;
  log(game, `🌲 ${p.name} juega ${card.name}.`);
  return { ok: true };
}

/**
 * Lanza un hechizo (CR 601.2): anunciar, elegir X y objetivos, calcular coste total (con modificadores),
 * pagar. El hechizo queda en la pila hasta que todos pasen prioridad (CR 117.4).
 */
export async function castSpell(game, p, card, io, { x = 0, target } = {}) {
  const why = castBlockReason(game, p, card);
  if (why) return { ok: false, reason: why };

  // CR 601.2c: objetivos
  const spec = targetSpec(card);
  let chosen = null;
  if (spec) {
    const legal = legalTargets(game, p, spec);
    if (!legal.length) return { ok: false, reason: 'No hay objetivos legales (CR 601.2c).' };
    if (target && legal.some((r) => sameTarget(r, target))) chosen = target;
    else if (aiControlled(game, p)) chosen = aiChooseTarget(game, p, spec, legal);
    else {
      chosen = await io.decide(p, { kind: 'target', card: card.name, iid: card.iid, spec, targets: legal });
      if (!chosen || !legal.some((r) => sameTarget(r, chosen))) return { ok: false, reason: 'Lanzamiento cancelado.' };
    }
    if (!chosen) return { ok: false, reason: 'No hay objetivos adecuados.' };
  }

  // CR 601.2f-h: coste total y pago
  const cost = costOf(game, p, card);
  const mods = costModifiers(game, p, card);
  if (!payCost(game, p, cost, x)) return { ok: false, reason: `Maná insuficiente para ${costText(cost, x)} (CR 601.2h).` };
  const fromCommand = p.command.includes(card);
  if (fromCommand) p.commanderTax[card.iid] = (p.commanderTax[card.iid] || 0) + 2;
  p.stats.spells++;
  p.stats.manaSpent += costTotal(cost, x);

  const loc = findCard(game, card.iid);
  loc.player[loc.zone].splice(loc.index, 1);
  const item = { id: ++stackSeq, kind: 'spell', card, controller: p, x, target: chosen };
  game.stack.push(item);
  p.castsThisTurn.push(card.typeLine);
  const modTxt = mods.length ? ` [${mods.map((m) => `${m.source} ${m.amount > 0 ? '+' : ''}${m.amount}`).join(', ')}, CR 601.2f]` : '';
  log(game, `✨ ${p.name} lanza ${card.name}${fromCommand ? ' desde la zona de mando (CR 903.8)' : ''}${targetLabel(game, chosen)}${modTxt}.`);
  await io.step(card.isCommander ? 'COMMANDER' : 'CAST', `${p.name}: ${card.name}${targetLabel(game, chosen)}`);
  await castTriggers(game, p, card, io);
  return { ok: true };
}

function targetLabel(game, ref) {
  const t = resolveTargetRef(game, ref);
  if (!t) return '';
  if (t.type === 'player') return ` → ${t.player.name}`;
  if (t.type === 'card') return ` → ${t.card.name}`;
  return ` → ${t.item.card.name}`;
}

/** Habilidades activadas no de maná que el motor sabe resolver (CR 602). */
export function activatedAbilities(game, p, c) {
  const out = [];
  if (c.tapped || (isCreature(c) && c.sick && !has(c, 'haste'))) return out;
  const text = c.oracle || '';
  let m = text.match(/\{T\}, (?:Pay 1 life, )?Sacrifice [^:]+: (Search your library for [^.]+\.[^.]*\.?)/);
  if (m) out.push({ label: 'Buscar tierra (sacrificar)', sacrifice: true, life: /Pay 1 life/.test(m[0]) ? 1 : 0, text: m[1] });
  for (const mm of text.matchAll(/(?:^|\n)\{T\}: ((?:Create|Draw|Target player|Each opponent|[^.\n]* deals \d+ damage)[^\n]*)/g)) {
    out.push({ label: mm[1].slice(0, 60), text: mm[1] });
  }
  return out;
}

export async function activateAbility(game, p, c, index, io) {
  const ability = activatedAbilities(game, p, c)[index];
  if (!ability) return { ok: false, reason: 'Habilidad no disponible.' };
  c.tapped = true; // CR 602.2: pagar costes
  if (ability.life) p.life -= ability.life;
  if (ability.sacrifice) moveCard(game, c, 'graveyard');
  game.stack.push({ id: ++stackSeq, kind: 'ability', card: { ...c, name: `${c.name} (habilidad)` }, source: c, controller: p, text: ability.text });
  log(game, `⚙ ${p.name} activa ${c.name}.`);
  await io.step('ABILITY', c.name);
  return { ok: true };
}

// ---------- Disparadores al lanzar (CR 603.2) ----------

async function payOrNot(game, payer, amount, prompt, io) {
  if (amount <= 0) return true;
  if (!canPayGeneric(game, payer, amount)) return false;
  const pay = aiControlled(game, payer)
    ? availableMana(payer) >= amount + 1 || amount <= 1
    : await io.decide(payer, { kind: 'payUnless', amount, ...prompt });
  if (pay !== true && !pay) return false;
  return payCost(game, payer, { generic: amount, pips: [], x: 0 });
}

async function castTriggers(game, caster, card, io) {
  for (const pl of game.players) {
    if (!pl.alive) continue;
    for (const src of [...pl.battlefield]) {
      const t = src.oracle || '';
      if (pl !== caster) {
        // Rhystic Study, Mystic Remora, Esper Sentinel…
        const m = t.match(/whenever an opponent casts (?:a|an|their first) ((?:non)?(?:creature )?|instant or sorcery )?spell(?: each turn)?, (?:you may )?draw a card unless that player pays \{(x|\d+)\}/i);
        if (m) {
          const first = /their first/i.test(m[0]);
          const kind = (m[1] || '').trim();
          const okKind = spellMatchesKind(card, kind);
          const isFirst = caster.castsThisTurn.filter((tl) => spellMatchesKind({ typeLine: tl }, kind)).length === 1;
          if (okKind && (!first || isFirst)) {
            const amount = m[2].toLowerCase() === 'x' ? Math.max(0, power(game, src)) : +m[2];
            const paid = await payOrNot(game, caster, amount, { source: src.name, owner: pl.name, effect: `${pl.name} roba una carta` }, io);
            if (!paid) draw(game, pl, 1);
            log(game, `   ⚡ ${src.name} (${pl.name}): ${caster.name} ${paid ? `paga {${amount}}` : `no paga → ${pl.name} roba`} (CR 603.2).`);
            await io.step('TRIGGER', `${src.name}: ${paid ? `${caster.name} pagó {${amount}}` : `${pl.name} roba`}`);
          }
        }
        // Daño/pérdida de vida al lanzar (Ruric Thar, Kambal…)
        const d = t.match(/whenever (?:a player|an opponent) casts (?:a|an) (noncreature )?spell, [^.]*?(?:deals (\d+) damage to that player|that player loses (\d+) life)/i);
        if (d && spellMatchesKind(card, d[1])) {
          const n = +(d[2] || d[3]);
          caster.life -= n;
          log(game, `   ⚡ ${src.name} (${pl.name}): ${caster.name} pierde ${n} (CR 603.2).`);
        }
      } else {
        // "Whenever you cast …" (Talrand, Young Pyromancer, magecraft…)
        const m = t.match(/whenever you cast (?:an?|your first) ((?:non)?(?:creature )?|instant or sorcery )?spell(?: each turn)?, ([^.\n]+)/i);
        if (m && src !== card && spellMatchesKind(card, m[1])) {
          const fx = resolveText(game, pl, m[2], { source: src });
          if (fx.length) log(game, `   ⚡ ${src.name}: ${fx.join(', ')}.`);
        }
      }
    }
  }
  runSBA(game);
}

// ---------- Resolución (CR 608) ----------

async function resolveTop(game, io) {
  const item = game.stack[game.stack.length - 1];
  const { card, controller: p } = item;
  // CR 608.2b: si todos sus objetivos son ilegales, no se resuelve
  if (item.target && !stillLegal(game, item)) {
    game.stack.pop();
    if (item.kind === 'spell') {
      game.players[card.owner].graveyard.push(card);
      runSBA(game);
    }
    log(game, `💨 ${card.name} no se resuelve: objetivo ilegal (CR 608.2b).`);
    await io.step('FIZZLE', card.name);
    return;
  }
  game.stack.pop();
  let effects = [];
  if (item.kind === 'ability') {
    effects = resolveText(game, p, item.text, { source: item.source, target: item.target });
  } else if (isInstantOrSorcery(card)) {
    effects = resolveText(game, p, card.oracle || '', { source: card, x: item.x, target: item.target });
    if (!card.isToken) game.players[card.owner].graveyard.push(card); // CR 608.2n
  } else {
    card.sick = true;
    game.players[card.owner].battlefield.push(card); // CR 608.3
    if (has(card, 'haste')) card.sick = false;
    const etb = (card.oracle || '')
      .split('\n')
      .filter((l) => /^when(ever)? .* enters/i.test(l))
      .map((l) => l.replace(/^when(ever)? [^,]* enters[^,]*, /i, ''))
      .join('\n');
    if (etb) effects = resolveText(game, p, etb, { source: card, x: item.x });
  }
  runSBA(game);
  log(game, `   ↳ Se resuelve ${card.name}${effects.length ? ': ' + effects.join(', ') : ''}.`);
  await io.step(labelFor(effects, item), `${card.name}${effects.length ? ' · ' + effects.join(', ') : ''}`);
  await flushTriggers(game, io);
}

function stillLegal(game, item) {
  const spec = item.kind === 'spell' ? targetSpec(item.card) : null;
  if (!spec) return true;
  return legalTargets(game, item.controller, spec).some((r) => sameTarget(r, item.target));
}

function labelFor(effects, item) {
  if (effects.some((e) => e.startsWith('BOARD WIPE'))) return 'BOARD WIPE';
  if (effects.some((e) => / sacrifica /.test(e))) return 'SACRIFICE';
  if (effects.some((e) => e.startsWith('contrarresta'))) return 'COUNTER';
  if (effects.some((e) => /destruye|exilia/.test(e))) return 'REMOVAL';
  if (effects.some((e) => e.startsWith('crea'))) return 'TOKENS';
  if (effects.some((e) => e.startsWith('busca'))) return 'RAMP';
  return item.card?.isCommander ? 'COMMANDER' : 'RESOLVE';
}

/** Resuelve los efectos más comunes leyendo el texto Oracle. */
export function resolveText(game, p, text, { source = null, x = 0, target = null, defender = null } = {}) {
  const t = text.toLowerCase();
  const out = [];
  const tgt = resolveTargetRef(game, target);
  let m;

  // Contrarrestar (CR 701.6)
  if (/counter target [a-z ,]*spell/.test(t) && tgt?.type === 'stack') {
    const it = tgt.item;
    game.stack.splice(game.stack.indexOf(it), 1);
    if (it.kind === 'spell' && !it.card.isToken) game.players[it.card.owner].graveyard.push(it.card); // CR 701.6a
    out.push(`contrarresta ${it.card.name}`);
    p.stats.counters++;
  }

  // Board wipes
  if ((m = t.match(/(destroy|exile) all (creatures|nonland permanents|artifacts|enchantments)/))) {
    const filt = permFilter(m[2]);
    let n = 0;
    for (const pl of game.players) {
      for (const c of [...pl.battlefield]) {
        if (!filt(c)) continue;
        if (m[1] === 'destroy' && has(c, 'indestructible')) continue; // CR 702.12b
        moveCard(game, c, m[1] === 'exile' ? 'exile' : 'graveyard');
        n++;
      }
    }
    out.push(`BOARD WIPE (${n})`);
  } else if ((m = t.match(/all creatures get -(\d+)\/-(\d+)/))) {
    for (const pl of game.players) for (const c of pl.battlefield) if (isCreature(c)) c.tempT = (c.tempT || 0) - +m[2];
    out.push(`todas las criaturas -${m[1]}/-${m[2]}`);
  }

  // Removal con objetivo
  if ((m = t.match(/(destroy|exile) target /)) && tgt?.type === 'card') {
    const c = tgt.card;
    if (m[1] === 'destroy' && has(c, 'indestructible')) out.push(`${c.name} es indestructible`);
    else {
      moveCard(game, c, m[1] === 'exile' ? 'exile' : 'graveyard');
      p.stats.removal++;
      out.push(`${m[1] === 'exile' ? 'exilia' : 'destruye'} ${c.name}`);
    }
  }

  // Daño
  if ((m = t.match(/deals? (\d+|x) damage to each opponent/))) {
    const n = num(m[1], x);
    for (const o of opponents(game, p)) {
      o.life -= n;
      creditDamage(game, p.idx, source?.name, n, false);
    }
    out.push(`${n} de daño a cada oponente`);
  } else if ((m = t.match(/deals? (\d+|x) damage to the player or planeswalker it's attacking/)) && defender) {
    defender.life -= num(m[1], x);
    creditDamage(game, p.idx, source?.name, num(m[1], x), false);
    out.push(`${num(m[1], x)} de daño a ${defender.name}`);
  } else if ((m = t.match(/deals? (\d+|x) damage to (?:any target|target [a-z ]+)/)) && tgt) {
    const n = num(m[1], x);
    if (tgt.type === 'player') {
      tgt.player.life -= n;
      if (tgt.player !== p) creditDamage(game, p.idx, source?.name, n, false);
      out.push(`${n} de daño a ${tgt.player.name}`);
    } else if (tgt.type === 'card') {
      tgt.card.damage += n;
      if (isPlaneswalker(tgt.card)) tgt.card.counters.loyalty -= n;
      out.push(`${n} de daño a ${tgt.card.name}`);
    }
  }

  // Pérdida de vida / drenaje
  if ((m = t.match(/each opponent loses (\d+) life/))) {
    for (const o of opponents(game, p)) {
      o.life -= +m[1];
      creditDamage(game, p.idx, source?.name, +m[1], false);
    }
    out.push(`cada oponente pierde ${m[1]}`);
  } else if ((m = t.match(/target (?:player|opponent) loses (\d+) life/))) {
    const o = weakestOpponent(game, p);
    if (o) {
      o.life -= +m[1];
      creditDamage(game, p.idx, source?.name, +m[1], false);
      out.push(`${o.name} pierde ${m[1]}`);
    }
  }
  if ((m = t.match(/you gain (\d+) life/))) {
    p.life += +m[1];
    p.stats.lifeGained += +m[1];
    out.push(`+${m[1]} vida`);
  }

  // Sacrificio forzado (Grave Pact): cada jugador elige; se elige la criatura más débil.
  if (/each (?:other player|opponent) sacrifices a creature/.test(t)) {
    for (const o of opponents(game, p)) {
      const c = o.battlefield.filter(isCreature).sort((a, b) => threatScore(game, a) - threatScore(game, b))[0];
      if (c) {
        moveCard(game, c, 'graveyard');
        out.push(`${o.name} sacrifica ${c.name}`);
      }
    }
  }

  // Robar
  if ((m = t.match(/(?<!each (?:player|opponent) )draws? (a|one|two|three|four|x|\d+) cards?/))) {
    const n = num(m[1], x);
    draw(game, p, n);
    out.push(`roba ${n}`);
  }

  // Buscar tierras (Cultivate, Rampant Growth, fetchlands…)
  if ((m = t.match(/search your library for (a|an|up to (?:one|two|three)) (basic land|basic [a-z]+|land|[a-z]+ or [a-z]+) cards?/))) {
    const n = /up to (\w+)/.test(m[1]) ? num(m[1].split(' ').pop()) : 1;
    const words = m[2].replace('basic ', '').split(/ or /).map((w) => w.trim());
    let found = 0;
    for (let i = 0; i < n; i++) {
      const land = p.library.find(
        (c) => isLand(c) && (/basic/.test(m[2]) ? /Basic/.test(c.typeLine) : true) &&
          (words.some((w) => w === 'land') || words.some((w) => c.typeLine.toLowerCase().includes(w)))
      );
      if (!land) break;
      moveCard(game, land, 'battlefield');
      land.sick = false;
      land.tapped = /onto the battlefield tapped/.test(t);
      found++;
    }
    shuffle(p.library);
    if (found) out.push(`busca ${found} tierra${found > 1 ? 's' : ''}`);
  }

  // Contadores +1/+1 masivos
  if ((m = t.match(/put (a|two|\d+) \+1\/\+1 counters? on each creature you control/))) {
    for (const c of p.battlefield) if (isCreature(c)) c.counters.p1 += num(m[1]);
    out.push('+1/+1 a tus criaturas');
  }

  // Tokens de criatura (CR 111)
  if ((m = t.match(/create (a|one|two|three|four|five|x|\d+) (tapped )?(\d+)\/(\d+) ([a-z ]*?)creature tokens?(?: with ([a-z ,]+?))?(?:[.,]|$| where| for| and)/))) {
    let n = num(m[1], x);
    const wm = t.match(/where x is the number of ([a-z]+?)s? you control/);
    if (m[1] === 'x' && wm) n = p.battlefield.filter((c) => c.typeLine.toLowerCase().includes(wm[1])).length;
    const sub = m[5].replace(/\b(white|blue|black|red|green|colorless|and|artifact)\b/g, '').trim().split(' ').map(cap).join(' ');
    const kws = (m[6] || '').split(/,| and /).map((s) => s.trim()).filter(Boolean);
    const made = createTokens(game, p, n, +m[3], +m[4], sub, kws, !!m[2]);
    out.push(`crea ${made} token${made !== 1 ? 's' : ''} ${m[3]}/${m[4]}`);
  }
  // Tokens de artefacto (Treasure, Clue, Food)
  if ((m = t.match(/create (a|one|two|three|four|x|\d+) (tapped )?(treasure|clue|food) tokens?/))) {
    const n = num(m[1], x);
    for (let i = 0; i < n; i++) {
      const tk = makeArtifactToken(p.idx, m[3]);
      tk.tapped = !!m[2];
      p.battlefield.push(tk);
    }
    out.push(`crea ${n} ${cap(m[3])}`);
  }

  runSBA(game);
  return out;
}

/** Crea tokens aplicando efectos de reemplazo (CR 614): Chatterfang, Parallel Lives… */
function createTokens(game, p, n, pw, tg, sub, kws = [], tapped = false) {
  if (n <= 0) return 0;
  let count = n;
  let squirrels = 0;
  for (const c of p.battlefield) {
    const o = (c.oracle || '').toLowerCase();
    if (/twice that many of those tokens/.test(o)) count *= 2;
    if (/those tokens plus that many 1\/1 green squirrel creature tokens/.test(o)) squirrels += count;
  }
  for (let i = 0; i < count; i++) {
    const tk = makeToken(p.idx, pw, tg, sub, kws);
    tk.tapped = tapped;
    p.battlefield.push(tk);
  }
  for (let i = 0; i < squirrels; i++) p.battlefield.push(makeToken(p.idx, 1, 1, 'Squirrel'));
  return count + squirrels;
}

// ---------- Disparadores (CR 603) ----------

function triggerMatches(subject, src, dead) {
  let s = subject.toLowerCase().trim();
  const nm = src.name.toLowerCase();
  if (s === nm || s === 'this creature') return dead.iid === src.iid;
  if (s.startsWith(`${nm} or `)) {
    if (dead.iid === src.iid) return true;
    s = s.slice(nm.length + 4);
  }
  if (!/creature/.test(s)) return false;
  if (/you control/.test(s) && dead.owner !== src.owner) return false;
  if (/another/.test(s) && dead.iid === src.iid) return false;
  if (/nontoken/.test(s) && dead.isToken) return false;
  return true;
}

/** Resuelve disparadores pendientes en orden APNAP (CR 603.3b). */
export async function flushTriggers(game, io) {
  for (let guard = 0; guard < 60 && game.pendingTriggers.length; guard++) {
    const ev = game.pendingTriggers.shift();
    const n = game.players.length;
    const order = game.players.map((_, k) => game.players[(game.active + k) % n]);
    if (ev.type === 'dies') {
      for (const pl of order) {
        if (!pl.alive) continue;
        const sources = [...pl.battlefield];
        if (ev.card.owner === pl.idx && !sources.some((s) => s.iid === ev.card.iid)) sources.push(ev.card); // CR 603.10a
        for (const src of sources) {
          for (const m of (src.oracle || '').matchAll(/(?:^|\n|\. )(?:when|whenever) ([^,]*?) dies, ([^.\n]+)/gi)) {
            if (!triggerMatches(m[1], src, ev.card)) continue;
            const fx = resolveText(game, pl, m[2], { source: src });
            if (fx.length) log(game, `   ⚡ ${src.name}: ${fx.join(', ')} (CR 603).`);
          }
        }
      }
    } else if (ev.type === 'draw') {
      const drawer = game.players[ev.player];
      for (const pl of order) {
        if (pl === drawer || !pl.alive || !drawer.alive) continue;
        for (const src of pl.battlefield) {
          // Smothering Tithe y similares
          const m = (src.oracle || '').match(/whenever an opponent draws a card, that player may pay \{(\d+)\}\. if (?:the player|they) do(?:es)?n't, you create an? (treasure|clue|food) token/i);
          if (!m) continue;
          const paid = await payOrNot(game, drawer, +m[1], { source: src.name, owner: pl.name, effect: `${pl.name} crea un ${cap(m[2])}` }, io);
          if (!paid) pl.battlefield.push(makeArtifactToken(pl.idx, m[2].toLowerCase()));
          log(game, `   ⚡ ${src.name} (${pl.name}): ${drawer.name} ${paid ? `paga {${m[1]}}` : `no paga → ${cap(m[2])}`}.`);
        }
      }
    }
  }
  runSBA(game);
}

function fireTriggers(game, p, pattern, extra = {}) {
  for (const src of [...p.battlefield]) {
    for (const m of (src.oracle || '').matchAll(pattern)) {
      const fx = resolveText(game, p, m[m.length - 1], { source: src, ...extra });
      if (fx.length) log(game, `   ⚡ ${src.name}: ${fx.join(', ')}.`);
    }
  }
}

// ---------- Avisos automáticos ----------

/** Efectos de otros jugadores que afectan a `p` (para avisar en la UI). */
export function activeEffects(game, p) {
  const out = [];
  for (const pl of game.players) {
    if (!pl.alive) continue;
    for (const src of pl.battlefield) {
      const t = src.oracle || '';
      const tag = `${src.name}${pl === p ? '' : ` (${pl.name})`}`;
      for (const m of t.matchAll(/((?:non)?(?:creature|artifact|enchantment|instant|sorcery|planeswalker)(?: and (?:instant|sorcery))? )?spells( your opponents cast| you cast| each opponent casts)? costs? \{(\d+)\} (more|less) to cast/gi)) {
        const who = (m[2] || '').trim();
        if ((who.includes('opponent') && pl === p) || (who === 'you cast' && pl !== p)) continue;
        out.push({ icon: m[4].toLowerCase() === 'more' ? '💸' : '💰', text: `${tag}: hechizos ${m[1] ? m[1].trim() + ' ' : ''}cuestan {${m[3]}} ${m[4].toLowerCase() === 'more' ? 'más' : 'menos'} (CR 601.2f)` });
      }
      if (pl === p) continue;
      let m = t.match(/whenever an opponent casts (?:a|an|their first) ((?:non)?(?:creature )?|instant or sorcery )?spell(?: each turn)?, (?:you may )?draw a card unless that player pays \{(x|\d+)\}/i);
      if (m) out.push({ icon: '🔔', text: `${tag}: cuando lances ${/their first/i.test(m[0]) ? 'tu primer ' : 'un '}hechizo ${m[1] ? m[1].trim() + ' ' : ''}paga {${m[2].toUpperCase() === 'X' ? power(game, src) : m[2]}} o roba` });
      m = t.match(/the first ((?:non)?(?:creature )?)?spell each opponent casts (?:each|during each of your) turns? costs \{(\d+)\} more/i);
      if (m) out.push({ icon: '💸', text: `${tag}: tu primer hechizo ${m[1] ? m[1].trim() + ' ' : ''}de cada turno cuesta {${m[2]}} más` });
      if (/whenever an opponent draws a card, that player may pay/i.test(t)) out.push({ icon: '🪙', text: `${tag}: cada vez que robes, paga {2} o crea un Treasure` });
      if (/can't cast more than one spell each turn/i.test(t)) out.push({ icon: '⛔', text: `${tag}: solo un hechizo por turno` });
      if (/your opponents can't cast spells during your turn/i.test(t)) out.push({ icon: '⛔', text: `${tag}: no puedes lanzar hechizos en su turno` });
      m = t.match(/whenever (?:a player|an opponent) casts (?:a|an) (noncreature )?spell, [^.]*?(?:deals (\d+) damage to that player|that player loses (\d+) life)/i);
      if (m) out.push({ icon: '🔥', text: `${tag}: pierdes ${m[2] || m[3]} al lanzar un hechizo ${m[1] ? 'no criatura' : ''}` });
    }
  }
  return out;
}

// ---------- Acciones basadas en estado (CR 704) ----------

export function runSBA(game) {
  for (let guard = 0; guard < 30; guard++) {
    let changed = false;
    const losers = [];
    for (const p of game.players) {
      if (!p.alive) continue;
      if (p.life <= 0) losers.push([p, 'vida en 0 (CR 704.5a)']);
      else if (p.drewFromEmpty) losers.push([p, 'robó de una biblioteca vacía (CR 704.5b)']);
      else if (p.poison >= POISON_LETHAL) losers.push([p, '10 contadores de veneno (CR 704.5c)']);
      else if (Object.values(p.commanderDamage).some((d) => d >= COMMANDER_DAMAGE_LETHAL))
        losers.push([p, '21 de daño de combate de un comandante (CR 704.6c)']);
    }
    for (const [p, why] of losers) {
      eliminate(game, p, why);
      changed = true;
    }

    for (const p of game.players) {
      for (const c of [...p.battlefield]) {
        if (isCreature(c)) {
          const tg = toughness(game, c);
          if (tg <= 0) {
            moveCard(game, c, 'graveyard'); // CR 704.5f
            changed = true;
            continue;
          }
          if ((c.damage >= tg || (c.deathtouched && c.damage > 0)) && !has(c, 'indestructible')) {
            moveCard(game, c, 'graveyard'); // CR 704.5g / 704.5h
            changed = true;
            continue;
          }
        }
        if (isPlaneswalker(c) && c.loyalty != null && c.counters.loyalty <= 0) {
          moveCard(game, c, 'graveyard'); // CR 704.5i
          changed = true;
          continue;
        }
        if (c.counters.p1 && c.counters.m1) {
          const k = Math.min(c.counters.p1, c.counters.m1); // CR 704.5q
          c.counters.p1 -= k;
          c.counters.m1 -= k;
        }
      }
      const byName = new Map();
      for (const c of p.battlefield.filter(isLegendary)) {
        if (!byName.has(c.name)) byName.set(c.name, []);
        byName.get(c.name).push(c);
      }
      for (const [name, list] of byName) {
        if (list.length < 2) continue;
        list.sort((a, b) => b.iid - a.iid).slice(1).forEach((c) => moveCard(game, c, 'graveyard')); // CR 704.5j
        log(game, `👑 Regla de leyenda: ${p.name} conserva un solo ${name} (CR 704.5j).`);
        changed = true;
      }
      for (const zone of ['graveyard', 'exile']) {
        for (const c of [...p[zone]]) {
          if (!c.isCommander) continue;
          p[zone].splice(p[zone].indexOf(c), 1); // CR 903.9a
          p.command.push(c);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

export function eliminate(game, p, reason) {
  if (!p.alive) return;
  p.alive = false;
  p.stats.eliminatedTurn = game.turn;
  p.stats.eliminatedReason = reason;
  for (const c of p.battlefield) game.combat?.remove(c);
  p.battlefield = []; // CR 800.4a
  game.stack = game.stack.filter((it) => it.controller !== p);
  log(game, `☠️ ${p.name} pierde: ${reason}.`);
  const alive = game.players.filter((x) => x.alive);
  if (alive.length === 1 && game.winner == null) {
    game.winner = alive[0].idx;
    snapshotLife(game, 'Final');
    log(game, `🏆 ¡${alive[0].name} gana la partida! (CR 104.2a)`);
  }
}

// ---------- Prioridad (CR 117) ----------

/** Opciones a velocidad de instantáneo (para decidir si vale la pena detenerse). */
export function instantOptions(game, p) {
  const spells = [...p.hand, ...p.command].filter((c) => {
    if (!isInstantSpeed(c) || isLand(c) || castBlockReason(game, p, c) || !canPay(game, p, c)) return false;
    const spec = targetSpec(c);
    return !spec || legalTargets(game, p, spec).length > 0;
  });
  const abilities = p.battlefield.filter((c) => activatedAbilities(game, p, c).length);
  return spells.length + abilities.length;
}

/** ¿Debe detenerse un humano para recibir prioridad? (paradas inteligentes) */
function humanWantsPriority(game, p) {
  if (p.autoPassTurn === game.turnId) return false;
  if (game.active === p.idx && MAIN_STEPS.includes(game.step) && !game.stack.length) return true;
  if (!instantOptions(game, p)) return false;
  if (game.settings.fullStops) return true;
  const top = game.stack[game.stack.length - 1];
  if (top && top.controller !== p) return true;
  if (game.step === 'declareAttackers' && game.combat?.attacks.some((a) => a.defender === p)) return true;
  if (game.step === 'end' && game.active !== p.idx) return true;
  return false;
}

async function getPriorityAction(game, p, io) {
  if (aiControlled(game, p)) return aiPriorityAction(game, p);
  if (!humanWantsPriority(game, p)) return PASS;
  const error = p.lastError;
  p.lastError = null;
  const act = (await io.decide(p, { kind: 'priority', step: game.step, error, stack: game.stack.length })) || PASS;
  if (act.type === 'passTurn') {
    p.autoPassTurn = game.turnId;
    return PASS;
  }
  if (act.type === 'aiForMe') {
    p.aiTurn = game.turnId;
    return aiPriorityAction(game, p);
  }
  return act;
}

async function performAction(game, p, act, io) {
  const find = (zones) => {
    for (const z of zones) {
      const c = p[z].find((x) => x.iid === act.iid);
      if (c) return c;
    }
    return null;
  };
  if (act.type === 'land') {
    const c = find(['hand']);
    return c ? playLand(game, p, c) : { ok: false, reason: 'Carta no encontrada.' };
  }
  if (act.type === 'cast') {
    const c = find(['hand', 'command']);
    return c ? castSpell(game, p, c, io, { x: act.x || 0, target: act.target }) : { ok: false, reason: 'Carta no encontrada.' };
  }
  if (act.type === 'activate') {
    const c = find(['battlefield']);
    return c ? activateAbility(game, p, c, act.index || 0, io) : { ok: false, reason: 'Permanente no encontrado.' };
  }
  return { ok: false, reason: 'Acción desconocida.' };
}

/**
 * Ronda de prioridad: empieza el jugador activo (CR 117.3a). Si todos pasan en sucesión con la pila
 * vacía, termina el paso (CR 500.2); si la pila tiene algo, se resuelve el objeto de arriba (CR 117.4).
 */
export async function priorityLoop(game, io) {
  const n = game.players.length;
  let passes = 0;
  let cur = game.active;
  for (let guard = 0; guard < 3000; guard++) {
    if (game.winner != null || game.aborted) return;
    const alive = game.players.filter((x) => x.alive).length;
    if (passes >= alive) {
      if (!game.stack.length) return;
      await resolveTop(game, io);
      passes = 0;
      cur = game.active; // CR 117.3b
      continue;
    }
    const pl = game.players[cur];
    if (!pl.alive) {
      cur = (cur + 1) % n;
      continue;
    }
    const act = await getPriorityAction(game, pl, io);
    if (!act || act.type === 'pass') {
      passes++;
      cur = (cur + 1) % n;
      continue;
    }
    const res = await performAction(game, pl, act, io);
    if (res.ok) {
      passes = 0; // CR 117.3c: quien actúa recibe prioridad de nuevo
      await flushTriggers(game, io);
    } else if (aiControlled(game, pl)) {
      passes++;
      cur = (cur + 1) % n;
    } else {
      pl.lastError = res.reason;
    }
  }
}

// ---------- Estructura del turno (CR 500) ----------

export async function takeTurn(game, io) {
  const p = game.players[game.active];
  // Si el jugador activo pierde a mitad de turno, el turno termina (CR 800.4a)
  const stop = () => {
    if (game.winner != null || game.aborted) return true;
    if (!p.alive) {
      game.stack = [];
      game.combat = null;
      nextTurn(game);
      return true;
    }
    return false;
  };
  game.turnId++;
  snapshotLife(game, p.name);
  for (const pl of game.players) pl.castsThisTurn = [];
  p.landsPlayed = 0;

  // 502 Untap (sin prioridad, CR 502.4)
  setStep(game, 'untap');
  for (const c of p.battlefield) {
    if (!/doesn't untap during/i.test(c.oracle || '')) c.tapped = false; // CR 502.3
    c.sick = false; // CR 302.6
  }
  // 503 Upkeep
  setStep(game, 'upkeep');
  fireTriggers(game, p, /at the beginning of your upkeep, ([^.\n]+)/gi);
  await io.step('UNTAP · UPKEEP', p.name);
  await flushTriggers(game, io);
  await priorityLoop(game, io);
  if (stop()) return;

  // 504 Draw — CR 103.8a / 103.8c
  setStep(game, 'draw');
  const skip = game.players.length === 2 && game.active === game.firstPlayer && p.turnsTaken === 0;
  if (!skip) draw(game, p, 1);
  p.turnsTaken++;
  log(game, `▶ Turno ${game.turn}: ${p.name}${skip ? ' (no roba, CR 103.8a)' : ''}.`);
  await io.step('DRAW', p.name);
  await flushTriggers(game, io);
  await priorityLoop(game, io);
  if (stop()) return;

  // 505 Main 1
  setStep(game, 'main1');
  await priorityLoop(game, io);
  if (stop()) return;

  // 506 Combat
  await combatPhase(game, p, io);
  if (stop()) return;

  // 505 Main 2
  setStep(game, 'main2');
  await priorityLoop(game, io);
  if (stop()) return;

  // 513 End
  setStep(game, 'end');
  fireTriggers(game, p, /at the beginning of your end step, ([^.\n]+)/gi);
  await flushTriggers(game, io);
  await io.step('END STEP', p.name);
  await priorityLoop(game, io);
  if (stop()) return;

  // 514 Cleanup
  await cleanup(game, p, io);
  nextTurn(game);
}

async function cleanup(game, p, io) {
  setStep(game, 'cleanup');
  const noMax = p.battlefield.some((c) => /you have no maximum hand size/i.test(c.oracle || ''));
  const excess = noMax ? 0 : p.hand.length - MAX_HAND;
  if (excess > 0 && p.alive) {
    let chosen = [];
    if (!aiControlled(game, p)) {
      const ids = await io.decide(p, { kind: 'discard', n: excess });
      chosen = (Array.isArray(ids) ? ids : []).map((id) => p.hand.find((c) => c.iid === id)).filter(Boolean).slice(0, excess);
    }
    if (chosen.length < excess) chosen.push(...aiDiscard(p, excess).filter((c) => !chosen.includes(c)).slice(0, excess - chosen.length));
    for (const c of chosen) moveCard(game, c, 'graveyard');
    log(game, `🗑 ${p.name} descarta ${excess} (CR 514.1).`);
  }
  for (const pl of game.players) {
    for (const c of pl.battlefield) {
      c.damage = 0; // CR 514.2
      c.deathtouched = false;
      c.tempP = c.tempT = 0;
    }
  }
}

function nextTurn(game) {
  const n = game.players.length;
  let next = game.active;
  for (let i = 0; i < n; i++) {
    next = (next + 1) % n;
    if (next === game.firstPlayer) game.turn++;
    if (game.players[next].alive) break;
  }
  game.active = next;
  setStep(game, 'untap');
}

// ---------- Combate (CR 506–511) ----------

export function canAttack(game, c) {
  return (
    isCreature(c) && !c.tapped && (!c.sick || has(c, 'haste')) && !has(c, 'defender') && // CR 508.1a, 302.6, 702.3b
    power(game, c) > 0 && !/can't attack/i.test(c.oracle || '')
  );
}

export function canBlock(game, blocker, attacker) {
  if (!isCreature(blocker) || blocker.tapped) return false; // CR 509.1a
  if (/can't block/i.test(blocker.oracle || '')) return false;
  if (has(attacker, 'flying') && !has(blocker, 'flying') && !has(blocker, 'reach')) return false; // CR 702.9b
  if (/can't be blocked/i.test(attacker.oracle || '') && !/can't be blocked except/i.test(attacker.oracle || '')) return false;
  if (has(attacker, 'forestwalk') && game.players[blocker.owner].battlefield.some((l) => /Forest/.test(l.typeLine))) return false; // CR 702.14
  return true;
}

/** Limpia bloqueos ilegales (CR 509.1b-c): menace (702.111b) exige 2+ bloqueadores. */
export function validateBlocks(game, blocks) {
  const used = new Set();
  const clean = new Map();
  for (const [a, list] of blocks) {
    const legal = list.filter((b) => !used.has(b) && canBlock(game, b, a));
    if (has(a, 'menace') && legal.length === 1) continue;
    if (!legal.length) continue;
    legal.forEach((b) => used.add(b));
    clean.set(a, legal);
  }
  return clean;
}

class Combat {
  constructor(attacker) {
    this.attackingPlayer = attacker;
    this.attacks = []; // { attacker, defender, blockers: [], blocked: false }
    this.dealtFirst = new Set();
  }
  remove(card) {
    this.attacks = this.attacks.filter((a) => a.attacker !== card);
    for (const a of this.attacks) a.blockers = a.blockers.filter((b) => b !== card);
  }
}

/** Declara el ataque a partir de un plan. Exportada para tests y para la UI manual. */
export async function declareAttack(game, p, plan, io) {
  const legal = plan.filter(({ attacker, defender }) => attacker && defender && canAttack(game, attacker) && defender.alive && defender !== p);
  if (!legal.length) return false;
  const combat = new Combat(p);
  game.combat = combat;
  for (const { attacker, defender } of legal) {
    if (!has(attacker, 'vigilance')) attacker.tapped = true; // CR 508.1f
    combat.attacks.push({ attacker, defender, blockers: [], blocked: false });
  }
  const targets = [...new Set(legal.map((a) => a.defender.name))].join(', ');
  log(game, `⚔️ ${p.name} ataca con ${legal.length} criatura${legal.length > 1 ? 's' : ''} → ${targets} (CR 508).`);
  for (const a of combat.attacks) {
    const nm = escRe(a.attacker.name);
    for (const m of (a.attacker.oracle || '').matchAll(new RegExp(`whenever ${nm} attacks, ([^.\\n]+)`, 'gi'))) {
      resolveText(game, p, m[1], { source: a.attacker, defender: a.defender }); // CR 508.3a
    }
  }
  fireTriggers(game, p, /whenever (?:a|another) creature you control attacks, ([^.\n]+)/gi, { defender: legal[0].defender });
  fireTriggers(game, p, /whenever you attack, ([^.\n]+)/gi, { defender: legal[0].defender });
  await io.step('COMBAT', `${p.name} → ${targets}`);
  return true;
}

export async function combatPhase(game, p, io) {
  // 507 Beginning of combat
  setStep(game, 'beginCombat');
  fireTriggers(game, p, /at the beginning of combat on your turn, ([^.\n]+)/gi);
  await flushTriggers(game, io);
  await priorityLoop(game, io);
  if (game.winner != null || game.aborted) return;

  // 508 Declare attackers
  setStep(game, 'declareAttackers');
  const eligible = p.battlefield.filter((c) => canAttack(game, c));
  let plan = [];
  if (eligible.length && opponents(game, p).length) {
    if (aiControlled(game, p)) plan = aiPlanAttacks(game, p);
    else {
      const v = await io.decide(p, {
        kind: 'attackers',
        attackers: eligible.map((c) => c.iid),
        defenders: opponents(game, p).map((o) => o.idx),
      });
      plan = (Array.isArray(v) ? v : []).map((x) => ({
        attacker: eligible.find((c) => c.iid === x.attacker),
        defender: game.players[x.defender],
      }));
    }
  }
  const attacked = await declareAttack(game, p, plan, io);
  if (!attacked) {
    setStep(game, 'endCombat'); // CR 508.8: sin atacantes se saltan bloqueos y daño
    game.combat = null;
    return;
  }
  await flushTriggers(game, io);
  await priorityLoop(game, io);
  if (game.winner != null || game.aborted || !game.combat?.attacks.length) return endCombat(game, io);

  // 509 Declare blockers
  setStep(game, 'declareBlockers');
  await declareBlocks(game, p, io);
  await priorityLoop(game, io);
  if (game.winner != null || game.aborted) return;

  // 510 Combat damage
  setStep(game, 'combatDamage');
  const combat = game.combat;
  if (combat) {
    const fs = (c) => has(c, 'first strike') || has(c, 'double strike');
    const anyFirst = combat.attacks.some((a) => fs(a.attacker) || a.blockers.some(fs));
    if (anyFirst) {
      const s = dealCombatDamage(game, combat, 'first'); // CR 510.4
      await io.step('FIRST STRIKE', s);
      await flushTriggers(game, io);
      await priorityLoop(game, io);
    }
    if (game.combat && game.winner == null) {
      const s = dealCombatDamage(game, game.combat, anyFirst ? 'regular' : 'only');
      await flushTriggers(game, io);
      await io.step('DAMAGE', s);
      await priorityLoop(game, io);
    }
  }
  await endCombat(game, io);
}

async function endCombat(game, io) {
  setStep(game, 'endCombat'); // CR 511
  if (game.winner == null && !game.aborted) await priorityLoop(game, io);
  game.combat = null;
}

async function declareBlocks(game, p, io) {
  const combat = game.combat;
  const summary = [];
  const n = game.players.length;
  for (let k = 1; k < n; k++) {
    const d = game.players[(p.idx + k) % n]; // APNAP
    if (!d.alive) continue;
    const mine = combat.attacks.filter((a) => a.defender === d);
    if (!mine.length) continue;
    const atks = mine.map((a) => a.attacker);
    let raw;
    if (aiControlled(game, d)) raw = aiChooseBlocks(game, d, atks);
    else {
      const options = atks.map((a) => ({
        attacker: a.iid,
        menace: has(a, 'menace'),
        blockers: d.battlefield.filter((b) => canBlock(game, b, a)).map((b) => b.iid),
      }));
      raw = new Map();
      if (options.some((o) => o.blockers.length)) {
        const v = await io.decide(d, { kind: 'blockers', options });
        for (const x of Array.isArray(v) ? v : []) {
          const a = atks.find((c) => c.iid === x.attacker);
          const bs = (x.blockers || []).map((id) => d.battlefield.find((c) => c.iid === id)).filter(Boolean);
          if (a && bs.length) raw.set(a, bs);
        }
      }
    }
    const blocks = validateBlocks(game, raw);
    for (const a of mine) {
      a.blockers = blocks.get(a.attacker) || [];
      a.blocked = a.blockers.length > 0; // CR 509.1h
    }
    if (blocks.size) summary.push(`${d.name} bloquea ${blocks.size}`);
  }
  if (summary.length) {
    log(game, `🛡 ${summary.join(' · ')} (CR 509).`);
    await io.step('BLOCKERS', summary.join(' · '));
  }
}

function dealsInStage(c, stage, dealtFirst) {
  const f = has(c, 'first strike');
  const d = has(c, 'double strike');
  if (stage === 'only') return true;
  if (stage === 'first') return f || d;
  return d || (!f && !dealtFirst.has(c)); // CR 510.4
}

/** Asigna y reparte el daño de combate simultáneamente (CR 510.1–510.2). */
export function dealCombatDamage(game, combat, stage) {
  const events = [];
  for (const a of combat.attacks) {
    const atk = a.attacker;
    const atkP = power(game, atk);
    if (dealsInStage(atk, stage, combat.dealtFirst) && atkP > 0) {
      if (!a.blocked) events.push({ source: atk, target: a.defender, amount: atkP });
      else if (a.blockers.length === 0) {
        if (has(atk, 'trample')) events.push({ source: atk, target: a.defender, amount: atkP }); // CR 702.19e
      } else {
        let left = atkP; // CR 510.1c-d
        const sorted = [...a.blockers].sort((x, y) => toughness(game, x) - x.damage - (toughness(game, y) - y.damage));
        sorted.forEach((b, i) => {
          const lethal = has(atk, 'deathtouch') ? 1 : Math.max(0, toughness(game, b) - b.damage); // CR 702.2c
          const last = i === sorted.length - 1;
          const amt = last && !has(atk, 'trample') ? left : Math.min(left, lethal);
          if (amt > 0) events.push({ source: atk, target: b, amount: amt });
          left -= amt;
        });
        if (left > 0 && has(atk, 'trample')) events.push({ source: atk, target: a.defender, amount: left });
      }
      if (stage === 'first') combat.dealtFirst.add(atk);
    }
    for (const b of a.blockers) {
      if (dealsInStage(b, stage, combat.dealtFirst) && power(game, b) > 0) events.push({ source: b, target: atk, amount: power(game, b) });
      if (stage === 'first' && (has(b, 'first strike') || has(b, 'double strike'))) combat.dealtFirst.add(b);
    }
  }

  const toPlayers = new Map();
  for (const ev of events) {
    const src = ev.source;
    const ctrl = game.players[src.owner];
    if (ev.target.life !== undefined && ev.target.library) {
      const pl = ev.target;
      if (has(src, 'infect')) pl.poison += ev.amount; // CR 702.90b
      else pl.life -= ev.amount;
      if ((src.keywords || []).some((k) => /^toxic/i.test(k))) pl.poison += parseInt((src.oracle || '').match(/Toxic (\d+)/i)?.[1] || '1', 10); // CR 702.164
      if (src.isCommander) pl.commanderDamage[src.iid] = (pl.commanderDamage[src.iid] || 0) + ev.amount; // CR 903.10a
      creditDamage(game, src.owner, src.isToken ? 'Tokens' : src.name, ev.amount, true);
      toPlayers.set(pl.name, (toPlayers.get(pl.name) || 0) + ev.amount);
      for (const m of (src.oracle || '').matchAll(/whenever [^,]*? deals combat damage to a player, ([^.\n]+)/gi)) {
        resolveText(game, ctrl, m[1], { source: src, defender: pl });
      }
    } else {
      const c = ev.target;
      if (has(src, 'infect') || has(src, 'wither')) c.counters.m1 += ev.amount; // CR 702.80, 702.90c
      else c.damage += ev.amount;
      if (has(src, 'deathtouch')) c.deathtouched = true; // CR 702.2b
    }
    if (has(src, 'lifelink')) {
      ctrl.life += ev.amount; // CR 702.15b
      ctrl.stats.lifeGained += ev.amount;
    }
  }
  runSBA(game);
  const parts = [...toPlayers].map(([n, d]) => `${n} −${d}`);
  const s = parts.length ? parts.join(', ') : 'sin daño a jugadores';
  log(game, `💥 Daño de combate${stage === 'first' ? ' (first strike)' : ''}: ${s}.`);
  return s;
}

// ---------- IA ----------

function aiDiscard(p, n) {
  const lands = p.hand.filter(isLand).length;
  return [...p.hand]
    .sort((a, b) => (lands >= 5 ? Number(isLand(b)) - Number(isLand(a)) : 0) || (b.cmc || 0) - (a.cmc || 0))
    .slice(0, n);
}

export function aiChooseBlocks(game, d, attackers) {
  const blocks = new Map();
  const used = new Set();
  const incoming = attackers.reduce((n, a) => n + power(game, a), 0);
  const desperate = incoming >= d.life || attackers.some((a) => a.isCommander && (d.commanderDamage[a.iid] || 0) + power(game, a) >= COMMANDER_DAMAGE_LETHAL);
  for (const a of [...attackers].sort((x, y) => power(game, y) - power(game, x))) {
    const ap = power(game, a);
    const at = toughness(game, a);
    const cands = d.battlefield
      .filter((b) => !used.has(b) && canBlock(game, b, a))
      .map((b) => {
        const survives = toughness(game, b) > ap && !has(a, 'deathtouch');
        const kills = power(game, b) >= at || has(b, 'deathtouch');
        const goodTrade = kills && (b.cmc || 0) <= (a.cmc || 0) && !b.isCommander;
        return { b, score: (survives ? 3 : 0) + (kills ? 2 : 0) + (goodTrade ? 1 : 0), ok: survives || goodTrade || desperate };
      })
      .filter((x) => x.ok)
      .sort((x, y) => y.score - x.score || (x.b.cmc || 0) - (y.b.cmc || 0));
    const need = has(a, 'menace') ? 2 : 1;
    if (cands.length >= need) {
      const chosen = cands.slice(0, need).map((x) => x.b);
      chosen.forEach((b) => used.add(b));
      blocks.set(a, chosen);
    }
  }
  return blocks;
}

function aiPlanAttacks(game, p) {
  const attackers = p.battlefield.filter((c) => canAttack(game, c));
  const target = weakestOpponent(game, p);
  if (!attackers.length || !target) return [];
  const lethal = attackers.reduce((n, c) => n + power(game, c), 0) >= target.life;
  return attackers
    .filter((a) => {
      if (lethal || has(a, 'flying') || has(a, 'menace')) return true;
      const blockers = target.battlefield.filter((b) => canBlock(game, b, a));
      return !blockers.some((b) => power(game, b) >= toughness(game, a) && toughness(game, b) > power(game, a));
    })
    .filter((a, i, arr) => p.life > 12 || arr.length < 2 || i > 0)
    .map((attacker) => ({ attacker, defender: target }));
}

function castScore(game, p, c) {
  const t = (c.oracle || '').toLowerCase();
  let s = c.cmc || 0;
  if (/add \{|search your library for .*land|create (a|one|two|\w+) treasure/.test(t)) s += 6;
  if (c.isCommander) s += 4;
  if (/destroy all|exile all|all creatures get -/.test(t)) {
    const mine = p.battlefield.filter(isCreature).length;
    const theirs = opponents(game, p).reduce((n, o) => n + o.battlefield.filter(isCreature).length, 0);
    s = theirs >= mine + 3 ? s + 5 : -100;
  }
  const spec = targetSpec(c);
  if (spec) {
    if (spec.type === 'spell') return -100; // contrahechizos: se guardan para responder
    const legal = legalTargets(game, p, spec);
    if (!aiChooseTarget(game, p, spec, legal)) return -100;
    if (isInstantSpeed(c) && spec.type !== 'player' && game.step === 'main1') return -100; // reservar removal instantáneo
  }
  // Evitar pagar impuestos absurdos (Rhystic Study, Thalia…) si deja sin maná para nada más
  return s;
}

function aiWantsCounter(game, p, item) {
  const c = item.card;
  const t = (c.oracle || '').toLowerCase();
  const wipeHurtsMe = /destroy all|exile all/.test(t) && p.battlefield.filter(isCreature).length >= 2;
  const targetsMe = item.target && ((item.target.type === 'player' && item.target.idx === p.idx) ||
    (item.target.type === 'card' && findCard(game, item.target.iid)?.card.owner === p.idx));
  return c.isCommander || (c.cmc || 0) >= 5 || wipeHurtsMe || targetsMe || /extra turn/.test(t);
}

/** Decide una acción de prioridad para la IA (CR 117). */
export function aiPriorityAction(game, p) {
  const top = game.stack[game.stack.length - 1];
  if (top) {
    if (top.controller !== p && top.kind === 'spell' && aiWantsCounter(game, p, top)) {
      const counter = p.hand.find((c) => {
        const spec = targetSpec(c);
        return spec?.type === 'spell' && counterMatches(spec.kind, top.card) && !castBlockReason(game, p, c) && canPay(game, p, c);
      });
      if (counter) return { type: 'cast', iid: counter.iid, target: { type: 'stack', id: top.id } };
    }
    return PASS;
  }
  const myMain = game.active === p.idx && MAIN_STEPS.includes(game.step);
  if (myMain) {
    if (p.landsPlayed === 0) {
      const land = p.hand.filter(isLand).sort((a, b) => Number(/enters.*tapped/i.test(a.oracle)) - Number(/enters.*tapped/i.test(b.oracle)))[0];
      if (land) return { type: 'land', iid: land.iid };
    }
    if (game.step === 'main1') {
      for (const c of p.battlefield) {
        if (activatedAbilities(game, p, c).length) return { type: 'activate', iid: c.iid, index: 0 };
      }
    }
    const best = [...p.hand.filter((c) => !isLand(c)), ...p.command]
      .filter((c) => !castBlockReason(game, p, c) && canPay(game, p, c))
      .map((c) => ({ c, score: castScore(game, p, c) }))
      .filter((o) => o.score > -50)
      .sort((a, b) => b.score - a.score)[0];
    if (best) return { type: 'cast', iid: best.c.iid };
    return PASS;
  }
  // Fuera de su fase principal: removal instantáneo contra atacantes, o hechizos al final del turno rival
  if (game.step === 'declareAttackers' && game.combat?.attacks.some((a) => a.defender === p)) {
    const attackers = game.combat.attacks.filter((a) => a.defender === p).map((a) => a.attacker);
    const threat = attackers.sort((a, b) => threatScore(game, b) - threatScore(game, a))[0];
    if (threat && (power(game, threat) >= 3 || threat.isCommander)) {
      const removal = p.hand.find((c) => {
        const spec = targetSpec(c);
        return isInstantSpeed(c) && spec?.type !== 'spell' && spec?.type !== 'player' && spec &&
          !castBlockReason(game, p, c) && canPay(game, p, c) &&
          legalTargets(game, p, spec).some((r) => r.type === 'card' && r.iid === threat.iid) &&
          (spec.amount == null || num(spec.amount) >= toughness(game, threat) - threat.damage);
      });
      if (removal) return { type: 'cast', iid: removal.iid, target: { type: 'card', iid: threat.iid } };
    }
  }
  if (game.step === 'end' && game.active !== p.idx) {
    const flashy = p.hand.find((c) => isInstantSpeed(c) && !targetSpec(c) && !castBlockReason(game, p, c) && canPay(game, p, c));
    if (flashy) return { type: 'cast', iid: flashy.iid };
  }
  return PASS;
}
