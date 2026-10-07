// Construcción de entradas de deck a partir de una lista normalizada + datos de cartas.
// Compartido entre navegador (modo local) y servidor (salas LAN).

import { lookup } from './scryfall.js';
import { analyze } from './stats.js';

export function buildEntries(deck, infoMap) {
  const entries = deck.cards.map((c) => ({ name: c.name, qty: c.qty, board: c.board, info: lookup(infoMap, c.name) }));
  autoPickCommander(entries);
  return entries;
}

export function legendaryCandidates(entries) {
  return (entries || []).filter(
    (e) => e.board === 'main' && /Legendary/.test(e.info.typeLine) && /(Creature|Planeswalker)/.test(e.info.typeLine)
  );
}

export function autoPickCommander(entries) {
  if (entries.some((e) => e.board === 'commander')) return;
  const c = legendaryCandidates(entries)[0];
  if (c) setCommander(entries, c.info.name);
}

/** Mueve `name` a la zona de comandante (devuelve las entradas actualizadas). */
export function setCommander(entries, name) {
  for (const e of entries) if (e.board === 'commander') e.board = 'main';
  const e = entries.find((x) => x.info.name === name || x.name === name);
  if (e) {
    if (e.qty > 1) {
      e.qty--;
      entries.push({ ...e, qty: 1, board: 'commander' });
    } else e.board = 'commander';
  }
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].qty <= 0) entries.splice(i, 1);
  return entries;
}

export function summarizeDeck(deck, entries) {
  return {
    name: deck.name,
    source: deck.source,
    author: deck.author || '',
    commanders: entries.filter((e) => e.board === 'commander').map((e) => e.info.name),
    art: entries.find((e) => e.board === 'commander')?.info.art || null,
    candidates: legendaryCandidates(entries).map((e) => e.info.name),
    stats: analyze(entries),
  };
}
