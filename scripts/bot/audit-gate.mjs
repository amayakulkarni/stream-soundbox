// npm run audit:gate: read-only check that people who are not verified cannot see members. Changes nothing.
import { Client, GatewayIntentBits } from 'discord.js';
import { loadConfig, readEnv } from '../../src/bot/config.mjs';
import { auditGate, printAudit } from './audit-lib.mjs';

const env = readEnv();
const ids = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
await client.login(env.token);
await new Promise((resolve) => (client.isReady() ? resolve() : client.once('clientReady', resolve)));
const guild = await client.guilds.fetch(env.guildId);
await guild.channels.fetch();
await guild.members.fetch();
const audit = auditGate(guild, ids);
printAudit(audit);
process.exitCode = audit.leaks.length ? 1 : 0;
await client.destroy();
