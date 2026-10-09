import { parseDeckText } from './lib/deckText.js';
import { fetchCards } from './lib/scryfall.js';
import { BRACKET_NAMES } from './lib/stats.js';
import { DEMO_DECKS } from './lib/demo.js';
import { buildEntries, setCommander, summarizeDeck } from './lib/deckBuild.js';
import { GameSession, SPEEDS } from './lib/session.js';

// ---------- Estado ----------

const SEAT_COLORS = ['#39c5bb', '#9b5de5', '#e63946', '#f4a261'];
const STEP_LABELS = [
  ['untap', 'Untap', '502'], ['upkeep', 'Upkeep', '503'], ['draw', 'Draw', '504'], ['main1', 'Main 1', '505'],
  ['beginCombat', 'Combat', '507'], ['declareAttackers', 'Attackers', '508'], ['declareBlockers', 'Blockers', '509'],
  ['combatDamage', 'Damage', '510'], ['endCombat', 'End combat', '511'], ['main2', 'Main 2', '505'], ['end', 'End', '513'], ['cleanup', 'Cleanup', '514'],
];

const state = {
  mode: 'setup', // setup | lobby | table
  count: 4,
  seats: Array.from({ length: 4 }, (_, i) => newSeat(i)),
  settings: { speed: 'normal', fullStops: false },
  simulate: false,
  client: null,
  view: null,
  lobby: null,
  lanUrls: [],
  lobbyInputs: {},
  shownDecision: null,
};

function newSeat(i) {
  return {
    name: i === 0 ? 'Tú' : `Jugador ${i + 1}`,
    isAI: i !== 0,
    mode: 'url',
    url: '',
    text: '',
    status: 'idle',
    message: '',
    deck: null,
    entries: null,
    summary: null,
  };
}

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Persistencia (best effort) ----------

function save() {
  try {
    const data = state.seats.map(({ name, isAI, mode, url, text }) => ({ name, isAI, mode, url, text }));
    localStorage.setItem('qtg.setup', JSON.stringify({ count: state.count, seats: data, settings: state.settings }));
  } catch {}
}

function restore() {
  try {
    const hash = new URLSearchParams(location.hash.slice(1)).get('pod');
    if (hash) {
      const pod = JSON.parse(decodeURIComponent(escape(atob(hash))));
      state.count = Math.min(4, Math.max(2, pod.length));
      pod.forEach((p, i) => Object.assign(state.seats[i], { name: p.n, url: p.u || '', isAI: !!p.ai, mode: 'url' }));
      return;
    }
    const raw = localStorage.getItem('qtg.setup');
    if (!raw) return;
    const data = JSON.parse(raw);
    state.count = data.count || 4;
    Object.assign(state.settings, data.settings || {});
    data.seats?.forEach((s, i) => state.seats[i] && Object.assign(state.seats[i], s));
  } catch {}
}

// ---------- Datos de cartas ----------

/** Usa la caché del servidor (compartida en LAN); si no hay servidor, va directo a Scryfall. */
async function lookupCards(names, onProgress) {
  try {
    const res = await fetch('/api/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }) });
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
      const data = await res.json();
      if (data.offline) toast('Sin conexión a Scryfall: algunas cartas saldrán sin imagen.');
      return new Map(data.cards);
    }
  } catch {}
  return fetchCards(names, onProgress);
}

// ---------- Carga de decks (modo local) ----------

async function loadSeat(i) {
  const seat = state.seats[i];
  seat.status = 'loading';
  seat.message = 'Importando…';
  renderSetup();
  try {
    let deck;
    if (seat.mode === 'url') {
      if (!seat.url.trim()) throw new Error('Pega un link de deck primero.');
      let res;
      try {
        res = await fetch(`/api/deck?url=${encodeURIComponent(seat.url.trim())}`);
      } catch {
        throw new Error('No hay servidor. Ejecuta "npm start" o usa la pestaña Texto.');
      }
      if (!(res.headers.get('content-type') || '').includes('json')) throw new Error('Para importar por link ejecuta "npm start" (o pega la lista como texto).');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo importar el deck.');
      deck = data;
    } else {
      const parsed = parseDeckText(seat.text);
      if (!parsed.cards.length) throw new Error('No se encontraron cartas en el texto.');
      deck = { ...parsed, name: seat.deckName || 'Lista pegada', source: 'Texto' };
    }
    seat.message = 'Buscando cartas…';
    renderSetup();
    const info = await lookupCards(deck.cards.map((c) => c.name), (done, total) => {
      seat.message = `Scryfall ${done}/${total}…`;
      renderSetup();
    });
    seat.deck = deck;
    seat.entries = buildEntries(deck, info);
    seat.summary = summarizeDeck(deck, seat.entries);
    seat.status = 'ready';
    seat.message = '';
  } catch (err) {
    seat.status = 'error';
    seat.message = err.message;
  }
  save();
  renderSetup();
}

async function loadDemo() {
  state.count = 4;
  DEMO_DECKS.forEach((d, i) => {
    Object.assign(state.seats[i], { mode: 'text', text: d.text, deckName: d.name, name: i === 0 ? 'Tú' : d.player });
  });
  renderSetup();
  await Promise.all(DEMO_DECKS.map((_, i) => loadSeat(i)));
}

function shareLink() {
  const pod = state.seats.slice(0, state.count).map((s) => ({ n: s.name, u: s.mode === 'url' ? s.url : '', ai: s.isAI }));
  const url = `${location.origin}${location.pathname}#pod=${btoa(unescape(encodeURIComponent(JSON.stringify(pod))))}`;
  copy(url, '🔗 Link del pod copiado');
}

function copy(text, msg) {
  navigator.clipboard?.writeText(text).then(
    () => toast(msg),
    () => prompt('Copia este texto:', text)
  );
}

// ---------- Render: resumen de deck (compartido setup/lobby) ----------

const PIP = { W: '☀', U: '💧', B: '💀', R: '🔥', G: '🌳' };

