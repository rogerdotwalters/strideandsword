/* -------------------------------------------------------------------------
   11. Zone + node generation
   ------------------------------------------------------------------------- */
const Zones = {
  createZone(userId, lat, lng, label) {
    const s = settings();
    const zone = {
      zoneId: uid("zn"), userId, label: label || "Home Base",
      centerLatitude: lat, centerLongitude: lng,
      radius: s.zoneRadius, seed: uid("seed"),
      createdAt: nowTs(), lastModified: nowTs()
    };
    Store.patch(K.zones, (z) => { z[zone.zoneId] = zone; });
    API.request("/location/create-zone", "POST", zone);
    return zone;
  },

  /**
   * A zone made in the map editor has no player behind it, so it is stored
   * with userId "editor" and belongs to the world rather than to anyone. Every
   * character sees those as well as their own — without this, anything you
   * author in the editor is invisible in the game, which was the bug.
   */
  isShared(z) { return !!z && (z.shared === true || z.userId === "editor"); },

  zonesFor(userId) {
    const z = Store.get(K.zones, {}) || {};
    return Object.values(z).filter(x => x.userId === userId || this.isShared(x));
  },

  /** Every zone, whoever made it — what the map editor lists. */
  allZones() {
    return Object.values(Store.get(K.zones, {}) || {});
  },

  /**
   * The zone row standing in for one grid cell, created on first sight.
   *
   * A chunk *is* a zone rather than a parallel concept, which is what lets the
   * spawner, the placement scoring and the map editor all carry on unchanged.
   * Its radius is the cell's half-diagonal, so the circle covers the square.
   */
  forChunk(cell) {
    const all = Store.get(K.zones, {}) || {};
    const found = Object.values(all).find(z => z.chunkKey === cell.key);
    if (found) return found;
    const zone = {
      zoneId: uid("zn"), userId: "world", shared: true,
      kind: "chunk", chunkKey: cell.key,
      label: "Chunk " + cell.latIndex + "," + cell.lngIndex,
      centerLatitude: cell.latitude, centerLongitude: cell.longitude,
      radius: cell.coverM,
      bounds: { south: cell.south, north: cell.north, west: cell.west, east: cell.east },
      seed: uid("seed"),
      createdAt: nowTs(), lastModified: nowTs()
    };
    Store.patch(K.zones, (z) => { z[zone.zoneId] = zone; });
    return zone;
  },

  /** A hand-made zone containing this point, if there is one. */
  authoredAt(lat, lng) {
    return this.allZones().find(z =>
      z.kind !== "chunk" &&
      haversine(z.centerLatitude, z.centerLongitude, lat, lng) <= (+z.radius || 320));
  },

  /**
   * A hand-made zone that has asked to be left alone, containing this point.
   *
   * `authoredOnly` means "this zone shows exactly what I placed in it". On a
   * grid that has to reach the generator as well as the drawing: the chunk
   * under your office is generated whether you are standing in it or not, and
   * without this its eight sites would be scattered across the office and be
   * waiting for you the moment you stepped outside the zone's edge.
   */
  authoredOnlyAt(lat, lng) {
    const z = this.authoredAt(lat, lng);
    return z && z.authoredOnly ? z : null;
  },

  /**
   * Scatter sites across a grid cell rather than in a ring.
   *
   * generateNodes puts everything in a ring from 45 m out, because its centre
   * is where the player was standing when the zone was anchored. A chunk's
   * centre is just a grid line, so the sites want to be spread over the whole
   * square instead — with the "nothing on top of you" rule measured from the
   * player's actual position, which is what it always meant.
   */
  generateInCell(zone, cell, count, playerLevel, at) {
    const s = settings();
    const rand = seededRandom(zone.seed + ":cell:" + cell.key);
    const target = Math.max(1, count || 8);
    const placed = [];
    const MIN_GAP = 34, MIN_FROM_PLAYER = 45;
    let guard = 0;

    while (placed.length < target && guard < target * 80) {
      guard++;
      const p = Grid.pointIn(cell, rand);
      if (at && haversine(at.latitude, at.longitude, p.latitude, p.longitude) < MIN_FROM_PLAYER) continue;
      // Somebody's hand-made, leave-it-alone zone. Nothing procedural goes in.
      if (this.authoredOnlyAt(p.latitude, p.longitude)) continue;
      if (placed.some(o => haversine(o.latitude, o.longitude, p.latitude, p.longitude) < MIN_GAP)) continue;

      // Difficulty rises with distance from the cell's own centre, which keeps
      // a little of the "further out is meaner" shape without a home base.
      const fromMid = haversine(cell.latitude, cell.longitude, p.latitude, p.longitude);
      const ratio = clamp(fromMid / Math.max(1, cell.coverM), 0, 1);

      let type;
      const roll = rand();
      if (placed.length === target - 1 && !placed.some(n => n.type === "boss")) type = "boss";
      else if (roll < 0.60) type = "combat";
      else if (roll < 0.80) type = "treasure";
      else if (roll < 0.90) type = "landmark";
      else type = "boss";

      const difficulty = clamp(
        Math.round(1 + ratio * 6 + rand() * 2 + (playerLevel - 1) * 0.55 + (type === "boss" ? 3 : 0)),
        1, 10);

      placed.push({
        nodeId: uid("nd"), zoneId: zone.zoneId, chunkKey: cell.key,
        type, difficulty,
        latitude: p.latitude, longitude: p.longitude,
        name: pick(NODE_NAMES[type]),
        icon: { combat: "⚔️", treasure: "📦", boss: "👑", landmark: "⛲" }[type],
        status: "undiscovered",
        enemies: [],
        rewards: {
          experience: Math.round((70 + difficulty * 55) * (type === "boss" ? 2.4 : type === "treasure" ? 0.35 : 1)),
          gold: Math.round((18 + difficulty * 16) * (type === "treasure" ? 2.2 : type === "boss" ? 2.6 : 1)),
          items: []
        },
        distanceFromHome: Math.round(fromMid),
        createdAt: nowTs(),
        discoveredAt: null, clearedAt: null
      });
    }

    Store.patch(K.nodes, (all) => { placed.forEach(n => { all[n.nodeId] = n; }); });
    API.request("/nodes/generate", "POST", { zoneId: zone.zoneId, nodes: placed });
    return placed;
  },

  nodesIn(zoneId) {
    const all = Store.get(K.nodes, {}) || {};
    return Object.values(all).filter(n => n.zoneId === zoneId);
  },

  /** Every node belonging to any of these zones, in one pass. */
  nodesInAny(zoneIds) {
    const want = {};
    (zoneIds || []).forEach(id => { want[id] = 1; });
    const all = Store.get(K.nodes, {}) || {};
    return Object.values(all).filter(n => want[n.zoneId]);
  },

  /**
   * Procedural placement. Nodes go in a ring between 45m and the zone radius
   * so nothing spawns literally on top of the player, are spaced at least
   * 35m apart, and get a difficulty that rises with distance from home.
   */
  generateNodes(zone, count, playerLevel) {
    const s = settings();
    const rand = seededRandom(zone.seed + ":" + (count || s.nodeCount));
    const target = count || s.nodeCount;
    const minR = 45, maxR = zone.radius;
    const placed = [];
    let guard = 0;

    while (placed.length < target && guard < target * 60) {
      guard++;
      const bearing = rand() * 360;
      // sqrt keeps the ring area-uniform instead of clustering near the centre
      const dist = minR + Math.sqrt(rand()) * (maxR - minR);
      const p = projectPoint(zone.centerLatitude, zone.centerLongitude, dist, bearing);
      const tooClose = placed.some(o =>
        haversine(o.latitude, o.longitude, p.latitude, p.longitude) < 34);
      if (tooClose) continue;

      const distRatio = (dist - minR) / Math.max(1, maxR - minR);
      let type;
      const roll = rand();
      if (placed.length === target - 1 && !placed.some(n => n.type === "boss")) type = "boss";
      else if (roll < 0.60) type = "combat";
      else if (roll < 0.80) type = "treasure";
      else if (roll < 0.90) type = "landmark";
      else type = "boss";

      // Far nodes are meaner. That is the whole point of the walking.
      const difficulty = clamp(
        Math.round(1 + distRatio * 6 + rand() * 2 + (playerLevel - 1) * 0.55 + (type === "boss" ? 3 : 0)),
        1, 10);

      placed.push({
        nodeId: uid("nd"), zoneId: zone.zoneId, type, difficulty,
        latitude: p.latitude, longitude: p.longitude,
        name: pick(NODE_NAMES[type]),
        icon: { combat: "⚔️", treasure: "📦", boss: "👑", landmark: "⛲" }[type],
        status: "undiscovered",
        enemies: [],
        rewards: {
          experience: Math.round((70 + difficulty * 55) * (type === "boss" ? 2.4 : type === "treasure" ? 0.35 : 1)),
          gold: Math.round((18 + difficulty * 16) * (type === "treasure" ? 2.2 : type === "boss" ? 2.6 : 1)),
          items: []
        },
        distanceFromHome: Math.round(dist),
        discoveredAt: null, clearedAt: null
      });
    }

    Store.patch(K.nodes, (all) => { placed.forEach(n => { all[n.nodeId] = n; }); });
    API.request("/nodes/generate", "POST", { zoneId: zone.zoneId, nodes: placed });
    return placed;
  },

  updateNode(node, patch) {
    Object.assign(node, patch);
    Store.patch(K.nodes, (all) => { all[node.nodeId] = node; });
    API.request("/nodes/" + node.nodeId + "/status", "PATCH", patch);
  },

  /** Replace cleared nodes so the map keeps giving you reasons to walk. */
  respawnCleared(zone, playerLevel, at) {
    if (zone.authoredOnly) return 0;          // hand-placed zones are not reshuffled
    const nodes = this.nodesIn(zone.zoneId);
    // Never recycle a hand-placed site — the map editor owns those.
    const cleared = nodes.filter(n => n.status === "cleared" && n.type !== "landmark" && !n.locationId);
    if (cleared.length < 3) return 0;
    const toRemove = cleared.slice(0, cleared.length - 1);
    Store.patch(K.nodes, (all) => { toRemove.forEach(n => { delete all[n.nodeId]; }); });
    zone.seed = uid("seed");
    Store.patch(K.zones, (z) => { z[zone.zoneId] = zone; });

    /* A chunk zone refills its own square. generateNodes places a ring around
       the zone centre, which is a grid line here rather than anywhere you have
       been — and its nodes would carry no chunkKey, so nothing would ever
       expire them. */
    const cell = zone.chunkKey && typeof Grid !== "undefined" ? Grid.fromKey(zone.chunkKey) : null;
    const fresh = cell
      ? this.generateInCell(zone, cell, toRemove.length, playerLevel,
                            at || (typeof Loc !== "undefined" ? Loc.last : null))
      : this.generateNodes(zone, toRemove.length, playerLevel);
    return fresh.length;
  }
};
