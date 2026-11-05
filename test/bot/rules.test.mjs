// The membership, intro, ticket, league, Pomodoro and ambience rules, against an in-memory database and fake Discord sides.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createAmbience, loadAmbienceConfig, matchRooms, normalizeName } from '../../src/bot/ambience.mjs';
import { reconcileWithBmc } from '../../src/bot/bmc-api.mjs';
import { createActivity } from '../../src/bot/activity.mjs';
import { applyEvent, parseEvent, verifySignature, toIso } from '../../src/bot/bmc.mjs';
import { elderProgress, entitlement, isElder, roleDiff, tierForLevel, wantedRoles } from '../../src/bot/core.mjs';
import { createElderRooms } from '../../src/bot/elder-rooms.mjs';
import { applyPick } from '../../src/bot/hobbies.mjs';
import { checkIntro, createIntro, parseIntro, INTRO_TEMPLATE } from '../../src/bot/intro.mjs';
import { createLeague, parseWhen, scoreMatch, standings } from '../../src/bot/league.mjs';
import { createLink } from '../../src/bot/link.mjs';
import { createMirror } from '../../src/bot/mirror.mjs';
import { createPomodoro } from '../../src/bot/pomodoro.mjs';
import { openStore } from '../../src/bot/store.mjs';
import { createSync } from '../../src/bot/sync.mjs';
import { createTickets } from '../../src/bot/tickets.mjs';
import { todoCommand } from '../../src/bot/todos.mjs';
import { createUnlink } from '../../src/bot/unlink.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 5);
const tiers = ['Spark', 'Ember', 'Forgehand', 'Netrunner', 'Magenta Core'].map((name, i) => ({ n: i + 1, name, slug: name.toLowerCase().replace(' ', '-'), rank: i + 1, roleId: `r${i + 1}`, accessRoleId: `a${i + 1}`, bmcLevelIds: i === 3 ? ['777'] : [] }));
const cfg = {
  guildId: 'G', tiers, unknownLevelTier: 'spark', staffRoleIds: ['founder', 'rep', 'warden'],
  grace: { lapseDays: 7, remindDaysBeforeEnd: [3], remindDuringGrace: [0, 5] },
  channels: { botLog: 'bot', modLog: 'mod', thankYou: 'wall', ticketCategory: 'tc', ticketTranscripts: 'tt', introCategory: 'ic' },
  roles: { verified: 'verified', grandElder: 'grand' },
  tourist: { roleId: 'visitor', name: 'Visitor' },
  elder: { roleId: 'elder', grandElderRoleId: 'grand', afterDays: 90, activeDaysRequired: 30, activityWindowDays: 90, creatorRoleIds: ['warden'], lobbyChannelId: 'lobby', maxRoomsPerElder: 1 },
  league: { commissionerRoleId: 'comm', teams: [{ key: 'hammer', name: 'Hammer', roleId: 'th' }, { key: 'tongs', name: 'Tongs', roleId: 'tt2' }, { key: 'bellows', name: 'Bellows', roleId: 'tb' }, { key: 'rust', name: 'Rust', roleId: 'tr' }], games: [{ slug: 'gta-6', label: 'GTA 6' }], channels: { fixtures: 'f', scoreboard: 's', office: 'o', matchReports: 'm' } },
  hobbies: [{ slug: 'gaming', label: 'Co-op', roleId: 'hg' }, { slug: 'esports', label: 'League', roleId: 'he', requires: 'gaming' }],
};

function fakeDiscord(roles = new Map()) {
  const dms = [];
  const posts = [];
  return {
    dms, posts, roles,
    fetchMember: async (id) => (roles.has(id) ? { roles: roles.get(id) } : null),
    addRole: async (id, r) => roles.get(id).add(r),
    removeRole: async (id, r) => roles.get(id).delete(r),
    dm: async (id, text) => (dms.push({ id, text }), true),
    post: async (ch, text) => posts.push({ ch, text }),
  };
}
const setup = (ids = ['u1']) => {
  const store = openStore(':memory:');
  const discord = fakeDiscord(new Map(ids.map((i) => [i, new Set()])));
  let at = T0;
  const sync = createSync({ cfg, store, discord, env: { renewUrl: 'https://buymeacoffee.com/amayakulkarni/membership' }, now: () => at });
  return { store, discord, sync, setNow: (t) => (at = t), now: () => at };
};
const member = { subscriptionId: 's1', email: 'a@b.co', levelName: 'Ember', status: 'active', paidUntil: new Date(T0 + 30 * DAY).toISOString() };
const ended = { ...member, status: 'cancelling', paidUntil: new Date(T0 + 10 * DAY).toISOString() };