function deckSummaryHTML(sum, { seat, editable }) {
  if (!sum) return '';
  const st = sum.stats;
  const max = Math.max(...st.curve, 1);
  return `
    <div class="deck-preview" ${sum.art ? `style="background-image:linear-gradient(180deg,transparent,var(--bg-2) 92%),url('${esc(sum.art)}')"` : ''}>
      <div class="deck-title">${esc(sum.name)}</div>
      <div class="deck-sub">${esc(sum.source)}${sum.author ? ' · ' + esc(sum.author) : ''}</div>
      <div class="cmdr">👑 ${sum.commanders.length ? sum.commanders.map(esc).join(' + ') : '<em>sin comandante</em>'}</div>
    </div>
    ${
      editable && (sum.candidates.length || sum.commanders.length)
        ? `<label class="pick">Comandante:
            <select data-commander="${seat}">
              ${sum.commanders.map((c) => `<option selected>${esc(c)}</option>`).join('')}
              ${sum.candidates.map((c) => `<option>${esc(c)}</option>`).join('')}
            </select></label>`
        : ''
    }
    <div class="stats">
      <div><b>${st.count}</b><span>cartas</span></div>
      <div><b>${st.avgMV}</b><span>MV prom.</span></div>
      <div><b>${st.lands}</b><span>tierras</span></div>
      <div><b>$${st.price}</b><span>precio</span></div>
    </div>
    <div class="pips">${st.colorIdentity.map((c) => `<span class="pip pip-${c}" title="${c}">${PIP[c]}</span>`).join('') || '<span class="pip">◇</span>'}
      <span class="bracket b${st.bracket}" title="Estimado por Game Changers, tutores, turnos extra y destrucción masiva de tierras">Bracket ${st.bracket} · ${BRACKET_NAMES[st.bracket]}</span>
    </div>
    <div class="curve" aria-label="Curva de maná">${st.curve
      .map((n, mv) => `<div class="bar" title="MV ${mv === 7 ? '7+' : mv}: ${n}"><i style="height:${(n / max) * 100}%"></i><span>${mv === 7 ? '7+' : mv}</span></div>`)
      .join('')}</div>
    <div class="tags">
      <span>Ramp ${st.ramp}</span><span>Robo ${st.draw}</span><span>Removal ${st.removal}</span><span>Wipes ${st.wipes}</span><span>Tutores ${st.tutors}</span>
      ${st.gameChangers.length ? `<span class="gc" title="${esc(st.gameChangers.join(', '))}">Game Changers ${st.gameChangers.length}</span>` : ''}
    </div>
    ${st.legality.map((w) => `<div class="warn small">⚖️ ${esc(w)}</div>`).join('')}
    ${st.missing.length ? `<div class="warn small">No encontradas en Scryfall: ${esc(st.missing.slice(0, 5).join(', '))}${st.missing.length > 5 ? '…' : ''}</div>` : ''}
    ${sum.offline ? '<div class="warn small">El anfitrión no tiene conexión a Scryfall: cartas sin imagen.</div>' : ''}`;
}

// ---------- Render: Setup ----------

function renderSetup() {
  if (state.mode !== 'setup') return;
  const root = $('#setup');
  const seats = state.seats.slice(0, state.count);
  const ready = seats.filter((s) => s.status === 'ready');
  const brackets = ready.map((s) => s.summary.stats.bracket);
  const unbalanced = brackets.length > 1 && Math.max(...brackets) - Math.min(...brackets) >= 2;
  const roomParam = new URLSearchParams(location.search).get('room') || '';

  root.innerHTML = `
    <section class="lan-panel">
      <h2>🌐 Multijugador LAN</h2>
      <p class="hint">Quien hospeda corre <code>npm start</code> y crea la sala. Los demás abren la dirección del anfitrión y se unen con el código. Funciona en la misma red o con Radmin VPN, Hamachi, ZeroTier o Tailscale.</p>
      <div class="lan-row">
        <input id="lan-name" placeholder="Tu nombre" maxlength="20" value="${esc(state.seats[0].name === 'Tú' ? '' : state.seats[0].name)}">
        <button class="btn primary small" data-act="room-create">Crear sala</button>
        <input id="lan-code" placeholder="Código" maxlength="4" value="${esc(roomParam)}" class="code-input">
        <button class="btn accent small" data-act="room-join">Unirse</button>
      </div>
    </section>
    <h2 class="section-title">🎴 Partida local (tú + IA)</h2>
    <div class="setup-bar">
      <div class="seg" role="group" aria-label="Jugadores">
        ${[2, 3, 4].map((n) => `<button class="${state.count === n ? 'on' : ''}" data-count="${n}">${n} jugadores</button>`).join('')}
      </div>
      <button class="btn ghost" data-act="demo">🎴 Decks demo</button>
      <button class="btn ghost" data-act="load-all">⬇ Cargar todos</button>
      <button class="btn ghost" data-act="share">🔗 Compartir pod</button>
    </div>
    ${unbalanced ? `<div class="warn">⚠️ Pod desbalanceado: brackets muy distintos (${brackets.join(' · ')}).</div>` : ''}
    <div class="seats">${seats.map((s, i) => seatCard(s, i)).join('')}</div>
    <div class="start-bar">
      <button class="btn primary" data-act="start" ${ready.length === seats.length ? '' : 'disabled'}>▶ Jugar en la mesa</button>
      <button class="btn accent" data-act="simulate" ${ready.length === seats.length ? '' : 'disabled'}>🤖 Simular partida (todo IA)</button>
      <label class="toggle" title="Detenerse en cada paso donde tengas prioridad y opciones (CR 117)"><input type="checkbox" data-setting="fullStops" ${state.settings.fullStops ? 'checked' : ''}> Paradas completas</label>
      <span class="hint">${ready.length}/${seats.length} decks listos</span>
    </div>`;
}

function seatCard(s, i) {
  return `
  <article class="seat" style="--pc:${SEAT_COLORS[i]}" data-seat="${i}">
    <header>
      <span class="dot"></span>
      <input class="name" data-field="name" value="${esc(s.name)}" aria-label="Nombre del jugador" maxlength="20">
      <label class="toggle"><input type="checkbox" data-field="isAI" ${s.isAI ? 'checked' : ''}> IA</label>
    </header>
    <div class="tabs">
      <button class="${s.mode === 'url' ? 'on' : ''}" data-mode="url">Link</button>
      <button class="${s.mode === 'text' ? 'on' : ''}" data-mode="text">Texto</button>
    </div>
    ${
      s.mode === 'url'
        ? `<input class="url" data-field="url" placeholder="https://archidekt.com/decks/…  ·  moxfield.com/decks/…" value="${esc(s.url)}">`
        : `<textarea data-field="text" rows="5" placeholder="1 Sol Ring&#10;1 Command Tower&#10;…  (pon 'Commander' arriba del comandante)">${esc(s.text)}</textarea>`
    }
    <div class="row-btns">
      <button class="btn small" data-act="load" ${s.status === 'loading' ? 'disabled' : ''}>${s.status === 'ready' ? '↻ Recargar' : 'Cargar deck'}</button>
      <span class="status ${s.status}">${esc(s.message)}</span>
    </div>
    ${s.status === 'ready' ? deckSummaryHTML(s.summary, { seat: i, editable: true }) : ''}
  </article>`;
}

// ---------- Clientes de juego ----------

/** Partida en este navegador (tú + IA, o asientos humanos por turnos en el mismo equipo). */
class LocalClient {
  constructor(session, { simulate }) {
    this.session = session;
    this.simulate = simulate;
    const g = session.game;
    this.viewer = Math.max(0, g.players.findIndex((p) => !p.isAI));
    this.isHost = true;
    session.onChange(() => this.push());
    session.run();
    this.push();
  }
  push() {
    const g = this.session.game;
    const humanPending = [...this.session.pending.keys()].find((i) => !g.players[i].isAI);
    if (humanPending != null) this.viewer = humanPending; // asientos humanos en el mismo equipo
    state.view = this.session.view(this.viewer, { revealAll: this.simulate });
    renderTable();
  }
  send(msg) {
    this.session.dispatch(this.viewer, msg, { isHost: true });
  }
  rematch() {
    startLocal(this.simulate);
  }
  close() {
    this.session.abort();
  }
}

