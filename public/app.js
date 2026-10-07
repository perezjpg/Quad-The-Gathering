import { parseDeckText } from './lib/deckText.js';
import { fetchCards, lookup } from './lib/scryfall.js';
import { analyze, isLand, isCreature, BRACKET_NAMES } from './lib/stats.js';
import { DEMO_DECKS } from './lib/demo.js';
import * as E from './lib/engine.js';

// ---------- Estado ----------

const SEAT_COLORS = ['#39c5bb', '#9b5de5', '#e63946', '#f4a261'];
const SPEEDS = { lenta: 1300, normal: 750, rápida: 280, turbo: 40 };

const state = {
  count: 4,
  seats: Array.from({ length: 4 }, (_, i) => newSeat(i)),
  game: null,
  you: 0, // asiento que se muestra abajo
  settings: { speed: 'normal', autoBlock: true, showAIHands: false },
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
      ${st.count !== 100 ? `<div class="warn small">El deck tiene ${st.count} cartas (Commander usa 100).</div>` : ''}
      ${st.missing.length ? `<div class="warn small">No encontradas en Scryfall: ${esc(st.missing.slice(0, 5).join(', '))}${st.missing.length > 5 ? '…' : ''}</div>` : ''}
      `
        : ''
    }
  </article>`;
}

// ---------- Mesa ----------

function startGame(simulate) {
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
  $('#setup').hidden = true;
  $('#table').hidden = false;
  document.body.classList.add('playing');
  renderTable();
  runLoop();
}

async function step(label, detail) {
  state.game.banner = { label, detail, key: Math.random() };
  renderTable();
  const ms = SPEEDS[state.settings.speed] ?? 700;
  await sleep(ms);
  while (state.paused) await sleep(150);
}

async function runLoop() {
  if (state.looping) return;
  state.looping = true;
  try {
    const g = state.game;
    while (g && g === state.game && g.winner == null) {
      const p = g.players[g.active];
      if (p.isAI) {
        await E.aiTurn(g, step);
        if (g.turn > 60) {
          E.log(g, '⏱ Límite de 60 turnos alcanzado.');
          break;
        }
      } else {
        E.startTurn(g);
        g.banner = { label: 'TU TURNO', detail: p.name, key: Math.random() };
        g.humanTurnStarted = true;
        renderTable();
        break; // esperar acciones del humano
      }
    }
  } finally {
    state.looping = false;
    renderTable();
  }
}

function endHumanTurn() {
  const g = state.game;
  const p = g.players[g.active];
  if (p.isAI || g.winner != null) return;
  while (p.hand.length > 7) E.moveCard(g, p.hand[0], 'graveyard');
  E.endTurn(g);
  runLoop();
}

async function aiPlayForMe() {
  const g = state.game;
  const p = g.players[g.active];
  if (p.isAI || state.looping) return;
  state.looping = true;
  try {
    // El turno humano ya hizo untap/draw, así que la IA continúa desde la fase principal.
    await E.aiTurn(g, step, { skipStart: true });
  } finally {
    state.looping = false;
  }
  runLoop();
}

// ---------- Render: Mesa ----------

// Solo animar cartas que aparecen por primera vez en una zona (evita parpadeo al re-renderizar).
const seenCards = new Set();

