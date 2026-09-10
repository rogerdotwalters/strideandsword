/* -------------------------------------------------------------------------
   8b. The Atlas — a JSON name database for the real world around you

   Two tables, both keyed by coordinate:

     atlas_buildings  "41.88270,-87.62330" -> { key, name, kind, ... }
     atlas_streets    "41.88301,-87.62410" -> { key, name, realName, ... }

   Buildings are keyed by their footprint centroid, streets by the midpoint of
   the OSM way that carries them. Names are generated from a seed derived from
   the key, so the same doorway is always the same tavern — on this device, on
   a reload, and on any other device given the same coordinates.

   Streets are a special case: one real street is many OSM ways, so the fantasy
   name is seeded from the *real* street name (when there is one) rather than
   the coordinate. Every segment of "W Adams St" therefore reads as the same
   fantasy road, while each segment still gets its own row keyed by position.
   ------------------------------------------------------------------------- */
const Atlas = (function () {
  const KEY_B = "atlas_buildings";
  const KEY_S = "atlas_streets";

  /* ---- word banks ---- */
  const ST_FIRST = ["Ash","Copper","Grim","Long","Old","Silver","Thorn","Ember","Hollow","Raven",
                    "Iron","Mist","Cinder","Bram","Fen","Gallow","Quill","Amber","Stone","Wither",
                    "Kettle","Rook","Salt","Tallow","Vellum","Wren","Harrow","Marl","Pike","Bell"];
  const ST_SECOND = ["wind","gate","fall","mere","barrow","hollow","reach","watch","ford","cross",
                     "march","stead","holt","vale","bourne","wick","moor","spire","gild","haven"];
  const ST_KIND   = ["Way","Row","Lane","Mile","Path","Rise","Walk","Steps","Causeway","Crossing",
                     "Passage","Run","Close","Reach","Bend"];
  const ST_THE    = ["The Long Mile","The Crooked Mile","The Ashen Walk","The Quiet Crossing",
                    "The Pilgrim's Road","The Drover's Path","The Old Processional","The Coalway",
                    "The Lamplighter's Round","The Sunken Steps"];

  const B_ADJ  = ["Gilded","Crooked","Quiet","Weeping","Brazen","Hollow","Salted","Guttering","Patient",
                  "Wayward","Iron","Blessed","Rusted","Amber","Nameless","Drowned","Laughing","Grey",
                  "Wandering","Threadbare","Tallow","Bitter","Sable","Copper"];
  const B_NOUN = ["Ledger","Tankard","Lantern","Anvil","Bell","Key","Hound","Crown","Cask","Sparrow",
                  "Thimble","Compass","Kettle","Hearth","Reliquary","Lark","Gate","Coin","Wheel",
                  "Chandler","Cellar","Vault","Loom","Quill"];
  const B_PERSON = ["Maugrim","Ottoline","Bram","Cassilda","Hollis","Ingrid","Jory","Kestrel","Lund",
                    "Mirren","Nevin","Osric","Peregrine","Quillon","Rhosyn","Sable","Tamsin","Ulric",
                    "Varda","Wend","Yarrow","Zeph"];
  const B_PLURAL = ["Quiet Bells","Small Mercies","Long Accounts","Borrowed Hours","Nine Locks",
                    "Grey Petitions","Wintering Birds","Kept Promises","Idle Hands","Twelve Windows"];

  /* Building kinds live in Content so the map editor can offer the same
     vocabulary without pulling in the whole Atlas. */
  const KINDS = Content.BUILDING_KINDS;

  /* OSM building=* / amenity=* -> fantasy kind */
  const TAG_KIND = {
    church: "temple", cathedral: "temple", chapel: "temple", mosque: "temple",
    synagogue: "temple", temple: "temple", shrine: "temple", religious: "temple",
    school: "library", university: "library", college: "library", library: "library",
    kindergarten: "library",
    hospital: "apothecary", clinic: "apothecary", pharmacy: "apothecary",
    retail: "market", shop: "market", supermarket: "market", kiosk: "market",
    commercial: "counting", office: "counting", bank: "counting",
    industrial: "foundry", warehouse: "foundry", manufacture: "foundry", factory: "foundry",
    garage: "stable", garages: "stable", carport: "stable", parking: "stable",
    hotel: "tavern", restaurant: "tavern", bar: "tavern", pub: "tavern", cafe: "tavern",
    barn: "granary", farm: "granary", greenhouse: "granary", silo: "granary",
    civic: "guildhall", government: "guildhall", public: "guildhall", townhall: "guildhall",
    hangar: "barracks", fire_station: "barracks", police: "barracks",
    tower: "tower", water_tower: "tower", mast: "tower",
    house: "cottage", detached: "cottage", residential: "cottage", apartments: "cottage",
    bungalow: "cottage", terrace: "cottage", dormitory: "cottage", hut: "cottage",
    sports_centre: "bathhouse", swimming_pool: "bathhouse", stadium: "bathhouse"
  };

  function table(which) {
    return Store.get(which === "buildings" ? KEY_B : KEY_S, {}) || {};
  }
  function writeTable(which, obj) {
    Store.set(which === "buildings" ? KEY_B : KEY_S, obj);
  }

  /** Coordinate key. 5 decimal places ~= 1.1 m, which is finer than any GPS fix. */
  function keyFor(lat, lng) {
    return Number(lat).toFixed(5) + "," + Number(lng).toFixed(5);
  }

  /**
   * Two different features can land on the same coordinate — a street midpoint
   * sitting exactly on a crossroads, say. The key stays the coordinate; a
   * "#2" suffix distinguishes the second tenant so neither row is lost.
   */
  function freeKey(t, lat, lng, osmId) {
    const base = keyFor(lat, lng);
    if (!t[base] || !osmId || !t[base].osmId || t[base].osmId === osmId) return base;
    let n = 2;
    while (t[base + "#" + n] && t[base + "#" + n].osmId !== osmId) n++;
    return base + "#" + n;
  }

  function nameStreet(seed, realName) {
    const r = seededRandom("street:" + seed);
    if (r() < 0.14) return ST_THE[Math.floor(r() * ST_THE.length)];
    const a = ST_FIRST[Math.floor(r() * ST_FIRST.length)];
    const b = ST_SECOND[Math.floor(r() * ST_SECOND.length)];
    const k = ST_KIND[Math.floor(r() * ST_KIND.length)];
    return a + b + " " + k;
  }

  function nameBuilding(seed, kind) {
    const r = seededRandom("bldg:" + seed);
    const roll = r();
    if (roll < 0.42) {
      return "The " + B_ADJ[Math.floor(r() * B_ADJ.length)] + " " + B_NOUN[Math.floor(r() * B_NOUN.length)];
    }
    if (roll < 0.74) {
      return B_PERSON[Math.floor(r() * B_PERSON.length)] + "'s " + cap(KINDS[kind].label);
    }
    if (roll < 0.88) {
      return "House of " + B_PLURAL[Math.floor(r() * B_PLURAL.length)];
    }
    return "The " + B_ADJ[Math.floor(r() * B_ADJ.length)] + " " + cap(KINDS[kind].label);
  }

  /** Pick a fantasy kind from OSM tags, falling back to footprint area. */
  function kindFor(tags, areaM2, seed) {
    tags = tags || {};
    const candidates = [tags.building, tags.amenity, tags.shop && "shop", tags.man_made,
                        tags.leisure, tags.office && "office", tags.tourism];
    for (const c of candidates) {
      if (c && TAG_KIND[c]) return TAG_KIND[c];
    }
    const r = seededRandom("kind:" + seed);
    if (areaM2 < 90)   return r() < 0.5 ? "market" : "cottage";
    if (areaM2 < 260)  return pickFrom(r, ["cottage", "smithy", "apothecary", "tavern", "market"]);
    if (areaM2 < 900)  return pickFrom(r, ["tavern", "guildhall", "smithy", "library", "counting", "bathhouse"]);
    if (areaM2 < 3000) return pickFrom(r, ["guildhall", "granary", "foundry", "barracks", "library"]);
    return pickFrom(r, ["keep", "foundry", "granary", "barracks"]);
  }
  function pickFrom(r, arr) { return arr[Math.floor(r() * arr.length)]; }

  return {
    KINDS,
    keyFor,
    table,

    /** Look a row up, creating and persisting it the first time it is seen. */
    building(lat, lng, meta) {
      const t = table("buildings");
      const key = freeKey(t, lat, lng, meta && meta.osmId);
      if (t[key]) return t[key];
      const kind = kindFor(meta && meta.tags, (meta && meta.area) || 0, key);
      const row = {
        key, coordKey: keyFor(lat, lng), latitude: +lat, longitude: +lng,
        name: nameBuilding(key, kind),
        kind, kindLabel: KINDS[kind].label, icon: KINDS[kind].icon,
        realName: (meta && meta.tags && (meta.tags.name || meta.tags["addr:housename"])) || null,
        address: meta && meta.tags && meta.tags["addr:housenumber"]
          ? (meta.tags["addr:housenumber"] + " " + (meta.tags["addr:street"] || "")).trim() : null,
        osmId: (meta && meta.osmId) || null,
        area: Math.round((meta && meta.area) || 0),
        source: (meta && meta.source) || "osm",
        createdAt: nowTs()
      };
      t[key] = row;
      writeTable("buildings", t);
      return row;
    },

    street(lat, lng, meta) {
      const t = table("streets");
      const key = freeKey(t, lat, lng, meta && meta.osmId);
      if (t[key]) return t[key];
      const realName = (meta && meta.tags && meta.tags.name) || null;
      // Seed from the real street name so every segment shares one fantasy name.
      const seed = realName ? "name:" + realName.toLowerCase() : key;
      const row = {
        key, coordKey: keyFor(lat, lng), latitude: +lat, longitude: +lng,
        name: nameStreet(seed, realName),
        realName,
        kind: (meta && meta.tags && meta.tags.highway) || "path",
        osmId: (meta && meta.osmId) || null,
        lengthM: Math.round((meta && meta.length) || 0),
        source: (meta && meta.source) || "osm",
        createdAt: nowTs()
      };
      t[key] = row;
      writeTable("streets", t);
      return row;
    },

    /** Recorded buildings within `maxM` metres, nearest first. */
    nearBuildings(lat, lng, maxM, excludeKeys) {
      const t = table("buildings");
      const out = [];
      for (const k in t) {
        if (excludeKeys && excludeKeys.has(k)) continue;
        const d = haversine(lat, lng, t[k].latitude, t[k].longitude);
        if (d <= (maxM || 80)) out.push({ row: t[k], d });
      }
      return out.sort((a, b) => a.d - b.d);
    },

    /** Nearest recorded building within `maxM` metres, or null. */
    nearestBuilding(lat, lng, maxM, excludeKeys) {
      return this.nearBuildings(lat, lng, maxM, excludeKeys)[0] || null;
    },

    stats() {
      const b = table("buildings"), s = table("streets");
      const named = {};
      for (const k in s) named[s[k].name] = 1;
      return { buildings: Object.keys(b).length, streetRows: Object.keys(s).length,
               streetNames: Object.keys(named).length };
    },

    /** The whole database, shaped the way a server would return it. */
    export() {
      return {
        format: "stride-and-sword.atlas",
        version: 1,
        exportedAt: new Date().toISOString(),
        keying: "decimal degrees, 5dp, \"lat,lng\"",
        tables: { buildings: table("buildings"), streets: table("streets") }
      };
    },

    import(json) {
      if (!json || !json.tables) return { success: false, message: "Not an atlas file." };
      const b = Object.assign(table("buildings"), json.tables.buildings || {});
      const s = Object.assign(table("streets"), json.tables.streets || {});
      writeTable("buildings", b);
      writeTable("streets", s);
      return { success: true, buildings: Object.keys(b).length, streets: Object.keys(s).length };
    },

    clear() { Store.remove(KEY_B); Store.remove(KEY_S); }
  };
})();

