// Snitch for Magenta Forge. startBot() starts every feature and wires Discord events to the rule modules.
// Import it from a bigger app, or run src/index.mjs on its own. See README.md, "Using the bot inside another app".
import path from 'node:path';
import { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ChannelType, Client, GatewayIntentBits, Partials, StringSelectMenuBuilder, ActivityType } from 'discord.js';
import { createActivity } from './activity.mjs';
import { createAmbience, loadAmbienceConfig, matchRooms } from './ambience.mjs';
import { createVoiceEntry, humansInChannel, setStatus, startHelperClients, voiceChannels } from './ambience-voice.mjs';
import { applyEvent, receiveWebhook, startWebhookServer } from './bmc.mjs';
import { checkOverdue } from './bmc-overdue.mjs';
import { buildCommands } from './commands.mjs';
import { loadConfig, readEnv, ROOT } from './config.mjs';
import { createDiscordCore, createIntroAdapter, createLeagueAdapter, createMirrorAdapter, createProductivityAdapter, createTicketAdapter, mirrorSource, row, upsertPanel } from './discord-adapters.mjs';
import { createElderAdapter } from './discord-elder.mjs';
import { createElderRooms } from './elder-rooms.mjs';
import { linkCodeEmail } from './email.mjs';
import { judgeGrandElderChange } from './grand-elder.mjs';
import { pickerOptions } from './hobbies.mjs';
import { createInteractionRouter } from './interactions.mjs';
import { createIntro } from './intro.mjs';
import { createLeague } from './league.mjs';
import { createLink } from './link.mjs';
import { createMirror } from './mirror.mjs';
import { createPomodoro, loadPomodoroConfig } from './pomodoro.mjs';
import { openStore } from './store.mjs';
import { createSync } from './sync.mjs';
import { createTickets } from './tickets.mjs';
import { TODO_LIMITS } from './todos.mjs';
import { createUnlink } from './unlink.mjs';
import { createVcTools } from './vc-tools.mjs';
import { ensureStaticNotices, VOICE_NOTICE } from './voice-notice.mjs';
import nodemailer from 'nodemailer';

const MIN = 60_000;
const log = (...a) => console.log(new Date().toISOString(), '[bot]', ...a);

/**
 * Logs in and starts everything. Resolves when the bot is ready; rejects with a plain-language message if it cannot start.
 * options:
 *   webhook: true (default) listens on WEBHOOK_PORT. false: the host app takes the Buy Me a Coffee webhook on its own
 *            route and passes it on with bot.receiveBmcWebhook(rawBody, headers).
 *   handleSignals: true (default) shuts down on SIGINT and SIGTERM. false: the host app calls bot.stop().
 * Returns { client, guild, cfg, store, sync, receiveBmcWebhook(rawBody, headers), applyBmcEvent(body), stop }.
 * applyBmcEvent is for a host app that has already checked the delivery itself; receiveBmcWebhook checks the signature.
 */
export async function startBot({ webhook: ownWebhook = true, handleSignals = true } = {}) {
  const fail = (message) => {
    throw new Error(message);
  };
  const env = readEnv();
  if (!env.token) fail('SNITCH_BOT_TOKEN is not set. Paste Snitch\'s token into .env (see README.md).');
  if (!env.guildId) fail('DISCORD_GUILD_ID is not set. Paste the Magenta Forge server ID into .env (see README.md).');
  const cfg = loadConfig();
  cfg.brandColor = env.brandColor;

  const store = openStore(env.dbPath);
  // Ticket transcripts need message text, which is the Message Content Intent. If it is off in the Developer Portal the
  // bot runs without it: transcripts then list who wrote what and when, but not the text.
  const connect = async (contentIntent) => {
    const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages];
    if (contentIntent) intents.push(GatewayIntentBits.MessageContent);
    const client = new Client({ intents, partials: [Partials.Channel, Partials.Message] });
    client.on('error', (err) => log('client error:', err.message));
    const ready = new Promise((resolve) => client.once('clientReady', resolve));
    try {
      await client.login(env.token);
    } catch (err) {
      await client.destroy();
      if (contentIntent && /disallowed intents/i.test(err.message)) {
        log('The Message Content Intent is off in the Developer Portal. Starting without it: ticket transcripts will not include message text until it is on.');
        return connect(false);
      }
      store.close();
      if (/disallowed intents/i.test(err.message)) fail('Discord refused the login: turn on "Server Members Intent" for Snitch in the Developer Portal (Bot tab).');
      fail(`Discord refused the login: ${err.message}. Check SNITCH_BOT_TOKEN in .env.`);
    }
    await ready;
    return { client, contentIntent };
  };
  const { client, contentIntent } = await connect(true);
  try {
    return await start({ env, cfg, store, client, contentIntent, ownWebhook, handleSignals, fail });
  } catch (err) {
    // Wrong server name and the like: leave nothing logged in or open behind.
    await client.destroy().catch(() => {});
    store.close();
    throw err;
  }
}

