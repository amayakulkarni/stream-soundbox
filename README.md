# Supporters overlay

A pink, minimal OBS browser-source overlay that shows live **YouTube**, **Twitch** and **Buy Me a Coffee** supporter numbers and announces each new supporter by name, one every 5 seconds.

- Includes **Snitch**, the Magenta Forge Discord bot, which runs in the same process (see [Discord bot](#discord-bot))
- Node.js 22+ for the bot (the overlay alone runs on 20+). Run `npm install` once. The overlay alone needs no packages: they only load when the bot is switched on
- Port `42001`, configured through `.env`
- Webhooks for Twitch and Buy Me a Coffee, polling for YouTube
- Admin dashboard at `/admin`
- nginx reverse proxy + systemd unit for `supporters.amayakulkarni.com`

## Run it locally

```bash
cp .env.example .env      # set ADMIN_PASSWORD and SESSION_SECRET at minimum
node src/server.js        # or: npm start
```

- Overlay: http://localhost:42001/overlay
- Admin: http://localhost:42001/admin
- Preview without any accounts connected: http://localhost:42001/overlay?demo=1&preview=1

Webhooks and OAuth need a public HTTPS address, so for those use the server setup below.

## OBS

Add a **Browser** source, paste a URL from the top of `/admin`, set 1920 × 1080, leave Custom CSS empty.

| URL | Shows |
|---|---|
| `/overlay` | counters, announcements and chat together |
| `/counters` | counters only |
| `/alerts` | announcements only |
| `/comments` | YouTube + Twitch + Discord chat only (right side) |
| `/goal` | progress bar toward a target (set title, target and what it counts under *Look and goal*) |
| `/status` | small badges: YouTube live/offline, Discord connected |
| `/latest` | the newest follower, subscriber or compute purchase, always visible |

Every widget also works under `/overlay/<name>` (for example `/overlay/chat`). The page itself is always transparent; pills and chat bubbles are translucent glass, and *Look and goal → Panel opacity* (or `?glass=0-100`) controls how see-through they are.

Optional URL parameters: `chatpos=left`, `chat=0` (hide chat in the combined view), `glass=40`, `blur=0`, `pos=bottom-right` (placement of `/goal`, `/status`, `/latest`), `layout=column`, `cpos=top-right` (counters position: `top|bottom` + `left|center|right`), `apos=top-center` (announcement position, also `middle`), `scale=1.25`, `preview=1`, `demo=1`.

If `OVERLAY_KEY` is set, every overlay URL needs `?key=…` (the dashboard shows ready-made URLs).

## Put it on the server

On a Debian/Ubuntu machine whose DNS for `supporters.amayakulkarni.com` points at it:

```bash
sudo ./deploy/install.sh --email you@example.com
```

That installs to `/opt/supporters-overlay`, generates every secret in `.env`, starts the `supporters` systemd service, issues a Let's Encrypt certificate and enables the nginx proxy. It prints the admin password once.

Manual route: copy the folder, create `.env`, install `deploy/systemd/supporters.service` (replace `__NODE__` with your `node` path), and put `deploy/nginx/supporters.amayakulkarni.com.conf` in `sites-enabled` once a certificate exists. The nginx file proxies to `127.0.0.1:42001`, disables buffering for the event streams, rate-limits the login and webhooks, and turns off access logs for URLs that carry `?key=`.


**Updating later:** copy the new version to the server (a zip or a folder) and run

```bash
sudo ./deploy/install.sh update --from supporters-overlay.zip   # or --from /path/to/folder
```

It backs up the running version, replaces the code, keeps your `.env` and `data/`, adds any new settings to `.env` (empty/off), restarts, checks the app answers, and **rolls back automatically** if it doesn't. `sudo ./deploy/install.sh rollback` restores the latest backup by hand (the last 5 are kept in `/var/backups/supporters-overlay`).

## Two OBS windows (for example HDR YouTube + HD Twitch)

The server handles any number of overlays at once; each OBS window just opens the page itself. If the browser source is blank in one of them:

- Run the second OBS as its own **portable** copy (its own folder, started with `--portable --multi`). Two OBS windows sharing one settings folder fight over the same browser cache, and the second one's browser sources can stay blank.
- Give each window's source a label (`/overlay?key=…&name=hdr-youtube`, `&name=hd-twitch`) and check *Open right now* in `/admin` to see which one connected.
- Put `?sound=0` on one of the two, or you will hear every announcement twice.
- On the HDR window, raise *SDR white level* (Settings → Video) if the overlay looks dim.

## Sound announcements

*Sounds* in `/admin`: a built-in girly chime per announcement type (sparkle, chime, bell, bubble pop, harp swirl, arcade coin; synthesised in the browser, nothing to download), a volume slider, and your own `.mp3/.wav/.ogg/.m4a` files (upload up to 3 MB, or drop them in `data/sounds/`). *Read the name aloud* speaks "Marigold Rose, new subscriber on YouTube" but only works in a normal browser: **OBS's browser source cannot do text-to-speech.** For OBS, use the voice helper below and leave that switch off.

**Voice helper (for OBS).** `tools/speak.js` runs on your streaming PC, listens to the same announcement feed and speaks with Windows' own voices (macOS: `say`); OBS picks it up through *Desktop Audio*. Needs only Node 20+:

```bash
node tools/speak.js --list-voices
node tools/speak.js --url https://supporters.amayakulkarni.com --key YOUR_OVERLAY_KEY --voice "Microsoft Zira Desktop" --rate 0
```

Or edit and double-click `tools/Start-voice-helper.bat`. It reconnects by itself and shows in *Open right now* as `voice-helper`. Run it on one PC only (two would speak twice). `--dry-run` prints instead of speaking. Written for Windows PowerShell's built-in `System.Speech`; I could only test the connection and text part on Linux.

In OBS tick *Control audio via OBS* on the browser source if you want it on its own mixer track. A normal browser blocks audio until you click once (a "Click once to turn sound on" button appears); OBS does not. Use `?sound=0` on a source to mute it (if two overlays are open) and `?volume=40` to override the volume.

## Turning features off

In `.env`: `DISABLE_YOUTUBE_MEMBERS=true` and/or `DISABLE_TWITCH_SUBS=true`. The counter and its announcements disappear from the overlay and dashboard, the API calls stop, and the connect screens no longer ask Google/Twitch for the matching permission (reconnect once after changing it). Restart the app after editing `.env`.

Buy Me a Coffee purchases are labelled "compute" on screen (counter, announcements, dashboard).

## If a supporter is announced twice

Each announcement is sent to every connected source, so check the setup first. *Open right now* in the dashboard warns you when it sees one of these:

- **Two sources showing announcements**, for example `/overlay` and `/overlay/alerts` in OBS, or the same source in two scenes or left open in a browser tab. Keep one, and use `/overlay/counters` for the others.
- **Two voices**: more than one voice helper, or the voice helper together with *Read the name aloud*.

The app itself only announces a supporter once, even when the same event arrives again or from two routes:

- **YouTube** updates its count and its list of names separately. A rise in the count waits `YOUTUBE_ANON_WAIT_MIN` minutes (30 by default) for a name before it is announced as "Someone", and a name that came first cancels the rise that follows it. A private subscriber's "Someone" therefore arrives up to about half an hour late.
- **Twitch** subs are recognised by person, not by delivery, so a leftover EventSub subscription cannot repeat them. A gifted sub adds to the count and the log, and only the gift itself is announced.
- **Buy Me a Coffee** retries are ignored, and a second start event for an active member is not announced.
- **Discord**: Snitch handles one member at a time and posts one welcome per day and tier. Run only one copy of the bot, because two copies would each post it. The app starts its bot only after it owns its port, so a second copy of this app cannot start a second bot.

## Discord bot

Snitch runs inside this app and shares its `.env`, `package.json` and Buy Me a Coffee webhook. It starts when `SNITCH_BOT_TOKEN` is set. If it cannot start, the overlay keeps running and the log says why. The commands, roles and setup are in [docs/DISCORD-BOT.md](docs/DISCORD-BOT.md), and the tier text for Buy Me a Coffee is in [docs/BMC-TIERS.md](docs/BMC-TIERS.md).

```
npm install
npm run setup:apply        # creates the roles and channels, and writes config/discord-tiers.json
npm run invites            # invite links for Snitch and its helper bots
npm run ambience:generate  # sounds for any voice room that has none
npm start                  # the overlay and the bot together
```

- **Buy Me a Coffee needs one webhook only:** `<PUBLIC_URL>/webhooks/bmc`. Remove any older webhook that pointed at the bot's own port. When the bot is set up but down, the webhook answers 503 so the event can be sent again. The overlay ignores the repeat.
- **Chat feed:** it uses Snitch's token unless `DISCORD_BOT_TOKEN` is set. Put the `#stream-live` channel ID in `DISCORD_CHANNEL_IDS`.

## Chat feed (YouTube + Twitch + Discord)

Messages from all three appear in one feed, newest at the bottom, fading after 60 s (all adjustable under *Chat feed*). Super Chats and new members get a highlight. Moderator-deleted and banned messages disappear. Bots, `!commands` and words you list are hidden.

**YouTube** uses the same connection as the counters. It does **not** need you to be live: it checks for an active broadcast every 90 s (1 API unit), starts reading when you go live, ignores chat history from before it joined, and goes back to waiting when the stream ends. Failures never stop it: network or server errors retry with back-off (5 s up to 60 s), an expired login shows *Reconnect YouTube* in the dashboard and keeps retrying, and an exhausted daily quota is reported and retried every 15 minutes. While you are live it reads at most every 10 s, about 1,800 of your 10,000 daily API units per hour; it pauses (no units) when no overlay with chat is open.

**Twitch** needs nothing extra. It reads your channel's chat over Twitch's IRC, signed in anonymously, so there is no quota and it works whether or not you are live. The channel is the connected Twitch account (or `TWITCH_CHANNEL` in `.env`). Emotes show as images, cheers show as highlighted bits, deleted/timed-out messages disappear, and any dropped connection (or Twitch asking us to reconnect) reconnects by itself with back-off.

**Discord** needs a bot: [Developer Portal](https://discord.com/developers/applications) → New Application → Bot → copy the token, and turn on **Message Content Intent**. Invite it to your server with permission *View Channel* and *Read Message History*, then put the token in `DISCORD_BOT_TOKEN` and one or more channel IDs (Developer Mode → right-click channel → Copy ID) in `DISCORD_CHANNEL_IDS`, comma separated. The bot polls the REST API every 3 s, so there is no connection to drop; rate limits, outages and permission errors are shown in the dashboard and retried.

**Keeping it running.** On the Linux server systemd restarts the app (`deploy/systemd`). On Windows or anywhere without systemd use `npm run start:supervised`, which restarts the server if it ever crashes.

## Connect the services

Do this from `/admin → Connections`.

**YouTube**
1. Google Cloud Console → enable *YouTube Data API v3* → Credentials → OAuth client (Web application).
2. Authorized redirect URI: `https://supporters.amayakulkarni.com/admin/auth/youtube/callback`
3. Put the ID and secret in `.env`, restart, press **Connect YouTube**.
4. Set the OAuth consent screen to **In production**. In "Testing" mode Google expires the login after 7 days.

**Twitch**
1. https://dev.twitch.tv/console/apps → register an app. OAuth Redirect URL: `https://supporters.amayakulkarni.com/admin/auth/twitch/callback`
2. Put the ID, secret and a `TWITCH_EVENTSUB_SECRET` (10–100 characters) in `.env`, restart.
3. **Connect Twitch**, then **Set up webhooks**. This subscribes to follows, subs, resubs and gifted subs.

**Buy Me a Coffee**
1. Settings → Webhooks → add the URL shown in the dashboard: `https://supporters.amayakulkarni.com/webhooks/bmc?token=<BMC_WEBHOOK_TOKEN>`
2. If Buy Me a Coffee shows a signing secret, put it in `BMC_WEBHOOK_SECRET`. Requests are accepted if the URL token matches **or** the HMAC signature is valid.
3. Use their "send test" button. It shows an announcement without touching the counters.

## How it behaves

- **One announcement every 5 seconds** (change under *Announcements*). The line is kept on the server, so refreshing OBS never skips anyone, and it is saved to disk across restarts. Each announcement stays on screen for 4.2 s so there's a beat between them.
- **Wait for OBS** (on by default): while no overlay is open, announcements wait instead of playing to nobody.
- **First run learns, it doesn't announce.** Existing YouTube subscribers/members and recent Twitch followers are recorded silently, so you don't get a flood on day one.
- Duplicates (webhook retries, a follower seen by both webhook and polling) are announced once.
- Counters come from the platform APIs. Webhooks nudge them up immediately and the next check corrects them. Use **Adjust** in the dashboard for fixed offsets, for example the Buy Me a Coffee members you had before the webhook existed.

## Things worth knowing

- **YouTube** rounds public subscriber counts above 1,000 to three significant figures. Names of new subscribers only appear for people whose subscriptions are public. Member counts need memberships enabled on the channel. Checking every 120 s costs about 2,200 of your 10,000 daily API quota units.
- **Twitch** only reports subscriber names through webhooks (the API can give a total but not "who's new"), so keep webhooks set up. A new-follower fallback by polling is on by default.
- **Buy Me a Coffee** has no read API used here: member counts come from membership webhook events. Their docs name the signature header both `x-signature-sha256` and `X-BMC-Signature`, so the app accepts either. I wasn't able to test against a live Buy Me a Coffee account; the payload handling follows their documented fields and is covered by tests using those shapes. Confirm with their "send test" button and the *Activity* list.
- Names are cleaned (control and right-to-left override characters removed, length capped) and always rendered as text.

## Security

Admin login is a single password with a signed, HttpOnly cookie (7 days), throttled after 8 failures per 15 minutes. State-changing admin calls reject cross-origin requests. Webhooks are rejected unless signed or tokened; Twitch messages older than 10 minutes are refused. OAuth tokens live in `data/tokens.json` (mode 0600). The app listens on `127.0.0.1` only.

## Tests

```bash
node test/run.js   # supporters, webhooks, admin, restarts
node test/chat.js  # chat feed, YouTube not-live/errors/restarts, Discord, widgets
# or: npm test
```

Boots the real server against mock YouTube and Twitch APIs and checks pacing, signatures, polling, de-duplication, admin access, OAuth, and restart persistence (~100 checks, about a minute).

## Layout

```
src/server.js          routes, admin API, OAuth, boot
src/engine.js          counters, event intake, the paced announcement queue
src/providers/         youtube.js · twitch.js · bmc.js
src/http.js            small router / body / static helpers (no dependencies)
public/overlay.html    OBS page   (assets/overlay.css, overlay.js, theme.css)
public/admin/          dashboard and login
deploy/                install.sh · nginx/ · systemd/
test/run.js            end-to-end tests
```

## Voice helper in Rust (own app audio for OBS)

`tools/voice-helper/` is a small Windows app that speaks announcements and can open two portable OBS windows. OBS captures just its audio with *Application Audio Capture*. Build with `cargo build --release` (see `tools/voice-helper/README.md`). It has not been compiled by the author yet, so `tools/speak.js` remains as a fallback.
