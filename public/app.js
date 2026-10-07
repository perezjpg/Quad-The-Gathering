import { parseDeckText } from './lib/deckText.js';
import { fetchCards, lookup } from './lib/scryfall.js';
import { analyze, isLand, isCreature, BRACKET_NAMES } from './lib/stats.js';
import { DEMO_DECKS } from './lib/demo.js';
import * as E from './lib/engine.js';

// ---------- Estado ----------

const SEAT_COLORS = ['#39c5bb', '#9b5de5', '#e63946', '#f4a261'];
const SPEEDS = { lenta: 1300, normal: 750, rápida: 280, turbo: 40 };

const state = {
  busy: false,
  count: 4,
  seats: Array.from({ length: 4 }, (_, i) => newSeat(i)),
  game: null,
  you: 0, // asiento que se muestra abajo
  settings: { speed: 'normal', askResponses: true, showAIHands: false },
  looping: false,
  paused: false,
  simulate: false,
};

function newSeat(i) {
  return {
    name: i === 0 ? 'Tú' : `Jugador ${i + 1}`,
    isAI: i !== 0,
    mode: 'url',
    url: '',
    text: '',
    status: 'idle', // idle | loading | ready | error
    message: '',
    deck: null,
    entries: null,
    stats: null,
  };
}

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---------- Carga de decks ----------

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
      const isJSON = (res.headers.get('content-type') || '').includes('json');
      if (!isJSON) throw new Error('Para importar por link ejecuta "npm start" (o pega la lista como texto).');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo importar el deck.');
      deck = data;
    } else {
      const parsed = parseDeckText(seat.text);
      if (!parsed.cards.length) throw new Error('No se encontraron cartas en el texto.');
      deck = { ...parsed, name: seat.deckName || 'Lista pegada', source: 'Texto' };
    }

    seat.message = 'Buscando cartas en Scryfall…';
    renderSetup();
    const info = await fetchCards(
      deck.cards.map((c) => c.name),
      (done, total) => {
        seat.message = `Scryfall ${done}/${total}…`;
        renderSetup();
      }
    );
    seat.deck = deck;
    seat.entries = deck.cards.map((c) => ({ ...c, info: lookup(info, c.name) }));
    autoPickCommander(seat);
    seat.stats = analyze(seat.entries);
    seat.status = 'ready';
    seat.message = '';
  } catch (err) {
    seat.status = 'error';
    seat.message = err.message;
  }
  save();
  renderSetup();
}

function legendaryCandidates(seat) {
  return (seat.entries || []).filter(
    (e) => e.board === 'main' && /Legendary/.test(e.info.typeLine) && /(Creature|Planeswalker)/.test(e.info.typeLine)
  );
}

function autoPickCommander(seat) {
  if (seat.entries.some((e) => e.board === 'commander')) return;
  const c = legendaryCandidates(seat)[0];
  if (c) setCommander(seat, c.info.name);
}

function setCommander(seat, name) {
  for (const e of seat.entries) if (e.board === 'commander') e.board = 'main';
  const e = seat.entries.find((x) => x.info.name === name || x.name === name);
  if (e) {
    if (e.qty > 1) {
      e.qty--;
      seat.entries.push({ ...e, qty: 1, board: 'commander' });
    } else e.board = 'commander';
  }
  seat.entries = seat.entries.filter((x) => x.qty > 0);
  seat.stats = analyze(seat.entries);
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
  const pod = state.seats
    .slice(0, state.count)
    .map((s) => ({ n: s.name, u: s.mode === 'url' ? s.url : '', ai: s.isAI }));
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(pod))));
  const url = `${location.origin}${location.pathname}#pod=${encoded}`;
  navigator.clipboard?.writeText(url).then(
    () => toast('🔗 Link del pod copiado'),
    () => prompt('Copia este link:', url)
  );
}

// ---------- Render: Setup ----------

const PIP = { W: '☀', U: '💧', B: '💀', R: '🔥', G: '🌳' };

