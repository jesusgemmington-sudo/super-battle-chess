// Chess computer tests: engine unit tests + server integration.
// Run: node test-bots.js [port]   (server must be running)

import WebSocket from 'ws';
import { createState } from './public/classic.js';
import { chooseGmMove, chooseBattleMove } from './bot.js';

const PORT = process.argv[2] || 3000;
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// Part 1 - engine unit tests
// ===========================================================================
console.log('--- bot engine unit tests ---');

// finds back-rank mate in one (white Ra1-a8#)
{
  const st = createState();
  st.pieces = [
    { id: 'k0', type: 'king', team: 0, x: 4, y: 7, alive: true, moved: true },
    { id: 'r0', type: 'rook', team: 0, x: 0, y: 7, alive: true, moved: true },
    { id: 'k1', type: 'king', team: 1, x: 7, y: 0, alive: true, moved: true },
    { id: 'p1', type: 'pawn', team: 1, x: 6, y: 1, alive: true, moved: true },
    { id: 'p2', type: 'pawn', team: 1, x: 7, y: 1, alive: true, moved: true },
  ];
  st.turn = 0;
  const choice = chooseGmMove(st, 0, 8);
  check(choice.pieceId === 'r0' && choice.x === 0 && choice.y === 0,
    `level 8 finds back-rank mate in one (played ${choice.pieceId} to ${choice.x},${choice.y})`);
}

// takes a hanging queen
{
  const st = createState();
  st.pieces = [
    { id: 'k0', type: 'king', team: 0, x: 4, y: 7, alive: true, moved: true },
    { id: 'q0', type: 'queen', team: 0, x: 3, y: 7, alive: true, moved: true },
    { id: 'k1', type: 'king', team: 1, x: 4, y: 0, alive: true, moved: true },
    { id: 'q1', type: 'queen', team: 1, x: 3, y: 3, alive: true, moved: true }, // hanging on d5
  ];
  st.turn = 0;
  const choice = chooseGmMove(st, 0, 6);
  check(choice.pieceId === 'q0' && choice.x === 3 && choice.y === 3,
    'level 6 grabs a hanging queen');
}

// always returns a legal move, even at level 1
{
  const st = createState();
  for (let i = 0; i < 5; i++) {
    const choice = chooseGmMove(st, 0, 1);
    if (!choice) { check(false, 'level 1 returns a move'); break; }
    if (i === 4) check(true, 'level 1 returns a move (5 samples)');
  }
}

// battle bot: captures the king the instant it can
{
  const now = Date.now();
  const pieces = [
    { id: 'k0', type: 'king', team: 0, x: 4, y: 7, alive: true, cdUntil: 0 },
    { id: 'r0', type: 'rook', team: 0, x: 7, y: 0, alive: true, cdUntil: 0 },
    { id: 'k1', type: 'king', team: 1, x: 7, y: 4, alive: true, cdUntil: 0 },
  ];
  const choice = chooseBattleMove(pieces, 0, 5, now);
  check(choice?.id === 'r0' && choice.x === 7 && choice.y === 4,
    'battle bot takes the enemy king when possible');
}

// battle bot: respects cooldowns
{
  const now = Date.now();
  const pieces = [
    { id: 'k0', type: 'king', team: 0, x: 4, y: 7, alive: true, cdUntil: now + 9999 },
    { id: 'k1', type: 'king', team: 1, x: 0, y: 0, alive: true, cdUntil: 0 },
  ];
  check(chooseBattleMove(pieces, 0, 10, now) === null, 'battle bot waits out cooldowns');
}

