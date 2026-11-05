// The Discord side of Elder rooms: creating the private channel and moving people.
import { ChannelType, PermissionFlagsBits as P } from 'discord.js';

export function createElderAdapter({ getClient, getGuild, cfg }) {
  const guild = () => getGuild();
  const ch = (id) => guild().channels.cache.get(id);
  const view = [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD, P.SendMessages, P.ReadMessageHistory];
  return {
    async createRoom({ ownerId, name }) {
      const created = await guild().channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: cfg.elder.categoryId || undefined,
        permissionOverwrites: [
          { id: guild().id, deny: [P.ViewChannel, P.Connect] },
          { id: ownerId, allow: view },
          { id: getClient().user.id, allow: [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers] },
        ],
        reason: `Private Elder room for ${ownerId}`,
      });
      return created.id;
    },
    async moveMember(userId, channelId) {
      const m = await guild().members.fetch(userId);
      await m.voice.setChannel(channelId, 'Private Elder room');
    },
    deleteChannel: async (id) => ch(id)?.delete('Elder room closed'),
    allow: async (id, userId) => ch(id).permissionOverwrites.edit(userId, { ViewChannel: true, Connect: true, Speak: true, SendMessages: true, ReadMessageHistory: true }),
    deny: async (id, userId) => {
      await ch(id).permissionOverwrites.delete(userId);
      const m = ch(id).members.get(userId);
      if (m) await m.voice.disconnect('Removed from a private room').catch(() => {});
    },
    rename: async (id, name) => ch(id).setName(name),
    setLimit: async (id, n) => ch(id).setUserLimit(n),
    peopleIn: (id) => [...(ch(id)?.members?.values() ?? [])].filter((m) => !m.user.bot).length,
    exists: (id) => Boolean(ch(id)),
    postNote: async (id, text) => {
      const m = await ch(id)?.send({ content: text, allowedMentions: { parse: [] } });
      await m?.pin().catch(() => {}); // needs Pin Messages; the notice still stands without the pin
    },
    /** Voice channels in the Elder category, except the lobby: rooms the bot made and rooms staff made. */
    categoryVoiceIds: () =>
      [...guild().channels.cache.values()]
        .filter((c) => c.parentId && c.parentId === cfg.elder.categoryId && c.type === ChannelType.GuildVoice && c.id !== cfg.elder.lobbyChannelId)
        .map((c) => c.id),
    /** True when the bot already posted the notice in this room's chat (recent messages). */
    hasNote: async (id) => {
      const c = ch(id);
      if (!c?.messages) return true;
      const recent = await c.messages.fetch({ limit: 30 });
      return recent.some((m) => m.author.id === getClient().user.id && m.content.startsWith('🔒 **Notice:**'));
    },
  };
}
