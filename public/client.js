// Super Battle Chess - client.

import { SIZE, buildGrid, computeMoves, isLegalMove, promotionRow } from './rules.js';
import {
  COSTS, grid as gmGrid, legalMovesFor, bonusMovesFor, ENERGY_CAP,
} from './classic.js';
import { pieceSVG } from './pieces.js';
import { sfx } from './sfx.js';
import * as br from './royale-client.js';

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
    royale: $('#screen-royale'),
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
  br.stop();
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
    case 'gstate':
      applyGstate(msg);
      break;
    case 'bs':
      br.onSnapshot(msg);
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
      const botTag = p.isBot ? `🤖 ` : '';
      li.textContent = `${crown}${botTag}${p.name}`;
      if (p.isBot) {
        const lv = document.createElement('span');
        lv.className = 'you-tag';
        lv.textContent = `Lv ${p.level}`;
        li.appendChild(lv);
        if (isHost) {
          const rm = document.createElement('button');
          rm.className = 'remove-bot';
          rm.textContent = '✕';
          rm.title = 'Remove computer';
          rm.addEventListener('click', () => send({ t: 'removeBot', id: p.id }));
          li.appendChild(rm);
        }
      }
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

  // Mode / rules / speed segments
  const segMode = $('#seg-mode');
  const segRules = $('#seg-rules');
  const segSpeed = $('#seg-speed');
  segMode.classList.toggle('locked', !isHost);
  segRules.classList.toggle('locked', !isHost);
  segSpeed.classList.toggle('locked', !isHost);
  segMode.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === lobby.mode));
  segRules.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.rules === (lobby.rules || 'battle')));
  segSpeed.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.speed === lobby.speed));
  $('#speed-group').classList.toggle('hidden', lobby.rules !== 'battle');
  $('#mode-group').classList.toggle('hidden', lobby.rules === 'royale');
  $('#bot-row').classList.toggle('hidden', !isHost);
  $('#rules-blurb').textContent =
    lobby.rules === 'grandmaster'
      ? '👑 Real chess rules: turns, check & checkmate — plus earnable power-ups (no luck involved)'
      : lobby.rules === 'royale'
        ? '🪂 Free-for-all! Drop in as a King, loot chess pieces as weapons, survive the shrinking board.'
        : '⚡ No turns! Move any piece whenever it’s off cooldown. Capture the king to win.';

  // Start button + hint
  let ready;
  let waitingText;
  if (lobby.rules === 'royale') {
    ready = lobby.players.length >= 2;
    waitingText = 'Royale needs 2-4 fighters — invite friends or add bots!';
  } else {
    const counts = [0, 0];
    lobby.players.forEach((p) => counts[p.team]++);
    ready = counts[0] === perTeam && counts[1] === perTeam && lobby.players.length === perTeam * 2;
    waitingText = `Waiting for players — ${lobby.mode} needs ${perTeam} per team`;
  }
  const startBtn = $('#btn-start');
  startBtn.classList.toggle('hidden', !isHost);
  startBtn.disabled = !ready;
  const hint = $('#lobby-hint');
  if (!ready) {
    hint.textContent = waitingText;
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

$('#seg-rules').addEventListener('click', (e) => {
  const rules = e.target.dataset?.rules;
  if (rules && lobby?.hostId === myId) send({ t: 'setRules', rules });
});

$('#btn-start').addEventListener('click', () => send({ t: 'start' }));

// Computer opponent controls
const BOT_NAMES = ['Wood Pusher', 'Pawn Pusher', 'Rook Rookie', 'Bishop Bonker', 'Castle Crusher',
  'Fork Fiend', 'Tactic Tonic', 'Sharp Silicon', 'Deep Sprocket', 'GM Gizmo'];
const botLevelSelect = $('#bot-level');
for (let lv = 1; lv <= 10; lv++) {
  const opt = document.createElement('option');
  opt.value = lv;
  opt.textContent = `Lv ${lv} · ${BOT_NAMES[lv - 1]}`;
  botLevelSelect.appendChild(opt);
}
botLevelSelect.value = '5';

$('#btn-add-bot').addEventListener('click', () => {
  send({ t: 'addBot', level: Number(botLevelSelect.value) });
  sfx.select();
});

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
  if (msg.rules === 'royale') {
    inGame = true;
    game = { rules: 'royale', players: msg.players, playing: true, myTeam: 0 };
    els.overlayEnd.classList.add('hidden');
    br.init(msg, { send, myId });
    showScreen('royale');
    return;
  }
  buildBoard();
  els.piecesLayer.innerHTML = '';
  els.fxLayer.innerHTML = '';
  els.emoteLayer.innerHTML = '';
  els.overlayEnd.classList.add('hidden');
  cells.forEach((c) => c.classList.remove('sel', 'dot', 'ring', 'last-move'));

  inGame = true;
  game = {
    rules: msg.rules || 'battle',
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

  const isGm = game.rules === 'grandmaster';
  els.screens.game.classList.toggle('gm', isGm);
  $('#power-tray').classList.toggle('hidden', !isGm);
  $('#turn-banner').classList.toggle('hidden', !isGm);
  $('#bonus-bar').classList.add('hidden');
  gm = null;
  armed.spirit = false;
  armed.wind = false;
  armed.shieldMode = false;

  reconcilePieces(msg.pieces);
  renderHud();
  showScreen('game');
  runCountdown(msg.in);
  if (isGm) {
    applyGstate(msg.gm);
  } else {
    requestAnimationFrame(cooldownLoop);
  }
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
    if (game?.rules === 'grandmaster') renderGmPanel();
  }, ms);
  setTimeout(() => cd.classList.add('hidden'), ms + 600);
}

