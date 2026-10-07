// Motor de Commander basado en las Reglas Completas de Magic (Comprehensive Rules).
// Los números "CR x.y" en los comentarios y en el registro apuntan a la regla correspondiente.
// Ver docs/REGLAS.md para la lista de lo implementado y lo aproximado.
//
// La interfaz `io` la provee la UI:
//   io.step(label, detail)                 -> Promise  (animación / pausa)
//   io.chooseBlocks(game, defender, atks)  -> Promise<Map<atk, blocker[]>>   (solo humanos)
//   io.respond(game, player, ctx, options) -> Promise<card|null>             (solo humanos)
//   io.chooseDiscard(game, player, n)      -> Promise<card[]>                (solo humanos)

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

let iidSeq = 0;

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, x: 0 };
const num = (s, x = 0) => (String(s).toLowerCase() === 'x' ? x : (NUM[String(s).toLowerCase()] ?? (parseInt(s, 10) || 1)));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const has = (c, kw) => (c.keywords || []).some((k) => k.toLowerCase() === kw);
export const isInstantOrSorcery = (c) => /\b(Instant|Sorcery)\b/.test(c.typeLine);
export const isPermanentCard = (c) => !isInstantOrSorcery(c);
const isLegendary = (c) => /\bLegendary\b/.test(c.typeLine);
const isPlaneswalker = (c) => /\bPlaneswalker\b/.test(c.typeLine);
const subtypes = (c) => (c.typeLine.split('—')[1] || '').trim().split(/\s+/).filter(Boolean);

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
      img: null,
      imgSmall: null,
    },
    owner,
    { isToken: true }
  );
}

/** Fuerza/resistencia actuales: base + contadores (CR 122) + efectos estáticos de "lords" (CR 613.4c). */
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
  const ctrl = game.players[c.owner];
  for (const src of ctrl?.battlefield || []) {
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
export function createGame(configs) {
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
      commanderDamage: {}, // iid del comandante -> daño de combate recibido (CR 903.10a)
      landsPlayed: 0,
      turnsTaken: 0,
      alive: true,
      drewFromEmpty: false,
      mulligans: 0,
    };
  });

  const game = {
    players,
    active: Math.floor(Math.random() * players.length), // CR 103.1
    firstPlayer: 0,
    turn: 1,
    step: 'untap',
    stack: [],
    pools: players.map(() => []),
    combat: null,
    log: [],
    winner: null,
    banner: null,
    pendingTriggers: [],
  };
  game.firstPlayer = game.active;

  for (const p of players) {
    draw(game, p, 7); // CR 103.4
    if (p.isAI) aiMulligan(game, p);
  }
  log(game, `🎲 ${players[game.active].name} empieza la partida (CR 103.1).`);
  return game;
}

export function log(game, msg) {
  game.log.unshift({ turn: game.turn, msg });
  if (game.log.length > 300) game.log.pop();
}

export function setStep(game, step) {
  game.step = step;
  for (let i = 0; i < game.pools.length; i++) game.pools[i] = []; // CR 106.4: la reserva se vacía
}

export function draw(game, p, n = 1) {
  for (let i = 0; i < n; i++) {
    const c = p.library.shift();
    if (!c) {
      p.drewFromEmpty = true; // CR 704.5b (se revisa como acción basada en estado)
      break;
    }
    p.hand.push(c);
  }
  runSBA(game);
}

/** Mulligan de Londres (CR 103.5). En multijugador el primero es gratis (CR 103.5c). */
export function mulligan(game, p) {
  p.library.push(...p.hand);
  p.hand = [];
  shuffle(p.library);
  p.mulligans++;
  for (let i = 0; i < 7; i++) p.hand.push(p.library.shift());
  const free = game.players.length > 2 ? 1 : 0;
  const toBottom = Math.max(0, p.mulligans - free);
  if (toBottom) {
    const sorted = [...p.hand].sort((a, b) => (b.cmc || 0) - (a.cmc || 0));
    for (const c of sorted.slice(0, toBottom)) moveCard(game, c, 'library', { position: 'bottom' });
  }
  log(game, `🔄 ${p.name} hace mulligan #${p.mulligans}${toBottom ? `, pone ${toBottom} al fondo` : ' (gratis, CR 103.5c)'}.`);
}

function aiMulligan(game, p) {
  for (let tries = 0; tries < 2; tries++) {
    const lands = p.hand.filter(isLand).length;
    if (lands >= 2 && lands <= 5) return;
    mulligan(game, p);
  }
}

export function findCard(game, iid) {
  for (const p of game.players) {
    for (const zone of ['hand', 'battlefield', 'graveyard', 'exile', 'command', 'library']) {
      const i = p[zone].findIndex((c) => c.iid === iid);
      if (i >= 0) return { player: p, zone, index: i, card: p[zone][i] };
    }
  }
  const s = game.stack.findIndex((it) => it.card.iid === iid);
  if (s >= 0) return { player: game.stack[s].controller, zone: 'stack', index: s, card: game.stack[s].card };
  return null;
}

