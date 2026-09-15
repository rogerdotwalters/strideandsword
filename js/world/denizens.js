"use strict";
/* -------------------------------------------------------------------------
   8f. Denizens — things that move, inside boundaries that hold them.

   A park with a quest node in it is still an empty park. This puts things in
   it: creatures that pace their own patch of ground, and characters who walk
   between places. On the real map, at real coordinates, moving while you are
   not looking.

   ============================ THE ONE BIG IDEA ============================

   **Position is a pure function of the clock.** Nothing ticks, nothing
   accumulates, nothing is stored. Ask where a creature is at time T and the
   answer is computed from its seed and T — the same answer on every device,
   after every reload, whether or not anybody was watching in between.

   That follows the rule the rest of this project already keeps (no timers;
   recompute when the game happens to look), and it buys three things that a
   simulation loop would not:

     · it moves while the phone is in a pocket, because there is nothing to
       run — the position was never stored, only derived
     · it cannot drift, desync or double-step
     · a test can ask where everything is at noon tomorrow, instantly

   HOW THE MOVEMENT WORKS

   Time is cut into **legs** of a fixed length. Leg *i* has a waypoint, picked
   by `seededRandom(seed + ":" + i)` from inside the territory. A denizen's
   position is the point between waypoint *i* and waypoint *i+1*, by however
   far through the leg the clock is. Smooth, endless, and deterministic.

   **A creature cannot leave its territory because every waypoint is inside
   it.** That is containment by construction, not a collision test that has to
   be right on every step — and it is why the boundary is the first thing this
   file asks for and the last thing it would give up.

   ======================== WHAT HOLDS THEM =================================

   A **territory** is a polygon with a purpose. Two sources:

     drawn     a shape from the shape editor with `purpose: "zone"`, which is
               how you say "the wolves live in this bit of the wood"
     derived   a park with no drawn zones is quartered automatically, so the
               feature works before anybody authors anything

   Creatures are bound to one territory. Characters are bound to a *place*, or
   to the whole world — which is what lets the tanner turn up at the market.
   ------------------------------------------------------------------------- */
