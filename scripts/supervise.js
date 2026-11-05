'use strict';

// Keeps the server running on machines without systemd (e.g. Windows):
//   npm run start:supervised
// If the server process ever exits unexpectedly it is started again, waiting
// 2s, 4s, 8s … up to 30s between rapid crashes. Ctrl+C stops everything.

const { spawn } = require('child_process');
const path = require('path');

let child = null;
let stopping = false;
let delay = 2000;
let startedAt = 0;

function start() {
  startedAt = Date.now();
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(code === null ? 0 : code);
    delay = Date.now() - startedAt > 60_000 ? 2000 : Math.min(delay * 2, 30_000);
    console.log(`[supervisor] server exited (${signal || code}). Restarting in ${delay / 1000}s…`);
    setTimeout(start, delay);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

start();
