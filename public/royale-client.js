// Royale mode client - "The Board": a first-person chess battle royale.
// Three.js renderer + pointer-lock FPS controller. The server owns combat,
// items, the zone and win logic; we own local movement and presentation.

import * as THREE from './lib/three.module.js';
import {
  TILE, BOARD, WORLD, buildWorld, groundAt, tileRing, supportHeight,
  pointInBox, lineAlignment,
} from './map.js';
import { PALETTES } from './pieces.js';
import { sfx } from './sfx.js';

const EYE = 1.6;
const PLAYER_R = 0.6;
const PLAYER_H = 1.8;
const SPEED = 9;
const JUMP_V = 8.5;
const GRAV = 24;

const WEAPON_LABEL = {
  null: '✊ Royal Fists',
  pawn: '♙ Pawn Pistol',
  bishop: '♗ Bishop Longshot — diagonals hit harder',
  rook: '♖ Rook Cannon — ranks & files hit harder',
  queen: '♕ Queen Scepter — all 8 lines empowered',
};

let st = null;
let sendFn = null;
let myId = null;
let rafId = 0;
let listeners = [];

const $ = (sel) => document.querySelector(sel);

function on(target, ev, fn, opts) {
  target.addEventListener(ev, fn, opts);
  listeners.push(() => target.removeEventListener(ev, fn, opts));
}

// ---------------------------------------------------------------------------
// Mesh builders (low-poly cartoon chess pieces)
// ---------------------------------------------------------------------------

function mat(color) {
  return new THREE.MeshLambertMaterial({ color });
}

function pieceMesh(type, colorHex, scale = 1) {
  const g = new THREE.Group();
  const c = mat(colorHex);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 0.3, 10), c);
  base.position.y = 0.15;
  g.add(base);
  if (type === 'pawn') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.4, 0.7, 10), c);
    body.position.y = 0.6;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), c);
    head.position.y = 1.1;
    g.add(body, head);
  } else if (type === 'rook') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.46, 0.95, 10), c);
    body.position.y = 0.75;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.22, 10), c);
    top.position.y = 1.3;
    g.add(body, top);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.2, 0.18), c);
      const a = (i / 4) * Math.PI * 2;
      m.position.set(Math.cos(a) * 0.34, 1.5, Math.sin(a) * 0.34);
      g.add(m);
    }
  } else if (type === 'bishop') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.42, 1.0, 10), c);
    body.position.y = 0.8;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), c);
    head.position.y = 1.4;
    head.scale.y = 1.35;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), c);
    tip.position.y = 1.82;
    g.add(body, head, tip);
  } else if (type === 'knight') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.44, 0.8, 10), c);
    body.position.y = 0.65;
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.7, 0.5), c);
    neck.position.set(0, 1.25, 0.05);
    neck.rotation.x = -0.35;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.65), c);
    head.position.set(0, 1.6, 0.3);
    const ear = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.12), c);
    ear.position.set(0, 1.82, 0.12);
    g.add(body, neck, head, ear);
  } else if (type === 'queen') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.46, 1.2, 10), c);
    body.position.y = 0.9;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), c);
    head.position.y = 1.65;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.22, 8), mat('#ffd34d'));
    crown.position.y = 1.95;
    g.add(body, head, crown);
  } else { // king
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.5, 1.25, 10), c);
    body.position.y = 0.95;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), c);
    head.position.y = 1.75;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.24, 0.24, 8), mat('#ffd34d'));
    crown.position.y = 2.05;
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.34, 0.08), mat('#ffd34d'));
    crossV.position.y = 2.35;
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.08), mat('#ffd34d'));
    crossH.position.y = 2.38;
    g.add(body, head, crown, crossV, crossH);
  }
  g.scale.setScalar(scale);
  return g;
}

