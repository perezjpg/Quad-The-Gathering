// Motor de mesa de Commander: zonas, turnos, combate e IA heurística.
// No es un motor de reglas completo: resuelve los efectos más comunes leyendo el texto Oracle
// (robar, destruir, daño, tokens, ramp, wipes) para que la simulación se sienta como una partida real.

import { isLand, isCreature } from './stats.js';

export const STARTING_LIFE = 40;
export const COMMANDER_DAMAGE_LETHAL = 21;

let iidSeq = 0;

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, x: 1 };
const num = (s) => NUM[String(s).toLowerCase()] ?? (parseInt(s, 10) || 1);

export const isInstantOrSorcery = (c) => /\b(Instant|Sorcery)\b/.test(c.typeLine);
const has = (c, kw) => (c.keywords || []).some((k) => k.toLowerCase() === kw);
const pow = (c) => (c.isToken ? c.power : parseInt(c.power, 10)) || 0;
const tough = (c) => (c.isToken ? c.toughness : parseInt(c.toughness, 10)) || 1;
const producesMana = (c) => !isLand(c) && /\{T\}[^.]*?: Add /i.test(c.oracle || '');

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function makeCard(info, owner, extra = {}) {
  return { ...info, iid: ++iidSeq, owner, tapped: false, sick: true, damage: 0, ...extra };
}

function makeToken(owner, p, t, label) {
  return makeCard(
    {
      name: label || `Token ${p}/${t}`,
      typeLine: 'Token Creature',
      cmc: 0,
      oracle: '',
      keywords: [],
      power: p,
      toughness: t,
      img: null,
      imgSmall: null,
    },
    owner,
    { isToken: true }
  );
}

/**
 * @param {{name:string, isAI:boolean, color:string, entries:{info:object, qty:number, board:string}[]}[]} configs
 */
export function createGame(configs) {
  const players = configs.map((cfg, idx) => {
    const library = [];
    const command = [];
    for (const e of cfg.entries) {
      if (e.board === 'commander') command.push(makeCard(e.info, idx, { isCommander: true }));
      else if (e.board === 'main') for (let i = 0; i < e.qty; i++) library.push(makeCard(e.info, idx));
    }
    return {
      idx,
      name: cfg.name,
      isAI: cfg.isAI,
      color: cfg.color,
      deckName: cfg.deckName || '',
      life: STARTING_LIFE,
      library: shuffle(library),
      hand: [],
      battlefield: [],
      graveyard: [],
      exile: [],
      command,
      commanderTax: {},
      commanderDamage: {}, // de quién -> cantidad
      landsPlayed: 0,
      alive: true,
      mulligans: 0,
    };
  });

  const game = {
    players,
    active: Math.floor(Math.random() * players.length),
    firstPlayer: 0,
    turn: 1,
    log: [],
    winner: null,
    banner: null,
  };
  game.firstPlayer = game.active;

  for (const p of players) {
    draw(game, p, 7);
    if (p.isAI) aiMulligan(game, p);
  }
  log(game, `🎲 ${players[game.active].name} empieza la partida.`);
  return game;
}

export function log(game, msg) {
  game.log.unshift({ turn: game.turn, msg });
  if (game.log.length > 200) game.log.pop();
}

export function draw(game, p, n = 1) {
  for (let i = 0; i < n; i++) {
    const c = p.library.shift();
    if (!c) {
      log(game, `💀 ${p.name} no puede robar: biblioteca vacía.`);
      eliminate(game, p, 'biblioteca vacía');
      return;
    }
    p.hand.push(c);
  }
}

export function mulligan(game, p) {
  p.library.push(...p.hand);
  p.hand = [];
  shuffle(p.library);
  p.mulligans++;
  draw(game, p, 7);
  // Primer mulligan gratis (regla de Commander multijugador); luego al fondo N-1 cartas.
  const toBottom = Math.max(0, p.mulligans - 1);
  if (toBottom) {
    const sorted = [...p.hand].sort((a, b) => b.cmc - a.cmc);
    for (const c of sorted.slice(0, toBottom)) moveCard(game, c, 'library', 'bottom');
  }
  log(game, `🔄 ${p.name} hace mulligan (${p.mulligans}).`);
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
  return null;
}

