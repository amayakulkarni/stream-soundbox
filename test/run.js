'use strict';

// End-to-end test: boots the real server against mock YouTube / Twitch APIs and
// drives it over HTTP + SSE exactly like OBS, Twitch, Buy Me a Coffee and the admin page would.
//   node test/run.js

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 42077;
const MOCK_PORT = 42078;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRETS = {
  admin: 'correct horse battery',
  session: 'x'.repeat(48),
  overlayKey: 'okey123',
  twitch: 'twitch-eventsub-secret-123',
  bmcSecret: 'bmc-signing-secret',
  bmcToken: 'bmc-url-token',
};
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'supporters-test-'));

let failures = 0;
let passes = 0;
const ok = (cond, msg, extra) => {
  if (cond) {
    passes += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${msg}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────── mock YouTube + Twitch ───────────── */

const mock = {
  ytSubs: 100,
  subs: [{ id: 's1', title: 'Old One' }, { id: 's0', title: 'Older' }], // newest first
  members: [{ id: 'M1', name: 'Mem One' }],
  twTotalFollowers: 50,
  twFollowers: [{ user_id: '1', user_name: 'old_f', followed_at: '2026-10-01T00:00:00Z' }], // newest first
  twSubsTotal: 7,
  eventsub: [],
  eventsubPosts: [],
  authHeaders: [],
};

const mockServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    mock.authHeaders.push(req.headers.authorization || '');
    const p = u.pathname;
    if (p === '/yt/channels') return send(200, { items: [{ id: 'UC1', snippet: { title: 'Amaya Channel' }, statistics: { subscriberCount: String(mock.ytSubs) } }] });
    if (p === '/yt/subscriptions') return send(200, { items: mock.subs.map((s) => ({ id: s.id, subscriberSnippet: { title: s.title, channelId: `C-${s.id}` } })) });
    if (p === '/yt/members') {
      return send(200, { items: mock.members.map((m) => ({ snippet: { memberDetails: { channelId: m.id, displayName: m.name }, membershipsDetails: { highestAccessibleLevelDisplayName: 'Gold', membershipsDuration: { memberSince: '2026-10-31T00:00:00Z' } } } })) });
    }
    if (p === '/google/token') return send(200, { access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600, scope: 'x' });
    if (p === '/tw-id/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') return send(200, { access_token: 't-access', refresh_token: 't-refresh', expires_in: 14400, scope: ['moderator:read:followers', 'channel:read:subscriptions'] });
      return send(200, { access_token: `t-${f.get('grant_type')}`, refresh_token: 't-refresh2', expires_in: 14400 });
    }
    if (p === '/helix/users') return send(200, { data: [{ id: '999', login: 'amaya', display_name: 'Amaya' }] });
    if (p === '/helix/channels/followers') return send(200, { total: mock.twTotalFollowers, data: mock.twFollowers });
    if (p === '/helix/subscriptions') return send(200, { total: mock.twSubsTotal, data: [] });
    if (p === '/helix/eventsub/subscriptions') {
      if (req.method === 'GET') return send(200, { data: mock.eventsub, pagination: {} });
      if (req.method === 'POST') {
        const b = JSON.parse(body);
        mock.eventsubPosts.push(b);
        const rec = { id: crypto.randomUUID(), type: b.type, status: 'webhook_callback_verification_pending', condition: b.condition, transport: { method: 'webhook', callback: b.transport.callback } };
        mock.eventsub.push(rec);
        return send(202, { data: [rec] });
      }
      if (req.method === 'DELETE') return send(204);
    }
    return send(404, { message: `mock: no route ${p}` });
  });
});

/* ───────────── server process ───────────── */

