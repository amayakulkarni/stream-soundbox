'use strict';

const crypto = require('crypto');
const cfg = require('../config');
const { clean, safeEq, hmacHex, fmtMoney, log } = require('../util');

const SIG_HEADERS = ['x-signature-sha256', 'x-bmc-signature']; // Buy Me a Coffee's docs name both

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

module.exports = function createBmc({ store, engine, forward = () => {} }) {
  const runtime = { received: 0, lastAt: null, lastType: null, lastRejectedAt: null };

  const configured = () => !!(cfg.bmc.webhookSecret || cfg.bmc.webhookToken);

  function authorized(req, raw) {
    const token = req.query.token;
    if (cfg.bmc.webhookToken && typeof token === 'string' && safeEq(token, cfg.bmc.webhookToken)) return true;
    if (cfg.bmc.webhookSecret) {
      for (const h of SIG_HEADERS) {
        const v = req.get(h);
        if (!v) continue;
        const given = v.replace(/^sha256=/i, '').trim().toLowerCase();
        if (safeEq(given, hmacHex(cfg.bmc.webhookSecret, raw))) return true;
      }
    }
    return false;
  }

  function activeMembers() {
    return Object.values(store.state.bmc.members).filter((m) => m.active).length;
  }

  function refreshMemberCounter() {
    engine.setCounter('bmcMembers', activeMembers());
  }

  function handleEvent(body) {
    const type = String(body.type || body.event || '').toLowerCase();
    const d = body.data || body.response || {};
    const live = body.live_mode !== false; // BMC's "send test" uses live_mode:false
    const test = !live;
    const ref = d.id ?? d.transaction_id ?? d.psp_id ?? body.event_id ?? crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    const name = d.supporter_name || d.payer_name || d.name || '';
    const money = fmtMoney(d.amount ?? d.total_amount_charged, d.currency);

    // ── one-time support ("coffees") ──
    if (type === 'donation.created') {
      const coffees = Math.max(1, Number(d.coffee_count) || 1);
      const detail = [money, `${coffees} compute`].filter(Boolean).join(' · ');
      const res = engine.ingest({
        key: `bmc:donation:${ref}`,
        type: 'bmc.donation',
        name,
        detail,
        message: d.support_note || d.message || d.note,
        test,
      });
      if (!res.duplicate && !test) {
        const cur = d.currency || 'USD';
        const b = store.state.bmc;
        b.donations += 1;
        b.totals[cur] = (b.totals[cur] || 0) + (Number(d.amount) || 0);
        engine.bump('bmcCoffees', coffees);
        store.save();
      }
      return res;
    }

    if (type === 'donation.refunded') {
      if (!store.markSeen(`bmc:refund:${ref}`)) return { duplicate: true };
      if (!test) {
        const cur = d.currency || 'USD';
        const coffees = Math.max(1, Number(d.coffee_count) || 1);
        const b = store.state.bmc;
        b.totals[cur] = Math.max(0, (b.totals[cur] || 0) - (Number(d.amount) || 0));
        b.donations = Math.max(0, b.donations - 1);
        engine.bump('bmcCoffees', -coffees);
        store.save();
      }
      engine.note(`Refund: ${clean(name, 40) || 'a supporter'} ${money}`.trim());
      return { logged: true };
    }

    // ── memberships ──
    if (type === 'membership.started' || type === 'membership.created') {
      const mid = String(d.id ?? d.psp_id ?? d.supporter_id ?? name);
      const level = d.membership_level_name;
      const every = d.duration_type || 'month';
      const detail = [level, money && `${money}/${every}`].filter(Boolean).join(' · ');
      // Someone already counted as an active member is not new, whichever date this event carries.
      const res = !test && store.state.bmc.members[mid]?.active
        ? { duplicate: true }
        : engine.ingest({ key: `bmc:membership:${mid}:${d.started_at || d.created_at || ref}`, type: 'bmc.membership', name, detail, test });
      if (!test) {
        store.state.bmc.members[mid] = { name: clean(name, 40), level: clean(level, 40), active: true };
        store.save();
        refreshMemberCounter();
      }
      return res;
    }

    if (type === 'membership.updated') {
      const mid = String(d.id ?? d.psp_id ?? d.supporter_id ?? name);
      const cancelled = truthy(d.canceled) || truthy(d.cancelled) || /cancel/i.test(String(d.status || ''));
      if (!test) {
        const prev = store.state.bmc.members[mid] || {};
        store.state.bmc.members[mid] = {
          name: clean(name, 40) || prev.name || '',
          level: clean(d.membership_level_name, 40) || prev.level || '',
          active: !cancelled,
        };
        store.save();
        refreshMemberCounter();
      }
      engine.note(`Membership updated: ${clean(name, 40) || 'a member'}${d.membership_level_name ? ` → ${clean(d.membership_level_name, 40)}` : ''}${cancelled ? ' (cancelled)' : ''}`);
      return { logged: true };
    }

    if (type === 'membership.cancelled' || type === 'membership.canceled') {
      const mid = String(d.id ?? d.psp_id ?? d.supporter_id ?? name);
      if (!test) {
        const prev = store.state.bmc.members[mid] || { name: clean(name, 40), level: clean(d.membership_level_name, 40) };
        store.state.bmc.members[mid] = { ...prev, active: false };
        store.save();
        refreshMemberCounter();
      }
      engine.note(`Membership cancelled: ${clean(name, 40) || 'a member'}`);
      return { logged: true };
    }

    // ── shop / extras ──
    if (type === 'extra_purchase.created' || type === 'extra.created' || type === 'extra_purchase') {
      const title = d.extra_title || d.title || d.extra_name || '';
      return engine.ingest({
        key: `bmc:extra:${ref}`,
        type: 'bmc.extra',
        name,
        detail: [clean(title, 40), money].filter(Boolean).join(' · '),
        message: d.support_note || d.message,
        test,
      });
    }

    engine.note(`Buy Me a Coffee event ignored: ${clean(type, 40) || 'unknown'}`);
    return { ignored: true };
  }

  // Express handler; req.body is the raw Buffer (see server.js).
  function handleWebhook(req, res) {
    if (!configured()) return res.status(503).type('text/plain').send('bmc webhooks not configured');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!authorized(req, raw)) {
      runtime.lastRejectedAt = Date.now();
      return res.status(401).type('text/plain').send('unauthorized');
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).type('text/plain').send('bad json');
    }
    runtime.received += 1;
    runtime.lastAt = Date.now();
    runtime.lastType = clean(body.type || body.event, 40);
    try {
      handleEvent(body);
    } catch (e) {
      log(`[bmc] event error: ${e.message}`);
    }
    // The Discord bot keeps its own membership records, from this same webhook: one Buy Me a Coffee setting, one address.
    return Promise.resolve()
      .then(() => forward(body))
      .then(
        () => res.sendStatus(200),
        (e) => {
          log(`[bmc] the Discord bot could not take this event: ${e.message}`);
          res.status(503).type('text/plain').send('discord bot unavailable');
        }
      );
  }

  function status() {
    const b = store.state.bmc;
    return {
      configured: configured(),
      secretSet: !!cfg.bmc.webhookSecret,
      tokenSet: !!cfg.bmc.webhookToken,
      webhookUrl: `${cfg.publicUrl}/webhooks/bmc${cfg.bmc.webhookToken ? `?token=${cfg.bmc.webhookToken}` : ''}`,
      received: runtime.received,
      lastAt: runtime.lastAt,
      lastType: runtime.lastType,
      lastRejectedAt: runtime.lastRejectedAt,
      activeMembers: activeMembers(),
      donations: b.donations,
      totals: b.totals,
    };
  }

  return { configured, handleWebhook, handleEvent, status };
};
