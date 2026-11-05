// Amaya's rule: people who are not verified must not be able to see current members.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { TEMPLATE_FILE } from '../../src/bot/config.mjs';
import { buildCommands } from '../../src/bot/commands.mjs';
import { buildIds, checkGate, overwritesFor, planChannels, planRoles } from '../../src/bot/setup-plan.mjs';
import { scrubText, mirrorPayload } from '../../src/bot/mirror.mjs';

const template = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
const tiers = ['Spark', 'Ember', 'Forgehand', 'Netrunner', 'Magenta Core'].map((name, i) => ({ n: i + 1, name, slug: name.toLowerCase().replace(' ', '-'), rank: i + 1, bmcLevelIds: [] }));
const roles = planRoles(template, tiers, { touristName: 'Visitor' });
const roleIds = { '@everyone': 'EVERYONE' };
for (const r of roles) roleIds[r.key] = `role-${r.key}`;
const channels = planChannels(template, { roleIds, tiers });

/** The Discord permission calculation for one channel. roleKeys excludes @everyone, which everyone has. */
function can(channel, roleKeys, bit) {
  const base = roles.filter((r) => roleKeys.includes(r.key)).some((r) => r.permissions.includes(bit)); // @everyone has nothing server-wide
  let allowed = base;
  const ev = channel.overwrites.find((o) => o.id === 'EVERYONE');
  if (ev?.deny.includes(bit)) allowed = false;
  if (ev?.allow.includes(bit)) allowed = true;
  const mine = channel.overwrites.filter((o) => roleKeys.some((k) => roleIds[k] === o.id));
  if (mine.some((o) => o.deny.includes(bit))) allowed = false;
  if (mine.some((o) => o.allow.includes(bit))) allowed = true;
  return allowed;
}
const seenBy = (roleKeys) => channels.filter((c) => can(c, roleKeys, P.ViewChannel)).map((c) => c.name);

test('the template passes the gate check', () => assert.deepEqual(checkGate(channels, roleIds), []));

test('someone not verified sees only the gate', () => {
  assert.deepEqual(seenBy([]).sort(), ['gate-announcements', 'gate-rules', 'verification-help', '🚪 THE GATE'].sort());
});

test('they can post nowhere', () => {
  for (const c of channels) if (can(c, [], P.ViewChannel)) assert.equal(can(c, [], P.SendMessages), false, c.name);
});

test('nobody verified shares a channel with them', () => {
  const kinds = [['verified'], ['verified', 'tourist'], ['verified', 'founder'], ['verified', 'warden'], ['verified', 'representative'], ['verified', 'access:5'], ['verified', 'elder'], ['verified', 'grandElder'], ['verified', 'commissioner'], ['ambience']];
  const gate = channels.filter((c) => c.access === 'gate');
  for (const who of kinds) for (const c of gate) assert.equal(can(c, who, P.ViewChannel), false, `${who} sees ${c.name}`);
});

test('no staff role has Administrator, which would ignore the gate', () => {
  for (const r of roles) assert.ok(!r.permissions.includes(P.Administrator), r.name);
});

test('no role is shown separately in the member list', () => {
  for (const r of roles) assert.equal(r.hoist, false, r.name);
});

test('verified members see all of Amaya\'s channels and can talk in the right ones', () => {
  const seen = seenBy(['verified']);
  for (const name of ['rules', 'announcements', 'the-forge-general', 'vice-city-grind', 'night-city-chat', 'maker-workbench', 'stream-live', 'The Lounge', 'Co-op Gaming']) assert.ok(seen.includes(name), name);
  const by = (n) => channels.find((c) => c.name === n);
  assert.equal(can(by('rules'), ['verified'], P.SendMessages), false);
  assert.equal(can(by('the-forge-general'), ['verified'], P.SendMessages), true);
  assert.equal(can(by('The Lounge'), ['verified'], P.Connect), true);
  assert.equal(can(by('rules'), ['verified', 'warden'], P.SendMessages), true);
});

