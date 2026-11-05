// Applies config/server-template.json to the existing Magenta Forge server, using the Snitch bot.
//
//   npm run setup                    shows what would change. Touches nothing.
//   npm run setup:apply              makes the changes and writes config/discord-tiers.json.
//
// When the server already has people in it, closing it to everyone unverified would lock them out too. So --apply also
// needs one of these, the first time, or it stops:
//   --verify-existing                everyone already here becomes a verified member.
//   --existing-are-aspirants         everyone already here must send an intro like a newcomer.
//
// Run it as often as you like: it reuses what exists (by stored ID, then by name) and never deletes anything.
import fs from 'node:fs';
import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { IDS_FILE, TEMPLATE_FILE, readEnv, tiersFromEnv } from '../../src/bot/config.mjs';
import { buildIds, checkGate, planChannels, planRoles } from '../../src/bot/setup-plan.mjs';
import { openStore } from '../../src/bot/store.mjs';
import { auditGate, printAudit } from './audit-lib.mjs';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const say = (...a) => console.log(...a);
const die = (m) => {
  console.error(`\n${m}\n`);
  process.exit(1);
};

const env = readEnv();
if (!env.token) die('SNITCH_BOT_TOKEN is not set in .env.');
if (!env.guildId) die('DISCORD_GUILD_ID is not set in .env.');
const template = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
const tiers = tiersFromEnv();
const prior = fs.existsSync(IDS_FILE) ? JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')) : null;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
await client.login(env.token).catch((err) => die(`Discord refused the login: ${err.message}. In the Developer Portal, also turn on Server Members Intent for Snitch.`));
await new Promise((resolve) => (client.isReady() ? resolve() : client.once('clientReady', resolve)));