test('a level is matched by ID, then name, then falls back to the lowest tier', () => {
  assert.equal(tierForLevel(cfg, '777', 'whatever').tier.slug, 'netrunner');
  assert.equal(tierForLevel(cfg, null, 'magenta core').tier.slug, 'magenta-core');
  const unknown = tierForLevel(cfg, '1', 'Mystery');
  assert.equal(unknown.tier.slug, 'spark');
  assert.equal(unknown.known, false);
});

test('active never ends by date; cancelled → grace → none', () => {
  const m = { level_name: 'Ember', status: 'active', paid_until: new Date(T0 + 10 * DAY).toISOString() };
  assert.equal(entitlement(cfg, { memberships: [m] }, T0 + 400 * DAY).state, 'active', 'it renews until the hourly check says otherwise');
  const c = { ...m, status: 'cancelling' };
  assert.equal(entitlement(cfg, { memberships: [c] }, T0).endsAt, T0 + 10 * DAY);
  assert.equal(entitlement(cfg, { memberships: [c] }, T0 + 12 * DAY).state, 'grace');
  assert.equal(entitlement(cfg, { memberships: [c] }, T0 + 18 * DAY).state, 'none');
  assert.equal(entitlement(cfg, { memberships: [{ ...m, status: 'paused' }] }, T0 + 12 * DAY).state, 'grace');
  assert.equal(entitlement(cfg, { memberships: [{ ...m, status: 'lapsed', ended_at: new Date(T0).toISOString() }] }, T0 + 3 * DAY).state, 'grace');
  assert.equal(entitlement(cfg, { memberships: [{ ...m, status: 'revoked' }] }, T0).state, 'none');
  // A complimentary grant also gets the grace period.
  assert.equal(entitlement(cfg, { grants: [{ tier: 'ember', expires_at: new Date(T0).toISOString() }] }, T0 + DAY).state, 'grace');
});

test('the highest tier wins, and a grant counts', () => {
  const low = { level_name: 'Spark', status: 'active' };
  const high = { level_name: 'Netrunner', status: 'active' };
  assert.equal(entitlement(cfg, { memberships: [low, high] }, T0).tier.slug, 'netrunner');
  assert.equal(entitlement(cfg, { memberships: [low], grants: [{ tier: 'magenta-core', expires_at: new Date(T0 + DAY).toISOString() }] }, T0).tier.slug, 'magenta-core');
});

test('roles: tier, discreet and the verified role', () => {
  const t = tiers[1];
  assert.deepEqual([...wantedRoles(cfg, t)].sort(), ['a1', 'a2', 'r2', 'verified'].sort(), 'the lounges of this tier and every cheaper one');
  assert.deepEqual([...wantedRoles(cfg, t, { discreet: true })].sort(), ['a1', 'a2', 'verified'].sort());
  assert.deepEqual([...wantedRoles(cfg, null)], []);
  assert.deepEqual([...wantedRoles(cfg, null, { tourist: true })].sort(), ['verified', 'visitor'].sort());
  assert.deepEqual([...wantedRoles(cfg, null, { staff: true })], ['verified']);
  const diff = roleDiff(cfg, new Set(['visitor', 'other', 'r3', 'grand']), new Set(['r2']));
  assert.deepEqual(diff.remove.sort(), ['r3', 'visitor'], 'a tier replaces the free role; unmanaged roles and Grand Elder stay');
});

test('the bot never gives or removes Grand Elder', () => {
  const diff = roleDiff(cfg, new Set(['grand']), wantedRoles(cfg, null, {}));
  assert.deepEqual(diff, { add: [], remove: [] });
  assert.ok(![...wantedRoles(cfg, tiers[4], { elder: true, tourist: true, staff: true })].includes('grand'));
});

