// Grandmaster mode tests: engine unit tests + server integration.
// Run: node test-grandmaster.js [port]   (server must be running)

import WebSocket from 'ws';
import {
  COSTS, createState, legalMovesFor, bonusMovesFor, applyMoveRaw, endTurn,
  inCheck, hasAnyAction, findPiece,
} from './public/classic.js';

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
console.log('--- engine unit tests ---');

function at(state, x, y) {
  return state.pieces.find((p) => p.alive && p.x === x && p.y === y);
}

function move(state, fromX, fromY, toX, toY, { promo, spirit } = {}) {
  const p = at(state, fromX, fromY);
  const mv = legalMovesFor(state, p.id, { spirit: !!spirit }).find((m) => m.x === toX && m.y === toY);
  if (!mv) throw new Error(`illegal test move ${fromX},${fromY} -> ${toX},${toY}`);
  applyMoveRaw(state, p.id, mv, promo);
  return endTurn(state);
}

// 20 legal opening moves
{
  const st = createState();
  let count = 0;
  for (const p of st.pieces.filter((q) => q.team === 0)) count += legalMovesFor(st, p.id).length;
  check(count === 20, `20 legal opening moves (got ${count})`);
}

// fool's mate -> checkmate detection
{
  const st = createState();
  move(st, 5, 6, 5, 5);      // f3
  move(st, 4, 1, 4, 3);      // e5
  move(st, 6, 6, 6, 4);      // g4
  const result = move(st, 3, 0, 7, 4); // Qh4#
  check(result?.reason === 'checkmate' && result.winner === 1, "fool's mate detected as checkmate");
}

// pinned piece cannot move
{
  const st = createState();
  move(st, 4, 6, 4, 4);      // e4
  move(st, 4, 1, 4, 3);      // e5
  move(st, 3, 6, 3, 5);      // d3
  move(st, 3, 0, 7, 4);      // Qh4 (eyeing e1)
  // white knight g1 is NOT pinned, but pawn f2 IS (Qh4-e1 diagonal goes through f2... via g3)
  // The f2 pawn at (5,6): moving it to f3 opens Qh4xe1? No - Qh4 attacks e1 through g3,f2.
  const f2 = at(st, 5, 6);
  const f2Moves = legalMovesFor(st, f2.id);
  check(f2Moves.length === 0, 'pinned f2 pawn has no legal moves while Qh4 eyes e1');
}

// castling
{
  const st = createState();
  move(st, 4, 6, 4, 4);      // e4
  move(st, 0, 1, 0, 2);      // a6
  move(st, 6, 7, 5, 5);      // Nf3
  move(st, 1, 1, 1, 2);      // b6
  move(st, 5, 7, 2, 4);      // Bc4
  move(st, 2, 1, 2, 2);      // c6
  const king = at(st, 4, 7);
  const castles = legalMovesFor(st, king.id).filter((m) => m.castle);
  check(castles.length === 1 && castles[0].x === 6, 'kingside castle available');
  move(st, 4, 7, 6, 7);      // O-O
  check(at(st, 5, 7)?.type === 'rook' && at(st, 6, 7)?.type === 'king', 'castle moves king and rook');
}

// en passant
{
  const st = createState();
  move(st, 4, 6, 4, 4);      // e4
  move(st, 0, 1, 0, 2);      // a6
  move(st, 4, 4, 4, 3);      // e5
  move(st, 3, 1, 3, 3);      // d5 (double)
  const eMoves = legalMovesFor(st, at(st, 4, 3).id);
  const ep = eMoves.find((m) => m.ep);
  check(!!ep && ep.x === 3 && ep.y === 2, 'en passant offered');
  move(st, 4, 3, 3, 2);      // exd6 e.p.
  check(!at(st, 3, 3), 'en passant removes the passed pawn');
}

// stalemate detection (black Ka8, white Qb6 + Kh1, black to move)
{
  const st = createState();
  st.pieces = [
    { id: 'k0', type: 'king', team: 0, x: 7, y: 7, alive: true, moved: true },
    { id: 'q0', type: 'queen', team: 0, x: 1, y: 2, alive: true, moved: true },
    { id: 'k1', type: 'king', team: 1, x: 0, y: 0, alive: true, moved: true },
  ];
  st.turn = 1;
  check(!inCheck(st, 1) && !hasAnyAction(st, 1), 'stalemate position: no check, no moves');
}

