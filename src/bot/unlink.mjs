// Mod /unlink: a Forge Founder or Warden removes the Discord link of any account (member or user ID),
// after a confirmation step. Members still use plain /unlink on themselves (commands.mjs).
import crypto from 'node:crypto';
import { entitlement } from './core.mjs';
import { isMod } from './tickets.mjs';

const date = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const TTL = 10 * 60_000;

export const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email || '').split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

/** Accepts a mention (<@123>), a bare ID, or an ID with spaces; returns the ID or null. */
export const parseUserId = (value) => {
  const m = String(value ?? '').match(/\d{15,25}/);
  return m ? m[0] : null;
};

export function createUnlink({ cfg, store, sync, discord, now = () => Date.now() }) {
  const pending = new Map(); // token → { actorId, targetId, reason, expires }

  /** Step 1: checks the caller and describes the link. Returns { error } or { text, token }. */
  function prepare({ actorId, roleIds, target, reason }) {
    if (!isMod(cfg, roleIds)) return { error: 'Only mods can unlink another account.' };
    const targetId = parseUserId(target);
    if (!targetId) return { error: 'Choose a member, or paste their Discord user ID.' };
    const member = store.member(targetId);
    if (!member?.email) return { error: `<@${targetId}> is not linked to a Buy Me a Coffee email, so there is nothing to unlink.` };
    const ent = entitlement(cfg, { memberships: store.membershipsFor(member.email), grants: store.grantsFor(targetId), member }, now());
    const tierText = ent.tier
      ? `${ent.tier.name} (${ent.state === 'grace' ? 'in grace' : 'active'}${ent.until ? `, until ${date(ent.until)}` : ''})`
      : 'none';
    for (const [token, p] of pending) if (p.expires < now()) pending.delete(token);
    const token = crypto.randomBytes(8).toString('hex');
    pending.set(token, { actorId, targetId, reason: String(reason ?? '').trim().slice(0, 300), expires: now() + TTL });
    return {
      token,
      text:
        `Unlink <@${targetId}> (${targetId})?\n` +
        `• Linked email: ${maskEmail(member.email)}\n• Tier now: ${tierText}\n` +
        `Their tier and lounge roles are removed at once, with no grace period. The Buy Me a Coffee membership itself is untouched, and ` +
        `a complimentary /membership grant stays until it expires or is revoked. They can run /link again.`,
    };
  }

  /** Step 2: the Confirm button. */
  async function confirm({ actorId, roleIds, token }) {
    const p = pending.get(token);
    if (!p || p.expires < now()) return 'That confirmation expired. Run /unlink again.';
    if (p.actorId !== actorId) return 'Only the mod who ran the command can confirm it.';
    if (!isMod(cfg, roleIds)) return 'Only mods can unlink another account.';
    pending.delete(token);
    if (!store.adminUnlink(p.targetId)) return `<@${p.targetId}> is no longer linked.`;
    await sync.syncMember(p.targetId, `unlinked by a mod`);
    const why = p.reason ? ` Reason: ${p.reason}` : '';
    if (cfg.channels.modLog) await discord.post(cfg.channels.modLog, `<@${actorId}> unlinked <@${p.targetId}>'s Buy Me a Coffee link.${why}`).catch(() => {});
    await discord.dm(p.targetId, 'A moderator unlinked your Buy Me a Coffee email from Magenta Forge, so your tier was removed. To link again, run /link in the server.').catch(() => false);
    return `Unlinked <@${p.targetId}>. Their tier roles are removed${why ? '.' + why : '.'}`;
  }

  return { prepare, confirm };
}
