/* -------------------------------------------------------------------------
   8. Enemy generation
   ------------------------------------------------------------------------- */
const Bestiary = {
  spawn(template, difficulty, playerLevel) {
    // Enemies scale mostly with the node's difficulty and only lightly with
    // the player's level — enough to keep low-difficulty nodes from becoming
    // pure filler, not enough to cancel out levelling.
    const lvl = clamp(Math.round(difficulty * 0.85 + playerLevel * 0.28), 1, 40);
    const scale = 1 + (lvl - 1) * 0.15;
    const t = template;
    const attributes = {
      strength: Math.round(t.str * scale), dexterity: Math.round(t.dex * scale),
      constitution: Math.round(t.con * scale), intelligence: Math.round(t.int * scale),
      wisdom: Math.round(t.wis * scale), charisma: 8, luck: 8 + Math.round(difficulty * 0.6)
    };
    const hp = Math.round(t.hp * scale);
    return {
      enemyId: uid("enm"), name: t.name, icon: t.icon, level: lvl, boss: !!t.boss,
      hp, maxHp: hp, attributes, alive: true, tempEvasion: 0, slowed: 0,
      attackPower: attributes.strength * 1.25 + attributes.dexterity * 0.5 + difficulty * 1.4,
      spellPower:  attributes.intelligence * 1.3 + attributes.wisdom * 0.4,
      armor:       Math.round(attributes.constitution * 0.6 + difficulty * 1.1),
      magicDefense:Math.round(attributes.wisdom * 1.1),
      accuracy:    72 + attributes.dexterity * 1.2,
      evasion:     attributes.dexterity * 1.1,
      critChance:  clamp(3 + attributes.luck * 0.6, 0, 45),
      critResist:  attributes.wisdom * 0.5,
      caster:      attributes.intelligence > attributes.strength,
      rewards: {
        experience: Math.round(t.xp * (1 + (lvl - 1) * 0.13)),
        gold: Math.round(t.gold * (1 + (lvl - 1) * 0.15)),
        items: []
      }
    };
  },

  /** Authored monsters win when any of them fit this node; the built-in
      bestiary below is the fallback for an empty content database. */
  packFor(node, playerLevel) {
    // A hand-placed location with a spawn table decides its own encounter.
    if (node.spawnTableId) {
      const pack = Content.rollSpawn(node.spawnTableId,
        node.type === "boss" ? node.difficulty + 3 : node.difficulty, playerLevel);
      if (pack.length) return pack;
    }
    const authored = Content.monstersFor(node, playerLevel);
    if (authored.length) return this.packFromAuthored(authored, node, playerLevel);
    return this.packFromBuiltins(node, playerLevel);
  },

  packFromAuthored(pool, node, playerLevel) {
    const d = node.difficulty;
    // A boss site punches above its difficulty number, as it always has.
    const pack = [Content.toEnemy(pick(pool), node.type === "boss" ? d + 3 : d, playerLevel)];
    const extra = clamp(Math.floor(d / 4), 0, 2);
    if (node.type === "boss") {
      const adds = Content.monstersFor({ type: "combat", difficulty: Math.max(1, d - 2) }, playerLevel);
      for (let i = 0; i < extra && adds.length; i++) pack.push(Content.toEnemy(pick(adds), Math.max(1, d - 2), playerLevel));
    } else {
      for (let i = 0; i < extra; i++) pack.push(Content.toEnemy(pick(pool), d, playerLevel));
    }
    return pack;
  },

  packFromBuiltins(node, playerLevel) {
    const d = node.difficulty;
    if (node.type === "boss") {
      const pool = BOSSES.filter(b => b.tier <= Math.ceil(d / 3) + 1);
      const boss = pick(pool.length ? pool : [BOSSES[0]]);
      const pack = [this.spawn(boss, d + 2, playerLevel)];
      const adds = clamp(Math.floor(d / 4), 0, 2);
      const minions = BESTIARY.filter(b => b.tier <= Math.ceil(d / 3));
      for (let i = 0; i < adds; i++) pack.push(this.spawn(pick(minions.length ? minions : BESTIARY), d - 2, playerLevel));
      return pack;
    }
    const tierCap = clamp(Math.ceil(d / 3), 1, 4);
    const pool = BESTIARY.filter(b => b.tier <= tierCap && b.tier >= Math.max(1, tierCap - 2));
    const use = pool.length ? pool : BESTIARY.slice(0, 3);
    const count = clamp(1 + Math.floor(d / 4), 1, 3);
    const pack = [];
    for (let i = 0; i < count; i++) pack.push(this.spawn(pick(use), d, playerLevel));
    return pack;
  }
};
