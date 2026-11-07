// The Discord side of the rule modules. Each create*Adapter returns the small interface its rule module documents.
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, MessageFlags, OverwriteType, PermissionFlagsBits as P, Routes } from 'discord.js';
import { modRoleIds } from './tickets.mjs';

const NO_PINGS = { parse: [] };
const VIEW_TALK = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
export const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);

async function textChannel(guild, id) {
  const ch = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id));
  if (!ch?.isTextBased?.()) throw new Error(`channel ${id} is not a text channel`);
  return ch;
}

export function createDiscordCore({ client, guild, cfg, store }) {
  const post = async (channelId, text, extra = {}) => {
    const ch = await textChannel(guild, channelId);
    return ch.send({ content: text, allowedMentions: NO_PINGS, ...extra });
  };
  const dm = async (id, text) => {
    try {
      const user = await client.users.fetch(id);
      await user.send({ content: text, allowedMentions: NO_PINGS });
      return true;
    } catch {
      return false;
    }
  };
  const fetchMember = async (id) => {
    const m = await guild.members.fetch(id).catch(() => null);
    return m ? { roles: new Set(m.roles.cache.keys()), displayName: m.displayName } : null;
  };
  const discord = {
    fetchMember,
    addRole: (id, roleId, reason) => guild.members.addRole({ user: id, role: roleId, reason }),
    removeRole: (id, roleId, reason) => guild.members.removeRole({ user: id, role: roleId, reason }),
    dm,
    post,
  };
  const modLog = (text) => (cfg.channels.modLog ? post(cfg.channels.modLog, text) : Promise.resolve());
  return { discord, post, dm, fetchMember, modLog };
}

/** Roles that see tickets and intros: the mods only. */
const privateOverwrites = (guild, cfg, personId, personAllow = VIEW_TALK) => [
  { id: guild.roles.everyone.id, deny: [P.ViewChannel], type: OverwriteType.Role },
  ...(cfg.roles?.verified ? [{ id: cfg.roles.verified, deny: [P.ViewChannel], type: OverwriteType.Role }] : []),
  ...modRoleIds(cfg).map((id) => ({ id, allow: VIEW_TALK, type: OverwriteType.Role })),
  ...(personId ? [{ id: personId, allow: personAllow, type: OverwriteType.Member }] : []),
];

export function createTicketAdapter({ guild, cfg, core }) {
  return {
    contentAvailable: true,
    createChannel: async ({ openerId, name }) =>
      (await guild.channels.create({ name, type: ChannelType.GuildText, parent: cfg.channels.ticketCategory, permissionOverwrites: privateOverwrites(guild, cfg, openerId), reason: 'Ticket opened' })).id,
    postFirstMessage: async (channelId, { number, openerId, subject, details }) => {
      const embed = new EmbedBuilder().setColor(cfg.brandColor ?? '#ff267c').setTitle(`Ticket ${String(number).padStart(4, '0')}: ${subject}`).setDescription(details);
      await core.post(channelId, `<@${openerId}> the staff will answer here. Only you and the mods can see this channel.`, {
        embeds: [embed],
        components: [row(button('ticket:close', 'Close ticket', ButtonStyle.Danger))],
        allowedMentions: { users: [openerId] },
      });
    },
    setOpenerCanSend: async (channelId, openerId, allowed) => {
      const ch = await textChannel(guild, channelId);
      await ch.permissionOverwrites.edit(openerId, { SendMessages: allowed });
    },
    rename: async (channelId, name) => (await textChannel(guild, channelId)).setName(name),
    postClosedControls: (channelId, text) =>
      core.post(channelId, text, { components: [row(button('ticket:reopen', 'Reopen'), button('ticket:archive', 'Archive', ButtonStyle.Danger))] }),
    postPlain: (channelId, text) => core.post(channelId, text, { allowedMentions: { parse: ['users'] } }),
    fetchMessages: async (channelId) => {
      const ch = await textChannel(guild, channelId);
      const out = [];
      let before;
      for (let page = 0; page < 20; page++) {
        const batch = await ch.messages.fetch({ limit: 100, before });
        if (!batch.size) break;
        for (const m of batch.values()) out.push({ at: m.createdTimestamp, authorId: m.author.id, author: m.member?.displayName ?? m.author.username, text: [m.content, ...m.embeds.map((e) => [e.title, e.description].filter(Boolean).join('\n'))].filter(Boolean).join('\n'), attachments: [...m.attachments.values()].map((a) => a.url) });
        before = batch.last().id;
      }
      return out.reverse();
    },
    sendTranscript: (channelId, { filename, content, summary }) =>
      core.post(channelId, summary, { files: [new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: filename })] }),
    deleteChannel: async (channelId, reason) => (await guild.channels.fetch(channelId)).delete(reason),
    modLog: core.modLog,
  };
}

