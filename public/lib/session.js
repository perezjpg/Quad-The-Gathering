// Sesión de juego: ejecuta el motor y conecta las decisiones humanas con la UI.
// Funciona igual en el navegador (partida local) y en el servidor (partida LAN), sin DOM.

import * as E from './engine.js';
import { isLand, isCreature } from './stats.js';

export const SPEEDS = { lenta: 1300, normal: 750, rápida: 280, turbo: 40 };

export class Abort extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GameSession {
  /**
   * @param {object[]} configs  ver E.createGame
   * @param {{speed?:string, fullStops?:boolean, spectator?:boolean}} opts
   */
  constructor(configs, opts = {}) {
    this.game = E.createGame(configs, { fullStops: !!opts.fullStops });
    this.speed = opts.speed || 'normal';
    this.paused = false;
    this.pending = new Map(); // playerIdx -> { id, req, resolve, fallback }
    this.seq = 0;
    this.listeners = new Set();
    this.running = false;
    this.error = null;
    this.io = {
      step: (label, detail) => this.step(label, detail),
      decide: (p, req) => this.decide(p, req),
    };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    if (this._emitQueued) return;
    this._emitQueued = true;
    queueMicrotask(() => {
      this._emitQueued = false;
      for (const fn of this.listeners) fn();
    });
  }

  async step(label, detail) {
    const g = this.game;
    if (g.aborted) throw new Abort();
    g.banner = { label, detail, key: ++this.seq };
    this.emit();
    await sleep(SPEEDS[this.speed] ?? 700);
    while (this.paused && !g.aborted) await sleep(150);
    if (g.aborted) throw new Abort();
  }

  decide(p, req) {
    if (this.game.aborted) return Promise.reject(new Abort());
    return new Promise((resolve) => {
      this.pending.set(p.idx, { id: ++this.seq, req, resolve });
      this.emit();
    });
  }

