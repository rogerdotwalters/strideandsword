/* -------------------------------------------------------------------------
   5. Game data: attributes, races, classes, skills, items, bestiary
   ------------------------------------------------------------------------- */
const ATTRS = [
  { key: "strength",     name: "Strength",     short: "STR", blurb: "Physical damage, carry weight" },
  { key: "dexterity",    name: "Dexterity",    short: "DEX", blurb: "Speed, accuracy, evasion" },
  { key: "constitution", name: "Constitution", short: "CON", blurb: "Health, stamina, poison resist" },
  { key: "intelligence", name: "Intelligence", short: "INT", blurb: "Spell power, mana pool" },
  { key: "wisdom",       name: "Wisdom",       short: "WIS", blurb: "Magic defence, crit resistance" },
  { key: "charisma",     name: "Charisma",     short: "CHA", blurb: "Prices, NPC reactions" },
  { key: "luck",         name: "Luck",         short: "LCK", blurb: "Rare drops, critical chance" }
];

const RACES = {
  Human: {
    name: "Human", icon: "🧑", blurb: "Adaptable and stubborn. Nothing they can't learn to do passably.",
    mods: { strength: 1, dexterity: 1, constitution: 1, intelligence: 1, wisdom: 1, charisma: 1, luck: 1 }
  },
  Elf: {
    name: "Elf", icon: "🧝", blurb: "Quick and perceptive, but light of frame.",
    mods: { dexterity: 2, wisdom: 1, constitution: -1 }
  },
  Dwarf: {
    name: "Dwarf", icon: "🧔", blurb: "Built like the doorframe they're blocking.",
    mods: { constitution: 2, strength: 1, dexterity: -1 }
  }
};

const CLASSES = {
  Warrior: {
    name: "Warrior", icon: "⚔️", blurb: "Front line. Soaks damage, hits hard, ignores subtlety.",
    mods: { strength: 2, constitution: 1 },
    hpMul: 1.32, mpMul: 0.55, spMul: 1.2,
    resource: "stamina",
    skills: [
      { id: "cleave",  name: "Cleave",     lvl: 1, cost: 18, res: "stamina", icon: "🪓",
        desc: "Hits every living enemy for 80% weapon damage.", target: "all", mult: 0.8, kind: "phys" },
      { id: "bulwark", name: "Shield Wall",lvl: 3, cost: 15, res: "stamina", icon: "🛡️",
        desc: "+60% armour and +8 HP regen for 2 rounds.", target: "self", kind: "buff",
        buff: { armorPct: 0.6, regen: 8, rounds: 2 } },
      { id: "execute", name: "Execute",    lvl: 5, cost: 30, res: "stamina", icon: "💥",
        desc: "260% damage to a single target. Doubles again below 30% HP.", target: "one", mult: 2.6, kind: "phys", execute: true }
    ]
  },
  Rogue: {
    name: "Rogue", icon: "🗡️", blurb: "Fast, fragile, and lethal when it matters.",
    mods: { dexterity: 2, luck: 1 },
    hpMul: 1.0, mpMul: 0.85, spMul: 1.35,
    resource: "stamina",
    skills: [
      { id: "backstab", name: "Backstab", lvl: 1, cost: 20, res: "stamina", icon: "🔪",
        desc: "180% damage with +35% critical chance.", target: "one", mult: 1.8, kind: "phys", critBonus: 35 },
      { id: "vanish",   name: "Vanish",   lvl: 3, cost: 16, res: "stamina", icon: "💨",
        desc: "+70 evasion for 2 rounds. Your next hit is a guaranteed crit.", target: "self", kind: "buff",
        buff: { evasion: 70, guaranteedCrit: true, rounds: 2 } },
      { id: "flurry",   name: "Flurry",   lvl: 5, cost: 28, res: "stamina", icon: "🌀",
        desc: "Three strikes at 75% damage each, targets chosen at random.", target: "random3", mult: 0.75, kind: "phys" }
    ]
  },
  Mage: {
    name: "Mage", icon: "🔮", blurb: "Glass, cannon. Manage your mana or become scenery.",
    mods: { intelligence: 2, wisdom: 1 },
    hpMul: 0.90, mpMul: 1.5, spMul: 0.85,
    resource: "mana",
    skills: [
      { id: "firebolt", name: "Firebolt", lvl: 1, cost: 12, res: "mana", icon: "🔥",
        desc: "160% spell damage to one target.", target: "one", mult: 1.6, kind: "magic" },
      { id: "mend",     name: "Mend",     lvl: 3, cost: 18, res: "mana", icon: "✨",
        desc: "Restores HP equal to 220% of your spell power.", target: "self", kind: "heal", mult: 2.2 },
      { id: "nova",     name: "Frost Nova",lvl: 5, cost: 26, res: "mana", icon: "❄️",
        desc: "110% spell damage to all enemies and slows them for a round.", target: "all", mult: 1.1, kind: "magic",
        applies: { slow: 1 } }
    ]
  }
};