function nameSprite(text, colorHex) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const c = cv.getContext('2d');
  c.font = 'bold 34px Fredoka, sans-serif';
  c.textAlign = 'center';
  c.lineWidth = 7;
  c.strokeStyle = 'rgba(43,42,64,.9)';
  c.strokeText(text, 128, 42);
  c.fillStyle = colorHex;
  c.fillText(text, 128, 42);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.scale.set(6, 1.5, 1);
  return sp;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function init(startMsg, opts) {
  stop();
  sendFn = opts.send;
  myId = opts.myId;

  const canvas = $('#br-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#7cc4ff');
  scene.fog = new THREE.Fog('#9cd4ff', 120, 460);
  scene.add(new THREE.HemisphereLight('#dff1ff', '#5d8b4a', 1.05));
  const sun = new THREE.DirectionalLight('#fff6dd', 1.1);
  sun.position.set(0.5, 1, 0.3);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(78, 1, 0.1, 900);

  const world = buildWorld(startMsg.royale.seed);

  st = {
    canvas, renderer, scene, camera, world,
    startsAt: Date.now() + startMsg.in,
    me: null,
    players: new Map(),
    items: new Map(),
    crates: new Map(),
    projectiles: new Map(),
    banners: new Map(),
    tiles: [],
    fallen: 0, warnRing: -1, shrinkIn: null,
    promo: { ...startMsg.royale.promo },
    promoMesh: null,
    tracers: [],
    keys: {},
    yaw: 0, pitch: 0, vy: 0, grounded: false,
    locked: false, dead: false, over: false,
    lastInputAt: 0, lastTime: performance.now(),
    snap: null,
    leap: 0, banner: null, dodgeCd: 0, cd: 0, weapon: null, hp: 100, check: false,
  };

  // --- board tiles ---
  const tileGeo = new THREE.BoxGeometry(TILE - 0.6, 6, TILE - 0.6);
  for (let tz = 0; tz < BOARD; tz++) {
    for (let tx = 0; tx < BOARD; tx++) {
      const h = groundAt(tx * TILE + 1, tz * TILE + 1);
      const light = (tx + tz) % 2 === 0;
      const m = new THREE.Mesh(tileGeo, mat(light ? '#a3e077' : '#7ec850'));
      m.position.set(tx * TILE + TILE / 2, h - 3, tz * TILE + TILE / 2);
      m.scale.y = (h + 6) / 6;
      m.position.y = (h - 6 * m.scale.y / 2) + 6 * m.scale.y / 2 - 3 * m.scale.y + (h - (h - 3 * m.scale.y));
      m.position.y = h - (6 * m.scale.y) / 2;
      scene.add(m);
      st.tiles.push({ mesh: m, tx, tz, ring: tileRing(tx, tz), baseY: m.position.y, sink: 0 });
    }
  }

  // --- world boxes ---
  for (const b of world.boxes) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.sx, b.sy, b.sz), mat(b.color || '#cfc4ae'));
    m.position.set(b.x, b.y, b.z);
    scene.add(m);
  }

  // --- promotion square ---
  const promoGeo = new THREE.CylinderGeometry(5, 5, 0.4, 24);
  const promoMat = new THREE.MeshBasicMaterial({ color: '#ffd34d', transparent: true, opacity: 0.55 });
  st.promoMesh = new THREE.Mesh(promoGeo, promoMat);
  movePromo(st.promo.x, st.promo.z);
  scene.add(st.promoMesh);

  // --- players ---
  for (const p of startMsg.royale.players) {
    const isMe = p.id === myId;
    const rec = {
      ...p, rx: p.x, ry: p.y, rz: p.z, ryaw: 0,
      hp: 100, weapon: null, dead: false, check: false,
      mesh: null, label: null,
    };
    if (!isMe) {
      rec.mesh = pieceMesh('king', PALETTES[p.color].main, 1.25);
      rec.label = nameSprite(p.name, PALETTES[p.color].light);
      rec.label.position.y = 3.4;
      rec.mesh.add(rec.label);
      scene.add(rec.mesh);
    } else {
      st.me = rec;
      camera.position.set(p.x, p.y + EYE, p.z);
      // face the board center
      st.yaw = Math.atan2(WORLD / 2 - p.z, WORLD / 2 - p.x);
    }
    st.players.set(p.id, rec);
  }

  for (const it of startMsg.royale.items) addItem(it);

  // view-model (held piece in front of the camera)
  st.viewModel = new THREE.Group();
  camera.add(st.viewModel);
  scene.add(camera);
  setViewModel(null);

  window.__br = st; // debug handle
  resize();
  bindInput();
  $('#br-feed').innerHTML = '';
  $('#br-banner').classList.add('hidden');
  $('#br-lock').classList.remove('hidden');
  $('#br-lock').textContent = '🪂 CLICK TO TAKE THE FIELD 🪂';
  updateHud();

  const secs = Math.round(startMsg.in / 1000);
  for (let i = 0; i <= secs; i++) {
    setTimeout(() => {
      if (!st) return;
      banner(i === secs ? 'FIGHT FOR THE BOARD! ⚔' : String(secs - i), 800);
      if (i === secs) sfx.go(); else sfx.tick();
    }, i * 1000);
  }

  rafId = requestAnimationFrame(frame);
}