test('Elder needs days, activity, no timeouts and a confirmed email', () => {
  const since = new Date(T0).toISOString();
  const ent = { state: 'none' };
  const m = { tourist_since: since, email: 'a@b.co' };
  assert.equal(isElder(cfg, m, ent, T0 + 89 * DAY, { activeDays: 40, moderated: false }), false);
  assert.equal(isElder(cfg, m, ent, T0 + 91 * DAY, { activeDays: 29, moderated: false }), false);
  assert.equal(isElder(cfg, m, ent, T0 + 91 * DAY, { activeDays: 30, moderated: true }), false);
  assert.equal(isElder(cfg, m, ent, T0 + 91 * DAY, { activeDays: 30, moderated: false }), true);
  assert.equal(isElder(cfg, { tourist_since: since }, ent, T0 + 91 * DAY, { activeDays: 30, moderated: false }), false, 'no email yet');
  const off = { ...cfg, elder: { ...cfg.elder, requireEmail: false } };
  assert.equal(isElder(off, { tourist_since: since }, ent, T0 + 91 * DAY, { activeDays: 30, moderated: false }), true, 'ELDER_REQUIRE_EMAIL=off');
  assert.equal(elderProgress(cfg, { tourist_since: since }, ent, T0 + 10 * DAY).needsEmail, true);
  assert.equal(elderProgress(cfg, m, ent, T0 + 10 * DAY).remaining, 80);
});

test('sync: joining a tier opens the lounges and verifies; lapsing takes them away', async () => {
  const { store, discord, sync, setNow } = setup();
  store.upsertMembership(ended);
  store.linkEmail('u1', 'a@b.co');
  await sync.syncMember('u1', 'linked');
  const roles = discord.roles.get('u1');
  assert.ok(roles.has('r2') && roles.has('a2') && roles.has('verified'));
  assert.match(discord.dms[0].text, /Ember/);
  setNow(T0 + 40 * DAY);
  await sync.syncMember('u1', 'sweep');
  assert.equal(roles.size, 0);
  assert.ok(discord.dms.some((d) => /run out/.test(d.text)));
  await sync.syncMember('u1', 'sweep');
  assert.equal(discord.dms.filter((d) => /run out/.test(d.text)).length, 1, 'once per lapse');
  store.close();
});

test('sync: someone with the free role keeps access after a tier lapses', async () => {
  const { store, discord, sync, setNow } = setup();
  store.touristSet('u1');
  store.upsertMembership(ended);
  store.linkEmail('u1', 'a@b.co');
  await sync.syncMember('u1', 'linked');
  assert.ok(!discord.roles.get('u1').has('visitor'), 'a tier replaces the free role');
  setNow(T0 + 40 * DAY);
  await sync.syncMember('u1', 'sweep');
  const roles = discord.roles.get('u1');
  assert.ok(roles.has('visitor') && roles.has('verified'));
  assert.ok(!roles.has('a2'));
  store.close();
});

test('renewing during grace is not a new welcome', async () => {
  const { store, discord, sync, setNow } = setup();
  store.upsertMembership(ended);
  store.linkEmail('u1', 'a@b.co');
  store.setFlag('u1', 'thanks', true);
  await sync.syncMember('u1', 'linked');
  setNow(T0 + 12 * DAY);
  await sync.syncMember('u1', 'sweep');
  assert.equal(store.member('u1').applied_state, 'grace');
  store.upsertMembership({ ...member, paidUntil: new Date(T0 + 40 * DAY).toISOString() });
  await sync.syncMember('u1', 'membership.updated');
  assert.equal(store.member('u1').applied_state, 'active');
  assert.equal(discord.dms.filter((d) => /Thank you for supporting/.test(d.text)).length, 1);
  assert.equal(discord.posts.filter((p) => p.ch === 'wall').length, 1);
  store.close();
});

test('two events at the same moment announce a new supporter once', async () => {
  const { store, discord, sync } = setup();
  store.upsertMembership(member);
  store.linkEmail('u1', 'a@b.co');
  store.setFlag('u1', 'thanks', true);
  await Promise.all([sync.syncMember('u1', 'membership.started'), sync.syncMember('u1', 'membership.updated'), sync.syncMember('u1', 'retry')]);
  assert.equal(discord.dms.filter((d) => /Thank you for supporting/.test(d.text)).length, 1);
  assert.equal(discord.posts.filter((p) => p.ch === 'wall').length, 1);
  store.close();
});

