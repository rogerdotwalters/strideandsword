"use strict";
/* -------------------------------------------------------------------------
   12c. Placement — where things should go, and how often.

   One scoring core, used by three callers: the procedural locations, the
   dungeon spawner and the instance spawner. It answers one question —
   "given these candidate spots, which one?" — and answers it the same way
   every time, so tuning one thing tunes all of them.

   THE RULE THAT SHAPES EVERYTHING: a weight is never a filter.

   Every candidate keeps a floor, every out-of-hours category keeps a
   multiplier rather than a zero, and "other" — anywhere public that we could
   not categorise — always carries some weight. So an office with no mapped
   parks and no mapped shops still gets dungeons; they just land on ordinary
   buildings. Nothing has to special-case the empty case, because there is no
   empty case.

   The numbers live in data/spawn-rules.json and are meant to be edited. The
   fallback below is deliberately flat and deliberately noisy about itself: if
   you are seeing uniform spawning, the file did not load.
   ------------------------------------------------------------------------- */
const Placement = {

  /* A last resort, not a second copy of the rules. Everything equally likely,
     which is visibly wrong, so a missing file shows up as a bug rather than
     hiding as a subtly different distribution. */
  FALLBACK: {
    contrast: 1,
    dungeons: {
      alive: 1, minSeparationM: 610, regapMinutes: 15, lifetimeMinutes: 180,
      minWeight: 0.05, outOfWindowMultiplier: 1, categories: {}
    },
    instances: {
      perDayMin: 1, perDayMax: 2, minSeparationM: 610, lifetimeMinutes: 180,
      minWeight: 0.05, outOfWindowMultiplier: 0.15, categories: {}
    },
    locations: {
      minWeight: 0.1, snapRangeM: 75,
      road: { idealM: 25, bonus: 6, falloffM: 60 },
      insideCategory: {}, buildingKind: {}
    }
  },

  _warned: false,

  /** The rules as loaded, or the flat fallback with one warning. */
  rules() {
    const r = (typeof DB !== "undefined" && DB.raw && DB.raw.spawnRules) || null;
    if (r) return r;
    if (!this._warned) {
      this._warned = true;
      console.warn("[placement] data/spawn-rules.json did not load — spawning is uniform.");
    }
    return this.FALLBACK;
  },

  /** The rules for one kind: "dungeons", "instances" or "locations". */
  rulesFor(kind) {
    const r = this.rules();
    return r[kind] || this.FALLBACK[kind] || {};
  },

  catRules(kind, category) {
    const cats = this.rulesFor(kind).categories || {};
    return cats[category] || cats.other || { weight: 1, windows: [] };
  },

  /* --------------------------------------------------------------- windows */

  /**
   * Is `when` inside any of these windows? An empty list means always — a
   * category with no hours is not restricted, it simply has no opinion.
   *
   * Reuses the game's own time parsing, so a window that wraps past midnight
   * behaves here exactly as an opening time does on a hand-placed location.
   */
  windowOpen(windows, when) {
    if (!windows || !windows.length) return true;
    const d = when instanceof Date ? when : new Date(when || Date.now());
    const now = d.getHours() * 60 + d.getMinutes();
    return windows.some(w => {
      const start = Content.minutesOf(w[0]), end = Content.minutesOf(w[1]);
      if (start == null || end == null || start === end) return true;
      return start < end ? (now >= start && now < end) : (now >= start || now < end);
    });
  },

  /* ---------------------------------------------------------------- weight */

  /**
   * What a category is worth right now.
   *
   *   weight ^ contrast, times the window multiplier, floored.
   *
   * The exponent is the dial that decides how much any of this is noticeable.
   * At 1 the weights apply as written; at 0.55 a ten-to-one spread reads as
   * about three-and-a-half to one — a park is clearly favoured without the
   * corner shop feeling dead. At 0 everywhere is equally likely.
   */
  categoryWeight(kind, category, when) {
    const rules = this.rulesFor(kind);
    const cat = this.catRules(kind, category);
    const contrast = this.rules().contrast;
    const c = isFinite(contrast) ? clamp(+contrast, 0, 3) : 1;
    const base = Math.max(0, +cat.weight || 0);
    let w = Math.pow(base, c);
    if (!this.windowOpen(cat.windows, when)) {
      const m = rules.outOfWindowMultiplier;
      w *= (m == null ? 0.15 : +m);
    }
    return Math.max(+rules.minWeight || 0.01, w);
  },

  /** How long something placed here should last, in ms. */
  lifetimeMs(kind, category) {
    const rules = this.rulesFor(kind);
    const cat = this.catRules(kind, category);
    const mins = (+rules.lifetimeMinutes || 180) * (+cat.lifetimeMultiplier || 1);
    return Math.max(60000, Math.round(mins * 60000));
  },

  /** The footprint a dungeon placed at this kind of place should have. */
  radiusFor(kind, category) {
    return Math.max(10, +this.catRules(kind, category).radiusM || 40);
  },

  /* ------------------------------------------------------------ candidates */

  /**
   * Every public place in reach, as scored candidates. Buildings stand in
   * where no place has been mapped, so the list is never empty once a zone
   * has been surveyed at all.
   */
  candidates(zone, kind, when) {
    if (!zone) return [];
    const out = [];
    const reach = (+zone.radius || 320) + 60;

    Atlas.nearPlaces(zone.centerLatitude, zone.centerLongitude, reach).forEach(p => {
      out.push({
        kind: "place", row: p.row, category: p.row.category,
        latitude: p.row.latitude, longitude: p.row.longitude,
        ring: p.row.ring || null,
        weight: this.categoryWeight(kind, p.row.category, when)
      });
    });

    // Buildings are the floor. Without them a zone with no mapped parks or
    // shops would have nothing to offer at all.
    Atlas.nearBuildings(zone.centerLatitude, zone.centerLongitude, reach).forEach(b => {
      // A shop that is also its own building is already in the list above.
      if (out.some(c => c.row.osmId && c.row.osmId === b.row.osmId)) return;
      out.push({
        kind: "building", row: b.row, category: "other",
        latitude: b.row.latitude, longitude: b.row.longitude,
        ring: null,
        weight: this.categoryWeight(kind, "other", when)
      });
    });

    return out;
  },

  /* ----------------------------------------------------------------- picks */

  /**
   * Weighted pick. `rnd` is injectable so a test can pin the outcome; left
   * out, it is ordinary randomness.
   */
  pick(candidates, rnd) {
    if (!candidates || !candidates.length) return null;
    const r = rnd || Math.random;
    let total = 0;
    candidates.forEach(c => { total += Math.max(0, c.weight || 0); });
    if (total <= 0) return candidates[Math.floor(r() * candidates.length)];
    let roll = r() * total;
    for (const c of candidates) {
      roll -= Math.max(0, c.weight || 0);
      if (roll <= 0) return c;
    }
    return candidates[candidates.length - 1];
  },

  /**
   * Pick in two stages: the category first, then somewhere in it.
   *
   * This matters more than it looks. Weighting every candidate individually
   * would mean a zone with thirty-seven buildings and three parks gives the
   * buildings thirty-seven entries in the draw — "other" would win most of the
   * time however high the park weight was, because there is so much more of
   * it. Choosing the category first makes the weights mean what they say: a
   * 33% park share is a 33% park share whether the map has one park or nine.
   *
   * Within a category everything is equally likely, which is the honest
   * default — we have no reason to prefer one park over another.
   */
  pickByCategory(candidates, kind, when, rnd) {
    if (!candidates || !candidates.length) return null;
    const r = rnd || Math.random;
    const groups = {};
    candidates.forEach(c => { (groups[c.category] = groups[c.category] || []).push(c); });

    const cats = Object.keys(groups);
    const weights = cats.map(c => this.categoryWeight(kind, c, when));
    let total = 0;
    weights.forEach(w => { total += w; });
    if (total <= 0) return candidates[Math.floor(r() * candidates.length)];

    let roll = r() * total, chosen = cats[cats.length - 1];
    for (let i = 0; i < cats.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { chosen = cats[i]; break; }
    }
    const pool = groups[chosen];
    return pool[Math.floor(r() * pool.length)] || pool[0];
  },

  /** Drop anything too close to a point already taken. */
  spacedOut(candidates, taken, minM) {
    if (!minM) return candidates;
    return candidates.filter(c =>
      taken.every(t => haversine(c.latitude, c.longitude, t.latitude, t.longitude) >= minM));
  },

  /**
   * A point to actually stand the thing on. Inside the ring when there is one,
   * because a park's centroid can sit in the middle of a pond; the bare point
   * otherwise.
   */
  spotIn(cand, rnd) {
    const r = rnd || Math.random;
    if (!cand.ring || cand.ring.length < 3) {
      return { latitude: cand.latitude, longitude: cand.longitude };
    }
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    cand.ring.forEach(p => {
      if (p[0] < minLat) minLat = p[0];
      if (p[0] > maxLat) maxLat = p[0];
      if (p[1] < minLng) minLng = p[1];
      if (p[1] > maxLng) maxLng = p[1];
    });
    for (let i = 0; i < 40; i++) {
      const la = minLat + r() * (maxLat - minLat);
      const ln = minLng + r() * (maxLng - minLng);
      if (Content.pointInRing(cand.ring, la, ln)) return { latitude: la, longitude: ln };
    }
    return { latitude: cand.latitude, longitude: cand.longitude };
  },

  /* -------------------------------------------------------------- geometry */

  /**
   * Metres from a point to the nearest road centreline. Roads are polylines,
   * so this is the minimum over every segment — worked in local metres via an
   * equirectangular approximation, which is exact enough over a few hundred
   * metres and far cheaper than a haversine per segment.
   */
  distanceToRoad(lat, lng, roads) {
    if (!roads || !roads.length) return Infinity;
    const mx = 111320 * Math.cos(toRad(lat)), my = 110540;
    const px = lng * mx, py = lat * my;
    let best = Infinity;
    for (const r of roads) {
      const line = r.line || r;
      for (let i = 1; i < line.length; i++) {
        const ax = line[i - 1][1] * mx, ay = line[i - 1][0] * my;
        const bx = line[i][1] * mx, by = line[i][0] * my;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx, qy = ay + t * dy;
        const d = Math.hypot(px - qx, py - qy);
        if (d < best) best = d;
      }
    }
    return best;
  },

  /* ------------------------------------------------- scoring a location spot

     Locations are different from dungeons and instances: the spot already
     exists (the generator scattered it), and the question is which nearby
     building to pull it onto. So the score combines what the building is,
     what it sits inside, and how close it is to a road you would walk. */

  scoreBuilding(building, roads, when) {
    const rules = this.rulesFor("locations");
    let score = 1;

    const byKind = rules.buildingKind || {};
    score += +byKind[building.kind] || 0;

    const place = typeof Atlas !== "undefined"
      ? Atlas.placeAt(building.latitude, building.longitude, 40) : null;
    if (place) score += +(rules.insideCategory || {})[place.category] || 0;

    const road = rules.road || {};
    const d = this.distanceToRoad(building.latitude, building.longitude, roads);
    if (isFinite(d)) {
      // Full bonus out to idealM, then fading to nothing by falloffM.
      const ideal = +road.idealM || 25, falloff = +road.falloffM || 60;
      const near = d <= ideal ? 1 : Math.max(0, 1 - (d - ideal) / Math.max(1, falloff));
      score += (+road.bonus || 0) * near;
    }

    const contrast = this.rules().contrast;
    const c = isFinite(contrast) ? clamp(+contrast, 0, 3) : 1;
    return Math.max(+rules.minWeight || 0.1, Math.pow(score, c));
  }
};
