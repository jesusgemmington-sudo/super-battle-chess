// Grandmaster mode engine - full classic chess rules plus the Energy
// power-up system. Shared by server (authoritative) and client (highlights).
//
// Chess rules implemented in full: strict turns, legal-move filtering
// (no moving into check), castling, en passant, promotion with choice,
// checkmate, stalemate, 50-move rule, threefold repetition, insufficient
// material. Kings are never captured - checkmate ends the game.
//
// Power-ups (deterministic, symmetric, perfect information - no RNG):
//   shield (Aegis, 4):  one of your pieces (not king) cannot be captured
//                       until your next turn begins. Free action before
//                       your move.
//   spirit (Knight's Spirit, 6): one move where a piece (not king) may
//                       also jump like a knight. May capture, but never
//                       a king, and grants no new check threats - check
//                       is always computed from standard attacks only.
//   wind   (Second Wind, 10): after your move, one extra move with a
//                       different piece; it may not capture and may not
//                       give check. Forfeited if your first move checks.
//
// Energy: each team gains +1 at the end of its own turn, capped at 12.

import { SIZE, createPieces, pawnDir, pawnStartRow, promotionRow } from './rules.js';

export const COSTS = { shield: 4, spirit: 6, wind: 10 };
export const ENERGY_CAP = 12;
export const PROMO_TYPES = ['queen', 'rook', 'bishop', 'knight'];

const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL_DIRS = [...ROOK_DIRS, ...BISHOP_DIRS];
const KNIGHT_JUMPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

const inB = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;

export function createState() {
  return {
    pieces: createPieces().map((p) => ({ ...p, moved: false })),
    turn: 0,                // team to move (0 = blue, moves first)
    ep: null,               // { x, y, pawnId } - en passant target square
    halfmove: 0,            // for the 50-move rule
    energy: [0, 0],
    shields: {},            // pieceId -> true while shield is active
    pending: null,          // { team, exclude } while a Second Wind bonus move is owed
    history: {},            // position hash -> occurrence count (threefold)
    result: null,           // { winner, reason } ; winner -1 means draw
  };
}

export function grid(state) {
  const g = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const p of state.pieces) if (p.alive) g[p.y][p.x] = p;
  return g;
}

export function findPiece(state, id) {
  return state.pieces.find((p) => p.id === id);
}

function findKing(state, team) {
  return state.pieces.find((p) => p.alive && p.team === team && p.type === 'king');
}

// Standard attack patterns only - power-ups never alter what counts as check.
export function squareAttacked(state, byTeam, x, y, g = grid(state)) {
  // pawns
  const d = pawnDir(byTeam);
  for (const dx of [-1, 1]) {
    const px = x + dx;
    const py = y - d;
    if (inB(px, py)) {
      const p = g[py][px];
      if (p && p.team === byTeam && p.type === 'pawn') return true;
    }
  }
  // knights
  for (const [dx, dy] of KNIGHT_JUMPS) {
    const nx = x + dx, ny = y + dy;
    if (inB(nx, ny)) {
      const p = g[ny][nx];
      if (p && p.team === byTeam && p.type === 'knight') return true;
    }
  }
  // king
  for (const [dx, dy] of ALL_DIRS) {
    const nx = x + dx, ny = y + dy;
    if (inB(nx, ny)) {
      const p = g[ny][nx];
      if (p && p.team === byTeam && p.type === 'king') return true;
    }
  }
  // sliders
  for (const [dx, dy] of ROOK_DIRS) {
    let nx = x + dx, ny = y + dy;
    while (inB(nx, ny)) {
      const p = g[ny][nx];
      if (p) {
        if (p.team === byTeam && (p.type === 'rook' || p.type === 'queen')) return true;
        break;
      }
      nx += dx; ny += dy;
    }
  }
  for (const [dx, dy] of BISHOP_DIRS) {
    let nx = x + dx, ny = y + dy;
    while (inB(nx, ny)) {
      const p = g[ny][nx];
      if (p) {
        if (p.team === byTeam && (p.type === 'bishop' || p.type === 'queen')) return true;
        break;
      }
      nx += dx; ny += dy;
    }
  }
  return false;
}

export function inCheck(state, team, g = grid(state)) {
  const king = findKing(state, team);
  if (!king) return false;
  return squareAttacked(state, 1 - team, king.x, king.y, g);
}

function shielded(state, piece) {
  return !!state.shields[piece.id];
}