let child = null;
function startServer() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR,
    PUBLIC_URL: 'https://supporters.test',
    ADMIN_PASSWORD: SECRETS.admin,
    SESSION_SECRET: SECRETS.session,
    YOUTUBE_ANON_WAIT_MIN: '0', // test/ytanon.js covers the wait itself
    OVERLAY_KEY: SECRETS.overlayKey,
    TWITCH_CLIENT_ID: 'tcid',
    TWITCH_CLIENT_SECRET: 'tsec',
    TWITCH_EVENTSUB_SECRET: SECRETS.twitch,
    YOUTUBE_CLIENT_ID: 'ycid',
    YOUTUBE_CLIENT_SECRET: 'ysec',
    BMC_WEBHOOK_SECRET: SECRETS.bmcSecret,
    BMC_WEBHOOK_TOKEN: SECRETS.bmcToken,
    YOUTUBE_API_BASE: `http://127.0.0.1:${MOCK_PORT}/yt`,
    GOOGLE_AUTH_URL: 'https://accounts.example/auth',
    GOOGLE_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/google/token`,
    TWITCH_ID_BASE: `http://127.0.0.1:${MOCK_PORT}/tw-id`,
    TWITCH_HELIX_BASE: `http://127.0.0.1:${MOCK_PORT}/helix`,
  };
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  c.logs = '';
  c.stdout.on('data', (d) => (c.logs += d));
  c.stderr.on('data', (d) => (c.logs += d));
  child = c;
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`server did not start:\n${child.logs}`);
}

async function stopServer() {
  if (!child) return;
  const c = child;
  child = null;
  c.kill('SIGTERM');
  await new Promise((r) => c.on('exit', r));
}

/* ───────────── helpers ───────────── */

let cookie = '';
async function A(method, p, body, headers = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function login() {
  const res = await fetch(`${BASE}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(SECRETS.admin)}`,
  });
  const set = res.headers.get('set-cookie') || '';
  cookie = set.split(';')[0];
  return { res, set };
}

class Sse {
  constructor(p) {
    this.events = [];
    this.cursor = 0;
    this.ctrl = new AbortController();
    this.done = this._run(p);
  }

  async _run(p) {
    const res = await fetch(`${BASE}${p}`, { signal: this.ctrl.signal, headers: { Accept: 'text/event-stream', ...(p.startsWith('/admin') ? { cookie } : {}) } });
    this.status = res.status;
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) this.events.push({ event, data: JSON.parse(data), t: Date.now() });
        }
      }
    } catch {
      /* aborted */
    }
  }

  // Consume the next matching event (in order), waiting up to `ms`.
  async next(event, ms = 3000, pred = () => true) {
    const end = Date.now() + ms;
    for (;;) {
      for (let i = this.cursor; i < this.events.length; i++) {
        const e = this.events[i];
        if (e.event === event && pred(e.data)) {
          this.cursor = i + 1;
          return e;
        }
      }
      if (Date.now() > end) return null;
      await sleep(25);
    }
  }

  drain() {
    this.cursor = this.events.length;
  }

  close() {
    this.ctrl.abort();
  }
}

