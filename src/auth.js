'use strict';

const crypto = require('crypto');
const cfg = require('./config');
const { safeEq } = require('./util');

const COOKIE = 'sp_admin';
const TTL_MS = 7 * 24 * 3600 * 1000;

const sign = (payload) => crypto.createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url');

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_MS, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, mac] = token.split('.');
  if (!payload || !mac || !safeEq(mac, sign(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isAuthed = (req) => verifyToken(parseCookies(req)[COOKIE]);

function setSession(req, res) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${makeToken()}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure}`);
}

function clearSession(req, res) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

const checkPassword = (pw) => !!cfg.adminPassword && typeof pw === 'string' && safeEq(pw, cfg.adminPassword);

// 8 failed logins per 15 minutes per client IP.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

function throttled(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (a.resetAt < Date.now()) {
    attempts.delete(ip);
    return false;
  }
  return a.count >= MAX_FAILS;
}

function recordFail(ip) {
  const a = attempts.get(ip);
  if (!a || a.resetAt < Date.now()) attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else a.count += 1;
}

const recordSuccess = (ip) => attempts.delete(ip);

// Cookies are SameSite=Lax already; this additionally rejects cross-origin writes.
function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return res.status(403).type('text/plain').send('bad origin');
  }
  const allowed = new Set([req.get('host'), new URL(cfg.publicUrl).host]);
  if (!allowed.has(host)) return res.status(403).type('text/plain').send('cross-origin request blocked');
  return next();
}

module.exports = { isAuthed, setSession, clearSession, checkPassword, throttled, recordFail, recordSuccess, originCheck };