const Denizens = {
  KILL_KEY: "denizen_kills",

  /* A leg is deliberately long. Walking pace over forty seconds is about
     fifty metres, which reads as an animal crossing a clearing rather than a
     dot twitching, and it means two consecutive looks a few seconds apart
     show a small, believable change. */
  LEG_MS: 40000,

  /* How long a population lasts before it is rolled again. A creature you did
     not kill is still gone eventually — the wood is not a fixed cast list. */
  GENERATION_MS: 3 * 3600 * 1000,

  /* And how long a killed one stays killed. Shorter than a generation, so a
     patch you cleared is worth coming back to. */
  RESPAWN_MS: 45 * 60 * 1000,

  KINDS: {
    creature:  { key: "creature",  name: "Creature",  icon: "🐺",
                 blurb: "Lives here and does not leave." },
    character: { key: "character", name: "Character", icon: "🧍",
                 blurb: "Walks about, and may travel to other places." }
  },

  /* How far a character will wander from the place it belongs to. */
  ROAMS: {
    zone:  { key: "zone",  name: "Stays in this patch",  blurb: "Never leaves the drawn area." },
    place: { key: "place", name: "Wanders the place",    blurb: "The whole park, not just this patch." },
    world: { key: "world", name: "Travels between places", blurb: "Turns up at your other haunts too." }
  },

  /* ================================================== TERRITORIES ========= */

  /**
   * Every drawn territory — shapes the shape editor marked as zones.
   *
   * A zone is an ordinary shape with `purpose: "zone"`, so it is drawn, moved
   * and resized by the tool that already exists. Nothing about the geometry is
   * special; only what it means.
   */
  drawnZones() {
    if (typeof Shapes === "undefined") return [];
    return Shapes.list().filter(s => s.purpose === "zone" && (s.points || []).length > 2);
  },

  /** Drawn territories whose middle is within `radiusM` of a point. */
  zonesNear(lat, lng, radiusM) {
    const r = +radiusM || 800;
    return this.drawnZones().filter(z => {
      const c = Shapes.centroid(z);
      return c && haversine(lat, lng, c.latitude, c.longitude) <= r + Shapes.sizeM(z);
    });
  },

  /** Is this point inside the territory? */
  contains(zone, lat, lng) {
    if (!zone) return false;
    if (zone.points && zone.points.length > 2) return Content.pointInRing(zone.points, lat, lng);
    return haversine(zone.latitude, zone.longitude, lat, lng) <= (+zone.radiusM || 60);
  },

  /**
   * A haunt with no drawn zones, quartered.
   *
   * Without this the feature would need authoring before it did anything, and
   * a park would sit empty until somebody opened the shape editor. Four
   * quadrants of the ring is crude and completely adequate: each one is a real
   * polygon, inside the park, and different from its neighbours.
   */
  derivedZones(haunt) {
    if (!haunt) return [];
    const ring = (haunt.ring && haunt.ring.length > 2) ? haunt.ring : null;
    const c = { latitude: +haunt.latitude, longitude: +haunt.longitude };
    const quads = [
      { key: "n", name: "north", lat: 1, lng: 0 },
      { key: "e", name: "east",  lat: 0, lng: 1 },
      { key: "s", name: "south", lat: -1, lng: 0 },
      { key: "w", name: "west",  lat: 0, lng: -1 }
    ];
    const reach = Math.max(25, (+haunt.radiusM || 60) * 0.55);
    /* How many live in each quarter, by how much ground there is.
       A fixed two per quarter put eight creatures inside a forty-metre pocket
       park, which draws as one pile of icons and reads as a bug rather than a
       wood. One apiece in a small park, three by the time it is a hundred and
       fifty metres across. */
    const count = clamp(Math.round((+haunt.radiusM || 60) / 50), 1, 3);
    return quads.map(q => {
      const mid = projectPoint(c.latitude, c.longitude, reach * 0.55,
                               q.key === "n" ? 0 : q.key === "e" ? 90 : q.key === "s" ? 180 : 270);
      return {
        shapeId: "derived:" + (haunt.slotKey || "place") + ":" + q.key,
        derived: true,
        name: "The " + q.name + " " + (haunt.role === "forest" || haunt.role === "deepwood" ? "wood" : "side"),
        purpose: "zone",
        zoneKind: "creature",
        // No polygon: a circle inside the park, which pointIn handles as well.
        points: null,
        latitude: mid.latitude, longitude: mid.longitude,
        radiusM: Math.round(reach * 0.45),
        ring,
        placeName: haunt.name, role: haunt.role,
        count, spawnTableId: "", roams: "zone"
      };
    });
  },

  /**
   * Every territory worth considering near a point: what you drew, plus the
   * automatic quarters of any of your places nearby that has nothing drawn in
   * it.
   */
  territories(lat, lng, radiusM) {
    const out = this.zonesNear(lat, lng, radiusM);
    if (typeof Haunts === "undefined") return out;
    Haunts.list().forEach(h => {
      if (haversine(lat, lng, h.latitude, h.longitude) > (+radiusM || 800) + (+h.radiusM || 60)) return;
      // Anything drawn inside this place wins; only fall back where nothing is.
      const drawn = out.some(z => {
        const c = Shapes.centroid(z);
        return c && haversine(c.latitude, c.longitude, h.latitude, h.longitude) <= (+h.radiusM || 60) + 40;
      });
      if (!drawn) this.derivedZones(h).forEach(z => out.push(z));
    });
    return out;
  },

  /** A point inside a territory, from a seeded random source. */
  pointIn(zone, rand) {
    if (zone.points && zone.points.length > 2) {
      let s = zone.points[0][0], n = s, w = zone.points[0][1], e = w;
      zone.points.forEach(p => {
        s = Math.min(s, p[0]); n = Math.max(n, p[0]);
        w = Math.min(w, p[1]); e = Math.max(e, p[1]);
      });
      for (let i = 0; i < 80; i++) {
        const lat = s + rand() * (n - s), lng = w + rand() * (e - w);
        if (Content.pointInRing(zone.points, lat, lng)) return { latitude: lat, longitude: lng };
      }
      // A polygon so thin that eighty samples missed it. Its middle is still
      // inside a sane shape, and a denizen standing still beats one outside.
      const c = Shapes.centroid(zone);
      return { latitude: c.latitude, longitude: c.longitude };
    }
    const d = Math.sqrt(rand()) * (+zone.radiusM || 50);
    const p = projectPoint(zone.latitude, zone.longitude, d, rand() * 360);
    return { latitude: p.latitude, longitude: p.longitude };
  },

  /* =================================================== THE POPULATION ===== */

  generationAt(now) { return Math.floor((now || Date.now()) / this.GENERATION_MS); },

  /**
   * Who is in this territory right now.
   *
   * Derived, not stored: the same seed and the same generation give the same
   * cast, so two looks a second apart do not reshuffle the wood, and a reload
   * does not either.
   */
  inZone(zone, now, opts) {
    opts = opts || {};
    now = now || Date.now();
    const gen = this.generationAt(now);
    const kind = zone.zoneKind === "character" ? "character" : "creature";
    const count = kind === "character" ? 1 : clamp(Math.round(+zone.count || 2), 0, 8);
    const out = [];
    const killed = this.killed(now);

    for (let i = 0; i < count; i++) {
      const id = zone.shapeId + ":" + gen + ":" + i;
      if (killed[id]) continue;
      const seed = id + ":" + (zone.name || "");
      const rand = seededRandom(seed);
      const d = {
        denizenId: id, zoneId: zone.shapeId, zone,
        kind,
        seed,
        placeName: zone.placeName || zone.name || "",
        roams: zone.roams || (kind === "character" ? "place" : "zone"),
        spawnTableId: zone.spawnTableId || "",
        questId: zone.questId || "",
        // A difficulty band, so a patch feels like its own place.
        difficulty: clamp(Math.round(1 + rand() * 6 + (+zone.difficulty || 0)), 1, 10),
        name: "", icon: ""
      };
      this.dress(d, rand);
      const p = this.positionAt(d, now);
      d.latitude = p.latitude; d.longitude = p.longitude;
      out.push(d);
    }
    return out;
  },

  /** A name and a face, from the spawn table if there is one. */
  dress(d, rand) {
    if (d.kind === "character") {
      // Not `pick`: that one uses Math.random and would give this character a
      // different name every time the map redrew.
      d.name = d.zone.npcName || this.NPC_NAMES[Math.floor(rand() * this.NPC_NAMES.length)];
      d.icon = d.zone.npcIcon || "🧍";
      return d;
    }
    let mon = null;
    if (d.spawnTableId && typeof Content !== "undefined") {
      const table = Content.get("spawns", d.spawnTableId);
      const ids = (table && table.monsters) || [];
      if (ids.length) mon = Content.get("monsters", ids[Math.floor(rand() * ids.length)]);
    }
    if (!mon && typeof Content !== "undefined") {
      const pool = Content.list("monsters").filter(m => !m.isBoss);
      if (pool.length) mon = pool[Math.floor(rand() * pool.length)];
    }
    d.monsterId = mon ? mon.monsterId : "";
    d.name = mon ? mon.name : "Something";
    d.icon = (mon && mon.icon) || "🐺";
    if (mon) d.difficulty = clamp(Math.round((+mon.levelMin + +mon.levelMax) / 2) || d.difficulty, 1, 10);
    return d;
  },

  NPC_NAMES: ["Wend the tanner", "Old Maugrim", "Cassilda", "Bram the drover",
              "Hollis of the wells", "Rhosyn", "Ottoline", "The lamplighter"],

  /* ====================================================== MOVEMENT ======== */

  /**
   * Where this denizen is at `now`.
   *
   * Two waypoints and a fraction. Both waypoints come from the same seeded
   * source keyed by the leg number, so the path is a fixed, endless walk that
   * any device can recompute from scratch.
   */
  positionAt(d, now) {
    now = now || Date.now();
    const leg = Math.floor(now / this.LEG_MS);
    const t = (now % this.LEG_MS) / this.LEG_MS;
    const a = this.waypoint(d, leg);
    const b = this.waypoint(d, leg + 1);
    /* Ease in and out of each waypoint rather than sliding at a constant
       speed through it. A thing that pauses where it arrives reads as alive;
       one that changes direction at full tilt reads as a cursor. */
    const e = t * t * (3 - 2 * t);
    return {
      latitude: a.latitude + (b.latitude - a.latitude) * e,
      longitude: a.longitude + (b.longitude - a.longitude) * e,
      leg, t
    };
  },

  /**
   * The waypoint for one leg.
   *
   * For a creature, always inside its territory — which is the containment
   * guarantee. For a character, the territory *or*, every so often, somewhere
   * else entirely: a place they travel to and then wander for a while.
   */
  waypoint(d, leg) {
    const rand = seededRandom(d.seed + ":leg:" + leg);
    if (d.kind === "character" && d.roams === "world" && typeof Haunts !== "undefined") {
      /* A trip lasts several legs, so they stay somewhere long enough to be
         met rather than teleporting between parks every forty seconds. */
      const trip = Math.floor(leg / 6);
      const tripRand = seededRandom(d.seed + ":trip:" + trip);
      const places = Haunts.list();
      if (places.length) {
        const h = places[Math.floor(tripRand() * places.length)];
        const p = Haunts.pointIn(h, 90, 20, 0, rand);
        return { latitude: p.latitude, longitude: p.longitude };
      }
    }
    const zone = (d.kind === "character" && d.roams === "place" && d.zone.ring)
      ? { shapeId: (d.zone.shapeId || "") + ":ring", points: d.zone.ring }
      : d.zone;
    return this.stepIn(d, zone, leg, rand);
  },

  /**
   * One leg's waypoint inside a bounding shape — and the reason there is an
   * anchor at all.
   *
   * Two waypoints inside a polygon do not make a path inside it. Cut across
   * the inside corner of an L and every point at each end is in the shape
   * while the middle of the walk is out in the street. A circle cannot do
   * that (any line between two of its points is inside it), so this only
   * applies where a territory was drawn by hand.
   *
   * The fix is a **den**: one point in the territory, picked once per
   * creature, that every other leg returns to. A leg is then always between
   * the den and somewhere the den can see in a straight line — tested when
   * the waypoint is chosen and rejected if it cannot. So the path is inside
   * the boundary by construction, the same way the waypoints were, with no
   * per-step collision test to get wrong.
   *
   * It also reads better than the alternative: a thing that keeps coming back
   * to one spot has a home, and pacing out and back is what an animal with a
   * territory actually does.
   */
  stepIn(d, zone, leg, rand) {
    const ring = (zone.points && zone.points.length > 2) ? zone.points : null;
    if (!ring) return this.pointIn(zone, rand);      // a circle is its own alibi
    const den = this.denOf(d, zone);
    if (leg % 2 === 0) return den;
    for (let i = 0; i < 24; i++) {
      const p = this.pointIn(zone, rand);
      if (this.segmentInside(ring, den, p)) return p;
    }
    return den;                                      // a shape too awkward to leave
  },

  /** The point a denizen keeps coming back to. Seeded, so it is always the same one. */
  denOf(d, zone) {
    const key = "_den:" + (zone.shapeId || "ring");
    if (d[key]) return d[key];
    const rand = seededRandom(d.seed + ":den:" + (zone.shapeId || "ring"));
    /* Prefer a den that can see a lot of its own territory: a few candidates,
       and the one with the clearest view wins. In an L that puts it near the
       inside corner rather than at the end of one arm. */
    let best = null, bestSeen = -1;
    for (let i = 0; i < 5; i++) {
      const c = this.pointIn(zone, rand);
      const look = seededRandom(d.seed + ":look:" + i);
      let seen = 0;
      for (let k = 0; k < 8; k++) {
        if (this.segmentInside(zone.points, c, this.pointIn(zone, look))) seen++;
      }
      if (seen > bestSeen) { bestSeen = seen; best = c; }
      if (seen === 8) break;
    }
    d[key] = best;
    return best;
  },

  /** Is every point between these two inside the ring? */
  segmentInside(ring, a, b) {
    const STEPS = 24;
    for (let i = 1; i < STEPS; i++) {
      const t = i / STEPS;
      if (!Content.pointInRing(ring,
            a.latitude + (b.latitude - a.latitude) * t,
            a.longitude + (b.longitude - a.longitude) * t)) return false;
    }
    return true;
  },

  /* ================================================== KILLS AND LOOKING === */

  killed(now) {
    const all = Store.get(this.KILL_KEY, {}) || {};
    const t = now || Date.now();
    let dirty = false;
    Object.keys(all).forEach(k => { if (all[k] <= t) { delete all[k]; dirty = true; } });
    if (dirty) Store.set(this.KILL_KEY, all);
    return all;
  },

  kill(denizenId, now) {
    const t = now || Date.now();
    Store.patch(this.KILL_KEY, (all) => { all[denizenId] = t + this.RESPAWN_MS; });
  },

  /**
   * Everything alive and near enough to matter. The one call the game makes.
   */
  near(lat, lng, radiusM, now) {
    now = now || Date.now();
    const out = [];
    this.territories(lat, lng, radiusM).forEach(z => {
      this.inZone(z, now).forEach(d => {
        d.distance = haversine(lat, lng, d.latitude, d.longitude);
        if (d.distance <= (+radiusM || 600)) out.push(d);
      });
    });
    return out.sort((a, b) => a.distance - b.distance);
  },

  /** A throwaway combat node for a creature, the way a dungeon stop does it. */
  toNode(d) {
    return {
      nodeId: "dz_" + d.denizenId,
      name: d.name, type: "combat", difficulty: d.difficulty,
      latitude: d.latitude, longitude: d.longitude,
      icon: d.icon, status: "discovered",
      spawnTableId: d.spawnTableId || "",
      monsterId: d.monsterId || "",
      transient: true,
      rewards: { experience: 0, gold: 0, items: [] }
    };
  },

  stats(lat, lng, now) {
    const zones = (lat != null) ? this.territories(lat, lng, 900) : [];
    return {
      zones: zones.length,
      drawn: zones.filter(z => !z.derived).length,
      derived: zones.filter(z => z.derived).length,
      alive: (lat != null) ? this.near(lat, lng, 900, now).length : 0,
      killed: Object.keys(this.killed(now)).length
    };
  }
};
