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
        "</div>" +
        // Everything you have authored, in one list, with a way straight to it.
        // This is the whole point of the dev panel: place something in the map
        // editor, come here, and be standing on it in two clicks.
        // What the spawner is up to, and two ways to hurry it along. The
        // schedule is measured in hours, so without these you would be
        // waiting a long time to see whether any of it works.
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

    $("#dvSpawnNow").onclick = () => {
      if (typeof Spawner === "undefined" || !this.zone) { UI.toast("No zone yet.", "bad"); return; }
      // Clear the gap and the day's allowance so something actually lands,
      // then run the normal tick — no special spawn path to get out of step.
      const st = Spawner.state(this.zone.zoneId);
      st.nextDungeonAt = 0;
      st.target = Math.max(st.target || 0, (st.spawned || 0) + 1);
      Spawner.saveState(this.zone.zoneId, st);
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

  /* ------------------------------------------------- authored content jump
     Locations, dungeons and instances all get listed together, because when
     you are testing you do not care which of the three a thing is — you care
     that you just placed it and want to be standing on it. */

  devTargets() {
    if (!this.zone) return [];
    const out = [];
    Content.locationsFor(this.zone.zoneId).forEach(l => out.push({
      kind: "location", id: l.locationId, name: l.name || "(unnamed location)",
      icon: l.image ? "🖼️" : "📍", lat: l.latitude, lng: l.longitude, row: l
    }));
    Content.dungeonsFor(this.zone.zoneId).forEach(d => out.push({
      kind: "dungeon", id: d.dungeonId, name: d.name || "(unnamed dungeon)",
      icon: Content.dungeonKind(d.kind).icon, lat: d.latitude, lng: d.longitude, row: d
    }));
    Content.instancesFor(this.zone.zoneId).forEach(d => out.push({
      kind: "instance", id: d.instanceId, name: d.name || "(unnamed instance)",
      icon: Content.instanceKind(d.kind).icon, lat: d.latitude, lng: d.longitude, row: d
    }));
    const p = Loc.last;
    if (p) out.forEach(t => { t.dist = haversine(p.latitude, p.longitude, t.lat, t.lng); });
    out.sort((a, b) => (a.dist == null ? 0 : a.dist) - (b.dist == null ? 0 : b.dist));
    return out;
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
    out.innerHTML =
      "places surveyed " + s.places + "<br>" +
      "dungeons " + s.dungeons + " · expires in " + mins(s.dungeonExpiresInMs) +
        " · next in " + mins(s.nextDungeonInMs) + "<br>" +
      "instances " + s.instances + " live · " + s.instancesToday + "/" + s.instanceTarget + " today";
  },

  refreshDevReadout() {
    this.refreshSpawnReadout();
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
