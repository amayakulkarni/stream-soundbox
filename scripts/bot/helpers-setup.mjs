// Checks and prepares the Snitch Helper bots that let several voice rooms play ambient sound at once.
//
//   npm run invites                                      prints each bot's invite link
//   npm run helpers:setup                                shows rooms, bots and missing invites, and gives helpers their role
//   npm run helpers:setup -- --tokens-file t.txt         reads helper tokens (one per line, in order) and validates them
//   npm run helpers:setup -- --tokens-file t.txt --write-env
//                                                        also writes them to .env as SNITCH_HELPER_n_TOKEN (a .bak copy is kept)
//
// Discord does not let a program create a bot application (that is only possible by hand in the Developer Portal), and
// only a person can press Authorize on an invite. This script automates everything around that.
import fs from 'node:fs';
import path from 'node:path';
import { PermissionFlagsBits as P, PermissionsBitField, REST, Routes } from 'discord.js';
import { loadAmbienceConfig, matchRooms } from '../../src/bot/ambience.mjs';
import { IDS_FILE, ROOT, readEnv } from '../../src/bot/config.mjs';

/** What a helper needs on the voice channels. */
export const HELPER_PERMISSIONS = new PermissionsBitField([P.ViewChannel, P.Connect, P.Speak, P.SendMessages, P.AttachFiles, P.ReadMessageHistory, P.SetVoiceChannelStatus]);
export const mask = (t) => `${t.slice(0, 6)}…${t.slice(-4)}`;

/** A bot token's first part is its client ID, in base64. */
export const idFromToken = (token) => {
  try {
    return Buffer.from(String(token).split('.')[0], 'base64').toString('utf8').match(/^\d{15,25}$/)?.[0] ?? '';
  } catch {
    return '';
  }
};
const invite = (clientId, guildId, perms, scope = 'bot') =>
  `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: clientId, scope, permissions: String(new PermissionsBitField(perms).bitfield), ...(guildId ? { guild_id: guildId, disable_guild_select: 'true' } : {}) })}`;

/** Replaces or adds KEY=value in env-file text. */
export function setEnvLine(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
}

function printInvites(env) {
  console.log('Open each link while signed in as the server owner, then press Authorize.\n');
  const snitchId = env.clientId || idFromToken(env.token);
  console.log(snitchId ? `Snitch:\n  ${invite(snitchId, env.guildId, [P.Administrator], 'bot applications.commands')}` : 'Snitch: put SNITCH_CLIENT_ID or SNITCH_BOT_TOKEN in .env to get its link.');
  for (const h of env.helpers) {
    const id = h.clientId || idFromToken(h.token);
    console.log(id ? `${h.name}:\n  ${invite(id, env.guildId, HELPER_PERMISSIONS)}` : `${h.name}: put SNITCH_HELPER_${h.n}_CLIENT_ID or its token in .env to get its link.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const env = readEnv();
  if (args.includes('--invites')) return printInvites(env);
  const fileArg = args.includes('--tokens-file') ? args[args.indexOf('--tokens-file') + 1] : null;
  const fromFile = fileArg ? fs.readFileSync(fileArg, 'utf8').split(/\r?\n/).map((t) => t.trim()).filter((t) => t && !t.startsWith('#')) : null;
  const tokens = fromFile ? [...new Set(fromFile)].filter((t) => t !== env.token) : null;

  if (fromFile && tokens.length !== fromFile.length) console.log(`Ignored ${fromFile.length - tokens.length} duplicate token(s), or Snitch's own token.`);
  if (tokens && tokens.length > env.helpers.length) throw new Error(`There are ${env.helpers.length} helper slots but ${tokens.length} tokens.`);

  if (args.includes('--write-env')) {
    if (!tokens) throw new Error('--write-env needs --tokens-file.');
    const target = path.join(ROOT, '.env');
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (before) fs.writeFileSync(`${target}.bak`, before);
    let text = before;
    tokens.forEach((t, i) => (text = setEnvLine(text, `SNITCH_HELPER_${i + 1}_TOKEN`, t)));
    fs.writeFileSync(target, text);
    console.log(`Wrote ${tokens.length} token(s) to .env (the previous file is kept as .env.bak, which git ignores). Delete ${path.basename(fileArg)} now.`);
  }

  const list = tokens ? tokens.map((token, i) => ({ n: i + 1, name: `Snitch Helper ${i + 1}`, token })) : env.helpers;
  if (!env.token || !env.guildId) {
    console.error('\nSNITCH_BOT_TOKEN and DISCORD_GUILD_ID are needed to check the server.');
    process.exitCode = 1;
    return;
  }
  const rest = new REST({ version: '10' }).setToken(env.token);
  const guild = await rest.get(Routes.guild(env.guildId));
  if (guild.name !== env.guildName) throw new Error(`Server ${env.guildId} is called "${guild.name}", not "${env.guildName}". Nothing was changed.`);

  const channels = (await rest.get(Routes.guildChannels(env.guildId))).filter((c) => c.type === 2 || c.type === 13);
  const rooms = matchRooms(loadAmbienceConfig().rooms, channels.map((c) => ({ id: c.id, name: c.name, kind: c.type === 13 ? 'stage' : 'voice', parentId: c.parent_id })));
  console.log(`Rooms that can play ambient sound: ${rooms.size}. One bot sits in one room, so every room sounding at once takes ${rooms.size} helper(s).`);

  const roleId = fs.existsSync(IDS_FILE) ? JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')).roles?.ambience : null;
  if (!roleId) console.log('The Forge Ambience role does not exist yet: run "npm run setup:apply", then run this again.');
  let ready = 0;
  for (const h of list) {
    if (!h.token) {
      console.log(`  - ${h.name}: no token (SNITCH_HELPER_${h.n}_TOKEN)`);
      continue;
    }
    try {
      const me = await new REST({ version: '10' }).setToken(h.token).get(Routes.user('@me'));
      const inServer = await rest.get(Routes.guildMember(env.guildId, me.id)).then(() => true, () => false);
      if (!inServer) {
        console.log(`  ! ${h.name}: not in the server yet. Invite: ${invite(me.id, env.guildId, HELPER_PERMISSIONS)}`);
        continue;
      }
      if (roleId) await rest.put(Routes.guildMemberRole(env.guildId, me.id, roleId), { reason: 'Ambience helper' });
      ready++;
      console.log(`  ✓ ${h.name}: ready (${me.username})`);
    } catch (err) {
      console.log(`  ✗ ${mask(h.token)}: ${err.status === 401 ? 'Discord rejected this token (401)' : err.message}`);
    }
  }
  console.log(`\n${ready} of ${list.length} helpers are ready. Sounds: npm run ambience:generate. Then restart the bot.`);
}

main().catch((err) => {
  console.error(`[helpers] ${err.message}`);
  process.exit(1);
});