export function stop() {
  cancelAnimationFrame(rafId);
  listeners.forEach((off) => off());
  listeners = [];
  if (st) {
    try { document.exitPointerLock?.(); } catch {}
    st.renderer.dispose();
  }
  st = null;
}

export function isActive() { return !!st; }

function movePromo(x, z) {
  st.promo = { x, z };
  st.promoMesh.position.set(x, groundAt(x, z) + 0.2, z);
}

// ---------------------------------------------------------------------------
// Items / crates / banners
// ---------------------------------------------------------------------------

function addItem(it) {
  const type = it.type === 'crown' ? 'king' : it.type === 'banner' ? 'rook' : it.type;
  const mesh = pieceMesh(type, it.type === 'banner' ? '#c9b9ff' : '#ffc94d', 1.5);
  mesh.position.set(it.x, it.y + 0.4, it.z);
  st.scene.add(mesh);
  st.items.set(it.id, { ...it, mesh });
}

function removeItem(id) {
  const it = st.items.get(id);
  if (it) { st.scene.remove(it.mesh); st.items.delete(id); }
}

function setViewModel(weapon) {
  st.viewModel.clear();
  const type = weapon || 'pawn';
  const m = pieceMesh(weapon ? type : 'pawn', weapon ? '#ffc94d' : '#e8e1d2', weapon ? 0.5 : 0.35);
  m.position.set(0.55, -0.62, -1.0);
  m.rotation.set(0.15, -0.5, 0.12);
  st.viewModel.add(m);
}

// ---------------------------------------------------------------------------
// Server snapshots & events
// ---------------------------------------------------------------------------

export function onSnapshot(msg) {
  if (!st) return;
  st.snap = msg;
  st.fallen = msg.fallen;
  st.warnRing = msg.warnRing;
  st.shrinkIn = msg.shrinkIn;
  if (msg.promo.x !== st.promo.x || msg.promo.z !== st.promo.z) movePromo(msg.promo.x, msg.promo.z);

  for (const sp of msg.players) {
    const p = st.players.get(sp.id);
    if (!p) continue;
    p.hp = sp.hp;
    p.weapon = sp.weapon;
    p.check = sp.check;
    p.dead = sp.dead;
    if (sp.id === myId) {
      st.hp = sp.hp; st.weapon = sp.weapon; st.check = sp.check;
      st.leap = sp.leap; st.cd = sp.cd; st.dodgeCdLeft = sp.dodgeCd;
      st.bannerState = sp.banner;
      if (sp.dead && !st.dead) onMyDeath();
    } else {
      p.sx = sp.x; p.sy = sp.y; p.sz = sp.z; p.syaw = sp.yaw;
    }
    // banner flags for everyone (visible = counterplay)
    const key = 'bn' + sp.id;
    if (sp.banner && typeof sp.banner === 'object') {
      let flag = st.banners.get(key);
      if (!flag) {
        flag = pieceMesh('rook', PALETTES[p.color].main, 1.1);
        st.scene.add(flag);
        st.banners.set(key, flag);
      }
      flag.position.set(sp.banner.x, sp.banner.y, sp.banner.z);
    } else {
      const flag = st.banners.get(key);
      if (flag) { st.scene.remove(flag); st.banners.delete(key); }
    }
  }

  // items
  const seen = new Set();
  for (const it of msg.items) {
    seen.add(it.id);
    if (!st.items.has(it.id)) addItem(it);
  }
  for (const id of [...st.items.keys()]) if (!seen.has(id)) removeItem(id);

  // crates
  const cseen = new Set();
  for (const c of msg.crates) {
    cseen.add(c.id);
    let rec = st.crates.get(c.id);
    if (!rec) {
      const g = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.4), mat('#a9743c'));
      const chute = new THREE.Mesh(new THREE.ConeGeometry(3.4, 2.4, 10, 1, true), mat('#ff6b57'));
      chute.position.y = 4;
      g.add(box, chute);
      st.scene.add(g);
      rec = { mesh: g, chute };
      st.crates.set(c.id, rec);
    }
    rec.mesh.position.set(c.x, c.y + 1.2, c.z);
  }
  for (const id of [...st.crates.keys()]) {
    if (!cseen.has(id)) { st.scene.remove(st.crates.get(id).mesh); st.crates.delete(id); }
  }

  // projectiles
  const pseen = new Set();
  for (const pr of msg.projectiles) {
    pseen.add(pr.id);
    let rec = st.projectiles.get(pr.id);
    if (!rec) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(pr.type === 'rook' ? 0.55 : 0.28, 8, 6),
        new THREE.MeshBasicMaterial({ color: pr.type === 'rook' ? '#3b3f54' : '#ffe07a' }));
      st.scene.add(m);
      rec = { mesh: m };
      st.projectiles.set(pr.id, rec);
    }
    rec.mesh.position.set(pr.x, pr.y, pr.z);
  }
  for (const id of [...st.projectiles.keys()]) {
    if (!pseen.has(id)) { st.scene.remove(st.projectiles.get(id).mesh); st.projectiles.delete(id); }
  }

  for (const ev of msg.events) handleEvent(ev);
  updateHud();
}

