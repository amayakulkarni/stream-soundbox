// Amaya's fixes of 2026-11-07: the branded link email, Grand Elder access and its owner-only rule, and #bot-spam.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { TEMPLATE_FILE } from '../../src/bot/config.mjs';
import { linkCodeEmail } from '../../src/bot/email.mjs';
import { judgeGrandElderChange } from '../../src/bot/grand-elder.mjs';
import { checkGate, planChannels, planRoles } from '../../src/bot/setup-plan.mjs';

const template = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
const tiers = ['Spark', 'Ember', 'Forgehand', 'Netrunner', 'Magenta Core'].map((name, i) => ({ n: i + 1, name, slug: name.toLowerCase().replace(' ', '-'), rank: i + 1, bmcLevelIds: [] }));
const roles = planRoles(template, tiers, { touristName: 'Visitor' });
const roleIds = { '@everyone': 'EVERYONE' };
for (const r of roles) roleIds[r.key] = `role-${r.key}`;
const channels = planChannels(template, { roleIds, tiers });
const sees = (c, keys) => {
  const ev = c.overwrites.find((o) => o.id === 'EVERYONE');
  let ok = roles.filter((r) => keys.includes(r.key)).some((r) => r.permissions.includes(P.ViewChannel));
  if (ev?.deny.includes(P.ViewChannel)) ok = false;
  if (ev?.allow.includes(P.ViewChannel)) ok = true;
  const mine = c.overwrites.filter((o) => keys.some((k) => roleIds[k] === o.id));
  if (mine.some((o) => o.deny.includes(P.ViewChannel))) ok = false;
  if (mine.some((o) => o.allow.includes(P.ViewChannel))) ok = true;
  return ok;
};

test('Grand Elder sees every paid channel without holding any tier', () => {
  const paid = channels.filter((c) => c.access.startsWith('tier:'));
  assert.ok(paid.length >= 6);
  for (const c of paid) assert.equal(sees(c, ['verified', 'grandElder']), true, c.name);
  for (const c of paid) assert.equal(sees(c, ['verified']), false, c.name);
  assert.equal(sees(channels.find((c) => c.name === 'elder-hall'), ['verified', 'grandElder']), true);
});

test('Grand Elder is the top role, so staff cannot give or take it', () => {
  assert.equal(roles[0].key, 'grandElder');
  assert.ok(roles.findIndex((r) => r.key === 'founder') > 0);
});

test('only the owner\'s change to Grand Elder stands', () => {
  assert.equal(judgeGrandElderChange({ executorId: 'owner', ownerId: 'owner', botId: 'bot' }), 'allow');
  assert.equal(judgeGrandElderChange({ executorId: 'bot', ownerId: 'owner', botId: 'bot' }), 'allow');
  assert.equal(judgeGrandElderChange({ executorId: 'warden', ownerId: 'owner', botId: 'bot' }), 'revert');
  assert.equal(judgeGrandElderChange({ executorId: null, ownerId: 'owner', botId: 'bot' }), 'unknown');
});

test('#bot-spam is open to every verified member and closed at the gate', () => {
  const c = channels.find((x) => x.name === 'bot-spam');
  assert.ok(c);
  assert.equal(sees(c, ['verified']), true);
  assert.equal(sees(c, []), false);
  assert.deepEqual(checkGate(channels, roleIds), []);
});

test('the link email is branded, escapes input and keeps a plain-text copy', () => {
  const m = linkCodeEmail({ code: '123456', brandColor: '#ff267c', links: { twitchUrl: 'https://twitch.tv/amaya.kulkarni', bmcUrl: 'https://buymeacoffee.com/amayakulkarni?a=1&b=<x>' } });
  assert.match(m.subject, /123456/);
  assert.match(m.html, /#ff267c/);
  assert.match(m.html, /MAGENTA FORGE/);
  assert.match(m.html, /\/link code:123456/);
  assert.ok(m.html.includes('a=1&amp;b=&lt;x&gt;'));
  assert.match(m.text, /\/link code:123456/);
  assert.match(linkCodeEmail({ code: '1', brandColor: 'red;}<script>' }).html, /#ff267c/);
});

test('members may use the soundboard and Activities in every voice room they can join', () => {
  const verified = roles.find((r) => r.key === 'verified');
  for (const bit of [P.UseSoundboard, P.UseExternalSounds, P.UseEmbeddedActivities, P.UseExternalApps]) assert.ok(verified.permissions.includes(bit));
  for (const c of channels.filter((x) => x.kind === 'voice' && x.access === 'verified')) {
    const o = c.overwrites.find((x) => x.id === roleIds.verified);
    assert.ok(o.allow.includes(P.UseSoundboard) && o.allow.includes(P.UseEmbeddedActivities), c.name);
  }
  for (const c of channels.filter((x) => x.kind === 'text')) for (const o of c.overwrites) assert.ok(!o.allow.includes(P.UseSoundboard), `${c.name} gets no voice-only bit`);
});
