// Buy Me a Coffee offers this server webhooks only, so nothing can be looked up. Its documented membership events are
// started, level changed and cancelled, and none is documented for a monthly renewal. So a paid period passing with no
// event may mean a lost cancellation, or may mean only that the renewal went through silently.
//
// Taking a tier away on that guess could remove every paying member about a month in. By default the mods are told once
// per paid period, and they check the Buy Me a Coffee dashboard. BMC_LAPSE_WITHOUT_RENEWAL=on starts the grace period
// automatically instead: turn it on only after the log has shown a real "renewal seen" line.
import { maskEmail } from './unlink.mjs';

const DAY = 86_400_000;
export const OVERDUE_MARGIN_DAYS = 3; // payment retries and slow webhooks
const NOTICE_OWNER = 'bmc-overdue';

export async function checkOverdue({ store, sync, autoLapse = false, post = async () => {}, now = () => Date.now() }) {
  let flagged = 0;
  let lapsed = 0;
  for (const m of store.activeMemberships()) {
    const end = Date.parse(m.paid_until);
    if (!Number.isFinite(end) || now() < end + OVERDUE_MARGIN_DAYS * DAY) continue;
    if (autoLapse) {
      store.lapse(m.subscription_id);
      lapsed += 1;
      await sync.syncEmail(m.email, 'no renewal from Buy Me a Coffee');
      continue;
    }
    if (!store.notice(NOTICE_OWNER, `${m.subscription_id}:${m.paid_until}`, '', true)) continue; // already told the mods
    flagged += 1;
    const who = m.supporter_name ?? 'A supporter';
    await post(`⏰ ${who} (${maskEmail(m.email)}): the ${m.level_name ?? 'membership'} period ended ${m.paid_until.slice(0, 10)} and Buy Me a Coffee has sent nothing since. Check the dashboard. If it really ended, use \`/membership revoke\`. They keep their tier until then.`);
  }
  return { flagged, lapsed };
}
