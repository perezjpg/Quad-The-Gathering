// Servidor mínimo sin dependencias: sirve /public y expone /api/deck.
// El proxy es necesario porque Archidekt/Moxfield/etc. no permiten CORS desde el navegador.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDeck, finalize, SOURCES } from './src/sources.js';
import { parseDeckText } from './public/lib/deckText.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 200_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Lista demasiado grande.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/sources') {
    return sendJSON(res, 200, SOURCES.map((s) => ({ id: s.id, label: s.label })));
  }

  if (url.pathname === '/api/deck' && req.method === 'GET') {
    const target = url.searchParams.get('url');
    if (!target) return sendJSON(res, 400, { error: 'Falta el parámetro ?url=' });
    const hit = cache.get(target);
    if (hit && Date.now() - hit.at < CACHE_MS) return sendJSON(res, 200, hit.deck);
    const deck = await importDeck(target);
    cache.set(target, { at: Date.now(), deck });
    return sendJSON(res, 200, deck);
  }

  if (url.pathname === '/api/deck' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const parsed = parseDeckText(body.text || '');
    if (!parsed.cards.length) return sendJSON(res, 400, { error: 'No se encontraron cartas en el texto.' });
    return sendJSON(res, 200, finalize({ ...parsed, name: body.name || 'Lista pegada', source: 'Texto' }));
  }

  return sendJSON(res, 404, { error: 'Ruta no encontrada' });
}

async function handleStatic(req, res, url) {
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
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
    sendJSON(res, status, { error: err.message || 'Error interno' });
  }
});

server.listen(PORT, () => {
  console.log(`⚡ Quad The Gathering en http://localhost:${PORT}`);
});
