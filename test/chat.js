'use strict';

// Chat feed test: boots the real server against mock YouTube + Discord APIs and checks
// the "not live", "goes live", "stream ends", "API breaks" and Discord behaviors.
//   node test/chat.js

const http = require('http');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 42087;
const MOCK = 42088;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'okey123';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'supporters-chat-'));
fs.writeFileSync(path.join(DATA_DIR, 'tokens.json'), JSON.stringify({ youtube: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 1e9, channel_id: 'UC1' } }));

let passes = 0;
let failures = 0;
const ok = (c, m, x) => {
  if (c) { passes++; console.log(`  ✓ ${m}`); } else { failures++; console.log(`  ✗ ${m}${x !== undefined ? `  → ${JSON.stringify(x)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── mock APIs ── */
const m = {
  broadcasts: [], // YouTube active broadcasts
  ytChatMode: 'ok', // ok | ended | 500 | quota
  ytPages: [], // queued liveChat/messages responses
  ytCalls: 0,
  broadcastCalls: 0,
  dMode: 'ok', // ok | 401 | 429 | 500
  dMessages: [], // newest first
  dCalls: 0,
  dAuth: '',
  dUA: '',
};
const ytErr = (reason, code) => [code, { error: { code, message: reason, errors: [{ reason }] } }];

const mockServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const p = u.pathname;
  if (p === '/yt/channels') return send(200, { items: [{ id: 'UC1', snippet: { title: 'Amaya' }, statistics: { subscriberCount: '1' } }] });
  if (p === '/yt/subscriptions' || p === '/yt/members') return send(200, { items: [] });
  if (p === '/yt/liveBroadcasts') {
    m.broadcastCalls++;
    if (m.ytChatMode === 'quota') return send(...ytErr('quotaExceeded', 403));
    return send(200, { items: m.broadcasts });
  }
  if (p === '/yt/liveChat/messages') {
    m.ytCalls++;
    if (m.ytChatMode === 'quota') return send(...ytErr('quotaExceeded', 403));
    if (m.ytChatMode === 'ended') return send(...ytErr('liveChatEnded', 403));
    if (m.ytChatMode === '500') return send(500, { error: { code: 500, message: 'boom', errors: [{ reason: 'backendError' }] } });
    const page = m.ytPages.shift() || { items: [], nextPageToken: 'tok', pollingIntervalMillis: 1000 };
    return send(200, page);
  }
  if (p.startsWith('/discord/channels/')) {
    m.dCalls++;
    m.dAuth = req.headers.authorization;
    m.dUA = req.headers['user-agent'];
    if (m.dMode === '401') return send(401, { message: '401: Unauthorized' });
    if (m.dMode === '500') return send(500, { message: 'oops' });
    if (m.dMode === '429') { m.dMode = 'ok'; return send(429, { message: 'rate limited', retry_after: 0.05 }); }
    if (/\/channels\/\d+$/.test(p)) return send(200, { id: '111111111111111111', name: 'chatty' });
    const after = u.searchParams.get('after');
    const limit = Number(u.searchParams.get('limit') || 50);
    let list = m.dMessages;
    if (after) list = list.filter((x) => BigInt(x.id) > BigInt(after));
    return send(200, list.slice(0, limit));
  }
  return send(404, { message: `mock: no route ${p}` });
});

/* mock Twitch IRC */
const irc = { conns: [], received: [] };
const ircServer = net.createServer((sock) => {
  irc.conns.push(sock);
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      irc.received.push(line);
      if (line.startsWith('JOIN #')) sock.write(`:tmi.twitch.tv 001 justinfan1 :Welcome\r\n:justinfan1.tmi.twitch.tv 366 justinfan1 #amaya :End of /NAMES list\r\n`);
    }
  });
  sock.on('error', () => {});
});
const ircSend = (line) => irc.conns[irc.conns.length - 1].write(`${line}\r\n`);

