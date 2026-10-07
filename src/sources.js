// Detección de sitio + descarga + normalización de decks.
// Formato normalizado:
// { source, url, name, format, author, commanders: string[], cards: {name, qty, board}[] }

import { parseDeckText, mergeDuplicates } from '../public/lib/deckText.js';

const UA = 'QuadTheGathering/0.1 (+https://github.com/perezjpg/quad-the-gathering)';

export const SOURCES = [
  {
    id: 'archidekt',
    label: 'Archidekt',
    match: (u) => u.hostname.endsWith('archidekt.com') && u.pathname.match(/\/decks\/(\d+)/),
    async fetch(m) {
      const data = await getJSON(`https://archidekt.com/api/decks/${m[1]}/`);
      return normalizeArchidekt(data);
    },
  },
  {
    id: 'moxfield',
    label: 'Moxfield',
    match: (u) => u.hostname.endsWith('moxfield.com') && u.pathname.match(/\/decks\/([\w-]+)/),
    async fetch(m) {
      try {
        return normalizeMoxfield(await getJSON(`https://api2.moxfield.com/v3/decks/all/${m[1]}`));
      } catch (err) {
        // v2 como respaldo
        return normalizeMoxfield(await getJSON(`https://api2.moxfield.com/v2/decks/all/${m[1]}`), err);
      }
    },
  },
  {
    id: 'deckstats',
    label: 'Deckstats',
    match: (u) => u.hostname.endsWith('deckstats.net') && u.pathname.match(/\/decks\/(\d+)\/(\d+)/),
    async fetch(m) {
      const base = `https://deckstats.net/api.php?action=get_deck&id_type=saved&owner_id=${m[1]}&id=${m[2]}`;
      const data = await getJSON(`${base}&response_type=list`);
      const parsed = parseDeckText(data.list || '');
      return { name: data.name, format: '', ...parsed };
    },
  },
  {
    id: 'tappedout',
    label: 'TappedOut',
    match: (u) => u.hostname.endsWith('tappedout.net') && u.pathname.match(/\/mtg-decks\/([\w-]+)/),
    async fetch(m) {
      const text = await getText(`https://tappedout.net/mtg-decks/${m[1]}/?fmt=txt`);
      return { name: m[1].replace(/-/g, ' '), ...parseDeckText(text, { blankLineIsSideboard: true }) };
    },
  },
  {
    id: 'mtggoldfish',
    label: 'MTGGoldfish',
    match: (u) => u.hostname.endsWith('mtggoldfish.com') && u.pathname.match(/\/deck\/(?:download\/)?(\d+)/),
    async fetch(m) {
      const text = await getText(`https://www.mtggoldfish.com/deck/download/${m[1]}`);
      return { name: `MTGGoldfish #${m[1]}`, ...parseDeckText(text, { blankLineIsSideboard: true }) };
    },
  },
];

export function detectSource(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  for (const s of SOURCES) {
    const m = s.match(u);
    if (m) return { source: s, match: m, url: u.toString() };
  }
  return null;
}

export async function importDeck(rawUrl) {
  const hit = detectSource(rawUrl);
  if (!hit) {
    const err = new Error(
      'Sitio no soportado. Usa Archidekt, Moxfield, Deckstats, TappedOut o MTGGoldfish — o pega la lista como texto.'
    );
    err.status = 400;
    throw err;
  }
  const deck = await hit.source.fetch(hit.match);
  return finalize({ ...deck, source: hit.source.label, url: hit.url });
}

export function finalize(deck) {
  const cards = mergeDuplicates((deck.cards || []).filter((c) => c.name && c.qty > 0));
  const commanders = deck.commanders?.length
    ? deck.commanders
    : cards.filter((c) => c.board === 'commander').map((c) => c.name);
  return {
    source: deck.source || 'Texto',
    url: deck.url || null,
    name: deck.name || 'Deck sin nombre',
    format: deck.format || '',
    author: deck.author || '',
    commanders,
    cards,
  };
}

// ---------- Normalizadores (exportados para tests) ----------

export function normalizeArchidekt(data) {
  const excluded = new Set(
    (data.categories || []).filter((c) => c.includedInDeck === false).map((c) => c.name)
  );
  const cards = [];
  for (const entry of data.cards || []) {
    const name = entry.card?.oracleCard?.name || entry.card?.name;
    if (!name) continue;
    const cats = entry.categories || [];
    let board = 'main';
    if (cats.some((c) => /commander/i.test(c))) board = 'commander';
    else if (cats.some((c) => /sideboard/i.test(c))) board = 'side';
    else if (cats.some((c) => excluded.has(c) || /maybeboard/i.test(c))) board = 'maybe';
    cards.push({ name, qty: entry.quantity || 1, board });
  }
  return {
    name: data.name,
    format: ARCHIDEKT_FORMATS[data.deckFormat] || '',
    author: data.owner?.username || '',
    cards,
  };
}

const ARCHIDEKT_FORMATS = {
  1: 'Standard', 2: 'Modern', 3: 'Commander', 4: 'Legacy', 5: 'Vintage', 6: 'Pauper',
  7: 'Custom', 8: 'Frontier', 9: 'Future Standard', 10: 'Penny Dreadful', 11: '1v1 Commander',
  12: 'Duel Commander', 13: 'Brawl', 14: 'Oathbreaker', 15: 'Pioneer', 16: 'Historic',
  17: 'Pauper EDH', 18: 'Alchemy', 19: 'Explorer', 20: 'Historic Brawl', 21: 'Gladiator',
  22: 'Premodern', 23: 'PreDH', 24: 'Timeless',
};

export function normalizeMoxfield(data) {
  const cards = [];
  const boardMap = {
    commanders: 'commander', companions: 'commander', mainboard: 'main',
    sideboard: 'side', maybeboard: 'maybe', signatureSpells: 'main',
  };
  // v3: data.boards.<board>.cards = { id: { quantity, card: { name } } }
  // v2: data.<board> = { name: { quantity, card: { name } } }
  const boards = data.boards || data;
  for (const [key, board] of Object.entries(boardMap)) {
    const b = boards[key];
    if (!b) continue;
    const entries = b.cards || b;
    for (const [k, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.card?.name || k;
      cards.push({ name, qty: entry.quantity || 1, board });
    }
  }
  return {
    name: data.name,
    format: data.format || '',
    author: data.createdByUser?.userName || data.authors?.[0]?.userName || '',
    cards,
  };
}

// ---------- HTTP ----------

async function request(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(
        res.status === 404
          ? 'Deck no encontrado (¿es privado?).'
          : `El sitio respondió ${res.status}. Si persiste, pega la lista como texto.`
      );
      err.status = res.status === 404 ? 404 : 502;
      throw err;
    }
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('Tiempo de espera agotado al contactar el sitio.');
      e.status = 504;
      throw e;
    }
    if (!err.status) err.status = 502;
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function getJSON(url) {
  return (await request(url)).json();
}

async function getText(url) {
  return (await request(url)).text();
}
