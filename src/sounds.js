'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');

// Custom sound files live in <DATA_DIR>/sounds. You can drop files in by hand or upload them
// from the dashboard. Built-in sounds are synthesised in the browser, so they need no files.

const DIR = path.join(cfg.dataDir, 'sounds');
const BUILTIN_INFO = [
  { id: 'sparkle', name: 'Sparkle' },
  { id: 'chime', name: 'Chime' },
  { id: 'bell', name: 'Bell' },
  { id: 'pop', name: 'Bubble pop' },
  { id: 'harp', name: 'Harp swirl' },
  { id: 'coin', name: 'Arcade coin' },
];
const EXT = ['.mp3', '.wav', '.ogg', '.m4a'];
const MAX_BYTES = 3 * 1024 * 1024;
const SOUND_REF = /^(none|sparkle|chime|bell|pop|harp|coin|file:[\w][\w .()-]{0,78}\.(mp3|wav|ogg|m4a))$/i;

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

const safeName = (n) => {
  const base = path.basename(String(n || '')).replace(/[^\w .()-]/g, '-').replace(/^[.\s-]+/, '').slice(-80);
  return EXT.includes(path.extname(base).toLowerCase()) ? base : null;
};

// Does the content look like what the extension says? (Blocks uploading arbitrary files.)
function looksLike(ext, b) {
  if (b.length < 12) return false;
  switch (ext) {
    case '.wav': return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE';
    case '.ogg': return b.toString('latin1', 0, 4) === 'OggS';
    case '.m4a': return b.toString('latin1', 4, 8) === 'ftyp';
    case '.mp3': return b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    default: return false;
  }
}

function list() {
  try {
    return fs
      .readdirSync(DIR)
      .filter((f) => safeName(f) === f)
      .map((f) => ({ name: f, size: fs.statSync(path.join(DIR, f)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function save(name, buf) {
  const safe = safeName(name);
  if (!safe) throw Object.assign(new Error('Use an .mp3, .wav, .ogg or .m4a file.'), { status: 400 });
  if (!Buffer.isBuffer(buf) || !buf.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('Keep sound files under 3 MB.'), { status: 413 });
  if (!looksLike(path.extname(safe).toLowerCase(), buf)) throw Object.assign(new Error(`That does not look like a real ${path.extname(safe)} file.`), { status: 400 });
  if (list().length >= 60 && !list().some((f) => f.name === safe)) throw Object.assign(new Error('Too many sound files (60 max). Delete some first.'), { status: 400 });
  fs.writeFileSync(path.join(DIR, safe), buf, { mode: 0o600 });
  return safe;
}

function remove(name) {
  const safe = safeName(name);
  if (!safe) throw Object.assign(new Error('unknown file'), { status: 404 });
  fs.rmSync(path.join(DIR, safe), { force: true });
}

module.exports = { DIR, BUILTIN_INFO, MAX_BYTES, SOUND_REF, list, save, remove };