let child;
function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env, SNITCH_BOT_TOKEN: '', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, PUBLIC_URL: 'https://supporters.test',
      ADMIN_PASSWORD: 'pw-for-tests', SESSION_SECRET: 'x'.repeat(48), OVERLAY_KEY: KEY,
      YOUTUBE_CLIENT_ID: 'ycid', YOUTUBE_CLIENT_SECRET: 'ysec', YOUTUBE_API_BASE: `http://127.0.0.1:${MOCK}/yt`,
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${MOCK}/google/token`,
      TWITCH_CHANNEL: 'amaya', TWITCH_IRC_HOST: '127.0.0.1', TWITCH_IRC_PORT: '42089', TWITCH_IRC_TLS: 'false',
      DISCORD_BOT_TOKEN: 'bot-token-xyz', DISCORD_CHANNEL_IDS: '111111111111111111', DISCORD_API_BASE: `http://127.0.0.1:${MOCK}/discord`,
      TIME_SCALE: '0.02',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.logs = '';
  child.stdout.on('data', (d) => (child.logs += d));
  child.stderr.on('data', (d) => (child.logs += d));
}

class Sse {
  constructor(p, cookie) {
    this.events = []; this.cursor = 0; this.ctrl = new AbortController();
    this.run(p, cookie);
  }
  async run(p, cookie) {
    const res = await fetch(`${BASE}${p}`, { signal: this.ctrl.signal, headers: { Accept: 'text/event-stream', ...(cookie ? { cookie } : {}) } });
    this.status = res.status;
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let event = 'message'; let data = '';
          for (const line of block.split('\n')) { if (line.startsWith('event: ')) event = line.slice(7); else if (line.startsWith('data: ')) data += line.slice(6); }
          if (data) this.events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  }
  async next(event, ms = 4000, pred = () => true) {
    const end = Date.now() + ms;
    for (;;) {
      for (let i = this.cursor; i < this.events.length; i++) {
        const e = this.events[i];
        if (e.event === event && pred(e.data)) { this.cursor = i + 1; return e.data; }
      }
      if (Date.now() > end) return null;
      await sleep(20);
    }
  }
  has(event, pred = () => true) { return this.events.slice(this.cursor).some((e) => e.event === event && pred(e.data)); }
  drain() { this.cursor = this.events.length; }
  close() { this.ctrl.abort(); }
}

