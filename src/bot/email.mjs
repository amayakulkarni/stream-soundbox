// The /link code email, in Magenta Forge colours. Plain text goes along for mail apps that do not show HTML.
// Every style is inline and the layout is a table: that is what email apps reliably show.

const MAGENTA = '#ff267c';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** links: { twitchUrl, youtubeUrl, bmcUrl }. Returns { subject, text, html }. */
export function linkCodeEmail({ code, minutes = 15, brandColor = MAGENTA, links = {} }) {
  const c = /^#[0-9a-f]{6}$/i.test(brandColor) ? brandColor : MAGENTA;
  const digits = String(code).replace(/\D/g, '');
  const footer = [['Twitch', links.twitchUrl], ['YouTube', links.youtubeUrl], ['Buy Me a Coffee', links.bmcUrl]].filter(([, u]) => u);

  const text = [
    'MAGENTA FORGE',
    '',
    `Your link code: ${digits}`,
    `It works for ${minutes} minutes.`,
    '',
    `In the Magenta Forge Discord server, run:  /link code:${digits}`,
    '',
    'If you did not ask for this, ignore this email: nothing happens without the code.',
    '',
    ...footer.map(([name, url]) => `${name}: ${url}`),
  ].join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Your Magenta Forge link code</title></head>
<body style="margin:0;padding:0;background:#0f0a12;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your code is ${esc(digits)}. It works for ${minutes} minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0f0a12;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#1a1220;border-radius:16px;border:1px solid #3a1f33;">
      <tr><td style="height:6px;background:${c};border-radius:16px 16px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:28px 32px 8px;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
        <div style="font-size:13px;letter-spacing:3px;font-weight:700;color:${c};">MAGENTA FORGE</div>
        <h1 style="margin:12px 0 0;font-size:22px;line-height:1.3;color:#ffffff;font-weight:700;">Here is your link code</h1>
        <p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:#d9c9d4;">Enter it in Discord to link this email to your account.</p>
      </td></tr>
      <tr><td align="center" style="padding:20px 32px;">
        <div style="display:inline-block;padding:16px 28px;border-radius:12px;background:#0f0a12;border:2px solid ${c};font-family:Consolas,Menlo,monospace;font-size:34px;letter-spacing:10px;font-weight:700;color:#ffffff;">${esc(digits)}</div>
        <div style="margin-top:10px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;color:#a8949f;">Works for ${minutes} minutes</div>
      </td></tr>
      <tr><td style="padding:0 32px 24px;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
        <p style="margin:0;font-size:15px;line-height:1.6;color:#d9c9d4;">In the Magenta Forge server, type:</p>
        <p style="margin:8px 0 0;padding:10px 14px;border-radius:8px;background:#2a1a26;font-family:Consolas,Menlo,monospace;font-size:15px;color:${c};">/link code:${esc(digits)}</p>
        <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#a8949f;">Didn't ask for this? Ignore this email. Nothing happens without the code.</p>
      </td></tr>
      ${footer.length ? `<tr><td style="padding:16px 32px 24px;border-top:1px solid #3a1f33;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;color:#a8949f;">${footer.map(([name, url]) => `<a href="${esc(url)}" style="color:${c};text-decoration:none;font-weight:600;">${esc(name)}</a>`).join(' &nbsp;·&nbsp; ')}</td></tr>` : ''}
    </table>
    <div style="margin-top:16px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;color:#6f5c68;">Sent by Snitch, the Magenta Forge bot, because someone typed this address in /link.</div>
  </td></tr>
</table>
</body></html>`;

  return { subject: `${digits} is your Magenta Forge link code`, text, html };
}
