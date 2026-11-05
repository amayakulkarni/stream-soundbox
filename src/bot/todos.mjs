// To-do lists. Every member has a private list, and every voice channel has a shared list that the people
// in it work from (a Pomodoro focus block repeats its open items in the channel's chat). The rules are here
// with no Discord library in them; discord-adapters.mjs and interactions.mjs do the Discord side.
//
// Kept to the minimum: the task text, who wrote it, which voice channel (if any) and when. Ticking an item
// off deletes it. Unfinished items expire (personal after 30 days, voice channel items after 14 days), and
// /forget-me deletes every item a member wrote.

export const TODO_LIMITS = { textLength: 200, personalItems: 20, roomItems: 30, personalDays: 30, roomDays: 14 };

/** One line, no mentions or links that ping, at most textLength characters. */
export const cleanTask = (s) =>
  String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TODO_LIMITS.textLength);

/** Numbered lines for a list, at most `max` of them. */
export function formatTodos(items, { empty = 'Nothing on the list.', max = 15 } = {}) {
  if (!items.length) return empty;
  const lines = items.slice(0, max).map((t, n) => `${n + 1}. ${t.text}`);
  if (items.length > max) lines.push(`…and ${items.length - max} more.`);
  return lines.join('\n');
}

/**
 * /todo add|list|done|remove|clear
 * ctx: { sub, userId, isMod, list: 'mine' | 'room', roomId (the voice channel the command is about, or null),
 *        inRoom (the member is connected to roomId), task, item }
 */
export function todoCommand(ctx, { store }) {
  store.todoExpire(TODO_LIMITS.personalDays, TODO_LIMITS.roomDays);
  const room = ctx.list === 'room';
  if (room && !ctx.roomId) return 'Run this from a voice channel (join it, or type in its chat) to use that channel\'s list.';
  if (room && !ctx.inRoom && !ctx.isMod && ctx.sub !== 'list') return 'Join that voice channel first: its list is for the people working in it.';
  const items = store.todoList(ctx.userId, room ? ctx.roomId : null);
  const where = room ? `<#${ctx.roomId}>'s list` : 'your list';
  const pick = () => {
    const n = Number(ctx.item);
    return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : null;
  };

  switch (ctx.sub) {
    case 'add': {
      const text = cleanTask(ctx.task);
      if (!text) return 'Write the task.';
      if (items.length >= (room ? TODO_LIMITS.roomItems : TODO_LIMITS.personalItems)) return `${room ? 'This voice channel' : 'Your list'} is full. Tick something off first.`;
      store.todoAdd(ctx.userId, room ? ctx.roomId : null, text);
      const warn = room ? ' Everyone in the channel can read it, so keep personal details out.' : '';
      return `Added to ${where} as number ${items.length + 1}: ${text}.${warn}`;
    }
    case 'list':
      return `**${room ? `To-do for <#${ctx.roomId}>` : 'Your to-do list'}**\n${formatTodos(items)}`;
    case 'done':
    case 'remove': {
      const t = pick();
      if (!t) return items.length ? `Pick a number from 1 to ${items.length} (see /todo list).` : `${room ? 'That list' : 'Your list'} is empty.`;
      // Anyone working in the channel can tick an item off; only its author or a mod can delete it unfinished.
      if (room && ctx.sub === 'remove' && t.owner_id !== ctx.userId && !ctx.isMod) return 'Only the person who added it (or a mod) can remove it. Use done if it is finished.';
      store.todoDelete(t.id);
      return ctx.sub === 'done' ? `Done: ~~${t.text}~~` : `Removed: ${t.text}`;
    }
    case 'clear': {
      if (!room) return `Cleared ${store.todoClear(ctx.userId, null)} item(s) from your list.`;
      if (ctx.isMod) return `Cleared ${store.todoClear(null, ctx.roomId)} item(s) from ${where}.`;
      let n = 0;
      for (const t of items) if (t.owner_id === ctx.userId && store.todoDelete(t.id)) n++;
      return `Cleared ${n} item(s) you added to ${where}. Items others added stay.`;
    }
  }
  return 'Unknown command.';
}