test('webhook: signature, parsing and tolerance', async () => {
  const raw = Buffer.from('{"a":1}');
  const sig = crypto.createHmac('sha256', 'shh').update(raw).digest('hex');
  assert.equal(verifySignature(raw, sig, 'shh'), true);
  assert.equal(verifySignature(raw, `sha256=${sig}`, 'shh'), true);
  assert.equal(verifySignature(raw, sig, 'other'), false);
  assert.equal(verifySignature(raw, undefined, 'shh'), false);
  assert.equal(verifySignature(raw, sig, ''), false);
  assert.equal(toIso(1793897000), new Date(1793897000000).toISOString());
  assert.equal(parseEvent({ type: 'donation.created', live_mode: true, data: {} }).ignore.includes('not about'), true);
  assert.ok(parseEvent({ type: 'membership.started', live_mode: false, data: {} }).ignore);

  const { store, discord, sync } = setup();
  store.linkEmail('u1', 'a@b.co');
  const event = (type, extra = {}) => ({ type, live_mode: true, data: { id: 42, supporter_email: 'A@B.co', supporter_name: 'A', membership_level_id: 777, membership_level_name: 'Whatever', current_period_end: Math.floor(T0 / 1000) + 30 * 86400, ...extra } });
  await applyEvent(event('membership.started'), { store, sync });
  assert.ok(discord.roles.get('u1').has('r4'));
  await applyEvent(event('membership.cancelled'), { store, sync });
  assert.equal(store.membershipsFor('a@b.co')[0].status, 'cancelling');
  await applyEvent(event('membership.updated', { paused: 'true' }), { store, sync });
  assert.equal(store.membershipsFor('a@b.co')[0].status, 'paused');
  assert.ok(discord.roles.get('u1').has('r4'), 'keeps the tier until the paid period ends');
  store.close();
});

test('link: no email reveals itself, a code links, wrong codes run out', async () => {
  const { store, discord, sync } = setup();
  store.upsertMembership(member);
  const sent = [];
  const link = createLink({ cfg, store, sync, lx: { smtpOn: true, sendCode: async (e, c) => sent.push({ e, c }), reviewRequest: async () => {}, dm: discord.dm }, makeCode: () => '123456', now: () => T0 });
  const a = await link.start({ userId: 'u1', email: 'nobody@x.co' });
  const b = await link.start({ userId: 'u2', email: 'a@b.co' });
  assert.equal(a, b, 'same answer whether or not the email is a supporter');
  assert.equal(sent.length, 2, 'any email can be confirmed: the Elder rule needs one even from free members');
  assert.match(await link.code({ userId: 'u2', code: '000000' }), /not right/);
  discord.roles.set('u2', new Set());
  assert.match(await link.code({ userId: 'u2', code: '123456' }), /Linked/);
  assert.ok(discord.roles.get('u2').has('a2'));
  // The email is now taken.
  const later = createLink({ cfg, store, sync, lx: { smtpOn: true, sendCode: async () => {}, reviewRequest: async () => {}, dm: discord.dm }, makeCode: () => '654321', now: () => T0 + DAY });
  await later.start({ userId: 'u1', email: 'a@b.co' });
  assert.match(await later.code({ userId: 'u1', code: '654321' }), /already linked/);
  store.close();
});

test('link without SMTP goes to a mod', async () => {
  const { store, discord, sync } = setup();
  store.upsertMembership(member);
  const asked = [];
  const link = createLink({ cfg, store, sync, lx: { smtpOn: false, reviewRequest: async (r) => asked.push(r), dm: discord.dm }, now: () => T0 });
  await link.start({ userId: 'u1', email: 'a@b.co' });
  assert.equal(asked[0].maskedEmail, 'a•••@b.co');
  assert.match(await link.approve({ roleIds: new Set(), id: asked[0].id, actorId: 'x' }), /Only mods/);
  assert.match(await link.approve({ roleIds: new Set(['warden']), id: asked[0].id, actorId: 'x' }), /Linked/);
  store.close();
});

test('intro: the template parses, under-13s are refused unread, an approval verifies', async () => {
  assert.equal(checkIntro(parseIntro(INTRO_TEMPLATE)).ok, true);
  assert.equal(checkIntro(parseIntro('Age: 12\nPronouns: she/her')).tooYoung, true);
  assert.match(checkIntro(parseIntro('Age: 20')).error, /Missing/);

  const { store, discord, sync } = setup();
  const made = [];
  const ix = {
    createChannel: async () => (made.push('c1'), 'c1'), postIntro: async () => {}, archiveIntro: async () => ({ channelId: 'tt', messageId: 'm1' }),
    deleteMessage: async () => {}, deleteChannel: async () => {}, isMember: async () => true, dm: discord.dm, modLog: async () => {},
  };
  const intro = createIntro({ cfg, store, ix, sync, now: () => T0 });
  assert.match(await intro.dm({ userId: 'u1', text: 'Age: 10' }), /13 and over/);
  assert.equal(made.length, 0);
  assert.match(await intro.dm({ userId: 'u1', text: 'hello' }), /Join Magenta Forge/);
  assert.match(await intro.dm({ userId: 'u1', text: INTRO_TEMPLATE }), /with the mods/);
  const req = store.introByUser('u1');
  assert.match(await intro.approve({ userId: 'x', roleIds: new Set(), number: req.id }), /Only mods/);
  assert.match(await intro.approve({ userId: 'x', roleIds: new Set(['warden']), number: req.id }), /verified/);
  const roles = discord.roles.get('u1');
  assert.ok(roles.has('visitor') && roles.has('verified'));
  await intro.withdraw('u1');
  assert.deepEqual(store.introRecords('u1'), []);
  store.close();
});

