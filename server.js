// Servidor sin dependencias: sirve /public, importa decks (/api/deck), cachea cartas (/api/cards)
// y hospeda salas multijugador LAN (/api/rooms).

import http from 'node:http';
import os from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDeck, finalize, SOURCES } from './src/sources.js';
import { parseDeckText } from './public/lib/deckText.js';
import { getCards } from './src/cards.js';
import * as Rooms from './src/rooms.js';
import { staticPath } from './src/staticPath.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // escuchar en la LAN
const CACHE_MS = 10 * 60 * 1000;
const deckCache = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function lanUrls(port = PORT) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`);
    }
  }
  return out;
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 300_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Petición demasiado grande.'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('JSON inválido.'), { status: 400 });
  }
}

async function handleRooms(req, res, url) {
  const m = url.pathname.match(/^\/api\/rooms(?:\/([A-Za-z0-9]{4}))?(?:\/([a-z]+))?\/?$/);
  if (!m) return sendJSON(res, 404, { error: 'Ruta no encontrada' });
  const [, code, action] = m;

  if (!code && req.method === 'POST') {
    const body = await readBody(req);
    return sendJSON(res, 200, Rooms.createRoom(body.name));
  }
  if (code && action === 'join' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJSON(res, 200, Rooms.joinRoom(code, body.name));
  }
  const room = Rooms.getRoom(code);
  if (action === 'stream' && req.method === 'GET') return Rooms.subscribe(room, url.searchParams.get('token'), req, res);
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Método no permitido' });
  const body = await readBody(req);
  const tok = body.token;
  switch (action) {
    case 'config':
      Rooms.configure(room, tok, body);
      return sendJSON(res, 200, { ok: true });
    case 'deck':
      await Rooms.setDeck(room, tok, body);
      return sendJSON(res, 200, { ok: true });
    case 'start':
      Rooms.startGame(room, tok);
      return sendJSON(res, 200, { ok: true });
    case 'end':
      Rooms.endGame(room, tok);
      return sendJSON(res, 200, { ok: true });
    case 'act':
      return sendJSON(res, 200, Rooms.act(room, tok, body.msg));
    default:
      return sendJSON(res, 404, { error: 'Acción desconocida' });
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/sources') {
    return sendJSON(res, 200, SOURCES.map((s) => ({ id: s.id, label: s.label })));
  }
  if (url.pathname === '/api/info') {
    return sendJSON(res, 200, { lan: lanUrls(), port: PORT });
  }
  if (url.pathname.startsWith('/api/rooms')) return handleRooms(req, res, url);

  if (url.pathname === '/api/cards' && req.method === 'POST') {
    const body = await readBody(req, 1_000_000);
    const names = (Array.isArray(body.names) ? body.names : []).slice(0, 600).map(String);
    const { map, offline } = await getCards(names);
    return sendJSON(res, 200, { cards: [...map], offline });
  }

  if (url.pathname === '/api/deck' && req.method === 'GET') {
    const target = url.searchParams.get('url');
    if (!target) return sendJSON(res, 400, { error: 'Falta el parámetro ?url=' });
    const hit = deckCache.get(target);
    if (hit && Date.now() - hit.at < CACHE_MS) return sendJSON(res, 200, hit.deck);
    const deck = await importDeck(target);
    deckCache.set(target, { at: Date.now(), deck });
    return sendJSON(res, 200, deck);
  }

  if (url.pathname === '/api/deck' && req.method === 'POST') {
    const body = await readBody(req);
    const parsed = parseDeckText(body.text || '');
    if (!parsed.cards.length) return sendJSON(res, 400, { error: 'No se encontraron cartas en el texto.' });
    return sendJSON(res, 200, finalize({ ...parsed, name: body.name || 'Lista pegada', source: 'Texto' }));
  }

  return sendJSON(res, 404, { error: 'Ruta no encontrada' });
}

async function handleStatic(req, res, url) {
  const file = staticPath(ROOT, url.pathname);
  if (!file) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await handleStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJSON(res, status, { error: err.message || 'Error interno' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`⚡ Quad The Gathering en http://localhost:${PORT}`);
  const lan = lanUrls();
  if (lan.length) {
    console.log('🌐 Para jugar en LAN, tus amigos abren una de estas direcciones:');
    for (const u of lan) console.log(`   ${u}`);
  }
});
