'use strict';

const path = require('path');
const crypto = require('crypto');

const cfg = require('./config');
const { log, safeEq, clean } = require('./util');
const { App, raw, json, urlencoded, serveStatic } = require('./http');
const { Store, tokens } = require('./store');
const { Hub } = require('./hub');
const { Engine, TYPES, COUNTER_KEYS, DISABLED_COUNTERS, DISABLED_TYPES } = require('./engine');
const auth = require('./auth');
const createYouTube = require('./providers/youtube');
const createTwitch = require('./providers/twitch');
const createBmc = require('./providers/bmc');
const createDiscord = require('./providers/discord');
const createYouTubeChat = require('./providers/ytchat');
const createTwitchChat = require('./providers/twitchchat');
const { Chat } = require('./chat');
const { createBotBridge } = require('./botbridge');
const sounds = require('./sounds');

const PUBLIC = path.join(cfg.root, 'public');

const store = new Store();
const hub = new Hub();
const engine = new Engine({ store, hub });
const youtube = createYouTube({ store, tokens, engine });
const twitch = createTwitch({ store, tokens, engine });
const bot = createBotBridge({ enabled: cfg.bot.enabled, load: () => import('./bot/bot.mjs'), log });
const bmc = createBmc({ store, engine, forward: bot.bmcEvent });
const chat = new Chat({ store, hub });
const discord = createDiscord({ chat, store, hub });
const ytChat = createYouTubeChat({ yt: youtube, chat, store, hub });
const twChat = createTwitchChat({ chat, store, hub });

const app = new App();

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    // 'same-origin' (not 'no-referrer'): browsers send Origin: null on same-origin form posts under no-referrer,
    // which would break the admin login's Origin check.
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; media-src 'self' blob:; img-src 'self' data: https://cdn.discordapp.com https://static-cdn.jtvnw.net; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
});

/* ───────────── webhooks (raw bodies: signatures cover the exact bytes) ───────────── */

app.post('/webhooks/twitch', raw(), twitch.handleWebhook);
app.post('/webhooks/bmc', raw(), bmc.handleWebhook);

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

/* ───────────── overlay (public, optional ?key=) ───────────── */

function overlayKey(req, res, next) {
  if (!cfg.overlayKey) return next();
  const key = req.query.key;
  if (typeof key === 'string' && safeEq(key, cfg.overlayKey)) return next();
  return res.status(403).type('text/plain').send('forbidden: missing or wrong ?key=');
}

const sendPage = (res, file) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC, file));
};

app.get('/', (req, res) => res.redirect('/overlay'));
// Every widget works as its own OBS source: /overlay/<name> (and the short /<name>).
const WIDGETS = ['counters', 'alerts', 'chat', 'comments', 'goal', 'status', 'latest'];
app.get(['/overlay', ...WIDGETS.flatMap((w) => [`/overlay/${w}`, `/${w}`])], overlayKey, (req, res) => sendPage(res, 'overlay.html'));
app.use('/sounds', overlayKey);
app.use('/sounds', serveStatic(sounds.DIR, { prefix: '/sounds', headers: { 'Cache-Control': 'no-cache' } }));
app.use('/assets', serveStatic(path.join(PUBLIC, 'assets'), { prefix: '/assets', headers: { 'Cache-Control': 'no-cache' } }));

// Which overlays are connected right now (shown in the dashboard so you can tell which OBS source is alive).
const overlayList = () => [...hub.clients.values()].filter((c) => c.kind === 'overlay').map((c) => ({ view: c.view, name: c.label || '', since: c.connectedAt }));
const pushOverlays = () => hub.broadcast('overlays', overlayList(), (c) => c.kind === 'admin');

app.get('/api/stream', overlayKey, (req, res) => {
  const view = ['counters', 'alerts', 'chat', 'goal', 'status', 'latest'].includes(req.query.view) ? req.query.view : 'all';
  const label = clean(req.query.name, 24);
  const client = hub.add(req, res, { kind: 'overlay', label, view, alerts: view === 'all' || view === 'alerts', chat: view === 'all' || view === 'chat', latest: view === 'latest', status: view === 'status' });
  if (!client) return;
  pushOverlays();
  res.on('close', () => setTimeout(pushOverlays, 50));
  hub.send(client, 'snapshot', {
    counters: engine.snapshot(),
    style: store.state.settings.style,
    chat: chat.snapshot(),
    goal: store.state.settings.goal,
    sound: store.state.settings.sound,
    live: { youtube: ytChat.status().state, twitch: twChat.status().state, discord: discord.status().state },
    latest: engine.latest(),
  });
});

/* ───────────── admin ───────────── */

app.use('/admin', auth.originCheck);
app.use('/admin/assets', serveStatic(path.join(PUBLIC, 'admin', 'assets'), { prefix: '/admin/assets', headers: { 'Cache-Control': 'no-cache' } }));

