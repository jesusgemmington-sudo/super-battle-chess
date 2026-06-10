// Royale mode - server-side simulation for Super Battle Chess.
//
// Every player is a King on a giant 8x8 board. Chess pieces fall from supply
// boxes and act as weapons that fire along their chess movement lines:
// bishops snipe diagonals, rooks cannon ranks/files, queens get all eight,
// pawns are short daggers, and knights are rideable mounts with an L-shaped
// trample dash. The board itself is the shrinking zone (outer rings fall
// away), standing in an enemy's firing line shows CHECK!, and carrying a pawn
// onto the glowing promotion rank upgrades it into a queen. Last crown
// standing wins; kills are CHECKMATEs.

export const TILE = 100;
export const BOARD = 8;
export const WORLD = TILE * BOARD;

const TICK_MS = 33;
const SNAP_EVERY = 2; // snapshot every 2 ticks (~15Hz)
const PLAYER_R = 18;
const SPEED = 175;
const MOUNT_SPEED = 285;
const HP_MAX = 100;
const HORSE_HP = 70;
const REGEN_AFTER_MS = 4000;
const REGEN_PER_S = 3;
const OFFBOARD_DPS = 14;
const PICKUP_R = 46;

const FAST = !!process.env.SBC_ROYALE_FAST; // shortened timers for tests
const T = (ms) => (FAST ? Math.max(1500, ms / 8) : ms);

export const WEAPONS = {
  melee:  { dmg: 24, cd: 600, range: 60 },
  pawn:   { dmg: 18, cd: 450, range: 270, speed: 500, snap: null,    projR: 10 },
  bishop: { dmg: 42, cd: 1100, range: 720, speed: 780, snap: 'diag',  projR: 9 },
  rook:   { dmg: 55, cd: 1400, range: 620, speed: 430, snap: 'ortho', projR: 15 },
  queen:  { dmg: 40, cd: 500, range: 660, speed: 660, snap: 'eight', projR: 10 },
};
const DASH = { dmg: 40, cd: 1100, speed: 760 };

const SHRINKS = () => [
  { warnAt: T(35000), fallAt: T(50000) },
  { warnAt: T(80000), fallAt: T(95000) },
  { warnAt: T(125000), fallAt: T(140000) },
];
const SUPPLY_EVERY = () => T(40000);
const PROMO_MOVE_EVERY = () => T(30000);
const PROMO_CHANNEL_MS = 1500;

// ---------------------------------------------------------------------------
// Geometry helpers (exported for tests)
// ---------------------------------------------------------------------------

const DIAG = [45, 135, 225, 315].map((d) => (d * Math.PI) / 180);
const ORTHO = [0, 90, 180, 270].map((d) => (d * Math.PI) / 180);
const EIGHT = [...ORTHO, ...DIAG];

function angDiff(a, b) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

export function snapDir(dx, dy, mode) {
  const ang = Math.atan2(dy, dx);
  if (!mode) {
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }
  const set = mode === 'diag' ? DIAG : mode === 'ortho' ? ORTHO : EIGHT;
  let best = set[0];
  for (const a of set) if (angDiff(ang, a) < angDiff(ang, best)) best = a;
  return { x: Math.cos(best), y: Math.sin(best) };
}

// Is `target` standing in `shooter`'s firing line (CHECK)?
export function inFiringLine(shooter, target, weapon) {
  const w = WEAPONS[weapon];
  if (!w || !w.speed) return false;
  const dx = target.x - shooter.x;
  const dy = target.y - shooter.y;
  const dist = Math.hypot(dx, dy);
  if (dist > w.range || dist < 1) return false;
  if (!w.snap) return dist < w.range * 0.8; // pawns: proximity threat
  const dir = snapDir(dx, dy, w.snap);
  // perpendicular distance from the snapped ray to the target
  const along = dx * dir.x + dy * dir.y;
  if (along <= 0) return false;
  const perp = Math.abs(dx * dir.y - dy * dir.x);
  return perp < PLAYER_R * 1.8;
}

export function tileRing(tx, ty) {
  return Math.min(tx, ty, BOARD - 1 - tx, BOARD - 1 - ty);
}

export function isSafe(x, y, fallen) {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || tx >= BOARD || ty < 0 || ty >= BOARD) return false;
  return tileRing(tx, ty) >= fallen;
}

// ---------------------------------------------------------------------------
// Match setup
// ---------------------------------------------------------------------------

let nextEntId = 1;

