// Super Battle Chess - client.

import { SIZE, buildGrid, computeMoves, isLegalMove } from './rules.js';
import { pieceSVG } from './pieces.js';
import { sfx } from './sfx.js';

const $ = (sel) => document.querySelector(sel);

const EMOTES = ['😂', '😡', '😎', '😱', '👏', '💀', '🫡', '🐔'];
const BONKS = ['BONK!', 'WHAM!', 'POW!', 'SMACK!', 'BAM!', 'OOF!'];
const TEAM_NAMES = ['Blue', 'Red'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws = null;
let myId = null;
let lobby = null;       // latest lobby snapshot from server
let inGame = false;
let game = null;        // active game state

const els = {
  screens: {
    home: $('#screen-home'),
    lobby: $('#screen-lobby'),
    game: $('#screen-game'),
  },
  board: $('#board'),
  boardWrap: $('#board-wrap'),
  piecesLayer: $('#pieces-layer'),
  fxLayer: $('#fx-layer'),
  emoteLayer: $('#emote-layer'),
  countdown: $('#countdown'),
  overlayEnd: $('#overlay-end'),
  toast: $('#toast'),
};

function showScreen(name) {
  for (const [key, el] of Object.entries(els.screens)) {
    el.classList.toggle('hidden', key !== name);
  }
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3000);
}

function myTeam() {
  const me = lobby?.players.find((p) => p.id === myId);
  return me ? me.team : 0;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) return resolve();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Could not reach the server.'));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = () => {
      if (lobby || inGame) {
        toast('Disconnected from server 😵');
        resetToHome();
      }
      ws = null;
    };
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function resetToHome() {
  lobby = null;
  inGame = false;
  game = null;
  els.overlayEnd.classList.add('hidden');
  showScreen('home');
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

function handleMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      myId = msg.id;
      break;
    case 'lobby':
      lobby = msg;
      renderLobby();
      if (!inGame && els.overlayEnd.classList.contains('hidden')) {
        showScreen('lobby');
      }
      break;
    case 'start':
      startGame(msg);
      break;
    case 'move':
      applyMove(msg);
      break;
    case 'reject': {
      const rec = game?.els.get(msg.id);
      if (rec) {
        rec.el.classList.remove('wiggle');
        void rec.el.offsetWidth;
        rec.el.classList.add('wiggle');
      }
      sfx.reject();
      break;
    }
    case 'end':
      endGame(msg);
      break;
    case 'emote':
      showEmote(msg);
      break;
    case 'playerLeft':
      toast(`${msg.name} left the game`);
      break;
    case 'error':
      toast(msg.msg);
      break;
  }
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

const nameInput = $('#name-input');
const codeInput = $('#code-input');

nameInput.value = localStorage.getItem('sbc-name') || '';
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) codeInput.value = urlCode.toUpperCase().slice(0, 4);

function getName() {
  const name = nameInput.value.trim() || 'Player';
  localStorage.setItem('sbc-name', name);
  return name;
}

async function doConnect(action) {
  const btns = [$('#btn-create'), $('#btn-join')];
  btns.forEach((b) => (b.disabled = true));
  try {
    await connect();
    action();
  } catch (err) {
    toast(err.message);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

$('#btn-create').addEventListener('click', () => {
  doConnect(() => send({ t: 'create', name: getName() }));
});

$('#btn-join').addEventListener('click', joinWithCode);
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinWithCode(); });

function joinWithCode() {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Room codes are 4 letters!');
    return;
  }
  doConnect(() => send({ t: 'join', code, name: getName() }));
}

// Home mascots
$('#mascot-left').innerHTML = pieceSVG('pawn', 0);
$('#mascot-right').innerHTML = pieceSVG('king', 1);

// ---------------------------------------------------------------------------
// Lobby screen
// ---------------------------------------------------------------------------