function renderSetup() {
  const root = $('#setup');
  const seats = state.seats.slice(0, state.count);
  const ready = seats.filter((s) => s.status === 'ready');
  const brackets = ready.map((s) => s.stats.bracket);
  const unbalanced = brackets.length > 1 && Math.max(...brackets) - Math.min(...brackets) >= 2;

  root.innerHTML = `
    <div class="setup-bar">
      <div class="seg" role="group" aria-label="Jugadores">
        ${[2, 3, 4].map((n) => `<button class="${state.count === n ? 'on' : ''}" data-count="${n}">${n} jugadores</button>`).join('')}
      </div>
      <button class="btn ghost" data-act="demo">🎴 Decks demo</button>
      <button class="btn ghost" data-act="load-all">⬇ Cargar todos</button>
      <button class="btn ghost" data-act="share">🔗 Compartir pod</button>
    </div>
    ${unbalanced ? `<div class="warn">⚠️ Pod desbalanceado: hay decks con brackets muy distintos (${brackets.join(' · ')}). Considera ajustar antes de jugar.</div>` : ''}
    <div class="seats">${seats.map((s, i) => seatCard(s, i)).join('')}</div>
    <div class="start-bar">
      <button class="btn primary" data-act="start" ${ready.length === seats.length && seats.length >= 2 ? '' : 'disabled'}>▶ Jugar en la mesa</button>
      <button class="btn accent" data-act="simulate" ${ready.length === seats.length && seats.length >= 2 ? '' : 'disabled'}>🤖 Simular partida (todo IA)</button>
      <span class="hint">${ready.length}/${seats.length} decks listos</span>
    </div>
  `;
}

