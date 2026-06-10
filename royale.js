// Royale mode - server simulation for "The Board", the chess FPS battle
// royale. Movement is client-driven (friends-scale trust) with bounds
// checks; combat, items, zone, abilities and win logic are authoritative.
//
// Chess identity:
//  - True Lines: shots aligned with board ranks/files ('line') or diagonals
//    ('diag') get weapon-specific damage bonuses.
//  - Knight's Leap: L-shaped blink (over walls), 3 charges per knight.
//  - Castling: plant a rook banner, later swap positions with it.
//  - En passant dodge: short immunity window; dodged shots are announced.
//  - The board is the zone: outer tile rings sink into the void.
//  - Promotion: hold a pawn on the glowing promotion square to gain a queen.
//  - Kills are CHECKMATEs. Last crown standing wins.

import {
  TILE, BOARD, WORLD, buildWorld, groundAt, tileRing, raycast, lineAlignment,
  pointInBox,
} from './public/map.js';

const TICK_MS = 50;            // 20Hz sim
const SNAP_EVERY = 2;          // ~10Hz snapshots
const PLAYER_R = 0.7;          // body radius
const PLAYER_H = 1.8;
const EYE = 1.6;
const HP_MAX = 100;
const REGEN_AFTER_MS = 5000;
const REGEN_PER_S = 4;
const OFFBOARD_DPS = 20;
const PICKUP_R = 3.2;
const DODGE_IMMUNE_MS = 350;
const DODGE_CD_MS = 4000;
const LEAP_CHARGES = 3;
const LEAP_RANGE = 26;         // ~2 squares + 1 sideways at world scale
const CASTLE_CD_MS = 3000;
const PROMO_CHANNEL_MS = 2000;

const FAST = !!process.env.SBC_ROYALE_FAST;
const T = (ms) => (FAST ? Math.max(15000, ms / 8) : ms);

export const WEAPONS = {
  fists:  { dmg: 20, cd: 500, kind: 'melee', range: 3.2 },
  pawn:   { dmg: 15, cd: 320, kind: 'proj', speed: 75, range: 90, projR: 0.4, bonus: null },
  bishop: { dmg: 38, cd: 1300, kind: 'hitscan', range: 320, bonus: 'diag', bonusDmg: 24 },
  rook:   { dmg: 45, cd: 1600, kind: 'proj', speed: 45, range: 200, projR: 0.7, splash: 4.5, bonus: 'line', bonusDmg: 25 },
  queen:  { dmg: 32, cd: 480, kind: 'hitscan', range: 260, bonus: 'both', bonusDmg: 16 },
};

const SHRINKS = () => [
  { warnAt: T(60000), fallAt: T(80000) },
  { warnAt: T(130000), fallAt: T(150000) },
  { warnAt: T(200000), fallAt: T(220000) },
];
const SUPPLY_EVERY = () => T(45000);
const PROMO_MOVE_EVERY = () => T(40000);

let nextEntId = 1;

// ---------------------------------------------------------------------------
// Match setup
// ---------------------------------------------------------------------------

function outdoorPoint(world, rand, marginTiles = 0.8) {
  for (let tries = 0; tries < 40; tries++) {
    const x = TILE * marginTiles + rand() * (WORLD - TILE * marginTiles * 2);
    const z = TILE * marginTiles + rand() * (WORLD - TILE * marginTiles * 2);
    const y = groundAt(x, z) + 0.5;
    let inside = false;
    for (const b of world.boxes) {
      if (b.kind !== 'prop' && pointInBox(b, x, y + 1, z, 1.2)) { inside = true; break; }
    }
    if (!inside) return { x, y: groundAt(x, z), z };
  }
  return { x: WORLD / 2, y: groundAt(WORLD / 2, WORLD / 2), z: WORLD / 2 };
}