test('verification-help is only for people still at the gate', () => {
  assert.equal(seenBy(['verified']).includes('verification-help'), false);
});

test('supporter lounges open from a tier upward, and not for lower tiers', () => {
  const by = (n) => channels.find((c) => c.name === n);
  assert.equal(can(by('backstage'), ['verified', 'access:1'], P.ViewChannel), true);
  assert.equal(can(by('forgehand-bench'), ['verified', 'access:2'], P.ViewChannel), false);
  assert.equal(can(by('forgehand-bench'), ['verified', 'access:3'], P.ViewChannel), true);
  assert.equal(can(by('forgehand-bench'), ['verified', 'access:5'], P.ViewChannel), true);
  assert.equal(can(by('magenta-core'), ['verified', 'access:4'], P.ViewChannel), false);
  assert.equal(can(by('magenta-core'), ['verified'], P.ViewChannel), false);
});

test('the Elder Hall opens for Forge Elders and Grand Elders', () => {
  const hall = channels.find((c) => c.name === 'elder-hall');
  assert.equal(can(hall, ['verified', 'elder'], P.ViewChannel), true);
  assert.equal(can(hall, ['verified', 'grandElder'], P.ViewChannel), true);
  assert.equal(can(hall, ['verified'], P.ViewChannel), false);
});

test('helper bots can join every ambience room', () => {
  const rooms = channels.filter((c) => c.ambience || ['The Lounge', 'Build Room'].includes(c.name));
  assert.ok(rooms.length >= 6);
  for (const c of rooms) {
    assert.equal(can(c, ['ambience'], P.Connect), true, c.name);
    assert.equal(can(c, ['ambience'], P.Speak), true, c.name);
  }
});

test('a gate-open category can never be mistaken for a member one', () => {
  assert.throws(() => overwritesFor('nonsense', {}, { roleIds, tiers }));
});

test('any slash command with a member search needs a permission only verified members have', () => {
  const ids = buildIds({ guildId: 'G', roleIds, channelIds: Object.fromEntries(channels.map((c) => [c.key, `ch-${c.key}`])), template, tiers });
  const cmds = buildCommands({ ...ids, tiers });
  const hasUserOption = (o) => o.type === 6 || (o.options ?? []).some(hasUserOption);
  for (const c of cmds) {
    if (hasUserOption(c)) assert.ok(c.default_member_permissions && BigInt(c.default_member_permissions) !== 0n, c.name);
  }
  for (const name of ['intro', 'link', 'membership', 'forget-me', 'ticket']) assert.equal(cmds.find((c) => c.name === name).default_member_permissions ?? null, null, name);
});

test('gate copies carry nobody\'s name', () => {
  assert.equal(scrubText('hi <@123456789012345678> and <@!123456789012345678> <@&99> @everyone'), 'hi and ');
  const p = mirrorPayload({ content: 'Rules by <@123>', embeds: [{ title: 'Rules', description: 'by <@123>', author: { name: 'someone' }, footer: { text: 'someone' } }], attachments: [] });
  assert.equal(p.embeds[0].author, undefined);
  assert.equal(p.embeds[0].footer, undefined);
  assert.ok(!JSON.stringify(p).includes('<@'));
  assert.deepEqual(p.allowedMentions, { parse: [] });
});

test('buildIds maps the mirror and Grand Elder correctly', () => {
  const ids = buildIds({ guildId: 'G', roleIds, channelIds: Object.fromEntries(channels.map((c) => [c.key, `ch-${c.key}`])), template, tiers });
  assert.equal(ids.mirrors['ch-rules'], 'ch-gateRules');
  assert.equal(ids.mirrors['ch-announcements'], 'ch-gateAnnouncements');
  assert.ok(ids.elder.creatorRoleIds.includes(roleIds.grandElder));
  assert.equal(ids.hobbies.find((h) => h.slug === 'esports').requires, 'gaming');
  assert.equal(ids.league.teams.length, 4);
});