function seatCard(s, i) {
  const color = SEAT_COLORS[i];
  const cmd = s.entries?.filter((e) => e.board === 'commander') || [];
  const art = cmd[0]?.info.art;
  const st = s.stats;
  return `
  <article class="seat" style="--pc:${color}" data-seat="${i}">
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
    ${
      s.status === 'ready'
        ? `
      <div class="deck-preview" ${art ? `style="background-image:linear-gradient(180deg,transparent,var(--bg-2) 92%),url('${esc(art)}')"` : ''}>
        <div class="deck-title">${esc(s.deck.name)}</div>
        <div class="deck-sub">${esc(s.deck.source)}${s.deck.author ? ' · ' + esc(s.deck.author) : ''}</div>
        <div class="cmdr">👑 ${cmd.length ? cmd.map((c) => esc(c.info.name)).join(' + ') : '<em>sin comandante</em>'}</div>
      </div>
      ${
        legendaryCandidates(s).length || cmd.length
          ? `<label class="pick">Comandante:
              <select data-field="commander">
                ${cmd.map((c) => `<option selected>${esc(c.info.name)}</option>`).join('')}
                ${legendaryCandidates(s).map((c) => `<option>${esc(c.info.name)}</option>`).join('')}
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
      <div class="curve" aria-label="Curva de maná">
        ${st.curve
          .map((n, mv) => {
            const max = Math.max(...st.curve, 1);
            return `<div class="bar" title="MV ${mv === 7 ? '7+' : mv}: ${n}"><i style="height:${(n / max) * 100}%"></i><span>${mv === 7 ? '7+' : mv}</span></div>`;
          })
          .join('')}
      </div>
      <div class="tags">
        <span>Ramp ${st.ramp}</span><span>Robo ${st.draw}</span><span>Removal ${st.removal}</span><span>Wipes ${st.wipes}</span><span>Tutores ${st.tutors}</span>
        ${st.gameChangers.length ? `<span class="gc" title="${esc(st.gameChangers.join(', '))}">Game Changers ${st.gameChangers.length}</span>` : ''}
      </div>
      ${st.legality.map((w) => `<div class="warn small">⚖️ ${esc(w)}</div>`).join('')}
      ${st.missing.length ? `<div class="warn small">No encontradas en Scryfall: ${esc(st.missing.slice(0, 5).join(', '))}${st.missing.length > 5 ? '…' : ''}</div>` : ''}
      `
        : ''
    }
  </article>`;
}

// ---------- Mesa ----------

class Abort extends Error {}
const pendingDecisions = new Set();

/** Termina la partida actual: resuelve decisiones pendientes y detiene el motor de la partida vieja. */
function abortGame() {
  if (state.game) state.game.aborted = true;
  for (const resolveDefault of [...pendingDecisions]) resolveDefault();
  pendingDecisions.clear();
  document.querySelectorAll('.modal-wrap, .menu').forEach((m) => m.remove());
  state.looping = false;
  state.busy = false;
  state.paused = false;
}

function startGame(simulate) {
  abortGame();
  seenCards.clear();
  const seats = state.seats.slice(0, state.count);
  state.simulate = simulate;
  state.game = E.createGame(
    seats.map((s, i) => ({
      name: s.name,
      isAI: simulate ? true : s.isAI,
      color: SEAT_COLORS[i],
      deckName: s.deck.name,
      entries: s.entries,
    }))
  );
  const human = state.game.players.findIndex((p) => !p.isAI);
  state.you = human >= 0 ? human : 0;
  state.paused = false;
  state.busy = false;
  $('#setup').hidden = true;
  $('#table').hidden = false;
  document.body.classList.add('playing');
  renderTable();
  runLoop();
}

/** Interfaz que el motor usa para animar y para pedir decisiones a jugadores humanos. */
const io = {
  async step(label, detail) {
    const g = state.game;
    if (!g) throw new Abort();
    g.banner = { label, detail, key: Math.random() };
    renderTable();
    await sleep(SPEEDS[state.settings.speed] ?? 700);
    while (state.paused && !g.aborted) await sleep(150);
    if (g.aborted) throw new Abort();
  },
  chooseBlocks: (game, defender, attackers) => askBlocks(game, defender, attackers),
  respond: (game, player, ctx, options) => (state.settings.askResponses ? askResponse(game, player, ctx, options) : null),
  chooseDiscard: (game, player, n) => askDiscard(game, player, n),
};

async function runLoop() {
  if (state.looping) return;
  state.looping = true;
  const g = state.game;
  try {
    while (g && g === state.game && g.winner == null) {
      const p = g.players[g.active];
      if (p.isAI) {
        await E.aiTurn(g, io);
        if (g.turn > 80) {
          E.log(g, '⏱ Límite de 80 rondas alcanzado.');
          break;
        }
      } else {
        if (g.step === 'untap') await E.beginTurn(g, io);
        if (g === state.game) g.banner = { label: 'TU TURNO', detail: `${p.name} · Main 1`, key: Math.random() };
        break; // esperar acciones del humano
      }
    }
  } catch (err) {
    if (!(err instanceof Abort) && !g?.aborted) {
      console.error(err);
      toast(`Error del motor: ${err.message}`);
    }
  } finally {
    if (g === state.game) {
      state.looping = false;
      renderTable();
    }
  }
}

/** Ejecuta una acción del humano bloqueando la UI mientras el motor resuelve. */
async function humanAction(fn) {
  if (state.busy || state.looping || !state.game) return;
  const g = state.game;
  state.busy = true;
  renderTable();
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Abort) && !g.aborted) {
      console.error(err);
      toast(err.message);
    }
  } finally {
    if (g === state.game) {
      state.busy = false;
      renderTable();
    }
  }
  if (g === state.game && g.winner == null && g.players[g.active].isAI) runLoop();
}

const isHumanTurn = () => {
  const g = state.game;
  return g && g.winner == null && !g.players[g.active].isAI && !state.looping && !state.busy;
};

// ---------- Render: Mesa ----------

// Solo animar cartas que aparecen por primera vez en una zona (evita parpadeo al re-renderizar).
const seenCards = new Set();

function cardHTML(c, { small = false, owner = null, zone = '', hidden = false, count = 0 } = {}) {
  if (hidden) return `<div class="card back ${small ? 'sm' : ''}"></div>`;
  const g = state.game;
  const seenKey = `${c.iid}:${zone}`;
  const fresh = !seenCards.has(seenKey);
  seenCards.add(seenKey);
  let pt = '';
  if (isCreature(c) && c.power != null) {
    const pw = zone === 'battlefield' ? E.power(g, c) : c.power;
    const tg = zone === 'battlefield' ? E.toughness(g, c) : c.toughness;
    const buffed = zone === 'battlefield' && (pw !== parseInt(c.power, 10) || tg !== parseInt(c.toughness, 10));
    pt = `<span class="pt ${c.damage ? 'hurt' : ''} ${buffed ? 'buffed' : ''}">${esc(pw)}/${esc(tg)}${c.damage ? ` <s>-${c.damage}</s>` : ''}</span>`;
  }
  const img = c.imgSmall
    ? `<img src="${esc(c.imgSmall)}" alt="${esc(c.name)}" loading="lazy" draggable="false">`
    : `<div class="text-card"><b>${esc(c.name)}</b><small>${esc(c.typeLine)}</small></div>`;
  const cls = [
    'card', small && 'sm', c.tapped && 'tapped', c.sick && isCreature(c) && zone === 'battlefield' && !E.has(c, 'haste') && 'sick',
    c.isCommander && 'commander', c.isToken && 'token', fresh && 'fresh',
  ].filter(Boolean).join(' ');
  return `<div class="${cls}" data-iid="${c.iid}" data-zone="${zone}" data-owner="${owner}" title="${esc(c.name)}" tabindex="0">${img}${pt}${
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

const COLOR_EMOJI = { W: '☀', U: '💧', B: '💀', R: '🔥', G: '🌳', C: '◇', '*': '✦' };

function manaBadge(p) {
  const g = state.game;
  const sources = E.sourcesOf(p);
  const total = sources.reduce((n, s) => n + Math.max(...s.options.map((o) => o.length)), 0);
  const colors = new Set(sources.flatMap((s) => s.options.flat()));
  const pool = g.pools[p.idx];
  return `<span class="mana-badge" title="Maná disponible (fuentes sin girar) y reserva de maná (CR 106.4)">💎 ${total}
    <span class="mana-colors">${['W', 'U', 'B', 'R', 'G', 'C'].filter((c) => colors.has(c) || (c !== 'C' && colors.has('*'))).map((c) => COLOR_EMOJI[c]).join('')}</span>
    ${pool.length ? `<span class="pool">reserva: ${pool.map((u) => COLOR_EMOJI[u]).join('')}</span>` : ''}</span>`;
}

function matHTML(p, { isYou }) {
  const g = state.game;
  const active = g.active === p.idx && g.winner == null;
  const lands = p.battlefield.filter(isLand);
  const creatures = p.battlefield.filter((c) => !isLand(c) && isCreature(c));
  const others = p.battlefield.filter((c) => !isLand(c) && !isCreature(c));
  const small = !isYou;
  const cmdDmg = Object.entries(p.commanderDamage).filter(([, v]) => v > 0);
  const showHand = (isYou && (!p.isAI || state.simulate)) || state.settings.showAIHands;
  return `
  <section class="mat ${isYou ? 'you' : 'opp'} ${active ? 'active' : ''} ${p.alive ? '' : 'dead'} ${g.winner === p.idx ? 'winner' : ''}" style="--pc:${p.color}" data-player="${p.idx}">
    <div class="mat-head">
      <span class="pill">${esc(p.name)}${p.isAI ? ' <small>IA</small>' : ''}</span>
      <span class="life-wrap">
        <button class="life-btn" data-life="-1" data-p="${p.idx}" aria-label="Restar vida">−</button>
        <span class="life ${p.life <= 10 ? 'low' : ''}">${p.life}</span>
        <button class="life-btn" data-life="1" data-p="${p.idx}" aria-label="Sumar vida">+</button>
      </span>
      ${p.poison ? `<span class="poison" title="Contadores de veneno (10 = derrota, CR 704.5c)">☠ ${p.poison}</span>` : ''}
      ${cmdDmg.length ? `<span class="cmd-dmg" title="Daño de combate de comandante recibido (21 = derrota)">🗡 ${cmdDmg.map(([, v]) => v).join(' / ')}</span>` : ''}
      ${p.alive ? manaBadge(p) : ''}
      <span class="zones">
        <span title="Biblioteca">📚 ${p.library.length}</span>
        <span title="Mano">✋ ${p.hand.length}</span>
        <button class="zone-btn" data-pile="graveyard" data-p="${p.idx}" title="Cementerio">🪦 ${p.graveyard.length}</button>
        <button class="zone-btn" data-pile="exile" data-p="${p.idx}" title="Exilio">🌀 ${p.exile.length}</button>
      </span>
    </div>
    <div class="mat-body">
      <div class="command-zone">
        <span class="cz-label">COMMAND ZONE</span>
        ${p.command.map((c) => `${cardHTML(c, { small, owner: p.idx, zone: 'command' })}${p.commanderTax[c.iid] ? `<span class="tax" title="Impuesto de comandante (CR 903.8)">+${p.commanderTax[c.iid]}</span>` : ''}`).join('')}
      </div>
      <div class="field">
        <div class="row creatures">${creatures.map((c) => cardHTML(c, { small, owner: p.idx, zone: 'battlefield' })).join('')}</div>
        <div class="row others">${others.map((c) => cardHTML(c, { small, owner: p.idx, zone: 'battlefield' })).join('')}</div>
        <div class="row lands">${groupLands(lands)
          .map((grp) => cardHTML(grp[0], { small: true, owner: p.idx, zone: 'battlefield', count: grp.length }))
          .join('')}</div>
      </div>
    </div>
    ${
      isYou
        ? `<div class="hand-row">
            <div class="lib-pile" title="Biblioteca">LIB<br><b>${p.library.length}</b></div>
            <div class="hand">${p.hand.map((c) => cardHTML(c, { owner: p.idx, zone: 'hand', hidden: !showHand })).join('')}</div>
            <button class="gy-pile" data-pile="graveyard" data-p="${p.idx}" title="Cementerio">${
              p.graveyard.length ? cardHTML(p.graveyard[p.graveyard.length - 1], { small: true, owner: p.idx, zone: 'graveyard' }) : 'GY'
            }</button>
          </div>`
        : showHand && p.hand.length
          ? `<div class="hand mini">${p.hand.map((c) => cardHTML(c, { small: true, owner: p.idx, zone: 'hand' })).join('')}</div>`
          : ''
    }
  </section>`;
}

function stepBarHTML(g) {
  const idx = E.STEPS.findIndex((s) => s.id === g.step);
  return `<ol class="steps" aria-label="Paso del turno">${E.STEPS.map(
    (s, i) => `<li class="${i === idx ? 'on' : i < idx ? 'done' : ''}" title="CR ${s.cr}">${s.label}</li>`
  ).join('')}</ol>`;
}

function renderTable() {
  const g = state.game;
  if (!g) return;
  const root = $('#table');
  const you = g.players[state.you];
  const opps = g.players.filter((p) => p !== you);
  const activeP = g.players[g.active];
  const humanTurn = isHumanTurn();
  const b = g.banner;
  const inMain = g.step === 'main1' || g.step === 'main2';

  root.innerHTML = `
    <header class="table-head">
      <button class="btn ghost small" data-act="back">← Setup</button>
      <div class="title"><h1>COMMANDER TABLE</h1><span>TURN ${g.turn}</span></div>
      <div class="table-ctrl">
        <select data-setting="speed" aria-label="Velocidad">
          ${Object.keys(SPEEDS).map((k) => `<option value="${k}" ${state.settings.speed === k ? 'selected' : ''}>⏱ ${k}</option>`).join('')}
        </select>
        ${state.looping ? `<button class="btn ghost small" data-act="pause">${state.paused ? '▶ Seguir' : '❚❚ Pausa'}</button>` : ''}
        ${!state.simulate ? `<button class="btn ghost small" data-act="toggle-resp" title="Pedirte responder con instantáneos cuando tengas prioridad (CR 117)">${state.settings.askResponses ? '🛎 Prioridad' : '🔕 Prioridad'}</button>` : ''}
      </div>
    </header>
    <div class="opps n${opps.length}">${opps.map((p) => matHTML(p, { isYou: false })).join('')}</div>
    <div class="center">
      ${stepBarHTML(g)}
      ${
        g.winner != null
          ? `<div class="banner win">🏆 ${esc(g.players[g.winner].name)} GANA</div>`
          : b
            ? `<div class="banner" data-k="${b.key}"><span>${esc(b.label)}</span>${b.detail ? `<small>${esc(b.detail)}</small>` : ''}</div>`
            : ''
      }
      ${g.stack.length ? `<div class="stack-zone" title="La pila (CR 405)">PILA: ${g.stack.map((it) => esc(it.card.name)).join(' ← ')}</div>` : ''}
      <div class="turn-line" style="--pc:${activeP.color}"></div>
      <details class="log"><summary>Registro (${g.log.length})</summary><ol>${g.log
        .slice(0, 80)
        .map((l) => `<li><b>T${l.turn}</b> ${esc(l.msg)}</li>`)
        .join('')}</ol></details>
    </div>
    ${matHTML(you, { isYou: true })}
    <nav class="toolbar">
      ${
        g.winner != null
          ? `<button class="btn primary" data-act="rematch">↻ Revancha</button><button class="btn ghost" data-act="back">Volver al setup</button>`
          : humanTurn
            ? `
        <span class="mana">${esc(E.STEPS.find((s) => s.id === g.step)?.label || '')}</span>
        ${g.step === 'main1' ? `<button class="btn small" data-act="combat">⚔ Combate</button>` : ''}
        ${activeP.turnsTaken === 1 && activeP.landsPlayed === 0 && activeP.battlefield.length === 0 && inMain ? `<button class="btn small ghost" data-act="mulligan">Mulligan</button>` : ''}
        <button class="btn small ghost" data-act="ai-me">🤖 IA juega por mí</button>
        <button class="btn small primary" data-act="end-turn">Pasar turno ⏭</button>`
            : `<span class="mana">${state.busy ? 'Resolviendo…' : `${esc(activeP.name)} está jugando…`}</span>`
      }
    </nav>
  `;
}

// ---------- Popovers / modales ----------

function closeMenus() {
  document.querySelectorAll('.menu, .modal-wrap:not(.decision)').forEach((m) => m.remove());
}

function openMenu(anchor, items) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = items
    .map((it, i) => (it.sep ? '<hr>' : `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}>${it.label}</button>`))
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
    renderTable();
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

/** Modal de decisión que devuelve una promesa (no se cierra con clic afuera). */
function decide(html, bind, fallback) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap decision';
    wrap.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
    document.body.appendChild(wrap);
    const done = (v) => {
      pendingDecisions.delete(onAbort);
      wrap.remove();
      resolve(v);
    };
    const onAbort = () => done(fallback);
    pendingDecisions.add(onAbort);
    bind(wrap, done);
  });
}

