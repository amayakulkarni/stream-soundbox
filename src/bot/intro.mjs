// The free member role by intro verification. A person sends Snitch an intro in a fixed template (by DM or the button
// in #verification-help); the bot opens a private staff channel with it, a mod approves or declines with a button, and
// an approval gives the free role and opens the server (Buy Me a Coffee has no free level, so it never comes from there).
// Internally the free role is called "tourist"; TOURIST_NAME sets what people see. The rules are here with no Discord
// library in them; discord-adapters.mjs supplies the `ix` adapter.
//
// Privacy: while an intro waits, its text lives only in the private staff channel. A declined or withdrawn intro is
// deleted with that channel. An approved intro is kept, staff-only, as a text file in #ticket-transcripts (the same
// place as archived tickets) with the person's Discord ID, until the member asks for it to be deleted (/forget-me,
// or a mod deleting the message). The database keeps only IDs and dates: a request row while pending, and for an
// approved intro the ID of the archived message and tourist_since. Under-13 intros are refused unread: nothing is
// saved and no channel is made.
//
// ix: {
//   createChannel({ number, applicantId, name }) → channelId
//   postIntro(channelId, { number, applicantId, fields: [{ label, value }] })
//   archiveIntro(channelId, { number, applicantId, approvedBy }) → { channelId, messageId } (the intro as a text file in #ticket-transcripts)
//   deleteMessage(channelId, messageId)
//   deleteChannel(channelId, reason)
//   isMember(userId) → boolean
//   dm(userId, text) → boolean
//   modLog(text)
// }
import { isMod } from './tickets.mjs';

export const MIN_AGE = 13;
export const INTRO_EXPIRE_DAYS = 14;
const MAX_FIELD = 200;
const MAX_MESSAGE = 1500;

export const INTRO_FIELDS = [
  { key: 'age', label: 'Age', names: ['age'] },
  { key: 'pronouns', label: 'Pronouns', names: ['pronouns', 'pronoun'] },
  { key: 'location', label: 'Region', names: ['region', 'location', 'country'] },
  { key: 'found', label: 'Found the stream via', names: ['found the stream via', 'found via', 'how you found us', 'found'] },
  { key: 'interests', label: 'Into', names: ['into', 'interests', 'games', 'hobbies'] },
  { key: 'trivia', label: 'Trivia', names: ['trivia', 'fun fact'] },
];

export const INTRO_TEMPLATE = [
  'Age: 22',
  'Pronouns: she/her',
  'Region: Maharashtra, India',
  'Found the stream via: a Cyberpunk 2077 clip on YouTube',
  'Into: GTA Online heists, 3D printing, homelabs',
  'Trivia: my printer has a name and an attitude',
].join('\n');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const LABEL_RE = new RegExp(`^\\s*[*_>\\-]*\\s*(${INTRO_FIELDS.flatMap((f) => f.names).map(escapeRe).join('|')})\\s*[:：=\\-–]\\s*(.*)$`, 'i');

/** Splits a message into the template's fields. Lines that follow a field belong to it. Unknown text before the first field is ignored. */
export function parseIntro(text) {
  const values = {};
  let current = null;
  for (const line of String(text ?? '').replace(/\r/g, '').slice(0, MAX_MESSAGE).split('\n')) {
    const m = LABEL_RE.exec(line);
    if (m) {
      const field = INTRO_FIELDS.find((f) => f.names.includes(m[1].toLowerCase()));
      current = field.key;
      values[current] = m[2].trim();
    } else if (current && line.trim()) {
      values[current] = `${values[current]} ${line.trim()}`.trim();
    }
  }
  for (const k of Object.keys(values)) values[k] = values[k].replace(/\s+/g, ' ').slice(0, MAX_FIELD);
  return values;
}

/** True when a message looks like an intro attempt (it has at least the Age label). */
export const looksLikeIntro = (text) => 'age' in parseIntro(text);

/**
 * values → { ok: true, fields } | { tooYoung: true } | { error }.
 * optional: field keys that may be left empty (tourist.introOptionalFields in the config; default none).
 */
