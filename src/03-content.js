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
    monsters: "content_monsters",
    loot:     "content_loot",
    items:    "content_items",
    config:   "content_config"
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
    const idKey = kind === "monsters" ? "monsterId" : kind === "loot" ? "lootTableId" : "itemId";
    return read(kind).find(r => r[idKey] === id) || null;
  }
  function save(kind, row) {
    const idKey = kind === "monsters" ? "monsterId" : kind === "loot" ? "lootTableId" : "itemId";
    const rows = read(kind);
    if (!row[idKey]) row[idKey] = newId(kind === "monsters" ? "mon" : kind === "loot" ? "lt" : "itm");
    const i = rows.findIndex(r => r[idKey] === row[idKey]);
    row.updatedAt = Date.now();
    if (i >= 0) rows[i] = row; else { row.createdAt = Date.now(); rows.push(row); }
    write(kind, rows);
    return row;
  }
  function remove(kind, id) {
    const idKey = kind === "monsters" ? "monsterId" : kind === "loot" ? "lootTableId" : "itemId";
    write(kind, read(kind).filter(r => r[idKey] !== id));
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

  /* ------------------------------------------------------------ import/export */
  function exportAll() {
    return {
      format: "stride-and-sword.content",
      version: 1,
      exportedAt: new Date().toISOString(),
      config: config(),
      tables: { monsters: read("monsters"), loot: read("loot"), items: read("items") }
    };
  }
  function importAll(json, mode) {
    if (!json || !json.tables) return { success: false, message: "Not a content file." };
    ["monsters", "loot", "items"].forEach(kind => {
      const incoming = json.tables[kind] || [];
      if (mode === "replace") { write(kind, incoming); return; }
      const idKey = kind === "monsters" ? "monsterId" : kind === "loot" ? "lootTableId" : "itemId";
      const rows = read(kind);
      incoming.forEach(row => {
        const i = rows.findIndex(r => r[idKey] === row[idKey]);
        if (i >= 0) rows[i] = row; else rows.push(row);
      });
      write(kind, rows);
    });
    if (json.config) saveConfig(json.config);
    return { success: true,
             monsters: read("monsters").length, loot: read("loot").length, items: read("items").length };
  }

  function stats() {
    return { monsters: read("monsters").length, loot: read("loot").length, items: read("items").length };
  }
  function isEmpty() { const s = stats(); return !s.monsters && !s.loot && !s.items; }
  function clearAll() { ["monsters", "loot", "items"].forEach(k => Store.remove(KEYS[k])); }

  return {
    KEYS, RARITY, RARITY_ORDER, DEFAULT_SCALE, MONSTER_TYPES, DAMAGE_TYPES, MAGIC_DAMAGE,
    GEAR_SLOTS, ICONS, ICON_KEYS,
    config, saveConfig, scaleOf, effective,
    iconSvg, itemIconHtml, rarityColor, rarityName, slotDef, newId,
    list, get, save, remove, replaceAll,
    blankMonster, blankLootTable, blankItem,
    rollLoot, toGameItem, toEnemy, monstersFor,
    exportAll, importAll, stats, isEmpty, clearAll
  };
})();

/* ==========================================================================
   SEED — the game's original hardcoded content, expressed as editable rows.
   Installed once, on first run, only when all three tables are empty.
   Target numbers below are the *effective* values the game used to have;
   they are divided by the rarity multiplier so authoring a Rare monster and
   the old Rare monster come out at the same strength.
   ========================================================================== */
