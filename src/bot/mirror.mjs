// Keeps the gate copies of #rules and #announcements in step with the members' channels.
//
// Discord lists everyone who can view a channel, so people who are not verified must never share a channel with members.
// They read #gate-rules and #gate-announcements instead: only the bot writes there, and every post is copied here with
// no author name and with user mentions removed, so nothing in it can show them who is in the server.
//
// mx: { fetchRecent(channelId, limit) → [{ id, content, embeds, attachments: [url], authorIsBot }] (oldest first),
//       send(channelId, payload) → messageId, edit(channelId, messageId, payload), remove(channelId, messageId) }

const MAX = 2000;
const USER_MENTION = /<@!?\d+>/g;
const ROLE_MENTION = /<@&\d+>/g;

/** Message text with nobody's name in it. */
export const scrubText = (text) =>
  String(text ?? '')
    .replace(USER_MENTION, '')
    .replace(ROLE_MENTION, '')
    .replace(/@(everyone|here)/gi, '')
    .replace(/[ \t]{2,}/g, ' ');

const scrubEmbed = (e) => {
  const { author, footer, ...rest } = e;
  const out = { ...rest };
  if (out.title) out.title = scrubText(out.title);
  if (out.description) out.description = scrubText(out.description);
  if (out.fields) out.fields = out.fields.map((f) => ({ ...f, name: scrubText(f.name), value: scrubText(f.value) || '​' }));
  return out;
};

export function mirrorPayload(msg) {
  const links = (msg.attachments ?? []).join('\n');
  const content = [scrubText(msg.content), links].filter(Boolean).join('\n').slice(0, MAX);
  const embeds = (msg.embeds ?? []).slice(0, 10).map(scrubEmbed);
  return { content: content || undefined, embeds, allowedMentions: { parse: [] } };
}

const isEmpty = (p) => !p.content && !p.embeds.length;

export function createMirror({ mirrors, store, mx, log = () => {} }) {
  const targetOf = (sourceId) => mirrors[sourceId] ?? null;

  async function posted(msg) {
    const target = targetOf(msg.channelId);
    if (!target || store.mirrorGet(msg.channelId, msg.id)) return false;
    const payload = mirrorPayload(msg);
    if (isEmpty(payload)) return false;
    const id = await mx.send(target, payload);
    store.mirrorAdd(msg.channelId, msg.id, target, id);
    return true;
  }

  async function edited(msg) {
    const target = targetOf(msg.channelId);
    if (!target) return false;
    const rec = store.mirrorGet(msg.channelId, msg.id);
    if (!rec) return posted(msg);
    const payload = mirrorPayload(msg);
    await mx.edit(rec.target_channel, rec.target_message, { ...payload, content: payload.content ?? '' });
    return true;
  }

  async function deleted(channelId, messageId) {
    const rec = store.mirrorGet(channelId, messageId);
    if (!rec) return false;
    store.mirrorDelete(channelId, messageId);
    await mx.remove(rec.target_channel, rec.target_message).catch((err) => log(`could not delete a gate copy: ${err.message}`));
    return true;
  }

  /** On start: catch up on anything posted, edited or deleted while the bot was off (the publishing script included). */
  async function backfill(limit = 100) {
    let copied = 0;
    for (const sourceId of Object.keys(mirrors)) {
      try {
        const recent = await mx.fetchRecent(sourceId, limit);
        const seen = new Set(recent.map((m) => m.id));
        for (const m of recent) {
          if (store.mirrorGet(sourceId, m.id)) await edited(m);
          else if (await posted(m)) copied++;
        }
        if (recent.length < limit) {
          for (const rec of store.mirrorAll(sourceId)) if (!seen.has(rec.source_message)) await deleted(sourceId, rec.source_message);
        }
      } catch (err) {
        log(`gate copy of ${sourceId} failed: ${err.message}`);
      }
    }
    return copied;
  }

  return { posted, edited, deleted, backfill, targetOf };
}