/* -------------------------------------------------------------------------
   8c. OSM — real road and building geometry, drawn as a fantasy town

   Geometry comes from the Overpass API (OpenStreetMap's query service). Every
   way it returns is registered in the Atlas, so the fantasy names are stable
   and inspectable rather than being invented at render time.
   ------------------------------------------------------------------------- */
const OSM = {
  ENDPOINTS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ],
  MAX_BUILDINGS: 700,
  MAX_ROADS: 700,
  ROAD_TYPES: "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|" +
              "service|pedestrian|footway|path|steps|cycleway|track",

  cacheKey(zone) { return "osm_cache_" + zone.zoneId; },

  query(lat, lng, radius) {
    return "[out:json][timeout:30];(" +
      'way["building"](around:' + radius + "," + lat + "," + lng + ");" +
      'way["highway"~"^(' + this.ROAD_TYPES + ')$"](around:' + radius + "," + lat + "," + lng + ");" +
      ");out geom;";
  },

  /** Metric-ish area of a small polygon, via the shoelace formula. */
  polygonArea(pts) {
    if (!pts || pts.length < 3) return 0;
    const lat0 = toRad(pts[0].lat);
    const mx = 111320 * Math.cos(lat0), my = 110540;
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].lon * mx, yi = pts[i].lat * my;
      const xj = pts[j].lon * mx, yj = pts[j].lat * my;
      a += xj * yi - xi * yj;
    }
    return Math.abs(a / 2);
  },

  centroid(pts) {
    let la = 0, lo = 0;
    pts.forEach(p => { la += p.lat; lo += p.lon; });
    return { lat: la / pts.length, lng: lo / pts.length };
  },

  wayLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    return d;
  },

  async fetchAround(lat, lng, radius) {
    const body = "data=" + encodeURIComponent(this.query(lat, lng, radius));
    for (const url of this.ENDPOINTS) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 25000);
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body, signal: ctl.signal
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const json = await res.json();
        if (json && json.elements) return { success: true, elements: json.elements, endpoint: url };
      } catch (e) {
        console.warn("[OSM] " + url + " failed:", e && e.message);
      }
    }
    return { success: false, message: "No Overpass endpoint answered." };
  },

  /** Turn raw Overpass elements into Atlas-registered features. */
  digest(elements) {
    const buildings = [], roads = [];
    for (const el of elements) {
      if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
      const tags = el.tags || {};
      if (tags.building && buildings.length < this.MAX_BUILDINGS) {
        const area = this.polygonArea(el.geometry);
        if (area < 12) continue;                 // sheds, bins, map noise
        const c = this.centroid(el.geometry);
        const row = Atlas.building(c.lat, c.lng, { tags, area, osmId: "way/" + el.id });
        buildings.push({ row, ring: el.geometry.map(p => [p.lat, p.lon]), area });
      } else if (tags.highway && roads.length < this.MAX_ROADS) {
        const mid = el.geometry[Math.floor(el.geometry.length / 2)];
        const row = Atlas.street(mid.lat, mid.lon, {
          tags, osmId: "way/" + el.id, length: this.wayLength(el.geometry)
        });
        roads.push({ row, line: el.geometry.map(p => [p.lat, p.lon]), highway: tags.highway });
      }
    }
    return { buildings, roads };
  },

  /* Road weights by class — motorways read as great roads, paths as tracks. */
  roadStyle(highway, zoom) {
    const major = { motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5 };
    const minor = { residential: 4, unclassified: 4, living_street: 4, pedestrian: 3.5, service: 3 };
    const trail = { footway: 2, path: 2, steps: 2, cycleway: 2, track: 2.5 };
    // Stroke width is in screen pixels, so it has to grow with zoom or a road
    // reads as a hairline once you're in close enough to walk a building.
    const z = clamp((zoom - 15) * 0.30 + 1, 0.7, 3.6);
    if (major[highway]) return { weight: major[highway] * z, color: "#c9a869", opacity: .75, dash: null, cls: "rd-major" };
    if (minor[highway]) return { weight: minor[highway] * z, color: "#9d8a63", opacity: .62, dash: null, cls: "rd-minor" };
    return { weight: (trail[highway] || 2) * z, color: "#7d8a6a", opacity: .55, dash: "5 6", cls: "rd-trail" };
  }
};