/** Mueve una carta entre zonas. Los comandantes que van al cementerio/exilio regresan a la zona de mando. */
export function moveCard(game, card, toZone, position = 'top') {
  const loc = findCard(game, card.iid);
  if (!loc) return;
  loc.player[loc.zone].splice(loc.index, 1);
  if (card.isToken && toZone !== 'battlefield') return; // los tokens dejan de existir
  const owner = game.players[card.owner];
  if (card.isCommander && (toZone === 'graveyard' || toZone === 'exile')) toZone = 'command';
  card.tapped = false;
  card.damage = 0;
  if (toZone === 'battlefield') card.sick = true;
  if (toZone === 'library' && position === 'bottom') owner.library.push(card);
  else if (toZone === 'library') owner.library.unshift(card);
  else owner[toZone].push(card);
}

export function commanderCost(p, card) {
  return (card.cmc || 0) + (p.commanderTax[card.iid] || 0);
}

// ---------- Maná ----------

function manaSources(p) {
  return p.battlefield.filter((c) => !c.tapped && (isLand(c) || (producesMana(c) && !(isCreature(c) && c.sick))));
}

export function availableMana(p) {
  return manaSources(p).length;
}

function tapMana(p, n) {
  // Primero tierras, luego rocas/dorks.
  const sources = manaSources(p).sort((a, b) => Number(isLand(b)) - Number(isLand(a)));
  for (const s of sources.slice(0, n)) s.tapped = true;
}

// ---------- Acciones ----------

export function playLand(game, p, card) {
  moveCard(game, card, 'battlefield');
  card.sick = false;
  if (/enters( the battlefield)? tapped/i.test(card.oracle || '') && !/unless/i.test(card.oracle || '')) card.tapped = true;
  p.landsPlayed++;
  log(game, `🌲 ${p.name} juega ${card.name}.`);
}

/** Lanza una carta. Paga con maná disponible si `pay` es true. Devuelve descripciones de efectos. */
export function castCard(game, p, card, { pay = true } = {}) {
  const fromCommand = p.command.includes(card);
  const cost = fromCommand ? commanderCost(p, card) : card.cmc || 0;
  if (pay) tapMana(p, cost);
  if (fromCommand) p.commanderTax[card.iid] = (p.commanderTax[card.iid] || 0) + 2;

  const effects = [];
  if (isInstantOrSorcery(card)) {
    moveCard(game, card, 'graveyard');
    effects.push(...resolveText(game, p, card.oracle || ''));
  } else {
    moveCard(game, card, 'battlefield');
    if (has(card, 'haste')) card.sick = false;
    const etb = (card.oracle || '')
      .split('\n')
      .filter((l) => /^when .* enters/i.test(l))
      .join('\n');
    if (etb) effects.push(...resolveText(game, p, etb));
  }
  log(game, `✨ ${p.name} lanza ${card.name}${fromCommand ? ' (desde la zona de mando)' : ''}${effects.length ? ' — ' + effects.join(', ') : ''}.`);
  return effects;
}

function opponents(game, p) {
  return game.players.filter((o) => o !== p && o.alive);
}

function biggestThreat(game, p) {
  let best = null;
  for (const o of opponents(game, p)) {
    for (const c of o.battlefield) {
      if (!isCreature(c) && !/Planeswalker/.test(c.typeLine)) continue;
      const score = pow(c) + tough(c) + (c.isCommander ? 6 : 0) + (c.cmc || 0);
      if (!best || score > best.score) best = { card: c, score, owner: o };
    }
  }
  return best;
}

function weakestOpponent(game, p) {
  const opps = opponents(game, p);
  return opps.sort((a, b) => a.life - b.life || Math.random() - 0.5)[0];
}