try {
  const guild = await client.guilds.fetch(env.guildId).catch(() => null);
  if (!guild) die(`Snitch is not in server ${env.guildId}. Invite it first: npm run invites`);
  // Snitch and its helpers may also be in other servers. Never edit one by mistake.
  if (guild.name !== env.guildName) die(`Server ${env.guildId} is called "${guild.name}", not "${env.guildName}". Nothing was changed. Fix DISCORD_GUILD_ID, or set DISCORD_GUILD_NAME if you renamed the server.`);
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(P.Administrator)) die('Snitch needs the Administrator permission to set up channel permissions. Give its role Administrator in Server Settings, or re-invite it: npm run invites');
  await guild.channels.fetch();
  await guild.roles.fetch();
  const members = await guild.members.fetch();
  say(`${APPLY ? 'Applying to' : 'Dry run on'} "${guild.name}" (${members.size} members, ${guild.channels.cache.size} channels, ${guild.roles.cache.size} roles)\n`);

  // ROLES
  const planned = planRoles(template, tiers, env);
  const roleIds = { '@everyone': guild.roles.everyone.id };
  const priorRole = (key) => {
    if (!prior) return null;
    const maps = { verified: prior.roles?.verified, elder: prior.roles?.elder, grandElder: prior.roles?.grandElder, tourist: prior.roles?.tourist, ambience: prior.roles?.ambience, founder: prior.staffRoleIds?.[0], representative: prior.staffRoleIds?.[1], warden: prior.staffRoleIds?.[2], commissioner: prior.league?.commissionerRoleId };
    if (maps[key]) return maps[key];
    if (key.startsWith('tier:')) return prior.tiers?.find((t) => t.n === Number(key.slice(5)))?.roleId;
    if (key.startsWith('access:')) return prior.tiers?.find((t) => t.n === Number(key.slice(7)))?.accessRoleId;
    if (key.startsWith('hobby:')) return prior.hobbies?.find((h) => h.slug === key.slice(6))?.roleId;
    if (key.startsWith('team:')) return prior.league?.teams?.find((t) => t.key === key.slice(5))?.roleId;
    return null;
  };
  for (const r of planned) {
    const existing = guild.roles.cache.get(priorRole(r.key)) ?? guild.roles.cache.find((x) => x.name === r.name && !x.managed);
    const perms = new PermissionsBitField(r.permissions ?? []);
    if (existing) {
      roleIds[r.key] = existing.id;
      const changed = existing.name !== r.name || existing.permissions.bitfield !== perms.bitfield || existing.hoist;
      if (changed) say(`  role  update  ${r.name}`);
      if (APPLY && changed) await existing.edit({ name: r.name, permissions: perms, colors: r.color ? { primaryColor: r.color } : undefined, hoist: false, mentionable: false, reason: 'Magenta Forge setup' });
    } else {
      say(`  role  create  ${r.name}`);
      if (APPLY) roleIds[r.key] = (await guild.roles.create({ name: r.name, colors: r.color ? { primaryColor: r.color } : undefined, permissions: perms, hoist: false, mentionable: false, reason: 'Magenta Forge setup' })).id;
      else roleIds[r.key] = `new:${r.key}`;
    }
  }

  // The list in the template runs top to bottom, all of it under Snitch's own role.
  if (APPLY) {
    const myTop = me.roles.highest.position;
    const count = planned.length;
    if (myTop <= count) say('  note  Snitch\'s role is low in the list. If roles fail to move, drag Snitch\'s role to the top in Server Settings and run setup again.');
    await guild.roles
      .setPositions(planned.map((r, i) => ({ role: roleIds[r.key], position: Math.max(1, myTop - 1 - i) })))
      .catch((err) => say(`  note  could not order the roles: ${err.message}. Drag Snitch's role to the top and run setup again.`));
  }

  // WHO IS ALREADY HERE
  const verifiedId = roleIds.verified;
  const humans = members.filter((m) => !m.user.bot);
  const notVerified = humans.filter((m) => !m.roles.cache.has(verifiedId) && m.id !== guild.ownerId);
  if (notVerified.size) {
    say(`\n  ${notVerified.size} person(s) here are not verified yet.`);
    if (!args.has('--verify-existing') && !args.has('--existing-are-aspirants')) {
      const msg = 'Decide what happens to them, then run again with one of:\n  --verify-existing          they become verified members and keep access\n  --existing-are-aspirants   they lose access until they send an intro';
      if (APPLY) die(`${msg}\nNothing about channels was changed.`);
      say(`  ${msg.replace(/\n/g, '\n  ')}`);
    }
  }
  const staffIds = ['founder', 'representative', 'warden', 'commissioner', 'grandElder'].map((k) => roleIds[k]);
  if (APPLY) {
    const owner = members.get(guild.ownerId);
    if (owner && !owner.roles.cache.has(verifiedId)) await owner.roles.add(verifiedId, 'Server owner').catch(() => {});
    // Other bots already in the server stay able to work. The helpers get their role from helpers-setup instead.
    for (const b of members.filter((m) => m.user.bot && m.id !== me.id && !/^snitch helper/i.test(m.user.username)).values()) {
      if (!b.roles.cache.has(verifiedId)) await b.roles.add(verifiedId, 'Existing bot').catch(() => {});
    }
    for (const m of humans.filter((x) => staffIds.some((id) => x.roles.cache.has(id)) && !x.roles.cache.has(verifiedId)).values()) await m.roles.add(verifiedId, 'Staff').catch(() => {});
    if (args.has('--verify-existing') && notVerified.size) {
      const store = openStore(env.dbPath);
      for (const m of notVerified.values()) {
        store.touristSet(m.id);
        await m.roles.add([verifiedId, roleIds.tourist], 'Already here at setup').catch((err) => say(`  could not verify ${m.user.tag}: ${err.message}`));
      }
      store.close();
      say(`  verified ${notVerified.size} existing member(s)`);
    }
  }

  // CHANNELS
  const channels = planChannels(template, { roleIds, tiers });
  const problems = checkGate(channels, roleIds);
  if (problems.length) die(`The template would show members to people who are not verified:\n${problems.join('\n')}`);

  const typeOf = { category: ChannelType.GuildCategory, text: ChannelType.GuildText, voice: ChannelType.GuildVoice };
  const channelIds = {};
  const toOverwrites = (list) => list.map((o) => ({ id: o.id, allow: o.allow, deny: o.deny }));
  const parentIdOf = (c) => (c.parent ? channelIds[c.parent] : undefined);
  const inPlan = new Set();
  for (const c of channels) {
    const type = typeOf[c.kind];
    const stored = prior?.channels?.[c.key];
    const parent = parentIdOf(c);
    const sameName = guild.channels.cache.filter((x) => x.type === type && x.name.toLowerCase().replace(/^🔊\s*/, '') === c.name.toLowerCase());
    const existing = guild.channels.cache.get(stored) ?? sameName.find((x) => x.parentId === parent) ?? sameName.first();
    if (existing) {
      channelIds[c.key] = existing.id;
      inPlan.add(existing.id);
      say(`  chan  update  ${c.kind === 'category' ? c.name : `  ${c.name}`} (${c.access})`);
      if (APPLY) {
        await existing.edit({ name: c.name, ...(c.kind === 'category' ? {} : { parent: parent ?? null, lockPermissions: false }), ...(c.kind === 'text' && c.topic ? { topic: c.topic } : {}), permissionOverwrites: toOverwrites(c.overwrites), reason: 'Magenta Forge setup' });
      }
    } else {
      say(`  chan  create  ${c.kind === 'category' ? c.name : `  ${c.name}`} (${c.access})`);
      if (APPLY) {
        const made = await guild.channels.create({ name: c.name, type, ...(parent ? { parent } : {}), ...(c.kind === 'text' && c.topic ? { topic: c.topic } : {}), permissionOverwrites: toOverwrites(c.overwrites), reason: 'Magenta Forge setup' });
        channelIds[c.key] = made.id;
        inPlan.add(made.id);
      } else channelIds[c.key] = `new:${c.key}`;
    }
  }
  if (APPLY) {
    const pos = channels.filter((c) => c.kind === 'category').map((c, i) => ({ channel: channelIds[c.key], position: i }));
    const kids = channels.filter((c) => c.kind !== 'category').map((c, i) => ({ channel: channelIds[c.key], position: i, parent: channelIds[c.parent], lockPermissions: false }));
    await guild.channels.setPositions([...pos, ...kids]).catch((err) => say(`  note  could not order the channels: ${err.message}`));
  }

  // CHANNELS THAT WERE ALREADY THERE AND ARE NOT IN THE TEMPLATE: close them to anyone unverified, delete nothing.
  const openExtras = [...guild.channels.cache.values()].filter((c) => !inPlan.has(c.id) && !c.isThread() && c.permissionOverwrites?.cache.get(guild.roles.everyone.id)?.allow.has(P.ViewChannel));
  for (const c of openExtras) {
    say(`  lock  ${c.name}: was open to everyone, now verified members only`);
    if (APPLY) {
      await c.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: null }, { reason: 'Magenta Forge setup' });
      await c.permissionOverwrites.edit(verifiedId, { ViewChannel: true }, { reason: 'Magenta Forge setup' });
    }
  }

  say(`  server @everyone loses every server-wide permission; welcome messages off; server widget off${guild.features.includes('COMMUNITY') ? '; Community rules channel set to #gate-rules' : ''}`);
  if (APPLY) {
    const ids = buildIds({ guildId: guild.id, roleIds, channelIds, template, tiers });
    fs.writeFileSync(IDS_FILE, `${JSON.stringify(ids, null, 2)}\n`);
    say(`  wrote ${IDS_FILE}`);
    await guild.roles.everyone.setPermissions(0n, 'Magenta Forge setup: the server opens with verification');
    await guild.edit({ systemChannel: null, ...(guild.features.includes('COMMUNITY') ? { rulesChannel: channelIds.gateRules, publicUpdatesChannel: channelIds.staffChat } : {}), reason: 'Magenta Forge setup' }).catch((err) => say(`  note  ${err.message}`));
    await guild.setWidgetSettings({ enabled: false, channel: null }, 'The widget would list online members publicly').catch((err) => say(`  note  could not turn the widget off: ${err.message}`));

    await guild.channels.fetch();
    await guild.members.fetch();
    const audit = auditGate(guild, ids);
    printAudit(audit, say);
    if (audit.leaks.length) process.exitCode = 1;
    say('\nDone. Next: npm run helpers:setup, then npm start.');
  } else {
    say('\nDry run: nothing was changed. Run "npm run setup:apply" to do this.');
  }
} finally {
  await client.destroy();
}
