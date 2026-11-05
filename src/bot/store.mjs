// The bot's SQLite database. The bot owns every table, including the Buy Me a Coffee memberships fed by its webhook.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';


export function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS memberships (
    subscription_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    supporter_name TEXT,
    level_id TEXT,
    level_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT,
    paid_until TEXT,
    cancel_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS memberships_email ON memberships (email)');
  db.exec(`CREATE TABLE IF NOT EXISTS discord_members (
    discord_id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    linked_at TEXT,
    discreet INTEGER NOT NULL DEFAULT 0,
    thanks INTEGER NOT NULL DEFAULT 0,
    applied_tier TEXT,
    applied_state TEXT,
    carry_tier TEXT,
    carry_until TEXT,
    tourist_since TEXT,
    elder_since TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS discord_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    granted_by TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS discord_notices (
    discord_id TEXT NOT NULL,
    notice_key TEXT NOT NULL,
    message TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (discord_id, notice_key)
  )`);
  // A /link in progress. The code is stored only as a hash and expires in minutes.
  db.exec(`CREATE TABLE IF NOT EXISTS discord_link_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    email TEXT NOT NULL,
    code_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  // Which gate copy belongs to which member-side message, so edits and deletes follow. No message text is stored.
  db.exec(`CREATE TABLE IF NOT EXISTS mirror_messages (
    source_channel TEXT NOT NULL,
    source_message TEXT NOT NULL,
    target_channel TEXT NOT NULL,
    target_message TEXT NOT NULL,
    PRIMARY KEY (source_channel, source_message)
  )`);
  const nowIso = () => new Date().toISOString();
  // Support tickets. No message text is stored here: the transcript
  // in #ticket-transcripts is the only copy. AUTOINCREMENT means a number is never reused.
  db.exec(`CREATE TABLE IF NOT EXISTS tickets (
    number INTEGER PRIMARY KEY AUTOINCREMENT,
    opener_id TEXT NOT NULL,
    channel_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by TEXT,
    archived_at TEXT,
    archived_by TEXT
  )`);

  // Private voice rooms made for Elders (deleted when empty). Only the owner and a channel id.
  db.exec(`CREATE TABLE IF NOT EXISTS elder_rooms (
    channel_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

    // Activity counts for the Elder rule: per member per day, how many messages and voice minutes. Never any
  // message text or channel. Rows older than the Elder window are deleted (activityExpire).
  db.exec(`CREATE TABLE IF NOT EXISTS discord_activity (
    discord_id TEXT NOT NULL,
    day TEXT NOT NULL,
    msgs INTEGER NOT NULL DEFAULT 0,
    voice_min INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (discord_id, day)
  )`);
  // Moderation actions (a timeout) that stand in the way of the Elder role for the length of the window.
  db.exec(`CREATE TABLE IF NOT EXISTS discord_strikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS discord_strikes_member ON discord_strikes (discord_id)');

  // To-do lists: a member's own list (channel_id NULL) or a voice channel's shared list. Only the task
  // text, who wrote it and when. Ticking an item off deletes it; old items expire (todos.mjs).
  db.exec(`CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    channel_id TEXT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS todos_channel ON todos (channel_id)');

  // Intro checks for the free Tourist role (intro.mjs): one row while an intro waits for a mod. The intro text
  // is never stored here; it exists only in the private staff channel, which is deleted when a mod decides.
  db.exec(`CREATE TABLE IF NOT EXISTS intro_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    channel_id TEXT,
    created_at TEXT NOT NULL
  )`);

  // Approved intros are kept as a text file in #ticket-transcripts; this table holds only where that message is, so
  // /forget-me can delete it. No intro text is stored here.
  db.exec(`CREATE TABLE IF NOT EXISTS intro_records (
    discord_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    approved_at TEXT NOT NULL
  )`);

  // Magenta Forge League (league.mjs): fixtures, per-team results and a few settings. Team keys and times only;
  // created_by is the one member ID, cleared by /forget-me.
  db.exec(`CREATE TABLE IF NOT EXISTS league_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL DEFAULT 1,
    week INTEGER,
    game TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'h2h',
    starts_at INTEGER NOT NULL,
    teams TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    reminded INTEGER NOT NULL DEFAULT 0,
    room_id TEXT,
    event_id TEXT,
    announce_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS league_results (
    match_id INTEGER NOT NULL,
    team TEXT NOT NULL,
    points INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    showed_up INTEGER NOT NULL DEFAULT 1,
    best_sport INTEGER NOT NULL DEFAULT 0,
    penalty INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (match_id, team)
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS league_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const matchRow = (r) => (r ? { ...r, teams: String(r.teams).split(',') } : null);

  // Members the bot server-muted for a Pomodoro focus block, so it can unmute them even after a restart
  // or when they left voice while muted. A row exists only while the mute is the bot's doing.
  db.exec(`CREATE TABLE IF NOT EXISTS pomodoro_mutes (
    user_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    muted_at TEXT NOT NULL
  )`);

  return {
    db,
    upsertMembership: ({ subscriptionId, email, supporterName, levelId, levelName, status, startedAt, paidUntil, cancelAt, endedAt }) =>
      db.prepare(
        `INSERT INTO memberships (subscription_id, email, supporter_name, level_id, level_name, status, started_at, paid_until, cancel_at, ended_at, updated_at)
         VALUES (@subscriptionId, @email, @supporterName, @levelId, @levelName, @status, @startedAt, @paidUntil, @cancelAt, @endedAt, @now)
         ON CONFLICT(subscription_id) DO UPDATE SET
           email = excluded.email, supporter_name = COALESCE(excluded.supporter_name, supporter_name),
           level_id = COALESCE(excluded.level_id, level_id), level_name = COALESCE(excluded.level_name, level_name),
           status = CASE WHEN memberships.status = 'revoked' THEN 'revoked' ELSE excluded.status END,
           started_at = COALESCE(excluded.started_at, started_at), paid_until = COALESCE(excluded.paid_until, paid_until),
           cancel_at = excluded.cancel_at, ended_at = excluded.ended_at, updated_at = excluded.updated_at`,
      ).run({ subscriptionId, email, supporterName: supporterName ?? null, levelId: levelId ?? null, levelName: levelName ?? null, status, startedAt: startedAt ?? null, paidUntil: paidUntil ?? null, cancelAt: cancelAt ?? null, endedAt: endedAt ?? null, now: nowIso() }),
    linkStart: (discordId, email, codeHash, expiresAt) => {
      db.prepare('DELETE FROM discord_link_codes WHERE discord_id = ?').run(discordId);
      return Number(db.prepare('INSERT INTO discord_link_codes (discord_id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(discordId, email, codeHash ?? null, expiresAt, nowIso()).lastInsertRowid);
    },
    linkPending: (discordId) => db.prepare('SELECT * FROM discord_link_codes WHERE discord_id = ? ORDER BY id DESC').get(discordId) ?? null,
    linkById: (id) => db.prepare('SELECT * FROM discord_link_codes WHERE id = ?').get(id) ?? null,
    linkAttempt: (id) => db.prepare('UPDATE discord_link_codes SET attempts = attempts + 1 WHERE id = ?').run(id),
    linkDelete: (id) => db.prepare('DELETE FROM discord_link_codes WHERE id = ?').run(id),
    linkExpire: (at = Date.now()) => db.prepare('DELETE FROM discord_link_codes WHERE expires_at < ?').run(new Date(at).toISOString()).changes,
    /** Ties an email to a Discord account. A false result means another account holds that email. */
    linkEmail: (id, email) => {
      const other = db.prepare('SELECT discord_id FROM discord_members WHERE email = ? AND discord_id != ?').get(email, id);
      if (other) return false;
      db.prepare('INSERT INTO discord_members (discord_id, updated_at) VALUES (?, ?) ON CONFLICT(discord_id) DO NOTHING').run(id, nowIso());
      db.prepare('UPDATE discord_members SET email = ?, linked_at = COALESCE(linked_at, ?), carry_tier = NULL, carry_until = NULL, updated_at = ? WHERE discord_id = ?').run(email, nowIso(), nowIso(), id);
      return true;
    },
    mirrorAdd: (sourceChannel, sourceMessage, targetChannel, targetMessage) => db.prepare('INSERT OR REPLACE INTO mirror_messages (source_channel, source_message, target_channel, target_message) VALUES (?, ?, ?, ?)').run(sourceChannel, sourceMessage, targetChannel, targetMessage),
    mirrorGet: (sourceChannel, sourceMessage) => db.prepare('SELECT * FROM mirror_messages WHERE source_channel = ? AND source_message = ?').get(sourceChannel, sourceMessage) ?? null,
    mirrorDelete: (sourceChannel, sourceMessage) => db.prepare('DELETE FROM mirror_messages WHERE source_channel = ? AND source_message = ?').run(sourceChannel, sourceMessage),
    mirrorAll: (sourceChannel) => db.prepare('SELECT * FROM mirror_messages WHERE source_channel = ?').all(sourceChannel),
    close: () => db.close(),
    elderRoomCreate: (channelId, ownerId) => db.prepare('INSERT OR REPLACE INTO elder_rooms (channel_id, owner_id, created_at) VALUES (?, ?, ?)').run(channelId, ownerId, nowIso()),
    elderRoomDelete: (channelId) => db.prepare('DELETE FROM elder_rooms WHERE channel_id = ?').run(channelId),
    elderRoomByChannel: (channelId) => db.prepare('SELECT * FROM elder_rooms WHERE channel_id = ?').get(channelId) ?? null,
    elderRoomsByOwner: (ownerId) => db.prepare('SELECT * FROM elder_rooms WHERE owner_id = ?').all(ownerId),
    elderRoomsAll: () => db.prepare('SELECT * FROM elder_rooms').all(),
    todoAdd: (ownerId, channelId, text) =>
      Number(db.prepare('INSERT INTO todos (owner_id, channel_id, text, created_at) VALUES (?, ?, ?, ?)').run(ownerId, channelId ?? null, text, nowIso()).lastInsertRowid),
    /** A member's own list (channelId null) or a voice channel's list, oldest first. */
    todoList: (ownerId, channelId) =>
      channelId
        ? db.prepare('SELECT * FROM todos WHERE channel_id = ? ORDER BY id').all(channelId)
        : db.prepare('SELECT * FROM todos WHERE owner_id = ? AND channel_id IS NULL ORDER BY id').all(ownerId),
    todoDelete: (id) => db.prepare('DELETE FROM todos WHERE id = ?').run(id).changes === 1,
    todoClear: (ownerId, channelId) =>
      channelId
        ? db.prepare('DELETE FROM todos WHERE channel_id = ?').run(channelId).changes
        : db.prepare('DELETE FROM todos WHERE owner_id = ? AND channel_id IS NULL').run(ownerId).changes,
    /** Deletes personal items older than personalDays and voice channel items older than roomDays. */
    todoExpire: (personalDays, roomDays, at = Date.now()) =>
      db.prepare('DELETE FROM todos WHERE (channel_id IS NULL AND created_at < ?) OR (channel_id IS NOT NULL AND created_at < ?)')
        .run(new Date(at - personalDays * 86_400_000).toISOString(), new Date(at - roomDays * 86_400_000).toISOString()).changes,
    leagueMatchAdd: ({ season, week, game, kind, startsAt, teams, createdBy }) =>
      Number(db.prepare('INSERT INTO league_matches (season, week, game, kind, starts_at, teams, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(season, week, game, kind, startsAt, teams.join(','), createdBy ?? null, nowIso()).lastInsertRowid),
    leagueMatch: (id) => matchRow(db.prepare('SELECT * FROM league_matches WHERE id = ?').get(id)),
    leagueMatchSet: (id, fields) => {
      const keys = Object.keys(fields);
      if (keys.length) db.prepare(`UPDATE league_matches SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    },
    /** Matches that are neither finished nor cancelled (reminders and rooms are handled for these). */
    leagueActive: () => db.prepare("SELECT * FROM league_matches WHERE status = 'scheduled' ORDER BY starts_at").all().map(matchRow),
    leagueUpcoming: (since, limit = 10) => db.prepare("SELECT * FROM league_matches WHERE status = 'scheduled' AND starts_at >= ? ORDER BY starts_at LIMIT ?").all(since, limit).map(matchRow),
    leagueSeasonHasMatches: (season) => db.prepare("SELECT 1 FROM league_matches WHERE season = ? AND status != 'cancelled' LIMIT 1").get(season) != null,
    leagueResultSet: (matchId, rows) =>
      db.transaction(() => {
        db.prepare('DELETE FROM league_results WHERE match_id = ?').run(matchId);
        for (const r of rows) {
          db.prepare('INSERT INTO league_results (match_id, team, points, outcome, showed_up, best_sport, penalty) VALUES (?, ?, ?, ?, ?, ?, ?)').run(matchId, r.team, r.points, r.outcome, r.showedUp ? 1 : 0, r.bestSport ? 1 : 0, r.penalty ? 1 : 0);
        }
      })(),
    leagueResults: (season) =>
      db.prepare("SELECT r.* FROM league_results r JOIN league_matches m ON m.id = r.match_id WHERE m.season = ? AND m.status = 'done'").all(season),
    /** Renames a team key in stored matches and results (after a team is renamed in the layout). Returns how many rows changed. */
    leagueRenameTeam: (from, to) =>
      db.transaction(() => {
        let n = db.prepare('UPDATE league_results SET team = ? WHERE team = ?').run(to, from).changes;
        for (const m of db.prepare('SELECT id, teams FROM league_matches').all()) {
          const parts = String(m.teams).split(',');
          if (!parts.includes(from)) continue;
          db.prepare('UPDATE league_matches SET teams = ? WHERE id = ?').run(parts.map((k) => (k === from ? to : k)).join(','), m.id);
          n += 1;
        }
        return n;
      })(),
    leagueState: (key, fallback = null) => db.prepare('SELECT value FROM league_state WHERE key = ?').get(key)?.value ?? fallback,
    leagueStateSet: (key, value) => db.prepare('INSERT INTO league_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)),
    pomodoroMuteAdd: (userId, channelId) =>
      db.prepare('INSERT OR REPLACE INTO pomodoro_mutes (user_id, channel_id, muted_at) VALUES (?, ?, ?)').run(userId, channelId, nowIso()),
    pomodoroMuteDelete: (userId) => db.prepare('DELETE FROM pomodoro_mutes WHERE user_id = ?').run(userId),
    pomodoroMuted: (userId) => db.prepare('SELECT * FROM pomodoro_mutes WHERE user_id = ?').get(userId) ?? null,
    pomodoroMutesAll: () => db.prepare('SELECT * FROM pomodoro_mutes').all(),
    /** Adds counts to a member's day (UTC date yyyy-mm-dd). */
    activityAdd: (id, day, msgs, voiceMin) =>
      db.prepare(
        `INSERT INTO discord_activity (discord_id, day, msgs, voice_min) VALUES (?, ?, ?, ?)
         ON CONFLICT(discord_id, day) DO UPDATE SET msgs = msgs + excluded.msgs, voice_min = voice_min + excluded.voice_min`,
      ).run(id, day, msgs, voiceMin),
    /** Days in the window with at least minMsgs messages or minVoice voice minutes, and whether a strike falls in it. */
    activitySummary: (id, windowDays, at = Date.now(), minMsgs = 1, minVoice = 5) => {
      const since = new Date(at - windowDays * 86_400_000).toISOString();
      const activeDays = db
        .prepare('SELECT COUNT(*) n FROM discord_activity WHERE discord_id = ? AND day >= ? AND (msgs >= ? OR voice_min >= ?)')
        .get(id, since.slice(0, 10), minMsgs, minVoice).n;
      const moderated = db.prepare('SELECT 1 FROM discord_strikes WHERE discord_id = ? AND created_at >= ? LIMIT 1').get(id, since) != null;
      return { activeDays, moderated };
    },
    activityExpire: (keepDays, at = Date.now()) => {
      const cut = new Date(at - keepDays * 86_400_000).toISOString();
      db.prepare('DELETE FROM discord_activity WHERE day < ?').run(cut.slice(0, 10));
      db.prepare('DELETE FROM discord_strikes WHERE created_at < ?').run(cut);
    },
    strikeAdd: (id, kind) => db.prepare('INSERT INTO discord_strikes (discord_id, kind, created_at) VALUES (?, ?, ?)').run(id, kind, nowIso()),
    /** Tourist: a mod approved the member's intro. No email is needed; the row is made if the member has none yet. */
    touristSet: (id) => {
      db.prepare('INSERT INTO discord_members (discord_id, updated_at) VALUES (?, ?) ON CONFLICT(discord_id) DO NOTHING').run(id, nowIso());
      db.prepare('UPDATE discord_members SET tourist_since = COALESCE(tourist_since, ?), updated_at = ? WHERE discord_id = ?').run(nowIso(), nowIso(), id);
      return true;
    },
    introCreate: (discordId, at) => Number(db.prepare('INSERT INTO intro_requests (discord_id, created_at) VALUES (?, ?)').run(discordId, at).lastInsertRowid),
    introSetChannel: (id, channelId) => db.prepare('UPDATE intro_requests SET channel_id = ? WHERE id = ?').run(channelId, id),
    introGet: (id) => db.prepare('SELECT * FROM intro_requests WHERE id = ?').get(id) ?? null,
    introByUser: (discordId) => db.prepare('SELECT * FROM intro_requests WHERE discord_id = ? ORDER BY id DESC').get(discordId) ?? null,
    introDelete: (id) => db.prepare('DELETE FROM intro_requests WHERE id = ?').run(id).changes === 1,
    introsOlderThan: (cutoffIso) => db.prepare('SELECT * FROM intro_requests WHERE created_at < ?').all(cutoffIso),
    introRecordAdd: (discordId, channelId, messageId, at) => db.prepare('INSERT INTO intro_records (discord_id, channel_id, message_id, approved_at) VALUES (?, ?, ?, ?)').run(discordId, channelId, messageId, at),
    introRecords: (discordId) => db.prepare('SELECT * FROM intro_records WHERE discord_id = ?').all(discordId),
    introRecordsDelete: (discordId) => db.prepare('DELETE FROM intro_records WHERE discord_id = ?').run(discordId),
    introPending: () => db.prepare('SELECT * FROM intro_requests ORDER BY id').all(),
    elderSet: (id) => db.prepare('UPDATE discord_members SET elder_since = COALESCE(elder_since, ?), updated_at = ? WHERE discord_id = ?').run(nowIso(), nowIso(), id),
    member: (id) => db.prepare('SELECT * FROM discord_members WHERE discord_id = ?').get(id) ?? null,
    memberByEmail: (email) => db.prepare('SELECT * FROM discord_members WHERE email = ?').get(email) ?? null,
    membershipsFor: (email) => (email ? db.prepare('SELECT * FROM memberships WHERE email = ?').all(email) : []),
    grantsFor: (id) => db.prepare('SELECT * FROM discord_grants WHERE discord_id = ?').all(id),
    /** Everyone the bot looks after: linked members, members with grants, and anyone it gave a role. */
    managedIds: () =>
      db
        .prepare('SELECT discord_id FROM discord_members UNION SELECT discord_id FROM discord_grants')
        .all()
        .map((r) => r.discord_id),
    ensureMember: (id) =>
      db.prepare('INSERT INTO discord_members (discord_id, updated_at) VALUES (?, ?) ON CONFLICT(discord_id) DO NOTHING').run(id, nowIso()),
    setApplied: (id, tier, state) =>
      db.prepare('UPDATE discord_members SET applied_tier = ?, applied_state = ?, updated_at = ? WHERE discord_id = ?').run(tier, state, nowIso(), id),
    setFlag: (id, flag, on) => {
      if (!['discreet', 'thanks'].includes(flag)) throw new Error('bad flag');
      db.prepare('INSERT INTO discord_members (discord_id, updated_at) VALUES (?, ?) ON CONFLICT(discord_id) DO NOTHING').run(id, nowIso());
      db.prepare(`UPDATE discord_members SET ${flag} = ?, updated_at = ? WHERE discord_id = ?`).run(on ? 1 : 0, nowIso(), id);
    },
    /** Unlink: forget the email, keep the current class for the grace period. */
    unlink: (id, graceDays) => {
      const m = db.prepare('SELECT applied_tier FROM discord_members WHERE discord_id = ? AND email IS NOT NULL').get(id);
      if (!m) return false;
      const until = m.applied_tier ? new Date(Date.now() + graceDays * 86_400_000).toISOString() : null;
      db.prepare('UPDATE discord_members SET email = NULL, linked_at = NULL, elder_since = NULL, carry_tier = ?, carry_until = ?, updated_at = ? WHERE discord_id = ?')
        .run(until ? m.applied_tier : null, until, nowIso(), id);
      return true;
    },
    /** Mod /unlink: drop the link and any grace carry-over, so the class goes at once. The Buy Me a Coffee record and any /membership grant stay. */
    adminUnlink: (id) => {
      const m = db.prepare('SELECT email FROM discord_members WHERE discord_id = ? AND email IS NOT NULL').get(id);
      if (!m) return false;
      db.prepare('UPDATE discord_members SET email = NULL, linked_at = NULL, elder_since = NULL, carry_tier = NULL, carry_until = NULL, updated_at = ? WHERE discord_id = ?').run(nowIso(), id);
      return true;
    },
    ticketCreate: (openerId, at) => Number(db.prepare("INSERT INTO tickets (opener_id, status, opened_at) VALUES (?, 'open', ?)").run(openerId, at).lastInsertRowid),
    ticketSetChannel: (number, channelId) => db.prepare('UPDATE tickets SET channel_id = ? WHERE number = ?').run(channelId, number),
    ticketDelete: (number) => db.prepare('DELETE FROM tickets WHERE number = ?').run(number),
    ticketByChannel: (channelId) => db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId) ?? null,
    openTicketFor: (openerId) => db.prepare("SELECT * FROM tickets WHERE opener_id = ? AND status = 'open' AND channel_id IS NOT NULL ORDER BY number DESC").get(openerId) ?? null,
    ticketClose: (number, by, at) => db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE number = ?").run(at, by, number),
    ticketReopen: (number) => db.prepare("UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL WHERE number = ?").run(number),
    ticketArchive: (number, by, at) => db.prepare("UPDATE tickets SET status = 'archived', archived_at = ?, archived_by = ? WHERE number = ?").run(at, by, number),
    ticketsOpenOrClosed: () => db.prepare("SELECT * FROM tickets WHERE status IN ('open', 'closed') AND channel_id IS NOT NULL ORDER BY number").all(),
    /** /forget-me: delete everything the bot and the link page hold about this Discord account. */
    forget: (id) =>
      db.transaction(() => {
        // An archived ticket keeps its number and dates but loses the link to the person.
        db.prepare("UPDATE tickets SET opener_id = 'deleted' WHERE opener_id = ? AND status = 'archived'").run(id);
        for (const table of ['discord_members', 'discord_grants', 'discord_notices', 'discord_link_codes', 'elder_rooms', 'discord_activity', 'discord_strikes', 'intro_requests', 'intro_records']) {
          db.prepare(`DELETE FROM ${table} WHERE ${table === 'elder_rooms' ? 'owner_id' : 'discord_id'} = ?`).run(id);
        }
        // Every to-do the member wrote, on their own list and on voice channel lists.
        db.prepare('DELETE FROM todos WHERE owner_id = ?').run(id);
        // League fixtures keep no name: only the team keys and the result.
        db.prepare('UPDATE league_matches SET created_by = NULL WHERE created_by = ?').run(id);
      })(),
    grant: (id, tier, days, by) => {
      db.prepare('INSERT INTO discord_members (discord_id, updated_at) VALUES (?, ?) ON CONFLICT(discord_id) DO NOTHING').run(id, nowIso());
      const expires = new Date(Date.now() + days * 86_400_000).toISOString();
      db.prepare('INSERT INTO discord_grants (discord_id, tier, expires_at, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, tier, expires, by, nowIso());
      return expires;
    },
    /** Founder revoke (refunds, chargebacks): no grace period. */
    revoke: (id) =>
      db.transaction(() => {
        const m = db.prepare('SELECT email FROM discord_members WHERE discord_id = ?').get(id);
        if (m?.email) db.prepare("UPDATE memberships SET status = 'revoked', updated_at = ? WHERE email = ?").run(nowIso(), m.email);
        db.prepare('DELETE FROM discord_grants WHERE discord_id = ?').run(id);
        db.prepare('UPDATE discord_members SET carry_tier = NULL, carry_until = NULL, updated_at = ? WHERE discord_id = ?').run(nowIso(), id);
      })(),
    /** Records a message once per key. Returns false if this key was already sent. */
    notice: (id, key, message, delivered) =>
      db
        .prepare('INSERT OR IGNORE INTO discord_notices (discord_id, notice_key, message, delivered, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, key, message, delivered ? 1 : 0, nowIso()).changes === 1,
    hasNotice: (id, key) => Boolean(db.prepare('SELECT 1 FROM discord_notices WHERE discord_id = ? AND notice_key = ?').get(id, key)),
    markDelivered: (id, key) => db.prepare('UPDATE discord_notices SET delivered = 1 WHERE discord_id = ? AND notice_key = ?').run(id, key),
    undelivered: (id) =>
      db.prepare('SELECT notice_key, message FROM discord_notices WHERE discord_id = ? AND delivered = 0 ORDER BY created_at').all(id),
    membershipById: (id) => db.prepare('SELECT * FROM memberships WHERE subscription_id = ?').get(id) ?? null,
    activeMemberships: () => db.prepare("SELECT * FROM memberships WHERE status = 'active'").all(),
    lapse: (subscriptionId) =>
      db.prepare("UPDATE memberships SET status = 'lapsed', ended_at = ?, updated_at = ? WHERE subscription_id = ? AND status = 'active'").run(nowIso(), nowIso(), subscriptionId),
    setPaidUntil: (subscriptionId, iso) =>
      db.prepare('UPDATE memberships SET paid_until = ?, updated_at = ? WHERE subscription_id = ?').run(iso, nowIso(), subscriptionId),
    levelsSeen: () => db.prepare('SELECT DISTINCT level_id, level_name FROM memberships').all(),
  };
}
