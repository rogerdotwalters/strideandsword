/* -------------------------------------------------------------------------
   20. Dev panel — test without leaving your chair
   ------------------------------------------------------------------------- */
Object.assign(Game, {
  _simWalk: null,

  buildDevPanel(forceOpen) {
    const host = $("#devPanel");
    if (!host) return;
    const s = settings();
    // The panel exists only while dev testing is switched on.
    if (s.locationMode !== "sim" && !forceOpen) { host.classList.add("hidden"); return; }
    host.classList.remove("hidden");
    const collapsed = !!this._devCollapsed;
    host.innerHTML =
      '<div class="dh">' +
        '<button class="btn sm ghost" id="dvFold" title="Collapse">' + (collapsed ? "▸" : "▾") + "</button>" +
        "<b>Dev test</b>" +
        '<button class="btn sm ghost" id="dvHide">use GPS</button></div>' +
      '<div class="db' + (collapsed ? " hidden" : "") + '">' +
        '<div class="row">' +
          '<input class="input" id="dvLat" placeholder="lat">' +
          '<input class="input" id="dvLng" placeholder="lng">' +
        "</div>" +
        '<div class="grid2">' +
          '<button class="btn sm" id="dvGo">Teleport</button>' +
          '<button class="btn sm" id="dvHome">To home</button>' +
          '<button class="btn sm" id="dvNearest">Walk to nearest</button>' +
          '<button class="btn sm" id="dvWander">Wander</button>' +
          '<button class="btn sm danger" id="dvStop">Stop</button>' +
          '<button class="btn sm ghost" id="dvSeed">Seed data</button>' +
          /* Simulated fixes are teleports, so they can never raise a speed —
             which is right for every other test and leaves no way to see the
             travelling veil from a desk. This is that way. */
          '<button class="btn sm ghost" id="dvDrive">Drive</button>' +
        "</div>" +
        // Everything you have authored, in one list, with a way straight to it.
        // This is the whole point of the dev panel: place something in the map
        // editor, come here, and be standing on it in two clicks.
        // What the spawner is up to, and two ways to hurry it along. The
        // schedule is measured in hours, so without these you would be
        // waiting a long time to see whether any of it works.
        '<div class="sect tiny">The chunked world</div>' +
        '<p class="devNote" id="dvChunks"></p>' +
        '<div class="grid2">' +
          '<button class="btn sm" id="dvChunkSync">Load chunks now</button>' +
          '<button class="btn sm danger" id="dvChunkReset">Wipe chunks</button>' +
        "</div>" +
        '<div class="sect tiny">Spawning</div>' +
        '<p class="devNote" id="dvSpawn"></p>' +
        '<div class="grid2">' +
          '<button class="btn sm" id="dvSpawnNow">Force a spawn</button>' +
          '<button class="btn sm danger" id="dvSpawnReset">Clear spawned</button>' +
        "</div>" +
        '<div class="sect tiny">Authored content</div>' +
        '<select class="input" id="dvJump"></select>' +
        '<div class="grid2">' +
          '<button class="btn sm" id="dvJumpGo">Walk to it</button>' +
          '<button class="btn sm" id="dvJumpTp">Teleport to it</button>' +
          '<button class="btn sm primary" id="dvJumpIn">Go straight in</button>' +
          '<button class="btn sm ghost" id="dvReload">Reload authored</button>' +
        "</div>" +
        '<p class="devNote" id="dvOut"></p>' +
        '<p class="devNote">Tap the map to teleport there.</p>' +
      "</div>";
    this.fillDevJump();

    $("#dvFold").onclick = () => { this._devCollapsed = !this._devCollapsed; this.buildDevPanel(true); };

    $("#dvHide").onclick = () => { this.setLocationMode("gps"); host.classList.add("hidden"); };

    $("#dvGo").onclick = () => {
      const la = parseFloat($("#dvLat").value), ln = parseFloat($("#dvLng").value);
      if (isNaN(la) || isNaN(ln)) { UI.toast("Enter a valid lat and lng.", "bad"); return; }
      Loc.simulateTo(la, ln);
    };
    $("#dvHome").onclick = () => {
      if (!this.zone) { UI.toast("No zone yet.", "bad"); return; }
      Loc.simulateTo(this.zone.centerLatitude, this.zone.centerLongitude);
    };
    $("#dvNearest").onclick = () => {
      const near = Loc.nearest(this.nodes);
      if (!near) { UI.toast("Nothing left to walk to.", "bad"); return; }
      this.walkTo(near.node.latitude, near.node.longitude);
    };
    $("#dvWander").onclick = () => this.wander();
    $("#dvStop").onclick = () => { if (this._simWalk) { clearInterval(this._simWalk); this._simWalk = null; UI.toast("Sim stopped.", "info", 1400); } };
    $("#dvSeed").onclick = () => this.seedTestData();
    $("#dvDrive").onclick = () => {
      const on = !Loc.travelling;
      // Fake the reading as well as the state, or the veil reads "0 km/h".
      Loc.speedMps = on ? (+settings().travelEnterKph || 16) / 3.6 * 2.4 : 0;
      Loc.setTravelling(on);
      UI.toast(on ? "Pretending to be in a car." : "Out of the car.", "info", 1600);
    };

    $("#dvChunkSync").onclick = () => {
      UI.toast("Surveying…", "info", 1600);
      this.syncChunks({ force: true }).then(n => {
        UI.toast(n ? "Chunks updated." : "Nothing new to load.", n ? "good" : "info", 2200);
        this.refreshSpawnReadout();
      });
    };
    $("#dvChunkReset").onclick = () => {
      if (typeof Chunks === "undefined") return;
      const n = Chunks.reset();
      this.nodes = [];
      this.world = null;
      this._lastChunkSync = 0;
      if (!this.mapless && this.worldLayer) this.worldLayer.clearLayers();
      this.drawNodes();
      this.refreshSpawnReadout();
      UI.toast("Wiped " + n + " generated sites. Walk, or hit Load chunks.", "info", 3000);
    };

    $("#dvSpawnNow").onclick = () => {
      if (typeof Spawner === "undefined" || !this.zone) { UI.toast("No zone yet.", "bad"); return; }
      // Clear the gap and the day's allowance so something actually lands,
      // then run the normal tick — no special spawn path to get out of step.
      // Clear the gap, and let the region roll again, so something lands now.
      const st = Spawner.state(this.zone.zoneId);
      st.nextDungeonAt = 0;
      Spawner.saveState(this.zone.zoneId, st);
      if (Loc.last && typeof Grid !== "undefined") {
        const region = Grid.regionAt(Loc.last.latitude, Loc.last.longitude);
        Spawner.saveRegionState(region.key, { rolled: 0, target: 0 });
      }
      const n = this.runSpawner({ force: true });
      UI.toast(n ? "Spawned " + n + "." : "Nothing to spawn — no places surveyed yet.",
               n ? "good" : "bad", 2600);
      this.refreshSpawnReadout();
    };
    $("#dvSpawnReset").onclick = () => {
      if (typeof Spawner === "undefined" || !this.zone) return;
      const n = Spawner.reset(this.zone);
      this.syncAuthoredLocations();
      if (!this.mapless) { this.drawDungeons(); this.drawInstanceDoors(); }
      this.fillDevJump();
      this.refreshSpawnReadout();
      UI.toast("Removed " + n + " spawned.", "info", 2000);
    };

    $("#dvJumpGo").onclick = () => this.devJump("walk");
    $("#dvJumpTp").onclick = () => this.devJump("teleport");
    $("#dvJumpIn").onclick = () => this.devJump("enter");
    $("#dvReload").onclick = () => {
      const r = this.refreshAuthored({ announce: true });
      if (r && !(r.added + r.updated + r.removed)) UI.toast("Nothing has changed.", "info", 1800);
      this.fillDevJump();
    };

    this.refreshDevReadout();
  },

  /**
   * Keep the panel clear of the HUD it is floating over.
   *
   * The panel has grown a section at a time — the chunked world and the
   * spawner are the newest — and on a phone-sized screen it had quietly got
   * tall enough to sit on top of the GPS chip, swallowing clicks meant for it.
   * A fixed max-height in CSS cannot know that, because the bar stack below
   * changes height whenever a dungeon or instance run is going. So the cap is
   * measured from where the bars actually start, and re-measured whenever the
   * panel is rebuilt.
   */
  fitDevPanel() {
    const host = $("#devPanel"), body = host && host.querySelector(".db");
    const bars = document.querySelector(".bars");
    if (!host || !body || !bars || host.classList.contains("hidden")) return;
    const top = host.getBoundingClientRect().top;
    const head = host.querySelector(".dh");
    const headH = head ? head.getBoundingClientRect().height : 0;
    const room = bars.getBoundingClientRect().top - top - headH - 12;
    body.style.maxHeight = Math.max(120, Math.round(room)) + "px";
  },

  /* ------------------------------------------------- authored content jump
     Locations, dungeons and instances all get listed together, because when
     you are testing you do not care which of the three a thing is — you care
     that you just placed it and want to be standing on it. */

  devTargets() {
    const out = [];
    /* Everything anywhere, sorted by distance. With a chunked world there is
       no single zone to list, and "the nearest twenty things" is what you
       actually want when you are testing. */
    Content.list("locations").forEach(l => out.push({
      kind: "location", id: l.locationId, name: l.name || "(unnamed location)",
      icon: l.image ? "🖼️" : "📍", lat: l.latitude, lng: l.longitude, row: l
    }));
    Content.list("dungeons").forEach(d => out.push({
      kind: "dungeon", id: d.dungeonId,
      name: (d.name || "(unnamed dungeon)") + (d.origin === "auto" ? " ·auto" : ""),
      icon: Content.dungeonKind(d.kind).icon, lat: d.latitude, lng: d.longitude, row: d
    }));
    Content.list("instances").forEach(d => out.push({
      kind: "instance", id: d.instanceId,
      name: (d.name || "(unnamed instance)") + (d.origin === "auto" ? " ·auto" : ""),
      icon: Content.instanceKind(d.kind).icon, lat: d.latitude, lng: d.longitude, row: d
    }));
    (this.nodes || []).forEach(n => {
      if (n.locationId) return;               // already listed as a location
      out.push({
        kind: "node", id: n.nodeId, name: n.name || "(site)",
        icon: n.icon || "📍", lat: n.latitude, lng: n.longitude, row: n
      });
    });
    const p = Loc.last;
    if (p) out.forEach(t => { t.dist = haversine(p.latitude, p.longitude, t.lat, t.lng); });
    out.sort((a, b) => (a.dist == null ? 0 : a.dist) - (b.dist == null ? 0 : b.dist));
    return out.slice(0, 25);
  },

  fillDevJump() {
    const sel = $("#dvJump");
    if (!sel) return;
    const keep = sel.value;
    const list = this.devTargets();
    sel.innerHTML = !list.length
      ? '<option value="">Nothing authored in this zone</option>'
      : list.map(t => '<option value="' + esc(t.kind + ":" + t.id) + '">' +
          t.icon + " " + esc(t.name) + (t.dist != null ? " · " + Math.round(t.dist) + " m" : "") +
          "</option>").join("");
    if (keep && sel.querySelector('option[value="' + keep.replace(/"/g, "") + '"]')) sel.value = keep;
  },

  devJump(how) {
    const sel = $("#dvJump");
    const val = sel && sel.value;
    if (!val) { UI.toast("Nothing authored in this zone yet.", "bad"); return; }
    const t = this.devTargets().find(x => x.kind + ":" + x.id === val);
    if (!t) { this.fillDevJump(); return; }

    if (settings().locationMode !== "sim") {
      UI.toast("Switch on dev testing first — this moves a simulated position.", "bad", 3200);
      return;
    }

    // Landing a metre off the centre still counts as arriving, and it means
    // the proximity checks fire exactly as they would on foot.
    if (how === "walk") {
      this.walkTo(t.lat, t.lng, () => UI.toast("Arrived at " + t.name + ".", "good", 2200));
      return;
    }
    Loc.simulateTo(t.lat, t.lng);
    if (how !== "enter") { UI.toast("Standing on " + t.name + ".", "good", 2000); return; }

    // Skip the doorstep prompt entirely — that is what "straight in" means.
    setTimeout(() => {
      if (t.kind === "instance") {
        const gate = Instance.canEnter(t.row, 0);
        if (!gate.ok) { UI.toast(gate.why, "bad", 3000); return; }
        const paused = Instance.pausedFor(t.id);
        if (paused) Instance.resume(t.row); else Instance.begin(t.row);
      } else if (t.kind === "dungeon") {
        const gate = Dungeon.canEnter(t.row, 0);
        if (!gate.ok) { UI.toast(gate.why, "bad", 3000); return; }
        const paused = Dungeon.pausedFor(t.id);
        if (paused) Dungeon.resume(t.row); else Dungeon.begin(t.row);
      } else if (t.kind === "node") {
        this.openNode(t.row);
      } else {
        const node = this.nodes.find(n => n.locationId === t.id);
        if (!node) { UI.toast("That location has no node yet — hit Reload authored.", "bad", 3000); return; }
        this.openNode(node);
      }
    }, 60);
  },

  /** What the spawner has live, and what it is waiting on. */
  refreshSpawnReadout() {
    const out = $("#dvSpawn");
    if (!out) return;
    if (typeof Spawner === "undefined" || !this.zone) { out.textContent = "no zone"; return; }
    const s = Spawner.status(this.zone);
    const mins = (ms) => ms ? Math.max(1, Math.round(ms / 60000)) + " min" : "—";
    const hrs = (ms) => ms ? (ms / 3600000).toFixed(1) + " h" : "—";
    out.innerHTML =
      "places surveyed " + s.places + "<br>" +
      "dungeons " + s.dungeons + " here · expires " + mins(s.dungeonExpiresInMs) +
        " · next " + mins(s.nextDungeonInMs) + "<br>" +
      "instances " + s.instances + " over " + s.regions + " region(s) · expires " +
        hrs(s.instanceExpiresInMs);

    const ch = $("#dvChunks");
    if (ch && typeof Chunks !== "undefined") {
      const p = Loc.last;
      const c = Chunks.status(p && p.latitude, p && p.longitude);
      /* The map-service line is here rather than buried in a console: this is
         somebody else's donated server, and "how much have we asked of it"
         should be as visible as anything else the panel reports. */
      const cool = c.coolOffMs
        ? '<span style="color:var(--warn)">backing off ' + Math.ceil(c.coolOffMs / 1000) + "s</span>"
        : (c.waiting ? c.waiting + " cell(s) waiting to retry" : "clear");
      ch.innerHTML =
        "here " + c.here + " · region " + c.region + "<br>" +
        "chunks " + c.loaded + " loaded / " + c.inRange + " in range / " + c.known + " known<br>" +
        "geometry " + c.cacheKB + " KB of " + c.budgetKB + " KB in " + c.cached +
          " cell(s) · " + c.nodes + " sites<br>" +
        "overpass " + c.queriesOk + "/" + c.queries + " queries" +
          (c.deferred ? " · " + c.deferred + " held back" : "") + " · " + cool;
    }
  },

  refreshDevReadout() {
    this.refreshSpawnReadout();
    // Cheap, and the bar stack below grows and shrinks with a dungeon run, so
    // the cap is re-measured here rather than only when the panel is built.
    this.fitDevPanel();
    const out = $("#dvOut");
    if (!out) return;
    const p = Loc.last;
    const near = Loc.nearest(this.nodes);
    out.innerHTML =
      "pos " + (p ? p.latitude.toFixed(5) + ", " + p.longitude.toFixed(5) : "—") + "<br>" +
      "src " + (Loc.simulated ? "simulated" : "gps") + " · " + Loc.status + "<br>" +
      "nodes " + this.nodes.length + " · nearest " + (near ? Math.round(near.distance) + " m" : "—");
    const la = $("#dvLat"), ln = $("#dvLng");
    if (p && la && !la.matches(":focus")) la.value = p.latitude.toFixed(6);
    if (p && ln && !ln.matches(":focus")) ln.value = p.longitude.toFixed(6);
  },

  /** Interpolate toward a point at roughly walking pace (1.4 m/s). */
  walkTo(lat, lng, done) {
    if (this._simWalk) clearInterval(this._simWalk);
    const stepMeters = 14;
    this._simWalk = setInterval(() => {
      const p = Loc.last;
      if (!p) { clearInterval(this._simWalk); this._simWalk = null; return; }
      const d = haversine(p.latitude, p.longitude, lat, lng);
      if (d < stepMeters) {
        Loc.simulateTo(lat, lng);
        clearInterval(this._simWalk); this._simWalk = null;
        if (done) done();
        return;
      }
      const bearing = this.bearingTo(p.latitude, p.longitude, lat, lng);
      const next = projectPoint(p.latitude, p.longitude, stepMeters, bearing);
      Loc.simulateTo(next.latitude, next.longitude);
    }, 700);
  },

  bearingTo(la1, lo1, la2, lo2) {
    const φ1 = toRad(la1), φ2 = toRad(la2), Δλ = toRad(lo2 - lo1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  },

  /** Random meander inside the zone — good for testing the walk counter. */
  wander() {
    if (!this.zone || !Loc.last) { UI.toast("No zone yet.", "bad"); return; }
    if (this._simWalk) clearInterval(this._simWalk);
    let bearing = rnd(0, 360);
    this._simWalk = setInterval(() => {
      const p = Loc.last;
      bearing += rnd(-40, 40);
      let next = projectPoint(p.latitude, p.longitude, 12, bearing);
      const fromHome = haversine(this.zone.centerLatitude, this.zone.centerLongitude,
                                 next.latitude, next.longitude);
      if (fromHome > this.zone.radius) {
        bearing = this.bearingTo(p.latitude, p.longitude,
                                 this.zone.centerLatitude, this.zone.centerLongitude);
        next = projectPoint(p.latitude, p.longitude, 12, bearing);
      }
      Loc.simulateTo(next.latitude, next.longitude);
    }, 700);
    UI.toast("Simulated walk running. ■ to stop.", "info", 2200);
  },

  /** QA seed: a level 8 character with gear, plus a stocked pack. */
  seedTestData() {
    const c = this.ch;
    Characters.addXp(c, Calc.xpForLevel(1) * 7);
    c.gold += 2000;
    for (let i = 0; i < 6; i++) {
      const it = Items.generate(c.level, 22, 8);
      this.giveItem(it);
    }
    Characters.refreshMaxes(c, true);
    Characters.save(c);
    this.renderHud();
    UI.toast("Seeded: level " + c.level + ", gear and gold.", "good", 3000);
  }
});
