'use strict';

const crypto = require('crypto');

const log = (...args) => console.log(new Date().toISOString(), ...args);

// Strip control / bidi-override characters, collapse whitespace, cap length by
// code point. Everything that came from a third party goes through this before
// it is stored or shown.
function clean(value, max = 80) {
  if (value === null || value === undefined) return '';
  const s = String(value)
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, max).join('');
}

// Constant-time string comparison that tolerates different lengths.
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

async function fetchJson(url, { method = 'GET', headers = {}, body, timeout = 15000 } = {}) {
  const target = String(url);
  const res = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const detail =
      (json && (json.error?.message || json.message || json.error_description || json.error)) ||
      text.slice(0, 200);
    const err = new Error(`HTTP ${res.status} from ${target.split('?')[0]}: ${detail}`);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json;
}

function fmtMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
    }).format(n);
  } catch {
    return `${n} ${currency || ''}`.trim();
  }
}

module.exports = { log, clean, safeEq, hmacHex, fetchJson, fmtMoney };
