# Magenta Forge bot (Snitch)

The Discord bot for Amaya Kulkarni's Magenta Forge server. Snitch runs the server and Snitch Helper 1 to 10 play ambience in voice rooms.

## Getting it running

You need Node 20 or newer. Each step that changes Discord tells you what it is doing first.

1. Install: `npm install`
2. Create the five tiers on Buy Me a Coffee using [docs/BMC-TIERS.md](docs/BMC-TIERS.md).
3. Fill in `.env`: every value starting with `PUT_`. Tokens come from the [Discord Developer Portal](https://discord.com/developers/applications).
4. In the Developer Portal, on Snitch's Bot tab, turn on **Server Members Intent** and **Message Content Intent**.
5. Invite the bots: `npm run invites` prints a link for each. Open them signed in as the server owner. Snitch needs Administrator, because it sets permissions on every channel. After inviting, drag its role to the top of the list.
6. See what would change: `npm run setup`. This changes nothing.
7. Apply it: `npm run setup:apply`. The first time, if people are already in the server, add one of these so nobody is locked out by surprise:
   - `npm run setup:apply -- --verify-existing`: everyone already here stays in as a verified member.
   - `npm run setup:apply -- --existing-are-aspirants`: everyone already here has to send an intro.
8. Set up the helpers: `npm run helpers:setup`
9. Make the sounds, if `audio/` has none: `npm run ambience:generate`
10. Start: `npm start`
11. Point Buy Me a Coffee's webhook at `https://YOUR-ADDRESS/webhooks/bmc` and send a test event. It needs a public address, for example a Cloudflare Tunnel to the `PORT` in `.env`, or the app's nginx setup.

**If Snitch and the helpers are also running for another server:** one Discord bot should only have one program answering it. If the Closet Republic bot still runs with the same tokens, both programs receive DMs sent to Snitch and may both answer, and its code might answer button presses here. Stop that one, or give Magenta Forge its own bot applications. This program ignores other servers, but it can't make the other program do the same.

## Hiding members from people who are not verified

Discord shows anyone in a channel the list of everyone who can see that channel. So the only way to hide members is to never let the two groups share a channel:

- `@everyone` has no permissions at server level. Nobody sees anything without the **Forged** role, which every verified member holds. This also closes any channel you add later.
- Someone not verified sees only **The Gate**: `#gate-rules`, `#gate-announcements` and `#verification-help`. Verified members, staff and helper bots are denied those, so they aren't listed there. People can't post there at all.
- `#gate-rules` and `#gate-announcements` are copies. Snitch mirrors posts, edits and deletes from `#rules` and `#announcements`, with authors and mentions removed. Post only in the member channels.
- `#verification-help` has buttons: send an intro, link a membership, ask for help. Each one is private between that person and the mods.
- The setup also turns off welcome messages and the server widget, which lists online members publicly. League events are tied to a voice channel so the list of who is interested stays hidden, and slash commands with a member search are hidden from unverified people.

`npm run audit:gate` checks the live server this way and reports any leak. It changes nothing.

Limits Discord doesn't let a bot change:
- The owner and Snitch always appear in the list, since they can see everything.
- The member count still shows on the invite and in the server.
- People waiting at the gate can see each other in the list.
- Someone who types a name in Discord's search may still find that account. To rule this out completely, keep aspirants out of the server altogether with a separate lobby server.
- Don't give anyone Administrator, because it overrides the denies and shows them at the gate. The Forge Founder role deliberately doesn't have it.

## How someone joins

1. They join and see only The Gate.
2. They press **Send my intro** (or DM Snitch). A private channel opens for the mods, who approve or decline with a button. Approved people get **Visitor** and **Forged**, and the server opens. Or they press **Link my membership**, which opens the server straight away for supporters.
3. After 90 days with 30 active days in the last 90, no timeouts and a confirmed email (`/link`; any email they own works, and `ELDER_REQUIRE_EMAIL=off` drops this step), the bot makes them a **Forge Elder**: Elder Hall and private voice rooms.
4. **Grand Elder** is given by admins by hand, in Discord. The bot never gives or removes it. It opens the same rooms, and Snitch adds Forged if the person doesn't have it.

## Roles

| Role | How you get it | What it does |
|---|---|---|
| Forge Founder | By hand | Server management, mod powers. Can give Grand Elder |
| Community Rep | By hand | Staff who can run events. Not a mod for tickets and intros |
| Forge Warden | By hand | Mods tickets, intros, timeouts |
| League Commissioner | By hand | Runs `/league` |
| Grand Elder | By hand, admins only | Elder Hall and private voice rooms |
| Forge Elder | Automatic | Elder Hall and private voice rooms |
| Spark to Magenta Core | Buy Me a Coffee | Tier colour. `/discreet on` hides it |
| ... Access | Buy Me a Coffee | Opens the lounges for that tier and below |
| Visitor | Approved intro | The free member role |
| Forged | Automatic | Every verified person. This is what opens the server |
| Stream pings, interests | `#pick-your-roles` | Opt-in pings and hobby rooms |
| Team Hammer, Tongs, Bellows, Rust | By hand | League teams |
| Forge Ambience | Helper bots only | Lets helpers join voice rooms |

## Channels

Your channels are all there: `#rules`, `#announcements`, `#verification-help`, `#the-forge-general`, `#vice-city-grind`, `#night-city-chat`, `#maker-workbench`, `#stream-live`, The Lounge and Co-op Gaming.

The bot's features needed a few more, and most are hidden until someone qualifies: The Gate copies, `#pick-your-roles`, `#supporter-wall`, `#open-a-ticket`, the Build Room (Pomodoro), supporter lounges, Elder Hall, league channels, two hobby rooms (art and writing) and staff channels. To change the layout, edit `config/server-template.json` and run setup again. It reuses what exists and never deletes.

## Commands

| Command | Who | What |
|---|---|---|
| `/intro` | Everyone | How to get verified |
| `/link email:` then `/link code:` | Everyone | Link a Buy Me a Coffee membership. With no SMTP in `.env`, a mod approves instead |
| `/membership status` | Everyone | Your tier, dates and Elder progress |
| `/rank` | Everyone | Your tier's rank and the days left until Forge Elder |
| `/membership grant`, `revoke` | Founder | Free tier for some days; end one at once with no grace |
| `/unlink` | Members; mods for anyone | Remove a link. Your own keeps a 7-day grace, a mod's doesn't |
| `/tiers` | Everyone | The tiers. The Founder also sees levels the bot doesn't recognise |
| `/discreet`, `/thanks` | Members | Hide your tier colour; opt in to the supporter wall |
| `/forget-me` | Everyone | Deletes all the bot holds about you, after a confirmation |
| `/ticket open`, `close` | Everyone | Private chat with the mods |
| `/ticket reopen`, `archive`, `list` | Mods | Archiving saves a transcript in `#ticket-transcripts` |
| `/pomodoro start`, `stop`, `status`, `join`, `leave` | Members | Focus sessions in the Build Room. Muting is opt-in |
| `/todo add`, `list`, `done`, `remove`, `clear` | Members | Your list, or the voice channel's with `list:room` |
| `/vc status`, `clear-status`, `meeting`, `meeting-end`, `note` | Members in that voice channel | Status line, meetings with an agenda, pinned notes |
| Message menu: Pin / Unpin in voice chat | Members in that voice channel | |
| `/room invite`, `remove`, `rename`, `limit`, `close` | Room owner | Your private voice room. Mods can't see it unless invited |
| `/ambience` | Mods | Which rooms have sound and which helper is playing |
| `/league fixtures`, `standings` | Members | |
| `/league schedule`, `result`, `cancel`, `season` | Commissioners, staff | Times are India time. Rooms and reminders are automatic |
| `/socials` | Everyone | Twitch, YouTube, Buy Me a Coffee |
| `/stream announce` | Mods | Posts in `#announcements` and pings who opted in |
| `/sync` | Mods | Re-check someone's roles, or everyone's |

## Ambience

A helper joins a room when the first person arrives and leaves 20 seconds after the last one goes, deleting its notice as it leaves. With all ten busy, a room waits for the next free one. A dropped connection retries after 3 seconds, then up to 60. Co-op Gaming has no ambience on purpose, since it is for coordinating matches. To change rooms, copy `config/ambience.example.json` to `config/ambience.json`.

The sounds in `audio/generated/` are soft synth loops made by a script, so nothing needs a licence. To use your own music, add `audio/the-lounge.mp3`, or a folder `audio/the-lounge/` for a random track each time. Only use music you have the rights to play. An animated picture is optional: set `visual` and `caption` on a room and add `assets/visuals/<visual>.gif`.

## Before going live

The automated tests (`npm test`) use fake Discord and Buy Me a Coffee sides, so they check the rules but not the real services. Nothing has run against the real Discord server yet, because the tokens aren't in `.env`. Please check these first:

- `npm run audit:gate` after setup.
- From a second account, join and go through an intro.
- Join The Lounge and check a helper plays.
- Send a Buy Me a Coffee test event with `BMC_ACCEPT_TEST_EVENTS=on`. Its field names come from public guides rather than an official reference, so the bot accepts variations and logs what it ignores. Check `/tiers` shows no unknown level, then set it back to `off`.

## Files

- `src/bot/`: the bot. The rule modules have no Discord code in them and are tested on their own; `bot.mjs`, `discord-adapters.mjs`, `interactions.mjs` and `ambience-voice.mjs` connect them to Discord.
- `scripts/bot/`: setup, helpers-setup, audit-gate, generate-ambience.
- `config/server-template.json`: roles, channels and permissions. `config/discord-tiers.json` is generated and not committed.
- `docs/BMC-TIERS.md`: the tier text to paste into Buy Me a Coffee.
- `data/`: the SQLite database, with member emails. Not committed; back it up.
