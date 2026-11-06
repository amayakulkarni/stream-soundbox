# Channel posts

The opening posts for Magenta Forge's channels, and a script that posts them as **Snitch** in magenta embeds. It reads the bot's own `.env` (token, guild, links, tier names), so there is nothing else to set up.

## Use (from the discord-bot folder)
```
node content/publish.mjs                      # preview only: prints every post and any problems, sends nothing
node content/publish.mjs --only rules         # preview one channel
node content/publish.mjs --publish            # post for real
node content/publish.mjs --publish            # again after editing: updates the same posts, no duplicates
node content/publish.mjs --publish --repost   # delete the old posts and post fresh
```
Run it after `npm run setup:apply` has created the channels. Snitch needs View Channel, Send Messages, Embed Links and Manage Messages (for pinning).

## Editing posts
- One file per channel in `posts/`. `channel:` is the channel name; `pin: true` pins the first message.
- `<!-- next -->` on its own line starts another message in the same channel. Each message starts with `# Title`.
- Any other `<!-- comment -->` is a note for you and is never posted.
- `{{TWITCH_URL}}`, `{{BMC_URL}}`, `{{TIER_1_NAME}}` and so on come from the bot's `.env`. A post with an empty one is never sent.

## Channels
Channels are found by name (emoji, case, spaces and dashes ignored). Add `channelId: 123,456` to a file's front matter to target exact channels instead.
Never post to #gate-rules or #gate-announcements: Snitch copies #rules and #announcements into them, so keep @mentions out of those two.
The bot keeps its own button panels in #verification-help, #open-a-ticket and #pick-your-roles, and the voice-room notices; these posts sit beside them.
