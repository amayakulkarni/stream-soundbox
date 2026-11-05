'use strict';

const net = require('net');
const tls = require('tls');
const cfg = require('../config');
const { tokens } = require('../store');
const { log } = require('../util');

// Reads your Twitch chat over IRC, signed in anonymously ("justinfan…"): no extra login, no API
// quota, and it works whether or not you are live. The connection is kept alive for you:
// any drop (network, Twitch asking us to reconnect, a silent connection) reconnects with back-off.

const unescapeTag = (v) => String(v || '').replace(/\\(.)/g, (_, c) => ({ s: ' ', n: ' ', r: ' ', ':': ';', '\\': '\\' }[c] ?? c));

function parseLine(line) {
  let rest = line;
  const tags = {};
  if (rest.startsWith('@')) {
    const i = rest.indexOf(' ');
    for (const kv of rest.slice(1, i).split(';')) {
      const eq = kv.indexOf('=');
      tags[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '' : unescapeTag(kv.slice(eq + 1));
    }
    rest = rest.slice(i + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const i = rest.indexOf(' ');
    prefix = rest.slice(1, i);
    rest = rest.slice(i + 1);
  }
  const j = rest.indexOf(' :');
  const trailing = j >= 0 ? rest.slice(j + 2) : '';
  const head = (j >= 0 ? rest.slice(0, j) : rest).split(' ').filter(Boolean);
  return { tags, prefix, command: head[0] || '', params: head.slice(1), trailing };
}

// Turn "Kappa hi Kappa" + emotes tag "25:0-4,9-13" into text/emote parts (indices count code points).
function toParts(text, emotesTag) {
  const chars = Array.from(text);
  const spans = [];
  for (const group of String(emotesTag || '').split('/').filter(Boolean)) {
    const [id, ranges] = group.split(':');
    if (!/^[\w-]+$/.test(id || '')) continue;
    for (const r of String(ranges || '').split(',')) {
      const [a, b] = r.split('-').map(Number);
      if (Number.isInteger(a) && Number.isInteger(b) && b >= a) spans.push({ a, b, id });
    }
  }
  spans.sort((x, y) => x.a - y.a);
  const parts = [];
  let pos = 0;
  for (const s of spans) {
    if (s.a < pos || s.a >= chars.length) continue;
    if (s.a > pos) parts.push({ t: 'text', v: chars.slice(pos, s.a).join('') });
    parts.push({ t: 'emoji', name: chars.slice(s.a, s.b + 1).join(''), url: `https://static-cdn.jtvnw.net/emoticons/v2/${s.id}/default/dark/1.0` });
    pos = s.b + 1;
  }
  if (pos < chars.length) parts.push({ t: 'text', v: chars.slice(pos).join('') });
  return parts;
}

module.exports = function createTwitchChat({ chat, store, hub }) {
  const st = { state: 'off', detail: 'Not started', channel: null, lastMessageAt: null, lastError: null };
  let running = false;
  let sock = null;
  let timer = null;
  let watchdog = null;
  let failures = 0;
  let onlineSince = 0;
  let wanted = null; // channel we are (trying to be) connected to

  const T = (ms) => Math.max(15, Math.round(ms * cfg.timeScale));
  const conf = () => store.state.settings.chat;

  function channel() {
    if (cfg.twitch.channel) return cfg.twitch.channel;
    const t = tokens.get('twitch');
    return t && /^[a-z0-9_]{3,25}$/.test(t.login || '') ? t.login : null;
  }

  function status() {
    return { state: st.state, detail: st.detail, channel: st.channel, lastMessageAt: st.lastMessageAt, lastError: st.lastError };
  }

  function setState(state, detail, extra = {}) {
    const changed = st.state !== state || st.detail !== detail;
    st.state = state;
    st.detail = detail;
    Object.assign(st, extra);
    if (changed) {
      hub.broadcast('chatstatus', { twitch: status() }, (c) => c.kind === 'admin');
      hub.broadcast('livestatus', { twitch: st.state }, (c) => c.kind === 'overlay' && c.status);
    }
  }

  function handle(line) {
    const m = parseLine(line);
    switch (m.command) {
      case 'PING':
        return sock && sock.write(`PONG :${m.trailing || 'tmi.twitch.tv'}\r\n`);
      case 'RECONNECT':
        log('[twitch-chat] Twitch asked us to reconnect');
        return sock && sock.destroy();
      case '366': // end of names list: we are in the channel
        failures = 0;
        onlineSince = Date.now();
        return setState('online', `Listening to #${st.channel}`, { lastError: null });
      case 'NOTICE':
        if (/Login (unsuccessful|authentication failed)|Improperly formatted auth/i.test(m.trailing)) setState('error', `Twitch refused the connection: ${m.trailing}`, { lastError: m.trailing });
        return undefined;
      case 'PRIVMSG': {
        let text = m.trailing;
        const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
        if (action) text = action[1];
        const b = String(m.tags.badges || '');
        const badges = [];
        if (b.includes('broadcaster/')) badges.push('owner');
        if (b.includes('moderator/')) badges.push('mod');
        if (b.includes('vip/')) badges.push('vip');
        if (b.includes('subscriber/') || b.includes('founder/')) badges.push('member');
        const bits = Number(m.tags.bits) || 0;
        const login = m.prefix.split('!')[0];
        st.lastMessageAt = Date.now();
        chat.push({
          source: 'twitch',
          id: m.tags.id || `${Date.now()}-${Math.random()}`,
          name: m.tags['display-name'] || login,
          aid: m.tags['user-id'],
          bot: false,
          kind: bits > 0 ? 'superchat' : 'message',
          amount: bits > 0 ? `${bits} bits` : '',
          badges,
          parts: toParts(text, m.tags.emotes),
        });
        return undefined;
      }
      case 'USERNOTICE': {
        const id = m.tags['msg-id'];
        if ((id === 'sub' || id === 'resub') && !cfg.disable.twitchSubs) {
          chat.push({
            source: 'twitch',
            id: m.tags.id || `${Date.now()}-${Math.random()}`,
            name: m.tags['display-name'] || m.tags.login,
            aid: m.tags['user-id'],
            kind: 'member',
            badges: ['member'],
            parts: [{ t: 'text', v: m.trailing || (id === 'sub' ? 'just subscribed!' : 'resubscribed!') }],
          });
        }
        return undefined;
      }
      case 'CLEARMSG':
        return chat.removeByKey('twitch', m.tags['target-msg-id']);
      case 'CLEARCHAT':
        if (m.tags['target-user-id']) chat.removeByAuthor('twitch', m.tags['target-user-id']);
        else chat.clear();
        return undefined;
      default:
        return undefined;
    }
  }

  function scheduleReconnect() {
    clearTimeout(timer);
    if (!running) return;
    failures += 1;
    const wait = Math.min(1000 * 2 ** Math.min(failures - 1, 6), 60_000); // 1s … 60s
    setState('error', `Twitch chat disconnected, reconnecting in ${Math.round(wait / 1000)}s`);
    timer = setTimeout(connect, T(wait));
  }

  function connect() {
    clearTimeout(timer);
    clearInterval(watchdog);
    const c = conf();
    const ch = channel();
    if (!c.enabled || !c.twitch) {
      wanted = null;
      return setState('off', 'Twitch chat is turned off.');
    }
    if (!ch) {
      wanted = null;
      setState('off', 'Connect Twitch, or set TWITCH_CHANNEL in .env, to read your chat.');
      timer = setTimeout(connect, T(10_000));
      return undefined;
    }
    wanted = ch;
    st.channel = ch;
    setState('connecting', `Connecting to #${ch}…`);
    let buf = '';
    let lastData = Date.now();
    const s = (cfg.endpoints.twitchIrcTls ? tls : net).connect({ host: cfg.endpoints.twitchIrcHost, port: cfg.endpoints.twitchIrcPort, ...(cfg.endpoints.twitchIrcTls ? { servername: cfg.endpoints.twitchIrcHost } : {}) });
    sock = s;
    s.setEncoding('utf8');
    s.setNoDelay(true);
    s.on(cfg.endpoints.twitchIrcTls ? 'secureConnect' : 'connect', () => {
      s.write(`CAP REQ :twitch.tv/tags twitch.tv/commands\r\nPASS SCHMOOZE\r\nNICK justinfan${Math.floor(10000 + Math.random() * 89999)}\r\nJOIN #${ch}\r\n`);
    });
    s.on('data', (d) => {
      lastData = Date.now();
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line) {
          try {
            handle(line);
          } catch (e) {
            log(`[twitch-chat] bad line ignored: ${e.message}`);
          }
        }
      }
      if (buf.length > 65536) buf = ''; // never let a broken stream grow without bound
    });
    s.on('error', (e) => {
      st.lastError = e.message;
    });
    s.on('close', () => {
      if (sock !== s) return; // an old socket we replaced on purpose
      sock = null;
      clearInterval(watchdog);
      if (Date.now() - onlineSince > 60_000 && onlineSince) failures = 0; // it was healthy for a while
      scheduleReconnect();
    });
    // Twitch pings every ~5 minutes; if nothing at all arrives for 7, the connection is dead.
    watchdog = setInterval(() => {
      if (Date.now() - lastData > T(7 * 60_000)) {
        log('[twitch-chat] connection went silent; reconnecting');
        s.destroy();
      }
    }, T(30_000));
    return undefined;
  }

  // Settings or channel changed: reconnect only if needed.
  function wake() {
    const c = conf();
    const ch = channel();
    const shouldRun = c.enabled && c.twitch && ch;
    if (!shouldRun && sock) {
      const s = sock;
      sock = null;
      s.destroy();
    }
    if ((shouldRun && !sock && st.state !== 'connecting') || (shouldRun && wanted && wanted !== ch)) {
      if (sock && wanted !== ch) {
        const s = sock;
        sock = null;
        s.destroy();
      }
      failures = 0;
      connect();
    } else if (!shouldRun) {
      connect(); // updates the "off" status text
    }
  }

  return {
    status,
    wake,
    retry() {
      failures = 0;
      if (sock) {
        const s = sock;
        sock = null;
        s.destroy();
      }
      connect();
    },
    start() {
      if (running) return;
      running = true;
      connect();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      clearInterval(watchdog);
      if (sock) sock.destroy();
    },
  };
};
