/* -------------------------------------------------------------------------
   16. Game controller + map + HUD
   ------------------------------------------------------------------------- */
const Game = {
  ch: null, zone: null, nodes: [], map: null, mapless: false,
  playerMarker: null, accCircle: null, zoneCircle: null,
  nodeMarkers: {}, rangeCircle: null,
  inCombat: false, locMsg: "", trail: null, trailPts: [],
  _pendingNode: null, _regenTimer: null,

  reset() {
    Loc.stop();
    if (this._regenTimer) clearInterval(this._regenTimer);
    this.ch = null; this.zone = null; this.nodes = []; this.map = null;
    this.nodeMarkers = {}; this.trailPts = []; this.inCombat = false;
    this.mapless = false;
    this.instDoors = null; this._pendingInst = null;
    this.world = null; this._worldZone = null; this._worldBusy = false;
    this.tiles = null; this.worldLayer = null;
    this.dungeonLayer = null; this.dungeonShapes = {}; this._pendingDungeon = null;
    this.artLayer = null;
    this.streetLabels = null; this.buildingLabels = null;
    this._locPrompt = false;
    this._lastSpawnCheck = 0;
  },

  start(ch) {
    Characters.refreshMaxes(ch);
    this.ch = ch;
    const inv = Store.get(K.inventories, {}) || {};
    if (inv[ch.characterId]) ch.inventory = inv[ch.characterId];
    Screens.show("game");
    this.watchAuthoring();
  },

  mount(root) {
    const screen = el("div", "screen");
    screen.id = "gameScreen";
    screen.innerHTML =
      '<div id="map"></div>' +
      '<div id="instMap"></div>' +
      '<div class="instHint hidden" id="instHint"></div>' +
      '<div class="topBar">' +
        '<div class="charChip">' +
          '<div class="avatar" id="chAvatar"></div>' +
          '<div class="who"><b id="chName"></b><span id="chSub"></span></div>' +
        "</div>" +
        '<div class="spacer"></div>' +
        '<button class="iconBtn" id="btnSheet" title="Character">📋</button>' +
        '<button class="iconBtn" id="btnBag" title="Inventory">🎒</button>' +
        '<button class="iconBtn" id="btnMenu" title="Menu">☰</button>' +
      "</div>" +
      // Directly after the dev panel so CSS can slide it aside when that opens.
      '<div id="devPanel" class="hidden"></div>' +
      '<div class="zoomModes hidden" id="zoomModes"></div>' +
      '<div class="bars">' +
        '<div class="modeRow" id="modeRow">' +
          '<label class="modeLbl">' +
            '<input type="checkbox" id="modeToggle">' +
            '<span class="lbl">Dev test <small>simulate my location</small></span>' +
          "</label>" +
          '<button class="gpsChip" id="wGps">…</button>' +
        "</div>" +
        '<div class="dungeonBar hidden" id="dungeonBar"></div>' +
        '<div class="instBar hidden" id="instBar"></div>' +
        '<div class="walkStrip">' +
          '<div class="st"><span>Today</span><b id="wToday">0 m</b></div>' +
          '<div class="st"><span>All time</span><b id="wTotal">0 m</b></div>' +
          '<div class="st"><span>Nearest</span><b id="wNear">--</b></div>' +
        "</div>" +
        '<div class="barsInner">' +
          '<div class="bar"><span class="lbl">❤</span>' + UI.bar("hp", 1, 1) + '<span class="num" id="nHp"></span></div>' +
          '<div class="bar"><span class="lbl">✦</span>' + UI.bar("mp", 1, 1) + '<span class="num" id="nMp"></span></div>' +
          '<div class="bar"><span class="lbl">⚡</span>' + UI.bar("sp", 1, 1) + '<span class="num" id="nSp"></span></div>' +
          '<div class="bar"><span class="lbl">★</span>' + UI.bar("xp", 0, 1) + '<span class="num" id="nXp"></span></div>' +
        "</div>" +
      "</div>";
    root.appendChild(screen);

    $("#btnSheet").onclick = () => Panels.sheet();
    $("#btnBag").onclick   = () => Panels.inventory();
    $("#btnMenu").onclick  = () => Panels.menu();

    const toggle = $("#modeToggle");
    toggle.checked = settings().locationMode === "sim";
    toggle.onchange = (e) => this.setLocationMode(e.target.checked ? "sim" : "gps");
    $("#wGps").onclick = () => {
      if (settings().locationMode === "sim") { this.setLocationMode("gps"); return; }
      if (Loc.status === "live") { this.locationDiagnostics(); return; }
      this.beginLocation(true);
    };

    this.initMap();
    this.renderHud();
    this.buildDevPanel();

    Loc.onUpdate(() => this.onPosition());
    this.beginLocation();

    // If a watch is running but nothing arrives, say so — never silently
    // pretend to be somewhere.
    setTimeout(() => {
      if (!Loc.last && settings().locationMode === "gps" && Loc.watchId != null) {
        this.onLocationProblem("Still waiting on a location fix.", 3);
      }
    }, 25000);

    this._regenTimer = setInterval(() => this.passiveRegen(), 12000);
  },

  /* ---- Map ---- */
  initMap() {
    const s = settings();
    const start = Loc.last || { latitude: 41.8827, longitude: -87.6233 };

    // Leaflet comes off a CDN. If it didn't load (offline, blocked network),
    // fall back to a compass list so the game is still playable.
    if (typeof L === "undefined") {
      this.mapless = true;
      this.buildListView();
      setTimeout(() => UI.toast(
        "Map library didn't load — switched to list view. Reconnect and reload for the map.", "bad", 6500), 400);
      return;
    }

    // maxZoom 24 with maxNativeZoom 19 means deep zoom upscales the last real
    // tile instead of requesting tiles that don't exist and going blank. OSM
    // has no tiles past 19, but the fantasy town is drawn as vectors from the
    // Overpass geometry, so it stays sharp all the way in — which is the whole
    // reason it's worth zooming past the raster at all.
    this.map = L.map("map", {
      zoomControl: true, attributionControl: true,
      maxZoom: 24, minZoom: 12, zoomSnap: 0.5, zoomDelta: 0.5
    }).setView([start.latitude, start.longitude], s.mapZoom);

    this.tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 24, maxNativeZoom: 19, minZoom: 12, keepBuffer: 3,
      opacity: s.fantasyMap ? s.tileOpacity : 1,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(this.map);

    this.worldLayer = L.layerGroup().addTo(this.map);   // fantasy roads + buildings
    this.trail = L.polyline([], { color: "#4a8fd4", weight: 3, opacity: .5, dashArray: "4 6" }).addTo(this.map);

    // Dev: click to teleport (only while dev testing is switched on)
    this.map.on("click", (e) => {
      if (settings().locationMode !== "sim") return;
      Loc.simulateTo(e.latlng.lat, e.latlng.lng);
      UI.toast("Moved to " + e.latlng.lat.toFixed(5) + ", " + e.latlng.lng.toFixed(5), "info", 1500);
    });

    this.map.on("zoomend", () => {
      // Remember wherever you left it, so a recentre doesn't yank you back.
      const z = this.map.getZoom();
      saveSettings({ mapZoom: z, zoomMode: zoomModeAt(z) });
      this.applyZoomDetail();
    });
    this.buildZoomModes();
    this.applyZoomDetail();
  },

  /* ---- the two zoom presets ------------------------------------------- */

  buildZoomModes() {
    const host = $("#zoomModes");
    if (!host || this.mapless) return;
    host.innerHTML = ZOOM_MODES.map(m =>
      '<button class="zmBtn" data-z="' + m.key + '" title="' + m.hint + '">' +
        '<span class="zmIc">' + m.icon + "</span>" +
        '<span class="zmLb">' + m.label + "</span>" +
      "</button>").join("");
    host.classList.remove("hidden");
    host.querySelectorAll(".zmBtn").forEach(b => {
      b.onclick = () => this.setZoomMode(b.dataset.z);
    });
    this.syncZoomModes();
  },

  /** Jump to a preset, centred on the player when we have a fix. */
  setZoomMode(key) {
    if (this.mapless || !this.map) return;
    const s = saveSettings({ zoomMode: key, mapZoom: zoomOf(key) });
    const z = zoomOf(key, s);
    const p = Loc.last;
    const c = p ? [p.latitude, p.longitude]
                : (this.map.getCenter ? this.map.getCenter() : null);
    if (c) this.map.setView(c, z, { animate: true });
    else this.map.setZoom(z);
    this.applyZoomDetail();   // the map may already be at that zoom, so no event
  },

  /** Light whichever preset the current zoom matches — or neither. */
  syncZoomModes() {
    const host = $("#zoomModes");
    if (!host || !this.map) return;
    const now = zoomModeAt(this.map.getZoom());
    host.querySelectorAll(".zmBtn").forEach(b => {
      b.classList.toggle("on", b.dataset.z === now);
    });
  },

  /** Buildings and street labels only make sense close in. */
  applyZoomDetail() {
    if (this.mapless || !this.map) return;
    const z = this.map.getZoom();
    const s = settings();
    const host = $("#map");
    if (host) host.classList.toggle("zBuildings", z >= 16);
    this.syncZoomModes();

    // The single owner of tile opacity. Dim only when there is actually an
    // overlay to dim under — a failed survey leaves the plain map at full
    // strength. Past native zoom the photograph goes soft while the drawn town
    // stays crisp, so let the drawing take over rather than showing a blur.
    if (this.tiles) {
      const drawn = s.fantasyMap && !!this.world;
      const base = drawn ? s.tileOpacity : 1;
      this.tiles.setOpacity(drawn && z > 19 ? base * 0.55 : base);
    }
    const swap = (layer, on) => {
      if (!layer) return;
      const has = this.map.hasLayer(layer);
      if (on && !has) this.map.addLayer(layer);
      if (!on && has) this.map.removeLayer(layer);
    };
    swap(this.streetLabels, s.fantasyMap && z >= s.labelZoom);
    swap(this.buildingLabels, s.fantasyMap && z >= s.labelZoom + 1.5);

    // Stroke width is in pixels, so roads need restyling as you zoom or they
    // read as hairlines up close and as a smear far out.
    if (this.roadLayers && this._styledZoom !== z) {
      this._styledZoom = z;
      this.roadLayers.forEach(r => {
        const st = OSM.roadStyle(r.highway, z);
        r.layer.setStyle({ weight: st.weight, opacity: st.opacity });
      });
    }
  },

  ensureZone() {
    if (this.zone || !Loc.last) return;
    const existing = Zones.zonesFor(this.ch.userId);
    const near = existing.find(z =>
      haversine(z.centerLatitude, z.centerLongitude, Loc.last.latitude, Loc.last.longitude) < z.radius * 1.6);
    if (near) {
      this.zone = near;
      this.nodes = Zones.nodesIn(near.zoneId);
      // A zone marked hand-placed keeps only its authored sites. Procedural
      // ones stay in storage untouched, so the flag is reversible.
      if (this.zone.authoredOnly) this.nodes = this.nodes.filter(n => n.locationId);
      else if (!this.nodes.length) this.nodes = Zones.generateNodes(near, null, this.ch.level);
    } else {
      this.zone = Zones.createZone(this.ch.userId, Loc.last.latitude, Loc.last.longitude, "Office Grounds");
      this.nodes = Zones.generateNodes(this.zone, null, this.ch.level);
      UI.toast("Zone anchored. " + this.nodes.length + " sites scattered nearby.", "good", 3400);
    }
    // The seed rows in data/*.json carry placeholder coordinates. Shift them
    // onto this zone the first time one exists, so the samples are walkable
    // from wherever you actually are.
    const moved = (typeof DB !== "undefined") ? DB.rehomeSeed(this.zone) : 0;
    if (moved) UI.toast("Placed " + moved + " sample sites around you.", "good", 3000);
    if (typeof Spawner !== "undefined") { try { Spawner.tick(this.zone); } catch (e) {} }
    this.syncAuthoredLocations();
    this.drawZone();
    this.drawNodes();
    this.drawDungeons();
    this.drawInstanceDoors();
    this.renderDungeonBar();
    if (Instance.current()) this.enterInstanceView();
    else this.renderInstanceBar();
    this.loadWorld();
  },

  /**
   * Give the spawner a turn, and redraw if it did anything.
   *
   * This is the whole scheduling mechanism. There is no timer: the question
   * "should there be a dungeon here right now?" is recomputed whenever the
   * game already happens to be looking — every position fix, and every time
   * the tab comes back to the front. Nothing accumulates, so nothing is lost
   * by not running while the phone is in a pocket.
   */
  runSpawner(opts) {
    opts = opts || {};
    if (typeof Spawner === "undefined" || !this.zone) return 0;
    // A rate limit, not a timer. GPS fixes arrive every second or so and the
    // answer cannot change that fast, so the scan over the Atlas is worth
    // doing about twice a minute rather than on every one.
    const now = opts.now || Date.now();
    if (!opts.force && this._lastSpawnCheck && now - this._lastSpawnCheck < 30000) return 0;
    this._lastSpawnCheck = now;
    let n = 0;
    try {
      n = Spawner.tick(this.zone, opts);
    } catch (e) {
      console.warn("[spawn]", e && e.message);
      return 0;
    }
    if (!n) return 0;
    this.syncAuthoredLocations();
    if (!this.mapless) { this.drawDungeons(); this.drawInstanceDoors(); }
    this.renderDungeonBar();
    if (!Instance.current()) this.renderInstanceBar();
    if (this.mapless) this.renderListView();
    this.fillDevJump();
    return n;
  },

  /**
   * Re-read everything the editors may have changed and redraw. The game and
   * the map editor are two tabs over one storage area, so this runs whenever
   * this tab comes back to the front, and on the storage event the browser
   * fires when the other tab writes. Without it you had to reload to see
   * anything you had just placed.
   */
  refreshAuthored(opts) {
    if (!this.zone) { this.ensureZone(); return; }
    const zones = Store.get(K.zones, {}) || {};
    if (zones[this.zone.zoneId]) this.zone = zones[this.zone.zoneId];
    this.runSpawner();
    const r = this.syncAuthoredLocations();
    if (this.mapless) { this.renderListView(); }
    else {
      this.drawZone();
      this.drawNodes();
      this.drawDungeons();
      this.drawInstanceDoors();
    }
    this.renderDungeonBar();
    if (!Instance.current()) this.renderInstanceBar();
    this.renderHud();
    const n = r.added + r.updated + r.removed;
    if (opts && opts.announce && n) {
      UI.toast("Reloaded authored content — " + r.added + " new, " + r.updated +
               " updated, " + r.removed + " removed.", "good", 2600);
    }
    return r;
  },

  /** Called once, from the game screen, to keep the two tabs in step. */
  watchAuthoring() {
    if (this._watchingAuthoring) return;
    this._watchingAuthoring = true;
    const bump = () => { if (Screens.current === "game" && this.zone) this.refreshAuthored(); };
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) bump(); });
    window.addEventListener("storage", (e) => {
      if (!e || !e.key) return;
      if (/content_|zones|nodes/.test(e.key)) bump();
    });
  },

  /**
   * Fold hand-placed locations into the live node list: add new ones, adopt
   * edits made in the map editor while keeping whatever progress the player
   * has made against them, and drop nodes whose location has been deleted.
   */
  syncAuthoredLocations() {
    if (!this.zone) return { added: 0, updated: 0, removed: 0 };
    const locs = Content.locationsFor(this.zone.zoneId);
    const byLoc = {};
    this.nodes.forEach(n => { if (n.locationId) byLoc[n.locationId] = n; });
    let added = 0, updated = 0;

    locs.forEach(loc => {
      const fresh = Content.locationToNode(loc, this.zone);
      const cur = byLoc[loc.locationId];
      if (cur) {
        const progress = { status: cur.status, discoveredAt: cur.discoveredAt, clearedAt: cur.clearedAt };
        Object.assign(cur, fresh, progress);
        // An older build could snap an authored site onto a building. Its
        // coordinates come back from the editor, so any anchor left over from
        // that now points somewhere else — drop it rather than keep a lie.
        delete cur.anchorKey; delete cur.anchorName; delete cur.anchorKind;
        Store.patch(K.nodes, (all) => { all[cur.nodeId] = cur; });
        updated++;
      } else {
        const stored = (Store.get(K.nodes, {}) || {})[fresh.nodeId];
        if (stored) Object.assign(fresh, {
          status: stored.status, discoveredAt: stored.discoveredAt, clearedAt: stored.clearedAt
        });
        this.nodes.push(fresh);
        Store.patch(K.nodes, (all) => { all[fresh.nodeId] = fresh; });
        added++;
      }
    });

    const live = {};
    locs.forEach(l => { live[l.locationId] = 1; });
    const drop = this.nodes.filter(n => n.locationId && !live[n.locationId]);
    if (drop.length) {
      Store.patch(K.nodes, (all) => { drop.forEach(n => delete all[n.nodeId]); });
      this.nodes = this.nodes.filter(n => drop.indexOf(n) < 0);
    }

    this.refreshAuthoredState();
    return { added, updated, removed: drop.length };
  },

  /** Respawn cooldowns and opening hours, re-evaluated on every fix. */
  refreshAuthoredState() {
    const now = Date.now();
    let changed = false;
    this.nodes.forEach(n => {
      if (!n.locationId) return;
      const loc = Content.get("locations", n.locationId);
      if (!loc) return;
      if (n.status === "cleared" && n.clearedAt) {
        const at = Content.respawnAt(loc, n.clearedAt);
        if (at && now >= at) {
          const back = n.discoveredAt ? "discovered" : "undiscovered";
          Zones.updateNode(n, { status: back, clearedAt: null });
          changed = true;
        }
      }
      const open = Content.isLocationActive(loc, now);
      if (!!n.closed === open) changed = true;
      n.closed = !open;
    });
    return changed;
  },

  /* ---- The fantasy town: real OSM geometry, renamed and restyled ---- */
  async loadWorld(force) {
    if (this.mapless || !this.zone || this._worldBusy) return;
    if (!settings().fantasyMap) return;
    if (this._worldZone === this.zone.zoneId && !force) return;
    this._worldBusy = true;
    this._worldZone = this.zone.zoneId;

    const cacheKey = OSM.cacheKey(this.zone);
    let elements = force ? null : Store.get(cacheKey, null);

    if (!elements) {
      UI.toast("Surveying the streets…", "info", 2600);
      const r = await OSM.fetchAround(this.zone.centerLatitude, this.zone.centerLongitude,
                                      Math.round(this.zone.radius + 140));
      if (!r.success) {
        this._worldBusy = false;
        this._worldZone = null;
        UI.toast("Couldn't reach the map data service — showing the plain map. " +
                 "Try 'Resurvey the streets' from the menu later.", "bad", 6000);
        this.applyZoomDetail();   // no overlay, so the plain map goes to full
        return;
      }
      elements = r.elements;
      // Cache geometry so a reload is instant and works offline.
      try {
        const payload = JSON.stringify(elements);
        if (payload.length < 2000000) Store.set(cacheKey, elements);
      } catch (e) { /* over quota — fine, we just refetch next time */ }
    }

    const world = OSM.digest(elements);
    this.world = world;
    this.renderWorld(world);
    this.snapNodesToBuildings(world);
    this._worldBusy = false;

    const st = Atlas.stats();
    UI.toast("The town takes shape: " + world.buildings.length + " buildings and " +
             st.streetNames + " named roads.", "good", 4200);
  },

  renderWorld(world) {
    if (this.mapless || !this.worldLayer) return;
    this.worldLayer.clearLayers();
    if (!this.streetLabels) this.streetLabels = L.layerGroup();
    if (!this.buildingLabels) this.buildingLabels = L.layerGroup();
    this.streetLabels.clearLayers();
    this.buildingLabels.clearLayers();
    const s = settings();

    // Roads first so buildings sit on top of them.
    this.roadLayers = [];
    const z0 = this.map.getZoom();
    world.roads.forEach(r => {
      const st = OSM.roadStyle(r.highway, z0);
      const line = L.polyline(r.line, {
        color: st.color, weight: st.weight, opacity: st.opacity,
        dashArray: st.dash, lineCap: "round", lineJoin: "round",
        className: "fRoad " + st.cls, interactive: true
      });
      line.bindTooltip(r.row.name, { className: "streetLabel", direction: "center", sticky: true });
      line.on("click", (e) => {
        L.DomEvent.stop(e);
        this.describeStreet(r.row);
      });
      this.worldLayer.addLayer(line);
      this.roadLayers.push({ layer: line, highway: r.highway });
    });

    world.buildings.forEach(b => {
      const kind = Atlas.KINDS[b.row.kind] || Atlas.KINDS.cottage;
      const poly = L.polygon(b.ring, {
        color: kind.color, weight: 1.2, opacity: .9,
        fillColor: kind.color, fillOpacity: .32,
        className: "fBuilding", interactive: true
      });
      poly.bindTooltip(kind.icon + " " + b.row.name, { className: "buildingLabel", direction: "top", sticky: true });
      poly.on("click", (e) => {
        L.DomEvent.stop(e);
        this.describeBuilding(b.row);
      });
      this.worldLayer.addLayer(poly);
      if (b.area > 140) {
        this.buildingLabels.addLayer(L.marker([b.row.latitude, b.row.longitude], {
          interactive: false, keyboard: false,
          icon: L.divIcon({ className: "pinWrap",
            html: '<div class="worldLabel bLabel">' + kind.icon + " " + esc(b.row.name) + "</div>",
            iconSize: [0, 0], iconAnchor: [0, 0] })
        }));
      }
    });

    // Label every named segment: at label zoom only a handful are on screen,
    // and you want the name of the road you're actually standing on.
    world.roads.forEach(r => {
      if (!r.row.realName) return;             // unnamed alleys stay unlabelled
      const mid = r.line[Math.floor(r.line.length / 2)];
      this.streetLabels.addLayer(L.marker(mid, {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: "pinWrap",
          html: '<div class="worldLabel sLabel">' + esc(r.row.name) + "</div>",
          iconSize: [0, 0], iconAnchor: [0, 0] })
      }));
    });

    this.applyZoomDetail();
  },

  describeBuilding(row) {
    UI.modal({
      title: row.name, icon: (Atlas.KINDS[row.kind] || {}).icon || "🏠",
      body:
        '<div class="kv"><span>Kind</span><b>' + esc(cap(row.kindLabel)) + "</b></div>" +
        '<div class="kv"><span>Footprint</span><b>' + row.area + " m²</b></div>" +
        (row.realName ? '<div class="kv"><span>Known to outsiders as</span><b>' + esc(row.realName) + "</b></div>" : "") +
        (row.address ? '<div class="kv"><span>Address</span><b>' + esc(row.address) + "</b></div>" : "") +
        '<div class="kv"><span>Atlas key</span><b class="tiny">' + esc(row.key) + "</b></div>" +
        '<div class="kv"><span>Source</span><b class="tiny">' + esc(row.osmId || row.source) + "</b></div>",
      buttons: [{ label: "Close", cls: "ghost" }]
    });
  },

  describeStreet(row) {
    UI.modal({
      title: row.name, icon: "🛣️",
      body:
        '<div class="kv"><span>Type</span><b>' + esc(row.kind.replace(/_/g, " ")) + "</b></div>" +
        (row.realName ? '<div class="kv"><span>Known to outsiders as</span><b>' + esc(row.realName) + "</b></div>" : "") +
        '<div class="kv"><span>Segment length</span><b>' + fmtDist(row.lengthM) + "</b></div>" +
        '<div class="kv"><span>Atlas key</span><b class="tiny">' + esc(row.key) + "</b></div>" +
        '<div class="kv"><span>Source</span><b class="tiny">' + esc(row.osmId || row.source) + "</b></div>",
      buttons: [{ label: "Close", cls: "ghost" }]
    });
  },

  /**
   * Move each site onto a real building so "walk to The Crooked Tankard" means
   * walking to an actual doorway. One building per site, nearest wins.
   */
  snapNodesToBuildings(world) {
    if (!settings().snapNodesToBuildings || !world.buildings.length) return;
    const taken = new Set(this.nodes.map(n => n.anchorKey).filter(Boolean));
    const MIN_GAP = 34;         // the same spacing the generator guarantees
    const MIN_FROM_HOME = 45;  // and the same inner radius of its ring
    const range = +Placement.rulesFor("locations").snapRangeM || 75;
    let moved = 0;
    this.nodes.forEach(n => {
      if (n.anchorKey || n.status === "cleared") return;
      // Never move a hand-placed site. You put it on that doorway on purpose,
      // and shifting it onto the nearest building would quietly undo that.
      if (n.locationId) return;

      // Every building in range that doesn't shove this site onto a neighbour,
      // and doesn't drag it inside the ring the generator placed it in. That
      // second rule matters more now than it used to: nearest-wins rarely moved
      // a node far, but a weighted pick will happily reach the full range, and
      // a site pulled in to 34 m undoes the "nothing spawns on top of you"
      // floor that generateNodes works to keep.
      const zc = this.zone;
      const legal = Atlas.nearBuildings(n.latitude, n.longitude, range, taken).filter(cand => {
        if (zc) {
          const fromHome = haversine(zc.centerLatitude, zc.centerLongitude,
                                     cand.row.latitude, cand.row.longitude);
          if (fromHome < MIN_FROM_HOME || fromHome > zc.radius) return false;
        }
        return this.nodes.every(o => o === n ||
          haversine(cand.row.latitude, cand.row.longitude, o.latitude, o.longitude) >= MIN_GAP);
      });
      if (!legal.length) return;

      // Weighted rather than nearest-wins: what the building is, what it sits
      // inside, and how near a road it is all count. Nothing is excluded — the
      // dullest building in range is still a possible answer, just a less
      // likely one than the market by the road.
      const scored = legal.map(cand => ({
        latitude: cand.row.latitude, longitude: cand.row.longitude, row: cand.row,
        weight: Placement.scoreBuilding(cand.row, world.roads, Date.now())
      }));
      const won = Placement.pick(scored);
      const near = won ? legal.find(c => c.row.key === won.row.key) : null;
      if (!near) return;
      taken.add(near.row.key);
      Zones.updateNode(n, {
        latitude: near.row.latitude, longitude: near.row.longitude,
        anchorKey: near.row.key, anchorName: near.row.name,
        anchorKind: near.row.kindLabel,
        name: near.row.name,
        icon: n.type === "boss" ? "👑" : n.type === "treasure" ? "📦" :
              n.type === "landmark" ? "⛲" : (Atlas.KINDS[near.row.kind] || {}).icon || "⚔️"
      });
      moved++;
    });
    if (moved) { this.drawNodes(); this.renderHud(); }
  },

  /* Fallback presentation when Leaflet is unavailable. */
  buildListView() {
    const host = $("#map");
    if (!host) return;
    host.innerHTML =
      '<div id="listView" style="position:absolute;inset:0;overflow-y:auto;padding:58px 12px 190px">' +
        '<div class="card" style="padding:12px;margin-bottom:10px">' +
          '<b style="font-size:13px">List view</b>' +
          '<p class="tiny dim" style="margin:5px 0 0">The map tiles could not load. Sites are listed by ' +
          'distance and bearing instead — walk toward one and it will open the same way.</p>' +
        "</div>" +
        '<div id="listNodes"></div>' +
      "</div>";
  },

  renderListView() {
    const host = $("#listNodes");
    if (!host) return;
    const rows = this.nodes.map(n => {
      const d = Loc.distanceTo(n);
      return { n, d: d == null ? Infinity : d };
    }).sort((a, b) => a.d - b.d);
    const s = settings();
    host.innerHTML = "";
    if (!rows.length) { host.innerHTML = '<div class="emptyMsg">Waiting for a position fix…</div>'; return; }
    rows.forEach(({ n, d }) => {
      const inRange = d <= s.interactRange;
      const row = el("div", "item r-" + (n.status === "cleared" ? "common" :
        n.type === "boss" ? "epic" : n.type === "treasure" ? "legendary" : "rare"));
      row.style.cursor = "pointer";
      const brg = Loc.last ? Game.bearingTo(Loc.last.latitude, Loc.last.longitude, n.latitude, n.longitude) : 0;
      const compass = ["N","NE","E","SE","S","SW","W","NW"][Math.round(brg / 45) % 8];
      row.innerHTML =
        '<span class="ico">' + (n.status === "cleared" ? "✓" : n.icon) + "</span>" +
        '<div class="body"><div class="nm">' + esc(n.name) +
          (n.type !== "landmark" ? ' <span class="badge">d' + n.difficulty + "</span>" : "") + "</div>" +
        '<div class="ds">' + fmtDist(d) + " · " + compass + " · " + cap(n.status) + "</div></div>" +
        '<div class="acts"><span class="badge" style="' +
          (inRange && n.status !== "cleared" ? "border-color:var(--ok);color:var(--ok)" : "") + '">' +
          (n.status === "cleared" ? "done" : inRange ? "in range" : "walk") + "</span></div>";
      row.onclick = () => this.openNode(n);
      host.appendChild(row);
    });
  },

  drawZone() {
    if (this.mapless) return;
    if (this.zoneCircle) this.map.removeLayer(this.zoneCircle);
    this.zoneCircle = L.circle([this.zone.centerLatitude, this.zone.centerLongitude], {
      radius: this.zone.radius, color: "#e0a33e", weight: 1, opacity: .35,
      fillColor: "#e0a33e", fillOpacity: .04, className: "rangeRing", interactive: false
    }).addTo(this.map);
  },

  drawNodes() {
    if (this.mapless) { this.renderListView(); return; }
    for (const id in this.nodeMarkers) this.map.removeLayer(this.nodeMarkers[id]);
    this.nodeMarkers = {};
    this.drawLocationArt();
    this.nodes.forEach(n => this.drawNode(n));
  },

  /**
   * The PNGs hand-placed locations carry, on the ground under their pins.
   * They are placed in metres, so they hold their size against the buildings
   * however far you zoom — which is the only way a picture of the loading dock
   * can sit on the actual loading dock.
   */
  drawLocationArt() {
    if (this.mapless || !this.map || typeof Art === "undefined") return;
    if (typeof L === "undefined" || typeof L.imageOverlay !== "function") return;
    if (!this.artLayer) this.artLayer = L.layerGroup().addTo(this.map);
    this.artLayer.clearLayers();
    if (!this.zone) return;
    Content.locationsFor(this.zone.zoneId).forEach(loc => {
      if (!loc.image) return;
      if (!Content.isLocationActive(loc, Date.now())) return;
      Art.add(this.artLayer, loc);
    });
  },

  drawNode(n) {
    if (this.mapless) { this.renderListView(); return; }
    if (this.nodeMarkers[n.nodeId]) { this.map.removeLayer(this.nodeMarkers[n.nodeId]); }
    const cleared = n.status === "cleared";
    const html =
      '<div class="pin ' + n.type + (cleared ? " cleared" : "") + (n.closed ? " closed" : "") +
        '" data-node="' + n.nodeId + '" title="' + (n.closed ? "Closed right now" : "") + '">' +
        (cleared ? "✓" : n.closed ? "🕒" : n.icon) +
        (n.type !== "landmark" && !cleared ? '<span class="diff">' + n.difficulty + "</span>" : "") +
      "</div>";
    const icon = L.divIcon({ html, className: "pinWrap",
      iconSize: [n.type === "boss" ? 42 : 34, n.type === "boss" ? 42 : 34],
      iconAnchor: [n.type === "boss" ? 21 : 17, n.type === "boss" ? 21 : 17] });
    const m = L.marker([n.latitude, n.longitude], { icon }).addTo(this.map);
    m.on("click", () => this.openNode(n));
    this.nodeMarkers[n.nodeId] = m;
  },

  /* ---- Position pipeline ---- */
  onPosition() {
    const p = Loc.last;
    if (!p) return;

    // Location started working — by the button, by the browser's own settings,
    // or by a watch that finally delivered. Get the dialog out of the way.
    if (this._gate && !Loc.simulated && Loc.status === "live") {
      this._gate.close();
      UI.toast("Location on" + (p.accuracy ? " — ±" + Math.round(p.accuracy) + " m" : "") + ".", "good", 2800);
    }

    this.ch.position = { latitude: p.latitude, longitude: p.longitude, lastUpdated: nowTs() };

    if (this.mapless) {
      this.ensureZone();
      this.runSpawner();
      this.checkProximity();
      this.renderListView();
      this.renderHud();
      this.refreshDevReadout();
      Characters.save(this.ch);
      return;
    }

    if (!this.playerMarker) {
      this.playerMarker = L.marker([p.latitude, p.longitude], {
        icon: L.divIcon({ html: '<div class="playerPin"></div>', className: "pinWrap",
                          iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000
      }).addTo(this.map);
      this.map.setView([p.latitude, p.longitude], settings().mapZoom);
    } else {
      this.playerMarker.setLatLng([p.latitude, p.longitude]);
      if (settings().followPlayer) this.map.panTo([p.latitude, p.longitude], { animate: true, duration: .5 });
    }

    if (this.accCircle) this.map.removeLayer(this.accCircle);
    if (p.accuracy && p.accuracy > 8) {
      this.accCircle = L.circle([p.latitude, p.longitude], {
        radius: p.accuracy, color: "#4a8fd4", weight: 1, opacity: .3,
        fillColor: "#4a8fd4", fillOpacity: .07, interactive: false
      }).addTo(this.map);
    }

    if (this.rangeCircle) this.map.removeLayer(this.rangeCircle);
    this.rangeCircle = L.circle([p.latitude, p.longitude], {
      radius: settings().interactRange, color: "#54b37a", weight: 1, opacity: .45,
      fillColor: "#54b37a", fillOpacity: .05, interactive: false
    }).addTo(this.map);

    this.trailPts.push([p.latitude, p.longitude]);
    if (this.trailPts.length > 400) this.trailPts.shift();
    this.trail.setLatLngs(this.trailPts);

    this.ensureZone();
    this.runSpawner();
    this.checkProximity();
    this.renderHud();
    this.refreshDevReadout();
    Characters.save(this.ch);
  },

  /* ---- Dungeons ----
     A dungeon is drawn as its footprint plus a door at the centre, so you can
     see how far you have to walk to be inside it rather than guessing from a
     pin. Circles and rectangles are the only two shapes, which is what keeps
     both the drawing and the containment test honest. */
  dungeons() {
    return this.zone ? Content.dungeonsFor(this.zone.zoneId).filter(d => d.active !== false) : [];
  },

  drawDungeons() {
    if (this.mapless || !this.map) return;
    if (!this.dungeonLayer) this.dungeonLayer = L.layerGroup().addTo(this.map);
    this.dungeonLayer.clearLayers();
    this.dungeonShapes = {};
    const run = Dungeon.current();
    this.dungeons().forEach(d => {
      const kind = Content.dungeonKind(d.kind);
      const inside = run && run.dungeonId === d.dungeonId;
      const sealed = Dungeon.cooldownLeft(d) > 0;
      const style = {
        color: inside ? "#e0a33e" : sealed ? "#5a6478" : kind.color,
        weight: inside ? 3 : 2, opacity: sealed ? .45 : .85,
        fillColor: inside ? "#e0a33e" : kind.color,
        fillOpacity: sealed ? .05 : .12,
        dashArray: sealed ? "4 6" : null, interactive: true
      };
      const shape = d.shape === "rect"
        ? L.rectangle(Content.dungeonCorners(d), style)
        : L.circle([d.latitude, d.longitude], Object.assign({ radius: +d.radius || 40 }, style));
      shape.on("click", () => Dungeon.open(d, Loc.distanceTo({ latitude: d.latitude, longitude: d.longitude })));
      this.dungeonLayer.addLayer(shape);
      this.dungeonShapes[d.dungeonId] = shape;

      const door = L.marker([d.latitude, d.longitude], {
        icon: L.divIcon({ className: "pinWrap",
          html: '<div class="dungeonPin' + (inside ? " inside" : "") + (sealed ? " sealed" : "") +
                (d.origin === "auto" ? " spawned" : "") +
                '" data-dungeon="' + d.dungeonId + '">' + (sealed ? "🔒" : kind.icon) +
                '<span class="fl">' + (d.floors || []).length + "</span></div>",
          iconSize: [40, 40], iconAnchor: [20, 20] })
      });
      door.on("click", () => Dungeon.open(d, Loc.distanceTo({ latitude: d.latitude, longitude: d.longitude })));
      this.dungeonLayer.addLayer(door);
    });
  },

  /** The strip above the walk stats while a run is going. */
  renderDungeonBar() {
    const host = $("#dungeonBar");
    if (!host) return;
    const run = Dungeon.current();
    if (!run) { host.classList.add("hidden"); host.innerHTML = ""; return; }
    const d = Dungeon.def(run.dungeonId);
    if (!d) { host.classList.add("hidden"); return; }
    const floor = (d.floors || [])[run.floor] || {};
    const len = Math.max(20, +floor.lengthMeters || 200);
    const pct = clamp(run.walked / len * 100, 0, 100);
    const next = Dungeon.nextStop();
    const kind = Content.dungeonKind(d.kind);
    host.classList.remove("hidden");
    host.innerHTML =
      '<div class="dvTop">' +
        '<span class="dvIco">' + kind.icon + "</span>" +
        "<b>" + esc(Content.floorName(d, floor, run.floor)) + "</b>" +
        '<span class="tiny dim">' + (run.floor + 1) + " of " + (d.floors || []).length + "</span>" +
        '<span class="spacer"></span>' +
        '<button class="btn sm ghost" id="dgnLeave">Step out</button>' +
      "</div>" +
      '<div class="dvTrack"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<div class="dvFoot">' +
        "<span>" + Math.round(run.walked) + " / " + len + " m</span>" +
        "<span>" + (next
          ? (Content.STOP_KINDS[next.stop.kind] || {}).icon + " in " + Math.max(0, Math.round(next.away)) + " m"
          : "the way is clear") + "</span>" +
      "</div>";
    const btn = $("#dgnLeave");
    if (btn) btn.onclick = () => Dungeon.leave();
  },

  checkDungeonProximity() {
    if (this.inCombat || Dungeon.current()) return;
    const p = Loc.last;
    if (!p) return;
    for (const d of this.dungeons()) {
      const edge = Content.distanceToDungeon(d, p.latitude, p.longitude);
      const near = edge <= (+d.entryRange || 25);
      const pin = document.querySelector('.dungeonPin[data-dungeon="' + d.dungeonId + '"]');
      if (pin) pin.classList.toggle("inrange", near && Dungeon.canEnter(d, edge).ok);
      if (near && this._pendingDungeon !== d.dungeonId) {
        this._pendingDungeon = d.dungeonId;
        Dungeon.open(d, edge);
        return;                    // one door at a time
      }
      if (!near && this._pendingDungeon === d.dungeonId) this._pendingDungeon = null;
    }
  },

  /* ================================================== INSTANCES ==========
     Doors on the real map, and behind each one a floor of its own. */

  instances() {
    return this.zone ? Content.instancesFor(this.zone.zoneId).filter(d => d.active !== false) : [];
  },

  drawInstanceDoors() {
    if (this.mapless || !this.map) return;
    if (!this.instDoors) this.instDoors = L.layerGroup().addTo(this.map);
    this.instDoors.clearLayers();
    this.instances().forEach(d => {
      const kind = Content.instanceKind(d.kind);
      const sealed = Instance.cooldownLeft(d) > 0;
      const inside = (Instance.current() || {}).instanceId === d.instanceId;
      this.instDoors.addLayer(L.circle([d.latitude, d.longitude], {
        radius: +d.radius || 30,
        color: inside ? "#e0a33e" : sealed ? "#5a6478" : kind.color,
        weight: 1.5, opacity: sealed ? .4 : .8,
        fillColor: kind.color, fillOpacity: sealed ? .04 : .10,
        dashArray: sealed ? "4 6" : null, interactive: false
      }));
      const door = L.marker([d.latitude, d.longitude], {
        icon: L.divIcon({ className: "pinWrap",
          html: '<div class="instDoor' + (inside ? " inside" : "") + (sealed ? " sealed" : "") +
                (d.origin === "auto" ? " spawned" : "") +
                '" data-inst="' + d.instanceId + '">' + (sealed ? "🔒" : kind.icon) +
                '<span class="lv">' + (d.levels || []).length + "</span></div>",
          iconSize: [40, 40], iconAnchor: [20, 20] })
      });
      door.on("click", () => Instance.open(d, Loc.distanceTo(d)));
      this.instDoors.addLayer(door);
    });
  },

  checkInstanceProximity() {
    if (this.inCombat || Instance.current() || Dungeon.current()) return;
    const p = Loc.last;
    if (!p) return;
    for (const d of this.instances()) {
      const dist = haversine(p.latitude, p.longitude, d.latitude, d.longitude);
      const near = dist <= (+d.radius || 30);
      const pin = document.querySelector('.instDoor[data-inst="' + d.instanceId + '"]');
      if (pin) pin.classList.toggle("inrange", near && Instance.canEnter(d, dist).ok);
      if (near && this._pendingInst !== d.instanceId) {
        this._pendingInst = d.instanceId;
        Instance.open(d, dist);
        return;
      }
      if (!near && this._pendingInst === d.instanceId) this._pendingInst = null;
    }
  },

  /* ---- the view inside ---- */

  enterInstanceView() {
    document.body.classList.add("inInstance");
    this.renderInstanceMap();
    this.renderInstanceBar();
  },

  exitInstanceView() {
    document.body.classList.remove("inInstance");
    const host = $("#instMap");
    if (host) host.innerHTML = "";
    this.renderInstanceBar();
    this.drawInstanceDoors();
  },

  instanceHint(msg) {
    const h = $("#instHint");
    if (!h) return;
    h.textContent = msg;
    h.classList.remove("hidden");
    clearTimeout(this._instHintT);
    this._instHintT = setTimeout(() => h.classList.add("hidden"), 2400);
  },

  /**
   * The floor, drawn rotated so you are always facing up the screen. The
   * world is transformed rather than the player: translate the player to the
   * centre, spin the whole floor by minus the heading, and leave the token
   * pointing up. "Forward" is then literally up, which is the only way a
   * heading is any use on a phone.
   */
  renderInstanceMap() {
    const host = $("#instMap");
    if (!host) return;
    const run = Instance.current();
    if (!run || !run.plan) { host.innerHTML = ""; return; }
    const plan = run.plan;

    // The viewBox is in metres and is shaped to the container, so one metre is
    // the same number of pixels whichever way the box is. Getting this wrong
    // is how the first cut ended up drawing one room across the whole phone.
    const cw = host.clientWidth || 390, ch = host.clientHeight || 520;
    const VW = 58, VH = VW * ch / Math.max(1, cw);
    const rect = (cls, r, rx) =>
      '<rect class="' + cls + '" x="' + r.x + '" y="' + r.y +
      '" width="' + r.w + '" height="' + r.h + '"' + (rx ? ' rx="' + rx + '"' : "") + "/>";

    // Floor, then the walls drawn into it, then the dark over everything you
    // have not laid eyes on yet.
    const floor = (plan.floors || []).map(f => rect("rm floor", f, 1)).join("");
    const walls = (plan.walls || []).map(w => rect("wall", w)).join("");
    const fog   = Content.fogRects(plan).map(f => rect("fog", f)).join("");

    // Every glyph is counter-rotated so the icons stay upright as the floor spins.
    const upright = (x, y, size, html, cls) =>
      '<g class="' + (cls || "") + '" transform="translate(' + x + "," + y + ") rotate(" + run.heading + ')">' +
      '<text font-size="' + size + '">' + html + "</text></g>";

    const seen = (x, y) => Content.isSeen(plan, x, y);
    const marks =
      (plan.start && seen(plan.start.x, plan.start.y)
        ? upright(plan.start.x, plan.start.y, 3.6, "🚪", "mark") : "") +
      (plan.stairs && seen(plan.stairs.x, plan.stairs.y)
        ? upright(plan.stairs.x, plan.stairs.y, 3.6, "🪜", "mark") : "");

    const ents = (plan.entities || []).filter(e => !e.dead && seen(e.x, e.y)).map(e =>
      upright(e.x, e.y, 3.2, e.kind === "boss" ? "👑" : e.kind === "chest" ? "🧰" : "👹",
              "ent " + e.kind + (e.alert ? " alert" : ""))).join("");

    host.innerHTML =
      '<svg viewBox="' + (-VW / 2) + " " + (-VH / 2) + " " + VW + " " + VH +
        '" preserveAspectRatio="xMidYMid meet" class="instSvg">' +
        '<g transform="rotate(' + (-run.heading) + ") translate(" + (-run.pos.x) + "," + (-run.pos.y) + ')">' +
          floor + walls + fog + marks + ents +
        "</g>" +
        '<g class="me"><circle r="1.1"/>' +
          '<path class="nose" d="M0,-2.6 L1.5,1.1 L0,0.3 L-1.5,1.1 Z"/></g>' +
      "</svg>";
  },

  /** Floor readout, the steering dial, and the way out. */
  renderInstanceBar() {
    const host = $("#instBar");
    if (!host) return;
    const run = Instance.current();
    if (!run) { host.classList.add("hidden"); host.innerHTML = ""; return; }
    const d = Instance.def(run.instanceId);
    if (!d) { host.classList.add("hidden"); return; }
    const lvl = (d.levels || [])[run.level] || {};
    const kind = Content.instanceKind(d.kind);
    const plan = run.plan;
    const explored = Math.round(Content.exploredFraction(plan) * 100);
    const foes = (plan.entities || []).filter(e => !e.dead && e.kind !== "chest").length;
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const face = dirs[Math.round(run.heading / 45) % 8];

    host.classList.remove("hidden");
    host.innerHTML =
      '<div class="dvTop">' +
        '<span class="dvIco">' + kind.icon + "</span>" +
        "<b>" + esc(Content.levelName(d, lvl, run.level)) + "</b>" +
        '<span class="tiny dim">' + (run.level + 1) + " of " + (d.levels || []).length + "</span>" +
        '<span class="spacer"></span>' +
        '<span class="tiny dim">' + explored + "% explored · " + foes + " left</span>" +
        '<button class="btn sm ghost" id="instLeave">Step out</button>' +
      "</div>" +
      '<div class="dialRow">' +
        '<button class="turnBtn" id="turnL" aria-label="Turn left">◀</button>' +
        '<div class="dial" id="instDial" role="slider" aria-label="Heading">' +
          '<div class="dialTicks"></div>' +
          '<div class="dialFace">' + face + " · " + Math.round(run.heading) + "°</div>" +
        "</div>" +
        '<button class="turnBtn" id="turnR" aria-label="Turn right">▶</button>' +
      "</div>";

    const btn = $("#instLeave");
    if (btn) btn.onclick = () => Instance.leave();
    const nudge = (deg) => () => Instance.turn(deg);
    const l = $("#turnL"), r = $("#turnR");
    if (l) l.onclick = nudge(-15);
    if (r) r.onclick = nudge(15);
    this.wireDial();
  },

  /** Drag the dial sideways to swing the heading. Turning costs nothing. */
  wireDial() {
    const dial = $("#instDial");
    if (!dial) return;
    let last = null;
    const start = (e) => {
      last = (e.touches ? e.touches[0] : e).clientX;
      dial.classList.add("on");
      e.preventDefault();
    };
    const move = (e) => {
      if (last == null) return;
      const x = (e.touches ? e.touches[0] : e).clientX;
      const dx = x - last;
      if (Math.abs(dx) < 1) return;
      last = x;
      Instance.turn(dx * 0.9);          // ~1 degree per pixel of thumb
    };
    const end = () => { last = null; dial.classList.remove("on"); };
    dial.addEventListener("pointerdown", start);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    dial.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
  },

  checkProximity() {
    this.checkDungeonProximity();
    this.checkInstanceProximity();
    if (this.inCombat || !this.nodes.length) return;
    const s = settings();
    let changed = false;
    this.refreshAuthoredState();
    for (const n of this.nodes) {
      if (n.closed) continue;                     // outside its opening hours
      const d = Loc.distanceTo(n);
      if (d == null) continue;
      // A hand-placed location carries its own trigger radius.
      const near = d <= (+n.radius || s.interactRange);
      const pinEl = document.querySelector('.pin[data-node="' + n.nodeId + '"]');
      if (pinEl) pinEl.classList.toggle("inrange", near && n.status !== "cleared");

      if (near && n.status === "undiscovered") {
        Zones.updateNode(n, { status: "discovered", discoveredAt: nowTs() });
        changed = true;
        UI.toast("Discovered: " + esc(n.name), "good", 3000);
        this.drawNode(n);
      }
      if (near && n.status === "discovered" && !this._pendingNode) {
        this._pendingNode = n.nodeId;
        this.openNode(n);
      }
      if (!near && this._pendingNode === n.nodeId) this._pendingNode = null;
    }
    if (changed) this.renderHud();
  },

  /* ---- HUD ---- */
  renderHud() {
    const c = this.ch;
    if (!c || !$("#chName")) return;
    Characters.refreshMaxes(c);
    $("#chAvatar").textContent = CLASSES[c.class].icon;
    $("#chName").textContent = c.name;
    $("#chSub").textContent = "Lv " + c.level + " " + c.race + " " + c.class +
      (c.unspentPoints ? "  ·  " + c.unspentPoints + " pts" : "");
    const btn = $("#btnSheet");
    if (btn) {
      const has = c.unspentPoints > 0;
      let dot = btn.querySelector(".dot");
      if (has && !dot) { dot = el("span", "dot"); btn.appendChild(dot); }
      if (!has && dot) dot.remove();
    }

    const s = c.stats;
    setBar("nHp", "hp", s.hp, s.maxHp);
    setBar("nMp", "mp", s.mana, s.maxMana);
    setBar("nSp", "sp", s.stamina, s.maxStamina);
    const need = Calc.xpForLevel(c.level);
    setBar("nXp", "xp", c.experience, need);

    const w = Walk.data();
    $("#wToday").textContent = fmtDist(w.meters);
    $("#wTotal").textContent = fmtDist(w.total);
    const near = Loc.nearest(this.nodes);
    $("#wNear").textContent = near ? fmtDist(near.distance) : "--";
    const gps = $("#wGps");
    const sim = settings().locationMode === "sim";
    const live = Loc.status === "live";
    gps.textContent = sim ? "simulated"
                    : live ? (Loc.last && Loc.last.accuracy ? "GPS ±" + Math.round(Loc.last.accuracy) + " m" : "GPS live")
                    : Loc.status === "requesting" ? "asking…"
                    : "Enable GPS";
    gps.className = "gpsChip" + (sim ? " warn" : live ? " ok" : " action");
    const row = $("#modeRow");
    if (row) row.classList.toggle("simOn", sim);
    const box = $("#modeToggle");
    if (box && box.checked !== sim) box.checked = sim;

    function setBar(numId, kind, cur, max) {
      const numEl = $("#" + numId);
      if (!numEl) return;
      numEl.textContent = Math.round(cur) + " / " + Math.round(max);
      const fill = numEl.parentElement.querySelector(".fill." + kind);
      if (fill) fill.style.width = (max > 0 ? clamp(cur / max * 100, 0, 100) : 0) + "%";
    }
  },

  setLocStatus(msg) {
    this.locMsg = msg;
    if (msg) UI.toast(msg, "info", 3200);
  },

  /** Switch between your real position and simulated dev testing. */
  setLocationMode(mode, quiet) {
    saveSettings({ locationMode: mode, devMode: mode === "sim" ? true : settings().devMode });
    Loc.stop();
    if (this._simWalk) { clearInterval(this._simWalk); this._simWalk = null; }
    if (mode === "gps") {
      Loc.simulated = false;
      Loc.status = "idle";
      this.beginLocation();
      if (!quiet) UI.toast("Using your real location.", "good", 2600);
    } else {
      Loc.startSimulated();
      this.buildDevPanel(true);
      if (!quiet) UI.toast("Dev testing on — click the map to move.", "warn", 3000);
    }
    this.buildDevPanel();
    this.renderHud();
    const box = $("#modeToggle");
    if (box) box.checked = mode === "sim";
  },

  /**
   * Decide how to obtain location. Nothing is requested silently: if the
   * browser hasn't already granted permission we put a button in front of the
   * player, because several browsers only raise the prompt while the page has
   * user activation.
   */
  async beginLocation(force) {
    const s = settings();
    if (s.locationMode === "sim") { Loc.start(); return; }

    const d = Loc.diagnose();
    const perm = await Loc.permissionQuery();
    d.permission = perm;
    this._diag = d;

    if (!d.hasGeo) { this.showLocationGate("nogeo", d); return; }
    // Already granted (and still granted) — nothing to ask, just watch.
    if (perm === "granted" && !force) { Loc.start(); return; }
    // Order matters: file:// is the root cause even when it surfaces as
    // "denied", and Firefox will still grant it, so the button stays live.
    if (d.isFile)     { this.showLocationGate("file", d); return; }
    if (!d.canPrompt) { this.showLocationGate("insecure", d); return; }
    if (perm === "denied") { this.showLocationGate("denied", d); return; }
    this.showLocationGate("ask", d);
  },

  /** The one screen that actually asks for permission. */
  showLocationGate(reason, d) {
    if (this._locPrompt) return;
    this._locPrompt = true;
    this.renderHud();

    const serveCmd = "python3 -m http.server 8000";
    const blocks = {
      ask: {
        title: "Turn on location", icon: "📍",
        lead: "This game moves your character with your phone's GPS, so it needs permission to read your position.",
        detail: "Tap <b>Allow location</b> below and your browser will ask. Choose <b>Allow while using the app</b>. " +
                "Nothing leaves your device — the position is only used to move you on the map.",
        primary: { label: "Allow location", act: "request" }
      },
      denied: {
        title: "Location is blocked", icon: "🚫",
        lead: "Your browser has location switched off for this page, so it won't even show the prompt.",
        detail: "<b>Chrome / Edge:</b> tap the icon to the left of the address bar → <b>Permissions</b> → " +
                "set <b>Location</b> to Allow, then reload.<br><br>" +
                "<b>Safari on iPhone:</b> <b>aA</b> in the address bar → <b>Website Settings</b> → " +
                "<b>Location</b> → Allow. Also check <b>Settings → Privacy &amp; Security → Location Services → Safari</b>.<br><br>" +
                "<b>Firefox:</b> padlock → clear the blocked Location permission, then reload.",
        primary: { label: "Ask again", act: "request" }
      },
      file: {
        title: "Open this over http, not as a file", icon: "🔒",
        lead: "The page is open straight off the disk (<span class='mono tiny'>file://</span>). " +
              "Chrome and Safari can't attach a location permission to a file, so they never ask — " +
              "which is exactly what you're seeing.",
        detail: "<b>On this computer</b> — put the file in a folder, open a terminal there and run:" +
                "<div class='cmd'><code>" + serveCmd + "</code></div>" +
                "then visit <span class='mono'>http://localhost:8000/" +
                  esc((location.pathname.split("/").pop() || "").replace(/^index\.html$/, "")) + "</span>. " +
                "Localhost counts as secure, so the prompt appears.<br><br>" +
                "<b>On your phone</b> — it needs a real <b>https</b> address. Drop the file on any static host " +
                "(GitHub Pages, Netlify Drop, Cloudflare Pages), or tunnel your laptop's server with " +
                "<span class='mono'>cloudflared tunnel --url http://localhost:8000</span>. " +
                "A plain <span class='mono'>http://192.168.x.x</span> address will not work.",
        primary: { label: "Try anyway", act: "request" }
      },
      insecure: {
        title: "This page isn't on a secure origin", icon: "🔒",
        lead: "Browsers only hand out GPS over <b>https</b>, or on <b>localhost</b>. This page is served from " +
              "<span class='mono'>" + esc(d.protocol + "//" + d.host) + "</span>, so location is blocked before it can ask.",
        detail: "Serve the file over https, or reach it as <span class='mono'>http://localhost</span> on the machine " +
                "that's hosting it. A LAN address like <span class='mono'>http://192.168.1.20</span> is not " +
                "treated as secure and will always fail.",
        primary: { label: "Try anyway", act: "request" }
      },
      nogeo: {
        title: "No location support", icon: "🧭",
        lead: "This browser doesn't expose the Geolocation API at all.",
        detail: "Try Chrome, Safari or Firefox. Until then, dev testing lets you play by tapping the map.",
        primary: null
      }
    };
    const b = blocks[reason] || blocks.ask;

    const body = el("div");
    body.innerHTML =
      '<p style="margin:0 0 12px;color:var(--ink-2);line-height:1.55">' + b.lead + "</p>" +
      '<div class="noteBox">' + b.detail + "</div>" +
      '<div id="gateResult" class="err" style="margin-top:10px"></div>' +
      '<button class="btn ghost block sm" id="gateDiag" style="margin-top:4px">Show diagnostics</button>' +
      '<pre class="diagBox hidden" id="gateDiagBox"></pre>';

    const buttons = [{ label: "Dev testing instead", cls: "ghost", onClick: () => { this.setLocationMode("sim"); } }];
    if (b.primary) {
      buttons.push({
        label: b.primary.label, cls: "primary",
        onClick: (close, root) => {
          const out = $("#gateResult", root);
          out.style.color = "var(--ink-2)";
          out.textContent = "Waiting for your browser…";
          Loc.requestPermission().then(r => {
            if (r.ok) {
              UI.toast("Location on. ±" + Math.round(r.accuracy) + " m.", "good", 3000);
              close();
              return;
            }
            out.style.color = "var(--blood)";
            out.textContent = r.code === 1
              ? "Blocked by the browser — see the steps above."
              : r.code === 3 ? "Timed out. Outdoors or by a window helps."
              : (r.message || "Position unavailable.");
            this.renderHud();
          });
          return true;   // keep the dialog open until we know
        }
      });
    }

    this._gate = UI.modal({
      title: b.title, icon: b.icon, body, buttons,
      onClose: () => { this._locPrompt = false; this._gate = null; this.renderHud(); }
    });

    $("#gateDiag", body).onclick = () => {
      const box = $("#gateDiagBox", body);
      box.textContent = JSON.stringify(Loc.diagnose(), null, 2);
      box.classList.toggle("hidden");
    };
  },

  /** Tapping a healthy GPS chip shows what the browser is actually reporting. */
  locationDiagnostics() {
    const d = Loc.diagnose();
    const p = Loc.last;
    UI.modal({
      title: "Location", icon: "📍",
      body:
        '<div class="kv"><span>Source</span><b>' + (Loc.simulated ? "Simulated" : "Device GPS") + "</b></div>" +
        '<div class="kv"><span>Permission</span><b>' + esc(d.permission) + "</b></div>" +
        '<div class="kv"><span>Accuracy</span><b>' + (p && p.accuracy ? "±" + Math.round(p.accuracy) + " m" : "—") + "</b></div>" +
        '<div class="kv"><span>Position</span><b class="tiny">' +
          (p ? p.latitude.toFixed(5) + ", " + p.longitude.toFixed(5) : "—") + "</b></div>" +
        '<div class="kv"><span>Last fix</span><b>' +
          (p ? Math.round((nowTs() - p.ts) / 1000) + " s ago" : "—") + "</b></div>" +
        '<div class="kv"><span>Origin</span><b class="tiny">' + esc(d.protocol + "//" + d.host) + "</b></div>" +
        '<p class="tiny dimmer" style="margin:12px 0 0">Keep the screen awake while you walk — most phones ' +
        "stop feeding GPS to a background tab.</p>",
      buttons: [{ label: "Close", cls: "ghost" }]
    });
  },

  /** A watch that was running has stopped producing fixes. */
  onLocationProblem(reason, code) {
    if (this._locPrompt) return;
    this.renderHud();
    this.showLocationGate(code === 1 ? "denied" : "ask", Loc.diagnose());
    const out = $("#gateResult");
    if (out) { out.style.color = "var(--warn)"; out.textContent = reason; }
  },

  /* ---- Walking rewards: the nag loop ---- */
  onWalked(meters, w) {
    if (!this.ch) return;
    // Stamina trickles back as you move; standing still doesn't refill it.
    const c = this.ch;
    c.stats.stamina = clamp(c.stats.stamina + meters * 0.22, 0, c.stats.maxStamina);
    c.stats.mana    = clamp(c.stats.mana + meters * 0.06, 0, c.stats.maxMana);

    // 1 XP per 4 metres, banked so partial metres aren't lost.
    // Inside a dungeon, the same metres are what carry you along the floor.
    Dungeon.advance(meters);
    // Inside an instance, they carry you forward along your heading instead.
    Instance.advance(meters);

    const bank = (w.xpBanked || 0) + meters / 4;
    const whole = Math.floor(bank);
    w.xpBanked = bank - whole;
    if (whole > 0) {
      const gains = Characters.addXp(c, whole);
      gains.forEach(g => this.announceLevel(g));
    }
    const goal = settings().dailyGoalMeters;
    if (!w.goalHit && w.meters >= goal) {
      w.goalHit = true;
      c.gold += 150;
      const bonus = Items.generate(c.level, c.attributes.luck + 6, 4);
      this.giveItem(bonus);
      UI.toast("Daily goal met — " + fmtDist(goal) + ". +150 gold and " + esc(bonus.name) + ".", "good", 5000);
    }
    Store.set(K.walk, w);
    Characters.save(c);
    this.renderHud();
  },

  passiveRegen() {
    if (!this.ch || this.inCombat) return;
    const c = this.ch;
    const before = c.stats.hp;
    c.stats.hp = clamp(c.stats.hp + Math.max(1, c.stats.maxHp * 0.012), 0, c.stats.maxHp);
    c.stats.mana = clamp(c.stats.mana + Math.max(1, c.stats.maxMana * 0.02), 0, c.stats.maxMana);
    if (c.stats.hp !== before) { Characters.save(c); this.renderHud(); }
  },

  announceLevel(g) {
    const c = this.ch;
    UI.toast("Level " + g.level + "! +5 attribute points.", "good", 4200);
    if (g.unlocked && g.unlocked.length) {
      g.unlocked.forEach(sk => UI.toast("New ability: " + sk.icon + " " + sk.name, "good", 4600));
    }
  },

  giveItem(item) {
    const c = this.ch;
    if (!c.inventory) c.inventory = [];
    if (c.inventory.length >= 20) {
      UI.toast("Pack full — " + esc(item.name) + " left behind.", "bad", 3200);
      return false;
    }
    c.inventory.push(item);
    Store.patch(K.inventories, (all) => { all[c.characterId] = c.inventory; });
    API.request("/inventory/item/add", "POST", { characterId: c.characterId, item });
    return true;
  }
};

/* -------------------------------------------------------------------------
   16b. Detail rows shown for a hand-placed location
   ------------------------------------------------------------------------- */
Object.assign(Game, {
  authoredNodeDetail(n) {
    const loc = Content.get("locations", n.locationId);
    if (!loc) return "";
    let out = '<div class="kv"><span>Trigger radius</span><b>' + (+loc.radius || 35) + " m</b></div>";
    const b = Content.BUILDING_KINDS[loc.buildingType];
    if (b) out += '<div class="kv"><span>Building</span><b>' + esc(cap(b.label)) + "</b></div>";
    if (loc.timeStart && loc.timeEnd) {
      out += '<div class="kv"><span>Open</span><b>' + esc(loc.timeStart) + "–" + esc(loc.timeEnd) + "</b></div>";
    }
    if (loc.days && loc.days.length) {
      out += '<div class="kv"><span>Days</span><b>' +
        loc.days.slice().sort().map(d => Content.DAY_NAMES[d]).join(" ") + "</b></div>";
    }
    if (+loc.respawnMinutes) {
      out += '<div class="kv"><span>Respawns after</span><b>' + (+loc.respawnMinutes) + " min</b></div>";
    }
    if (loc.chestTier) {
      out += '<div class="kv"><span>Chest</span><b>' + esc(Content.chestTier(loc.chestTier).label) + "</b></div>";
    }
    return out;
  }
});
