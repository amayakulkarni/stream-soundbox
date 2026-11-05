# Buy Me a Coffee tiers for amayakulkarni

Create these at [buymeacoffee.com/amayakulkarni](https://buymeacoffee.com/amayakulkarni) under Memberships. Use the names exactly as written, because the bot matches levels by name until you add their IDs. If you change a name or price here, change `TIER_n_NAME` or `TIER_n_PRICE` in `.env` too.

| # | Tier | Price | Discord colour role | Lounges opened |
|---|---|---|---|---|
| 1 | Spark | $1/month | Spark | #backstage, Backstage voice |
| 2 | Ember | $3/month | Ember | The above |
| 3 | Forgehand | $5/month | Forgehand | The above, plus #forgehand-bench |
| 4 | Netrunner | $10/month | Netrunner | The above, plus #netrunner-den |
| 5 | Magenta Core | $25/month | Magenta Core | The above, plus #magenta-core, Core Room voice |

The free role, **Visitor**, comes from an approved intro. Buy Me a Coffee has no free membership, so it isn't a level there. Prices and names match the publishing thread's drafts.

## Text to paste

**Spark, $1/month.** Keep the forge lit. You get the Spark colour in Discord plus #backstage and the Backstage voice room, with stream previews and behind-the-scenes.

**Ember, $3/month.** Everything in Spark, plus your name on the supporter wall and stream schedule previews.

**Forgehand, $5/month.** Everything in Ember, plus #forgehand-bench and a vote on what gets built or played next.

**Netrunner, $10/month.** Everything in Forgehand, plus #netrunner-den with build files, configs and early access to videos.

**Magenta Core, $25/month.** Everything in Netrunner, plus #magenta-core and the Core Room: a direct line to Amaya.

Add this line to every tier: *After joining, press "Link my membership" in the Magenta Forge Discord, using the same email you paid with.*

## After creating them

1. Add a webhook under Buy Me a Coffee's settings, pointing at `https://YOUR-ADDRESS/webhooks/bmc`, and put its secret in `.env` as `BMC_WEBHOOK_SECRET`.
2. When the first event arrives for a level, the Founder can run `/tiers`. It lists any level the bot can't match, with the ID. Put IDs in `.env` as `TIER_n_BMC_ID` so renaming a level later can't break anything.

## What happens with payments

- **Active:** stays active until a cancellation webhook or a mod ends it. Buy Me a Coffee has no API for this bot to check, and no documented renewal event, so a missed cancellation won't end a tier by itself. When a paid period passes with no event for 3 days, the mods get one message in the mod log asking them to check the dashboard. See `BMC_LAPSE_WITHOUT_RENEWAL` in `.env` to end it automatically instead.
- **Cancelled or paused:** the tier stays until the paid period ends, then for a 7-day grace period, with DM reminders. Renewing during grace keeps the tier with no second welcome.
- **Lapsed:** tier and lounge roles go. A member who also has Visitor keeps the rest of the server. One who joined only by paying goes back to The Gate until they send an intro or renew.
- **Refund or chargeback:** the Founder runs `/membership revoke`, which ends it at once with no grace.
- **More than one tier:** the highest counts.