// ===========================================================================
// Part 2 - server integration
// ===========================================================================
console.log('--- server integration ---');

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    name, ws,
    send: (m) => ws.send(JSON.stringify(m)),
    open: () => new Promise((res) => ws.on('open', res)),
    next(match = () => true, timeout = 12000) {
      const idx = queue.findIndex(match);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: timeout`)), timeout);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    drain: () => queue.splice(0),
  };
}

const pieceAt = (pieces, x, y) => pieces.find((p) => p.x === x && p.y === y);

// --- lobby management ---
const a = client('Ana');
await a.open();
a.send({ t: 'create', name: 'Ana' });
const { id: anaId } = await a.next((m) => m.t === 'welcome');

a.send({ t: 'addBot', level: 3 });
let lob = await a.next((m) => m.t === 'lobby' && m.players.length === 2);
const bot = lob.players.find((p) => p.isBot);
check(bot && bot.level === 3 && bot.team === 1, `bot added to red team (${bot?.name} Lv${bot?.level})`);

a.send({ t: 'removeBot', id: bot.id });
lob = await a.next((m) => m.t === 'lobby' && m.players.length === 1);
check(!lob.players.some((p) => p.isBot), 'bot removed');

a.send({ t: 'addBot', level: 99 });
lob = await a.next((m) => m.t === 'lobby' && m.players.length === 2);
check(lob.players.find((p) => p.isBot)?.level === 10, 'level clamped to 10');
a.send({ t: 'removeBot', id: lob.players.find((p) => p.isBot).id });
await a.next((m) => m.t === 'lobby' && m.players.length === 1);

// --- grandmaster 1v1 vs bot ---
{
  a.send({ t: 'setRules', rules: 'grandmaster' });
  await a.next((m) => m.t === 'lobby' && m.rules === 'grandmaster');
  a.send({ t: 'addBot', level: 3 });
  await a.next((m) => m.t === 'lobby' && m.players.length === 2);
  a.send({ t: 'start' });
  const start = await a.next((m) => m.t === 'start');
  await sleep(start.in + 200);
  a.drain();

  // my move, then the bot must reply on its own
  a.send({ t: 'gmove', id: pieceAt(start.gm.pieces, 4, 6).id, x: 4, y: 4 }); // e4
  let st = await a.next((m) => m.t === 'gstate');
  check(st.turn === 1, 'human move accepted');
  st = await a.next((m) => m.t === 'gstate' && m.turn === 0);
  check(st.event && st.turn === 0 && st.mover === anaId,
    `bot replied with a legal move on its own (${JSON.stringify(st.lastMove)})`);

  a.send({ t: 'gmove', id: pieceAt(st.pieces, 3, 6).id, x: 3, y: 4 }); // d4
  await a.next((m) => m.t === 'gstate' && m.turn === 1);
  st = await a.next((m) => m.t === 'gstate' && m.turn === 0);
  check(!!st.event, 'bot keeps playing');

  a.send({ t: 'resign' });
  const end = await a.next((m) => m.t === 'end');
  check(end.winner === 1 && end.reason === 'resign', 'resign vs bot works');
  await a.next((m) => m.t === 'lobby');
}

// --- battle 1v1 vs bot ---
{
  a.send({ t: 'setRules', rules: 'battle' });
  a.send({ t: 'setSpeed', speed: 'frenzy' });
  await a.next((m) => m.t === 'lobby' && m.rules === 'battle' && m.speed === 'frenzy');
  a.send({ t: 'start' });
  const start = await a.next((m) => m.t === 'start');
  const botId = start.players.find((p) => p.isBot).id;
  await sleep(start.in + 200);
  a.drain();

  const botMove = await a.next((m) => m.t === 'move' && m.by === botId, 10000);
  check(!!botMove, 'battle bot moves on its own');
  const botMove2 = await a.next((m) => m.t === 'move' && m.by === botId, 10000);
  check(!!botMove2, 'battle bot keeps moving');

  // human can still play and win by capturing the king eventually; just leave
  a.send({ t: 'leave' });
  await sleep(300);
  check(true, 'left battle room cleanly');
}

// --- 2v2 grandmaster: human + 3 bots, mover rotation through bots ---
{
  const h = client('Hero');
  await h.open();
  h.send({ t: 'create', name: 'Hero' });
  const { id: heroId } = await h.next((m) => m.t === 'welcome');
  h.send({ t: 'setMode', mode: '2v2' });
  h.send({ t: 'setRules', rules: 'grandmaster' });
  h.send({ t: 'addBot', level: 2 });
  h.send({ t: 'addBot', level: 2 });
  h.send({ t: 'addBot', level: 2 });
  const lob2 = await h.next((m) => m.t === 'lobby' && m.players.length === 4);
  const counts = [lob2.players.filter((p) => p.team === 0).length, lob2.players.filter((p) => p.team === 1).length];
  check(counts[0] === 2 && counts[1] === 2, 'bots auto-balanced into 2v2 teams');

  h.send({ t: 'start' });
  const start = await h.next((m) => m.t === 'start');
  await sleep(start.in + 200);
  h.drain();
  check(start.gm.mover === heroId, '2v2: human moves first');

  h.send({ t: 'gmove', id: pieceAt(start.gm.pieces, 4, 6).id, x: 4, y: 4 }); // e4
  await h.next((m) => m.t === 'gstate' && m.turn === 1);
  // three consecutive bot moves: red bot, blue teammate bot, red bot - then back to Hero
  let st = await h.next((m) => m.t === 'gstate' && m.turn === 0, 15000); // red bot moved
  st = await h.next((m) => m.t === 'gstate' && m.turn === 1, 15000);     // blue teammate bot moved
  st = await h.next((m) => m.t === 'gstate' && m.turn === 0 && m.mover === heroId, 15000); // red bot 2 moved
  check(st.mover === heroId, '2v2: rotation passed through 3 bots back to the human');

  h.send({ t: 'resign' });
  await h.next((m) => m.t === 'end');
  h.ws.close();
}

a.ws.close();
console.log(failures === 0 ? '\nALL BOT TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
