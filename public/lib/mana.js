// Maná según las Reglas Completas:
//  CR 106   — maná, reserva de maná (se vacía entre pasos, 106.4)
//  CR 107.4 — símbolos de maná: genérico, de color, híbrido, pirexiano, {C}, {X}, {2/W}
//  CR 202   — coste de maná
//  CR 305.6 — los tipos de tierra básica tienen la habilidad intrínseca "{T}: Agrega [color]"
//  CR 302.6 — una criatura con "mareo de invocación" no puede usar habilidades con {T}
//  CR 601.2g-h — se activan habilidades de maná y luego se paga el coste total

export const COLORS = ['W', 'U', 'B', 'R', 'G'];
const BASIC_TYPES = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

const isLand = (c) => /\bLand\b/.test(c.typeLine || '');
const isCreature = (c) => /\bCreature\b/.test(c.typeLine || '');
const hasKw = (c, kw) => (c.keywords || []).some((k) => k.toLowerCase() === kw);

/** Convierte "{2}{G}{G/W}{B/P}{X}" en una estructura de coste. */
export function parseCost(manaCost = '') {
  const first = String(manaCost).split(' // ')[0];
  const cost = { generic: 0, pips: [], x: 0 };
  for (const [, raw] of first.matchAll(/\{([^}]+)\}/g)) {
    const s = raw.toUpperCase();
    if (/^\d+$/.test(s)) cost.generic += +s;
    else if (s === 'X') cost.x++;
    else if (s === 'C' || COLORS.includes(s)) cost.pips.push({ any: [s] });
    else if (/^[WUBRG]\/P$/.test(s)) cost.pips.push({ any: [s[0]], phyrexian: true }); // CR 107.4f
    else if (/^2\/[WUBRG]$/.test(s)) cost.pips.push({ any: [s[2]], twoGeneric: true }); // CR 107.4e
    else if (/^[WUBRGC]\/[WUBRG]$/.test(s)) cost.pips.push({ any: [s[0], s[2]] }); // híbrido CR 107.4e
    else if (/^[WUBRG]\/[WUBRG]\/P$/.test(s)) cost.pips.push({ any: [s[0], s[2]], phyrexian: true });
    else if (s === 'S') cost.generic += 1; // nieve: aproximado como genérico
  }
  return cost;
}

export const costTotal = (cost, x = 0) => cost.generic + cost.pips.length + cost.x * x;

/**
 * Opciones de maná que produce un permanente al girarse.
 * Cada opción es un arreglo de símbolos ('W','U','B','R','G','C' o '*' = cualquier color).
 */
