// Magenta Forge League: fixtures, match rooms, reminders, results and standings. The rules are here with no
// Discord library in them; interactions.mjs routes /league and discord-adapters.mjs does the posting.
// Scoring: head-to-head win 3, draw 2, loss 1; free-for-all 4/3/2/1;
// +1 for fielding a squad on time; +1 Best Sport (kindness); a forfeit scores 0 and the other side wins;
// a conduct penalty (rule 6) voids the team's points for that night. Only team keys, games and times are
// stored; the only member ID kept is who created a fixture (deleted by /forget-me).

export const DEFAULT_GAMES = [
  { slug: 'gta-online', label: 'GTA Online' },
  { slug: 'gta-6', label: 'GTA 6' },
  { slug: 'fortnite', label: 'Fortnite' },
  { slug: 'minecraft', label: 'Minecraft (side quest)' },
  { slug: 'cyberpunk', label: 'Cyberpunk 2077 (side quest)' },
];

export const POINTS = { win: 3, draw: 2, loss: 1, forfeit: 0, ffa: [4, 3, 2, 1], showedUp: 1, bestSport: 1 };
const MIN = 60_000;
export const REMINDERS = [
  { bit: 1, kind: 'day', before: 24 * 60 * MIN },
  { bit: 2, kind: 'hour', before: 60 * MIN },
  { bit: 4, kind: 'room', before: 15 * MIN },
];
export const ROOM_KEEP_MS = 3 * 60 * MIN; // a match room that never got a result is removed 3 hours after the start
const IST = 330 * MIN;

/** "2026-11-01 20:00" (India time) → UTC milliseconds, or null. */
export function parseWhen(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi) - IST;
  return new Date(ms).getUTCDate() === d ? ms : null;
}

const unix = (ms) => Math.floor(ms / 1000);
export const gameLabel = (cfg, slug) => cfg.league.games.find((g) => g.slug === slug)?.label ?? slug;
export const teamOf = (cfg, key) => cfg.league.teams.find((t) => t.key === key);
export const teamName = (cfg, key) => {
  const t = teamOf(cfg, key);
  return t ? `${t.emoji ? `${t.emoji} ` : ''}${t.name}` : key;
};

/** "hammer, Tongs" → team keys (names, keys and role words all work), or { error }. */
export function resolveTeams(cfg, text) {
  const keys = [];
  for (const part of String(text ?? '').split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const t = cfg.league.teams.find((x) => x.key === part || x.name.toLowerCase() === part || x.key === part.replace(/\s+/g, '-'));
    if (!t) return { error: `"${part}" is not a team. Teams: ${cfg.league.teams.map((x) => x.key).join(', ')}.` };
    if (!keys.includes(t.key)) keys.push(t.key);
  }
  return { keys };
}

/**
 * Points per team for one match.
 * input: { winner?, draw?, placements? (ffa: team keys, first to last), forfeit?, late?, penalty?, bestSport? } (lists are arrays of keys)
 * Returns { rows: [{ team, points, outcome, showedUp, bestSport, penalty }] } or { error }.
 */
