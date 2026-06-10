// The Board - deterministic world generator for Royale mode.
// Server and client both build the exact same world from a match seed:
// the server uses the boxes for collision, occlusion and hit detection,
// the client turns them into meshes. All units are meters.

export const TILE = 60;          // one board square
export const BOARD = 8;
export const WORLD = TILE * BOARD; // 480m x 480m

// Deterministic PRNG (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tileRing(tx, ty) {
  return Math.min(tx, ty, BOARD - 1 - tx, BOARD - 1 - ty);
}

// Tile elevation layout (fixed design, seed varies decoration):
// "Pawn Rise" plateau in the NW quadrant, "Queen's Bluff" high plateau SE.
const TILE_H = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 4, 4, 0, 0, 0, 0, 0],
  [0, 4, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 8, 0],
  [0, 0, 0, 0, 0, 8, 8, 0],
  [0, 0, 0, 0, 0, 8, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
]; // TILE_H[ty][tx]

export function tileHeight(tx, ty) {
  if (tx < 0 || tx >= BOARD || ty < 0 || ty >= BOARD) return 0;
  return TILE_H[ty][tx];
}

export function groundAt(x, z) {
  return tileHeight(Math.floor(x / TILE), Math.floor(z / TILE));
}

// ---------------------------------------------------------------------------
// World construction
// ---------------------------------------------------------------------------

// box: { x, y, z (center), sx, sy, sz (full sizes), kind, color }
function box(x, y, z, sx, sy, sz, kind, color) {
  return { x, y, z, sx, sy, sz, kind, color };
}

// A simple hollow building: 4 walls (front has a door gap), flat roof.
// Returns boxes. Door faces -Z.
function building(out, cx, cz, w, d, h, color, roofStairs, rand) {
  const gy = groundAt(cx, cz);
  const t = 0.6; // wall thickness
  const doorW = 2.4, doorH = 3.2;
  // back wall
  out.push(box(cx, gy + h / 2, cz + d / 2 - t / 2, w, h, t, 'wall', color));
  // side walls
  out.push(box(cx - w / 2 + t / 2, gy + h / 2, cz, t, h, d, 'wall', color));
  out.push(box(cx + w / 2 - t / 2, gy + h / 2, cz, t, h, d, 'wall', color));
  // front wall, split around the door
  const segW = (w - doorW) / 2;
  out.push(box(cx - doorW / 2 - segW / 2, gy + h / 2, cz - d / 2 + t / 2, segW, h, t, 'wall', color));
  out.push(box(cx + doorW / 2 + segW / 2, gy + h / 2, cz - d / 2 + t / 2, segW, h, t, 'wall', color));
  // lintel above the door
  out.push(box(cx, gy + doorH + (h - doorH) / 2, cz - d / 2 + t / 2, doorW, h - doorH, t, 'wall', color));
  // roof slab
  out.push(box(cx, gy + h + 0.3, cz, w, 0.6, d, 'roof', color));
  if (roofStairs) stairs(out, cx + w / 2 + 2.4, cz + d / 2 - 2, h + 0.6, 0, rand);
  return out;
}

// A staircase of step boxes climbing `rise` meters. dir 0=+X 1=-X 2=+Z 3=-Z
function stairs(out, sx, sz, rise, dir, rand, width = 4) {
  const steps = Math.ceil(rise / 0.5);
  const depth = 1.1;
  const gy = groundAt(sx, sz);
  for (let i = 0; i < steps; i++) {
    const h = (i + 1) * 0.5;
    const off = i * depth;
    const dx = dir === 0 ? off : dir === 1 ? -off : 0;
    const dz = dir === 2 ? off : dir === 3 ? -off : 0;
    out.push(box(sx + dx, gy + h - 0.25, sz + dz,
      dir < 2 ? depth : width, 0.5, dir < 2 ? width : depth, 'stair', '#cfc4ae'));
  }
}