const RARITY = {
  common:    { name: "Common",    mult: 1.00, color: "common",    weight: 58, priceMul: 1 },
  uncommon:  { name: "Uncommon",  mult: 1.30, color: "uncommon",  weight: 25, priceMul: 2.2 },
  rare:      { name: "Rare",      mult: 1.70, color: "rare",      weight: 11, priceMul: 5 },
  epic:      { name: "Epic",      mult: 2.25, color: "epic",      weight: 4.5, priceMul: 12 },
  legendary: { name: "Legendary", mult: 3.10, color: "legendary", weight: 1.5, priceMul: 30 }
};

const WEAPONS = [
  { base: "Shortsword", icon: "🗡️", dmg: 6,  attr: "strength" },
  { base: "Longsword",  icon: "⚔️", dmg: 8,  attr: "strength" },
  { base: "War Axe",    icon: "🪓", dmg: 10, attr: "strength" },
  { base: "Dagger",     icon: "🔪", dmg: 5,  attr: "dexterity" },
  { base: "Rapier",     icon: "🤺", dmg: 7,  attr: "dexterity" },
  { base: "Oak Staff",  icon: "🪄", dmg: 4,  attr: "intelligence" },
  { base: "Rune Wand",  icon: "🪄", dmg: 5,  attr: "intelligence" }
];
const ARMORS = [
  { base: "Padded Vest",  icon: "🧥", def: 4,  attr: "constitution" },
  { base: "Leather Coat", icon: "🥋", def: 6,  attr: "dexterity" },
  { base: "Chain Hauberk",icon: "🛡️", def: 9,  attr: "constitution" },
  { base: "Plate Cuirass",icon: "🛡️", def: 12, attr: "strength" },
  { base: "Silk Robe",    icon: "👘", def: 3,  attr: "intelligence" }
];
const TRINKETS = [
  { base: "Copper Band",   icon: "💍", attr: "luck" },
  { base: "Owl Charm",     icon: "🦉", attr: "wisdom" },
  { base: "Bull Totem",    icon: "🐂", attr: "strength" },
  { base: "Hare's Foot",   icon: "🐇", attr: "dexterity" },
  { base: "Silver Locket", icon: "📿", attr: "charisma" }
];
const PREFIX = ["Rusted","Sturdy","Keen","Gilded","Runed","Ancient","Blessed","Grim","Wandering","Office-Issue"];
const SUFFIX = ["of the Corridor","of the Stairwell","of Long Walks","of the Third Floor","of Dawn","of Grit","of the Break Room","of Wandering"];

const POTIONS = [
  { key: "hp_s",  name: "Minor Healing Draught", icon: "🧪", type: "potion", restore: { hp: 45 },     price: 25 },
  { key: "hp_l",  name: "Greater Healing Draught",icon: "🧪", type: "potion", restore: { hp: 120 },    price: 70 },
  { key: "mp_s",  name: "Vial of Blue Ink",      icon: "🫙", type: "potion", restore: { mana: 40 },   price: 30 },
  { key: "sp_s",  name: "Bitter Coffee",         icon: "☕", type: "potion", restore: { stamina: 60 },price: 18 },
  { key: "full",  name: "Second Wind",           icon: "🌟", type: "potion", restore: { hp: 80, mana: 40, stamina: 60 }, price: 110 }
];