function renderHud() {
  for (const team of [0, 1]) {
    const hud = team === 0 ? $('#hud-left') : $('#hud-right');
    const names = game.players
      .filter((p) => p.team === team)
      .map((p) => (p.id === myId ? `⭐ ${p.name}` : p.isBot ? `🤖 ${p.name}` : p.name))
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
  cells.forEach((c) => c.classList.remove('sel', 'dot', 'ring', 'sdot'));
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
  if (game.rules === 'grandmaster') {
    onCellTapGm(vx, vy);
    return;
  }
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
// Grandmaster mode
// ---------------------------------------------------------------------------

let gm = null; // latest gstate from the server
const armed = { spirit: false, wind: false, shieldMode: false };
let lastTurnKey = '';

// Rebuild a rules-engine state object from the latest server snapshot.
function gmRulesState() {
  return {
    pieces: gm.pieces.map((p) => ({ ...p, alive: true })),
    turn: gm.turn,
    ep: gm.ep,
    halfmove: 0,
    energy: [...gm.energy],
    shields: Object.fromEntries(gm.shields.map((id) => [id, true])),
    pending: null,
    history: {},
    result: null,
  };
}

function applyGstate(msg) {
  if (!game) return;

  // FX for what just happened (before reconcile removes captured pieces).
  const ev = msg.event;
  if (ev) {
    if (ev.captured) {
      const rec = game.els.get(ev.captured.id);
      if (rec) {
        rec.el.classList.add('dying');
        const dead = rec.el;
        game.els.delete(ev.captured.id);
        setTimeout(() => dead.remove(), 350);
      }
      spawnCaptureFx(ev.to.x, ev.to.y, false);
      addCaptureTrophy(ev.captured);
      sfx.capture();
    } else if (ev.kind === 'move') {
      sfx.move();
    }
    if (ev.kind === 'shield') sfx.join();
    if (ev.spirit) spawnSparks(ev.to.x, ev.to.y, ['#b88af5', '#d8b6ff', '#fff'], 14);
    if (ev.promoted) sfx.promote();
    if (ev.castle) sfx.move();
  }

  const wasCheck = gm?.check && gm?.turn === game.myTeam;
  gm = msg;

  reconcilePieces(msg.pieces);

  // Shields + check visuals
  for (const [id, rec] of game.els) {
    rec.el.classList.toggle('shielded', gm.shields.includes(id));
    rec.el.classList.remove('in-check');
  }
  if (gm.check) {
    const king = gm.pieces.find((p) => p.type === 'king' && p.team === gm.turn);
    if (king) game.els.get(king.id)?.el.classList.add('in-check');
  }
  if (gm.check && gm.turn === game.myTeam && !wasCheck) sfx.check();

  // Last-move highlight
  cells.forEach((c) => c.classList.remove('last-move'));
  if (gm.lastMove) {
    cellAt(gm.lastMove.from.x, gm.lastMove.from.y).classList.add('last-move');
    cellAt(gm.lastMove.to.x, gm.lastMove.to.y).classList.add('last-move');
  }

  // Reset armed power-ups when the turn actually moves on (a shield cast
  // keeps the turn, so Wind/Spirit stay armed through it).
  const turnKey = `${gm.turn}:${gm.mover}:${gm.pending ? 'b' : '-'}`;
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    armed.spirit = false;
    armed.wind = false;
    armed.shieldMode = false;
    clearSelection();
  }

  renderGmPanel();
}

function renderGmPanel() {
  if (!gm || !game) return;

  // Energy bars
  for (const team of [0, 1]) {
    const hud = team === 0 ? $('#hud-left') : $('#hud-right');
    hud.querySelector('.energy-fill').style.width = `${(gm.energy[team] / ENERGY_CAP) * 100}%`;
    hud.querySelector('.energy-num').textContent = `${gm.energy[team]}⚡`;
  }

  // Turn banner
  const banner = $('#turn-banner');
  const myMove = gm.mover === myId;
  const moverP = game.players.find((p) => p.id === gm.mover);
  const moverName = moverP ? `${moverP.isBot ? '🤖 ' : ''}${moverP.name}` : '…';
  const isBonus = !!gm.pending;
  banner.classList.remove('hidden', 'my-turn', 'in-check');
  if (isBonus) {
    banner.textContent = myMove ? '🌀 Bonus move!' : `🌀 ${moverName} has a bonus move…`;
    if (myMove) banner.classList.add('my-turn');
  } else if (myMove) {
    banner.textContent = gm.check ? '⚠️ CHECK — defend your king!' : 'Your move!';
    banner.classList.add(gm.check ? 'in-check' : 'my-turn');
  } else {
    banner.textContent = `${moverName} is thinking…` + (gm.check && gm.turn !== game.myTeam ? ' (in check!)' : '');
  }

  // Power buttons
  const myEnergy = gm.energy[game.myTeam];
  const canAct = myMove && !isBonus && game.playing;
  const btnShield = $('#pw-shield');
  const btnSpirit = $('#pw-spirit');
  const btnWind = $('#pw-wind');
  btnShield.disabled = !canAct || myEnergy < COSTS.shield;
  btnSpirit.disabled = !canAct || myEnergy < COSTS.spirit;
  btnWind.disabled = !canAct || myEnergy < COSTS.wind;
  btnShield.classList.toggle('armed', armed.shieldMode);
  btnSpirit.classList.toggle('armed', armed.spirit);
  btnWind.classList.toggle('armed', armed.wind);

  // Second Wind bonus bar
  $('#bonus-bar').classList.toggle('hidden', !(isBonus && myMove));
}

function highlightGm() {
  cells.forEach((c) => c.classList.remove('sel', 'dot', 'ring', 'sdot'));
  if (!game?.selected || !gm) return;
  const sel = gm.pieces.find((p) => p.id === game.selected);
  if (!sel) return;
  cellAt(sel.x, sel.y).classList.add('sel');

  const st = gmRulesState();
  const g = gmGrid(st);
  let moves;
  if (gm.pending && gm.pending.team === game.myTeam) {
    moves = bonusMovesFor(st, game.myTeam, gm.pending.exclude).filter((m) => m.pieceId === sel.id);
  } else {
    const useSpirit = armed.spirit && gm.energy[game.myTeam] >= COSTS.spirit;
    moves = legalMovesFor(st, sel.id, { spirit: useSpirit });
  }
  for (const m of moves) {
    const cls = m.spirit ? 'sdot' : (g[m.y][m.x] ? 'ring' : 'dot');
    cellAt(m.x, m.y).classList.add(cls);
  }
}

function sendGmMove({ bonus, id, x, y, spirit, promo }) {
  if (bonus) {
    send({ t: 'gbonus', id, x, y, promo });
  } else {
    send({ t: 'gmove', id, x, y, spirit, sw: armed.wind, promo });
  }
  sfx.move();
  clearSelection();
}

function onCellTapGm(vx, vy) {
  if (!gm) return;
  const { x, y } = toModel(vx, vy);
  const st = gmRulesState();
  const g = gmGrid(st);
  const target = g[y][x];

  // Aegis targeting mode
  if (armed.shieldMode) {
    armed.shieldMode = false;
    if (target && target.team === game.myTeam && target.type !== 'king' && !gm.shields.includes(target.id)) {
      send({ t: 'shield', id: target.id });
    }
    renderGmPanel();
    return;
  }

  if (gm.mover !== myId) return;
  const isBonus = gm.pending && gm.pending.team === game.myTeam;

  if (game.selected) {
    const sel = gm.pieces.find((p) => p.id === game.selected);
    if (sel) {
      let mv = null;
      let spirit = false;
      if (isBonus) {
        mv = bonusMovesFor(st, game.myTeam, gm.pending.exclude)
          .find((m) => m.pieceId === sel.id && m.x === x && m.y === y);
      } else {
        mv = legalMovesFor(st, sel.id).find((m) => m.x === x && m.y === y);
        if (!mv && armed.spirit && gm.energy[game.myTeam] >= COSTS.spirit) {
          mv = legalMovesFor(st, sel.id, { spirit: true })
            .find((m) => m.spirit && m.x === x && m.y === y);
          spirit = !!mv;
        }
      }
      if (mv) {
        if (sel.type === 'pawn' && y === promotionRow(game.myTeam)) {
          openPromoPicker({ bonus: isBonus, id: sel.id, x, y, spirit });
        } else {
          sendGmMove({ bonus: isBonus, id: sel.id, x, y, spirit });
        }
        return;
      }
    }
  }

  if (target && target.team === game.myTeam && (!isBonus || target.id !== gm.pending.exclude)) {
    if (game.selected === target.id) {
      clearSelection();
      return;
    }
    clearSelection();
    game.selected = target.id;
    game.els.get(target.id)?.el.classList.add('selected');
    sfx.select();
    highlightGm();
    return;
  }

  clearSelection();
}

// Promotion picker
let pendingPromo = null;
function openPromoPicker(move) {
  pendingPromo = move;
  const box = $('#promo-choices');
  box.innerHTML = '';
  for (const type of ['queen', 'rook', 'bishop', 'knight']) {
    const btn = document.createElement('button');
    btn.innerHTML = pieceSVG(type, game.myTeam);
    btn.addEventListener('click', () => {
      $('#overlay-promo').classList.add('hidden');
      if (pendingPromo) sendGmMove({ ...pendingPromo, promo: type });
      pendingPromo = null;
    });
    box.appendChild(btn);
  }
  $('#overlay-promo').classList.remove('hidden');
}

// Power-up buttons
$('#pw-shield').addEventListener('click', () => {
  armed.shieldMode = !armed.shieldMode;
  if (armed.shieldMode) toast('Pick one of your pieces to shield 🛡');
  sfx.select();
  renderGmPanel();
});

$('#pw-spirit').addEventListener('click', () => {
  armed.spirit = !armed.spirit;
  sfx.select();
  renderGmPanel();
  highlightGm();
});

$('#pw-wind').addEventListener('click', () => {
  armed.wind = !armed.wind;
  if (armed.wind) toast('Second Wind armed — it triggers after your next move 🌀');
  sfx.select();
  renderGmPanel();
});

$('#btn-skip-bonus').addEventListener('click', () => {
  send({ t: 'gbonus', skip: true });
});

$('#btn-resign').addEventListener('click', () => {
  if (window.confirm('Resign the game?')) send({ t: 'resign' });
});

function spawnSparks(x, y, colors, n) {
  const { vx, vy } = toVisual(x, y);
  const cx = (vx + 0.5) * 12.5;
  const cy = (vy + 0.5) * 12.5;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.style.left = `${cx}%`;
    s.style.top = `${cy}%`;
    s.style.background = colors[i % colors.length];
    const ang = Math.random() * Math.PI * 2;
    const dist = 40 * (0.5 + Math.random());
    s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(ang) * dist}px`);
    els.fxLayer.appendChild(s);
    setTimeout(() => s.remove(), 600);
  }
}

// ---------------------------------------------------------------------------
// Game end
// ---------------------------------------------------------------------------

function endGame(msg) {
  inGame = false;
  if (game) game.playing = false;

  if (msg.reason === 'royale' && msg.royale) {
    br.stop();
    const win = msg.royale.winner;
    const mine = win && win.id === myId;
    $('#end-emoji').textContent = mine ? '🏆' : '👑';
    const title = $('#end-title');
    title.textContent = win ? `${win.name} wins!` : 'Nobody survived!';
    title.className = '';
    const myPlace = msg.royale.placements.find((p) => p.id === myId)?.place;
    $('#end-sub').textContent =
      `Last crown standing!${myPlace ? ` You placed #${myPlace} of ${msg.royale.placements.length}.` : ''}`;
    const confetti = $('#confetti');
    confetti.innerHTML = '';
    if (mine) {
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
    return;
  }

  clearSelection();
  $('#bonus-bar').classList.add('hidden');
  $('#overlay-promo').classList.add('hidden');
  pendingPromo = null;

  const draw = msg.winner === -1;
  const won = !draw && msg.winner === game?.myTeam;
  $('#end-emoji').textContent = draw ? '🤝' : won ? '🏆' : '💀';
  const title = $('#end-title');
  title.textContent = draw ? 'It’s a draw!' : `${TEAM_NAMES[msg.winner]} wins!`;
  title.className = draw ? '' : msg.winner === 0 ? 'win-blue' : 'win-red';
  const subs = {
    king: won ? 'You captured the enemy king!' : 'Your king has been captured…',
    forfeit: 'The other team fled the battlefield!',
    checkmate: won ? 'Checkmate! The enemy king is trapped.' : 'Checkmate… your king is trapped.',
    resign: won ? 'The enemy resigned. Victory with honor!' : 'Your team resigned.',
    stalemate: 'Stalemate — no legal moves, nobody wins.',
    repetition: 'Draw by threefold repetition.',
    fifty: 'Draw by the 50-move rule.',
    material: 'Draw — not enough pieces left to checkmate.',
  };
  $('#end-sub').textContent = subs[msg.reason] || '';

  const confetti = $('#confetti');
  confetti.innerHTML = '';
  if (draw) {
    sfx.emote();
  } else if (won) {
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
