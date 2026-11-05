'use strict';

const cfg = require('./config');

const { randomUUID } = require('crypto');
const { clean, log } = require('./util');

// Every kind of announcement the overlay can make.
const TYPES = {
  'youtube.subscriber': { platform: 'YouTube', label: 'new subscriber', fallback: 'A new subscriber', icon: 'heart' },
  'youtube.member': { platform: 'YouTube', label: 'new member', fallback: 'A new member', icon: 'star' },
  'twitch.follow': { platform: 'Twitch', label: 'new follower', fallback: 'A new follower', icon: 'heart' },
  'twitch.sub': { platform: 'Twitch', label: 'new subscriber', fallback: 'A new subscriber', icon: 'star' },
  'twitch.resub': { platform: 'Twitch', label: 'resubscribed', fallback: 'A subscriber', icon: 'star' },
  'twitch.gift': { platform: 'Twitch', label: 'gifted subs', fallback: 'Anonymous', icon: 'gift' },
  'bmc.donation': { platform: 'Buy Me a Coffee', label: 'bought compute', fallback: 'Someone', icon: 'cup' },
  'bmc.membership': { platform: 'Buy Me a Coffee', label: 'new member', fallback: 'A new member', icon: 'cup' },
  'bmc.extra': { platform: 'Buy Me a Coffee', label: 'new purchase', fallback: 'Someone', icon: 'cup' },
};

// Counters and announcement types switched off with DISABLE_* in .env.
const DISABLED_COUNTERS = [...(cfg.disable.youtubeMembers ? ['ytMembers'] : []), ...(cfg.disable.twitchSubs ? ['twSubs'] : [])];
const DISABLED_TYPES = [...(cfg.disable.youtubeMembers ? ['youtube.member'] : []), ...(cfg.disable.twitchSubs ? ['twitch.sub', 'twitch.resub', 'twitch.gift'] : [])];
const COUNTER_KEYS = ['ytSubs', 'ytMembers', 'twFollowers', 'twSubs', 'bmcMembers', 'bmcCoffees'];
const QUEUE_MAX = 2000;
const RECENT_MAX = 100;

const isOverlayAlertClient = (c) => c.kind === 'overlay' && c.alerts;
const isAdminClient = (c) => c.kind === 'admin';

class Engine {
  constructor({ store, hub }) {
    this.store = store;
    this.hub = hub;
    this.timer = null;
    this.lastAlertAt = 0;
  }

  get settings() {
    return this.store.state.settings;
  }

  /* ───────────── counters ───────────── */

  snapshot() {
    const s = this.store.state;
    const set = this.settings;
    const values = {};
    for (const k of COUNTER_KEYS) {
      const base = s.counters[k];
      values[k] = base === null || base === undefined ? null : Math.max(0, Math.round(base + (set.offsets[k] || 0)));
    }
    return {
      values,
      show: { ...set.show, ...Object.fromEntries(DISABLED_COUNTERS.map((k) => [k, false])) },
      hidden: { ytSubs: !!s.counters.ytSubsHidden },
      updatedAt: { ...s.updatedAt },
    };
  }

  rawCounters() {
    return { ...this.store.state.counters };
  }

  pushCounters() {
    this.hub.broadcast('counters', this.snapshot());
  }

  // Authoritative value from a provider (API poll / reconcile).
  setCounter(key, value) {
    const c = this.store.state.counters;
    const v = value === null || value === undefined ? null : Number(value);
    if (v !== null && !Number.isFinite(v)) return;
    const changed = c[key] !== v;
    c[key] = v;
    this.store.state.updatedAt[key] = Date.now();
    this.store.save();
    if (changed) this.pushCounters();
  }

  setFlag(key, value) {
    const c = this.store.state.counters;
    if (c[key] === value) return;
    c[key] = value;
    this.store.save();
    this.pushCounters();
  }

  // Optimistic bump so a webhook shows up before the next poll.
  bump(key, delta) {
    const c = this.store.state.counters;
    if (c[key] === null || c[key] === undefined) return;
    c[key] = Math.max(0, c[key] + delta);
    this.store.state.updatedAt[key] = Date.now();
    this.store.save();
    this.pushCounters();
  }

  /* ───────────── events ───────────── */