// shield blocks captures and expires correctly
{
  const st = createState();
  move(st, 4, 6, 4, 4);      // e4
  move(st, 3, 1, 3, 3);      // d5 -> e4 pawn could take d5
  const d5 = at(st, 3, 3);
  st.shields[d5.id] = true;  // black shields d5 (cast during black's turn)
  const e4Moves = legalMovesFor(st, at(st, 4, 4).id);
  check(!e4Moves.some((m) => m.x === 3 && m.y === 3), 'shielded pawn cannot be captured');
  // White plays something else; the turn flips back to black (the shield's
  // owner), which is exactly when the shield expires.
  move(st, 0, 6, 0, 5);
  check(!st.shields[d5.id], "shield expired when owner's turn began");
  const e4Moves2 = legalMovesFor(st, at(st, 4, 4).id);
  check(e4Moves2.some((m) => m.x === 3 && m.y === 3), 'capture available again after shield expiry');
}

// spirit moves: knight jumps, never capture kings, and rescue from "mate"
{
  const st = createState();
  st.pieces = [
    { id: 'k0', type: 'king', team: 0, x: 0, y: 7, alive: true, moved: true },
    { id: 'r0', type: 'rook', team: 0, x: 0, y: 0, alive: true, moved: true },
    { id: 'k1', type: 'king', team: 1, x: 7, y: 0, alive: true, moved: true },
    { id: 'p1', type: 'pawn', team: 1, x: 6, y: 1, alive: true, moved: true },
    { id: 'p2', type: 'pawn', team: 1, x: 7, y: 1, alive: true, moved: true },
  ];
  st.turn = 1;
  check(inCheck(st, 1), 'back-rank check from rook');
  st.energy = [0, 0];
  check(!hasAnyAction(st, 1), 'checkmate without energy');
  st.energy = [0, COSTS.spirit];
  check(hasAnyAction(st, 1), 'Knight\'s Spirit escape makes it NOT checkmate (pawn jump blocks)');
  const jumps = legalMovesFor(st, 'p1', { spirit: true }).filter((m) => m.spirit);
  check(jumps.some((m) => m.x === 4 && m.y === 0), 'spirit pawn can jump to block the check');
  check(!legalMovesFor(st, 'r0', { spirit: true }).some((m) => m.x === 7 && m.y === 0),
    'spirit moves can never capture a king');
}

// second wind bonus moves: no captures, no checks
{
  const st = createState();
  move(st, 4, 6, 4, 4);      // e4
  move(st, 3, 1, 3, 3);      // d5
  const bonus = bonusMovesFor(st, 0, 'none');
  const grid = {};
  for (const p of st.pieces.filter((p) => p.alive)) grid[`${p.x},${p.y}`] = true;
  check(bonus.length > 0, 'bonus moves exist');
  check(!bonus.some((m) => grid[`${m.x},${m.y}`]), 'bonus moves never capture');
}

// fifty-move rule
{
  const st = createState();
  st.halfmove = 99;
  const result = move(st, 6, 7, 5, 5); // quiet knight move -> halfmove 100
  check(result?.reason === 'fifty', '50-move rule draw');
}

// threefold repetition
{
  const st = createState();
  let result = null;
  for (let i = 0; i < 3 && !result; i++) {
    result = move(st, 6, 7, 5, 5) || move(st, 6, 0, 5, 2) ||
             move(st, 5, 5, 6, 7) || move(st, 5, 2, 6, 0);
  }
  check(result?.reason === 'repetition', 'threefold repetition draw');
}

