"use strict";
/* -------------------------------------------------------------------------
   12d. Spawner — keeping dungeons and instances turning over.

   Two schedules, one weighting core (Placement):

     Dungeons   one alive in the zone at a time. It lasts three hours, or
                until you clear it, and the next one appears somewhere else
                about fifteen minutes later.

     Instances  one or two per 2 km REGION, each lasting one to three days.
                Not per chunk: an instance should still be there tomorrow, and
                tying its life to a 500 m square you happened to cross would
                throw it away for no reason. A chunk only ever *draws* one.

   NO TIMERS. Inside a dungeon, walking is the clock; that stays true. These
   rules are wall-clock, so instead of ticking in the background the spawner
   recomputes "should something be here now?" whenever the game already
   happens to look — on a position fix, and when the tab comes back to the
   front. Nothing runs while nobody is watching, and the answer is the same
   either way because it is derived from the time, not accumulated.

   WHAT IT OWNS. A spawned row is an ordinary row in content_dungeons or
   content_instances, marked `origin: "auto"` with an `expiresAt`. Everything
   downstream — the map pin, the door prompt, the run — treats it like any
   other, which is the point: no parallel code path to keep honest. The
   spawner only ever removes rows it marked, so anything you placed by hand is
   untouchable, and it never removes one you are standing inside.

   WHAT IT SPAWNS. Clones of what you have already authored. Any hand-placed
   dungeon is a template unless it says `spawnable: false`, so placing one good
   dungeon teaches the spawner what a dungeon looks like here. With nothing
   authored at all it falls back to a plain generated one.
   ------------------------------------------------------------------------- */