function renderLobby() {
  if (!lobby) return;
  $('#lobby-code').textContent = lobby.code;

  const isHost = lobby.hostId === myId;
  const perTeam = lobby.mode === '2v2' ? 2 : 1;

  for (const team of [0, 1]) {
    const list = $(`#team${team}-list`);
    list.innerHTML = '';
    const members = lobby.players.filter((p) => p.team === team);
    for (const p of members) {
      const li = document.createElement('li');
      const crown = p.id === lobby.hostId ? '👑 ' : '';
      li.textContent = `${crown}${p.name}`;
      if (p.id === myId) {
        const tag = document.createElement('span');
        tag.className = 'you-tag';
        tag.textContent = 'you';
        li.appendChild(tag);
      }
      list.appendChild(li);
    }
    for (let i = members.length; i < perTeam; i++) {
      const li = document.createElement('li');
      li.className = 'empty-slot';
      li.textContent = 'waiting…';
      list.appendChild(li);
    }
  }

  // Team switch buttons
  const me = lobby.players.find((p) => p.id === myId);
  document.querySelectorAll('.btn-team').forEach((btn) => {
    btn.classList.toggle('hidden-btn', !me || me.team === Number(btn.dataset.team));
  });

  // Mode / speed segments
  const segMode = $('#seg-mode');
  const segSpeed = $('#seg-speed');
  segMode.classList.toggle('locked', !isHost);
  segSpeed.classList.toggle('locked', !isHost);
  segMode.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === lobby.mode));
  segSpeed.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.speed === lobby.speed));

  // Start button + hint
  const counts = [0, 0];
  lobby.players.forEach((p) => counts[p.team]++);
  const ready = counts[0] === perTeam && counts[1] === perTeam && lobby.players.length === perTeam * 2;
  const startBtn = $('#btn-start');
  startBtn.classList.toggle('hidden', !isHost);
  startBtn.disabled = !ready;
  const hint = $('#lobby-hint');
  if (!ready) {
    hint.textContent = `Waiting for players — ${lobby.mode} needs ${perTeam} per team`;
  } else {
    hint.textContent = isHost ? 'Everyone is here. Let’s go!' : 'Waiting for the host to start…';
  }
}

document.querySelectorAll('.btn-team').forEach((btn) => {
  btn.addEventListener('click', () => {
    send({ t: 'setTeam', team: Number(btn.dataset.team) });
    sfx.select();
  });
});

$('#seg-mode').addEventListener('click', (e) => {
  const mode = e.target.dataset?.mode;
  if (mode && lobby?.hostId === myId) send({ t: 'setMode', mode });
});

$('#seg-speed').addEventListener('click', (e) => {
  const speed = e.target.dataset?.speed;
  if (speed && lobby?.hostId === myId) send({ t: 'setSpeed', speed });
});

$('#btn-start').addEventListener('click', () => send({ t: 'start' }));

$('#btn-leave').addEventListener('click', () => {
  send({ t: 'leave' });
  resetToHome();
});