export function createIntroAdapter({ guild, cfg, core, store }) {
  const padded = (n) => String(n).padStart(4, '0');
  return {
    createChannel: async ({ name }) =>
      (await guild.channels.create({ name, type: ChannelType.GuildText, parent: cfg.channels.introCategory || cfg.channels.ticketCategory, permissionOverwrites: privateOverwrites(guild, cfg, null), reason: 'Intro waiting for a mod' })).id,
    postIntro: (channelId, { number, applicantId, fields }) => {
      const embed = new EmbedBuilder().setColor(cfg.brandColor ?? '#ff267c').setTitle(`Intro ${padded(number)}`).setDescription(`From <@${applicantId}> (${applicantId})`).addFields(fields.map((f) => ({ name: f.label, value: f.value.slice(0, 1024) })));
      return core.post(channelId, '', { embeds: [embed], components: [row(button(`intro:approve:${number}`, 'Approve', ButtonStyle.Success), button(`intro:decline:${number}`, 'Decline', ButtonStyle.Danger))] });
    },
    archiveIntro: async (channelId, { number, applicantId, approvedBy }) => {
      const ch = await textChannel(guild, channelId);
      const msgs = await ch.messages.fetch({ limit: 20 });
      const intro = [...msgs.values()].reverse().find((m) => m.embeds[0]?.fields?.length);
      const body = [`Magenta Forge intro ${padded(number)}`, `Discord ID: ${applicantId}`, `Approved by: ${approvedBy}`, `Approved: ${new Date().toISOString()}`, '-'.repeat(40), ...(intro?.embeds[0]?.fields ?? []).map((f) => `${f.name}: ${f.value}`)].join('\n');
      const msg = await core.post(cfg.channels.ticketTranscripts, `Approved intro ${padded(number)} for <@${applicantId}>`, { files: [new AttachmentBuilder(Buffer.from(body, 'utf8'), { name: `intro-${padded(number)}.txt` })] });
      return { channelId: cfg.channels.ticketTranscripts, messageId: msg.id };
    },
    deleteMessage: async (channelId, messageId) => (await textChannel(guild, channelId)).messages.delete(messageId),
    deleteChannel: async (channelId, reason) => (await guild.channels.fetch(channelId)).delete(reason),
    isMember: async (userId) => Boolean(await guild.members.fetch(userId).catch(() => null)),
    dm: core.dm,
    modLog: core.modLog,
  };
}

export function createLeagueAdapter({ client, guild, cfg, store }) {
  const L = cfg.league;
  return {
    post: async (channelId, text, roleIds = []) => {
      const ch = await textChannel(guild, channelId);
      const pings = roleIds.map((id) => `<@&${id}>`).join(' ');
      const m = await ch.send({ content: `${pings ? `${pings}\n` : ''}${text}`, allowedMentions: { roles: roleIds, users: [] } });
      return m.id;
    },
    upsertScoreboard: async (channelId, text) => {
      const ch = await textChannel(guild, channelId);
      const id = store.leagueState('scoreboardMessage', '');
      if (id) {
        const old = await ch.messages.fetch(id).catch(() => null);
        if (old) return void (await old.edit({ content: text, allowedMentions: NO_PINGS }));
      }
      const m = await ch.send({ content: text, allowedMentions: NO_PINGS });
      store.leagueStateSet('scoreboardMessage', m.id);
    },
    createRoom: async ({ name, teamRoleIds, crewRoleIds }) =>
      (
        await guild.channels.create({
          name,
          type: ChannelType.GuildVoice,
          parent: L.categoryId,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [P.ViewChannel], type: OverwriteType.Role },
            ...(cfg.roles?.verified ? [{ id: cfg.roles.verified, deny: [P.ViewChannel], type: OverwriteType.Role }] : []),
            ...[...teamRoleIds, ...crewRoleIds].map((id) => ({ id, allow: [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.SendMessages, P.ReadMessageHistory, P.UseSoundboard, P.UseExternalSounds, P.UseEmbeddedActivities, P.UseExternalApps], type: OverwriteType.Role })),
          ],
          reason: 'League match room',
        })
      ).id,
    deleteChannel: async (id) => (await guild.channels.fetch(id)).delete('League match room finished'),
    // A voice-channel event, never an external one: Discord only shows it to people who can see that channel,
    // so the list of who is interested stays out of sight of people who are not verified.
    createEvent: async ({ name, description, startsAt }) =>
      (
        await guild.scheduledEvents.create({
          name,
          description,
          scheduledStartTime: new Date(Math.max(startsAt, Date.now() + 60_000)),
          privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
          entityType: GuildScheduledEventEntityType.Voice,
          channel: L.arenaChannelId,
        })
      ).id,
    deleteEvent: async (id) => guild.scheduledEvents.delete(id),
  };
}