async function start({ env, cfg, store, client, contentIntent, ownWebhook, handleSignals, fail }) {
  const guild = await client.guilds.fetch(env.guildId).catch(() => null);
  if (!guild) fail(`Snitch is not in server ${env.guildId}. Run "npm run invites" to get its invite link.`);
  if (guild.name !== env.guildName) fail(`Server ${env.guildId} is called "${guild.name}", not "${env.guildName}". Check DISCORD_GUILD_ID so the bot never touches the wrong server.`);
  await guild.channels.fetch();
  await guild.members.fetchMe();
  log(`logged in as ${client.user.tag} on ${guild.name}`);

  const core = createDiscordCore({ client, guild, cfg, store });
  const sync = createSync({ cfg, store, discord: core.discord, env });

  const transporter = env.smtp.host ? nodemailer.createTransport({ host: env.smtp.host, port: env.smtp.port, secure: env.smtp.port === 465, auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined }) : null;
  const link = createLink({
    cfg,
    store,
    sync,
    lx: {
      smtpOn: Boolean(transporter),
      sendCode: (email, code) => transporter.sendMail({ from: env.smtp.from || env.smtp.user, to: email, ...linkCodeEmail({ code, brandColor: env.brandColor, links: env }) }),
      reviewRequest: ({ id, userId, maskedEmail, levelName, supporterName }) =>
        core.post(cfg.channels.modLog, `🔗 <@${userId}> asks to link a membership.\nEmail: ${maskedEmail}\nLevel: ${levelName ?? 'unknown'}\nSupporter name: ${supporterName ?? 'unknown'}\nCheck them against the Buy Me a Coffee dashboard, or ask in a ticket before approving.`, {
          components: [row(new ButtonBuilder().setCustomId(`link:approve:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`link:decline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger))],
        }),
      dm: core.dm,
    },
  });

  const tickets = createTickets({ cfg, store, tk: { ...createTicketAdapter({ guild, cfg, core }), contentAvailable: contentIntent } });
  const intro = createIntro({ cfg, store, ix: createIntroAdapter({ guild, cfg, core, store }), sync });
  const unlink = createUnlink({ cfg, store, sync, discord: core.discord });
  const league = cfg.league?.teams?.length ? createLeague({ cfg, store, lg: createLeagueAdapter({ client, guild, cfg, store }), log: (m) => log('league:', m) }) : null;

  // Ambience and its pool of helper bots. A missing voice library only turns ambience off, never the rest of the bot.
  const getClient = () => client;
  const getGuild = () => guild;
  let ambience = null;
  let helpers = [];
  const botIds = () => new Set([client.user.id, ...helpers.map((h) => h.client.user.id)]);
  const pd = { ...createProductivityAdapter({ client, guild }), setStatus: (channelId, text) => setStatus(client, channelId, text) };
  const ambienceConfig = loadAmbienceConfig();
  const ambienceChannels = () => voiceChannels(guild).map((c) => ({ ...c, ignore: c.id === cfg.elder.lobbyChannelId || Boolean(store.elderRoomByChannel(c.id)) }));
  if (env.ambienceOn && ambienceConfig.enabled) {
    helpers = await startHelperClients({ helpers: env.helpers, mainToken: env.token, guildId: env.guildId }, (t) => log(t));
    ambience = createAmbience({
      config: ambienceConfig,
      pool: helpers.map((h) => createVoiceEntry({ name: h.name, getClient: () => h.client, guildId: env.guildId, log: (t) => log(t) })),
      humansIn: (id) => humansInChannel(guild, id, botIds()),
      channels: ambienceChannels,
      // Every room gets the "voices here are public" notice. The Elder category is for verified elders only.
      notice: (channel) => (cfg.elder.categoryId && channel.parentId === cfg.elder.categoryId ? null : VOICE_NOTICE),
      log: (t) => log('ambience:', t),
    });
    ambience.scan();
    log(`ambience: ${helpers.length} of ${env.helpers.length} helper bots ready`);
  }
  const ambienceRoomIds = new Set(ambience ? [...matchRooms(ambienceConfig.rooms, ambienceChannels()).keys()] : []);

  // Productivity.
  const pomodoro = createPomodoro({ config: loadPomodoroConfig(path.join(ROOT, 'config', 'pomodoro.json')), store, pd, ambience: () => ambience, log: (m) => log('pomodoro:', m) });
  const vcTools = createVcTools({ store, pd, pomodoro, ambience: () => ambience, log: (m) => log('vc:', m) });
  const elderRooms = createElderRooms({ cfg, store, dc: createElderAdapter({ getClient, getGuild, cfg }), log: (m) => log('rooms:', m) });

  // Gate copies of #rules and #announcements.
  const mirror = createMirror({ mirrors: cfg.mirrors ?? {}, store, mx: createMirrorAdapter({ guild }), log: (m) => log('mirror:', m) });

  const activity = createActivity({ store });

  async function forgetMe(userId) {
    await intro.withdraw(userId);
    const open = store.openTicketFor(userId);
    store.forget(userId);
    const gm = await guild.members.fetch(userId).catch(() => null);
    if (gm) {
      const remove = [...cfg.tiers.flatMap((t) => [t.roleId, t.accessRoleId]), cfg.tourist?.roleId, cfg.elder?.roleId, cfg.roles?.verified, ...(cfg.hobbies ?? []).map((h) => h.roleId)].filter((id) => id && gm.roles.cache.has(id));
      // Staff keep what lets them work.
      const staff = (cfg.staffRoleIds ?? []).some((id) => gm.roles.cache.has(id));
      for (const r of remove) if (!(staff && r === cfg.roles?.verified)) await gm.roles.remove(r, 'Member used /forget-me').catch(() => {});
    }
    if (open) log(`member used /forget-me with an open ticket in ${open.channel_id}`);
    core.modLog(`A member used /forget-me: their data was deleted.`).catch(() => {});
  }

  const route = createInteractionRouter({ cfg, env, store, sync, tickets, intro, league, pomodoro, vcTools, unlink, link, elderRooms, ambience, guild, core, forgetMe, log: (m) => log(m) });
  for (const [from, to] of Object.entries(cfg.league?.renameKeys ?? {})) store.leagueRenameTeam(from, to);
  client.on('interactionCreate', route);

  // Register commands on this server only, and clear out any global ones this app no longer needs here.
  await guild.commands.set(buildCommands(cfg));
  log('slash commands registered');

  // Panels: the bot keeps one message in each of these channels.
  const M = (name) => `⁣${name}⁣ `; // an invisible mark so the bot finds its own message again
  await upsertPanel({
    client, guild, channelId: cfg.channels.verificationHelp, marker: M('v'), log,
    payload: {
      content: `**Welcome to the gate of Magenta Forge.** The server opens once a mod has read your intro.\n\n📝 **Send my intro**: the free way in as a ${cfg.tourist.name}. Only the mods read it.\n☕ **Link my membership**: supporters from ${env.bmcUrl} go straight in.\n🛟 **Ask for help**: a private chat with the staff.\n\nRead #gate-rules first. You will not see other members from here: that is on purpose, to protect everyone's privacy.`,
      components: [row(new ButtonBuilder().setCustomId('panel:intro').setLabel('Send my intro').setEmoji('📝').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('panel:link').setLabel('Link my membership').setEmoji('☕').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('panel:ticket').setLabel('Ask for help').setEmoji('🛟').setStyle(ButtonStyle.Secondary))],
    },
  });
  await upsertPanel({
    client, guild, channelId: cfg.channels.ticketDesk, marker: M('t'), log,
    payload: {
      content: '**Need the staff?** Press the button for a private channel only you and the mods can see. Report unsolicited DMs here.',
      components: [row(new ButtonBuilder().setCustomId('panel:ticket').setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary))],
    },
  });
  const options = pickerOptions(cfg);
  if (options.length) {
    await upsertPanel({
      client, guild, channelId: cfg.channels.college, marker: M('h'), log,
      payload: {
        content: '**Pick your stream pings and interests.** Choosing again replaces your choice; clear them all to stop the pings.',
        components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('hobbies:pick').setPlaceholder('Choose what you want').setMinValues(0).setMaxValues(options.length).addOptions(options))],
      },
    });
  }

  // Public-voice notice in rooms with no ambient sound (rooms with sound get it from the ambience session).
  await ensureStaticNotices({ client, guild, categoryIds: cfg.voiceNotice?.categoryIds ?? [], skipIds: ambienceRoomIds, log: (m) => log(m) });

  await pomodoro.recover().catch((err) => log('pomodoro recover:', err.message));
  await elderRooms.cleanup().then(() => elderRooms.scan()).catch((err) => log('room cleanup:', err.message));
  const copied = await mirror.backfill();
  if (copied) log(`copied ${copied} message(s) to the gate channels`);

  // Discord events. Everything is limited to this server: Snitch may be in others.
  client.on('messageCreate', async (msg) => {
    try {
      if (!msg.guildId) return await directMessage(msg);
      if (msg.guildId !== cfg.guildId) return;
      if (cfg.mirrors?.[msg.channelId]) await mirror.posted(mirrorSource(msg));
      if (!msg.author.bot && !msg.system && !msg.webhookId) activity.message(msg.author.id);
    } catch (err) {
      log('message handler:', err.message);
    }
  });
  client.on('messageUpdate', async (_, msg) => {
    if (msg.guildId !== cfg.guildId || !cfg.mirrors?.[msg.channelId]) return;
    try {
      const full = msg.partial ? await msg.fetch() : msg;
      await mirror.edited(mirrorSource(full));
    } catch (err) {
      log('mirror edit:', err.message);
    }
  });
  client.on('messageDelete', (msg) => {
    if (msg.guildId === cfg.guildId) mirror.deleted(msg.channelId, msg.id).catch((err) => log('mirror delete:', err.message));
  });

  const lastDm = new Map();
  async function directMessage(msg) {
    if (msg.author.bot) return;
    const at = Date.now();
    if (at - (lastDm.get(msg.author.id) ?? 0) < 3000) return; // ignore floods
    lastDm.set(msg.author.id, at);
    if (lastDm.size > 500) for (const [k, t] of lastDm) if (at - t > 60_000) lastDm.delete(k);
    // Someone who is not in this server is another server's business.
    const inServer = await guild.members.fetch(msg.author.id).catch(() => null);
    if (!inServer) return;
    const reply = await intro.dm({ userId: msg.author.id, text: msg.content });
    if (reply) await msg.channel.send({ content: reply, allowedMentions: { parse: [] } });
  }

  client.on('guildMemberAdd', async (m) => {
    if (m.guild.id !== cfg.guildId || m.user.bot) return;
    await sync.syncMember(m.id, 'joined').catch((err) => log('join sync:', err.message));
    const known = store.member(m.id);
    if (!known?.tourist_since && !known?.email) {
      await core.dm(m.id, `Welcome to Magenta Forge! The server opens once a mod has read your intro.\n\n${intro.help()}`);
    }
  });

  // Staff and Grand Elders are given their roles by hand, so they get the verified role here.
  client.on('guildMemberUpdate', async (before, after) => {
    if (after.guild.id !== cfg.guildId) return;
    const was = before.communicationDisabledUntilTimestamp ?? 0;
    const is = after.communicationDisabledUntilTimestamp ?? 0;
    if (is > Date.now() && is !== was) store.strikeAdd(after.id, 'timeout'); // a moderation action, for the Elder rule
    const needsVerified = [...(cfg.staffRoleIds ?? []), cfg.roles?.grandElder, cfg.league?.commissionerRoleId].some((id) => id && after.roles.cache.has(id));
    if (needsVerified && cfg.roles?.verified && !after.roles.cache.has(cfg.roles.verified)) await after.roles.add(cfg.roles.verified, 'Holds a role given by an admin').catch((err) => log('verified role:', err.message));
    await guardGrandElder(before, after).catch((err) => log('Grand Elder check:', err.message));
  });

  // Only the server owner gives or takes Grand Elder. Anyone else's change is undone and reported in #mod-log.
  async function guardGrandElder(before, after) {
    const roleId = cfg.roles?.grandElder;
    if (!roleId || before.partial) return;
    const had = before.roles.cache.has(roleId);
    const has = after.roles.cache.has(roleId);
    if (had === has) return;
    await new Promise((r) => setTimeout(r, 1500)); // the audit log entry can arrive a moment after the change
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 10 });
    const key = has ? '$add' : '$remove';
    const entry = logs.entries.find((e) => e.targetId === after.id && Date.now() - e.createdTimestamp < 30_000 && e.changes.some((c) => c.key === key && c.new?.some?.((r) => r.id === roleId)));
    const verdict = judgeGrandElderChange({ executorId: entry?.executorId ?? null, ownerId: guild.ownerId, botId: client.user.id });
    if (verdict === 'allow') return;
    if (verdict === 'unknown') return void core.modLog(`⚠️ Grand Elder was ${has ? 'given to' : 'taken from'} <@${after.id}>, and the audit log does not say by whom. Only the owner should change it.`).catch(() => {});
    if (has) await after.roles.remove(roleId, 'Only the server owner gives Grand Elder');
    else await after.roles.add(roleId, 'Only the server owner takes Grand Elder away');
    core.modLog(`🛡️ <@${entry.executorId}> ${has ? 'gave' : 'took'} Grand Elder ${has ? 'to' : 'from'} <@${after.id}>. Only the owner can do that, so it was undone.`).catch(() => {});
  }

  client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.guild.id !== cfg.guildId) return;
    const from = oldState.channelId;
    const to = newState.channelId;
    const member = newState.member;
    if (from === to) return;
    try {
      for (const id of [from, to]) {
        if (!id) continue;
        elderRooms.roomChanged(id);
        ambience?.evaluate(id);
      }
      if (member?.user?.bot) return;
      if (to && to === cfg.elder.lobbyChannelId) await elderRooms.lobbyJoin({ userId: newState.id, displayName: member?.displayName, roleIds: new Set(member?.roles?.cache?.keys() ?? []) });
      await pomodoro.voiceChanged({ userId: newState.id, from, to });
      if (from && pd.humans(from).length === 0) await vcTools.channelEmpty(from);
    } catch (err) {
      log('voice handler:', err.message);
    }
  });

  // A voice channel staff add to the Elder category gets the private-room notice too (the wait lets the bot's own rooms post theirs first).
  client.on('channelCreate', (channel) => {
    if (channel.guildId !== cfg.guildId || !cfg.elder.categoryId || channel.parentId !== cfg.elder.categoryId || channel.type !== ChannelType.GuildVoice) return;
    setTimeout(() => elderRooms.noteIfMissing(channel.id).catch(() => {}), 5000);
  });

  // Webhook and timers.
  const webhookOptions = { secret: env.webhookSecret, store, sync, acceptTest: env.acceptTestWebhooks, log };
  const webhook = ownWebhook ? startWebhookServer({ port: env.webhookPort, ...webhookOptions }) : null;
  if (!env.webhookSecret) log('BMC_WEBHOOK_SECRET is not set: Buy Me a Coffee events are refused until it is.');

  const timers = [];
  const every = (ms, what, fn) => timers.push(setInterval(() => Promise.resolve().then(fn).catch((err) => log(`${what}:`, err.message)), ms));
  every(MIN, 'tick', async () => {
    // One minute of voice per person, except in the AFK channel. Flushed with the messages below.
    for (const v of guild.voiceStates.cache.values()) if (v.channelId && !botIds().has(v.id) && !v.member?.user?.bot && v.channelId !== guild.afkChannelId) activity.voiceMinute(v.id);
    await league?.tick();
  });
  every(5 * MIN, 'activity', () => activity.flush());
  every(15 * MIN, 'sweep', () => sync.syncAll('sweep'));
  const checkBmc = async () => {
    const r = await checkOverdue({ store, sync, autoLapse: env.lapseWithoutRenewal, post: (t) => core.post(cfg.channels.modLog, t).catch(() => {}) });
    if (r.flagged || r.lapsed) log('Buy Me a Coffee overdue check', JSON.stringify(r));
  };
  every(60 * MIN, 'Buy Me a Coffee overdue check', checkBmc);
  checkBmc().catch((err) => log('Buy Me a Coffee overdue check:', err.message));
  every(6 * 60 * MIN, 'tidy', async () => {
    activity.expire();
    store.todoExpire(TODO_LIMITS.personalDays, TODO_LIMITS.roomDays);
    store.linkExpire();
    await intro.expire();
  });
  activity.expire();
  await intro.expire().catch((err) => log('intro expire:', err.message));
  await sync.syncAll('startup');
  client.user.setActivity('the Magenta Forge', { type: ActivityType.Watching });
  core.post(cfg.channels.botLog, 'Snitch is online.').catch(() => {});
  log('ready');

  let closing = false;
  const stop = async (why = 'stop') => {
    if (closing) return;
    closing = true;
    log(`${why}: shutting down`);
    timers.forEach(clearInterval);
    activity.flush();
    await pomodoro.stopAll().catch(() => {});
    await ambience?.stopAll().catch(() => {});
    for (const h of helpers) await h.client.destroy();
    webhook?.close();
    await client.destroy();
    store.close();
  };
  if (handleSignals) {
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(sig).then(() => process.exit(0)));
  }

  return {
    client,
    guild,
    cfg,
    store,
    sync,
    stop,
    /** For a host app's own route: pass the unparsed body and the headers, and answer with the status and text returned. */
    receiveBmcWebhook: (rawBody, headers) => receiveWebhook(rawBody, headers, webhookOptions),
    applyBmcEvent: (body) => applyEvent(body, { store, sync, acceptTest: env.acceptTestWebhooks, log: (m) => log(`[bmc] ${m}`) }),
  };
}
