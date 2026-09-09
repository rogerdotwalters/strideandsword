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
        '<p class="devNote" id="dvOut"></p>' +
        '<p class="devNote">Tap the map to teleport there.</p>' +
      "</div>";

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

    this.refreshDevReadout();
  },

  refreshDevReadout() {
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

/* -------------------------------------------------------------------------
   21. Boot
   ------------------------------------------------------------------------- */
(function boot() {
  function go() {
    Screens.init();
    if (!Store.isDurable) {
      setTimeout(() => UI.toast(
        "This browser is blocking site storage, so progress lives in memory only and will not survive a reload. " +
        "Open the file directly in a browser tab for saving to work.", "bad", 8000), 600);
    }
    // First run: install the authored content database so the game and the
    // editor agree from the start. Never overwrites anything already there.
    if (Content.isEmpty()) ContentSeed.install();

    const user = Auth.restore();
    if (!user) { Screens.show("auth"); return; }
    const chars = Object.values(Store.get(K.characters, {}) || {}).filter(c => c.userId === user.userId);
    Screens.show(chars.length ? "select" : "create");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
})();

/* Expose a few internals for console poking / future test harnesses. */
window.SS = { Store, API, Auth, Game, Combat, Loc, Walk, Zones, Characters, Calc, Items,
              Bestiary, Screens, Atlas, OSM, Content, ContentSeed, settings, saveSettings, K };
