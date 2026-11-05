'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (KEY=value, # comments, optional quotes). Real environment
// variables always win over the file, so systemd/Docker overrides keep working.
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) {
      const q = v[0];
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, '\n');
    } else {
      v = v.replace(/\s+#.*$/, ''); // inline comment (quote the value if it contains " #")
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

// PUT_… values are the placeholders shipped in .env.example. They count as empty: a published placeholder
// must never work as a webhook secret or a token.
const env = (name, def = '') => {
  const v = process.env[name];
  return v === undefined || v === '' || /^PUT_/i.test(String(v).trim()) ? def : String(v).trim();
};

const int = (name, def, min, max) => {
  const n = parseInt(env(name, ''), 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
};

const warnings = [];

const port = int('PORT', 42001, 1, 65535);

let sessionSecret = env('SESSION_SECRET');
if (sessionSecret.length < 32) {
  warnings.push(
    sessionSecret
      ? 'SESSION_SECRET is shorter than 32 characters; using a random one for this run (admin sessions reset on restart).'
      : 'SESSION_SECRET is not set; using a random one for this run (admin sessions reset on restart).'
  );
  sessionSecret = crypto.randomBytes(32).toString('hex');
}

const adminPassword = env('ADMIN_PASSWORD');
if (!adminPassword) warnings.push('ADMIN_PASSWORD is not set: the /admin login is disabled.');

let eventsubSecret = env('TWITCH_EVENTSUB_SECRET');
if (eventsubSecret && (eventsubSecret.length < 10 || eventsubSecret.length > 100)) {
  warnings.push('TWITCH_EVENTSUB_SECRET must be 10-100 characters; Twitch webhooks are disabled until fixed.');
  eventsubSecret = '';
}

const bmcSecret = env('BMC_WEBHOOK_SECRET');
const bmcToken = env('BMC_WEBHOOK_TOKEN');
if (!bmcSecret && !bmcToken) {
  warnings.push('Neither BMC_WEBHOOK_SECRET nor BMC_WEBHOOK_TOKEN is set: Buy Me a Coffee webhooks will be rejected.');
}

const discordChannelIds = env('DISCORD_CHANNEL_IDS')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^\d{15,25}$/.test(s));
// The chat feed reads Discord with its own token if it has one, otherwise with Snitch's.
const discordChatToken = env('DISCORD_BOT_TOKEN') || env('SNITCH_BOT_TOKEN');
if (env('DISCORD_BOT_TOKEN') && !discordChannelIds.length) warnings.push('DISCORD_BOT_TOKEN is set but DISCORD_CHANNEL_IDS has no valid channel IDs: Discord chat is off.');
if (!discordChatToken && discordChannelIds.length) warnings.push('DISCORD_CHANNEL_IDS is set but there is no DISCORD_BOT_TOKEN or SNITCH_BOT_TOKEN: Discord chat is off.');

const flag = (name) => /^(1|true|yes|on)$/i.test(env(name, '').trim());

const cfg = {
  root: ROOT,
  // Switch whole features off from .env (they disappear from the overlay, dashboard and API calls).
  disable: {
    youtubeMembers: flag('DISABLE_YOUTUBE_MEMBERS'),
    twitchSubs: flag('DISABLE_TWITCH_SUBS'),
  },
  port,
  host: env('HOST', '127.0.0.1'),
  publicUrl: env('PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
  adminPassword,
  sessionSecret,
  overlayKey: env('OVERLAY_KEY'),
  youtube: {
    clientId: env('YOUTUBE_CLIENT_ID'),
    clientSecret: env('YOUTUBE_CLIENT_SECRET'),
  },
  twitch: {
    clientId: env('TWITCH_CLIENT_ID'),
    clientSecret: env('TWITCH_CLIENT_SECRET'),
    eventsubSecret,
    // Whose chat to read. Defaults to the connected Twitch account.
    channel: (env('TWITCH_CHANNEL') || '').trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_]/g, ''),
  },
  bmc: {
    webhookSecret: bmcSecret,
    webhookToken: bmcToken,
  },
  discord: {
    token: discordChatToken,
    channelIds: discordChannelIds,
  },
  // Snitch, the Discord bot in src/bot/. Its own settings are read by src/bot/config.mjs.
  bot: {
    enabled: !!env('SNITCH_BOT_TOKEN'),
  },
  // Test-suite only: shrinks the chat readers' waits/back-offs (1 = real time).
  timeScale: Math.min(1, Math.max(0.005, parseFloat(env('TIME_SCALE', '1')) || 1)),
  // Upstream API roots. Only overridden by the test-suite (mock servers).
  endpoints: {
    youtubeApi: env('YOUTUBE_API_BASE', 'https://www.googleapis.com/youtube/v3'),
    googleAuth: env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    googleToken: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    twitchId: env('TWITCH_ID_BASE', 'https://id.twitch.tv/oauth2'),
    twitchHelix: env('TWITCH_HELIX_BASE', 'https://api.twitch.tv/helix'),
    twitchIrcHost: env('TWITCH_IRC_HOST', 'irc.chat.twitch.tv'),
    twitchIrcPort: parseInt(env('TWITCH_IRC_PORT', '6697'), 10) || 6697,
    twitchIrcTls: !/^(0|false|no|off)$/i.test(env('TWITCH_IRC_TLS', 'true')),
    discordApi: env('DISCORD_API_BASE', 'https://discord.com/api/v10'),
  },
  warnings,
};

module.exports = cfg;
