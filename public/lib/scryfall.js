// Enriquecimiento de cartas con la API pública de Scryfall (permite CORS).
// https://scryfall.com/docs/api/cards/collection — máximo 75 identificadores por petición.

const cache = new Map();
const API = 'https://api.scryfall.com/cards/collection';

function frontName(name) {
  return name.split(' // ')[0].trim();
}

function key(name) {
  return frontName(name).toLowerCase();
}

/** Reduce un objeto de Scryfall a lo que necesita la mesa. */
export function summarize(card) {
  const face = card.card_faces?.[0] || {};
  const imgs = card.image_uris || face.image_uris || {};
  const oracle = card.oracle_text ?? (card.card_faces || []).map((f) => f.oracle_text || '').join('\n');
  return {
    name: card.name,
    cmc: card.cmc ?? 0,
    typeLine: card.type_line || face.type_line || '',
    manaCost: card.mana_cost ?? face.mana_cost ?? '',
    oracle,
    power: card.power ?? face.power ?? null,
    toughness: card.toughness ?? face.toughness ?? null,
    loyalty: card.loyalty ?? face.loyalty ?? null,
    keywords: card.keywords || [],
    colors: card.colors || face.colors || [],
    colorIdentity: card.color_identity || [],
    gameChanger: Boolean(card.game_changer),
    usd: parseFloat(card.prices?.usd || card.prices?.usd_foil || '0') || 0,
    img: imgs.normal || imgs.large || null,
    imgSmall: imgs.small || imgs.normal || null,
    art: imgs.art_crop || null,
    scryfall: card.scryfall_uri || null,
  };
}

/** Carta de reemplazo cuando Scryfall no la encuentra. */
export function placeholder(name) {
  const isBasic = /^(snow-covered )?(plains|island|swamp|mountain|forest|wastes)$/i.test(name);
  return {
    name,
    cmc: 0,
    typeLine: isBasic ? 'Basic Land' : 'Unknown',
    manaCost: '',
    oracle: '',
    power: null,
    toughness: null,
    keywords: [],
    colors: [],
    colorIdentity: [],
    gameChanger: false,
    usd: 0,
    img: null,
    imgSmall: null,
    art: null,
    missing: !isBasic,
  };
}

/** Carga entradas previamente guardadas (caché en disco del servidor). */
export function primeCache(obj) {
  for (const [k, v] of Object.entries(obj || {})) if (v && !v.missing) cache.set(k, v);
}

/** Exporta la caché (solo cartas encontradas) para guardarla en disco. */
export function exportCache() {
  const out = {};
  for (const [k, v] of cache) if (!v.missing) out[k] = v;
  return out;
}

/**
 * Busca la información de una lista de nombres.
 * @param {string[]} names
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<Map<string, object>>} mapa nombre-en-minúsculas -> resumen
 */
export async function fetchCards(names, onProgress, { headers = {} } = {}) {
  const unique = [...new Set(names.map(key))];
  const pending = unique.filter((n) => !cache.has(n));
  const original = new Map(names.map((n) => [key(n), frontName(n)]));

  for (let i = 0; i < pending.length; i += 75) {
    const chunk = pending.slice(i, i + 75);
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify({ identifiers: chunk.map((n) => ({ name: original.get(n) })) }),
    });
    if (!res.ok) throw new Error(`Scryfall respondió ${res.status}`);
    const data = await res.json();
    for (const card of data.data || []) {
      const s = summarize(card);
      cache.set(key(card.name), s);
      // También indexar por la cara frontal y por el nombre pedido
      cache.set(key(frontName(card.name)), s);
    }
    for (const nf of data.not_found || []) {
      if (nf.name) cache.set(key(nf.name), placeholder(nf.name));
    }
    onProgress?.(Math.min(i + 75, pending.length), pending.length);
    if (i + 75 < pending.length) await new Promise((r) => setTimeout(r, 110)); // rate limit
  }

  const out = new Map();
  for (const n of unique) out.set(n, cache.get(n) || placeholder(original.get(n)));
  return out;
}

/** Mapa solo con lo que ya está en caché (para modo sin conexión). */
export function cachedLookup(names) {
  const out = new Map();
  for (const n of names) out.set(key(n), cache.get(key(n)) || placeholder(frontName(n)));
  return out;
}

export function lookup(map, name) {
  return map.get(key(name)) || placeholder(name);
}