const Spawner = {
  KEY: "spawn_state",

  /* ----------------------------------------------------------------- state */

  all() { return Store.get(this.KEY, {}) || {}; },
  state(zoneId) {
    return this.all()[zoneId] || { nextDungeonAt: 0, day: "", target: 0, spawned: 0 };
  },
  saveState(zoneId, st) {
    Store.patch(this.KEY, (all) => { all[zoneId] = st; });
  },

  dayKey(now) {
    const d = new Date(now);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
           "-" + String(d.getDate()).padStart(2, "0");
  },

  /* ----------------------------------------------------------------- rows */

  /** Rows this spawner put there, in this zone. */
  mine(table, zoneId) {
    return Content.list(table).filter(r => r.origin === "auto" && r.zoneId === zoneId);
  },

  /** Rows a person put there — the templates, and the things never removed. */
  authored(table, zoneId) {
    return Content.list(table).filter(r =>
      r.origin !== "auto" && (!r.zoneId || r.zoneId === zoneId));
  },

  idOf(table, row) { return row[table === "dungeons" ? "dungeonId" : "instanceId"]; },

  /**
   * Is the player inside this, or holding a paused run in it? Either way it
   * stays, however overdue it is — deleting the floor from under someone is
   * never the right answer.
   */
  inUse(table, row) {
    const api = table === "dungeons" ? (typeof Dungeon !== "undefined" ? Dungeon : null)
                                     : (typeof Instance !== "undefined" ? Instance : null);
    if (!api) return false;
    const id = this.idOf(table, row);
    const active = api.current();
    if (active && (active.dungeonId === id || active.instanceId === id)) return true;
    return !!api.pausedFor(id);
  },

  /** Has this been finished? A cleared spawn makes way for the next. */
  cleared(table, row) {
    const api = table === "dungeons" ? (typeof Dungeon !== "undefined" ? Dungeon : null)
                                     : (typeof Instance !== "undefined" ? Instance : null);
    const ch = typeof Game !== "undefined" ? Game.ch : null;
    if (!api || !ch) return false;
    const st = api.slotFor(ch.characterId).state[this.idOf(table, row)];
    return !!(st && st.clearedAt);
  },

  /* ---------------------------------------------------------------- expiry */

  /**
   * Clear out anything of ours that is finished or out of time. Returns how
   * many went, so the caller knows whether to redraw.
   */
  sweep(zone, now) {
    let gone = 0, freedDungeon = false;
    // Dungeons only. Instances belong to their region and are swept by
    // sweepRegions, which is what keeps them alive across chunk boundaries.
    ["dungeons"].forEach(table => {
      this.mine(table, zone.zoneId).forEach(row => {
        if (this.inUse(table, row)) return;
        const done = this.cleared(table, row);
        const expired = row.expiresAt && now >= row.expiresAt;
        if (!done && !expired) return;
        Content.remove(table, this.idOf(table, row));
        gone++;
        if (table === "dungeons") freedDungeon = true;
      });
    });

    if (freedDungeon) {
      // The gap between one dungeon and the next. Deliberately a gap: for
      // those fifteen minutes the zone has no dungeon in it, which is what
      // gives a cleared one a sense of ending.
      const st = this.state(zone.zoneId);
      const gap = (+Placement.rulesFor("dungeons").regapMinutes || 15) * 60000;
      st.nextDungeonAt = now + gap;
      this.saveState(zone.zoneId, st);
    }
    return gone;
  },

  /* -------------------------------------------------------------- templates */

  /**
   * Something to copy. Anything authored in this zone will do, weighted by an
   * optional `spawnWeight`; with nothing authored we generate a plain one so
   * a brand-new install still has something to walk to.
   */
  template(table, zone, rnd) {
    const r = rnd || Math.random;
    const pool = this.authored(table, zone.zoneId).filter(x => x.spawnable !== false);
    if (pool.length) {
      const weights = pool.map(x => Math.max(0.01, +x.spawnWeight || 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let roll = r() * total;
      for (let i = 0; i < pool.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return pool[i];
      }
      return pool[pool.length - 1];
    }
    return table === "dungeons"
      ? Content.blankDungeon(zone.centerLatitude, zone.centerLongitude, zone.zoneId)
      : Content.blankInstance(zone.centerLatitude, zone.centerLongitude, zone.zoneId);
  },

  /** A clone of the template, stripped of anything personal to the original. */
  clone(table, tpl, zone) {
    const copy = JSON.parse(JSON.stringify(tpl));
    delete copy.dungeonId; delete copy.instanceId;
    delete copy.expiresAt; delete copy.spawnWeight; delete copy.spawnable;
    copy.zoneId = zone.zoneId;
    copy.active = true;
    copy.origin = "auto";
    return copy;
  },

  /* --------------------------------------------------------------- placing */

  /**
   * Where the next one of these should go. Everything already placed — ours
   * and yours — is kept at arm's length, so a spawn never lands on top of
   * something you put somewhere on purpose.
   */
  placeFor(table, zone, now, rnd, at) {
    const rules = Placement.rulesFor(table);
    const taken = Content.list(table)
      .filter(r => r.zoneId === zone.zoneId || !r.zoneId)
      .map(r => ({ latitude: r.latitude, longitude: r.longitude }));

    let cands = Placement.candidates(zone, table, now);
    if (!cands.length) return null;

    /* Never right where the player is standing.
       This matters much more on a grid than it did with one zone: a chunk you
       walk into generates a dungeon immediately, and without this it lands at
       your feet and opens its own door prompt in your face. A dungeon is meant
       to be something you walk *to*. If nothing is far enough — a small cell,
       everything nearby — the rule is dropped rather than spawning nothing. */
    const minFromPlayer = +rules.minFromPlayerM || 0;
    if (at && minFromPlayer) {
      const away = cands.filter(c =>
        haversine(at.latitude, at.longitude, c.latitude, c.longitude) >= minFromPlayer);
      if (away.length) cands = away;
    }

    const sep = +rules.minSeparationM || 0;
    const spaced = Placement.spacedOut(cands, taken, sep);

    /* Nothing is far enough away. That is the normal case, not an edge one:
       a zone is 640 m across and the separation asks for 610 m, so as soon as
       anything is on the map the rule is unsatisfiable.

       Refusing to spawn would leave the zone empty forever, and ignoring the
       rule would let a spawn land on top of a dungeon you placed by hand. So
       fall back to the furthest quarter of what is available and weight within
       that — the separation stops being a hard floor and becomes a push. */
    let pool = spaced;
    if (!pool.length) {
      const far = cands.map(c => ({
        c, d: taken.length
          ? Math.min.apply(null, taken.map(t =>
              haversine(c.latitude, c.longitude, t.latitude, t.longitude)))
          : Infinity
      })).sort((a, b) => b.d - a.d);
      const keep = Math.max(1, Math.ceil(far.length * 0.25));
      pool = far.slice(0, keep).map(x => x.c);
    }

    const chosen = Placement.pickByCategory(pool, table, now, rnd);
    if (!chosen) return null;
    const spot = Placement.spotIn(chosen, rnd);
    return { cand: chosen, spot };
  },

  /* -------------------------------------------------------------- dungeons */

  tickDungeons(zone, now, rnd, opts) {
    const rules = Placement.rulesFor("dungeons");
    const want = Math.max(0, Math.round(+rules.alive || 1));
    const have = this.mine("dungeons", zone.zoneId).length;
    if (have >= want) return 0;

    const st = this.state(zone.zoneId);
    if (st.nextDungeonAt && now < st.nextDungeonAt) return 0;

    const placed = this.placeFor("dungeons", zone, now, rnd, opts && opts.at);
    if (!placed) return 0;

    const tpl = this.template("dungeons", zone, rnd);
    const row = this.clone("dungeons", tpl, zone);
    row.latitude = placed.spot.latitude;
    row.longitude = placed.spot.longitude;
    row.shape = "circle";
    row.radius = Placement.radiusFor("dungeons", placed.cand.category);
    row.placeCategory = placed.cand.category;
    row.placeName = placed.cand.row.name || "";
    row.name = this.nameFor(tpl.name, placed.cand);
    row.expiresAt = now + Placement.lifetimeMs("dungeons", placed.cand.category);
    Content.save("dungeons", row);

    st.nextDungeonAt = 0;
    this.saveState(zone.zoneId, st);
    return 1;
  },

  /* ------------------------------------------------------------- instances

     Regions, not chunks. A region is 2 km of ground; it rolls one or two
     instances the first time you come into it and then leaves them alone for
     one to three days. Walking through the 500 m chunks underneath changes
     nothing — they only draw what the region already put there.

     The time windows survive, but not as a gate. Something that lives two days
     is alive across every window, so instead they tilt *where* a region's roll
     lands: enter one at lunchtime and a food place is likelier, enter it at
     eight and a park is. */

  regionState(key) {
    const all = Store.get(this.KEY + "_regions", {}) || {};
    return all[key] || { rolled: 0, target: 0 };
  },
  saveRegionState(key, st) {
    Store.patch(this.KEY + "_regions", (all) => { all[key] = st; });
  },

  /** Instances this spawner owns in one region. */
  inRegion(regionKey) {
    return Content.list("instances").filter(r => r.origin === "auto" && r.regionKey === regionKey);
  },

  /**
   * Expired dungeons anywhere, not just in a loaded chunk.
   *
   * sweep() only ever sees the zones the game is currently holding, so a
   * dungeon in a chunk you walked away from would sit in storage until you
   * happened back. Walk a few kilometres and that is dozens of them. This runs
   * from wherever the player is and cleans up behind them.
   */
  sweepGlobal(now) {
    let gone = 0;
    Content.list("dungeons").forEach(row => {
      if (row.origin !== "auto") return;
      if (!row.expiresAt || now < row.expiresAt) return;
      if (this.inUse("dungeons", row)) return;
      Content.remove("dungeons", row.dungeonId);
      gone++;
    });
    return gone;
  },

  /** Expire instances whose days are up, wherever they are. */
  sweepRegions(now) {
    let gone = 0;
    const touched = {};
    Content.list("instances").forEach(row => {
      if (row.origin !== "auto") return;
      if (this.inUse("instances", row)) return;
      const done = this.cleared("instances", row);
      const expired = row.expiresAt && now >= row.expiresAt;
      if (!done && !expired) return;
      Content.remove("instances", row.instanceId);
      if (row.regionKey) touched[row.regionKey] = 1;
      gone++;
    });
    // A region with nothing left is ready to roll again next time you are in it.
    Object.keys(touched).forEach(key => {
      if (this.inRegion(key).length) return;
      this.saveRegionState(key, { rolled: 0, target: 0 });
    });
    return gone;
  },

  /**
   * Give one region its instances, if it has none. `region` is a Grid cell.
   */
  tickRegion(region, now, rnd, opts) {
    const rules = Placement.rulesFor("instances");
    const r = rnd || Math.random;
    if (this.inRegion(region.key).length) return 0;

    const st = this.regionState(region.key);
    if (st.rolled && now < st.rolled) return 0;

    const lo = Math.max(1, Math.round(+rules.perRegionMin || 1));
    const hi = Math.max(lo, Math.round(+rules.perRegionMax || lo));
    const target = lo + Math.floor(r() * (hi - lo + 1));

    // The whole region is the search area, so a 2 km cell can put its instance
    // anywhere in it rather than only where you happen to be standing.
    const cands = Placement.candidatesAround(
      region.latitude, region.longitude, region.coverM, "instances", now);
    if (!cands.length) return 0;

    const taken = Content.list("instances").map(x => ({ latitude: x.latitude, longitude: x.longitude }));
    const minFromPlayer = +rules.minFromPlayerM || 0;
    let made = 0;
    for (let i = 0; i < target; i++) {
      const sep = +rules.minSeparationM || 0;
      let base = cands;
      if (opts && opts.at && minFromPlayer) {
        const away = base.filter(c =>
          haversine(opts.at.latitude, opts.at.longitude, c.latitude, c.longitude) >= minFromPlayer);
        if (away.length) base = away;
      }
      let pool = Placement.spacedOut(base, taken, sep);
      if (!pool.length) pool = base;
      const chosen = Placement.pickByCategory(pool, "instances", now, r);
      if (!chosen) break;
      const spot = this.spotOn(chosen, r);

      const tpl = this.templateAnywhere("instances", r);
      const row = this.clone("instances", tpl, { zoneId: "" });
      row.latitude = spot.latitude;
      row.longitude = spot.longitude;
      row.regionKey = region.key;
      row.zoneId = "";                    // a region spans many chunk zones
      row.radius = Placement.radiusFor("instances", chosen.category);
      row.placeCategory = chosen.category;
      row.placeName = (chosen.row && chosen.row.name) || "";
      row.name = this.nameFor(tpl.name, chosen);
      row.expiresAt = now + this.instanceLifetimeMs(chosen.category, r);
      Content.save("instances", row);
      taken.push({ latitude: row.latitude, longitude: row.longitude });
      made++;
    }

    this.saveRegionState(region.key, { rolled: now, target });
    return made;
  },

  /** One to three days, tilted by category, rolled per instance. */
  instanceLifetimeMs(category, rnd) {
    const rules = Placement.rulesFor("instances");
    const r = rnd || Math.random;
    const lo = Math.max(0.25, +rules.lifetimeDaysMin || 1);
    const hi = Math.max(lo, +rules.lifetimeDaysMax || lo);
    const mult = +Placement.catRules("instances", category).lifetimeMultiplier || 1;
    const days = (lo + r() * (hi - lo)) * mult;
    return Math.round(days * 24 * 3600 * 1000);
  },

  /** A trail candidate is a line, so walk a little way along it. */
  spotOn(cand, rnd) {
    if (cand.category !== "trail") return Placement.spotIn(cand, rnd);
    const r = rnd || Math.random;
    // The row keeps a midpoint and a length, not the full line, so offset
    // along an arbitrary bearing by up to a third of the way's length. Close
    // enough to read as "on the path" without storing every point of it.
    const len = Math.max(10, +cand.row.lengthM || 40);
    const d = (r() - 0.5) * Math.min(len, 120);
    const p = projectPoint(cand.latitude, cand.longitude, Math.abs(d), r() * 360);
    return { latitude: p.latitude, longitude: p.longitude };
  },

  /** A template from anywhere — regions are not tied to one zone. */
  templateAnywhere(table, rnd) {
    const r = rnd || Math.random;
    const pool = Content.list(table).filter(x => x.origin !== "auto" && x.spawnable !== false);
    if (!pool.length) return Content.blankInstance(0, 0, "");
    const weights = pool.map(x => Math.max(0.01, +x.spawnWeight || 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = r() * total;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  },

  /** Name it after where it landed, so the map reads as a place not a clone. */
  nameFor(templateName, cand) {
    const where = (cand.row && cand.row.name) || "";
    if (!where) return templateName || "A dark place";
    if (!templateName) return where;
    return templateName + " · " + where;
  },

  /* ------------------------------------------------------------------ tick */

  /**
   * The whole job, cheap enough to call on every position fix. `opts.now`
   * lets a test drive the clock; `opts.rnd` pins the rolls.
   */
  tick(zone, opts) {
    opts = opts || {};
    if (!zone || typeof Content === "undefined" || typeof Placement === "undefined") return 0;
    const now = opts.now || Date.now();
    const rnd = opts.rnd;
    let changed = 0;
    changed += this.sweep(zone, now);
    changed += this.tickDungeons(zone, now, rnd, opts);
    return changed;
  },

  /**
   * The region half of the job, called with wherever the player is. Separate
   * from tick() because tick is per chunk-zone and this is emphatically not.
   */
  tickAt(lat, lng, opts) {
    opts = opts || {};
    if (typeof Grid === "undefined" || typeof Content === "undefined") return 0;
    const now = opts.now || Date.now();
    const rules = Placement.rulesFor("instances");
    let changed = this.sweepGlobal(now) + this.sweepRegions(now);
    const region = Grid.cellAt(lat, lng, +rules.regionSizeM || Grid.REGION_M);
    changed += this.tickRegion(region, now, opts.rnd, opts);
    return changed;
  },

  /** Dev: throw everything of ours away so the next tick starts over. */
  reset(zone) {
    let gone = 0;
    if (zone) {
      this.mine("dungeons", zone.zoneId).forEach(row => {
        if (this.inUse("dungeons", row)) return;
        Content.remove("dungeons", row.dungeonId);
        gone++;
      });
      Store.patch(this.KEY, (all) => { delete all[zone.zoneId]; });
    }
    // Instances are region-owned, so they go whatever zone you were in.
    Content.list("instances").forEach(row => {
      if (row.origin !== "auto") return;
      if (this.inUse("instances", row)) return;
      Content.remove("instances", row.instanceId);
      gone++;
    });
    Store.remove(this.KEY + "_regions");
    return gone;
  },

  /** A plain-words account of what is live and what is next. */
  status(zone, now) {
    if (!zone) return null;
    now = now || Date.now();
    const st = this.state(zone.zoneId);
    const dungeons = this.mine("dungeons", zone.zoneId);
    const instances = Content.list("instances").filter(r => r.origin === "auto");
    const soonest = dungeons.map(d => d.expiresAt || 0).filter(Boolean).sort()[0] || 0;
    const instSoonest = instances.map(d => d.expiresAt || 0).filter(Boolean).sort()[0] || 0;
    return {
      dungeons: dungeons.length,
      instances: instances.length,
      regions: Object.keys(Store.get(this.KEY + "_regions", {}) || {}).length,
      nextDungeonInMs: st.nextDungeonAt ? Math.max(0, st.nextDungeonAt - now) : 0,
      dungeonExpiresInMs: soonest ? Math.max(0, soonest - now) : 0,
      instanceExpiresInMs: instSoonest ? Math.max(0, instSoonest - now) : 0,
      places: (typeof Atlas !== "undefined" ? Atlas.stats().places : 0) || 0
    };
  }
};