function scatterItems(types, cx, cy, spread) {
  const items = [];
  for (const type of types) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * spread;
    const x = Math.min(WORLD - 40, Math.max(40, cx + Math.cos(ang) * dist));
    const y = Math.min(WORLD - 40, Math.max(40, cy + Math.sin(ang) * dist));
    items.push({
      id: 'i' + nextEntId++,
      type, x, y,
      delay: 300 + Math.random() * 900,
    });
  }
  return items;
}

const SPAWNS = [
  { x: TILE * 1.5, y: TILE * 1.5 }, { x: WORLD - TILE * 1.5, y: WORLD - TILE * 1.5 },
  { x: WORLD - TILE * 1.5, y: TILE * 1.5 }, { x: TILE * 1.5, y: WORLD - TILE * 1.5 },
];

export function createMatch(room, playerList, startsAt, hooks) {
  const players = new Map();
  playerList.forEach((p, i) => {
    players.set(p.id, {
      id: p.id, name: p.name, isBot: !!p.isBot, level: p.level || 5, color: i % 4,
      x: SPAWNS[i % 4].x, y: SPAWNS[i % 4].y,
      mvx: 0, mvy: 0, aimx: WORLD / 2, aimy: WORLD / 2,
      hp: HP_MAX, weapon: null, mounted: false, horseHp: 0,
      cdReadyAt: 0, lastHurtAt: 0, dead: false, place: 0,
      dash: null, promoMs: 0, check: false,
      botThinkAt: 0, botAttackSlop: (11 - (p.level || 5)) * 0.035,
    });
  });

  const initialTypes = ['pawn', 'pawn', 'pawn', 'pawn', 'bishop', 'bishop', 'rook', 'rook', 'knight', 'knight', 'crown'];
  const items = new Map();
  for (const it of scatterItems(initialTypes, WORLD / 2, WORLD / 2, 260)) {
    it.activeAt = startsAt + 900 + it.delay;
    items.set(it.id, it);
  }

  const m = {
    room, hooks, players, items,
    projectiles: [],
    events: [],
    startsAt,
    fallen: 0,
    shrinks: SHRINKS(),
    nextSupplyAt: startsAt + SUPPLY_EVERY(),
    promo: { side: Math.floor(Math.random() * 4), movedAt: startsAt },
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
    world: { tile: TILE, board: BOARD },
    items: [...m.items.values()].map((i) => ({ id: i.id, type: i.type, x: i.x, y: i.y, delay: i.delay })),
    players: [...m.players.values()].map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, color: p.color, x: p.x, y: p.y })),
  };
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

export function handleInput(m, playerId, msg) {
  const p = m.players.get(playerId);
  if (!p || p.dead) return;
  const mx = Number(msg.mx), my = Number(msg.my);
  if (Number.isFinite(mx) && Number.isFinite(my)) {
    const len = Math.hypot(mx, my);
    p.mvx = len > 1 ? mx / len : mx;
    p.mvy = len > 1 ? my / len : my;
  }
  const ax = Number(msg.ax), ay = Number(msg.ay);
  if (Number.isFinite(ax) && Number.isFinite(ay)) {
    p.aimx = Math.max(0, Math.min(WORLD, ax));
    p.aimy = Math.max(0, Math.min(WORLD, ay));
  }
}

export function handleAttack(m, playerId) {
  const p = m.players.get(playerId);
  const now = Date.now();
  if (!p || p.dead || m.finished || now < m.startsAt || now < p.cdReadyAt || p.dash) return;

  const adx = p.aimx - p.x;
  const ady = p.aimy - p.y;

  if (p.mounted) {
    // Knight L-dash: two tiles along the snapped orthogonal, one perpendicular.
    const main = snapDir(adx, ady, 'ortho');
    const residual = { x: adx - (adx * main.x + ady * main.y) * main.x, y: ady - (adx * main.x + ady * main.y) * main.y };
    let side = { x: -main.y, y: main.x };
    if (residual.x * side.x + residual.y * side.y < 0) side = { x: main.y, y: -main.x };
    p.dash = {
      phase: 1,
      dir: main, side,
      remaining: TILE * 2,
      hit: new Set(),
    };
    p.cdReadyAt = now + DASH.cd;
    m.events.push({ k: 'dash', id: p.id });
    return;
  }

  if (!p.weapon || p.weapon === 'crown') {
    // royal melee bonk
    const w = WEAPONS.melee;
    p.cdReadyAt = now + w.cd;
    const dir = snapDir(adx, ady, null);
    const hx = p.x + dir.x * 34;
    const hy = p.y + dir.y * 34;
    m.events.push({ k: 'swing', id: p.id, x: hx, y: hy });
    for (const q of m.players.values()) {
      if (q === p || q.dead) continue;
      if (Math.hypot(q.x - hx, q.y - hy) < w.range) damage(m, q, w.dmg, p);
    }
    return;
  }

  const w = WEAPONS[p.weapon];
  if (!w || !w.speed) return;
  p.cdReadyAt = now + w.cd;
  const dir = snapDir(adx, ady, w.snap);
  m.projectiles.push({
    id: 'pr' + nextEntId++,
    type: p.weapon, owner: p.id,
    x: p.x + dir.x * (PLAYER_R + 6), y: p.y + dir.y * (PLAYER_R + 6),
    dx: dir.x, dy: dir.y,
    traveled: 0,
  });
  m.events.push({ k: 'shoot', id: p.id, type: p.weapon });
}

