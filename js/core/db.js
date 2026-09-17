"use strict";
/* -------------------------------------------------------------------------
   DB — the seeded JSON database.

   Everything the game starts with lives in data/*.json as plain, editable
   files. Nothing is embedded in the code. On boot we fetch them and seed any
   table that is still empty; a table you have edited is never overwritten,
   so your work always wins over the seed.

   This needs http — fetch() cannot read data/ over file://, which is the same
   reason geolocation needs a real origin. Run `npm run serve`.
   ------------------------------------------------------------------------- */
const DB = {
  BASE: "data/",

  /** Table name -> file. The content tables share their names with Content. */
  FILES: {
    config:    "config.json",
    items:     "items.json",
    monsters:  "monsters.json",
    loot:      "loot.json",
    spawns:    "spawns.json",
    locations: "locations.json",
    dungeons:  "dungeons.json",
    instances: "instances.json",
    quests:    "quests.json",
    players:   "players.json",
    /* Not a content table — the spawn weights, read straight off DB.raw by
       Placement. Loaded here so it arrives with everything else. */
    spawnRules: "spawn-rules.json",
    /* Also not a content table: hand-drawn scenery, in its own file so it can
       be edited elsewhere and uploaded whole. See js/world/shapes.js. */
    shapes:     "shapes.json",
    /* The ground itself: terrain regions that decide what spawns on them.
       Its own file for the same reason shapes have one — it is authored
       elsewhere (a GIS, the importer) and uploaded whole. */
    regions:    "regions.json",
    /* The places on the map and the people who work out of them. GeoJSON
       like regions, for the same reason: it is authored in Google Earth as
       often as it is authored here. See js/world/buildings.js. */
    buildings:  "buildings.json"
  },

  raw: {},              // what the files actually held, after load
  problems: [],         // anything that would not load, in plain words

  async load() {
    this.raw = {}; this.problems = [];
    const names = Object.keys(this.FILES);
    await Promise.all(names.map(async (name) => {
      const url = this.BASE + this.FILES[name];
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        this.raw[name] = await res.json();
      } catch (e) {
        this.problems.push(url + " — " + (e && e.message ? e.message : e));
      }
    }));
    return this.raw;
  },

  /**
   * Seed a table only when it is empty. `force` wipes and re-seeds, which is
   * what the dev panel's "Reseed from JSON" does.
   */
  seedTable(name, force) {
    const rows = this.raw[name];
    if (!Array.isArray(rows)) return 0;
    // "Has a table" rather than "has rows in it" — see Content.exists.
    if (!force && Content.exists(name)) return 0;
    Content.replaceAll(name, JSON.parse(JSON.stringify(rows)));
    return rows.length;
  },

  /**
   * Test credentials, so there is something to log in as out of the box.
   *
   * The row is written the way the local backend writes one — same shape, same
   * hash — because an account seeded any other way is one you could never
   * actually log in as. Passwords in players.json are plain text on purpose:
   * the file is a stand-in for a real accounts service and everything in it is
   * throwaway.
   */
  seedPlayers(force) {
    const rows = this.raw.players;
    if (!Array.isArray(rows)) return 0;
    if (typeof Local === "undefined" || typeof Local.hashPassword !== "function") return 0;
    const accounts = Store.get(K.accounts, {}) || {};
    let made = 0;
    rows.forEach(p => {
      if (!p || !p.username || !p.password) return;
      const existing = Object.values(accounts).find(a =>
        (a.username || "").toLowerCase() === String(p.username).toLowerCase());
      if (existing && !force) return;
      const id = (existing && existing.userId) || p.userId || uid("usr");
      accounts[id] = {
        userId: id, username: p.username, email: p.email || "",
        passwordHash: Local.hashPassword(p.password),
        seeded: true, createdAt: nowTs(), lastLogin: null
      };
      made++;
    });
    if (made) Store.set(K.accounts, accounts);
    return made;
  },

  /**
   * Shapes are their own table with their own key, so they seed on their own
   * terms — and on the same rule as everything else: a table that has been
   * written is never overwritten, so a file you emptied stays empty.
   */
  seedShapes(force) {
    const rows = this.raw.shapes;
    if (typeof Shapes === "undefined" || !Array.isArray(rows)) return 0;
    if (!force && Shapes.exists()) return 0;
    Shapes.replaceAll(JSON.parse(JSON.stringify(rows)));
    return rows.length;
  },

  seedRegions(force) {
    const rows = this.raw.regions;
    if (typeof Regions === "undefined") return 0;
    // The file is a GeoJSON FeatureCollection, not a row array.
    const feats = rows && (rows.features || (Array.isArray(rows) ? rows : null));
    if (!Array.isArray(feats)) return 0;
    if (!force && Regions.exists()) return 0;
    const out = [];
    feats.forEach(f => Regions.fromFeature(f).forEach(r => out.push(r)));
    Regions.replaceAll(out);
    return out.length;
  },

  seedBuildings(force) {
    const rows = this.raw.buildings;
    if (typeof Buildings === "undefined") return 0;
    const feats = rows && (rows.features || (Array.isArray(rows) ? rows : null));
    if (!Array.isArray(feats)) return 0;
    if (!force && Buildings.exists()) return 0;
    const out = [];
    feats.forEach(f => { const b = Buildings.fromFeature(f); if (b) out.push(b); });
    Buildings.replaceAll(out);
    return out.length;
  },

  seedAll(force) {
    const out = {};
    if (this.raw.config && (force || !Store.get(Content.KEYS.config, null))) {
      Content.saveConfig(JSON.parse(JSON.stringify(this.raw.config)));
      out.config = 1;
    }
    ["items", "monsters", "loot", "spawns", "locations", "dungeons", "instances", "quests"]
      .forEach(n => { out[n] = this.seedTable(n, force); });
    out.players = this.seedPlayers(force);
    out.shapes = this.seedShapes(force);
    out.regions = this.seedRegions(force);
    out.buildings = this.seedBuildings(force);
    return out;
  },

  /**
   * Seed content carries placeholder coordinates. The first time a zone is
   * anchored we shift every seeded row by the same offset, so the sample
   * locations, dungeons and instances land around wherever you actually are
   * rather than in a car park in Chicago.
   */
  rehomeSeed(zone, at) {
    if (!zone || Store.get("seed_rehomed", null)) return 0;
    const anchor = this.anchorOfSeed();
    if (!anchor) return 0;

    /* Shift relative to where the player actually is, not the zone's centre.
       On a grid those are different things — a chunk's centre is a grid line
       and you can be 250 m from it — and the samples are only useful if they
       land somewhere you would plausibly walk. */
    const here = at && isFinite(at.latitude)
      ? at : { latitude: zone.centerLatitude, longitude: zone.centerLongitude };
    const dLat = here.latitude - anchor.lat, dLng = here.longitude - anchor.lng;

    /* And never underfoot. A sample landing 30 m away opens its own dialog the
       moment the game starts, which is not a welcome. */
    const MIN_M = 90, PUSH_M = 130;
    let moved = 0;
    [["locations", "locationId"], ["dungeons", "dungeonId"], ["instances", "instanceId"]]
      .forEach(([table, idKey]) => {
        const rows = Content.list(table);
        rows.forEach(r => {
          if (!/^(loc|dgn|inst)_seed_/.test(r[idKey] || "")) return;
          r.latitude += dLat; r.longitude += dLng;
          const d = haversine(here.latitude, here.longitude, r.latitude, r.longitude);
          if (d < MIN_M) {
            const bearing = (moved * 67) % 360;   // fan them out rather than stack
            const p = projectPoint(here.latitude, here.longitude, PUSH_M, bearing);
            r.latitude = p.latitude; r.longitude = p.longitude;
          }
          r.zoneId = zone.zoneId;
          moved++;
        });
        Content.replaceAll(table, rows);
      });

    /* Buildings are not a Content table, but they are seeded from a file with
       the same placeholder coordinates, so they move with everything else —
       footprint and all, or a traced outline would be left behind in
       Chicago. They are allowed to sit closer than MIN_M: a shop you can see
       from where you start is a welcome, not an ambush. */
    if (typeof Buildings !== "undefined" && Buildings.exists()) {
      const bs = Buildings.all();
      let touched = 0;
      bs.forEach(b => {
        if (!/^bld_seed_/.test(b.buildingId || "")) return;
        b.latitude += dLat; b.longitude += dLng;
        (b.footprint || []).forEach(p => { p[0] += dLat; p[1] += dLng; });
        touched++; moved++;
      });
      if (touched) Buildings.replaceAll(bs);
    }

    Store.set("seed_rehomed", { at: nowTs(), zoneId: zone.zoneId });
    return moved;
  },

  /**
   * Where the seed files think they are: the centre of everything in them, not
   * the first row. Anchoring on the first row drops that one location exactly
   * on top of the player, which looks like a bug even though it isn't.
   */
  anchorOfSeed() {
    const rows = [].concat(this.raw.locations || [], this.raw.dungeons || [], this.raw.instances || [])
      .filter(r => isFinite(r.latitude) && isFinite(r.longitude));
    if (!rows.length) return null;
    const lat = rows.reduce((a, r) => a + r.latitude, 0) / rows.length;
    const lng = rows.reduce((a, r) => a + r.longitude, 0) / rows.length;
    return { lat, lng };
  },

  /** Hand the whole database back as one JSON blob, for saving to disk. */
  exportAll() {
    const out = { format: "stride-and-sword.db", version: 1, exportedAt: new Date().toISOString() };
    ["items", "monsters", "loot", "spawns", "locations", "dungeons", "instances", "quests"]
      .forEach(n => { out[n] = Content.list(n); });
    out.config = Content.config();
    return out;
  }
};
