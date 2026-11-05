// Support tickets: one private channel per ticket, visible only to the opener and the mods.
//
// This file holds the rules and has no Discord library in it, so it can run against a fake in the tests.
// discord-adapters.mjs supplies the real `tk` adapter.
//
// tk: {
//   createChannel({ number, openerId, name }) → channelId
//   postFirstMessage(channelId, { number, openerId, subject, details })
//   setOpenerCanSend(channelId, openerId, allowed)
//   rename(channelId, name)
//   postClosedControls(channelId, text)
//   postPlain(channelId, text)
//   fetchMessages(channelId) → [{ at, authorId, author, text, attachments: [url] }]
//   sendTranscript(channelId, { filename, content, summary })
//   deleteChannel(channelId, reason)
//   modLog(text)
// }

export const ticketName = (number, closed = false) => `${closed ? 'closed' : 'ticket'}-${String(number).padStart(4, '0')}`;

/** Forge Founder and Forge Warden. The Community Rep role (index 1 in staffRoleIds) is not a mod here. */
export const modRoleIds = (cfg) => (cfg.staffRoleIds || []).filter((id, i) => i !== 1 && id);
export const isMod = (cfg, roleIds) => modRoleIds(cfg).some((id) => roleIds.has(id));

const MAX_SUBJECT = 80;
const MAX_DETAILS = 1500;
const clip = (s, n) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n);

/** The plain-text copy kept in #ticket-transcripts. No message text is ever stored in the database. */
export function buildTranscript(ticket, { openerName, closedByName, archivedBy, messages, contentAvailable = true }) {
  const iso = (v) => (v ? new Date(v).toISOString() : '-');
  const lines = [
    `Magenta Forge ticket ${String(ticket.number).padStart(4, '0')}`,
    `Opened by: ${openerName || 'unknown'} (${ticket.opener_id})`,
    `Opened: ${iso(ticket.opened_at)}`,
    `Closed: ${iso(ticket.closed_at)}${ticket.closed_by ? ` by ${closedByName || ticket.closed_by} (${ticket.closed_by})` : ''}`,
    `Archived: ${new Date().toISOString()} by ${archivedBy}`,
    `Messages: ${messages.length}`,
    '-'.repeat(60),
  ];
  for (const m of messages) {
    const text = m.text || (contentAvailable ? '' : '[message text not available: the bot\'s Message Content Intent is off]');
    const [first = '', ...rest] = text.split('\n');
    lines.push(`${iso(m.at)} | ${m.author} (${m.authorId}) | ${first}`);
    for (const l of rest) lines.push(`    ${l}`);
    for (const url of m.attachments || []) lines.push(`    attachment: ${url}`);
  }
  return lines.join('\n') + '\n';
}