export function checkIntro(values, optional = []) {
  const age = Number(/\d{1,3}/.exec(values.age ?? '')?.[0]);
  if (!Number.isFinite(age) || age < 1 || age > 120) return { error: 'Age needs to be a number, for example "Age: 23".' };
  if (age < MIN_AGE) return { tooYoung: true };
  const missing = INTRO_FIELDS.filter((f) => !optional.includes(f.key) && !values[f.key]?.trim()).map((f) => f.label);
  if (missing.length) return { error: `Missing: ${missing.join(', ')}.` };
  return { ok: true, fields: INTRO_FIELDS.filter((f) => values[f.key]?.trim()).map((f) => ({ label: f.label, value: values[f.key] })) };
}

export const introHelp = (optional = []) =>
  `**Join Magenta Forge for free.** Press **Send my intro** in #verification-help, or send it to me here in one message, copying this template (fill in your own answers):\n\`\`\`\n${INTRO_TEMPLATE}\n\`\`\`\n` +
  `${optional.length ? `You may leave out: ${INTRO_FIELDS.filter((f) => optional.includes(f.key)).map((f) => f.label).join(', ')}.` : 'Every line is needed.'} Answers can be short, and nothing needs to be your real name.\n` +
  `• You must be ${MIN_AGE} or older.\n` +
  '• Only the mods can read the intro, to check you are a real person who fits the community. It is never published. If you are approved, the intro is kept in the mods\' private records (with your Discord ID) until you ask for it to be deleted: type `/forget-me` in the server, or ask a mod. If it is declined, or you withdraw it, it is deleted.\n' +
  '• You get a DM with the decision. If it is a no, you can fix the intro and send it again.\n' +
  '• Send `cancel` to withdraw an intro you already sent. Deleting your DM does not delete the mods\' copy: use `cancel`.';

