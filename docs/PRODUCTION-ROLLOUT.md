# Production rollout: merged overlay and Snitch

This replaces the standalone overlay running at supporters.amayakulkarni.com with the merged app. It goes in two stages so each can be undone separately: first the overlay fixes with the bot switched off, then the bot. Nothing here has been run on the live server yet (written 5 November 2026).

## Where things stand

- **Production today:** the overlay is live and healthy behind Cloudflare, and had been up for about 4.4 days when checked. It appears to be on the netcup server (there is a `netcup-kvm-1` key on this PC), installed in `/opt/supporters-overlay` by `deploy/install.sh`, with systemd and nginx. I have not logged in, so the server's Node version and free space are unknown.
- **Rehearsal:** I ran the update on a throwaway Debian container with Node 22, starting from a stand-in old version with an existing `.env` and data. All checks passed: `.env` values and counters kept, both webhook forms accepted, bot off with placeholder tokens, overlay still up when the bot can't start, manual rollback, and automatic rollback of a broken release. systemd was simulated, and real nginx, TLS and Cloudflare were not part of it.
- **Found by the rehearsal and fixed:** the package install failed on a server with no compiler, which would have made the real update roll itself back.
- **Not tested anywhere:** the bot against real Discord or Buy Me a Coffee. All its tests use fakes because the tokens are still placeholders.

## Decide before starting

1. **Are Snitch's tokens still used by the Closet Republic bot?** If yes, stop that bot or create new bot applications for Magenta Forge first. With both running on one token, both receive DMs sent to Snitch and may both answer, which would bring back double replies.
2. **Which Node version is on the server?** The bot's database package requires Node 22 or newer, although the bot's own guide says 20. The overlay runs on 20, so stage 1 can go ahead either way, but stage 2 needs the upgrade.
3. **What about people already in the Discord server?** `setup:apply` closes the server to anyone unverified. Choose `--verify-existing` (they stay in) or `--existing-are-aspirants` (they must send an intro).

## Stage 1: overlay fixes, bot off

Do this outside a stream. The overlay restarts once for a few seconds. New `.env` settings arrive as `PUT_` placeholders, and the bot stays off until a real token is set.

**1. Check the server.**

```bash
node -v; npm -v; free -m; df -h /opt; systemctl is-active supporters
```

**2. Take your own backup.** The installer backs up code only and leaves `.env` and `data/` in place, so this copy is your safety net for those.

```bash
sudo tar -czf /root/supporters-before-merge.tar.gz -C /opt/supporters-overlay .env data
```

**3. Upload `supporters-overlay.zip`** to `/tmp` on the server, with WinSCP or `pscp`. It contains no `.env`, data or `node_modules`.

**4. Run the update.** It backs up the code, installs packages, restarts, checks the app answers, and rolls back by itself if it doesn't.

```bash
cd /tmp && rm -rf rel && unzip -q supporters-overlay.zip -d rel
sudo bash rel/supporters-overlay/deploy/install.sh update --from /tmp/supporters-overlay.zip
```

**5. Check it.**

- `curl -s https://supporters.amayakulkarni.com/healthz` answers `ok` with a low uptime.
- `/admin` logs in with the same password and the counters are unchanged.
- OBS reconnects, and a test announcement from the dashboard appears once.
- *Open right now* shows any warning about two sources or two voices. **Follow it if it appears:** this is the most likely remaining cause of doubles, and I can't see your OBS setup from here.
- A Buy Me a Coffee test event shows up. The webhook address stays the same, so there is nothing to change there.

**Behaviour you will notice:** a private YouTube subscriber's "Someone" now arrives up to about 30 minutes late, which is what stops the double. `YOUTUBE_ANON_WAIT_MIN` changes the wait. Gifted Twitch subs now announce the gift only, not each recipient as well.

## Stage 2: turn on the bot

Start this soon after stage 1. Until the bot is on, membership events are not recorded for it.

**1. Upgrade to Node 22 or newer** if step 1 showed an older version, then repeat the update command so packages are installed for the new version.

**2. Fill in the bot's settings** in `/opt/supporters-overlay/.env`: `SNITCH_BOT_TOKEN`, `SNITCH_CLIENT_ID`, `DISCORD_GUILD_ID`, the helper tokens and client IDs, `BMC_API_TOKEN`, and SMTP if you want email codes. The tier names are already there. Keep your existing `BMC_WEBHOOK_SECRET` and `BMC_WEBHOOK_TOKEN`. Don't restart yet.

**3. Discord Developer Portal:** turn on Server Members Intent and Message Content Intent for Snitch.

**4. Invite the bots and preview the changes.** `npm run setup` changes nothing.

```bash
cd /opt/supporters-overlay
sudo npm run invites
sudo npm run setup
```

**5. Apply the Discord setup.** This changes your live Discord server and is not undone by the rollback below. Use the option you chose above. The `chown` matters: these commands run as root, and the service must be able to write to the bot's database.

```bash
sudo npm run setup:apply -- --verify-existing
sudo npm run helpers:setup
sudo chown -R supporters:supporters data
```

**6. Point the chat feed at Discord.** Set `DISCORD_CHANNEL_IDS` to the #stream-live channel ID if you want Discord chat on the overlay.

**7. Restart and watch the log.** Look for `[bot] running`. If you see `[bot] not started`, the line says why, and the overlay is still fine.

```bash
sudo systemctl restart supporters
journalctl -u supporters -f
```

**8. Check it.**

- `sudo npm run audit:gate` reports no leaks, then run `sudo chown -R supporters:supporters data` again.
- From a second account, join the server and send an intro.
- Join The Lounge and check a helper plays ambience.
- Set `BMC_ACCEPT_TEST_EVENTS=on`, restart, send a Buy Me a Coffee test event, and check the log and `/tiers`. Then set it back to `off` and restart. The bot's field names come from public guides rather than an official reference, so this is the check most likely to find something.

**Existing paying members:** the hourly check only updates memberships the bot already knows about, so it won't import people who joined before the bot was on. They need `/membership grant`, or a new event from Buy Me a Coffee, before `/link` will find them.

## If something goes wrong

| Problem | What to do | What it undoes |
|---|---|---|
| The bot misbehaves but the overlay is fine | Set `SNITCH_BOT_TOKEN=PUT_SNITCH_BOT_TOKEN_HERE` in `.env`, then `sudo systemctl restart supporters` | Turns the bot off and leaves the overlay fixes in place. Fastest option. |
| The overlay is broken after the update | `sudo bash /tmp/rel/supporters-overlay/deploy/install.sh rollback` | Restores the previous code. `.env` and `data/` stay as they are. |
| Data or `.env` got damaged | Stop the service, then `sudo tar -xzf /root/supporters-before-merge.tar.gz -C /opt/supporters-overlay` and start it again | Restores the state from before stage 1. Anything newer is lost. |
| Discord roles or channels are wrong | Fix them in Discord, or adjust and rerun setup | The rollbacks above don't touch Discord. |

Run only one copy of the bot. Don't start the old `discord-bot` folder anywhere once this is live: a second copy on the same token would double every welcome and reply.