// energy accrual and cap
{
  const st = createState();
  move(st, 6, 7, 5, 5);
  check(st.energy[0] === 1 && st.energy[1] === 0, 'energy +1 after own turn only');
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
    next(match = () => true, timeout = 6000) {
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

const a = client('Ana');
const b = client('Bob');
await Promise.all([a.open(), b.open()]);

a.send({ t: 'create', name: 'Ana' });
const { code, id: anaId } = await a.next((m) => m.t === 'welcome');
b.send({ t: 'join', code, name: 'Bob' });
const { id: bobId } = await b.next((m) => m.t === 'welcome');

b.send({ t: 'setRules', rules: 'grandmaster' });
await sleep(200);
a.send({ t: 'setRules', rules: 'grandmaster' });
const lob = await a.next((m) => m.t === 'lobby' && m.rules === 'grandmaster');
check(!!lob, 'host can set grandmaster rules (non-host attempt ignored)');

const pieceAt = (pieces, x, y) => pieces.find((p) => p.x === x && p.y === y);

async function startGmGame() {
  a.send({ t: 'start' });
  const start = await a.next((m) => m.t === 'start');
  await b.next((m) => m.t === 'start');
  await sleep(start.in + 200);
  a.drain(); b.drain();
  return start;
}

async function gmove(cl, pieces, fx, fy, tx, ty, extra = {}) {
  cl.send({ t: 'gmove', id: pieceAt(pieces, fx, fy).id, x: tx, y: ty, ...extra });
  const st = await a.next((m) => m.t === 'gstate');
  await b.next((m) => m.t === 'gstate');
  return st;
}

// --- game 1: turn enforcement + fool's mate ---
{
  const start = await startGmGame();
  check(start.rules === 'grandmaster' && start.gm.turn === 0 && start.gm.mover === anaId,
    'grandmaster game starts, blue (Ana) to move');

  // Bob (red) tries to move out of turn -> ignored
  b.send({ t: 'gmove', id: pieceAt(start.gm.pieces, 4, 1).id, x: 4, y: 3 });
  await sleep(250);
  check(b.drain().filter((m) => m.t === 'gstate').length === 0, 'out-of-turn move ignored');

  // Ana illegal move -> reject
  a.send({ t: 'gmove', id: pieceAt(start.gm.pieces, 0, 7).id, x: 0, y: 4 });
  check((await a.next((m) => m.t === 'reject')) !== null, 'illegal move rejected');

  let st = await gmove(a, start.gm.pieces, 5, 6, 5, 5);   // f3
  check(st.turn === 1 && st.mover === bobId && st.energy[0] === 1, 'turn passes, energy accrues');
  st = await gmove(b, st.pieces, 4, 1, 4, 3);             // e5
  st = await gmove(a, st.pieces, 6, 6, 6, 4);             // g4
  st = await gmove(b, st.pieces, 3, 0, 7, 4);             // Qh4#
  const end1 = await a.next((m) => m.t === 'end');
  await b.next((m) => m.t === 'end');
  check(end1.winner === 1 && end1.reason === 'checkmate', 'checkmate ends game over the wire');
  await a.next((m) => m.t === 'lobby');
  await b.next((m) => m.t === 'lobby');
}

// --- game 2: castle, en passant, shield, spirit, check, resign ---
{
  const start = await startGmGame();
  let st = start.gm;
  st = await gmove(a, st.pieces, 4, 6, 4, 4);   // e4
  st = await gmove(b, st.pieces, 0, 1, 0, 2);   // a6
  st = await gmove(a, st.pieces, 6, 7, 5, 5);   // Nf3
  st = await gmove(b, st.pieces, 1, 1, 1, 2);   // b6
  st = await gmove(a, st.pieces, 5, 7, 2, 4);   // Bc4
  st = await gmove(b, st.pieces, 2, 1, 2, 2);   // c6
  st = await gmove(a, st.pieces, 4, 7, 6, 7);   // O-O
  check(pieceAt(st.pieces, 5, 7)?.type === 'rook' && pieceAt(st.pieces, 6, 7)?.type === 'king',
    'castling works over the wire');

  st = await gmove(b, st.pieces, 7, 1, 7, 2);   // h6
  st = await gmove(a, st.pieces, 4, 4, 4, 3);   // e5
  st = await gmove(b, st.pieces, 3, 1, 3, 3);   // d5 (double)
  const before = st.pieces.length;
  st = await gmove(a, st.pieces, 4, 3, 3, 2);   // exd6 e.p.
  check(st.pieces.length === before - 1 && !pieceAt(st.pieces, 3, 3) && st.event.enPassant,
    'en passant works over the wire');

  // Bob shields f7 then develops; Ana's Bxf7 must be rejected while shielded
  const f7 = pieceAt(st.pieces, 5, 1);
  const bobEnergy = st.energy[1];
  b.send({ t: 'shield', id: f7.id });
  st = await a.next((m) => m.t === 'gstate');
  await b.next((m) => m.t === 'gstate');
  check(st.shields.includes(f7.id) && st.energy[1] === bobEnergy - COSTS.shield,
    'shield cast, energy deducted, turn kept');
  st = await gmove(b, st.pieces, 6, 0, 5, 2);   // Nf6

  const bishop = pieceAt(st.pieces, 2, 4);
  a.send({ t: 'gmove', id: bishop.id, x: 5, y: 1 });
  check((await a.next((m) => m.t === 'reject')).id === bishop.id, 'capturing shielded pawn rejected');

  st = await gmove(a, st.pieces, 3, 6, 3, 5);   // d3
  st = await gmove(b, st.pieces, 0, 2, 0, 3);   // a5 (Bob's turn begins -> shield expires)
  check(!st.shields.includes(f7.id), 'shield expired after one enemy turn');

  st = await gmove(a, st.pieces, 2, 4, 5, 1);   // Bxf7+
  check(st.event.captured?.type === 'pawn' && st.check === true, 'Bxf7 lands and gives check');

  // Bob must address the check: a random move is rejected, Kxf7 works
  b.send({ t: 'gmove', id: pieceAt(st.pieces, 1, 2).id, x: 1, y: 3 });
  check((await b.next((m) => m.t === 'reject')) !== null, 'moves that ignore check are rejected');
  st = await gmove(b, st.pieces, 4, 0, 5, 1);   // Kxf7

  // Knight's Spirit: queen jumps d1 -> e3 (not a queen move)
  const queen = pieceAt(st.pieces, 3, 7);
  const anaEnergy = st.energy[0];
  check(anaEnergy >= COSTS.spirit, `Ana has spirit energy (${anaEnergy})`);
  st = await gmove(a, st.pieces, 3, 7, 4, 5, { spirit: true });
  check(pieceAt(st.pieces, 4, 5)?.id === queen.id && st.event.spirit &&
    st.energy[0] === anaEnergy - COSTS.spirit + 1,
    'spirit jump applied with correct energy cost');

  b.send({ t: 'resign' });
  const end2 = await a.next((m) => m.t === 'end');
  await b.next((m) => m.t === 'end');
  check(end2.winner === 0 && end2.reason === 'resign', 'resignation ends the game');
  await a.next((m) => m.t === 'lobby');
  await b.next((m) => m.t === 'lobby');
}

// --- game 3: Second Wind over the wire ---
{
  const start = await startGmGame();
  let st = start.gm;
  // ten quiet pawn moves each to bank 10 energy
  const anaFiller = [[0, 6, 0, 5], [1, 6, 1, 5], [2, 6, 2, 5], [6, 6, 6, 5], [7, 6, 7, 5],
                     [0, 5, 0, 4], [1, 5, 1, 4], [2, 5, 2, 4], [6, 5, 6, 4], [7, 5, 7, 4]];
  const bobFiller = [[0, 1, 0, 2], [1, 1, 1, 2], [2, 1, 2, 2], [6, 1, 6, 2], [7, 1, 7, 2],
                     [0, 2, 0, 3], [1, 2, 1, 3], [2, 2, 2, 3], [6, 2, 6, 3], [7, 2, 7, 3]];
  for (let i = 0; i < 10; i++) {
    st = await gmove(a, st.pieces, ...anaFiller[i]);
    st = await gmove(b, st.pieces, ...bobFiller[i]);
  }
  check(st.energy[0] === 10 && st.energy[1] === 10, `both banked 10 energy (got ${st.energy})`);

  // Ana: knight b1-d2?? -> Nb1 is at (1,7): move to (3,6)? occupied by d2 pawn. Use Nc3 (2,5)? occupied by pawn c4... use d-pawn d4 then wind.
  const knight = pieceAt(st.pieces, 1, 7);
  a.send({ t: 'gmove', id: knight.id, x: 0, y: 5, sw: true }); // Na3... a3 is empty (a-pawn on a4)
  st = await a.next((m) => m.t === 'gstate');
  await b.next((m) => m.t === 'gstate');
  check(st.pending?.team === 0 && st.mover === anaId, 'Second Wind: bonus move pending');

  // bonus may not capture: try capturing nothing is fine; make a quiet second move with the other knight
  const knight2 = pieceAt(st.pieces, 6, 7);
  a.send({ t: 'gbonus', id: knight2.id, x: 5, y: 5 }); // Nf3
  st = await a.next((m) => m.t === 'gstate');
  await b.next((m) => m.t === 'gstate');
  check(!st.pending && st.turn === 1 &&
    pieceAt(st.pieces, 0, 5)?.type === 'knight' && pieceAt(st.pieces, 5, 5)?.type === 'knight' &&
    st.energy[0] === 1,
    'Second Wind: two pieces moved in one turn, energy spent (10), turn passed');

  a.send({ t: 'resign' });
  await a.next((m) => m.t === 'end');
  await b.next((m) => m.t === 'end');
  await a.next((m) => m.t === 'lobby');
  await b.next((m) => m.t === 'lobby');
}

a.ws.close();
b.ws.close();

// --- game 4: 2v2 mover rotation ---
{
  const h = client('H'); const x2 = client('X'); const y2 = client('Y'); const z2 = client('Z');
  await Promise.all([h, x2, y2, z2].map((c) => c.open()));
  h.send({ t: 'create', name: 'H' });
  const { code: code2, id: hId } = await h.next((m) => m.t === 'welcome');
  x2.send({ t: 'join', code: code2, name: 'X' });
  const { id: xId } = await x2.next((m) => m.t === 'welcome');
  y2.send({ t: 'join', code: code2, name: 'Y' });
  const { id: yId } = await y2.next((m) => m.t === 'welcome');
  z2.send({ t: 'join', code: code2, name: 'Z' });
  const { id: zId } = await z2.next((m) => m.t === 'welcome');
  // teams by auto-balance: H,Y team0; X,Z team1
  h.send({ t: 'setMode', mode: '2v2' });
  h.send({ t: 'setRules', rules: 'grandmaster' });
  await h.next((m) => m.t === 'lobby' && m.mode === '2v2' && m.rules === 'grandmaster');
  h.send({ t: 'start' });
  const start = await h.next((m) => m.t === 'start');
  await Promise.all([x2, y2, z2].map((c) => c.next((m) => m.t === 'start')));
  await sleep(start.in + 200);
  [h, x2, y2, z2].forEach((c) => c.drain());

  check(start.gm.mover === hId, '2v2: first mover is team0 player 1');

  // teammate Y (team0) may NOT move when H is the mover
  y2.send({ t: 'gmove', id: pieceAt(start.gm.pieces, 0, 6).id, x: 0, y: 5 });
  await sleep(250);
  check(y2.drain().filter((m) => m.t === 'gstate').length === 0, '2v2: non-mover teammate ignored');

  h.send({ t: 'gmove', id: pieceAt(start.gm.pieces, 0, 6).id, x: 0, y: 5 });
  let st = await h.next((m) => m.t === 'gstate');
  check(st.mover === xId, '2v2: red mover is X');
  x2.send({ t: 'gmove', id: pieceAt(st.pieces, 0, 1).id, x: 0, y: 2 });
  st = await h.next((m) => m.t === 'gstate');
  check(st.mover === yId, '2v2: blue rotates to teammate Y');
  y2.send({ t: 'gmove', id: pieceAt(st.pieces, 1, 6).id, x: 1, y: 5 });
  st = await h.next((m) => m.t === 'gstate');
  check(st.mover === zId, '2v2: red rotates to teammate Z');
  [h, x2, y2, z2].forEach((c) => c.ws.close());
}

console.log(failures === 0 ? '\nALL GRANDMASTER TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
