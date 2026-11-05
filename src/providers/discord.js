'use strict';

const cfg = require('../config');
const { fetchJson, log } = require('../util');

// Reads the Discord channel(s) in DISCORD_CHANNEL_IDS with a bot token by polling the
// REST API every few seconds. No gateway/websocket, so nothing to reconnect: a failed
// poll is simply retried, with per-channel back-off and rate-limit handling.

const UA = `DiscordBot (${cfg.publicUrl}, 1.0)`;
const EMOJI = /<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>/g;

const cmpSnowflake = (a, b) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

// Discord markup → plain parts (custom emoji become images, mentions become @names).
function toParts(m) {
  const users = new Map((m.mentions || []).map((u) => [u.id, u.global_name || u.username]));
  const text = String(m.content || '')
    .replace(/<@!?(\d+)>/g, (_, id) => `@${users.get(id) || 'user'}`)
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel');
  const parts = [];
  let last = 0;
  let hit;
  EMOJI.lastIndex = 0;
  while ((hit = EMOJI.exec(text))) {
    if (hit.index > last) parts.push({ t: 'text', v: text.slice(last, hit.index) });
    parts.push({ t: 'emoji', name: hit[2], url: `https://cdn.discordapp.com/emojis/${hit[3]}.${hit[1] ? 'gif' : 'png'}?size=48` });
    last = hit.index + hit[0].length;
  }
  if (last < text.length) parts.push({ t: 'text', v: text.slice(last) });
  const extras = [];
  if (m.attachments && m.attachments.length) extras.push(m.attachments.length > 1 ? `[${m.attachments.length} attachments]` : '[attachment]');
  if (m.sticker_items && m.sticker_items.length) extras.push('[sticker]');
  if (extras.length) parts.push({ t: 'text', v: `${parts.length ? ' ' : ''}${extras.join(' ')}` });
  return parts;
}

