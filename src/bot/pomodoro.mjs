// Pomodoro sessions in the Build Room and other focus voice channels. One person starts a session in the channel
// they sit in; focus blocks and breaks then take turns. During a focus block:
//   - members who pressed "Mute me during focus" are server-muted (nobody else is ever muted),
//   - a bot from the ambience pool is called in to play the room sound (rooms with a sound of their own keep it),
//   - the channel status shows the block and the bot repeats the channel's open to-do items in its chat.
// Breaks unmute everyone. When the session ends (last block, /pomodoro stop, or the channel empties) every
// mute is lifted, the helper leaves and the status goes back to what it was.
//
// A server mute follows the member into every voice channel, so the bot unmutes a member who leaves the
// channel during focus as soon as Discord allows it (when they are next in a voice channel). The
// pomodoro_mutes table remembers whom the bot muted, so a restart never leaves anyone stuck.
// The rules are here with no Discord library in them.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeName } from './ambience.mjs';
import { formatTodos } from './todos.mjs';

export const POMODORO_DEFAULTS = {
  enabled: true,
  // Voice channels whose name contains one of these words (emoji, case and spaces ignored), or exactly
  // channelIds when that list is not empty.
  match: ['build', 'workbench', 'focus', 'cowork'],
  channelIds: [],
  ambienceKey: 'build-room',
  focusMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  rounds: 4,
};
export const POMODORO_LIMITS = { focus: [5, 90], break: [1, 30], rounds: [1, 8] };

