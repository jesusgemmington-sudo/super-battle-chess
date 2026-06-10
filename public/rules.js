// Shared movement rules for Super Battle Chess.
// Used by both the server (authoritative validation) and the client (move highlights).
//
// Battle-chess variant: there are no turns, so there is no check or checkmate.
// You win by capturing the enemy king. Castling and en passant don't exist here.

export const SIZE = 8;

const BACK_ROW = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];

// Team 0 (blue) starts at the bottom (rows 6-7), team 1 (red) at the top (rows 0-1).
export function createPieces() {
  const pieces = [];
  let id = 1;
  for (const team of [0, 1]) {
    const backY = team === 0 ? 7 : 0;
    const pawnY = team === 0 ? 6 : 1;
    BACK_ROW.forEach((type, x) => {
      pieces.push({ id: 'p' + id++, type, team, x, y: backY, alive: true });
    });
    for (let x = 0; x < SIZE; x++) {
      pieces.push({ id: 'p' + id++, type: 'pawn', team, x, y: pawnY, alive: true });
    }
  }
  return pieces;
}

export function buildGrid(pieces) {
  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const p of pieces) {
    if (p.alive) grid[p.y][p.x] = p;
  }
  return grid;
}

export function pawnDir(team) {
  return team === 0 ? -1 : 1;
}

export function pawnStartRow(team) {
  return team === 0 ? 6 : 1;
}

export function promotionRow(team) {
  return team === 0 ? 0 : 7;
}

const SLIDES = {
  rook: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  bishop: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  queen: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
};

const KNIGHT_JUMPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

const inBounds = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;

// Returns every square the piece may move to right now, as [{x, y}].
export function computeMoves(grid, p) {
  const moves = [];

  if (p.type === 'pawn') {
    const d = pawnDir(p.team);
    const y1 = p.y + d;
    if (inBounds(p.x, y1) && !grid[y1][p.x]) {
      moves.push({ x: p.x, y: y1 });
      const y2 = p.y + 2 * d;
      if (p.y === pawnStartRow(p.team) && inBounds(p.x, y2) && !grid[y2][p.x]) {
        moves.push({ x: p.x, y: y2 });
      }
    }
    for (const dx of [-1, 1]) {
      const x = p.x + dx;
      if (inBounds(x, y1) && grid[y1][x] && grid[y1][x].team !== p.team) {
        moves.push({ x, y: y1 });
      }
    }
    return moves;
  }

  if (p.type === 'knight' || p.type === 'king') {
    const deltas = p.type === 'knight' ? KNIGHT_JUMPS : SLIDES.queen;
    for (const [dx, dy] of deltas) {
      const x = p.x + dx;
      const y = p.y + dy;
      if (inBounds(x, y) && (!grid[y][x] || grid[y][x].team !== p.team)) {
        moves.push({ x, y });
      }
    }
    return moves;
  }

  for (const [dx, dy] of SLIDES[p.type]) {
    let x = p.x + dx;
    let y = p.y + dy;
    while (inBounds(x, y)) {
      if (!grid[y][x]) {
        moves.push({ x, y });
      } else {
        if (grid[y][x].team !== p.team) moves.push({ x, y });
        break;
      }
      x += dx;
      y += dy;
    }
  }
  return moves;
}

export function isLegalMove(grid, p, x, y) {
  return computeMoves(grid, p).some((m) => m.x === x && m.y === y);
}
