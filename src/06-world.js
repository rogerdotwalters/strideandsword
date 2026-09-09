/* -------------------------------------------------------------------------
   9. Settings
   ------------------------------------------------------------------------- */
const DEFAULT_SETTINGS = {
  locationMode: "gps",       // "gps" = your real position | "sim" = dev testing
  gpsUpdateInterval: 6000,   // ms between accepted position updates
  interactRange: 35,         // metres to trigger a node
  zoneRadius: 320,           // metres — how far nodes spread from the office
  nodeCount: 11,
  mapZoom: 18,
  followPlayer: true,
  devMode: false,            // dev panel visibility (forced on in sim mode)
  highAccuracy: true,
  dailyGoalMeters: 3000,
  fantasyMap: true,          // draw real roads/buildings as a fantasy town
  tileOpacity: 0.3,          // how much of the real map shows under the overlay
  labelZoom: 18,             // zoom at which street names appear
  snapNodesToBuildings: true
};
function settings() {
  return Object.assign({}, DEFAULT_SETTINGS, Store.get(K.settings, {}) || {});
}
function saveSettings(patch) {
  const s = Object.assign(settings(), patch);
  Store.set(K.settings, s);
  return s;
}

/* -------------------------------------------------------------------------
   10. Character factory & progression
   ------------------------------------------------------------------------- */
const Characters = {
  BASE_ATTR: 8,
  POOL: 14,

  blankAllocation() {
    const o = {};
    ATTRS.forEach(a => { o[a.key] = 0; });
    return o;
  },

  /** base 8 + point buy + race mods + class mods, floored at 3. */
  finalAttributes(allocation, raceKey, classKey) {
    const out = {};
    ATTRS.forEach(a => { out[a.key] = this.BASE_ATTR + (allocation[a.key] || 0); });
    const apply = (mods) => { for (const k in mods) out[k] = (out[k] || 0) + mods[k]; };
    if (RACES[raceKey])   apply(RACES[raceKey].mods);
    if (CLASSES[classKey]) apply(CLASSES[classKey].mods);
    ATTRS.forEach(a => { out[a.key] = Math.max(3, out[a.key]); });
    return out;
  },

  create(userId, name, classKey, raceKey, allocation) {
    const ch = {
      characterId: uid("chr"), userId, name,
      class: classKey, race: raceKey,
      level: 1, experience: 0, unspentPoints: 0, gold: 60,
      attributes: this.finalAttributes(allocation, raceKey, classKey),
      stats: { hp: 0, maxHp: 0, mana: 0, maxMana: 0, stamina: 0, maxStamina: 0 },
      equipment: [],
      inventory: [],
      position: { latitude: null, longitude: null, lastUpdated: null },
      createdAt: nowTs()
    };
    this.refreshMaxes(ch, true);
    return ch;
  },

  /** Recompute derived maxima; optionally top the character right up. */
  refreshMaxes(ch, full) {
    const s = ch.stats;
    const mh = Calc.maxHp(ch), mm = Calc.maxMana(ch), ms = Calc.maxStamina(ch);
    s.maxHp = mh; s.maxMana = mm; s.maxStamina = ms;
    if (full) { s.hp = mh; s.mana = mm; s.stamina = ms; }
    s.hp = clamp(s.hp, 0, mh);
    s.mana = clamp(s.mana, 0, mm);
    s.stamina = clamp(s.stamina, 0, ms);
    return ch;
  },

  skillsFor(ch) {
    return CLASSES[ch.class].skills.filter(sk => ch.level >= sk.lvl);
  },

  addXp(ch, amount) {
    ch.experience += amount;
    const gains = [];
    while (ch.experience >= Calc.xpForLevel(ch.level)) {
      ch.experience -= Calc.xpForLevel(ch.level);
      ch.level += 1;
      ch.unspentPoints += 5;
      this.refreshMaxes(ch, true);
      const unlocked = CLASSES[ch.class].skills.filter(sk => sk.lvl === ch.level);
      gains.push({ level: ch.level, unlocked });
    }
    return gains;
  },

  save(ch) {
    Store.patch(K.characters, (all) => { all[ch.characterId] = ch; });
    API.request("/character/" + ch.characterId, "PATCH", ch);
  }
};

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

  zonesFor(userId) {
    const z = Store.get(K.zones, {}) || {};
    return Object.values(z).filter(x => x.userId === userId);
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
    const nodes = this.nodesIn(zone.zoneId);
    const cleared = nodes.filter(n => n.status === "cleared" && n.type !== "landmark");
    if (cleared.length < 3) return 0;
    const toRemove = cleared.slice(0, cleared.length - 1);
    Store.patch(K.nodes, (all) => { toRemove.forEach(n => { delete all[n.nodeId]; }); });
    zone.seed = uid("seed");
    Store.patch(K.zones, (z) => { z[zone.zoneId] = zone; });
    const fresh = this.generateNodes(zone, toRemove.length, playerLevel);
    return fresh.length;
  }
};

