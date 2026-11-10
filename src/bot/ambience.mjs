// Ambient sound for the voice rooms: when someone sits in one of the rooms below, a bot joins and plays a
// looping track (and posts a small animated picture in the room's chat); when the room empties it leaves.
// This file holds the rules and no Discord library, so it can run against fakes in the tests.
// The voice side (joining, ffmpeg, the picture post) is ambience-voice.mjs.
//
// One Discord bot can sit in only ONE voice channel per server. A "pool" of bots therefore decides how
// many rooms can sound at once: Snitch Helper 1 to 10 (SNITCH_HELPER_n_TOKEN).
// When every bot is busy, the other occupied rooms stay quiet until one frees up.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

/** gainDb is added to the common loudness target (-24 LUFS). Co-op Gaming has no room on purpose: it is for coordinating matches. */
export const DEFAULT_ROOMS = [
  { key: 'the-lounge', match: ['the lounge'], visual: null, gainDb: 0, status: '🛋️ low-pressure downtime', caption: '🛋️ Pull up a chair.' },
  { key: 'build-room', match: ['build room'], visual: null, gainDb: -2, status: '🛠️ heads down, building', caption: '🛠️ The bench is warm.' },
  { key: 'backstage', match: ['backstage'], visual: null, gainDb: 0, status: '🎬 behind the scenes', caption: '🎬 Backstage is open.' },
  { key: 'core-room', match: ['core room'], visual: null, gainDb: 0, status: '💗 the magenta core hums', caption: '💗 The core hums quietly.' },
  { key: 'elder-campfire', match: ['elder campfire', 'campfire'], visual: null, gainDb: 0, status: '🔥 crackling fire', caption: '🔥 A fire crackles in the forge.' },
  { key: 'elder-lounge', match: ['elder lounge'], visual: null, gainDb: 0, status: '🕯️ quiet company', caption: '🕯️ Quiet company.' },
  { key: 'art-studio', match: ['art studio'], visual: null, gainDb: 0, status: '🎨 brushes moving', caption: '🎨 Brushes moving.' },
  { key: 'writing-desk', match: ['writing desk'], visual: null, gainDb: 0, status: '✒️ pens scratching', caption: '✒️ Pens scratching.' },
];

export const AUDIO_EXT = ['.ogg', '.opus', '.mp3', '.wav', '.flac', '.m4a', '.aac'];

/** Lower-case letters and digits only, so "Dictator's Bedroom" and "dictators-bedroom" compare equal. */
export const normalizeName = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Reads config/ambience.json (optional) over the built-in rooms. A room with the same `key` is merged; new keys are added. */
export function loadAmbienceConfig(file = process.env.AMBIENCE_CONFIG || path.join(ROOT, 'config', 'ambience.json'), env = process.env) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    // A typo in the file must not stop the whole bot: ambience runs on its built-in rooms and says why.
    if (err.code !== 'ENOENT') console.error(`[ambience] ignoring ${file} (using the built-in rooms): ${err.message}`);
  }
  const byKey = new Map(DEFAULT_ROOMS.map((r) => [r.key, { ...r }]));
  for (const r of raw.rooms || []) byKey.set(r.key, { ...(byKey.get(r.key) || { gainDb: 0, visual: null, match: [r.key] }), ...r });
  const flag = String(env.AMBIENCE ?? (raw.enabled === false ? 'off' : 'on')).toLowerCase();
  // volumeDb turns every room up or down at once; a room's own gainDb is added on top. Negative is quieter.
  const volumeDb = Number(raw.volumeDb ?? 0) || 0;
  return {
    volumeDb,
    enabled: !['off', 'false', '0', 'no'].includes(flag),
    dir: env.AMBIENCE_DIR || raw.dir || path.join(ROOT, 'audio'), // your own music, as audio/<key>.mp3 or a folder audio/<key>/
    defaultsDir: path.join(ROOT, 'audio', 'generated'), // the loops scripts/generate-ambience.mjs makes
    visualsDir: path.join(ROOT, 'assets', 'visuals'), // optional: assets/visuals/<visual>.gif
    leaveDelayMs: Math.max(0, Number(env.AMBIENCE_LEAVE_DELAY ?? raw.leaveDelaySeconds ?? 20)) * 1000,
    rooms: [...byKey.values()].map((r) => ({ ...r, gainDb: (Number(r.gainDb) || 0) + volumeDb })),
  };
}

/**
 * Pairs rooms with voice or stage channels. Every channel whose name matches a room counts, so a cloned
 * category (for example the Elder rooms) sounds the same as the original. A room with channelId or
 * channelIds uses exactly those channels. A channel belongs to one room only.
 * channels: [{ id, name, kind: 'voice' | 'stage', parentId?, ignore? }]
 */
