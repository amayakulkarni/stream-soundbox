'use strict';

const crypto = require('crypto');
const cfg = require('../config');
const { fetchJson, safeEq, log } = require('../util');
const { createPoller } = require('../poller');

const SCOPES = ['moderator:read:followers', ...(cfg.disable.twitchSubs ? [] : ['channel:read:subscriptions'])];
const TIERS = { 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3' };
const MAX_SKEW_MS = 10 * 60 * 1000;

module.exports = function createTwitch({ store, tokens, engine }) {
  const runtime = { appToken: null, eventsub: null, received: 0, lastReceivedAt: null, warnings: [] };

  const configured = () => !!(cfg.twitch.clientId && cfg.twitch.clientSecret);
  const redirectUri = () => `${cfg.publicUrl}/admin/auth/twitch/callback`;
  const callbackUrl = () => `${cfg.publicUrl}/webhooks/twitch`;

  /* ───────────── OAuth / tokens ───────────── */

  function authUrl(state) {
    const p = new URLSearchParams({
      client_id: cfg.twitch.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES.join(' '),
      state,
      force_verify: 'true',
    });
    return `${cfg.endpoints.twitchId}/authorize?${p}`;
  }

  const tokenRequest = (params) =>
    fetchJson(`${cfg.endpoints.twitchId}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.twitch.clientId, client_secret: cfg.twitch.clientSecret, ...params }),
    });

  async function exchangeCode(code) {
    const r = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
    const me = await fetchJson(`${cfg.endpoints.twitchHelix}/users`, {
      headers: { Authorization: `Bearer ${r.access_token}`, 'Client-Id': cfg.twitch.clientId },
    });
    const u = me.data && me.data[0];
    if (!u) throw new Error('Twitch did not return the authorizing user');
    const granted = r.scope || [];
    runtime.warnings = SCOPES.filter((s) => !granted.includes(s)).map((s) => `missing scope ${s}`);
    tokens.set('twitch', {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: Date.now() + (r.expires_in || 14400) * 1000,
      scopes: granted,
      user_id: u.id,
      login: u.login,
      display_name: u.display_name,
    });
    poller.now().catch(() => {});
    return u;
  }

  async function userToken() {
    const t = tokens.get('twitch');
    if (!t) throw new Error('Twitch is not connected');
    if (t.access_token && t.expires_at - 60_000 > Date.now()) return t.access_token;
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    tokens.set('twitch', {
      ...t,
      access_token: r.access_token,
      refresh_token: r.refresh_token || t.refresh_token,
      expires_at: Date.now() + (r.expires_in || 14400) * 1000,
    });
    return r.access_token;
  }

  async function appToken() {
    const a = runtime.appToken;
    if (a && a.expires_at - 60_000 > Date.now()) return a.token;
    const r = await tokenRequest({ grant_type: 'client_credentials' });
    runtime.appToken = { token: r.access_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000 };
    return runtime.appToken.token;
  }

  async function helix(path, { params, method = 'GET', body, as = 'user' } = {}, retried = false) {
    const token = as === 'app' ? await appToken() : await userToken();
    const url = new URL(cfg.endpoints.twitchHelix + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    try {
      return await fetchJson(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-Id': cfg.twitch.clientId,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e.status === 401 && !retried) {
        // Token revoked/expired early: force a refresh once and retry.
        if (as === 'app') runtime.appToken = null;
        else tokens.set('twitch', { ...tokens.get('twitch'), expires_at: 0 });
        return helix(path, { params, method, body, as }, true);
      }
      throw e;
    }
  }

  /* ───────────── polling (counts + follower fallback) ───────────── */

  async function poll() {
    const t = tokens.get('twitch');
    if (!t) return;
    const warnings = [];

    const f = await helix('/channels/followers', { params: { broadcaster_id: t.user_id, first: '20' } });
    engine.setCounter('twFollowers', f.total);

    if (store.state.settings.twitchPollFollowers) {
      const ps = store.state.providers.twitch;
      const fresh = [];
      for (const it of f.data || []) {
        const key = `tw:follow:${it.user_id}:${Date.parse(it.followed_at)}`;
        if (!store.seen.has(key)) fresh.push({ key, name: it.user_name || it.user_login });
      }
      if (!ps.followersSeeded) {
        for (const x of fresh) store.markSeen(x.key);
        ps.followersSeeded = true;
        store.save();
      } else {
        for (const x of fresh.reverse()) engine.ingest({ key: x.key, type: 'twitch.follow', name: x.name });
      }
    }

    if (!cfg.disable.twitchSubs) try {
      const s = await helix('/subscriptions', { params: { broadcaster_id: t.user_id, first: '1' } });
      engine.setCounter('twSubs', s.total);
    } catch (e) {
      // Non-affiliates cannot read subscriptions; keep going.
      warnings.push(`subscribers: ${e.message}`);
    }
    runtime.warnings = warnings;
  }

  const poller = createPoller('twitch', () => store.state.settings.twitchPollSec, poll);

  /* ───────────── EventSub webhooks ───────────── */

  async function syncEventSub() {
    const t = tokens.get('twitch');
    if (!t) throw new Error('Connect Twitch first');
    if (!cfg.twitch.eventsubSecret) throw new Error('Set TWITCH_EVENTSUB_SECRET (10-100 chars) in .env and restart');
    if (!cfg.publicUrl.startsWith('https://')) throw new Error('Twitch needs an HTTPS callback: set PUBLIC_URL to your https:// domain');

    const callback = callbackUrl();
    const bid = t.user_id;
    const want = [
      { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: bid, moderator_user_id: bid } },
      ...(cfg.disable.twitchSubs ? [] : [
        { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: bid } },
        { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: bid } },
        { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: bid } },
      ]),
    ];

    const existing = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const r = await helix('/eventsub/subscriptions', { as: 'app', params: cursor ? { after: cursor } : {} });
      existing.push(...(r.data || []));
      cursor = r.pagination?.cursor;
      if (!cursor) break;
    }

    const result = [];
    for (const w of want) {
      const mine = existing.filter(
        (s) => s.type === w.type && s.transport?.callback === callback && s.condition?.broadcaster_user_id === bid
      );
      const healthy = mine.find((s) => ['enabled', 'webhook_callback_verification_pending'].includes(s.status));
      if (healthy) {
        result.push({ type: w.type, status: healthy.status });
        continue;
      }
      for (const s of mine) await helix('/eventsub/subscriptions', { as: 'app', method: 'DELETE', params: { id: s.id } }).catch(() => {});
      try {
        const r = await helix('/eventsub/subscriptions', {
          as: 'app',
          method: 'POST',
          body: {
            type: w.type,
            version: w.version,
            condition: w.condition,
            transport: { method: 'webhook', callback, secret: cfg.twitch.eventsubSecret },
          },
        });
        result.push({ type: w.type, status: r.data?.[0]?.status || 'created' });
      } catch (e) {
        result.push({ type: w.type, status: 'error', error: e.message });
      }
    }
    runtime.eventsub = { at: Date.now(), callback, result };
    return runtime.eventsub;
  }

  const who = (e) => e.user_id || e.user_login || e.user_name || '';

  function handleNotification(msgId, body) {
    const type = body.subscription?.type;
    const e = body.event || {};
    switch (type) {
      case 'channel.follow':
        return engine.ingest({
          key: `tw:follow:${e.user_id}:${Date.parse(e.followed_at)}`,
          type: 'twitch.follow',
          name: e.user_name || e.user_login,
          bump: [['twFollowers', 1]],
        });
      case 'channel.subscribe':
        // Keyed on the person, not the delivery: a leftover EventSub subscription (say from an old PUBLIC_URL that still
        // reaches this app) sends the same sub with a different message id.
        return engine.ingest({
          key: `tw:sub:${who(e) ? `${who(e)}:${e.tier}:${new Date().toISOString().slice(0, 10)}` : msgId}`,
          type: 'twitch.sub',
          name: e.user_name || e.user_login,
          detail: [TIERS[e.tier] || 'Subscriber', e.is_gift ? 'gifted' : ''].filter(Boolean).join(' · '),
          bump: [['twSubs', 1]],
          quiet: !!e.is_gift, // the gift event already announces it; each recipient only adds to the count and the log
        });
      case 'channel.subscription.message':
        return engine.ingest({
          key: `tw:resub:${who(e) && e.cumulative_months ? `${who(e)}:${e.cumulative_months}` : msgId}`,
          type: 'twitch.resub',
          name: e.user_name || e.user_login,
          detail: [e.cumulative_months ? `${e.cumulative_months} months` : '', TIERS[e.tier]].filter(Boolean).join(' · '),
          message: e.message?.text,
        });
      case 'channel.subscription.gift':
        return engine.ingest({
          key: `tw:gift:${msgId}`,
          type: 'twitch.gift',
          name: e.is_anonymous ? 'Anonymous' : e.user_name || e.user_login,
          detail: [e.total ? `${e.total} ${e.total === 1 ? 'sub' : 'subs'}` : '', TIERS[e.tier]].filter(Boolean).join(' · '),
        });
      default:
        engine.note(`Twitch event ignored: ${type}`);
        return { ignored: true };
    }
  }

  // Express handler; req.body is the raw Buffer (see server.js).
  function handleWebhook(req, res) {
    if (!cfg.twitch.eventsubSecret) return res.status(503).type('text/plain').send('twitch webhooks not configured');

    const id = req.get('twitch-eventsub-message-id');
    const ts = req.get('twitch-eventsub-message-timestamp');
    const sig = req.get('twitch-eventsub-message-signature');
    const type = req.get('twitch-eventsub-message-type');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!id || !ts || !sig || !type) return res.status(400).type('text/plain').send('missing headers');

    const expected = `sha256=${crypto
      .createHmac('sha256', cfg.twitch.eventsubSecret)
      .update(id)
      .update(ts)
      .update(raw)
      .digest('hex')}`;
    if (!safeEq(expected, sig)) return res.status(403).type('text/plain').send('bad signature');

    const age = Math.abs(Date.now() - Date.parse(ts));
    if (!Number.isFinite(age) || age > MAX_SKEW_MS) return res.status(403).type('text/plain').send('stale message');

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).type('text/plain').send('bad json');
    }

    runtime.received += 1;
    runtime.lastReceivedAt = Date.now();

    if (type === 'webhook_callback_verification') {
      log(`[twitch] verified ${body.subscription?.type}`);
      return res.status(200).type('text/plain').send(String(body.challenge || ''));
    }
    if (type === 'revocation') {
      engine.note(`Twitch revoked ${body.subscription?.type}: ${body.subscription?.status}. Press "Sync webhooks" in /admin.`);
      return res.sendStatus(204);
    }
    if (type === 'notification') {
      try {
        handleNotification(id, body);
      } catch (e) {
        log(`[twitch] notification error: ${e.message}`);
      }
      return res.sendStatus(204);
    }
    return res.sendStatus(204);
  }

  function status() {
    const t = tokens.get('twitch');
    return {
      configured: configured(),
      connected: !!t,
      account: t?.display_name || t?.login || null,
      redirectUri: redirectUri(),
      callbackUrl: callbackUrl(),
      webhookSecretSet: !!cfg.twitch.eventsubSecret,
      eventsub: runtime.eventsub,
      webhooksReceived: runtime.received,
      lastWebhookAt: runtime.lastReceivedAt,
      lastRunAt: poller.status.lastRunAt,
      lastOkAt: poller.status.lastOkAt,
      lastError: poller.status.lastError,
      warnings: runtime.warnings,
    };
  }

  function disconnect() {
    tokens.clear('twitch');
    runtime.eventsub = null;
    runtime.warnings = [];
  }

  return {
    configured,
    authUrl,
    exchangeCode,
    syncEventSub,
    handleWebhook,
    status,
    disconnect,
    start: () => poller.start(),
    refresh: () => poller.now(),
  };
};
