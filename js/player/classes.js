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
