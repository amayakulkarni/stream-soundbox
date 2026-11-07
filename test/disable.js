'use strict';

// DISABLE_YOUTUBE_MEMBERS / DISABLE_TWITCH_SUBS: counters and announcements disappear.
//   node test/disable.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 42097;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'supporters-disable-'));
let fails = 0;
const ok = (c, m, x) => { console.log(`  ${c ? '✓' : '✗'} ${m}${!c && x !== undefined ? `  → ${JSON.stringify(x)}` : ''}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(flags) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, SNITCH_BOT_TOKEN: '', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'x'.repeat(48), ...flags },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const login = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=pw' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const A = async (p, body) => (await fetch(`${BASE}/admin/api/${p}`, { method: body ? 'POST' : 'GET', headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
  const out = { state: await A('state') };
  await A('test', { type: 'twitch.sub', name: 'Hidden Sub' });
  await A('test', { type: 'youtube.member', name: 'Hidden Member' });
  await A('test', { type: 'twitch.follow', name: 'Visible Follower' });
  out.after = await A('state');
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  return out;
}

(async () => {
  console.log('\nBoth disabled');
  let r = await run({ DISABLE_YOUTUBE_MEMBERS: 'true', DISABLE_TWITCH_SUBS: '1' });
  ok(!r.state.counterKeys.includes('ytMembers') && !r.state.counterKeys.includes('twSubs'), 'member and sub counters are gone from the dashboard', r.state.counterKeys);
  ok(r.state.counters.snapshot.show.ytMembers === false && r.state.counters.snapshot.show.twSubs === false, 'overlay is told to hide them');
  ok(!r.state.types['youtube.member'] && !r.state.types['twitch.sub'] && !r.state.types['twitch.gift'] && r.state.types['twitch.follow'], 'those announcement types are gone, others stay');
  const names = r.after.queue.items.map((i) => i.name);
  ok(names.includes('Visible Follower') && !names.includes('Hidden Sub') && !names.includes('Hidden Member'), 'disabled announcements are never queued', names);

  console.log('\nNothing disabled');
  r = await run({});
  ok(r.state.counterKeys.includes('ytMembers') && r.state.counterKeys.includes('twSubs') && r.state.types['twitch.sub'], 'everything is on by default');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