/* Bestiary. `tier` gates which enemies can appear at a node's difficulty. */
const BESTIARY = [
  { name: "Loose Stapler Swarm", icon: "📎", tier: 1, hp: 22, str: 6,  dex: 9,  con: 5,  int: 2, wis: 2, xp: 55,  gold: 12 },
  { name: "Break Room Rat",      icon: "🐀", tier: 1, hp: 26, str: 7,  dex: 11, con: 6,  int: 2, wis: 3, xp: 60,  gold: 14 },
  { name: "Goblin Intern",       icon: "👺", tier: 1, hp: 34, str: 9,  dex: 8,  con: 8,  int: 5, wis: 4, xp: 85,  gold: 22 },
  { name: "Filing Cabinet Mimic",icon: "🗄️", tier: 2, hp: 58, str: 13, dex: 5,  con: 14, int: 4, wis: 6, xp: 140, gold: 40 },
  { name: "Corridor Wisp",       icon: "👻", tier: 2, hp: 44, str: 6,  dex: 15, con: 7,  int: 13,wis: 11,xp: 150, gold: 35 },
  { name: "Vending Golem",       icon: "🤖", tier: 2, hp: 76, str: 15, dex: 4,  con: 16, int: 3, wis: 5, xp: 175, gold: 55 },
  { name: "Stairwell Stalker",   icon: "🕷️", tier: 3, hp: 68, str: 14, dex: 17, con: 11, int: 8, wis: 8, xp: 230, gold: 62 },
  { name: "Parking Lot Wraith",  icon: "💀", tier: 3, hp: 82, str: 16, dex: 13, con: 13, int: 15,wis: 14,xp: 265, gold: 78 },
  { name: "Hoarding Kobold",     icon: "🦎", tier: 3, hp: 72, str: 15, dex: 14, con: 12, int: 9, wis: 7, xp: 240, gold: 95 },
  { name: "Fluorescent Horror",  icon: "🦇", tier: 4, hp: 118,str: 20, dex: 16, con: 18, int: 14,wis: 13,xp: 400, gold: 130 },
  { name: "Quarterly Review",    icon: "📊", tier: 4, hp: 140,str: 22, dex: 12, con: 22, int: 18,wis: 17,xp: 470, gold: 160 }
];
const BOSSES = [
  { name: "The Facilities Manager", icon: "👔", tier: 2, hp: 190, str: 20, dex: 12, con: 20, int: 12, wis: 14, xp: 900,  gold: 320, boss: true },
  { name: "Ancient Copier, Awoken", icon: "🖨️", tier: 3, hp: 280, str: 24, dex: 10, con: 26, int: 16, wis: 16, xp: 1500, gold: 520, boss: true },
  { name: "Warden of the Skyway",   icon: "🐉", tier: 4, hp: 420, str: 30, dex: 18, con: 30, int: 22, wis: 22, xp: 2600, gold: 900, boss: true }
];

const NODE_NAMES = {
  combat:   ["Cracked Planter","Bike Rack Ambush","Loading Dock","Hedgerow Skirmish","Side Entrance","Overflow Lot","Utility Alcove","Crosswalk Standoff","Bench Row","Delivery Bay"],
  treasure: ["Forgotten Cache","Lost & Found","Dropped Satchel","Cracked Paving Stone","Old Mail Slot","Supply Closet"],
  boss:     ["The Long Corridor","Rooftop Access","The Deep Stairwell","Far Parking Deck"],
  landmark: ["Quiet Fountain","Sunlit Bench","Old Oak","Coffee Cart","Memorial Stone"]
};

/* -------------------------------------------------------------------------
   6. CombatCalculator — all derived stats and damage maths
   ------------------------------------------------------------------------- */
