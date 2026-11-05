'use strict';

const cfg = require('../config');
const { fetchJson, log } = require('../util');
const { createPoller } = require('../poller');
const { createAnonSubs } = require('./ytanon');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  ...(cfg.disable.youtubeMembers ? [] : ['https://www.googleapis.com/auth/youtube.channel-memberships.creator']),
];

module.exports = function createYouTube({ store, tokens, engine }) {
  const runtime = { warnings: [] };

  const configured = () => !!(cfg.youtube.clientId && cfg.youtube.clientSecret);
  const redirectUri = () => `${cfg.publicUrl}/admin/auth/youtube/callback`;

  /* ───────────── OAuth ───────────── */

  function authUrl(state) {
    const p = new URLSearchParams({
      client_id: cfg.youtube.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${cfg.endpoints.googleAuth}?${p}`;
  }

  async function tokenRequest(params) {
    return fetchJson(cfg.endpoints.googleToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.youtube.clientId,
        client_secret: cfg.youtube.clientSecret,
        ...params,
      }),
    });
  }

  async function exchangeCode(code) {
    const r = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
    if (!r.refresh_token) {
      throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
    }
    const saved = {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: Date.now() + (r.expires_in || 3600) * 1000,
      scope: r.scope || '',
    };
    tokens.set('youtube', saved);
    const ch = await fetchChannel(); // also records the channel title
    runtime.warnings = [];
    poller.now().catch(() => {});
    return ch;
  }

  async function accessToken() {
    const t = tokens.get('youtube');
    if (!t) throw new Error('YouTube is not connected');
    if (t.access_token && t.expires_at - 60_000 > Date.now()) return t.access_token;
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    tokens.set('youtube', {
      ...t,
      access_token: r.access_token,
      expires_at: Date.now() + (r.expires_in || 3600) * 1000,
    });
    return r.access_token;
  }

  async function api(path, params) {
    const url = new URL(cfg.endpoints.youtubeApi + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const token = await accessToken();
    return fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
  }

  /* ───────────── polling ───────────── */

  async function fetchChannel() {
    const r = await api('/channels', { part: 'snippet,statistics', mine: 'true' });
    const c = r.items && r.items[0];
    if (!c) throw new Error('This Google account has no YouTube channel');
    const t = tokens.get('youtube');
    if (t && (t.channel_id !== c.id || t.channel_title !== c.snippet?.title)) {
      tokens.set('youtube', { ...t, channel_id: c.id, channel_title: c.snippet?.title || '' });
    }
    return c;
  }

  async function pollSubscribers() {
    const ps = store.state.providers.youtube;
    const r = await api('/subscriptions', {
      part: 'snippet,subscriberSnippet',
      myRecentSubscribers: 'true',
      maxResults: '50',
    });
    const fresh = [];
    for (const it of r.items || []) {
      if (!it.id) continue;
      const key = `yt:sub:${it.id}`;
      if (store.seen.has(key)) continue;
      fresh.push({ key, name: it.subscriberSnippet?.title });
    }
    // First run only learns who is already subscribed; nobody is announced.
    if (!ps.subsSeeded) {
      for (const f of fresh) store.markSeen(f.key);
      ps.subsSeeded = true;
      store.save();
      return 0;
    }
    // API is newest-first; announce oldest-first.
    for (const f of fresh.reverse()) {
      engine.ingest({ key: f.key, type: 'youtube.subscriber', name: f.name });
    }
    return fresh.length;
  }

  // YouTube only lists subscribers whose subscriptions are PUBLIC; private ones raise the count with
  // no name. See ytanon.js for how a rise is told apart from a name that is just running late.
  const waitMin = parseInt(process.env.YOUTUBE_ANON_WAIT_MIN, 10);
  const anonStep = createAnonSubs({ waitMs: (Number.isNaN(waitMin) ? 30 : Math.max(0, waitMin)) * 60_000 });
  function anonymousSubs(count, named) {
    const due = anonStep(count, named);
    const announce = process.env.YOUTUBE_ANON_SUBS !== '0' ? due : 0;
    for (let i = 0; i < announce; i++) {
      engine.ingest({ key: `yt:anon:${Date.now()}:${i}:${Math.random().toString(36).slice(2, 8)}`, type: 'youtube.subscriber', name: 'Someone' });
    }
  }

  async function pollMembers() {
    const ps = store.state.providers.youtube;
    const current = new Map();
    let pageToken;
    for (let page = 0; page < 20; page++) {
      const r = await api('/members', {
        part: 'snippet',
        mode: 'all_current',
        maxResults: '1000',
        ...(pageToken ? { pageToken } : {}),
      });
      for (const m of r.items || []) {
        const d = m.snippet?.memberDetails || {};
        const md = m.snippet?.membershipsDetails || {};
        if (!d.channelId) continue;
        current.set(d.channelId, {
          name: d.displayName,
          since: md.membershipsDuration?.memberSince,
          level: md.highestAccessibleLevelDisplayName,
        });
      }
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    engine.setCounter('ytMembers', current.size);

    if (!ps.membersSeeded) {
      ps.memberIds = [...current.keys()];
      ps.membersSeeded = true;
      store.save();
      return;
    }
    const known = new Set(ps.memberIds);
    for (const [id, m] of current) {
      if (known.has(id)) continue;
      engine.ingest({
        key: `yt:member:${id}:${m.since || Math.floor(Date.now() / 3_600_000)}`,
        type: 'youtube.member',
        name: m.name,
        detail: m.level,
      });
    }
    ps.memberIds = [...current.keys()];
    store.save();
  }

  async function poll() {
    if (!tokens.get('youtube')) return;
    const channel = await fetchChannel(); // failure here = real poll failure
    const stats = channel.statistics || {};
    if (stats.hiddenSubscriberCount) {
      engine.setCounter('ytSubs', null);
      engine.setFlag('ytSubsHidden', true);
    } else {
      engine.setFlag('ytSubsHidden', false);
      engine.setCounter('ytSubs', Number(stats.subscriberCount || 0));
    }

    const warnings = [];
    try {
      const named = await pollSubscribers();
      anonymousSubs(stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount || 0), named);
    } catch (e) {
      warnings.push(`subscriber names: ${e.message}`);
    }
    try {
      if (!cfg.disable.youtubeMembers) await pollMembers();
    } catch (e) {
      // Channels without memberships enabled answer 403; that's not a failure.
      warnings.push(`members: ${e.message}`);
    }
    runtime.warnings = warnings;
    if (warnings.length) log(`[youtube] partial: ${warnings.join(' | ')}`);
  }

  const poller = createPoller('youtube', () => store.state.settings.youtubePollSec, poll);

  function status() {
    const t = tokens.get('youtube');
    return {
      configured: configured(),
      connected: !!t,
      account: t?.channel_title || null,
      redirectUri: redirectUri(),
      lastRunAt: poller.status.lastRunAt,
      lastOkAt: poller.status.lastOkAt,
      lastError: poller.status.lastError,
      warnings: runtime.warnings,
    };
  }

  function disconnect() {
    tokens.clear('youtube');
    runtime.warnings = [];
  }

  return { configured, authUrl, exchangeCode, status, disconnect, api, connected: () => !!tokens.get('youtube'), start: () => poller.start(), refresh: () => poller.now() };
};
