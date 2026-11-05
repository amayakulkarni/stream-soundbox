'use strict';

const { randomUUID } = require('crypto');

// The combined YouTube + Discord feed. Providers hand raw messages to push();
// this module cleans them, applies the filters from the admin dashboard, keeps a
// short buffer (so a reloaded OBS source repopulates) and fans them out over SSE.

const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;
const MAX_TEXT = 300;
const BUFFER_MAX = 80;
const KEYS_MAX = 2000;
const EMOJI_URL = [
  /^https:\/\/cdn\.discordapp\.com\/emojis\/\d+\.(png|gif)(\?size=\d+)?$/,
  /^https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/[\w-]+\/default\/dark\/[123]\.0$/,
];
const BADGES = new Set(['owner', 'mod', 'member', 'vip']);

const isChatOverlay = (c) => c.kind === 'overlay' && c.chat;
const isAdmin = (c) => c.kind === 'admin';

// Strip control / bidi-override characters and collapse whitespace; does not trim.
function sanitize(s, max) {
  return Array.from(String(s === null || s === undefined ? '' : s).replace(CONTROL, ' ').replace(/\s+/g, ' ')).slice(0, max).join('');
}

const plainText = (parts) => parts.map((p) => (p.t === 'text' ? p.v : `:${p.name}:`)).join('');

const publicMsg = (m) => ({ id: m.id, source: m.source, name: m.name, parts: m.parts, badges: m.badges, kind: m.kind, amount: m.amount, ts: m.ts });

class Chat {
  constructor({ store, hub }) {
    this.store = store;
    this.hub = hub;
    this.buffer = [];
    this.keys = new Set();
    this.keyOrder = [];
  }

  get settings() {
    return this.store.state.settings.chat;
  }

  // Number of overlays that would actually display chat right now.
  listening() {
    return this.hub.count(isChatOverlay);
  }

  /**
   * raw = { source:'youtube'|'discord', id, name, aid?, bot?, kind?, amount?, badges?, parts:[{t:'text',v}|{t:'emoji',url,name}] }
   * opts.force skips the on/off and filter settings (used by "send test message").
   * Returns the stored message, or null when it was filtered out.
   */
  push(raw, opts = {}) {
    const s = this.settings;
    if (!opts.force) {
      if (!s.enabled) return null;
      if (raw.source === 'youtube' && !s.youtube) return null;
      if (raw.source === 'twitch' && !s.twitch) return null;
      if (raw.source === 'discord' && !s.discord) return null;
      if (raw.bot && s.hideBots) return null;
    }

    let budget = MAX_TEXT;
    const parts = [];
    for (const p of raw.parts || []) {
      if (budget <= 0) break;
      if (p.t === 'emoji') {
        if (EMOJI_URL.some((re) => re.test(String(p.url)))) {
          parts.push({ t: 'emoji', url: p.url, name: sanitize(p.name, 32) });
          budget -= 2;
        }
        continue;
      }
      const v = sanitize(p.v, budget);
      if (v) {
        parts.push({ t: 'text', v });
        budget -= Array.from(v).length;
      }
    }
    if (parts.length && parts[0].t === 'text') parts[0].v = parts[0].v.replace(/^\s+/, '');
    if (parts.length && parts[parts.length - 1].t === 'text') parts[parts.length - 1].v = parts[parts.length - 1].v.replace(/\s+$/, '');

    const kind = ['message', 'superchat', 'member'].includes(raw.kind) ? raw.kind : 'message';
    const plain = plainText(parts).trim();
    if (!plain && kind === 'message') return null;

    if (!opts.force) {
      if (s.hideCommands && plain.startsWith('!')) return null;
      const words = String(s.blocked || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
      const lower = plain.toLowerCase();
      if (words.some((w) => lower.includes(w))) return null;
    }

    const key = `${raw.source}:${raw.id}`;
    if (this.keys.has(key)) return null;
    this.keys.add(key);
    this.keyOrder.push(key);
    if (this.keyOrder.length > KEYS_MAX) this.keys.delete(this.keyOrder.shift());

    const msg = {
      id: randomUUID(),
      key,
      source: raw.source,
      name: sanitize(raw.name, 32).trim() || 'someone',
      aid: raw.aid ? String(raw.aid) : '',
      parts,
      badges: (raw.badges || []).filter((b) => BADGES.has(b)),
      kind,
      amount: sanitize(raw.amount, 20).trim(),
      ts: Date.now(),
    };
    this.buffer.push(msg);
    if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
    this.hub.broadcast('chat', publicMsg(msg), (c) => isChatOverlay(c) || isAdmin(c));
    return msg;
  }

  // Provider-side deletions (YouTube moderators removing a message, bans).
  removeByKey(source, id) {
    const key = `${source}:${id}`;
    const hit = this.buffer.find((m) => m.key === key);
    if (hit) this.#drop([hit]);
  }

  removeByAuthor(source, aid) {
    if (!aid) return;
    const hits = this.buffer.filter((m) => m.source === source && m.aid === String(aid));
    if (hits.length) this.#drop(hits);
  }

  #drop(msgs) {
    const ids = new Set(msgs.map((m) => m.id));
    this.buffer = this.buffer.filter((m) => !ids.has(m.id));
    for (const id of ids) this.hub.broadcast('chatdel', { id }, (c) => isChatOverlay(c) || isAdmin(c));
  }

  clear() {
    this.buffer = [];
    this.hub.broadcast('chatclear', {}, (c) => isChatOverlay(c) || isAdmin(c));
  }

  recent(limit) {
    const { max, ttlSec } = this.settings;
    const cutoff = ttlSec > 0 ? Date.now() - ttlSec * 1000 : 0;
    return this.buffer.filter((m) => m.ts >= cutoff).slice(-(limit || max)).map(publicMsg);
  }

  snapshot() {
    return { settings: { max: this.settings.max, ttlSec: this.settings.ttlSec }, recent: this.recent() };
  }
}

module.exports = { Chat };