export function matchRooms(rooms, channels) {
  const out = new Map();
  for (const room of rooms) {
    const ids = [room.channelId, ...(room.channelIds || [])].filter(Boolean).map(String);
    let found;
    if (ids.length) found = channels.filter((c) => ids.includes(c.id));
    else {
      const words = (room.match?.length ? room.match : [room.key]).map(normalizeName).filter(Boolean);
      found = channels.filter((c) => !c.ignore && words.some((w) => normalizeName(c.name).includes(w)));
    }
    for (const channel of found) if (!out.has(channel.id)) out.set(channel.id, { ...room, channel });
  }
  return out;
}

/** Your own track beats the built-in one: audio/<key>/ (a random file each time), audio/<key>.<ext>, then the generated loop. */
export function resolveTrack(room, { dir, defaultsDir, random = Math.random, fsApi = fs }) {
  const isAudio = (f) => AUDIO_EXT.includes(path.extname(f).toLowerCase());
  const sub = path.join(dir, room.key);
  try {
    const files = fsApi.readdirSync(sub).filter(isAudio).sort();
    if (files.length) return { path: path.join(sub, files[Math.floor(random() * files.length)]), source: 'yours' };
  } catch {}
  for (const ext of AUDIO_EXT) {
    const p = path.join(dir, room.key + ext);
    if (fsApi.existsSync(p)) return { path: p, source: 'yours' };
  }
  for (const ext of AUDIO_EXT) {
    const p = path.join(defaultsDir, room.key + ext);
    if (fsApi.existsSync(p)) return { path: p, source: 'built-in' };
  }
  return null;
}

export function resolveVisual(room, { visualsDir, fsApi = fs }) {
  if (!room.visual) return null;
  const p = path.join(visualsDir, `${room.visual}.gif`);
  return fsApi.existsSync(p) ? p : null;
}

/**
 * pool: [{ name, busy: false, start(room, channel, assets, onLost) → Promise<{ stop(): Promise }> }]
 * humansIn(channelId) → number of people (not bots) in the channel
 * channels() → [{ id, name, kind }]
 */