/** Resuelve efectos comunes a partir del texto Oracle. */
export function resolveText(game, p, text) {
  const t = text.toLowerCase();
  const out = [];

  // Board wipes
  if (/(destroy|exile) all (creatures|nonland permanents)|all creatures get -\d+\/-\d+/.test(t)) {
    let n = 0;
    for (const pl of game.players) {
      for (const c of [...pl.battlefield]) {
        if (isCreature(c) && !has(c, 'indestructible')) {
          moveCard(game, c, /exile all/.test(t) ? 'exile' : 'graveyard');
          n++;
        }
      }
    }
    out.push(`BOARD WIPE (${n} criaturas)`);
    return out;
  }

  // Removal puntual
  if (/(destroy|exile) target (creature|nonland permanent|permanent|artifact or creature|creature or planeswalker)/.test(t)) {
    const threat = biggestThreat(game, p);
    if (threat) {
      moveCard(game, threat.card, /exile target/.test(t) ? 'exile' : 'graveyard');
      out.push(`elimina ${threat.card.name} de ${threat.owner.name}`);
    }
  }

  // Daño
  let m = t.match(/deals? (\d+) damage to each opponent/);
  if (m) {
    for (const o of opponents(game, p)) o.life -= +m[1];
    out.push(`${m[1]} de daño a cada oponente`);
  } else if ((m = t.match(/deals? (\d+) damage to (any target|target player|target opponent)/))) {
    const o = weakestOpponent(game, p);
    if (o) {
      o.life -= +m[1];
      out.push(`${m[1]} de daño a ${o.name}`);
    }
  }

  // Robar
  m = t.match(/draws? (a|one|two|three|four|\d+) cards?/);
  if (m && !/each (player|opponent) draws/.test(t)) {
    draw(game, p, num(m[1]));
    out.push(`roba ${num(m[1])}`);
  }

  // Vida
  m = t.match(/you gain (\d+) life/);
  if (m) {
    p.life += +m[1];
    out.push(`+${m[1]} vida`);
  }

  // Ramp: buscar tierras básicas
  m = t.match(/search your library for (a|up to (one|two|three)) basic land/);
  if (m) {
    const n = m[2] ? num(m[2]) : 1;
    let found = 0;
    for (let i = 0; i < n; i++) {
      const land = p.library.find((c) => /Basic Land/.test(c.typeLine));
      if (!land) break;
      moveCard(game, land, 'battlefield');
      land.tapped = /tapped/.test(t);
      land.sick = false;
      found++;
    }
    shuffle(p.library);
    if (found) out.push(`ramp +${found} tierra${found > 1 ? 's' : ''}`);
  }

  // Tokens
  m = t.match(/create (a|one|two|three|four|five|x|\d+) (?:tapped )?(\d+)\/(\d+) [^.]*?creature tokens?/);
  if (m) {
    const n = num(m[1]);
    const label = (t.match(/\d+\/\d+ ([a-z ]+?) creature token/) || [])[1];
    const name = label ? label.replace(/\b(white|blue|black|red|green|colorless)\b/g, '').trim() : '';
    for (let i = 0; i < n; i++) {
      p.battlefield.push(makeToken(p.idx, +m[2], +m[3], name ? `${capitalize(name)} ${m[2]}/${m[3]}` : null));
    }
    out.push(`crea ${n} token${n > 1 ? 's' : ''} ${m[2]}/${m[3]}`);
  }

  checkState(game);
  return out;
}

const capitalize = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// ---------- Turnos ----------

export function startTurn(game) {
  const p = game.players[game.active];
  p.landsPlayed = 0;
  for (const c of p.battlefield) {
    c.tapped = false;
    c.sick = false;
  }
  const skipDraw = game.turn === 1 && game.active === game.firstPlayer;
  if (!skipDraw) draw(game, p, 1);
  log(game, `▶ Turno ${game.turn}: ${p.name}.`);
}

export function endTurn(game) {
  for (const pl of game.players) for (const c of pl.battlefield) c.damage = 0;
  const n = game.players.length;
  let next = game.active;
  for (let i = 0; i < n; i++) {
    next = (next + 1) % n;
    if (next === game.firstPlayer) game.turn++;
    if (game.players[next].alive) break;
  }
  game.active = next;
}

