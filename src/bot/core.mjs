// The membership rules, with no Discord or database in them.
//
// A member's class comes from, in order of strength:
//   - an active Buy Me a Coffee membership for their linked email (no end date: it lasts until
//     a webhook ends it, or a mod does; see bmc-overdue.mjs),
//   - a cancelled or paused membership, until the end of the period they paid for,
//   - a complimentary class from /membership grant, until it expires,
// and after any of those ends, a grace period (7 days) with the same class. /unlink also
// leaves a grace period. The highest class wins; a class in grace only counts when there is
// no current one. Revoked memberships count for nothing.
//
// "Class" means a tier and "Tourist" the free role (shown as TOURIST_NAME). Spark, $1, is the entry level.
// Tourist comes from an approved intro. A member keeps
// it until a class replaces it, and falls back to it when a class lapses. It is not a Buy Me a Coffee level.
// Elder: a verified member (paid class or Tourist) whose first verification is at least elder.afterDays old (90),
// with good activity (active on elder.activeDaysRequired days of the last elder.activityWindowDays, and no
// moderation action in that window), gets the Elder role and keeps it while they still hold a class or Tourist.

const DAY = 86_400_000;
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

export function tierForLevel(cfg, levelId, levelName) {
  const id = levelId == null ? '' : String(levelId);
  const name = String(levelName || '').trim().toLowerCase();
  const byId = id && cfg.tiers.findLast((t) => t.bmcLevelIds.includes(id));
  const byName = name && cfg.tiers.findLast((t) => (t.bmcLevels ?? [t.name.toLowerCase()]).includes(name));
  const tier = byId || byName || cfg.tiers.find((t) => t.slug === cfg.unknownLevelTier) || null;
  return { tier, known: Boolean(byId || byName) };
}

/**
 * @returns {{ tier: object|null, state: 'active'|'grace'|'none', until: number|null, graceStart: number|null, endsAt: number|null }}
 *   until: when the current state ends (null = open-ended); endsAt: end of a paid period that
 *   is running out (cancelled or paused memberships), for the "ending soon" reminder.
 */
export function entitlement(cfg, { memberships = [], grants = [], member = null }, now = Date.now()) {
  const graceMs = (cfg.grace.lapseDays ?? 7) * DAY;
  const candidates = [];
  const add = (tier, end, open = false) => {
    if (!tier) return;
    if (open || end > now) candidates.push({ tier, state: 'active', until: open ? null : end, endsAt: open ? null : end });
    else if (end + graceMs > now) candidates.push({ tier, state: 'grace', until: end + graceMs, graceStart: end });
  };

  for (const m of memberships) {
    if (m.status === 'revoked') continue;
    const { tier } = tierForLevel(cfg, m.level_id, m.level_name);
    if (m.status === 'active') add(tier, null, true);
    else if (m.status === 'cancelling' || m.status === 'paused') add(tier, ms(m.paid_until) || ms(m.updated_at));
    else add(tier, ms(m.ended_at) || ms(m.paid_until) || ms(m.updated_at));
  }
  for (const g of grants) add(cfg.tiers.find((t) => t.slug === g.tier), ms(g.expires_at));
  if (member?.carry_tier && member.carry_until) {
    const until = ms(member.carry_until);
    const tier = cfg.tiers.find((t) => t.slug === member.carry_tier);
    if (tier && until > now) candidates.push({ tier, state: 'grace', until, graceStart: until - graceMs });
  }

  const best = (state) =>
    candidates
      .filter((c) => c.state === state)
      .sort((a, b) => b.tier.rank - a.tier.rank || (b.until ?? Infinity) - (a.until ?? Infinity))[0];
  const pick = best('active') || best('grace');
  if (!pick) return { tier: null, state: 'none', until: null, graceStart: null, endsAt: null };
  // An open-ended membership at the same class outranks one that is running out.
  const open = pick.state === 'active' && candidates.some((c) => c.state === 'active' && c.tier === pick.tier && c.until === null);
  return {
    tier: pick.tier,
    state: pick.state,
    until: open ? null : pick.until,
    graceStart: pick.graceStart ?? null,
    endsAt: open ? null : pick.endsAt ?? null,
  };
}

