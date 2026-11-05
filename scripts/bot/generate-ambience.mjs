// npm run ambience:generate: makes a soft looping sound for each ambience room with ffmpeg, so rooms work straight away
// with nothing licensed. Slow synth pads over quiet noise, written from scratch here. To use your own music, drop a file
// with the room's name in audio/ (for example audio/the-lounge.mp3): it is used instead of the generated one.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { ROOT } from '../../src/bot/config.mjs';

const OUT_DIR = path.join(ROOT, 'audio', 'generated');

const SECONDS = 240; // every frequency below repeats a whole number of times in this length, so the loop has no click
const pad = (notes, level = 0.07) => notes.map((f, i) => `${level}*sin(2*PI*${f}*t)*(0.65+0.35*sin(2*PI*${(i + 2) / SECONDS * 3}*t))`).join('+');

const ROOMS = {
  'the-lounge': { notes: [110, 165, 220, 277, 330], noise: 'brown', noiseLevel: 0.02, cutoff: 1200 },
  'build-room': { notes: [98, 147, 196, 247], noise: 'pink', noiseLevel: 0.012, cutoff: 900 },
  backstage: { notes: [82, 123, 165, 247, 311], noise: 'brown', noiseLevel: 0.018, cutoff: 1400 },
  'core-room': { notes: [131, 196, 262, 311, 392], noise: 'brown', noiseLevel: 0.015, cutoff: 1500 },
  'elder-campfire': { notes: [73, 110, 147], noise: 'brown', noiseLevel: 0.07, cutoff: 800 },
  'elder-lounge': { notes: [87, 131, 175, 220, 262], noise: 'brown', noiseLevel: 0.02, cutoff: 1100 },
  'art-studio': { notes: [147, 220, 294, 370, 440], noise: 'pink', noiseLevel: 0.01, cutoff: 2000 },
  'writing-desk': { notes: [123, 185, 247, 294], noise: 'pink', noiseLevel: 0.012, cutoff: 1000 },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
let made = 0;
for (const [key, r] of Object.entries(ROOMS)) {
  const out = path.join(OUT_DIR, `${key}.ogg`);
  if (fs.existsSync(out)) {
    console.log(`${key}: already made`);
    continue;
  }
  const res = spawnSync(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `aevalsrc='${pad(r.notes)}':s=48000:c=stereo:d=${SECONDS}`,
      '-f', 'lavfi', '-i', `anoisesrc=color=${r.noise}:amplitude=${r.noiseLevel}:sample_rate=48000:duration=${SECONDS}:seed=${key.length * 97}`,
      '-filter_complex', `[0:a][1:a]amix=inputs=2:normalize=0,lowpass=f=${r.cutoff},aecho=0.7:0.6:180:0.25,volume=0.9`,
      '-c:a', 'libvorbis', '-q:a', '3', out,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    console.error(`${key}: ffmpeg failed: ${res.stderr || res.error?.message}`);
    process.exitCode = 1;
    continue;
  }
  made++;
  console.log(`${key}: made ${path.basename(out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}
console.log(`${made} sound(s) made in ${OUT_DIR}`);
