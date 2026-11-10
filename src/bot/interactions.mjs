// Routes every slash command, button, menu and modal. The rules live in the other modules: this file only reads the
// interaction, checks who is asking and shows the answer. Every answer is private to the person who asked.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { elderProgress, entitlement, isTourist } from './core.mjs';
import { applyPick, describePick } from './hobbies.mjs';
import { INTRO_TEMPLATE } from './intro.mjs';
import { isMod } from './tickets.mjs';
import { todoCommand } from './todos.mjs';
import { parseUserId } from './unlink.mjs';
import { resolveTeams } from './league.mjs';

const EPHEMERAL = { flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
const date = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const input = (id, label, style, opts = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(opts.required ?? true);
  if (opts.value) t.setValue(opts.value);
  if (opts.max) t.setMaxLength(opts.max);
  return new ActionRowBuilder().addComponents(t);
};

export function createInteractionRouter(app) {
  const { cfg, env, store, sync, tickets, intro, league, pomodoro, vcTools, unlink, link, elderRooms, ambience, guild, core, log } = app;

  const rolesOf = (ix) => new Set(ix.member?.roles?.cache?.keys?.() ?? ix.member?.roles ?? []);
  const voiceRoom = (ix) => {
    const here = ix.channel?.isVoiceBased?.() ? ix.channelId : null;
    return here ?? guild.voiceStates.cache.get(ix.user.id)?.channelId ?? null;
  };
  const inRoom = (ix, id) => guild.voiceStates.cache.get(ix.user.id)?.channelId === id;

  /** A notice the DM could not deliver is shown on their next command instead. */
  async function pendingNotices(ix) {
    const list = store.undelivered(ix.user.id);
    if (!list.length) return;
    for (const n of list) store.markDelivered(ix.user.id, n.notice_key);
    await ix.followUp({ ...EPHEMERAL, content: `You have ${list.length} message(s) from Snitch that could not reach your DMs:\n${list.map((n) => `• ${n.message}`).join('\n')}`.slice(0, 1900) }).catch(() => {});
  }

  const isFounder = (ix) => Boolean(cfg.staffRoleIds?.[0] && rolesOf(ix).has(cfg.staffRoleIds[0]));
  const tierLines = () => cfg.tiers.slice().sort((a, b) => a.n - b.n).map((t) => `**${t.name}**${t.price ? ` ($${t.price}/month)` : ''}${t.perks ? `: ${t.perks}` : ''}`).join('\n');

  const commands = {
    intro: async () => intro.help(),

    link: async (ix) => {
      const code = ix.options.getString('code');
      const email = ix.options.getString('email');
      if (code) return link.code({ userId: ix.user.id, code });
      if (email) return link.start({ userId: ix.user.id, email });
      return 'Use `/link email:you@example.com` with the email you paid with on Buy Me a Coffee.';
    },

    unlink: async (ix) => {
      const target = ix.options.getUser('member')?.id ?? ix.options.getString('user_id');
      if (target && parseUserId(target) !== ix.user.id) {
        const res = unlink.prepare({ actorId: ix.user.id, roleIds: rolesOf(ix), target, reason: ix.options.getString('reason') });
        if (res.error) return res.error;
        return { content: res.text, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`unlink:confirm:${res.token}`).setLabel('Unlink').setStyle(ButtonStyle.Danger))] };
      }
      const ok = store.unlink(ix.user.id, cfg.grace?.lapseDays ?? 7);
      if (!ok) return 'You have no Buy Me a Coffee link.';
      await sync.syncMember(ix.user.id, 'unlinked');
      return 'Unlinked. If you had a tier, you keep it through the grace period. Link again any time with /link.';
    },

    membership: async (ix) => {
      const sub = ix.options.getSubcommand();
      if (sub === 'status') {
        const member = store.member(ix.user.id);
        const ent = entitlement(cfg, { memberships: store.membershipsFor(member?.email), grants: store.grantsFor(ix.user.id), member });
        const lines = [ent.tier ? `Tier: **${ent.tier.name}**${ent.state === 'grace' ? ` (grace until ${date(ent.until)})` : ent.endsAt ? ` (ends ${date(ent.endsAt)})` : ''}` : `Tier: none. Support the stream at ${env.bmcUrl}`];
        lines.push(`Buy Me a Coffee link: ${member?.email ? 'yes' : 'no, use /link'}`);
        if (member?.tourist_since) lines.push(`${cfg.tourist.name} since ${date(Date.parse(member.tourist_since))}`);
        if (member?.elder_since) lines.push(`Forge Elder since ${date(Date.parse(member.elder_since))}`);
        else if (cfg.elder?.activeDaysRequired && member) {
          const a = store.activitySummary(ix.user.id, cfg.elder.activityWindowDays ?? 90);
          lines.push(`Forge Elder progress: ${a.activeDays} of ${cfg.elder.activeDaysRequired} active days${a.moderated ? ', paused by a recent timeout' : ''}`);
        }
        return lines.join('\n');
      }
      if (!isFounder(ix)) return 'Only Founders can do this.';
      const id = parseUserId(ix.options.getString('member'));
      if (!id) return 'Give a mention or a user ID.';
      if (sub === 'grant') {
        const tier = ix.options.getString('tier');
        const expires = store.grant(id, tier, ix.options.getInteger('days'), ix.user.id);
        await sync.syncMember(id, 'granted');
        core.modLog(`<@${ix.user.id}> gave <@${id}> ${tier} until ${date(Date.parse(expires))}.`).catch(() => {});
        return `<@${id}> has ${tier} until ${date(Date.parse(expires))}.`;
      }
      store.revoke(id);
      await sync.syncMember(id, 'revoked');
      core.modLog(`<@${ix.user.id}> revoked the membership of <@${id}>.`).catch(() => {});
      return `Revoked. <@${id}> has no tier now, with no grace period.`;
    },

    tiers: async (ix) => {
      let text = `**Support the forge: ${env.bmcUrl}**\n${tierLines()}`;
      if (isFounder(ix)) {
        const known = new Set(cfg.tiers.flatMap((t) => t.bmcLevelIds.map(String)));
        const names = new Set(cfg.tiers.map((t) => t.name.toLowerCase()));
        const odd = store.levelsSeen().filter((l) => !known.has(String(l.level_id)) && !names.has(String(l.level_name).toLowerCase()));
        if (odd.length) text += `\n\n**Levels the bot does not know** (treated as ${cfg.unknownLevelTier}):\n${odd.map((l) => `${l.level_name}: ${l.level_id}`).join('\n')}\nPut these IDs in .env as TIER_n_BMC_ID.`;
      }
      return text;
    },

    rank: async (ix) => {
      const m = store.member(ix.user.id);
      const ent = entitlement(cfg, { memberships: store.membershipsFor(m?.email), grants: store.grantsFor(ix.user.id), member: m });
      const ladder = cfg.tiers.map((t) => (t === ent.tier ? `**${t.name}**` : t.name)).join(' < ');
      const free = cfg.tourist.name;
      const cls = ent.tier
        ? `Your tier: ${ent.tier.name}, rank ${cfg.tiers.indexOf(ent.tier) + 1} of ${cfg.tiers.length} (${ladder}).${ent.state === 'grace' ? ` It is in its grace period until ${date(ent.until)}.` : ''}`
        : isTourist(cfg, m)
          ? `You are a ${free} (free). Tiers, cheapest first: ${ladder}.`
          : `You are not verified yet. Press Send my intro in #verification-help to join for free, or pick a tier: ${ladder}.`;
      const activity = cfg.elder.activeDaysRequired ? store.activitySummary(ix.user.id, cfg.elder.activityWindowDays) : undefined;
      const p = elderProgress(cfg, m, ent, Date.now(), activity);
      const need = cfg.elder.afterDays;
      const standing = ent.state !== 'none' || isTourist(cfg, m);
      let elder;
      if (p.elder) elder = `You are a Forge Elder (verified ${p.days} days ago).`;
      else if (!p.verified) elder = `Forge Elder: the ${need}-day count starts when your intro is approved or you link an email with /link.`;
      else if (p.needsEmail) elder = `Forge Elder: the ${need}-day count is running from your intro (${p.days} day(s) so far), but the role also needs a second verification step: confirm an email with /link. Any email you own works.`;
      else if (p.remaining > 0) elder = `Forge Elder: verified ${p.days} day(s) ago, ${p.remaining} day(s) to go (around ${date(p.eligibleAt)}).${standing ? '' : ` The role also needs a tier or ${free} at that point.`}`;
      else if (!standing) elder = `Forge Elder: your ${need} days are done; the role arrives once you hold a tier or ${free} again.`;
      else if (!p.activityOk) elder = `Forge Elder: your ${need} days are done. The role also needs activity on ${cfg.elder.activeDaysRequired} of the last ${cfg.elder.activityWindowDays} days (you have ${activity.activeDays}${activity.moderated ? ', and a moderation action in that time counts against it' : ''}).`;
      else elder = 'Forge Elder: your days are done; the role arrives within 15 minutes.';
      return `${cls}\n${elder}`;
    },

    discreet: async (ix) => {
      const on = ix.options.getString('state') === 'on';
      store.setFlag(ix.user.id, 'discreet', on);
      await sync.syncMember(ix.user.id, 'discreet');
      return on ? 'Your tier colour is hidden. Your lounges stay open.' : 'Your tier colour is showing again.';
    },

    thanks: async (ix) => {
      const on = ix.options.getString('state') === 'on';
      store.setFlag(ix.user.id, 'thanks', on);
      return on ? 'You will be welcomed on the supporter wall when you join a tier.' : 'No public welcome. Thank you all the same!';
    },

    'forget-me': async () => ({
      content: 'This deletes everything the bot holds about you: your link, tier history, to-dos, activity counts and your saved intro. Your roles are removed and the server closes again until you are verified anew. Your Buy Me a Coffee membership itself is not changed.',
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('forget:confirm').setLabel('Delete everything').setStyle(ButtonStyle.Danger))],
    }),

    socials: async () => `**Find Amaya**\nTwitch: ${env.twitchUrl}\nYouTube: ${env.youtubeUrl}\nBuy Me a Coffee: ${env.bmcUrl}`,

    stream: async (ix) => {
      if (!isMod(cfg, rolesOf(ix))) return 'Only mods can do this.';
      const kind = ix.options.getString('kind');
      const title = ix.options.getString('title').replace(/@(everyone|here)/gi, '');
      const ping = cfg.hobbies?.find((h) => h.slug === `${kind}-streams`)?.roleId;
      const text = `${ping ? `<@&${ping}> ` : ''}🔴 **Amaya is live: ${title}**\n${kind === 'build' ? '🛠️ Build stream' : '🎮 Gameplay stream'}\nTwitch: ${env.twitchUrl}\nYouTube: ${env.youtubeUrl}\nChat along in <#${cfg.channels.streamLive}>.`;
      const m = await core.post(cfg.channels.announcements, text, { allowedMentions: { roles: ping ? [ping] : [] } });
      return `Announced: ${m.url}`;
    },

    sync: async (ix) => {
      if (!isMod(cfg, rolesOf(ix))) return 'Only mods can do this.';
      const given = ix.options.getString('member');
      if (given) {
        const id = parseUserId(given);
        if (!id) return 'Give a mention or a user ID.';
        const r = await sync.syncMember(id, 'manual');
        return r.skipped ? `<@${id}> is not managed by the bot.` : `<@${id}>: ${r.tier ?? 'no tier'}, ${r.added.length} role(s) added, ${r.removed.length} removed.`;
      }
      const all = await sync.syncAll('manual');
      return `Checked ${all.length} member(s).`;
    },

    ticket: async (ix) => {
      const sub = ix.options.getSubcommand();
      const base = { userId: ix.user.id, roleIds: rolesOf(ix), channelId: ix.channelId };
      if (sub === 'open') {
        const r = await tickets.open({ userId: ix.user.id, subject: ix.options.getString('subject'), details: ix.options.getString('details') });
        return r.error ?? `Your ticket is open: <#${r.channelId}>`;
      }
      if (sub === 'close') return tickets.close({ ...base, reason: ix.options.getString('reason') });
      if (sub === 'reopen') return tickets.reopen(base);
      if (sub === 'archive') return tickets.archive({ ...base, archivedByName: ix.user.username });
      return tickets.list(base);
    },

    pomodoro: async (ix) => {
      const sub = ix.options.getSubcommand();
      const channelId = voiceRoom(ix);
      const base = { channelId, userId: ix.user.id };
      if (sub === 'start') {
        if (vcTools.meetings.has(channelId)) return 'A meeting is running here. End it with /vc meeting-end first.';
        return pomodoro.start({ ...base, focus: ix.options.getInteger('focus'), brk: ix.options.getInteger('break'), rounds: ix.options.getInteger('rounds') });
      }
      if (sub === 'stop') return pomodoro.stop({ ...base, isMod: isMod(cfg, rolesOf(ix)) });
      if (sub === 'status') return pomodoro.status(channelId);
      if (sub === 'join') return pomodoro.optIn(base);
      return pomodoro.optOut(base);
    },

    todo: async (ix) => {
      const roomId = voiceRoom(ix);
      return todoCommand(
        { sub: ix.options.getSubcommand(), userId: ix.user.id, isMod: isMod(cfg, rolesOf(ix)), list: ix.options.getString('list') ?? 'mine', roomId, inRoom: roomId ? inRoom(ix, roomId) : false, task: ix.options.getString('task'), item: ix.options.getInteger('item') },
        { store },
      );
    },

    vc: async (ix) => {
      const roomId = voiceRoom(ix);
      const sub = ix.options.getSubcommand();
      return vcTools.command({ sub, userId: ix.user.id, roomId, inRoom: roomId ? inRoom(ix, roomId) : false, isMod: isMod(cfg, rolesOf(ix)), text: ix.options.getString(sub === 'meeting' ? 'topic' : 'text'), minutes: ix.options.getInteger('minutes') });
    },

    room: async (ix) => elderRooms.command({ sub: ix.options.getSubcommand(), userId: ix.user.id, roleIds: rolesOf(ix), target: ix.options.getUser('member')?.id ?? null, name: ix.options.getString('name'), limit: ix.options.getInteger('people') }),

    camp: async (ix) => {
      // "Until I issue /camp stop": only the server owner (and the Forge Founder role) runs the camp.
      if (ix.user.id !== guild.ownerId && !isFounder(ix)) return 'Only the server owner can start or stop the camp.';
      if (!ambience) return 'Ambient sound is off (AMBIENCE=off, or the voice libraries failed to load; see the bot log).';
      const channelId = app.campChannelId();
      if (!channelId) return 'There is no Elder Campfire voice channel with a sound, so there is nothing to light.';
      const sub = ix.options.getSubcommand();
      if (sub === 'status') return ambience.isHeld(channelId) ? `🔥 The camp is running in <#${channelId}>. /camp stop puts it out.` : 'The camp is not running. /camp start lights it.';
      if (sub === 'start') {
        store.leagueStateSet('ambience:camp', '1');
        const state = ambience.hold(channelId);
        log(`camp started by ${ix.user.id}`);
        return state === 'playing' ? `🔥 Camp started: a helper is in <#${channelId}> and stays until /camp stop, even when it is empty.` : state === 'waiting' ? `🔥 Camp started. Every helper is busy right now, so one joins <#${channelId}> as soon as it is free, and then stays.` : `Camp started, but no helper could join yet (no free helper, or no sound file for elder-campfire). It keeps trying.`;
      }
      store.leagueStateSet('ambience:camp', '');
      const was = ambience.unhold(channelId);
      log(`camp stopped by ${ix.user.id}`);
      return was ? 'Camp stopped. The helper leaves once nobody is in the room.' : 'The camp was not running.';
    },

    ambience: async (ix) => {
      if (!isMod(cfg, rolesOf(ix))) return 'Only mods can use this.';
      return ambience ? ambience.describe() : 'Ambient sound is off (AMBIENCE=off, or the voice libraries failed to load; see the bot log).';
    },

    league: async (ix) => {
      const sub = ix.options.getSubcommand();
      const roleIds = rolesOf(ix);
      const userId = ix.user.id;
      const teamList = (name) => {
        const r = resolveTeams(cfg, ix.options.getString(name) ?? '');
        return r;
      };
      if (sub === 'fixtures') return league.fixtures();
      if (sub === 'standings') return league.standings();
      if (sub === 'cancel') return league.cancel({ roleIds, matchId: ix.options.getInteger('match') });
      if (sub === 'season') return league.seasonStart({ roleIds, name: ix.options.getString('name') });
      if (sub === 'schedule') {
        const named = [ix.options.getString('team1'), ix.options.getString('team2')].filter(Boolean);
        const extra = teamList('teams');
        if (extra.error) return extra.error;
        return league.schedule({ roleIds, userId, game: ix.options.getString('game'), kind: ix.options.getString('kind') ?? 'h2h', when: ix.options.getString('when'), teams: [...new Set([...named, ...extra.keys])], week: ix.options.getInteger('week'), note: ix.options.getString('note') ?? '' });
      }
      const fields = {};
      for (const [opt, key] of [['forfeit', 'forfeit'], ['late', 'late'], ['penalty', 'penalty']]) {
        const r = teamList(opt);
        if (r.error) return r.error;
        fields[key] = r.keys;
      }
      const best = ix.options.getString('best_sport');
      const placements = ['first', 'second', 'third', 'fourth'].map((n) => ix.options.getString(n)).filter(Boolean);
      return league.result({ roleIds, matchId: ix.options.getInteger('match'), winner: ix.options.getString('winner'), draw: ix.options.getBoolean('draw') ?? false, placements, bestSport: best ? [best] : [], ...fields });
    },

    'Pin in voice chat': async (ix) => pinItem(ix, true),
    'Unpin from voice chat': async (ix) => pinItem(ix, false),
  };

  function pinItem(ix, pin) {
    const roomId = ix.channel?.isVoiceBased?.() ? ix.channelId : null;
    return vcTools.pinMessage({ userId: ix.user.id, roomId, inRoom: roomId ? inRoom(ix, roomId) : false, isMod: isMod(cfg, rolesOf(ix)), messageId: ix.targetId, pin });
  }

  const modals = {
    intro: () => new ModalBuilder().setCustomId('modal:intro').setTitle('Your Magenta Forge intro').addComponents(input('text', 'Fill in your answers. Only mods read this.', TextInputStyle.Paragraph, { value: INTRO_TEMPLATE, max: 1500 })),
    link: () => new ModalBuilder().setCustomId('modal:link').setTitle('Link your membership').addComponents(input('email', 'The email you paid with', TextInputStyle.Short, { max: 254 })),
    ticket: () => new ModalBuilder().setCustomId('modal:ticket').setTitle('Talk privately to the staff').addComponents(input('subject', 'What is it about?', TextInputStyle.Short, { max: 80 }), input('details', 'Tell us more', TextInputStyle.Paragraph, { max: 1500 })),
    linkCode: () => new ModalBuilder().setCustomId('modal:linkCode').setTitle('Enter your code').addComponents(input('code', 'The code from the email', TextInputStyle.Short, { max: 10 })),
    decline: (n) => new ModalBuilder().setCustomId(`modal:declineIntro:${n}`).setTitle('Decline this intro').addComponents(input('reason', 'Reason sent to them (optional)', TextInputStyle.Short, { required: false, max: 300 })),
  };

  /** Buttons that open a form have to answer at once, so they run before the rest. */
  async function handleButton(ix) {
    const [area, action, arg] = ix.customId.split(':');
    if (area === 'panel') return ix.showModal(modals[action]());
    if (area === 'intro' && action === 'decline') {
      if (!isMod(cfg, rolesOf(ix))) return ix.reply({ ...EPHEMERAL, content: 'Only mods can decide an intro.' });
      return ix.showModal(modals.decline(arg));
    }
    await ix.deferReply({ flags: MessageFlags.Ephemeral });
    const base = { userId: ix.user.id, roleIds: rolesOf(ix), channelId: ix.channelId };
    let text = 'Unknown button.';
    if (area === 'ticket') {
      if (action === 'close') text = await tickets.close(base);
      if (action === 'reopen') text = await tickets.reopen(base);
      if (action === 'archive') text = await tickets.archive({ ...base, archivedByName: ix.user.username });
    } else if (area === 'intro' && action === 'approve') {
      text = await intro.approve({ ...base, number: Number(arg) });
    } else if (area === 'pomodoro') {
      text = action === 'join' ? await pomodoro.optIn({ channelId: ix.channelId, userId: ix.user.id }) : await pomodoro.optOut({ channelId: ix.channelId, userId: ix.user.id });
    } else if (area === 'unlink' && action === 'confirm') {
      text = await unlink.confirm({ actorId: ix.user.id, roleIds: rolesOf(ix), token: arg });
    } else if (area === 'link') {
      text = action === 'approve' ? await link.approve({ roleIds: rolesOf(ix), id: Number(arg), actorId: ix.user.id }) : await link.decline({ roleIds: rolesOf(ix), id: Number(arg), actorId: ix.user.id });
      if (isMod(cfg, rolesOf(ix))) await ix.message.edit({ content: `${ix.message.content}\n${text}`.slice(0, 2000), components: [], allowedMentions: { parse: [] } }).catch(() => {});
    } else if (area === 'forget') {
      await app.forgetMe(ix.user.id);
      text = 'Done. Everything the bot held about you is deleted.';
    }
    await ix.editReply({ content: String(text).slice(0, 2000), allowedMentions: { parse: [] } });
  }

  async function handleModal(ix) {
    await ix.deferReply({ flags: MessageFlags.Ephemeral });
    const [, kind, arg] = ix.customId.split(':');
    let text = 'Unknown form.';
    if (kind === 'intro') text = (await intro.dm({ userId: ix.user.id, text: ix.fields.getTextInputValue('text') })) ?? 'Thanks!';
    if (kind === 'link') text = await link.start({ userId: ix.user.id, email: ix.fields.getTextInputValue('email') });
    if (kind === 'linkCode') text = await link.code({ userId: ix.user.id, code: ix.fields.getTextInputValue('code') });
    if (kind === 'ticket') {
      const r = await tickets.open({ userId: ix.user.id, subject: ix.fields.getTextInputValue('subject'), details: ix.fields.getTextInputValue('details') });
      text = r.error ?? `Your ticket is open: <#${r.channelId}>`;
    }
    if (kind === 'declineIntro') text = await intro.decline({ userId: ix.user.id, roleIds: rolesOf(ix), number: Number(arg), reason: ix.fields.getTextInputValue('reason') });
    await ix.editReply({ content: String(text).slice(0, 2000), allowedMentions: { parse: [] } });
  }

  async function handlePicker(ix) {
    await ix.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await guild.members.fetch(ix.user.id);
    const have = new Set(member.roles.cache.keys());
    const { add, remove, notes } = applyPick(cfg, have, ix.values);
    for (const r of add) {
      await member.roles.add(r, 'Picked in #pick-your-roles');
      have.add(r);
    }
    for (const r of remove) {
      await member.roles.remove(r, 'Unpicked in #pick-your-roles');
      have.delete(r);
    }
    await ix.editReply({ content: [describePick(cfg, have), ...notes].join('\n') });
  }

  return async function route(ix) {
    if (ix.guildId !== cfg.guildId) return; // Snitch may be in other servers: never answer for them here.
    try {
      if (ix.isChatInputCommand() || ix.isContextMenuCommand()) {
        const fn = commands[ix.commandName];
        if (!fn) return;
        // A form has to be the first answer, so it comes before anything else. Options still work for a quick ticket.
        if (ix.isChatInputCommand() && ix.commandName === 'ticket' && ix.options.getSubcommand() === 'open' && !ix.options.getString('subject')) return await ix.showModal(modals.ticket());
        await ix.deferReply({ flags: MessageFlags.Ephemeral });
        const out = await fn(ix);
        await ix.editReply(typeof out === 'string' ? { content: out.slice(0, 2000), allowedMentions: { parse: [] } } : { allowedMentions: { parse: [] }, ...out });
        await pendingNotices(ix);
      } else if (ix.isButton()) await handleButton(ix);
      else if (ix.isModalSubmit()) await handleModal(ix);
      else if (ix.isStringSelectMenu() && ix.customId === 'hobbies:pick') await handlePicker(ix);
    } catch (err) {
      log(`interaction ${ix.commandName ?? ix.customId} failed: ${err.stack ?? err.message}`);
      const text = { content: 'Something went wrong on my side. Please try again in a minute.', allowedMentions: { parse: [] } };
      if (ix.isRepliable?.()) await (ix.deferred || ix.replied ? ix.editReply(text) : ix.reply({ ...text, flags: MessageFlags.Ephemeral })).catch(() => {});
    }
  };
}