export function handlePickup(m, playerId) {
  const p = m.players.get(playerId);
  if (!p || p.dead || m.finished) return;
  const now = Date.now();
  let nearest = null;
  let nd = PICKUP_R;
  for (const it of m.items.values()) {
    if (now < it.activeAt) continue;
    const d = Math.hypot(it.x - p.x, it.y - p.y);
    if (d < nd) { nd = d; nearest = it; }
  }
  if (!nearest) return;
  takeItem(m, p, nearest);
}

function takeItem(m, p, it) {
  if (it.type === 'knight') {
    if (p.mounted) return;
    p.mounted = true;
    p.horseHp = HORSE_HP;
    m.items.delete(it.id);
    m.events.push({ k: 'mount', id: p.id });
    return;
  }
  if (it.type === 'crown') {
    if (p.hp >= HP_MAX) return;
    p.hp = Math.min(HP_MAX, p.hp + 50);
    m.items.delete(it.id);
    m.events.push({ k: 'heal', id: p.id });
    return;
  }
  // weapon swap: drop current at feet
  if (p.weapon) {
    const drop = { id: 'i' + nextEntId++, type: p.weapon, x: p.x, y: p.y, delay: 0, activeAt: Date.now() + 800 };
    m.items.set(drop.id, drop);
  }
  p.weapon = it.type;
  m.items.delete(it.id);
  m.events.push({ k: 'pickup', id: p.id, type: it.type });
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
// Simulation
// ---------------------------------------------------------------------------

function damage(m, q, dmg, from) {
  if (q.dead) return;
  q.lastHurtAt = Date.now();
  if (q.mounted) {
    q.horseHp -= dmg;
    m.events.push({ k: 'hit', id: q.id, dmg, horse: true });
    if (q.horseHp <= 0) {
      q.mounted = false;
      m.events.push({ k: 'horsedown', id: q.id });
    }
    return;
  }
  q.hp -= dmg;
  m.events.push({ k: 'hit', id: q.id, dmg });
  if (q.hp <= 0) {
    q.hp = 0;
    q.dead = true;
    m.deathOrder.push(q.id);
    if (q.weapon) {
      const drop = { id: 'i' + nextEntId++, type: q.weapon, x: q.x, y: q.y, delay: 0, activeAt: Date.now() + 600 };
      m.items.set(drop.id, drop);
      q.weapon = null;
    }
    m.events.push({ k: 'kill', id: q.id, by: from?.id || null });
  }
}

function botThink(m, p, now) {
  if (now < p.botThinkAt) return;
  p.botThinkAt = now + 320 - p.level * 18;

  const enemies = [...m.players.values()].filter((q) => !q.dead && q !== p);
  if (enemies.length === 0) return;
  let target = enemies[0];
  for (const e of enemies) {
    if (Math.hypot(e.x - p.x, e.y - p.y) < Math.hypot(target.x - p.x, target.y - p.y)) target = e;
  }

  // stay on safe tiles above all
  if (!isSafe(p.x, p.y, m.fallen)) {
    const c = WORLD / 2;
    const len = Math.hypot(c - p.x, c - p.y) || 1;
    p.mvx = (c - p.x) / len;
    p.mvy = (c - p.y) / len;
    return;
  }

  // unarmed and not mounted: find a piece
  if (!p.weapon && !p.mounted) {
    let best = null, bd = Infinity;
    for (const it of m.items.values()) {
      if (it.type === 'crown' && p.hp > 60) continue;
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      if (d < bd) { bd = d; best = it; }
    }
    if (best) {
      const len = Math.hypot(best.x - p.x, best.y - p.y) || 1;
      p.mvx = (best.x - p.x) / len;
      p.mvy = (best.y - p.y) / len;
      if (bd < PICKUP_R * 0.8) handlePickup(m, p.id);
      return;
    }
  }

  p.aimx = target.x;
  p.aimy = target.y;
  const dist = Math.hypot(target.x - p.x, target.y - p.y);
  const w = p.weapon ? WEAPONS[p.weapon] : WEAPONS.melee;

  let desired;
  if (p.mounted) {
    desired = { x: target.x, y: target.y };
    if (dist < TILE * 2.4) handleAttack(m, p.id);
  } else if (!p.weapon) {
    desired = { x: target.x, y: target.y };
    if (dist < WEAPONS.melee.range + PLAYER_R) handleAttack(m, p.id);
  } else if (w.snap) {
    // move toward the nearest aligned firing position at mid range
    const dir = snapDir(p.x - target.x, p.y - target.y, w.snap);
    const standOff = Math.min(w.range * 0.55, 320);
    desired = {
      x: Math.max(30, Math.min(WORLD - 30, target.x + dir.x * standOff)),
      y: Math.max(30, Math.min(WORLD - 30, target.y + dir.y * standOff)),
    };
    if (inFiringLine(p, target, p.weapon) || Math.random() < p.botAttackSlop) {
      handleAttack(m, p.id);
    }
  } else {
    desired = { x: target.x, y: target.y };
    if (dist < w.range * 0.8) handleAttack(m, p.id);
  }

  if (!isSafe(desired.x, desired.y, m.fallen)) desired = { x: WORLD / 2, y: WORLD / 2 };
  const len = Math.hypot(desired.x - p.x, desired.y - p.y);
  if (len < 14) {
    p.mvx = 0; p.mvy = 0;
  } else {
    p.mvx = (desired.x - p.x) / len;
    p.mvy = (desired.y - p.y) / len;
  }
}

function tick(m) {
  const now = Date.now();
  const dt = Math.min(0.1, (now - m.lastTick) / 1000);
  m.lastTick = now;
  m.tickCount++;
  if (m.finished) return;
  const live = now >= m.startsAt;

  // zone shrink
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

  // supply drops
  if (live && now >= m.nextSupplyAt) {
    m.nextSupplyAt = now + SUPPLY_EVERY();
    const pool = ['pawn', 'bishop', 'rook', 'knight'];
    const types = [pool[Math.floor(Math.random() * pool.length)]];
    types.push(Math.random() < 0.3 ? 'queen' : pool[Math.floor(Math.random() * pool.length)]);
    if (Math.random() < 0.4) types.push('crown');
    const margin = TILE * (m.fallen + 1.2);
    const cx = margin + Math.random() * (WORLD - margin * 2);
    const cy = margin + Math.random() * (WORLD - margin * 2);
    for (const it of scatterItems(types, cx, cy, 120)) {
      it.activeAt = now + 900 + it.delay;
      m.items.set(it.id, it);
    }
    m.events.push({ k: 'supply', x: cx, y: cy });
  }

  // promotion rank relocation
  if (live && now - m.promo.movedAt >= PROMO_MOVE_EVERY()) {
    m.promo = { side: Math.floor(Math.random() * 4), movedAt: now };
    m.events.push({ k: 'promomove', side: m.promo.side });
  }

  for (const p of m.players.values()) {
    if (p.dead) continue;
    if (p.isBot && live) botThink(m, p, now);

    // dashing knights
    if (p.dash) {
      const d = p.dash;
      const dir = d.phase === 1 ? d.dir : d.side;
      const step = DASH.speed * dt;
      p.x += dir.x * step;
      p.y += dir.y * step;
      d.remaining -= step;
      for (const q of m.players.values()) {
        if (q === p || q.dead || d.hit.has(q.id)) continue;
        if (Math.hypot(q.x - p.x, q.y - p.y) < PLAYER_R * 2.2) {
          d.hit.add(q.id);
          damage(m, q, DASH.dmg, p);
        }
      }
      if (d.remaining <= 0) {
        if (d.phase === 1) {
          d.phase = 2;
          d.remaining = TILE;
        } else {
          p.dash = null;
        }
      }
    } else if (live) {
      const speed = p.mounted ? MOUNT_SPEED : SPEED;
      p.x += p.mvx * speed * dt;
      p.y += p.mvy * speed * dt;
    }
    p.x = Math.max(PLAYER_R, Math.min(WORLD - PLAYER_R, p.x));
    p.y = Math.max(PLAYER_R, Math.min(WORLD - PLAYER_R, p.y));

    // auto-pickup when bare-handed
    if (live && !p.weapon) {
      for (const it of m.items.values()) {
        if (now < it.activeAt || it.type === 'crown') continue;
        if (it.type === 'knight' && p.mounted) continue;
        if (Math.hypot(it.x - p.x, it.y - p.y) < PICKUP_R * 0.7) {
          takeItem(m, p, it);
          break;
        }
      }
    }

    // off-board drain + regen
    if (live && !isSafe(p.x, p.y, m.fallen)) {
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

    // promotion run
    if (live && p.weapon === 'pawn' && onPromoStrip(m, p)) {
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
    pr.x += pr.dx * step;
    pr.y += pr.dy * step;
    pr.traveled += step;
    let dead = pr.traveled > w.range || pr.x < -20 || pr.x > WORLD + 20 || pr.y < -20 || pr.y > WORLD + 20;
    if (!dead) {
      for (const q of m.players.values()) {
        if (q.dead || q.id === pr.owner) continue;
        if (Math.hypot(q.x - pr.x, q.y - pr.y) < PLAYER_R + w.projR) {
          damage(m, q, w.dmg, m.players.get(pr.owner));
          dead = true;
          break;
        }
      }
    }
    if (dead) m.projectiles.splice(i, 1);
  }

  // CHECK! detection
  for (const p of m.players.values()) {
    if (p.dead) { p.check = false; continue; }
    p.check = [...m.players.values()].some((e) =>
      e !== p && !e.dead && e.weapon && inFiringLine(e, p, e.weapon));
  }

  // win condition
  const alive = [...m.players.values()].filter((p) => !p.dead);
  if (live && alive.length <= 1) {
    m.finished = true;
    const winner = alive[0] || null;
    if (winner) m.deathOrder.push(winner.id);
    const order = [...m.deathOrder].reverse(); // first = winner
    const placements = order.map((id, idx) => {
      const pl = m.players.get(id);
      return { id, name: pl.name, isBot: pl.isBot, place: idx + 1 };
    });
    m.hooks.broadcast(snapshot(m));
    setTimeout(() => m.hooks.finish(winner ? { id: winner.id, name: winner.name } : null, placements), 900);
    return;
  }

  if (m.tickCount % SNAP_EVERY === 0) {
    m.hooks.broadcast(snapshot(m));
  }
}

function onPromoStrip(m, p) {
  const inset = m.fallen * TILE;
  const stripDepth = TILE * 0.8;
  switch (m.promo.side) {
    case 0: return p.y < inset + stripDepth && isSafe(p.x, p.y, m.fallen);
    case 1: return p.x > WORLD - inset - stripDepth && isSafe(p.x, p.y, m.fallen);
    case 2: return p.y > WORLD - inset - stripDepth && isSafe(p.x, p.y, m.fallen);
    default: return p.x < inset + stripDepth && isSafe(p.x, p.y, m.fallen);
  }
}

function snapshot(m) {
  const now = Date.now();
  const nextShrink = m.shrinks.find((s) => !s.fell);
  const msg = {
    t: 'bs',
    players: [...m.players.values()].map((p) => ({
      id: p.id, x: Math.round(p.x), y: Math.round(p.y),
      hp: Math.round(p.hp), weapon: p.weapon, mounted: p.mounted,
      dead: p.dead, check: p.check, cd: Math.max(0, p.cdReadyAt - now),
      dash: !!p.dash, promo: p.promoMs > 0,
    })),
    projectiles: m.projectiles.map((pr) => ({
      id: pr.id, type: pr.type, x: Math.round(pr.x), y: Math.round(pr.y), dx: pr.dx, dy: pr.dy,
    })),
    items: [...m.items.values()].map((i) => ({
      id: i.id, type: i.type, x: Math.round(i.x), y: Math.round(i.y), ready: now >= i.activeAt,
    })),
    fallen: m.fallen,
    shrinkIn: nextShrink ? Math.max(0, m.startsAt + nextShrink.fallAt - now) : null,
    promoSide: m.promo.side,
    events: m.events.splice(0),
  };
  return msg;
}
