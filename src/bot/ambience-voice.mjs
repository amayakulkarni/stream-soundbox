// The Discord side of ambient sound: joining a voice or stage channel, looping a file through ffmpeg,
// posting the room's picture, and setting the channel status. The rules are in ambience.mjs.
// @discordjs/voice and ffmpeg-static are loaded on demand, so a missing library only turns ambience off
// and never stops the membership bot.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits } from 'discord.js';

/** One loop of the file, forever, as Ogg Opus (so Discord needs no extra encoder in Node). */
/**
 * What to do after ffmpeg ends. state = { fails }, kept between runs; run = { code, ranMs }.
 * A clean end, or a run that lasted a while, plays again at once. Each quick failure in a row waits twice as long
 * (1, 2, 4, 8 s, up to 60 s). After GIVE_UP_AFTER of them the room is handed back, so ambience.mjs backs off too.
 */
export const QUICK_FAIL_MS = 2000;
export const GIVE_UP_AFTER = 5;
export function nextRun(state, { code, ranMs }) {
  const failed = code !== 0 && ranMs < QUICK_FAIL_MS;
  state.fails = failed ? state.fails + 1 : 0;
  if (!failed) return { action: 'play', delayMs: 0 };
  if (state.fails >= GIVE_UP_AFTER) return { action: 'give-up', delayMs: 0 };
  return { action: 'wait', delayMs: Math.min(60_000, 1000 * 2 ** (state.fails - 1)) };
}

export function ffmpegArgs(file, gainDb = 0, trimDb = 0) {
  const gain = (Number(gainDb) || 0) + (Number(trimDb) || 0);
  return [
    '-hide_banner', '-loglevel', 'error',
    '-stream_loop', '-1', '-i', file,
    '-vn', '-af', `loudnorm=I=-24:TP=-2:LRA=11${gain ? `,volume=${gain}dB` : ''},alimiter=limit=0.79:level=disabled`,
    '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', 'pipe:1',
  ];
}

let libs = null;
async function loadLibs(env) {
  if (libs) return libs;
  const voice = await import('@discordjs/voice').catch((err) => {
    throw new Error(`@discordjs/voice is not installed (run npm install): ${err.message}`);
  });
  let ffmpeg = env.AMBIENCE_FFMPEG || null;
  if (!ffmpeg) {
    ffmpeg = await import('ffmpeg-static').then((m) => m.default).catch(() => null);
  }
  libs = { voice, ffmpeg: ffmpeg || 'ffmpeg' };
  return libs;
}

/** Logs in the helper bots that have a token and are in the server. helpers: [{ n, name, token }] */
export async function startHelperClients({ helpers, mainToken, guildId }, log = console.log) {
  // The same token twice (or Snitch's own token) would make two connections fight over one voice slot
  // and the bot would join and leave in a loop.
  const seen = new Set([mainToken]);
  const list = helpers.filter((h) => h.token).filter((h) => {
    if (seen.has(h.token)) {
      log(`[ambience] ignored ${h.name}: its token is a duplicate, or Snitch's own`);
      return false;
    }
    seen.add(h.token);
    return true;
  });
  const out = [];
  for (const { n, name, token } of list) {
    const c = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    c.on('error', (e) => log(`[ambience] ${name} client error: ${e.message}`));
    try {
      await c.login(token);
      await new Promise((res) => (c.isReady() ? res() : c.once(Events.ClientReady, res)));
      if (!(await c.guilds.fetch(guildId).catch(() => null))) {
        log(`[ambience] ${name} is not in the server yet: run "npm run invites"`);
        await c.destroy();
        continue;
      }
      out.push({ name, client: c });
    } catch (err) {
      log(`[ambience] ${name} could not log in: ${err.message}`);
      c.destroy();
    }
  }
  return out;
}

/**
 * One pool entry for a logged-in client. getClient is a function because the main client can be recreated at login.
 * Returns { name, busy, start }.
 */