app.get('/admin', (req, res) => sendPage(res, auth.isAuthed(req) ? 'admin/index.html' : 'admin/login.html'));

app.post('/admin/login', urlencoded(), (req, res) => {
  if (!cfg.adminPassword) return res.redirect(303, '/admin?e=disabled');
  if (auth.throttled(req.ip)) return res.redirect(303, '/admin?e=throttled');
  if (!auth.checkPassword(req.body && req.body.password)) {
    auth.recordFail(req.ip);
    log(`[admin] failed login from ${req.ip}`);
    return res.redirect(303, '/admin?e=bad');
  }
  auth.recordSuccess(req.ip);
  auth.setSession(req, res);
  return res.redirect(303, '/admin');
});

app.post('/admin/logout', (req, res) => {
  auth.clearSession(req, res);
  res.redirect(303, '/admin');
});

// ── everything below needs a session ──
app.use('/admin', (req, res, next) => {
  if (auth.isAuthed(req)) return next();
  if (req.path.startsWith('/admin/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/admin');
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    log(`[admin] ${req.method} ${req.path} failed: ${e.message}`);
    res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message });
  });

function sanitizeSettings(input, current) {
  const out = JSON.parse(JSON.stringify(current));
  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
  };
  const setNum = (key, min, max) => {
    if (input[key] === undefined) return;
    const n = num(input[key], min, max);
    if (n !== undefined) out[key] = n;
  };
  const setBool = (key) => {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  };
  setNum('alertIntervalMs', 1000, 60000);
  setNum('alertDurationMs', 1000, 15000);
  setNum('youtubePollSec', 30, 3600);
  setNum('twitchPollSec', 15, 3600);
  setBool('holdWhenNoOverlay');
  setBool('twitchPollFollowers');
  if (input.sound && typeof input.sound === 'object') {
    const so = input.sound;
    for (const k of ['enabled', 'speak']) if (typeof so[k] === 'boolean') out.sound[k] = so[k];
    for (const [k, lo, hi] of [['volume', 0, 100], ['speakRate', 50, 200]]) {
      const n = num(so[k], lo, hi);
      if (so[k] !== undefined && n !== undefined) out.sound[k] = n;
    }
    if (so.types && typeof so.types === 'object') {
      for (const k of Object.keys(TYPES)) if (typeof so.types[k] === 'string' && sounds.SOUND_REF.test(so.types[k])) out.sound.types[k] = so.types[k];
    }
  }
  if (input.goal && typeof input.goal === 'object') {
    const g = input.goal;
    if (typeof g.title === 'string') out.goal.title = g.title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
    if (g.counter === 'followers' || COUNTER_KEYS.includes(g.counter)) out.goal.counter = g.counter;
    const n = num(g.target, 1, 100_000_000);
    if (n !== undefined) out.goal.target = n;
  }
  if (input.style && typeof input.style === 'object') {
    const n = num(input.style.panelOpacity, 0, 100);
    if (n !== undefined) out.style.panelOpacity = n;
  }
  if (input.chat && typeof input.chat === 'object') {
    const c = input.chat;
    for (const k of ['enabled', 'youtube', 'twitch', 'discord', 'hideBots', 'hideCommands']) if (typeof c[k] === 'boolean') out.chat[k] = c[k];
    const lim = { max: [1, 30], ttlSec: [0, 3600], ytSearchSec: [30, 900], ytMinPollSec: [5, 120] };
    for (const [k, [lo, hi]] of Object.entries(lim)) {
      if (c[k] === undefined) continue;
      const n = num(c[k], lo, hi);
      if (n !== undefined) out.chat[k] = n;
    }
    if (typeof c.blocked === 'string') out.chat.blocked = c.blocked.replace(/[\u0000-\u001f]/g, ' ').slice(0, 500);
  }
  if (input.alerts && typeof input.alerts === 'object') {
    for (const k of Object.keys(TYPES)) if (typeof input.alerts[k] === 'boolean') out.alerts[k] = input.alerts[k];
  }
  if (input.show && typeof input.show === 'object') {
    for (const k of Object.keys(out.show)) if (typeof input.show[k] === 'boolean') out.show[k] = input.show[k];
  }
  if (input.offsets && typeof input.offsets === 'object') {
    for (const k of Object.keys(out.offsets)) {
      if (input.offsets[k] === undefined) continue;
      const n = num(input.offsets[k], -10_000_000, 10_000_000);
      if (n !== undefined) out.offsets[k] = n;
    }
  }
  return out;
}

