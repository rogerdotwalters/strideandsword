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

/* ---------------------------------------------------------------- equipment

   TWELVE SLOTS, AND WHY THE NUMBERS SHRANK

   A character used to wear one weapon, one piece of armour and one trinket.
   Now there is a whole paper doll, and the arithmetic has to be told about it:
   eight armour pieces each carrying what one piece used to carry would make a
   fully-kitted character eight times as armoured as the balance table assumes.

   So every slot has a **share** of the old single-piece budget (below, in
   js/world/items.js), and the shares add up to about one. A full kit lands
   roughly where one good piece landed before, which keeps `npm run balance`
   and the published win rates honest — and each individual piece is a small
   improvement rather than the whole of your defence.

   WEIGHT IS THE CLASS GATE

   Armour is light, medium or heavy, and a class can wear up to its own limit:
   a warrior wears anything, a rogue stops at medium, a mage at light. That is
   one rule covering every armour piece in the game, present and future,
   instead of a list of classes on each item. Weapons are gated by family
   (nobody teaches a mage the greataxe) and everything can additionally ask for
   an attribute minimum. */

const ARMOR_WEIGHTS = {
  light:  { key: "light",  name: "Light",  order: 1, blurb: "Cloth, silk and soft leather." },
  medium: { key: "medium", name: "Medium", order: 2, blurb: "Hardened leather, hide and mail." },
  heavy:  { key: "heavy",  name: "Heavy",  order: 3, blurb: "Scale, plate and the weight of it." }
};

/* The paper doll, in the order it is drawn. `armor: true` means the slot is
   held to the wearer's armour limit; the rest are gated by family or by
   nothing at all. */
const EQUIP_SLOTS = [
  { key: "mainhand",  label: "Main hand", icon: "⚔️", kind: "weapon" },
  { key: "offhand",   label: "Off hand",  icon: "🛡️", kind: "offhand" },
  { key: "helm",      label: "Helm",      icon: "🪖", kind: "armor", armor: true },
  { key: "shoulders", label: "Shoulders", icon: "🎽", kind: "armor", armor: true },
  { key: "chest",     label: "Chest",     icon: "🥋", kind: "armor", armor: true },
  { key: "gloves",    label: "Gloves",    icon: "🧤", kind: "armor", armor: true },
  { key: "belt",      label: "Belt",      icon: "🎗️", kind: "armor", armor: true },
  { key: "legs",      label: "Legs",      icon: "👖", kind: "armor", armor: true },
  { key: "boots",     label: "Boots",     icon: "🥾", kind: "armor", armor: true },
  { key: "back",      label: "Back",      icon: "🧣", kind: "armor", armor: true },
  { key: "neck",      label: "Neck",      icon: "📿", kind: "trinket" },
  { key: "ring",      label: "Ring",      icon: "💍", kind: "trinket" }
];

/* Weapon families, so a class can be allowed swords without being handed a
   list of every sword ever authored. */
const WEAPON_FAMILIES = ["blade", "axe", "blunt", "dagger", "polearm", "bow", "staff", "wand"];

/**
 * What each class may wear and wield.
 *
 * `armor` is the heaviest weight allowed; `weapons` the families it trained
 * with; `offhand` what it may hold in the other hand. Deliberately generous at
 * the edges — a mage with a dagger is a classic, a warrior with a bow is fine
 * — and strict where it matters: nobody in a robe takes a plate hit, and the
 * staff is not a warrior's.
 */
const CLASS_GEAR = {
  Warrior: { armor: "heavy",  weapons: ["blade", "axe", "blunt", "dagger", "polearm", "bow"],
             offhand: ["shield", "dagger", "blade"] },
  Rogue:   { armor: "medium", weapons: ["blade", "dagger", "bow", "polearm"],
             offhand: ["dagger", "blade", "shield"] },
  Mage:    { armor: "light",  weapons: ["staff", "wand", "dagger", "blunt"],
             offhand: ["focus", "wand", "dagger"] }
};