function nameOf(id) { return st.players.get(id)?.name || '???'; }

function handleEvent(ev) {
  switch (ev.k) {
    case 'tracer': {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ev.x, ev.y, ev.z), new THREE.Vector3(ev.tx, ev.ty, ev.tz)]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: ev.bonus ? '#ffd34d' : (ev.type === 'bishop' ? '#c9a9ff' : '#fff'), transparent: true, opacity: 0.9,
      }));
      st.scene.add(line);
      st.tracers.push({ mesh: line, t0: performance.now() });
      if (ev.id === myId) sfx.move(); else sfx.tick();
      break;
    }
    case 'shoot': if (ev.id === myId) { sfx.move(); kickViewModel(); } break;
    case 'swing': if (ev.id === myId) { sfx.select(); kickViewModel(); } break;
    case 'boom': sfx.capture(); break;
    case 'hit': {
      if (ev.id === myId) { flashDamage(); sfx.capture(); }
      else if (ev.by === myId) { hitMarker(ev.label); sfx.capture(); }
      break;
    }
    case 'dodged':
      feed(`💨 ${nameOf(ev.id)} en passant'd ${nameOf(ev.by)}'s shot!`);
      if (ev.id === myId) banner('EN PASSANT! 💨', 900);
      break;
    case 'kill': {
      const who = nameOf(ev.id);
      feed(ev.zone ? `🕳 ${who} fell off the board` :
        `☠ ${nameOf(ev.by)} CHECKMATED ${who}${ev.label ? ` (${ev.label})` : ''}`);
      if (ev.by === myId) { banner('CHECKMATE! ☠', 1600); sfx.win(); }
      else if (ev.id !== myId) sfx.capture();
      break;
    }
    case 'pickup':
      if (ev.id === myId) {
        sfx.select();
        if (ev.type !== 'knight' && ev.type !== 'banner') setViewModel(ev.type);
        if (ev.type === 'knight') banner('♘ KNIGHT’S LEAP READY (Q)', 1400);
        if (ev.type === 'banner') banner('♖ CASTLING BANNER (F to plant)', 1400);
      }
      break;
    case 'heal': if (ev.id === myId) sfx.promote(); break;
    case 'leap':
      sfx.go();
      if (ev.id === myId) {
        st.me.rx = ev.tx; st.camera.position.set(ev.tx, ev.ty + EYE, ev.tz);
      }
      break;
    case 'banner': feed(`♖ ${nameOf(ev.id)} planted a castling banner`); sfx.join(); break;
    case 'castle':
      feed(`♖ ${nameOf(ev.id)} CASTLED across the board!`);
      sfx.promote();
      if (ev.id === myId) st.camera.position.set(ev.tx, ev.ty + EYE, ev.tz);
      break;
    case 'dodge': if (ev.id === myId) sfx.go(); break;
    case 'promote':
      feed(`👑 ${nameOf(ev.id)} PROMOTED a pawn into the QUEEN!`);
      banner(ev.id === myId ? '♕ PROMOTED!' : '⚠ A QUEEN WALKS THE BOARD', 2000);
      sfx.promote();
      if (ev.id === myId) setViewModel('queen');
      break;
    case 'promomove': feed('✨ The promotion square relocated'); break;
    case 'supply': feed('📦 Supply crate dropping!'); sfx.tick(); break;
    case 'crateland': sfx.capture(); break;
    case 'warn': banner('⚠ THE BOARD IS SHRINKING', 1800); sfx.check(); break;
    case 'fall': sinkRing(ev.ring); sfx.capture(); break;
    case 'left': feed(`🚪 ${nameOf(ev.id)} fled the board`); break;
  }
}

