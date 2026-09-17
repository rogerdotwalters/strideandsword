"use strict";
/* -------------------------------------------------------------------------
   8i. Buildings — places on the map, and the people who work out of them.

   A building is a structure you put on the real map: a smithy on the corner
   of your street, a store in the strip mall, an inn where the pub actually
   is. It has a name, a kind, a level and a footprint, and it is drawn there
   whether or not anything is happening.

   ============================== THE ONE RULE =============================

   **The building does not serve you. Its resident does, and the resident
   walks.** There is no "enter shop" button and no panel attached to the
   structure. Each building puts one person into the world, and that person
   is an ordinary `Denizens` character: their position is a pure function of
   the clock, they pace around the building, and you trade with them wherever
   you catch them. Walk to the smithy at the wrong moment and the smith is
   round the back.

   That is why this file is so short on UI and so long on geometry. The
   building supplies a **territory** — a circle of ground around itself — and
   everything about movement, containment, generations and drawing is already
   solved in `js/world/denizens.js`. Nothing here ticks either.

   ================================ WHAT A LEVEL IS ========================

   One number, 1–10, and it is the only dial. It decides what the resident
   carries, what they charge, how much a night's rest gives back and how far
   a smith will take a piece of gear. A level 1 store is a cart with three
   things on it; a level 8 store is worth walking across town for.

   ================================= WHERE THEY COME FROM ==================

     mapeditor.html    the Buildings layer: drop a point, trace a footprint
     regions.html      import a Google Earth file — see docs/google-earth.md
     data/buildings.json   what a fresh install starts with

   Buildings are **world-scoped**, like regions and shapes and unlike
   locations: they have no `zoneId`, because a town does not stop at the edge
   of a 500 m chunk and an imported high street would vanish the moment you
   walked out of the zone it happened to be anchored in.

       localStorage  "building_defs"       the live table
       data/buildings.json                 the seed
       export                              a GeoJSON FeatureCollection
   ------------------------------------------------------------------------- */