const Calc = {
  /** Effective attributes = base (already includes race mods) + equipment. */
  effectiveAttrs(ch) {
    const a = Object.assign({}, ch.attributes);
    for (const it of (ch.equipment || [])) {
      if (it && it.stats && it.stats.bonusAttribute) {
        for (const k in it.stats.bonusAttribute) a[k] = (a[k] || 0) + it.stats.bonusAttribute[k];
      }
    }
    return a;
  },
  maxHp(ch) {
    const a = this.effectiveAttrs(ch), c = CLASSES[ch.class];
    return Math.round((44 + a.constitution * 6.5 + a.strength * 1.6 + (ch.level - 1) * 13) * c.hpMul);
  },
  maxMana(ch) {
    const a = this.effectiveAttrs(ch), c = CLASSES[ch.class];
    return Math.round((14 + a.intelligence * 4.4 + a.wisdom * 1.8 + (ch.level - 1) * 6) * c.mpMul);
  },
  maxStamina(ch) {
    const a = this.effectiveAttrs(ch), c = CLASSES[ch.class];
    return Math.round((46 + a.constitution * 3 + a.dexterity * 2.4 + (ch.level - 1) * 5) * c.spMul);
  },
  weaponDamage(ch) {
    const w = (ch.equipment || []).find(i => i && i.type === "weapon");
    return w ? (w.stats.damage || 0) : 2; // bare fists
  },
  armor(ch) {
    const a = this.effectiveAttrs(ch);
    let def = a.constitution * 0.55;
    for (const it of (ch.equipment || [])) if (it && it.stats && it.stats.defense) def += it.stats.defense;
    return Math.round(def);
  },
  attackPower(ch) {
    const a = this.effectiveAttrs(ch);
    const c = CLASSES[ch.class];
    const boost = c.name === "Warrior" ? 1.2 : c.name === "Rogue" ? 1.05 : 0.85;
    return (a.strength * 1.15 + a.dexterity * 0.55 + this.weaponDamage(ch) * 1.6) * boost;
  },
  spellPower(ch) {
    const a = this.effectiveAttrs(ch);
    const c = CLASSES[ch.class];
    const boost = c.name === "Mage" ? 1.35 : 0.8;
    return (a.intelligence * 1.45 + a.wisdom * 0.5 + this.weaponDamage(ch) * 0.7) * boost;
  },
  accuracy(ch)   { const a = this.effectiveAttrs(ch); return 74 + a.dexterity * 1.5 + a.luck * 0.4; },
  evasion(ch)    { const a = this.effectiveAttrs(ch); return a.dexterity * 1.35 + a.luck * 0.45; },
  critChance(ch) {
    const a = this.effectiveAttrs(ch);
    const base = 4 + a.luck * 0.85 + a.dexterity * 0.32;
    return clamp(base + (ch.class === "Rogue" ? 7 : 0), 0, 70);
  },
  critResist(ch) { const a = this.effectiveAttrs(ch); return a.wisdom * 0.65; },
  magicDefense(ch) {
    const a = this.effectiveAttrs(ch);
    let res = 0;
    for (const it of (ch.equipment || [])) if (it && it.stats && it.stats.resistance) res += it.stats.resistance;
    return a.wisdom * 1.25 + a.intelligence * 0.35 + res;
  },
  initiative(ch) { const a = this.effectiveAttrs(ch); return a.dexterity * 2 + a.luck * 0.5 + rnd(0, 8); },
  priceMod(ch)   { const a = this.effectiveAttrs(ch); return clamp(1 - (a.charisma - 10) * 0.02, 0.6, 1.4); },

  /** Mitigation curve: armour has diminishing returns, never full immunity. */
  mitigate(raw, defence) { return Math.max(1, raw * (100 / (100 + Math.max(0, defence)))); },

  xpForLevel(level) { return 1000 + (level - 1) * 450; },

  /** One attack resolution. Returns {hit, crit, damage}. */
  resolveHit(atk, def, opts) {
    opts = opts || {};
    const acc = (atk.accuracy || 80) + (opts.accBonus || 0);
    const evd = (def.evasion || 0) + (def.tempEvasion || 0);
    const hitChance = clamp(acc - evd * 0.75, 22, 96);
    if (!chance(hitChance)) return { hit: false, crit: false, damage: 0 };

    const critC = clamp((atk.critChance || 5) + (opts.critBonus || 0) - (def.critResist || 0), 0, 92);
    const crit = opts.guaranteedCrit || chance(critC);

    const defence = opts.kind === "magic" ? def.magicDefense : def.armor;
    let raw;
    if (atk.atkMin != null && atk.atkMax != null) {
      // An authored monster states its damage range outright, so use it as
      // written rather than deriving a figure from attributes.
      raw = rnd(atk.atkMin, atk.atkMax) * (opts.mult || 1);
    } else {
      const power = opts.kind === "magic" ? atk.spellPower : atk.attackPower;
      raw = power * (opts.mult || 1) * rnd(0.86, 1.14);
    }
    if (crit) raw *= 1.85;
    return { hit: true, crit, damage: Math.max(1, Math.round(this.mitigate(raw, defence))) };
  }
};

