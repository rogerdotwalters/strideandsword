/* -------------------------------------------------------------------------
   8b. The Atlas — a JSON name database for the real world around you

   Three tables, all keyed by coordinate:

     atlas_buildings  "41.88270,-87.62330" -> { key, name, kind, ... }
     atlas_streets    "41.88301,-87.62410" -> { key, name, realName, ... }
     atlas_places     "41.88412,-87.62190" -> { key, name, category, ring, ... }

   A *place* is the third thing, and it exists because a park carries no
   building tag: it is somewhere public that a dungeon or an instance can be
   attached to, categorised coarsely (park / food / civic / transit / other)
   so the spawn weights have something to address.

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
  const KEY_P = "atlas_places";

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

  const TABLE_KEYS = { buildings: KEY_B, streets: KEY_S, places: KEY_P };

  function table(which) {
    return Store.get(TABLE_KEYS[which] || KEY_B, {}) || {};
  }
  function writeTable(which, obj) {
    Store.set(TABLE_KEYS[which] || KEY_B, obj);
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

  /* ---- naming a place ---- */
  const P_GREEN = ["Green","Grove","Commons","Meadow","Glade","Orchard","Yard","Ring","Lawn","Copse"];
  const P_GREEN_ADJ = ["Whispering","Sunken","Kingsfoot","Elder","Bramble","Quiet","Wind-bent",
                       "Hollow","Faded","Thistle","Morning","Lantern"];
  const P_TRADE = ["Provisioner","Victualler","Granary","Larder","Stores","Pantry","Dry Goods",
                   "Salt House","Cellars"];
  const P_CIVIC = ["Hall","Rolls","Archive","Chapter House","Assembly","Rest","Sanctum","Court"];
  const P_TRANSIT = ["Waystation","Coachyard","Staging Post","Halt","Landing"];

  /**
   * A fantasy name for a place. Seeded on the key like a building, so the same
   * park is the same park forever. A real name, where OSM has one, seeds
   * instead — every entrance to one park then reads as the same place.
   */
  function namePlace(seed, category) {
    const r = seededRandom("place:" + seed);
    if (category === "park") {
      return "The " + pickFrom(r, P_GREEN_ADJ) + " " + pickFrom(r, P_GREEN);
    }
    if (category === "food") {
      return r() < 0.5
        ? B_PERSON[Math.floor(r() * B_PERSON.length)] + "'s " + pickFrom(r, P_TRADE)
        : "The " + pickFrom(r, B_ADJ) + " " + pickFrom(r, P_TRADE);
    }
    if (category === "civic")   return "The " + pickFrom(r, B_ADJ) + " " + pickFrom(r, P_CIVIC);
    if (category === "transit") return "The " + pickFrom(r, B_ADJ) + " " + pickFrom(r, P_TRANSIT);
    return "The " + pickFrom(r, B_ADJ) + " " + pickFrom(r, B_NOUN);
  }

  /**
   * Polygon rings go into storage, so they get thinned first. Thirty-two
   * points describe any park well enough for a point-in-polygon test, and the
   * whole Atlas has to fit in a few megabytes alongside everything else.
   */
  const RING_MAX = 32;
  function thinRing(ring) {
    if (!ring || ring.length <= RING_MAX) return ring || null;
    const step = ring.length / RING_MAX;
    const out = [];
    for (let i = 0; i < RING_MAX; i++) out.push(ring[Math.floor(i * step)]);
    out.push(ring[ring.length - 1]);
    return out;
  }

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

    /**
     * Look a place up, creating and persisting it the first time it is seen.
     * `meta.ring` is the polygon for an area; a POI mapped as a single node
     * has none, and is treated as a point with a nominal radius instead.
     */
    place(lat, lng, meta) {
      const t = table("places");
      const key = freeKey(t, lat, lng, meta && meta.osmId);
      if (t[key]) return t[key];
      const tags = (meta && meta.tags) || {};
      const { category, osmKind } = Content.placeCategory(tags);
      const realName = tags.name || null;
      const seed = realName ? "name:" + realName.toLowerCase() + ":" + category : key;
      const def = Content.PLACE_CATEGORIES[category] || Content.PLACE_CATEGORIES.other;
      const row = {
        key, coordKey: keyFor(lat, lng), latitude: +lat, longitude: +lng,
        name: namePlace(seed, category),
        category, categoryLabel: def.label, icon: def.icon,
        osmKind, realName,
        ring: thinRing(meta && meta.ring),
        area: Math.round((meta && meta.area) || 0),
        osmId: (meta && meta.osmId) || null,
        source: (meta && meta.source) || "osm",
        createdAt: nowTs()
      };
      t[key] = row;
      writeTable("places", t);
      return row;
    },

    /** Recorded places within `maxM` metres of a point, nearest first. */
    nearPlaces(lat, lng, maxM) {
      const t = table("places");
      const out = [];
      for (const k in t) {
        const d = haversine(lat, lng, t[k].latitude, t[k].longitude);
        if (d <= (maxM || 400)) out.push({ row: t[k], d });
      }
      return out.sort((a, b) => a.d - b.d);
    },

    /**
     * Which place is this point standing in or beside? A ring is tested
     * properly with point-in-polygon; a node POI falls back to a radius.
     */
    placeAt(lat, lng, nearM) {
      const t = table("places");
      let best = null;
      for (const k in t) {
        const row = t[k];
        if (row.ring && Content.pointInRing(row.ring, lat, lng)) return row;
        const d = haversine(lat, lng, row.latitude, row.longitude);
        if (d <= (nearM || 30) && (!best || d < best.d)) best = { row, d };
      }
      return best ? best.row : null;
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
      const b = table("buildings"), s = table("streets"), p = table("places");
      const named = {};
      for (const k in s) named[s[k].name] = 1;
      const byCat = {};
      for (const k in p) byCat[p[k].category] = (byCat[p[k].category] || 0) + 1;
      return { buildings: Object.keys(b).length, streetRows: Object.keys(s).length,
               streetNames: Object.keys(named).length,
               places: Object.keys(p).length, placesByCategory: byCat };
    },

    /** The whole database, shaped the way a server would return it. */
    export() {
      return {
        format: "stride-and-sword.atlas",
        version: 1,
        exportedAt: new Date().toISOString(),
        keying: "decimal degrees, 5dp, \"lat,lng\"",
        tables: { buildings: table("buildings"), streets: table("streets"),
                  places: table("places") }
      };
    },

    import(json) {
      if (!json || !json.tables) return { success: false, message: "Not an atlas file." };
      const b = Object.assign(table("buildings"), json.tables.buildings || {});
      const s = Object.assign(table("streets"), json.tables.streets || {});
      const p = Object.assign(table("places"), json.tables.places || {});
      writeTable("buildings", b);
      writeTable("streets", s);
      writeTable("places", p);
      return { success: true, buildings: Object.keys(b).length,
               streets: Object.keys(s).length, places: Object.keys(p).length };
    },

    clear() { Store.remove(KEY_B); Store.remove(KEY_S); Store.remove(KEY_P); }
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
  MAX_PLACES: 300,

  /* What counts as a public place worth attaching a dungeon to. Kept in step
     with Content.PLACE_TAGS — that decides the category, this decides what is
     even fetched. Narrow on purpose: every extra tag is more response to pull
     down and more of the 2 MB cache to fill. */
  PLACE_LEISURE: "park|garden|pitch|playground|recreation_ground|common|dog_park|" +
                 "nature_reserve|sports_centre|fitness_centre",
  PLACE_LANDUSE: "recreation_ground|village_green|forest|meadow",
  PLACE_SHOP:    "supermarket|convenience|greengrocer|bakery|butcher|deli|farm|" +
                 "department_store|mall",
  PLACE_AMENITY: "restaurant|cafe|fast_food|food_court|pub|bar|marketplace|library|" +
                 "townhall|community_centre|school|university|college|place_of_worship|" +
                 "theatre|cinema|arts_centre|hospital|parking|bus_station",
  ROAD_TYPES: "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|" +
              "service|pedestrian|footway|path|steps|cycleway|track",

  cacheKey(zone) { return "osm_cache_" + zone.zoneId; },

  query(lat, lng, radius) {
    const at = "(around:" + radius + "," + lat + "," + lng + ");";
    // `nw` rather than `nwr`: relations give multipolygons, and a park with a
    // hole in it is not worth the geometry code. A relation-mapped park is
    // usually also tagged on its outer way, so little is lost.
    return "[out:json][timeout:30];(" +
      'way["building"]' + at +
      'way["highway"~"^(' + this.ROAD_TYPES + ')$"]' + at +
      'nw["leisure"~"^(' + this.PLACE_LEISURE + ')$"]' + at +
      'nw["landuse"~"^(' + this.PLACE_LANDUSE + ')$"]' + at +
      'nw["shop"~"^(' + this.PLACE_SHOP + ')$"]' + at +
      'nw["amenity"~"^(' + this.PLACE_AMENITY + ')$"]' + at +
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

  /**
   * Turn raw Overpass elements into Atlas-registered features.
   *
   * Order matters. A supermarket is usually tagged on its own building way, so
   * it is both a building and a place — it should be registered as both, which
   * is why places are tested before the building/road chain rather than inside
   * it. A node POI has no geometry at all and is handled first.
   */
  digest(elements) {
    const buildings = [], roads = [], places = [];

    const addPlace = (lat, lng, tags, el, ring, area) => {
      if (places.length >= this.MAX_PLACES) return;
      if (!Content.isPlaceTagged(tags)) return;
      const row = Atlas.place(lat, lng, {
        tags, ring, area, osmId: (el.type || "way") + "/" + el.id
      });
      places.push({ row, ring: ring || null, area: area || 0 });
    };

    for (const el of elements) {
      const tags = el.tags || {};

      // A POI mapped as a single point: a cafe inside a building, say.
      if (el.type === "node" && isFinite(el.lat) && isFinite(el.lon)) {
        addPlace(el.lat, el.lon, tags, el, null, 0);
        continue;
      }
      if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;

      // Areas: a park, or a shop that is also its own building.
      if (Content.isPlaceTagged(tags)) {
        const ring = el.geometry.map(p => [p.lat, p.lon]);
        const c = this.centroid(el.geometry);
        addPlace(c.lat, c.lng, tags, el, ring, this.polygonArea(el.geometry));
      }

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
    return { buildings, roads, places };
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