/** Reads config/pomodoro.json (optional) over the defaults. POMODORO=off turns the feature off. */
export function loadPomodoroConfig(file = process.env.POMODORO_CONFIG || 'config/pomodoro.json', env = process.env) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${file}: ${err.message}`);
  }
  const cfg = { ...POMODORO_DEFAULTS, ...raw };
  const flag = String(env.POMODORO ?? (raw.enabled === false ? 'off' : 'on')).toLowerCase();
  return {
    ...cfg,
    enabled: !['off', 'false', '0', 'no'].includes(flag),
    match: (cfg.match || []).map(normalizeName).filter(Boolean),
    channelIds: (cfg.channelIds || []).map(String),
  };
}

/** Is this voice channel a focus room? channel: { id, name } */
export function isPomodoroRoom(config, channel) {
  if (!channel) return false;
  if (config.channelIds.length) return config.channelIds.includes(channel.id);
  const name = normalizeName(channel.name);
  return config.match.some((w) => name.includes(w));
}

const clamp = (v, [lo, hi], dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v != null ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * pd (the Discord side, discord-adapters.mjs):
 *   channel(id) → { id, name, kind } | null      humans(channelId) → [userId]
 *   voiceOf(userId) → { channelId, serverMute } | null
 *   setMute(userId, on) → Promise                 setStatus(channelId, text) → Promise
 *   post(channelId, { content, buttons: boolean }) → Promise
 * ambience(): the ambience controller (summon, release, statusFor) or null when ambience is off.
 */
export function createPomodoro({ config, store, pd, ambience = () => null, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
  const sessions = new Map(); // channelId → session

  const unix = (ms) => Math.floor(ms / 1000);
  const statusText = (s) =>
    s.phase === 'focus'
      ? `🍅 Pomodoro: focus ${s.round}/${s.rounds} (${s.focus} min), mics muted for those who opted in`
      : `☕ Pomodoro: ${s.phase === 'long' ? 'long ' : ''}break (${s.phase === 'long' ? s.longBreak : s.break} min), focus ${s.round + 1}/${s.rounds} next`;

  async function mute(s, userId) {
    const v = pd.voiceOf(userId);
    if (v?.channelId !== s.channelId) return;
    store.pomodoroMuteAdd(userId, s.channelId); // first, so a crash in between still unmutes later
    await pd.setMute(userId, true).catch((e) => {
      store.pomodoroMuteDelete(userId);
      log(`could not mute ${userId}: ${e.message} (the bot needs Mute Members)`);
    });
  }

  /** Lifts a mute the bot made. A member who is not in voice stays on record until they are. */
  async function unmute(userId) {
    if (!store.pomodoroMuted(userId)) return;
    if (!pd.voiceOf(userId)) return; // Discord only changes the voice state of a connected member
    try {
      await pd.setMute(userId, false);
      store.pomodoroMuteDelete(userId);
    } catch (e) {
      log(`could not unmute ${userId}: ${e.message}`);
    }
  }

  const todoLines = (channelId) => {
    const items = store.todoList(null, channelId);
    return items.length ? `\n**Open to-dos for this channel:**\n${formatTodos(items, { max: 10 })}` : '\nNo open to-dos for this channel: add one with `/todo add list:room`.';
  };

  async function setPhase(s, phase) {
    s.phase = phase;
    const minutes = phase === 'focus' ? s.focus : phase === 'long' ? s.longBreak : s.break;
    s.endsAt = now() + minutes * 60_000;
    clearTimer(s.timer);
    s.timer = setTimer(() => next(s.channelId).catch((e) => log(`pomodoro step failed: ${e.message}`)), minutes * 60_000);
    await pd.setStatus(s.channelId, statusText(s)).catch((e) => log(`could not set the channel status: ${e.message} (the bot needs Set Voice Channel Status)`));
    if (phase === 'focus') {
      for (const id of s.optedIn) await mute(s, id);
      await pd.post(s.channelId, { content: `🍅 **Focus ${s.round} of ${s.rounds}** until <t:${unix(s.endsAt)}:t> (<t:${unix(s.endsAt)}:R>). ${s.optedIn.size ? `${s.optedIn.size} member(s) muted by choice.` : 'Nobody asked to be muted.'}${todoLines(s.channelId)}`, buttons: true });
    } else {
      for (const id of s.optedIn) await unmute(id);
      await pd.post(s.channelId, { content: `☕ **${phase === 'long' ? 'Long break' : 'Break'}** until <t:${unix(s.endsAt)}:t>. Mics are back on. Focus ${s.round + 1} of ${s.rounds} starts <t:${unix(s.endsAt)}:R>.`, buttons: true });
    }
  }

  async function next(channelId) {
    const s = sessions.get(channelId);
    if (!s) return;
    if (s.phase === 'focus') {
      if (s.round >= s.rounds) return finish(channelId, 'done');
      return setPhase(s, s.round % 4 === 0 ? 'long' : 'break');
    }
    s.round++;
    return setPhase(s, 'focus');
  }

  /** /pomodoro start. Returns the private reply. */
  async function start({ channelId, userId, focus, brk, rounds }) {
    if (!config.enabled) return 'Pomodoro is switched off on this server.';
    const ch = channelId ? pd.channel(channelId) : null;
    if (!ch || pd.voiceOf(userId)?.channelId !== channelId) return 'Join the Build Room voice channel first, then start the Pomodoro there.';
    if (!isPomodoroRoom(config, ch)) return 'Pomodoro runs only in the Build Room and other focus voice channels.';
    if (sessions.has(channelId)) return 'A Pomodoro is already running here. Press "Mute me during focus" on its message to join in.';
    const s = {
      channelId,
      starterId: userId,
      focus: clamp(focus, POMODORO_LIMITS.focus, config.focusMinutes),
      break: clamp(brk, POMODORO_LIMITS.break, config.breakMinutes),
      longBreak: config.longBreakMinutes,
      rounds: clamp(rounds, POMODORO_LIMITS.rounds, config.rounds),
      round: 1,
      phase: null,
      optedIn: new Set(),
      timer: null,
      startedAt: now(),
      sound: 'off',
    };
    sessions.set(channelId, s);
    s.sound = ambience()?.summon(channelId, config.ambienceKey) ?? 'off';
    await pd.post(channelId, {
      content: `⏱️ <@${userId}> started a Pomodoro here: ${s.rounds} × ${s.focus} min focus with ${s.break} min breaks.${s.sound === 'playing' || s.sound === 'own' ? ' The room sound plays during the session.' : s.sound === 'waiting' ? ' Every helper bot is busy, so the room sound joins when one is free.' : ''}\nMics stay on unless you choose otherwise: press **Mute me during focus** to be muted for each focus block (unmuted in every break and at the end), or **Unmute me** to leave. \`/pomodoro stop\` ends it.`,
      buttons: false,
    });
    await setPhase(s, 'focus');
    log(`started in ${ch.name} by ${userId}`);
    return `Pomodoro started: ${s.rounds} focus block(s) of ${s.focus} minutes. Press **Mute me during focus** in the channel chat if you want to be muted.`;
  }

  /** "Mute me during focus" button or /pomodoro join. */
  async function optIn({ channelId, userId }) {
    const s = sessions.get(channelId);
    if (!s) return 'No Pomodoro is running in this channel.';
    const v = pd.voiceOf(userId);
    if (v?.channelId !== channelId) return 'Join this voice channel first.';
    // Never take over a mute a moderator made: unmuting it at the end would undo their decision.
    if (v.serverMute && !store.pomodoroMuted(userId)) return 'You are already server-muted by a moderator, so the Pomodoro leaves your mic alone.';
    s.optedIn.add(userId);
    if (s.phase === 'focus') await mute(s, userId);
    return s.phase === 'focus' ? 'You are muted until this focus block ends. Press **Unmute me** at any time.' : 'You will be muted when the next focus block starts.';
  }

  /** "Unmute me" button or /pomodoro leave. */
  async function optOut({ channelId, userId }) {
    const s = sessions.get(channelId);
    s?.optedIn.delete(userId);
    const had = Boolean(store.pomodoroMuted(userId));
    await unmute(userId);
    return had ? 'Unmuted. You will not be muted again in this session.' : 'You are not muted by the Pomodoro.';
  }

  /** Ends a session: lifts the mutes, sends the helper away, puts the status back. */
  async function finish(channelId, why) {
    const s = sessions.get(channelId);
    if (!s) return false;
    sessions.delete(channelId);
    clearTimer(s.timer);
    for (const id of s.optedIn) await unmute(id);
    for (const r of store.pomodoroMutesAll()) if (r.channel_id === channelId) await unmute(r.user_id);
    ambience()?.release(channelId);
    await pd.setStatus(channelId, ambience()?.statusFor(channelId) ?? '').catch(() => {});
    const minutes = Math.round((now() - s.startedAt) / 60_000);
    const text = { done: `✅ Pomodoro finished: ${s.rounds} focus block(s) done. Mics are back on.`, stopped: `⏹️ Pomodoro stopped after ${minutes} min. Mics are back on.`, empty: null, shutdown: '⏹️ Pomodoro stopped because the bot is restarting. Mics are back on.' }[why];
    if (text) await pd.post(channelId, { content: text, buttons: false }).catch(() => {});
    log(`${why} in ${channelId} after ${minutes} min`);
    return true;
  }

  /** /pomodoro stop: the starter, anyone in the channel once the starter has left, or a mod. */
  async function stop({ channelId, userId, isMod }) {
    const s = sessions.get(channelId);
    if (!s) return 'No Pomodoro is running in this channel.';
    const starterHere = pd.voiceOf(s.starterId)?.channelId === channelId;
    if (!isMod && userId !== s.starterId && (starterHere || pd.voiceOf(userId)?.channelId !== channelId)) return 'Only the person who started it (or a mod) can stop it.';
    await finish(channelId, 'stopped');
    return 'Pomodoro stopped. Everyone the Pomodoro muted is unmuted.';
  }

  function status(channelId) {
    const s = sessions.get(channelId);
    if (!s) return 'No Pomodoro is running in this channel.';
    return `${statusText(s)}, until <t:${unix(s.endsAt)}:t>. Started by <@${s.starterId}>; ${s.optedIn.size} member(s) opted in to muting.`;
  }

  /** Every voice change: lift mutes for members who left their session, end sessions nobody is in. */
  async function voiceChanged({ userId, from, to }) {
    if (from && from !== to) {
      const s = sessions.get(from);
      if (s) {
        s.optedIn.delete(userId);
        if (pd.humans(from).length === 0) await finish(from, 'empty');
      }
    }
    const rec = store.pomodoroMuted(userId);
    if (to && rec && !(rec.channel_id === to && sessions.get(to)?.phase === 'focus' && sessions.get(to).optedIn.has(userId))) await unmute(userId);
  }

  /** On start: sessions do not survive a restart, so every mute on record is lifted where possible. */
  async function recover() {
    for (const r of store.pomodoroMutesAll()) await unmute(r.user_id);
  }

  async function stopAll() {
    for (const id of [...sessions.keys()]) await finish(id, 'shutdown');
  }

  return { start, optIn, optOut, stop, status, voiceChanged, recover, stopAll, isRunning: (id) => sessions.has(id), sessions };
}
