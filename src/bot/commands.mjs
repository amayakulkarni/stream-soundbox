// Slash commands. Registered on the Magenta Forge server only, so nothing shows up in any other server Snitch is in.
//
// Hiding members: a "user" option lets the person typing search the server's members, which would show people who are
// not verified who is here. So every command with one needs a permission only verified members have (Connect or
// ModerateMembers). Commands open to everyone in the gate (/intro, /link, /membership status, /forget-me, /ticket open) have none.
import { ApplicationCommandType, ContextMenuCommandBuilder, PermissionFlagsBits as P, SlashCommandBuilder as S } from 'discord.js';

const member = P.Connect; // only the verified role has this
const mod = P.ModerateMembers;
const teamChoices = (cfg) => cfg.league?.teams?.map((t) => ({ name: t.name, value: t.key })) ?? [];
const gameChoices = (cfg) => cfg.league?.games?.map((g) => ({ name: g.label, value: g.slug })) ?? [];

export function buildCommands(cfg) {
  const tierChoices = cfg.tiers.map((t) => ({ name: t.name, value: t.slug }));
  const onOff = (c) => c.setName('state').setDescription('On or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' });
  const whichList = (c) => c.setName('list').setDescription('Your own list or this voice channel\'s').addChoices({ name: 'mine', value: 'mine' }, { name: 'room', value: 'room' });

  const list = [
    new S().setName('intro').setDescription('How to get verified and join Magenta Forge'),
    new S().setName('link').setDescription('Link your Buy Me a Coffee membership')
      .addStringOption((o) => o.setName('email').setDescription('The email you paid with'))
      .addStringOption((o) => o.setName('code').setDescription('The code from the email')),
    new S().setName('unlink').setDescription('Remove a Buy Me a Coffee link').setDefaultMemberPermissions(member)
      .addUserOption((o) => o.setName('member').setDescription('Mods only: the member to unlink'))
      .addStringOption((o) => o.setName('user_id').setDescription('Mods only: a Discord user ID, for someone who left the server'))
      .addStringOption((o) => o.setName('reason').setDescription('Mods only: why (goes in #mod-log)')),
    new S().setName('membership').setDescription('Your membership, and staff tools')
      .addSubcommand((c) => c.setName('status').setDescription('See your tier and when it ends'))
      .addSubcommand((c) => c.setName('grant').setDescription('Founders: give a free tier for some days')
        .addStringOption((o) => o.setName('member').setDescription('A mention or user ID').setRequired(true))
        .addStringOption((o) => o.setName('tier').setDescription('Tier').setRequired(true).addChoices(...tierChoices))
        .addIntegerOption((o) => o.setName('days').setDescription('Days').setRequired(true).setMinValue(1).setMaxValue(3650)))
      .addSubcommand((c) => c.setName('revoke').setDescription('Founders: end a membership now, with no grace (refunds)')
        .addStringOption((o) => o.setName('member').setDescription('A mention or user ID').setRequired(true))),
    new S().setName('tiers').setDescription('The Buy Me a Coffee tiers and what they unlock'),
    new S().setName('rank').setDescription('Your tier, its rank, and the days left until Forge Elder'),
    new S().setName('discreet').setDescription('Hide or show your tier colour').setDefaultMemberPermissions(member).addStringOption(onOff),
    new S().setName('thanks').setDescription('Be welcomed on the supporter wall when you join a tier').setDefaultMemberPermissions(member).addStringOption(onOff),
    new S().setName('forget-me').setDescription('Delete everything the bot holds about you'),
    new S().setName('socials').setDescription('Where to find Amaya: Twitch, YouTube and Buy Me a Coffee'),
    new S().setName('stream').setDescription('Mods: announce a stream').setDefaultMemberPermissions(mod)
      .addSubcommand((c) => c.setName('announce').setDescription('Post a going-live message and ping who opted in')
        .addStringOption((o) => o.setName('kind').setDescription('What kind of stream').setRequired(true).addChoices({ name: 'build', value: 'build' }, { name: 'gameplay', value: 'gameplay' }))
        .addStringOption((o) => o.setName('title').setDescription('Stream title').setRequired(true).setMaxLength(200))),
    new S().setName('sync').setDescription('Mods: re-check a member\'s roles, or everyone\'s').setDefaultMemberPermissions(mod)
      .addStringOption((o) => o.setName('member').setDescription('A mention or user ID; leave out for everyone')),
    new S().setName('ticket').setDescription('Talk privately to the staff')
      .addSubcommand((c) => c.setName('open').setDescription('Open a private ticket')
        .addStringOption((o) => o.setName('subject').setDescription('What it is about').setMaxLength(80))
        .addStringOption((o) => o.setName('details').setDescription('Tell us more').setMaxLength(1500)))
      .addSubcommand((c) => c.setName('close').setDescription('Close this ticket').addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(300)))
      .addSubcommand((c) => c.setName('reopen').setDescription('Mods: reopen this ticket'))
      .addSubcommand((c) => c.setName('archive').setDescription('Mods: save a transcript and delete this ticket'))
      .addSubcommand((c) => c.setName('list').setDescription('Mods: list tickets')),
    new S().setName('pomodoro').setDescription('Focus sessions in the Build Room').setDefaultMemberPermissions(member)
      .addSubcommand((c) => c.setName('start').setDescription('Start a Pomodoro here')
        .addIntegerOption((o) => o.setName('focus').setDescription('Focus minutes').setMinValue(5).setMaxValue(90))
        .addIntegerOption((o) => o.setName('break').setDescription('Break minutes').setMinValue(1).setMaxValue(30))
        .addIntegerOption((o) => o.setName('rounds').setDescription('Focus blocks').setMinValue(1).setMaxValue(8)))
      .addSubcommand((c) => c.setName('stop').setDescription('Stop the Pomodoro'))
      .addSubcommand((c) => c.setName('status').setDescription('See the Pomodoro'))
      .addSubcommand((c) => c.setName('join').setDescription('Be muted during focus'))
      .addSubcommand((c) => c.setName('leave').setDescription('Stop being muted')),
    new S().setName('todo').setDescription('Your to-do list, or a voice channel\'s').setDefaultMemberPermissions(member)
      .addSubcommand((c) => c.setName('add').setDescription('Add a task').addStringOption((o) => o.setName('task').setDescription('The task').setRequired(true).setMaxLength(200)).addStringOption(whichList))
      .addSubcommand((c) => c.setName('list').setDescription('Show a list').addStringOption(whichList))
      .addSubcommand((c) => c.setName('done').setDescription('Tick a task off').addIntegerOption((o) => o.setName('item').setDescription('Number').setRequired(true).setMinValue(1)).addStringOption(whichList))
      .addSubcommand((c) => c.setName('remove').setDescription('Remove a task').addIntegerOption((o) => o.setName('item').setDescription('Number').setRequired(true).setMinValue(1)).addStringOption(whichList))
      .addSubcommand((c) => c.setName('clear').setDescription('Clear a list').addStringOption(whichList)),
    new S().setName('vc').setDescription('Voice channel tools').setDefaultMemberPermissions(member)
      .addSubcommand((c) => c.setName('status').setDescription('Set the status line').addStringOption((o) => o.setName('text').setDescription('Status').setRequired(true).setMaxLength(100)))
      .addSubcommand((c) => c.setName('clear-status').setDescription('Clear the status line'))
      .addSubcommand((c) => c.setName('meeting').setDescription('Start a meeting with a pinned agenda')
        .addStringOption((o) => o.setName('topic').setDescription('Topic').setMaxLength(80))
        .addIntegerOption((o) => o.setName('minutes').setDescription('How long').setMinValue(5).setMaxValue(240)))
      .addSubcommand((c) => c.setName('meeting-end').setDescription('End the meeting'))
      .addSubcommand((c) => c.setName('note').setDescription('Post and pin a note').addStringOption((o) => o.setName('text').setDescription('Note').setRequired(true).setMaxLength(300))),
    new S().setName('room').setDescription('Your private voice room').setDefaultMemberPermissions(member)
      .addSubcommand((c) => c.setName('invite').setDescription('Let someone in').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
      .addSubcommand((c) => c.setName('remove').setDescription('Remove someone').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
      .addSubcommand((c) => c.setName('rename').setDescription('Rename the room').addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(60)))
      .addSubcommand((c) => c.setName('limit').setDescription('Limit how many people fit (0 = no limit)').addIntegerOption((o) => o.setName('people').setDescription('Number of people').setRequired(true).setMinValue(0).setMaxValue(99)))
      .addSubcommand((c) => c.setName('close').setDescription('Close your room now')),
    new S().setName('camp').setDescription('Owner: keep a helper playing in the Elder Campfire, even when it is empty').setDefaultMemberPermissions(mod)
      .addSubcommand((c) => c.setName('start').setDescription('Light the campfire: a helper joins and stays until /camp stop'))
      .addSubcommand((c) => c.setName('stop').setDescription('Put the campfire out: back to normal (the helper leaves once nobody is there)'))
      .addSubcommand((c) => c.setName('status').setDescription('Is the camp running?')),
    new S().setName('ambience').setDescription('Mods: see which rooms have ambient sound and which bot is playing where').setDefaultMemberPermissions(mod),
    new ContextMenuCommandBuilder().setName('Pin in voice chat').setType(ApplicationCommandType.Message).setDefaultMemberPermissions(member),
    new ContextMenuCommandBuilder().setName('Unpin from voice chat').setType(ApplicationCommandType.Message).setDefaultMemberPermissions(member),
  ];

  if (cfg.league?.teams?.length) {
    list.push(
      new S().setName('league').setDescription('The Magenta Forge League').setDefaultMemberPermissions(member)
        .addSubcommand((c) => c.setName('fixtures').setDescription('Upcoming matches'))
        .addSubcommand((c) => c.setName('standings').setDescription('The season table'))
        .addSubcommand((c) => c.setName('schedule').setDescription('Commissioners: add a match')
          .addStringOption((o) => o.setName('game').setDescription('Game').setRequired(true).addChoices(...gameChoices(cfg)))
          .addStringOption((o) => o.setName('when').setDescription('YYYY-MM-DD HH:mm in India time').setRequired(true))
          .addStringOption((o) => o.setName('kind').setDescription('Match type').addChoices({ name: 'head-to-head', value: 'h2h' }, { name: 'free-for-all', value: 'ffa' }))
          .addStringOption((o) => o.setName('team1').setDescription('Team').addChoices(...teamChoices(cfg)))
          .addStringOption((o) => o.setName('team2').setDescription('Team').addChoices(...teamChoices(cfg)))
          .addStringOption((o) => o.setName('teams').setDescription('Free-for-all: team names, comma-separated (empty for all)'))
          .addIntegerOption((o) => o.setName('week').setDescription('Week'))
          .addStringOption((o) => o.setName('note').setDescription('Note').setMaxLength(300)))
        .addSubcommand((c) => c.setName('result').setDescription('Commissioners: enter or correct a result')
          .addIntegerOption((o) => o.setName('match').setDescription('Match number').setRequired(true))
          .addStringOption((o) => o.setName('winner').setDescription('Who won').addChoices(...teamChoices(cfg)))
          .addBooleanOption((o) => o.setName('draw').setDescription('It was a draw'))
          .addStringOption((o) => o.setName('first').setDescription('Free-for-all: 1st place').addChoices(...teamChoices(cfg)))
          .addStringOption((o) => o.setName('second').setDescription('Free-for-all: 2nd place').addChoices(...teamChoices(cfg)))
          .addStringOption((o) => o.setName('third').setDescription('Free-for-all: 3rd place').addChoices(...teamChoices(cfg)))
          .addStringOption((o) => o.setName('fourth').setDescription('Free-for-all: 4th place').addChoices(...teamChoices(cfg)))
          .addStringOption((o) => o.setName('best_sport').setDescription('The team the opponents voted kindest (+1)').addChoices(...teamChoices(cfg)))
          .addStringOption((o) => o.setName('late').setDescription('Teams that did not field a squad on time, separated by commas').setMaxLength(100))
          .addStringOption((o) => o.setName('forfeit').setDescription('Team that forfeited (scores 0, the other side wins)').setMaxLength(100))
          .addStringOption((o) => o.setName('penalty').setDescription('Team whose points are voided for a conduct breach').setMaxLength(100)))
        .addSubcommand((c) => c.setName('cancel').setDescription('Commissioners: cancel a match').addIntegerOption((o) => o.setName('match').setDescription('Match number').setRequired(true)))
        .addSubcommand((c) => c.setName('season').setDescription('Commissioners: start a new season').addStringOption((o) => o.setName('name').setDescription('Season name').setMaxLength(60))),
    );
  }
  return list.map((c) => c.toJSON());
}
