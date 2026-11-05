'use strict';

// Runs Snitch, the Discord bot in src/bot/, inside this process. The overlay never depends on it: if the bot is not set up or
// cannot start, the overlay carries on and says why in the log. The bot and its npm packages only load when it is switched on.

const START_WAIT_MS = 15_000;

function createBotBridge({ enabled, load, log, startWaitMs = START_WAIT_MS }) {
  let bot = null;
  let problem = null;
  let starting = null;

  function start() {
    if (!enabled || starting) return starting;
    starting = Promise.resolve()
      .then(load)
      .then((m) => m.startBot({ webhook: false, handleSignals: false }))
      .then(
        (b) => {
          bot = b;
          log('[bot] running');
        },
        (e) => {
          problem = e.message;
          log(`[bot] not started, the overlay keeps running: ${e.message}`);
        }
      );
    return starting;
  }

  // Passes on a Buy Me a Coffee event the overlay has already checked. Throws while the bot cannot take it, so the webhook
  // answers with an error and the sender can retry; the overlay ignores repeats, so a retry is not announced again.
  async function bmcEvent(body) {
    if (!enabled) return;
    let timer;
    await Promise.race([
      starting,
      new Promise((resolve) => {
        timer = setTimeout(resolve, startWaitMs);
      }),
    ]);
    clearTimeout(timer);
    if (!bot) throw new Error(problem || 'the bot is still starting');
    await bot.applyBmcEvent(body);
  }

  async function stop() {
    const b = bot;
    bot = null;
    if (b) await b.stop();
  }

  return { start, bmcEvent, stop, status: () => ({ enabled, running: !!bot, problem }) };
}

module.exports = { createBotBridge };
