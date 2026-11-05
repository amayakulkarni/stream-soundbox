'use strict';

const { randomUUID } = require('crypto');

const MAX_CLIENTS = 80;

// Server-Sent Events fan-out. Clients are either OBS overlays or the admin page.
class Hub {
  constructor() {
    this.clients = new Map();
  }

  add(req, res, meta) {
    if (this.clients.size >= MAX_CLIENTS) {
      res.status(503).type('text/plain').send('too many connections');
      return null;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const id = randomUUID();
    const client = { id, res, ...meta, connectedAt: Date.now() };
    client.ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        this.remove(id);
      }
    }, 20000);
    this.clients.set(id, client);

    const drop = () => this.remove(id);
    res.on('close', drop); // fires when the socket goes away, unlike req 'close'
    res.on('error', drop);
    return client;
  }

  remove(id) {
    const c = this.clients.get(id);
    if (!c) return;
    clearInterval(c.ping);
    this.clients.delete(id);
  }

  send(client, event, data) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.remove(client.id);
    }
  }

  broadcast(event, data, pred = () => true) {
    for (const c of [...this.clients.values()]) {
      if (pred(c)) this.send(c, event, data);
    }
  }

  count(pred = () => true) {
    let n = 0;
    for (const c of this.clients.values()) if (pred(c)) n++;
    return n;
  }
}

module.exports = { Hub };