export function scoreMatch(match, input = {}) {
  const teams = match.teams;
  const inMatch = (k) => teams.includes(k);
  const forfeit = input.forfeit ?? [];
  const late = input.late ?? [];
  const penalty = input.penalty ?? [];
  const bestSport = input.bestSport ?? [];
  for (const [label, list] of [['forfeit', forfeit], ['late', late], ['penalty', penalty], ['best sport', bestSport]]) {
    const bad = list.find((k) => !inMatch(k));
    if (bad) return { error: `${bad} is not playing in this match (the ${label} option).` };
  }
  if (bestSport.length > 1) return { error: 'Only one team gets Best Sport.' };
  const outcome = {};
  if (match.kind === 'ffa') {
    const order = input.placements ?? [];
    if (new Set(order).size !== order.length || order.some((k) => !inMatch(k))) return { error: 'Placements must name each team in this match once.' };
    const rest = teams.filter((k) => !order.includes(k) && !forfeit.includes(k));
    if (rest.length) return { error: `Give a place for every team that played: missing ${rest.join(', ')}.` };
    const scale = POINTS.ffa.slice(POINTS.ffa.length - teams.length); // 2 teams: 2,1. 4 teams: 4,3,2,1.
    const playing = order.filter((k) => !forfeit.includes(k));
    playing.forEach((k, n) => (outcome[k] = { place: n + 1, base: scale[n] ?? 1 }));
    for (const k of forfeit) outcome[k] = { place: null, base: POINTS.forfeit };
  } else {
    if (teams.length !== 2) return { error: 'A head-to-head match needs exactly two teams.' };
    const [a, b] = teams;
    if (forfeit.length === 2) return { error: 'Both teams cannot forfeit: cancel the match instead.' };
    if (forfeit.length === 1) {
      const loser = forfeit[0];
      const winner = loser === a ? b : a;
      outcome[winner] = { result: 'win', base: POINTS.win };
      outcome[loser] = { result: 'forfeit', base: POINTS.forfeit };
    } else if (input.draw) {
      outcome[a] = { result: 'draw', base: POINTS.draw };
      outcome[b] = { result: 'draw', base: POINTS.draw };
    } else if (input.winner && inMatch(input.winner)) {
      const loser = input.winner === a ? b : a;
      outcome[input.winner] = { result: 'win', base: POINTS.win };
      outcome[loser] = { result: 'loss', base: POINTS.loss };
    } else return { error: 'Say who won (winner), or draw:true, or which team forfeited.' };
  }
  const rows = teams.map((team) => {
    const o = outcome[team];
    const forfeited = forfeit.includes(team);
    const showedUp = !forfeited && !late.includes(team);
    const voided = penalty.includes(team);
    const best = bestSport.includes(team);
    const points = voided ? 0 : o.base + (showedUp ? POINTS.showedUp : 0) + (best ? POINTS.bestSport : 0);
    const label = o.result ?? (o.place ? ['1st', '2nd', '3rd', '4th'][o.place - 1] : 'forfeit');
    return { team, points, outcome: voided ? `${label}, penalty` : label, showedUp, bestSport: best, penalty: voided };
  });
  return { rows };
}

/** Season table from the stored result rows: [{ team, played, points, wins, bestSport, tied }], best first. */
export function standings(cfg, resultRows) {
  const t = new Map(cfg.league.teams.map((x) => [x.key, { team: x.key, played: 0, points: 0, wins: 0, bestSport: 0, tied: false }]));
  for (const r of resultRows) {
    const row = t.get(r.team);
    if (!row) continue;
    row.played += 1;
    row.points += r.points;
    row.bestSport += r.best_sport ? 1 : 0;
    if (/^(win|1st)/.test(r.outcome)) row.wins += 1;
  }
  const list = [...t.values()].sort((a, b) => b.points - a.points || b.bestSport - a.bestSport || a.team.localeCompare(b.team));
  list.forEach((row, n) => {
    const prev = list[n - 1];
    if (prev && prev.points === row.points && prev.bestSport === row.bestSport) row.tied = prev.tied = true;
  });
  return list;
}

export function formatStandings(cfg, list, { season, seasonName } = {}) {
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [pad('Team', 22) + pad('Played', 8) + pad('Points', 8) + 'Best Sport'];
  for (const r of list) lines.push(pad(cfg.league.teams.find((t) => t.key === r.team)?.name ?? r.team, 22) + pad(r.played, 8) + pad(r.points, 8) + r.bestSport + (r.tied ? '  =' : ''));
  const tie = list.some((r) => r.tied) ? '\n= level on points and Best Sport: settled by rock-paper-scissors in The Arena.' : '';
  return `# 📊 Season ${season}${seasonName ? `: ${seasonName}` : ''} standings\n\`\`\`\n${lines.join('\n')}\n\`\`\`${tie}\nUpdated by the League Commissioners after every league night.`;
}

export const describeMatch = (cfg, m) =>
  `#${m.id} ${gameLabel(cfg, m.game)} ${m.kind === 'ffa' ? 'free-for-all' : 'head-to-head'}: ${m.teams.map((k) => teamName(cfg, k)).join(m.kind === 'ffa' ? ', ' : ' vs ')}, <t:${unix(m.starts_at)}:F> (<t:${unix(m.starts_at)}:R>)${m.week != null ? `, week ${m.week}` : ''}`;

