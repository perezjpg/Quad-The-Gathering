// Parser de listas de texto (formato MTGO / Arena / Moxfield / Archidekt export).
// Se usa tanto en el servidor como en el navegador (módulo ES sin dependencias).

const SECTION_ALIASES = [
  { re: /^(commanders?|comandantes?|cmdr)$/i, board: 'commander' },
  { re: /^(companions?|compañeros?)$/i, board: 'commander' },
  { re: /^(sideboard|side|banquillo)$/i, board: 'side' },
  { re: /^(maybeboard|maybe|considering|quizás)$/i, board: 'maybe' },
  { re: /^(deck|main|mainboard|main deck|mazo|library)$/i, board: 'main' },
];

function sectionFromHeader(line) {
  const clean = line
    .replace(/^\/\/\s*/, '')
    .replace(/^#+\s*/, '')
    .replace(/:$/, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .trim();
  for (const { re, board } of SECTION_ALIASES) {
    if (re.test(clean)) return board;
  }
  return null;
}

/** Normaliza el nombre de una carta para buscarla en Scryfall. */
export function cleanCardName(raw) {
  let name = raw
    .replace(/\s+\*[A-Z]+\*\s*/g, ' ') // *F*, *E*, *CMDR*
    .replace(/\s+\^[^^]*\^/g, ' ') // ^Tag^ (Moxfield)
    .replace(/\s+#\S.*$/, '') // #tags
    .replace(/\s+\[[^\]]*\]\s*$/, '') // [Categoria] (Archidekt)
    .replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+[\w★-]+)?\s*$/, '') // (SET) 123
    .replace(/\s+\[[A-Za-z0-9]{2,6}\](\s+[\w★-]+)?\s*$/, '') // [SET] 123
    .trim();
  // Caras dobles: "A / B" o "A//B" -> "A // B"
  name = name.replace(/\s*\/\/?\s*/g, ' // ');
  return name;
}

/**
 * Convierte una lista de texto en cartas normalizadas.
 * @param {string} text
 * @param {{ blankLineIsSideboard?: boolean }} [opts]
 * @returns {{ cards: {name:string, qty:number, board:string}[], commanders: string[] }}
 */
export function parseDeckText(text, opts = {}) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const cards = [];
  let board = 'main';
  let seenCards = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (opts.blankLineIsSideboard && seenCards && board === 'main') board = 'side';
      continue;
    }
    if (/^(about|name)\s/i.test(line)) continue; // cabecera de Arena

    const header = sectionFromHeader(line);
    if (header) {
      board = header;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('#')) continue;

    let m = line.match(/^(SB:\s*)?(\d+)\s*x?\s+(.+)$/i);
    let qty = 1;
    let rest = line;
    let lineBoard = board;
    if (m) {
      if (m[1]) lineBoard = 'side';
      qty = parseInt(m[2], 10);
      rest = m[3];
    }

    // Archidekt export: "1x Sol Ring (cmm) 410 [Commander{top}]"
    const cat = rest.match(/\[([^\]]+)\]\s*$/);
    if (cat) {
      const c = cat[1].toLowerCase();
      if (c.includes('commander')) lineBoard = 'commander';
      else if (c.includes('maybeboard')) lineBoard = 'maybe';
      else if (c.includes('sideboard')) lineBoard = 'side';
    }
    if (/\*CMDR\*/i.test(rest)) lineBoard = 'commander';

    const name = cleanCardName(rest);
    if (!name || qty <= 0) continue;
    cards.push({ name, qty, board: lineBoard });
    seenCards = true;
  }

  // Heurística MTGGoldfish/TappedOut: 98-99 en main y 1-2 cartas "sideboard" => comandantes.
  const mainCount = sum(cards.filter((c) => c.board === 'main'));
  const side = cards.filter((c) => c.board === 'side');
  const hasCommander = cards.some((c) => c.board === 'commander');
  if (!hasCommander && side.length > 0 && sum(side) <= 2 && mainCount >= 97 && mainCount <= 99) {
    side.forEach((c) => (c.board = 'commander'));
  }

  return {
    cards: mergeDuplicates(cards),
    commanders: cards.filter((c) => c.board === 'commander').map((c) => c.name),
  };
}

function sum(list) {
  return list.reduce((n, c) => n + c.qty, 0);
}

export function mergeDuplicates(cards) {
  const map = new Map();
  for (const c of cards) {
    const key = `${c.board}|${c.name.toLowerCase()}`;
    if (map.has(key)) map.get(key).qty += c.qty;
    else map.set(key, { ...c });
  }
  return [...map.values()];
}