function askBlocks(game, defender, attackers) {
  const blockersFor = (a) => defender.battlefield.filter((b) => E.canBlock(game, b, a));
  // Sin bloqueadores legales no hay decisión que tomar (CR 509.1a)
  if (!attackers.some((a) => blockersFor(a).length)) return Promise.resolve(new Map());
  const row = (a, i) => {
    const opts = blockersFor(a);
    const sel = (k) =>
      `<select data-a="${i}" data-k="${k}"><option value="">— sin bloquear —</option>${opts
        .map((b) => `<option value="${b.iid}">${esc(b.name)} ${E.power(game, b)}/${E.toughness(game, b)}</option>`)
        .join('')}</select>`;
    return `<div class="atk">${cardHTML(a, { small: true })}
      <div><b>${esc(a.name)}</b> ${E.power(game, a)}/${E.toughness(game, a)} <small>${esc((a.keywords || []).join(', '))}</small><br>
      ${opts.length ? sel(0) + (E.has(a, 'menace') ? ' + ' + sel(1) + ' <small>(menace: 2+ bloqueadores)</small>' : '') : '<small>No puedes bloquearla</small>'}</div></div>`;
  };
  return decide(
    `<h3>🛡 Declara bloqueadores (CR 509)</h3>
     <p class="hint">${esc(defender.name)}: te atacan ${attackers.length} criatura${attackers.length > 1 ? 's' : ''}. Vida: ${defender.life}.</p>
     <div class="atk-list">${attackers.map(row).join('')}</div>
     <div class="row-btns"><button class="btn ghost small" data-suggest>🤖 Sugerencia</button><button class="btn primary" data-ok>Confirmar bloqueos</button></div>`,
    (wrap, done) => {
      wrap.querySelector('[data-suggest]').onclick = () => {
        const s = E.aiChooseBlocks(game, defender, attackers);
        attackers.forEach((a, i) => {
          (s.get(a) || []).forEach((b, k) => {
            const el = wrap.querySelector(`select[data-a="${i}"][data-k="${k}"]`);
            if (el) el.value = b.iid;
          });
        });
      };
      wrap.querySelector('[data-ok]').onclick = () => {
        const map = new Map();
        attackers.forEach((a, i) => {
          const list = [...wrap.querySelectorAll(`select[data-a="${i}"]`)]
            .map((el) => defender.battlefield.find((b) => b.iid === +el.value))
            .filter(Boolean);
          if (list.length) map.set(a, [...new Set(list)]);
        });
        done(map);
      };
    },
    new Map()
  );
}

