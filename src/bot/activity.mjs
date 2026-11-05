// Activity counts for the Elder rule ("good activity"): messages and voice minutes per member per day, kept as
// numbers only (no text, no channel names) and deleted after the Elder window. In-memory counters are flushed
// to the database every few minutes, so one busy chat is a few writes, not one per message.

const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

export function createActivity({ store, now = () => Date.now(), keepDays = 120 }) {
  const pending = new Map(); // `${id}|${day}` → { id, day, msgs, voice }
  const bump = (id, field) => {
    const day = dayOf(now());
    const key = `${id}|${day}`;
    const row = pending.get(key) ?? { id, day, msgs: 0, voice: 0 };
    row[field] += 1;
    pending.set(key, row);
  };

  return {
    /** A human posted in the server. */
    message: (id) => bump(id, 'msgs'),
    /** One minute of someone sitting in a voice channel. */
    voiceMinute: (id) => bump(id, 'voice'),
    flush() {
      for (const r of pending.values()) store.activityAdd(r.id, r.day, r.msgs, r.voice);
      pending.clear();
    },
    expire: () => store.activityExpire(keepDays, now()),
  };
}