// Pseudo-legal moves (before king-safety filtering).
// Each move: { x, y, ep?, castle?, double?, spirit? }
function pseudoMoves(state, p, opts = {}) {
  const g = grid(state);
  const moves = [];
  const tryAdd = (x, y, extra = {}) => {
    if (!inB(x, y)) return;
    const target = g[y][x];
    if (target) {
      if (target.team === p.team) return;
      if (target.type === 'king') return;       // kings are never captured
      if (shielded(state, target)) return;      // Aegis blocks capture
    }
    moves.push({ x, y, ...extra });
  };

  if (p.type === 'pawn') {
    const d = pawnDir(p.team);
    const y1 = p.y + d;
    if (inB(p.x, y1) && !g[y1][p.x]) {
      moves.push({ x: p.x, y: y1 });
      const y2 = p.y + 2 * d;
      if (p.y === pawnStartRow(p.team) && inB(p.x, y2) && !g[y2][p.x]) {
        moves.push({ x: p.x, y: y2, double: true });
      }
    }
    for (const dx of [-1, 1]) {
      const x = p.x + dx;
      if (!inB(x, y1)) continue;
      const target = g[y1][x];
      if (target && target.team !== p.team) tryAdd(x, y1);
      // en passant
      if (!target && state.ep && state.ep.x === x && state.ep.y === y1) {
        const victim = findPiece(state, state.ep.pawnId);
        if (victim && victim.alive && victim.team !== p.team && !shielded(state, victim)) {
          moves.push({ x, y: y1, ep: true });
        }
      }
    }
  } else if (p.type === 'knight') {
    for (const [dx, dy] of KNIGHT_JUMPS) tryAdd(p.x + dx, p.y + dy);
  } else if (p.type === 'king') {
    for (const [dx, dy] of ALL_DIRS) tryAdd(p.x + dx, p.y + dy);
    // castling
    if (!p.moved && p.x === 4 && !inCheck(state, p.team, g)) {
      const y = p.y;
      const enemy = 1 - p.team;
      const rookAt = (x) => {
        const r = g[y][x];
        return r && r.type === 'rook' && r.team === p.team && !r.moved ? r : null;
      };
      // king side
      if (rookAt(7) && !g[y][5] && !g[y][6] &&
          !squareAttacked(state, enemy, 5, y, g) && !squareAttacked(state, enemy, 6, y, g)) {
        moves.push({ x: 6, y, castle: 'k' });
      }
      // queen side
      if (rookAt(0) && !g[y][1] && !g[y][2] && !g[y][3] &&
          !squareAttacked(state, enemy, 3, y, g) && !squareAttacked(state, enemy, 2, y, g)) {
        moves.push({ x: 2, y, castle: 'q' });
      }
    }
  } else {
    const dirs = p.type === 'rook' ? ROOK_DIRS : p.type === 'bishop' ? BISHOP_DIRS : ALL_DIRS;
    for (const [dx, dy] of dirs) {
      let x = p.x + dx, y = p.y + dy;
      while (inB(x, y)) {
        const target = g[y][x];
        if (!target) {
          moves.push({ x, y });
        } else {
          if (target.team !== p.team && target.type !== 'king' && !shielded(state, target)) {
            moves.push({ x, y });
          }
          break;
        }
        x += dx; y += dy;
      }
    }
  }

  // Knight's Spirit: extra knight-jump moves for any non-king piece.
  if (opts.spirit && p.type !== 'king') {
    for (const [dx, dy] of KNIGHT_JUMPS) {
      const x = p.x + dx, y = p.y + dy;
      if (!inB(x, y)) continue;
      if (moves.some((m) => m.x === x && m.y === y)) continue; // already reachable normally
      const target = g[y][x];
      if (target && (target.team === p.team || target.type === 'king' || shielded(state, target))) continue;
      moves.push({ x, y, spirit: true });
    }
  }
  return moves;
}

export function cloneState(state) {
  return {
    pieces: state.pieces.map((p) => ({ ...p })),
    turn: state.turn,
    ep: state.ep ? { ...state.ep } : null,
    halfmove: state.halfmove,
    energy: [...state.energy],
    shields: { ...state.shields },
    pending: null,
    history: state.history, // shared read-only during legality probes
    result: null,
  };
}