/* -------------------------------------------------------------- base gear
   Every base item names its slot, its family, its weight and what it asks of
   you. `attr` is the attribute the piece favours when it rolls a bonus, as
   before; `req` is the minimum to wear it at all, scaled with item level by
   `Items.requirementFor`.

   **The damage numbers are lower than the weapons they replace, on purpose.**
   Before class gating, a warrior's weapon was drawn from every weapon in the
   game — wands and staves included — and the published win rates were measured
   against that average. Now each class draws only from what it can actually
   wield, so the same numbers would have made every warrior sharply stronger
   than the table says. Each family was scaled until the *allowed* pool for a
   class averages what the ungated pool averaged, which `npm run balance`
   confirms rather than assumes. */
const GEAR_BASES = [
  /* ------------------------------------------------------------ main hand */
  { base: "Shortsword",    icon: "🗡️", slot: "mainhand", family: "blade",   dmg: 5,  attr: "strength",     req: { strength: 9 } },
  { base: "Longsword",     icon: "⚔️", slot: "mainhand", family: "blade",   dmg: 6,  attr: "strength",     req: { strength: 12 } },
  { base: "Greatsword",    icon: "⚔️", slot: "mainhand", family: "blade",   dmg: 9, attr: "strength",     req: { strength: 15 }, twoHanded: true },
  { base: "War Axe",       icon: "🪓", slot: "mainhand", family: "axe",     dmg: 7, attr: "strength",     req: { strength: 13 } },
  { base: "Great Axe",     icon: "🪓", slot: "mainhand", family: "axe",     dmg: 10, attr: "strength",     req: { strength: 16 }, twoHanded: true },
  { base: "Iron Mace",     icon: "🔨", slot: "mainhand", family: "blunt",   dmg: 7,  attr: "strength",     req: { strength: 11 } },
  { base: "Dagger",        icon: "🔪", slot: "mainhand", family: "dagger",  dmg: 4,  attr: "dexterity",    req: { dexterity: 8 } },
  { base: "Rapier",        icon: "🤺", slot: "mainhand", family: "blade",   dmg: 5,  attr: "dexterity",    req: { dexterity: 12 } },
  { base: "Boar Spear",    icon: "🔱", slot: "mainhand", family: "polearm", dmg: 7,  attr: "strength",     req: { strength: 11, dexterity: 9 } },
  { base: "Recurve Bow",   icon: "🏹", slot: "mainhand", family: "bow",     dmg: 6,  attr: "dexterity",    req: { dexterity: 13 }, twoHanded: true },
  { base: "Oak Staff",     icon: "🪄", slot: "mainhand", family: "staff",   dmg: 4,  attr: "intelligence", req: { intelligence: 11 }, twoHanded: true },
  { base: "Rune Wand",     icon: "🪄", slot: "mainhand", family: "wand",    dmg: 5,  attr: "intelligence", req: { intelligence: 13 } },
  /* -------------------------------------------------------------- offhand */
  { base: "Buckler",       icon: "🛡️", slot: "offhand", family: "shield", def: 5,  weight: "medium", attr: "dexterity",    req: { strength: 10 } },
  { base: "Heater Shield", icon: "🛡️", slot: "offhand", family: "shield", def: 8,  weight: "heavy",  attr: "constitution", req: { strength: 13 } },
  { base: "Parrying Dirk", icon: "🔪", slot: "offhand", family: "dagger", dmg: 3,  attr: "dexterity",    req: { dexterity: 12 } },
  { base: "Scrying Focus", icon: "🔮", slot: "offhand", family: "focus",  def: 2,  weight: "light",  attr: "intelligence", req: { intelligence: 12 } },
  /* ---------------------------------------------------------------- armour */
  { base: "Leather Cap",   icon: "🪖", slot: "helm",      def: 5,  weight: "light",  attr: "dexterity",    req: {} },
  { base: "Mail Coif",     icon: "🪖", slot: "helm",      def: 8,  weight: "medium", attr: "constitution", req: { strength: 11 } },
  { base: "Dented Helm",   icon: "🪖", slot: "helm",      def: 11, weight: "heavy",  attr: "constitution", req: { strength: 13 } },
  { base: "Hide Mantle",   icon: "🎽", slot: "shoulders", def: 4,  weight: "light",  attr: "dexterity",    req: {} },
  { base: "Iron Pauldrons",icon: "🎽", slot: "shoulders", def: 9,  weight: "heavy",  attr: "strength",     req: { strength: 13 } },
  { base: "Silk Robe",     icon: "👘", slot: "chest",     def: 4,  weight: "light",  attr: "intelligence", req: {} },
  { base: "Padded Vest",   icon: "🧥", slot: "chest",     def: 6,  weight: "light",  attr: "constitution", req: {} },
  { base: "Leather Coat",  icon: "🥋", slot: "chest",     def: 9,  weight: "medium", attr: "dexterity",    req: { dexterity: 10 } },
  { base: "Chain Hauberk", icon: "🛡️", slot: "chest",     def: 13, weight: "medium", attr: "constitution", req: { strength: 12 } },
  { base: "Plate Cuirass", icon: "🛡️", slot: "chest",     def: 17, weight: "heavy",  attr: "strength",     req: { strength: 15, constitution: 12 } },
  { base: "Work Gloves",   icon: "🧤", slot: "gloves",    def: 3,  weight: "light",  attr: "dexterity",    req: {} },
  { base: "Mail Mitts",    icon: "🧤", slot: "gloves",    def: 6,  weight: "medium", attr: "strength",     req: { strength: 11 } },
  { base: "Gauntlets",     icon: "🧤", slot: "gloves",    def: 8,  weight: "heavy",  attr: "strength",     req: { strength: 14 } },
  { base: "Rope Belt",     icon: "🎗️", slot: "belt",      def: 2,  weight: "light",  attr: "wisdom",       req: {} },
  { base: "Belt of Holding", icon: "🎗️", slot: "belt",    def: 4,  weight: "medium", attr: "constitution", req: {} },
  { base: "Hide Breeches", icon: "👖", slot: "legs",      def: 6,  weight: "light",  attr: "dexterity",    req: {} },
  { base: "Riveted Greaves", icon: "👖", slot: "legs",    def: 11, weight: "heavy",  attr: "constitution", req: { strength: 13 } },
  { base: "Long-Mile Boots", icon: "🥾", slot: "boots",   def: 4,  weight: "light",  attr: "dexterity",    req: {} },
  { base: "Iron Sabatons", icon: "🥾", slot: "boots",     def: 7,  weight: "heavy",  attr: "constitution", req: { strength: 12 } },
  { base: "Traveller's Cloak", icon: "🧣", slot: "back",  def: 3,  weight: "light",  attr: "wisdom",       req: {} },
  { base: "Scale Drape",   icon: "🧣", slot: "back",      def: 6,  weight: "medium", attr: "constitution", req: { strength: 11 } },
  /* -------------------------------------------------------------- trinkets */
  { base: "Copper Band",   icon: "💍", slot: "ring", attr: "luck",         req: {} },
  { base: "Signet Ring",   icon: "💍", slot: "ring", attr: "charisma",     req: {} },
  { base: "Witchlight Shard", icon: "💎", slot: "ring", attr: "intelligence", req: { intelligence: 11 } },
  { base: "Owl Charm",     icon: "🦉", slot: "neck", attr: "wisdom",       req: {} },
  { base: "Bull Totem",    icon: "🐂", slot: "neck", attr: "strength",     req: {} },
  { base: "Hare's Foot",   icon: "🐇", slot: "neck", attr: "dexterity",    req: {} },
  { base: "Silver Locket", icon: "📿", slot: "neck", attr: "charisma",     req: {} }
];