$('#btn-copy').addEventListener('click', async () => {
  const link = `${location.origin}/?code=${lobby?.code || ''}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied! 📋');
  } catch {
    toast(`Invite link: ${link}`);
  }
});

// ---------------------------------------------------------------------------
// Board setup
// ---------------------------------------------------------------------------

const cells = []; // index = vy * 8 + vx (visual coords)

function buildBoard() {
  if (cells.length) return;
  for (let vy = 0; vy < SIZE; vy++) {
    for (let vx = 0; vx < SIZE; vx++) {
      const cell = document.createElement('div');
      cell.className = `cell ${(vx + vy) % 2 === 0 ? 'light' : 'dark'}`;
      cell.addEventListener('pointerdown', () => onCellTap(vx, vy));
      els.board.appendChild(cell);
      cells.push(cell);
    }
  }
}

function toVisual(x, y) {
  return game?.flip ? { vx: SIZE - 1 - x, vy: SIZE - 1 - y } : { vx: x, vy: y };
}

function toModel(vx, vy) {
  return game?.flip ? { x: SIZE - 1 - vx, y: SIZE - 1 - vy } : { x: vx, y: vy };
}

function cellAt(x, y) {
  const { vx, vy } = toVisual(x, y);
  return cells[vy * SIZE + vx];
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------

function startGame(msg) {
  buildBoard();
  els.piecesLayer.innerHTML = '';
  els.fxLayer.innerHTML = '';
  els.emoteLayer.innerHTML = '';
  els.overlayEnd.classList.add('hidden');
  cells.forEach((c) => c.classList.remove('sel', 'dot', 'ring', 'last-move'));

  inGame = true;
  game = {
    cooldown: msg.cooldown,
    players: msg.players,
    flip: msg.players.find((p) => p.id === myId)?.team === 1,
    myTeam: msg.players.find((p) => p.id === myId)?.team ?? 0,
    pieces: [],
    els: new Map(), // pieceId -> { el, svgType, data, cdUntil }
    startsAt: Date.now() + msg.in,
    playing: false,
    selected: null,
  };

  reconcilePieces(msg.pieces);
  renderHud();
  showScreen('game');
  runCountdown(msg.in);
  requestAnimationFrame(cooldownLoop);
}

function runCountdown(ms) {
  const cd = els.countdown;
  cd.classList.remove('hidden');
  const seconds = Math.round(ms / 1000);
  const showNum = (n) => {
    cd.innerHTML = `<span class="num">${n}</span>`;
    if (n === 'GO!') sfx.go(); else sfx.tick();
  };
  for (let i = 0; i < seconds; i++) {
    setTimeout(() => showNum(String(seconds - i)), i * 1000);
  }
  setTimeout(() => {
    showNum('GO!');
    if (game) game.playing = true;
  }, ms);
  setTimeout(() => cd.classList.add('hidden'), ms + 600);
}

function renderHud() {
  for (const team of [0, 1]) {
    const hud = team === 0 ? $('#hud-left') : $('#hud-right');
    const names = game.players
      .filter((p) => p.team === team)
      .map((p) => (p.id === myId ? `⭐ ${p.name}` : p.name))
      .join(' & ');
    hud.querySelector('.hud-names').textContent = names;
    hud.querySelector('.hud-caps').innerHTML = '';
  }
}

// Sync local piece elements with the authoritative server list.
function reconcilePieces(list) {
  const seen = new Set();
  const now = Date.now();

  for (const p of list) {
    seen.add(p.id);
    let rec = game.els.get(p.id);
    if (!rec) {
      const el = document.createElement('div');
      el.className = 'piece';
      el.innerHTML = pieceSVG(p.type, p.team) + '<div class="cd-pie"></div>';
      els.piecesLayer.appendChild(el);
      rec = { el, svgType: p.type, data: p, cdUntil: 0 };
      game.els.set(p.id, rec);
    }
    if (rec.svgType !== p.type) {
      rec.el.innerHTML = pieceSVG(p.type, p.team) + '<div class="cd-pie"></div>';
      rec.svgType = p.type;
    }
    rec.data = p;
    rec.cdUntil = p.cd > 0 ? now + p.cd : 0;
    const { vx, vy } = toVisual(p.x, p.y);
    rec.el.style.transform = `translate(${vx * 100}%, ${vy * 100}%)`;
  }

  // Anything the server no longer reports is gone.
  for (const [id, rec] of game.els) {
    if (!seen.has(id)) {
      rec.el.remove();
      game.els.delete(id);
    }
  }

  game.pieces = list;
}

function gridNow() {
  return buildGrid(game.pieces.map((p) => ({ ...p, alive: true })));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function clearSelection() {
  if (game?.selected) {
    const rec = game.els.get(game.selected);
    rec?.el.classList.remove('selected');
  }
  if (game) game.selected = null;
  cells.forEach((c) => c.classList.remove('sel', 'dot', 'ring'));
}

function highlightSelection() {
  cells.forEach((c) => c.classList.remove('sel', 'dot', 'ring'));
  if (!game?.selected) return;
  const piece = game.pieces.find((p) => p.id === game.selected);
  if (!piece) return;
  cellAt(piece.x, piece.y).classList.add('sel');
  const grid = gridNow();
  for (const m of computeMoves(grid, piece)) {
    cellAt(m.x, m.y).classList.add(grid[m.y][m.x] ? 'ring' : 'dot');
  }
}

function onCellTap(vx, vy) {
  if (!game || !game.playing) return;
  const { x, y } = toModel(vx, vy);
  const grid = gridNow();
  const target = grid[y][x];

  if (game.selected) {
    const piece = game.pieces.find((p) => p.id === game.selected);
    if (piece && isLegalMove(grid, piece, x, y)) {
      send({ t: 'move', id: piece.id, x, y });
      sfx.move();
      clearSelection();
      return;
    }
  }

  if (target && target.team === game.myTeam) {
    const rec = game.els.get(target.id);
    if (rec && rec.cdUntil > Date.now()) {
      rec.el.classList.remove('wiggle');
      void rec.el.offsetWidth;
      rec.el.classList.add('wiggle');
      sfx.reject();
      clearSelection();
      return;
    }
    if (game.selected === target.id) {
      clearSelection();
      return;
    }
    clearSelection();
    game.selected = target.id;
    rec?.el.classList.add('selected');
    sfx.select();
    highlightSelection();
    return;
  }

  clearSelection();
}

// ---------------------------------------------------------------------------
// Moves from the server
// ---------------------------------------------------------------------------

function applyMove(msg) {
  if (!game) return;

  // Death animation for the captured piece (before reconcile removes it).
  if (msg.captured) {
    const rec = game.els.get(msg.captured.id);
    if (rec) {
      rec.el.classList.add('dying');
      const dead = rec.el;
      game.els.delete(msg.captured.id);
      setTimeout(() => dead.remove(), 350);
    }
    spawnCaptureFx(msg.to.x, msg.to.y, msg.captured.type === 'king');
    addCaptureTrophy(msg.captured);
    sfx.capture();
  } else {
    sfx.move();
  }

  reconcilePieces(msg.pieces);

  if (msg.promoted) sfx.promote();

  cells.forEach((c) => c.classList.remove('last-move'));
  cellAt(msg.from.x, msg.from.y).classList.add('last-move');
  cellAt(msg.to.x, msg.to.y).classList.add('last-move');

  // Board changed - refresh highlights for the piece we have selected.
  if (game.selected) {
    if (!game.pieces.find((p) => p.id === game.selected)) clearSelection();
    else highlightSelection();
  }
}

function spawnCaptureFx(x, y, big) {
  const { vx, vy } = toVisual(x, y);
  const cx = (vx + 0.5) * 12.5;
  const cy = (vy + 0.5) * 12.5;
  const colors = ['#ffd34d', '#ff6b57', '#5aa6ff', '#fff', '#9ade6b'];
  const n = big ? 26 : 12;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.style.left = `${cx}%`;
    s.style.top = `${cy}%`;
    s.style.background = colors[i % colors.length];
    const ang = Math.random() * Math.PI * 2;
    const dist = (big ? 70 : 45) * (0.5 + Math.random());
    s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(ang) * dist}px`);
    els.fxLayer.appendChild(s);
    setTimeout(() => s.remove(), 600);
  }
  const bonk = document.createElement('div');
  bonk.className = 'bonk';
  bonk.textContent = big ? 'ROYAL BONK!!' : BONKS[Math.floor(Math.random() * BONKS.length)];
  bonk.style.left = `${cx}%`;
  bonk.style.top = `${cy}%`;
  els.fxLayer.appendChild(bonk);
  setTimeout(() => bonk.remove(), 750);

  els.boardWrap.classList.remove('shake');
  void els.boardWrap.offsetWidth;
  els.boardWrap.classList.add('shake');
}