function overlayUrls(origin) {
  const q = cfg.overlayKey ? `?key=${encodeURIComponent(cfg.overlayKey)}` : '';
  return { all: `${origin}/overlay${q}`, counters: `${origin}/overlay/counters${q}`, alerts: `${origin}/overlay/alerts${q}`, chat: `${origin}/overlay/chat${q}`, comments: `${origin}/comments${q}`, goal: `${origin}/goal${q}`, status: `${origin}/status${q}`, latest: `${origin}/latest${q}` };
}

function fullState() {
  return {
    settings: store.state.settings,
    counters: { raw: engine.rawCounters(), snapshot: engine.snapshot() },
    queue: engine.queueSummary(),
    recent: store.state.recent.slice(0, 60),
    status: { youtube: youtube.status(), twitch: twitch.status(), bmc: bmc.status() },
    chat: { youtube: ytChat.status(), twitch: twChat.status(), discord: discord.status(), buffered: chat.buffer.length, overlays: chat.listening() },
    urls: { public: overlayUrls(cfg.publicUrl), local: overlayUrls(`http://localhost:${cfg.port}`) },
    types: Object.fromEntries(Object.entries(TYPES).filter(([k]) => !DISABLED_TYPES.includes(k))),
    counterKeys: COUNTER_KEYS.filter((k) => !DISABLED_COUNTERS.includes(k)),
    disabled: cfg.disable,
    sounds: { builtin: sounds.BUILTIN_INFO, files: sounds.list(), keyQuery: cfg.overlayKey ? `?key=${encodeURIComponent(cfg.overlayKey)}` : '' },
    overlays: {
      connected: hub.count((c) => c.kind === 'overlay'),
      listeningForAlerts: hub.count((c) => c.kind === 'overlay' && c.alerts),
      listeningForChat: chat.listening(),
      list: overlayList(),
    },
    serverTime: Date.now(),
  };
}

app.get('/admin/api/state', (req, res) => res.json(fullState()));

app.get('/admin/api/stream', (req, res) => {
  const client = hub.add(req, res, { kind: 'admin' });
  if (client) hub.send(client, 'hello', { ok: true });
});

app.post(
  '/admin/api/settings',
  json(),
  wrap((req, res) => {
    store.state.settings = sanitizeSettings(req.body || {}, store.state.settings);
    store.save();
    engine.pushCounters();
    engine.pushQueue();
    hub.broadcast('settings', store.state.settings);
    hub.broadcast('look', { style: store.state.settings.style, chat: chat.snapshot(), goal: store.state.settings.goal, sound: store.state.settings.sound }, (c) => c.kind === 'overlay');
    ytChat.wake();
    twChat.wake();
    discord.wake();
    res.json({ settings: store.state.settings });
  })
);

app.post('/admin/api/queue/skip', wrap((req, res) => res.json({ skipped: engine.skip(), queue: engine.queueSummary() })));
app.post('/admin/api/queue/clear', wrap((req, res) => res.json({ cleared: engine.clear(), queue: engine.queueSummary() })));

app.post(
  '/admin/api/test',
  json(),
  wrap((req, res) => {
    const b = req.body || {};
    if (!TYPES[b.type]) throw Object.assign(new Error('unknown alert type'), { status: 400 });
    const count = Math.min(10, Math.max(1, parseInt(b.count, 10) || 1));
    for (let i = 0; i < count; i++) {
      engine.ingest({
        type: b.type,
        name: count > 1 ? `${b.name || 'Test supporter'} ${i + 1}` : b.name || 'Test supporter',
        detail: b.detail,
        message: b.message,
        test: true,
      });
    }
    res.json({ queue: engine.queueSummary() });
  })
);

app.post(
  '/admin/api/sounds',
  raw(sounds.MAX_BYTES + 1024),
  wrap((req, res) => {
    const name = sounds.save(req.query.name, req.body);
    res.json({ name, files: sounds.list() });
  })
);

app.post(
  '/admin/api/sounds/delete',
  json(),
  wrap((req, res) => {
    sounds.remove(req.body && req.body.name);
    // anything that used the file falls back to "none" rather than pointing at a missing file
    for (const [k, v] of Object.entries(store.state.settings.sound.types)) if (v === `file:${req.body.name}`) store.state.settings.sound.types[k] = 'none';
    store.save();
    hub.broadcast('look', { style: store.state.settings.style, chat: chat.snapshot(), goal: store.state.settings.goal, sound: store.state.settings.sound }, (c) => c.kind === 'overlay');
    res.json({ files: sounds.list(), settings: store.state.settings });
  })
);

app.post('/admin/api/chat/clear', wrap((req, res) => {
  chat.clear();
  res.json({ ok: true });
}));

