'use strict';

// One new YouTube subscriber must be one announcement, in whichever order YouTube updates its count and its list of names.
//   node test/ytanon.js

const assert = require('assert');
const { createAnonSubs } = require('../src/providers/ytanon');

const MIN = 60_000;
const POLL = 2 * MIN;

// polls = [[count, namesThisPoll], …], one every two minutes. Returns the total number of "Someone" announcements.
function run(polls, { waitMs = 30 * MIN, trailing = 20 } = {}) {
  let t = 0;
  const step = createAnonSubs({ waitMs, now: () => t });
  let someone = 0;
  const last = polls[polls.length - 1][0];
  for (const [count, named] of [...polls, ...Array.from({ length: trailing }, () => [last, 0])]) {
    someone += step(count, named);
    t += POLL;
  }
  return someone;
}

const cases = [
  ['name and count in the same poll', [[100, 0], [101, 1]], 0],
  ['name a poll before the count', [[100, 0], [100, 1], [101, 0]], 0],
  ['name an hour before the count', [[100, 0], [100, 1], ...Array(30).fill([100, 0]), [101, 0]], 0],
  ['count a poll before the name', [[100, 0], [101, 0], [101, 1]], 0],
  ['count, name ten minutes later', [[100, 0], [101, 0], [101, 0], [101, 0], [101, 0], [101, 0], [101, 1]], 0],
  ['private subscriber: a count rise that never gets a name', [[100, 0], [101, 0]], 1],
  ['two private subscribers', [[100, 0], [102, 0]], 2],
  ['one public and one private', [[100, 0], [102, 1]], 1],
  ['a dip that recovers is nobody new', [[100, 0], [99, 0], [100, 0]], 0],
  ['first poll only learns the count', [[500, 0]], 0],
];

let failed = 0;
for (const [title, polls, want] of cases) {
  const got = run(polls);
  const pass = got === want;
  if (!pass) failed += 1;
  console.log(`  ${pass ? '✓' : '✗'} ${title}: ${got} "Someone"${pass ? '' : `, wanted ${want}`}`);
}

// A rise has to outlast the wait, then is said exactly once.
{
  let t = 0;
  const step = createAnonSubs({ waitMs: 30 * MIN, now: () => t });
  step(100, 0);
  t += POLL;
  step(101, 0);
  t = 29 * MIN;
  assert.strictEqual(step(101, 0), 0, 'nothing before the wait is over');
  t = 33 * MIN;
  assert.strictEqual(step(101, 0), 1, 'announced once the wait is over');
  t = 35 * MIN;
  assert.strictEqual(step(101, 0), 0, 'and only once');
  console.log('  ✓ waits the full time, then announces once');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
