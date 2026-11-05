'use strict';

const cfg = require('../config');
const { log } = require('../util');

// Reads YouTube live chat. YouTube only has a chat while you are live, so this is a
// small state machine that never gives up:
//   off → idle (not live; look again every few seconds/minutes) → live (reading chat)
//   → idle again when the stream ends. Every error is classified and retried.
// Cost: liveBroadcasts.list = 1 quota unit, liveChatMessages.list = 5 units per read.

module.exports = function createYouTubeChat({ yt, chat, store, hub }) {
  const st = { state: 'off', detail: 'Not started', title: null, messages: 0, lastPollAt: null, lastError: null, since: null };
  let running = false;
  let wakeFn = null;
  let liveChatId = null;
  let pageToken = null;
  let baselined = false;
  let lastMsgAt = 0;
  let failures = 0;

  const T = (ms) => Math.max(15, Math.round(ms * cfg.timeScale)); // timeScale is 1 outside tests
  const conf = () => store.state.settings.chat;
  const short = (m) => String(m || '').replace(/^HTTP \d+ from \S+: /, '').slice(0, 140);

  function status() {
    const c = conf();
    return {
      state: st.state,
      detail: st.detail,
      title: st.title,
      messages: st.messages,
      lastPollAt: st.lastPollAt,
      lastError: st.lastError,
      quotaPerHourWhileLive: Math.round((3600 / Math.max(5, c.ytMinPollSec)) * 5),
    };
  }

  function setState(state, detail, extra = {}) {
    const changed = st.state !== state || st.detail !== detail;
    st.state = state;
    st.detail = detail;
    Object.assign(st, extra);
    if (changed) {
      hub.broadcast('chatstatus', { youtube: status() }, (c) => c.kind === 'admin');
      hub.broadcast('livestatus', { youtube: st.state }, (c) => c.kind === 'overlay' && c.status);
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

  function reset() {
    liveChatId = null;
    pageToken = null;
    baselined = false;
    st.messages = 0;
    st.since = null;
  }

  const reasonOf = (e) => (e && e.body && e.body.error && e.body.error.errors && e.body.error.errors[0] && e.body.error.errors[0].reason) || '';

  async function findBroadcast() {
    const r = await yt.api('/liveBroadcasts', { part: 'snippet,status', broadcastStatus: 'active', maxResults: '5' });
    const items = (r.items || []).filter((b) => b.snippet && b.snippet.liveChatId);
    const live = items.find((b) => b.status && b.status.lifeCycleStatus === 'live') || items[0];
    return live ? { liveChatId: live.snippet.liveChatId, title: live.snippet.title || 'your stream' } : null;
  }

  function badgesOf(au) {
    const b = [];
    if (au.isChatOwner) b.push('owner');
    if (au.isChatModerator) b.push('mod');
    if (au.isChatSponsor) b.push('member');
    return b;
  }

  function handleItem(it) {
    const sn = it.snippet || {};
    const au = it.authorDetails || {};
    const base = { source: 'youtube', id: it.id, name: au.displayName, aid: au.channelId, badges: badgesOf(au) };
    const textOf = (t) => [{ t: 'text', v: t || '' }];
    switch (sn.type) {
      case 'textMessageEvent':
        st.messages += 1;
        lastMsgAt = Date.now();
        chat.push({ ...base, kind: 'message', parts: textOf((sn.textMessageDetails && sn.textMessageDetails.messageText) || sn.displayMessage) });
        break;
      case 'superChatEvent': {
        const d = sn.superChatDetails || {};
        st.messages += 1;
        lastMsgAt = Date.now();
        chat.push({ ...base, kind: 'superchat', amount: d.amountDisplayString, parts: textOf(d.userComment) });
        break;
      }
      case 'superStickerEvent': {
        const d = sn.superStickerDetails || {};
        st.messages += 1;
        lastMsgAt = Date.now();
        chat.push({ ...base, kind: 'superchat', amount: d.amountDisplayString, parts: textOf('sent a sticker') });
        break;
      }
      case 'newSponsorEvent':
        if (cfg.disable.youtubeMembers) break;
        chat.push({ ...base, kind: 'member', parts: textOf('just became a member!') });
        break;
      case 'memberMilestoneChatEvent': {
        if (cfg.disable.youtubeMembers) break;
        const d = sn.memberMilestoneChatDetails || {};
        chat.push({ ...base, kind: 'member', parts: textOf(d.userComment || (d.memberMonth ? `${d.memberMonth} months as a member` : 'member milestone')) });
        break;
      }
      case 'messageDeletedEvent':
        chat.removeByKey('youtube', sn.messageDeletedDetails && sn.messageDeletedDetails.deletedMessageId);
        break;
      case 'userBannedEvent':
        chat.removeByAuthor('youtube', sn.userBannedDetails && sn.userBannedDetails.bannedUserDetails && sn.userBannedDetails.bannedUserDetails.channelId);
        break;
      default:
        break; // polls, mode changes, tombstones…
    }
  }

  // Returns ms to wait before the next read, or -1 when the stream has ended.
  async function pollOnce() {
    const r = await yt.api('/liveChat/messages', {
      liveChatId,
      part: 'snippet,authorDetails',
      maxResults: '200',
      ...(pageToken ? { pageToken } : {}),
    });
    st.lastPollAt = Date.now();
    pageToken = r.nextPageToken || pageToken;
    if (!baselined) baselined = true; // the first page is chat history from before we joined: don't replay it
    else for (const it of r.items || []) handleItem(it);

    if (r.offlineAt) return -1;
    const serverMs = Number(r.pollingIntervalMillis) || 5000;
    const min = conf().ytMinPollSec * 1000;
    const quiet = Date.now() - lastMsgAt > 60_000 ? 2 : 1; // slow down when nobody is talking
    return Math.max(serverMs, min * quiet);
  }

  async function handleError(e) {
    const reason = reasonOf(e);
    const msg = e && e.message ? e.message : String(e);
    const searchMs = conf().ytSearchSec * 1000;

    if (['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled'].includes(reason) || (e.status === 404 && liveChatId)) {
      log(`[youtube-chat] chat is gone (${reason || e.status}); looking for the next stream`);
      const disabled = reason === 'liveChatDisabled';
      reset();
      setState('idle', disabled ? 'Live chat is turned off for this stream.' : 'The stream ended. Looking for the next one.', { lastError: null });
      return sleep(T(searchMs));
    }
    if (reason === 'liveStreamingNotEnabled') {
      reset();
      setState('idle', 'Live streaming is not enabled on this YouTube channel yet.', { lastError: null });
      return sleep(T(searchMs));
    }
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      setState('error', "YouTube's daily API quota is used up. Trying again in 15 minutes.", { lastError: msg });
      return sleep(T(15 * 60_000));
    }
    if (e.status === 401 || (e.body && e.body.error === 'invalid_grant') || ['insufficientPermissions', 'authError'].includes(reason)) {
      setState('error', 'The YouTube login needs attention. Press Reconnect in /admin.', { lastError: msg });
      return sleep(T(5 * 60_000));
    }

    failures += 1;
    let wait = Math.min(5000 * 2 ** (failures - 1), 60_000);
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') wait = Math.max(wait, 30_000);
    if (failures >= 5 && liveChatId) reset(); // look the broadcast up again; the chat id may be stale
    log(`[youtube-chat] error ${failures}: ${msg}`);
    setState('error', `YouTube chat problem, retrying in ${Math.round(wait / 1000)}s: ${short(msg)}`, { lastError: msg });
    return sleep(T(wait));
  }

  async function loop() {
    while (running) {
      try {
        const c = conf();
        if (!c.enabled || !c.youtube) {
          reset();
          setState('off', 'YouTube chat is turned off.');
          await sleep(T(5000));
          continue;
        }
        if (!yt.connected()) {
          reset();
          setState('off', 'Connect YouTube to read live chat.');
          await sleep(T(10_000));
          continue;
        }

        if (!liveChatId) {
          const found = await findBroadcast();
          if (!found) {
            failures = 0;
            st.lastError = null;
            setState('idle', `Not live on YouTube right now. Checking again every ${c.ytSearchSec}s.`, { title: null });
            await sleep(T(c.ytSearchSec * 1000));
            continue;
          }
          liveChatId = found.liveChatId;
          st.title = found.title;
          st.since = Date.now();
          st.messages = 0;
          pageToken = null;
          baselined = false;
          lastMsgAt = Date.now();
          log(`[youtube-chat] live: "${found.title}"`);
        }

        // Every read costs quota, so don't read when no overlay would show it.
        if (store.state.settings.holdWhenNoOverlay && !chat.listening()) {
          pageToken = null;
          baselined = false; // skip whatever was said while nobody was watching
          setState('paused', 'You are live. Waiting for an overlay with chat to open (saves API quota).', { title: st.title });
          await sleep(T(3000));
          continue;
        }

        const wait = await pollOnce();
        failures = 0;
        st.lastError = null;
        if (wait < 0) {
          log('[youtube-chat] stream ended');
          reset();
          setState('idle', 'The stream ended. Looking for the next one.', { title: null });
          await sleep(T(c.ytSearchSec * 1000));
          continue;
        }
        setState('live', `Live: "${st.title}". ${st.messages} chat messages so far.`);
        await sleep(T(wait));
      } catch (e) {
        try {
          await handleError(e);
        } catch (e2) {
          log(`[youtube-chat] error handler failed: ${e2.message}`);
          await sleep(T(10_000));
        }
      }
    }
  }

  return {
    status,
    wake,
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
