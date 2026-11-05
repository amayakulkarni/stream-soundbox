// Hourly check against Buy Me a Coffee's API (BMC_API_TOKEN, a read-only developer token),
// for what a lost webhook or a failed card would otherwise leave stale:
//   - an active membership whose paid period has passed and that Buy Me a Coffee no longer
//     lists as active becomes "lapsed", which starts its 7-day grace period;
//   - an active membership the API lists gets its new period end.
// If the API answers with nothing usable, nothing is changed.

const DAY = 86_400_000;
const pick = (obj, keys) => keys.map((k) => obj?.[k]).find((v) => v !== undefined && v !== null && v !== '');
const toIso = (v) => {
  if (v == null || v === '') return null;
  const n = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) return null;
  return new Date((n < 1e12 ? n * 1000 : n) + DAY).toISOString();
};

export async function fetchActiveSubscriptions(env, fetchImpl = fetch) {
  const subs = [];
  let url = `${env.bmcApiUrl}/subscriptions?status=active`;
  for (let page = 0; url && page < 100; page++) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${env.bmcApiToken}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Buy Me a Coffee API answered ${res.status}`);
    const body = await res.json();
    for (const s of body.data || []) {
      subs.push({
        id: String(pick(s, ['subscription_id', 'id']) ?? ''),
        email: String(pick(s, ['payer_email', 'supporter_email', 'email']) || '').trim().toLowerCase(),
        paidUntil: toIso(pick(s, ['subscription_current_period_end', 'current_period_end'])),
      });
    }
    url = body.next_page_url || null;
  }
  return subs;
}

export async function reconcileWithBmc({ env, store, sync, log = () => {}, fetchImpl = fetch, now = () => Date.now() }) {
  if (!env.bmcApiToken) return { skipped: 'BMC_API_TOKEN not set' };
  const subs = await fetchActiveSubscriptions(env, fetchImpl);
  const ours = store.activeMemberships();
  const usable = subs.filter((s) => s.email);
  // Guard against a changed API shape wiping everyone: no usable answer, no changes.
  if (ours.length && usable.length === 0) {
    log(`Buy Me a Coffee check skipped: the API listed ${subs.length} subscription(s) but none had an email.`);
    return { skipped: 'no usable data' };
  }
  const byId = new Map(usable.filter((s) => s.id).map((s) => [s.id, s]));
  const byEmail = new Map(usable.map((s) => [s.email, s]));
  const lapsed = [];
  let renewed = 0;
  for (const m of ours) {
    const live = byId.get(String(m.subscription_id)) || byEmail.get(String(m.email).toLowerCase());
    if (live) {
      if (live.paidUntil && live.paidUntil !== m.paid_until) {
        store.setPaidUntil(m.subscription_id, live.paidUntil);
        renewed++;
      }
    } else if (m.paid_until ? Date.parse(m.paid_until) < now() : Date.parse(m.updated_at) < now() - 2 * DAY) {
      store.lapse(m.subscription_id);
      lapsed.push(m.email);
    }
  }
  for (const email of new Set(lapsed)) await sync.syncEmail(email, 'membership not active on Buy Me a Coffee');
  return { checked: ours.length, renewed, lapsed: lapsed.length };
}
