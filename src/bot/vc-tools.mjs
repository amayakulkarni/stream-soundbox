// Voice channel tracking: the status line under a voice channel's name, meetings with a pinned agenda and
// an end time, and pinning messages in a voice channel's chat. Only members connected to that voice
// channel (or mods) can change it, because Discord gives these powers to the bot and not to members.
// Nothing here is stored: meetings live in memory and end with a restart. The rules are here with no
// Discord library in them; interactions.mjs routes /vc.
import { formatTodos } from './todos.mjs';

export const MEETING_LIMITS = { minutes: [5, 240], topicLength: 80, statusLength: 100 };

/** One line, no pings, cut to `max` characters. */
export const cleanLine = (s, max) =>
  String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<@[!&]?\d+>|@(everyone|here)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * pd: { setStatus(channelId, text), post(channelId, { content }) → { id }, pin(channelId, messageId), unpin(channelId, messageId) }
 * pomodoro: the Pomodoro controller (isRunning); ambience(): statusFor(channelId) for the line to restore.
 */
export function createVcTools({ store, pd, pomodoro, ambience = () => null, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
  const meetings = new Map(); // channelId → { topic, by, startedAt, endsAt, timer, pinnedId }
  const unix = (ms) => Math.floor(ms / 1000);
  const restoreStatus = (channelId) => pd.setStatus(channelId, ambience()?.statusFor(channelId) ?? '');
  const statusError = (e) => (log(`status: ${e.message}`), 'Discord refused the status change (the bot needs Set Voice Channel Status in this channel).');

  async function endMeeting(channelId, why) {
    const m = meetings.get(channelId);
    if (!m) return false;
    meetings.delete(channelId);
    clearTimer(m.timer);
    if (m.pinnedId) await pd.unpin(channelId, m.pinnedId).catch(() => {});
    if (!pomodoro?.isRunning(channelId)) await restoreStatus(channelId).catch(() => {});
    const minutes = Math.max(1, Math.round((now() - m.startedAt) / 60_000));
    if (why !== 'empty') await pd.post(channelId, { content: `📅 Meeting "${m.topic}" ended after ${minutes} min${why === 'time' ? ' (time is up)' : ''}.` }).catch(() => {});
    return true;
  }

  /**
   * /vc status|clear-status|meeting|meeting-end|note
   * ctx: { sub, userId, roomId, inRoom, isMod, text, minutes }
   */
  async function command(ctx) {
    if (!ctx.roomId) return 'Run this from a voice channel: join it, or type in its chat.';
    if (!ctx.inRoom && !ctx.isMod) return 'Join that voice channel first. Only the people in it can change it.';
    const id = ctx.roomId;
    const busy = () => (pomodoro?.isRunning(id) ? 'A Pomodoro is running here and owns the status line until it ends.' : null);

    switch (ctx.sub) {
      case 'status': {
        const text = cleanLine(ctx.text, MEETING_LIMITS.statusLength);
        if (!text) return 'Write the status.';
        if (busy()) return busy();
        if (meetings.has(id)) return 'A meeting is running here. End it with /vc meeting-end first.';
        return pd.setStatus(id, text).then(() => `Status of <#${id}>: ${text}`, statusError);
      }
      case 'clear-status': {
        if (busy()) return busy();
        if (meetings.has(id)) return 'A meeting is running here. End it with /vc meeting-end.';
        return restoreStatus(id).then(() => `Status of <#${id}> cleared.`, statusError);
      }
      case 'meeting': {
        const topic = cleanLine(ctx.text, MEETING_LIMITS.topicLength) || 'Meeting';
        if (busy()) return busy();
        if (meetings.has(id)) return `A meeting is already running here: "${meetings.get(id).topic}".`;
        const [lo, hi] = MEETING_LIMITS.minutes;
        const minutes = ctx.minutes == null ? null : Math.min(hi, Math.max(lo, Math.round(Number(ctx.minutes)) || lo));
        const m = { topic, by: ctx.userId, startedAt: now(), endsAt: minutes ? now() + minutes * 60_000 : null, timer: null, pinnedId: null };
        meetings.set(id, m);
        if (minutes) m.timer = setTimer(() => endMeeting(id, 'time').catch((e) => log(`meeting end failed: ${e.message}`)), minutes * 60_000);
        await pd.setStatus(id, `📅 Meeting: ${topic}`).catch(statusError);
        const agenda = store.todoList(null, id);
        const msg = await pd
          .post(id, { content: `📅 **Meeting: ${topic}**, started by <@${ctx.userId}> <t:${unix(m.startedAt)}:t>${m.endsAt ? `, ends <t:${unix(m.endsAt)}:t> (<t:${unix(m.endsAt)}:R>)` : ''}.\n${agenda.length ? `**Agenda (this channel's to-do list):**\n${formatTodos(agenda, { max: 10 })}` : 'Add agenda points with `/todo add list:room`.'}` })
          .catch((e) => (log(`meeting post: ${e.message}`), null));
        if (msg?.id) {
          const pinned = await pd.pin(id, msg.id).then(() => true, (e) => (log(`meeting pin: ${e.message}`), false));
          if (pinned) m.pinnedId = msg.id;
        }
        return `Meeting started in <#${id}>${minutes ? ` for ${minutes} min` : ''}. End it with /vc meeting-end.`;
      }
      case 'meeting-end':
        return (await endMeeting(id, 'ended')) ? 'Meeting ended.' : 'No meeting is running in this channel.';
      case 'note': {
        const text = cleanLine(ctx.text, 300);
        if (!text) return 'Write the note.';
        const msg = await pd.post(id, { content: `📌 ${text}\n-# pinned by <@${ctx.userId}>` }).catch(() => null);
        if (!msg?.id) return 'Could not post in that voice channel\'s chat.';
        return pd.pin(id, msg.id).then(() => 'Note posted and pinned.', () => 'Note posted, but Discord refused the pin (the bot needs Pin Messages in this channel).');
      }
    }
    return 'Unknown command.';
  }

  /** The "Pin in voice chat" / "Unpin from voice chat" message menu items. */
  async function pinMessage({ userId, roomId, inRoom, isMod, messageId, pin }) {
    if (!roomId) return 'This works on messages in a voice channel\'s chat.';
    if (!inRoom && !isMod) return 'Join that voice channel first. Only the people in it can pin there.';
    return (pin ? pd.pin(roomId, messageId) : pd.unpin(roomId, messageId)).then(
      () => (log(`${userId} ${pin ? 'pinned' : 'unpinned'} ${messageId} in ${roomId}`), pin ? 'Pinned.' : 'Unpinned.'),
      (e) => (log(`pin: ${e.message}`), 'Discord refused (the bot needs Pin Messages in this channel, or the pin list is full).'),
    );
  }

  /** The channel emptied: a meeting nobody attends ends quietly. */
  const channelEmpty = (channelId) => endMeeting(channelId, 'empty');

  return { command, pinMessage, channelEmpty, endMeeting, meetings };
}
