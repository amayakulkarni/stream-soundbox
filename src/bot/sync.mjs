// Compares what each member should have with what they have in Discord, and fixes the
// difference. Webhooks, /link, joins and the 15-minute sweep all end up here, so the same
// rules serve new members, renewals, expiries and manual fixes.
import { entitlement, isElder, isTourist, roleDiff, wantedRoles } from './core.mjs';

const DAY = 86_400_000;
const date = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * discord: { fetchMember(id) → { roles: Set<string> } | null, addRole(id, roleId, reason), removeRole(id, roleId, reason),
 *            dm(id, text) → Promise<boolean>, post(channelId, text) }
 */
export function createSync({ cfg, store, discord, env, now = () => Date.now() }) {
  const renew = env.renewUrl ? ` Renew here: ${env.renewUrl}` : '';
  const free = cfg.tourist?.name ?? 'Visitor';
  const lapse = cfg.grace?.lapseDays ?? 7;
  const log = (text) => cfg.channels.botLog && discord.post(cfg.channels.botLog, text).catch(() => {});
  const modLog = (text) => cfg.channels.modLog && discord.post(cfg.channels.modLog, text).catch(() => {});
  const isStaff = (roles) => (cfg.staffRoleIds ?? []).some((id) => id && roles.has(id));

  /** Sends a DM once per key; if DMs are closed it waits for their next command. */
  async function tell(id, key, text) {
    if (store.hasNotice(id, key)) return;
    const delivered = await discord.dm(id, text).catch(() => false);
    store.notice(id, key, text, delivered);
  }

  // One sync at a time per member. Buy Me a Coffee can send two events together, or retry one: run side by side, both
  // would see the old state and both would announce the same new supporter.
  const queues = new Map();
  function syncMember(id, reason = 'sync') {
    const run = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(() => syncNow(id, reason));
    queues.set(id, run);
    run.finally(() => {
      if (queues.get(id) === run) queues.delete(id);
    }).catch(() => {});
    return run;
  }

  async function syncNow(id, reason) {
    const member = store.member(id);
    const grants = store.grantsFor(id);
    if (!member && !grants.length) return { skipped: 'not managed' };
    const at = now();
    const ent = entitlement(cfg, { memberships: store.membershipsFor(member?.email), grants, member }, at);
    const tierSlug = ent.tier?.slug ?? null;
    const prevTier = member?.applied_tier ?? null;
    const prevState = member?.applied_state ?? 'none';

    const gm = await discord.fetchMember(id);
    // Someone given the free role by hand counts as verified too, so a sweep never closes the server on them.
    const heldByHand = Boolean(gm && cfg.tourist?.roleId && gm.roles.has(cfg.tourist.roleId) && !member?.tourist_since);
    if (heldByHand) store.touristSet(id); // recorded, so it comes back when a tier replaces it and later lapses
    const tourist = isTourist(cfg, member) || heldByHand;
    // Members who already hold the Elder role when this rule starts keep it (their date is recorded now).
    if (gm && cfg.elder?.roleId && gm.roles.has(cfg.elder.roleId) && member && !member.elder_since && (ent.state !== 'none' || tourist)) {
      store.elderSet(id);
      member.elder_since = new Date(at).toISOString();
    }
    const activity = cfg.elder?.activeDaysRequired ? store.activitySummary(id, cfg.elder.activityWindowDays ?? 90, at) : undefined;
    const elder = isElder(cfg, member, ent, at, activity);
    if (elder && member && !member.elder_since) store.elderSet(id);
    let changed = { add: [], remove: [] };
    if (gm) {
      changed = roleDiff(cfg, gm.roles, wantedRoles(cfg, ent.tier, { discreet: Boolean(member?.discreet), elder, tourist, staff: isStaff(gm.roles) }));
      const why = `Magenta Forge membership: ${reason}`;
      for (const r of changed.add) await discord.addRole(id, r, why);
      for (const r of changed.remove) await discord.removeRole(id, r, why);
    }
    store.ensureMember(id);
    store.setApplied(id, tierSlug, ent.state === 'none' && tourist ? 'tourist' : ent.state);

    // Messages for what changed since last time.
    const name = ent.tier?.name;
    const appliedState = ent.state === 'none' && tourist ? 'tourist' : ent.state;
    const tierChanged = tierSlug !== prevTier || appliedState !== prevState;
    if (tierChanged) {
      const none = prevState === 'tourist' ? free : 'Aspirant';
      const from = prevTier ? `${cfg.tiers.find((t) => t.slug === prevTier)?.name ?? prevTier}${prevState === 'grace' ? ' (grace)' : ''}` : none;
      const to = name ? `${name}${ent.state === 'grace' ? ' (grace)' : ''}` : tourist ? free : 'Aspirant';
      log(`<@${id}>: ${from} → ${to} (${reason})`);
    }
    if (cfg.tourist?.roleId && changed.add.includes(cfg.tourist.roleId) && !tierSlug) {
      await tell(id, 'tourist', `Welcome to Magenta Forge! You are verified as a ${free}, so the server is open: say hi in #the-forge-general and pick your stream pings in #pick-your-roles. Stay active for about three months and you can become a Forge Elder.`);
    }
    if (cfg.elder?.roleId && changed.add.includes(cfg.elder.roleId)) {
      await tell(id, 'elder', `You have been part of the forge for ${cfg.elder.afterDays} days and have been active in the community, so you are now a Forge Elder. The Elder Hall is open, and you can start a private voice room from Create a Room.`);
      log(`<@${id}> became a Forge Elder.`);
    }
    // Renewing during grace counts as staying, not as new: no second welcome.
    if (ent.state === 'active' && (prevState === 'none' || !prevTier)) {
      await tell(id, `welcome:${tierSlug}:${new Date(at).toISOString().slice(0, 10)}`, `Thank you for supporting the stream! You are now ${name} in Magenta Forge and your supporter lounges are open. Type /discreet on if you'd rather not show your tier colour, or /thanks on for a shout-out on the supporter wall.`);
      const wallKey = `wall:${tierSlug}:${new Date(at).toISOString().slice(0, 10)}`;
      if (member?.thanks && cfg.channels.thankYou && !store.hasNotice(id, wallKey)) {
        store.notice(id, wallKey, '', true);
        discord.post(cfg.channels.thankYou, `Please welcome our newest ${name}, <@${id}>! 🔥`).catch(() => {});
      }
    } else if (ent.state === 'active' && prevState === 'active' && prevTier && prevTier !== tierSlug) {
      await tell(id, `class:${tierSlug}:${at}`, `Your Magenta Forge tier is now ${name}.`);
    }
    if (ent.state === 'active' && ent.endsAt) {
      await tell(id, `ending:${ent.endsAt}`, `Your ${name} membership ends on ${date(ent.endsAt)}. You keep your tier until then, plus a ${lapse}-day grace period.${renew}`);
      for (const days of cfg.grace.remindDaysBeforeEnd || []) {
        if (at >= ent.endsAt - days * DAY) await tell(id, `ending-${days}:${ent.endsAt}`, `Reminder: your ${name} membership ends on ${date(ent.endsAt)}.${renew}`);
      }
    }
    if (ent.state === 'grace') {
      for (const days of cfg.grace.remindDuringGrace || []) {
        if (at < ent.graceStart + days * DAY) continue;
        const text =
          days === 0
            ? `Your Magenta Forge membership has ended, so you are in a ${lapse}-day grace period: you keep your ${name} tier until ${date(ent.until)}.${renew}`
            : `Reminder: your ${name} grace period runs out on ${date(ent.until)}. After that your tier and lounges are removed until you renew.${renew}`;
        await tell(id, `grace-${days}:${ent.until}`, text);
      }
    }
    if (ent.state === 'none' && prevTier) {
      if (reason !== 'revoked' && reason !== 'forget-me') {
        const fallback = tourist ? ` You stay a ${free}, so the rest of the server remains open to you.` : '';
        await tell(id, `goodbye:${at}`, `Your Magenta Forge membership has run out, so your tier and lounges have been removed.${fallback} You're always welcome back.${renew}`);
      }
      modLog(`<@${id}> is ${tourist ? `a ${free}` : 'an aspirant'} again (${reason}).`);
    }
    return { tier: tierSlug, state: ent.state, added: changed.add, removed: changed.remove, inServer: Boolean(gm) };
  }

  async function syncEmail(email, reason) {
    const m = store.memberByEmail(email);
    return m ? syncMember(m.discord_id, reason) : { skipped: 'not linked' };
  }

  async function syncAll(reason = 'sweep') {
    const results = [];
    for (const id of store.managedIds()) {
      try {
        results.push(await syncMember(id, reason));
      } catch (err) {
        console.error(`[bot] sync ${id} failed:`, err.message);
      }
    }
    return results;
  }

  return { syncMember, syncEmail, syncAll };
}