/**
 * Mueve una carta. CR 400.7: al cambiar de zona es un objeto nuevo (se limpian estados).
 * CR 903.9b: si un comandante iría a la biblioteca, su dueño lo pone en la zona de mando.
 * (Cementerio/exilio -> zona de mando ocurre como acción basada en estado, CR 903.9a.)
 */
export function moveCard(game, card, toZone, { position = 'top' } = {}) {
  const loc = findCard(game, card.iid);
  if (!loc) return;
  const fromBattlefield = loc.zone === 'battlefield';
  if (loc.zone === 'stack') game.stack.splice(loc.index, 1);
  else loc.player[loc.zone].splice(loc.index, 1);

  if (fromBattlefield && toZone === 'graveyard' && isCreature(card)) {
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

// ---------- Maná ----------

export function sourcesOf(p) {
  return manaSources(p, p.commanderCI.length ? p.commanderCI : []);
}

export function costOf(p, card) {
  const cost = parseCost(card.manaCost);
  if (p.command.includes(card)) cost.generic += p.commanderTax[card.iid] || 0;
  return cost;
}

export function canPay(game, p, card, x = 0) {
  return planPayment(sourcesOf(p), game.pools[p.idx], costOf(p, card), { x, life: p.life }).ok;
}

function pay(game, p, cost, x) {
  const plan = planPayment(sourcesOf(p), game.pools[p.idx], cost, { x, life: p.life });
  if (!plan.ok) return false;
  plan.used.forEach((s) => (s.tapped = true));
  game.pools[p.idx] = plan.pool;
  if (plan.lifePaid) p.life -= plan.lifePaid;
  return true;
}

export function availableMana(p) {
  return sourcesOf(p).reduce((n, s) => n + Math.max(...s.options.map((o) => o.length)), 0);
}

// ---------- Tiempos (timing) ----------

const sorcerySpeedOK = (game, p) =>
  game.active === p.idx && (game.step === 'main1' || game.step === 'main2') && game.stack.length === 0;

/** Razón por la que no se puede lanzar (o null). CR 117.1a, 307.1, 301.1, 601.3, 903.8 */
export function castBlockReason(game, p, card) {
  if (isLand(card)) return 'Las tierras se juegan, no se lanzan (CR 305.9).';
  if (!p.hand.includes(card) && !p.command.includes(card)) return 'Solo puedes lanzar desde la mano o la zona de mando (CR 601.3).';
  const instantSpeed = /\bInstant\b/.test(card.typeLine) || has(card, 'flash');
  if (!instantSpeed && !sorcerySpeedOK(game, p))
    return 'Velocidad de conjuro: solo en tu fase principal con la pila vacía (CR 307.1).';
  return null;
}

export function landBlockReason(game, p, card) {
  if (!isLand(card)) return 'No es una tierra.';
  if (!p.hand.includes(card)) return 'La tierra debe estar en tu mano.';
  if (!sorcerySpeedOK(game, p)) return 'Solo en tu fase principal con la pila vacía (CR 305.2/116.2a).';
  if (p.landsPlayed >= 1) return 'Ya jugaste una tierra este turno (CR 305.2).';
  return null;
}

// ---------- Acciones ----------

export function playLand(game, p, card) {
  const why = landBlockReason(game, p, card);
  if (why) return { ok: false, reason: why };
  moveCard(game, card, 'battlefield'); // CR 305.1: jugar tierra no usa la pila
  if (/enters( the battlefield)? tapped/i.test(card.oracle || '') && !/unless/i.test(card.oracle || '')) card.tapped = true;
  p.landsPlayed++;
  log(game, `🌲 ${p.name} juega ${card.name}.`);
  return { ok: true };
}

/**
 * Lanza un hechizo usando la pila (CR 601, 405) y abre una ronda de prioridad (CR 117).
 * @returns {Promise<{ok:boolean, reason?:string, countered?:boolean, effects?:string[]}>}
 */
export async function castSpell(game, p, card, io, { x = 0, free = false, ctx = null } = {}) {
  const why = castBlockReason(game, p, card);
  if (why) return { ok: false, reason: why };
  const fromCommand = p.command.includes(card);
  if (!free && !pay(game, p, costOf(p, card), x)) return { ok: false, reason: 'Maná insuficiente o de colores incorrectos (CR 601.2h).' };
  if (fromCommand) p.commanderTax[card.iid] = (p.commanderTax[card.iid] || 0) + 2;

  // Mover a la pila
  const loc = findCard(game, card.iid);
  loc.player[loc.zone].splice(loc.index, 1);
  const item = { card, controller: p, x, ctx, countered: false };
  game.stack.push(item);
  log(game, `✨ ${p.name} lanza ${card.name}${fromCommand ? ' desde la zona de mando (impuesto CR 903.8)' : ''}.`);
  await io.step(card.isCommander ? 'COMMANDER' : 'CAST', `${p.name}: ${card.name}`);

  // Ronda de prioridad: cada otro jugador, en orden de turno, puede responder (CR 117.3d, 405.5)
  await priorityRound(game, p, { type: 'spell', item }, io);

  game.stack.splice(game.stack.indexOf(item), 1);
  if (item.countered) {
    putInZoneFromStack(game, card, 'graveyard'); // CR 701.6a
    log(game, `🚫 ${card.name} fue contrarrestado.`);
    runSBA(game);
    return { ok: true, countered: true, effects: [] };
  }
  const effects = resolve(game, item); // CR 608
  if (effects.length) log(game, `   ↳ ${card.name}: ${effects.join(', ')}.`);
  await flushTriggers(game, io);
  return { ok: true, effects };
}

function putInZoneFromStack(game, card, zone) {
  const owner = game.players[card.owner];
  if (card.isToken) return;
  if (zone === 'battlefield') card.sick = true;
  owner[zone].push(card);
}

function resolve(game, item) {
  const { card, controller: p, x } = item;
  if (isInstantOrSorcery(card)) {
    const out = resolveText(game, p, card.oracle || '', { source: card, x, ctx: item.ctx });
    putInZoneFromStack(game, card, 'graveyard'); // CR 608.2n
    runSBA(game);
    return out;
  }
  putInZoneFromStack(game, card, 'battlefield'); // CR 608.3
  if (has(card, 'haste')) card.sick = false;
  const etb = (card.oracle || '')
    .split('\n')
    .filter((l) => /^when(ever)? .* enters/i.test(l))
    .map((l) => l.replace(/^when(ever)? [^,]* enters[^,]*, /i, ''))
    .join('\n');
  const out = etb ? resolveText(game, p, etb, { source: card, x }) : [];
  runSBA(game);
  return out;
}

async function priorityRound(game, caster, ctx, io) {
  const n = game.players.length;
  for (let k = 1; k < n; k++) {
    const r = game.players[(caster.idx + k) % n];
    if (!r.alive) continue;
    const options = responseOptions(game, r, ctx);
    if (!options.length) continue;
    const pick = r.isAI ? aiPickResponse(game, r, ctx, options) : await io.respond(game, r, ctx, options);
    if (!pick) continue;
    await castSpell(game, r, pick, io, { ctx });
    if (ctx.type === 'spell' && ctx.item.countered) return;
  }
}

/** Respuestas posibles: instantáneos/destello pagables y relevantes al contexto. */
export function responseOptions(game, p, ctx) {
  return p.hand.filter((c) => {
    if (!(/\bInstant\b/.test(c.typeLine) || has(c, 'flash')) || !canPay(game, p, c)) return false;
    const t = (c.oracle || '').toLowerCase();
    if (ctx.type === 'spell') return counterMatches(t, ctx.item.card) && ctx.item.controller !== p;
    if (ctx.type === 'attack') return /(destroy|exile) target (creature|attacking creature|nonland permanent|permanent)|deals? \d+ damage to (any target|target creature|target attacking creature)/.test(t);
    return false;
  });
}

function counterMatches(t, target) {
  const m = t.match(/counter target ([a-z ,]*?)spell/);
  if (!m) return false;
  const kind = m[1].trim();
  if (!kind) return true;
  if (kind.includes('noncreature')) return !isCreature(target);
  if (kind.includes('creature')) return isCreature(target);
  if (kind.includes('instant or sorcery')) return isInstantOrSorcery(target);
  return true;
}

// ---------- Selección de objetivos ----------

const targetable = (c) => !has(c, 'hexproof') && !has(c, 'shroud'); // CR 702.11, 702.18

function targetFilter(kind) {
  kind = kind.toLowerCase();
  return (c) => {
    if (kind.includes('nonland')) return !isLand(c);
    if (kind.includes('creature') && isCreature(c)) return true;
    if (kind.includes('artifact') && /Artifact/.test(c.typeLine)) return true;
    if (kind.includes('enchantment') && /Enchantment/.test(c.typeLine)) return true;
    if (kind.includes('planeswalker') && isPlaneswalker(c)) return true;
    return kind.trim() === 'permanent';
  };
}

function threatScore(game, c) {
  return (isCreature(c) ? power(game, c) + toughness(game, c) : 2) + (c.isCommander ? 8 : 0) + (c.cmc || 0);
}

function bestTarget(game, p, kind, { among = null } = {}) {
  let best = null;
  const pool = among || opponents(game, p).flatMap((o) => o.battlefield);
  for (const c of pool) {
    if (!targetable(c) || !targetFilter(kind)(c)) continue;
    const s = threatScore(game, c);
    if (!best || s > best.s) best = { c, s };
  }
  return best?.c || null;
}

export function opponents(game, p) {
  return game.players.filter((o) => o !== p && o.alive);
}

function weakestOpponent(game, p) {
  return opponents(game, p).sort((a, b) => a.life - b.life || Math.random() - 0.5)[0];
}

// ---------- Resolución de texto ----------

/** Resuelve los efectos más comunes leyendo el texto Oracle. */
export function resolveText(game, p, text, { source = null, x = 0, ctx = null, defender = null } = {}) {
  const t = text.toLowerCase();
  const out = [];
  let m;

  // Contrarrestar (CR 701.6)
  if (/counter target [a-z ,]*spell/.test(t) && ctx?.type === 'spell' && game.stack.includes(ctx.item)) {
    ctx.item.countered = true;
    out.push(`contrarresta ${ctx.item.card.name}`);
  }

  // Board wipes
  if ((m = t.match(/(destroy|exile) all (creatures|nonland permanents|artifacts|enchantments)/))) {
    const filt = targetFilter(m[2]);
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

  // Removal puntual (en combate apunta al atacante más peligroso)
  if ((m = t.match(/(destroy|exile) target ((?:attacking |nonland |nontoken )?(?:creature or planeswalker|artifact or enchantment|artifact or creature|creature|artifact|enchantment|planeswalker|permanent))/))) {
    const among = ctx?.type === 'attack' ? ctx.attackers : null;
    const target = bestTarget(game, p, m[2], { among });
    if (target) {
      if (m[1] === 'destroy' && has(target, 'indestructible')) out.push(`${target.name} es indestructible`);
      else {
        moveCard(game, target, m[1] === 'exile' ? 'exile' : 'graveyard');
        out.push(`${m[1] === 'exile' ? 'exilia' : 'destruye'} ${target.name}`);
      }
    }
  }

  // Daño
  if ((m = t.match(/deals? (\d+|x) damage to each opponent/))) {
    const n = num(m[1], x);
    for (const o of opponents(game, p)) o.life -= n;
    out.push(`${n} de daño a cada oponente`);
  } else if ((m = t.match(/deals? (\d+|x) damage to the player or planeswalker it's attacking/)) && defender) {
    defender.life -= num(m[1], x);
    out.push(`${num(m[1], x)} de daño a ${defender.name}`);
  } else if ((m = t.match(/deals? (\d+|x) damage to (any target|target creature|target attacking creature|target player|target opponent)/))) {
    const n = num(m[1], x);
    const among = ctx?.type === 'attack' ? ctx.attackers : null;
    const kill = m[2].includes('player') || m[2].includes('opponent')
      ? null
      : (among || opponents(game, p).flatMap((o) => o.battlefield)).filter(
          (c) => isCreature(c) && targetable(c) && toughness(game, c) - c.damage <= n
        ).sort((a, b) => threatScore(game, b) - threatScore(game, a))[0];
    if (kill) {
      kill.damage += n;
      out.push(`${n} de daño a ${kill.name}`);
    } else if (!m[2].includes('creature')) {
      const o = weakestOpponent(game, p);
      if (o) {
        o.life -= n;
        out.push(`${n} de daño a ${o.name}`);
      }
    }
  }

  // Pérdida de vida / drenaje
  if ((m = t.match(/each opponent loses (\d+) life/))) {
    for (const o of opponents(game, p)) o.life -= +m[1];
    out.push(`cada oponente pierde ${m[1]}`);
  } else if ((m = t.match(/target (?:player|opponent) loses (\d+) life/))) {
    const o = weakestOpponent(game, p);
    if (o) {
      o.life -= +m[1];
      out.push(`${o.name} pierde ${m[1]}`);
    }
  }
  if ((m = t.match(/you gain (\d+) life/))) {
    p.life += +m[1];
    out.push(`+${m[1]} vida`);
  }

  // Sacrificio forzado (Grave Pact y similares). El jugador elige: la IA sacrifica la más débil.
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

  // Ramp: buscar tierras (Cultivate, Rampant Growth, Evolving Wilds…)
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
    out.push(`+1/+1 a tus criaturas`);
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

  runSBA(game);
  return out;
}

const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Crea tokens aplicando efectos de reemplazo (CR 614) como Chatterfang o Parallel Lives. */
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

// ---------- Habilidades activadas sencillas ----------

/** Habilidades "{T}: …" no de maná y fetchlands que el motor sabe resolver. */
export function activatedAbilities(game, p, c) {
  const out = [];
  if (c.tapped || (isCreature(c) && c.sick && !has(c, 'haste'))) return out;
  const text = c.oracle || '';
  let m = text.match(/\{T\}, (?:Pay 1 life, )?Sacrifice [^:]+: (Search your library for [^.]+\.[^.]*\.?)/);
  if (m) out.push({ label: 'Buscar tierra (sacrificar)', sacrifice: true, life: /Pay 1 life/.test(m[0]) ? 1 : 0, text: m[1] });
  for (const mm of text.matchAll(/(?:^|\n)\{T\}: ((?:Create|Draw|Target player|Each opponent|[^.]* deals \d+ damage)[^\n]*)/g)) {
    out.push({ label: mm[1].slice(0, 60), text: mm[1] });
  }
  return out;
}

export async function activate(game, p, c, ability, io) {
  c.tapped = true; // CR 602.2: pagar costes ({T}, vida, sacrificio)
  if (ability.life) p.life -= ability.life;
  if (ability.sacrifice) moveCard(game, c, 'graveyard');
  const effects = resolveText(game, p, ability.text, { source: c });
  log(game, `⚙ ${p.name} activa ${c.name}${effects.length ? ': ' + effects.join(', ') : ''}.`);
  await flushTriggers(game, io);
  return effects;
}

// ---------- Disparadores (CR 603) ----------

function triggerMatches(subject, src, event) {
  let s = subject.toLowerCase().trim();
  const dead = event.card;
  const nm = src.name.toLowerCase();
  if (s === nm || s === 'this creature') return dead.iid === src.iid;
  if (s.startsWith(`${nm} or `)) {
    if (dead.iid === src.iid) return true;
    s = s.slice(nm.length + 4);
  }
  const yours = /you control/.test(s);
  const another = /another/.test(s);
  const nontoken = /nontoken/.test(s);
  if (!/creature/.test(s)) return false;
  if (yours && dead.owner !== src.owner) return false;
  if (another && dead.iid === src.iid) return false;
  if (nontoken && dead.isToken) return false;
  return true;
}

/** Resuelve disparadores pendientes ("dies" y similares) en orden APNAP (CR 603.3b). */
export async function flushTriggers(game, io) {
  for (let guard = 0; guard < 40 && game.pendingTriggers.length; guard++) {
    const ev = game.pendingTriggers.shift();
    const order = game.players.map((_, k) => game.players[(game.active + k) % game.players.length]);
    for (const pl of order) {
      const sources = [...pl.battlefield];
      if (ev.card.owner === pl.idx && !sources.some((s) => s.iid === ev.card.iid)) sources.push(ev.card); // CR 603.10a
      for (const src of sources) {
        for (const m of (src.oracle || '').matchAll(/(?:^|\n|\. )(?:when|whenever) ([^,]*?) dies, ([^.\n]+)/gi)) {
          if (!pl.alive || !triggerMatches(m[1], src, ev)) continue;
          const effects = resolveText(game, pl, m[2], { source: src });
          if (effects.length) log(game, `   ⚡ ${src.name}: ${effects.join(', ')} (CR 603).`);
        }
      }
    }
  }
  runSBA(game);
  void io;
}

function fireTriggers(game, p, pattern, extra = {}) {
  const fired = [];
  for (const src of [...p.battlefield]) {
    for (const m of (src.oracle || '').matchAll(pattern)) {
      const effects = resolveText(game, p, m[m.length - 1], { source: src, ...extra });
      if (effects.length) {
        fired.push(`${src.name}: ${effects.join(', ')}`);
        log(game, `   ⚡ ${src.name}: ${effects.join(', ')}.`);
      }
    }
  }
  return fired;
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
        if (isPlaneswalker(c) && c.counters.loyalty <= 0 && c.loyalty != null) {
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
      // Regla de leyenda (CR 704.5j): se queda la más reciente
      const byName = new Map();
      for (const c of p.battlefield.filter(isLegendary)) {
        if (!byName.has(c.name)) byName.set(c.name, []);
        byName.get(c.name).push(c);
      }
      for (const [name, list] of byName) {
        if (list.length < 2) continue;
        list.sort((a, b) => b.iid - a.iid).slice(1).forEach((c) => moveCard(game, c, 'graveyard'));
        log(game, `👑 Regla de leyenda: ${p.name} conserva un solo ${name} (CR 704.5j).`);
        changed = true;
      }
      // Comandante en cementerio/exilio -> zona de mando (CR 903.9a)
      for (const zone of ['graveyard', 'exile']) {
        for (const c of [...p[zone]]) {
          if (!c.isCommander) continue;
          p[zone].splice(p[zone].indexOf(c), 1);
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
  // CR 800.4a: los objetos del jugador que abandona la partida dejan la partida
  for (const c of p.battlefield) game.combat?.remove(c);
  p.battlefield = [];
  log(game, `☠️ ${p.name} pierde: ${reason}.`);
  const alive = game.players.filter((x) => x.alive);
  if (alive.length === 1 && game.winner == null) {
    game.winner = alive[0].idx;
    log(game, `🏆 ¡${alive[0].name} gana la partida! (CR 104.2a)`);
  }
}

// ---------- Estructura del turno (CR 500) ----------

export async function beginTurn(game, io) {
  const p = game.players[game.active];
  p.landsPlayed = 0;
  setStep(game, 'untap');
  for (const c of p.battlefield) {
    if (!/doesn't untap during/i.test(c.oracle || '')) c.tapped = false; // CR 502.3
    c.sick = false; // CR 302.6: bajo su control desde el inicio del turno
  }
  setStep(game, 'upkeep');
  fireTriggers(game, p, /at the beginning of your upkeep, ([^.\n]+)/gi);
  setStep(game, 'draw');
  // CR 103.8a: en partidas de dos jugadores, quien empieza no roba su primer turno.
  // CR 103.8c: en las demás partidas multijugador nadie se salta el robo.
  const skip = game.players.length === 2 && game.active === game.firstPlayer && p.turnsTaken === 0;
  if (!skip) draw(game, p, 1);
  p.turnsTaken++;
  log(game, `▶ Turno ${game.turn}: ${p.name}${skip ? ' (sin robar, CR 103.8a)' : ''}.`);
  await io.step('UNTAP · UPKEEP · DRAW', p.name);
  await flushTriggers(game, io);
  setStep(game, 'main1');
}

export async function endTurn(game, io) {
  const p = game.players[game.active];
  if (game.winner != null) return;
  setStep(game, 'end');
  fireTriggers(game, p, /at the beginning of your end step, ([^.\n]+)/gi);
  await flushTriggers(game, io);
  setStep(game, 'cleanup');
  // CR 514.1: descartar hasta el tamaño máximo de mano
  const excess = p.hand.length - (/no maximum hand size/i.test(p.battlefield.map((c) => c.oracle).join('\n')) ? Infinity : MAX_HAND);
  if (excess > 0 && p.alive) {
    const discards = p.isAI ? aiDiscard(p, excess) : await io.chooseDiscard(game, p, excess);
    for (const c of discards.slice(0, excess)) moveCard(game, c, 'graveyard');
    log(game, `🗑 ${p.name} descarta ${excess} (CR 514.1).`);
  }
  // CR 514.2: se quita el daño y terminan los efectos "hasta el final del turno"
  for (const pl of game.players) {
    for (const c of pl.battlefield) {
      c.damage = 0;
      c.deathtouched = false;
      c.tempP = c.tempT = 0;
    }
  }
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
  if (/forestwalk/i.test((attacker.keywords || []).join(' ')) && game.players[blocker.owner].battlefield.some((l) => /Forest/.test(l.typeLine)))
    return false; // CR 702.14
  return true;
}

/** Valida y limpia bloqueos ilegales (CR 509.1b-c): menace (702.111b) exige 2+ bloqueadores. */
export function validateBlocks(game, blocks) {
  const usedBlockers = new Set();
  const clean = new Map();
  for (const [a, list] of blocks) {
    const legal = list.filter((b) => !usedBlockers.has(b) && canBlock(game, b, a));
    if (has(a, 'menace') && legal.length === 1) continue;
    if (!legal.length) continue;
    legal.forEach((b) => usedBlockers.add(b));
    clean.set(a, legal);
  }
  return clean;
}

class Combat {
  constructor(attacker) {
    this.attackingPlayer = attacker;
    this.attacks = []; // { attacker, defender, blockers: [], blocked: false }
  }
  remove(card) {
    this.attacks = this.attacks.filter((a) => a.attacker !== card);
    for (const a of this.attacks) a.blockers = a.blockers.filter((b) => b !== card);
  }
}

/**
 * Ejecuta el combate completo.
 * @param {{attacker:object, defender:object}[]} plan
 */
export async function runCombat(game, p, plan, io) {
  setStep(game, 'beginCombat');
  const legal = plan.filter(({ attacker, defender }) => canAttack(game, attacker) && defender.alive && defender !== p);
  if (!legal.length) {
    setStep(game, 'main2');
    return 'Sin atacantes';
  }

  setStep(game, 'declareAttackers');
  const combat = new Combat(p);
  game.combat = combat;
  for (const { attacker, defender } of legal) {
    if (!has(attacker, 'vigilance')) attacker.tapped = true; // CR 508.1f
    combat.attacks.push({ attacker, defender, blockers: [], blocked: false });
  }
  const targets = [...new Set(legal.map((a) => a.defender.name))].join(', ');
  log(game, `⚔️ ${p.name} ataca con ${legal.length} criatura${legal.length > 1 ? 's' : ''} → ${targets} (CR 508).`);
  // Disparadores de ataque (CR 508.3)
  for (const a of combat.attacks) {
    const nm = escRe(a.attacker.name);
    for (const m of (a.attacker.oracle || '').matchAll(new RegExp(`whenever ${nm} attacks, ([^.\\n]+)`, 'gi'))) {
      resolveText(game, p, m[1], { source: a.attacker, defender: a.defender });
    }
  }
  fireTriggers(game, p, /whenever (?:a|another) creature you control attacks, ([^.\n]+)/gi, { defender: legal[0].defender });
  fireTriggers(game, p, /whenever you attack, ([^.\n]+)/gi, { defender: legal[0].defender });
  await io.step('COMBAT', `${p.name} → ${targets}`);

  // Prioridad tras declarar atacantes: los defensores pueden responder (CR 508.8)
  for (const d of opponents(game, p)) {
    const attackers = combat.attacks.filter((a) => a.defender === d).map((a) => a.attacker);
    if (!attackers.length) continue;
    const ctx = { type: 'attack', attackers };
    const options = responseOptions(game, d, ctx);
    if (!options.length) continue;
    const pick = d.isAI ? aiPickResponse(game, d, ctx, options) : await io.respond(game, d, ctx, options);
    if (pick) await castSpell(game, d, pick, io, { ctx });
  }
  if (!combat.attacks.length) return endCombat(game, 'Ataque neutralizado');

  // Declarar bloqueadores (CR 509)
  setStep(game, 'declareBlockers');
  const summary = [];
  for (const d of opponents(game, p)) {
    const mine = combat.attacks.filter((a) => a.defender === d);
    if (!mine.length) continue;
    const atks = mine.map((a) => a.attacker);
    const raw = d.isAI ? aiChooseBlocks(game, d, atks) : await io.chooseBlocks(game, d, atks);
    const blocks = validateBlocks(game, raw);
    for (const a of mine) {
      a.blockers = blocks.get(a.attacker) || [];
      a.blocked = a.blockers.length > 0; // CR 509.1h: sigue bloqueada aunque el bloqueador desaparezca
    }
    if (blocks.size) summary.push(`${d.name} bloquea ${blocks.size}`);
  }
  if (summary.length) await io.step('BLOCKERS', summary.join(' · '));

  // Daño de combate (CR 510). Paso extra de "dañar primero" si hay first/double strike (CR 510.4).
  setStep(game, 'combatDamage');
  const fs = (c) => has(c, 'first strike') || has(c, 'double strike');
  const anyFirst = combat.attacks.some((a) => fs(a.attacker) || a.blockers.some(fs));
  let total = '';
  if (anyFirst) {
    total = dealCombatDamage(game, combat, 'first');
    await io.step('FIRST STRIKE', total);
  }
  total = dealCombatDamage(game, combat, anyFirst ? 'regular' : 'only');
  await flushTriggers(game, io);
  await io.step('DAMAGE', total);
  return endCombat(game, total);
}

function endCombat(game, summary) {
  setStep(game, 'endCombat'); // CR 511
  game.combat = null;
  setStep(game, 'main2');
  return summary;
}

function dealsInStage(c, stage, dealtFirst) {
  const f = has(c, 'first strike');
  const d = has(c, 'double strike');
  if (stage === 'only') return true;
  if (stage === 'first') return f || d;
  return d || (!f && !dealtFirst.has(c)); // CR 510.4
}

/** Asigna y reparte el daño de combate simultáneamente (CR 510.1–510.2). */
function dealCombatDamage(game, combat, stage) {
  combat.dealtFirst ||= new Set();
  const events = []; // { source, target (card|player), amount }
  for (const a of combat.attacks) {
    const atk = a.attacker;
    const atkP = power(game, atk);
    if (dealsInStage(atk, stage, combat.dealtFirst) && atkP > 0) {
      if (!a.blocked) events.push({ source: atk, target: a.defender, amount: atkP });
      else if (a.blockers.length === 0) {
        if (has(atk, 'trample')) events.push({ source: atk, target: a.defender, amount: atkP }); // CR 702.19e
      } else {
        // CR 510.1c-d: daño letal a cada bloqueador antes de pasar al siguiente / al jugador con arrollar
        let left = atkP;
        const sorted = [...a.blockers].sort((x, y) => toughness(game, x) - y.damage - (toughness(game, y) - x.damage));
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
    if (ev.target.idx !== undefined && ev.target.life !== undefined) {
      const pl = ev.target;
      if (has(src, 'infect')) pl.poison += ev.amount; // CR 702.90b
      else pl.life -= ev.amount;
      const toxic = (src.keywords || []).find((k) => /^toxic/i.test(k));
      if (toxic) pl.poison += parseInt((src.oracle || '').match(/Toxic (\d+)/i)?.[1] || '1', 10); // CR 702.164
      if (src.isCommander) pl.commanderDamage[src.iid] = (pl.commanderDamage[src.iid] || 0) + ev.amount; // CR 903.10a
      toPlayers.set(pl.name, (toPlayers.get(pl.name) || 0) + ev.amount);
      // "Whenever ~ deals combat damage to a player"
      for (const m of (src.oracle || '').matchAll(/whenever [^,]*? deals combat damage to a player, ([^.\n]+)/gi)) {
        resolveText(game, ctrl, m[1], { source: src, defender: pl });
      }
    } else {
      const c = ev.target;
      if (has(src, 'infect') || has(src, 'wither')) c.counters.m1 += ev.amount; // CR 702.80, 702.90c
      else c.damage += ev.amount;
      if (has(src, 'deathtouch')) c.deathtouched = true; // CR 702.2b
    }
    if (has(src, 'lifelink')) ctrl.life += ev.amount; // CR 702.15b
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

function aiPickResponse(game, p, ctx, options) {
  if (ctx.type === 'spell') {
    const c = ctx.item.card;
    const t = (c.oracle || '').toLowerCase();
    const wipeHurtsMe = /destroy all|exile all/.test(t) && p.battlefield.filter(isCreature).length >= 2;
    const scary = c.isCommander || (c.cmc || 0) >= 5 || wipeHurtsMe || /extra turn/.test(t);
    return scary ? options.find((o) => /counter target/i.test(o.oracle)) || null : null;
  }
  if (ctx.type === 'attack') {
    const threat = [...ctx.attackers].sort((a, b) => threatScore(game, b) - threatScore(game, a))[0];
    if (threat && (power(game, threat) >= 3 || threat.isCommander)) return options[0];
  }
  return null;
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
    .filter((a, i, arr) => p.life > 12 || arr.length < 2 || i > 0) // con poca vida deja un defensor
    .map((attacker) => ({ attacker, defender: target }));
}

function castScore(game, p, c) {
  const t = (c.oracle || '').toLowerCase();
  let s = c.cmc || 0;
  if (/add \{|search your library for .*land/.test(t)) s += 6;
  if (c.isCommander) s += 4;
  if (/destroy all|exile all|all creatures get -/.test(t)) {
    const mine = p.battlefield.filter(isCreature).length;
    const theirs = opponents(game, p).reduce((n, o) => n + o.battlefield.filter(isCreature).length, 0);
    s = theirs >= mine + 3 ? s + 5 : -100;
  }
  if (/(destroy|exile) target/.test(t) && !bestTarget(game, p, (t.match(/(?:destroy|exile) target ([a-z ]+?)(?:\.|,| with| an)/) || [])[1] || 'creature'))
    s = -100;
  if (/counter target/.test(t)) s = -100; // se guarda para responder
  if (/\bInstant\b/.test(c.typeLine) && /(destroy|exile) target creature/.test(t) && game.step === 'main1') s = -100; // reservar
  return s;
}

async function aiMain(game, p, io) {
  if (p.landsPlayed === 0) {
    const lands = p.hand
      .filter(isLand)
      .sort((a, b) => Number(/enters.*tapped/i.test(a.oracle)) - Number(/enters.*tapped/i.test(b.oracle)));
    if (lands[0] && playLand(game, p, lands[0]).ok) await io.step('LAND DROP', lands[0].name);
  }
  // Fetchlands y habilidades {T} que crean fichas / roban
  for (const c of [...p.battlefield]) {
    for (const ab of activatedAbilities(game, p, c)) {
      const fx = await activate(game, p, c, ab, io);
      if (fx.length) await io.step('ABILITY', `${c.name}: ${fx.join(', ')}`);
      break;
    }
  }
  for (let guard = 0; guard < 15 && game.winner == null && p.alive; guard++) {
    const options = [...p.hand.filter((c) => !isLand(c)), ...p.command]
      .filter((c) => !castBlockReason(game, p, c) && canPay(game, p, c))
      .map((c) => ({ c, score: castScore(game, p, c) }))
      .filter((o) => o.score > -50)
      .sort((a, b) => b.score - a.score);
    if (!options.length) break;
    const res = await castSpell(game, p, options[0].c, io);
    if (res.ok && res.effects?.length) await io.step(labelFor(res.effects), `${options[0].c.name} · ${res.effects.join(', ')}`);
  }
}

function labelFor(effects) {
  if (effects.some((e) => e.startsWith('BOARD WIPE'))) return 'BOARD WIPE';
  if (effects.some((e) => /destruye|exilia/.test(e))) return 'REMOVAL';
  if (effects.some((e) => e.startsWith('crea'))) return 'TOKENS';
  if (effects.some((e) => e.startsWith('busca'))) return 'RAMP';
  return 'RESOLVE';
}

/** Turno completo de la IA siguiendo la estructura de turno. */
export async function aiTurn(game, io, { skipStart = false } = {}) {
  const p = game.players[game.active];
  if (!skipStart) await beginTurn(game, io);
  if (!p.alive || game.winner != null) return endIfNeeded(game, io);
  if (game.step === 'main1') await aiMain(game, p, io);
  if (game.winner != null) return;
  if (game.step === 'main1') {
    const plan = aiPlanAttacks(game, p);
    if (plan.length) await runCombat(game, p, plan, io);
    else setStep(game, 'main2');
  }
  if (game.winner != null) return;
  await aiMain(game, p, io);
  await endIfNeeded(game, io);
}

async function endIfNeeded(game, io) {
  if (game.winner != null) return;
  await io.step('END TURN', game.players[game.active].name);
  await endTurn(game, io);
}