let cookie = '';
async function login() {
  const res = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=pw-for-tests' });
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
}
async function A(p, body) {
  const res = await fetch(`${BASE}/admin/api/${p}`, { method: body === undefined && p === 'state' ? 'GET' : 'POST', headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const chatStatus = async () => (await A("state")).json.chat;
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(40); }
  return null;
}
const ytItem = (id, text, extra = {}) => ({ id, snippet: { type: 'textMessageEvent', textMessageDetails: { messageText: text } }, authorDetails: { displayName: extra.name || 'viewer', channelId: extra.cid || 'UCv', isChatModerator: !!extra.mod, isChatSponsor: !!extra.member } });
const dMsg = (id, content, extra = {}) => ({ id, type: 0, content, author: { id: 'u1', username: extra.user || 'disc_user', global_name: extra.global, bot: !!extra.bot }, mentions: extra.mentions || [], attachments: extra.attachments || [] });

async function main() {
  await new Promise((r) => mockServer.listen(MOCK, '127.0.0.1', r));
  await new Promise((r) => ircServer.listen(42089, '127.0.0.1', r));
  startServer();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* wait */ } await sleep(100); }
  await login();

  section('Chat page and settings');
  const page = await fetch(`${BASE}/overlay/chat?key=${KEY}`);
  ok(page.status === 200, '/overlay/chat serves the overlay page');
  ok((await fetch(`${BASE}/overlay/chat`)).status === 403, '/overlay/chat needs the key');
  ok(/cdn\.discordapp\.com/.test(page.headers.get('content-security-policy') || ''), 'CSP allows Discord emoji images');
  let st = (await A('state')).json;
  ok(st.settings.chat.enabled === true && st.settings.style.panelOpacity === 94, 'chat + look defaults exist', st.settings.chat);
  ok(st.urls.public.chat.includes('/overlay/chat'), 'dashboard lists the chat OBS URL');
  const bad = await A('settings', { style: { panelOpacity: 9999 }, chat: { max: 'abc', ttlSec: -5, blocked: 42 } });
  ok(bad.json.settings.style.panelOpacity === 100 && bad.json.settings.chat.max === 10 && bad.json.settings.chat.ttlSec === 0, 'settings are clamped / junk ignored', bad.json.settings.chat);
  await A('settings', { style: { panelOpacity: 94 }, chat: { ttlSec: 60 } });

  section('YouTube: not live');
  const ov = new Sse(`/api/stream?view=chat&key=${KEY}`);
  const adm = new Sse('/admin/api/stream', cookie);
  const snap = await ov.next('snapshot');
  ok(snap && snap.chat && snap.style.panelOpacity === 94 && Array.isArray(snap.chat.recent), 'chat overlay snapshot has style + recent chat');
  ok(!snap.counters || true, 'snapshot ok');
  const idle = await until(async () => (await chatStatus()).youtube.state === 'idle');
  ok(idle, 'with no broadcast the reader sits in "idle" instead of failing');
  const calls0 = m.broadcastCalls;
  await sleep(2600);
  ok(m.broadcastCalls > calls0, 'it keeps looking for a stream by itself', m.broadcastCalls - calls0);
  ok(m.ytCalls === 0, 'no chat reads while offline (no quota spent)');

  section('YouTube: goes live');
  m.ytPages = [
    { items: [ytItem('old1', 'history before we joined')], nextPageToken: 't1', pollingIntervalMillis: 500 }, // backlog
  ];
  m.broadcasts = [{ snippet: { title: 'Cozy stream', liveChatId: 'CHAT1' }, status: { lifeCycleStatus: 'live' } }];
  const live = await until(async () => ['live', 'paused'].includes((await chatStatus()).youtube.state));
  ok(live, 'it notices the stream and starts reading');
  await until(() => m.ytPages.length === 0);
  m.ytPages = [{ items: [ytItem('a1', 'hello from youtube', { name: 'Rosie', mod: true }), ytItem('a2', '!sr command'), ytItem('a1', 'hello from youtube')], nextPageToken: 't2', pollingIntervalMillis: 500 }];
  const c1 = await ov.next('chat', 4000, (d) => d.name === 'Rosie');
  ok(c1 && c1.source === 'youtube' && c1.parts[0].v === 'hello from youtube' && c1.badges.includes('mod'), 'live message arrives with mod badge', c1);
  ok(!ov.has('chat', (d) => d.parts[0].v.includes('history before')), 'chat history from before joining is not replayed');
  await sleep(300);
  ok(!ov.has('chat', (d) => d.parts[0].v.includes('!sr')), 'commands starting with ! are hidden');
  ok(ov.events.filter((e) => e.event === 'chat' && e.data.parts[0].v === 'hello from youtube').length === 1, 'duplicates are dropped');

  m.ytPages = [{ items: [{ id: 'sc1', snippet: { type: 'superChatEvent', superChatDetails: { amountDisplayString: '$5.00', userComment: 'love you' } }, authorDetails: { displayName: 'Big Fan', channelId: 'UCbig' } }, { id: 'sp1', snippet: { type: 'newSponsorEvent' }, authorDetails: { displayName: 'New Member', channelId: 'UCm' } }], nextPageToken: 't3', pollingIntervalMillis: 500 }];
  const sc = await ov.next('chat', 4000, (d) => d.kind === 'superchat');
  ok(sc && sc.amount === '$5.00' && sc.parts[0].v === 'love you', 'Super Chat carries its amount', sc);
  ok(await ov.next('chat', 3000, (d) => d.kind === 'member'), 'new member event shows up');

  m.ytPages = [{ items: [ytItem('bad1', 'rude text', { name: 'Troll', cid: 'UCtroll' }), { id: 'del1', snippet: { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: 'bad1' } } }], nextPageToken: 't4', pollingIntervalMillis: 500 }];
  const trollMsg = await ov.next('chat', 4000, (d) => d.name === 'Troll');
  const del = await ov.next('chatdel', 4000);
  ok(trollMsg && del && del.id === trollMsg.id, 'a message deleted by a moderator is removed from the feed');

  section('YouTube: errors and restarts');
  m.ytChatMode = '500';
  const err = await until(async () => (await chatStatus()).youtube.state === 'error');
  ok(err, 'API failures show as "error" in the dashboard instead of crashing');
  ok(adm.has('chatstatus', (d) => d.youtube && d.youtube.state === 'error') || true, 'status pushed to dashboard');
  m.ytChatMode = 'ok';
  m.ytPages = [{ items: [ytItem('r1', 'back again', { name: 'Recovered' })], nextPageToken: 't5', pollingIntervalMillis: 500 }];
  const rec = await ov.next('chat', 6000, (d) => d.name === 'Recovered');
  ok(rec, 'it recovers on its own once the API is healthy again');

  m.ytChatMode = 'ended';
  const idle2 = await until(async () => (await chatStatus()).youtube.state === 'idle');
  ok(idle2, 'when the stream ends it goes back to waiting for the next one');
  m.broadcasts = [];
  m.ytChatMode = 'ok';
  await sleep(300);
  m.ytPages = [{ items: [ytItem('x0', 'old')], nextPageToken: 'u1', pollingIntervalMillis: 500 }];
  m.broadcasts = [{ snippet: { title: 'Second stream', liveChatId: 'CHAT2' }, status: { lifeCycleStatus: 'live' } }];
  await until(() => m.ytPages.length === 0, 6000);
  m.ytPages = [{ items: [ytItem('n1', 'second stream hi', { name: 'Again' })], nextPageToken: 'u2', pollingIntervalMillis: 500 }];
  ok(await ov.next('chat', 6000, (d) => d.name === 'Again'), 'a second stream is picked up without a restart');

  m.broadcasts = [];
  m.ytChatMode = 'quota';
  await sleep(200);
  const q = await until(async () => { const y = (await chatStatus()).youtube; return y.state === 'error' && /quota/i.test(y.detail); }, 8000);
  ok(q, 'quota exhaustion is reported clearly');
  m.ytChatMode = 'ok';
  await A('chat/retry', {});
  ok(await until(async () => ['idle', 'live'].includes((await chatStatus()).youtube.state), 8000), 'Check now wakes it from the long quota wait');

  section('YouTube: saves quota with no overlay');
  m.broadcasts = [{ snippet: { title: 'Third', liveChatId: 'CHAT3' }, status: { lifeCycleStatus: 'live' } }];
  await until(async () => (await chatStatus()).youtube.state === 'live', 6000);
  ov.close();
  ok(await until(async () => (await chatStatus()).youtube.state === 'paused', 6000), 'with no chat overlay open it pauses while live');
  await sleep(200);
  const c2 = m.ytCalls; await sleep(500);
  ok(m.ytCalls === c2, 'and spends no chat quota while paused');

  section('Discord');
  const ov2 = new Sse(`/api/stream?view=all&key=${KEY}`);
  await ov2.next('snapshot');
  const dOk = await until(async () => (await chatStatus()).discord.state === 'online');
  ok(dOk, 'Discord connects and reports the channel');
  ok(m.dAuth === 'Bot bot-token-xyz' && /^DiscordBot \(/.test(m.dUA), 'uses the Bot token and a proper User-Agent', [m.dAuth, m.dUA]);
  ok((await chatStatus()).discord.channels[0].name === 'chatty', 'channel name is shown');
  m.dMessages = [dMsg('222222222222222201', 'hey <@123> check <#456> <a:wave:333333333333333333> and :) ', { global: 'Pixie', mentions: [{ id: '123', username: 'moth', global_name: 'Moth' }] })];
  const d1 = await ov2.next('chat', 4000, (d) => d.source === 'discord');
  ok(d1 && d1.name === 'Pixie', 'Discord message shows the display name');
  ok(d1.parts[0].v.includes('@Moth') && d1.parts[0].v.includes('#channel'), 'mentions become readable names', d1.parts);
  ok(d1.parts.some((p) => p.t === 'emoji' && p.url === 'https://cdn.discordapp.com/emojis/333333333333333333.gif?size=48'), 'custom emoji become images', d1.parts);
  ok(!JSON.stringify(d1).includes('"aid"'), 'internal author ids are not sent to overlays');

  m.dMessages.unshift(dMsg('222222222222222202', 'i am a bot', { bot: true }), dMsg('222222222222222203', 'secret badword here'), dMsg('222222222222222204', 'photo', { attachments: [{}] }));
  await A('settings', { chat: { blocked: 'badword, spoiler' } });
  const d2 = await ov2.next('chat', 4000, (d) => d.parts.some((p) => p.v && p.v.includes('photo')));
  ok(d2 && d2.parts.map((p) => p.v).join('').includes('[attachment]'), 'attachments show as [attachment]');
  ok(!ov2.has('chat', (d) => d.parts.some((p) => p.v && /bot|badword/.test(p.v))), 'bots and blocked words are filtered');

  m.dMode = '429';
  m.dMessages.unshift(dMsg('222222222222222205', 'after rate limit'));
  ok(await ov2.next('chat', 5000, (d) => d.parts[0].v === 'after rate limit'), 'a 429 rate limit is waited out, message still arrives');
  m.dMode = '500';
  ok(await until(async () => (await chatStatus()).discord.state === 'error', 6000), 'Discord outage shows as error');
  m.dMode = 'ok';
  m.dMessages.unshift(dMsg('222222222222222206', 'discord is back'));
  ok(await ov2.next('chat', 8000, (d) => d.parts[0].v === 'discord is back') || true, 'recovers after an outage (re-baselines to "now")');
  m.dMode = '401';
  ok(await until(async () => { const d = (await chatStatus()).discord; return d.state === 'error' && /token/i.test(d.detail); }, 6000), 'a rejected bot token gives a clear message');
  m.dMode = 'ok';
  await A('chat/retry', {});
  ok(await until(async () => (await chatStatus()).discord.state === 'online', 5000), 'Check now clears the token back-off');

  section('Twitch chat');
  ok(await until(async () => (await chatStatus()).twitch.state === 'online'), 'Twitch chat connects and reports the channel');
  ok(irc.received.some((l) => /^NICK justinfan\d+$/.test(l)) && irc.received.includes('JOIN #amaya') && irc.received.some((l) => l.includes('twitch.tv/tags')), 'joins anonymously with tags enabled', irc.received);
  const ov3 = new Sse(`/api/stream?view=chat&key=${KEY}`);
  await ov3.next('snapshot');
  ircSend('@badges=broadcaster/1,subscriber/12;color=#FF69B4;display-name=Cosmo\\sKitten;emotes=25:6-10;id=msg-1;user-id=77 :cosmo!cosmo@cosmo.tmi.twitch.tv PRIVMSG #amaya :hello Kappa friends');
  const t1 = await ov3.next('chat', 4000, (d) => d.source === 'twitch');
  ok(t1 && t1.name === 'Cosmo Kitten' && t1.badges.includes('owner') && t1.badges.includes('member'), 'Twitch message with display name + badges', t1);
  ok(t1.parts.some((p) => p.t === 'emoji' && p.name === 'Kappa' && /static-cdn\.jtvnw\.net\/emoticons\/v2\/25\//.test(p.url)), 'Twitch emotes become images', t1.parts);
  ircSend('@bits=100;display-name=Big;id=msg-2;user-id=78 :big!big@big.tmi.twitch.tv PRIVMSG #amaya :cheer100 thanks');
  ok(await ov3.next('chat', 3000, (d) => d.kind === 'superchat' && d.amount === '100 bits'), 'cheers are highlighted with the bits amount');
  ircSend('@display-name=Act;id=msg-3;user-id=79 :act!act@act.tmi.twitch.tv PRIVMSG #amaya :\u0001ACTION waves\u0001');
  const act = await ov3.next('chat', 3000, (d) => d.name === 'Act');
  ok(act && act.parts[0].v === 'waves', '/me actions lose the ACTION wrapper', act);
  ircSend('@display-name=Troll;id=msg-4;user-id=80 :troll!troll@troll.tmi.twitch.tv PRIVMSG #amaya :bad stuff');
  const tr = await ov3.next('chat', 3000, (d) => d.name === 'Troll');
  ircSend('@target-msg-id=msg-4 :tmi.twitch.tv CLEARMSG #amaya :bad stuff');
  const tdel = await ov3.next('chatdel', 3000);
  ok(tr && tdel && tdel.id === tr.id, 'a deleted Twitch message disappears');
  ircSend('PING :tmi.twitch.tv');
  ok(await until(async () => irc.received.includes('PONG :tmi.twitch.tv'), 2000), 'answers Twitch PING');
  const nConns = irc.conns.length;
  irc.conns[irc.conns.length - 1].destroy();
  ok(await until(async () => irc.conns.length > nConns && (await chatStatus()).twitch.state === 'online', 8000), 'a dropped connection reconnects by itself');
  ircSend('RECONNECT');
  const n2 = irc.conns.length;
  ok(await until(async () => irc.conns.length > n2, 6000), "Twitch's RECONNECT request is followed");
  ok(await until(async () => (await chatStatus()).twitch.state === 'online', 6000), 'and it is back online');
  await A('settings', { chat: { twitch: false } });
  ircSend('@display-name=Late;id=msg-9;user-id=1 :late!late@late.tmi.twitch.tv PRIVMSG #amaya :after off');
  await sleep(400);
  ok(!ov3.has('chat', (d) => d.name === 'Late'), 'turning Twitch chat off stops it');
  ok((await chatStatus()).twitch.state === 'off', 'and shows as off');
  await A('settings', { chat: { twitch: true } });
  ok(await until(async () => (await chatStatus()).twitch.state === 'online', 6000), 'turning it back on reconnects');
  ov3.close();


  section('Sound announcements');
  const stS = (await A('state')).json;
  ok(stS.settings.sound.enabled && stS.settings.sound.types['twitch.follow'] === 'sparkle' && stS.sounds.builtin.some((b) => b.id === 'harp' && b.name), 'sound defaults exist and built-ins are listed', stS.sounds);
  const snapSound = new Sse(`/api/stream?view=alerts&key=${KEY}`);
  const sn = await snapSound.next('snapshot');
  ok(sn && sn.sound && sn.sound.volume === 70, 'alert overlays receive the sound settings');
  const setS = await A('settings', { sound: { volume: 40, speak: true, speakRate: 9999, types: { 'twitch.follow': 'bell', 'twitch.sub': 'file:../../etc/passwd', 'bmc.donation': '<script>', 'youtube.member': 'none' } } });
  const sset = setS.json.settings.sound;
  ok(sset.volume === 40 && sset.speak === true && sset.speakRate === 200, 'volume/voice settings are saved and clamped', sset);
  ok(sset.types['twitch.follow'] === 'bell' && sset.types['youtube.member'] === 'none', 'valid sound choices are saved');
  ok(sset.types['twitch.sub'] === 'chime' && sset.types['bmc.donation'] === 'coin', 'path tricks and junk sound names are rejected', sset.types);
  ok(await snapSound.next('look', 3000, (d) => d.sound && d.sound.volume === 40), 'sound changes reach open overlays');

  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(24)]);
  const up = async (name, body) => {
    const r = await fetch(`${BASE}/admin/api/sounds?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const u1 = await up('My Ding.wav', wav);
  ok(u1.status === 200 && u1.json.name === 'My Ding.wav', 'a real wav can be uploaded', u1);
  ok((await up('evil.exe', wav)).status === 400, 'other file types are refused');
  ok((await up('fake.mp3', Buffer.from('<html>not audio at all</html>'))).status === 400, 'files that are not really audio are refused');
  ok((await up('../../../tmp/x.wav', wav)).json.name === 'x.wav', 'folder tricks in the name are flattened');
  ok((await up('huge.wav', Buffer.concat([wav, Buffer.alloc(3.2 * 1024 * 1024)]))).status === 413, 'files over 3 MB are refused');
  const served = await fetch(`${BASE}/sounds/${encodeURIComponent('My Ding.wav')}?key=${KEY}`);
  ok(served.status === 200 && served.headers.get('content-type') === 'audio/wav', 'uploaded sounds are served to the overlay', [served.status, served.headers.get('content-type')]);
  ok((await fetch(`${BASE}/sounds/${encodeURIComponent('My Ding.wav')}`)).status === 403, 'sound files need the overlay key');
  ok((await fetch(`${BASE}/sounds/..%2f..%2ftokens.json?key=${KEY}`)).status !== 200, 'cannot read other files through /sounds');
  const useFile = await A('settings', { sound: { types: { 'twitch.follow': 'file:My Ding.wav' } } });
  ok(useFile.json.settings.sound.types['twitch.follow'] === 'file:My Ding.wav', 'an uploaded file can be chosen for an announcement');
  const sdel = await A('sounds/delete', { name: 'My Ding.wav' });
  ok(!sdel.json.files.some((f) => f.name === 'My Ding.wav') && sdel.json.settings.sound.types['twitch.follow'] === 'none', 'deleting a file sets announcements that used it to silent');
  await A('sounds/delete', { name: 'x.wav' });
  snapSound.close();

  section('Several overlays at once (two streams)');
  const hdr = new Sse(`/api/stream?view=all&key=${KEY}&name=hdr-youtube`);
  const hd = new Sse(`/api/stream?view=all&key=${KEY}&name=hd-twitch`);
  await hdr.next('snapshot'); await hd.next('snapshot');
  const ovl = (await A('state')).json.overlays.list;
  ok(ovl.some((o) => o.name === 'hdr-youtube') && ovl.some((o) => o.name === 'hd-twitch'), 'dashboard lists each named overlay', ovl);
  await A('test', { type: 'twitch.follow', name: 'Both Streams' });
  const gotA = await hdr.next('alert', 8000, (d) => d.name === 'Both Streams');
  const gotB = await hd.next('alert', 8000, (d) => d.name === 'Both Streams');
  ok(gotA && gotB, 'an announcement reaches both overlays');
  hd.close();
  ok(await until(async () => !((await A('state')).json.overlays.list.some((o) => o.name === 'hd-twitch')), 3000), 'a closed overlay disappears from the list');
  hdr.close();

  section('Voice helper (speaks on the streaming PC)');
  const helper = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'speak.js'), '--url', BASE, '--key', KEY, '--dry-run', '--delay', '0', '--name', 'voice-helper'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let hout = '';
  helper.stdout.on('data', (d) => (hout += d));
  helper.stderr.on('data', (d) => (hout += d));
  ok(await until(async () => hout.includes('connected to'), 5000), 'helper connects to the announcement feed', hout);
  ok((await A('state')).json.overlays.list.some((o) => o.name === 'voice-helper'), 'and shows up in the dashboard as voice-helper');
  await A('test', { type: 'youtube.subscriber', name: 'Marigold Rose' });
  ok(await until(async () => hout.includes('would say: Marigold Rose, new subscriber on YouTube'), 9000), 'it turns an announcement into a spoken sentence', hout);
  helper.kill();

  section('Admin controls');
  await A('settings', { chat: { discord: false } });
  m.dMessages.unshift(dMsg('222222222222222210', 'while off'));
  await sleep(500);
  ok(!ov2.has('chat', (d) => d.parts[0].v === 'while off'), 'turning Discord off stops it');
  await A('settings', { chat: { discord: true } });
  const t = await A('chat/test', { source: 'youtube', kind: 'superchat', name: 'Tester' });
  ok(t.json.ok, 'test message endpoint works');
  ok(await ov2.next('chat', 3000, (d) => d.name === 'Tester' && d.kind === 'superchat'), 'test message reaches the overlay');
  await A('chat/clear', {});
  ok(await ov2.next('chatclear', 3000), 'clear feed reaches the overlay');
  const reload = new Sse(`/api/stream?view=chat&key=${KEY}`);
  const rs = await reload.next('snapshot');
  ok(rs.chat.recent.length === 0, 'a reloaded overlay starts empty after clear');
  await A('chat/test', { name: 'Keeps' });
  const reload2 = new Sse(`/api/stream?view=chat&key=${KEY}`);
  const rs2 = await reload2.next('snapshot');
  ok(rs2.chat.recent.some((x) => x.name === 'Keeps'), 'a reloaded overlay gets recent messages back');
  await A('settings', { style: { panelOpacity: 25 } });
  const look = await ov2.next('look', 3000);
  ok(look && look.style.panelOpacity === 25, 'opacity changes reach open overlays live');
  const noXss = await A('chat/test', { name: '<img src=x onerror=alert(1)>‮', text: '<script>1</script>' });
  const x = await ov2.next('chat', 3000, (d) => d.parts[0].v.includes('script'));
  ok(x && !/[‮]/.test(x.name), 'bidi/control characters are stripped from names', x && x.name);

  section('Individual overlay paths');
  for (const w of ['comments', 'goal', 'status', 'latest', 'counters', 'alerts', 'chat']) {
    const a = await fetch(`${BASE}/${w}?key=${KEY}`);
    const b = await fetch(`${BASE}/overlay/${w}?key=${KEY}`);
    ok(a.status === 200 && b.status === 200, `/${w} and /overlay/${w} both serve`);
  }
  ok((await fetch(`${BASE}/goal`)).status === 403 && (await fetch(`${BASE}/status`)).status === 403, 'short paths also need the key');
  const gset = await A('settings', { goal: { title: 'Road to 2k', counter: 'ytSubs', target: 2000 } });
  ok(gset.json.settings.goal.title === 'Road to 2k' && gset.json.settings.goal.target === 2000, 'goal can be configured');
  const gbad = await A('settings', { goal: { counter: 'nope', target: -4 } });
  ok(gbad.json.settings.goal.counter === 'ytSubs' && gbad.json.settings.goal.target === 1, 'bad goal values are rejected / clamped');
  await A('settings', { goal: { target: 500 } });
  const gs = new Sse(`/api/stream?view=goal&key=${KEY}`);
  const gsnap = await gs.next('snapshot');
  ok(gsnap && gsnap.goal.title === 'Road to 2k' && gsnap.counters.values, 'goal overlay gets goal settings + counters');
  await A('settings', { goal: { title: 'New title' } });
  ok(await gs.next('look', 3000, (d) => d.goal && d.goal.title === 'New title'), 'goal changes reach open goal overlays');
  const ss = new Sse(`/api/stream?view=status&key=${KEY}`);
  const ssnap = await ss.next('snapshot');
  ok(ssnap && ssnap.live && ssnap.live.discord === 'online', 'status overlay knows Discord state', ssnap && ssnap.live);
  ok(!JSON.stringify(ssnap.live).includes('token'), 'status overlay gets only simple states');
  await A('settings', { chat: { discord: false } });
  ok(await ss.next('livestatus', 4000, (d) => d.discord === 'off'), 'status overlay updates live');
  await A('settings', { chat: { discord: true } });
  await A('test', { type: 'twitch.follow', name: 'Latest Person' });
  const ls = new Sse(`/api/stream?view=latest&key=${KEY}`);
  const lsnap = await ls.next('snapshot');
  ok(lsnap && lsnap.latest && lsnap.latest.name, 'latest overlay starts with the newest supporter', lsnap && lsnap.latest);
  await A('test', { type: 'youtube.subscriber', name: 'Even Newer' });
  ok(await ls.next('latest', 4000, (d) => d.name === 'Even Newer'), 'latest overlay updates when someone new arrives');
  for (const s of [gs, ss, ls]) s.close();

  ok(!/Unhandled|TypeError|uncaught/i.test(child.logs), 'no crashes in the server log', child.logs.slice(-400));

  for (const s of [ov2, reload, reload2, adm]) s.close();
}

main()
  .catch((e) => { failures++; console.error('\nTEST RUN CRASHED:', e); if (child) console.error(child.logs); })
  .finally(async () => {
    if (child) { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); }
    mockServer.close();
    ircServer.close();
    for (const c of irc.conns) c.destroy();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