function askResponse(game, player, ctx, options) {
  const what =
    ctx.type === 'spell'
      ? `${esc(ctx.item.controller.name)} lanza <b>${esc(ctx.item.card.name)}</b>.`
      : `Te atacan: ${ctx.attackers.map((a) => esc(a.name)).join(', ')}.`;
  return decide(
    `<h3>⏱ Tienes prioridad (CR 117)</h3>
     <p>${what} ¿Quieres responder?</p>
     <div class="pile">${options
       .map((c) => `<div class="pile-item">${cardHTML(c, { small: false })}<button class="btn small" data-pick="${c.iid}">Lanzar</button></div>`)
       .join('')}</div>
     <button class="btn primary" data-pass>Pasar prioridad</button>`,
    (wrap, done) => {
      wrap.querySelector('[data-pass]').onclick = () => done(null);
      wrap.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => done(options.find((c) => c.iid === +b.dataset.pick))));
    },
    null
  );
}

function askDiscard(game, p, n) {
  return decide(
    `<h3>🗑 Limpieza: descarta ${n} carta${n > 1 ? 's' : ''} (CR 514.1)</h3>
     <div class="pile">${p.hand
       .map((c) => `<label class="pile-item pick-card"><input type="checkbox" value="${c.iid}">${cardHTML(c)}</label>`)
       .join('')}</div>
     <button class="btn primary" data-ok disabled>Descartar</button>`,
    (wrap, done) => {
      const ok = wrap.querySelector('[data-ok]');
      wrap.addEventListener('change', () => {
        ok.disabled = wrap.querySelectorAll('input:checked').length !== n;
      });
      ok.onclick = () => {
        const ids = [...wrap.querySelectorAll('input:checked')].map((i) => +i.value);
        done(p.hand.filter((c) => ids.includes(c.iid)));
      };
    },
    p.hand.slice(0, n)
  );
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
  const g = state.game;
  const loc = E.findCard(g, +el.dataset.iid);
  if (!loc) return;
  const { card, zone, player } = loc;
  const view = { label: '🔍 Ver carta', run: () => previewCard(card) };
  if (player.isAI || player.idx !== g.active || !isHumanTurn()) return previewCard(card);

  const manual = (fn) => () => humanAction(async () => {
    fn();
    E.runSBA(g);
    await E.flushTriggers(g, io);
  });
  const mv = (to, pos) => manual(() => E.moveCard(g, card, to, { position: pos }));
  const cast = () =>
    humanAction(async () => {
      let x = 0;
      if (/\{X\}/.test(card.manaCost || '')) x = Math.max(0, parseInt(prompt('Valor de X:', '1') || '0', 10) || 0);
      const res = await E.castSpell(g, player, card, io, { x });
      if (!res.ok) toast(res.reason);
      else if (res.effects?.length) g.banner = { label: 'RESOLVE', detail: `${card.name} · ${res.effects.join(', ')}`, key: Math.random() };
    });

  let items = [];
  if (zone === 'hand') {
    if (isLand(card)) {
      const why = E.landBlockReason(g, player, card);
      items.push({
        label: `🌲 Jugar tierra${why ? ' ⚠' : ''}`,
        run: () => {
          const res = E.playLand(g, player, card);
          if (!res.ok) toast(res.reason);
        },
      });
    } else {
      const why = E.castBlockReason(g, player, card);
      const payable = E.canPay(g, player, card);
      items.push({ label: `✨ Lanzar ${esc(card.manaCost || '')}${why ? ' ⚠ timing' : !payable ? ' ⚠ maná' : ''}`, run: cast });
    }
    items.push({ sep: true }, { label: '🪦 Descartar (manual)', run: mv('graveyard') }, { label: '⬇ Al campo sin pagar (manual)', run: manual(() => { E.moveCard(g, card, 'battlefield'); }) });
  } else if (zone === 'battlefield') {
    for (const ab of E.activatedAbilities(g, player, card)) {
      items.push({ label: `⚙ ${esc(ab.label)}`, run: () => humanAction(async () => {
        const fx = await E.activate(g, player, card, ab, io);
        g.banner = { label: 'ABILITY', detail: `${card.name}${fx.length ? ' · ' + fx.join(', ') : ''}`, key: Math.random() };
      }) });
    }
    items.push(
      { label: card.tapped ? '↺ Enderezar (manual)' : '↻ Girar (manual)', run: () => (card.tapped = !card.tapped) },
      { sep: true },
      { label: '🔥 Sacrificar', run: mv('graveyard') },
      { label: '🌀 Exiliar', run: mv('exile') },
      { label: '✋ A la mano', run: mv('hand') }
    );
    if (isCreature(card)) items.push({ label: '➕ Contador +1/+1', run: () => card.counters.p1++ });
  } else if (zone === 'command') {
    const why = E.castBlockReason(g, player, card);
    items.push({ label: `👑 Lanzar comandante (${E.commanderCost(player, card)})${why ? ' ⚠ timing' : !E.canPay(g, player, card) ? ' ⚠ maná' : ''}`, run: cast });
  } else if (zone === 'graveyard') {
    return openPile(player.idx, 'graveyard');
  }
  items.push(view);
  openMenu(el, items);
}