test('tickets: open, close, reopen, archive and permissions', async () => {
  const store = openStore(':memory:');
  const log = [];
  const tk = {
    createChannel: async () => 'chan', postFirstMessage: async () => {}, setOpenerCanSend: async (c, o, a) => log.push(`send:${a}`), rename: async () => {}, postClosedControls: async () => {}, postPlain: async () => {},
    fetchMessages: async () => [{ at: T0, authorId: 'u1', author: 'someone', text: 'help', attachments: [] }], sendTranscript: async (c, t) => log.push(t.content), deleteChannel: async () => log.push('deleted'), modLog: async () => {},
  };
  const t = createTickets({ cfg, store, tk });
  const opened = await t.open({ userId: 'u1', subject: 'hi', details: 'x' });
  assert.equal(opened.number, 1);
  assert.match((await t.open({ userId: 'u1' })).error, /already/);
  const mod = new Set(['warden']);
  assert.match(await t.archive({ userId: 'x', roleIds: mod, channelId: 'chan' }), /Close the ticket first/);
  assert.match(await t.close({ userId: 'u2', roleIds: new Set(), channelId: 'chan' }), /Only/);
  await t.close({ userId: 'u1', roleIds: new Set(), channelId: 'chan' });
  assert.match(await t.reopen({ userId: 'u1', roleIds: new Set(), channelId: 'chan' }), /Only mods/);
  await t.reopen({ userId: 'x', roleIds: mod, channelId: 'chan' });
  await t.close({ userId: 'x', roleIds: mod, channelId: 'chan' });
  assert.match(await t.archive({ userId: 'x', roleIds: mod, channelId: 'chan', archivedByName: 'mod' }), /archived/);
  assert.ok(log.some((l) => l.includes('Magenta Forge ticket 0001')));
  assert.ok(log.includes('deleted'));
  // The Community Rep is staff but not a mod.
  assert.match(t.list({ roleIds: new Set(['rep']) }), /Only mods/);
  store.close();
});

test('unlink: a mod needs confirmation and it takes effect at once', async () => {
  const { store, discord, sync } = setup();
  store.upsertMembership(member);
  store.linkEmail('u1', 'a@b.co');
  await sync.syncMember('u1', 'linked');
  const un = createUnlink({ cfg, store, sync, discord, now: () => T0 });
  assert.ok(un.prepare({ actorId: 'x', roleIds: new Set(), target: 'u1' }).error);
  const p = un.prepare({ actorId: 'x', roleIds: new Set(['warden']), target: '<@123456789012345678>' });
  assert.match(p.error, /not linked/);
  store.db.prepare("UPDATE discord_members SET discord_id = '123456789012345678' WHERE discord_id = 'u1'").run();
  discord.roles.set('123456789012345678', discord.roles.get('u1'));
  const q = un.prepare({ actorId: 'x', roleIds: new Set(['warden']), target: '<@123456789012345678>' });
  assert.match(q.text, /a•••@b\.co/);
  assert.match(await un.confirm({ actorId: 'other', roleIds: new Set(['warden']), token: q.token }), /Only the mod/);
  assert.match(await un.confirm({ actorId: 'x', roleIds: new Set(['warden']), token: q.token }), /Unlinked/);
  assert.equal(discord.roles.get('123456789012345678').has('a2'), false);
  store.close();
});

test('forget-me deletes the person', () => {
  const store = openStore(':memory:');
  store.touristSet('u1');
  store.todoAdd('u1', null, 'x');
  store.activityAdd('u1', '2026-11-05', 1, 0);
  store.linkStart('u1', 'a@b.co', null, new Date(T0).toISOString());
  store.forget('u1');
  assert.equal(store.member('u1'), null);
  assert.deepEqual(store.todoList('u1', null), []);
  assert.equal(store.linkPending('u1'), null);
  store.close();
});

