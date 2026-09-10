/* -------------------------------------------------------------------------
   10. Character factory & progression
   ------------------------------------------------------------------------- */
const Characters = {
  BASE_ATTR: 8,
  POOL: 14,

  blankAllocation() {
    const o = {};
    ATTRS.forEach(a => { o[a.key] = 0; });
    return o;
  },

  /** base 8 + point buy + race mods + class mods, floored at 3. */
  finalAttributes(allocation, raceKey, classKey) {
    const out = {};
    ATTRS.forEach(a => { out[a.key] = this.BASE_ATTR + (allocation[a.key] || 0); });
    const apply = (mods) => { for (const k in mods) out[k] = (out[k] || 0) + mods[k]; };
    if (RACES[raceKey])   apply(RACES[raceKey].mods);
    if (CLASSES[classKey]) apply(CLASSES[classKey].mods);
    ATTRS.forEach(a => { out[a.key] = Math.max(3, out[a.key]); });
    return out;
  },

  create(userId, name, classKey, raceKey, allocation) {
    const ch = {
      characterId: uid("chr"), userId, name,
      class: classKey, race: raceKey,
      level: 1, experience: 0, unspentPoints: 0, gold: 60,
      attributes: this.finalAttributes(allocation, raceKey, classKey),
      stats: { hp: 0, maxHp: 0, mana: 0, maxMana: 0, stamina: 0, maxStamina: 0 },
      equipment: [],
      inventory: [],
      position: { latitude: null, longitude: null, lastUpdated: null },
      createdAt: nowTs()
    };
    this.refreshMaxes(ch, true);
    return ch;
  },

  /** Recompute derived maxima; optionally top the character right up. */
  refreshMaxes(ch, full) {
    const s = ch.stats;
    const mh = Calc.maxHp(ch), mm = Calc.maxMana(ch), ms = Calc.maxStamina(ch);
    s.maxHp = mh; s.maxMana = mm; s.maxStamina = ms;
    if (full) { s.hp = mh; s.mana = mm; s.stamina = ms; }
    s.hp = clamp(s.hp, 0, mh);
    s.mana = clamp(s.mana, 0, mm);
    s.stamina = clamp(s.stamina, 0, ms);
    return ch;
  },

  skillsFor(ch) {
    return CLASSES[ch.class].skills.filter(sk => ch.level >= sk.lvl);
  },

  addXp(ch, amount) {
    ch.experience += amount;
    const gains = [];
    while (ch.experience >= Calc.xpForLevel(ch.level)) {
      ch.experience -= Calc.xpForLevel(ch.level);
      ch.level += 1;
      ch.unspentPoints += 5;
      this.refreshMaxes(ch, true);
      const unlocked = CLASSES[ch.class].skills.filter(sk => sk.lvl === ch.level);
      gains.push({ level: ch.level, unlocked });
    }
    return gains;
  },

  save(ch) {
    Store.patch(K.characters, (all) => { all[ch.characterId] = ch; });
    API.request("/character/" + ch.characterId, "PATCH", ch);
  }
};
