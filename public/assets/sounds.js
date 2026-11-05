// Sound + voice for announcements. Built-in sounds are synthesised here (no files to load);
// custom ones are fetched from /sounds/<name>. Used by the overlay and the dashboard preview.
(() => {
  'use strict';

  const BUILTIN = [
    { id: 'sparkle', name: 'Sparkle' },
    { id: 'chime', name: 'Chime' },
    { id: 'bell', name: 'Bell' },
    { id: 'pop', name: 'Bubble pop' },
    { id: 'harp', name: 'Harp swirl' },
    { id: 'coin', name: 'Arcade coin' },
  ];

  let ctx = null;
  const buffers = new Map();

  function context() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  function unlock() {
    const c = context();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
    return c ? c.state : 'none';
  }

  const state = () => (ctx ? ctx.state : 'suspended');

  // One plucked/blown note: oscillator through a quick-attack, exponential-decay envelope.
  function note(c, out, { freq, at = 0, dur = 0.5, type = 'sine', gain = 0.3, to = null }) {
    const t = c.currentTime + at;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  const RECIPES = {
    sparkle: (c, out) => [1319, 1568, 1976, 2637, 3136].forEach((f, i) => note(c, out, { freq: f, at: i * 0.075, dur: 0.55, type: 'triangle', gain: 0.22 })),
    chime: (c, out) => {
      note(c, out, { freq: 880, dur: 1.1, gain: 0.3 });
      note(c, out, { freq: 1320, at: 0.16, dur: 1.2, gain: 0.26 });
    },
    bell: (c, out) => [[660, 0.34], [1822, 0.16], [3564, 0.08]].forEach(([f, g]) => note(c, out, { freq: f, dur: 1.6, gain: g })),
    pop: (c, out) => note(c, out, { freq: 720, to: 160, dur: 0.16, gain: 0.5 }),
    harp: (c, out) => [523, 659, 784, 988, 1175, 1319, 1568, 1976].forEach((f, i) => note(c, out, { freq: f, at: i * 0.06, dur: 0.9, type: 'triangle', gain: 0.2 })),
    coin: (c, out) => {
      note(c, out, { freq: 988, dur: 0.09, type: 'square', gain: 0.12 });
      note(c, out, { freq: 1319, at: 0.09, dur: 0.5, type: 'square', gain: 0.12 });
    },
  };

  async function fileBuffer(c, url) {
    if (buffers.has(url)) return buffers.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`sound file ${res.status}`);
    const buf = await c.decodeAudioData(await res.arrayBuffer());
    buffers.set(url, buf);
    return buf;
  }

  // ref: 'none' | built-in id | 'file:name.mp3'.  opts: { volume 0-100, base: '/sounds/', keyQuery: '?key=…' }
  async function play(ref, opts = {}) {
    if (!ref || ref === 'none') return false;
    const c = context();
    if (!c) return false;
    if (c.state === 'suspended') await c.resume().catch(() => {});
    if (c.state !== 'running') return false;
    const master = c.createGain();
    master.gain.value = Math.max(0, Math.min(100, opts.volume ?? 70)) / 100;
    master.connect(c.destination);
    if (ref.startsWith('file:')) {
      const url = `${opts.base || '/sounds/'}${encodeURIComponent(ref.slice(5))}${opts.keyQuery || ''}`;
      const src = c.createBufferSource();
      src.buffer = await fileBuffer(c, url);
      src.connect(master);
      src.start();
      return true;
    }
    const recipe = RECIPES[ref];
    if (!recipe) return false;
    recipe(c, master);
    return true;
  }

  // Speak a short phrase, preferring a soft female-sounding voice when the system has one.
  function speak(text, rate = 100, volume = 100) {
    const synth = window.speechSynthesis;
    if (!synth || !text) return false;
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 160));
    const voices = synth.getVoices();
    const pick = voices.find((v) => /zira|aria|jenny|samantha|victoria|karen|moira|tessa|female/i.test(v.name) && /^en/i.test(v.lang)) || null;
    if (pick) u.voice = pick;
    u.rate = Math.max(0.5, Math.min(2, rate / 100));
    u.pitch = 1.15;
    u.volume = Math.max(0, Math.min(1, volume / 100));
    synth.speak(u);
    return true;
  }

  window.Sounds = { BUILTIN, play, speak, unlock, state };
})();