function openPile(pIdx, zone) {
  const g = state.game;
  const p = g.players[pIdx];
  const mine = p.idx === g.active && !p.isAI && isHumanTurn();
  const cards = [...p[zone]].reverse();
  openModal(
    `<h3>${zone === 'graveyard' ? '🪦 Cementerio' : '🌀 Exilio'} de ${esc(p.name)} (${cards.length})</h3>
     <div class="pile">${cards.map((c) => `<div class="pile-item">${cardHTML(c, { owner: p.idx, zone })}${
       mine ? `<div class="pile-acts"><button data-to="hand" data-iid="${c.iid}" title="A la mano">✋</button><button data-to="battlefield" data-iid="${c.iid}" title="Al campo">⬆</button></div>` : ''
     }</div>`).join('') || '<p class="hint">Vacío</p>'}</div>`,
    (e) => {
      const b = e.target.closest('button[data-to]');
      if (b) {
        const loc = E.findCard(g, +b.dataset.iid);
        if (loc) E.moveCard(g, loc.card, b.dataset.to);
        closeMenus();
        renderTable();
        return;
      }
      const c = e.target.closest('.card');
      if (c) {
        const loc = E.findCard(g, +c.dataset.iid);
        if (loc) previewCard(loc.card);
      }
    }
  );
}

