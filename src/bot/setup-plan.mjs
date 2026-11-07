// Turns config/server-template.json into exact roles, channels and permissions. No Discord connection here, so the tests
// can check the gate rule against every channel. scripts/setup.mjs applies the result.
import { PermissionFlagsBits as P } from 'discord.js';

const toBits = (names = []) => names.map((n) => {
  if (P[n] === undefined) throw new Error(`unknown permission ${n}`);
  return P[n];
});

/** Roles from the template, with tier names and the free role's name filled in from .env. */
export function planRoles(template, tiers, env = {}) {
  return template.roles.map((r) => {
    if (r.tier) {
      const t = tiers.find((x) => x.n === r.tier);
      return { key: `tier:${t.n}`, name: t.name, color: r.color, permissions: [], hoist: false };
    }
    if (r.tierAccess) {
      const t = tiers.find((x) => x.n === r.tierAccess);
      return { key: `access:${t.n}`, name: `${t.name} Access`, color: null, permissions: [], hoist: false };
    }
    const name = r.nameFromEnv ? env.touristName ?? r.defaultName : r.name;
    return { ...r, name, color: r.color ?? null, permissions: toBits(r.permissions), permissionNames: r.permissions ?? [], hoist: false };
  });
}

const VIEW = [P.ViewChannel, P.ReadMessageHistory];
const TALK = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AddReactions, P.EmbedLinks, P.AttachFiles, P.Connect, P.Speak, P.Stream, P.UseVAD];
// Helpers post the room's picture and notice in the voice chat, and set the status line, themselves.
const AMBIENT = [P.ViewChannel, P.Connect, P.Speak, P.SendMessages, P.AttachFiles, P.ReadMessageHistory, P.SetVoiceChannelStatus];
const NO_WRITE = [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads, P.AddReactions];
const STAFF_KEYS = ['founder', 'representative', 'warden'];
const everyone = '@everyone';

/**
 * The permission overwrites for a channel. roleIds: role key → ID (plus '@everyone').
 * Discord adds up a member's allowed roles and lets an allow beat a deny, so a private channel denies the verified role
 * and then allows the people who belong. @everyone starts with nothing at server level: a channel with no overwrite is
 * already closed to anyone without the verified role.
 */
export function overwritesFor(access, ch, { roleIds, tiers, staffTalks = true }) {
  const id = (key) => {
    if (!roleIds[key]) throw new Error(`no role ${key}`);
    return roleIds[key];
  };
  const list = [];
  const allow = (key, bits) => list.push({ id: id(key), allow: bits, deny: [] });
  const deny = (key, bits) => list.push({ id: id(key), allow: [], deny: bits });
  const staff = () => STAFF_KEYS.forEach((k) => allow(k, TALK));
  const privateTo = (keys) => {
    deny(everyone, [P.ViewChannel]);
    deny('verified', [P.ViewChannel]);
    keys.forEach((k) => allow(k, TALK));
    staff();
    if (ch?.ambience) allow('ambience', AMBIENT);
  };

  if (access === 'gate') {
    // The one place someone who is not verified can look. Everyone who is verified, every member of staff and the helper
    // bots are denied, so the member list here shows nobody but the people still waiting, the owner and Snitch.
    list.push({ id: id(everyone), allow: ch?.gateCommands ? [...VIEW, P.UseApplicationCommands] : VIEW, deny: NO_WRITE });
    ['verified', ...STAFF_KEYS, 'commissioner', 'ambience'].forEach((k) => deny(k, [P.ViewChannel]));
    return list;
  }
  deny(everyone, [P.ViewChannel]);
  if (access === 'staff') {
    deny('verified', [P.ViewChannel]);
    staff();
    return list;
  }
  list.length = 0;
  // An @everyone deny outranks what roles give at server level, so verified channels must allow their people explicitly.
  const openToVerified = (readOnly) => {
    deny(everyone, [P.ViewChannel]);
    if (readOnly) {
      list.push({ id: id('verified'), allow: VIEW, deny: NO_WRITE });
      staff();
    } else {
      allow('verified', TALK);
    }
    allow('ambience', AMBIENT);
  };
  if (access === 'verified') {
    openToVerified(ch?.readOnly);
    return list;
  }
  if (access === 'readonly') {
    openToVerified(true);
    return list;
  }
  if (access.startsWith('tier:')) {
    const from = Number(access.slice(5));
    // Grand Elders (Amaya's friends) see every paid channel, whatever tier they hold.
    privateTo([...tiers.filter((t) => t.n >= from).map((t) => `access:${t.n}`), 'grandElder']);
    return list;
  }
  if (access.startsWith('role:')) {
    privateTo(access.slice(5).split('+'));
    return list;
  }
  if (access === 'league') {
    privateTo(['hobby:esports', 'commissioner', ...Object.keys(roleIds).filter((k) => k.startsWith('team:'))]);
    if (ch?.readOnly) {
      for (const o of list) {
        if (o.id !== id('commissioner') && !STAFF_KEYS.some((k) => o.id === id(k)) && o.allow.includes(P.ViewChannel)) {
          o.allow = VIEW;
          o.deny = NO_WRITE;
        }
      }
    }
    return list;
  }
  throw new Error(`unknown access rule "${access}"`);
}

