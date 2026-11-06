#!/usr/bin/env node
// Posts the Magenta Forge channel content (content/*.md) as Snitch, as magenta embeds.
//
//   node publish.mjs                      dry run: shows what would be posted where, changes nothing
//   node publish.mjs --only rules         dry run for one channel (repeat --only for more)
//   node publish.mjs --publish            posts for real; a second run edits the same messages instead of reposting
//   node publish.mjs --publish --repost   deletes the earlier posts and posts again
//
// Content files: front matter (channel, pin) and then messages separated by a line `<!-- next -->`. Each message
// starts with `# Title`. {{PLACEHOLDERS}} are filled from the environment (.env / .env.local); a run that would post
// an unfilled placeholder stops. Channels are found by name, ignoring emoji, case, spaces and dashes, so
// "#the-forge-general" matches "💜the-forge-general". Every channel with a matching name gets the
// post; channelId: 1,2 in front matter pins exact IDs. #gate-rules and #gate-announcements never match: Snitch mirrors into them. The message IDs of a real run go into .publish-state.json.
// Needs Node 20.12 or newer. No packages to install.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
for (const file of [process.env.BOT_ENV_FILE, '.env.local', '.env'].filter(Boolean)) {
  try { process.loadEnvFile(file); } catch {}
}

const args = process.argv.slice(2);
const live = args.includes('--publish');
const repost = args.includes('--repost');
const only = args.flatMap((a, i) => (a === '--only' ? [args[i + 1]] : []));
const contentDir = path.resolve(process.env.CONTENT_DIR || path.join(here, 'content'));
const stateFile = path.resolve(process.env.PUBLISH_STATE_FILE || path.join(here, '.publish-state.json'));
const token = process.env.SNITCH_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || '';
const guildId = process.env.DISCORD_GUILD_ID || '';
const color = parseInt(String(process.env.BRAND_COLOR || '#ff267c').replace('#', ''), 16);
const footer = process.env.SERVER_NAME || 'Magenta Forge';
const API = 'https://discord.com/api/v10';

export const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

export function parseFile(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = Object.fromEntries(m[1].split(/\r?\n/).map((l) => l.split(/:\s*/, 2)).filter(([k]) => k).map(([k, v = '']) => [k.trim(), v.trim()]));
  const messages = m[2].split(/^<!--\s*next\s*-->\s*$/m).map((block) => {
    const b = block.trim();
    const t = /^#\s+(.+)\r?\n?/.exec(b);
    return { title: t ? t[1].trim() : '', body: (t ? b.slice(t[0].length) : b).trim() };
  });
  return { file, channel: meta.channel, channelId: meta.channelId || '', pin: meta.pin === 'true', messages };
}

export function fill(text, env = process.env) {
  const missing = new Set();
  const out = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (all, key) => {
    const v = env[key];
    if (v == null || v === '') { missing.add(key); return all; }
    return v.replace(/\\n/g, '\n');
  });
  return { out, missing: [...missing] };
}

async function api(method, route, body) {
  for (let tries = 0; tries < 5; tries++) {
    const res = await fetch(API + route, {
      method,
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'MagentaForgePublisher (local, 1.0)' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = Number((await res.json().catch(() => ({}))).retry_after || 1);
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
      continue;
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(`${method} ${route} → ${res.status} ${data?.message || ''}`); e.status = res.status; throw e; }
    return data;
  }
  throw new Error(`${method} ${route} → still rate limited`);
}

async function main() {
  const files = fs.readdirSync(contentDir).filter((f) => f.endsWith('.md')).sort();
  const docs = files.map((f) => parseFile(fs.readFileSync(path.join(contentDir, f), 'utf8'), f))
    .filter((d) => !only.length || only.some((o) => norm(o) === norm(d.channel)));
  if (!docs.length) throw new Error('No content matched.');

  // Fill placeholders and check Discord's limits before touching anything.
  const problems = [];
  for (const d of docs) {
    d.messages = d.messages.map((msg, i) => {
      const t = fill(msg.title), b = fill(msg.body);
      for (const k of [...t.missing, ...b.missing]) problems.push(`${d.file} message ${i + 1}: {{${k}}} is not set`);
      if (t.out.length > 256) problems.push(`${d.file} message ${i + 1}: title is ${t.out.length} characters (max 256)`);
      if (b.out.length > 4096) problems.push(`${d.file} message ${i + 1}: text is ${b.out.length} characters (max 4096)`);
      return { title: t.out, body: b.out };
    });
  }

  let channels = [];
  if (token && guildId) channels = await api('GET', `/guilds/${guildId}/channels`);
  else if (live) throw new Error('Set SNITCH_BOT_TOKEN and DISCORD_GUILD_ID to publish.');
  for (const d of docs) {
    // channelId (comma-separated IDs) picks exact channels; otherwise every channel with the name gets the post,
    // (gate-* copies have other names and are filled by the bot's mirror, not here).
    const ids = d.channelId.split(',').map((x) => x.trim()).filter(Boolean);
    d.targets = ids.length
      ? channels.filter((c) => ids.includes(c.id))
      : channels.filter((c) => [0, 2, 5, 13].includes(c.type) && norm(c.name) === norm(d.channel));
    if (channels.length && !d.targets.length) problems.push(`${d.file}: no channel ${ids.length ? `with ID ${ids.join(', ')}` : `named "${d.channel}"`} on the server`);
  }

  for (const d of docs) {
    const where = d.targets.length ? d.targets.map((c) => `${c.name} (${c.id})`).join(' + ') : '(not checked: no token)';
    console.log(`\n=== #${d.channel} → ${where}${d.pin ? ', pinned' : ''}`);
    d.messages.forEach((m, i) => console.log(`--- message ${i + 1}: ${m.title}\n${m.body}`));
  }
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    if (live) throw new Error('Nothing was posted. Fix the problems above first.');
  }
  if (!live) { console.log('\nDry run: nothing was posted. Add --publish to post.'); return; }

  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  for (const d of docs) {
    for (const target of d.targets) {
      const key = `${norm(d.channel)}:${target.id}`;
      const old = state[key]?.messageIds || [];
      if (repost) for (const id of old) await api('DELETE', `/channels/${target.id}/messages/${id}`).catch(() => {});
      const ids = [];
      for (const [i, m] of d.messages.entries()) {
        const payload = {
          embeds: [{ title: m.title || undefined, description: m.body, color, footer: { text: footer } }],
          allowed_mentions: { parse: [] },
        };
        let msg = null;
        if (!repost && old[i]) msg = await api('PATCH', `/channels/${target.id}/messages/${old[i]}`, payload).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
        msg ||= await api('POST', `/channels/${target.id}/messages`, payload);
        if (d.pin && i === 0) await api('PUT', `/channels/${target.id}/pins/${msg.id}`).catch((e) => console.warn(`Could not pin in ${target.name}: ${e.message}`));
        ids.push(msg.id);
      }
      // Messages that the content no longer has are removed.
      if (!repost) for (const id of old.slice(d.messages.length)) await api('DELETE', `/channels/${target.id}/messages/${id}`).catch(() => {});
      state[key] = { channelId: target.id, messageIds: ids, at: new Date().toISOString() };
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      console.log(`Posted #${d.channel} in ${target.name} (${target.id}): ${ids.length} message(s).`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
