// Salas LAN: el servidor del anfitrión ejecuta la partida y cada jugador se conecta desde su navegador.
// Transporte: Server-Sent Events (servidor → jugador) + POST (jugador → servidor). Sin dependencias.

import { randomBytes } from 'node:crypto';
import { GameSession } from '../public/lib/session.js';
import { DEMO_DECKS } from '../public/lib/demo.js';
import { parseDeckText } from '../public/lib/deckText.js';
import { buildEntries, setCommander, summarizeDeck } from '../public/lib/deckBuild.js';
import { importDeck, finalize } from './sources.js';
import { getCards } from './cards.js';

const SEAT_COLORS = ['#39c5bb', '#9b5de5', '#e63946', '#f4a261'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

const token = () => randomBytes(16).toString('hex');

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw fail('La sala no existe (¿el anfitrión la cerró?).', 404);
  return room;
}

export function seatOf(room, tok) {
  return room.seats.findIndex((s) => s.token && s.token === tok);
}

function requireSeat(room, tok) {
  const i = seatOf(room, tok);
  if (i < 0) throw fail('No perteneces a esta sala.', 403);
  return i;
}

function requireHost(room, tok) {
  if (tok !== room.hostToken) throw fail('Solo el anfitrión puede hacer esto.', 403);
}

export function createRoom(name) {
  const room = {
    code: newCode(),
    hostToken: token(),
    count: 4,
    speed: 'normal',
    fullStops: false,
    session: null,
    clients: new Set(),
    lastActive: Date.now(),
    seats: [],
  };
  room.seats = Array.from({ length: 4 }, (_, i) => ({
    name: i === 0 ? clean(name) || 'Anfitrión' : `Asiento ${i + 1}`,
    kind: i === 0 ? 'human' : 'open',
    token: i === 0 ? room.hostToken : null,
    deck: null,
    entries: null,
    summary: null,
    loading: false,
    error: null,
  }));
  rooms.set(room.code, room);
  return { code: room.code, token: room.hostToken, seat: 0 };
}

const clean = (s) => String(s || '').trim().slice(0, 20);

export function joinRoom(code, name) {
  const room = getRoom(code);
  if (room.session) throw fail('La partida ya empezó.');
  const i = room.seats.slice(0, room.count).findIndex((s) => s.kind === 'open');
  if (i < 0) throw fail('La sala está llena.');
  const seat = room.seats[i];
  Object.assign(seat, { kind: 'human', token: token(), name: clean(name) || `Jugador ${i + 1}` });
  broadcast(room);
  return { code: room.code, token: seat.token, seat: i };
}

export function configure(room, tok, body) {
  requireHost(room, tok);
  if ([2, 3, 4].includes(body.count)) room.count = body.count;
  if (body.speed) room.speed = body.speed;
  if (typeof body.fullStops === 'boolean') room.fullStops = body.fullStops;
  if (Number.isInteger(body.seat) && body.seat > 0 && room.seats[body.seat]) {
    const s = room.seats[body.seat];
    if (body.kind === 'ai' && s.kind !== 'ai') Object.assign(s, { kind: 'ai', token: null, name: body.name ? clean(body.name) : `IA ${body.seat + 1}` });
    else if (body.kind === 'open') Object.assign(s, { kind: 'open', token: null, name: `Asiento ${body.seat + 1}` });
    if (body.name && s.kind === 'ai') s.name = clean(body.name);
  }
  if (room.session) {
    room.session.dispatch(0, { type: 'setting', speed: body.speed, fullStops: body.fullStops, paused: body.paused }, { isHost: true });
  }
  broadcast(room);
}

