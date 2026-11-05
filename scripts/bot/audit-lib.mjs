// Looks at the live server the way someone who is not verified would.
import { PermissionFlagsBits as P } from 'discord.js';

export function auditGate(guild, ids) {
  const everyone = guild.roles.everyone;
  const gateIds = new Set([ids.channels.gateRules, ids.channels.gateAnnouncements, ids.channels.verificationHelp, ids.channels.gate]);
  const verified = ids.roles.verified;
  const leaks = [];
  const gateViewers = new Map();
  if (everyone.permissions.has(P.ViewChannel)) leaks.push('@everyone can still view channels at server level');
  for (const ch of guild.channels.cache.values()) {
    if (ch.isThread?.() || !ch.permissionsFor) continue;
    const sees = ch.permissionsFor(everyone).has(P.ViewChannel);
    if (sees && !gateIds.has(ch.id)) leaks.push(`#${ch.name} can be seen by people who are not verified`);
    if (gateIds.has(ch.id) && ch.isTextBased?.()) {
      // Who shows up in this channel's member list, apart from the people still waiting.
      const listed = guild.members.cache.filter((m) => m.roles.cache.has(verified) && ch.permissionsFor(m).has(P.ViewChannel) && m.id !== guild.ownerId && m.id !== guild.client.user.id);
      gateViewers.set(ch.name, [...listed.values()].map((m) => m.user.tag ?? m.user.username));
      if (listed.size) leaks.push(`#${ch.name} shows verified member(s) to people who are not verified: ${gateViewers.get(ch.name).join(', ')}`);
    }
  }
  const gateMembersWithoutVerified = guild.members.cache.filter((m) => !m.user.bot && !m.roles.cache.has(verified) && m.id !== guild.ownerId);
  return { leaks, gateViewers, aspirants: gateMembersWithoutVerified.size };
}

export function printAudit(audit, say = console.log) {
  say('\nGate check (the server as seen by someone not verified):');
  if (!audit.leaks.length) say('  OK: they can only see the gate channels, and no verified member is listed there.');
  for (const l of audit.leaks) say(`  LEAK: ${l}`);
  say(`  People waiting at the gate right now: ${audit.aspirants}`);
  say('  Discord limits no bot can change: the server owner and Snitch always appear in the list; the total member');
  say('  count on the invite and the server header stays visible; someone who knows an exact name may find that account through search.');
}