/* -------------------------------------------------------------------------
   12. LocationService
   Wraps geolocation, distance accumulation and node proximity checks.
   Simulated positions from the dev panel flow through the exact same path,
   so nothing downstream needs to know where a fix came from.
   ------------------------------------------------------------------------- */
const Loc = {
  watchId: null,
  simulated: false,
  last: null,           // { latitude, longitude, accuracy, ts }
  lastAccepted: 0,
  status: "idle",       // idle | requesting | live | simulated | denied | error
  listeners: [],

  permissionState: "unknown",   // granted | prompt | denied | unknown

  onUpdate(fn) { this.listeners.push(fn); },
  _emit() { this.listeners.forEach(fn => { try { fn(this.last); } catch (e) { console.error(e); } }); },

  /**
   * Why location might not work here. Browsers only hand out GPS on a secure
   * origin, and Chrome and Safari additionally refuse to remember a permission
   * for a file:// page — there is no origin to attach it to — so the prompt
   * never appears at all. That is the single most common reason this page
   * looks like it "never asked".
   */
  diagnose() {
    const proto = location.protocol;
    const host = location.hostname;
    const localhost = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "";
    return {
      protocol: proto,
      host: host || "(none)",
      href: location.href,
      hasGeo: !!navigator.geolocation,
      isFile: proto === "file:",
      isLocalhost: localhost,
      secureContext: !!window.isSecureContext,
      // file: reports as a secure context but still cannot hold a permission
      canPrompt: !!navigator.geolocation && proto !== "file:" &&
                 (proto === "https:" || localhost),
      permission: this.permissionState
    };
  },

  /** Read the stored permission where the browser exposes it. */
  async permissionQuery() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return "unknown";
      const st = await navigator.permissions.query({ name: "geolocation" });
      this.permissionState = st.state;
      st.onchange = () => {
        this.permissionState = st.state;
        if (st.state === "granted" && settings().locationMode === "gps" && this.watchId == null) this.start();
        Game.renderHud();
      };
      return st.state;
    } catch (e) { return "unknown"; }
  },

  /**
   * Ask for permission. MUST be called from a click or tap: several browsers
   * only surface the prompt while the page has user activation, which is why
   * asking silently at load can look like nothing happened.
   */
  requestPermission() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        return resolve({ ok: false, code: 0, message: "This browser has no Geolocation API." });
      }
      // Permission may already have been granted elsewhere (browser settings,
      // another tab) and a watch may already be feeding us. Don't ask again.
      if (this.status === "live" && this.last && !this.simulated && nowTs() - this.last.ts < 60000) {
        this.permissionState = "granted";
        return resolve({ ok: true, accuracy: this.last.accuracy || 0 });
      }

      this.status = "requesting";
      Game.renderHud();
      let retried = false;

      const onOk = (pos) => {
        this.permissionState = "granted";
        this.simulated = false;
        this.status = "live";
        this.accept({
          latitude: pos.coords.latitude, longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy, ts: nowTs()
        }, true);
        this.start();                        // hold the watch open from here
        resolve({ ok: true, accuracy: pos.coords.accuracy });
      };
      const onErr = (err) => {
        // High accuracy can time out indoors; a coarse fix is better than none.
        if (err.code === 3 && !retried) {
          retried = true;
          navigator.geolocation.getCurrentPosition(onOk, onErr,
            { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
          return;
        }
        this.status = err.code === 1 ? "denied" : "error";
        if (err.code === 1) this.permissionState = "denied";
        Game.renderHud();
        resolve({ ok: false, code: err.code, message: err.message || "" });
      };
      // maximumAge lets the browser answer with a fix it already holds. Asking
      // for a brand-new sample (maximumAge 0) can hang for a stationary device
      // whose position genuinely hasn't changed.
      navigator.geolocation.getCurrentPosition(onOk, onErr,
        { enableHighAccuracy: settings().highAccuracy, timeout: 15000, maximumAge: 30000 });
    });
  },

  /**
   * Real GPS is the default and the only thing that moves you, unless the
   * player has explicitly ticked dev testing. A denial is reported, never
   * papered over with a fake position.
   */
  start() {
    const s = settings();
    if (s.locationMode === "sim") {
      this.stop();
      this.startSimulated();
      Game.setLocStatus("Dev testing — your real location is ignored.");
      return;
    }
    if (!navigator.geolocation) {
      this.status = "error";
      Game.onLocationProblem("This browser has no geolocation support.");
      return;
    }
    this.stop();                 // never stack watches
    this.status = "requesting";
    Game.setLocStatus("Asking for your location…");
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const first = !this.last || this.simulated;
        this.simulated = false;
        this.status = "live";
        this.accept({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          ts: nowTs()
        }, first);
        if (first) Game.setLocStatus("Location locked on. ±" + Math.round(pos.coords.accuracy) + " m.");
      },
      (err) => {
        this.status = err.code === 1 ? "denied" : "error";
        if (err.code === 1) this.permissionState = "denied";
        Game.onLocationProblem(err.code === 1
          ? "Location permission was denied."
          : err.code === 3 ? "Location timed out — no fix yet."
          : "Location is unavailable on this device right now.", err.code);
      },
      { enableHighAccuracy: s.highAccuracy, maximumAge: 3000, timeout: 15000 }
    );
  },

  stop() {
    if (this.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
  },

  startSimulated(lat, lng) {
    this.simulated = true;
    this.status = "simulated";
    const la = lat != null ? lat : (this.last ? this.last.latitude : 41.8827);
    const ln = lng != null ? lng : (this.last ? this.last.longitude : -87.6233);
    this.accept({ latitude: la, longitude: ln, accuracy: 5, ts: nowTs(), sim: true });
  },

  /** Manual/simulated move — same pipeline as a real GPS fix. */
  simulateTo(lat, lng) {
    this.simulated = true;
    if (this.status !== "live") this.status = "simulated";
    this.accept({ latitude: lat, longitude: lng, accuracy: 5, ts: nowTs(), sim: true }, true);
  },

  accept(fix, force) {
    const s = settings();
    if (!force && this.last && nowTs() - this.lastAccepted < s.gpsUpdateInterval) return;
    // Ignore jitter smaller than the reported accuracy — stops the walk
    // counter inflating while you sit still.
    if (this.last) {
      const moved = haversine(this.last.latitude, this.last.longitude, fix.latitude, fix.longitude);
      const noiseFloor = fix.sim ? 0 : Math.max(4, Math.min(25, (fix.accuracy || 15) * 0.6));
      if (moved > noiseFloor) Walk.add(moved);
      else if (!force) { this.last = fix; this.lastAccepted = nowTs(); this._emit(); return; }
    }
    this.last = fix;
    this.lastAccepted = nowTs();
    this._emit();
  },

  nearest(nodes) {
    if (!this.last) return null;
    let best = null;
    for (const n of nodes) {
      if (n.status === "cleared") continue;
      const d = haversine(this.last.latitude, this.last.longitude, n.latitude, n.longitude);
      if (!best || d < best.distance) best = { node: n, distance: d };
    }
    return best;
  },

  distanceTo(node) {
    if (!this.last) return null;
    return haversine(this.last.latitude, this.last.longitude, node.latitude, node.longitude);
  }
};

/* -------------------------------------------------------------------------
   13. Walk tracker — the part that actually nags you to move
   ------------------------------------------------------------------------- */
const Walk = {
  todayKey() { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); },
  data() {
    const w = Store.get(K.walk, null) || { day: this.todayKey(), meters: 0, total: 0, xpBanked: 0, goalHit: false };
    if (w.day !== this.todayKey()) { w.day = this.todayKey(); w.meters = 0; w.xpBanked = 0; w.goalHit = false; }
    return w;
  },
  add(meters) {
    if (!isFinite(meters) || meters <= 0 || meters > 400) return; // 400m in one tick = a car
    const w = this.data();
    w.meters += meters;
    w.total += meters;
    Store.set(K.walk, w);
    Game.onWalked(meters, w);
  },
  reset() { Store.set(K.walk, { day: this.todayKey(), meters: 0, total: 0, xpBanked: 0, goalHit: false }); }
};
