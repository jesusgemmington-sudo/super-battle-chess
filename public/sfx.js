// Tiny WebAudio synth - zero asset files, maximum boing.

let ctx = null;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// One enveloped oscillator note.
function note({ freq = 440, end = freq, dur = 0.12, type = 'sine', vol = 0.18, at = 0 }) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + at;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(end, 1), t0 + dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noiseBurst({ dur = 0.12, vol = 0.2, at = 0, cutoff = 900 }) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + at;
  const len = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const gain = ac.createGain();
  gain.gain.value = vol;
  src.connect(filter).connect(gain).connect(ac.destination);
  src.start(t0);
}

export const sfx = {
  unlock() { audio(); }, // call on first user gesture

  select() { note({ freq: 520, end: 700, dur: 0.07, type: 'triangle', vol: 0.12 }); },

  move() {
    note({ freq: 300, end: 180, dur: 0.09, type: 'square', vol: 0.07 });
    noiseBurst({ dur: 0.06, vol: 0.12, cutoff: 1400 });
  },

  capture() {
    noiseBurst({ dur: 0.16, vol: 0.3, cutoff: 700 });
    note({ freq: 160, end: 60, dur: 0.18, type: 'square', vol: 0.14 });
    note({ freq: 900, end: 1400, dur: 0.12, type: 'triangle', vol: 0.1, at: 0.05 });
  },

  reject() { note({ freq: 140, end: 100, dur: 0.15, type: 'sawtooth', vol: 0.08 }); },

  promote() {
    [660, 880, 1100].forEach((f, i) => note({ freq: f, dur: 0.12, type: 'triangle', vol: 0.12, at: i * 0.07 }));
  },

  tick() { note({ freq: 600, end: 600, dur: 0.08, type: 'square', vol: 0.08 }); },

  go() { note({ freq: 880, end: 1320, dur: 0.25, type: 'square', vol: 0.12 }); },

  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) =>
      note({ freq: f, dur: 0.22, type: 'triangle', vol: 0.14, at: i * 0.11 }));
  },

  lose() {
    [392, 330, 262, 196].forEach((f, i) =>
      note({ freq: f, end: f * 0.92, dur: 0.3, type: 'sawtooth', vol: 0.07, at: i * 0.16 }));
  },

  emote() { note({ freq: 350, end: 750, dur: 0.16, type: 'sine', vol: 0.12 }); },

  join() { note({ freq: 440, end: 660, dur: 0.14, type: 'triangle', vol: 0.1 }); },
};