function openCombat() {
  const g = state.game;
  const p = g.players[g.active];
  const attackers = p.battlefield.filter((c) => E.canAttack(g, c));
  const targets = E.opponents(g, p);
  if (!attackers.length) return toast('No tienes criaturas que puedan atacar (mareo de invocación, CR 302.6).');
  const def = [...targets].sort((a, b) => a.life - b.life)[0];
  const tgtSelect = (iid) =>
    `<select data-t="${iid}">${targets.map((o) => `<option value="${o.idx}" ${o === def ? 'selected' : ''}>${esc(o.name)} (${o.life}❤)</option>`).join('')}</select>`;
  openModal(
    `<h3>⚔ Declarar atacantes (CR 508)</h3>
     <p class="hint">Cada criatura puede atacar a un jugador distinto (CR 506.2). Los oponentes deciden sus bloqueos.</p>
     <div class="atk-list">${attackers
       .map(
         (c) => `<label class="atk"><input type="checkbox" value="${c.iid}" checked>${cardHTML(c, { small: true })}
          <span>${esc(c.name)} ${E.power(g, c)}/${E.toughness(g, c)}<br><small>${esc((c.keywords || []).join(', '))}</small></span>${tgtSelect(c.iid)}</label>`
       )
       .join('')}</div>
     <button class="btn primary" data-go>Atacar</button>`,
    (e, wrap) => {
      if (!e.target.closest('[data-go]')) return;
      const plan = [...wrap.querySelectorAll('.atk input:checked')].map((i) => ({
        attacker: attackers.find((c) => c.iid === +i.value),
        defender: g.players[+wrap.querySelector(`select[data-t="${i.value}"]`).value],
      }));
      closeMenus();
      if (!plan.length) return;
      humanAction(() => E.runCombat(g, p, plan, io));
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
    if (act === 'start') startGame(false);
    if (act === 'simulate') startGame(true);
  });
  root.addEventListener('input', (e) => {
    const seatEl = e.target.closest('[data-seat]');
    const f = e.target.dataset.field;
    if (!seatEl || !f || f === 'commander' || f === 'isAI') return;
    state.seats[+seatEl.dataset.seat][f] = e.target.value;
    save();
  });
  root.addEventListener('change', (e) => {
    const seatEl = e.target.closest('[data-seat]');
    if (!seatEl) return;
    const seat = state.seats[+seatEl.dataset.seat];
    if (e.target.dataset.field === 'isAI') seat.isAI = e.target.checked;
    if (e.target.dataset.field === 'commander') setCommander(seat, e.target.value);
    save();
    renderSetup();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.field === 'url') loadSeat(+e.target.closest('[data-seat]').dataset.seat);
  });
}