// Giant chess piece props, built from primitive boxes (collision-friendly).
function pieceProp(out, type, cx, cz, scale, color) {
  const gy = groundAt(cx, cz);
  const s = scale;
  out.push(box(cx, gy + 0.5 * s, cz, 3 * s, 1 * s, 3 * s, 'prop', color)); // base
  if (type === 'rook') {
    out.push(box(cx, gy + 3 * s, cz, 2.2 * s, 4 * s, 2.2 * s, 'prop', color));
    out.push(box(cx, gy + 5.3 * s, cz, 2.8 * s, 0.7 * s, 2.8 * s, 'prop', color));
  } else if (type === 'pawn') {
    out.push(box(cx, gy + 2 * s, cz, 1.6 * s, 2.4 * s, 1.6 * s, 'prop', color));
    out.push(box(cx, gy + 3.8 * s, cz, 2 * s, 1.6 * s, 2 * s, 'prop', color));
  } else if (type === 'bishop') {
    out.push(box(cx, gy + 2.6 * s, cz, 1.6 * s, 3.4 * s, 1.6 * s, 'prop', color));
    out.push(box(cx, gy + 5 * s, cz, 1.1 * s, 1.6 * s, 1.1 * s, 'prop', color));
  } else { // knight
    out.push(box(cx, gy + 2.4 * s, cz, 1.7 * s, 3 * s, 1.7 * s, 'prop', color));
    out.push(box(cx + 0.6 * s, gy + 4.2 * s, cz, 1.9 * s, 1.1 * s, 1.3 * s, 'prop', color));
  }
}

export function buildWorld(seed) {
  const rand = rng(seed);
  const boxes = [];

  // --- stairways onto the plateaus ---
  stairs(boxes, 1 * TILE + 8, 1 * TILE - 1, 4, 2, rand, 6);            // Pawn Rise south face
  stairs(boxes, 2 * TILE + 30, 2 * TILE + 30, 4, 3, rand, 6);          // Pawn Rise east face
  stairs(boxes, 5 * TILE + 10, 5 * TILE - 1, 8, 2, rand, 7);           // Queen's Bluff north
  stairs(boxes, 6 * TILE + 50, 4 * TILE + 30, 8, 0, rand, 7);          // Queen's Bluff west

  // --- Whiteford (white-stone town, NW-center) ---
  const whites = ['#efe6d4', '#e7dcc4', '#f2ead9'];
  const wfx = 1.4 * TILE, wfz = 4.2 * TILE;
  building(boxes, wfx, wfz, 12, 10, 6, whites[0], true, rand);
  building(boxes, wfx + 20, wfz + 6, 10, 12, 7, whites[1], false, rand);
  building(boxes, wfx + 4, wfz + 26, 14, 10, 6, whites[2], false, rand);
  building(boxes, wfx + 26, wfz + 30, 10, 10, 9, whites[0], true, rand);
  building(boxes, wfx + 48, wfz + 10, 12, 12, 6, whites[1], false, rand);
  pieceProp(boxes, 'pawn', wfx + 38, wfz - 8, 1.4, '#f5efdf');

  // --- Blackmoor (slate city, E-center) with rook towers ---
  const darks = ['#5d6273', '#4e5364', '#6a7086'];
  const bmx = 5.2 * TILE, bmz = 2.0 * TILE;
  building(boxes, bmx, bmz, 14, 14, 14, darks[0], true, rand);          // tower 1
  building(boxes, bmx + 26, bmz + 4, 14, 14, 18, darks[1], true, rand); // tower 2 (tallest)
  building(boxes, bmx + 6, bmz + 28, 12, 10, 8, darks[2], false, rand);
  building(boxes, bmx + 30, bmz + 30, 10, 12, 10, darks[0], true, rand);
  building(boxes, bmx - 22, bmz + 12, 10, 10, 7, darks[1], false, rand);
  building(boxes, bmx + 52, bmz + 16, 12, 10, 8, darks[2], false, rand);
  pieceProp(boxes, 'rook', bmx - 14, bmz + 34, 1.6, '#454a5c');

  // --- The Cathedral (center) ---
  const cx = 4 * TILE, cz = 4 * TILE;
  building(boxes, cx - 12, cz - 14, 18, 16, 10, '#d9cdb4', true, rand);
  boxes.push(box(cx - 12, groundAt(cx - 12, cz - 14) + 10 + 9, cz - 14, 6, 18, 6, 'spire', '#cbbd9f')); // bishop spire
  pieceProp(boxes, 'bishop', cx + 14, cz + 10, 1.8, '#e3d8c0');
  pieceProp(boxes, 'knight', cx + 26, cz - 16, 1.5, '#d6c9ad');

  // --- scattered monuments for cover ---
  const types = ['pawn', 'rook', 'bishop', 'knight'];
  for (let i = 0; i < 9; i++) {
    const px = 40 + rand() * (WORLD - 80);
    const pz = 40 + rand() * (WORLD - 80);
    // keep monuments out of the towns and cathedral
    if ((Math.abs(px - wfx - 24) < 50 && Math.abs(pz - wfz - 15) < 40) ||
        (Math.abs(px - bmx - 15) < 60 && Math.abs(pz - bmz - 15) < 50) ||
        (Math.abs(px - cx) < 45 && Math.abs(pz - cz) < 40)) continue;
    pieceProp(boxes, types[Math.floor(rand() * 4)], px, pz, 1.1 + rand() * 0.7,
      rand() < 0.5 ? '#e9dfc8' : '#5b6072');
  }

  const spawns = [
    { x: 0.5 * TILE, z: 0.5 * TILE }, { x: 7.5 * TILE, z: 7.5 * TILE },
    { x: 7.5 * TILE, z: 0.5 * TILE }, { x: 0.5 * TILE, z: 7.5 * TILE },
  ].map((s) => ({ x: s.x, y: tileHeight(Math.floor(s.x / TILE), Math.floor(s.z / TILE)), z: s.z }));

  return { seed, boxes, spawns };
}

