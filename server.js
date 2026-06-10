// Super Battle Chess - game server.
// Serves the static client and runs the authoritative real-time game logic
// over WebSockets. No turns: any piece may move when it's off cooldown.
// Capture the enemy king to win.

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createPieces, buildGrid, isLegalMove, promotionRow } from './public/rules.js';
import {
  COSTS, createState, findPiece, legalMovesFor, bonusMovesFor,
  applyMoveRaw, endTurn, inCheck,
} from './public/classic.js';
import { BOT_NAMES, chooseGmMove, chooseBattleMove, battleReactionMs } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;

const COUNTDOWN_MS = 3000;
const EMOTE_COOLDOWN_MS = 1200;
const SPEEDS = { chill: 4500, classic: 3000, frenzy: 1500 };
const MODES = { '1v1': 1, '2v2': 2 }; // players per team

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Rooms and players
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> room

let nextPlayerId = 1;

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function createRoom() {
  const code = makeRoomCode();
  if (!code) return null;
  const room = {
    code,
    mode: '1v1',
    rules: 'battle', // battle (real-time) | grandmaster (turn-based + power-ups)
    speed: 'classic',
    hostId: null,
    state: 'lobby', // lobby | countdown | playing
    players: new Map(), // id -> player
    pieces: null,
    game: null, // grandmaster game: { state, moverIdx, lastMove }
    startsAt: 0,
    countdownTimer: null,
    botTimer: null,
    botInterval: null,
  };
  rooms.set(code, room);
  return room;
}

function send(player, msg) {
  if (player.ws && player.ws.readyState === player.ws.OPEN) {
    player.ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}

function lobbySnapshot(room) {
  return {
    t: 'lobby',
    code: room.code,
    mode: room.mode,
    rules: room.rules,
    speed: room.speed,
    hostId: room.hostId,
    state: room.state,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, isBot: !!p.isBot, level: p.level,
    })),
  };
}

function broadcastLobby(room) {
  broadcast(room, lobbySnapshot(room));
}

function teamCounts(room) {
  const counts = [0, 0];
  for (const p of room.players.values()) counts[p.team]++;
  return counts;
}

function cleanName(raw) {
  const name = String(raw || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 14);
  return name || 'Player';
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function serializePieces(room) {
  const now = Date.now();
  return room.pieces
    .filter((p) => p.alive)
    .map((p) => ({
      id: p.id,
      type: p.type,
      team: p.team,
      x: p.x,
      y: p.y,
      cd: Math.max(0, p.cdUntil - now),
    }));
}

function startGame(room) {
  const counts = teamCounts(room);
  const perTeam = MODES[room.mode];
  if (room.players.size !== perTeam * 2 || counts[0] !== perTeam || counts[1] !== perTeam) {
    return `${room.mode} needs ${perTeam} player${perTeam > 1 ? 's' : ''} on each team`;
  }
  room.state = 'countdown';
  room.startsAt = Date.now() + COUNTDOWN_MS;
  const startMsg = {
    t: 'start',
    mode: room.mode,
    rules: room.rules,
    speed: room.speed,
    cooldown: SPEEDS[room.speed],
    in: COUNTDOWN_MS,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, isBot: !!p.isBot, level: p.level,
    })),
  };
  if (room.rules === 'grandmaster') {
    room.game = { state: createState(), moverIdx: [0, 0], lastMove: null };
    room.pieces = null;
    startMsg.gm = gmPayload(room);
    startMsg.pieces = startMsg.gm.pieces;
  } else {
    room.pieces = createPieces().map((p) => ({ ...p, cdUntil: 0 }));
    room.game = null;
    startMsg.pieces = serializePieces(room);
  }
  broadcast(room, startMsg);
  room.countdownTimer = setTimeout(() => {
    if (room.state === 'countdown') room.state = 'playing';
  }, COUNTDOWN_MS);
  if (room.rules === 'grandmaster') maybeBotMove(room);
  else startBattleBots(room);
  return null;
}

