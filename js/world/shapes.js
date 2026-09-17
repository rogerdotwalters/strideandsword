"use strict";
/* -------------------------------------------------------------------------
   8d. Shapes — hand-drawn fantasy buildings, in their own database.

   The generated town is real OSM geometry renamed and restyled: it is the
   right shape but it is nobody's design. This is the other half — buildings
   you draw yourself, over the real map, and keep in a file of your own.

   WHY ITS OWN TABLE AND ITS OWN FILE

   Everything else in data/ is game content: monsters, loot, the places the
   spawner uses. Shapes are scenery, they are yours, and they are the thing
   most likely to be edited somewhere else and uploaded — so they live in one
   flat table under one key, export as one document, and nothing else in the
   game writes to them.

       localStorage  "shape_defs"          the live table
       data/shapes.json                    what a fresh install starts with
       export        stride-and-sword.shapes v1

   GEOMETRY

   A shape is a list of [lat, lng] points and how to paint them. Two kinds:

       polygon   closed, filled — a building, a courtyard, a pond
       line      open — a wall, a bridge, a path

   Real coordinates, not pixels or metres-from-something, so a shape sits on
   the ground it was drawn on at every zoom and needs no projection of its
   own. Moving, scaling and rotating all work on the points directly, about
   the shape's own centroid, which is what makes "drag it, then make it a bit
   bigger" behave the way a person expects.
   ------------------------------------------------------------------------- */