const ContentSeed = (function () {


  const ITEMS = [
    // key,            name,                   slot,      rarity,      dmg,     armor, res, lvl, value, damageType,  description
    ["shortsword",   "Shortsword",             "sword",    "common",    [4, 8],   0,  0,  1,  24, "slashing",  "Standard issue, standard results."],
    ["longsword",    "Longsword",              "sword",    "uncommon",  [6, 11],  0,  0,  3,  60, "slashing",  "Long enough to keep trouble at arm's length."],
    ["rapier",       "Rapier",                 "sword",    "uncommon",  [5, 10],  0,  0,  3,  58, "piercing",  "Precise, and smug about it."],
    ["waraxe",       "War Axe",                "axe",      "uncommon",  [8, 14],  0,  0,  4,  72, "slashing",  "Settles arguments in one swing."],
    ["dagger",       "Dagger",                 "dagger",   "common",    [3, 7],   0,  0,  1,  18, "piercing",  "Quiet, quick, deniable."],
    ["mace",         "Iron Mace",              "mace",     "common",    [5, 10],  0,  0,  2,  30, "blunt",     "No edge to dull."],
    ["spear",        "Corridor Pike",          "spear",    "rare",      [9, 15],  0,  0,  6, 140, "piercing",  "Reach beats speed in a narrow hallway."],
    ["bow",          "Recurve Bow",            "bow",      "rare",      [7, 16],  0,  0,  6, 155, "piercing",  "Best used before anything notices you."],
    ["oakstaff",     "Oak Staff",              "staff",    "common",    [3, 6],   0,  4,  1,  26, "arcane",    "Warm to the touch, for no reason anyone can name."],
    ["runewand",     "Rune Wand",              "wand",     "uncommon",  [4, 9],   0,  6,  3,  66, "arcane",    "Fits in a pocket. Empties a corridor."],
    ["paddedvest",   "Padded Vest",            "chest",    "common",    [0, 0],   4,  0,  1,  22, "physical",  "Better than nothing, marginally."],
    ["leathercoat",  "Leather Coat",           "chest",    "uncommon",  [0, 0],   6,  1,  3,  55, "physical",  "Broken in by someone who is no longer here."],
    ["chainhauberk", "Chain Hauberk",          "chest",    "rare",      [0, 0],   9,  2,  6, 130, "physical",  "Loud, heavy, worth it."],
    ["platecuirass", "Plate Cuirass",          "chest",    "epic",      [0, 0],  12,  3, 10, 300, "physical",  "Turns a killing blow into a bad morning."],
    ["silkrobe",     "Silk Robe",              "clothing", "uncommon",  [0, 0],   3,  8,  3,  70, "arcane",    "Threadbare against blades, excellent against spells."],
    ["helm",         "Dented Helm",            "helm",     "common",    [0, 0],   3,  0,  1,  20, "physical",  "The dent was there when you found it."],
    ["shoulder",     "Iron Pauldrons",         "shoulder", "uncommon",  [0, 0],   4,  1,  4,  62, "physical",  "Carries weight so your back doesn't."],
    ["gloves",       "Work Gauntlets",         "gloves",   "common",    [0, 0],   2,  0,  1,  16, "physical",  "Grip first, protection second."],
    ["belt",         "Toolbelt of Holding",    "belt",     "rare",      [0, 0],   2,  3,  6, 145, "physical",  "Deeper than it has any right to be."],
    ["legs",         "Riveted Greaves",        "legs",     "uncommon",  [0, 0],   5,  0,  4,  64, "physical",  "For walking, mostly."],
    ["boots",        "Long-Mile Boots",        "boots",    "rare",      [0, 0],   3,  2,  6, 150, "physical",  "The soles never seem to wear down."],
    ["cloak",        "Stairwell Cloak",        "cloak",    "epic",      [0, 0],   3,  9, 10, 320, "shadow",    "Shadows fold toward it."],
    ["shield",       "Heater Shield",          "shield",   "uncommon",  [0, 0],   8,  1,  4,  80, "physical",  "A door you can carry."],
    ["ring",         "Copper Band",            "ring",     "common",    [0, 0],   0,  1,  1,  25, "physical",  "Turns your finger green. Probably harmless."],
    ["amulet",       "Owl Charm",              "amulet",   "rare",      [0, 0],   0,  6,  6, 160, "arcane",    "You notice things a half-second sooner."],
    ["gem",          "Fluorescent Shard",      "gem",      "legendary", [0, 0],   2, 12, 14, 800, "lightning", "Hums at the exact pitch of a dying ceiling light."],
    ["scroll",       "Scroll of Second Wind",  "scroll",   "rare",      [0, 0],   0,  0,  5, 120, "holy",      "One good breath when you need it most."],
    ["tome",         "Ledger of Small Debts",  "tome",     "epic",      [0, 0],   0,  4, 10, 400, "shadow",    "Every name in it is owed something."],
    ["potion_hp_s",  "Minor Healing Draught",  "potion",   "common",    [0, 0],   0,  0,  1,  25, "holy",      "Tastes of iron and mint."],
    ["potion_hp_l",  "Greater Healing Draught","potion",   "uncommon",  [0, 0],   0,  0,  5,  70, "holy",      "Thick, and worth every swallow."],
    ["potion_mp",    "Vial of Blue Ink",       "potion",   "common",    [0, 0],   0,  0,  2,  30, "arcane",    "Definitely not ink."],
    ["potion_sp",    "Bitter Coffee",          "potion",   "common",    [0, 0],   0,  0,  1,  18, "physical",  "Burnt at 6am, still going."],
    ["potion_full",  "Second Wind",            "potion",   "rare",      [0, 0],   0,  0,  8, 110, "holy",      "Everything at once, briefly."]
  ];

  const RESTORES = {
    potion_hp_s:  { hp: 45 },
    potion_hp_l:  { hp: 120 },
    potion_mp:    { mana: 40 },
    potion_sp:    { stamina: 60 },
    potion_full:  { hp: 80, mana: 40, stamina: 60 },
    scroll:       { hp: 60, stamina: 40 }
  };

  /* name, icon, type, rarity, boss, [lvlMin,lvlMax], baseHp, armour,
     attackName, [atkMin,atkMax], damageType, xp, gold, lootKey

     These are BASE numbers, describing the monster at the bottom of its level
     band before its rarity multiplier. They were derived from the original
     hardcoded bestiary by tools/calibrate.js, so seeding the editor reproduces
     the difficulty curve the game was tuned to rather than quietly changing it.
     Re-run that script if the built-in fallback bestiary is ever retuned. */
  const MONSTERS = [
    ["Loose Stapler Swarm",  "📎", "construct", "common",    false, [1, 4],    22,  4, "Snapping Bite",    [12, 15],  "piercing",    55,  12, "vermin"],
    ["Break Room Rat",       "🐀", "beast",     "common",    false, [1, 4],    26,  5, "Gnaw",             [13, 18],  "piercing",    60,  14, "vermin"],
    ["Goblin Intern",        "👺", "humanoid",  "common",    false, [1, 5],    34,  6, "Stapler Swing",    [14, 19],  "blunt",       85,  22, "vermin"],
    ["Filing Cabinet Mimic", "🗄️", "aberration","uncommon",  false, [3, 8],    64, 13, "Drawer Slam",      [22, 29],  "blunt",      135,  40, "office"],
    ["Corridor Wisp",        "👻", "spirit",    "uncommon",  false, [3, 8],    48,  8, "Cold Whisper",     [19, 25],  "arcane",     145,  35, "office"],
    ["Vending Golem",        "🤖", "construct", "uncommon",  false, [4, 9],    93, 16, "Coin Return",      [28, 37],  "lightning",  187,  62, "office"],
    ["Stairwell Stalker",    "🕷️", "beast",     "rare",      false, [7, 14],   89, 16, "Ambush",           [40, 53],  "slashing",   227,  66, "deep"],
    ["Parking Lot Wraith",   "💀", "undead",    "rare",      false, [7, 14],  108, 18, "Grasp of the Lot", [40, 53],  "shadow",     262,  82, "deep"],
    ["Hoarding Kobold",      "🦎", "humanoid",  "rare",      false, [7, 15],   94, 18, "Snatch and Bite",  [40, 53],  "piercing",   237, 101, "deep"],
    ["Fluorescent Horror",   "🦇", "aberration","epic",      false, [12, 20], 165, 29, "Flicker",          [60, 79],  "shadow",     347, 123, "executive"],
    ["Quarterly Review",     "📊", "aberration","epic",      false, [12, 22], 195, 33, "Performance Note", [60, 80],  "arcane",     408, 151, "executive"],
    ["The Facilities Manager","👔","humanoid",  "rare",      true,  [5, 10],  210, 20, "Keyring Flail",    [38, 50],  "blunt",      760, 284, "office"],
    ["Ancient Copier, Awoken","🖨️","construct", "epic",      true,  [10, 18], 346, 33, "Toner Cloud",      [55, 73],  "poison",    1163, 436, "deep"],
    ["Warden of the Skyway", "🐉", "dragon",    "legendary", true,  [16, 30], 525, 45, "Skyway Breath",    [83, 110], "fire",      1704, 650, "executive"]
  ];

  /* key, name, dropsMin, dropsMax, [[itemKey, chance], ...] */
  const LOOT = [
    ["vermin", "Vermin Scraps", 0, 2, [
      ["potion_sp", 30], ["dagger", 12], ["shortsword", 8], ["gloves", 10],
      ["helm", 6], ["ring", 4], ["potion_hp_s", 18]
    ]],
    ["office", "Office Salvage", 1, 3, [
      ["potion_hp_s", 35], ["potion_mp", 20], ["leathercoat", 12], ["shield", 10],
      ["longsword", 9], ["rapier", 8], ["runewand", 7], ["shoulder", 8],
      ["legs", 8], ["waraxe", 6], ["silkrobe", 5]
    ]],
    ["deep", "Deep Floor Cache", 1, 3, [
      ["potion_hp_l", 30], ["chainhauberk", 12], ["boots", 10], ["belt", 10],
      ["spear", 9], ["bow", 9], ["amulet", 8], ["potion_full", 12], ["scroll", 7]
    ]],
    ["executive", "Executive Hoard", 2, 4, [
      ["platecuirass", 14], ["cloak", 12], ["tome", 10], ["gem", 4],
      ["potion_full", 40], ["amulet", 18], ["boots", 16], ["belt", 16], ["scroll", 20]
    ]]
  ];

  function build() {
    const scale = Content.config().scale;
    const itemIdOf = {}, lootIdOf = {};

    const items = ITEMS.map(row => {
      const [key, name, slot, rarity, dmg, armor, res, lvl, value, dtype, desc] = row;
      const id = "itm_seed_" + key;
      itemIdOf[key] = id;
      const r = RESTORES[key] || {};
      return {
        itemId: id, name, gearType: slot, iconKey: Content.slotDef(slot).icon,
        rarity, damageType: dtype, damageMin: dmg[0], damageMax: dmg[1],
        armor, resistance: res,
        restoreHp: r.hp || 0, restoreMana: r.mana || 0, restoreStamina: r.stamina || 0,
        itemLevel: lvl, value, description: desc,
        createdAt: Date.now(), updatedAt: Date.now()
      };
    });

    const loot = LOOT.map(([key, name, dmin, dmax, entries]) => {
      const id = "lt_seed_" + key;
      lootIdOf[key] = id;
      return {
        lootTableId: id, name, dropsMin: dmin, dropsMax: dmax,
        loot: entries.map(e => itemIdOf[e[0]]),
        chances: entries.map(e => e[1]),
        createdAt: Date.now(), updatedAt: Date.now()
      };
    });

    const monsters = MONSTERS.map(row => {
      const [name, icon, type, rarity, isBoss, lvl, hp, armor, attackName, atk, dtype, xp, gold, lootKey] = row;
      return {
        monsterId: "mon_seed_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
        name, icon, type, rarity, isBoss,
        levelMin: lvl[0], levelMax: lvl[1],
        baseHp: hp, armor: armor,
        attackName, attackMin: atk[0], attackMax: atk[1],
        damageType: dtype,
        expReward: xp, goldReward: gold,
        lootTableId: lootIdOf[lootKey] || "",
        createdAt: Date.now(), updatedAt: Date.now()
      };
    });

    return { items, loot, monsters };
  }

  return {
    build,
    /** Install once. Never overwrites anything a person has authored. */
    install(force) {
      if (!force && !Content.isEmpty()) return { seeded: false };
      const b = build();
      Content.replaceAll("items", b.items);
      Content.replaceAll("loot", b.loot);
      Content.replaceAll("monsters", b.monsters);
      return { seeded: true, items: b.items.length, loot: b.loot.length, monsters: b.monsters.length };
    }
  };
})();