/** Every category and channel with its overwrites. */
export function planChannels(template, { roleIds, tiers }) {
  const out = [];
  for (const cat of template.categories) {
    const access = cat.access;
    out.push({ key: cat.key, name: cat.name, kind: 'category', access, overwrites: overwritesFor(access, cat, { roleIds, tiers }) });
    for (const ch of cat.channels) {
      const chAccess = ch.access ?? access;
      const list = overwritesFor(chAccess, ch, { roleIds, tiers });
      const kind = ch.type ?? 'text';
      // Text channels only take text permissions.
      const fit = kind === 'text' ? list.map((o) => ({ ...o, allow: o.allow.filter((b) => !VOICE_ONLY.has(b)), deny: o.deny.filter((b) => !VOICE_ONLY.has(b)) })) : list;
      out.push({ ...ch, kind, parent: cat.key, access: chAccess, overwrites: fit });
    }
  }
  return out;
}

const VOICE_ONLY = new Set([P.Connect, P.Speak, P.Stream, P.UseVAD, P.SetVoiceChannelStatus]);
const hasView = (o) => o.allow.includes(P.ViewChannel);

/**
 * The gate rule, checked channel by channel: nobody can both be unverified and share a channel with a verified member.
 * Returns a list of problems (empty is good).
 */
export function checkGate(channels, roleIds) {
  const problems = [];
  const everyoneId = roleIds['@everyone'];
  const memberRoles = new Set(Object.entries(roleIds).filter(([k]) => k !== '@everyone').map(([, v]) => v));
  for (const c of channels) {
    const ev = c.overwrites.find((o) => o.id === everyoneId);
    const openToEveryone = Boolean(ev && hasView(ev));
    if (c.access === 'gate') {
      if (!openToEveryone) problems.push(`${c.name}: the gate must be open to people who are not verified`);
      if (ev && !ev.deny.includes(P.SendMessages)) problems.push(`${c.name}: people in the gate must not be able to post`);
      for (const key of ['verified', ...STAFF_KEYS, 'ambience']) {
        const o = c.overwrites.find((x) => x.id === roleIds[key]);
        if (!o?.deny.includes(P.ViewChannel)) problems.push(`${c.name}: ${key} must not be able to see the gate`);
      }
      if (c.overwrites.some((o) => memberRoles.has(o.id) && hasView(o))) problems.push(`${c.name}: a member role can see the gate`);
    } else if (openToEveryone) {
      problems.push(`${c.name}: open to people who are not verified, so it would show them members`);
    }
  }
  return problems;
}

/** discord-tiers.json: where everything ended up. */
export function buildIds({ guildId, roleIds, channelIds, template, tiers }) {
  const roleOf = (k) => roleIds[k] ?? '';
  const ch = (k) => channelIds[k] ?? '';
  // The Elder category is left out: its rooms carry their own notice.
  const voiceCategories = template.categories.filter((c) => c.key !== 'elderCategory' && c.channels.some((x) => x.type === 'voice')).map((c) => channelIds[c.key]).filter(Boolean);
  const hobbies = template.roles.filter((r) => r.hobby).map((r) => {
    const text = template.categories.flatMap((c) => c.channels).find((x) => x.hobbyText === r.hobby.slug);
    const voice = template.categories.flatMap((c) => c.channels).find((x) => x.hobbyVoice === r.hobby.slug);
    return { ...r.hobby, name: r.name, roleId: roleOf(r.key), textChannelId: text ? ch(text.key) : null, voiceChannelId: voice ? ch(voice.key) : null };
  });
  const teams = template.roles.filter((r) => r.team).map((r) => ({ ...r.team, roleId: roleOf(r.key) }));
  const mirrors = {};
  for (const c of template.categories.flatMap((x) => x.channels)) if (c.mirrorOf) mirrors[ch(c.mirrorOf)] = ch(c.key);
  const allChannels = {};
  for (const [k, v] of Object.entries(channelIds)) allChannels[k] = v;
  return {
    _readme: 'Written by "npm run setup:apply". Do not edit by hand: change config/server-template.json or .env and run it again.',
    guildId,
    tiers: tiers.map((t) => ({ n: t.n, slug: t.slug, rank: t.rank, roleId: roleOf(`tier:${t.n}`), accessRoleId: roleOf(`access:${t.n}`) })),
    staffRoleIds: [roleOf('founder'), roleOf('representative'), roleOf('warden')],
    grace: template.grace,
    channels: allChannels,
    mirrors,
    roles: { verified: roleOf('verified'), elder: roleOf('elder'), grandElder: roleOf('grandElder'), tourist: roleOf('tourist'), ambience: roleOf('ambience') },
    tourist: { roleId: roleOf('tourist'), free: true },
    elder: {
      ...template.elder,
      roleId: roleOf('elder'),
      grandElderRoleId: roleOf('grandElder'), // the bot never gives or removes this: only the server owner does
      lobbyChannelId: ch('elderLobby'),
      categoryId: ch('elderCategory'),
      creatorRoleIds: [roleOf('elder'), roleOf('grandElder'), roleOf('founder'), roleOf('representative'), roleOf('warden')],
    },
    league: {
      commissionerRoleId: roleOf('commissioner'),
      categoryId: ch('leagueCategory'),
      arenaChannelId: ch('arena'),
      teams,
      games: template.league.games,
      channels: { fixtures: ch('fixtures'), scoreboard: ch('scoreboard'), office: ch('office'), matchReports: ch('matchReports') },
    },
    hobbies,
    voiceNotice: { categoryIds: voiceCategories },
    ambience: { roleId: roleOf('ambience') },
  };
}
