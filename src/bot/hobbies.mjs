// The #pick-your-roles picker: stream pings and interests. An entry with "requires" is only given along with that entry
// (the Esports League needs Co-op gaming). No Discord library here.

/**
 * have: Set of the member's role IDs. picked: the slugs chosen in the menu, which replace their current choice.
 * Returns { add: [roleId], remove: [roleId], notes: [string] }.
 */
export function applyPick(cfg, have, picked) {
  const hobbies = cfg.hobbies ?? [];
  const chosen = new Set(picked);
  const notes = [];
  for (const h of hobbies) {
    if (h.requires && chosen.has(h.slug) && !chosen.has(h.requires)) {
      chosen.delete(h.slug);
      const need = hobbies.find((x) => x.slug === h.requires);
      notes.push(`${h.label} needs ${need?.label ?? h.requires} too, so it was left out. Pick both to join.`);
    }
  }
  const add = [];
  const remove = [];
  for (const h of hobbies) {
    if (!h.roleId) continue;
    if (chosen.has(h.slug) && !have.has(h.roleId)) add.push(h.roleId);
    if (!chosen.has(h.slug) && have.has(h.roleId)) remove.push(h.roleId);
  }
  return { add, remove, notes };
}

/** The menu options, marking what the member already has. */
export const pickerOptions = (cfg) => (cfg.hobbies ?? []).filter((h) => h.roleId).map((h) => ({ label: h.label, value: h.slug, emoji: h.emoji }));

export function describePick(cfg, have) {
  const list = (cfg.hobbies ?? []).filter((h) => have.has(h.roleId)).map((h) => `${h.emoji ?? ''} ${h.label}`.trim());
  return list.length ? `You now have: ${list.join(', ')}.` : 'You have no stream pings or interests picked.';
}
