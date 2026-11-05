'use strict';

// Works out how many private YouTube subscribers to announce as "Someone".
//
// YouTube's subscriber count and its list of recent subscribers update separately, in either order and sometimes far
// apart. So a rise in the count and a new name are usually the same person, and each has to wait for the other:
//   - a name that arrives first is remembered, and cancels the rise that follows it;
//   - a rise that arrives first waits (waitMs), so a late name can cancel it before anyone hears "Someone".
// Only a rise that never gets a name is announced. A count that dips and recovers is not a new supporter, so only a
// new highest count is treated as a rise.
function createAnonSubs({ waitMs = 30 * 60_000, nameMemoryMs = 6 * 3_600_000, now = () => Date.now() } = {}) {
  let highest = null;
  let rises = []; // when each unexplained rise was seen, oldest first
  let names = []; // when each unmatched name was seen, oldest first

  // Call once per poll. count = the current subscriber count (null if hidden), named = names announced by this poll.
  // Returns how many "Someone" announcements are due now.
  return function step(count, named) {
    if (count === null || !Number.isFinite(count)) {
      highest = null;
      rises = [];
      names = [];
      return 0;
    }
    const at = now();
    const carried = rises.length; // only rises from an earlier poll may be announced: they have had a poll to get a name
    const delta = highest === null ? 0 : Math.max(0, count - highest);
    highest = highest === null ? count : Math.max(highest, count);
    for (let i = 0; i < delta; i++) rises.push(at);
    for (let i = 0; i < named; i++) names.push(at);
    names = names.filter((t) => at - t <= nameMemoryMs);

    const matched = Math.min(rises.length, names.length);
    rises.splice(0, matched);
    names.splice(0, matched);

    const eligible = Math.max(0, carried - matched);
    let due = 0;
    while (due < eligible && due < rises.length && at - rises[due] >= waitMs) due += 1;
    rises.splice(0, due);
    return due;
  };
}

module.exports = { createAnonSubs };