const Buildings = {
  KEY: "building_defs",
  FORMAT: "stride-and-sword.buildings",
  VERSION: 1,

  /* What the resident has on them, and for how long. Six hours is a
     deliberate compromise: long enough that the stock is a *place* you
     remember rather than a slot machine you re-roll, short enough that
     walking past the same store tomorrow is worth doing. */
  RESTOCK_MS: 6 * 3600 * 1000,
  TAKEN_KEY: "building_stock_taken",

  /* ------------------------------------------------------------- the trades
     Four things a person can do for you. A building's kind picks a default
     set and the editor can change it, so a temple that also sells candles is
     one checkbox rather than a new kind. */
  TRADES: {
    goods: { key: "goods", name: "Buy and sell", verb: "Trade",  icon: "🪙",
             blurb: "Carries stock, and takes what you do not want." },
    rest:  { key: "rest",  name: "Rest",         verb: "Rest",   icon: "🔥",
             blurb: "Food, a fire and a bed, for a price." },
    mend:  { key: "mend",  name: "Improve gear", verb: "Improve", icon: "🔨",
             blurb: "Takes a piece of your gear a level further." },
    talk:  { key: "talk",  name: "Talk",         verb: "Talk",   icon: "💬",
             blurb: "Has something to say, and sometimes work." }
  },
  TRADE_ORDER: ["goods", "rest", "mend", "talk"],

  /* --------------------------------------------------------------- the kinds
     Keys and icons line up with `Content.BUILDING_KINDS`, which is the older,
     purely decorative field on a location — so the two vocabularies agree
     where they overlap and you are not learning the word for "smithy" twice.
     What is new here is `trades` (what the resident does), `title` (what they
     are called) and `words` (how an imported placemark names itself).

     `stock` is what the resident's goods are rolled from: a slot name, a
     family, or null for anything at all. An apothecary selling plate armour
     was the first thing that read as a bug. */
  KINDS: [
    { key: "store",      label: "store",         icon: "🏪", color: "#c9a63a",
      title: "trader",    trades: ["goods"],          stock: null,
      words: ["store", "shop", "general store", "trader", "emporium", "market",
              "mercantile", "outfitter", "supply"] },
    { key: "market",     label: "market stall",  icon: "🧺", color: "#c9a63a",
      title: "stallholder", trades: ["goods"],        stock: null,
      words: ["market stall", "stall", "bazaar", "market square"] },
    { key: "tavern",     label: "tavern",        icon: "🍺", color: "#c98a3a",
      title: "innkeeper", trades: ["rest", "talk"],   stock: ["potion"],
      words: ["tavern", "inn", "alehouse", "pub", "bar", "lodge", "hostel",
              "public house", "brewery"] },
    { key: "smithy",     label: "smithy",        icon: "🔨", color: "#c2603f",
      title: "smith",     trades: ["mend", "goods"],  stock: ["mainhand", "chest", "helm"],
      words: ["smithy", "smith", "blacksmith", "forge", "armoury", "armory",
              "weaponsmith", "hardware"] },
    { key: "foundry",    label: "foundry",       icon: "⚒️", color: "#b0563f",
      title: "founder",   trades: ["mend"],           stock: ["mainhand"],
      words: ["foundry", "smelter", "ironworks", "works"] },
    { key: "apothecary", label: "apothecary",    icon: "⚗️", color: "#5fae8f",
      title: "apothecary", trades: ["goods", "rest"], stock: ["potion"],
      words: ["apothecary", "herbalist", "alchemist", "chemist", "pharmacy",
              "drug store", "drugstore", "infirmary"] },
    { key: "temple",     label: "temple",        icon: "⛪", color: "#8f6fd0",
      title: "priest",    trades: ["rest", "talk"],   stock: ["potion"],
      words: ["temple", "church", "chapel", "shrine", "abbey", "cathedral",
              "mosque", "synagogue", "meeting house"] },
    { key: "guildhall",  label: "guild hall",    icon: "🏛️", color: "#7f9fc0",
      title: "steward",   trades: ["talk"],           stock: null,
      words: ["guild", "guild hall", "guildhall", "hall", "town hall", "court",
              "office", "chapter house"] },
    { key: "library",    label: "library",       icon: "📚", color: "#6f8fd0",
      title: "archivist", trades: ["talk"],           stock: ["neck", "ring"],
      words: ["library", "archive", "scriptorium", "school", "college",
              "university", "museum"] },
    { key: "counting",   label: "counting house", icon: "🪙", color: "#c9a63a",
      title: "clerk",     trades: ["goods"],          stock: ["ring", "neck"],
      words: ["counting house", "bank", "exchange", "treasury", "mint",
              "credit union"] },
    { key: "stable",     label: "stable",        icon: "🐎", color: "#8a7a5a",
      title: "hostler",   trades: ["goods", "rest"],  stock: ["boots", "belt", "back"],
      words: ["stable", "stables", "mews", "livery", "garage", "depot"] },
    { key: "granary",    label: "granary",       icon: "🌾", color: "#b09a4a",
      title: "factor",    trades: ["goods"],          stock: ["potion"],
      words: ["granary", "mill", "silo", "barn", "grain", "bakery", "grocer",
              "grocery", "supermarket"] },
    { key: "barracks",   label: "barracks",      icon: "🛡️", color: "#7a8a9a",
      title: "serjeant",  trades: ["mend", "talk"],   stock: ["offhand", "chest"],
      words: ["barracks", "garrison", "watch house", "guardhouse", "armoury hall",
              "station", "fire station", "police"] },
    { key: "bathhouse",  label: "bathhouse",     icon: "♨️", color: "#5f9fae",
      title: "attendant", trades: ["rest"],           stock: ["potion"],
      words: ["bathhouse", "baths", "spa", "pool", "gym", "leisure centre",
              "leisure center"] },
    { key: "keep",       label: "keep",          icon: "🏰", color: "#8899b0",
      title: "castellan", trades: ["talk"],           stock: null,
      words: ["keep", "castle", "fort", "fortress", "citadel", "manor"] },
    { key: "tower",      label: "tower",         icon: "🗼", color: "#5f8fd0",
      title: "adept",     trades: ["talk", "goods"],  stock: ["neck", "ring", "mainhand"],
      words: ["tower", "spire", "observatory", "mast", "lighthouse"] },
    { key: "cottage",    label: "cottage",       icon: "🏚️", color: "#9a7f5f",
      title: "cottager",  trades: ["talk"],           stock: null,
      words: ["cottage", "house", "home", "hut", "farmhouse", "residence",
              "apartments", "flat"] }
  ],

  /** The kind a key means. Never nothing: an unknown key is a cottage. */
  kind(key) {
    return this.KINDS.find(k => k.key === key) ||
           this.KINDS[this.KINDS.length - 1];
  },

  /**
   * Which kind a piece of text is naming, or "" for text that names none.
   *
   * Longest phrase first and last mention wins, the same rule the terrain
   * hints use: "the old forge bakery" is a bakery, "bakery by the old forge"
   * is a forge, and both are better than alphabetical order would be.
   */
  kindFromWords(...texts) {
    const hay = texts.filter(Boolean).join(" ").toLowerCase();
    if (!hay.trim()) return "";
    let best = "", bestAt = -1, bestLen = 0;
    this.KINDS.forEach(k => {
      k.words.forEach(w => {
        const at = hay.lastIndexOf(w);
        if (at < 0) return;
        if (at > bestAt || (at === bestAt && w.length > bestLen)) {
          best = k.key; bestAt = at; bestLen = w.length;
        }
      });
    });
    return best;
  },

  /* ============================================== NAMES OUT OF GOOGLE EARTH

     A placemark carries one piece of text you control, and this is the whole
     grammar for it:

         building: Store level 3
         building: The Gilded Flask, tavern, level 2
         smithy: Ash & Ember level 5 radius 40m

     The prefix says "this pin is a building" rather than a region. After it,
     `level N` and `radius Nm` are pulled out wherever they sit, the kind is
     whatever word in the line names one, and what is left is the name. A
     trailing comma-separated segment that is *only* a kind word is dropped,
     so "The Gilded Flask, tavern" is called The Gilded Flask and not
     The Gilded Flask, tavern.

     `declared` is the important half of the answer: it says the author asked
     for a building. A pin that merely happens to contain the word "store" is
     accepted too — being strict about a colon is a bad way to greet somebody
     who just dropped forty pins — but it is a guess, and it is recorded as
     one. See docs/google-earth.md, which is the copy a person reads. */
  PREFIX_RE: /^\s*(building|bldg|place|shop)\s*[:–-]\s*/i,
  LEVEL_RE: /\b(?:level|lvl|lv)\s*([0-9]{1,2})\b/i,
  RADIUS_RE: /\b(?:radius|r)\s*([0-9]{1,4})\s*m\b/i,

  parseName(text, folder) {
    const raw = String(text == null ? "" : text).trim();
    let rest = raw;
    let declared = false;

    const pre = this.PREFIX_RE.exec(rest);
    if (pre) { declared = true; rest = rest.slice(pre[0].length); }
    else {
      /* "smithy: Ash & Ember" — naming the kind in front of the colon is just
         as clear a declaration as the word "building", and it is what people
         write once they know the kinds. Only a whole kind word counts, so
         "Note: the old forge" stays a note. */
      const m = /^([A-Za-z][A-Za-z '&]{0,24})\s*[:–-]\s*/.exec(rest);
      if (m && this.KINDS.some(k => k.words.indexOf(m[1].trim().toLowerCase()) >= 0 ||
                                    k.key === m[1].trim().toLowerCase())) {
        declared = true;
        rest = rest.slice(m[0].length);
      }
    }

    let level = 0, radiusM = 0;
    const lv = this.LEVEL_RE.exec(rest);
    if (lv) { level = clamp(parseInt(lv[1], 10) || 1, 1, 10); rest = rest.replace(this.LEVEL_RE, " "); }
    const rd = this.RADIUS_RE.exec(rest);
    if (rd) { radiusM = clamp(parseInt(rd[1], 10) || 0, 5, 400); rest = rest.replace(this.RADIUS_RE, " "); }

    /* The name decides, and the folder is only a fallback.
       Unlike the terrain hints — where a folder called "Low ground" is the
       better statement — a folder here is a filing decision: a smithy inside
       a folder called "Shops" is a smithy, and reading both at once made it
       a store, because "Shops" came later in the joined text. */
    const kind = this.kindFromWords(raw) || this.kindFromWords(folder || "") || "";

    let name = rest.replace(/\s+/g, " ").trim().replace(/^[,;·\-–]+|[,;·\-–]+$/g, "").trim();
    // Drop a trailing ", tavern" that was only there to say what it is.
    const seg = name.split(",");
    if (seg.length > 1) {
      const tail = seg[seg.length - 1].trim().toLowerCase();
      if (tail && this.kindFromWords(tail) && tail.split(/\s+/).length <= 3) {
        name = seg.slice(0, -1).join(",").trim();
      }
    }
    if (!name) name = cap(this.kind(kind).label);

    return { declared, kind, name, level, radiusM };
  },

  /* ------------------------------------------------------------------ table */

  all() {
    const rows = Store.get(this.KEY, null);
    return Array.isArray(rows) ? rows : [];
  },
  list(includeHidden) {
    const rows = this.all();
    return includeHidden ? rows : rows.filter(b => b.active !== false);
  },
  get(id) { return this.all().find(b => b.buildingId === id) || null; },
  exists() { return Array.isArray(Store.get(this.KEY, null)); },
  replaceAll(rows) {
    Store.set(this.KEY, Array.isArray(rows) ? rows : []);
    return this.all();
  },
  clear() { Store.set(this.KEY, []); },

  save(b) {
    if (!b) return null;
    const rows = this.all();
    b.lastModified = nowTs();
    if (!b.buildingId) {
      b.buildingId = uid("bld");
      b.createdAt = nowTs();
      rows.push(b);
    } else {
      const i = rows.findIndex(x => x.buildingId === b.buildingId);
      if (i < 0) rows.push(b); else rows[i] = b;
    }
    Store.set(this.KEY, rows);
    return b;
  },

  remove(id) {
    const rows = this.all().filter(b => b.buildingId !== id);
    Store.set(this.KEY, rows);
    return rows;
  },

  blank(kindKey, lat, lng) {
    const k = this.kind(kindKey);
    return {
      buildingId: "",
      name: cap(k.label),
      kind: k.key,
      level: 1,
      latitude: +lat || 0, longitude: +lng || 0,
      /* How far the resident strays, and how close you have to be for the
         building itself to be "here". One number for both, because two would
         be a setting nobody can predict the effect of. */
      radius: 45,
      /* Optional, and [lat, lng] like every other ring in this project. The
         real outline traced in the editor or imported from a Google Earth
         polygon. The resident still paces a circle — see `territoryOf`. */
      footprint: [],
      residentName: "",          // blank = named from the building, seeded
      residentIcon: "",
      residentPortrait: "",      // the picture inside their token, if drawn
      trades: k.trades.slice(),
      questId: "",
      notes: "",
      source: "hand", sourceId: "",
      active: true,
      createdAt: nowTs(), lastModified: nowTs()
    };
  },

  /* --------------------------------------------------------------- geometry */

  ring(b) {
    const r = (b && b.footprint) || [];
    return r.length > 2 ? r : null;
  },

  centroid(b) {
    const r = this.ring(b);
    if (!r) return { latitude: +b.latitude, longitude: +b.longitude };
    let la = 0, ln = 0;
    r.forEach(p => { la += +p[0]; ln += +p[1]; });
    return { latitude: la / r.length, longitude: ln / r.length };
  },

  /** Longest span of the footprint in metres, or the radius twice over. */
  sizeM(b) {
    const r = this.ring(b);
    if (!r) return Math.round((+b.radius || 45) * 2);
    let s = r[0][0], n = s, w = r[0][1], e = w;
    r.forEach(p => {
      s = Math.min(s, p[0]); n = Math.max(n, p[0]);
      w = Math.min(w, p[1]); e = Math.max(e, p[1]);
    });
    return Math.round(Math.max(haversine(s, w, n, w), haversine(s, w, s, e)));
  },

  /** Standing in it: inside the traced outline, or inside the circle. */
  contains(b, lat, lng) {
    if (!b) return false;
    const r = this.ring(b);
    if (r) return Content.pointInRing(r, lat, lng);
    return haversine(+b.latitude, +b.longitude, lat, lng) <= (+b.radius || 45);
  },

  /** Metres from a point to the building's middle. */
  distanceTo(b, lat, lng) {
    const c = this.centroid(b);
    return haversine(lat, lng, c.latitude, c.longitude);
  },

  near(lat, lng, radiusM) {
    const r = +radiusM || 800;
    return this.list().filter(b => this.distanceTo(b, lat, lng) <= r + this.sizeM(b));
  },

  levelOf(b) { return clamp(Math.round(+((b && b.level) || 1)) || 1, 1, 10); },

  tradesOf(b) {
    const want = (b && b.trades && b.trades.length) ? b.trades : this.kind(b && b.kind).trades;
    return this.TRADE_ORDER.filter(t => want.indexOf(t) >= 0);
  },

  does(b, trade) { return this.tradesOf(b).indexOf(trade) >= 0; },

  /* ================================================== WHO WORKS THERE =====

     The resident is not a new kind of thing. A building hands `Denizens` a
     territory — a circle of ground centred on the building — with one
     character in it, and everything else (position from the clock, the ease
     between waypoints, generations, drawing, the meeting panel) is already
     written and already tested.

     The territory is a **circle even when a footprint was traced**, and that
     is deliberate: a person confined to the outline of a building would be
     standing in the walls and would be unmeetable at a 35 m interaction
     range. The footprint draws the structure; the circle is the yard. */

  FIRST_NAMES: ["Bram", "Wend", "Cassilda", "Hollis", "Rhosyn", "Maugrim",
                "Ottoline", "Perrin", "Sable", "Toft", "Ivy", "Garrow",
                "Melisent", "Odo", "Nesta", "Corvin"],

  residentName(b) {
    if (b.residentName) return b.residentName;
    const rand = seededRandom((b.buildingId || b.name || "bld") + ":resident");
    const first = this.FIRST_NAMES[Math.floor(rand() * this.FIRST_NAMES.length)];
    return first + " the " + this.kind(b.kind).title;
  },

  residentIcon(b) { return b.residentIcon || "🧍"; },

  territoryOf(b) {
    const c = this.centroid(b);
    return {
      shapeId: "bld:" + (b.buildingId || b.name || "x"),
      purpose: "zone",
      zoneKind: "character",
      building: true,
      buildingId: b.buildingId || "",
      name: b.name || cap(this.kind(b.kind).label),
      points: null,                                  // a circle: see above
      latitude: c.latitude, longitude: c.longitude,
      radiusM: clamp(+b.radius || 45, 15, 250),
      /* How far they actually walk, which is not the same as how big the yard
         is. A leg is forty seconds and walking pace over one is about fifty
         metres, so two waypoints must not be more than that apart — at a 60 m
         yard the smith was crossing it at 3 m/s. Twenty-five metres from the
         door, whatever the yard says. */
      walkRadiusM: Math.min(clamp(+b.radius || 45, 15, 250), 25),
      placeName: b.name || "",
      npcName: this.residentName(b),
      npcIcon: this.residentIcon(b),
      npcPortrait: b.residentPortrait || "",
      trades: this.tradesOf(b),
      level: this.levelOf(b),
      questId: b.questId || "",
      count: 1, roams: "zone", difficulty: 0
    };
  },

  /** Territories for every building near a point — what `Denizens` asks for. */
  territories(lat, lng, radiusM) {
    return this.near(lat, lng, radiusM).map(b => this.territoryOf(b));
  },

  /** Where this building's resident is right now. Null if nothing lives there. */
  residentOf(b, now) {
    if (typeof Denizens === "undefined" || !b || b.active === false) return null;
    return Denizens.inZone(this.territoryOf(b), now || Date.now())[0] || null;
  },

  /* ==================================================== WHAT THEY CARRY ===

     Stock is derived, never stored — the same rule the rest of the world
     keeps. A building, a six-hour window and an index give one item, on any
     device, before and after a reload. What *is* stored is the short list of
     what has been bought, so a thing you carried away does not reappear on
     the shelf until the shop restocks. */

  windowAt(now) { return Math.floor((now || Date.now()) / this.RESTOCK_MS); },
  restocksAt(now) { return (this.windowAt(now) + 1) * this.RESTOCK_MS; },

  /**
   * Run `fn` with `Math.random` replaced by a seeded source.
   *
   * `Items.generate` reaches for `Math.random` in a dozen places through
   * `pick`, `rnd` and `chance`, and threading a random source through all of
   * them would change every call site in the project for the sake of a shop.
   * Swapping it for the duration is honest, reversible, and restored in a
   * `finally` so a throw inside the generator cannot leave the game with a
   * fixed die.
   */
  withSeed(seed, fn) {
    const rand = seededRandom(String(seed));
    const real = Math.random;
    Math.random = rand;
    try { return fn(rand); } finally { Math.random = real; }
  },

  /** How many things a resident of this level has on them. */
  stockCount(b) { return clamp(2 + Math.round(this.levelOf(b) / 2), 3, 8); },

  /** The item level a resident of this level deals in. */
  stockLevel(b, bump) {
    return clamp(this.levelOf(b) * 2 + (bump || 0), 1, 40);
  },

  /**
   * What is on the shelf in this window.
   *
   * Item ids are derived too — `itm_<building>_<window>_<i>` — so "the one I
   * looked at a minute ago" and "the one I just bought" are the same row on
   * every device. A random id would have made the taken list meaningless.
   */
  stockOf(b, now) {
    if (!b || !this.does(b, "goods")) return [];
    const win = this.windowAt(now);
    const k = this.kind(b.kind);
    const taken = this.taken(now);
    const out = [];
    const n = this.stockCount(b);
    for (let i = 0; i < n; i++) {
      const id = "itm_" + (b.buildingId || "bld") + "_" + win + "_" + i;
      const item = this.withSeed((b.buildingId || b.name) + ":" + win + ":" + i, (rand) => {
        const forced = k.stock ? k.stock[Math.floor(rand() * k.stock.length)] : null;
        const lvl = this.stockLevel(b, Math.floor(rand() * 3) - 1);
        return Items.generate(lvl, 10 + this.levelOf(b), this.levelOf(b), forced);
      });
      item.itemId = id;
      item.fromBuilding = b.buildingId || "";
      out.push({ index: i, item, price: this.buyPrice(item, null), taken: !!taken[id] });
    }
    return out;
  },

  /** The short list of what has been bought, pruned as it is read. */
  taken(now) {
    const all = Store.get(this.TAKEN_KEY, {}) || {};
    const t = now || Date.now();
    let dirty = false;
    Object.keys(all).forEach(k => { if (all[k] <= t) { delete all[k]; dirty = true; } });
    if (dirty) Store.set(this.TAKEN_KEY, all);
    return all;
  },

  /* Prices. A resident marks up by their level — a good shop knows what it
     has — and your charisma pulls the other way through the same `priceMod`
     the rest of the game already uses. */
  buyPrice(item, ch) {
    const base = Math.max(1, Math.round((+item.price || 10) * 1.35));
    const mod = (ch && typeof Calc !== "undefined") ? Calc.priceMod(ch) : 1;
    return Math.max(1, Math.round(base * mod));
  },

  sellPrice(item, ch) {
    const mod = (ch && typeof Calc !== "undefined") ? Calc.priceMod(ch) : 1;
    return Math.max(1, Math.round((+item.price || 10) * 0.45 / mod));
  },

  /**
   * Buy one row of the stock.
   *
   * Mutates the character (gold, pack) and records what was taken; saving the
   * character is the caller's job, exactly as it is in the inventory panel.
   * Every refusal is a sentence, because it is shown to a person.
   */
  buy(b, index, ch, now) {
    if (!ch) return { ok: false, why: "No character." };
    const row = this.stockOf(b, now)[index];
    if (!row) return { ok: false, why: "That is not for sale." };
    if (row.taken) return { ok: false, why: "That one is already sold." };
    const price = this.buyPrice(row.item, ch);
    if ((+ch.gold || 0) < price) return { ok: false, why: "You are " + (price - (+ch.gold || 0)) + " gold short." };
    if ((ch.inventory || []).length >= 20) return { ok: false, why: "Your pack is full." };
    ch.gold -= price;
    ch.inventory = (ch.inventory || []).concat([row.item]);
    const expires = this.restocksAt(now);
    Store.patch(this.TAKEN_KEY, (all) => { all[row.item.itemId] = expires; });
    return { ok: true, why: "", item: row.item, price };
  },

  sell(b, item, ch) {
    if (!ch || !item) return { ok: false, why: "Nothing to sell." };
    if (!this.does(b, "goods")) return { ok: false, why: "They do not buy." };
    const price = this.sellPrice(item, ch);
    ch.inventory = (ch.inventory || []).filter(x => x.itemId !== item.itemId);
    ch.gold = (+ch.gold || 0) + price;
    return { ok: true, why: "", price };
  },

  /* ---------------------------------------------------------------- resting */

  /** How much of each pool a night here gives back. */
  restFraction(b) { return clamp(0.4 + this.levelOf(b) * 0.07, 0.4, 1); },
  restCost(b, ch) {
    const mod = (ch && typeof Calc !== "undefined") ? Calc.priceMod(ch) : 1;
    return Math.max(1, Math.round((8 + this.levelOf(b) * 6) * mod));
  },

  rest(b, ch, now) {
    if (!this.does(b, "rest")) return { ok: false, why: "Nowhere to lie down." };
    if (!ch) return { ok: false, why: "No character." };
    const cost = this.restCost(b, ch);
    if ((+ch.gold || 0) < cost) return { ok: false, why: "You are " + (cost - (+ch.gold || 0)) + " gold short." };
    const f = this.restFraction(b);
    const gained = {};
    ["hp", "mana", "stamina"].forEach(k => {
      const max = +ch.stats["max" + cap(k)] || 0;
      const was = +ch.stats[k] || 0;
      const to = clamp(Math.round(was + max * f), 0, max);
      gained[k] = to - was;
      ch.stats[k] = to;
    });
    const total = gained.hp + gained.mana + gained.stamina;
    if (total <= 0) return { ok: false, why: "You are already rested." };
    ch.gold -= cost;
    ch.lastRestAt = now || Date.now();
    return { ok: true, why: "", cost, gained };
  },

  /* --------------------------------------------------------------- improving

     No durability exists in this game, so "repair" would be a button with
     nothing to do. What a smith does instead is take a piece one level
     further, and their own level is the ceiling: a village smith cannot make
     you a legend's sword however much gold you put on the counter. */

  improveCap(b) { return this.levelOf(b) * 3; },
  improveCost(b, item) {
    return Math.max(5, Math.round((+item.price || 10) * 0.75));
  },

  canImprove(b, item) {
    if (!this.does(b, "mend")) return { ok: false, why: "They do not work metal." };
    if (!item) return { ok: false, why: "Nothing to improve." };
    if (item.type === "potion" || !Items.slotOf(item)) {
      return { ok: false, why: "That is not a piece of gear." };
    }
    /* Not named `cap`: that is the global "capitalise" helper this file uses
       three lines further down, and shadowing it here is how a smith once
       reported "Beyond a level 3 Smith". */
    const ceiling = this.improveCap(b);
    if ((+item.level || 1) >= ceiling) {
      return { ok: false, why: "Beyond a level " + this.levelOf(b) + " " +
                              this.kind(b.kind).title + " — they stop at item level " + ceiling + "." };
    }
    return { ok: true, why: "" };
  },

  improve(b, item, ch) {
    const gate = this.canImprove(b, item);
    if (!gate.ok) return gate;
    const cost = this.improveCost(b, item);
    if ((+ch.gold || 0) < cost) return { ok: false, why: "You are " + (cost - (+ch.gold || 0)) + " gold short." };
    const before = { level: +item.level || 1, effect: item.effect };
    Items.improve(item);
    ch.gold -= cost;
    return { ok: true, why: "", cost, before, item };
  },

  /* --------------------------------------------------------------- GeoJSON
     Same contract as regions: [lng, lat] on disk, [lat, lng] in memory, and
     only these two functions know it. A building with a traced outline is a
     Polygon; one without is a Point, because a pin is what it is. */

  toFeature(b) {
    const r = this.ring(b);
    const geometry = r
      ? { type: "Polygon", coordinates: [(() => {
          const out = r.map(p => [+p[1], +p[0]]);
          if (out.length && (out[0][0] !== out[out.length - 1][0] ||
                             out[0][1] !== out[out.length - 1][1])) out.push(out[0].slice());
          return out;
        })()] }
      : { type: "Point", coordinates: [+b.longitude, +b.latitude] };
    return {
      type: "Feature",
      id: b.buildingId || undefined,
      properties: {
        feature: "building",
        name: b.name, kind: b.kind, level: this.levelOf(b),
        radius: +b.radius || 45,
        residentName: b.residentName || "", residentIcon: b.residentIcon || "",
        residentPortrait: b.residentPortrait || "",
        trades: this.tradesOf(b),
        questId: b.questId || "",
        notes: b.notes || "",
        source: b.source || "hand", sourceId: b.sourceId || "",
        active: b.active !== false
      },
      geometry
    };
  },

  /** True for a feature this table should take. */
  isBuildingFeature(f) {
    const p = (f && f.properties) || {};
    if (p.feature === "building") return true;
    // A bare Point in a file of ours is a building; nothing else here is one.
    return !!(f && f.geometry && f.geometry.type === "Point" && p.kind &&
              this.KINDS.some(k => k.key === p.kind));
  },

  fromFeature(f) {
    if (!f || !f.geometry || !this.isBuildingFeature(f)) return null;
    const p = f.properties || {};
    const g = f.geometry;
    let ring = null, lat = 0, lng = 0;
    if (g.type === "Point") {
      lng = +g.coordinates[0]; lat = +g.coordinates[1];
    } else if (g.type === "Polygon" || g.type === "MultiPolygon") {
      const rings = g.type === "Polygon" ? g.coordinates : (g.coordinates[0] || []);
      const outer = rings[0] || [];
      ring = outer.map(c => [+c[1], +c[0]]);
      if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] &&
          ring[0][1] === ring[ring.length - 1][1]) ring.pop();
      if (ring.length < 3) return null;
      let la = 0, ln = 0;
      ring.forEach(q => { la += q[0]; ln += q[1]; });
      lat = la / ring.length; lng = ln / ring.length;
    } else return null;

    const b = this.blank(p.kind, lat, lng);
    b.buildingId = f.id ? String(f.id) : uid("bld");
    if (p.name) b.name = String(p.name);
    if (p.level) b.level = clamp(Math.round(+p.level) || 1, 1, 10);
    if (p.radius) b.radius = clamp(Math.round(+p.radius) || 45, 5, 400);
    if (ring) b.footprint = ring;
    b.residentName = p.residentName || "";
    b.residentIcon = p.residentIcon || "";
    b.residentPortrait = p.residentPortrait || "";
    if (Array.isArray(p.trades) && p.trades.length) {
      b.trades = this.TRADE_ORDER.filter(t => p.trades.indexOf(t) >= 0);
    }
    b.questId = p.questId || "";
    b.notes = p.notes || "";
    b.source = p.source || "import";
    b.sourceId = p.sourceId || "";
    b.active = p.active !== false;
    return b;
  },

  export() {
    return {
      type: "FeatureCollection",
      format: this.FORMAT, version: this.VERSION,
      exportedAt: new Date().toISOString(),
      features: this.all().map(b => this.toFeature(b))
    };
  },

  /**
   * Merge a FeatureCollection in.
   *
   * Non-building features are ignored rather than refused: the file a person
   * drops in is usually one Google Earth export holding both the ground and
   * the shops, and both halves are imported from the same drop.
   */
  import(doc, replace) {
    const feats = doc && (doc.features || (doc.type === "Feature" ? [doc] : null));
    if (!Array.isArray(feats)) return { success: false, message: "That file has no features in it.", added: 0, updated: 0 };
    const rows = [];
    feats.forEach(f => { const b = this.fromFeature(f); if (b) rows.push(b); });
    /* A file with no buildings in it leaves this table alone — even with
       `replace` on. "Replace everything" is a statement about the file you are
       dropping, and a survey of the ground is not a statement that the town
       has no shops in it. */
    if (!rows.length) return { success: true, added: 0, updated: 0, empty: true };
    if (replace) { this.replaceAll(rows); return { success: true, added: rows.length, updated: 0 }; }
    const mine = this.all();
    const byId = {}, bySource = {};
    mine.forEach((b, i) => {
      byId[b.buildingId] = i;
      if (b.sourceId) bySource[b.sourceId] = i;
    });
    let added = 0, updated = 0;
    rows.forEach(b => {
      const at = (b.buildingId && byId[b.buildingId] != null) ? byId[b.buildingId]
               : (b.sourceId && bySource[b.sourceId] != null) ? bySource[b.sourceId] : -1;
      if (at >= 0) { b.buildingId = mine[at].buildingId; mine[at] = b; updated++; }
      else { mine.push(b); added++; }
    });
    Store.set(this.KEY, mine);
    return { success: true, added, updated };
  },

  stats() {
    const rows = this.all();
    const byKind = {};
    rows.forEach(b => { byKind[b.kind] = (byKind[b.kind] || 0) + 1; });
    return {
      buildings: rows.length,
      hidden: rows.filter(b => b.active === false).length,
      imported: rows.filter(b => b.source && b.source !== "hand").length,
      traced: rows.filter(b => this.ring(b)).length,
      kinds: byKind,
      bytes: JSON.stringify(rows).length
    };
  }
};
