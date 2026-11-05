'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });

const STATE_FILE = path.join(cfg.dataDir, 'state.json');
const TOKEN_FILE = path.join(cfg.dataDir, 'tokens.json');

const DEFAULT_SETTINGS = {
  alertIntervalMs: 5000, // one announcement every 5 seconds
  alertDurationMs: 4200, // how long each one stays on screen (always < interval)
  holdWhenNoOverlay: true, // keep the queue while no OBS source is listening
  youtubePollSec: 120,
  twitchPollSec: 60,
  twitchPollFollowers: true, // also detect new followers by polling (webhook fallback)
  alerts: {
    'youtube.subscriber': true,
    'youtube.member': true,
    'twitch.follow': true,
    'twitch.sub': true,
    'twitch.resub': true,
    'twitch.gift': true,
    'bmc.donation': true,
    'bmc.membership': true,
    'bmc.extra': true,
  },
  style: {
    panelOpacity: 94, // % fill of the pills and chat bubbles; the page itself is always transparent
  },
  sound: {
    enabled: true,
    volume: 70,
    speak: false, // read "<name>, new follower on Twitch" aloud (browser voice)
    speakRate: 100,
    // what plays for each announcement: none | sparkle | chime | bell | pop | harp | coin | file:<your file>
    types: {
      'youtube.subscriber': 'sparkle',
      'youtube.member': 'harp',
      'twitch.follow': 'sparkle',
      'twitch.sub': 'chime',
      'twitch.resub': 'chime',
      'twitch.gift': 'harp',
      'bmc.donation': 'coin',
      'bmc.membership': 'harp',
      'bmc.extra': 'coin',
    },
  },
  goal: {
    title: 'Follower goal',
    counter: 'followers', // 'followers' = YouTube subs + Twitch followers, or any counter key
    target: 1000,
  },
  chat: {
    enabled: true,
    youtube: true,
    twitch: true,
    discord: true,
    hideBots: true,
    hideCommands: true, // drop messages that start with !
    blocked: '', // comma-separated words; messages containing any are dropped
    max: 10, // messages on screen
    ttlSec: 60, // fade after this many seconds (0 = stay until pushed out)
    ytSearchSec: 90, // how often to look for a live stream while offline
    ytMinPollSec: 10, // minimum gap between live-chat reads (each read costs ~5 quota units)
  },
  show: {
    ytSubs: true,
    ytMembers: true,
    twFollowers: true,
    twSubs: true,
    bmcMembers: true,
    bmcCoffees: true,
  },
  offsets: {
    ytSubs: 0,
    ytMembers: 0,
    twFollowers: 0,
    twSubs: 0,
    bmcMembers: 0,
    bmcCoffees: 0,
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Merge `extra` over `base`, keeping only keys that exist in `base`.
function mergeKnown(base, extra) {
  const out = {};
  for (const k of Object.keys(base)) {
    if (isObj(base[k])) out[k] = mergeKnown(base[k], isObj(extra) ? extra[k] : undefined);
    else out[k] = isObj(extra) && extra[k] !== undefined ? extra[k] : base[k];
  }
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data, mode) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode });
  fs.renameSync(tmp, file);
}

const freshState = () => ({
  v: 1,
  counters: {
    ytSubs: null,
    ytMembers: null,
    twFollowers: null,
    twSubs: null,
    bmcMembers: 0,
    bmcCoffees: 0,
    ytSubsHidden: false,
  },
  updatedAt: {},
  bmc: { donations: 0, totals: {}, members: {} },
  providers: {
    youtube: { subsSeeded: false, membersSeeded: false, memberIds: [] },
    twitch: { followersSeeded: false },
  },
  seen: [],
  queue: [],
  recent: [],
  settings: {},
});

function loadState() {
  const fresh = freshState();
  const loaded = readJson(STATE_FILE, {});
  return {
    ...fresh,
    ...loaded,
    counters: { ...fresh.counters, ...(loaded.counters || {}) },
    updatedAt: { ...(loaded.updatedAt || {}) },
    bmc: { ...fresh.bmc, ...(loaded.bmc || {}) },
    providers: {
      youtube: { ...fresh.providers.youtube, ...(loaded.providers?.youtube || {}) },
      twitch: { ...fresh.providers.twitch, ...(loaded.providers?.twitch || {}) },
    },
    seen: Array.isArray(loaded.seen) ? loaded.seen : [],
    queue: Array.isArray(loaded.queue) ? loaded.queue : [],
    recent: Array.isArray(loaded.recent) ? loaded.recent : [],
    settings: mergeKnown(DEFAULT_SETTINGS, loaded.settings),
  };
}

class Store {
  constructor() {
    this.state = loadState();
    this.seen = new Set(this.state.seen);
    this._timer = null;
    process.on('exit', () => this.flush());
  }

  // true the first time a key is seen, false for duplicates.
  markSeen(key) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.state.seen.push(key);
    if (this.state.seen.length > 6000) {
      const dropped = this.state.seen.splice(0, this.state.seen.length - 5000);
      for (const k of dropped) this.seen.delete(k);
    }
    this.save();
    return true;
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 400);
    this._timer.unref?.();
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      writeJsonAtomic(STATE_FILE, this.state, 0o600);
    } catch (e) {
      console.error('state save failed:', e.message);
    }
  }
}

const tokens = {
  data: readJson(TOKEN_FILE, {}),
  get(provider) {
    return this.data[provider] || null;
  },
  set(provider, value) {
    this.data[provider] = value;
    this._write();
  },
  clear(provider) {
    delete this.data[provider];
    this._write();
  },
  _write() {
    try {
      writeJsonAtomic(TOKEN_FILE, this.data, 0o600);
    } catch (e) {
      console.error('token save failed:', e.message);
    }
  },
};

module.exports = { Store, tokens, DEFAULT_SETTINGS };