export function createAmbience({ config, notice = () => null, pool, humansIn, channels, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, fsApi = fs, retryMs = 60_000, now = () => Date.now() }) {
  const sessions = new Map(); // channelId → { entry, handle, timer, state }
  const waiting = new Set();
  const failedAt = new Map();
  const lostCount = new Map();
  // Rooms called in for a while by another feature (a Pomodoro session): channelId → room key. They play
  // that room's sound but leave the channel status and the public notice to the feature that called them.
  const summoned = new Map();
  // Rooms held open on purpose (/camp start): a helper stays and plays even with nobody there, until released.
  const held = new Set();
  const present = (channelId) => humansIn(channelId) + (held.has(channelId) ? 1 : 0);
  const matches = () => {
    const list = channels();
    const found = matchRooms(config.rooms, list);
    for (const [id, key] of summoned) {
      const room = config.rooms.find((r) => r.key === key);
      const channel = list.find((c) => c.id === id);
      if (room && channel && !found.has(id)) found.set(id, { ...room, status: null, summoned: true, channel });
    }
    return found;
  };
  const assetsFor = (room) => ({ notice: room.summoned ? null : notice(room.channel), track: resolveTrack(room, { dir: config.dir, defaultsDir: config.defaultsDir, random, fsApi }), visual: resolveVisual(room, { visualsDir: config.visualsDir, fsApi }) });

  function cleanup(channelId) {
    const s = sessions.get(channelId);
    if (!s) return;
    if (s.timer) clearTimer(s.timer);
    sessions.delete(channelId);
    s.entry.busy = false;
    for (const id of [...waiting]) evaluate(id); // a bot is free again
  }

  async function leave(channelId) {
    const s = sessions.get(channelId);
    if (!s) return;
    s.timer = null;
    if (present(channelId) > 0) return;
    try {
      await s.handle?.stop();
    } catch (err) {
      log(`could not leave cleanly: ${err.message}`);
    }
    cleanup(channelId);
  }

  /** Stops a session at once, people or not (a summoned room that was released). */
  async function leaveNow(channelId) {
    const s = sessions.get(channelId);
    if (!s?.handle) return;
    await s.handle.stop().catch((err) => log(`could not leave cleanly: ${err.message}`));
    cleanup(channelId);
  }

  function evaluate(channelId) {
    const room = matches().get(channelId);
    if (!room) {
      if (sessions.has(channelId)) leaveNow(channelId); // released, and not an ambient room of its own
      return;
    }
    if (!config.enabled) return;
    const people = present(channelId);
    const s = sessions.get(channelId);
    if (people > 0) {
      if (s) {
        if (s.timer) clearTimer(s.timer);
        s.timer = null;
        return;
      }
      if (now() - (failedAt.get(channelId) ?? -Infinity) < retryMs) return;
      const entry = pool.find((e) => !e.busy);
      if (!entry) {
        if (!waiting.has(channelId)) log(`${room.channel.name}: every bot is busy in another room, so it stays quiet for now`);
        waiting.add(channelId);
        return;
      }
      const assets = assetsFor(room);
      if (!assets.track) {
        log(`${room.channel.name}: no audio file for "${room.key}"`);
        return;
      }
      waiting.delete(channelId);
      entry.busy = true;
      const session = { entry, handle: null, timer: null, state: 'starting' };
      sessions.set(channelId, session);
      entry
        .start(room, room.channel, assets, () => {
          // the connection dropped (moved out, kicked, network): start over if people are still there
          if (sessions.get(channelId) !== session) return;
          cleanup(channelId);
          // Back off 3 s, 6 s, 12 s ... up to 60 s, so a bad connection never turns into a join/leave loop.
          const lost = (lostCount.get(channelId) ?? 0) + 1;
          lostCount.set(channelId, lost);
          const wait = Math.min(60_000, 3000 * 2 ** (lost - 1));
          log(`${room.channel.name}: connection lost (${lost}), trying again in ${wait / 1000} s`);
          setTimer(() => evaluate(channelId), wait);
        })
        .then((handle) => {
          session.handle = handle;
          session.state = 'playing';
          setTimer(() => { if (sessions.get(channelId) === session) lostCount.delete(channelId); }, 120_000)?.unref?.();
          log(`${room.channel.name}: ${entry.name} is playing ${assets.track.source === 'yours' ? 'your' : 'the built-in'} ${room.key} loop`);
          if (present(channelId) === 0 || !matches().has(channelId)) evaluate(channelId);
        })
        .catch((err) => {
          log(`${room.channel.name}: could not start (${err.message})`);
          failedAt.set(channelId, now());
          if (sessions.get(channelId) === session) cleanup(channelId);
        });
      return;
    }
    waiting.delete(channelId);
    if (s && s.state === 'playing' && !s.timer) s.timer = setTimer(() => leave(channelId), config.leaveDelayMs);
  }

  const scan = () => {
    for (const id of matches().keys()) evaluate(id);
  };

  /**
   * Calls a bot into a channel to play `key`'s sound until release(). A channel that already plays its own
   * sound (the Cafe) keeps it. Returns 'own' (already an ambient room), 'playing', 'waiting' (every bot is
   * busy) or 'off'.
   */
  function summon(channelId, key) {
    if (!config.enabled || !config.rooms.some((r) => r.key === key)) return 'off';
    if (matchRooms(config.rooms, channels()).has(channelId)) {
      evaluate(channelId);
      return 'own';
    }
    summoned.set(channelId, key);
    evaluate(channelId);
    return sessions.has(channelId) ? 'playing' : waiting.has(channelId) ? 'waiting' : 'off';
  }

  function release(channelId) {
    if (!summoned.delete(channelId)) return;
    waiting.delete(channelId);
    evaluate(channelId);
  }

  /** The status line the room shows when ambience plays there by itself ('' when it does not). */
  const statusFor = (channelId) => {
    const room = matchRooms(config.rooms, channels()).get(channelId);
    return room && sessions.has(channelId) ? room.status || '' : '';
  };

  async function stopAll() {
    for (const id of [...sessions.keys()]) {
      const s = sessions.get(id);
      await s?.handle?.stop().catch(() => {});
      cleanup(id);
    }
  }

  /** The text for /ambience status. */
  function describe() {
    const found = matches();
    const lines = [`Bots available for ambience: ${pool.length} (${pool.filter((e) => !e.busy).length} free). One bot plays in one room at a time.`];
    for (const room of config.rooms) {
      const hits = [...found.values()].filter((r) => r.key === room.key);
      if (!hits.length) {
        lines.push(`• ${room.key}: no voice channel matches (${(room.match || []).join(', ')}). Set channelId in config/ambience.json.`);
        continue;
      }
      const t = assetsFor(hits[0]).track;
      for (const hit of hits) {
        const s = sessions.get(hit.channel.id);
        lines.push(`• ${hit.channel.name} (${hit.channel.kind}): ${t ? `${t.source} track ${path.basename(t.path)}` : 'NO audio file'}${s ? `, playing via ${s.entry.name}` : waiting.has(hit.channel.id) ? ', waiting for a free bot' : ''}`);
      }
    }
    const rooms = found.size;
    lines.push(`${rooms} room(s) matched. For every room to sound at once, ${rooms} helper bot(s) are needed.`);
    return lines.join('\n').slice(0, 1900);
  }

  /** Keeps a helper in this room, playing, whether or not anyone is there. */
  function hold(channelId) {
    held.add(channelId);
    failedAt.delete(channelId);
    evaluate(channelId);
    return sessions.has(channelId) ? 'playing' : waiting.has(channelId) ? 'waiting' : 'off';
  }

  /** Lets the room go back to normal: the helper leaves after the usual delay once nobody is there. */
  function unhold(channelId) {
    if (!held.delete(channelId)) return false;
    evaluate(channelId);
    return true;
  }

  return { evaluate, scan, stopAll, describe, summon, release, statusFor, hold, unhold, isHeld: (id) => held.has(id) };
}