/** Partida LAN: el servidor del anfitrión manda la vista por SSE y recibe acciones por POST. */
class RemoteClient {
  constructor(creds) {
    this.creds = creds;
    this.isHost = creds.seat === 0;
    this.connect();
  }
  connect() {
    const { code, token } = this.creds;
    this.es = new EventSource(`/api/rooms/${code}/stream?token=${encodeURIComponent(token)}`);
    this.es.onmessage = (e) => onServerMessage(JSON.parse(e.data));
    this.es.onerror = () => {
      if (this.es.readyState === EventSource.CLOSED) {
        toast('Conexión perdida con el anfitrión.');
        leaveOnline();
      } else toast('Reconectando…');
    };
  }
  async post(action, body = {}) {
    const res = await fetch(`/api/rooms/${this.creds.code}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.creds.token, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }
  send(msg) {
    this.post('act', { msg }).catch((e) => toast(e.message));
  }
  rematch() {
    this.post('start').catch((e) => toast(e.message));
  }
  close() {
    this.es?.close();
  }
}

function startLocal(simulate) {
  state.client?.close();
  state.simulate = simulate;
  const seats = state.seats.slice(0, state.count);
  const session = new GameSession(
    seats.map((s, i) => ({ name: s.name, isAI: simulate ? true : s.isAI, color: SEAT_COLORS[i], deckName: s.deck.name, entries: s.entries })),
    { speed: state.settings.speed, fullStops: state.settings.fullStops }
  );
  seenCards.clear();
  showMode('table');
  state.client = new LocalClient(session, { simulate });
}

function showMode(mode) {
  state.mode = mode;
  $('#setup').hidden = mode !== 'setup';
  $('#lobby').hidden = mode !== 'lobby';
  $('#table').hidden = mode !== 'table';
  document.body.classList.toggle('playing', mode === 'table');
  if (mode !== 'table') closeDecision();
}

function backToSetup() {
  state.client?.close();
  state.client = null;
  state.view = null;
  showMode('setup');
  renderSetup();
}

// ---------- LAN ----------

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error('Necesitas el servidor (npm start) para jugar en LAN.');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

async function createRoom() {
  try {
    const name = $('#lan-name').value.trim() || 'Anfitrión';
    const creds = await api('/api/rooms', { name });
    enterRoom(creds);
  } catch (err) {
    toast(err.message);
  }
}

async function joinRoom() {
  try {
    const code = $('#lan-code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('El código tiene 4 caracteres.');
    const name = $('#lan-name').value.trim() || 'Jugador';
    const creds = await api(`/api/rooms/${code}/join`, { name });
    enterRoom(creds);
  } catch (err) {
    toast(err.message);
  }
}

function enterRoom(creds) {
  try {
    sessionStorage.setItem('qtg.room', JSON.stringify(creds));
  } catch {}
  history.replaceState(null, '', `?room=${creds.code}`);
  state.client?.close();
  seenCards.clear();
  state.client = new RemoteClient(creds);
  fetch('/api/info')
    .then((r) => r.json())
    .then((d) => {
      state.lanUrls = d.lan || [];
      renderLobby();
    })
    .catch(() => {});
}

function leaveOnline() {
  try {
    sessionStorage.removeItem('qtg.room');
  } catch {}
  history.replaceState(null, '', location.pathname);
  backToSetup();
}

function onServerMessage(msg) {
  if (msg.type === 'lobby') {
    state.lobby = msg;
    if (state.mode !== 'lobby') showMode('lobby');
    renderLobby();
  } else if (msg.type === 'view') {
    if (state.mode !== 'table') {
      seenCards.clear();
      showMode('table');
    }
    state.client.isHost = msg.isHost;
    state.view = msg.view;
    renderTable();
  }
}

function renderLobby() {
  const L = state.lobby;
  if (!L || state.mode !== 'lobby') return;
  const root = $('#lobby');
  const focus = document.activeElement?.id;
  const caret = document.activeElement?.selectionStart;
  const links = (state.lanUrls.length ? state.lanUrls : [location.origin]).map((u) => `${u}/?room=${L.code}`);
  const canStart = L.seats.every((s) => s.kind !== 'open' && s.deck);
  root.innerHTML = `
    <div class="lobby-head">
      <div>
        <h2>Sala <span class="room-code">${esc(L.code)}</span></h2>
        <p class="hint">Comparte una de estas direcciones con tus amigos (misma red o VPN):</p>
        <div class="links">${links.map((u) => `<button class="link-chip" data-copy="${esc(u)}">📋 ${esc(u)}</button>`).join('')}</div>
      </div>
      <button class="btn ghost small" data-act="room-leave">Salir</button>
    </div>
    ${
      L.isHost
        ? `<div class="setup-bar">
            <div class="seg">${[2, 3, 4].map((n) => `<button class="${L.count === n ? 'on' : ''}" data-room-count="${n}">${n} jugadores</button>`).join('')}</div>
            <label class="toggle"><input type="checkbox" data-room-setting="fullStops" ${L.fullStops ? 'checked' : ''}> Paradas completas</label>
          </div>`
        : ''
    }
    <div class="seats">${L.seats.map((s) => lobbySeat(L, s)).join('')}</div>
    <div class="start-bar">
      ${L.isHost ? `<button class="btn primary" data-act="room-start" ${canStart ? '' : 'disabled'}>▶ Empezar partida</button>` : '<span class="hint">Esperando a que el anfitrión empiece…</span>'}
      ${!canStart && L.isHost ? '<span class="hint">Faltan jugadores o decks. Los asientos vacíos pueden ser IA.</span>' : ''}
    </div>`;
  if (focus) {
    const el = document.getElementById(focus);
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(caret, caret);
      } catch {}
    }
  }
}

function lobbySeat(L, s) {
  const mine = s.idx === L.you;
  const editable = mine || (L.isHost && s.kind === 'ai');
  const inp = state.lobbyInputs[s.idx] || (state.lobbyInputs[s.idx] = { mode: 'url', url: '', text: '' });
  const badge = { human: mine ? 'Tú' : 'Jugador', ai: 'IA', open: 'Vacío' }[s.kind];
  return `
  <article class="seat" style="--pc:${s.color}" data-lseat="${s.idx}">
    <header>
      <span class="dot ${s.online || s.kind === 'ai' ? '' : 'off'}"></span>
      <b class="name">${esc(s.name)}</b>
      <span class="kind kind-${s.kind}">${badge}</span>
      ${L.isHost && s.idx > 0 && s.kind !== 'human' ? `<button class="btn ghost small" data-seat-kind="${s.kind === 'ai' ? 'open' : 'ai'}">${s.kind === 'ai' ? 'Abrir asiento' : 'Poner IA'}</button>` : ''}
    </header>
    ${s.kind === 'open' ? '<p class="hint">Esperando a que alguien se una con el código…</p>' : ''}
    ${
      editable && s.kind !== 'open'
        ? `<div class="tabs">
            <button class="${inp.mode === 'url' ? 'on' : ''}" data-lmode="url">Link</button>
            <button class="${inp.mode === 'text' ? 'on' : ''}" data-lmode="text">Texto</button>
            <button class="${inp.mode === 'demo' ? 'on' : ''}" data-lmode="demo">Demo</button>
          </div>
          ${
            inp.mode === 'url'
              ? `<input class="url" id="lurl-${s.idx}" data-linput="url" placeholder="https://archidekt.com/decks/…" value="${esc(inp.url)}">`
              : inp.mode === 'text'
                ? `<textarea id="ltext-${s.idx}" data-linput="text" rows="4" placeholder="1 Sol Ring…">${esc(inp.text)}</textarea>`
                : `<select id="ldemo-${s.idx}" data-linput="demo">${DEMO_DECKS.map((d, k) => `<option value="${k}" ${String(inp.demo) === String(k) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`
          }
          <div class="row-btns">
            <button class="btn small" data-act="room-deck" ${s.loading ? 'disabled' : ''}>${s.deck ? '↻ Cambiar deck' : 'Cargar deck'}</button>
            <span class="status ${s.error ? 'error' : s.loading ? 'loading' : ''}">${esc(s.error || (s.loading ? 'Cargando…' : ''))}</span>
          </div>`
        : s.loading
          ? '<span class="status loading">Cargando deck…</span>'
          : ''
    }
    ${s.deck ? deckSummaryHTML(s.deck, { seat: s.idx, editable }) : s.kind !== 'open' ? '<p class="hint">Sin deck todavía.</p>' : ''}
  </article>`;
}

// ---------- Render: Mesa ----------

const seenCards = new Set();
const COLOR_EMOJI = { W: '☀', U: '💧', B: '💀', R: '🔥', G: '🌳', C: '◇', '*': '✦' };

function cardHTML(c, { small = false, zone = '', hidden = false, count = 0, extraClass = '' } = {}) {
  if (hidden || !c) return `<div class="card back ${small ? 'sm' : ''}"></div>`;
  const key = `${c.iid}:${zone}`;
  const fresh = !seenCards.has(key);
  seenCards.add(key);
  const pt =
    c.power != null
      ? `<span class="pt ${c.damage ? 'hurt' : ''} ${c.buffed ? 'buffed' : ''}">${esc(c.power)}/${esc(c.toughness)}${c.damage ? ` <s>-${c.damage}</s>` : ''}</span>`
      : c.loyalty != null
        ? `<span class="pt loyal">◆${c.loyalty}</span>`
        : '';
  const img = c.imgSmall
    ? `<img src="${esc(c.imgSmall)}" alt="${esc(c.name)}" loading="lazy" draggable="false">`
    : `<div class="text-card"><b>${esc(c.name)}</b><small>${esc(c.typeLine)}</small></div>`;
  const cls = ['card', small && 'sm', c.tapped && 'tapped', c.sick && 'sick', c.isCommander && 'commander', c.isToken && 'token', fresh && 'fresh', extraClass]
    .filter(Boolean)
    .join(' ');
  return `<div class="${cls}" data-iid="${c.iid}" data-zone="${zone}" title="${esc(c.name)}" tabindex="0">${img}${pt}${
    count > 1 ? `<span class="stack">×${count}</span>` : ''
  }</div>`;
}

function groupLands(cards) {
  const groups = new Map();
  for (const c of cards) {
    const k = `${c.name}|${c.tapped}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return [...groups.values()];
}

/** Tierras en formato compacto para los jugadores laterales: "5× Forest (2 giradas)". */
function landChips(lands) {
  const groups = new Map();
  for (const c of lands) {
    const g = groups.get(c.name) || { name: c.name, n: 0, tapped: 0, iid: c.iid };
    g.n++;
    if (c.tapped) g.tapped++;
    groups.set(c.name, g);
  }
  return [...groups.values()]
    .map((g) => `<span class="land-chip" title="${esc(g.name)}">${g.n}× ${esc(g.name)}${g.tapped ? ` <small>(${g.tapped}↻)</small>` : ''}</span>`)
    .join('');
}

function matHTML(v, p, isYou, { side = false, slot = '' } = {}) {
  const active = v.active === p.idx && v.winner == null;
  const attacking = new Set(v.combat.map((a) => a.attacker));
  const blocking = new Set(v.combat.flatMap((a) => a.blockers));
  const cls = (c) => (attacking.has(c.iid) ? 'attacking' : blocking.has(c.iid) ? 'blocking' : '');
  const lands = p.battlefield.filter((c) => c.isLand);
  const creatures = p.battlefield.filter((c) => !c.isLand && c.isCreature);
  const others = p.battlefield.filter((c) => !c.isLand && !c.isCreature);
  const small = !isYou;
  const canLife = state.client?.isHost;
  return `
  <section class="mat ${isYou ? 'you' : 'opp'} ${side ? 'side' : ''} ${slot} ${active ? 'active' : ''} ${p.alive ? '' : 'dead'} ${v.winner === p.idx ? 'winner' : ''}" style="--pc:${p.color}">
    <div class="mat-head">
      <span class="pill">${esc(p.name)}${p.isAI ? ' <small>IA</small>' : ''}</span>
      <span class="life-wrap">
        ${canLife ? `<button class="life-btn" data-life="-1" data-p="${p.idx}" aria-label="Restar vida">−</button>` : ''}
        <span class="life ${p.life <= 10 ? 'low' : ''}">${p.life}</span>
        ${canLife ? `<button class="life-btn" data-life="1" data-p="${p.idx}" aria-label="Sumar vida">+</button>` : ''}
      </span>
      ${p.poison ? `<span class="poison" title="Veneno (10 = derrota, CR 704.5c)">☠ ${p.poison}</span>` : ''}
      ${p.commanderDamage.length ? `<span class="cmd-dmg" title="Daño de comandante recibido (21 = derrota)">🗡 ${p.commanderDamage.join(' / ')}</span>` : ''}
      ${p.alive ? `<span class="mana-badge" title="Maná disponible y reserva (CR 106.4)">💎 ${p.mana.total} <span class="mana-colors">${p.mana.colors.map((c) => COLOR_EMOJI[c]).join('')}</span>${p.mana.pool.length ? ` <span class="pool">reserva ${p.mana.pool.map((u) => COLOR_EMOJI[u]).join('')}</span>` : ''}</span>` : ''}
      <span class="zones">
        <span title="Biblioteca">📚 ${p.libraryCount}</span>
        <span title="Mano">✋ ${p.handCount}</span>
        <button class="zone-btn" data-pile="graveyard" data-p="${p.idx}" title="Cementerio">🪦 ${p.graveyard.length}</button>
        <button class="zone-btn" data-pile="exile" data-p="${p.idx}" title="Exilio">🌀 ${p.exile.length}</button>
      </span>
    </div>
    <div class="mat-body">
      <div class="command-zone">
        <span class="cz-label">COMMAND ZONE</span>
        ${p.command.map((c) => `${cardHTML(c, { small, zone: 'command' })}${c.tax ? `<span class="tax" title="Impuesto de comandante (CR 903.8)">+${c.tax}</span>` : ''}`).join('')}
      </div>
      <div class="field">
        <div class="row creatures">${creatures.map((c) => cardHTML(c, { small, zone: 'battlefield', extraClass: cls(c) })).join('')}</div>
        <div class="row others">${others.map((c) => cardHTML(c, { small, zone: 'battlefield' })).join('')}</div>
        ${
          side
            ? `<div class="land-chips">${landChips(lands)}</div>`
            : `<div class="row lands">${groupLands(lands).map((g) => cardHTML(g[0], { small: true, zone: 'battlefield', count: g.length })).join('')}</div>`
        }
      </div>
    </div>
    ${
      isYou
        ? `<div class="hand-row">
            <div class="lib-pile" title="Biblioteca">LIB<br><b>${p.libraryCount}</b></div>
            <div class="hand">${p.hand ? p.hand.map((c) => cardHTML(c, { zone: 'hand', extraClass: playableClass(v, c) })).join('') : Array.from({ length: p.handCount }, () => cardHTML(null, { hidden: true })).join('')}</div>
            <button class="gy-pile" data-pile="graveyard" data-p="${p.idx}" title="Cementerio">${
              p.graveyard.length ? cardHTML(p.graveyard[p.graveyard.length - 1], { small: true, zone: 'graveyard' }) : 'GY'
            }</button>
          </div>`
        : p.hand && p.hand.length
          ? `<div class="hand mini">${p.hand.map((c) => cardHTML(c, { small: true, zone: 'hand' })).join('')}</div>`
          : ''
    }
  </section>`;
}

/** Resalta cartas jugables cuando tienes prioridad. */
function playableClass(v, c) {
  if (v.decision?.kind !== 'priority' || !c.play) return '';
  if (c.play.land) return c.play.reason ? '' : 'playable';
  return !c.play.reason && c.play.payable ? 'playable' : '';
}

function stepBarHTML(v) {
  const idx = STEP_LABELS.findIndex(([id]) => id === v.step);
  return `<ol class="steps" aria-label="Paso del turno">${STEP_LABELS.map(
    ([, label, cr], i) => `<li class="${i === idx ? 'on' : i < idx ? 'done' : ''}" title="CR ${cr}">${label}</li>`
  ).join('')}</ol>`;
}

function toolbarHTML(v) {
  const d = v.decision;
  const me = v.players[v.you];
  if (v.winner != null) {
    return state.client.isHost
      ? `<button class="btn ghost" data-act="analysis">📊 Análisis</button><button class="btn primary" data-act="rematch">↻ Revancha</button><button class="btn ghost" data-act="back">Salir</button>`
      : `<button class="btn ghost" data-act="analysis">📊 Análisis</button><button class="btn ghost" data-act="back">Salir</button>`;
  }
  if (d?.kind === 'priority') {
    const myTurn = v.active === v.you;
    const ownMain = myTurn && (v.step === 'main1' || v.step === 'main2') && !v.stack.length;
    const passLabel = v.stack.length ? 'Pasar (dejar resolver) ▸' : ownMain ? (v.step === 'main1' ? 'Ir a combate ▸' : 'Terminar turno ▸') : 'Pasar prioridad ▸';
    return `
      <span class="prio">⏱ Tienes prioridad · ${esc(STEP_LABELS.find(([id]) => id === v.step)?.[1] || '')}</span>
      ${d.error ? `<span class="prio-error">⚠ ${esc(d.error)}</span>` : ''}
      <button class="btn small primary" data-act="pass">${passLabel}</button>
      ${myTurn ? `<button class="btn small ghost" data-act="pass-turn" title="Pasar prioridad hasta el final del turno">⏭ Pasar turno</button>` : ''}
      ${myTurn ? `<button class="btn small ghost" data-act="ai-me">🤖 IA juega por mí</button>` : ''}`;
  }
  if (d) return `<span class="prio">🧠 Decide en la ventana…</span>`;
  if (!me?.alive) return `<span class="mana">Fuiste eliminado — puedes seguir mirando.</span><button class="btn ghost small" data-act="back">Salir</button>`;
  return `<span class="mana">${v.waitingOn.length ? `Esperando a ${esc(v.waitingOn.join(', '))}…` : `${esc(v.players[v.active].name)} está jugando…`}</span>`;
}

function renderTable() {
  const v = state.view;
  if (!v || state.mode !== 'table') return;
  const root = $('#table');
  const you = v.players[v.you];
  const opps = v.players.filter((p) => p.idx !== v.you);
  const host = state.client?.isHost;
  // Mesa en cruz como en el video (4 jugadores): el siguiente en el orden de turno a tu izquierda,
  // el de enfrente arriba y el anterior a tu derecha.
  const n = v.players.length;
  const cross = n === 4;
  const seat = (k) => v.players[(v.you + k) % n];
  const { centerHTML, logHTML } = centerParts(v);

  root.innerHTML = `
    <header class="table-head">
      <button class="btn ghost small" data-act="back">← Salir</button>
      <div class="title"><h1>COMMANDER TABLE</h1><span>TURN ${v.turn}</span></div>
      <div class="table-ctrl">
        <button class="btn ghost small" data-act="analysis" title="Análisis de la partida">📊</button>
        ${
          host
            ? `<select data-setting="speed" aria-label="Velocidad">${Object.keys(SPEEDS)
                .map((k) => `<option value="${k}" ${v.speed === k ? 'selected' : ''}>⏱ ${k}</option>`)
                .join('')}</select>
               <button class="btn ghost small" data-act="pause" title="Pausa">${v.paused ? '▶' : '❚❚'}</button>
               <button class="btn ghost small ${v.fullStops ? 'on' : ''}" data-act="stops" title="Paradas completas: detenerse en cada paso donde tengas opciones (CR 117)">🛎</button>`
            : ''
        }
      </div>
    </header>
    ${v.effects.length ? `<div class="effects" aria-label="Efectos activos que te afectan">${v.effects.map((e) => `<span class="effect">${e.icon} ${esc(e.text)}</span>`).join('')}</div>` : ''}
    ${
      cross
        ? `<div class="table-grid cross">
            ${matHTML(v, seat(2), false, { slot: 'slot-top' })}
            ${matHTML(v, seat(1), false, { side: true, slot: 'slot-left' })}
            ${centerHTML}
            ${matHTML(v, seat(3), false, { side: true, slot: 'slot-right' })}
          </div>`
        : `<div class="opps n${opps.length}">${opps.map((p) => matHTML(v, p, false)).join('')}</div>${centerHTML}`
    }
    ${logHTML}
    ${matHTML(v, you, true)}
    <nav class="toolbar">${toolbarHTML(v)}</nav>`;
  syncDecision(v);
  // Al terminar la partida, mostrar el análisis una vez
  if (v.winner == null) state.analysisShown = false;
  else if (!state.analysisShown && !v.decision) {
    state.analysisShown = true;
    openAnalysis();
  }
}

// ---------- Análisis de la partida ----------

function lifeChartSVG(an) {
  const hist = an.lifeHistory;
  if (hist.length < 2) return '<p class="hint">La gráfica aparece después del primer turno.</p>';
  const W = 640;
  const H = 220;
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const maxLife = Math.max(40, ...hist.flatMap((h) => h.lives));
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (hist.length - 1);
  const y = (life) => pad.t + (1 - life / maxLife) * (H - pad.t - pad.b);
  const grid = [0, 10, 20, 30, 40]
    .filter((g) => g <= maxLife)
    .map((g) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${pad.l - 6}" y="${y(g) + 4}" text-anchor="end">${g}</text>`)
    .join('');
  const turns = hist
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => i === 0 || h.turn !== hist[i - 1].turn)
    .map(({ h, i }) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">T${h.turn}</text>`)
    .join('');
  const lines = an.players
    .map((p) => {
      const pts = hist.map((h, i) => `${x(i).toFixed(1)},${y(h.lives[p.idx]).toFixed(1)}`).join(' ');
      return `<polyline points="${pts}" fill="none" stroke="${p.color}" stroke-width="2.5" stroke-linejoin="round"><title>${esc(p.name)}</title></polyline>`;
    })
    .join('');
  return `<svg class="life-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vida de cada jugador por turno">${grid}${turns}${lines}</svg>
    <div class="legend">${an.players.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.name)}</span>`).join('')}</div>`;
}

function analysisHTML(an) {
  const rows = [
    ['Vida', (p) => (p.alive ? p.life : `☠ T${p.eliminatedTurn}`)],
    ['Daño total', (p) => p.totalDamage],
    ['· en combate', (p) => p.combatDamage],
    ['· otros efectos', (p) => p.otherDamage],
    ['Golpe más fuerte', (p) => p.biggestHit],
    ['Daño de comandante recibido', (p) => p.cmdTaken],
    ['Hechizos lanzados', (p) => p.spells],
    ['Maná gastado', (p) => p.manaSpent],
    ['Tierras jugadas', (p) => p.landsPlayed],
    ['Cartas robadas', (p) => p.draws],
    ['Removal / contrahechizos', (p) => `${p.removal} / ${p.counters}`],
    ['Criaturas perdidas', (p) => p.creaturesLost],
    ['Vida ganada', (p) => p.lifeGained],
    ['Fuerza en mesa', (p) => p.boardPower],
    ['Carta MVP', (p) => (p.mvp ? `${esc(p.mvp.name)} (${p.mvp.damage})` : '—')],
  ];
  return `
    <h3>📊 Análisis de la partida · Turno ${an.turn}</h3>
    <ul class="insights">${an.insights.map((t) => `<li>${esc(t)}</li>`).join('') || '<li>Aún no pasa nada relevante.</li>'}</ul>
    <h4>❤️ Vida por turno</h4>
    ${lifeChartSVG(an)}
    <h4>📋 Estadísticas</h4>
    <div class="stats-table-wrap"><table class="stats-table">
      <thead><tr><th></th>${an.players.map((p) => `<th style="color:${p.color}">${esc(p.name)}${an.winner === p.idx ? ' 🏆' : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([label, fn]) => `<tr><td>${label}</td>${an.players.map((p) => `<td>${fn(p)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

function openAnalysis() {
  const an = state.view?.analysis;
  if (!an) return;
  openModal(`<div class="analysis">${analysisHTML(an)}</div>`);
}

function centerParts(v) {
  const b = v.banner;
  const centerHTML = `<div class="center">
      ${stepBarHTML(v)}
      ${
        v.winner != null
          ? `<div class="banner win">🏆 ${esc(v.players[v.winner].name)} GANA</div>`
          : b
            ? `<div class="banner" data-k="${b.key}"><span>${esc(b.label)}</span>${b.detail ? `<small>${esc(b.detail)}</small>` : ''}</div>`
            : ''
      }
      ${v.stack.length ? `<div class="stack-zone" title="La pila (CR 405) — se resuelve de arriba hacia abajo">📚 PILA: ${v.stack.slice().reverse().map((it) => `<b>${esc(it.name)}</b>${it.target ? ` → ${esc(it.target)}` : ''} <small>(${esc(it.controller)})</small>`).join(' · ')}</div>` : ''}
      ${v.error ? `<div class="warn small">Error del motor: ${esc(v.error)}</div>` : ''}
      <div class="turn-line" style="--pc:${v.players[v.active].color}"></div>
    </div>`;
  const logHTML = `<details class="log"><summary>Registro (${v.log.length})</summary><ol>${v.log
    .map((l) => `<li><b>T${l.turn}</b> ${esc(l.msg)}</li>`)
    .join('')}</ol></details>`;
  return { centerHTML, logHTML };
}

// ---------- Decisiones (modales) ----------

function closeDecision() {
  document.querySelectorAll('.modal-wrap.decision').forEach((m) => m.remove());
  state.shownDecision = null;
}

function answer(value) {
  const d = state.view?.decision;
  if (!d) return;
  closeDecision();
  closeMenus();
  state.client.send({ type: 'answer', id: d.id, value });
}

function syncDecision(v) {
  const d = v.decision;
  if (!d || d.kind === 'priority') return closeDecision();
  if (state.shownDecision === d.id) return;
  closeDecision();
  state.shownDecision = d.id;
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap decision';
  wrap.innerHTML = `<div class="modal" role="dialog">${decisionHTML(d)}</div>`;
  document.body.appendChild(wrap);
  bindDecision(wrap, d);
}

function decisionHTML(d) {
  switch (d.kind) {
    case 'mulligan':
      return `<h3>✋ Mano inicial (CR 103.5)</h3>
        <p class="hint">Mulligans: ${d.mulligans}. Si te quedas con esta mano pondrás ${d.toBottom} carta${d.toBottom === 1 ? '' : 's'} al fondo (el primer mulligan es gratis en multijugador, CR 103.5c).</p>
        <div class="pile">${d.hand.map((c) => cardHTML(c)).join('')}</div>
        <div class="row-btns"><button class="btn primary" data-v="keep">Quedarme</button><button class="btn ghost" data-v="mulligan">Mulligan</button></div>`;
    case 'bottom':
    case 'discard':
      return `<h3>${d.kind === 'bottom' ? `📚 Pon ${d.n} carta${d.n > 1 ? 's' : ''} al fondo (mulligan de Londres)` : `🗑 Limpieza: descarta ${d.n} (CR 514.1)`}</h3>
        <div class="pile">${d.hand.map((c) => `<label class="pile-item pick-card"><input type="checkbox" value="${c.iid}">${cardHTML(c)}</label>`).join('')}</div>
        <button class="btn primary" data-ok disabled>Confirmar</button>`;
    case 'attackers':
      return `<h3>⚔ Declarar atacantes (CR 508)</h3>
        <p class="hint">Cada criatura puede atacar a un jugador distinto (CR 506.2).</p>
        <div class="atk-list">${d.attackers
          .map(
            (c) => `<label class="atk"><input type="checkbox" value="${c.iid}">${cardHTML(c, { small: true })}
              <span>${esc(c.name)} ${c.power}/${c.toughness}<br><small>${esc(c.keywords.join(', '))}</small></span>
              <select data-t="${c.iid}">${d.defenders.map((o, k) => `<option value="p:${o.idx}" ${k === 0 ? 'selected' : ''}>${esc(o.name)} (${o.life}❤)</option>`).join('')}${(d.planeswalkers || [])
                .map((w) => `<option value="w:${w.iid}:${w.controller}">◆ ${esc(w.name)} (${w.loyalty} lealtad)</option>`)
                .join('')}</select></label>`
          )
          .join('')}</div>
        <div class="row-btns"><button class="btn ghost" data-all>Todas</button><button class="btn ghost" data-none>No atacar</button><button class="btn primary" data-ok>Atacar</button></div>`;
    case 'blockers':
      return `<h3>🛡 Declara bloqueadores (CR 509)</h3>
        <div class="atk-list">${d.options
          .map((o, i) => {
            const sel = (k) => `<select data-a="${i}" data-k="${k}"><option value="">— sin bloquear —</option>${o.blockers.map((b) => `<option value="${b.iid}">${esc(b.name)} ${b.power}/${b.toughness}</option>`).join('')}</select>`;
            return `<div class="atk">${cardHTML(o.attacker, { small: true })}
              <div><b>${esc(o.attacker.name)}</b> ${o.attacker.power}/${o.attacker.toughness} <small>${esc(o.attacker.keywords.join(', '))}</small><br>
              ${o.blockers.length ? sel(0) + (o.menace ? ' + ' + sel(1) + ' <small>(menace: 2+)</small>' : '') : '<small>No puedes bloquearla</small>'}</div></div>`;
          })
          .join('')}</div>
        <button class="btn primary" data-ok>Confirmar bloqueos</button>`;
    case 'target':
      return `<h3>🎯 Elige objetivo para ${esc(d.card)} (CR 601.2c)</h3>
        <div class="target-list">${d.targets
          .map((t, i) => `<button class="target-btn" data-t="${i}">${t.card ? cardHTML(t.card, { small: true }) : t.player ? '👤' : '📚'} <span>${esc(t.label)}${t.card ? ` <small>(${esc(t.card.controller)})</small>` : ''}</span></button>`)
          .join('')}</div>
        <button class="btn ghost" data-cancel>Cancelar lanzamiento</button>`;
    case 'payUnless':
      return `<h3>🔔 ${esc(d.source)} <small>(${esc(d.owner)})</small></h3>
        <p>Paga <b>{${d.amount}}</b> o <b>${esc(d.effect)}</b>.</p>
        <div class="row-btns"><button class="btn primary" data-pay="1">Pagar {${d.amount}}</button><button class="btn ghost" data-pay="0">No pagar</button></div>`;
    default:
      return `<p>Decisión desconocida.</p><button class="btn" data-skip>Continuar</button>`;
  }
}

function bindDecision(wrap, d) {
  const on = (sel, fn) => wrap.querySelectorAll(sel).forEach((el) => (el.onclick = fn));
  on('[data-v]', (e) => answer(e.currentTarget.dataset.v));
  on('[data-skip]', () => answer(null));
  on('[data-pay]', (e) => answer(e.currentTarget.dataset.pay === '1'));
  on('[data-cancel]', () => answer(null));
  on('.target-btn', (e) => answer(d.targets[+e.currentTarget.dataset.t].ref));
  if (d.kind === 'bottom' || d.kind === 'discard') {
    const ok = wrap.querySelector('[data-ok]');
    wrap.addEventListener('change', () => (ok.disabled = wrap.querySelectorAll('input:checked').length !== d.n));
    ok.onclick = () => answer([...wrap.querySelectorAll('input:checked')].map((i) => +i.value));
  }
  if (d.kind === 'attackers') {
    on('[data-all]', () => wrap.querySelectorAll('.atk input').forEach((i) => (i.checked = true)));
    on('[data-none]', () => answer([]));
    on('[data-ok]', () =>
      answer(
        [...wrap.querySelectorAll('.atk input:checked')].map((i) => {
          const [kind, a, b] = wrap.querySelector(`select[data-t="${i.value}"]`).value.split(':');
          return kind === 'w' ? { attacker: +i.value, defender: +b, pw: +a } : { attacker: +i.value, defender: +a };
        })
      )
    );
  }
  if (d.kind === 'blockers') {
    on('[data-ok]', () =>
      answer(
        d.options
          .map((o, i) => ({ attacker: o.attacker.iid, blockers: [...new Set([...wrap.querySelectorAll(`select[data-a="${i}"]`)].map((s) => +s.value).filter(Boolean))] }))
          .filter((x) => x.blockers.length)
      )
    );
  }
}

// ---------- Menús de carta ----------

function closeMenus() {
  document.querySelectorAll('.menu, .modal-wrap:not(.decision)').forEach((m) => m.remove());
}

function openMenu(anchor, items) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = items
    .map((it, i) => (it.sep ? '<hr>' : it.note ? `<p class="menu-note">${it.note}</p>` : `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}>${it.label}</button>`))
    .join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left + r.width / 2 - mw / 2))}px`;
  menu.style.top = `${Math.max(8, r.top - mh - 6 < 0 ? r.bottom + 6 : r.top - mh - 6) + window.scrollY}px`;
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenus();
    items[+b.dataset.i].run();
  });
}

function openModal(html, onClick) {
  closeMenus();
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal" role="dialog">${html}<button class="btn ghost small close" data-close>Cerrar</button></div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) return closeMenus();
    onClick?.(e, wrap);
  });
  document.body.appendChild(wrap);
}

function findViewCard(v, iid) {
  for (const p of v.players) {
    for (const zone of ['hand', 'battlefield', 'graveyard', 'exile', 'command']) {
      const c = (p[zone] || []).find((x) => x.iid === iid);
      if (c) return { card: c, zone, player: p };
    }
  }
  return null;
}

function previewCard(c) {
  openModal(`
    <div class="preview">
      ${c.img ? `<img src="${esc(c.img)}" alt="${esc(c.name)}">` : `<div class="text-card big"><b>${esc(c.name)}</b></div>`}
      <div>
        <h3>${esc(c.name)}</h3>
        <p class="type">${esc(c.typeLine)} ${c.manaCost ? `· ${esc(c.manaCost)}` : ''}</p>
        <p class="oracle">${esc(c.oracle || '').replace(/\n/g, '<br>')}</p>
        ${c.scryfall ? `<a href="${esc(c.scryfall)}" target="_blank" rel="noopener">Ver en Scryfall ↗</a>` : ''}
      </div>
    </div>`);
}

function cardMenu(el) {
  const v = state.view;
  const loc = findViewCard(v, +el.dataset.iid);
  if (!loc) return;
  const { card, zone, player } = loc;
  const mine = player.idx === v.you;
  const prio = v.decision?.kind === 'priority';
  const items = [];
  const act = (value) => () => answer(value);

  if (mine && (zone === 'hand' || zone === 'command') && card.play) {
    const pl = card.play;
    if (pl.land) {
      items.push({ label: '🌲 Jugar tierra', disabled: !prio || !!pl.reason, run: act({ type: 'land', iid: card.iid }) });
      if (pl.reason) items.push({ note: `⚠ ${esc(pl.reason)}` });
    } else {
      const label = `${card.isCommander ? '👑 Lanzar comandante' : '✨ Lanzar'} ${esc(pl.cost)}${pl.needsTarget ? ' 🎯' : ''}`;
      items.push({
        label,
        disabled: !prio || !!pl.reason || !pl.payable,
        run: () => {
          let x = 0;
          if (pl.hasX) x = Math.max(0, parseInt(prompt('Valor de X:', '1') || '0', 10) || 0);
          answer({ type: 'cast', iid: card.iid, x });
        },
      });
      for (const m of pl.mods) items.push({ note: `💸 ${esc(m)} (CR 601.2f)` });
      if (pl.reason) items.push({ note: `⚠ ${esc(pl.reason)}` });
      else if (!pl.payable) items.push({ note: '⚠ No tienes maná suficiente o de los colores correctos.' });
      if (!prio && !pl.reason) items.push({ note: 'Espera a tener prioridad para jugarla.' });
    }
  }
  if (mine && zone === 'battlefield') {
    for (const ab of card.abilities || []) {
      items.push({
        label: `${ab.kind === 'loyalty' ? '◆' : '⚙'} ${esc(ab.label)}`,
        disabled: !prio || !!ab.reason,
        run: () => {
          let x = 0;
          if (ab.isX) x = Math.max(0, parseInt(prompt('Valor de X:', '1') || '0', 10) || 0);
          answer({ type: 'activate', iid: card.iid, index: ab.index, x });
        },
      });
      if (ab.reason && prio) items.push({ note: `⚠ ${esc(ab.reason)}` });
    }
  }
  if (mine && (zone === 'battlefield' || zone === 'hand')) {
    if (items.length) items.push({ sep: true });
    const man = (op, to) => () => state.client.send({ type: 'manual', iid: card.iid, op, to });
    if (zone === 'battlefield') {
      items.push({ label: `🛠 ${card.tapped ? 'Enderezar' : 'Girar'} (manual)`, run: man('tap') });
      if (card.isCreature) items.push({ label: '🛠 Contador +1/+1 (manual)', run: man('counter') });
      items.push({ label: '🛠 Al cementerio (manual)', run: man('move', 'graveyard') }, { label: '🛠 Al exilio (manual)', run: man('move', 'exile') }, { label: '🛠 A la mano (manual)', run: man('move', 'hand') });
    }
    if (zone === 'hand') items.push({ label: '🛠 Descartar (manual)', run: man('move', 'graveyard') });
  }
  if (zone === 'graveyard') return openPile(player.idx, 'graveyard');
  items.push({ label: '🔍 Ver carta', run: () => previewCard(card) });
  if (items.length === 1) return previewCard(card);
  openMenu(el, items);
}

function openPile(pIdx, zone) {
  const p = state.view.players[pIdx];
  const cards = [...p[zone]].reverse();
  openModal(
    `<h3>${zone === 'graveyard' ? '🪦 Cementerio' : '🌀 Exilio'} de ${esc(p.name)} (${cards.length})</h3>
     <div class="pile">${cards.map((c) => `<div class="pile-item">${cardHTML(c, { zone })}</div>`).join('') || '<p class="hint">Vacío</p>'}</div>`,
    (e) => {
      const c = e.target.closest('.card');
      const card = c && cards.find((x) => x.iid === +c.dataset.iid);
      if (card) previewCard(card);
    }
  );
}

let toastTimer;
function toast(msg) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------- Eventos ----------

function bindSetup() {
  const root = $('#setup');
  root.addEventListener('click', (e) => {
    const t = e.target;
    const seatEl = t.closest('[data-seat]');
    const i = seatEl ? +seatEl.dataset.seat : -1;
    if (t.closest('[data-count]')) {
      state.count = +t.closest('[data-count]').dataset.count;
      save();
      return renderSetup();
    }
    if (t.closest('[data-mode]') && i >= 0) {
      state.seats[i].mode = t.closest('[data-mode]').dataset.mode;
      save();
      return renderSetup();
    }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'load' && i >= 0) loadSeat(i);
    if (act === 'load-all') state.seats.slice(0, state.count).forEach((_, j) => loadSeat(j));
    if (act === 'demo') loadDemo();
    if (act === 'share') shareLink();
    if (act === 'start') startLocal(false);
    if (act === 'simulate') startLocal(true);
    if (act === 'room-create') createRoom();
    if (act === 'room-join') joinRoom();
  });
  root.addEventListener('input', (e) => {
    const seatEl = e.target.closest('[data-seat]');
    const f = e.target.dataset.field;
    if (!seatEl || !f || f === 'isAI') return;
    state.seats[+seatEl.dataset.seat][f] = e.target.value;
    save();
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset.setting === 'fullStops') {
      state.settings.fullStops = e.target.checked;
      return save();
    }
    if (e.target.dataset.commander != null) {
      const seat = state.seats[+e.target.dataset.commander];
      setCommander(seat.entries, e.target.value);
      seat.summary = summarizeDeck(seat.deck, seat.entries);
      return renderSetup();
    }
    const seatEl = e.target.closest('[data-seat]');
    if (seatEl && e.target.dataset.field === 'isAI') {
      state.seats[+seatEl.dataset.seat].isAI = e.target.checked;
      save();
      renderSetup();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.field === 'url') loadSeat(+e.target.closest('[data-seat]').dataset.seat);
    if (e.key === 'Enter' && e.target.id === 'lan-code') joinRoom();
  });
}