/* Views onto the one table, for anything that still thinks in three kinds. */
const WEAPONS  = GEAR_BASES.filter(g => g.slot === "mainhand");
const ARMORS   = GEAR_BASES.filter(g => g.def && g.slot !== "offhand");
const TRINKETS = GEAR_BASES.filter(g => g.slot === "ring" || g.slot === "neck");

const PREFIX = ["Rusted","Sturdy","Keen","Gilded","Runed","Ancient","Blessed","Grim","Wandering","Weathered"];
const SUFFIX = ["of the Ford","of the Fen","of Long Walks","of the Low Road","of Dawn","of Grit","of the Hearth","of Wandering"];

const POTIONS = [
  { key: "hp_s",  name: "Minor Healing Draught", icon: "🧪", type: "potion", restore: { hp: 45 },     price: 25 },
  { key: "hp_l",  name: "Greater Healing Draught",icon: "🧪", type: "potion", restore: { hp: 120 },    price: 70 },
  { key: "mp_s",  name: "Vial of Scribe's Ink", icon: "🫙", type: "potion", restore: { mana: 40 },   price: 30 },
  { key: "sp_s",  name: "Bitterroot Tea",        icon: "🍵", type: "potion", restore: { stamina: 60 },price: 18 },
  { key: "full",  name: "Second Wind",           icon: "🌟", type: "potion", restore: { hp: 80, mana: 40, stamina: 60 }, price: 110 }
];