const Shapes = {
  KEY: "shape_defs",
  FORMAT: "stride-and-sword.shapes",
  VERSION: 1,

  /* A palette worth having to hand: the game's own materials, so a drawn
     building sits beside a generated one without shouting. */
  PALETTE: [
    { name: "Stone",   stroke: "#8b93a6", fill: "#3b4354" },
    { name: "Timber",  stroke: "#9c6d3f", fill: "#4a3527" },
    { name: "Gold",    stroke: "#e0a33e", fill: "#5c441a" },
    { name: "Blood",   stroke: "#c8453c", fill: "#4a1f1c" },
    { name: "Moss",    stroke: "#54b37a", fill: "#1f3a2b" },
    { name: "Water",   stroke: "#4a8fd4", fill: "#17314a" },
    { name: "Arcane",  stroke: "#a76fd4", fill: "#33224a" },
    { name: "Ash",     stroke: "#6b7a92", fill: "#232c3d" }
  ],

  /* ------------------------------------------------------------------ table */

  all() {
    const rows = Store.get(this.KEY, null);
    return Array.isArray(rows) ? rows : [];
  },
  /** Every shape, or only the live ones. */
  list(includeHidden) {
    const rows = this.all();
    return includeHidden ? rows : rows.filter(s => s.active !== false);
  },
  get(id) { return this.all().find(s => s.shapeId === id) || null; },
  replaceAll(rows) {
    Store.set(this.KEY, Array.isArray(rows) ? rows : []);
    return this.all();
  },
  /** Has this table ever been written? Same test DB.seedTable uses. */
  exists() { return Array.isArray(Store.get(this.KEY, null)); },

  save(shape) {
    if (!shape) return null;
    const rows = this.all();
    shape.lastModified = nowTs();
    if (!shape.shapeId) {
      shape.shapeId = uid("shp");
      shape.createdAt = nowTs();
      rows.push(shape);
    } else {
      const i = rows.findIndex(s => s.shapeId === shape.shapeId);
      if (i < 0) rows.push(shape); else rows[i] = shape;
    }
    Store.set(this.KEY, rows);
    return shape;
  },

  remove(id) {
    const rows = this.all().filter(s => s.shapeId !== id);
    Store.set(this.KEY, rows);
    return rows;
  },

  clear() { Store.set(this.KEY, []); },

  /* ------------------------------------------------------------------ making */

  blank(kind, points) {
    const closed = kind !== "line";
    const paint = this.PALETTE[0];
    return {
      shapeId: null,
      name: closed ? "New building" : "New line",
      kind: closed ? "polygon" : "line",
      points: (points || []).map(p => [+p[0], +p[1]]),
      stroke: paint.stroke, strokeWidth: 2, strokeOpacity: 0.95,
      fill: paint.fill, fillOpacity: closed ? 0.35 : 0,
      dash: "",
      z: 0,                       // higher draws on top
      /* Scenery, or a territory something lives in. A zone is the same polygon
         drawn with the same tool — only what it *means* differs, which is why
         this is a field rather than a second kind of shape with its own
         editor. See js/world/denizens.js. */
      purpose: "scenery",         // scenery | zone
      zoneKind: "creature",       // creature | character
      count: 2,                   // how many creatures live here
      spawnTableId: "",           // which ones
      npcName: "", npcIcon: "",   // for a character
      npcPortrait: "",            // …and the picture inside their token
      questId: "",                // a character who hands out work
      roams: "zone",              // zone | place | world
      difficulty: 0,              // nudges what lives here
      osmId: "",                  // set when imported from real geometry
      notes: "",
      active: true,
      createdAt: nowTs(), lastModified: nowTs()
    };
  },

  /**
   * A real OSM way, as an editable shape.
   *
   * This is the "rough starting point": the building is already the right
   * shape and in the right place, so the work is restyling and reshaping it
   * rather than tracing it by eye. `osmId` is kept so the same footprint is
   * not imported twice.
   */
  fromOsmWay(el, name) {
    const pts = (el.geometry || []).filter(p => isFinite(p.lat) && isFinite(p.lon))
                                   .map(p => [p.lat, p.lon]);
    if (pts.length < 2) return null;
    // Overpass closes a way by repeating its first point; a polygon does not
    // need the repeat and an editable vertex on top of another is a nuisance.
    const first = pts[0], last = pts[pts.length - 1];
    if (pts.length > 3 && first[0] === last[0] && first[1] === last[1]) pts.pop();
    const isArea = pts.length > 2 && ((el.tags || {}).building || (el.tags || {}).leisure ||
                                      (el.tags || {}).landuse || (el.tags || {}).shop ||
                                      (el.tags || {}).amenity);
    const s = this.blank(isArea ? "polygon" : "line", pts);
    s.name = name || (el.tags && el.tags.name) || (isArea ? "Building" : "Way");
    s.osmId = (el.type || "way") + "/" + el.id;
    if (!isArea) { s.strokeWidth = 3; s.fillOpacity = 0; }
    return s;
  },

  /* ---------------------------------------------------------------- geometry */

  points(shape) { return (shape && shape.points) || []; },

  bounds(shape) {
    const pts = this.points(shape);
    if (!pts.length) return null;
    let s = pts[0][0], n = pts[0][0], w = pts[0][1], e = pts[0][1];
    pts.forEach(p => {
      s = Math.min(s, p[0]); n = Math.max(n, p[0]);
      w = Math.min(w, p[1]); e = Math.max(e, p[1]);
    });
    return { south: s, north: n, west: w, east: e };
  },

  /** The average of the points. Good enough as a drag handle and a pivot. */
  centroid(shape) {
    const pts = this.points(shape);
    if (!pts.length) return null;
    let la = 0, ln = 0;
    pts.forEach(p => { la += p[0]; ln += p[1]; });
    return { latitude: la / pts.length, longitude: ln / pts.length };
  },

  /** Longest span in metres — what the table shows as a size. */
  sizeM(shape) {
    const b = this.bounds(shape);
    if (!b) return 0;
    const h = haversine(b.south, b.west, b.north, b.west);
    const w = haversine(b.south, b.west, b.south, b.east);
    return Math.round(Math.max(h, w));
  },

  /** Shift every point. */
  move(shape, dLat, dLng) {
    shape.points = this.points(shape).map(p => [p[0] + dLat, p[1] + dLng]);
    return shape;
  },

  /** Put the centroid here, keeping the shape rigid. */
  moveTo(shape, lat, lng) {
    const c = this.centroid(shape);
    if (!c) return shape;
    return this.move(shape, lat - c.latitude, lng - c.longitude);
  },

  /**
   * Resize about the centroid.
   *
   * Longitude is scaled the same as latitude in *degrees*, which is what keeps
   * the shape's proportions on the ground: both axes are already in degrees
   * and the ratio between them does not change when you scale both by the same
   * factor. Scaling metres instead would need a projection and would come back
   * to the same numbers.
   */
  scale(shape, factor) {
    const c = this.centroid(shape);
    const f = +factor;
    if (!c || !isFinite(f) || f <= 0) return shape;
    shape.points = this.points(shape).map(p => [
      c.latitude + (p[0] - c.latitude) * f,
      c.longitude + (p[1] - c.longitude) * f
    ]);
    return shape;
  },

  /** Turn about the centroid, degrees clockwise. */
  rotate(shape, degrees) {
    const c = this.centroid(shape);
    const d = +degrees;
    if (!c || !isFinite(d) || !d) return shape;
    const rad = -d * Math.PI / 180;         // clockwise on screen
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // Work in a local metre-ish frame so a rotated square stays square.
    const kx = Math.cos(toRad(c.latitude));
    shape.points = this.points(shape).map(p => {
      const x = (p[1] - c.longitude) * kx, y = p[0] - c.latitude;
      const rx = x * cos - y * sin, ry = x * sin + y * cos;
      return [c.latitude + ry, c.longitude + rx / kx];
    });
    return shape;
  },

  /* ----------------------------------------------------------------- drawing */

  /** Territories only — what Denizens reads. */
  zones() { return this.list().filter(s => s.purpose === "zone"); },

  /** Everything worth drawing around a point. */
  near(lat, lng, radiusM) {
    const r = +radiusM || 600;
    return this.list().filter(s => {
      const c = this.centroid(s);
      if (!c) return false;
      // The centroid plus the shape's own reach, so a big building is not
      // dropped because its middle is just outside the circle.
      return haversine(lat, lng, c.latitude, c.longitude) <= r + this.sizeM(s);
    });
  },

  /** The Leaflet style for one shape. Shared by the game and the editor. */
  styleOf(shape) {
    return {
      color: shape.stroke || "#8b93a6",
      weight: +shape.strokeWidth || 2,
      opacity: shape.strokeOpacity == null ? 0.95 : +shape.strokeOpacity,
      fillColor: shape.fill || shape.stroke || "#3b4354",
      fillOpacity: shape.kind === "line" ? 0 : (shape.fillOpacity == null ? 0.35 : +shape.fillOpacity),
      dashArray: shape.dash || null,
      lineJoin: "round"
    };
  },

  /* ------------------------------------------------------------ the document */

  export() {
    return {
      format: this.FORMAT, version: this.VERSION,
      exportedAt: new Date().toISOString(),
      note: "Hand-drawn scenery for Stride & Sword. Coordinates are [lat, lng].",
      shapes: this.all()
    };
  },

  /**
   * Merge a document in. Anything with a shapeId we already hold is replaced,
   * so re-importing your own export is a no-op rather than a duplication —
   * the whole point of a file you pass between machines.
   */
  import(doc, replace) {
    const rows = (doc && (doc.shapes || doc.rows)) || (Array.isArray(doc) ? doc : null);
    if (!Array.isArray(rows)) return { success: false, message: "That file has no shapes in it." };
    const clean = rows.filter(s => s && Array.isArray(s.points) && s.points.length >= 2)
                      .map(s => Object.assign(this.blank(s.kind), s));
    if (replace) { this.replaceAll(clean); return { success: true, added: clean.length, updated: 0 }; }
    const mine = this.all();
    const byId = {};
    mine.forEach((s, i) => { byId[s.shapeId] = i; });
    let added = 0, updated = 0;
    clean.forEach(s => {
      if (s.shapeId && byId[s.shapeId] != null) { mine[byId[s.shapeId]] = s; updated++; }
      else { s.shapeId = s.shapeId || uid("shp"); mine.push(s); added++; }
    });
    Store.set(this.KEY, mine);
    return { success: true, added, updated };
  },

  stats() {
    const rows = this.all();
    return {
      shapes: rows.length,
      zones: rows.filter(s => s.purpose === "zone").length,
      polygons: rows.filter(s => s.kind !== "line").length,
      lines: rows.filter(s => s.kind === "line").length,
      hidden: rows.filter(s => s.active === false).length,
      imported: rows.filter(s => s.osmId).length,
      bytes: JSON.stringify(rows).length
    };
  }
};