test('league: scoring and standings follow the rulebook', async () => {
  assert.equal(new Date(parseWhen('2026-11-07 20:00')).toISOString(), '2026-11-07T14:30:00.000Z');
  const m = { kind: 'h2h', teams: ['hammer', 'tongs'] };
  const { rows } = scoreMatch(m, { winner: 'hammer', bestSport: ['tongs'] });
  assert.equal(rows.find((r) => r.team === 'hammer').points, 4);
  assert.equal(rows.find((r) => r.team === 'tongs').points, 3);
  assert.equal(scoreMatch(m, { forfeit: ['tongs'] }).rows.find((r) => r.team === 'tongs').points, 0);
  assert.equal(scoreMatch(m, { winner: 'hammer', penalty: ['hammer'] }).rows.find((r) => r.team === 'hammer').points, 0);

  const store = openStore(':memory:');
  const posts = [];
  const lg = { post: async (c, t) => (posts.push({ c, t }), 'msg'), upsertScoreboard: async () => {}, createRoom: async () => 'room', deleteChannel: async () => {}, createEvent: async () => 'ev', deleteEvent: async () => {} };
  let at = Date.parse('2026-11-07T10:00:00Z');
  const lgue = createLeague({ cfg, store, lg, now: () => at });
  assert.match(await lgue.schedule({ roleIds: new Set(), userId: 'u', game: 'gta-6', kind: 'h2h', when: '2026-11-07 20:00', teams: ['hammer', 'tongs'] }), /Only/);
  assert.match(await lgue.schedule({ roleIds: new Set(['comm']), userId: 'u', game: 'gta-6', kind: 'h2h', when: '2026-11-07 20:00', teams: ['hammer', 'tongs'] }), /Fixture created/);
  await lgue.tick();
  assert.ok(posts.some((p) => /Tomorrow/.test(p.t)));
  at = Date.parse('2026-11-07T14:20:00Z');
  await lgue.tick();
  assert.equal(store.leagueMatch(1).room_id, 'room');
  assert.match(await lgue.result({ roleIds: new Set(['comm']), matchId: 1, winner: 'hammer' }), /Result saved/);
  const table = standings(cfg, store.leagueResults(1));
  assert.equal(table[0].team, 'hammer');
  store.close();
});

test('to-dos: private by default, shared in a voice room', () => {
  const store = openStore(':memory:');
  const base = { userId: 'u1', isMod: false, list: 'mine', roomId: null, inRoom: false };
  assert.match(todoCommand({ ...base, sub: 'add', task: 'print the bracket @everyone' }, { store }), /Added/);
  assert.ok(!store.todoList('u1', null)[0].text.includes('@everyone'));
  assert.match(todoCommand({ ...base, list: 'room', sub: 'add', task: 'x' }, { store }), /voice channel/);
  assert.match(todoCommand({ ...base, sub: 'done', item: 1 }, { store }), /Done/);
  store.close();
});