app.post(
  '/admin/api/chat/test',
  json(),
  wrap((req, res) => {
    const b = req.body || {};
    const source = ['discord', 'twitch'].includes(b.source) ? b.source : 'youtube';
    const kind = ['message', 'superchat', 'member'].includes(b.kind) ? b.kind : 'message';
    chat.push(
      {
        source,
        id: `test-${Date.now()}-${Math.random()}`,
        name: b.name || 'Test viewer',
        kind,
        amount: kind === 'superchat' ? '$5.00' : '',
        badges: kind === 'member' ? ['member'] : [],
        parts: [{ t: 'text', v: b.text || (kind === 'member' ? 'just became a member!' : 'hi chat, this is a test message') }],
      },
      { force: true }
    );
    res.json({ ok: true, listening: chat.listening() });
  })
);

app.post('/admin/api/chat/retry', wrap((req, res) => {
  ytChat.wake();
  twChat.retry();
  discord.retry();
  res.json({ ok: true });
}));

const providers = { youtube, twitch };

app.post(
  '/admin/api/refresh/:provider',
  wrap(async (req, res) => {
    const p = providers[req.params.provider];
    if (!p) throw Object.assign(new Error('unknown provider'), { status: 404 });
    await p.refresh();
    res.json({ status: p.status(), counters: engine.snapshot() });
  })
);

app.post(
  '/admin/api/twitch/sync',
  wrap(async (req, res) => {
    try {
      res.json({ eventsub: await twitch.syncEventSub() });
    } catch (e) {
      throw Object.assign(e, { status: 400 });
    }
  })
);

app.post(
  '/admin/api/disconnect/:provider',
  wrap((req, res) => {
    const p = providers[req.params.provider];
    if (!p) throw Object.assign(new Error('unknown provider'), { status: 404 });
    p.disconnect();
    if (req.params.provider === 'youtube') ytChat.wake();
    if (req.params.provider === 'twitch') twChat.wake();
    res.json({ ok: true });
  })
);

// ── OAuth connect flows (admin session required) ──
const oauthStates = new Map();
function newOAuthState(provider) {
  const s = crypto.randomBytes(16).toString('hex');
  oauthStates.set(s, { provider, exp: Date.now() + 10 * 60 * 1000 });
  return s;
}
function takeOAuthState(state, provider) {
  const v = oauthStates.get(state);
  oauthStates.delete(state);
  return !!v && v.provider === provider && v.exp > Date.now();
}

function oauthRoutes(name, provider) {
  app.get(`/admin/auth/${name}`, (req, res) => {
    if (!provider.configured()) {
      return res.redirect(`/admin?notice=${encodeURIComponent(`Set ${name.toUpperCase()}_CLIENT_ID and ${name.toUpperCase()}_CLIENT_SECRET in .env first`)}`);
    }
    return res.redirect(provider.authUrl(newOAuthState(name)));
  });
  app.get(`/admin/auth/${name}/callback`, async (req, res) => {
    const { code, state, error, error_description: desc } = req.query;
    const back = (m) => res.redirect(`/admin?notice=${encodeURIComponent(String(m).slice(0, 200))}`);
    if (error) return back(`${name} authorization was cancelled: ${desc || error}`);
    if (typeof code !== 'string' || typeof state !== 'string' || !takeOAuthState(state, name)) return back('Authorization link expired. Try connecting again.');
    try {
      await provider.exchangeCode(code);
      if (name === 'twitch') twChat.wake();
      if (name === 'youtube') ytChat.wake();
      return back(`${name} connected`);
    } catch (e) {
      log(`[${name}] connect failed: ${e.message}`);
      return back(`${name} connect failed: ${e.message}`);
    }
  });
}
oauthRoutes('youtube', youtube);
oauthRoutes('twitch', twitch);

process.on('unhandledRejection', (e) => log('[unhandledRejection]', e && e.message ? e.message : e));
// A genuinely unexpected sync exception leaves unknown state: log it and exit so systemd / scripts/supervise.js restart cleanly.
process.on('uncaughtException', (e) => {
  log('[uncaughtException]', e && e.stack ? e.stack : e);
  try { store.flush(); } catch { /* ignore */ }
  process.exit(1);
});

/* ───────────── boot ───────────── */

const server = app.listen(cfg.port, cfg.host, () => {
  log(`supporters overlay listening on http://${cfg.host}:${cfg.port}`);
  log(`public URL: ${cfg.publicUrl}   overlay: ${cfg.publicUrl}/overlay${cfg.overlayKey ? '?key=…' : ''}   admin: ${cfg.publicUrl}/admin`);
  for (const w of cfg.warnings) log(`[config] ${w}`);
  engine.start();
  youtube.start();
  twitch.start();
  ytChat.start();
  twChat.start();
  discord.start();
  // Started only once this process owns the port, so a second copy of the app can never run a second bot.
  bot.start();
});

server.on('error', (e) => {
  log(`cannot listen on ${cfg.host}:${cfg.port}: ${e.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    store.flush();
    const httpClosed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    Promise.all([httpClosed, bot.stop().catch((e) => log(`[bot] stop failed: ${e.message}`))]).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
