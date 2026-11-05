'use strict';

// The overlay and the Discord bot in one process.
//   node test/bot-bridge.js
// Part 1 uses a fake bot, because there is no real Discord here. Part 2 boots the real server with the real bot code and a
// bot that cannot start, and checks that the overlay keeps working and tells Buy Me a Coffee to retry.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createBotBridge } = require('../src/botbridge');

const PORT = 42097;
const logs = [];
const log = (m) => logs.push(m);
const pass = (m) => console.log(`  ✓ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridgeTests() {
  console.log('Bridge');
  let loaded = 0;
  const off = createBotBridge({ enabled: false, load: () => { loaded += 1; }, log });
  off.start();
  await off.bmcEvent({ type: 'membership.started' });
  await off.stop();
  assert.strictEqual(loaded, 0);
  pass('switched off: the bot code is never loaded, and events pass through harmlessly');

  const events = [];
  let stopped = 0;
  let opts;
  let release;
  const on = createBotBridge({
    enabled: true,
    log,
    load: async () => ({
      startBot: async (o) => {
        opts = o;
        await new Promise((r) => { release = r; });
        return { applyBmcEvent: async (b) => events.push(b), stop: async () => { stopped += 1; } };
      },
    }),
  });
  on.start();
  on.start();
  await sleep(10);
  assert.deepStrictEqual(opts, { webhook: false, handleSignals: false });
  pass('the bot opens no port of its own and leaves shutdown to the app');
  const early = on.bmcEvent({ id: 1 });
  release();
  await early;
  assert.deepStrictEqual(events, [{ id: 1 }]);
  pass('an event during startup waits for the bot');
  await on.stop();
  await on.stop();
  assert.strictEqual(stopped, 1);
  pass('stops once');

  const broken = createBotBridge({ enabled: true, log, load: async () => ({ startBot: async () => { throw new Error('bad token'); } }) });
  broken.start();
  await assert.rejects(broken.bmcEvent({}), /bad token/);
  assert.strictEqual(broken.status().problem, 'bad token');
  pass('a bot that failed to start refuses events, so the sender retries');

  const stuck = createBotBridge({ enabled: true, log, startWaitMs: 20, load: () => new Promise(() => {}) });
  stuck.start();
  await assert.rejects(stuck.bmcEvent({}), /still starting/);
  pass('a bot stuck connecting cannot hold a webhook open forever');
}

const request = (method, url, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request(`http://127.0.0.1:${PORT}${url}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    r.on('error', reject);
    r.end(body);
  });

async function serverTests() {
  console.log('\nThe real app, with a bot that cannot start');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-bridge-'));
  const secret = 'bridge-secret';
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir, DB_PATH: path.join(dir, 'bot.db'), ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'x'.repeat(48), BMC_WEBHOOK_SECRET: secret, BMC_WEBHOOK_TOKEN: '', SNITCH_BOT_TOKEN: 'not-a-real-token', DISCORD_GUILD_ID: '', DISCORD_BOT_TOKEN: '' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  try {
    for (let i = 0; i < 60 && !/\[bot\] not started/.test(out); i++) await sleep(250);
    assert.match(out, /\[bot\] not started, the overlay keeps running: .*DISCORD_GUILD_ID/);
    pass('the real bot code loads, and its problem is logged in plain words');
    assert.strictEqual((await request('GET', '/healthz')).status, 200);
    pass('the overlay is still up');

    const raw = JSON.stringify({ type: 'donation.created', live_mode: true, data: { id: 'b1', supporter_name: 'Ravi', amount: 3, currency: 'USD', coffee_count: 1 } });
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const post = () => request('POST', '/webhooks/bmc', raw, { 'content-type': 'application/json', 'x-signature-sha256': sig });
    assert.strictEqual((await post()).status, 503);
    pass('Buy Me a Coffee is told to retry while the bot is down');
    assert.strictEqual((await post()).status, 503);
    await sleep(600);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(state.recent.filter((r) => r.name === 'Ravi').length, 1);
    assert.strictEqual(state.counters.bmcCoffees, 1);
    pass('the retry is not announced or counted a second time on the overlay');
    assert.strictEqual((await request('POST', '/webhooks/bmc', raw, { 'content-type': 'application/json', 'x-signature-sha256': 'wrong' })).status, 401);
    pass('a bad signature is still refused');
  } finally {
    const gone = new Promise((r) => child.on('exit', r));
    child.kill('SIGTERM');
    await gone;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await bridgeTests();
  await serverTests();
  console.log('\nall passed');
})().catch((e) => {
  console.error(`\n  ✗ ${e.message}`);
  process.exit(1);
});
