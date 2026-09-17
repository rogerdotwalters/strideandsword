"use strict";
/* -------------------------------------------------------------------------
   8g. Regions — the ground itself, and what it decides lives on it.

   A chunk of the world is currently the same everywhere: the generator scores
   buildings and scatters sites, and any monster that fits the difficulty can
   turn up on any of them. That is fine for an office block and wrong for a
   county. A creek bottom should hold different things from a hayfield, and
   the difference should come from the actual ground, not from a die roll.

   A **region** is a polygon with a terrain class. Stand inside one and the
   game rolls its encounters from that terrain's spawn table. Nothing else
   about the world changes: the same sites are generated in the same places by
   the same rules — only what is waiting on them differs.

   ============================== WHERE THEY COME FROM =====================

   Regions are authored, not derived, because the interesting ones are not in
   OpenStreetMap at all: soil class, floodplain, "the low ground behind the
   school that is always wet". Three ways in, all the same file:

     tools/mapimport.js   real OSM water and green cover for a named place,
                          classified into terrain and written as GeoJSON
     regions.html         draw, reshape and label them by hand
     any GIS             it is plain GeoJSON — QGIS, geojson.io, a shapefile
                          conversion, whatever you already use

   ================================= THE FORMAT ============================

   **GeoJSON on disk, [lat, lng] in memory.** GeoJSON is the only format the
   rest of the world agrees on, so the file has to be GeoJSON — but every
   other geometry in this project is [lat, lng] (Leaflet's order), and one
   module quietly using the opposite order is how you get a map of Somalia.
   So the conversion happens at exactly two functions, `fromFeature` and
   `toFeature`, and nowhere else.

       localStorage  "region_defs"        the live table
       data/regions.json                  what a fresh install starts with
       export                             a GeoJSON FeatureCollection

   ================================ OVERLAPPING ============================

   Regions overlap constantly — a pond inside a park inside a floodplain — so
   `at()` has to choose. Higher `priority` wins; on a tie the **smaller** one
   wins, because the small polygon is the more specific statement about that
   patch of ground. The pond beats the park that contains it without anybody
   having to set a number.
   ------------------------------------------------------------------------- */
