// /link: tie an email to a Discord account, for a Buy Me a Coffee membership and as the second verification step for
// Elder (any email the member owns works for that). Anyone can type someone else's email, so it has to be proven first:
// with SMTP set up, a one-time code goes to that address; without it, a mod approves the request. The answer is the same
// whether or not an email is a supporter, so nobody can test addresses here.
import crypto from 'node:crypto';
import { maskEmail } from './unlink.mjs';
import { isMod } from './tickets.mjs';

export const LINK_TTL_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 60_000;

export const normalizeEmail = (s) => String(s ?? '').trim().toLowerCase();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/**
 * lx: { sendCode(email, code) → Promise, smtpOn: boolean, reviewRequest({ id, userId, maskedEmail, levelName, supporterName }) → Promise, dm(userId, text) }
 */
export function createLink({ cfg, store, sync, lx, now = () => Date.now(), makeCode = () => String(crypto.randomInt(100000, 1000000)) }) {
  async function start({ userId, email }) {
    const addr = normalizeEmail(email);
    if (!validEmail(addr)) return 'That does not look like an email address. Use the one you paid with on Buy Me a Coffee.';
    const prior = store.linkPending(userId);
    if (prior && now() - Date.parse(prior.created_at) < COOLDOWN_MS) return 'Please wait a minute before asking again.';
    store.linkExpire(now());
    const membership = store.membershipsFor(addr).find((m) => m.status !== 'revoked');
    const expires = new Date(now() + LINK_TTL_MS).toISOString();
    if (lx.smtpOn) {
      const code = makeCode();
      store.linkStart(userId, addr, hash(code), expires);
      await lx.sendCode(addr, code).catch((err) => console.error('[bot] link email failed:', err.message));
      return 'A code is on its way to that address. Run `/link code:123456` with it within 15 minutes. No email after a few minutes? Check spam.';
    }
    const id = store.linkStart(userId, addr, null, new Date(now() + 7 * 86_400_000).toISOString());
    await lx.reviewRequest({ id, userId, maskedEmail: maskEmail(addr), levelName: membership?.level_name, supporterName: membership?.supporter_name });
    return 'A mod will check it and you will get a DM when it is linked.';
  }

  async function finish(userId, email) {
    if (!store.linkEmail(userId, email)) return 'That membership is already linked to another Discord account. Open a ticket and the staff will sort it out.';
    const res = await sync.syncMember(userId, 'linked');
    const name = res.tier ? cfg.tiers.find((t) => t.slug === res.tier)?.name : null;
    return name ? `Linked! You are now ${name}, and your roles are on. Thank you for supporting the stream.` : 'Linked! That email has no active membership right now, so no tier role was added. It still counts as your second verification step for Forge Elder.';
  }

  async function code({ userId, code: entered }) {
    const req = store.linkPending(userId);
    if (!req?.code_hash || Date.parse(req.expires_at) < now()) return 'No code is waiting. Run `/link email:you@example.com` first.';
    if (req.attempts >= MAX_ATTEMPTS) {
      store.linkDelete(req.id);
      return 'Too many wrong codes. Run `/link email:you@example.com` to get a new one.';
    }
    const a = Buffer.from(hash(String(entered ?? '').trim()));
    const b = Buffer.from(req.code_hash);
    if (!crypto.timingSafeEqual(a, b)) {
      store.linkAttempt(req.id);
      return 'That code is not right. Check the email and try again.';
    }
    store.linkDelete(req.id);
    return finish(userId, req.email);
  }

  async function approve({ roleIds, id, actorId }) {
    if (!isMod(cfg, roleIds)) return 'Only mods can decide a link request.';
    const req = store.linkById(id);
    if (!req) return 'That request was already decided or has expired.';
    store.linkDelete(id);
    const text = await finish(req.discord_id, req.email);
    await lx.dm(req.discord_id, text).catch(() => false);
    return `Approved by <@${actorId}>. <@${req.discord_id}>: ${text}`;
  }

  async function decline({ roleIds, id, actorId }) {
    if (!isMod(cfg, roleIds)) return 'Only mods can decide a link request.';
    const req = store.linkById(id);
    if (!req) return 'That request was already decided or has expired.';
    store.linkDelete(id);
    await lx.dm(req.discord_id, 'Your Buy Me a Coffee link request was not approved. If this is a mistake, press "Ask for help" in #verification-help or open a ticket.').catch(() => false);
    return `Declined by <@${actorId}>.`;
  }

  return { start, code, approve, decline };
}