/** Productivity (Pomodoro, /vc): needs the voice states cached from Guilds + GuildVoiceStates. */
export function createProductivityAdapter({ client, guild }) {
  const voiceCh = (id) => guild.channels.cache.get(id);
  return {
    channel: (id) => {
      const ch = voiceCh(id);
      return ch ? { id: ch.id, name: ch.name, kind: ch.type } : null;
    },
    humans: (channelId) => {
      const ch = voiceCh(channelId);
      return ch?.members ? [...ch.members.filter((m) => !m.user.bot).keys()] : [];
    },
    voiceOf: (userId) => {
      const v = guild.voiceStates.cache.get(userId);
      return v?.channelId ? { channelId: v.channelId, serverMute: Boolean(v.serverMute) } : null;
    },
    setMute: (userId, on) => guild.members.edit(userId, { mute: on }),
    setStatus: (channelId, status) => client.rest.put(`/channels/${channelId}/voice-status`, { body: { status: status || '' } }),
    post: async (channelId, { content, buttons }) => {
      const ch = voiceCh(channelId);
      return ch.send({
        content,
        allowedMentions: NO_PINGS,
        ...(buttons ? { components: [row(button('pomodoro:join', 'Mute me during focus', ButtonStyle.Primary), button('pomodoro:leave', 'Unmute me'))] } : {}),
      });
    },
    pin: async (channelId, messageId) => {
      const m = await voiceCh(channelId).messages.fetch(messageId);
      await m.pin();
    },
    unpin: async (channelId, messageId) => {
      const m = await voiceCh(channelId).messages.fetch(messageId);
      await m.unpin();
    },
  };
}

export function createMirrorAdapter({ guild }) {
  return {
    fetchRecent: async (channelId, limit) => {
      const ch = await textChannel(guild, channelId);
      const batch = await ch.messages.fetch({ limit });
      return [...batch.values()].reverse().map(mirrorSource);
    },
    send: async (channelId, payload) => (await (await textChannel(guild, channelId)).send(payload)).id,
    edit: async (channelId, messageId, payload) => (await textChannel(guild, channelId)).messages.edit(messageId, payload),
    remove: async (channelId, messageId) => (await textChannel(guild, channelId)).messages.delete(messageId),
  };
}

export const mirrorSource = (m) => ({
  id: m.id,
  channelId: m.channelId,
  content: m.content,
  embeds: m.embeds.map((e) => e.toJSON()),
  attachments: [...m.attachments.values()].map((a) => a.url),
});

/** Keeps one message of ours in a channel, edited in place on every start. */
export async function upsertPanel({ client, guild, channelId, marker, payload, log = () => {} }) {
  if (!channelId) return;
  try {
    const ch = await textChannel(guild, channelId);
    const recent = await ch.messages.fetch({ limit: 50 });
    const ours = recent.find((m) => m.author.id === client.user.id && m.content.startsWith(marker));
    const full = { ...payload, content: `${marker}${payload.content ?? ''}`, allowedMentions: NO_PINGS, flags: MessageFlags.SuppressEmbeds };
    if (ours) await ours.edit(full);
    else await ch.send(full);
  } catch (err) {
    log(`could not post a panel in ${channelId}: ${err.message}`);
  }
}

export { Routes };
