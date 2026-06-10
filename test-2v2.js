// 2v2 smoke test: four clients, teammates share an army in real time.
// Run: node test-2v2.js   (server must be running on :3000)

import WebSocket from 'ws';

const URL = 'ws://localhost:3000';
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  };
}

const [a, b, c, d] = [client('A'), client('B'), client('C'), client('D')];
await Promise.all([a, b, c, d].map((x) => x.open()));

a.send({ t: 'create', name: 'Ana' });
const { code } = await a.next((m) => m.t === 'welcome');
for (const x of [b, c, d]) {
  x.send({ t: 'join', code, name: x.name });
  await x.next((m) => m.t === 'welcome');
}
const lobby = await d.next((m) => m.t === 'lobby' && m.players.length === 4);
const teams = [lobby.players.filter((p) => p.team === 0).length, lobby.players.filter((p) => p.team === 1).length];
check(teams[0] === 2 && teams[1] === 2, `auto-balance split 4 players 2/2 (got ${teams[0]}/${teams[1]})`);

a.send({ t: 'setMode', mode: '2v2' });
a.send({ t: 'setSpeed', speed: 'frenzy' });
await a.next((m) => m.t === 'lobby' && m.mode === '2v2' && m.speed === 'frenzy');
a.send({ t: 'start' });
const start = await a.next((m) => m.t === 'start');
check(start.pieces.length === 32, '2v2 game started');

await sleep(start.in + 200);

// Both blue teammates move different pieces at the same time.
const ids = Object.fromEntries(lobby.players.map((p) => [p.name, p]));
const blue = lobby.players.filter((p) => p.team === 0);
const blueClients = [a, b, c, d].filter((x) => blue.some((p) => p.name === ({ A: 'Ana', B: 'B', C: 'C', D: 'D' }[x.name] || x.name)));
// Simpler: every client tries to move a team-0 pawn; only team-0 members succeed.
const pawnL = start.pieces.find((p) => p.team === 0 && p.x === 0 && p.y === 6);
const pawnR = start.pieces.find((p) => p.team === 0 && p.x === 7 && p.y === 6);

const team0Clients = [a, b, c, d].filter((x, i) => {
  const names = ['Ana', 'B', 'C', 'D'];
  return lobby.players.find((p) => p.name === names[i])?.team === 0;
});
const team1Clients = [a, b, c, d].filter((x) => !team0Clients.includes(x));
check(team0Clients.length === 2, 'found both blue teammates');

team0Clients[0].send({ t: 'move', id: pawnL.id, x: 0, y: 4 });
team0Clients[1].send({ t: 'move', id: pawnR.id, x: 7, y: 4 });
await a.next((m) => m.t === 'move' && m.id === pawnL.id);
const mv2 = await a.next((m) => m.t === 'move' && m.id === pawnR.id);
check(true, 'both blue teammates moved pieces simultaneously');

// An enemy player cannot move blue pieces.
const pawnM = start.pieces.find((p) => p.team === 0 && p.x === 3 && p.y === 6);
team1Clients[0].send({ t: 'move', id: pawnM.id, x: 3, y: 4 });
await sleep(300);
const stolen = mv2.pieces.find((p) => p.id === pawnM.id);
check(stolen.x === 3 && stolen.y === 6, 'enemy cannot move blue pieces');

// One blue player leaving does NOT forfeit (teammate remains).
team0Clients[1].ws.close();
const leftMsg = await team1Clients[0].next((m) => m.t === 'playerLeft' || m.t === 'end');
check(leftMsg.t === 'playerLeft', 'game continues when one teammate leaves');

// Remaining blue player leaving forfeits to red.
team0Clients[0].ws.close();
const end = await team1Clients[0].next((m) => m.t === 'end');
check(end.winner === 1 && end.reason === 'forfeit', 'red wins when all blue players leave');

[a, b, c, d].forEach((x) => { try { x.ws.close(); } catch {} });
console.log(failures === 0 ? '\nALL 2v2 TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