  /** Respuesta de un jugador a su decisión pendiente. */
  answer(playerIdx, id, value) {
    const d = this.pending.get(playerIdx);
    if (!d || d.id !== id) return false;
    this.pending.delete(playerIdx);
    d.resolve(value);
    this.emit();
    return true;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    const g = this.game;
    try {
      await E.pregame(g, this.io);
      while (g.winner == null && !g.aborted) {
        await E.takeTurn(g, this.io);
        if (g.turn > 120) {
          E.log(g, '⏱ Límite de 120 rondas alcanzado.');
          break;
        }
      }
    } catch (err) {
      if (!(err instanceof Abort) && !g.aborted) {
        console.error(err);
        this.error = err.message;
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }

  abort() {
    this.game.aborted = true;
    for (const d of this.pending.values()) d.resolve(undefined);
    this.pending.clear();
    this.listeners.clear();
  }

  /** Mensajes de un jugador: respuestas, ajustes manuales y opciones. */
  dispatch(playerIdx, msg, { isHost = true } = {}) {
    const g = this.game;
    const p = g.players[playerIdx];
    if (!msg || !p) return { ok: false };
    if (msg.type === 'answer') return { ok: this.answer(playerIdx, msg.id, msg.value) };
    if (msg.type === 'life' && isHost) {
      const target = g.players[msg.player];
      if (target) {
        target.life += msg.delta | 0;
        E.runSBA(g);
      }
    }
    if (msg.type === 'manual') {
      // Correcciones manuales: solo sobre cartas propias (fuera de las reglas, se registra en el log)
      const loc = E.findCard(g, msg.iid);
      if (loc && loc.card.owner === playerIdx && loc.zone !== 'stack') {
        if (msg.op === 'tap') loc.card.tapped = !loc.card.tapped;
        if (msg.op === 'counter') loc.card.counters.p1++;
        if (msg.op === 'move' && ['graveyard', 'exile', 'hand', 'battlefield', 'library'].includes(msg.to)) E.moveCard(g, loc.card, msg.to);
        E.log(g, `🛠 ${p.name} (manual): ${msg.op} ${loc.card.name}${msg.to ? ' → ' + msg.to : ''}.`);
        E.runSBA(g);
      }
    }
    if (msg.type === 'setting' && isHost) {
      if (msg.speed && SPEEDS[msg.speed] != null) this.speed = msg.speed;
      if (typeof msg.paused === 'boolean') this.paused = msg.paused;
      if (typeof msg.fullStops === 'boolean') g.settings.fullStops = msg.fullStops;
    }
    this.emit();
    return { ok: true };
  }

  /** Vista serializable para un jugador (oculta manos ajenas y bibliotecas). */
  view(viewer, { revealAll = false } = {}) {
    const g = this.game;
    const me = g.players[viewer];
    const pending = this.pending.get(viewer);
    const cv = (c, zone) => cardView(g, c, zone);
    const players = g.players.map((p) => {
      const showHand = revealAll || p.idx === viewer;
      return {
        idx: p.idx,
        name: p.name,
        isAI: p.isAI,
        color: p.color,
        deckName: p.deckName,
        life: p.life,
        poison: p.poison,
        alive: p.alive,
        libraryCount: p.library.length,
        handCount: p.hand.length,
        hand: showHand
          ? p.hand.map((c) => ({ ...cv(c, 'hand'), play: p.idx === viewer ? playInfo(g, p, c) : null }))
          : null,
        battlefield: p.battlefield.map((c) => ({
          ...cv(c, 'battlefield'),
          abilities: p.idx === viewer ? E.activatedAbilities(g, p, c).map((a, i) => ({ index: i, label: a.label })) : [],
        })),
        graveyard: p.graveyard.map((c) => cv(c, 'graveyard')),
        exile: p.exile.map((c) => cv(c, 'exile')),
        command: p.command.map((c) => ({ ...cv(c, 'command'), tax: p.commanderTax[c.iid] || 0, play: p.idx === viewer ? playInfo(g, p, c) : null })),
        commanderDamage: Object.values(p.commanderDamage).filter((v) => v > 0),
        mana: manaView(g, p),
        landsPlayed: p.landsPlayed,
        turnsTaken: p.turnsTaken,
      };
    });
    return {
      you: viewer,
      turn: g.turn,
      step: g.step,
      active: g.active,
      winner: g.winner,
      banner: g.banner,
      error: this.error,
      speed: this.speed,
      paused: this.paused,
      fullStops: g.settings.fullStops,
      running: this.running,
      log: g.log.slice(0, 80),
      stack: g.stack.map((it) => ({
        id: it.id,
        name: it.card.name,
        img: it.card.imgSmall || null,
        controller: it.controller.name,
        target: targetName(g, it.target),
      })),
      combat: g.combat
        ? g.combat.attacks.map((a) => ({ attacker: a.attacker.iid, defender: a.defender.idx, blockers: a.blockers.map((b) => b.iid) }))
        : [],
      players,
      effects: me ? E.activeEffects(g, me) : [],
      decision: pending ? decisionView(g, me, pending) : null,
      waitingOn: [...this.pending.keys()].map((i) => g.players[i].name),
    };
  }
}

function cardView(g, c, zone) {
  const onField = zone === 'battlefield';
  return {
    iid: c.iid,
    name: c.name,
    img: c.img || null,
    imgSmall: c.imgSmall || null,
    typeLine: c.typeLine,
    manaCost: c.manaCost || '',
    oracle: c.oracle || '',
    scryfall: c.scryfall || null,
    keywords: c.keywords || [],
    owner: c.owner,
    power: isCreature(c) && c.power != null ? (onField ? E.power(g, c) : c.power) : null,
    toughness: isCreature(c) && c.toughness != null ? (onField ? E.toughness(g, c) : c.toughness) : null,
    buffed: onField && isCreature(c) && (E.power(g, c) !== parseInt(c.power, 10) || E.toughness(g, c) !== parseInt(c.toughness, 10)),
    tapped: !!c.tapped,
    sick: onField && isCreature(c) && c.sick && !E.has(c, 'haste'),
    damage: c.damage || 0,
    isCommander: !!c.isCommander,
    isToken: !!c.isToken,
    isLand: isLand(c),
    isCreature: isCreature(c),
    loyalty: c.loyalty != null ? c.counters?.loyalty : null,
  };
}

/** Información para jugar/lanzar una carta: legalidad, coste total y avisos (CR 601.2f). */
function playInfo(g, p, c) {
  if (isLand(c)) return { land: true, reason: E.landBlockReason(g, p, c) };
  const cost = E.costOf(g, p, c);
  const mods = E.costModifiers(g, p, c);
  const spec = E.targetSpec(c);
  return {
    land: false,
    reason: E.castBlockReason(g, p, c) || (spec && !E.legalTargets(g, p, spec).length ? 'No hay objetivos legales (CR 601.2c).' : null),
    payable: E.canPay(g, p, c),
    cost: E.costText(cost),
    baseCost: c.manaCost || '',
    hasX: /\{X\}/.test(c.manaCost || ''),
    mods: mods.map((m) => `${m.source}${m.owner !== p.name ? ` (${m.owner})` : ''}: ${m.amount > 0 ? '+' : ''}{${Math.abs(m.amount)}}${m.amount < 0 ? ' menos' : ''}`),
    needsTarget: !!spec,
  };
}

function manaView(g, p) {
  const sources = E.sourcesOf(p);
  const colors = new Set();
  let total = 0;
  for (const s of sources) {
    total += Math.max(...s.options.map((o) => o.length));
    for (const u of s.options.flat()) {
      if (u === '*') ['W', 'U', 'B', 'R', 'G'].forEach((c) => colors.add(c));
      else colors.add(u);
    }
  }
  return { total, colors: [...colors], pool: g.pools[p.idx] };
}

function targetName(g, ref) {
  if (!ref) return null;
  if (ref.type === 'player') return g.players[ref.idx]?.name;
  if (ref.type === 'card') return E.findCard(g, ref.iid)?.card.name || null;
  if (ref.type === 'stack') return g.stack.find((it) => it.id === ref.id)?.card.name || null;
  return null;
}

/** Enriquece la decisión con nombres e imágenes para que la UI la muestre. */
function decisionView(g, me, pending) {
  const { id, req } = pending;
  const card = (iid) => {
    const loc = E.findCard(g, iid);
    return loc ? { ...cardView(g, loc.card, loc.zone), controller: g.players[loc.card.owner].name } : { iid, name: '?' };
  };
  const base = { id, kind: req.kind };
  switch (req.kind) {
    case 'priority':
      return { ...base, step: req.step, error: req.error, stack: req.stack };
    case 'attackers':
      return { ...base, attackers: req.attackers.map(card), defenders: req.defenders.map((i) => ({ idx: i, name: g.players[i].name, life: g.players[i].life })) };
    case 'blockers':
      return { ...base, options: req.options.map((o) => ({ attacker: card(o.attacker), menace: o.menace, blockers: o.blockers.map(card) })) };
    case 'target':
      return {
        ...base,
        card: req.card,
        targets: req.targets.map((r) =>
          r.type === 'player'
            ? { ref: r, label: `${g.players[r.idx].name} (${g.players[r.idx].life}❤)`, player: true }
            : r.type === 'card'
              ? { ref: r, label: card(r.iid).name, card: card(r.iid) }
              : { ref: r, label: `Hechizo: ${g.stack.find((it) => it.id === r.id)?.card.name}` }
        ),
      };
    case 'discard':
    case 'bottom':
      return { ...base, n: req.n, hand: me.hand.map((c) => cardView(g, c, 'hand')) };
    case 'mulligan':
      return { ...base, mulligans: req.mulligans, toBottom: req.toBottom, hand: me.hand.map((c) => cardView(g, c, 'hand')) };
    case 'payUnless':
      return { ...base, amount: req.amount, source: req.source, owner: req.owner, effect: req.effect };
    default:
      return base;
  }
}