/* Bestiary. `tier` gates which enemies can appear at a node's difficulty. */
const BESTIARY = [
  { name: "Bog Leech",          icon: "🪱", tier: 1, hp: 22, str: 6,  dex: 9,  con: 5,  int: 2, wis: 2, xp: 55,  gold: 12 },
  { name: "Ash Rat",            icon: "🐀", tier: 1, hp: 26, str: 7,  dex: 11, con: 6,  int: 2, wis: 3, xp: 60,  gold: 14 },
  { name: "Rick Kobold",        icon: "👺", tier: 1, hp: 34, str: 9,  dex: 8,  con: 8,  int: 5, wis: 4, xp: 85,  gold: 22 },
  { name: "Bark Lurker",        icon: "🌳", tier: 2, hp: 58, str: 13, dex: 5,  con: 14, int: 4, wis: 6, xp: 140, gold: 40 },
  { name: "Marsh Wisp",         icon: "✨", tier: 2, hp: 44, str: 6,  dex: 15, con: 7,  int: 13,wis: 11,xp: 150, gold: 35 },
  { name: "Quarry Golem",       icon: "🗿", tier: 2, hp: 76, str: 15, dex: 4,  con: 16, int: 3, wis: 5, xp: 175, gold: 55 },
  { name: "Dire Wolf",          icon: "🐺", tier: 3, hp: 68, str: 14, dex: 17, con: 11, int: 8, wis: 8, xp: 230, gold: 62 },
  { name: "Rust Wraith",        icon: "👻", tier: 3, hp: 82, str: 16, dex: 13, con: 13, int: 15,wis: 14,xp: 265, gold: 78 },
  { name: "Mire Hag",           icon: "🧙", tier: 3, hp: 72, str: 15, dex: 14, con: 12, int: 9, wis: 7, xp: 240, gold: 95 },
  { name: "Fen Horror",         icon: "🦑", tier: 4, hp: 118,str: 20, dex: 16, con: 18, int: 14,wis: 13,xp: 400, gold: 130 },
  { name: "Drowned King",       icon: "👑", tier: 4, hp: 140,str: 22, dex: 12, con: 22, int: 18,wis: 17,xp: 470, gold: 160 }
];
const BOSSES = [
  { name: "The Warden of the Ford", icon: "🛡️", tier: 2, hp: 190, str: 20, dex: 12, con: 20, int: 12, wis: 14, xp: 900,  gold: 320, boss: true },
  { name: "Moss-Grown Colossus",    icon: "🗿", tier: 3, hp: 280, str: 24, dex: 10, con: 26, int: 16, wis: 16, xp: 1500, gold: 520, boss: true },
  { name: "The Pale Wyrm",          icon: "🐲", tier: 4, hp: 420, str: 30, dex: 18, con: 30, int: 22, wis: 22, xp: 2600, gold: 900, boss: true }
];

const NODE_NAMES = {
  combat:   ["Broken Milestone","Thornbrake Ambush","The Ferry Landing","Hedgerow Skirmish","Postern Gate","Fallow Strip","Culvert Mouth","Crossroads Standoff","Drover's Rest","Wagon Ford"],
  treasure: ["Forgotten Cache","Lost Satchel","Dropped Pack","Cracked Flagstone","Hollow Milepost","Hedge Stash"],
  boss:     ["The Long Causeway","The High Rocks","The Deep Stair","The Far Meadow"],
  landmark: ["Quiet Fountain","Sunlit Bench","Old Oak","Wayside Shrine","Memorial Stone"]
};