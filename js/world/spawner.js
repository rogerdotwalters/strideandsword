"use strict";
/* -------------------------------------------------------------------------
   12d. Spawner — keeping dungeons and instances turning over.

   Two schedules, one weighting core (Placement):

     Dungeons   one alive in the zone at a time. It lasts three hours, or
                until you clear it, and the next one appears somewhere else
                about fifteen minutes later.

     Instances  one or two a day across the whole zone, arriving inside the
                hours their category keeps — parks morning and evening, food
                places at lunch and dinner.

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
    ["dungeons", "instances"].forEach(table => {
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
  placeFor(table, zone, now, rnd) {
    const rules = Placement.rulesFor(table);
    const taken = Content.list(table)
      .filter(r => r.zoneId === zone.zoneId || !r.zoneId)
      .map(r => ({ latitude: r.latitude, longitude: r.longitude }));

    let cands = Placement.candidates(zone, table, now);
    if (!cands.length) return null;

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

  tickDungeons(zone, now, rnd) {
    const rules = Placement.rulesFor("dungeons");
    const want = Math.max(0, Math.round(+rules.alive || 1));
    const have = this.mine("dungeons", zone.zoneId).length;
    if (have >= want) return 0;

    const st = this.state(zone.zoneId);
    if (st.nextDungeonAt && now < st.nextDungeonAt) return 0;

    const placed = this.placeFor("dungeons", zone, now, rnd);
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

  /* ------------------------------------------------------------- instances */

  tickInstances(zone, now, rnd) {
    const rules = Placement.rulesFor("instances");
    const r = rnd || Math.random;
    const st = this.state(zone.zoneId);
    const today = this.dayKey(now);

    // A fresh day rolls a fresh target. Once rolled it is stored, so a reload
    // does not reroll how many you are getting.
    if (st.day !== today) {
      const lo = Math.max(0, Math.round(+rules.perDayMin || 1));
      const hi = Math.max(lo, Math.round(+rules.perDayMax || lo));
      st.day = today;
      st.target = lo + Math.floor(r() * (hi - lo + 1));
      st.spawned = 0;
      this.saveState(zone.zoneId, st);
    }

    if (st.spawned >= st.target) return 0;
    // One at a time: the next only arrives once the last has gone.
    if (this.mine("instances", zone.zoneId).length) return 0;

    /* Hold off unless a category that actually keeps hours is open right now.
       Windows decide *when* the day's allowance is spent; weights decide
       *where* it goes. The distinction matters: "civic" has no hours, so if a
       category without windows counted as open, it would justify spawning at
       three in the morning and the whole schedule would collapse. It can still
       win the spot once some park or grocery has opened the door — it just
       cannot open the door itself.

       With no windows configured anywhere, this falls through to always, so
       emptying the windows out of the rules file does not freeze spawning. */
    const cands = Placement.candidates(zone, "instances", now);
    let anyWindows = false, anyOpen = false;
    cands.forEach(c => {
      const w = Placement.catRules("instances", c.category).windows;
      if (!w || !w.length) return;
      anyWindows = true;
      if (Placement.windowOpen(w, now)) anyOpen = true;
    });
    if (anyWindows && !anyOpen) return 0;

    const placed = this.placeFor("instances", zone, now, rnd);
    if (!placed) return 0;

    const tpl = this.template("instances", zone, rnd);
    const row = this.clone("instances", tpl, zone);
    row.latitude = placed.spot.latitude;
    row.longitude = placed.spot.longitude;
    row.radius = Placement.radiusFor("instances", placed.cand.category);
    row.placeCategory = placed.cand.category;
    row.placeName = placed.cand.row.name || "";
    row.name = this.nameFor(tpl.name, placed.cand);
    row.expiresAt = now + Placement.lifetimeMs("instances", placed.cand.category);
    Content.save("instances", row);

    st.spawned++;
    this.saveState(zone.zoneId, st);
    return 1;
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
    changed += this.tickDungeons(zone, now, rnd);
    changed += this.tickInstances(zone, now, rnd);
    return changed;
  },

  /** Dev: throw everything of ours away so the next tick starts over. */
  reset(zone) {
    if (!zone) return 0;
    let gone = 0;
    ["dungeons", "instances"].forEach(table => {
      this.mine(table, zone.zoneId).forEach(row => {
        if (this.inUse(table, row)) return;
        Content.remove(table, this.idOf(table, row));
        gone++;
      });
    });
    Store.patch(this.KEY, (all) => { delete all[zone.zoneId]; });
    return gone;
  },

  /** A plain-words account of what is live and what is next. */
  status(zone, now) {
    if (!zone) return null;
    now = now || Date.now();
    const st = this.state(zone.zoneId);
    const dungeons = this.mine("dungeons", zone.zoneId);
    const instances = this.mine("instances", zone.zoneId);
    const soonest = dungeons.map(d => d.expiresAt || 0).filter(Boolean).sort()[0] || 0;
    return {
      dungeons: dungeons.length,
      instances: instances.length,
      instancesToday: st.spawned || 0,
      instanceTarget: st.target || 0,
      nextDungeonInMs: st.nextDungeonAt ? Math.max(0, st.nextDungeonAt - now) : 0,
      dungeonExpiresInMs: soonest ? Math.max(0, soonest - now) : 0,
      places: (typeof Atlas !== "undefined" ? Atlas.stats().places : 0) || 0
    };
  }
};
