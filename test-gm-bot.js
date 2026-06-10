// Grandmaster-mode bot: joins a room and, whenever it is the mover, plays the
// first legal move (deterministic). Casts a shield once it can afford one, so
// the shield visuals can be seen from the other side.
// Usage: node test-gm-bot.js <port> <CODE>

import WebSocket from 'ws';
import { COSTS, legalMovesFor } from './public/classic.js';

const [, , port, code] = process.argv;
const ws = new WebSocket(`ws://localhost:${port}`);
let myId = null;
let myTeam = 1;
let shieldCast = false;
let started = false;

ws.on('open', () => ws.send(JSON.stringify({ t: 'join', code, name: 'DeepBlueprint' })));

function rulesState(msg) {
  return {
    pieces: msg.pieces.map((p) => ({ ...p, alive: true })),
    turn: msg.turn,
    ep: msg.ep,
    halfmove: 0,
    energy: [...msg.energy],
    shields: Object.fromEntries(msg.shields.map((id) => [id, true])),
    pending: null,
    history: {},
    result: null,
  };
}

function act(msg) {
  if (msg.mover !== myId) return;
  const st = rulesState(msg);

  if (msg.pending) {
    ws.send(JSON.stringify({ t: 'gbonus', skip: true }));
    return;
  }

  if (!shieldCast && msg.energy[myTeam] >= COSTS.shield) {
    const target = msg.pieces.find((p) => p.team === myTeam && p.type === 'pawn');
    if (target) {
      shieldCast = true;
      ws.send(JSON.stringify({ t: 'shield', id: target.id }));
      // server keeps the turn; the follow-up gstate triggers the move
      return;
    }
  }

  for (const p of msg.pieces) {
    if (p.team !== myTeam) continue;
    const moves = legalMovesFor(st, p.id);
    if (moves.length > 0) {
      const mv = moves[0];
      ws.send(JSON.stringify({ t: 'gmove', id: p.id, x: mv.x, y: mv.y }));
      return;
    }
  }
}

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.t === 'welcome') myId = msg.id;
  if (msg.t === 'lobby') {
    myTeam = msg.players.find((p) => p.id === myId)?.team ?? 1;
  }
  if (msg.t === 'start') {
    started = true;
    console.log('game started, playing as team', myTeam);
    setTimeout(() => act(msg.gm), msg.in + 600);
  }
  if (msg.t === 'gstate') {
    if (started) setTimeout(() => act(msg), 700); // small thinking delay
  }
  if (msg.t === 'end') console.log('game over:', msg.winner, msg.reason);
});

setTimeout(() => process.exit(0), 240000);