module.exports = function createDiscord({ chat, store, hub }) {
  const configured = !!(cfg.discord.token && cfg.discord.channelIds.length);
  const channels = cfg.discord.channelIds.map((id) => ({ id, name: null, after: null, baselined: false, fails: 0, nextAt: 0, error: null, ok: false }));
  const st = { state: 'off', detail: 'Not started', lastOkAt: null };
  let running = false;
  let wakeFn = null;
  let fatalUntil = 0;

  const T = (ms) => Math.max(15, Math.round(ms * cfg.timeScale));
  const conf = () => store.state.settings.chat;
  const short = (m) => String(m || '').replace(/^HTTP \d+ from \S+: /, '').slice(0, 120);

  const api = (path) => fetchJson(cfg.endpoints.discordApi + path, { headers: { Authorization: `Bot ${cfg.discord.token}`, 'User-Agent': UA } });

  function status() {
    return {
      configured,
      state: st.state,
      detail: st.detail,
      lastOkAt: st.lastOkAt,
      channels: channels.map((c) => ({ id: c.id, name: c.name, ok: c.ok, error: c.error })),
    };
  }

  function setState(state, detail) {
    const changed = st.state !== state || st.detail !== detail;
    st.state = state;
    st.detail = detail;
    if (changed) {
      hub.broadcast('chatstatus', { discord: status() }, (c) => c.kind === 'admin');
      hub.broadcast('livestatus', { discord: st.state }, (c) => c.kind === 'overlay' && c.status);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        wakeFn = null;
        resolve();
      }, ms);
      wakeFn = () => {
        clearTimeout(t);
        wakeFn = null;
        resolve();
      };
    });
  }
  const wake = () => wakeFn && wakeFn();

  function handleMessage(m) {
    if (![0, 19].includes(m.type)) return; // normal messages and replies only (no joins, pins…)
    const parts = toParts(m);
    if (!parts.length) return;
    chat.push({
      source: 'discord',
      id: m.id,
      name: (m.author && (m.author.global_name || m.author.username)) || 'someone',
      aid: m.author && m.author.id,
      bot: !!(m.author && m.author.bot),
      kind: 'message',
      parts,
    });
  }

  async function pollChannel(ch) {
    if (!ch.baselined) {
      if (!ch.name) {
        try {
          ch.name = (await api(`/channels/${ch.id}`)).name || null;
        } catch (e) {
          if ([401, 403, 404].includes(e.status)) throw e; // name is best-effort for anything else
        }
      }
      const latest = await api(`/channels/${ch.id}/messages?limit=1`);
      ch.after = (Array.isArray(latest) && latest[0] && latest[0].id) || '0'; // start from "now": no history replay
      ch.baselined = true;
      return;
    }
    const r = await api(`/channels/${ch.id}/messages?after=${ch.after}&limit=50`);
    if (!Array.isArray(r) || !r.length) return;
    r.sort((a, b) => cmpSnowflake(a.id, b.id)); // the API answers newest-first
    ch.after = r[r.length - 1].id;
    for (const m of r) handleMessage(m);
  }

  // Returns extra delay (ms) the whole loop should honor.
  function handleError(ch, e) {
    ch.ok = false;
    if (e.status === 401) {
      fatalUntil = Date.now() + T(10 * 60_000);
      ch.error = 'Discord rejected the bot token. Check DISCORD_BOT_TOKEN.';
      log('[discord] 401: bot token rejected; pausing for 10 minutes');
      return 0;
    }
    if (e.status === 403) {
      ch.error = 'The bot cannot read this channel. Give it View Channel and Read Message History.';
      ch.baselined = false;
      ch.nextAt = Date.now() + T(60_000);
      return 0;
    }
    if (e.status === 404) {
      ch.error = 'Channel not found. Check DISCORD_CHANNEL_IDS.';
      ch.baselined = false;
      ch.nextAt = Date.now() + T(60_000);
      return 0;
    }
    if (e.status === 429) {
      const secs = Number(e.body && e.body.retry_after) || 5;
      ch.error = `Discord asked us to slow down for ${secs}s.`;
      return Math.ceil(secs * 1000) + 250;
    }
    ch.fails += 1;
    ch.error = `Connection problem: ${short(e.message)}`;
    ch.nextAt = Date.now() + T(Math.min(3000 * 2 ** ch.fails, 60_000));
    if (ch.fails >= 3) ch.baselined = false; // after a long outage, rejoin at "now" instead of replaying the gap
    log(`[discord] ${ch.id}: ${e.message}`);
    return 0;
  }

  function refreshState() {
    const ok = channels.filter((c) => c.ok);
    if (Date.now() < fatalUntil) return setState('error', channels[0].error || 'Discord rejected the bot token.');
    if (ok.length) return setState('online', `Listening to ${ok.map((c) => `#${c.name || c.id}`).join(', ')}`);
    const bad = channels.find((c) => c.error);
    return setState(bad ? 'error' : 'starting', bad ? `${bad.error}` : 'Connecting…');
  }

  async function loop() {
    while (running) {
      try {
        if (!configured) {
          setState('off', cfg.discord.token || cfg.discord.channelIds.length ? 'Set both DISCORD_BOT_TOKEN and DISCORD_CHANNEL_IDS in .env.' : 'Not set up. Add DISCORD_BOT_TOKEN and DISCORD_CHANNEL_IDS to .env.');
          await sleep(T(15_000));
          continue;
        }
        const c = conf();
        if (!c.enabled || !c.discord) {
          setState('off', 'Discord chat is turned off.');
          for (const ch of channels) ch.baselined = false; // rejoin at "now" when switched back on
          await sleep(T(5000));
          continue;
        }
        if (Date.now() < fatalUntil) {
          refreshState();
          await sleep(T(5000));
          continue;
        }
        let delay = 3000;
        for (const ch of channels) {
          if (Date.now() < ch.nextAt) continue;
          try {
            await pollChannel(ch);
            ch.error = null;
            ch.ok = true;
            ch.fails = 0;
            st.lastOkAt = Date.now();
          } catch (e) {
            delay = Math.max(delay, handleError(ch, e));
          }
        }
        refreshState();
        await sleep(T(delay));
      } catch (e) {
        log(`[discord] loop error: ${e.message}`);
        await sleep(T(10_000));
      }
    }
  }

  return {
    status,
    wake,
    // "Check now" in the dashboard: forget back-offs and try immediately.
    retry() {
      fatalUntil = 0;
      for (const ch of channels) ch.nextAt = 0;
      wake();
    },
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
      wake();
    },
  };
};