// Apply a move to the state (mutates). `mv` must come from legalMovesFor /
// bonusMovesFor so its flags are trusted. Returns { captured, promoted }.
export function applyMoveRaw(state, pieceId, mv, promo) {
  const p = findPiece(state, pieceId);
  const g = grid(state);
  let captured = null;

  if (mv.ep) {
    captured = findPiece(state, state.ep.pawnId);
  } else if (g[mv.y][mv.x]) {
    captured = g[mv.y][mv.x];
  }
  if (captured) captured.alive = false;

  if (mv.castle) {
    const rookFromX = mv.castle === 'k' ? 7 : 0;
    const rookToX = mv.castle === 'k' ? 5 : 3;
    const rook = g[p.y][rookFromX];
    rook.x = rookToX;
    rook.moved = true;
  }

  const fromY = p.y;
  p.x = mv.x;
  p.y = mv.y;
  p.moved = true;

  state.ep = mv.double ? { x: p.x, y: (fromY + mv.y) / 2, pawnId: p.id } : null;

  let promoted = false;
  if (p.type === 'pawn' && p.y === promotionRow(p.team)) {
    p.type = PROMO_TYPES.includes(promo) ? promo : 'queen';
    promoted = true;
  }

  state.halfmove = (captured || p.type === 'pawn' || promoted) ? 0 : state.halfmove + 1;
  return { captured, promoted };
}

// Fully legal moves for one piece (king safety enforced).
export function legalMovesFor(state, pieceId, opts = {}) {
  const p = findPiece(state, pieceId);
  if (!p || !p.alive) return [];
  return pseudoMoves(state, p, opts).filter((mv) => {
    const probe = cloneState(state);
    applyMoveRaw(probe, pieceId, mv, 'queen');
    return !inCheck(probe, p.team);
  });
}

// Second Wind bonus moves: any piece except `excludeId`, no captures,
// must not give check, normal movement only (no spirit).
export function bonusMovesFor(state, team, excludeId) {
  const out = [];
  for (const p of state.pieces) {
    if (!p.alive || p.team !== team || p.id === excludeId) continue;
    for (const mv of legalMovesFor(state, p.id)) {
      if (mv.ep) continue;
      const g = grid(state);
      if (g[mv.y][mv.x]) continue; // no captures
      const probe = cloneState(state);
      applyMoveRaw(probe, p.id, mv, 'queen');
      if (inCheck(probe, 1 - team)) continue; // may not give check
      out.push({ pieceId: p.id, ...mv });
    }
  }
  return out;
}

// Does `team` have any legal action at all? Includes affordable spirit moves,
// so "checkmate" honestly accounts for power-up escapes.
export function hasAnyAction(state, team) {
  const spirit = state.energy[team] >= COSTS.spirit;
  for (const p of state.pieces) {
    if (!p.alive || p.team !== team) continue;
    if (legalMovesFor(state, p.id, { spirit }).length > 0) return true;
  }
  return false;
}

function hashState(state) {
  const parts = state.pieces
    .filter((p) => p.alive)
    .map((p) => `${p.type[0]}${p.type[1] || ''}${p.team}${p.x}${p.y}${(p.type === 'king' || p.type === 'rook') ? (p.moved ? 'm' : 'u') : ''}`)
    .sort();
  const ep = state.ep ? `${state.ep.x},${state.ep.y}` : '-';
  return `${parts.join('|')}#${state.turn}#${ep}`;
}

function insufficientMaterial(state) {
  let minors = 0;
  for (const p of state.pieces) {
    if (!p.alive || p.type === 'king') continue;
    if (p.type === 'bishop' || p.type === 'knight') {
      minors++;
      if (minors > 1) return false;
    } else {
      return false; // any pawn/rook/queen means mate is possible
    }
  }
  return true; // K vs K, K+B vs K, K+N vs K
}

// Complete the current team's turn: accrue energy, flip the turn, expire
// shields, and evaluate the game result. Returns state.result (or null).
export function endTurn(state) {
  const moved = state.turn;
  state.energy[moved] = Math.min(ENERGY_CAP, state.energy[moved] + 1);
  state.turn = 1 - moved;
  state.pending = null;

  // Shields protect through the opponent's turn and expire when the
  // owner's turn begins again.
  for (const id of Object.keys(state.shields)) {
    const p = findPiece(state, id);
    if (!p || !p.alive || p.team === state.turn) delete state.shields[id];
  }

  const h = hashState(state);
  state.history[h] = (state.history[h] || 0) + 1;

  if (!hasAnyAction(state, state.turn)) {
    state.result = inCheck(state, state.turn)
      ? { winner: moved, reason: 'checkmate' }
      : { winner: -1, reason: 'stalemate' };
  } else if (state.halfmove >= 100) {
    state.result = { winner: -1, reason: 'fifty' };
  } else if (state.history[h] >= 3) {
    state.result = { winner: -1, reason: 'repetition' };
  } else if (insufficientMaterial(state)) {
    state.result = { winner: -1, reason: 'material' };
  }
  return state.result;
}
