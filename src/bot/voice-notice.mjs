// The notice posted in the text chat of every public voice channel, right after the room's picture.
import { ChannelType } from 'discord.js';

export const VOICE_NOTICE =
  '⚠️ **Voice chats here are public.** Do not write or show privileged or sensitive information (real names, addresses, documents, passwords, stream keys, anything that could identify or out someone). Do not trust newcomers with personal details. Report any unsolicited DM to the staff: press the button in #open-a-ticket or type /ticket open.';

const MARK = '⁣'; // an invisible mark, so the bot can find its own static notice again

/**
 * Public voice channels with no ambient sound keep one permanent notice (edited in place on every start).
 * Rooms that play ambient sound get the notice from the ambience session instead, after the picture.
 */
export async function ensureStaticNotices({ client, guild, categoryIds, skipIds = new Set(), log = () => {} }) {
  if (!categoryIds?.length) return 0;
  let n = 0;
  for (const ch of guild.channels.cache.values()) {
    if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type)) continue;
    if (!categoryIds.includes(ch.parentId) || skipIds.has(ch.id)) continue;
    try {
      const recent = await ch.messages.fetch({ limit: 30 });
      const ours = recent.find((m) => m.author.id === client.user.id && m.content.startsWith(MARK));
      const payload = { content: MARK + VOICE_NOTICE, allowedMentions: { parse: [] } };
      if (ours) await ours.edit(payload);
      else await ch.send(payload);
      n++;
    } catch (err) {
      log(`could not post the voice notice in ${ch.name}: ${err.message}`);
    }
  }
  return n;
}
