'use strict';

const { log } = require('./util');

// Re-runs `fn` every `intervalSec()` seconds with exponential back-off on
// failure (capped at 10 minutes). Never overlaps itself.
function createPoller(name, intervalSec, fn) {
  let timer = null;
  let running = false;
  let stopped = true;
  let failures = 0;
  const status = { lastRunAt: null, lastOkAt: null, lastError: null, running: false };

  async function run() {
    if (running) return;
    running = true;
    status.running = true;
    try {
      await fn();
      status.lastOkAt = Date.now();
      status.lastError = null;
      failures = 0;
    } catch (e) {
      failures += 1;
      status.lastError = e.message;
      log(`[${name}] poll failed (${failures}): ${e.message}`);
    } finally {
      status.lastRunAt = Date.now();
      status.running = false;
      running = false;
    }
  }

  function next() {
    if (stopped) return;
    const base = Math.max(15, Number(intervalSec()) || 60) * 1000;
    const delay = Math.min(base * 2 ** Math.min(failures, 4), 10 * 60 * 1000);
    timer = setTimeout(async () => {
      await run();
      next();
    }, delay);
  }

  return {
    status,
    start() {
      stopped = false;
      clearTimeout(timer);
      run().finally(next);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    // Immediate poll (admin "refresh"); the regular schedule continues.
    async now() {
      await run();
      return status;
    },
  };
}

module.exports = { createPoller };