// ---------------------------------------------------------------------------
// Collision / query helpers (shared by server sim, bots and client physics)
// ---------------------------------------------------------------------------

export function pointInBox(b, x, y, z, pad = 0) {
  return Math.abs(x - b.x) <= b.sx / 2 + pad &&
         Math.abs(y - b.y) <= b.sy / 2 + pad &&
         Math.abs(z - b.z) <= b.sz / 2 + pad;
}

// Highest standable surface at (x,z) that is at or below `belowY + step`.
export function supportHeight(world, x, z, belowY, step = 0.65) {
  let h = groundAt(x, z);
  for (const b of world.boxes) {
    const top = b.y + b.sy / 2;
    if (top > belowY + step) continue;
    if (Math.abs(x - b.x) <= b.sx / 2 + 0.45 && Math.abs(z - b.z) <= b.sz / 2 + 0.45 && top > h) {
      h = top;
    }
  }
  return h;
}

// Segment vs world boxes - returns the fraction t (0..1) of first hit, or 1.
export function raycast(world, ox, oy, oz, dx, dy, dz, maxDist) {
  let best = 1;
  for (const b of world.boxes) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, maxDist, b);
    if (t !== null && t < best) best = t;
  }
  // terrain: cheap sampling every 2m for height intersection
  const steps = Math.ceil(maxDist / 2);
  for (let i = 1; i <= steps; i++) {
    const t = (i * 2) / maxDist;
    if (t >= best) break;
    const y = oy + dy * maxDist * t;
    const g = groundAt(ox + dx * maxDist * t, oz + dz * maxDist * t);
    if (y <= g) { best = Math.min(best, t); break; }
  }
  return best;
}

function rayBox(ox, oy, oz, dx, dy, dz, maxDist, b) {
  let tmin = 0, tmax = maxDist;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [b.x - b.sx / 2, b.y - b.sy / 2, b.z - b.sz / 2];
  const hi = [b.x + b.sx / 2, b.y + b.sy / 2, b.z + b.sz / 2];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - o[i]) / d[i];
      let t2 = (hi[i] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin / maxDist;
}

// Is the horizontal direction aligned with a board diagonal / axis?
// Returns 'diag', 'line', or null. Tolerance in radians.
export function lineAlignment(dx, dz, tol = 0.14) {
  const ang = Math.atan2(dz, dx);
  const eighth = Math.PI / 4;
  const nearest = Math.round(ang / eighth) * eighth;
  if (Math.abs(ang - nearest) > tol) return null;
  const idx = ((Math.round(nearest / eighth) % 8) + 8) % 8;
  return idx % 2 === 0 ? 'line' : 'diag';
}