export function createVoiceEntry({ name, getClient, guildId, env = process.env, log = console.log }) {
  const entry = {
    name,
    busy: false,
    async start(room, channel, assets, onLost) {
      const { voice, ffmpeg } = await loadLibs(env);
      const client = getClient();
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
      const ch = await guild.channels.fetch(channel.id);
      const conn = voice.joinVoiceChannel({ channelId: ch.id, guildId, adapterCreator: guild.voiceAdapterCreator, group: name, selfDeaf: true });
      const player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Play } });
      let ff = null;
      let stopped = false;
      let post = null;
      let noticePost = null;
      let statusSet = false;

      const runs = { fails: 0 };
      let retry = null;
      let run = null; // the current ffmpeg: { startedAt, ended: Promise<exit code>, why() }

      const playOnce = () => {
        if (stopped) return;
        const proc = spawn(ffmpeg, ffmpegArgs(assets.track.path, room.gainDb, env.AMBIENCE_TRIM_DB), { stdio: ['ignore', 'pipe', 'pipe'] });
        ff = proc;
        let err = '';
        proc.stderr.on('data', (d) => (err = (err + d).slice(-400)));
        // Stopping ffmpeg closes its pipes; without these listeners that "error" event would crash the whole bot.
        proc.stdout.on('error', () => {});
        proc.stderr.on('error', () => {});
        const current = { startedAt: Date.now(), why: () => err.trim() };
        current.ended = new Promise((resolve) => {
          proc.on('error', (e) => {
            err = `could not start ffmpeg (${e.message}). Install ffmpeg or run npm install`;
            resolve(-1);
          });
          proc.on('close', (code, signal) => resolve(code ?? (signal ? 0 : -1)));
        });
        run = current;
        player.play(voice.createAudioResource(proc.stdout, { inputType: voice.StreamType.OggOpus }));
      };

      // The track ended or failed: once ffmpeg has finished, play again, wait, or give the room up. Logged once per streak.
      const afterRun = async () => {
        const current = run;
        if (stopped || !current) return;
        const code = await current.ended;
        if (stopped || run !== current || retry) return;
        const next = nextRun(runs, { code, ranMs: Date.now() - current.startedAt });
        if (next.action === 'play') return playOnce();
        if (runs.fails === 1) log(`[ambience] ${name} in ${ch.name}: ffmpeg failed (${code}): ${current.why() || 'no message'}. Retrying with growing waits.`);
        if (next.action === 'wait') {
          retry = setTimeout(() => {
            retry = null;
            playOnce();
          }, next.delayMs);
          return;
        }
        log(`[ambience] ${name} in ${ch.name}: ffmpeg failed ${runs.fails} times in a row, so it leaves the room for now.`);
        await stop();
        onLost();
      };

      const stop = async () => {
        if (stopped) return;
        stopped = true;
        if (retry) clearTimeout(retry);
        try { ff?.kill('SIGKILL'); } catch {}
        try { player.stop(true); } catch {}
        if (noticePost) await noticePost.delete().catch(() => {});
        if (post) await post.delete().catch(() => {});
        if (statusSet) await setStatus(client, ch.id, '').catch(() => {});
        try { conn.destroy(); } catch {}
      };

      try {
        await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 20_000);
        if (ch.type === ChannelType.GuildStageVoice) {
          const me = guild.members.me ?? (await guild.members.fetchMe());
          await me.voice.setSuppressed(false).catch(() => me.voice.setRequestToSpeak(true).catch(() => {}));
        }
        conn.subscribe(player);
        player.on(voice.AudioPlayerStatus.Idle, () => {
          afterRun().catch((e) => log(`[ambience] restart failed: ${e.message}`));
        });
        player.on('error', (e) => log(`[ambience] player error: ${e.message}`));
        playOnce();
      } catch (e) {
        await stop();
        throw new Error(/ready/i.test(e.message) || e.name === 'AbortError' ? 'could not join the voice channel in time (check Connect and Speak permissions)' : e.message);
      }

      conn.on('stateChange', (from, to) => {
        if (stopped || from.status === to.status) return;
        const why = to.closeCode ? ` (close code ${to.closeCode}${to.reason !== undefined ? `, reason ${to.reason}` : ''})` : '';
        log(`[ambience] ${name} in ${ch.name}: ${from.status} -> ${to.status}${why}`);
      });
      conn.on('error', (e) => log(`[ambience] ${name} connection error in ${ch.name}: ${e.message}`));
      conn.on(voice.VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            voice.entersState(conn, voice.VoiceConnectionStatus.Signalling, 5_000),
            voice.entersState(conn, voice.VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          if (!stopped) {
            await stop();
            onLost();
          }
        }
      });

      // The picture and the channel status are extras: a missing permission only skips them.
      if (assets.visual && ch.isTextBased?.()) {
        post = await ch.send({ content: room.caption, files: [new AttachmentBuilder(fs.readFileSync(assets.visual), { name: 'ambience.gif' })], allowedMentions: { parse: [] } }).catch((e) => (log(`[ambience] could not post the picture in ${ch.name}: ${e.message}`), null));
      }
      // The public-voice notice goes right after the picture (or alone, for rooms without one).
      if (assets.notice && ch.isTextBased?.()) {
        noticePost = await ch.send({ content: assets.notice, allowedMentions: { parse: [] } }).catch((e) => (log(`[ambience] could not post the voice notice in ${ch.name}: ${e.message}`), null));
      }
      if (room.status) statusSet = await setStatus(client, ch.id, room.status).then(() => true).catch((e) => (log(`[ambience] could not set the channel status (${e.message}); the bot needs Set Voice Channel Status`), false));

      return { stop };
    },
  };
  return entry;
}

/** Voice channel status (the small line under the channel name). discord.js has no helper for it yet. */
export function setStatus(client, channelId, text) {
  return client.rest.put(`/channels/${channelId}/voice-status`, { body: { status: String(text).slice(0, 500) } });
}

/** Channels the matcher can pair with: voice and stage channels of the guild. */
export function voiceChannels(guild) {
  return [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
    .map((c) => ({ id: c.id, name: c.name, kind: c.type === ChannelType.GuildStageVoice ? 'stage' : 'voice', parentId: c.parentId ?? null }));
}

/**
 * People in a channel, counted from voice states so a member missing from the cache still counts.
 * botIds: ids of Snitch and the helpers. Other bots are skipped when Discord says they are bots.
 */
export function humansInChannel(guild, channelId, botIds = new Set()) {
  let n = 0;
  for (const st of guild.voiceStates.cache.values()) {
    if (st.channelId !== channelId || botIds.has(st.id)) continue;
    if ((st.member?.user ?? guild.client.users.cache.get(st.id))?.bot) continue;
    n++;
  }
  return n;
}
