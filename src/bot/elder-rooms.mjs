// Private voice rooms. A Forge Elder, Grand Elder or member of staff (cfg.elder.creatorRoleIds, plus the Elder roles) who joins the lobby voice channel gets a room of their own in
// the Elder category, visible only to them and the people they invite, and is moved into it. The room is
// deleted when it has been empty for a short while. The rules are here; discord-elder.mjs talks to Discord.

const EMPTY_DELETE_MS = 15_000;

const clean = (s) => String(s ?? '').replace(/[^\p{L}\p{N} '’_-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * dc: { createRoom({ ownerId, name }) → channelId, moveMember(userId, channelId), deleteChannel(channelId),
 *       allow(channelId, userId), deny(channelId, userId), rename(channelId, name), setLimit(channelId, n),
 *       peopleIn(channelId) → number, exists(channelId) → boolean }
 */
/** Posted in the text chat of every private room: the text chat is not private, only voice and video are. */
export const ROOM_NOTICE =
  '🔒 **Notice:** the text chat of this room can be read by everyone who can see this channel, including anyone you invite later. Do not post anything private in text, and remember anyone you invite can hear and see you.';

export function createElderRooms({ cfg, store, dc, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const timers = new Map();
  /** Who may open a private room: the Elder and Grand Elder roles and every role in elder.creatorRoleIds. */
  const isElder = (roleIds) => [cfg.elder.roleId, cfg.elder.grandElderRoleId, ...(cfg.elder.creatorRoleIds || [])].some((id) => id && roleIds.has(id));
  const note = (channelId) => Promise.resolve(dc.postNote?.(channelId, ROOM_NOTICE)).catch((err) => log(`could not post the room notice: ${err.message}`));
  const maxRooms = cfg.elder.maxRoomsPerElder || 1;
  const roomName = (displayName) => {
    const who = clean(displayName) || 'Member';
    return cfg.elder.privateRoomPrefix ? `${cfg.elder.privateRoomPrefix}${who}` : `${who}'s room`;
  };

  /** Someone entered the lobby. Creates their room (or reuses it) and moves them in. */
  async function lobbyJoin({ userId, displayName, roleIds }) {
    if (!isElder(roleIds)) return { moved: false, reason: 'not allowed to create private rooms' };
    let rooms = store.elderRoomsByOwner(userId);
    // Rooms that were deleted in Discord are forgotten; below the limit a new room is made, at the limit the first one is reused.
    for (const r of rooms) if (!dc.exists(r.channel_id)) store.elderRoomDelete(r.channel_id);
    rooms = rooms.filter((r) => dc.exists(r.channel_id));
    let channelId = rooms.length >= maxRooms ? rooms[0].channel_id : null;
    if (!channelId) {
      channelId = await dc.createRoom({ ownerId: userId, name: roomName(displayName) });
      store.elderRoomCreate(channelId, userId);
      await note(channelId);
      log(`created a private room for <@${userId}>`);
    }
    await dc.moveMember(userId, channelId);
    return { moved: true, channelId };
  }

  /** Called on every voice change in a tracked room: deletes it once it has stayed empty. */
  function roomChanged(channelId) {
    if (!store.elderRoomByChannel(channelId)) return;
    clearTimer(timers.get(channelId));
    timers.delete(channelId);
    if (dc.peopleIn(channelId) > 0) return;
    timers.set(
      channelId,
      setTimer(async () => {
        timers.delete(channelId);
        if (dc.peopleIn(channelId) > 0) return;
        await dc.deleteChannel(channelId).catch((e) => log(`could not delete a room: ${e.message}`));
        store.elderRoomDelete(channelId);
      }, EMPTY_DELETE_MS),
    );
  }

  /** On start: forget rooms that no longer exist and delete rooms left empty. */
  async function cleanup() {
    for (const r of store.elderRoomsAll()) {
      if (!dc.exists(r.channel_id)) store.elderRoomDelete(r.channel_id);
      else if (dc.peopleIn(r.channel_id) === 0) {
        await dc.deleteChannel(r.channel_id).catch(() => {});
        store.elderRoomDelete(r.channel_id);
      } else if (dc.hasNote && !(await Promise.resolve(dc.hasNote(r.channel_id)).catch(() => true))) {
        // A room made before the notice existed gets it once.
        await note(r.channel_id);
      }
    }
  }

  /** A voice channel in the Elder category (made by the bot or by staff) gets the notice if it has none yet. */
  async function noteIfMissing(channelId) {
    if (channelId === cfg.elder.lobbyChannelId || !dc.exists(channelId)) return false;
    if (dc.hasNote && (await Promise.resolve(dc.hasNote(channelId)).catch(() => true))) return false;
    await note(channelId);
    return true;
  }

  /** At start-up: every voice channel in the Elder category (staff-made rooms included) gets the notice once. */
  async function scan() {
    for (const id of dc.categoryVoiceIds?.() ?? []) await noteIfMissing(id);
  }

  const myRoom = (userId) => store.elderRoomsByOwner(userId).find((r) => dc.exists(r.channel_id));

  /** /room invite|remove|rename|limit|close, for the owner of a room. */
  async function command({ sub, userId, roleIds, target, name, limit }) {
    if (!isElder(roleIds)) return 'Private rooms are for Forge Elders, Grand Elders and the staff.';
    const room = myRoom(userId);
    if (!room) return 'You have no private room yet. Join the Create a Room voice channel to get one.';
    const id = room.channel_id;
    if (sub === 'invite' || sub === 'remove') {
      if (!target) return 'Choose a member.';
      if (target === userId) return 'That is you.';
      if (sub === 'invite') await dc.allow(id, target);
      else await dc.deny(id, target);
      return sub === 'invite' ? `<@${target}> can now see and join your room.` : `<@${target}> can no longer see your room.`;
    }
    if (sub === 'rename') {
      const n = clean(name);
      if (!n) return 'Give the room a name (letters and numbers).';
      await dc.rename(id, n);
      return `Your room is now called ${n}.`;
    }
    if (sub === 'limit') {
      const n = Math.max(0, Math.min(99, Number(limit) || 0));
      await dc.setLimit(id, n);
      return n ? `Your room now holds up to ${n} people.` : 'Your room has no people limit now.';
    }
    if (sub === 'close') {
      await dc.deleteChannel(id);
      store.elderRoomDelete(id);
      return 'Your room is closed.';
    }
    return 'Unknown command.';
  }

  return { lobbyJoin, roomChanged, cleanup, command, maxRooms, noteIfMissing, scan };
}