/* -------------------------------------------------------------------------
   7. Item generation
   ------------------------------------------------------------------------- */
const Items = {
  rollRarity(luck, difficulty) {
    const tilt = 1 + (luck - 10) * 0.045 + (difficulty || 1) * 0.05;
    const entries = Object.entries(RARITY).map(([k, v]) => {
      const rareness = ["common","uncommon","rare","epic","legendary"].indexOf(k);
      return [k, v.weight * Math.pow(tilt, rareness)];
    });
    const total = entries.reduce((s, e) => s + e[1], 0);
    let r = Math.random() * total;
    for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
    return "common";
  },

  generate(level, luck, difficulty, forceType) {
    const type = forceType || pick(["weapon", "weapon", "armor", "armor", "trinket", "potion"]);
    if (type === "potion") {
      const p = pick(POTIONS);
      return { itemId: uid("itm"), name: p.name, type: "potion", icon: p.icon,
               rarity: "common", level, stats: {}, restore: p.restore,
               effect: Object.entries(p.restore).map(([k, v]) => "+" + v + " " + k.toUpperCase()).join(", "),
               price: p.price, quantity: 1 };
    }
    const rarity = this.rollRarity(luck, difficulty);
    const rm = RARITY[rarity].mult;
    const lvlScale = 1 + (level - 1) * 0.16;

    let baseDef, icon, name, stats = {};
    if (type === "weapon") {
      baseDef = pick(WEAPONS); icon = baseDef.icon;
      stats.damage = Math.max(1, Math.round(baseDef.dmg * rm * lvlScale));
    } else if (type === "armor") {
      baseDef = pick(ARMORS); icon = baseDef.icon;
      stats.defense = Math.max(1, Math.round(baseDef.def * rm * lvlScale));
    } else {
      baseDef = pick(TRINKETS); icon = baseDef.icon;
    }

    const rIdx = ["common","uncommon","rare","epic","legendary"].indexOf(rarity);
    // Trinkets have no damage or defence, so they always carry at least one
    // attribute bonus — otherwise a common trinket would be pure vendor trash.
    if (rIdx >= 1 || type === "trinket") {
      const n = clamp(Math.round(rIdx * 0.9), 1, 3);
      stats.bonusAttribute = {};
      const pool = ATTRS.map(a => a.key);
      const chosen = new Set([baseDef.attr]);
      while (chosen.size < n) chosen.add(pick(pool));
      for (const k of chosen) {
        stats.bonusAttribute[k] = Math.max(1,
          Math.round((1 + rIdx * 0.85) * (0.7 + Math.random() * 0.6) * (1 + (level - 1) * 0.06)));
      }
    }

    name = baseDef.base;
    if (rIdx >= 1) name = pick(PREFIX) + " " + name;
    if (rIdx >= 3) name = name + " " + pick(SUFFIX);

    const price = Math.round((12 + level * 6) * RARITY[rarity].priceMul);
    return { itemId: uid("itm"), name, type, icon, rarity, level, stats,
             effect: this.describe({ type, stats }), price, quantity: 1 };
  },

  describe(it) {
    const parts = [];
    if (it.stats.damage)  parts.push("+" + it.stats.damage + " DMG");
    if (it.stats.defense) parts.push("+" + it.stats.defense + " DEF");
    if (it.stats.bonusAttribute) {
      for (const k in it.stats.bonusAttribute) {
        const a = ATTRS.find(x => x.key === k);
        parts.push("+" + it.stats.bonusAttribute[k] + " " + (a ? a.short : k.slice(0, 3).toUpperCase()));
      }
    }
    if (it.restore) for (const k in it.restore) parts.push("+" + it.restore[k] + " " + k.toUpperCase());
    return parts.join("  ") || "No bonuses";
  },

  slotOf(item) {
    return item.type === "weapon" ? "weapon" : item.type === "armor" ? "armor" :
           item.type === "trinket" ? "trinket" : null;
  }
};

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
