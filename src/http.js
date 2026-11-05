'use strict';

// A tiny, dependency-free HTTP toolkit: routing, middleware, body readers,
// static files, redirects. Just enough for this app, built on node:http.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { log } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function augment(req, res) {
  const fromProxy = LOOPBACK.has(req.socket.remoteAddress);
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
    req.path = decodeURIComponent(u.pathname);
    req.query = Object.fromEntries(u.searchParams);
  } catch {
    return false;
  }
  req.params = {};
  req.get = (name) => req.headers[String(name).toLowerCase()];
  // nginx sets X-Real-IP from the socket address, overwriting anything the client sent.
  req.ip = (fromProxy && req.headers['x-real-ip']) || req.socket.remoteAddress || '';
  req.secure = !!req.socket.encrypted || (fromProxy && req.headers['x-forwarded-proto'] === 'https');

  res.status = (n) => {
    res.statusCode = n;
    return res;
  };
  res.type = (t) => {
    res.setHeader('Content-Type', t === 'text/plain' || t === 'text/html' ? `${t}; charset=utf-8` : t);
    return res;
  };
  res.set = (a, b) => {
    if (typeof a === 'object') for (const [k, v] of Object.entries(a)) res.setHeader(k, v);
    else res.setHeader(a, b);
    return res;
  };
  res.append = (k, v) => {
    const prev = res.getHeader(k);
    res.setHeader(k, prev ? [].concat(prev, v) : v);
    return res;
  };
  res.send = (body) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(obj));
  };
  res.sendStatus = (n) => {
    res.statusCode = n;
    if (n === 204 || n === 304) return res.end();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(http.STATUS_CODES[n] || String(n));
  };
  res.redirect = (a, b) => {
    const [status, url] = typeof a === 'number' ? [a, b] : [302, a];
    res.statusCode = status;
    res.setHeader('Location', url);
    res.end();
  };
  res.sendFile = (file) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.status(404).type('text/plain').send('not found');
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  };
  return true;
}

function compile(p) {
  if (p instanceof RegExp) return { re: p, names: [] };
  const names = [];
  const src = p
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_]+)/g, (_, n) => {
      names.push(n);
      return '([^/]+)';
    });
  return { re: new RegExp(`^${src}/?$`), names };
}

function matchAny(list, pathname) {
  for (const { re, names } of list) {
    const m = re.exec(pathname);
    if (m) return Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
  }
  return null;
}

function call(fn, req, res, next) {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.then === 'function') r.catch(next);
  } catch (e) {
    next(e);
  }
}

function runChain(handlers, req, res, next) {
  let j = 0;
  const step = (err) => {
    if (err) return next(err);
    const h = handlers[j++];
    if (!h) return next();
    return call(h, req, res, step);
  };
  step();
}

class App {
  constructor() {
    this.layers = [];
  }

  use(a, b) {
    const [prefix, fn] = typeof a === 'string' ? [a, b] : ['', a];
    this.layers.push({ kind: 'use', prefix, fn });
    return this;
  }

  add(method, paths, handlers) {
    this.layers.push({ kind: 'route', method, list: [].concat(paths).map(compile), handlers });
    return this;
  }

  get(p, ...h) {
    return this.add('GET', p, h);
  }

  post(p, ...h) {
    return this.add('POST', p, h);
  }

  handle(req, res) {
    if (!augment(req, res)) return res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad request');
    let i = 0;
    const next = (err) => {
      if (err) return this.onError(err, req, res);
      while (i < this.layers.length) {
        const L = this.layers[i++];
        if (L.kind === 'use') {
          if (L.prefix && req.path !== L.prefix && !req.path.startsWith(`${L.prefix}/`)) continue;
          return call(L.fn, req, res, next);
        }
        if (L.method !== req.method && !(L.method === 'GET' && req.method === 'HEAD')) continue;
        const params = matchAny(L.list, req.path);
        if (!params) continue;
        req.params = params;
        return runChain(L.handlers, req, res, next);
      }
      return res.status(404).type('text/plain').send('not found');
    };
    return next();
  }

  onError(err, req, res) {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) log(`[http] ${req.method} ${req.path}: ${err.stack || err.message}`);
    if (res.headersSent) return res.destroy();
    return res.status(status).type('text/plain').send(status === 500 ? 'server error' : err.message);
  }

  listen(port, host, cb) {
    const server = http.createServer((req, res) => this.handle(req, res));
    server.requestTimeout = 30_000; // bodies must arrive quickly; SSE responses are unaffected
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 65_000; // longer than nginx's upstream keep-alive, avoids sporadic 502s
    return server.listen(port, host, cb);
  }
}

/* ───────────── body readers ───────────── */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(Object.assign(new Error('payload too large'), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const raw = (limit = 1 << 20) => async (req, res, next) => {
  req.body = await readBody(req, limit);
  next();
};

const json = (limit = 100 * 1024) => async (req, res, next) => {
  const buf = await readBody(req, limit);
  try {
    req.body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
  next();
};

const urlencoded = (limit = 4096) => async (req, res, next) => {
  const buf = await readBody(req, limit);
  req.body = Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
  next();
};

/* ───────────── static files ───────────── */

function serveStatic(root, { prefix, headers = {} }) {
  const base = path.resolve(root) + path.sep;
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const rel = req.path.slice(prefix.length);
    if (!rel || rel === '/') return next();
    const file = path.resolve(base, `.${rel}`);
    if (!file.startsWith(base) || path.basename(file).startsWith('.')) return next();
    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return next();
      res.set(headers);
      return res.sendFile(file);
    });
  };
}

module.exports = { App, raw, json, urlencoded, serveStatic };