export function eliminate(game, p, reason) {
  if (!p.alive) return;
  p.alive = false;
  log(game, `☠️ ${p.name} queda eliminado (${reason}).`);
  checkWinner(game);
}

function checkWinner(game) {
  const alive = game.players.filter((p) => p.alive);
  if (alive.length === 1 && !game.winner) {
    game.winner = alive[0].idx;
    log(game, `🏆 ¡${alive[0].name} gana la partida!`);
  }
}

export function checkState(game) {
  for (const p of game.players) {
    if (!p.alive) continue;
    if (p.life <= 0) eliminate(game, p, 'vida en 0');
    else if (Object.values(p.commanderDamage).some((d) => d >= COMMANDER_DAMAGE_LETHAL))
      eliminate(game, p, '21 de daño de comandante');
    for (const c of [...p.battlefield]) {
      if (isCreature(c) && c.damage >= tough(c) && !has(c, 'indestructible')) moveCard(game, c, 'graveyard');
    }
  }
}

// ---------- Combate ----------

export function canAttack(c) {
  return isCreature(c) && !c.tapped && !c.sick && pow(c) > 0 && !has(c, 'defender');
}

function canBlock(blocker, attacker) {
  if (!isCreature(blocker) || blocker.tapped) return false;
  if (has(attacker, 'flying') && !has(blocker, 'flying') && !has(blocker, 'reach')) return false;
  if (has(attacker, 'unblockable') || /can't be blocked/i.test(attacker.oracle || '')) return false;
  return true;
}

/** El defensor bloquea solo cuando le conviene (sobrevive o intercambia hacia arriba). */
export function chooseBlocks(defender, attackers) {
  const used = new Set();
  const blocks = new Map();
  const sorted = [...attackers].sort((a, b) => pow(b) - pow(a));
  for (const a of sorted) {
    const candidates = defender.battlefield
      .filter((b) => !used.has(b) && canBlock(b, a))
      .map((b) => {
        const survives = tough(b) > pow(a) && !has(a, 'deathtouch');
        const kills = pow(b) >= tough(a) || has(b, 'deathtouch');
        const goodTrade = kills && (b.cmc || 0) <= (a.cmc || 0);
        const lethalSoon = defender.life - pow(a) <= 10;
        const score = (survives ? 3 : 0) + (kills ? 2 : 0) + (goodTrade ? 1 : 0);
        return { b, score, ok: survives || goodTrade || (lethalSoon && pow(a) >= 4) };
      })
      .filter((x) => x.ok)
      .sort((x, y) => y.score - x.score);
    if (candidates[0]) {
      used.add(candidates[0].b);
      blocks.set(a, candidates[0].b);
    }
  }
  return blocks;
}

/** Ejecuta un ataque contra un oponente. Devuelve un resumen. */
export function resolveCombat(game, attackerPlayer, attackers, defender, { autoBlock = true } = {}) {
  const blocks = autoBlock ? chooseBlocks(defender, attackers) : new Map();
  let toPlayer = 0;
  const deaths = [];
  for (const a of attackers) {
    if (!has(a, 'vigilance')) a.tapped = true;
    const b = blocks.get(a);
    let dmg = pow(a);
    if (b) {
      b.damage += pow(a);
      a.damage += pow(b);
      if (has(a, 'deathtouch')) b.damage = Math.max(b.damage, tough(b));
      if (has(b, 'deathtouch')) a.damage = Math.max(a.damage, tough(a));
      dmg = has(a, 'trample') ? Math.max(0, pow(a) - tough(b)) : 0;
      if (b.damage >= tough(b)) deaths.push(b.name);
      if (a.damage >= tough(a)) deaths.push(a.name);
    }
    if (dmg > 0) {
      defender.life -= dmg;
      toPlayer += dmg;
      if (a.isCommander) defender.commanderDamage[a.iid] = (defender.commanderDamage[a.iid] || 0) + dmg;
      if (has(a, 'lifelink')) attackerPlayer.life += dmg;
    }
  }
  checkState(game);
  const summary = `${attackers.length} atacante${attackers.length > 1 ? 's' : ''} → ${defender.name}: ${toPlayer} de daño${
    blocks.size ? `, ${blocks.size} bloqueo${blocks.size > 1 ? 's' : ''}` : ''
  }${deaths.length ? `, mueren ${deaths.join(', ')}` : ''}`;
  log(game, `⚔️ ${attackerPlayer.name}: ${summary}.`);
  return summary;
}

// ---------- IA ----------

function castScore(game, p, c) {
  const t = (c.oracle || '').toLowerCase();
  let s = c.cmc || 0;
  if (producesMana(c) || /search your library for .*basic land/.test(t)) s += 6; // ramp primero
  if (c.isCommander) s += 4;
  if (/destroy all|exile all|all creatures get -/.test(t)) {
    const mine = p.battlefield.filter(isCreature).length;
    const theirs = opponents(game, p).reduce((n, o) => n + o.battlefield.filter(isCreature).length, 0);
    s = theirs >= mine + 3 ? s + 5 : -100; // solo si va perdiendo en mesa
  }
  if (/(destroy|exile) target/.test(t) && !biggestThreat(game, p)) s = -100;
  if (/counter target/.test(t)) s = -100; // no hay pila en este motor
  return s;
}

/**
 * Juega un turno completo de IA. `step(label, detail)` permite a la UI animar cada acción.
 * @param {(label:string, detail?:string)=>Promise<void>} step
 */
export async function aiTurn(game, step, { skipStart = false } = {}) {
  const p = game.players[game.active];
  if (!skipStart) {
    startTurn(game);
    await step('UNTAP · DRAW', p.name);
  }
  if (!p.alive || game.winner != null) return;

  // Tierra: prefiere las que entran enderezadas
  const lands = p.hand.filter(isLand).sort((a, b) => Number(/enters.*tapped/i.test(a.oracle)) - Number(/enters.*tapped/i.test(b.oracle)));
  if (lands[0]) {
    playLand(game, p, lands[0]);
    await step('LAND DROP', lands[0].name);
  }

  // Lanzar hechizos mientras haya maná
  for (let guard = 0; guard < 15; guard++) {
    const mana = availableMana(p);
    const options = [...p.hand.filter((c) => !isLand(c)), ...p.command]
      .map((c) => ({ c, cost: p.command.includes(c) ? commanderCost(p, c) : c.cmc || 0 }))
      .filter((o) => o.cost <= mana)
      .map((o) => ({ ...o, score: castScore(game, p, o.c) }))
      .filter((o) => o.score > -50)
      .sort((a, b) => b.score - a.score);
    if (!options.length) break;
    const { c } = options[0];
    const effects = castCard(game, p, c);
    const label = effects.some((e) => e.startsWith('BOARD WIPE'))
      ? 'BOARD WIPE'
      : c.isCommander
        ? 'COMMANDER'
        : effects.some((e) => e.startsWith('elimina'))
          ? 'REMOVAL'
          : 'CAST';
    await step(label, `${c.name}${effects.length ? ' · ' + effects.join(', ') : ''}`);
    if (game.winner != null) return;
  }

  // Combate
  const attackers = p.battlefield.filter(canAttack);
  const target = weakestOpponent(game, p);
  if (attackers.length && target) {
    // No atacar con criaturas que morirían contra un bloqueador sin hacer nada útil
    const safe = attackers.filter((a) => {
      const blockers = target.battlefield.filter((b) => canBlock(b, a));
      return !blockers.some((b) => pow(b) >= tough(a) && tough(b) > pow(a)) || target.life <= pow(a);
    });
    if (safe.length) {
      await step('COMBAT', `${safe.length} atacante${safe.length > 1 ? 's' : ''} → ${target.name}`);
      const summary = resolveCombat(game, p, safe, target);
      await step('DAMAGE', summary);
    }
  }

  // Sacrificio/descartar al máximo de mano
  while (p.hand.length > 7) {
    const worst = [...p.hand].sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
    moveCard(game, worst, 'graveyard');
  }

  if (game.winner == null) {
    await step('END TURN', p.name);
    endTurn(game);
  }
}