/** Every role id the bot is allowed to manage: class roles, lounge access roles, the Tourist roles and the Elder role. */
export const managedRoles = (cfg) =>
  new Set([...cfg.tiers.flatMap((t) => [t.roleId, t.accessRoleId]), cfg.tourist?.roleId, cfg.tourist?.accessRoleId, cfg.elder?.roleId, cfg.roles?.verified].filter(Boolean)); // never Grand Elder: admins give that by hand

/** A member whose intro a mod approved (Tourist is free and never comes from Buy Me a Coffee). */
export const isTourist = (cfg, member) => Boolean(cfg.tourist?.roleId && member?.tourist_since);

/** When the first verification happened: the earlier of the link date and the Tourist date. */
const verifiedSince = (member) => {
  const dates = [member?.linked_at, member?.tourist_since].map((d) => Date.parse(d)).filter(Number.isFinite);
  return dates.length ? Math.min(...dates) : NaN;
};

/**
 * activity: { activeDays, moderated } from the store, or undefined to skip the activity check.
 * A member who already has elder_since keeps the role while they hold a class or Tourist.
 */
export function isElder(cfg, member, ent, now = Date.now(), activity) {
  if (!cfg.elder?.roleId || !member) return false;
  if (cfg.elder.requireEmail !== false && !member.email) return false; // the second verification step
  const standing = ent.state !== 'none' || isTourist(cfg, member);
  if (!standing) return false;
  if (member.elder_since) return true;
  const since = verifiedSince(member);
  if (!Number.isFinite(since) || now - since < (cfg.elder.afterDays ?? 90) * DAY) return false;
  return activityOk(cfg, activity);
}

/** Good activity: enough active days in the window and no moderation action. No data (undefined) skips the check. */
export function activityOk(cfg, activity) {
  const need = cfg.elder?.activeDaysRequired ?? 0;
  if (!need || !activity) return true;
  return activity.activeDays >= need && !activity.moderated;
}

/**
 * Where a member stands on the way to Elder, for /rank. The count starts at the first verification
 * (linked_at) and needs elder.afterDays days; the role itself also needs a class (active or grace).
 * @returns {{ verified: boolean, days: number, remaining: number, eligibleAt: number|null, elder: boolean }}
 */
export function elderProgress(cfg, member, ent, now = Date.now(), activity) {
  const need = cfg.elder?.afterDays ?? 90;
  // The count starts at the first verification: an approved intro or the email link, whichever came first.
  const since = member?.email || member?.tourist_since ? verifiedSince(member) : NaN;
  if (!Number.isFinite(since)) return { verified: false, days: 0, remaining: need, eligibleAt: null, elder: false, activityOk: true, needsEmail: false };
  const days = Math.max(0, Math.floor((now - since) / DAY));
  const eligibleAt = since + need * DAY;
  return {
    verified: true,
    days,
    remaining: Math.max(0, Math.ceil((eligibleAt - now) / DAY)),
    eligibleAt,
    elder: isElder(cfg, member, ent, now, activity),
    activityOk: activityOk(cfg, activity),
    needsEmail: cfg.elder?.requireEmail !== false && !member?.email,
  };
}

/**
 * The class role (unless discreet) plus the access role of that class and every cheaper one, plus Elder.
 * Without a class, a Tourist gets the Tourist role and its access role; a class replaces them.
 * Everyone with a place here also gets the verified role, which is what opens the server. Staff hold it too.
 */
export function wantedRoles(cfg, tier, { discreet = false, elder = false, tourist = false, staff = false } = {}) {
  let roles = [];
  if (tier) {
    roles = cfg.tiers.filter((t) => t.rank <= tier.rank).map((t) => t.accessRoleId);
    if (!discreet) roles.push(tier.roleId);
  } else if (tourist) {
    roles = [cfg.tourist?.accessRoleId, ...(discreet ? [] : [cfg.tourist?.roleId])];
  }
  if (tier || tourist || staff) roles.push(cfg.roles?.verified);
  if (elder) roles.push(cfg.elder?.roleId);
  return new Set(roles.filter(Boolean));
}

/** What to add and remove, touching only managed roles. */
export function roleDiff(cfg, current, wanted) {
  const managed = managedRoles(cfg);
  return {
    add: [...wanted].filter((r) => !current.has(r)),
    remove: [...current].filter((r) => managed.has(r) && !wanted.has(r)),
  };
}
