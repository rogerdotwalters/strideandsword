/* ==========================================================================
   CONTENT — the authored game database, shared by the game and the editor.

   Three tables, all arrays of plain rows in localStorage:

     content_monsters   what you fight
     content_loot       loot tables: parallel item / percentage lists
     content_items      gear and consumables

   Rarity is one vocabulary across monsters and items, with a colour per tier
   and a multiplier set that scales a monster's authored *base* numbers. Base
   values are what you type; effective values are what the game uses. Nothing
   is ever written back multiplied — the scale is applied on read, so changing
   a multiplier restyles every monster of that rarity at once.
   ========================================================================== */
const Content = (function () {

  const KEYS = {
    monsters:  "content_monsters",
    loot:      "content_loot",
    items:     "content_items",
    spawns:    "content_spawns",
    locations: "content_locations",
    dungeons:    "content_dungeons",
    instances: "content_instances",
    config:    "content_config"
  };

  /* Which field holds the primary key, per table. */
  const ID_KEY = {
    monsters:  "monsterId",
    loot:      "lootTableId",
    items:     "itemId",
    spawns:    "spawnTableId",
    locations: "locationId",
    dungeons:    "dungeonId",
    instances: "instanceId"
  };
  const ID_PREFIX = {
    monsters: "mon", loot: "lt", items: "itm", spawns: "sp", locations: "loc", dungeons: "dlv", instances: "inst"
  };

  /* ---------------------------------------------------------------- rarity */
  const RARITY = {
    common:    { key: "common",    name: "Common",    color: "#9aa7ba", order: 0 },
    uncommon:  { key: "uncommon",  name: "Uncommon",  color: "#5fae67", order: 1 },
    rare:      { key: "rare",      name: "Rare",      color: "#4a8fd4", order: 2 },
    epic:      { key: "epic",      name: "Epic",      color: "#a76fd4", order: 3 },
    legendary: { key: "legendary", name: "Legendary", color: "#e0a33e", order: 4 },
    mythic:    { key: "mythic",    name: "Mythic",    color: "#e05c5c", order: 5 }
  };
  const RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];

  /* Monster scaling per rarity. Editable from the editor's Rarity tab.
     lootRolls is extra rolls of the monster's loot table; lootTilt biases
     which tier of item a procedural fallback drop lands on. */
  const DEFAULT_SCALE = {
    common:    { hp: 1.00, dmg: 1.00, armor: 1.00, exp: 1.0, lootRolls: 0, lootTilt: 1.00 },
    uncommon:  { hp: 1.18, dmg: 1.12, armor: 1.10, exp: 1.3, lootRolls: 0, lootTilt: 1.15 },
    rare:      { hp: 1.45, dmg: 1.28, armor: 1.25, exp: 1.8, lootRolls: 1, lootTilt: 1.35 },
    epic:      { hp: 1.90, dmg: 1.50, armor: 1.45, exp: 2.8, lootRolls: 1, lootTilt: 1.60 },
    legendary: { hp: 2.60, dmg: 1.80, armor: 1.70, exp: 4.5, lootRolls: 2, lootTilt: 2.00 },
    mythic:    { hp: 3.60, dmg: 2.20, armor: 2.00, exp: 7.0, lootRolls: 3, lootTilt: 2.60 }
  };

  const MONSTER_TYPES = ["beast", "humanoid", "creature", "undead", "elemental",
                         "construct", "aberration", "dragon", "spirit", "plant"];

  const DAMAGE_TYPES = ["physical", "slashing", "piercing", "blunt", "fire", "frost",
                        "lightning", "poison", "arcane", "shadow", "holy"];

  /* Damage types the game resolves against magic defence rather than armour. */
  const MAGIC_DAMAGE = ["fire", "frost", "lightning", "arcane", "shadow", "holy", "poison"];

  /* ------------------------------------------------------------- gear slots
     gameType maps an authored slot onto the three equipment slots the game
     actually has, so authored gear is equippable without further work. */
  const GEAR_SLOTS = [
    { key: "helm",     label: "Helm",      gameType: "armor",      icon: "helm" },
    { key: "shoulder", label: "Shoulders", gameType: "armor",      icon: "shoulder" },
    { key: "chest",    label: "Chest",     gameType: "armor",      icon: "chest" },
    { key: "clothing", label: "Clothing",  gameType: "armor",      icon: "cloth" },
    { key: "gloves",   label: "Gloves",    gameType: "armor",      icon: "gloves" },
    { key: "belt",     label: "Belt",      gameType: "armor",      icon: "belt" },
    { key: "legs",     label: "Legs",      gameType: "armor",      icon: "legs" },
    { key: "boots",    label: "Boots",     gameType: "armor",      icon: "boots" },
    { key: "cloak",    label: "Cloak",     gameType: "armor",      icon: "cloak" },
    { key: "shield",   label: "Shield",    gameType: "armor",      icon: "shield" },
    { key: "sword",    label: "Sword",     gameType: "weapon",     icon: "sword" },
    { key: "axe",      label: "Axe",       gameType: "weapon",     icon: "axe" },
    { key: "mace",     label: "Mace",      gameType: "weapon",     icon: "mace" },
    { key: "dagger",   label: "Dagger",    gameType: "weapon",     icon: "dagger" },
    { key: "spear",    label: "Spear",     gameType: "weapon",     icon: "spear" },
    { key: "bow",      label: "Bow",       gameType: "weapon",     icon: "bow" },
    { key: "staff",    label: "Staff",     gameType: "weapon",     icon: "staff" },
    { key: "wand",     label: "Wand",      gameType: "weapon",     icon: "wand" },
    { key: "ring",     label: "Ring",      gameType: "trinket",    icon: "ring" },
    { key: "amulet",   label: "Amulet",    gameType: "trinket",    icon: "amulet" },
    { key: "gem",      label: "Gem",       gameType: "trinket",    icon: "gem" },
    { key: "potion",   label: "Potion",    gameType: "potion",     icon: "potion" },
    { key: "scroll",   label: "Scroll",    gameType: "consumable", icon: "scroll" },
    { key: "tome",     label: "Tome",      gameType: "quest",      icon: "tome" }
  ];

  /* ------------------------------------------------------- world vocabulary
     Shared by the Atlas (which types real OSM footprints) and the map editor
     (where you pick a building type by hand). One list, one set of colours. */
  const BUILDING_KINDS = {
    tavern:     { label: "tavern",        icon: "\ud83c\udf7a", color: "#c98a3a" },
    smithy:     { label: "smithy",        icon: "\ud83d\udd28", color: "#c2603f" },
    temple:     { label: "temple",        icon: "\u26ea", color: "#8f6fd0" },
    tower:      { label: "tower",         icon: "\ud83d\uddfc", color: "#5f8fd0" },
    market:     { label: "market stall",  icon: "\ud83e\uddfa", color: "#c9a63a" },
    guildhall:  { label: "guild hall",    icon: "\ud83c\udfdb\ufe0f", color: "#7f9fc0" },
    keep:       { label: "keep",          icon: "\ud83c\udff0", color: "#8899b0" },
    cottage:    { label: "cottage",       icon: "\ud83c\udfda\ufe0f", color: "#9a7f5f" },
    apothecary: { label: "apothecary",    icon: "\u2697\ufe0f", color: "#5fae8f" },
    library:    { label: "library",       icon: "\ud83d\udcda", color: "#6f8fd0" },
    granary:    { label: "granary",       icon: "\ud83c\udf3e", color: "#b09a4a" },
    stable:     { label: "stable",        icon: "\ud83d\udc0e", color: "#8a7a5a" },
    foundry:    { label: "foundry",       icon: "\u2692\ufe0f", color: "#b0563f" },
    bathhouse:  { label: "bathhouse",     icon: "\u2668\ufe0f", color: "#5f9fae" },
    barracks:   { label: "barracks",      icon: "\ud83d\udee1\ufe0f", color: "#7a8a9a" },
    counting:   { label: "counting house",icon: "\ud83e\ude99", color: "#c9a63a" }
  };

  /* What a hand-placed location *is*, mirroring the procedural node types. */
  const SITE_KINDS = [
    { key: "combat",   label: "Combat site", icon: "\u2694\ufe0f" },
    { key: "boss",     label: "Boss lair",   icon: "\ud83d\udc51" },
    { key: "treasure", label: "Cache",       icon: "\ud83d\udce6" },
    { key: "landmark", label: "Landmark",    icon: "\u26f2" }
  ];

  /* Chests: a tier for looks and extra rolls, plus the loot table it holds. */
  const CHEST_TIERS = [
    { key: "",        label: "No chest",      rolls: 0, rarity: "common" },
    { key: "wooden",  label: "Wooden chest",  rolls: 1, rarity: "common" },
    { key: "iron",    label: "Iron chest",    rolls: 1, rarity: "uncommon" },
    { key: "gilded",  label: "Gilded chest",  rolls: 2, rarity: "rare" },
    { key: "warded",  label: "Warded chest",  rolls: 3, rarity: "epic" }
  ];
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /* ------------------------------------------------------------------ dungeons
     A dungeon is an area you walk into rather than a point you stand on: a
     footprint drawn on the map, and behind it a stack of floors. Once you are
     inside, the metres you walk are what carry you through — see planFloor. */
  const DUNGEON_KINDS = {
    dungeon:  { label: "dungeon",     icon: "🏰", color: "#8f6fd0", floor: "Floor" },
    cave:     { label: "cave",        icon: "🕳️", color: "#7a8a9a", floor: "Depth" },
    forest:   { label: "forest",      icon: "🌲", color: "#5fae67", floor: "Reach" },
    crypt:    { label: "crypt",       icon: "⚰️", color: "#9a8fb0", floor: "Vault" },
    ruin:     { label: "ruin",        icon: "🏛️", color: "#b0a07a", floor: "Tier" },
    mine:     { label: "mine",        icon: "⛏️", color: "#c2603f", floor: "Level" },
    tower:    { label: "tower",       icon: "🗼", color: "#5f8fd0", floor: "Storey" },
    lair:     { label: "beast lair",  icon: "🐾", color: "#c98a3a", floor: "Den" },
    building: { label: "building",    icon: "🏢", color: "#8899b0", floor: "Floor" }
  };
  const DUNGEON_SHAPES = [
    { key: "circle", label: "Circle" },
    { key: "rect",   label: "Rectangle" }
  ];
  /* What a floor can throw at you between the entrance and the stairs down. */
  const STOP_KINDS = {
    fight: { label: "Fight",  icon: "⚔️" },
    chest: { label: "Chest",  icon: "🧰" },
    boss:  { label: "Boss",   icon: "👑" },
    stairs:{ label: "Stairs", icon: "🪜" }
  };

  /* ------------------------------------------------------------------ icons
     24 originals on a 24px grid. Stroked with currentColor so a rarity colour
     tints them, with a little fill for weight. */
  const ICONS = {
    sword:    '<path d="M20 3.5 12.5 11l-1.4-1.4L18.6 2H21z"/><path d="M11.8 10.2 5 17v2h2l6.8-6.8"/><path d="m4 20 1.6-1.6M9.2 12.6l2.2 2.2"/>',
    axe:      '<path d="M5.6 20.8 13.1 13.3"/><path d="M13.5 12.9 9.3 8.7l4.4-4.4a2.9 2.9 0 0 1 4.1 0l.3.3a2.9 2.9 0 0 1 0 4.1z"/><path d="m7.4 15.2 2.6 2.6"/>',
    mace:     '<path d="M3.5 20.5 11 13"/><circle cx="15" cy="9" r="4.6"/><path d="M15 1.6v2.6M15 13.8v2.6M8.2 9h2.2M19.6 9h2.6"/>',
    dagger:   '<path d="M12 2.4 15.6 10.6H8.4z"/><path d="M5.8 12.2h12.4"/><path d="M12 12.2v5"/><circle cx="12" cy="19" r="1.7"/>',
    spear:    '<path d="M12 1.8c1 1.4 1.5 2.5 1.5 3.6S13 7.9 12 9c-1-1.1-1.5-2.3-1.5-3.6S11 3.2 12 1.8Z"/><path d="M12 9v13.2"/><path d="M10.1 10.9h3.8"/>',
    bow:      '<path d="M8 2.6c6.4 3.8 6.4 15 0 18.8"/><path d="M8 2.6v18.8"/><path d="M5.5 12h13"/><path d="m15 8.8 3.4 3.2-3.4 3.2"/>',
    staff:    '<path d="M12 8v13"/><circle cx="12" cy="5" r="3"/><path d="M9.5 11h5"/>',
    wand:     '<path d="M4.2 20.8 12.4 12.6"/><path d="M17.4 2.6 19 6.9 23.2 8.4 19 9.9 17.4 14.2 15.8 9.9 11.6 8.4 15.8 6.9z"/>',
    helm:     '<path d="M5 12a7 7 0 0 1 14 0v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z"/><path d="M9 12v4M15 12v4M5 14h14"/>',
    shoulder: '<path d="M4 15c0-5 3.6-8 8-8s8 3 8 8v2a2 2 0 0 1-2 2h-3l-1-3H9l-1 3H6a2 2 0 0 1-2-2z"/><path d="M8.5 10.5c2.3-1.3 4.7-1.3 7 0"/>',
    chest:    '<path d="M7 4h10l3 3-2 3v8a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-8L4 7z"/><path d="M12 7v14M8 11h8"/>',
    cloth:    '<path d="M8 3h8l2 4-2 1v13H8V8L6 7z"/><path d="M10 3c0 1.4.9 2 2 2s2-.6 2-2"/>',
    gloves:   '<path d="M7 10V6a1.6 1.6 0 0 1 3.2 0v3M10.2 9V5a1.6 1.6 0 0 1 3.2 0v4M13.4 9.5V7a1.6 1.6 0 0 1 3.2 0v6.5c0 4-2.4 7.5-5.4 7.5S6 17.5 6 14v-3a1.5 1.5 0 0 1 3 0"/>',
    belt:     '<path d="M2 9h20v6H2z"/><path d="M9 9v6M15 9v6"/><path d="M11 11h2v2h-2z"/>',
    legs:     '<path d="M7 3h10l-1 9-1 9h-3l-1-7-1 7H7l-1-9z"/><path d="M6.5 8h11"/>',
    boots:    '<path d="M6 3h5v10l6 3.5c1.2.7 2 1.6 2 2.7V21H6z"/><path d="M6 17h13"/>',
    cloak:    '<path d="M12 3c-3 0-5 1.5-6 4L3 21h18l-3-14c-1-2.5-3-4-6-4Z"/><path d="M9 7c1 2 5 2 6 0"/>',
    shield:   '<path d="M12 2 4 5v7c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V5z"/><path d="M12 7v9M8.5 11.5h7"/>',
    ring:     '<circle cx="12" cy="15" r="6"/><path d="m12 3 2.6 3.4L12 9.8 9.4 6.4z"/>',
    amulet:   '<path d="M6 3c0 6 3 8 6 8s6-2 6-8"/><path d="m12 11 3.5 4-3.5 6-3.5-6z"/>',
    gem:      '<path d="m12 3 6 5-6 13L6 8z"/><path d="M6 8h12M12 3 9 8l3 13M12 3l3 5-3 13"/>',
    potion:   '<path d="M10 3h4v5l3.4 6.2A5 5 0 0 1 13 21h-2a5 5 0 0 1-4.4-6.8L10 8z"/><path d="M9 3h6M7.4 14.5h9.2"/>',
    scroll:   '<path d="M6 4h12v14a3 3 0 0 1-3 3H6a3 3 0 0 0 3-3z"/><circle cx="18" cy="4" r="2.4"/><path d="M9 9h6M9 13h6"/>',
    tome:     '<path d="M4 4h11a3 3 0 0 1 3 3v14H7a3 3 0 0 1-3-3z"/><path d="M4 18a3 3 0 0 1 3-3h11"/><path d="M9 8h6"/>',
    coin:     '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'
  };
  const ICON_KEYS = Object.keys(ICONS);

  /* ------------------------------------------------------------------ store */
  function read(kind) {
    const v = Store.get(KEYS[kind], null);
    return Array.isArray(v) ? v : [];
  }
  function write(kind, rows) { Store.set(KEYS[kind], rows); return rows; }

  /**
   * Has this table ever been written? Different from "is it empty": a table
   * you have deliberately emptied still exists, and the seed leaves it alone.
   * Deleting the last monster should not conjure fourteen back on reload.
   */
  function exists(kind) { return Store.get(KEYS[kind], null) !== null; }

  function config() {
    const c = Store.get(KEYS.config, null) || {};
    const scale = {};
    RARITY_ORDER.forEach(r => { scale[r] = Object.assign({}, DEFAULT_SCALE[r], (c.scale || {})[r]); });
    return { scale };
  }
  function saveConfig(c) { Store.set(KEYS.config, c); return c; }

  /* ------------------------------------------------------------- scaling */
  function scaleOf(rarity) {
    const c = config();
    return c.scale[rarity] || c.scale.common;
  }

  /**
   * Authored base numbers -> the numbers the game uses. Never written back:
   * change a multiplier and every monster of that rarity changes with it.
   */
  function effective(m) {
    const s = scaleOf(m.rarity);
    return {
      hp:      Math.max(1, Math.round((+m.baseHp || 1) * s.hp)),
      atkMin:  Math.max(1, Math.round((+m.attackMin || 1) * s.dmg)),
      atkMax:  Math.max(1, Math.round((+m.attackMax || 1) * s.dmg)),
      armor:   Math.max(0, Math.round((+m.armor || 0) * s.armor)),
      exp:     Math.max(0, Math.round((+m.expReward || 0) * s.exp)),
      gold:    Math.max(0, Math.round((+m.goldReward || 0) * s.exp)),
      lootRolls: s.lootRolls,
      lootTilt:  s.lootTilt,
      scale: s
    };
  }

  /* --------------------------------------------------------------- helpers */
  function iconSvg(iconKey, size, color) {
    const body = ICONS[iconKey] || ICONS.gem;
    return '<svg class="gicon" viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) +
      '" fill="none" stroke="' + (color || "currentColor") +
      '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body + "</svg>";
  }

  /** Icon markup for anything the game shows in a list: authored or procedural. */
  function itemIconHtml(item, size) {
    if (item && item.iconKey && ICONS[item.iconKey]) {
      return iconSvg(item.iconKey, size, rarityColor(item.rarity));
    }
    return '<span class="emojiIcon">' + (item && item.icon ? item.icon : "•") + "</span>";
  }

  function rarityColor(r) { return (RARITY[r] || RARITY.common).color; }
  function rarityName(r)  { return (RARITY[r] || RARITY.common).name; }

  function slotDef(key) { return GEAR_SLOTS.find(s => s.key === key) || GEAR_SLOTS[0]; }

  function newId(prefix) { return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8); }

  /* ------------------------------------------------------------------ CRUD */
  function list(kind) { return read(kind); }
  function get(kind, id) {
    const idKey = ID_KEY[kind];
    return read(kind).find(r => r[idKey] === id) || null;
  }
  function save(kind, row) {
    const idKey = ID_KEY[kind];
    const rows = read(kind);
    if (!row[idKey]) row[idKey] = newId(ID_PREFIX[kind]);
    const i = rows.findIndex(r => r[idKey] === row[idKey]);
    row.updatedAt = Date.now();
    if (i >= 0) rows[i] = row; else { row.createdAt = Date.now(); rows.push(row); }
    write(kind, rows);
    return row;
  }
  function remove(kind, id) {
    write(kind, read(kind).filter(r => r[ID_KEY[kind]] !== id));
  }
  function replaceAll(kind, rows) { return write(kind, rows || []); }

  /* ------------------------------------------------------------- blank rows */
  function blankMonster() {
    return {
      monsterId: "", name: "", icon: "👹", type: "beast", rarity: "common", isBoss: false,
      levelMin: 1, levelMax: 3,
      baseHp: 30, armor: 3,
      attackName: "Strike", attackMin: 4, attackMax: 8, damageType: "physical",
      expReward: 80, goldReward: 20,
      lootTableId: ""
    };
  }
  function blankLootTable() {
    return { lootTableId: "", name: "", loot: [], chances: [], dropsMin: 0, dropsMax: 2 };
  }
  function blankItem() {
    return {
      itemId: "", name: "", gearType: "sword", iconKey: "sword", rarity: "common",
      damageType: "slashing", damageMin: 3, damageMax: 6,
      armor: 0, resistance: 0,
      restoreHp: 0, restoreMana: 0, restoreStamina: 0,
      itemLevel: 1, value: 20, description: ""
    };
  }

  function blankSpawnTable() {
    return { spawnTableId: "", name: "", monsters: [], weights: [], packMin: 1, packMax: 2 };
  }

  function blankLocation(lat, lng, zoneId) {
    return {
      locationId: "", name: "", zoneId: zoneId || "",
      latitude: lat || 0, longitude: lng || 0,
      radius: 35,                       // metres you must be within to trigger it
      kind: "combat",                   // combat | boss | treasure | landmark
      buildingType: "cottage",
      difficulty: 3,
      spawnTableId: "",                 // monsters here, if any
      chestTier: "", chestLootTableId: "",   // a chest here, if any
      active: true,
      timeStart: "", timeEnd: "",       // "09:00"–"17:00"; blank = always open
      days: [],                         // 0=Sun … 6=Sat; empty = every day
      respawnMinutes: 0,                // 0 = once cleared, stays cleared
      /* Art. A location can carry a PNG that sits on the map underneath its
         pin. `image` is either a path relative to the page (art/well.png) or a
         data: URL from a file you dropped in. It is sized in metres, not
         pixels, so it stays the same size on the ground however far you zoom,
         which is the only way it can line up with a real building. */
      image: "",
      imageMeters: 24,                  // width on the ground; height follows the file
      imageRotation: 0,                 // degrees clockwise, to square it to a building
      imageOpacity: 1,
      notes: ""
    };
  }

  /**
   * Where a location's art sits on the map, in real coordinates. Returns null
   * when there is no art, so every caller is one `if` away from drawing it.
   * Aspect is the file's own, handed in once it has loaded; until then a
   * square is a decent guess.
   */
  function locationImageBounds(loc, aspect) {
    if (!loc || !loc.image) return null;
    const w = Math.max(1, +loc.imageMeters || 24);
    const h = w / (aspect && isFinite(aspect) && aspect > 0 ? aspect : 1);
    const half = { lat: h / 2, lng: w / 2 };
    const a = projectPoint(loc.latitude, loc.longitude, half.lat, 0);      // north
    const b = projectPoint(loc.latitude, loc.longitude, half.lat, 180);    // south
    const e = projectPoint(loc.latitude, loc.longitude, half.lng, 90);     // east
    const wp = projectPoint(loc.latitude, loc.longitude, half.lng, 270);   // west
    return [[b.latitude, wp.longitude], [a.latitude, e.longitude]];
  }

  /** Is this a path we can serve, or a data: URL someone pasted in? */
  function imageIsInline(src) { return /^data:/i.test(src || ""); }

  function blankFloor(level) {
    return {
      level: level || 1,
      name: "",
      lengthMeters: 220,          // how far you walk to reach the stairs down
      encounters: 3,              // fights spread along that walk
      spawnTableId: "",
      chests: 1,
      chestTier: "wooden", chestLootTableId: "",
      hasBoss: false, bossSpawnTableId: "",
      difficulty: 3,
      experience: 0, gold: 0      // paid on clearing the floor; 0 = derive it
    };
  }

  function blankDungeon(lat, lng, zoneId) {
    return {
      dungeonId: "", name: "", zoneId: zoneId || "",
      kind: "dungeon",
      shape: "circle",
      latitude: lat || 0, longitude: lng || 0,   // centre, for both shapes
      radius: 40,                                // circle
      width: 80, height: 60,                     // rect, in metres (E-W, N-S)
      entryRange: 25,             // how close to the footprint the door opens
      minLevel: 1,
      floors: [blankFloor(1)],
      active: true,
      timeStart: "", timeEnd: "",
      days: [],
      respawnMinutes: 240,        // before it can be run again; 0 = once only
      notes: ""
    };
  }

  /* ------------------------------------------------------------ dungeon shape
     Circles are a centre and a radius. Rectangles are axis-aligned and sized
     in metres, so the maths below converts a lat/lng offset into metres
     rather than working in degrees — a degree of longitude is a different
     distance at every latitude, and treating it as constant puts the east
     edge of a box in the wrong place. */
  function dungeonHalf(d) {
    return { w: Math.max(1, +d.width || 1) / 2, h: Math.max(1, +d.height || 1) / 2 };
  }
  /** Signed metres east and north from the dungeon's centre to a point. */
  function offsetMeters(d, lat, lng) {
    const north = haversine(d.latitude, d.longitude, lat, d.longitude) * (lat >= d.latitude ? 1 : -1);
    const east  = haversine(d.latitude, d.longitude, d.latitude, lng) * (lng >= d.longitude ? 1 : -1);
    return { east, north };
  }
  /** Metres from a point to the dungeon's edge; 0 when the point is inside. */
  function distanceToDungeon(d, lat, lng) {
    if (!d) return Infinity;
    if (d.shape === "rect") {
      const o = offsetMeters(d, lat, lng), half = dungeonHalf(d);
      const dx = Math.max(0, Math.abs(o.east) - half.w);
      const dy = Math.max(0, Math.abs(o.north) - half.h);
      return Math.sqrt(dx * dx + dy * dy);
    }
    return Math.max(0, haversine(d.latitude, d.longitude, lat, lng) - (+d.radius || 0));
  }
  function dungeonContains(d, lat, lng) { return distanceToDungeon(d, lat, lng) <= 0; }

  /** Corner coordinates of a rectangular dungeon, for drawing it. */
  function dungeonCorners(d) {
    const half = dungeonHalf(d);
    const n = projectPoint(d.latitude, d.longitude, half.h, 0);
    const s = projectPoint(d.latitude, d.longitude, half.h, 180);
    const e = projectPoint(d.latitude, d.longitude, half.w, 90);
    const w = projectPoint(d.latitude, d.longitude, half.w, 270);
    return [[s.latitude, w.longitude], [n.latitude, e.longitude]];
  }

  function dungeonsFor(zoneId) {
    return read("dungeons").filter(d => !d.zoneId || d.zoneId === zoneId);
  }
  function dungeonKind(key) { return DUNGEON_KINDS[key] || DUNGEON_KINDS.dungeon; }
  function floorName(dungeon, floor, i) {
    if (floor && floor.name) return floor.name;
    return dungeonKind(dungeon && dungeon.kind).floor + " " + ((floor && floor.level) || i + 1);
  }

  /* ------------------------------------------------------------ floor plans
     A floor is a distance, not a place. planFloor turns "220 m, 3 fights, 1
     chest, a boss" into an ordered list of stops at particular distances, so
     walking is what advances you. Fights and chests are spread over the first
     four fifths; the boss waits just before the stairs, which are always the
     last stop and always exactly at the floor's length. */
  function planFloor(d, index, seed) {
    const dungeon = d;
    const f = (dungeon.floors || [])[index];
    if (!f) return [];
    const len = Math.max(20, +f.lengthMeters || 200);
    const rnd = seededRandom("dungeon:" + (seed || d.dungeonId || "1") + ":" + index);
    const fights = Math.max(0, Math.floor(+f.encounters || 0));
    const chests = Math.max(0, Math.floor(+f.chests || 0));
    const spread = [];

    const place = (kind, n, from, to) => {
      for (let i = 0; i < n; i++) {
        // Evenly spaced, then jittered inside its own slot so two runs of the
        // same floor don't feel identical but the pacing still holds.
        const slot = (to - from) / n;
        const at = from + slot * (i + 0.5) + (rnd() - 0.5) * slot * 0.6;
        spread.push({ kind: kind, at: Math.round(at) });
      }
    };
    place("fight", fights, len * 0.10, len * 0.80);
    place("chest", chests, len * 0.20, len * 0.85);
    spread.sort((a, b) => a.at - b.at);
    if (f.hasBoss) spread.push({ kind: "boss", at: Math.round(len * 0.92) });
    spread.push({ kind: "stairs", at: len });

    return spread.map((s, i) => Object.assign({ index: i, done: false }, s, {
      spawnTableId: s.kind === "boss" ? (f.bossSpawnTableId || f.spawnTableId) : f.spawnTableId,
      lootTableId:  s.kind === "chest" ? f.chestLootTableId : "",
      chestTier:    s.kind === "chest" ? (f.chestTier || "wooden") : ""
    }));
  }

  /** Total walking distance a dungeon asks for, across every floor. */
  function dungeonLength(d) {
    return (d.floors || []).reduce((a, f) => a + Math.max(20, +f.lengthMeters || 200), 0);
  }

  /** What a floor pays out. Authored numbers win; blank ones are derived. */
  function floorRewards(dungeon, index) {
    const f = (dungeon.floors || [])[index];
    if (!f) return { experience: 0, gold: 0 };
    const d = clamp(+f.difficulty || 1, 1, 10);
    const depth = 1 + index * 0.35;
    return {
      experience: +f.experience || Math.round((90 + d * 60) * depth),
      gold:       +f.gold       || Math.round((22 + d * 18) * depth)
    };
  }

  /* ========================================================================
     INSTANCES

     A dungeon is a walk measured in metres. An instance is a *place*: a door on
     the real map, and behind it a floor with its own XY plane, in metres that
     owe nothing to GPS. Inside, you steer with a dial and walk in the real
     world to go forward. Walls stop you, so which way you are pointing is the
     whole game.


     A level is ONE OPEN RECTANGLE, plus a list of solid rectangles carved out
     of it. That is the whole geometry. Nothing is generated: the floor is
     exactly the width and height you type, and every wall inside it is one
     you drew. A brush or line tool only ever has to push rectangles into
     `walls` — no room graph, no corridor solver, nothing to fight with.

     Collision is therefore: inside the floor, and inside no wall. Cheap on
     every step, and obvious when something walks where it should not.

     What you have explored is tracked on a coarse grid rather than per room,
     because with an open floor there are no rooms to light up. Cells you have
     had line of sight to stay lit; the rest are dark.
     ======================================================================== */
  const INSTANCE_KINDS = {
    dungeon: { label: "dungeon",   icon: "🏰", color: "#8f6fd0", level: "Level" },
    cave:    { label: "cave",      icon: "🕳️", color: "#7a8a9a", level: "Depth" },
    crypt:   { label: "crypt",     icon: "⚰️", color: "#9a8fb0", level: "Vault" },
    ruin:    { label: "ruin",      icon: "🏛️", color: "#b0a07a", level: "Tier" },
    mine:    { label: "mine",      icon: "⛏️", color: "#c2603f", level: "Level" },
    tower:   { label: "tower",     icon: "🗼", color: "#5f8fd0", level: "Storey" },
    warren:  { label: "warren",    icon: "🐾", color: "#c98a3a", level: "Warren" },
    vault:   { label: "vault",     icon: "🔐", color: "#5fae8f", level: "Floor" }
  };

  const FOG_CELL = 3.5;           // metres; the resolution of "explored"
  const WALL_T   = 1.2;           // default thickness for a drawn line, metres

  function blankInstanceLevel(level) {
    return {
      level: level || 1,
      name: "",
      width: 64, height: 44,      // the floor, in metres — one plain rectangle
      walls: [],                  // [{x,y,w,h}] carved out of it; drawn, not generated
      difficulty: 3,
      monsters: 3,
      spawnTableId: "",
      chests: 1,
      chestTier: "wooden", chestLootTableId: "",
      hasBoss: false, bossSpawnTableId: "",
      experience: 0, gold: 0      // paid on clearing the level; 0 = derive it
    };
  }

  function blankInstance(lat, lng, zoneId) {
    return {
      instanceId: "", name: "", zoneId: zoneId || "",
      kind: "dungeon",
      latitude: lat || 0, longitude: lng || 0,
      radius: 30,                 // how close you must be to the door
      minLevel: 1,
      pace: 1,                    // metres inside bought by one metre walked
      levels: [blankInstanceLevel(1)],
      active: true,
      timeStart: "", timeEnd: "",
      days: [],
      respawnMinutes: 240,
      notes: ""
    };
  }

  function instancesFor(zoneId) {
    return read("instances").filter(d => !d.zoneId || d.zoneId === zoneId);
  }
  function instanceKind(key) { return INSTANCE_KINDS[key] || INSTANCE_KINDS.dungeon; }
  function levelName(inst, lvl, i) {
    if (lvl && lvl.name) return lvl.name;
    return instanceKind(inst && inst.kind).level + " " + ((lvl && lvl.level) || i + 1);
  }

  /* ---------------------------------------------------------- floor build */

  function inRect(r, x, y, pad) {
    pad = pad || 0;
    return x >= r.x + pad && x <= r.x + r.w - pad && y >= r.y + pad && y <= r.y + r.h - pad;
  }

  /** Normalise a drawn rectangle: positive extents, numbers, nothing degenerate. */
  function normRect(w) {
    if (!w) return null;
    let x = +w.x || 0, y = +w.y || 0, ww = +w.w || 0, hh = +w.h || 0;
    if (ww < 0) { x += ww; ww = -ww; }
    if (hh < 0) { y += hh; hh = -hh; }
    if (ww <= 0 || hh <= 0) return null;
    return { x, y, w: ww, h: hh };
  }

  /**
   * A drawn line becomes a rectangle. The line tool hands us two points and a
   * thickness; anything that is not axis-aligned is squared off to whichever
   * axis it is closest to, because the whole geometry is axis-aligned and a
   * diagonal wall would need a different collision test.
   */
  function wallFromLine(x1, y1, x2, y2, thickness) {
    const t = Math.max(0.2, +thickness || WALL_T);
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    if (dx >= dy) {
      return normRect({ x: Math.min(x1, x2), y: (y1 + y2) / 2 - t / 2, w: Math.max(dx, t), h: t });
    }
    return normRect({ x: (x1 + x2) / 2 - t / 2, y: Math.min(y1, y2), w: t, h: Math.max(dy, t) });
  }

  /**
   * Build one level. No generation: the floor is the rectangle you typed and
   * the walls are the ones you drew. Only the contents — where the monsters
   * and chests stand — are rolled, from the level's seed, so the same instance
   * lays out the same way twice.
   */
  function buildInstanceLevel(inst, index, seed) {
    const lvl = (inst.levels || [])[index];
    if (!lvl) return null;
    const rnd = seededRandom("inst:" + (seed || inst.instanceId || "1") + ":" + index);

    const W = clamp(+lvl.width  || 64, 8, 500);
    const H = clamp(+lvl.height || 44, 8, 500);
    const floors = [{ x: 0, y: 0, w: W, h: H }];
    const walls = (lvl.walls || []).map(normRect).filter(Boolean);

    const plan = {
      floors, walls,
      width: W, height: H,
      minX: -4, minY: -4, maxX: W + 4, maxY: H + 4,
      difficulty: clamp(+lvl.difficulty || 3, 1, 10),
      spawnTableId: lvl.spawnTableId || "",
      bossSpawnTableId: lvl.bossSpawnTableId || lvl.spawnTableId || "",
      chestTier: lvl.chestTier || "wooden",
      chestLootTableId: lvl.chestLootTableId || "",
      // Kept so anything still asking for rooms gets a sane answer: the floor
      // is one room. There is no room graph any more.
      rooms: [], edges: [], halls: [], startId: "r0", stairsId: "r0"
    };

    // Door on the west edge, stairs on the east, both nudged to real floor in
    // case a wall has been drawn across where they would otherwise land.
    plan.start  = nearestFloor(plan, Math.min(5, W * 0.12), H / 2);
    plan.stairs = nearestFloor(plan, W - Math.min(5, W * 0.12), H / 2);
    plan.rooms = [{
      id: "r0", kind: "floor", seen: true,
      cx: W / 2, cy: H / 2, rect: floors[0]
    }];

    buildFog(plan);

    /* ---- contents ---- */
    const spots = floorSpots(plan, rnd);
    const away = (p, list, min) => list.every(q => Math.hypot(q.x - p.x, q.y - p.y) >= min);
    const taken = [plan.start, plan.stairs];
    const draw = (min) => {
      for (let i = 0; i < spots.length; i++) {
        if (!away(spots[i], taken, min)) continue;
        const p = spots.splice(i, 1)[0];
        taken.push(p);
        return p;
      }
      return null;
    };

    const entities = [];
    let eid = 0;
    if (lvl.hasBoss) {
      // The boss stands between you and the stairs, so you cannot just stroll past.
      const p = nearestFloor(plan, (plan.stairs.x + plan.start.x * 0.25) / 1.25, plan.stairs.y);
      entities.push({ id: "e" + (eid++), kind: "boss", x: p.x, y: p.y, hp: 1,
                      spawnTableId: plan.bossSpawnTableId, facing: rnd() * 360 });
      taken.push(p);
    }
    const nMon = Math.max(0, Math.round(+lvl.monsters || 0));
    for (let i = 0; i < nMon; i++) {
      const p = draw(7);
      if (!p) break;
      entities.push({ id: "e" + (eid++), kind: "monster", x: p.x, y: p.y,
                      spawnTableId: plan.spawnTableId, facing: rnd() * 360 });
    }
    const nChest = Math.max(0, Math.round(+lvl.chests || 0));
    for (let i = 0; i < nChest; i++) {
      const p = draw(6);
      if (!p) break;
      entities.push({ id: "e" + (eid++), kind: "chest", x: p.x, y: p.y,
                      chestTier: plan.chestTier, lootTableId: plan.chestLootTableId });
    }
    plan.entities = entities;
    return plan;
  }

  /** Candidate standing spots: floor grid points, shuffled, walls excluded. */
  function floorSpots(plan, rnd) {
    const step = 4, out = [];
    for (let y = plan.minY + step; y < plan.maxY; y += step)
      for (let x = plan.minX + step; x < plan.maxX; x += step)
        if (walkable(plan, x, y)) out.push({ x, y });
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /** Push a point onto real floor — used for the door, the stairs, the boss. */
  function nearestFloor(plan, x, y) {
    if (walkable(plan, x, y)) return { x, y };
    for (let r = 1; r <= 60; r++) {
      for (let a = 0; a < 16; a++) {
        const th = a / 16 * Math.PI * 2;
        const px = x + Math.cos(th) * r, py = y + Math.sin(th) * r;
        if (walkable(plan, px, py)) return { x: px, y: py };
      }
    }
    return { x, y };
  }

  /* ----------------------------------------------------------- geometry */

  /**
   * Is this point inside the walkable floor? Inside the floor, outside every
   * wall. That is all of it.
   *
   * Note there is no padding, deliberately. The floor is a *union* of
   * rectangles, and insetting each separately leaves a seam at every gap that
   * belongs to neither — an invisible barrier across the one doorway you are
   * trying to walk through. Bodies are kept off the walls by drawing the token
   * small, not by shrinking the floor.
   */
  function walkable(plan, x, y) {
    if (!plan) return false;
    if (plan.floors) {
      let inside = false;
      for (let i = 0; i < plan.floors.length; i++) {
        if (inRect(plan.floors[i], x, y)) { inside = true; break; }
      }
      if (!inside) return false;
      const w = plan.walls || [];
      for (let i = 0; i < w.length; i++) if (inRect(w[i], x, y)) return false;
      return true;
    }
    // A run saved under the old room-and-corridor plan still walks.
    for (let i = 0; i < (plan.rooms || []).length; i++) if (inRect(plan.rooms[i].rect, x, y)) return true;
    for (let i = 0; i < (plan.halls || []).length; i++) if (inRect(plan.halls[i], x, y)) return true;
    return false;
  }

  /* ------------------------------------------------------------------ fog
     What you have seen, on a grid. Every cell that is floor starts dark and
     lights up the first time you have line of sight to it. This replaces the
     old per-room reveal, which had nothing to hang on once a level became one
     open rectangle. */

  function buildFog(plan) {
    const cols = Math.max(1, Math.ceil((plan.maxX - plan.minX) / FOG_CELL));
    const rows = Math.max(1, Math.ceil((plan.maxY - plan.minY) / FOG_CELL));
    const seen = new Array(cols * rows).fill(0);
    let floorCells = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = fogCentre(plan, cols, c, r);
        if (walkable(plan, p.x, p.y)) { seen[r * cols + c] = 0; floorCells++; }
        else seen[r * cols + c] = 2;      // 2 = not floor, never lights up
      }
    }
    plan.fog = { cell: FOG_CELL, cols, rows, seen, floorCells, lit: 0 };
    return plan.fog;
  }

  function fogCentre(plan, cols, c, r) {
    return { x: plan.minX + (c + 0.5) * FOG_CELL, y: plan.minY + (r + 0.5) * FOG_CELL };
  }

  /** Light every floor cell within `radius` that can be seen from x,y. */
  function markSeen(plan, x, y, radius) {
    const f = plan && plan.fog;
    if (!f) return 0;
    const c0 = Math.max(0, Math.floor((x - radius - plan.minX) / f.cell));
    const c1 = Math.min(f.cols - 1, Math.ceil((x + radius - plan.minX) / f.cell));
    const r0 = Math.max(0, Math.floor((y - radius - plan.minY) / f.cell));
    const r1 = Math.min(f.rows - 1, Math.ceil((y + radius - plan.minY) / f.cell));
    let lit = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * f.cols + c;
        if (f.seen[i] !== 0) continue;
        const p = fogCentre(plan, f.cols, c, r);
        if (Math.hypot(p.x - x, p.y - y) > radius) continue;
        if (!lineOfSight(plan, x, y, p.x, p.y)) continue;
        f.seen[i] = 1; lit++;
      }
    }
    f.lit += lit;
    return lit;
  }

  function isSeen(plan, x, y) {
    const f = plan && plan.fog;
    if (!f) return true;
    const c = Math.floor((x - plan.minX) / f.cell), r = Math.floor((y - plan.minY) / f.cell);
    if (c < 0 || r < 0 || c >= f.cols || r >= f.rows) return false;
    return f.seen[r * f.cols + c] === 1;
  }

  /** 0..1, how much of the floor you have laid eyes on. */
  function exploredFraction(plan) {
    const f = plan && plan.fog;
    if (!f || !f.floorCells) return 1;
    return clamp(f.lit / f.floorCells, 0, 1);
  }

  /** Unlit floor cells, merged into runs across each row so the fog overlay
      is a handful of rectangles rather than one per cell. */
  function fogRects(plan) {
    const f = plan && plan.fog;
    if (!f) return [];
    const out = [];
    for (let r = 0; r < f.rows; r++) {
      let run = -1;
      for (let c = 0; c <= f.cols; c++) {
        const dark = c < f.cols && f.seen[r * f.cols + c] !== 1;
        if (dark && run < 0) run = c;
        if (!dark && run >= 0) {
          out.push({ x: plan.minX + run * f.cell, y: plan.minY + r * f.cell,
                     w: (c - run) * f.cell, h: f.cell });
          run = -1;
        }
      }
    }
    return out;
  }

  /* Kept for compatibility with anything that still speaks rooms. The floor is
     one room, so these are all trivially true. */
  function roomAt(plan, x, y) { return walkable(plan, x, y) ? (plan.rooms || [])[0] || null : null; }
  function instanceRoom(plan, id) { return (plan.rooms || []).find(r => r.id === id) || null; }
  function instanceNeighbours() { return []; }
  function instanceRoute(plan, fromId, toId) { return fromId === toId ? [fromId] : [fromId, toId]; }

  /**
   * Can A see B? A straight line with nothing but floor along it. Sampled
   * rather than solved: the rectangles are axis-aligned and half a metre apart
   * is finer than any wall you can draw, so nothing slips through.
   */
  function lineOfSight(plan, ax, ay, bx, by, maxDist) {
    const d = Math.hypot(bx - ax, by - ay);
    if (maxDist != null && d > maxDist) return false;
    const steps = Math.max(2, Math.ceil(d * 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!walkable(plan, ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
    }
    return true;
  }

  /**
   * Walk from a point along a heading, stopping at walls. Tries the full step,
   * then each axis on its own — which is what lets you slide along a wall
   * instead of sticking to it, the single thing that makes steering bearable.
   */
  function stepThrough(plan, x, y, headingDeg, dist) {
    const rad = headingDeg * Math.PI / 180;
    const dx = Math.sin(rad) * dist, dy = -Math.cos(rad) * dist;
    if (walkable(plan, x + dx, y + dy)) return { x: x + dx, y: y + dy, hit: false };
    if (walkable(plan, x + dx, y)) return { x: x + dx, y: y, hit: true };
    if (walkable(plan, x, y + dy)) return { x: x, y: y + dy, hit: true };
    return { x: x, y: y, hit: true };
  }

  /** What a level pays out. Authored numbers win; blank ones are derived. */
  function instanceLevelRewards(inst, index) {
    const lvl = (inst.levels || [])[index];
    if (!lvl) return { experience: 0, gold: 0 };
    const d = clamp(+lvl.difficulty || 1, 1, 10);
    const depth = 1 + index * 0.35;
    return {
      experience: +lvl.experience || Math.round((90 + d * 60) * depth),
      gold:       +lvl.gold       || Math.round((22 + d * 18) * depth)
    };
  }

  /** A plain overview of a level, for the editor. No fog, nothing moving. */
  function instancePreviewSvg(plan) {
    if (!plan) return "";
    const w = plan.maxX - plan.minX, h = plan.maxY - plan.minY;
    const rect = (cls, r) => '<rect class="' + cls + '" x="' + r.x + '" y="' + r.y +
      '" width="' + r.w + '" height="' + r.h + '"/>';
    const floor = (plan.floors || []).map(r => rect("pr floor", r)).join("");
    const walls = (plan.walls || []).map(r => rect("pw", r)).join("");
    const ents = (plan.entities || []).map(e => {
      const ic = e.kind === "boss" ? "👑" : e.kind === "chest" ? "🧰" : "👹";
      return '<text x="' + e.x + '" y="' + (e.y + 3) + '" font-size="7">' + ic + "</text>";
    }).join("");
    const marks =
      (plan.start  ? '<text x="' + plan.start.x  + '" y="' + (plan.start.y + 3)  + '" font-size="8">🚪</text>' : "") +
      (plan.stairs ? '<text x="' + plan.stairs.x + '" y="' + (plan.stairs.y + 3) + '" font-size="8">🪜</text>' : "");
    return '<svg class="instPrev" viewBox="' + plan.minX + " " + plan.minY + " " + w + " " + h +
      '" preserveAspectRatio="xMidYMid meet">' + floor + walls + ents + marks + "</svg>";
  }

  /** Consumables carry their restore amounts as three plain fields. */
  function restoreOf(def) {
    const r = {};
    if (+def.restoreHp)      r.hp = +def.restoreHp;
    if (+def.restoreMana)    r.mana = +def.restoreMana;
    if (+def.restoreStamina) r.stamina = +def.restoreStamina;
    return Object.keys(r).length ? r : null;
  }

  /* --------------------------------------------------------- loot resolution
     Percentages are exactly what you typed: each entry is rolled on its own,
     nothing is normalised. dropsMin / dropsMax then clamp the result — a
     surplus is trimmed at random, a shortfall is topped up by drawing from
     the remaining entries weighted by their own chance. */
  function rollLoot(tableId, opts) {
    opts = opts || {};
    const t = get("loot", tableId);
    if (!t || !t.loot || !t.loot.length) return [];
    const luckBonus = (opts.luck || 0) * 0.35;   // percentage points, not a multiplier
    const won = [], lost = [];

    t.loot.forEach((itemId, i) => {
      const pct = Number(t.chances[i]) || 0;
      if (Math.random() * 100 < pct + luckBonus) won.push({ itemId, pct });
      else lost.push({ itemId, pct });
    });

    const min = Math.max(0, Number(t.dropsMin) || 0);
    const max = Math.max(min, Number(t.dropsMax) != null ? Number(t.dropsMax) : min);

    while (won.length > max) won.splice(Math.floor(Math.random() * won.length), 1);
    while (won.length < min && lost.length) {
      const total = lost.reduce((s, e) => s + Math.max(0.0001, e.pct), 0);
      let r = Math.random() * total, k = 0;
      for (; k < lost.length; k++) { r -= Math.max(0.0001, lost[k].pct); if (r <= 0) break; }
      won.push(lost.splice(Math.min(k, lost.length - 1), 1)[0]);
    }
    return won.map(w => w.itemId);
  }

  /* ------------------------------------------- authored row -> game instance */
  function toGameItem(def, level) {
    if (typeof def === "string") def = get("items", def);
    if (!def) return null;
    const slot = slotDef(def.gearType);
    const dmgMin = +def.damageMin || 0, dmgMax = +def.damageMax || 0;
    const stats = {};
    if (slot.gameType === "weapon") stats.damage = Math.max(1, Math.round((dmgMin + dmgMax) / 2));
    if (+def.armor) stats.defense = +def.armor;
    if (+def.resistance) stats.resistance = +def.resistance;

    const restore = restoreOf(def);
    const parts = [];
    if (stats.damage) parts.push(dmgMin + "–" + dmgMax + " " + def.damageType);
    if (stats.defense) parts.push("+" + stats.defense + " DEF");
    if (stats.resistance) parts.push("+" + stats.resistance + " RES");
    if (restore) for (const k in restore) parts.push("+" + restore[k] + " " + k.toUpperCase());

    return {
      itemId: newId("inst"), defId: def.itemId, name: def.name,
      type: slot.gameType === "consumable" || slot.gameType === "quest" ? "potion" : slot.gameType,
      gearType: def.gearType, iconKey: def.iconKey, icon: null,
      rarity: def.rarity, level: +def.itemLevel || level || 1,
      damageType: def.damageType, dmgMin, dmgMax,
      stats, restore,
      effect: parts.join("  ") || (def.description ? "" : "No bonuses"),
      description: def.description || "",
      price: +def.value || 10, quantity: 1, authored: true
    };
  }

  /**
   * Turn an authored monster into the enemy shape the combat engine expects.
   * Level is drawn from the authored range, nudged by how hard the node is.
   */
  function toEnemy(def, nodeDifficulty, playerLevel) {
    const eff = effective(def);
    const lo = Math.min(+def.levelMin || 1, +def.levelMax || 1);
    const hi = Math.max(+def.levelMin || 1, +def.levelMax || 1);
    const want = Math.round(((nodeDifficulty || 1) * 0.85 + (playerLevel || 1) * 0.28));
    const level = Math.max(lo, Math.min(hi, want || lo));
    // Authored numbers describe the monster at the BOTTOM of its level band.
    // It then gains 15% per level above that, so a level-20 specimen of a
    // 12–20 monster is roughly twice the level-12 one.
    const growth = 1 + Math.max(0, level - lo) * 0.15;

    const hp = Math.max(1, Math.round(eff.hp * growth));
    const atkMin = Math.max(1, Math.round(eff.atkMin * growth));
    const atkMax = Math.max(atkMin, Math.round(eff.atkMax * growth));
    const magic = MAGIC_DAMAGE.indexOf(def.damageType) >= 0;

    return {
      enemyId: newId("enm"), defId: def.monsterId,
      name: def.name, icon: def.icon || "👹",
      level, boss: !!def.isBoss, authored: true,
      monsterType: def.type, rarity: def.rarity,
      attackName: def.attackName || "Strike", damageType: def.damageType,
      hp, maxHp: hp, alive: true, tempEvasion: 0, slowed: 0,
      attributes: {
        strength: Math.round(atkMax * 0.9), dexterity: Math.round(6 + level * 1.1),
        constitution: Math.round(hp / 8), intelligence: magic ? Math.round(atkMax * 0.8) : 6,
        wisdom: Math.round(5 + level * 0.7), charisma: 8, luck: 8
      },
      // The engine reads atkMin/atkMax in preference to attackPower, so the
      // authored range is what actually lands, before mitigation.
      atkMin, atkMax,
      attackPower: (atkMin + atkMax) / 2,
      spellPower:  (atkMin + atkMax) / 2,
      armor: eff.armor,
      magicDefense: Math.round(eff.armor * 0.8 + level * 1.2),
      accuracy: 74 + level * 1.1,
      evasion: 4 + level * 0.9,
      critChance: 4 + (RARITY[def.rarity] || RARITY.common).order * 2,
      critResist: level * 0.5,
      caster: magic,
      lootTableId: def.lootTableId || "",
      lootRolls: eff.lootRolls,
      rewards: { experience: eff.exp, gold: eff.gold, items: [] }
    };
  }

  /** Authored monsters that fit this node, or [] to fall back to the built-ins. */
  function monstersFor(node, playerLevel) {
    const all = read("monsters").filter(m => m.name);
    if (!all.length) return [];
    const want = Math.round(((node.difficulty || 1) * 0.85 + (playerLevel || 1) * 0.28)) || 1;
    const boss = node.type === "boss";
    let pool = all.filter(m => !!m.isBoss === boss &&
      want >= (+m.levelMin || 1) - 1 && want <= (+m.levelMax || 99) + 1);
    if (!pool.length) pool = all.filter(m => !!m.isBoss === boss);
    if (!pool.length) pool = all;
    return pool;
  }

  /* ------------------------------------------------------------ spawn tables
     Weights are relative, not percentages: a monster on 30 against one on 10
     turns up three times as often. Unlike loot chances these *are* normalised,
     because picking one of a set is what a weight means. The editor shows the
     resulting probability next to each row so nothing is hidden. */
  function spawnOdds(table) {
    const w = (table.weights || []).map(x => Math.max(0, +x || 0));
    const total = w.reduce((a, b) => a + b, 0);
    return w.map(x => (total > 0 ? x / total : 0));
  }

  function pickWeighted(ids, weights) {
    const w = weights.map(x => Math.max(0, +x || 0));
    const total = w.reduce((a, b) => a + b, 0);
    if (total <= 0) return ids[Math.floor(Math.random() * ids.length)];
    let r = Math.random() * total;
    for (let i = 0; i < ids.length; i++) { r -= w[i]; if (r <= 0) return ids[i]; }
    return ids[ids.length - 1];
  }

  /** Build a pack of live enemies from a spawn table. */
  function rollSpawn(spawnTableId, difficulty, playerLevel) {
    const t = get("spawns", spawnTableId);
    if (!t || !t.monsters || !t.monsters.length) return [];
    const lo = Math.max(1, +t.packMin || 1);
    const hi = Math.max(lo, +t.packMax || lo);
    const n = lo + Math.floor(Math.random() * (hi - lo + 1));
    const pack = [];
    for (let i = 0; i < n; i++) {
      const def = get("monsters", pickWeighted(t.monsters, t.weights));
      if (def) pack.push(toEnemy(def, difficulty, playerLevel));
    }
    return pack;
  }

  /* --------------------------------------------------------------- locations */
  function locationsFor(zoneId) {
    return read("locations").filter(l => !l.zoneId || l.zoneId === zoneId);
  }

  /** "09:30" -> 570 minutes past midnight. Blank or malformed -> null. */
  function minutesOf(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  /**
   * Is this location open right now? A blank window means always; a window
   * whose end is before its start wraps past midnight (22:00–02:00).
   */
  function isLocationActive(loc, when) {
    if (!loc || loc.active === false) return false;
    const d = when instanceof Date ? when : new Date(when || Date.now());
    if (loc.days && loc.days.length && loc.days.indexOf(d.getDay()) < 0) return false;
    const start = minutesOf(loc.timeStart), end = minutesOf(loc.timeEnd);
    if (start == null || end == null || start === end) return true;
    const now = d.getHours() * 60 + d.getMinutes();
    return start < end ? (now >= start && now < end) : (now >= start || now < end);
  }

  /** When a cleared location comes back, or null if it never does. */
  function respawnAt(loc, clearedAt) {
    const mins = +loc.respawnMinutes || 0;
    if (!mins || !clearedAt) return null;
    return clearedAt + mins * 60000;
  }

  function chestTier(key) {
    return CHEST_TIERS.find(c => c.key === (key || "")) || CHEST_TIERS[0];
  }

  /**
   * Express a location in the shape the game's map and combat code already
   * understands, so authored sites travel the same path as procedural ones.
   * The nodeId is derived from the locationId, which is what lets an edit in
   * the map editor update a site in place instead of duplicating it.
   */
  function locationToNode(loc, zone) {
    const site = SITE_KINDS.find(k => k.key === loc.kind) || SITE_KINDS[0];
    const building = BUILDING_KINDS[loc.buildingType];
    const chest = chestTier(loc.chestTier);
    const dist = zone ? haversine(zone.centerLatitude, zone.centerLongitude, loc.latitude, loc.longitude) : 0;
    const d = clamp(+loc.difficulty || 1, 1, 10);
    return {
      nodeId: "nd_loc_" + loc.locationId,
      locationId: loc.locationId,
      zoneId: zone ? zone.zoneId : loc.zoneId,
      authored: true,
      type: loc.kind, difficulty: d,
      latitude: +loc.latitude, longitude: +loc.longitude,
      radius: +loc.radius || 35,
      name: loc.name || (building ? cap(building.label) : site.label),
      icon: loc.kind === "landmark" ? site.icon
          : loc.kind === "treasure" ? (chest.key ? "\ud83e\uddf0" : site.icon)
          : (building ? building.icon : site.icon),
      buildingType: loc.buildingType,
      spawnTableId: loc.spawnTableId || "",
      chestTier: loc.chestTier || "", chestLootTableId: loc.chestLootTableId || "",
      status: "undiscovered",
      enemies: [],
      rewards: {
        experience: Math.round((70 + d * 55) * (loc.kind === "boss" ? 2.4 : loc.kind === "treasure" ? 0.35 : 1)),
        gold: Math.round((18 + d * 16) * (loc.kind === "treasure" ? 2.2 : loc.kind === "boss" ? 2.6 : 1)),
        items: []
      },
      distanceFromHome: Math.round(dist),
      discoveredAt: null, clearedAt: null
    };
  }

  /* ------------------------------------------------------------ import/export */
  function exportAll() {
    return {
      format: "stride-and-sword.content",
      version: 1,
      exportedAt: new Date().toISOString(),
      config: config(),
      tables: { monsters: read("monsters"), loot: read("loot"), items: read("items"),
                spawns: read("spawns"), locations: read("locations"), dungeons: read("dungeons"),
                instances: read("instances") }
    };
  }
  function importAll(json, mode) {
    if (!json || !json.tables) return { success: false, message: "Not a content file." };
    ["monsters", "loot", "items", "spawns", "locations", "dungeons", "instances"].forEach(kind => {
      const incoming = json.tables[kind] || [];
      if (mode === "replace") { write(kind, incoming); return; }
      const idKey = ID_KEY[kind];
      const rows = read(kind);
      incoming.forEach(row => {
        const i = rows.findIndex(r => r[idKey] === row[idKey]);
        if (i >= 0) rows[i] = row; else rows.push(row);
      });
      write(kind, rows);
    });
    if (json.config) saveConfig(json.config);
    return { success: true,
             monsters: read("monsters").length, loot: read("loot").length, items: read("items").length,
             spawns: read("spawns").length, locations: read("locations").length,
             dungeons: read("dungeons").length, instances: read("instances").length };
  }

  function stats() {
    return { monsters: read("monsters").length, loot: read("loot").length, items: read("items").length,
             spawns: read("spawns").length, locations: read("locations").length,
             dungeons: read("dungeons").length, instances: read("instances").length };
  }
  function isEmpty() { const s = stats(); return !s.monsters && !s.loot && !s.items; }
  function clearAll() {
    ["monsters", "loot", "items", "spawns", "locations", "dungeons", "instances"].forEach(k => Store.remove(KEYS[k]));
  }

  return {
    KEYS, ID_KEY, RARITY, RARITY_ORDER, DEFAULT_SCALE, MONSTER_TYPES, DAMAGE_TYPES, MAGIC_DAMAGE,
    GEAR_SLOTS, ICONS, ICON_KEYS,
    config, saveConfig, scaleOf, effective,
    iconSvg, itemIconHtml, rarityColor, rarityName, slotDef, newId,
    list, get, save, remove, replaceAll,
    blankMonster, blankLootTable, blankItem, blankSpawnTable, blankLocation,
    blankDungeon, blankFloor,
    blankInstance, blankInstanceLevel, INSTANCE_KINDS,
    instancesFor, instanceKind, levelName, buildInstanceLevel, instanceLevelRewards,
    walkable, roomAt, instanceRoom, instanceNeighbours, instanceRoute,
    normRect, wallFromLine, nearestFloor,
    markSeen, isSeen, exploredFraction, fogRects, buildFog,
    lineOfSight, stepThrough, instancePreviewSvg,
    BUILDING_KINDS, SITE_KINDS, CHEST_TIERS, DAY_NAMES,
    DUNGEON_KINDS, DUNGEON_SHAPES, STOP_KINDS,
    dungeonsFor, dungeonKind, floorName, dungeonCorners, dungeonContains, distanceToDungeon,
    planFloor, dungeonLength, floorRewards,
    spawnOdds, pickWeighted, rollSpawn,
    locationsFor, isLocationActive, respawnAt, chestTier, locationToNode, minutesOf,
    locationImageBounds, imageIsInline,
    rollLoot, toGameItem, toEnemy, monstersFor,
    exportAll, importAll, stats, isEmpty, exists, clearAll
  };
})();

/* The seed data used to live here as a giant literal. It now lives in
   data/*.json and is loaded by js/core/db.js. Edit the JSON files. */