export function createIntro({ cfg, store, ix, sync, now = () => Date.now() }) {
  const optional = cfg.tourist?.introOptionalFields ?? [];
  const category = () => cfg.channels.introCategory || cfg.channels.ticketCategory;
  const iso = () => new Date(now()).toISOString();
  const modLog = (text) => Promise.resolve(ix.modLog(text)).catch(() => {});
  const padded = (n) => String(n).padStart(4, '0');

  async function removeRequest(req, reason) {
    store.introDelete(req.id);
    if (req.channel_id) await Promise.resolve(ix.deleteChannel(req.channel_id, reason)).catch(() => {});
  }

  return {
    help: () => introHelp(optional),

    /** A DM to the bot. Returns the reply text (or null for nothing to say). */
    async dm({ userId, text }) {
      if (!cfg.tourist?.roleId) return 'Verification is not open yet. Ask a mod in the server.';
      const word = String(text ?? '').trim().toLowerCase();
      if (['cancel', 'withdraw', '/cancel'].includes(word)) {
        const req = store.introByUser(userId);
        if (!req) return 'You have no intro waiting.';
        await removeRequest(req, 'Intro withdrawn');
        return 'Done. Your intro was withdrawn and the mods\' copy is deleted.';
      }
      if (!looksLikeIntro(text)) return introHelp(optional);
      if (store.member(userId)?.tourist_since) return 'You are already verified. See you in #the-forge-general!';
      if (!(await ix.isMember(userId))) return 'Join the Magenta Forge server first, then send your intro again.';
      const pending = store.introByUser(userId);
      if (pending) return 'Your intro is already with the mods. You will get a DM when they decide. Send `cancel` to withdraw it.';
      const check = checkIntro(parseIntro(text), optional);
      if (check.tooYoung) return `Sorry, Magenta Forge is for people aged ${MIN_AGE} and over, so I cannot take this intro. Nothing was saved. You are welcome back when you turn ${MIN_AGE}.`;
      if (check.error) return `Almost there. ${check.error} Send the whole intro again.\n\`\`\`\n${INTRO_TEMPLATE}\n\`\`\``;
      if (!category()) return 'Intro checks are not set up yet. Ask a mod in the server.';
      const number = store.introCreate(userId, iso());
      let channelId = null;
      try {
        channelId = await ix.createChannel({ number, applicantId: userId, name: `intro-${padded(number)}` });
        store.introSetChannel(number, channelId);
        await ix.postIntro(channelId, { number, applicantId: userId, fields: check.fields });
      } catch (err) {
        console.error('[bot] intro could not be opened:', err.message);
        if (channelId) await Promise.resolve(ix.deleteChannel(channelId, 'intro could not be set up')).catch(() => {});
        store.introDelete(number);
        return 'I could not pass your intro on just now. Please try again in a minute.';
      }
      modLog(`Intro ${padded(number)} from <@${userId}> is waiting: <#${channelId}>`);
      return 'Thank you! Your intro is with the mods. You will get a DM when they decide. Send `cancel` to withdraw it.';
    },

    /** A mod pressed Approve. */
    async approve({ userId, roleIds, number }) {
      if (!isMod(cfg, roleIds)) return 'Only mods can decide an intro.';
      const req = store.introGet(number);
      if (!req) return 'That intro was already decided.';
      if (!(await ix.isMember(req.discord_id))) {
        await removeRequest(req, 'Applicant left the server');
        return 'The person has left the server, so the intro was removed.';
      }
      if (!cfg.channels.ticketTranscripts) return 'There is no #ticket-transcripts channel set up, so the intro cannot be saved. Set it up, then approve again.';
      let kept;
      try {
        kept = await ix.archiveIntro(req.channel_id, { number, applicantId: req.discord_id, approvedBy: userId });
      } catch (err) {
        console.error('[bot] intro could not be archived:', err.message);
        return 'The intro could not be saved to #ticket-transcripts, so nothing was changed. Try again.';
      }
      store.introRecordAdd(req.discord_id, kept.channelId, kept.messageId, iso());
      store.touristSet(req.discord_id);
      await removeRequest(req, `Intro approved by ${userId}`);
      await sync.syncMember(req.discord_id, 'intro approved');
      modLog(`Intro ${padded(number)} for <@${req.discord_id}> approved by <@${userId}>. The intro is saved in <#${kept.channelId}>.`);
      return `Approved: <@${req.discord_id}> is verified. The intro was saved in <#${kept.channelId}> and this channel is deleted.`;
    },

    /** A mod declined (the reason is optional and goes to the applicant in a DM). */
    async decline({ userId, roleIds, number, reason }) {
      if (!isMod(cfg, roleIds)) return 'Only mods can decide an intro.';
      const req = store.introGet(number);
      if (!req) return 'That intro was already decided.';
      await removeRequest(req, `Intro declined by ${userId}`);
      const why = String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      await Promise.resolve(
        ix.dm(req.discord_id, `Your Magenta Forge intro was not approved this time${why ? `: ${why}` : '.'} You can fix it and send a new intro any time. If you think this is a mistake, press "Ask for help" in #verification-help.`),
      ).catch(() => {});
      modLog(`Intro ${padded(number)} for <@${req.discord_id}> declined by <@${userId}>. The intro text was deleted.`);
      return `Declined. <@${req.discord_id}> was told and can send a new intro.`;
    },

    /** /forget-me: withdraw any waiting intro and delete the mods' copies, including the kept copy of an approved intro. */
    async withdraw(userId) {
      const req = store.introByUser(userId);
      if (req) await removeRequest(req, 'Member used /forget-me');
      // The kept copy of an approved intro goes too.
      for (const rec of store.introRecords(userId)) await Promise.resolve(ix.deleteMessage(rec.channel_id, rec.message_id)).catch(() => {});
      store.introRecordsDelete(userId);
    },

    /** Intros nobody decided within INTRO_EXPIRE_DAYS are deleted, and the person is told. */
    async expire() {
      const cutoff = new Date(now() - INTRO_EXPIRE_DAYS * 86_400_000).toISOString();
      for (const req of store.introsOlderThan(cutoff)) {
        await removeRequest(req, 'Intro expired');
        await Promise.resolve(ix.dm(req.discord_id, 'Your Magenta Forge intro was not decided within two weeks, so it was deleted. Send a new intro any time.')).catch(() => {});
      }
    },
  };
}
