// Joins a room as a friendly bot opponent so a live game can be inspected.
// Usage: node test-bot.js <port> <CODE>

import WebSocket from 'ws';

const [, , port, code] = process.argv;
const ws = new WebSocket(`ws://localhost:${port}`);

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'join', code, name: 'RoboRook' }));
  console.log('joined', code);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.t === 'start') {
    console.log('game starting');
    setTimeout(() => {
      // After the countdown, push the e7 pawn (4,1) -> (4,3)
      const pawn = msg.pieces.find((p) => p.team === 1 && p.x === 4 && p.y === 1);
      ws.send(JSON.stringify({ t: 'move', id: pawn.id, x: 4, y: 3 }));
      ws.send(JSON.stringify({ t: 'emote', e: 2 }));
      console.log('moved pawn + emoted');
    }, msg.in + 500);
  }
  if (msg.t === 'end') {
    console.log('game ended, winner team', msg.winner);
  }
});

setTimeout(() => process.exit(0), 90000);
