// Royale mode client: canvas renderer + input. The whole board is always on
// screen (party-game style); the server simulates, we draw and emote.

import { pieceSVG, PALETTES } from './pieces.js';
import { sfx } from './sfx.js';

const TILE = 100;
const BOARD = 8;
const WORLD = TILE * BOARD;

const WEAPON_LABEL = {
  null: '✊ Royal Fists',
  pawn: '♙ Pawn Dagger',
  bishop: '♗ Bishop Sniper (diagonals!)',
  rook: '♖ Rook Cannon (ranks & files!)',
  queen: '♕ THE QUEEN (8 ways!)',
};

let ctx = null;
let canvas = null;
let st = null;       // live render state
let sendFn = null;
let myId = null;
let rafId = 0;
let listeners = [];

const sprites = new Map();
function sprite(type, palette) {
  const key = `${type}:${palette}`;
  if (!sprites.has(key)) {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(pieceSVG(type, palette));
    sprites.set(key, img);
  }
  return sprites.get(key);
}

function on(target, ev, fn, opts) {
  target.addEventListener(ev, fn, opts);
  listeners.push(() => target.removeEventListener(ev, fn, opts));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function init(startMsg, opts) {
  stop();
  sendFn = opts.send;
  myId = opts.myId;
  canvas = document.querySelector('#br-canvas');
  ctx = canvas.getContext('2d');

  const now = performance.now();
  st = {
    startsAt: Date.now() + startMsg.in,
    players: new Map(),
    items: new Map(),
    projectiles: [],
    fallen: 0,
    warnRing: -1,
    shrinkIn: null,
    promoSide: null,
    fx: [],          // {kind,x,y,t0,...}
    feed: [],
    keys: { up: false, down: false, left: false, right: false },
    aim: { x: WORLD / 2, y: WORLD / 2 },
    lastInputSent: 0,
    over: false,
  };

  for (const p of startMsg.royale.players) {
    st.players.set(p.id, {
      ...p, rx: p.x, ry: p.y, sx: p.x, sy: p.y,
      hp: 100, weapon: null, mounted: false, dead: false, check: false,
      hitFlash: 0,
    });
  }
  for (const it of startMsg.royale.items) {
    st.items.set(it.id, { ...it, landAt: now + startMsg.in + 600 + it.delay, ready: false });
  }

  document.querySelector('#br-feed').innerHTML = '';
  document.querySelector('#br-banner').classList.add('hidden');
  bindInput();
  rafId = requestAnimationFrame(frame);

  // countdown banner
  const secs = Math.round(startMsg.in / 1000);
  for (let i = 0; i <= secs; i++) {
    setTimeout(() => {
      banner(i === secs ? 'DROP! 🪂' : String(secs - i), 700);
      if (i === secs) sfx.go(); else sfx.tick();
    }, i * 1000);
  }
}

export function stop() {
  cancelAnimationFrame(rafId);
  listeners.forEach((off) => off());
  listeners = [];
  st = null;
}

export function isActive() {
  return !!st;
}

// ---------------------------------------------------------------------------
// Server snapshots
// ---------------------------------------------------------------------------

export function onSnapshot(msg) {
  if (!st) return;
  for (const sp of msg.players) {
    const p = st.players.get(sp.id);
    if (!p) continue;
    p.sx = sp.x; p.sy = sp.y;
    p.hp = sp.hp;
    p.weapon = sp.weapon;
    p.mounted = sp.mounted;
    p.check = sp.check;
    p.cd = sp.cd;
    p.dash = sp.dash;
    p.promo = sp.promo;
    if (!p.dead && sp.dead) p.deadAt = performance.now();
    p.dead = sp.dead;
  }
  const seen = new Set();
  for (const it of msg.items) {
    seen.add(it.id);
    const cur = st.items.get(it.id);
    if (cur) {
      cur.ready = it.ready;
    } else {
      st.items.set(it.id, { ...it, landAt: performance.now() + 700 });
    }
  }
  for (const id of [...st.items.keys()]) if (!seen.has(id)) st.items.delete(id);
  st.projectiles = msg.projectiles;
  st.fallen = msg.fallen;
  st.shrinkIn = msg.shrinkIn;
  st.promoSide = msg.promoSide;

  for (const ev of msg.events) handleEvent(ev);
  updateHud();
}

function nameOf(id) {
  return st.players.get(id)?.name || '???';
}

function handleEvent(ev) {
  switch (ev.k) {
    case 'hit': {
      const p = st.players.get(ev.id);
      if (p) {
        p.hitFlash = performance.now();
        st.fx.push({ kind: 'dmg', x: p.sx, y: p.sy - 30, t0: performance.now(), text: `-${ev.dmg}`, horse: ev.horse });
      }
      sfx.capture();
      break;
    }
    case 'kill': {
      const who = nameOf(ev.id);
      feed(ev.zone ? `🟥 ${who} fell off the board` : `☠ ${nameOf(ev.by)} CHECKMATED ${who}!`);
      if (ev.id === myId) {
        banner('💀 CHECKMATED!', 2200);
        sfx.lose();
      } else if (ev.by === myId) {
        banner('CHECKMATE! ☠', 1600);
        sfx.win();
      } else {
        sfx.capture();
      }
      break;
    }
    case 'shoot': sfx.move(); break;
    case 'swing': sfx.select(); break;
    case 'dash': sfx.go(); break;
    case 'mount': feed(`🐴 ${nameOf(ev.id)} saddled up!`); sfx.join(); break;
    case 'horsedown': feed(`🐴💨 ${nameOf(ev.id)}'s horse bolted!`); sfx.reject(); break;
    case 'pickup': if (ev.id === myId) sfx.select(); break;
    case 'heal': if (ev.id === myId) sfx.promote(); break;
    case 'promote':
      feed(`👑 ${nameOf(ev.id)} PROMOTED a pawn to QUEEN!`);
      banner(ev.id === myId ? '♕ PROMOTED!' : '⚠️ A QUEEN HAS ENTERED PLAY', 2000);
      sfx.promote();
      break;
    case 'promomove': feed('✨ The promotion rank moved'); break;
    case 'supply': feed('📦 Supply box incoming!'); sfx.tick(); break;
    case 'warn': banner('⚠️ THE BOARD IS SHRINKING', 1800); st.warnRing = ev.ring; sfx.check(); break;
    case 'fall': st.warnRing = -1; sfx.capture(); break;
    case 'left': feed(`🚪 ${nameOf(ev.id)} fled the arena`); break;
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function feed(text) {
  const el = document.createElement('div');
  el.textContent = text;
  const box = document.querySelector('#br-feed');
  box.prepend(el);
  while (box.children.length > 5) box.lastChild.remove();
  setTimeout(() => el.remove(), 6000);
}

function banner(text, ms) {
  const el = document.querySelector('#br-banner');
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(banner._t);
  banner._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function updateHud() {
  if (!st) return;
  const alive = [...st.players.values()].filter((p) => !p.dead).length;
  document.querySelector('#br-alive').textContent = `👑 ${alive} alive`;
  const shrinkEl = document.querySelector('#br-shrink');
  shrinkEl.textContent = st.shrinkIn == null
    ? '🟩 final board'
    : `🟨 board shrinks in ${Math.ceil(st.shrinkIn / 1000)}s`;
  const me = st.players.get(myId);
  if (me) {
    document.querySelector('#br-hp').style.width = `${Math.max(0, me.hp)}%`;
    document.querySelector('#br-weapon').textContent =
      (me.mounted ? '🐴 ' : '') + (WEAPON_LABEL[me.weapon] || WEAPON_LABEL.null);
    const checkEl = document.querySelector('#br-check');
    const showCheck = me.check && !me.dead;
    checkEl.classList.toggle('hidden', !showCheck);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
};

function bindInput() {
  on(window, 'keydown', (e) => {
    if (!st) return;
    const dir = KEYMAP[e.code];
    if (dir) { st.keys[dir] = true; sendInput(true); e.preventDefault(); }
    if (e.code === 'KeyE') sendFn({ t: 'bp' });
  });
  on(window, 'keyup', (e) => {
    const dir = KEYMAP[e.code];
    if (dir && st) { st.keys[dir] = false; sendInput(true); }
  });
  on(canvas, 'mousemove', (e) => {
    if (!st) return;
    const r = canvas.getBoundingClientRect();
    st.aim.x = ((e.clientX - r.left) / r.width) * WORLD;
    st.aim.y = ((e.clientY - r.top) / r.height) * WORLD;
  });
  on(canvas, 'pointerdown', (e) => {
    if (!st) return;
    const r = canvas.getBoundingClientRect();
    st.aim.x = ((e.clientX - r.left) / r.width) * WORLD;
    st.aim.y = ((e.clientY - r.top) / r.height) * WORLD;
    sendInput(true);
    sendFn({ t: 'ba' });
  });
}

function sendInput(force) {
  const now = performance.now();
  if (!force && now - st.lastInputSent < 80) return;
  st.lastInputSent = now;
  const mx = (st.keys.right ? 1 : 0) - (st.keys.left ? 1 : 0);
  const my = (st.keys.down ? 1 : 0) - (st.keys.up ? 1 : 0);
  sendFn({ t: 'bi', mx, my, ax: Math.round(st.aim.x), ay: Math.round(st.aim.y) });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function frame() {
  if (!st) return;
  rafId = requestAnimationFrame(frame);
  sendInput(false);

  const now = performance.now();
  // interpolate players toward server positions
  for (const p of st.players.values()) {
    p.rx += (p.sx - p.rx) * 0.25;
    p.ry += (p.sy - p.ry) * 0.25;
  }

  ctx.clearRect(0, 0, WORLD, WORLD);

  // tiles
  for (let ty = 0; ty < BOARD; ty++) {
    for (let tx = 0; tx < BOARD; tx++) {
      const ring = Math.min(tx, ty, BOARD - 1 - tx, BOARD - 1 - ty);
      const x = tx * TILE, y = ty * TILE;
      if (ring < st.fallen) {
        ctx.fillStyle = '#27435f';
        ctx.fillRect(x, y, TILE, TILE);
        continue;
      }
      ctx.fillStyle = (tx + ty) % 2 === 0 ? '#9ade6b' : '#7ec850';
      ctx.fillRect(x, y, TILE, TILE);
      if (ring === st.warnRing && Math.floor(now / 250) % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 90, 60, 0.4)';
        ctx.fillRect(x, y, TILE, TILE);
      }
    }
  }

  // promotion strip
  if (st.promoSide != null) {
    const inset = st.fallen * TILE;
    const glow = 0.25 + 0.15 * Math.sin(now / 250);
    ctx.fillStyle = `rgba(255, 211, 77, ${glow})`;
    const d = TILE * 0.8;
    if (st.promoSide === 0) ctx.fillRect(inset, inset, WORLD - inset * 2, d);
    if (st.promoSide === 1) ctx.fillRect(WORLD - inset - d, inset, d, WORLD - inset * 2);
    if (st.promoSide === 2) ctx.fillRect(inset, WORLD - inset - d, WORLD - inset * 2, d);
    if (st.promoSide === 3) ctx.fillRect(inset, inset, d, WORLD - inset * 2);
  }

  // items
  for (const it of st.items.values()) {
    const img = sprite(it.type === 'crown' ? 'king' : it.type, 4);
    const t = Math.min(1, Math.max(0, (now - it.landAt + 700) / 700));
    const dropY = (1 - t) * -300;
    const size = 52;
    ctx.save();
    ctx.globalAlpha = it.ready ? 1 : 0.85;
    if (t >= 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.ellipse(it.x, it.y + size * 0.42, size * 0.32, size * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (img.complete) ctx.drawImage(img, it.x - size / 2, it.y - size / 2 + dropY, size, size);
    if (it.type === 'crown') {
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('💖', it.x + 16, it.y - 16 + dropY);
    }
    ctx.restore();
  }

  // projectiles
  for (const pr of st.projectiles) {
    ctx.save();
    ctx.translate(pr.x, pr.y);
    ctx.rotate(Math.atan2(pr.dy, pr.dx));
    if (pr.type === 'rook') {
      ctx.fillStyle = '#3b3f54';
      ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#6a708e';
      ctx.beginPath(); ctx.arc(-4, -4, 4, 0, Math.PI * 2); ctx.fill();
    } else if (pr.type === 'bishop') {
      ctx.fillStyle = '#b88af5';
      ctx.fillRect(-16, -3, 32, 6);
      ctx.fillStyle = '#fff';
      ctx.fillRect(2, -1.5, 12, 3);
    } else if (pr.type === 'queen') {
      ctx.fillStyle = '#ffd34d';
      ctx.fillRect(-14, -4, 28, 8);
      ctx.fillStyle = '#fff';
      ctx.fillRect(4, -2, 8, 4);
    } else {
      const img = sprite('pawn', 4);
      if (img.complete) ctx.drawImage(img, -12, -12, 24, 24);
    }
    ctx.restore();
  }

  // players
  const sorted = [...st.players.values()].sort((a, b) => a.ry - b.ry);
  for (const p of sorted) {
    if (p.dead) {
      drawTombstone(p, now);
      continue;
    }
    const size = 64;
    const flash = now - (p.hitFlash || 0) < 130;
    ctx.save();
    if (p.dash) {
      ctx.globalAlpha = 0.92;
      ctx.translate(p.rx, p.ry);
      ctx.rotate(Math.sin(now / 30) * 0.15);
      ctx.translate(-p.rx, -p.ry);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(p.rx, p.ry + 26, 20, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    if (p.check && !p.dead) {
      ctx.strokeStyle = `rgba(255, 60, 40, ${0.5 + 0.3 * Math.sin(now / 120)})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(p.rx, p.ry + 6, 30, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (p.mounted) {
      const horse = sprite('knight', p.color);
      if (horse.complete) ctx.drawImage(horse, p.rx - 30, p.ry - 18, 60, 60);
    }
    const img = sprite('king', p.color);
    const bob = Math.sin(now / 140 + p.rx) * (p.mounted ? 4 : 2);
    if (img.complete) {
      if (flash) ctx.filter = 'brightness(2.2)';
      ctx.drawImage(img, p.rx - size / 2, p.ry - size + 18 + bob - (p.mounted ? 22 : 0), size, size);
      ctx.filter = 'none';
    }
    if (p.weapon) {
      const wimg = sprite(p.weapon, 4);
      if (wimg.complete) ctx.drawImage(wimg, p.rx + 12, p.ry - 34 + bob, 28, 28);
    }
    if (p.promo) {
      ctx.fillStyle = '#ffd34d';
      ctx.font = 'bold 15px Fredoka, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⏫ promoting…', p.rx, p.ry - 56);
    }
    ctx.restore();

    // name + hp
    ctx.font = 'bold 13px Fredoka, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(43,42,64,0.85)';
    ctx.strokeText(p.name, p.rx, p.ry - 40);
    ctx.fillStyle = PALETTES[p.color].light;
    ctx.fillText(p.name, p.rx, p.ry - 40);
    ctx.fillStyle = 'rgba(43,42,64,0.55)';
    ctx.fillRect(p.rx - 22, p.ry - 36, 44, 5);
    ctx.fillStyle = p.hp > 40 ? '#62cd6e' : '#ff6b57';
    ctx.fillRect(p.rx - 22, p.ry - 36, 44 * (p.hp / 100), 5);
  }

  // floating fx
  for (let i = st.fx.length - 1; i >= 0; i--) {
    const f = st.fx[i];
    const age = now - f.t0;
    if (age > 800) { st.fx.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - age / 800;
    ctx.font = 'bold 18px Fredoka, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = f.horse ? '#b88af5' : '#ff5040';
    ctx.fillText(f.text, f.x, f.y - age / 16);
    ctx.globalAlpha = 1;
  }

  // aim reticle for me
  const me = st.players.get(myId);
  if (me && !me.dead) {
    ctx.strokeStyle = 'rgba(43,42,64,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(st.aim.x, st.aim.y, 10, 0, Math.PI * 2);
    ctx.moveTo(st.aim.x - 16, st.aim.y); ctx.lineTo(st.aim.x - 5, st.aim.y);
    ctx.moveTo(st.aim.x + 5, st.aim.y); ctx.lineTo(st.aim.x + 16, st.aim.y);
    ctx.moveTo(st.aim.x, st.aim.y - 16); ctx.lineTo(st.aim.x, st.aim.y - 5);
    ctx.moveTo(st.aim.x, st.aim.y + 5); ctx.lineTo(st.aim.x, st.aim.y + 16);
    ctx.stroke();
  }
}

function drawTombstone(p, now) {
  const t = Math.min(1, (now - (p.deadAt || now)) / 400);
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.translate(p.rx, p.ry);
  ctx.scale(t, t);
  ctx.fillStyle = '#9aa0b5';
  ctx.strokeStyle = '#2b2a40';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-16, 18);
  ctx.lineTo(-16, -6);
  ctx.arc(0, -6, 16, Math.PI, 0);
  ctx.lineTo(16, 18);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#2b2a40';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('♔', 0, 4);
  ctx.restore();
}
