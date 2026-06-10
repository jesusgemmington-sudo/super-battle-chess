// Royale mode tests: geometry unit tests + live-server integration.
// Run with a FAST-mode server:  SBC_ROYALE_FAST=1 node server.js
//   node test-royale.js <port>

import WebSocket from 'ws';
import { snapDir, inFiringLine, tileRing, isSafe, WORLD } from './royale.js';

const PORT = process.argv[2] || 3000;
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const close = (a, b) => Math.abs(a - b) < 1e-9;

// ===========================================================================
// Part 1 - geometry unit tests
// ===========================================================================
console.log('--- royale geometry unit tests ---');

{
  const d = snapDir(10, 9, 'diag'); // ~42deg -> snaps to 45deg
  check(close(d.x, Math.SQRT1_2) && close(d.y, Math.SQRT1_2), 'bishop shots snap to diagonals');
  const o = snapDir(10, 2, 'ortho'); // ~11deg -> snaps to 0deg
  check(close(o.x, 1) && close(o.y, 0), 'rook shots snap to ranks/files');
  const e = snapDir(-1, -1.05, 'eight');
  check(close(e.x, -Math.SQRT1_2) && close(e.y, -Math.SQRT1_2), 'queen shots snap to 8 directions');
  const f = snapDir(3, 4, null);
  check(close(f.x, 0.6) && close(f.y, 0.8), 'pawn throws fly free-aim');
}

{
  const sniper = { x: 100, y: 100 };
  const onDiag = { x: 400, y: 400 };
  const offDiag = { x: 400, y: 250 };
  check(inFiringLine(sniper, onDiag, 'bishop'), 'CHECK: bishop sees a king on its diagonal');
  check(!inFiringLine(sniper, offDiag, 'bishop'), 'no check off the diagonal');
  const cannon = { x: 100, y: 300 };
  check(inFiringLine(cannon, { x: 500, y: 300 }, 'rook'), 'CHECK: rook sees along the rank');
  check(!inFiringLine(cannon, { x: 500, y: 410 }, 'rook'), 'no check off the rank');
  check(!inFiringLine(sniper, { x: 7000, y: 7000 }, 'bishop'), 'no check out of range');
}

{
  check(tileRing(0, 3) === 0 && tileRing(3, 3) === 3 && tileRing(7, 7) === 0, 'tile rings computed');
  check(isSafe(50, 50, 0) && !isSafe(50, 50, 1), 'outer ring becomes unsafe after one shrink');
  check(isSafe(WORLD / 2, WORLD / 2, 3), 'center stays safe to the end');
}