function bindLobby() {
  const root = $('#lobby');
  const client = () => state.client;
  root.addEventListener('click', (e) => {
    const t = e.target;
    const seatEl = t.closest('[data-lseat]');
    const idx = seatEl ? +seatEl.dataset.lseat : -1;
    const copyEl = t.closest('[data-copy]');
    if (copyEl) return copy(copyEl.dataset.copy, '📋 Dirección copiada');
    if (t.closest('[data-room-count]')) return client().post('config', { count: +t.closest('[data-room-count]').dataset.roomCount }).catch((err) => toast(err.message));
    if (t.closest('[data-seat-kind]')) return client().post('config', { seat: idx, kind: t.closest('[data-seat-kind]').dataset.seatKind }).catch((err) => toast(err.message));
    if (t.closest('[data-lmode]')) {
      state.lobbyInputs[idx].mode = t.closest('[data-lmode]').dataset.lmode;
      return renderLobby();
    }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'room-leave') return leaveOnline();
    if (act === 'room-start') return client().post('start').catch((err) => toast(err.message));
    if (act === 'room-deck') {
      const inp = state.lobbyInputs[idx];
      const body = { seat: idx };
      if (inp.mode === 'url') body.url = inp.url;
      else if (inp.mode === 'text') body.text = inp.text;
      else body.demo = +(inp.demo || 0);
      client().post('deck', body).catch((err) => toast(err.message));
    }
  });
  root.addEventListener('input', (e) => {
    const seatEl = e.target.closest('[data-lseat]');
    const f = e.target.dataset.linput;
    if (seatEl && f) state.lobbyInputs[+seatEl.dataset.lseat][f] = e.target.value;
  });
  root.addEventListener('change', (e) => {
    const seatEl = e.target.closest('[data-lseat]');
    if (e.target.dataset.linput === 'demo' && seatEl) state.lobbyInputs[+seatEl.dataset.lseat].demo = e.target.value;
    if (e.target.dataset.commander != null) client().post('deck', { seat: +e.target.dataset.commander, commander: e.target.value }).catch((err) => toast(err.message));
    if (e.target.dataset.roomSetting === 'fullStops') client().post('config', { fullStops: e.target.checked }).catch((err) => toast(err.message));
  });
}