/**
 * lg: Discord side. Methods used: post(channelId, text, roleIds), upsertScoreboard(channelId, text), createRoom({ name, teamRoleIds }),
 * deleteChannel(id), createEvent({ name, description, startsAt }) → id, deleteEvent(id). All may throw; the league carries on.
 */
export function createLeague({ cfg, store, lg, now = () => Date.now(), log = () => {} }) {
  const L = cfg.league;
  const crew = new Set([L.commissionerRoleId, ...(cfg.staffRoleIds ?? [])].filter(Boolean));
  const isCrew = (roleIds) => [...crew].some((id) => roleIds.has(id));
  const NO = 'Only the League Commissioners and the Forge staff can do this.';
  const teamRoles = (keys) => keys.map((k) => teamOf(cfg, k)?.roleId).filter(Boolean);
  const safe = async (what, fn) => {
    try {
      return await fn();
    } catch (err) {
      log(`${what} failed: ${err.message}`);
      return null;
    }
  };

  async function refreshScoreboard() {
    const season = store.leagueState('season', 1);
    const text = formatStandings(cfg, standings(cfg, store.leagueResults(Number(season))), { season, seasonName: store.leagueState('seasonName', '') });
    if (L.channels.scoreboard) await safe('scoreboard', () => lg.upsertScoreboard(L.channels.scoreboard, text));
    return text;
  }

  return {
    isCrew,
    refreshScoreboard,

    /** /league schedule */
    async schedule({ roleIds, userId, game, kind, when, teams, week = null, note = '' }) {
      if (!isCrew(roleIds)) return NO;
      const at = parseWhen(when);
      if (at == null) return 'Write the time as YYYY-MM-DD HH:mm in India time, for example 2026-11-07 20:00.';
      if (at < now() - 5 * MIN) return 'That time has passed.';
      const k = kind === 'ffa' ? 'ffa' : 'h2h';
      const keys = k === 'ffa' && !teams.length ? L.teams.map((t) => t.key) : teams;
      if (k === 'h2h' && keys.length !== 2) return 'A head-to-head match needs exactly two teams (team1 and team2).';
      if (keys.length < 2) return 'A match needs at least two teams.';
      const id = store.leagueMatchAdd({ season: Number(store.leagueState('season', 1)), week, game, kind: k, startsAt: at, teams: keys, createdBy: userId });
      const m = store.leagueMatch(id);
      const line = describeMatch(cfg, m);
      const posted = await safe('fixture post', () => lg.post(L.channels.fixtures, `🎮 **New fixture** ${line}${note ? `\n${String(note).slice(0, 300)}` : ''}\nClick **Interested** on the Discord event to be reminded.`, teamRoles(keys)));
      const eventId = await safe('event', () =>
        lg.createEvent({ name: `${gameLabel(cfg, game)}: ${keys.map((x) => teamOf(cfg, x)?.name ?? x).join(k === 'ffa' ? ' / ' : ' vs ')}`.slice(0, 100), description: note || 'Magenta Forge League match. Rules in #league-rulebook.', startsAt: at }),
      );
      store.leagueMatchSet(id, { announce_id: posted ?? null, event_id: eventId ?? null });
      return `Fixture created: ${line}.${eventId ? ' The Discord event is set.' : ' The Discord event could not be created (the bot needs Manage Events); the fixture was still posted.'}`;
    },

    /** /league cancel */
    async cancel({ roleIds, matchId }) {
      if (!isCrew(roleIds)) return NO;
      const m = store.leagueMatch(matchId);
      if (!m) return `No match #${matchId}.`;
      if (m.status === 'done') return `Match #${matchId} already has a result. Enter the result again to correct it.`;
      if (m.status === 'cancelled') return `Match #${matchId} is already cancelled.`;
      store.leagueMatchSet(matchId, { status: 'cancelled' });
      if (m.room_id) await safe('room', () => lg.deleteChannel(m.room_id));
      if (m.event_id) await safe('event', () => lg.deleteEvent(m.event_id));
      await safe('post', () => lg.post(L.channels.fixtures, `❌ Cancelled: ${describeMatch(cfg, m)}`, teamRoles(m.teams)));
      return `Match #${matchId} cancelled.`;
    },

    /** /league result: enter or correct a result. Standings and the scoreboard message update by themselves. */
    async result({ roleIds, matchId, ...input }) {
      if (!isCrew(roleIds)) return NO;
      const m = store.leagueMatch(matchId);
      if (!m) return `No match #${matchId}.`;
      if (m.status === 'cancelled') return `Match #${matchId} was cancelled.`;
      const scored = scoreMatch(m, input);
      if (scored.error) return scored.error;
      store.leagueResultSet(matchId, scored.rows);
      store.leagueMatchSet(matchId, { status: 'done' });
      if (m.room_id) await safe('room', () => lg.deleteChannel(m.room_id));
      store.leagueMatchSet(matchId, { room_id: null });
      await refreshScoreboard();
      const lines = scored.rows.map((r) => `${teamName(cfg, r.team)}: **${r.points}** (${r.outcome}${r.showedUp ? ', on time +1' : ''}${r.bestSport ? ', Best Sport +1' : ''})`);
      await safe('result post', () => lg.post(L.channels.matchReports ?? L.channels.fixtures, `✅ **Result** ${gameLabel(cfg, m.game)} (match #${matchId})\n${lines.join('\n')}`, []));
      return `Result saved for match #${matchId}. The scoreboard is updated.\n${lines.join('\n')}`;
    },

    /** /league standings */
    async standings() {
      return refreshScoreboard();
    },

    /** /league fixtures */
    fixtures() {
      const list = store.leagueUpcoming(now() - 3 * 60 * MIN, 10);
      return list.length ? `**Upcoming fixtures**\n${list.map((m) => describeMatch(cfg, m)).join('\n')}` : 'No fixtures yet. Commissioners add them with /league schedule.';
    },

    /** /league season start */
    async seasonStart({ roleIds, name }) {
      if (!isCrew(roleIds)) return NO;
      const current = Number(store.leagueState('season', 1));
      // A season with no matches yet is only renamed; otherwise a new season starts from zero.
      const next = store.leagueSeasonHasMatches(current) ? current + 1 : current;
      store.leagueStateSet('season', next);
      store.leagueStateSet('seasonName', String(name ?? '').slice(0, 60));
      store.leagueStateSet('scoreboardMessage', '');
      await refreshScoreboard();
      await safe('season post', () => lg.post(L.channels.office, `🏆 **Season ${next}${name ? `: ${name}` : ''} is open.** Standings start from zero.`, []));
      return `Season ${next} started.`;
    },

    /** Called every minute: reminders, match rooms 15 minutes before the start, and rooms nobody closed. */
    async tick() {
      const t = now();
      for (const m of store.leagueActive()) {
        for (const r of REMINDERS) {
          if (m.reminded & r.bit || t < m.starts_at - r.before || t > m.starts_at + 30 * MIN) continue;
          store.leagueMatchSet(m.id, { reminded: m.reminded | r.bit });
          m.reminded |= r.bit;
          if (r.kind === 'room') {
            const roomId = await safe('match room', () => lg.createRoom({ name: `Match ${m.id}: ${m.teams.map((k) => teamOf(cfg, k)?.name ?? k).join(' vs ').slice(0, 70)}`, teamRoleIds: teamRoles(m.teams), crewRoleIds: [...crew] }));
            if (roomId) store.leagueMatchSet(m.id, { room_id: roomId });
            await safe('room post', () => lg.post(L.channels.office, `🎮 **${gameLabel(cfg, m.game)} starts in 15 minutes.** Captains, confirm squads.${roomId ? ` The match room <#${roomId}> is open for the teams.` : ''}\n${describeMatch(cfg, m)}`, teamRoles(m.teams)));
          } else {
            await safe('reminder', () => lg.post(L.channels.office, `⏰ ${r.kind === 'day' ? 'Tomorrow' : 'In one hour'}: ${describeMatch(cfg, m)}`, teamRoles(m.teams)));
          }
        }
        if (m.room_id && t > m.starts_at + ROOM_KEEP_MS) {
          await safe('room cleanup', () => lg.deleteChannel(m.room_id));
          store.leagueMatchSet(m.id, { room_id: null });
        }
      }
    },
  };
}