// ===========================================================================
// Part 2 - server integration (server must run with SBC_ROYALE_FAST=1)
// ===========================================================================
console.log('--- server integration (fast mode) ---');

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
    else {
      queue.push(msg);
      if (queue.length > 400) queue.shift();
    }
  });
  return {
    name, ws,
    send: (m) => ws.send(JSON.stringify(m)),
    open: () => new Promise((res) => ws.on('open', res)),
    next(match = () => true, timeout = 10000) {
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

const a = client('Ace');
const b = client('Bee');
await Promise.all([a.open(), b.open()]);

a.send({ t: 'create', name: 'Ace' });
const { code, id: aceId } = await a.next((m) => m.t === 'welcome');
a.send({ t: 'setRules', rules: 'royale' });
await a.next((m) => m.t === 'lobby' && m.rules === 'royale');

// solo start blocked
a.send({ t: 'start' });
const soloErr = await a.next((m) => m.t === 'error');
check(/2 players/.test(soloErr.msg), `solo royale blocked ("${soloErr.msg}")`);

b.send({ t: 'join', code, name: 'Bee' });
const { id: beeId } = await b.next((m) => m.t === 'welcome');
await a.next((m) => m.t === 'lobby' && m.players.length === 2);

a.send({ t: 'start' });
const start = await a.next((m) => m.t === 'start');
await b.next((m) => m.t === 'start');
check(start.rules === 'royale' && start.royale.players.length === 2 && start.royale.items.length === 11,
  'royale starts with 2 kings and 11 scattered pieces');

await sleep(start.in + 300);
a.drain(); b.drain();

// snapshots flow
const snap1 = await a.next((m) => m.t === 'bs');
check(snap1.players.length === 2 && snap1.items.length > 0, 'snapshots stream with players and items');
const aceStart = snap1.players.find((p) => p.id === aceId);

// movement
a.send({ t: 'bi', mx: 1, my: 0, ax: 700, ay: aceStart.y });
await sleep(700);
a.drain(); // discard buffered snapshots; read a fresh one
const snap2 = (await a.next((m) => m.t === 'bs'));
const aceNow = snap2.players.find((p) => p.id === aceId);
check(aceNow.x > aceStart.x + 60, `movement applied (${aceStart.x} -> ${aceNow.x})`);
a.send({ t: 'bi', mx: 0, my: 0, ax: 700, ay: aceStart.y });

// melee swing event
a.send({ t: 'ba' });
const swingSnap = await a.next((m) => m.t === 'bs' && m.events.some((e) => e.k === 'swing' && e.id === aceId));
check(!!swingSnap, 'royal fists swing produces an event');

// walk to the nearest item and auto-pickup
{
  let latest = swingSnap;
  const deadline = Date.now() + 20000;
  let armed = null;
  while (Date.now() < deadline && !armed) {
    const me = latest.players.find((p) => p.id === aceId);
    if (me.weapon || me.mounted) { armed = me; break; }
    let best = null, bd = Infinity;
    for (const it of latest.items.filter((i) => i.ready && i.type !== 'crown')) {
      const d = Math.hypot(it.x - me.x, it.y - me.y);
      if (d < bd) { bd = d; best = it; }
    }
    if (best) {
      const len = Math.hypot(best.x - me.x, best.y - me.y) || 1;
      a.send({ t: 'bi', mx: (best.x - me.x) / len, my: (best.y - me.y) / len, ax: best.x, ay: best.y });
      if (len < 45) a.send({ t: 'bp' });
    }
    latest = await a.next((m) => m.t === 'bs');
  }
  a.send({ t: 'bi', mx: 0, my: 0, ax: 400, ay: 400 });
  check(!!armed, `picked up a piece (${armed?.weapon || (armed?.mounted && 'knight')})`);

  // attacking with the piece produces a shoot or dash event
  a.send({ t: 'ba' });
  const atk = await a.next((m) => m.t === 'bs' &&
    m.events.some((e) => (e.k === 'shoot' || e.k === 'dash') && e.id === aceId), 5000);
  check(!!atk, 'armed attack fires a projectile or dash');
}

// zone shrink happens (fast mode: ~6s)
const fall = await a.next((m) => m.t === 'bs' && m.fallen >= 1, 15000);
check(fall.fallen >= 1, 'outer board ring fell away');

// leaving mid-match hands the win to the survivor
b.send({ t: 'leave' });
const end1 = await a.next((m) => m.t === 'end');
check(end1.reason === 'royale' && end1.royale.winner?.id === aceId &&
  end1.royale.placements.length === 2 && end1.royale.placements[0].place === 1,
  'last crown standing wins with placements');
await a.next((m) => m.t === 'lobby');

// --- full match vs a bot: the bot should win against an idle human ---
{
  a.send({ t: 'addBot', level: 10 });
  await a.next((m) => m.t === 'lobby' && m.players.length === 2);
  a.send({ t: 'start' });
  const s2 = await a.next((m) => m.t === 'start');
  check(s2.rules === 'royale', 'royale vs bot starts');
  const end2 = await a.next((m) => m.t === 'end', 90000);
  const botWon = end2.royale?.winner && end2.royale.winner.id !== aceId;
  check(end2.reason === 'royale' && botWon, `lv10 bot hunted down an idle king (winner: ${end2.royale?.winner?.name})`);
}

a.ws.close();
b.ws.close();
console.log(failures === 0 ? '\nALL ROYALE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
