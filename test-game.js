// Headless integration test: plays a full 1v1 game against the live server.
// Run: node test-game.js   (server must be running on :3000)

import WebSocket from 'ws';

const URL = `ws://localhost:${process.argv[2] || 3000}`;
let failures = 0;

function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

function client(name) {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    name,
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    open: () => new Promise((res) => ws.on('open', res)),
    next(match = () => true, timeout = 5000) {
      const idx = queue.findIndex(match);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: timed out waiting for message`)), timeout);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    drain: () => queue.splice(0),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = client('Alice');
const b = client('Bob');
await Promise.all([a.open(), b.open()]);

// --- lobby flow ---
a.send({ t: 'create', name: 'Alice' });
const welcomeA = await a.next((m) => m.t === 'welcome');
check(/^[A-Z]{4}$/.test(welcomeA.code), `room code created (${welcomeA.code})`);
await a.next((m) => m.t === 'lobby');

b.send({ t: 'join', code: 'ZZZZ', name: 'Bob' });
const badJoin = await b.next((m) => m.t === 'error');
check(!!badJoin, 'joining a bogus code is rejected');

b.send({ t: 'join', code: welcomeA.code, name: 'Bob' });
const welcomeB = await b.next((m) => m.t === 'welcome');
const lobbyB = await b.next((m) => m.t === 'lobby');
check(lobbyB.players.length === 2, 'both players in lobby');
check(lobbyB.players.find((p) => p.id === welcomeB.id).team === 1, 'Bob auto-balanced to team 1');

// non-host can't change settings
b.send({ t: 'setSpeed', speed: 'frenzy' });
b.send({ t: 'start' });
await sleep(200);
const sneaky = [...a.drain(), ...b.drain()];
check(!sneaky.some((m) => m.t === 'start' || (m.t === 'lobby' && m.speed !== 'classic')),
  'non-host setSpeed/start ignored');

// 2v2 with 2 players must not start
a.send({ t: 'setMode', mode: '2v2' });
await a.next((m) => m.t === 'lobby' && m.mode === '2v2');
await b.next((m) => m.t === 'lobby' && m.mode === '2v2');
a.send({ t: 'start' });
const needMore = await a.next((m) => m.t === 'error');
check(/2 players/.test(needMore.msg), `2v2 start blocked with 2 players ("${needMore.msg}")`);

a.send({ t: 'setMode', mode: '1v1' });
a.send({ t: 'setSpeed', speed: 'frenzy' });
await a.next((m) => m.t === 'lobby' && m.speed === 'frenzy');
await b.next((m) => m.t === 'lobby' && m.speed === 'frenzy');

// --- game start ---
a.send({ t: 'start' });
const startA = await a.next((m) => m.t === 'start');
await b.next((m) => m.t === 'start');
check(startA.pieces.length === 32, 'game starts with 32 pieces');
check(startA.cooldown === 1500, 'frenzy cooldown is 1500ms');

const pieceAt = (pieces, x, y) => pieces.find((p) => p.x === x && p.y === y);
let pieces = startA.pieces;

// moving during countdown is silently ignored
const earlyPawn = pieceAt(pieces, 4, 6);
a.send({ t: 'move', id: earlyPawn.id, x: 4, y: 4 });
await sleep(300);
check(a.drain().filter((m) => m.t === 'move').length === 0, 'moves during countdown ignored');

await sleep(3000); // countdown over

// legal pawn move
a.send({ t: 'move', id: earlyPawn.id, x: 4, y: 4 });
let mv = await a.next((m) => m.t === 'move');
await b.next((m) => m.t === 'move');
check(mv.id === earlyPawn.id && mv.to.x === 4 && mv.to.y === 4, 'pawn double-step works');
pieces = mv.pieces;

// cooldown: same piece immediately again -> reject
a.send({ t: 'move', id: earlyPawn.id, x: 4, y: 3 });
const rej = await a.next((m) => m.t === 'reject');
check(rej.id === earlyPawn.id, 'cooldown move rejected');

// illegal move rejected (rook through own pawn)
const rook = pieceAt(pieces, 0, 7);
a.send({ t: 'move', id: rook.id, x: 0, y: 4 });
check((await a.next((m) => m.t === 'reject')).id === rook.id, 'blocked rook move rejected');

// can't move opponent's piece (silently dropped)
const enemyPawn = pieceAt(pieces, 4, 1);
a.send({ t: 'move', id: enemyPawn.id, x: 4, y: 3 });
await sleep(200);
check(a.drain().filter((m) => m.t === 'move').length === 0, "moving opponent's piece ignored");

// both teams can move simultaneously (no turns)
const bPawn = pieceAt(pieces, 3, 1);
const aPawn2 = pieceAt(pieces, 3, 6);
b.send({ t: 'move', id: bPawn.id, x: 3, y: 3 });
a.send({ t: 'move', id: aPawn2.id, x: 3, y: 4 });
await a.next((m) => m.t === 'move');
mv = await a.next((m) => m.t === 'move');
pieces = mv.pieces;
check(pieceAt(pieces, 3, 3)?.team === 1 && pieceAt(pieces, 3, 4)?.team === 0,
  'both teams moved with no turn order');

await sleep(1600); // cooldowns expire

// capture: Alice's pawn on (4,4) takes Bob's pawn on (3,3)
const aPawn = pieceAt(pieces, 4, 4);
a.send({ t: 'move', id: aPawn.id, x: 3, y: 3 });
mv = await a.next((m) => m.t === 'move' && m.captured);
await b.next((m) => m.t === 'move' && m.captured);
check(mv.captured.type === 'pawn' && mv.captured.team === 1, 'pawn capture works');
check(mv.pieces.length === 31, 'captured piece removed from state');
pieces = mv.pieces;

// march the queen out and capture the enemy king to win
await sleep(1600);
const queen = pieceAt(pieces, 3, 7); // d1

// own pawn now sits on (3,4) - moving onto it must be rejected
a.send({ t: 'move', id: queen.id, x: 3, y: 4 });
check((await a.next((m) => m.t === 'reject')).id === queen.id, 'capturing own piece rejected');

// legal long diagonal d1 -> h5 (3,7)->(7,3): (4,6),(5,5),(6,4) are empty
a.send({ t: 'move', id: queen.id, x: 7, y: 3 });
mv = await a.next((m) => m.t === 'move' && m.id === queen.id);
pieces = mv.pieces;
await sleep(1600);

// (7,3)->(4,0) is blocked by Bob's pawn at (5,1)
a.send({ t: 'move', id: queen.id, x: 4, y: 0 });
check((await a.next((m) => m.t === 'reject')).id === queen.id, 'queen sliding through enemy pawn rejected');

// capture that pawn instead: (7,3)->(5,1) via empty (6,2)
a.send({ t: 'move', id: queen.id, x: 5, y: 1 });
mv = await a.next((m) => m.t === 'move' && m.id === queen.id);
check(mv.captured?.type === 'pawn', 'queen captured pawn next to king');
pieces = mv.pieces;

await sleep(1600);
const king = pieces.find((p) => p.type === 'king' && p.team === 1);
a.send({ t: 'move', id: queen.id, x: king.x, y: king.y });
mv = await a.next((m) => m.t === 'move' && m.captured?.type === 'king');
const endA = await a.next((m) => m.t === 'end');
const endB = await b.next((m) => m.t === 'end');
check(endA.winner === 0 && endB.winner === 0 && endA.reason === 'king', 'king capture ends the game, team 0 wins');

const backToLobby = await a.next((m) => m.t === 'lobby');
check(backToLobby.state === 'lobby', 'room returns to lobby for rematch');

// --- forfeit on disconnect mid-game ---
a.send({ t: 'start' });
await a.next((m) => m.t === 'start');
await b.next((m) => m.t === 'start');
b.ws.close();
const forfeit = await a.next((m) => m.t === 'end');
check(forfeit.winner === 0 && forfeit.reason === 'forfeit', 'disconnect mid-game forfeits to the other team');

a.ws.close();
console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