  /**
   * e = { key?, type, name, detail?, message?, bump?: [[counterKey, delta]], test?, quiet? (log and count only) }
   * Returns { duplicate } | { queued } | { logged }.
   */
  ingest(e) {
    const meta = TYPES[e.type];
    if (!meta) throw new Error(`unknown event type ${e.type}`);
    if (DISABLED_TYPES.includes(e.type)) return { ignored: true };
    const state = this.store.state;

    if (!e.test && e.key && !this.store.markSeen(e.key)) return { duplicate: true };

    const entry = {
      id: randomUUID(),
      ts: Date.now(),
      type: e.type,
      name: clean(e.name, 40) || meta.fallback,
      detail: clean(e.detail, 80),
      message: clean(e.message, 160),
      test: !!e.test,
      queued: false,
    };

    if (!e.test) for (const [k, d] of e.bump || []) this.bump(k, d);

    const enabled = !e.quiet && (e.test || state.settings.alerts[e.type] !== false);
    if (enabled) {
      if (state.queue.length >= QUEUE_MAX) state.queue.shift();
      state.queue.push({
        id: entry.id,
        type: entry.type,
        platform: meta.platform,
        label: meta.label,
        icon: meta.icon,
        name: entry.name,
        detail: entry.detail,
        message: entry.message,
        test: entry.test,
      });
      entry.queued = true;
    }

    this.record(entry);
    if (entry.queued) {
      this.pushQueue();
      this.schedule();
    }
    return entry.queued ? { queued: true } : { logged: true };
  }

  // A line in the activity log with no announcement (refunds, cancellations…).
  note(text, extra = {}) {
    this.record({ id: randomUUID(), ts: Date.now(), type: 'note', name: clean(text, 120), detail: '', message: '', test: false, queued: false, ...extra });
  }

  // What the "latest supporter" overlay shows (no internal fields).
  latestOf(e) {
    const t = TYPES[e.type] || {};
    return { name: e.name, label: t.label || '', platform: t.platform || '', detail: e.detail || '', ts: e.ts };
  }

  latest() {
    const e = this.store.state.recent.find((r) => r.type !== 'note');
    return e ? this.latestOf(e) : null;
  }

  record(entry) {
    const recent = this.store.state.recent;
    recent.unshift(entry);
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
    this.store.save();
    this.hub.broadcast('log', entry, isAdminClient);
    if (entry.type !== 'note') this.hub.broadcast('latest', this.latestOf(entry), (c) => c.kind === 'overlay' && c.latest);
  }

  /* ───────────── paced announcer ───────────── */

  intervalMs() {
    return Math.min(60000, Math.max(1000, Number(this.settings.alertIntervalMs) || 5000));
  }

  durationMs() {
    const interval = this.intervalMs();
    const want = Number(this.settings.alertDurationMs) || 4200;
    return Math.max(1000, Math.min(want, interval - 300, 15000));
  }

  start() {
    if (this.store.state.queue.length) this.schedule();
  }

  schedule(delayOverride) {
    if (this.timer) return;
    const wait =
      delayOverride !== undefined ? delayOverride : Math.max(0, this.lastAlertAt + this.intervalMs() - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, wait);
  }

  tick() {
    const queue = this.store.state.queue;
    if (!queue.length) return;

    // Nobody is watching: keep the alert for when an OBS source connects.
    if (this.settings.holdWhenNoOverlay && this.hub.count(isOverlayAlertClient) === 0) {
      this.schedule(1500);
      return;
    }

    const alert = queue.shift();
    this.lastAlertAt = Date.now();
    this.store.save();
    this.hub.broadcast('alert', { ...alert, durationMs: this.durationMs() }, isOverlayAlertClient);
    this.pushQueue();
    log(`[alert] ${alert.type} → ${alert.name} (${queue.length} waiting)`);
    if (queue.length) this.schedule();
  }

  skip() {
    const skipped = this.store.state.queue.shift();
    this.store.save();
    this.pushQueue();
    return !!skipped;
  }

  clear() {
    const n = this.store.state.queue.length;
    this.store.state.queue.length = 0;
    this.store.save();
    this.pushQueue();
    return n;
  }

  queueSummary() {
    const q = this.store.state.queue;
    return {
      length: q.length,
      intervalMs: this.intervalMs(),
      items: q.slice(0, 12).map(({ id, type, name, detail, platform, label, test }) => ({ id, type, name, detail, platform, label, test })),
    };
  }

  pushQueue() {
    this.hub.broadcast('queue', this.queueSummary(), isAdminClient);
  }
}

module.exports = { Engine, TYPES, COUNTER_KEYS, DISABLED_COUNTERS, DISABLED_TYPES };