export function manaOptions(card, commanderCI = COLORS) {
  const text = card.oracle || '';
  const opts = [];
  for (const m of text.matchAll(/\{T\}(?:, (?:Pay \d+ life|Remove [^:]*|Sacrifice [^:]*))?: Add ([^.\n]+)/gi)) {
    const body = m[1];
    if (/one mana of any color in your commander/i.test(body)) opts.push(...commanderCI.map((c) => [c]));
    else if (/two mana in any combination of colors/i.test(body)) opts.push(['*', '*']);
    else if (/one mana of any (color|type)/i.test(body)) opts.push(['*']);
    else if (/\bor\b/.test(body)) for (const [, s] of body.matchAll(/\{([WUBRGC])\}/g)) opts.push([s]);
    else {
      const syms = [...body.matchAll(/\{([WUBRGC])\}/g)].map((x) => x[1]);
      if (syms.length) opts.push(syms);
    }
  }
  // Signets: "{1}, {T}: Add {B}{G}." — aproximado como +1 maná de cualquiera de sus colores.
  for (const m of text.matchAll(/\{1\}, \{T\}: Add \{([WUBRGC])\}\{([WUBRGC])\}/g)) opts.push([m[1]], [m[2]]);

  if (!opts.length && isLand(card)) {
    for (const [type, c] of Object.entries(BASIC_TYPES)) {
      if ((card.typeLine || '').includes(type) || new RegExp(`^(Snow-Covered )?${type}$`).test(card.name)) opts.push([c]);
    }
    if (/^Wastes$/.test(card.name)) opts.push(['C']);
  }
  const seen = new Set();
  return opts.filter((o) => {
    const k = o.join('');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Fuentes de maná disponibles de un jugador (sin girar, sin mareo si son criaturas). */
export function manaSources(p, commanderCI) {
  return p.battlefield
    .filter((c) => !c.tapped && !(isCreature(c) && c.sick && !hasKw(c, 'haste')))
    .map((c) => ({
      card: c,
      options: manaOptions(c, commanderCI),
      sacrifice: /\{T\}, Sacrifice [^:]*: Add/i.test(c.oracle || ''), // Treasure (se sacrifica al pagar)
    }))
    .filter((s) => s.options.length);
}

const fits = (unit, allowed) => allowed.includes(unit) || (unit === '*' && allowed.some((a) => a !== 'C'));
const flex = (s) => new Set(s.options.flat().map((u) => (u === '*' ? 'WUBRG' : u)).join('')).size;
const maxUnits = (s) => Math.max(...s.options.map((o) => o.length));

/**
 * Planifica el pago de un coste (sin modificar nada).
 * Primero paga los símbolos de color con las fuentes menos flexibles, luego el genérico.
 * @returns {{ok:boolean, used?:object[], pool?:string[], lifePaid?:number}}
 */
export function planPayment(sources, pool, cost, { x = 0, life = 40 } = {}) {
  pool = [...pool];
  const used = new Set();
  let lifePaid = 0;
  let generic = cost.generic + cost.x * x;

  const fromPool = (allowed) => {
    const i = pool.findIndex((u) => fits(u, allowed));
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  };
  const tapFor = (allowed) => {
    const cands = sources
      .filter((s) => !used.has(s.card))
      .map((s) => ({ s, opt: s.options.find((o) => o.some((u) => fits(u, allowed))) }))
      .filter((c) => c.opt)
      .sort((a, b) => flex(a.s) - flex(b.s));
    if (!cands.length) return false;
    const { s, opt } = cands[0];
    used.add(s.card);
    const units = [...opt];
    units.splice(units.findIndex((u) => fits(u, allowed)), 1);
    pool.push(...units); // el sobrante queda en la reserva (CR 106.4)
    return true;
  };

  const pips = [...cost.pips].sort(
    (a, b) => a.any.length - b.any.length + Number(!!(a.phyrexian || a.twoGeneric)) - Number(!!(b.phyrexian || b.twoGeneric))
  );
  for (const pip of pips) {
    if (fromPool(pip.any) || tapFor(pip.any)) continue;
    if (pip.twoGeneric) {
      generic += 2;
      continue;
    }
    if (pip.phyrexian && life - lifePaid > 2) {
      lifePaid += 2; // CR 107.4f: pagar 2 vidas
      continue;
    }
    return { ok: false };
  }
  for (let i = 0; i < generic; i++) {
    if (pool.length) {
      pool.shift();
      continue;
    }
    const cands = sources.filter((s) => !used.has(s.card)).sort((a, b) => flex(a) - flex(b) || maxUnits(b) - maxUnits(a));
    if (!cands.length) return { ok: false };
    const s = cands[0];
    const opt = [...s.options].sort((a, b) => b.length - a.length)[0];
    used.add(s.card);
    pool.push(...opt.slice(1));
  }
  return { ok: true, used: [...used], pool, lifePaid };
}

/** Resumen de maná potencial por color para la UI. */
export function manaSummary(sources) {
  const out = { total: 0, colors: new Set() };
  for (const s of sources) {
    out.total += maxUnits(s);
    for (const u of s.options.flat()) {
      if (u === '*') COLORS.forEach((c) => out.colors.add(c));
      else out.colors.add(u);
    }
  }
  return out;
}