function sinkRing(ring) {
  for (const t of st.tiles) if (t.ring === ring) t.sink = 0.0001;
}

function onMyDeath() {
  st.dead = true;
  banner('💀 CHECKMATED!', 2500);
  sfx.lose();
  $('#br-lock').classList.add('hidden');
  feed('Spectating — fly with WASD');
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function feed(text) {
  const el = document.createElement('div');
  el.textContent = text;
  const box = $('#br-feed');
  box.prepend(el);
  while (box.children.length > 5) box.lastChild.remove();
  setTimeout(() => el.remove(), 7000);
}

function banner(text, ms) {
  const el = $('#br-banner');
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(banner._t);
  banner._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function flashDamage() {
  const el = $('#br-hurt');
  el.style.opacity = '0.55';
  clearTimeout(flashDamage._t);
  flashDamage._t = setTimeout(() => { el.style.opacity = '0'; }, 180);
}

function hitMarker(label) {
  const el = $('#br-hitmark');
  el.textContent = label ? `✕ ${label}!` : '✕';
  el.classList.toggle('bonus', !!label);
  el.style.opacity = '1';
  clearTimeout(hitMarker._t);
  hitMarker._t = setTimeout(() => { el.style.opacity = '0'; }, label ? 600 : 250);
}

function kickViewModel() {
  if (st?.viewModel.children[0]) st.viewModel.children[0].position.z = -0.8;
}

function updateHud() {
  if (!st) return;
  const alive = [...st.players.values()].filter((p) => !p.dead).length;
  $('#br-alive').textContent = `👑 ${alive} alive`;
  $('#br-shrink').textContent = st.shrinkIn == null
    ? '🟩 final board'
    : `🟨 board shrinks in ${Math.ceil(st.shrinkIn / 1000)}s`;
  $('#br-hp').style.width = `${Math.max(0, st.hp)}%`;
  $('#br-weapon').textContent = WEAPON_LABEL[st.weapon] || WEAPON_LABEL.null;
  $('#br-check').classList.toggle('hidden', !(st.check && !st.dead));
  $('#ab-leap').classList.toggle('ab-on', st.leap > 0);
  $('#ab-leap').textContent = `Q ♘×${st.leap || 0}`;
  const b = st.bannerState;
  $('#ab-castle').classList.toggle('ab-on', !!b);
  $('#ab-castle').textContent = b === 'stored' ? 'F ♖ plant' : b ? 'F ♖ CASTLE!' : 'F ♖ —';
  $('#ab-dodge').classList.toggle('ab-on', !st.dodgeCdLeft);
  $('#ab-dodge').textContent = st.dodgeCdLeft ? `⇧ 💨 ${Math.ceil(st.dodgeCdLeft / 1000)}s` : '⇧ 💨 ready';
  drawMinimap();
}

function drawMinimap() {
  const cv = $('#br-map');
  const c = cv.getContext('2d');
  const s = cv.width / BOARD;
  for (let tz = 0; tz < BOARD; tz++) {
    for (let tx = 0; tx < BOARD; tx++) {
      const ring = tileRing(tx, tz);
      c.fillStyle = ring < st.fallen ? '#27435f'
        : ring === st.warnRing ? '#d98a4b'
        : (tx + tz) % 2 === 0 ? '#a3e077' : '#7ec850';
      c.fillRect(tx * s, tz * s, s, s);
    }
  }
  // promotion square
  c.fillStyle = '#ffd34d';
  c.beginPath();
  c.arc((st.promo.x / WORLD) * cv.width, (st.promo.z / WORLD) * cv.height, 4, 0, Math.PI * 2);
  c.fill();
  // crates
  c.fillStyle = '#a9743c';
  for (const [, rec] of st.crates) {
    c.fillRect((rec.mesh.position.x / WORLD) * cv.width - 3, (rec.mesh.position.z / WORLD) * cv.height - 3, 6, 6);
  }
  // me
  if (st.me) {
    const mx = (st.camera.position.x / WORLD) * cv.width;
    const mz = (st.camera.position.z / WORLD) * cv.height;
    c.save();
    c.translate(mx, mz);
    c.rotate(st.yaw + Math.PI / 2);
    c.fillStyle = '#fff';
    c.strokeStyle = '#2b2a40';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, -6); c.lineTo(4, 5); c.lineTo(-4, 5); c.closePath();
    c.fill(); c.stroke();
    c.restore();
  }
}

// ---------------------------------------------------------------------------
// Input + FPS controller
// ---------------------------------------------------------------------------

function bindInput() {
  const canvas = st.canvas;

  on($('#br-lock'), 'click', () => canvas.requestPointerLock());
  on(document, 'pointerlockchange', () => {
    if (!st) return;
    st.locked = document.pointerLockElement === canvas;
    $('#br-lock').classList.toggle('hidden', st.locked || st.dead || st.over);
    if (!st.locked && !st.dead) $('#br-lock').textContent = '⏸ CLICK TO RE-ENTER';
  });

  on(document, 'mousemove', (e) => {
    if (!st?.locked) return;
    st.yaw += e.movementX * 0.0024;
    st.pitch = Math.max(-1.5, Math.min(1.5, st.pitch - e.movementY * 0.0024));
  });

  on(window, 'keydown', (e) => {
    if (!st) return;
    st.keys[e.code] = true;
    if (e.code === 'KeyE') sendFn({ t: 'bp' });
    if (e.code === 'KeyQ') doLeap();
    if (e.code === 'KeyF') sendFn({ t: 'bf' });
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') doDodge();
    if (e.code === 'Space') e.preventDefault();
  });
  on(window, 'keyup', (e) => { if (st) st.keys[e.code] = false; });

  on(canvas, 'pointerdown', () => {
    if (!st || !st.locked || st.dead) return;
    pushInput(true);
    sendFn({ t: 'ba' });
  });

  on(window, 'resize', resize);
}

function resize() {
  if (!st) return;
  const wrap = $('#br-wrap');
  const w = wrap.clientWidth, h = wrap.clientHeight;
  st.renderer.setSize(w, h, false);
  st.camera.aspect = w / h;
  st.camera.updateProjectionMatrix();
}

function pushInput(force) {
  const now = performance.now();
  if (!force && now - st.lastInputAt < 80) return;
  st.lastInputAt = now;
  const c = st.camera.position;
  sendFn({
    t: 'bi',
    x: Math.round(c.x * 10) / 10, y: Math.round((c.y - EYE) * 10) / 10, z: Math.round(c.z * 10) / 10,
    yaw: Math.round(st.yaw * 100) / 100, pitch: Math.round(st.pitch * 100) / 100,
  });
}

// Knight's Leap: a true L - two squares along your facing axis, one sideways.
function doLeap() {
  if (!st || st.dead || st.leap <= 0) return;
  const main = Math.abs(Math.cos(st.yaw)) > Math.abs(Math.sin(st.yaw))
    ? { x: Math.sign(Math.cos(st.yaw)), z: 0 }
    : { x: 0, z: Math.sign(Math.sin(st.yaw)) };
  const residual = main.x !== 0 ? Math.sin(st.yaw) : Math.cos(st.yaw);
  const side = main.x !== 0
    ? { x: 0, z: Math.sign(residual) || 1 }
    : { x: Math.sign(residual) || 1, z: 0 };
  const L1 = 16, L2 = 8;
  const c = st.camera.position;
  const tx = Math.max(2, Math.min(WORLD - 2, c.x + main.x * L1 + side.x * L2));
  const tz = Math.max(2, Math.min(WORLD - 2, c.z + main.z * L1 + side.z * L2));
  const ty = supportHeight(st.world, tx, tz, 200, 200);
  sendFn({ t: 'bq', x: tx, y: ty, z: tz });
  // local teleport (server validates and echoes the effect)
  c.set(tx, ty + EYE, tz);
  st.vy = 0;
  sfx.go();
}

function doDodge() {
  if (!st || st.dead || st.dodgeCdLeft > 0) return;
  sendFn({ t: 'bd' });
  // lateral impulse relative to view
  const side = (st.keys.KeyA && !st.keys.KeyD) ? 1 : -1;
  st.dashVel = { x: Math.sin(st.yaw) * side * 22, z: -Math.cos(st.yaw) * side * 22, until: performance.now() + 180 };
}

function collides(x, y, z) {
  for (const b of st.world.boxes) {
    if (Math.abs(x - b.x) <= b.sx / 2 + PLAYER_R &&
        Math.abs(z - b.z) <= b.sz / 2 + PLAYER_R &&
        y + PLAYER_H > b.y - b.sy / 2 && y < b.y + b.sy / 2) {
      return b;
    }
  }
  return null;
}

function moveLocal(dt) {
  const c = st.camera.position;
  let feet = c.y - EYE;

  if (st.dead) {
    // free-fly spectate
    const fly = 24 * dt;
    const f = { x: Math.cos(st.yaw), z: Math.sin(st.yaw) };
    if (st.keys.KeyW) { c.x += f.x * fly; c.z += f.z * fly; }
    if (st.keys.KeyS) { c.x -= f.x * fly; c.z -= f.z * fly; }
    if (st.keys.KeyA) { c.x += f.z * fly; c.z -= f.x * fly; }
    if (st.keys.KeyD) { c.x -= f.z * fly; c.z += f.x * fly; }
    if (st.keys.Space) c.y += fly;
    if (st.keys.KeyC) c.y -= fly;
    c.y = Math.max(2, Math.min(200, c.y));
    return;
  }

  const live = Date.now() >= st.startsAt;
  let mx = 0, mz = 0;
  if (live && st.locked) {
    const f = { x: Math.cos(st.yaw), z: Math.sin(st.yaw) };
    if (st.keys.KeyW || st.keys.ArrowUp) { mx += f.x; mz += f.z; }
    if (st.keys.KeyS || st.keys.ArrowDown) { mx -= f.x; mz -= f.z; }
    if (st.keys.KeyA || st.keys.ArrowLeft) { mx += f.z; mz -= f.x; }
    if (st.keys.KeyD || st.keys.ArrowRight) { mx -= f.z; mz += f.x; }
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }
  }
  let vx = mx * SPEED, vz = mz * SPEED;
  if (st.dashVel && performance.now() < st.dashVel.until) {
    vx += st.dashVel.x; vz += st.dashVel.z;
  }

  // X axis
  let nx = c.x + vx * dt;
  let hit = collides(nx, feet, c.z);
  if (hit) {
    const top = hit.y + hit.sy / 2;
    if (top - feet <= 0.65 && !collides(nx, top + 0.01, c.z)) feet = top;
    else nx = c.x;
  }
  // Z axis
  let nz = c.z + vz * dt;
  hit = collides(nx, feet, nz);
  if (hit) {
    const top = hit.y + hit.sy / 2;
    if (top - feet <= 0.65 && !collides(nx, top + 0.01, nz)) feet = top;
    else nz = c.z;
  }
  nx = Math.max(1, Math.min(WORLD - 1, nx));
  nz = Math.max(1, Math.min(WORLD - 1, nz));

  // Y axis
  st.vy -= GRAV * dt;
  if (st.grounded && st.keys.Space && live) { st.vy = JUMP_V; st.grounded = false; sfx.tick(); }
  let ny = feet + st.vy * dt;
  const support = supportHeight(st.world, nx, nz, feet, 0.65);
  if (ny <= support) {
    ny = support;
    st.vy = 0;
    st.grounded = true;
  } else {
    st.grounded = false;
    const head = collides(nx, ny + 0.05, nz);
    if (head && st.vy > 0) st.vy = 0;
  }

  c.set(nx, ny + EYE, nz);
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function frame() {
  if (!st) return;
  rafId = requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.05, (now - st.lastTime) / 1000);
  st.lastTime = now;

  // self-heal if the wrap was resized or only just became visible
  const wrap = $('#br-wrap');
  if (st.canvas.width !== wrap.clientWidth && wrap.clientWidth > 0) resize();

  moveLocal(dt);
  pushInput(false);

  // camera orientation (yaw 0 looks along +X; pitch up is positive)
  st.camera.rotation.order = 'YXZ';
  st.camera.rotation.y = -st.yaw - Math.PI / 2;
  st.camera.rotation.x = st.pitch;
  st.camera.rotation.z = 0;

  // remote players
  for (const p of st.players.values()) {
    if (!p.mesh) continue;
    if (p.dead) { p.mesh.visible = false; continue; }
    p.mesh.visible = true;
    p.rx += ((p.sx ?? p.rx) - p.rx) * 0.2;
    p.ry += ((p.sy ?? p.ry) - p.ry) * 0.2;
    p.rz += ((p.sz ?? p.rz) - p.rz) * 0.2;
    p.mesh.position.set(p.rx, p.ry, p.rz);
    p.mesh.rotation.y = -(p.syaw ?? 0) - Math.PI / 2;
  }

  // items spin
  for (const [, it] of st.items) it.mesh.rotation.y = now / 600;
  st.promoMesh.material.opacity = 0.4 + 0.2 * Math.sin(now / 280);
  st.promoMesh.rotation.y = now / 1200;

  // sinking tiles
  for (const t of st.tiles) {
    if (t.sink > 0) {
      t.sink = Math.min(1, t.sink + dt * 0.5);
      t.mesh.position.y = t.baseY - t.sink * 40;
      t.mesh.visible = t.sink < 1;
    } else if (t.ring === st.warnRing) {
      const flash = Math.floor(now / 280) % 2 === 0;
      t.mesh.material = flash ? warnMat() : t.mesh.material;
      if (!flash) t.mesh.material = ((t.tx + t.tz) % 2 === 0) ? lightMat() : darkMat();
    }
  }

  // tracers fade
  for (let i = st.tracers.length - 1; i >= 0; i--) {
    const tr = st.tracers[i];
    const age = now - tr.t0;
    if (age > 350) { st.scene.remove(tr.mesh); st.tracers.splice(i, 1); }
    else tr.mesh.material.opacity = 0.9 * (1 - age / 350);
  }

  // view model spring-back
  const vm = st.viewModel.children[0];
  if (vm) {
    vm.position.z += (-1.0 - vm.position.z) * 0.18;
    vm.position.y = -0.62 + Math.sin(now / 240) * 0.02;
  }

  // true-line crosshair indicator
  const d = { x: Math.cos(st.yaw), z: Math.sin(st.yaw) };
  const align = lineAlignment(d.x, d.z);
  const cross = $('#br-cross');
  const wantsBonus = st.weapon === 'bishop' ? 'diag' : st.weapon === 'rook' ? 'line' : st.weapon === 'queen' ? 'both' : null;
  const lit = wantsBonus && align && (wantsBonus === 'both' || wantsBonus === align);
  cross.classList.toggle('true-line', !!lit);
  $('#br-align').textContent = lit ? (align === 'diag' ? '◆ TRUE DIAGONAL' : '✚ TRUE LINE') : '';

  st.renderer.render(st.scene, st.camera);
}

let _warnMat = null, _lightMat = null, _darkMat = null;
function warnMat() { return _warnMat || (_warnMat = mat('#e07a4b')); }
function lightMat() { return _lightMat || (_lightMat = mat('#a3e077')); }
function darkMat() { return _darkMat || (_darkMat = mat('#7ec850')); }
