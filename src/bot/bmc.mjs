// Buy Me a Coffee: the webhook that records memberships. The hourly API check is in bmc-api.mjs.
//
// Field and header names below follow what Buy Me a Coffee's webhook sends as far as public docs show, and the reader is
// deliberately tolerant. Send a test event from the Buy Me a Coffee dashboard to confirm: unknown shapes are logged.
import crypto from 'node:crypto';
import http from 'node:http';
import { normalizeEmail } from './link.mjs';

const SIGNATURE_HEADERS = ['x-signature-sha256', 'x-bmc-signature'];
const MAX_BODY = 1_000_000;

export function verifySignature(rawBody, headerValue, secret) {
  if (!secret || !headerValue) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = String(headerValue).trim().replace(/^sha256=/i, '').toLowerCase();
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Seconds, milliseconds or a date string → ISO, or null. */
export function toIso(v) {
  if (v == null || v === '' || v === false) return null;
  const n = typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : NaN;
  const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A webhook body → the membership change to record, or { ignore: reason }. */
export function parseEvent(body, { acceptTest = false } = {}) {
  const type = String(body?.type ?? '');
  const d = body?.data ?? {};
  if (body?.live_mode === false && !acceptTest) return { ignore: 'test event (set BMC_ACCEPT_TEST_EVENTS=on to accept)' };
  if (!type.startsWith('membership.')) return { ignore: `event ${type || 'unknown'} is not about memberships` };
  const email = normalizeEmail(d.supporter_email ?? d.payer_email ?? d.email);
  const subscriptionId = String(d.id ?? d.subscription_id ?? d.membership_id ?? '');
  if (!email || !subscriptionId) return { ignore: 'no email or membership ID in the event' };
  const periodEnd = toIso(d.current_period_end ?? d.subscription_current_period_end);
  const cancelled = type === 'membership.cancelled' || type === 'membership.canceled' || String(d.canceled ?? d.cancelled) === 'true' || d.status === 'canceled' || d.status === 'cancelled';
  const paused = String(d.paused) === 'true' || d.status === 'paused';
  // An active membership has no end date: it renews until the hourly check says otherwise. A cancelled or paused one runs to the end of the paid period, then grace.
  const status = cancelled ? 'cancelling' : paused ? 'paused' : 'active';
  const paidUntil = status === 'active' ? periodEnd : periodEnd ?? toIso(d.canceled_at ?? d.cancelled_at) ?? new Date().toISOString();
  return {
    type,
    change: {
      subscriptionId,
      email,
      supporterName: d.supporter_name ?? null,
      levelId: d.membership_level_id != null ? String(d.membership_level_id) : null,
      levelName: d.membership_level_name ?? null,
      status,
      startedAt: toIso(d.started_at ?? d.current_period_start),
      paidUntil,
      endedAt: null,
    },
  };
}

/** Applies one verified webhook body. */
export async function applyEvent(body, { store, sync, acceptTest, log = () => {} }) {
  const parsed = parseEvent(body, { acceptTest });
  if (parsed.ignore) {
    log(`ignored: ${parsed.ignore}`);
    return parsed;
  }
  store.upsertMembership(parsed.change);
  await sync.syncEmail(parsed.change.email, parsed.type);
  return parsed;
}

/** Checks and applies one webhook. rawBody must be the exact bytes received. Returns { status, text } to answer with. */
export async function receiveWebhook(rawBody, headers, { secret, store, sync, acceptTest = false, log = () => {} }) {
  if (!secret) return { status: 503, text: 'BMC_WEBHOOK_SECRET is not set' };
  const header = SIGNATURE_HEADERS.map((h) => headers[h]).find(Boolean);
  if (!verifySignature(rawBody, header, secret)) return { status: 401, text: 'bad signature' };
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, text: 'bad json' };
  }
  try {
    await applyEvent(body, { store, sync, acceptTest, log: (m) => log(`[bmc] ${m}`) });
    return { status: 200, text: 'ok' };
  } catch (err) {
    console.error('[bmc] event failed:', err.message);
    return { status: 500, text: 'error' };
  }
}

export function startWebhookServer({ port, log = console.log, ...options }) {
  const server = http.createServer((req, res) => {
    const reply = ({ status, text }) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(text);
    };
    if (req.method === 'GET' && req.url === '/health') return reply({ status: 200, text: 'ok' });
    if (req.method !== 'POST' || !req.url.startsWith('/webhooks/bmc')) return reply({ status: 404, text: 'not found' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => receiveWebhook(Buffer.concat(chunks), req.headers, { ...options, log }).then(reply));
  });
  server.listen(port, () => log(`[bmc] webhook listening on port ${port} at /webhooks/bmc`));
  return server;
}