function endGame(room, winner, reason) {
  if (room.state !== 'playing' && room.state !== 'countdown') return;
  clearTimeout(room.countdownTimer);
  clearTimeout(room.botTimer);
  clearInterval(room.botInterval);
  room.botInterval = null;
  for (const p of room.players.values()) if (p.isBot) p.nextActAt = 0;
  room.state = 'lobby';
  room.pieces = null;
  room.game = null;
  broadcast(room, { t: 'end', winner, reason });
  broadcastLobby(room);
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

let nextBotId = 1;

function addBot(room, level) {
  const counts = teamCounts(room);
  const bot = {
    id: 'bot' + nextBotId++,
    name: BOT_NAMES[level - 1],
    team: counts[0] <= counts[1] ? 0 : 1,
    ws: null,
    isBot: true,
    level,
    lastEmote: 0,
    nextActAt: 0,
    room,
  };
  room.players.set(bot.id, bot);
  return bot;
}

// Grandmaster: when the current mover is a bot, think then move.
function maybeBotMove(room) {
  if (!room.game || (room.state !== 'playing' && room.state !== 'countdown')) return;
  if (room.game.state.result) return;
  const mover = room.players.get(currentMover(room));
  if (!mover?.isBot) return;
  clearTimeout(room.botTimer);
  const gameRef = room.game;
  const waitForGo = Math.max(0, room.startsAt - Date.now());
  const delay = waitForGo + 600 + Math.random() * 700;
  room.botTimer = setTimeout(() => {
    if (room.game !== gameRef || room.state !== 'playing') return;
    if (room.players.get(currentMover(room)) !== mover) return;
    const choice = chooseGmMove(room.game.state, mover.team, mover.level);
    if (!choice) return; // no moves: endTurn already declared the result
    handleGmMove(room, mover, { id: choice.pieceId, x: choice.x, y: choice.y, promo: 'queen' });
  }, delay);
}

// Battle: bots act on their own reaction timers.
function startBattleBots(room) {
  if (![...room.players.values()].some((p) => p.isBot)) return;
  room.botInterval = setInterval(() => {
    if (room.state !== 'playing' || !room.pieces) return;
    const now = Date.now();
    for (const p of room.players.values()) {
      if (!p.isBot) continue;
      if (!p.nextActAt) {
        p.nextActAt = room.startsAt + 400 + Math.random() * battleReactionMs(p.level);
        continue;
      }
      if (now < p.nextActAt) continue;
      const move = chooseBattleMove(room.pieces, p.team, p.level, now);
      if (move) handleMove(room, p, move);
      p.nextActAt = now + battleReactionMs(p.level) * (0.75 + Math.random() * 0.5);
    }
  }, 250);
}

// ---------------------------------------------------------------------------
// Grandmaster mode (turn-based classic chess + power-ups)
// ---------------------------------------------------------------------------

function teamPlayers(room, team) {
  return [...room.players.values()].filter((p) => p.team === team);
}

// In 2v2, teammates alternate making the team's moves.
function currentMover(room) {
  const st = room.game.state;
  const team = st.pending ? st.pending.team : st.turn;
  const list = teamPlayers(room, team);
  if (list.length === 0) return null;
  return list[room.game.moverIdx[team] % list.length].id;
}

function gmPayload(room, event = null) {
  const st = room.game.state;
  return {
    t: 'gstate',
    pieces: st.pieces
      .filter((p) => p.alive)
      .map((p) => ({ id: p.id, type: p.type, team: p.team, x: p.x, y: p.y, moved: p.moved })),
    turn: st.turn,
    ep: st.ep,
    energy: st.energy,
    shields: Object.keys(st.shields),
    pending: st.pending,
    mover: currentMover(room),
    check: inCheck(st, st.turn),
    lastMove: room.game.lastMove,
    event,
  };
}

function finishGmTurn(room, event) {
  const st = room.game.state;
  const movedTeam = st.turn;
  const result = endTurn(st);
  room.game.moverIdx[movedTeam]++;
  broadcast(room, gmPayload(room, event));
  if (result) {
    endGame(room, result.winner, result.reason);
  } else {
    maybeBotMove(room);
  }
}

function gmGuard(room, player) {
  if (!room || room.rules !== 'grandmaster' || room.state !== 'playing' || !room.game) return false;
  if (Date.now() < room.startsAt) return false;
  if (player.id !== currentMover(room)) return false;
  return true;
}

function handleGmMove(room, player, msg) {
  if (!gmGuard(room, player)) return;
  const st = room.game.state;
  if (st.pending) return;

  const piece = findPiece(st, msg.id);
  const x = Number(msg.x);
  const y = Number(msg.y);
  if (!piece || !piece.alive || piece.team !== player.team || piece.team !== st.turn) return;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;

  // Prefer a normal move; fall back to a Knight's Spirit jump if requested.
  let mv = legalMovesFor(st, piece.id).find((m) => m.x === x && m.y === y);
  let usedSpirit = false;
  if (!mv && msg.spirit && st.energy[piece.team] >= COSTS.spirit) {
    mv = legalMovesFor(st, piece.id, { spirit: true })
      .find((m) => m.spirit && m.x === x && m.y === y);
    usedSpirit = !!mv;
  }
  if (!mv) {
    send(player, { t: 'reject', id: piece.id });
    return;
  }

  const wantWind = !!msg.sw &&
    st.energy[piece.team] - (usedSpirit ? COSTS.spirit : 0) >= COSTS.wind;

  if (usedSpirit) st.energy[piece.team] -= COSTS.spirit;
  if (wantWind) st.energy[piece.team] -= COSTS.wind;

  const from = { x: piece.x, y: piece.y };
  const { captured, promoted } = applyMoveRaw(st, piece.id, mv, msg.promo);
  room.game.lastMove = { from, to: { x, y } };

  const event = {
    kind: captured ? 'capture' : 'move',
    id: piece.id,
    from,
    to: { x, y },
    captured: captured ? { id: captured.id, type: captured.type, team: captured.team } : null,
    castle: mv.castle || null,
    enPassant: !!mv.ep,
    spirit: usedSpirit,
    promoted,
  };

  // Second Wind: bonus move owed, unless the first move gave check
  // (or no legal bonus move exists).
  if (wantWind && !inCheck(st, 1 - st.turn) &&
      bonusMovesFor(st, st.turn, piece.id).length > 0) {
    st.pending = { team: st.turn, exclude: piece.id };
    broadcast(room, gmPayload(room, event));
    return;
  }

  finishGmTurn(room, event);
}

function handleGmBonus(room, player, msg) {
  if (!gmGuard(room, player)) return;
  const st = room.game.state;
  if (!st.pending || st.pending.team !== player.team) return;

  if (msg.skip) {
    finishGmTurn(room, { kind: 'windskip' });
    return;
  }

  const x = Number(msg.x);
  const y = Number(msg.y);
  const mv = bonusMovesFor(st, st.pending.team, st.pending.exclude)
    .find((m) => m.pieceId === msg.id && m.x === x && m.y === y);
  if (!mv) {
    send(player, { t: 'reject', id: msg.id });
    return;
  }
  const piece = findPiece(st, msg.id);
  const from = { x: piece.x, y: piece.y };
  const { promoted } = applyMoveRaw(st, msg.id, mv, msg.promo);
  room.game.lastMove = { from, to: { x, y } };
  finishGmTurn(room, {
    kind: 'move', id: msg.id, from, to: { x, y },
    captured: null, castle: mv.castle || null, enPassant: false,
    spirit: false, promoted, wind: true,
  });
}

function handleGmShield(room, player, msg) {
  if (!gmGuard(room, player)) return;
  const st = room.game.state;
  if (st.pending) return;
  const piece = findPiece(st, msg.id);
  if (!piece || !piece.alive || piece.team !== player.team || piece.team !== st.turn) return;
  if (piece.type === 'king' || st.shields[piece.id]) return;
  if (st.energy[piece.team] < COSTS.shield) return;
  st.energy[piece.team] -= COSTS.shield;
  st.shields[piece.id] = true;
  broadcast(room, gmPayload(room, { kind: 'shield', id: piece.id }));
}

function handleGmResign(room, player) {
  if (!room || room.rules !== 'grandmaster') return;
  if (room.state !== 'playing' && room.state !== 'countdown') return;
  endGame(room, player.team === 0 ? 1 : 0, 'resign');
}

function handleMove(room, player, msg) {
  if (room.state !== 'playing') return;
  if (Date.now() < room.startsAt) return;

  const piece = room.pieces.find((p) => p.id === msg.id);
  const x = Number(msg.x);
  const y = Number(msg.y);
  if (!piece || !piece.alive || piece.team !== player.team) return;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;

  const now = Date.now();
  if (piece.cdUntil > now) {
    send(player, { t: 'reject', id: piece.id });
    return;
  }

  const grid = buildGrid(room.pieces);
  if (!isLegalMove(grid, piece, x, y)) {
    send(player, { t: 'reject', id: piece.id });
    return;
  }

  const target = grid[y][x];
  const from = { x: piece.x, y: piece.y };
  if (target) target.alive = false;
  piece.x = x;
  piece.y = y;
  piece.cdUntil = now + SPEEDS[room.speed];

  let promoted = false;
  if (piece.type === 'pawn' && y === promotionRow(piece.team)) {
    piece.type = 'queen';
    promoted = true;
  }

  broadcast(room, {
    t: 'move',
    id: piece.id,
    from,
    to: { x, y },
    by: player.id,
    captured: target ? { id: target.id, type: target.type, team: target.team } : null,
    promoted,
    pieces: serializePieces(room),
  });

  if (target && target.type === 'king') {
    endGame(room, piece.team, 'king');
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleMessage(player, msg) {
  const room = player.room;

  switch (msg.t) {
    case 'create': {
      if (room) return;
      const newRoom = createRoom();
      if (!newRoom) {
        send(player, { t: 'error', msg: 'Server is full, try again later.' });
        return;
      }
      player.name = cleanName(msg.name);
      player.team = 0;
      player.room = newRoom;
      newRoom.hostId = player.id;
      newRoom.players.set(player.id, player);
      send(player, { t: 'welcome', id: player.id, code: newRoom.code });
      broadcastLobby(newRoom);
      break;
    }

    case 'join': {
      if (room) return;
      const code = String(msg.code || '').toUpperCase().trim();
      const target = rooms.get(code);
      if (!target) {
        send(player, { t: 'error', msg: `Room ${code || '?'} doesn't exist.` });
        return;
      }
      if (target.state !== 'lobby') {
        send(player, { t: 'error', msg: 'That game is already in progress.' });
        return;
      }
      if (target.players.size >= 4) {
        send(player, { t: 'error', msg: 'That room is full.' });
        return;
      }
      player.name = cleanName(msg.name);
      const counts = teamCounts(target);
      player.team = counts[0] <= counts[1] ? 0 : 1;
      player.room = target;
      target.players.set(player.id, player);
      send(player, { t: 'welcome', id: player.id, code: target.code });
      broadcastLobby(target);
      break;
    }

    case 'setMode': {
      if (!room || room.state !== 'lobby' || player.id !== room.hostId) return;
      if (!MODES[msg.mode]) return;
      room.mode = msg.mode;
      broadcastLobby(room);
      break;
    }

    case 'setSpeed': {
      if (!room || room.state !== 'lobby' || player.id !== room.hostId) return;
      if (!SPEEDS[msg.speed]) return;
      room.speed = msg.speed;
      broadcastLobby(room);
      break;
    }

    case 'setRules': {
      if (!room || room.state !== 'lobby' || player.id !== room.hostId) return;
      if (msg.rules !== 'battle' && msg.rules !== 'grandmaster') return;
      room.rules = msg.rules;
      broadcastLobby(room);
      break;
    }

    case 'addBot': {
      if (!room || room.state !== 'lobby' || player.id !== room.hostId) return;
      if (room.players.size >= 4) {
        send(player, { t: 'error', msg: 'The room is full.' });
        return;
      }
      const level = Math.min(10, Math.max(1, Math.floor(Number(msg.level)) || 5));
      addBot(room, level);
      broadcastLobby(room);
      break;
    }

    case 'removeBot': {
      if (!room || room.state !== 'lobby' || player.id !== room.hostId) return;
      const bot = room.players.get(msg.id);
      if (bot?.isBot) {
        room.players.delete(bot.id);
        broadcastLobby(room);
      }
      break;
    }

    case 'setTeam': {
      if (!room || room.state !== 'lobby') return;
      const team = msg.team === 1 ? 1 : 0;
      player.team = team;
      broadcastLobby(room);
      break;
    }

    case 'start': {
      if (!room || room.state !== 'lobby' || player.id !== room.hostId) return;
      const err = startGame(room);
      if (err) send(player, { t: 'error', msg: err });
      break;
    }

    case 'move': {
      if (room && room.rules === 'battle') handleMove(room, player, msg);
      break;
    }

    case 'gmove': {
      if (room) handleGmMove(room, player, msg);
      break;
    }

    case 'gbonus': {
      if (room) handleGmBonus(room, player, msg);
      break;
    }

    case 'shield': {
      if (room) handleGmShield(room, player, msg);
      break;
    }

    case 'resign': {
      if (room) handleGmResign(room, player);
      break;
    }

    case 'emote': {
      if (!room) return;
      const now = Date.now();
      if (now - player.lastEmote < EMOTE_COOLDOWN_MS) return;
      const e = Number(msg.e);
      if (!Number.isInteger(e) || e < 0 || e > 11) return;
      player.lastEmote = now;
      broadcast(room, { t: 'emote', from: player.id, name: player.name, team: player.team, e });
      break;
    }

    case 'leave': {
      if (room) removeFromRoom(player);
      break;
    }
  }
}

function removeFromRoom(player) {
  const room = player.room;
  if (!room) return;
  player.room = null;
  room.players.delete(player.id);

  const humans = [...room.players.values()].filter((p) => !p.isBot);
  if (humans.length === 0) {
    clearTimeout(room.countdownTimer);
    clearTimeout(room.botTimer);
    clearInterval(room.botInterval);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === player.id) {
    room.hostId = humans[0].id;
  }

  if (room.state === 'playing' || room.state === 'countdown') {
    const counts = teamCounts(room);
    if (counts[player.team] === 0) {
      endGame(room, player.team === 0 ? 1 : 0, 'forfeit');
      return;
    }
    broadcast(room, { t: 'playerLeft', name: player.name });
    if (room.game) {
      broadcast(room, gmPayload(room)); // mover may have changed
      maybeBotMove(room);
    }
  }
  broadcastLobby(room);
}

// ---------------------------------------------------------------------------
// WebSocket wiring
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const player = {
    id: 'u' + nextPlayerId++,
    name: 'Player',
    team: 0,
    room: null,
    lastEmote: 0,
    ws,
  };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    try {
      handleMessage(player, msg);
    } catch (err) {
      console.error('message error:', err);
    }
  });
  ws.on('close', () => removeFromRoom(player));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ---------------------------------------------------------------------------

function onListenError(err) {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  Port ${PORT} is already in use — Super Battle Chess is probably already running.`);
    console.log(`  Just open http://localhost:${PORT} to play.`);
    console.log('');
    console.log(`  (To run a second server anyway, set a different port: set PORT=3001 && node server.js)`);
    process.exit(1);
  }
  throw err;
}
httpServer.on('error', onListenError);
wss.on('error', onListenError);

httpServer.listen(PORT, () => {
  console.log('');
  console.log('  ♟  SUPER BATTLE CHESS server is running!');
  console.log('');
  console.log(`  Play here:        http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  Friends on LAN:   http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
  console.log('  Create a room, share the 4-letter code, battle!');
  console.log('');
});