test('Pomodoro: only volunteers are muted, and everyone is unmuted at the end', async () => {
  const store = openStore(':memory:');
  const mutes = new Map();
  const voice = new Map([['u1', 'c'], ['u2', 'c']]);
  const pd = {
    channel: (id) => ({ id, name: 'Build Room' }), humans: () => [...voice.keys()], voiceOf: (u) => (voice.has(u) ? { channelId: voice.get(u), serverMute: Boolean(mutes.get(u)) } : null),
    setMute: async (u, on) => mutes.set(u, on), setStatus: async () => {}, post: async () => ({ id: 'm' }),
  };
  const timers = [];
  const p = createPomodoro({ config: { enabled: true, match: ['build'], channelIds: [], ambienceKey: 'build-room', focusMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, rounds: 2 }, store, pd, ambience: () => null, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
  assert.match(await p.start({ channelId: 'c', userId: 'u1' }), /started/);
  await p.optIn({ channelId: 'c', userId: 'u1' });
  assert.equal(mutes.get('u1'), true);
  assert.equal(mutes.get('u2'), undefined);
  await p.stop({ channelId: 'c', userId: 'u1', isMod: false });
  assert.equal(mutes.get('u1'), false);
  store.close();
});

test('ambience: a helper joins, leaves after the delay, the pool queues and a lost connection backs off', async () => {
  const people = new Map();
  const played = [];
  const stopped = [];
  const timers = [];
  const lost = [];
  const pool = ['Snitch Helper 1', 'Snitch Helper 2'].map((name) => ({
    name,
    busy: false,
    start: async (room, channel, assets, onLost) => {
      played.push([name, channel.id, assets.notice]);
      lost.push(onLost);
      return { stop: async () => stopped.push(name) };
    },
  }));
  const channels = [{ id: 'a', name: 'The Lounge', kind: 'voice' }, { id: 'b', name: 'Build Room', kind: 'voice' }, { id: 'c', name: 'Backstage', kind: 'voice' }, { id: 'd', name: 'Co-op Gaming', kind: 'voice' }, { id: 'e', name: 'Elder Lounge', kind: 'voice' }, { id: 'f', name: 'Private: Two', kind: 'voice', ignore: true }];
  const config = { ...loadAmbienceConfig('no-such-file.json', {}), leaveDelayMs: 20_000 };
  const found = matchRooms(config.rooms, channels);
  assert.equal(found.get('a').key, 'the-lounge');
  assert.equal(found.get('e').key, 'elder-lounge', 'not The Lounge');
  assert.equal(found.has('d'), false, 'Co-op Gaming stays silent');
  const fsApi = { readdirSync: () => [], existsSync: (p) => p.endsWith('.ogg') };
  const amb = createAmbience({ config, pool, humansIn: (id) => people.get(id) ?? 0, channels: () => channels, notice: () => 'NOTICE', fsApi, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
  people.set('a', 1);
  people.set('b', 1);
  people.set('c', 1);
  for (const id of ['a', 'b', 'c']) amb.evaluate(id);
  await new Promise((r) => setImmediate(r));
  assert.equal(played.length, 2);
  assert.equal(played[0][2], 'NOTICE');
  assert.match(amb.describe(), /waiting for a free bot|every bot|Backstage/);
  people.set('a', 0);
  amb.evaluate('a');
  assert.equal(stopped.length, 0, 'waits for the leave delay');
  await timers.at(-1)();
  assert.equal(stopped[0], 'Snitch Helper 1');
  assert.equal(played.at(-1)[1], 'c', 'the waiting room gets the free helper');
  await new Promise((r) => setImmediate(r));
  // A dropped connection frees the bot and tries again later, not at once.
  const before = played.length;
  lost.at(-1)();
  assert.equal(played.length, before);
  await timers.at(-1)();
  assert.ok(played.length > before);
  // A Pomodoro can call in a sound for a room with none of its own.
  people.set('d', 1);
  assert.equal(amb.summon('d', 'build-room') === 'off', false);
  amb.release('d');
  await amb.stopAll();
  assert.equal(normalizeName('🔊 The Lounge'), 'thelounge');
});

test('private rooms: Elders and Grand Elders make them; limit, close and the notice work', async () => {
  const store = openStore(':memory:');
  const calls = [];
  const live = new Set();
  const timers = [];
  let people = 1;
  const dc = { createRoom: async () => (live.add('r1'), 'r1'), moveMember: async (u, c) => calls.push(['move', u, c]), deleteChannel: async (c) => (live.delete(c), calls.push(['delete', c])), allow: async (c, u) => calls.push(['allow', u]), deny: async (c, u) => calls.push(['deny', u]), rename: async (c, n) => calls.push(['rename', n]), setLimit: async (c, n) => calls.push(['limit', n]), peopleIn: () => people, exists: (c) => live.has(c), postNote: async (c, text) => calls.push(['note', text]) };
  const er = createElderRooms({ cfg, store, dc, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
  assert.equal((await er.lobbyJoin({ userId: 'u1', roleIds: new Set() })).moved, false);
  const made = await er.lobbyJoin({ userId: 'u2', displayName: 'Two', roleIds: new Set(['grand']) });
  assert.equal(made.channelId, 'r1');
  assert.ok(calls.some(([k, v]) => k === 'note' && /Notice/.test(v)));
  assert.ok(!calls.some(([, v]) => /Underground|Republic/.test(String(v))));
  const roles = new Set(['elder']);
  assert.match(await er.command({ sub: 'invite', userId: 'u1', roleIds: new Set(), target: 'x' }), /Forge Elders/);
  assert.match(await er.command({ sub: 'limit', userId: 'u2', roleIds: roles, limit: 3 }), /up to 3/);
  assert.match(await er.command({ sub: 'invite', userId: 'u2', roleIds: roles, target: 'x' }), /can now see/);
  people = 0;
  er.roomChanged('r1');
  await timers.at(-1)();
  assert.deepEqual(calls.at(-1), ['delete', 'r1']);
  assert.equal(store.elderRoomByChannel('r1'), null);
  store.close();
});

test('Buy Me a Coffee check: renews, lapses, and changes nothing on an unusable answer', async () => {
  const { store, sync } = setup();
  const env = { bmcApiToken: 't', bmcApiUrl: 'https://x' };
  store.upsertMembership({ ...member, subscriptionId: 'live' });
  store.upsertMembership({ ...member, subscriptionId: 'gone', email: 'gone@b.co', paidUntil: new Date(Date.now() - DAY).toISOString() });
  const answer = (data) => async () => ({ ok: true, json: async () => ({ data }) });
  const useless = await reconcileWithBmc({ env, store, sync, fetchImpl: answer([{ subscription_id: 'live' }]) });
  assert.equal(useless.skipped, 'no usable data');
  assert.equal(store.activeMemberships().length, 2);
  const r = await reconcileWithBmc({ env, store, sync, fetchImpl: answer([{ subscription_id: 'live', payer_email: 'a@b.co', subscription_current_period_end: '2030-01-01 00:00:00' }]) });
  assert.equal(r.lapsed, 1);
  assert.equal(r.renewed, 1);
  assert.deepEqual(store.activeMemberships().map((m) => m.subscription_id), ['live']);
  assert.deepEqual(await reconcileWithBmc({ env: {}, store, sync }), { skipped: 'BMC_API_TOKEN not set' });
  store.close();
});

test('activity: counted in memory, written on flush, numbers only', () => {
  const store = openStore(':memory:');
  const a = createActivity({ store, now: () => Date.now() });
  a.message('u1');
  a.voiceMinute('u1');
  assert.equal(store.activitySummary('u1', 90).activeDays, 0);
  a.flush();
  assert.equal(store.activitySummary('u1', 90).activeDays, 1);
  store.close();
});

test('hobby picker: requires is enforced', () => {
  const r = applyPick(cfg, new Set(), ['esports']);
  assert.deepEqual(r.add, []);
  assert.match(r.notes[0], /needs/);
  assert.deepEqual(applyPick(cfg, new Set(['hg']), ['gaming', 'esports']).add, ['he']);
  assert.deepEqual(applyPick(cfg, new Set(['hg', 'he']), []).remove.sort(), ['he', 'hg']);
});

test('mirror: posts, edits and deletes reach the gate, and a restart catches up', async () => {
  const store = openStore(':memory:');
  const sent = new Map();
  let n = 0;
  const mx = { send: async (c, p) => (sent.set(`g${++n}`, p), `g${n}`), edit: async (c, id, p) => sent.set(id, p), remove: async (c, id) => sent.delete(id), fetchRecent: async () => [{ id: 'm1', channelId: 'rules', content: 'Be kind (edited)', embeds: [], attachments: [] }, { id: 'm2', channelId: 'rules', content: 'Second', embeds: [], attachments: [] }] };
  const mirror = createMirror({ mirrors: { rules: 'gateRules' }, store, mx });
  assert.equal(await mirror.posted({ id: 'm1', channelId: 'rules', content: 'Be kind <@123>', embeds: [], attachments: [] }), true);
  assert.equal(sent.get('g1').content.trim(), 'Be kind');
  assert.equal(await mirror.posted({ id: 'm1', channelId: 'rules', content: 'Be kind', embeds: [], attachments: [] }), false, 'no double copy');
  assert.equal(await mirror.posted({ id: 'x', channelId: 'general', content: 'hi', embeds: [], attachments: [] }), false);
  await mirror.backfill(100);
  assert.equal(sent.get('g1').content, 'Be kind (edited)');
  assert.equal(sent.size, 2);
  await mirror.deleted('rules', 'm2');
  assert.equal(sent.size, 1);
  store.close();
});

test('webhook over real HTTP: refuses a bad signature, applies a good one', async () => {
  const { startWebhookServer } = await import('../../src/bot/bmc.mjs');
  const { store, discord, sync } = setup();
  store.linkEmail('u1', 'a@b.co');
  const server = startWebhookServer({ port: 0, secret: 'shh', store, sync, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/webhooks/bmc`;
  const body = JSON.stringify({ type: 'membership.started', live_mode: true, data: { id: 9, supporter_email: 'a@b.co', membership_level_name: 'Spark' } });
  assert.equal((await fetch(url, { method: 'POST', body, headers: { 'x-signature-sha256': 'nope' } })).status, 401);
  const sig = crypto.createHmac('sha256', 'shh').update(body).digest('hex');
  assert.equal((await fetch(url, { method: 'POST', body, headers: { 'x-signature-sha256': sig } })).status, 200);
  assert.ok(discord.roles.get('u1').has('a1'));
  server.close();
  store.close();
});
