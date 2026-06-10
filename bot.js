// Chess computer for Super Battle Chess. Server-side only.
//
// Grandmaster mode: iterative-deepening negamax with alpha-beta pruning and a
// capture-only quiescence search, built on the shared classic.js rules engine.
// Battle mode: a reaction-time bot that scores candidate moves heuristically.
//
// Difficulty 1-10 scales search depth, evaluation noise, blunder chance, and
// (in battle mode) reaction speed.

import { buildGrid, computeMoves, promotionRow } from './public/rules.js';
import { cloneState, legalMovesFor, applyMoveRaw, inCheck } from './public/classic.js';

export const BOT_NAMES = [
  'Wood Pusher', 'Pawn Pusher', 'Rook Rookie', 'Bishop Bonker', 'Castle Crusher',
  'Fork Fiend', 'Tactic Tonic', 'Sharp Silicon', 'Deep Sprocket', 'GM Gizmo',
];

const VAL = { pawn: 100, knight: 320, bishop: 330, rook: 500, queen: 900, king: 0 };
const MATE = 100000;

//          level:   1     2     3     4     5     6     7     8     9    10
const DEPTH    = [   1,    1,    2,    2,    3,    3,    3,    4,    4,    5];
const QDEPTH   = [   0,    2,    2,    4,    4,    4,    6,    6,    6,    8];
const NOISE    = [ 150,  100,   70,   45,   30,   18,   10,    5,    2,    0];
const RANDOM   = [0.35,  0.2,  0.1, 0.05,    0,    0,    0,    0,    0,    0];
const TIME_MS  = [ 150,  200,  300,  450,  650,  900, 1300, 1800, 2300, 2800];

class TimeUp extends Error {}

// ---------------------------------------------------------------------------
// Evaluation (from `team`'s perspective, in centipawns)
// ---------------------------------------------------------------------------

function evaluate(state, team) {
  let score = 0;
  for (const p of state.pieces) {
    if (!p.alive) continue;
    let v = VAL[p.type];
    // pawns: reward advancing
    if (p.type === 'pawn') {
      v += (p.team === 0 ? 6 - p.y : p.y - 1) * 6;
    } else if (p.type === 'knight' || p.type === 'bishop' || p.type === 'queen') {
      // mild centralization
      v -= (Math.abs(p.x - 3.5) + Math.abs(p.y - 3.5)) * 3;
    }
    score += p.team === team ? v : -v;
  }
  return score;
}

function teamMoves(state, team) {
  const out = [];
  const g = (() => {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (const p of state.pieces) if (p.alive) grid[p.y][p.x] = p;
    return grid;
  })();
  for (const p of state.pieces) {
    if (!p.alive || p.team !== team) continue;
    for (const mv of legalMovesFor(state, p.id)) {
      const victim = mv.ep ? { type: 'pawn' } : g[mv.y][mv.x];
      out.push({
        pieceId: p.id,
        mv,
        capture: victim ? VAL[victim.type] : 0,
        attacker: VAL[p.type],
      });
    }
  }
  // captures first, most-valuable-victim / least-valuable-attacker
  out.sort((a, b) => (b.capture - b.attacker / 100) - (a.capture - a.attacker / 100));
  return out;
}

function child(state, move) {
  const next = cloneState(state);
  applyMoveRaw(next, move.pieceId, move.mv, 'queen');
  return next;
}

