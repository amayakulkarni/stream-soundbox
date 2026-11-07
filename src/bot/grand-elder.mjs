// Grand Elder is for Amaya's friends, and only the server owner gives or takes it. The role sits above every staff role,
// so Discord already stops anyone else from changing it; this is the second lock, for anyone who still manages to
// (another admin bot, a role moved by mistake). The bot never gives or removes Grand Elder by itself.

/**
 * change: 'added' | 'removed'. executorId: who made the change, from the audit log (null if it could not be found).
 * Returns 'allow', 'revert' or 'unknown'.
 */
export function judgeGrandElderChange({ executorId, ownerId, botId }) {
  if (!executorId) return 'unknown';
  if (executorId === ownerId || executorId === botId) return 'allow'; // the bot only ever undoes someone else's change
  return 'revert';
}
