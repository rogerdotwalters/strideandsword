"use strict";
/* -------------------------------------------------------------------------
   11c. Chunks — the world filling in as you walk.

   A chunk is surveyed and generated the first time you come within range of
   it, and it stays that way until it ages out. Enter it and its *whole* set of
   locations exists at once; seeing them is a separate question, answered by
   the sight radius.

   THREE BUDGETS, AND WHY THEY ARE DIFFERENT SIZES

   Measured, the things this keeps are wildly different weights:

     one node row             ~400 bytes
     one Atlas building row    319 bytes
     one chunk's raw geometry  370 KB – 2 MB

   So they get different treatment rather than one blanket rule:

     raw geometry   a byte budget, least-recently-seen evicted first. It is the
                    only thing big enough to fill localStorage, and the only
                    thing that costs nothing but one query to get back.

     Atlas rows     kept. They are small, they are what the spawner reads, and
                    throwing them away would rename every street you walk back
                    down — the one thing that must stay stable.

     nodes          an hour, then a cap. Cheap either way; the hour is about
                    the world feeling fresh rather than about space.

   Nothing here runs on a timer. `sync()` is called when the game already
   happens to be looking, and everything it decides is a function of the clock
   it is handed.
   ------------------------------------------------------------------------- */
const Chunks = {
  KEY: "chunk_state",

  /* In-memory only: the digested geometry for chunks near enough to draw.
     Never persisted in this form — the raw elements are what gets cached. */
  loaded: {},

  /* ------------------------------------------------------------------ state */

  all() { return Store.get(this.KEY, {}) || {}; },
  get(key) { return this.all()[key] || null; },
  put(key, patch) {
    Store.patch(this.KEY, (all) => {
      all[key] = Object.assign({ key }, all[key] || {}, patch);
    });
    return this.get(key);
  },
  forget(key) { Store.patch(this.KEY, (all) => { delete all[key]; }); },

  settingsFor() {
    const s = settings();
    return {
      loadRadiusM:    +s.chunkLoadRadiusM    || 350,
      sightM:         +s.sightRadiusM        || 300,
      perChunk:       +s.locationsPerChunk   || 8,
      nodeTtlMs:      (+s.chunkNodeTtlMinutes || 60) * 60000,
      maxNodes:       +s.maxProceduralNodes  || 300,
      cacheBudget:    +s.chunkCacheBudgetBytes || 1800000,
      cacheMaxPer:    +s.chunkCacheMaxBytes  || 800000
    };
  },

  /* --------------------------------------------------------------- surveying */

  cacheKeyFor(cellKey) { return "osm_cache_" + cellKey; },

  /* How long a cached survey is trusted before it is worth asking again.
     Long on purpose: OSM asks to be cached rather than re-queried, buildings
     and streets barely move, and a month means a cell you walk daily costs one
     query a month rather than one a session. */
  CACHE_TTL_MS: 30 * 24 * 3600 * 1000,

  /* A cell whose survey failed is not retried immediately. Doubling from a
     minute to half an hour, remembered per cell, because without it a service
     that is down means every cell in range re-asking on every sync — five to
     seven queries every twenty seconds, forever, which is precisely the
     behaviour the usage policy exists to prevent. */
  RETRY_BASE_MS: 60000,
  RETRY_MAX_MS: 30 * 60000,

  retryAfterMs(st) {
    const n = Math.max(1, +(st && st.failCount) || 1);
    return Math.min(this.RETRY_MAX_MS, this.RETRY_BASE_MS * Math.pow(2, n - 1));
  },

  /** Is this cell allowed to ask the network again yet? */
  mayAsk(cellKey, now) {
    now = now || Date.now();
    if (typeof OSM !== "undefined" && OSM.coolOffMs(now) > 0) return false;
    const st = this.get(cellKey);
    if (!st || !st.failedAt) return true;
    return now - st.failedAt >= this.retryAfterMs(st);
  },

  /**
   * Make sure this cell has geometry, in memory and (budget permitting) in
   * storage. Returns the digest, or null when there is none to be had.
   *
   * Three ways to get one, cheapest first: already in memory, in the cache and
   * still inside its TTL, or a query. The third is the one with a cost to
   * somebody else, so everything above is about not reaching it.
   */
  async survey(cell, force, now) {
    now = now || Date.now();
    if (!force && this.loaded[cell.key]) return this.loaded[cell.key];

    const ck = this.cacheKeyFor(cell.key);
    const st = this.get(cell.key) || {};
    const fresh = !st.surveyedAt || (now - st.surveyedAt) < this.CACHE_TTL_MS;
    let elements = force || !fresh ? null : Store.get(ck, null);
    let fromCache = !!elements;

    if (!elements) {
      // Stale cache is still better than another query: if we are not allowed
      // to ask yet, use what we have rather than showing a blank cell.
      if (!this.mayAsk(cell.key, now)) {
        const stale = Store.get(ck, null);
        if (!stale) {
          /* Give this cell its own wait, so the cells held back by one global
             cool-off do not all rush the moment it lifts. failCount is left
             alone: being told to wait is not this cell's failure, and it
             should not compound its backoff. */
          this.put(cell.key, { failedAt: now });
          return null;
        }
        elements = stale;
        fromCache = true;
      } else {
        // The half-diagonal plus a margin, so the circle covers the square and
        // a little beyond — features straddling an edge belong to both cells.
        const r = await OSM.fetchAround(cell.latitude, cell.longitude, cell.coverM + 60);
        if (!r.success) {
          // A refusal to send (deferred) is not the same as a service that
          // answered badly, so only the latter lengthens the backoff.
          this.put(cell.key, r.deferred
            ? { failedAt: now }
            : { failedAt: now, failCount: (+st.failCount || 0) + 1 });
          const stale = Store.get(ck, null);
          if (!stale) return null;
          elements = stale;          // fall back to whatever we already had
          fromCache = true;
        } else {
          elements = OSM.prune(r.elements);
          this.put(cell.key, { failedAt: 0, failCount: 0 });
        }
      }
    }

    const digest = OSM.digest(elements);
    this.loaded[cell.key] = digest;

    if (!fromCache) {
      const cfg = this.settingsFor();
      try {
        const payload = JSON.stringify(elements);
        // A chunk too big to cache is not an error — it just re-surveys next
        // time rather than eating the whole budget on its own.
        if (payload.length <= cfg.cacheMaxPer) {
          Store.set(ck, elements);
          this.put(cell.key, { cacheBytes: payload.length });
        } else {
          this.put(cell.key, { cacheBytes: 0, tooBigToCache: true });
        }
      } catch (e) {
        this.put(cell.key, { cacheBytes: 0 });
      }
      this.put(cell.key, { surveyedAt: now });
    }
    return digest;
  },

  /* -------------------------------------------------------------- generating */

  /**
   * Everything a chunk owns: a zone row, a survey, and its locations. Safe to
   * call repeatedly — each step is skipped once it has been done.
   */
  async ensure(cell, ch, now, at) {
    const cfg = this.settingsFor();
    const zone = Zones.forChunk(cell);
    let changed = 0;

    const st = this.get(cell.key) || {};
    if (!st.zoneId) this.put(cell.key, { zoneId: zone.zoneId });

    const digest = await this.survey(cell, false, now);

    /* Generate whether or not the survey worked.
       The Atlas decides *where* a site prefers to sit, not whether it exists —
       scattering points in a cell needs no geometry at all. Gating generation
       on Overpass would mean a cell with no signal, or a service having a bad
       day, produces an empty world; the game has always been playable on a
       plain map and it stays that way. The cell is marked unsurveyed so the
       geometry is picked up later, and the snap re-runs when it arrives. */
    if (!this.get(cell.key).generatedAt) {
      const made = Zones.generateInCell(zone, cell, cfg.perChunk, (ch && ch.level) || 1, at);
      this.put(cell.key, { generatedAt: now, nodes: made.length, blind: !digest });
      changed += made.length;
    } else if (digest && this.get(cell.key).blind) {
      // Geometry finally arrived for a cell generated without it.
      this.put(cell.key, { blind: false });
      changed += 1;
    }
    this.put(cell.key, { lastSeenAt: now });
    return { zone, digest, changed };
  },

  /* ----------------------------------------------------------------- syncing */

  /** Which cells are close enough to be worth having. */
  inRange(lat, lng) {
    return Grid.chunksWithin(lat, lng, this.settingsFor().loadRadiusM);
  },

  /**
   * The whole job: bring every nearby chunk up to date, drop what has drifted
   * out of memory, and evict what no longer fits. Returns a summary so the
   * caller knows whether anything is worth redrawing.
   *
   * Surveys are done one at a time on purpose. Three chunks arriving at once
   * would be three simultaneous Overpass queries from one device, which is
   * exactly the behaviour their fair-use terms ask you not to have.
   */
  async sync(lat, lng, ch, opts) {
    opts = opts || {};
    const now = opts.now || Date.now();
    const at = { latitude: lat, longitude: lng };
    const cells = this.inRange(lat, lng);
    const wanted = {};
    cells.forEach(c => { wanted[c.key] = c; });

    let generated = 0, surveyed = 0, failed = 0;
    for (const cell of cells) {
      const had = !!this.loaded[cell.key];
      const r = await this.ensure(cell, ch, now, at);
      if (!r.digest) failed++;
      else if (!had) surveyed++;
      generated += r.changed;
      /* The cell you are standing in comes back first, so tell the caller as
         soon as it lands rather than making it wait for the neighbours. On a
         cold start that is the difference between a map in one query and a
         blank screen for five. */
      if (opts.onCell) { try { opts.onCell(cell, r); } catch (e) { /* drawing is not our problem */ } }
    }

    // Anything no longer near enough leaves memory. Its cache and its nodes
    // stay until the budgets say otherwise — this is only about what is drawn.
    let unloaded = 0;
    Object.keys(this.loaded).forEach(key => {
      if (wanted[key]) return;
      delete this.loaded[key];
      unloaded++;
    });

    const evicted = this.evict(now, wanted);
    return { cells, surveyed, generated, unloaded, failed, evicted,
             changed: generated + surveyed + unloaded + evicted.caches + evicted.nodes };
  },

  /* ---------------------------------------------------------------- evicting */

  /**
   * Trim back to the budgets. Never touches a chunk currently in range, and
   * never a node that is mid-fight — whatever the clock says, taking the
   * ground out from under someone is not a saving worth making.
   */
  evict(now, keepKeys) {
    const cfg = this.settingsFor();
    const keep = keepKeys || {};
    const out = { caches: 0, nodes: 0, bytes: 0 };
    const state = this.all();

    /* ---- raw geometry, by byte budget, least recently seen first ---- */
    const cached = Object.values(state)
      .filter(c => c.cacheBytes > 0 && !keep[c.key])
      .sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0));
    let total = Object.values(state).reduce((n, c) => n + (c.cacheBytes || 0), 0);

    for (const c of cached) {
      if (total <= cfg.cacheBudget) break;
      Store.remove(this.cacheKeyFor(c.key));
      total -= c.cacheBytes;
      out.bytes += c.cacheBytes;
      out.caches++;
      this.put(c.key, { cacheBytes: 0 });
    }

    /* ---- nodes: an hour, then a cap ---- */
    const busy = (typeof Game !== "undefined" && Game.inCombat &&
                  typeof Combat !== "undefined" && Combat.node) ? Combat.node.nodeId : null;
    const all = Store.get(K.nodes, {}) || {};
    const mine = Object.values(all).filter(n => n.chunkKey && !n.locationId);
    const doomed = {};

    mine.forEach(n => {
      if (n.nodeId === busy) return;
      if (keep[n.chunkKey]) return;                   // still standing in it
      if (now - (n.createdAt || 0) >= cfg.nodeTtlMs) doomed[n.nodeId] = 1;
    });

    // Over the cap: oldest first, still never one you are in range of.
    const surviving = mine.filter(n => !doomed[n.nodeId]);
    if (surviving.length > cfg.maxNodes) {
      surviving
        .filter(n => n.nodeId !== busy && !keep[n.chunkKey])
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .slice(0, surviving.length - cfg.maxNodes)
        .forEach(n => { doomed[n.nodeId] = 1; });
    }

    const ids = Object.keys(doomed);
    if (ids.length) {
      Store.patch(K.nodes, (a) => { ids.forEach(id => delete a[id]); });
      out.nodes = ids.length;

      // A chunk with nothing left is forgotten entirely, so walking back into
      // it generates a fresh set rather than an empty one.
      const left = {};
      Object.values(Store.get(K.nodes, {}) || {}).forEach(n => {
        if (n.chunkKey) left[n.chunkKey] = 1;
      });
      Object.values(state).forEach(c => {
        if (c.generatedAt && !left[c.key] && !keep[c.key]) this.put(c.key, { generatedAt: 0, nodes: 0 });
      });
    }
    return out;
  },

  /* ------------------------------------------------------------------ world */

  /**
   * One world built out of every loaded chunk, in the shape renderWorld and
   * the placement scoring already expect. Rebuilt when the loaded set changes
   * rather than held incrementally — it happens on chunk transitions, which is
   * rare enough that the simple version is the right one.
   */
  mergedWorld() {
    const buildings = [], roads = [], places = [];
    const seen = {};
    Object.keys(this.loaded).forEach(key => {
      const d = this.loaded[key];
      if (!d) return;
      // Features straddling an edge come back from both surveys; the OSM id is
      // what makes them one thing again.
      (d.buildings || []).forEach(b => {
        const id = b.row.osmId || b.row.key;
        if (seen["b" + id]) return; seen["b" + id] = 1; buildings.push(b);
      });
      (d.roads || []).forEach(r => {
        const id = r.row.osmId || r.row.key;
        if (seen["r" + id]) return; seen["r" + id] = 1; roads.push(r);
      });
      (d.places || []).forEach(p => {
        const id = p.row.osmId || p.row.key;
        if (seen["p" + id]) return; seen["p" + id] = 1; places.push(p);
      });
    });
    return { buildings, roads, places };
  },

  /** Every chunk zone currently in memory, for the spawner and for drawing. */
  loadedZones() {
    const out = [];
    Object.keys(this.loaded).forEach(key => {
      const st = this.get(key);
      if (!st || !st.zoneId) return;
      const z = (Store.get(K.zones, {}) || {})[st.zoneId];
      if (z) out.push(z);
    });
    return out;
  },

  /** A plain-words account, for the dev panel. */
  status(lat, lng, now) {
    now = now || Date.now();
    const state = this.all();
    const keys = Object.keys(state);
    const bytes = keys.reduce((n, k) => n + (state[k].cacheBytes || 0), 0);
    const nodes = Object.values(Store.get(K.nodes, {}) || {}).filter(n => n.chunkKey).length;
    const osm = (typeof OSM !== "undefined") ? OSM : null;
    return {
      known: keys.length,
      loaded: Object.keys(this.loaded).length,
      inRange: (lat != null) ? this.inRange(lat, lng).length : 0,
      cached: keys.filter(k => state[k].cacheBytes > 0).length,
      cacheKB: Math.round(bytes / 1024),
      budgetKB: Math.round(this.settingsFor().cacheBudget / 1024),
      nodes,
      here: (lat != null) ? Grid.chunkAt(lat, lng).key : "—",
      region: (lat != null) ? Grid.regionAt(lat, lng).key : "—",
      // What we have asked the map service to do for us, and whether it has
      // asked us to stop.
      queries: osm ? osm.stats.requests : 0,
      queriesOk: osm ? osm.stats.ok : 0,
      deferred: osm ? osm.stats.deferred : 0,
      coolOffMs: osm ? osm.coolOffMs(now) : 0,
      waiting: keys.filter(k => state[k].failedAt).length
    };
  },

  /** Dev: throw the whole chunked world away and start over. */
  reset() {
    Object.keys(this.all()).forEach(k => Store.remove(this.cacheKeyFor(k)));
    Store.remove(this.KEY);
    this.loaded = {};
    const all = Store.get(K.nodes, {}) || {};
    const ids = Object.values(all).filter(n => n.chunkKey).map(n => n.nodeId);
    Store.patch(K.nodes, (a) => { ids.forEach(id => delete a[id]); });
    Store.patch(K.zones, (z) => {
      Object.values(z).forEach(x => { if (x.kind === "chunk") delete z[x.zoneId]; });
    });
    return ids.length;
  }
};