const twSign = (id, ts, raw, secret = SECRETS.twitch) => `sha256=${crypto.createHmac('sha256', secret).update(id).update(ts).update(raw).digest('hex')}`;
async function twPost(type, bodyObj, { id = crypto.randomUUID(), ts = new Date().toISOString(), badSig = false } = {}) {
  const raw = JSON.stringify(bodyObj);
  const res = await fetch(`${BASE}/webhooks/twitch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-type': type,
      'twitch-eventsub-message-signature': badSig ? 'sha256=deadbeef' : twSign(id, ts, raw),
    },
    body: raw,
  });
  return { status: res.status, text: await res.text(), id };
}

async function bmcPost(bodyObj, { token, sigHeader, sig } = {}) {
  const raw = JSON.stringify(bodyObj);
  const headers = { 'content-type': 'application/json' };
  if (sigHeader) headers[sigHeader] = sig === undefined ? crypto.createHmac('sha256', SECRETS.bmcSecret).update(raw).digest('hex') : sig;
  const res = await fetch(`${BASE}/webhooks/bmc${token ? `?token=${encodeURIComponent(token)}` : ''}`, { method: 'POST', headers, body: raw });
  return res.status;
}

const donation = (id, name, amount = 5, extra = {}) => ({
  type: 'donation.created',
  live_mode: true,
  attempt: 1,
  event_id: `ev-${id}`,
  data: { id, amount, currency: 'USD', coffee_count: 1, supporter_name: name, support_note: 'thank you for the streams', ...extra },
});

const state = async () => (await A('GET', '/admin/api/state')).json;

/* ───────────── the tests ───────────── */

async function main() {
  await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

  // Pre-connect both providers (as if OAuth had been completed earlier).
  fs.writeFileSync(
    path.join(DATA_DIR, 'tokens.json'),
    JSON.stringify({
      youtube: { access_token: 'y-acc', refresh_token: 'y-ref', expires_at: Date.now() + 3600e3, channel_id: 'UC1', channel_title: 'Amaya Channel' },
      twitch: { access_token: 't-acc', refresh_token: 't-ref', expires_at: Date.now() + 3600e3, scopes: [], user_id: '999', login: 'amaya', display_name: 'Amaya' },
    })
  );

  startServer();
  await waitHealthy();
  await sleep(600); // first poll of both providers

  /* ── access control ── */
  section('Overlay access and static files');
  ok((await A('GET', '/overlay')).status === 403, 'overlay without ?key= is forbidden');
  ok((await A('GET', '/overlay?key=wrong')).status === 403, 'overlay with wrong key is forbidden');
  const ov = await A('GET', `/overlay?key=${SECRETS.overlayKey}`);
  ok(ov.status === 200 && ov.text.includes('id="counters"'), 'overlay with key serves the page');
  ok((await A('GET', `/overlay/counters?key=${SECRETS.overlayKey}`)).status === 200, '/overlay/counters served');
  ok((await A('GET', `/overlay/alerts?key=${SECRETS.overlayKey}`)).status === 200, '/overlay/alerts served');
  ok((await A('GET', '/assets/overlay.js')).status === 200, 'assets are served');
  const trav = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/assets/..%2f..%2fsrc%2fconfig.js' }, (r) => {
      r.resume();
      resolve(r.statusCode);
    });
  });
  ok(trav === 404, 'path traversal out of /assets is refused', trav);
  const trav2 = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/assets/../../.env' }, (r) => {
      r.resume();
      resolve(r.statusCode);
    });
  });
  ok(trav2 !== 200, 'raw ../ traversal does not leak files', trav2);
  ok((await A('GET', '/api/stream?view=all')).status === 403, 'event stream needs the key too');

  section('Admin sign-in');
  ok((await A('GET', '/admin')).text.includes('type="password"'), '/admin shows the sign-in form when signed out');
  ok((await A('GET', '/admin/api/state')).status === 401, 'admin API rejects signed-out requests');
  const bad = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=nope' });
  ok(bad.status === 303 && bad.headers.get('location') === '/admin?e=bad' && !bad.headers.get('set-cookie'), 'wrong password is refused, no cookie');
  const nullOrigin = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' }, body: `password=${encodeURIComponent(SECRETS.admin)}` });
  ok(nullOrigin.status === 403, 'Origin: null (sandboxed cross-site form) is refused');
  const browserLike = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE }, body: `password=${encodeURIComponent(SECRETS.admin)}` });
  ok(browserLike.status === 303 && /sp_admin=/.test(browserLike.headers.get('set-cookie') || ''), 'a real browser login (same-origin Origin header) works');
  ok((await A('GET', '/admin')).headers.get('referrer-policy') === 'same-origin', 'Referrer-Policy is same-origin so browsers send a usable Origin');
  const { res: lr, set } = await login();
  ok(lr.status === 303 && /sp_admin=/.test(set), 'correct password sets a session cookie');
  ok(/HttpOnly/i.test(set) && /SameSite=Lax/i.test(set) && /Path=\/admin/i.test(set), 'cookie is HttpOnly, SameSite=Lax, scoped to /admin', set);
  ok((await A('GET', '/admin')).text.includes('id="p-counters"'), '/admin shows the dashboard when signed in');
  ok((await A('POST', '/admin/api/queue/clear', {}, { origin: 'https://evil.example' })).status === 403, 'cross-origin admin POST is blocked');

  section('First poll: counts loaded, nobody announced for existing followers/subscribers');
  let s = await state();
  const v = s.counters.snapshot.values;
  ok(v.ytSubs === 100 && v.ytMembers === 1 && v.twFollowers === 50 && v.twSubs === 7, 'counters match the APIs', v);
  ok(s.queue.length === 0, 'existing supporters were not queued on first run', s.queue.length);
  ok(s.status.youtube.connected && s.status.youtube.account === 'Amaya Channel', 'YouTube shows connected account');
  ok(s.status.twitch.connected && s.status.twitch.account === 'Amaya', 'Twitch shows connected account');

  /* ── pacing at the default 5 s ── */
  section('Announcement pacing: 1 every 5 seconds');
  const sse = new Sse(`/api/stream?view=all&key=${SECRETS.overlayKey}`);
  const snap = await sse.next('snapshot', 3000);
  ok(!!snap && snap.data.counters.values.ytSubs === 100, 'overlay stream sends a snapshot first');
  ok((await A('GET', '/admin/api/state')).json.settings.alertIntervalMs === 5000, 'default interval is 5000 ms');
  await A('POST', '/admin/api/test', { type: 'twitch.follow', name: 'Pacing', count: 4 });
  const times = [];
  for (let i = 0; i < 4; i++) {
    const e = await sse.next('alert', 7000);
    if (e) times.push(e);
  }
  ok(times.length === 4, 'all four announcements arrive', times.length);
  const gaps = times.slice(1).map((e, i) => e.t - times[i].t);
  ok(gaps.every((g) => g >= 4900 && g <= 5400), 'gaps are ~5000 ms', gaps);
  ok(times[0].data.name === 'Pacing 1' && times[3].data.name === 'Pacing 4', 'order is first-in first-out');
  ok(times[0].data.durationMs < 5000 && times[0].data.durationMs >= 1000, 'on-screen time is shorter than the interval', times[0].data.durationMs);

  // Faster pacing for the rest of the run.
  const set1 = await A('POST', '/admin/api/settings', { alertIntervalMs: 1000, alertDurationMs: 700 });
  ok(set1.json.settings.alertIntervalMs === 1000 && set1.json.settings.alertDurationMs === 1000, 'settings API clamps to sane bounds', set1.json.settings);
  const clamp = await A('POST', '/admin/api/settings', { alertIntervalMs: 10, youtubePollSec: 1, bogus: 1, alerts: { 'nope.type': true } });
  ok(clamp.json.settings.alertIntervalMs === 1000 && clamp.json.settings.youtubePollSec === 30 && !('bogus' in clamp.json.settings), 'unknown keys ignored, numbers clamped', clamp.json.settings);

  /* ── YouTube ── */
  section('YouTube polling');
  sse.drain();
  mock.ytSubs = 101;
  mock.subs.unshift({ id: 's2', title: 'Rose Petal' });
  mock.members.push({ id: 'M2', name: 'Mem Two' });
  await A('POST', '/admin/api/refresh/youtube', {});
  const a1 = await sse.next('alert', 3000, (a) => a.type === 'youtube.subscriber');
  ok(a1 && a1.data.name === 'Rose Petal', 'new subscriber is announced by name', a1 && a1.data);
  const a2 = await sse.next('alert', 3000, (a) => a.type === 'youtube.member');
  ok(a2 && a2.data.name === 'Mem Two' && a2.data.detail === 'Gold', 'new member is announced with their level', a2 && a2.data);
  s = await state();
  ok(s.counters.snapshot.values.ytSubs === 101 && s.counters.snapshot.values.ytMembers === 2, 'YouTube counters updated');
  sse.drain();
  await A('POST', '/admin/api/refresh/youtube', {});
  ok((await sse.next('alert', 1800)) === null, 'a second poll does not announce the same people again');

  // Private subscribers raise the count but have no name: announced as "Someone" one poll later.
  sse.drain();
  mock.ytSubs = 103;
  await A('POST', '/admin/api/refresh/youtube', {});
  ok((await sse.next('alert', 1500, (a) => a.name === 'Someone')) === null, 'a count rise alone is not announced right away (a name may still show up)');
  await A('POST', '/admin/api/refresh/youtube', {});
  const an1 = await sse.next('alert', 3000, (a) => a.name === 'Someone');
  const an2 = await sse.next('alert', 3000, (a) => a.name === 'Someone');
  ok(an1 && an2 && an1.data.type === 'youtube.subscriber', 'two private subscribers are announced as Someone', an1 && an1.data);
  sse.drain();
  await A('POST', '/admin/api/refresh/youtube', {});
  ok((await sse.next('alert', 1500, (a) => a.name === 'Someone')) === null, 'and only once');
  mock.ytSubs = 101;
  await A('POST', '/admin/api/refresh/youtube', {});

  /* ── Twitch webhooks ── */
  section('Twitch webhooks');
  const ver = await twPost('webhook_callback_verification', { challenge: 'pogchamp-123', subscription: { type: 'channel.follow' } });
  ok(ver.status === 200 && ver.text === 'pogchamp-123', 'callback verification echoes the challenge');
  ok((await twPost('notification', { subscription: { type: 'channel.follow' }, event: {} }, { badSig: true })).status === 403, 'bad signature rejected');
  const old = new Date(Date.now() - 20 * 60e3).toISOString();
  ok((await twPost('notification', { subscription: { type: 'channel.follow' }, event: { user_id: '5', user_name: 'late', followed_at: old } }, { ts: old })).status === 403, 'stale (replayed) message rejected');

  sse.drain();
  const followedAt = new Date().toISOString();
  const fol = { subscription: { type: 'channel.follow' }, event: { user_id: '77', user_name: 'pastel_pixie', user_login: 'pastel_pixie', followed_at: followedAt } };
  const msgId = crypto.randomUUID();
  ok((await twPost('notification', fol, { id: msgId })).status === 204, 'follow notification accepted');
  const f1 = await sse.next('alert', 3000, (a) => a.type === 'twitch.follow');
  ok(f1 && f1.data.name === 'pastel_pixie' && f1.data.label === 'new follower', 'new follower announced', f1 && f1.data);
  s = await state();
  ok(s.counters.snapshot.values.twFollowers === 51, 'follower count bumps immediately', s.counters.snapshot.values.twFollowers);
  sse.drain();
  await twPost('notification', fol, { id: msgId });
  await twPost('notification', fol); // same follow, different message id
  ok((await sse.next('alert', 1800)) === null, 'redelivered / duplicate follow is not announced twice');

  await twPost('notification', { subscription: { type: 'channel.subscribe' }, event: { user_name: 'velvet_moth', tier: '1000', is_gift: false } });
  const sb = await sse.next('alert', 3000, (a) => a.type === 'twitch.sub');
  ok(sb && sb.data.name === 'velvet_moth' && sb.data.detail === 'Tier 1', 'new Twitch subscriber announced', sb && sb.data);
  await twPost('notification', { subscription: { type: 'channel.subscription.message' }, event: { user_name: 'ribbon', tier: '2000', cumulative_months: 6, message: { text: 'six months!' } } });
  const rs = await sse.next('alert', 3000, (a) => a.type === 'twitch.resub');
  ok(rs && rs.data.detail === '6 months · Tier 2' && rs.data.message === 'six months!', 'resub announced with months and message', rs && rs.data);
  await twPost('notification', { subscription: { type: 'channel.subscription.gift' }, event: { is_anonymous: true, total: 5, tier: '1000' } });
  const gf = await sse.next('alert', 3000, (a) => a.type === 'twitch.gift');
  ok(gf && gf.data.name === 'Anonymous' && gf.data.detail === '5 subs · Tier 1', 'anonymous gift announced', gf && gf.data);
  await twPost('notification', { subscription: { type: 'channel.subscribe' }, event: { user_id: '901', user_name: 'gift_kid', tier: '1000', is_gift: true } });
  ok((await sse.next('alert', 1800, (a) => a.name === 'gift_kid')) === null, 'a gifted sub is not announced on top of the gift itself');
  await twPost('notification', { subscription: { type: 'channel.subscribe' }, event: { user_id: '902', user_name: 'solo_sub', tier: '1000', is_gift: false } });
  ok(await sse.next('alert', 3000, (a) => a.name === 'solo_sub'), 'a new sub is announced');
  await twPost('notification', { subscription: { type: 'channel.subscribe' }, event: { user_id: '902', user_name: 'solo_sub', tier: '1000', is_gift: false } });
  ok((await sse.next('alert', 1800, (a) => a.name === 'solo_sub')) === null, 'the same sub from a second EventSub subscription (new message id) is not announced again');
  s = await state();
  ok(s.counters.snapshot.values.twSubs === 10, 'subscriber count bumps by one per new sub, not per gift event', s.counters.snapshot.values.twSubs);

  section('Twitch polling fallback');
  mock.twTotalFollowers = 53;
  mock.twFollowers.unshift({ user_id: '77', user_name: 'pastel_pixie', followed_at: followedAt }); // already announced via webhook
  mock.twFollowers.unshift({ user_id: '88', user_name: 'polled_pal', followed_at: new Date().toISOString() });
  sse.drain();
  await A('POST', '/admin/api/refresh/twitch', {});
  const pf = await sse.next('alert', 3000, (a) => a.type === 'twitch.follow');
  ok(pf && pf.data.name === 'polled_pal', 'follower missed by webhooks is caught by polling', pf && pf.data);
  ok((await sse.next('alert', 1800)) === null, 'poll does not repeat the follower that arrived by webhook');
  s = await state();
  ok(s.counters.snapshot.values.twFollowers === 53, 'poll sets the authoritative follower count');

  /* ── Buy Me a Coffee ── */
  section('Buy Me a Coffee webhooks');
  const d1 = donation('d1', 'Ananya', 5);
  ok((await bmcPost(d1)) === 401, 'no token / signature → 401');
  ok((await bmcPost(d1, { token: 'wrong' })) === 401, 'wrong token → 401');
  ok((await bmcPost(d1, { sigHeader: 'x-signature-sha256', sig: 'abc123' })) === 401, 'bad signature → 401');
  sse.drain();
  ok((await bmcPost(d1, { sigHeader: 'x-signature-sha256' })) === 200, 'valid HMAC (x-signature-sha256) accepted');
  const bd = await sse.next('alert', 3000, (a) => a.type === 'bmc.donation');
  ok(bd && bd.data.name === 'Ananya' && bd.data.detail === '$5 · 1 compute' && bd.data.message === 'thank you for the streams', 'donation announced with amount and message', bd && bd.data);
  ok((await bmcPost(donation('d2', 'Meera', 10, { coffee_count: 2 }), { sigHeader: 'x-bmc-signature' })) === 200, 'valid HMAC (x-bmc-signature) accepted');
  const bd2 = await sse.next('alert', 3000, (a) => a.name === 'Meera');
  ok(bd2 && bd2.data.detail === '$10 · 2 compute', 'multi-coffee donation reads correctly', bd2 && bd2.data);
  sse.drain();
  await bmcPost(d1, { token: SECRETS.bmcToken });
  ok((await sse.next('alert', 1800)) === null, 'retried delivery of the same donation is not announced twice');
  s = await state();
  ok(s.counters.snapshot.values.bmcCoffees === 3 && s.status.bmc.donations === 2 && s.status.bmc.totals.USD === 15, 'coffee count and totals are tracked', [s.counters.snapshot.values.bmcCoffees, s.status.bmc.totals]);

  const mem = { type: 'membership.started', live_mode: true, data: { id: 'm1', supporter_name: 'Kavya', amount: 4, currency: 'USD', membership_level_name: 'Cozy Club', duration_type: 'month' } };
  ok((await bmcPost(mem, { token: SECRETS.bmcToken })) === 200, 'membership webhook accepted (URL token)');
  const bm = await sse.next('alert', 3000, (a) => a.type === 'bmc.membership');
  ok(bm && bm.data.name === 'Kavya' && bm.data.detail === 'Cozy Club · $4/month', 'new member announced with level and price', bm && bm.data);
  s = await state();
  ok(s.counters.snapshot.values.bmcMembers === 1, 'member count = 1');
  await bmcPost({ ...mem, data: { ...mem.data, started_at: '2026-11-05T10:00:00Z' } }, { token: SECRETS.bmcToken });
  ok((await sse.next('alert', 1800, (a) => a.type === 'bmc.membership')) === null, 'a second start event for an active member is not announced again');
  await bmcPost({ type: 'membership.cancelled', live_mode: true, data: { id: 'm1', supporter_name: 'Kavya' } }, { token: SECRETS.bmcToken });
  s = await state();
  ok(s.counters.snapshot.values.bmcMembers === 0, 'cancellation lowers the member count');
  await bmcPost({ type: 'donation.refunded', live_mode: true, data: { id: 'd2', supporter_name: 'Meera', amount: 10, currency: 'USD', coffee_count: 2 } }, { token: SECRETS.bmcToken });
  s = await state();
  ok(s.counters.snapshot.values.bmcCoffees === 1 && s.status.bmc.totals.USD === 5, 'refund reverses coffees and total', [s.counters.snapshot.values.bmcCoffees, s.status.bmc.totals]);
  sse.drain();
  await bmcPost(donation('t1', 'Test Person', 3, {}), { token: SECRETS.bmcToken }); // normal
  await sse.next('alert', 2000);
  const before = (await state()).counters.snapshot.values.bmcCoffees;
  await bmcPost({ ...donation('t2', 'Setup Check', 3), live_mode: false }, { token: SECRETS.bmcToken });
  const tst = await sse.next('alert', 3000, (a) => a.name === 'Setup Check');
  ok(tst && tst.data.test === true, 'BMC "send test" (live_mode:false) shows an announcement');
  ok((await state()).counters.snapshot.values.bmcCoffees === before, 'but does not change the counters');

  /* ── admin controls ── */
  section('Admin controls');
  await A('POST', '/admin/api/settings', { alerts: { 'bmc.donation': false } });
  sse.drain();
  await bmcPost(donation('d9', 'Silent'), { token: SECRETS.bmcToken });
  ok((await sse.next('alert', 1800)) === null, 'a disabled alert type is not announced');
  s = await state();
  ok(s.recent.some((e) => e.name === 'Silent' && e.queued === false), 'but it is still in the activity log');
  ok(s.counters.snapshot.values.bmcCoffees === before + 1, 'and still counted');
  await A('POST', '/admin/api/settings', { alerts: { 'bmc.donation': true }, offsets: { twSubs: -1, ytSubs: 5 } });
  s = await state();
  // twSubs base is 7 here: the Twitch poll above reconciled the optimistic +1 back to the API total.
  ok(s.counters.snapshot.values.twSubs === 6 && s.counters.snapshot.values.ytSubs === 106, 'counter adjustments apply on display', s.counters.snapshot.values);
  await A('POST', '/admin/api/settings', { offsets: { twSubs: 0, ytSubs: 0 } });

  const xss = await A('POST', '/admin/api/test', { type: 'twitch.follow', name: '<img src=x onerror=alert(1)>‮gnp.exe\u0007' });
  const xe = await sse.next('alert', 3000, (a) => a.test);
  ok(xe && !/[‮\u0007]/.test(xe.data.name), 'control and bidi-override characters are stripped from names', xe && xe.data.name);
  ok(xss.status === 200, 'test API accepts input');
  ok((await A('POST', '/admin/api/test', { type: 'nope.type' })).status === 400, 'unknown test type → 400');

  section('Waiting for OBS (queue is held while no overlay is open)');
  sse.close();
  await sleep(300);
  await A('POST', '/admin/api/queue/clear', {});
  await A('POST', '/admin/api/test', { type: 'bmc.donation', name: 'Held', count: 2 });
  await sleep(2600);
  s = await state();
  ok(s.queue.length === 2 && s.overlays.listeningForAlerts === 0, 'two announcements wait while nothing is listening', s.queue.length);
  const sse2 = new Sse(`/api/stream?view=all&key=${SECRETS.overlayKey}`);
  const h1 = await sse2.next('alert', 4000);
  const h2 = await sse2.next('alert', 4000);
  ok(h1 && h2 && h1.data.name === 'Held 1' && h2.data.name === 'Held 2', 'they play, in order, once an overlay connects');
  const sse3 = new Sse(`/api/stream?view=counters&key=${SECRETS.overlayKey}`);
  await sse3.next('snapshot', 2000);
  await A('POST', '/admin/api/test', { type: 'twitch.follow', name: 'CountersOnly' });
  const gotOnCounters = await sse3.next('alert', 2500);
  const gotOnAll = await sse2.next('alert', 2500, (a) => a.name === 'CountersOnly');
  ok(gotOnCounters === null && !!gotOnAll, '/overlay/counters never receives announcements, /overlay does');
  sse3.close();

  section('Admin live stream');
  const adm = new Sse('/admin/api/stream');
  ok(!!(await adm.next('hello', 2000)), 'admin stream connects with a session');
  await A('POST', '/admin/api/test', { type: 'twitch.follow', name: 'LogLine' });
  ok(!!(await adm.next('log', 2000, (e) => e.name === 'LogLine')), 'admin stream pushes activity');
  ok(!!(await adm.next('queue', 2000)), 'admin stream pushes queue changes');
  adm.close();
  const unauth = await fetch(`${BASE}/admin/api/stream`);
  ok(unauth.status === 401, 'admin stream refuses signed-out clients');
  await unauth.text();
  sse2.close();

  section('Twitch webhook setup (EventSub)');
  const sy = await A('POST', '/admin/api/twitch/sync', {});
  ok(sy.status === 200 && sy.json.eventsub.result.length === 4, 'sync creates four subscriptions', sy.text);
  const types = mock.eventsubPosts.map((p) => p.type).sort();
  ok(JSON.stringify(types) === JSON.stringify(['channel.follow', 'channel.subscribe', 'channel.subscription.gift', 'channel.subscription.message']), 'follow, subscribe, resub and gift are covered', types);
  const fp = mock.eventsubPosts.find((p) => p.type === 'channel.follow');
  ok(fp.version === '2' && fp.condition.moderator_user_id === '999' && fp.transport.callback === 'https://supporters.test/webhooks/twitch' && fp.transport.secret === SECRETS.twitch, 'follow uses v2 with moderator id, HTTPS callback and the signing secret');
  ok(mock.authHeaders.some((h) => h === 'Bearer t-client_credentials'), 'subscriptions are created with an app access token');
  mock.eventsub.forEach((e) => (e.status = 'enabled'));
  const before2 = mock.eventsubPosts.length;
  await A('POST', '/admin/api/twitch/sync', {});
  ok(mock.eventsubPosts.length === before2, 'running sync again does not create duplicates');

  section('OAuth connect flows');
  const o1 = await A('GET', '/admin/auth/youtube');
  const loc = new URL(o1.headers.get('location'));
  ok(o1.status === 302 && loc.origin === 'https://accounts.example' && loc.searchParams.get('client_id') === 'ycid' && loc.searchParams.get('access_type') === 'offline', 'YouTube connect redirects to Google with offline access');
  ok(loc.searchParams.get('redirect_uri') === 'https://supporters.test/admin/auth/youtube/callback', 'redirect URI is <PUBLIC_URL>/admin/auth/youtube/callback');
  ok(loc.searchParams.get('scope').includes('youtube.channel-memberships.creator'), 'asks for the memberships scope');
  const bad2 = await A('GET', '/admin/auth/youtube/callback?code=abc&state=forged');
  ok(/notice=Authorization%20link%20expired/.test(bad2.headers.get('location')), 'a forged OAuth state is rejected');
  const good = await A('GET', `/admin/auth/youtube/callback?code=abc&state=${loc.searchParams.get('state')}`);
  ok(/notice=youtube%20connected/.test(good.headers.get('location')), 'valid callback connects YouTube');
  const o2 = await A('GET', '/admin/auth/twitch');
  const tl = new URL(o2.headers.get('location'));
  ok(tl.searchParams.get('scope') === 'moderator:read:followers channel:read:subscriptions' && tl.searchParams.get('redirect_uri') === 'https://supporters.test/admin/auth/twitch/callback', 'Twitch connect asks for follower + subscription scopes');
  const g2 = await A('GET', `/admin/auth/twitch/callback?code=abc&state=${tl.searchParams.get('state')}`);
  ok(/notice=twitch%20connected/.test(g2.headers.get('location')), 'valid callback connects Twitch');
  const tokenFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tokens.json'), 'utf8'));
  ok(tokenFile.youtube.refresh_token === 'g-refresh' && tokenFile.twitch.user_id === '999', 'tokens are saved');
  if (process.platform !== 'win32') ok((fs.statSync(path.join(DATA_DIR, 'tokens.json')).mode & 0o077) === 0, 'tokens.json is private (0600)'); // Windows has no such file modes

  section('Restart: state survives');
  await A('POST', '/admin/api/settings', { holdWhenNoOverlay: true });
  await A('POST', '/admin/api/queue/clear', {});
  await A('POST', '/admin/api/test', { type: 'twitch.follow', name: 'Survivor', count: 2 });
  await sleep(400);
  await stopServer();
  startServer();
  await waitHealthy();
  await login();
  s = await state();
  ok(s.queue.length === 2 && s.queue.items[0].name === 'Survivor 1', 'waiting announcements are restored', s.queue);
  ok(s.counters.snapshot.values.bmcCoffees > 0 && s.counters.snapshot.values.twFollowers === 53, 'counters are restored');
  sse.drain();
  await bmcPost(d1, { token: SECRETS.bmcToken });
  await sleep(300);
  s = await state();
  ok(!s.queue.items.some((a) => a.name === 'Ananya'), 'duplicate-protection also survives a restart');

  section('Login throttling');
  let throttled = false;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=guess' });
    if ((r.headers.get('location') || '').includes('throttled')) throttled = true;
  }
  ok(throttled, 'repeated wrong passwords are throttled');
  const tr = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(SECRETS.admin)}` });
  ok((tr.headers.get('location') || '').includes('throttled'), 'even the right password waits until the window passes');

  section('Shutdown');
  const t0 = Date.now();
  await stopServer();
  ok(Date.now() - t0 < 4000, 'SIGTERM exits cleanly and quickly', Date.now() - t0);
}

main()
  .catch((e) => {
    failures += 1;
    console.error('\nTEST RUN CRASHED:', e);
    if (child) console.error('--- server log ---\n', child.logs);
  })
  .finally(async () => {
    await stopServer();
    mockServer.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
