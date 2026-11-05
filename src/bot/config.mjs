// Reads .env and config/discord-tiers.json (written by the setup script) into one config object.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** The app's folder: the nearest package.json above this file, so the bot works wherever these files are moved to. */
function findRoot(start) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (dir === path.dirname(dir)) return start;
  }
}
export const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

export const TIER_COUNT = 5;
export const HELPER_COUNT = 10;
export const TEMPLATE_FILE = path.join(ROOT, 'config', 'server-template.json');
export const IDS_FILE = path.join(ROOT, 'config', 'discord-tiers.json');

/** True for an empty value or one of the PUT_... placeholders shipped in .env. */
export const isPlaceholder = (v) => !v || /^PUT_/i.test(String(v).trim());
const val = (env, key) => (isPlaceholder(env[key]) ? '' : String(env[key]).trim());
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter((s) => s && !isPlaceholder(s));

export const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The Buy Me a Coffee tiers from .env, cheapest first. A higher rank is a higher tier. */
export function tiersFromEnv(env = process.env) {
  const tiers = [];
  for (let n = 1; n <= TIER_COUNT; n++) {
    const name = val(env, `TIER_${n}_NAME`);
    if (!name) throw new Error(`TIER_${n}_NAME is missing from .env.`);
    tiers.push({
      n,
      slug: val(env, `TIER_${n}_SLUG`) || slugify(name),
      name,
      price: val(env, `TIER_${n}_PRICE`),
      perks: val(env, `TIER_${n}_PERKS`),
      rank: n,
      bmcLevels: [name.toLowerCase()],
      bmcLevelIds: list(env[`TIER_${n}_BMC_ID`]),
    });
  }
  return tiers;
}

export function readEnv(env = process.env) {
  const helpers = [];
  for (let n = 1; n <= HELPER_COUNT; n++) {
    helpers.push({ n, name: `Snitch Helper ${n}`, token: val(env, `SNITCH_HELPER_${n}_TOKEN`), clientId: val(env, `SNITCH_HELPER_${n}_CLIENT_ID`) });
  }
  const bmcUrl = val(env, 'BMC_URL') || 'https://buymeacoffee.com/amayakulkarni';
  return {
    token: val(env, 'SNITCH_BOT_TOKEN') || val(env, 'DISCORD_BOT_TOKEN'),
    clientId: val(env, 'SNITCH_CLIENT_ID'),
    guildId: val(env, 'DISCORD_GUILD_ID'),
    guildName: val(env, 'DISCORD_GUILD_NAME') || 'Magenta Forge',
    helpers,
    dbPath: val(env, 'DB_PATH') || path.join(ROOT, 'data', 'magenta-forge.db'),
    brandColor: val(env, 'BRAND_COLOR') || '#ff267c',
    touristName: val(env, 'TOURIST_NAME') || 'Visitor',
    bmcUrl,
    renewUrl: val(env, 'BMC_RENEW_URL') || `${bmcUrl.replace(/\/$/, '')}/membership`,
    twitchUrl: val(env, 'TWITCH_URL') || 'https://twitch.tv/amaya.kulkarni',
    youtubeUrl: val(env, 'YOUTUBE_URL') || 'https://youtube.com/@Amaya.Kulkarni',
    webhookPort: Number(val(env, 'WEBHOOK_PORT') || 8787),
    webhookSecret: val(env, 'BMC_WEBHOOK_SECRET'),
    bmcApiToken: val(env, 'BMC_API_TOKEN'),
    bmcApiUrl: (val(env, 'BMC_API_URL') || 'https://developers.buymeacoffee.com/api/v1').replace(/\/$/, ''),
    elderRequireEmail: !['off', 'false', '0', 'no'].includes(String(env.ELDER_REQUIRE_EMAIL ?? 'on').toLowerCase()),
    acceptTestWebhooks: ['on', 'true', '1', 'yes'].includes(String(env.BMC_ACCEPT_TEST_EVENTS ?? '').toLowerCase()),
    smtp: {
      host: val(env, 'SMTP_HOST'),
      port: Number(val(env, 'SMTP_PORT') || 587),
      user: val(env, 'SMTP_USER'),
      pass: val(env, 'SMTP_PASS'),
      from: val(env, 'SMTP_FROM'),
    },
    ambienceOn: !['off', 'false', '0', 'no'].includes(String(env.AMBIENCE ?? 'on').toLowerCase()),
  };
}

/** The whole bot config: IDs from setup, tier names and Buy Me a Coffee IDs from .env (so renaming needs no re-setup). */
export function loadConfig(env = process.env, file = IDS_FILE) {
  let ids;
  try {
    ids = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${path.basename(file)} is missing. Run "npm run setup:apply" first.`);
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  return mergeConfig(ids, tiersFromEnv(env), readEnv(env));
}

export function mergeConfig(ids, envTiers, e) {
  const tiers = envTiers.map((t) => {
    const stored = (ids.tiers ?? []).find((x) => x.n === t.n) ?? {};
    return { ...t, roleId: stored.roleId ?? '', accessRoleId: stored.accessRoleId ?? '' };
  });
  return {
    ...ids,
    guildId: e.guildId || ids.guildId,
    tiers,
    unknownLevelTier: tiers[0]?.slug,
    tourist: { ...ids.tourist, name: e.touristName },
    elder: { ...ids.elder, requireEmail: e.elderRequireEmail },
  };
}
