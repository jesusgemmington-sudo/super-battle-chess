// Creates a room as host, prints the code, and starts the game once a second
// player joins. Lets a human (or the preview browser) play as red.
// Usage: node test-host-bot.js <port>

import WebSocket from 'ws';

const port = process.argv[2] || 3000;
const ws = new WebSocket(`ws://localhost:${port}`);
let started = false;

ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: 'HostBot' })));

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.t === 'welcome') console.log('CODE:' + msg.code);
  if (msg.t === 'lobby' && msg.players.length === 2 && !started) {
    started = true;
    setTimeout(() => ws.send(JSON.stringify({ t: 'start' })), 300);
  }
  if (msg.t === 'start') {
    console.log('started');
    setTimeout(() => {
      const pawn = msg.pieces.find((p) => p.team === 0 && p.x === 4 && p.y === 6);
      ws.send(JSON.stringify({ t: 'move', id: pawn.id, x: 4, y: 4 }));
    }, msg.in + 500);
  }
});

setTimeout(() => process.exit(0), 120000);