export function createMatch(room, playerList, startsAt, hooks) {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const world = buildWorld(seed);
  const rand = (() => { let s = seed ^ 0x9e3779b9; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();

  const players = new Map();
  playerList.forEach((p, i) => {
    const sp = world.spawns[i % world.spawns.length];
    players.set(p.id, {
      id: p.id, name: p.name, isBot: !!p.isBot, level: p.level || 5, color: i % 4,
      x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0,
      hp: HP_MAX, weapon: null, dead: false,
      cdReadyAt: 0, lastHurtAt: 0, lastPosAt: 0,
      leapCharges: 0, banner: null, castleReadyAt: 0,
      immuneUntil: 0, dodgeReadyAt: 0,
      promoMs: 0, check: false, place: 0,
      botThinkAt: 0, botGoal: null, botStuck: 0,
    });
  });

  // initial loot, scattered outdoors
  const items = new Map();
  const lootTable = ['pawn', 'pawn', 'pawn', 'pawn', 'bishop', 'bishop', 'rook', 'rook',
    'knight', 'knight', 'banner', 'banner', 'crown', 'crown'];
  for (const type of lootTable) {
    const pt = outdoorPoint(world, rand);
    items.set('i' + nextEntId, { id: 'i' + nextEntId++, type, x: pt.x, y: pt.y, z: pt.z });
  }

  const m = {
    room, hooks, world, seed, players, items,
    projectiles: [],
    crates: [],
    events: [],
    startsAt,
    fallen: 0,
    shrinks: SHRINKS(),
    nextSupplyAt: startsAt + SUPPLY_EVERY(),
    promo: { ...outdoorPoint(world, rand), movedAt: startsAt },
    rand,
    deathOrder: [],
    finished: false,
    tickCount: 0,
    lastTick: Date.now(),
    interval: null,
  };
  m.interval = setInterval(() => tick(m), TICK_MS);
  return m;
}

export function destroyMatch(m) {
  if (m?.interval) clearInterval(m.interval);
}

export function startPayload(m) {
  return {
    seed: m.seed,
    players: [...m.players.values()].map((p) => ({
      id: p.id, name: p.name, isBot: p.isBot, color: p.color, x: p.x, y: p.y, z: p.z,
    })),
    items: [...m.items.values()],
    promo: { x: m.promo.x, z: m.promo.z },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSafeTile(x, z, fallen) {
  const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
  if (tx < 0 || tx >= BOARD || tz < 0 || tz >= BOARD) return false;
  return tileRing(tx, tz) >= fallen;
}

function losClear(m, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.01) return true;
  return raycast(m.world, ax, ay, az, dx / dist, dy / dist, dz / dist, dist) >= 0.999;
}

function dirOf(p) {
  const cp = Math.cos(p.pitch);
  return { x: Math.cos(p.yaw) * cp, y: Math.sin(p.pitch), z: Math.sin(p.yaw) * cp };
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

export function handleInput(m, playerId, msg) {
  const p = m.players.get(playerId);
  if (!p || p.dead) return;
  const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
    p.x = Math.max(0, Math.min(WORLD, x));
    p.z = Math.max(0, Math.min(WORLD, z));
    p.y = Math.max(groundAt(p.x, p.z) - 0.5, Math.min(120, y));
    p.lastPosAt = Date.now();
  }
  if (Number.isFinite(Number(msg.yaw))) p.yaw = Number(msg.yaw);
  if (Number.isFinite(Number(msg.pitch))) p.pitch = Math.max(-1.55, Math.min(1.55, Number(msg.pitch)));
}

function applyDamage(m, target, dmg, from, label) {
  if (target.dead || m.finished) return;
  const now = Date.now();
  if (now < target.immuneUntil) {
    m.events.push({ k: 'dodged', id: target.id, by: from?.id || null });
    return;
  }
  target.lastHurtAt = now;
  target.hp -= dmg;
  m.events.push({ k: 'hit', id: target.id, by: from?.id || null, dmg, label: label || null });
  if (target.hp <= 0) {
    target.hp = 0;
    target.dead = true;
    m.deathOrder.push(target.id);
    if (target.weapon && target.weapon !== 'fists') {
      const drop = { id: 'i' + nextEntId++, type: target.weapon, x: target.x, y: groundAt(target.x, target.z), z: target.z };
      m.items.set(drop.id, drop);
      target.weapon = null;
    }
    m.events.push({ k: 'kill', id: target.id, by: from?.id || null, label: label || null });
  }
}

export function handleAttack(m, playerId, msg = {}) {
  const p = m.players.get(playerId);
  const now = Date.now();
  if (!p || p.dead || m.finished || now < m.startsAt || now < p.cdReadyAt) return;

  const d = dirOf(p);
  const ox = p.x, oy = p.y + EYE, oz = p.z;
  const weapon = p.weapon && WEAPONS[p.weapon] ? p.weapon : 'fists';
  const w = WEAPONS[weapon];
  p.cdReadyAt = now + w.cd;

  const align = lineAlignment(d.x, d.z);
  const bonusOn = w.bonus && align &&
    (w.bonus === 'both' || w.bonus === align);
  const dmg = w.dmg + (bonusOn ? w.bonusDmg : 0);
  const label = bonusOn ? (align === 'diag' ? 'TRUE DIAGONAL' : 'TRUE LINE') : null;

  if (w.kind === 'melee') {
    m.events.push({ k: 'swing', id: p.id });
    for (const q of m.players.values()) {
      if (q === p || q.dead) continue;
      const dist = Math.hypot(q.x - ox, (q.y + 1) - oy, q.z - oz);
      if (dist < w.range && losClear(m, ox, oy, oz, q.x, q.y + 1, q.z)) {
        applyDamage(m, q, w.dmg, p, null);
      }
    }
    return;
  }

  if (w.kind === 'hitscan') {
    let bestT = raycast(m.world, ox, oy, oz, d.x, d.y, d.z, w.range);
    let victim = null;
    for (const q of m.players.values()) {
      if (q === p || q.dead) continue;
      const t = sphereRayT(ox, oy, oz, d, w.range, q.x, q.y + 1, q.z, PLAYER_R + 0.35);
      if (t !== null && t < bestT) { bestT = t; victim = q; }
    }
    m.events.push({
      k: 'tracer', id: p.id, type: weapon,
      x: ox, y: oy, z: oz, tx: ox + d.x * w.range * bestT, ty: oy + d.y * w.range * bestT, tz: oz + d.z * w.range * bestT,
      bonus: !!bonusOn,
    });
    if (victim) applyDamage(m, victim, dmg, p, label);
    return;
  }

  // projectile
  m.projectiles.push({
    id: 'pr' + nextEntId++, type: weapon, owner: p.id,
    x: ox + d.x * 1.2, y: oy + d.y * 1.2, z: oz + d.z * 1.2,
    dx: d.x, dy: d.y, dz: d.z,
    traveled: 0, dmg, label, bonus: !!bonusOn,
  });
  m.events.push({ k: 'shoot', id: p.id, type: weapon });
}

function sphereRayT(ox, oy, oz, d, maxDist, cx, cy, cz, r) {
  const fx = ox - cx, fy = oy - cy, fz = oz - cz;
  const b = 2 * (fx * d.x + fy * d.y + fz * d.z);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / 2;
  if (t < 0 || t > maxDist) return null;
  return t / maxDist;
}

export function handlePickup(m, playerId) {
  const p = m.players.get(playerId);
  if (!p || p.dead || m.finished) return;
  let nearest = null, nd = PICKUP_R;
  for (const it of m.items.values()) {
    const dd = Math.hypot(it.x - p.x, it.y - p.y, it.z - p.z);
    if (dd < nd) { nd = dd; nearest = it; }
  }
  if (!nearest) return;
  takeItem(m, p, nearest);
}

function takeItem(m, p, it) {
  if (it.type === 'crown') {
    if (p.hp >= HP_MAX) return;
    p.hp = Math.min(HP_MAX, p.hp + 50);
    m.items.delete(it.id);
    m.events.push({ k: 'heal', id: p.id });
    return;
  }
  if (it.type === 'knight') {
    p.leapCharges = Math.min(LEAP_CHARGES + 2, p.leapCharges + LEAP_CHARGES);
    m.items.delete(it.id);
    m.events.push({ k: 'pickup', id: p.id, type: 'knight' });
    return;
  }
  if (it.type === 'banner') {
    if (p.banner === 'stored' || p.banner) return;
    p.banner = 'stored';
    m.items.delete(it.id);
    m.events.push({ k: 'pickup', id: p.id, type: 'banner' });
    return;
  }
  // weapons swap
  if (p.weapon && p.weapon !== 'fists') {
    const drop = { id: 'i' + nextEntId++, type: p.weapon, x: p.x, y: groundAt(p.x, p.z), z: p.z };
    m.items.set(drop.id, drop);
  }
  p.weapon = it.type;
  m.items.delete(it.id);
  m.events.push({ k: 'pickup', id: p.id, type: it.type });
}

// Knight's Leap: client proposes a target; server validates range & charge.
export function handleLeap(m, playerId, msg) {
  const p = m.players.get(playerId);
  if (!p || p.dead || m.finished || Date.now() < m.startsAt) return;
  if (p.leapCharges <= 0) return;
  const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (Math.hypot(x - p.x, z - p.z) > LEAP_RANGE + 2 || Math.abs(y - p.y) > 25) return;
  p.leapCharges--;
  m.events.push({ k: 'leap', id: p.id, fx: p.x, fy: p.y, fz: p.z, tx: x, ty: y, tz: z });
  p.x = Math.max(0, Math.min(WORLD, x));
  p.z = Math.max(0, Math.min(WORLD, z));
  p.y = Math.max(groundAt(p.x, p.z), Math.min(120, y));
}

// Castling: first press plants the banner, second press swaps with it.
export function handleCastle(m, playerId) {
  const p = m.players.get(playerId);
  const now = Date.now();
  if (!p || p.dead || m.finished || now < m.startsAt || now < p.castleReadyAt) return;
  if (p.banner === 'stored') {
    p.banner = { x: p.x, y: p.y, z: p.z };
    p.castleReadyAt = now + CASTLE_CD_MS;
    m.events.push({ k: 'banner', id: p.id, x: p.x, y: p.y, z: p.z });
    return;
  }
  if (p.banner && typeof p.banner === 'object') {
    const b = p.banner;
    m.events.push({ k: 'castle', id: p.id, fx: p.x, fy: p.y, fz: p.z, tx: b.x, ty: b.y, tz: b.z });
    p.x = b.x; p.y = b.y; p.z = b.z;
    p.banner = null;
    p.castleReadyAt = now + CASTLE_CD_MS;
  }
}

// En passant dodge: brief immunity, client handles the dash itself.
export function handleDodge(m, playerId) {
  const p = m.players.get(playerId);
  const now = Date.now();
  if (!p || p.dead || m.finished || now < m.startsAt || now < p.dodgeReadyAt) return;
  p.immuneUntil = now + DODGE_IMMUNE_MS;
  p.dodgeReadyAt = now + DODGE_CD_MS;
  m.events.push({ k: 'dodge', id: p.id });
}

export function playerLeft(m, playerId) {
  const p = m.players.get(playerId);
  if (p && !p.dead) {
    p.dead = true;
    p.hp = 0;
    m.deathOrder.push(p.id);
    m.events.push({ k: 'left', id: p.id });
  }
}

// ---------------------------------------------------------------------------
// Bots: roam outdoors, loot, take aligned shots, flee the void.
// ---------------------------------------------------------------------------

function botThink(m, p, now, dt) {
  // movement toward goal with crude box avoidance
  const speed = 8;
  const arrive = (gx, gz) => Math.hypot(gx - p.x, gz - p.z) < 3;

  if (!isSafeTile(p.x, p.z, m.fallen)) {
    p.botGoal = { x: WORLD / 2, z: WORLD / 2 };
  }

  const enemies = [...m.players.values()].filter((q) => !q.dead && q !== p);
  let target = null;
  for (const e of enemies) {
    if (!target || Math.hypot(e.x - p.x, e.z - p.z) < Math.hypot(target.x - p.x, target.z - p.z)) target = e;
  }

  if (now >= p.botThinkAt) {
    p.botThinkAt = now + 500 - p.level * 25;
    if (!p.weapon) {
      let best = null, bd = Infinity;
      for (const it of m.items.values()) {
        if (it.type === 'crown' || it.type === 'banner') continue;
        const dd = Math.hypot(it.x - p.x, it.z - p.z);
        if (dd < bd) { bd = dd; best = it; }
      }
      p.botGoal = best ? { x: best.x, z: best.z, item: best.id } : p.botGoal;
    } else if (target) {
      const dd = Math.hypot(target.x - p.x, target.z - p.z);
      const stand = p.weapon === 'pawn' ? 18 : 45;
      if (dd > stand) p.botGoal = { x: target.x, z: target.z };
      else if (!p.botGoal || arrive(p.botGoal.x, p.botGoal.z)) {
        p.botGoal = { x: p.x + (m.rand() - 0.5) * 30, z: p.z + (m.rand() - 0.5) * 30 };
      }
    }
    if (!p.botGoal || arrive(p.botGoal.x, p.botGoal.z)) {
      const pt = outdoorPoint(m.world, m.rand, m.fallen + 0.8);
      p.botGoal = { x: pt.x, z: pt.z };
    }
  }

  // walk
  if (p.botGoal) {
    let gx = p.botGoal.x - p.x, gz = p.botGoal.z - p.z;
    const len = Math.hypot(gx, gz) || 1;
    gx /= len; gz /= len;
    let nx = p.x + gx * speed * dt;
    let nz = p.z + gz * speed * dt;
    // crude avoidance: if the step lands inside a wall, slide perpendicular
    let blocked = false;
    for (const b of m.world.boxes) {
      if (b.sy > 1.2 && pointInBox(b, nx, p.y + 1, nz, PLAYER_R)) { blocked = true; break; }
    }
    if (blocked) {
      const px = -gz, pz = gx;
      const side = p.botStuck % 2 === 0 ? 1 : -1;
      nx = p.x + px * side * speed * dt;
      nz = p.z + pz * side * speed * dt;
      p.botStuck++;
      let still = false;
      for (const b of m.world.boxes) {
        if (b.sy > 1.2 && pointInBox(b, nx, p.y + 1, nz, PLAYER_R)) { still = true; break; }
      }
      if (still) { nx = p.x; nz = p.z; }
    }
    p.x = Math.max(2, Math.min(WORLD - 2, nx));
    p.z = Math.max(2, Math.min(WORLD - 2, nz));
    p.y = groundAt(p.x, p.z);
    if (p.botGoal.item) {
      const it = m.items.get(p.botGoal.item);
      if (it && Math.hypot(it.x - p.x, it.z - p.z) < PICKUP_R * 0.9) takeItem(m, p, it);
      if (!m.items.has(p.botGoal.item)) p.botGoal = null;
    }
  }

  // aim & shoot
  if (target) {
    const dx = target.x - p.x, dz = target.z - p.z;
    const err = (11 - p.level) * 0.02 * (m.rand() - 0.5);
    p.yaw = Math.atan2(dz, dx) + err;
    const dist = Math.hypot(dx, dz);
    p.pitch = Math.atan2((target.y + 1) - (p.y + EYE), dist) + err;
    const w = p.weapon ? WEAPONS[p.weapon] : WEAPONS.fists;
    const inRange = w.kind === 'melee' ? dist < w.range : dist < (w.range || 60) * 0.85;
    if (inRange && losClear(m, p.x, p.y + EYE, p.z, target.x, target.y + 1, target.z)) {
      if (m.rand() < 0.10 + p.level * 0.05) handleAttack(m, p.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function tick(m) {
  const now = Date.now();
  const dt = Math.min(0.12, (now - m.lastTick) / 1000);
  m.lastTick = now;
  m.tickCount++;
  if (m.finished) return;
  const live = now >= m.startsAt;

  // zone
  for (let i = 0; i < m.shrinks.length; i++) {
    const s = m.shrinks[i];
    if (!s.warned && now >= m.startsAt + s.warnAt) {
      s.warned = true;
      m.events.push({ k: 'warn', ring: i });
    }
    if (!s.fell && now >= m.startsAt + s.fallAt) {
      s.fell = true;
      m.fallen = i + 1;
      m.events.push({ k: 'fall', ring: i, fallen: m.fallen });
    }
  }

  // supply crates
  if (live && now >= m.nextSupplyAt) {
    m.nextSupplyAt = now + SUPPLY_EVERY();
    const pt = outdoorPoint(m.world, m.rand, m.fallen + 0.6);
    const types = ['bishop', 'rook', 'knight', 'queen', 'crown', 'banner'];
    const loot = [types[Math.floor(m.rand() * types.length)], m.rand() < 0.35 ? 'queen' : 'crown'];
    m.crates.push({ id: 'c' + nextEntId++, x: pt.x, z: pt.z, y: 120, groundY: pt.y, loot, landed: false });
    m.events.push({ k: 'supply', x: pt.x, z: pt.z });
  }
  for (let i = m.crates.length - 1; i >= 0; i--) {
    const c = m.crates[i];
    c.y -= 12 * dt;
    if (c.y <= c.groundY) {
      for (const type of c.loot) {
        const off = () => (m.rand() - 0.5) * 4;
        m.items.set('i' + nextEntId, { id: 'i' + nextEntId++, type, x: c.x + off(), y: c.groundY, z: c.z + off() });
      }
      m.events.push({ k: 'crateland', x: c.x, z: c.z });
      m.crates.splice(i, 1);
    }
  }

  // promotion square relocation
  if (live && now - m.promo.movedAt >= PROMO_MOVE_EVERY()) {
    m.promo = { ...outdoorPoint(m.world, m.rand, m.fallen + 0.6), movedAt: now };
    m.events.push({ k: 'promomove', x: m.promo.x, z: m.promo.z });
  }

  for (const p of m.players.values()) {
    if (p.dead) continue;
    if (p.isBot && live) botThink(m, p, now, dt);

    // off-board drain + regen
    if (live && !isSafeTile(p.x, p.z, m.fallen)) {
      p.lastHurtAt = now;
      p.hp -= OFFBOARD_DPS * dt;
      if (p.hp <= 0) {
        p.hp = 0;
        p.dead = true;
        m.deathOrder.push(p.id);
        m.events.push({ k: 'kill', id: p.id, by: null, zone: true });
      }
    } else if (live && p.hp < HP_MAX && now - p.lastHurtAt > REGEN_AFTER_MS) {
      p.hp = Math.min(HP_MAX, p.hp + REGEN_PER_S * dt);
    }

    // promotion channel
    if (live && p.weapon === 'pawn' &&
        Math.hypot(p.x - m.promo.x, p.z - m.promo.z) < 5 && Math.abs(p.y - groundAt(m.promo.x, m.promo.z)) < 3) {
      p.promoMs += dt * 1000;
      if (p.promoMs >= PROMO_CHANNEL_MS) {
        p.weapon = 'queen';
        p.promoMs = 0;
        m.events.push({ k: 'promote', id: p.id });
      }
    } else {
      p.promoMs = 0;
    }
  }

  // projectiles
  for (let i = m.projectiles.length - 1; i >= 0; i--) {
    const pr = m.projectiles[i];
    const w = WEAPONS[pr.type];
    const step = w.speed * dt;
    const t = raycast(m.world, pr.x, pr.y, pr.z, pr.dx, pr.dy, pr.dz, step);
    pr.x += pr.dx * step * t;
    pr.y += pr.dy * step * t;
    pr.z += pr.dz * step * t;
    pr.traveled += step * t;
    let boom = t < 0.999 || pr.traveled >= w.range || pr.y <= groundAt(pr.x, pr.z);
    let directHit = null;
    if (!boom) {
      for (const q of m.players.values()) {
        if (q.dead || q.id === pr.owner) continue;
        if (Math.hypot(q.x - pr.x, (q.y + 1) - pr.y, q.z - pr.z) < PLAYER_R + (w.projR || 0.4) + 0.3) {
          directHit = q;
          boom = true;
          break;
        }
      }
    }
    if (boom) {
      const from = m.players.get(pr.owner);
      if (directHit) applyDamage(m, directHit, pr.dmg, from, pr.label);
      if (w.splash) {
        m.events.push({ k: 'boom', x: pr.x, y: pr.y, z: pr.z });
        for (const q of m.players.values()) {
          if (q.dead || q === directHit) continue;
          const dd = Math.hypot(q.x - pr.x, (q.y + 1) - pr.y, q.z - pr.z);
          if (dd < w.splash && q.id !== pr.owner) {
            applyDamage(m, q, Math.round(pr.dmg * (1 - dd / w.splash)), from, pr.label);
          }
        }
      }
      m.projectiles.splice(i, 1);
    }
  }

  // CHECK! - enemy armed, has LOS, and is aiming near you
  if (m.tickCount % 8 === 0) {
    for (const p of m.players.values()) {
      if (p.dead) { p.check = false; continue; }
      p.check = false;
      for (const e of m.players.values()) {
        if (e === p || e.dead || !e.weapon || e.weapon === 'fists') continue;
        const dx = p.x - e.x, dy = (p.y + 1) - (e.y + EYE), dz = p.z - e.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 110) continue;
        const d = dirOf(e);
        const dot = (dx * d.x + dy * d.y + dz * d.z) / dist;
        if (dot < 0.975) continue;
        if (losClear(m, e.x, e.y + EYE, e.z, p.x, p.y + 1, p.z)) { p.check = true; break; }
      }
    }
  }

  // win condition
  const alive = [...m.players.values()].filter((p) => !p.dead);
  if (live && alive.length <= 1) {
    m.finished = true;
    const winner = alive[0] || null;
    if (winner) m.deathOrder.push(winner.id);
    const order = [...m.deathOrder].reverse();
    const placements = order.map((id, idx) => {
      const pl = m.players.get(id);
      return { id, name: pl.name, isBot: pl.isBot, place: idx + 1 };
    });
    m.hooks.broadcast(snapshot(m));
    setTimeout(() => m.hooks.finish(winner ? { id: winner.id, name: winner.name } : null, placements), 1200);
    return;
  }

  if (m.tickCount % SNAP_EVERY === 0) m.hooks.broadcast(snapshot(m));
}

function snapshot(m) {
  const now = Date.now();
  const nextShrink = m.shrinks.find((s) => !s.fell);
  return {
    t: 'bs',
    players: [...m.players.values()].map((p) => ({
      id: p.id,
      x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10,
      yaw: Math.round(p.yaw * 100) / 100, pitch: Math.round(p.pitch * 100) / 100,
      hp: Math.round(p.hp), weapon: p.weapon, dead: p.dead, check: p.check,
      cd: Math.max(0, p.cdReadyAt - now),
      leap: p.leapCharges,
      banner: typeof p.banner === 'object' && p.banner ? { x: p.banner.x, y: p.banner.y, z: p.banner.z } : p.banner,
      dodgeCd: Math.max(0, p.dodgeReadyAt - now),
      promo: p.promoMs > 0,
    })),
    projectiles: m.projectiles.map((pr) => ({
      id: pr.id, type: pr.type,
      x: Math.round(pr.x * 10) / 10, y: Math.round(pr.y * 10) / 10, z: Math.round(pr.z * 10) / 10,
    })),
    items: [...m.items.values()],
    crates: m.crates.map((c) => ({ id: c.id, x: c.x, y: Math.round(c.y * 10) / 10, z: c.z })),
    fallen: m.fallen,
    warnRing: m.shrinks.findIndex((s) => s.warned && !s.fell),
    shrinkIn: nextShrink ? Math.max(0, m.startsAt + nextShrink.fallAt - now) : null,
    promo: { x: m.promo.x, z: m.promo.z },
    events: m.events.splice(0),
  };
}
