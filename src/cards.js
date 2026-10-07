// Caché de cartas en el servidor: el anfitrión descarga de Scryfall una sola vez
// y comparte los datos con todos los jugadores de la LAN (data/card-cache.json).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCards, primeCache, exportCache, cachedLookup } from '../public/lib/scryfall.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'card-cache.json');
const UA = 'QuadTheGathering/0.2 (+https://github.com/perezjpg/quad-the-gathering)';
let loaded = false;
let saveTimer = null;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    primeCache(JSON.parse(await readFile(FILE, 'utf8')));
  } catch {
    // primera ejecución: no hay caché todavía
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(FILE, JSON.stringify(exportCache()));
    } catch (err) {
      console.warn('No se pudo guardar la caché de cartas:', err.message);
    }
  }, 1000);
}

/** Devuelve { map, offline } — si Scryfall no responde, usa la caché y cartas de reemplazo. */
export async function getCards(names) {
  await ensureLoaded();
  try {
    const map = await fetchCards(names, null, { headers: { 'User-Agent': UA } });
    scheduleSave();
    return { map, offline: false };
  } catch (err) {
    console.warn('Scryfall no disponible, usando caché local:', err.message);
    return { map: cachedLookup(names), offline: true };
  }
}
