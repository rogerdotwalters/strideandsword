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

  nodesIn(zoneId) {
    const all = Store.get(K.nodes, {}) || {};
    return Object.values(all).filter(n => n.zoneId === zoneId);
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
  respawnCleared(zone, playerLevel) {
    if (zone.authoredOnly) return 0;          // hand-placed zones are not reshuffled
    const nodes = this.nodesIn(zone.zoneId);
    // Never recycle a hand-placed site — the map editor owns those.
    const cleared = nodes.filter(n => n.status === "cleared" && n.type !== "landmark" && !n.locationId);
    if (cleared.length < 3) return 0;
    const toRemove = cleared.slice(0, cleared.length - 1);
    Store.patch(K.nodes, (all) => { toRemove.forEach(n => { delete all[n.nodeId]; }); });
    zone.seed = uid("seed");
    Store.patch(K.zones, (z) => { z[zone.zoneId] = zone; });
    const fresh = this.generateNodes(zone, toRemove.length, playerLevel);
    return fresh.length;
  }
};