function qsearch(state, team, alpha, beta, deadline, qdepth) {
  if (Date.now() > deadline) throw new TimeUp();
  const standPat = evaluate(state, team);
  if (qdepth <= 0 || standPat >= beta) return standPat;
  if (standPat > alpha) alpha = standPat;
  for (const move of teamMoves(state, team)) {
    if (!move.capture) break; // list is capture-first sorted
    const score = -qsearch(child(state, move), 1 - team, -beta, -alpha, deadline, qdepth - 1);
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(state, team, depth, alpha, beta, deadline, qdepth, ply) {
  if (Date.now() > deadline) throw new TimeUp();
  const moves = teamMoves(state, team);
  if (moves.length === 0) {
    return inCheck(state, team) ? -(MATE - ply) : 0; // mate or stalemate
  }
  if (depth <= 0) return qsearch(state, team, alpha, beta, deadline, qdepth);
  for (const move of moves) {
    const score = -negamax(child(state, move), 1 - team, depth - 1, -beta, -alpha, deadline, qdepth, ply + 1);
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

// Pick the bot's move in Grandmaster mode. Returns { pieceId, x, y } or null.
export function chooseGmMove(state, team, level) {
  const idx = Math.min(10, Math.max(1, level)) - 1;
  const rootMoves = teamMoves(state, team);
  if (rootMoves.length === 0) return null;

  // Low levels sometimes just play something.
  if (Math.random() < RANDOM[idx]) {
    const m = rootMoves[Math.floor(Math.random() * rootMoves.length)];
    return { pieceId: m.pieceId, x: m.mv.x, y: m.mv.y };
  }

  const deadline = Date.now() + TIME_MS[idx];
  let best = rootMoves.map((m) => ({ move: m, score: 0 }));

  for (let depth = 1; depth <= DEPTH[idx]; depth++) {
    const scored = [];
    try {
      // With evaluation noise we need true scores for every root move, so
      // only tighten the root window when playing at full strength.
      const tighten = NOISE[idx] === 0;
      let alpha = -Infinity;
      for (const m of rootMoves) {
        const beta = tighten ? -alpha : Infinity;
        const score = -negamax(child(state, m), 1 - team, depth - 1, -Infinity, beta, deadline, QDEPTH[idx], 1);
        scored.push({ move: m, score });
        if (score > alpha) alpha = score;
      }
      best = scored;
      // keep deeper iterations exploring the best lines first
      rootMoves.sort((a, b) =>
        (scored.find((s) => s.move === b)?.score ?? 0) - (scored.find((s) => s.move === a)?.score ?? 0));
    } catch (err) {
      if (err instanceof TimeUp) break;
      throw err;
    }
  }

  let top = null;
  for (const entry of best) {
    const jitter = NOISE[idx] > 0 ? (Math.random() * 2 - 1) * NOISE[idx] : 0;
    const v = entry.score + jitter;
    if (!top || v > top.v) top = { v, move: entry.move };
  }
  return { pieceId: top.move.pieceId, x: top.move.mv.x, y: top.move.mv.y };
}

// ---------------------------------------------------------------------------
// Battle mode (real-time)
// ---------------------------------------------------------------------------

export function battleReactionMs(level) {
  return Math.max(700, 3700 - level * 290);
}

// Pick a battle-mode move for the bot. `pieces` are the server's live battle
// pieces (with cdUntil). Returns { id, x, y } or null.
export function chooseBattleMove(pieces, team, level, now = Date.now()) {
  const alive = pieces.filter((p) => p.alive);
  const grid = buildGrid(alive);
  const ready = alive.filter((p) => p.team === team && p.cdUntil <= now);
  if (ready.length === 0) return null;

  const enemies = alive.filter((p) => p.team !== team);
  const myKing = alive.find((p) => p.team === team && p.type === 'king');
  const attacked = new Set();
  const kingThreats = new Set();
  for (const e of enemies) {
    for (const m of computeMoves(grid, e)) {
      attacked.add(`${m.x},${m.y}`);
      if (myKing && m.x === myKing.x && m.y === myKing.y && e.cdUntil <= now + 600) {
        kingThreats.add(e.id);
      }
    }
  }

  const candidates = [];
  for (const p of ready) {
    for (const m of computeMoves(grid, p)) {
      const target = grid[m.y][m.x];
      let s = 0;
      if (target) s += target.type === 'king' ? 1e6 : VAL[target.type] * 10;
      if (p.type === 'pawn' && m.y === promotionRow(team)) s += 7000;
      if (kingThreats.size > 0) {
        if (p.type === 'king' && !attacked.has(`${m.x},${m.y}`)) s += 500000;       // flee!
        else if (target && kingThreats.has(target.id)) s += 400000;                  // slay the assassin
      }
      if (attacked.has(`${m.x},${m.y}`)) {
        s -= VAL[p.type] * 8 - (target ? VAL[target.type] * 5 : 0);
      }
      s += (team === 0 ? p.y - m.y : m.y - p.y) * 4; // gentle forward pressure
      s += Math.random() * 12;
      candidates.push({ p, m, s });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.s - a.s);

  // King captures and king rescues are never left on the table.
  if (candidates[0].s >= 400000) {
    const top = candidates[0];
    return { id: top.p.id, x: top.m.x, y: top.m.y };
  }

  // Lower levels pick from a wider band of "pretty good" moves.
  const band = Math.max(1, Math.round((1 - level / 10) * 6) + 1);
  const pick = candidates[Math.floor(Math.random() * Math.min(band, candidates.length))];
  return { id: pick.p.id, x: pick.m.x, y: pick.m.y };
}