function bindTable() {
  const root = $('#table');
  root.addEventListener('click', (e) => {
    const v = state.view;
    if (!v) return;
    const t = e.target;
    const act = t.closest('[data-act]')?.dataset.act;
    if (act) {
      if (act === 'back') {
        if (state.client instanceof RemoteClient) {
          if (state.client.isHost) return state.client.post('end').catch((err) => toast(err.message));
          return leaveOnline();
        }
        return backToSetup();
      }
      if (act === 'rematch') return state.client.rematch();
      if (act === 'analysis') return openAnalysis();
      if (act === 'pause') return state.client.send({ type: 'setting', paused: !v.paused });
      if (act === 'stops') return state.client.send({ type: 'setting', fullStops: !v.fullStops });
      if (act === 'pass') return answer({ type: 'pass' });
      if (act === 'pass-turn') return answer({ type: 'passTurn' });
      if (act === 'ai-me') return answer({ type: 'aiForMe' });
      return;
    }
    const life = t.closest('[data-life]');
    if (life) return state.client.send({ type: 'life', player: +life.dataset.p, delta: +life.dataset.life * (e.shiftKey ? 5 : 1) });
    const pile = t.closest('[data-pile]');
    if (pile) return openPile(+pile.dataset.p, pile.dataset.pile);
    const card = t.closest('.card[data-iid]');
    if (card) return cardMenu(card);
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset.setting === 'speed') {
      state.settings.speed = e.target.value;
      save();
      state.client.send({ type: 'setting', speed: e.target.value });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('.card')) document.querySelectorAll('.menu').forEach((m) => m.remove());
  });
}

// ---------- Inicio ----------

restore();
bindSetup();
bindLobby();
bindTable();
renderSetup();

// Reconectar a una sala LAN tras recargar la página
try {
  const saved = JSON.parse(sessionStorage.getItem('qtg.room') || 'null');
  const roomParam = new URLSearchParams(location.search).get('room');
  if (saved && roomParam && saved.code === roomParam.toUpperCase()) enterRoom(saved);
} catch {}