const Regions = {
  KEY: "region_defs",
  FORMAT: "stride-and-sword.regions",
  VERSION: 1,

  /* The terrain classes. Deliberately few: this is a vocabulary the importer,
     the editor, the spawn tables and the player all have to share, and a
     hundred soil series would be unlearnable. Each names the spawn table it
     rolls from by default — an individual region can override it. */
  TERRAINS: [
    { key: "water",  name: "River & lake", icon: "🌊", table: "sp_water",
      stroke: "#4a8fd4", fill: "#17314a",
      blurb: "Running water, standing water, and the banks of both." },
    { key: "marsh",  name: "Marsh & fen",  icon: "🥾", table: "sp_marsh",
      stroke: "#5f9e86", fill: "#1b3a30",
      blurb: "Wetland and floodplain — ground that gives underfoot." },
    { key: "wood",   name: "Woodland",     icon: "🌲", table: "sp_wood",
      stroke: "#54b37a", fill: "#1f3a2b",
      blurb: "Forest, scrub and old orchard." },
    { key: "meadow", name: "Meadow & park", icon: "🌾", table: "sp_meadow",
      stroke: "#9cc25a", fill: "#2c3a1c",
      blurb: "Grass, parkland and pasture." },
    { key: "plain",  name: "Open field",   icon: "🌱", table: "sp_plain",
      stroke: "#d0b45e", fill: "#3a3318",
      blurb: "Farmland and open ground." },
    { key: "rock",   name: "Rock & scarp", icon: "🪨", table: "sp_rock",
      stroke: "#8b93a6", fill: "#2f3542",
      blurb: "Quarry, cliff, bare stone and spoil heap." },
    { key: "waste",  name: "Blighted",     icon: "☠️", table: "sp_waste",
      stroke: "#a76fd4", fill: "#33224a",
      blurb: "Sidings, tips and anything left to rot." },
    { key: "town",   name: "Built-up",     icon: "🏘️", table: "sp_town",
      stroke: "#c08a2e", fill: "#3a2d12",
      blurb: "Streets and buildings — what you get where nothing is drawn." }
  ],

  /** The terrain a key means, falling back to built-up rather than to nothing. */
  terrain(key) {
    return this.TERRAINS.find(t => t.key === key) ||
           this.TERRAINS[this.TERRAINS.length - 1];
  },

  /* --------------------------------------------------------- classification
     Real map tags → a terrain class. One table, used by the editor's "import
     what is here" button and by tools/mapimport.js, which loads this very
     file rather than keeping a second copy that would drift from it.

     Ordered: the first rule that matches wins, so water beats the park it
     sits in and wetland beats the wood growing out of it. */
  CLASSIFY: [
    { terrain: "water",  tags: { natural: ["water", "spring", "bay", "strait"],
                                 waterway: ["riverbank", "dock", "canal", "river", "stream"],
                                 landuse: ["reservoir", "basin"], water: "*" } },
    { terrain: "marsh",  tags: { natural: ["wetland", "marsh", "mud", "shoal", "beach"],
                                 landuse: ["salt_pond"] } },
    { terrain: "wood",   tags: { natural: ["wood", "scrub", "heath", "tree_row"],
                                 landuse: ["forest", "orchard", "vineyard"],
                                 leisure: ["nature_reserve"] } },
    { terrain: "rock",   tags: { natural: ["bare_rock", "scree", "cliff", "rock", "sand", "sinkhole"],
                                 landuse: ["quarry"] } },
    { terrain: "waste",  tags: { landuse: ["brownfield", "landfill", "industrial", "railway",
                                           "military", "construction"],
                                 man_made: ["works", "wastewater_plant"] } },
    { terrain: "meadow", tags: { leisure: ["park", "garden", "golf_course", "pitch", "common",
                                           "recreation_ground", "dog_park"],
                                 landuse: ["grass", "meadow", "village_green", "cemetery",
                                           "recreation_ground", "allotments"] } },
    { terrain: "plain",  tags: { landuse: ["farmland", "farmyard", "greenhouse_horticulture",
                                           "plant_nursery", "field"] } },
    { terrain: "town",   tags: { landuse: ["residential", "commercial", "retail"],
                                 place: ["neighbourhood", "suburb", "quarter"] } }
  ],

  /**
   * Which terrain a set of OSM tags is, or "" for anything that is not
   * ground — a building, a road, a bench. "" matters: the importer must drop
   * those rather than file them under "built-up" and bury the map in boxes.
   */
  classify(tags) {
    if (!tags) return "";
    if (tags.building || tags.highway || tags.amenity === "parking") return "";
    for (const rule of this.CLASSIFY) {
      for (const key in rule.tags) {
        const want = rule.tags[key], have = tags[key];
        if (!have) continue;
        if (want === "*" || (Array.isArray(want) && want.indexOf(have) >= 0)) return rule.terrain;
      }
    }
    return "";
  },

  /* ------------------------------------------------------------------ table */

  all() {
    const rows = Store.get(this.KEY, null);
    return Array.isArray(rows) ? rows : [];
  },
  list(includeHidden) {
    const rows = this.all();
    return includeHidden ? rows : rows.filter(r => r.active !== false);
  },
  get(id) { return this.all().find(r => r.regionId === id) || null; },
  replaceAll(rows) {
    Store.set(this.KEY, Array.isArray(rows) ? rows : []);
    return this.all();
  },
  exists() { return Array.isArray(Store.get(this.KEY, null)); },
  clear() { Store.set(this.KEY, []); },

  save(region) {
    if (!region) return null;
    const rows = this.all();
    region.lastModified = nowTs();
    if (!region.regionId) {
      region.regionId = uid("rg");
      region.createdAt = nowTs();
      rows.push(region);
    } else {
      const i = rows.findIndex(r => r.regionId === region.regionId);
      if (i < 0) rows.push(region); else rows[i] = region;
    }
    Store.set(this.KEY, rows);
    return region;
  },

  remove(id) {
    const rows = this.all().filter(r => r.regionId !== id);
    Store.set(this.KEY, rows);
    return rows;
  },

  /* ------------------------------------------------------------------ making */

  blank(terrainKey, rings) {
    const t = this.terrain(terrainKey);
    return {
      regionId: null,
      name: t.name,
      terrain: t.key,
      /* Rings, not a ring: the first is the outline and any after it are
         holes. An island in a lake and a copse in a field are the same shape
         problem, and GeoJSON polygons are already this shape. */
      rings: (rings || []).map(r => r.map(p => [+p[0], +p[1]])),
      spawnTableId: "",        // "" = whatever the terrain says
      priority: 0,
      difficulty: 0,           // nudges what the table rolls
      source: "hand",          // hand | osm | import
      sourceId: "",            // the OSM id, when it came from one
      notes: "",
      active: true,
      createdAt: nowTs(), lastModified: nowTs()
    };
  },

  /* ---------------------------------------------------------------- geometry */

  rings(region) { return (region && region.rings) || []; },
  outer(region) { return this.rings(region)[0] || []; },

  bounds(region) {
    const pts = this.outer(region);
    if (!pts.length) return null;
    let s = pts[0][0], n = s, w = pts[0][1], e = w;
    pts.forEach(p => {
      s = Math.min(s, p[0]); n = Math.max(n, p[0]);
      w = Math.min(w, p[1]); e = Math.max(e, p[1]);
    });
    return { south: s, north: n, west: w, east: e };
  },

  centroid(region) {
    const pts = this.outer(region);
    if (!pts.length) return null;
    let la = 0, ln = 0;
    pts.forEach(p => { la += p[0]; ln += p[1]; });
    return { latitude: la / pts.length, longitude: ln / pts.length };
  },

  /**
   * Rough area in square metres — the shoelace formula in a local metre frame.
   *
   * Only ever compared against other regions' areas, to decide which of two
   * overlapping ones is the more specific, so a few percent of projection
   * error at the edge of a county costs nothing.
   */
  areaM2(region) {
    const pts = this.outer(region);
    if (pts.length < 3) return 0;
    const c = this.centroid(region);
    const kx = 111320 * Math.cos(toRad(c.latitude)), ky = 110540;
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = (pts[i][1] - c.longitude) * kx, yi = (pts[i][0] - c.latitude) * ky;
      const xj = (pts[j][1] - c.longitude) * kx, yj = (pts[j][0] - c.latitude) * ky;
      a += xj * yi - xi * yj;
    }
    return Math.abs(a / 2);
  },

  /** Longest span in metres, for the editor's table. */
  sizeM(region) {
    const b = this.bounds(region);
    if (!b) return 0;
    return Math.round(Math.max(haversine(b.south, b.west, b.north, b.west),
                               haversine(b.south, b.west, b.south, b.east)));
  },

  /** Inside the outline and outside every hole. */
  contains(region, lat, lng) {
    const rings = this.rings(region);
    if (!rings.length || rings[0].length < 3) return false;
    if (!Content.pointInRing(rings[0], lat, lng)) return false;
    for (let i = 1; i < rings.length; i++) {
      if (rings[i].length > 2 && Content.pointInRing(rings[i], lat, lng)) return false;
    }
    return true;
  },

  /* ------------------------------------------------------------- the lookup */

  /** Every region this point is inside, most specific first. */
  allAt(lat, lng) {
    return this.list()
      .filter(r => this.contains(r, lat, lng))
      .sort((a, b) => ((+b.priority || 0) - (+a.priority || 0)) ||
                      (this.areaM2(a) - this.areaM2(b)));
  },

  /** The one that decides. Null means nothing is drawn here. */
  at(lat, lng) { return this.allAt(lat, lng)[0] || null; },

  /** The terrain key here — "town" where nothing is drawn, never nothing. */
  terrainAt(lat, lng) {
    const r = this.at(lat, lng);
    return r ? r.terrain : "town";
  },

  /**
   * The spawn table for this ground, or "" if that table does not exist.
   *
   * The empty string matters: a region naming a table nobody authored must
   * fall through to the game's ordinary picking rather than produce an
   * encounter with no monsters in it.
   */
  tableAt(lat, lng) {
    const r = this.at(lat, lng);
    const id = r ? (r.spawnTableId || this.terrain(r.terrain).table) : "";
    if (!id || typeof Content === "undefined") return "";
    return Content.get("spawns", id) ? id : "";
  },

  /** What a region adds to a site's difficulty. Blighted ground is worse. */
  difficultyAt(lat, lng) {
    const r = this.at(lat, lng);
    return r ? (+r.difficulty || 0) : 0;
  },

  /** Regions worth drawing near a point — bounds test first, it is cheap. */
  near(lat, lng, radiusM) {
    const r = +radiusM || 800;
    const dLat = r / 110540, dLng = r / (111320 * Math.cos(toRad(lat)) || 1);
    return this.list().filter(x => {
      const b = this.bounds(x);
      return b && b.south - dLat <= lat && lat <= b.north + dLat &&
                  b.west - dLng <= lng && lng <= b.east + dLng;
    });
  },

  styleOf(region) {
    const t = this.terrain(region.terrain);
    return {
      color: t.stroke, weight: 1.5, opacity: 0.55,
      fillColor: t.fill, fillOpacity: 0.18,
      dashArray: region.source === "hand" ? null : "6 5",
      interactive: false, lineJoin: "round"
    };
  },

  /* --------------------------------------------------------------- GeoJSON
     The two functions that know about [lng, lat]. Nothing else may. */

  /** A region as a GeoJSON Feature. */
  toFeature(region) {
    const rings = this.rings(region).map(r => {
      const out = r.map(p => [+p[1], +p[0]]);          // [lat,lng] → [lng,lat]
      // GeoJSON wants the ring closed; we store it open, as Leaflet does.
      if (out.length && (out[0][0] !== out[out.length - 1][0] ||
                         out[0][1] !== out[out.length - 1][1])) out.push(out[0].slice());
      return out;
    });
    return {
      type: "Feature",
      id: region.regionId || undefined,
      properties: {
        name: region.name, terrain: region.terrain,
        spawnTableId: region.spawnTableId || "", priority: +region.priority || 0,
        difficulty: +region.difficulty || 0,
        source: region.source || "hand", sourceId: region.sourceId || "",
        notes: region.notes || "", active: region.active !== false
      },
      geometry: { type: "Polygon", coordinates: rings }
    };
  },

  /**
   * A GeoJSON Feature as a region — or several, for a MultiPolygon.
   *
   * Anything that is not an area is dropped rather than guessed at: a river
   * drawn as a LineString has no inside, and the importer is the right place
   * to decide how wide a creek is, not this.
   */
  fromFeature(feature) {
    if (!feature || !feature.geometry) return [];
    const p = feature.properties || {};
    /* One file can hold both halves of a survey — the ground and the places
       standing on it — so a feature that says it is a building is left for
       `Buildings.import`. Without this, a traced shopfront would also become
       a 12 m region of woodland. */
    if (p.feature === "building") return [];
    const polys = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates]
                : feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates
                : [];
    return polys.map(rings => {
      const conv = rings.map(r => {
        const out = r.map(c => [+c[1], +c[0]]);        // [lng,lat] → [lat,lng]
        if (out.length > 3 && out[0][0] === out[out.length - 1][0] &&
            out[0][1] === out[out.length - 1][1]) out.pop();
        return out;
      }).filter(r => r.length > 2);
      if (!conv.length) return null;
      const r = this.blank(p.terrain, conv);
      r.regionId = (polys.length === 1 && feature.id) ? String(feature.id) : uid("rg");
      if (p.name) r.name = String(p.name);
      r.spawnTableId = p.spawnTableId || "";
      r.priority = +p.priority || 0;
      r.difficulty = +p.difficulty || 0;
      r.source = p.source || "import";
      r.sourceId = p.sourceId || "";
      r.notes = p.notes || "";
      r.active = p.active !== false;
      return r;
    }).filter(Boolean);
  },

  export() {
    return {
      type: "FeatureCollection",
      /* Not part of the spec, and harmless: every GeoJSON reader ignores
         members it does not know, and this is how the file says what it is. */
      format: this.FORMAT, version: this.VERSION,
      exportedAt: new Date().toISOString(),
      features: this.all().map(r => this.toFeature(r))
    };
  },

  /** Merge a FeatureCollection in, replacing anything with an id we hold. */
  import(doc, replace) {
    const feats = doc && (doc.features || (doc.type === "Feature" ? [doc] : null));
    if (!Array.isArray(feats)) return { success: false, message: "That file has no features in it." };
    const rows = [];
    feats.forEach(f => this.fromFeature(f).forEach(r => rows.push(r)));
    if (!rows.length) return { success: false, message: "No polygons in that file — lines and points are not regions." };
    if (replace) { this.replaceAll(rows); return { success: true, added: rows.length, updated: 0 }; }
    const mine = this.all();
    const byId = {}, bySource = {};
    mine.forEach((r, i) => {
      byId[r.regionId] = i;
      if (r.sourceId) bySource[r.sourceId] = i;
    });
    let added = 0, updated = 0;
    rows.forEach(r => {
      /* Matched by id first, then by where it came from. The second half is
         what makes re-importing an edited Google Earth file or a re-run of
         the map importer update the same rows instead of laying a second copy
         of the county on top of the first — KML carries no ids of its own. */
      const at = (r.regionId && byId[r.regionId] != null) ? byId[r.regionId]
               : (r.sourceId && bySource[r.sourceId] != null) ? bySource[r.sourceId] : -1;
      if (at >= 0) {
        r.regionId = mine[at].regionId;      // keep the id already in play
        mine[at] = r; updated++;
      } else { mine.push(r); added++; }
    });
    Store.set(this.KEY, mine);
    return { success: true, added, updated };
  },

  stats() {
    const rows = this.all();
    const byTerrain = {};
    rows.forEach(r => { byTerrain[r.terrain] = (byTerrain[r.terrain] || 0) + 1; });
    return {
      regions: rows.length,
      hidden: rows.filter(r => r.active === false).length,
      imported: rows.filter(r => r.source && r.source !== "hand").length,
      terrains: byTerrain,
      bytes: JSON.stringify(rows).length
    };
  }
};