function addCaptureTrophy(captured) {
  const capturer = captured.team === 0 ? 1 : 0;
  const hud = capturer === 0 ? $('#hud-left') : $('#hud-right');
  const icon = document.createElement('div');
  icon.className = 'cap-icon';
  icon.innerHTML = pieceSVG(captured.type, captured.team);
  hud.querySelector('.hud-caps').appendChild(icon);
}

// ---------------------------------------------------------------------------
// Cooldown spinner loop
// ---------------------------------------------------------------------------

function cooldownLoop() {
  if (!game) return;
  const now = Date.now();
  for (const rec of game.els.values()) {
    const remaining = rec.cdUntil - now;
    if (remaining > 0) {
      rec.el.classList.add('cooling');
      const frac = Math.min(1, remaining / game.cooldown);
      const pie = rec.el.querySelector('.cd-pie');
      if (pie) {
        pie.style.background =
          `conic-gradient(rgba(43,42,64,.6) ${frac * 360}deg, rgba(255,255,255,.15) 0deg)`;
      }
    } else {
      rec.el.classList.remove('cooling');
    }
  }
  requestAnimationFrame(cooldownLoop);
}

// ---------------------------------------------------------------------------
// Game end
// ---------------------------------------------------------------------------

function endGame(msg) {
  inGame = false;
  if (game) game.playing = false;
  clearSelection();

  const won = msg.winner === game?.myTeam;
  $('#end-emoji').textContent = won ? '🏆' : '💀';
  const title = $('#end-title');
  title.textContent = `${TEAM_NAMES[msg.winner]} wins!`;
  title.className = msg.winner === 0 ? 'win-blue' : 'win-red';
  $('#end-sub').textContent =
    msg.reason === 'forfeit'
      ? 'The other team fled the battlefield!'
      : won ? 'You captured the enemy king!' : 'Your king has been captured…';

  const confetti = $('#confetti');
  confetti.innerHTML = '';
  if (won) {
    const colors = ['#ffd34d', '#ff6b57', '#5aa6ff', '#9ade6b', '#c39bff'];
    for (let i = 0; i < 40; i++) {
      const span = document.createElement('span');
      span.style.left = `${Math.random() * 100}%`;
      span.style.background = colors[i % colors.length];
      span.style.animationDuration = `${2 + Math.random() * 2.5}s`;
      span.style.animationDelay = `${Math.random() * 2}s`;
      confetti.appendChild(span);
    }
    sfx.win();
  } else {
    sfx.lose();
  }

  els.overlayEnd.classList.remove('hidden');
}

$('#btn-back-lobby').addEventListener('click', () => {
  els.overlayEnd.classList.add('hidden');
  game = null;
  renderLobby();
  showScreen('lobby');
});

// ---------------------------------------------------------------------------
// Emotes
// ---------------------------------------------------------------------------

const tray = $('#emote-tray');
EMOTES.forEach((emoji, i) => {
  const btn = document.createElement('button');
  btn.className = 'emote-btn';
  btn.textContent = emoji;
  btn.addEventListener('click', () => send({ t: 'emote', e: i }));
  tray.appendChild(btn);
});

function showEmote(msg) {
  const float = document.createElement('div');
  float.className = 'emote-float';
  float.style.left = `${12 + Math.random() * 70}%`;
  const mine = msg.from === myId;
  float.innerHTML = `<span class="e">${EMOTES[msg.e] || '❓'}</span>` +
    `<span class="who" style="background:${msg.team === 0 ? '#3a7de0' : '#d94a38'}">${mine ? 'you' : escapeHtml(msg.name)}</span>`;
  els.emoteLayer.appendChild(float);
  sfx.emote();
  setTimeout(() => float.remove(), 2300);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------------------------------------------------------------------------

window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-create').click();
});