function bindTable() {
  const root = $('#table');
  root.addEventListener('click', (e) => {
    const g = state.game;
    if (!g) return;
    const t = e.target;
    const act = t.closest('[data-act]')?.dataset.act;
    if (act) {
      if (act === 'back') {
        abortGame();
        state.game = null;
        $('#table').hidden = true;
        $('#setup').hidden = false;
        document.body.classList.remove('playing');
        return renderSetup();
      }
      if (act === 'rematch') return startGame(state.simulate);
      if (act === 'pause') state.paused = !state.paused;
      if (act === 'toggle-resp') {
        state.settings.askResponses = !state.settings.askResponses;
        save();
      }
      if (!isHumanTurn()) return renderTable();
      const p = g.players[g.active];
      if (act === 'mulligan') E.mulligan(g, p);
      if (act === 'combat') return openCombat();
      if (act === 'end-turn') return humanAction(() => E.endTurn(g, io));
      if (act === 'ai-me') return humanAction(() => E.aiTurn(g, io, { skipStart: true }));
      return renderTable();
    }
    const life = t.closest('[data-life]');
    if (life) {
      const pl = g.players[+life.dataset.p];
      pl.life += +life.dataset.life * (e.shiftKey ? 5 : 1);
      E.runSBA(g);
      return renderTable();
    }
    const pile = t.closest('[data-pile]');
    if (pile) return openPile(+pile.dataset.p, pile.dataset.pile);
    const card = t.closest('.card[data-iid]');
    if (card) return cardMenu(card);
  });
  root.addEventListener('dblclick', (e) => {
    const g = state.game;
    const el = e.target.closest('.card[data-zone="battlefield"]');
    if (!g || !el || !isHumanTurn()) return;
    const loc = E.findCard(g, +el.dataset.iid);
    if (loc && loc.player.idx === g.active && !loc.player.isAI) {
      closeMenus();
      loc.card.tapped = !loc.card.tapped;
      renderTable();
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset.setting === 'speed') {
      state.settings.speed = e.target.value;
      save();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('.card')) document.querySelectorAll('.menu').forEach((m) => m.remove());
  });
}

restore();
bindSetup();
bindTable();
renderSetup();