export function createTickets({ cfg, store, tk, now = () => Date.now() }) {
  const iso = () => new Date(now()).toISOString();
  const link = (channelId) => `<#${channelId}>`;
  const modLog = (text) => Promise.resolve(tk.modLog(text)).catch(() => {});

  async function open({ userId, subject, details }) {
    if (!cfg.channels.ticketCategory) return { error: 'Tickets are not set up yet. Ask a Forge Warden.' };
    const existing = store.openTicketFor(userId);
    if (existing?.channel_id) return { error: `You already have an open ticket: ${link(existing.channel_id)}`, existing: true, channelId: existing.channel_id };
    const number = store.ticketCreate(userId, iso());
    let channelId = null;
    try {
      channelId = await tk.createChannel({ number, openerId: userId, name: ticketName(number) });
      store.ticketSetChannel(number, channelId);
      await tk.postFirstMessage(channelId, { number, openerId: userId, subject: clip(subject, MAX_SUBJECT) || 'No subject', details: clip(details, MAX_DETAILS) || 'No details' });
    } catch (err) {
      console.error('[bot] ticket open failed:', err.message);
      if (channelId) await tk.deleteChannel(channelId, 'ticket could not be set up').catch(() => {});
      store.ticketDelete(number);
      return { error: 'Could not open a ticket just now. Please try again in a minute, or ask a Forge Warden.' };
    }
    modLog(`Ticket ${String(number).padStart(4, '0')} opened by <@${userId}>: ${link(channelId)}`);
    return { ok: true, number, channelId };
  }

  async function close({ userId, roleIds, channelId, reason }) {
    const t = store.ticketByChannel(channelId);
    if (!t) return 'Run this inside a ticket channel.';
    if (t.status === 'archived') return 'That ticket is already archived.';
    if (t.status === 'closed') return 'That ticket is already closed.';
    if (userId !== t.opener_id && !isMod(cfg, roleIds)) return 'Only the person who opened the ticket or a mod can close it.';
    store.ticketClose(t.number, userId, iso());
    await tk.setOpenerCanSend(channelId, t.opener_id, false).catch((e) => console.error('[bot] ticket permissions:', e.message));
    await tk.rename(channelId, ticketName(t.number, true)).catch(() => {}); // Discord allows only 2 renames per 10 minutes
    const why = clip(reason, 300);
    await tk.postClosedControls(channelId, `Ticket closed by <@${userId}>${why ? `: ${why}` : '.'} A mod can reopen it or archive it.`);
    modLog(`Ticket ${String(t.number).padStart(4, '0')} closed by <@${userId}>.`);
    return 'Ticket closed.';
  }

  async function reopen({ userId, roleIds, channelId }) {
    if (!isMod(cfg, roleIds)) return 'Only mods can reopen a ticket.';
    const t = store.ticketByChannel(channelId);
    if (!t) return 'Run this inside a ticket channel.';
    if (t.status !== 'closed') return t.status === 'open' ? 'That ticket is already open.' : 'That ticket is archived.';
    store.ticketReopen(t.number);
    await tk.setOpenerCanSend(channelId, t.opener_id, true).catch((e) => console.error('[bot] ticket permissions:', e.message));
    await tk.rename(channelId, ticketName(t.number)).catch(() => {});
    await tk.postPlain(channelId, `<@${t.opener_id}> your ticket was reopened by a mod.`);
    modLog(`Ticket ${String(t.number).padStart(4, '0')} reopened by <@${userId}>.`);
    return 'Ticket reopened.';
  }

  async function archive({ userId, roleIds, channelId, archivedByName }) {
    if (!isMod(cfg, roleIds)) return 'Only mods can archive a ticket.';
    const t = store.ticketByChannel(channelId);
    if (!t) return 'Run this inside a ticket channel.';
    if (t.status === 'open') return 'Close the ticket first, then archive it.';
    if (t.status === 'archived') return 'That ticket is already archived.';
    if (!cfg.channels.ticketTranscripts) return 'There is no #ticket-transcripts channel set up, so the ticket was not archived.';
    const messages = await tk.fetchMessages(channelId);
    const opener = messages.find((m) => m.authorId === t.opener_id);
    const closer = messages.find((m) => m.authorId === t.closed_by);
    const content = buildTranscript(t, {
      openerName: opener?.author,
      closedByName: closer?.author,
      archivedBy: archivedByName || userId,
      messages,
      contentAvailable: tk.contentAvailable !== false,
    });
    const padded = String(t.number).padStart(4, '0');
    await tk.sendTranscript(cfg.channels.ticketTranscripts, {
      filename: `ticket-${padded}.txt`,
      content,
      summary: `Ticket ${padded}: opened by <@${t.opener_id}>, archived by <@${userId}> (${messages.length} messages).`,
    });
    store.ticketArchive(t.number, userId, iso()); // only after the transcript is safely posted
    modLog(`Ticket ${padded} archived by <@${userId}>. Transcript is in <#${cfg.channels.ticketTranscripts}>.`);
    await tk.deleteChannel(channelId, `Ticket ${padded} archived`);
    return `Ticket ${padded} archived.`;
  }

  function list({ roleIds }) {
    if (!isMod(cfg, roleIds)) return 'Only mods can list tickets.';
    const rows = store.ticketsOpenOrClosed();
    if (!rows.length) return 'No open or closed tickets.';
    return rows
      .map((t) => `${t.status === 'open' ? '🟢' : '🔴'} ${link(t.channel_id)} (${t.status}) opened by <@${t.opener_id}> ${t.opened_at.slice(0, 10)}`)
      .join('\n')
      .slice(0, 1900);
  }

  return { open, close, reopen, archive, list };
}