function cardHTML(c, { small = false, owner = null, zone = '', hidden = false, count = 0 } = {}) {
  if (hidden) return `<div class="card back ${small ? 'sm' : ''}"></div>`;
  const seenKey = `${c.iid}:${zone}`;
  const fresh = !seenCards.has(seenKey);
  seenCards.add(seenKey);
  const pt =
    isCreature(c) && c.power != null
      ? `<span class="pt ${c.damage ? 'hurt' : ''}">${esc(c.power)}/${esc(c.toughness)}${c.damage ? ` <s>-${c.damage}</s>` : ''}</span>`
      : '';
  const img = c.imgSmall
    ? `<img src="${esc(c.imgSmall)}" alt="${esc(c.name)}" loading="lazy" draggable="false">`
    : `<div class="text-card"><b>${esc(c.name)}</b><small>${esc(c.typeLine)}</small></div>`;
  return `<div class="card ${small ? 'sm' : ''} ${c.tapped ? 'tapped' : ''} ${c.sick && isCreature(c) && zone === 'battlefield' ? 'sick' : ''} ${c.isCommander ? 'commander' : ''} ${c.isToken ? 'token' : ''} ${fresh ? 'fresh' : ''}"
    data-iid="${c.iid}" data-zone="${zone}" data-owner="${owner}" title="${esc(c.name)}" tabindex="0">${img}${pt}${count > 1 ? `<span class="stack">×${count}</span>` : ''}</div>`;
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

function matHTML(p, { isYou }) {
  const g = state.game;
  const active = g.active === p.idx && g.winner == null;
  const lands = p.battlefield.filter(isLand);
  const creatures = p.battlefield.filter((c) => !isLand(c) && isCreature(c));
  const others = p.battlefield.filter((c) => !isLand(c) && !isCreature(c));
  const small = !isYou;
  const cmdDmg = Object.entries(p.commanderDamage).filter(([, v]) => v > 0);
  const showHand = isYou || state.settings.showAIHands;
  return `
  <section class="mat ${isYou ? 'you' : 'opp'} ${active ? 'active' : ''} ${p.alive ? '' : 'dead'} ${g.winner === p.idx ? 'winner' : ''}" style="--pc:${p.color}" data-player="${p.idx}">
    <div class="mat-head">
      <span class="pill">${esc(p.name)}${p.isAI ? ' <small>IA</small>' : ''}</span>
      <span class="life-wrap">
        <button class="life-btn" data-life="-1" data-p="${p.idx}" aria-label="Restar vida">−</button>
        <span class="life ${p.life <= 10 ? 'low' : ''}">${p.life}</span>
        <button class="life-btn" data-life="1" data-p="${p.idx}" aria-label="Sumar vida">+</button>
      </span>
      ${cmdDmg.length ? `<span class="cmd-dmg" title="Daño de comandante recibido">🗡 ${cmdDmg.map(([, v]) => v).join(' / ')}</span>` : ''}
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
        ${p.command.map((c) => `${cardHTML(c, { small, owner: p.idx, zone: 'command' })}${p.commanderTax[c.iid] ? `<span class="tax">+${p.commanderTax[c.iid]}</span>` : ''}`).join('')}
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

function renderTable() {
  const g = state.game;
  if (!g) return;
  const root = $('#table');
  const you = g.players[state.you];
  const opps = g.players.filter((p) => p !== you);
  const activeP = g.players[g.active];
  const humanTurn = !activeP.isAI && g.winner == null && !state.looping;
  const b = g.banner;

  root.innerHTML = `
    <header class="table-head">
      <button class="btn ghost small" data-act="back">← Setup</button>
      <div class="title"><h1>COMMANDER TABLE</h1><span>TURN ${g.turn}</span></div>
      <div class="table-ctrl">
        <select data-setting="speed" aria-label="Velocidad">
          ${Object.keys(SPEEDS).map((k) => `<option value="${k}" ${state.settings.speed === k ? 'selected' : ''}>⏱ ${k}</option>`).join('')}
        </select>
        ${state.looping ? `<button class="btn ghost small" data-act="pause">${state.paused ? '▶ Seguir' : '❚❚ Pausa'}</button>` : ''}
      </div>
    </header>
    <div class="opps n${opps.length}">${opps.map((p) => matHTML(p, { isYou: false })).join('')}</div>
    <div class="center">
      ${
        g.winner != null
          ? `<div class="banner win">🏆 ${esc(g.players[g.winner].name)} GANA</div>`
          : b
            ? `<div class="banner" data-k="${b.key}"><span>${esc(b.label)}</span>${b.detail ? `<small>${esc(b.detail)}</small>` : ''}</div>`
            : ''
      }
      <div class="turn-line" style="--pc:${activeP.color}"></div>
      <details class="log"><summary>Registro (${g.log.length})</summary><ol>${g.log
        .slice(0, 60)
        .map((l) => `<li><b>T${l.turn}</b> ${esc(l.msg)}</li>`)
        .join('')}</ol></details>
    </div>
    ${matHTML(you, { isYou: true })}
    <nav class="toolbar ${humanTurn ? '' : 'disabled'}">
      ${
        g.winner != null
          ? `<button class="btn primary" data-act="rematch">↻ Revancha</button><button class="btn ghost" data-act="back">Volver al setup</button>`
          : humanTurn
            ? `
        <span class="mana">💎 ${E.availableMana(activeP)} maná</span>
        <button class="btn small" data-act="draw">Robar</button>
        <button class="btn small" data-act="combat">⚔ Combate</button>
        ${g.turn === 1 && activeP.landsPlayed === 0 && activeP.battlefield.length === 0 ? `<button class="btn small ghost" data-act="mulligan">Mulligan</button>` : ''}
        <button class="btn small ghost" data-act="shuffle">Barajar</button>
        <button class="btn small ghost" data-act="ai-me">🤖 IA juega por mí</button>
        <button class="btn small primary" data-act="end-turn">Pasar turno ⏭</button>`
            : `<span class="mana">${esc(activeP.name)} está jugando…</span>`
      }
    </nav>
  `;
}

// ---------- Popovers / modales ----------

function closeMenus() {
  document.querySelectorAll('.menu, .modal-wrap').forEach((m) => m.remove());
}

function openMenu(anchor, items) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = items.map((it, i) => `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}>${it.label}</button>`).join('');
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
  const mine = player.idx === g.active && !player.isAI && !state.looping;
  const view = { label: '🔍 Ver carta', run: () => previewCard(card) };
  if (!mine || g.winner != null) return previewCard(card);
  const mv = (to, pos) => () => E.moveCard(g, card, to, pos);
  let items = [];
  if (zone === 'hand') {
    items = isLand(card)
      ? [{ label: `🌲 Jugar tierra${player.landsPlayed ? ' (extra)' : ''}`, run: () => E.playLand(g, player, card) }]
      : [
          {
            label: `✨ Lanzar (${card.cmc || 0})${E.availableMana(player) < (card.cmc || 0) ? ' ⚠ sin maná' : ''}`,
            run: () => showEffects(card, E.castCard(g, player, card)),
          },
          { label: '⬇ Al campo sin pagar', run: () => E.castCard(g, player, card, { pay: false }) },
        ];
    items.push({ label: '🪦 Descartar', run: mv('graveyard') }, { label: '📚 Al fondo de la biblioteca', run: mv('library', 'bottom') });
  } else if (zone === 'battlefield') {
    items = [
      { label: card.tapped ? '↺ Enderezar' : '↻ Girar', run: () => (card.tapped = !card.tapped) },
      { label: '🔥 Sacrificar / Destruir', run: mv('graveyard') },
      { label: '🌀 Exiliar', run: mv('exile') },
      { label: '✋ A la mano', run: mv('hand') },
    ];
    if (isCreature(card)) items.splice(1, 0, { label: '➕ +1/+1 (contador)', run: () => buff(card) });
  } else if (zone === 'command') {
    const cost = E.commanderCost(player, card);
    items = [{ label: `👑 Lanzar comandante (${cost})${E.availableMana(player) < cost ? ' ⚠' : ''}`, run: () => E.castCard(g, player, card) }];
  } else if (zone === 'graveyard') {
    return openPile(player.idx, 'graveyard');
  }
  items.push(view);
  openMenu(el, items);
}

function buff(card) {
  card.power = String((parseInt(card.power, 10) || 0) + 1);
  card.toughness = String((parseInt(card.toughness, 10) || 0) + 1);
}

function showEffects(card, effects) {
  state.game.banner = { label: 'CAST', detail: `${card.name}${effects.length ? ' · ' + effects.join(', ') : ''}`, key: Math.random() };
}

function openPile(pIdx, zone) {
  const g = state.game;
  const p = g.players[pIdx];
  const mine = p.idx === g.active && !p.isAI;
  const cards = [...p[zone]].reverse();
  openModal(
    `<h3>${zone === 'graveyard' ? '🪦 Cementerio' : '🌀 Exilio'} de ${esc(p.name)} (${cards.length})</h3>
     <div class="pile">${cards.map((c) => `<div class="pile-item">${cardHTML(c, { owner: p.idx, zone })}${
       mine ? `<div class="pile-acts"><button data-to="hand" data-iid="${c.iid}">✋</button><button data-to="battlefield" data-iid="${c.iid}">⬆</button></div>` : ''
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
  const attackers = p.battlefield.filter(E.canAttack);
  const targets = g.players.filter((o) => o !== p && o.alive);
  if (!attackers.length) return toast('No tienes criaturas que puedan atacar.');
  openModal(
    `<h3>⚔ Declarar ataque</h3>
     <label>Objetivo:
       <select id="atk-target">${targets.map((o) => `<option value="${o.idx}">${esc(o.name)} (${o.life}❤)</option>`).join('')}</select>
     </label>
     <div class="atk-list">${attackers
       .map(
         (c) => `<label class="atk"><input type="checkbox" value="${c.iid}" checked>${cardHTML(c, { small: true })}<span>${esc(c.name)} ${esc(c.power)}/${esc(c.toughness)}</span></label>`
       )
       .join('')}</div>
     <p class="hint">Los oponentes bloquean automáticamente según su mejor jugada.</p>
     <button class="btn primary" data-go>Atacar</button>`,
    (e, wrap) => {
      if (!e.target.closest('[data-go]')) return;
      const target = g.players[+$('#atk-target', wrap).value];
      const ids = [...wrap.querySelectorAll('.atk input:checked')].map((i) => +i.value);
      const chosen = attackers.filter((c) => ids.includes(c.iid));
      closeMenus();
      if (!chosen.length) return;
      const summary = E.resolveCombat(g, p, chosen, target, { autoBlock: true });
      g.banner = { label: 'COMBAT', detail: summary, key: Math.random() };
      renderTable();
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
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
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
    const p = g.players[g.active];
    if (act) {
      if (act === 'back') {
        state.game = null;
        state.paused = false;
        $('#table').hidden = true;
        $('#setup').hidden = false;
        document.body.classList.remove('playing');
        return renderSetup();
      }
      if (act === 'rematch') return startGame(state.simulate);
      if (act === 'pause') state.paused = !state.paused;
      if (act === 'draw') E.draw(g, p, 1);
      if (act === 'shuffle') {
        p.library.sort(() => Math.random() - 0.5);
        toast('Biblioteca barajada');
      }
      if (act === 'mulligan') E.mulligan(g, p);
      if (act === 'combat') return openCombat();
      if (act === 'end-turn') return endHumanTurn();
      if (act === 'ai-me') return aiPlayForMe();
      return renderTable();
    }
    const life = t.closest('[data-life]');
    if (life) {
      const pl = g.players[+life.dataset.p];
      pl.life += +life.dataset.life * (e.shiftKey ? 5 : 1);
      E.checkState(g);
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
    if (!g || !el) return;
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