export async function setDeck(room, tok, body) {
  const me = requireSeat(room, tok);
  const target = Number.isInteger(body.seat) ? body.seat : me;
  const seat = room.seats[target];
  if (!seat) throw fail('Asiento inválido.');
  if (target !== me && !(tok === room.hostToken && seat.kind === 'ai')) throw fail('Solo puedes cambiar tu propio deck.', 403);

  if (body.commander && seat.entries) {
    setCommander(seat.entries, body.commander);
    seat.summary = summarizeDeck(seat.deck, seat.entries);
    broadcast(room);
    return;
  }

  seat.loading = true;
  seat.error = null;
  broadcast(room);
  try {
    let deck;
    if (body.demo != null) {
      const d = DEMO_DECKS[body.demo % DEMO_DECKS.length];
      deck = finalize({ ...parseDeckText(d.text), name: d.name, source: 'Demo' });
    } else if (body.url) deck = await importDeck(body.url);
    else if (body.text) {
      const parsed = parseDeckText(body.text);
      if (!parsed.cards.length) throw fail('No se encontraron cartas en el texto.');
      deck = finalize({ ...parsed, name: body.name || 'Lista pegada', source: 'Texto' });
    } else throw fail('Envía un link, una lista o un deck demo.');
    const { map, offline } = await getCards(deck.cards.map((c) => c.name));
    seat.deck = deck;
    seat.entries = buildEntries(deck, map);
    seat.summary = { ...summarizeDeck(deck, seat.entries), offline };
  } catch (err) {
    seat.error = err.message;
  } finally {
    seat.loading = false;
    broadcast(room);
  }
}

export function startGame(room, tok) {
  requireHost(room, tok);
  const seats = room.seats.slice(0, room.count);
  if (seats.some((s) => s.kind === 'open')) throw fail('Hay asientos vacíos: espera a que se unan o conviértelos en IA.');
  if (seats.some((s) => !s.entries)) throw fail('Todos los asientos necesitan un deck.');
  room.session?.abort();
  const session = new GameSession(
    seats.map((s, i) => ({
      name: s.name,
      isAI: s.kind === 'ai',
      color: SEAT_COLORS[i],
      deckName: s.deck.name,
      entries: s.entries,
    })),
    { speed: room.speed, fullStops: room.fullStops }
  );
  room.session = session;
  session.onChange(() => broadcast(room));
  session.run();
  broadcast(room);
}

export function endGame(room, tok) {
  requireHost(room, tok);
  room.session?.abort();
  room.session = null;
  broadcast(room);
}

export function act(room, tok, msg) {
  const seat = requireSeat(room, tok);
  if (!room.session) throw fail('La partida no ha empezado.');
  room.lastActive = Date.now();
  return room.session.dispatch(seat, msg, { isHost: tok === room.hostToken });
}

// ---------- Streaming ----------

function lobbyView(room, seat) {
  return {
    type: 'lobby',
    code: room.code,
    count: room.count,
    you: seat,
    isHost: seat === 0,
    speed: room.speed,
    fullStops: room.fullStops,
    seats: room.seats.slice(0, room.count).map((s, i) => ({
      idx: i,
      name: s.name,
      kind: s.kind,
      color: SEAT_COLORS[i],
      online: [...room.clients].some((c) => c.seat === i),
      deck: s.summary,
      loading: s.loading,
      error: s.error,
    })),
  };
}

function send(client, payload) {
  client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function broadcast(room) {
  for (const client of room.clients) {
    try {
      if (room.session) send(client, { type: 'view', code: room.code, isHost: client.seat === 0, view: room.session.view(client.seat) });
      else send(client, lobbyView(room, client.seat));
    } catch {
      room.clients.delete(client);
    }
  }
}

export function subscribe(room, tok, req, res) {
  const seat = requireSeat(room, tok);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client = { res, seat };
  room.clients.add(client);
  room.lastActive = Date.now();
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    room.clients.delete(client);
    broadcast(room);
  });
  broadcast(room);
}

// Limpieza de salas abandonadas (2 h sin clientes)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.lastActive > 2 * 60 * 60 * 1000) {
      room.session?.abort();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();
