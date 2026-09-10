/* ==========================================================================
   MAP EDITOR
   Place, move, resize and delete the locations the game spawns from. Locations
   belong to a zone; a zone can be marked hand-placed, in which case the game
   stops scattering procedural sites inside it.
   ========================================================================== */
const Me = {
  zone: null,
  pane: "map",          // which pane is showing on a narrow screen
  mode: "locations",    // which layer the table and form are editing
  selected: null,
  draft: null,
  isNew: false,
  placing: false,
  markers: {},
  circles: {},
  sort: { col: "name", dir: 1 },

  /* ------------------------------------------------------------------ boot */
  init() {
    $("#me").innerHTML =
      '<header class="meTop">' +
        '<div class="meBrand"><b>Stride &amp; Sword</b><span>Map Editor</span></div>' +
        '<select id="meZone" title="Zone"></select>' +
        '<button class="btn ghost sm desktopOnly" id="meZoneNew">New zone here</button>' +
        '<button class="btn primary sm desktopOnly" id="mePlace">+ Place location</button>' +
        '<i class="meBreak"></i>' +
        '<input class="input" id="meSearch" placeholder="Find a place or lat, lng…">' +
        '<button class="btn ghost sm" id="meGo">Go</button>' +
        '<div class="spacer desktopOnly"></div>' +
        '<a class="btn sm ghost desktopOnly" href="editor.html">Content editor</a>' +
        '<a class="btn sm desktopOnly" href="index.html">Open game →</a>' +
        '<button class="btn sm ghost mobileOnly" id="meMenu" aria-label="Menu">⋯</button>' +
      "</header>" +
      '<div class="meBody">' +
        '<section class="meLeft">' +
          '<div class="mapWrap"><div id="map"></div>' +
            '<div class="mapHint hidden" id="meHint"></div>' +
            '<div class="zoomModes" id="meZoom"></div>' +
            '<button class="fab" id="meFab">+ Place</button>' +
          "</div>" +
          '<div class="meTable">' +
            '<div class="meTableBar" id="meTableBar"></div>' +
            '<div class="meTableWrap" id="meTableWrap"></div>' +
          "</div>" +
        "</section>" +
        '<aside class="meForm" id="meForm"></aside>' +
        '<nav class="paneBar" id="mePaneBar">' +
          '<button data-pane="map"><span class="ic">🗺️</span>Map</button>' +
          '<button data-pane="list"><span class="ic">📋</span>List</button>' +
          '<button data-pane="form"><span class="ic">✎</span>Details</button>' +
        "</nav>" +
      "</div>" +
      '<footer class="meStatus" id="meStatus"></footer>';

    $("#mePlace").onclick    = () => this.togglePlacing();
    $("#meFab").onclick      = () => this.togglePlacing();
    $("#meZoneNew").onclick  = () => this.newZoneHere();
    $("#meMenu").onclick     = () => this.mobileMenu();
    $$("#mePaneBar [data-pane]").forEach(b => {
      b.onclick = () => this.setPane(b.getAttribute("data-pane"));
    });
    $("#meGo").onclick       = () => this.search();
    $("#meSearch").addEventListener("keydown", e => { if (e.key === "Enter") this.search(); });
    $("#meZone").onchange    = () => this.selectZone($("#meZone").value);

    document.addEventListener("keydown", (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === "Escape" && this.placing) this.togglePlacing(false);
      const layer = this.layer3();
      if ((e.key === "Delete" || e.key === "Backspace") && layer.selected && !layer.isNew) {
        e.preventDefault(); layer.del();
      }
    });

    this.initMap();
    this.loadZones();
    this.setPane("map");
    this.renderAll();
    this.togglePlacing(false);   // gives both place buttons their real labels
    window.addEventListener("resize", () => {
      if (!this.compact()) document.body.setAttribute("data-pane", "map");
      // Leaflet needs telling when its container changes size.
      setTimeout(() => this.map.invalidateSize(), 60);
    });
  },

  compact() {
    return window.matchMedia && window.matchMedia("(max-width: 900px)").matches;
  },

  setPane(p) {
    this.pane = p;
    document.body.setAttribute("data-pane", p);
    $$("#mePaneBar [data-pane]").forEach(b =>
      b.classList.toggle("on", b.getAttribute("data-pane") === p));
    // The map was hidden while another pane showed; it must re-measure.
    if (p === "map" && this.map) setTimeout(() => this.map.invalidateSize(), 50);
  },

  /* ------------------------------------------------------------------ zones
     Zones live in the game's own storage, so a zone anchored while playing
     shows up here and vice versa. */
  zones() {
    const z = Store.get(K.zones, {}) || {};
    return Object.values(z).sort((a, b) => (a.label || "").localeCompare(b.label || ""));
  },
  saveZone(z) {
    z.lastModified = Date.now();
    Store.patch(K.zones, (all) => { all[z.zoneId] = z; });
    return z;
  },
  loadZones() {
    const all = this.zones();
    if (!all.length) return;
    const wanted = Store.session.get("mapEditorZone", null);
    this.zone = all.find(z => z.zoneId === wanted) || all[0];
  },
  selectZone(id) {
    const z = this.zones().find(x => x.zoneId === id);
    if (!z) return;
    this.zone = z;
    Store.session.set("mapEditorZone", id);
    this.selected = null; this.draft = null; this.isNew = false;
    Md.selected = null; Md.draft = null; Md.isNew = false;
    Mi.selected = null; Mi.draft = null; Mi.isNew = false;
    this.map.setView([z.centerLatitude, z.centerLongitude], this.zoomOf("street"));
    this.renderAll();
  },
  newZoneHere() {
    const c = this.map.getCenter();
    const label = prompt("Name this zone", "New Zone");
    if (label == null) return;
    const zone = {
      zoneId: Content.newId("zn"),
      // Editor zones belong to the world, not to whoever happens to be logged
      // in here, so every character sees them. This is what makes hand-placed
      // content actually show up in the game.
      userId: "editor",
      shared: true,
      label: label || "New Zone",
      centerLatitude: c.lat, centerLongitude: c.lng,
      radius: 320, seed: Content.newId("seed"),
      authoredOnly: true,
      createdAt: Date.now(), lastModified: Date.now()
    };
    this.saveZone(zone);
    this.zone = zone;
    Store.session.set("mapEditorZone", zone.zoneId);
    this.renderAll();
    this.toast("Zone created, set to hand-placed only.", "good");
  },

  /* -------------------------------------------------------------------- map */
  initMap() {
    const start = this.zone
      ? [this.zone.centerLatitude, this.zone.centerLongitude]
      : [41.8827, -87.6233];
    // maxNativeZoom stops at 19 because OSM has no tiles past it; maxZoom 24
    // upscales that last tile instead of going blank, which is what lets you
    // drop a pin on a specific doorway rather than a whole building.
    this.map = L.map("map", { zoomControl: true, maxZoom: 24, minZoom: 3, zoomSnap: 0.5 })
      .setView(start, this.zoomOf("street"));
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 24, maxNativeZoom: 19, attribution: "&copy; OpenStreetMap contributors"
    }).addTo(this.map);
    this.layer = L.layerGroup().addTo(this.map);
    this.zoneLayer = L.layerGroup().addTo(this.map);

    this.map.on("click", (e) => {
      if (!this.placing) return;
      this.placeAt(e.latlng.lat, e.latlng.lng);
    });
    this.map.on("zoomend", () => this.syncZoomModes());
    this.buildZoomModes();
  },

  /* ---- the same two zoom presets the game uses ------------------------ */

  /** Read the presets straight out of the game's settings, so both agree.
      The editor doesn't bundle 06-world.js, hence the raw Store read. */
  zoomOf(key) {
    const s = Store.get(K.settings, {}) || {};
    return key === "street" ? (+s.zoomStreet || 16) : (+s.zoomWalk || 19.5);
  },

  buildZoomModes() {
    const host = $("#meZoom");
    if (!host) return;
    host.innerHTML =
      '<button class="zmBtn" data-z="street" title="Street view — the roads and the whole zone">' +
        '<span class="zmIc">🚗</span><span class="zmLb">Street</span></button>' +
      '<button class="zmBtn" data-z="walk" title="Walking view — individual buildings, for placing on a door">' +
        '<span class="zmIc">🚶</span><span class="zmLb">Walk</span></button>';
    host.querySelectorAll(".zmBtn").forEach(b => {
      b.onclick = () => {
        this.map.setView(this.map.getCenter(), this.zoomOf(b.dataset.z), { animate: true });
        this.syncZoomModes();
      };
    });
    this.syncZoomModes();
  },

  syncZoomModes() {
    const host = $("#meZoom");
    if (!host || !this.map) return;
    const z = this.map.getZoom();
    host.querySelectorAll(".zmBtn").forEach(b => {
      b.classList.toggle("on", Math.abs(this.zoomOf(b.dataset.z) - z) < 0.4);
    });
  },

  togglePlacing(force) {
    this.placing = force == null ? !this.placing : force;
    $("#mePlace").classList.toggle("on", this.placing);
    // Say what will be placed. On a phone the layer switch lives in the list
    // pane, so the button is the only thing on the map that can tell you.
    const what = this.mode === "dungeons" ? "Dungeon" : this.mode === "instances" ? "Instance" : "Location";
    const fab = $("#meFab");
    if (fab) { fab.classList.toggle("on", this.placing); fab.textContent = this.placing ? "Cancel" : "+ " + what; }
    const pl = $("#mePlace");
    if (pl) pl.textContent = this.placing ? "Cancel" : "+ Place " + what.toLowerCase();
    if (this.placing && this.compact()) this.setPane("map");
    const hint = $("#meHint");
    hint.classList.toggle("hidden", !this.placing);
    hint.textContent = this.mode === "dungeons" ? "Click the map to drop a dungeon · Esc to cancel"
      : this.mode === "instances" ? "Click the map to put an instance door here · Esc to cancel"
      : "Click the map to place a location · Esc to cancel";
    const el = this.map.getContainer();
    el.style.cursor = this.placing ? "crosshair" : "";
  },

  placeAt(lat, lng) {
    // Disarm first, always. A guard clause that returns while still armed
    // leaves the button saying Cancel when nothing is placeable, and the next
    // tap on it turns placing off instead of on — which reads as the editor
    // simply refusing to place anything, ever.
    this.togglePlacing(false);
    if (!this.zone) {
      // Send them where the button actually is rather than just refusing.
      if (this.compact()) {
        this.setPane("form");
        this.toast("No zone yet — make one with the button here.", "bad", 5000);
      } else {
        this.toast("Make a zone first — press New zone here.", "bad", 4500);
      }
      return;
    }
    if (this.mode === "instances") {
      Mi.placeAt(lat, lng);
      const f2 = $("#f_name");
      if (f2) { f2.focus(); f2.select(); }
      this.toast("Door placed. Name it and add levels, then Save.", "good");
      return;
    }
    if (this.mode === "dungeons") {
      Md.placeAt(lat, lng);
      const f = $("#f_name");
      if (f) { f.focus(); f.select(); }
      this.toast("Drawn. Name it and add floors, then Save.", "good");
      return;
    }
    const d = Content.blankLocation(lat, lng, this.zone.zoneId);
    d.name = "New location";
    const saved = Content.save("locations", d);
    this.selected = saved.locationId;
    this.draft = JSON.parse(JSON.stringify(saved));
    this.isNew = false;
    this.renderAll();
    if (this.compact()) this.setPane("form");
    const nameField = $("#f_name");
    if (nameField) { nameField.focus(); nameField.select(); }
    this.toast(this.compact() ? "Placed. Name it, then Save."
                              : "Placed. Drag the pin to move it.", "good");
  },

  /* --------------------------------------------------------------- rendering */
  renderAll() {
    this.renderZonePicker();
    this.drawZone();
    this.drawLocations();
    Md.draw();
    Mi.draw();
    this.renderTableBar();
    this.renderTable();
    this.renderForm();
    this.renderStatus();
  },

  /** Whichever layer the switch has active — the one Delete and the form act on. */
  layer3() {
    return this.mode === "dungeons" ? Md : this.mode === "instances" ? Mi : this;
  },

  /* Three layers share one map. The switch decides which one the table and the
     form are editing; the others stay drawn, faded, and out of the way. */
  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    this.togglePlacing(false);
    this.renderAll();
    if (this.compact()) this.setPane("list");
  },

  renderZonePicker() {
    const sel = $("#meZone");
    const all = this.zones();
    sel.innerHTML = all.length
      ? all.map(z => '<option value="' + z.zoneId + '"' +
          (this.zone && z.zoneId === this.zone.zoneId ? " selected" : "") + ">" +
          esc(z.label || "Zone") + (z.authoredOnly ? " · hand-placed" : "") + "</option>").join("")
      : '<option value="">— no zones yet —</option>';
    sel.disabled = !all.length;
  },

  drawZone() {
    this.zoneLayer.clearLayers();
    if (!this.zone) return;
    const z = this.zone;
    this.zoneCircle = L.circle([z.centerLatitude, z.centerLongitude], {
      radius: z.radius, color: "#e0a33e", weight: 1.5, opacity: .55,
      fillColor: "#e0a33e", fillOpacity: .04, interactive: false
    });
    this.zoneLayer.addLayer(this.zoneCircle);
    const centre = L.marker([z.centerLatitude, z.centerLongitude], {
      draggable: true, zIndexOffset: -200,
      icon: L.divIcon({ className: "pinWrap", iconSize: [18, 18], iconAnchor: [9, 9],
        html: '<div style="width:16px;height:16px;border-radius:50%;background:#e0a33e;' +
              'border:2px solid #1a1206;box-shadow:0 0 10px rgba(224,163,62,.8)"></div>' })
    });
    centre.on("click", (e) => {
      // While placing, a click on the anchor should still drop a location
      // rather than being quietly swallowed by the marker.
      if (this.placing) { L.DomEvent.stop(e); this.placeAt(e.latlng.lat, e.latlng.lng); }
    });
    centre.on("dragend", () => {
      const p = centre.getLatLng();
      this.zone.centerLatitude = p.lat; this.zone.centerLongitude = p.lng;
      this.saveZone(this.zone);
      this.drawZone(); this.renderTable(); this.renderForm();
      this.toast("Zone moved.");
    });
    centre.bindTooltip((z.label || "Zone") + " — drag to move the anchor",
      { direction: "top", offset: [0, -8] });
    this.zoneLayer.addLayer(centre);
  },

  locations() {
    if (!this.zone) return [];
    return Content.list("locations").filter(l => l.zoneId === this.zone.zoneId);
  },

  drawLocations() {
    this.layer.clearLayers();
    if (!this.artLayer) this.artLayer = L.layerGroup().addTo(this.map);
    this.artLayer.clearLayers();
    this.markers = {}; this.circles = {};
    const now = Date.now();
    this.locations().forEach(loc => {
      // Draft edits should show live, so the selected row is drawn from the
      // draft rather than from what is saved.
      const shown = (this.draft && this.selected === loc.locationId) ? this.draft : loc;
      Art.add(this.artLayer, shown, { className: "meArt" });
      const site = Content.SITE_KINDS.find(k => k.key === loc.kind) || Content.SITE_KINDS[0];
      const b = Content.BUILDING_KINDS[loc.buildingType];
      const open = Content.isLocationActive(loc, now);
      const sel = this.selected === loc.locationId;

      const circle = L.circle([loc.latitude, loc.longitude], {
        radius: +loc.radius || 35,
        color: sel ? "#e0a33e" : "#54b37a", weight: sel ? 2 : 1,
        opacity: sel ? .85 : .4, fillColor: sel ? "#e0a33e" : "#54b37a",
        fillOpacity: sel ? .12 : .05, interactive: false
      });
      this.layer.addLayer(circle);
      this.circles[loc.locationId] = circle;

      const html = '<div class="locPin ' + loc.kind + (sel ? " sel" : "") + (open ? "" : " shut") + '">' +
        (loc.kind === "landmark" || loc.kind === "treasure" ? site.icon : (b ? b.icon : site.icon)) +
        (loc.kind !== "landmark" ? '<span class="d">' + (+loc.difficulty || 1) + "</span>" : "") +
        "</div>";
      const m = L.marker([loc.latitude, loc.longitude], {
        draggable: true,
        icon: L.divIcon({ html, className: "pinWrap",
          iconSize: [loc.kind === "boss" ? 40 : 32, loc.kind === "boss" ? 40 : 32],
          iconAnchor: [loc.kind === "boss" ? 20 : 16, loc.kind === "boss" ? 20 : 16] })
      });
      m.on("click", (e) => {
        if (this.placing) { L.DomEvent.stop(e); this.placeAt(e.latlng.lat, e.latlng.lng); return; }
        this.select(loc.locationId);
      });
      m.on("drag", () => {
        const p = m.getLatLng();
        circle.setLatLng(p);
      });
      m.on("dragend", () => {
        const p = m.getLatLng();
        const row = Content.get("locations", loc.locationId);
        row.latitude = p.lat; row.longitude = p.lng;
        Content.save("locations", row);
        if (this.selected === loc.locationId) {
          this.draft.latitude = p.lat; this.draft.longitude = p.lng;
          this.renderForm();
        }
        this.renderTable();
        this.toast("Moved to " + p.lat.toFixed(5) + ", " + p.lng.toFixed(5));
      });
      m.bindTooltip(esc(loc.name || "(unnamed)") + (open ? "" : " · closed now"),
        { direction: "top", offset: [0, -10] });
      this.layer.addLayer(m);
      this.markers[loc.locationId] = m;
    });
  },

  /* ------------------------------------------------------------------ table */
  renderTableBar() {
    const n = this.mode === "dungeons" ? Md.all().length
            : this.mode === "instances" ? Mi.all().length : this.locations().length;
    const tab = (key, label) => '<button data-mode="' + key + '"' +
      (this.mode === key ? ' class="on"' : "") + ">" + label + "</button>";
    $("#meTableBar").innerHTML =
      '<div class="layerSwitch">' +
        tab("locations", "📍 Locations") + tab("dungeons", "🏰 Dungeons") + tab("instances", "🗝️ Instances") +
      "</div>" +
      '<span class="tiny dimmer">' + n + " in " + (this.zone ? esc(this.zone.label || "this zone") : "no zone") + "</span>" +
      '<div class="spacer"></div>' +
      (this.zone
        ? '<label class="check" style="margin:0"><input type="checkbox" id="meAuthored"' +
          (this.zone.authoredOnly ? " checked" : "") +
          '> <span class="tiny">Hand-placed only — no procedural sites in this zone</span></label>'
        : "");
    $$("#meTableBar [data-mode]").forEach(b => {
      b.onclick = () => this.setMode(b.getAttribute("data-mode"));
    });
    const box = $("#meAuthored");
    if (box) box.onchange = () => {
      this.zone.authoredOnly = box.checked;
      this.saveZone(this.zone);
      this.renderZonePicker();
      this.toast(box.checked
        ? "This zone now uses only your locations."
        : "Procedural sites will be scattered here as well.", "good");
    };
  },

  th(col, label, cls) {
    const arrow = this.sort.col === col ? (this.sort.dir > 0 ? " ▲" : " ▼") : "";
    return '<th class="' + (cls || "") + '" data-sort="' + col + '">' + label + arrow + "</th>";
  },

  renderTable() {
    if (this.mode === "dungeons") { Md.renderTable(); return; }
    if (this.mode === "instances") { Mi.renderTable(); return; }
    const wrap = $("#meTableWrap");
    const rows = this.locations().slice();
    const s = this.sort;
    const val = (r) => {
      if (s.col === "spawn") { const t = Content.get("spawns", r.spawnTableId); return t ? t.name : ""; }
      if (s.col === "chest") return r.chestTier || "";
      if (s.col === "hours") return r.timeStart || "";
      return r[s.col] == null ? "" : r[s.col];
    };
    rows.sort((a, b) => {
      const av = val(a), bv = val(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * s.dir;
      return String(av).localeCompare(String(bv)) * s.dir;
    });

    if (!rows.length) {
      wrap.innerHTML = '<div class="emptyMsg">' + (this.zone
        ? "No locations in this zone yet.<br>Hit <b>+ Place location</b> and click the map."
        : "No zone yet.<br>Pan to where you want it and hit <b>New zone here</b>.") + "</div>";
      return;
    }

    const now = Date.now();
    wrap.innerHTML = '<table class="grid"><thead><tr>' +
      this.th("name", "Name") + this.th("kind", "Site") + this.th("buildingType", "Building") +
      this.th("difficulty", "Diff", "num") + this.th("radius", "Radius", "num") +
      this.th("spawn", "Spawns") + this.th("chest", "Chest") + this.th("hours", "Hours") +
      "<th>Days</th>" + this.th("respawnMinutes", "Respawn", "num") + "<th>State</th>" +
      "</tr></thead><tbody>" +
      rows.map(l => {
        const site = Content.SITE_KINDS.find(k => k.key === l.kind) || Content.SITE_KINDS[0];
        const b = Content.BUILDING_KINDS[l.buildingType];
        const sp = l.spawnTableId ? Content.get("spawns", l.spawnTableId) : null;
        const lt = l.chestLootTableId ? Content.get("loot", l.chestLootTableId) : null;
        const open = Content.isLocationActive(l, now);
        return '<tr data-id="' + l.locationId + '" class="' +
            (this.selected === l.locationId ? "on " : "") + (open ? "" : "shut") + '">' +
          '<td data-l="Name"><div class="nameCell"><span>' + site.icon + "</span><b>" + esc(l.name || "(unnamed)") + "</b></div></td>" +
          '<td data-l="Site"><span class="tag">' + esc(site.label) + "</span></td>" +
          '<td data-l="Building">' + (b ? esc(cap(b.label)) : '<span class="dimmer">—</span>') + "</td>" +
          '<td class="num" data-l="Difficulty">' + (l.kind === "landmark" ? "—" : (+l.difficulty || 1)) + "</td>" +
          '<td class="num" data-l="Radius">' + (+l.radius || 35) + " m</td>" +
          '<td data-l="Spawns">' + (sp ? esc(sp.name) : '<span class="dimmer">—</span>') + "</td>" +
          '<td data-l="Chest">' + (l.chestTier
              ? esc(Content.chestTier(l.chestTier).label) + (lt ? ' <span class="dimmer">· ' + esc(lt.name) + "</span>" : "")
              : '<span class="dimmer">—</span>') + "</td>" +
          '<td data-l="Hours">' + (l.timeStart && l.timeEnd
              ? esc(l.timeStart) + "–" + esc(l.timeEnd) : '<span class="dimmer">any</span>') + "</td>" +
          '<td data-l="Days">' + ((l.days && l.days.length)
              ? l.days.slice().sort().map(d => Content.DAY_NAMES[d]).join(" ")
              : '<span class="dimmer">all</span>') + "</td>" +
          '<td class="num" data-l="Respawn">' + (+l.respawnMinutes ? l.respawnMinutes + " m" : "—") + "</td>" +
          '<td data-l="State">' + (l.active === false ? '<span class="tag">off</span>'
              : open ? '<span class="tag ok">open</span>' : '<span class="tag warn">closed</span>') + "</td>" +
          "</tr>";
      }).join("") + "</tbody></table>";

    $$("tbody tr", wrap).forEach(tr => {
      tr.onclick = () => {
        const id = tr.getAttribute("data-id");
        this.select(id);
        const l = Content.get("locations", id);
        if (l) this.map.panTo([l.latitude, l.longitude]);
        if (this.compact()) this.setPane("form");
      };
    });
    $$("th[data-sort]", wrap).forEach(th => {
      th.onclick = () => {
        const col = th.getAttribute("data-sort");
        if (this.sort.col === col) this.sort.dir *= -1; else { this.sort.col = col; this.sort.dir = 1; }
        this.renderTable();
      };
    });
  },

  /* -------------------------------------------------------------- selection */
  select(id) {
    this.selected = id;
    this.isNew = false;
    const row = Content.get("locations", id);
    this.draft = row ? JSON.parse(JSON.stringify(row)) : null;
    this.drawLocations();
    this.renderTable();
    this.renderForm();
    if (this.compact() && this.draft) this.setPane("form");
  },

  save() {
    const d = this.draft;
    const problem = this.validate(d);
    if (problem) { const e = $("#meErr"); if (e) e.textContent = problem; return; }
    const saved = Content.save("locations", d);
    this.selected = saved.locationId;
    this.draft = JSON.parse(JSON.stringify(saved));
    const compact = this.compact();
    this.renderAll();
    if (compact) this.setPane("map");
    this.toast("Saved " + (saved.name || "location") + ".", "good");
  },

  validate(d) {
    if (!d.name || !d.name.trim()) return "Give it a name.";
    if (!(+d.radius >= 5)) return "Radius must be at least 5 m.";
    const bad = ["timeStart", "timeEnd"].find(k => d[k] && Content.minutesOf(d[k]) == null);
    if (bad) return "Times must look like 09:00.";
    if ((d.timeStart && !d.timeEnd) || (d.timeEnd && !d.timeStart)) return "Set both ends of the window, or neither.";
    if (+d.respawnMinutes < 0) return "Respawn cannot be negative.";
    return null;
  },

  duplicate() {
    const d = JSON.parse(JSON.stringify(this.draft));
    d.locationId = "";
    d.name = (d.name || "") + " (copy)";
    // drop the copy a little to the north-east so it isn't hidden underneath
    d.latitude += 0.00018; d.longitude += 0.00022;
    const saved = Content.save("locations", d);
    this.selected = saved.locationId;
    this.draft = JSON.parse(JSON.stringify(saved));
    this.renderAll();
    this.toast("Duplicated.");
  },

  del() {
    const name = (this.draft && this.draft.name) || "this location";
    if (!confirm("Delete " + name + "? This cannot be undone.")) return;
    Content.remove("locations", this.selected);
    this.selected = null; this.draft = null;
    this.renderAll();
    if (this.compact()) this.setPane("list");
    this.toast("Deleted.", "bad");
  },

  /* ------------------------------------------------------------------ search
     Nominatim is OSM's own geocoder. One request per Enter press, never
     while typing, which keeps well inside its usage policy. */
  async search() {
    const q = $("#meSearch").value.trim();
    if (!q) return;
    const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
    if (coords) {
      this.map.setView([+coords[1], +coords[2]], 18);
      this.toast("Jumped to " + (+coords[1]).toFixed(5) + ", " + (+coords[2]).toFixed(5));
      return;
    }
    this.toast("Searching…");
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q);
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const hits = await res.json();
      if (!hits.length) { this.toast("Nothing found for that.", "bad"); return; }
      this.map.setView([+hits[0].lat, +hits[0].lon], 18);
      this.toast("Found " + (hits[0].display_name || q).split(",").slice(0, 2).join(", "), "good", 3600);
    } catch (e) {
      this.toast("Search is unreachable — paste coordinates as \"lat, lng\" instead.", "bad", 5000);
    }
  },

  toast(msg, kind, ms) {
    let host = $("#toasts");
    if (!host) { host = el("div"); host.id = "toasts"; document.body.appendChild(host); }
    const t = el("div", "toast " + (kind || ""), esc(msg));
    host.appendChild(t);
    while (host.children.length > 3) host.removeChild(host.firstChild);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0";
      setTimeout(() => t.remove(), 320); }, ms || 2400);
  },

  renderStatus() {
    const n = Content.list("locations").length;
    const here = this.locations().length;
    const s = Content.stats();
    $("#meStatus").innerHTML =
      "<span><b>" + here + "</b> locations here</span>" +
      "<span><b>" + Md.all().length + "</b> dungeons here</span>" +
      "<span><b>" + Mi.all().length + "</b> instances here</span>" +
      "<span><b>" + n + "</b> locations in total</span>" +
      "<span><b>" + s.spawns + "</b> spawn tables</span>" +
      "<span><b>" + this.zones().length + "</b> zones</span>" +
      '<span class="spacer"></span>' +
      "<span>" + (Store.isDurable
        ? "localStorage · " + (Store.usageBytes() / 1024).toFixed(1) + " KB"
        : "in-memory only — changes will not survive a reload") + "</span>";
  }
};

/* ==========================================================================
   THE LOCATION FORM
   ========================================================================== */
Object.assign(Me, {

  bind(id, key, cast, after) {
    const n = $("#" + id);
    if (!n) return;
    n.addEventListener(n.type === "checkbox" || n.tagName === "SELECT" ? "change" : "input", () => {
      this.draft[key] = cast ? cast(n.type === "checkbox" ? n.checked : n.value)
                             : (n.type === "checkbox" ? n.checked : n.value);
      if (after) after();
    });
  },
  int(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; },

  fld(id, label, value, opts) {
    opts = opts || {};
    return '<label class="f"><span>' + label + "</span>" +
      '<input class="input" id="' + id + '" type="' + (opts.type || "text") + '"' +
      (opts.min != null ? ' min="' + opts.min + '"' : "") +
      (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : "") +
      (opts.readonly ? " readonly disabled" : "") +
      ' value="' + esc(value == null ? "" : value) + '"></label>';
  },
  sel(id, label, value, options) {
    return '<label class="f"><span>' + label + '</span><select id="' + id + '">' +
      options.map(o => '<option value="' + esc(o.value) + '"' +
        (String(o.value) === String(value) ? " selected" : "") + ">" + esc(o.label) + "</option>").join("") +
      "</select></label>";
  },

  renderForm() {
    if (this.mode === "dungeons") { Md.renderForm(); return; }
    if (this.mode === "instances") { Mi.renderForm(); return; }
    const host = $("#meForm");
    if (!this.draft) {
      host.innerHTML = '<div class="emptyForm">' +
        (this.zone
          ? "Select a location on the map or in the table,<br>or hit <b>+ Location</b> and tap the map."
          : "No zone yet. A zone is the area the game draws sites from — " +
            "pan the map to your office and make one here." +
            '<button class="btn primary block" id="meZoneNew2" style="margin-top:14px">New zone here</button>') +
        "</div>" +
        (this.zone ? this.zonePanel() : "");
      // The toolbar's own New zone button is desktop-only, so this one has to
      // work everywhere — it is the only way in on a phone.
      const mk = $("#meZoneNew2");
      if (mk) mk.onclick = () => this.newZoneHere();
      this.wireZonePanel();
      return;
    }

    const d = this.draft;
    const spawnOpts = [{ value: "", label: "— no monsters —" }]
      .concat(Content.list("spawns").map(t => ({ value: t.spawnTableId, label: t.name })));
    const lootOpts = [{ value: "", label: "— pick a loot table —" }]
      .concat(Content.list("loot").map(t => ({ value: t.lootTableId, label: t.name })));

    host.innerHTML =
      '<div class="formHead">' +
        '<button class="backBtn" id="meBack" aria-label="Back to the map">←</button>' +
        "<h3>" + esc(d.name || "Location") + "</h3></div>" +
      this.fld("f_name", "Name", d.name, { placeholder: "Loading Dock" }) +
      '<div class="row2">' +
        this.sel("f_kind", "Site type", d.kind,
          Content.SITE_KINDS.map(k => ({ value: k.key, label: k.label }))) +
        this.sel("f_buildingType", "Building type", d.buildingType,
          Object.keys(Content.BUILDING_KINDS).map(k =>
            ({ value: k, label: cap(Content.BUILDING_KINDS[k].label) }))) +
      "</div>" +

      '<div class="sect">Position &amp; size</div>' +
      '<div class="row2">' +
        this.fld("f_latitude", "Latitude", (+d.latitude).toFixed(6)) +
        this.fld("f_longitude", "Longitude", (+d.longitude).toFixed(6)) +
      "</div>" +
      '<label class="f"><span>Trigger radius — <b id="f_radLabel">' + (+d.radius || 35) + "</b> m</span>" +
        '<div class="radiusRow">' +
          '<input type="range" id="f_radiusRange" min="5" max="300" step="5" value="' + (+d.radius || 35) + '">' +
          '<input class="input" id="f_radius" type="number" min="5" value="' + (+d.radius || 35) + '">' +
        "</div></label>" +
      '<div class="row2">' +
        this.fld("f_difficulty", "Difficulty 1–10", d.difficulty, { type: "number", min: 1 }) +
        '<label class="f"><span>&nbsp;</span><label class="check" style="margin:6px 0 0">' +
          '<input type="checkbox" id="f_active"' + (d.active !== false ? " checked" : "") + "> Enabled</label></label>" +
      "</div>" +

      '<div class="sect">Art on the map</div>' +
      '<div class="artRow">' +
        '<div class="artPrev" id="f_artPrev"></div>' +
        '<div class="artFields">' +
          this.fld("f_image", "Image path", Content.imageIsInline(d.image) ? "" : d.image,
                   { placeholder: "art/loading-dock.png" }) +
          '<div class="artBtns">' +
            '<label class="btn sm ghost" for="f_imageFile">Upload a PNG</label>' +
            '<input type="file" id="f_imageFile" accept="image/*" hidden>' +
            '<button type="button" class="btn sm danger" id="f_imageClear">Clear</button>' +
          "</div>" +
          '<div class="tiny dimmer" id="f_artNote"></div>' +
        "</div>" +
      "</div>" +
      '<div class="row2">' +
        this.fld("f_imageMeters", "Width on the ground (m)", d.imageMeters == null ? 24 : d.imageMeters,
                 { type: "number", min: 1 }) +
        this.fld("f_imageRotation", "Rotation (degrees)", +d.imageRotation || 0, { type: "number" }) +
      "</div>" +

      '<div class="sect">Monster spawns</div>' +
      this.sel("f_spawnTableId", "Spawn table", d.spawnTableId, spawnOpts) +
      '<div id="f_spawnInfo"></div>' +

      '<div class="sect">Chest</div>' +
      this.sel("f_chestTier", "Chest type", d.chestTier,
        Content.CHEST_TIERS.map(c => ({ value: c.key, label: c.label }))) +
      '<div id="f_chestWrap"></div>' +

      '<div class="sect">Spawning times</div>' +
      '<div class="row2">' +
        this.fld("f_timeStart", "Opens", d.timeStart, { placeholder: "09:00" }) +
        this.fld("f_timeEnd", "Closes", d.timeEnd, { placeholder: "17:00" }) +
      "</div>" +
      '<label class="f"><span>Days</span><div class="dayRow" id="f_days"></div></label>' +
      this.fld("f_respawnMinutes", "Respawn after (minutes, 0 = never)", d.respawnMinutes, { type: "number", min: 0 }) +
      '<div class="noteBox" id="f_timeNote"></div>' +

      '<label class="f" style="margin-top:14px"><span>Notes</span>' +
        '<textarea id="f_notes" placeholder="Anything you want to remember about this spot.">' +
        esc(d.notes || "") + "</textarea></label>" +

      '<div class="err" id="meErr"></div>' +
      '<div class="formActions">' +
        '<button class="btn primary" id="meSave" style="flex:1">Save</button>' +
        '<button class="btn ghost" id="meDup">Duplicate</button>' +
        '<button class="btn danger" id="meDel">Delete</button>' +
      "</div>" +
      this.zonePanel();

    this.bind("f_name", "name", null, () => { $(".formHead h3").textContent = this.draft.name || "Location"; });
    this.bind("f_kind", "kind", null, () => { this.drawLocations(); });
    this.bind("f_buildingType", "buildingType", null, () => { this.drawLocations(); });
    this.bind("f_latitude", "latitude", parseFloat, () => this.moveFromForm());
    this.bind("f_longitude", "longitude", parseFloat, () => this.moveFromForm());
    this.bind("f_difficulty", "difficulty", this.int, () => this.drawLocations());
    this.bind("f_active", "active", Boolean);
    this.bind("f_spawnTableId", "spawnTableId", null, () => this.renderSpawnInfo());
    this.bind("f_chestTier", "chestTier", null, () => this.renderChest());
    this.bind("f_timeStart", "timeStart", null, () => this.renderTimeNote());
    this.bind("f_timeEnd", "timeEnd", null, () => this.renderTimeNote());
    this.bind("f_respawnMinutes", "respawnMinutes", this.int, () => this.renderTimeNote());
    this.bind("f_notes", "notes");
    this.bind("f_image", "image", null, () => { this.renderArt(); this.drawLocations(); });
    this.bind("f_imageMeters", "imageMeters", this.int, () => this.drawLocations());
    this.bind("f_imageRotation", "imageRotation", this.int, () => this.drawLocations());
    this.wireArt();

    const range = $("#f_radiusRange"), num = $("#f_radius");
    const setRadius = (v) => {
      const r = Math.max(5, this.int(v));
      this.draft.radius = r;
      $("#f_radLabel").textContent = r;
      if (range.value != r) range.value = r;
      if (num.value != r) num.value = r;
      const c = this.circles[this.selected];
      if (c) c.setRadius(r);
    };
    range.oninput = () => setRadius(range.value);
    num.oninput   = () => setRadius(num.value);

    this.renderDays();
    this.renderSpawnInfo();
    this.renderChest();
    this.renderTimeNote();
    const back = $("#meBack");
    if (back) back.onclick = () => this.setPane("map");
    $("#meSave").onclick = () => this.save();
    $("#meDup").onclick  = () => this.duplicate();
    $("#meDel").onclick  = () => this.del();
    this.wireZonePanel();
  },

  /* --------------------------------------------------------------- art
     A location's picture comes from a path or from a file you drop in. Both
     land in the same field, so nothing downstream has to care which. */

  renderArt() {
    const d = this.draft;
    if (!d) return;
    const prev = $("#f_artPrev"), note = $("#f_artNote"), path = $("#f_image");
    if (!prev) return;
    prev.innerHTML = d.image
      ? '<img src="' + esc(d.image) + '" alt="">'
      : '<span class="tiny dimmer">none</span>';
    if (note) note.textContent = d.image
      ? Art.describe(d.image) + " · " + (+d.imageMeters || 24) + " m wide on the ground"
      : "Point at a file in art/, or upload one. It sits under the pin, sized in metres.";
    // An uploaded image has no path to show; showing the first 60 characters of
    // a data URL would just be noise.
    if (path && Content.imageIsInline(d.image) && path.value) path.value = "";
  },

  wireArt() {
    const file = $("#f_imageFile"), clear = $("#f_imageClear");
    if (file) file.onchange = () => {
      const f = file.files && file.files[0];
      if (!f) return;
      Art.readFile(f).then(url => {
        this.draft.image = url;
        const path = $("#f_image");
        if (path) path.value = "";
        this.renderArt();
        this.drawLocations();
        this.toast("Image attached. Save to keep it.", "good");
      }).catch(e => this.toast(e.message, "bad"));
      file.value = "";
    };
    if (clear) clear.onclick = () => {
      this.draft.image = "";
      const path = $("#f_image");
      if (path) path.value = "";
      this.renderArt();
      this.drawLocations();
    };
    this.renderArt();
  },

  /** Typing coordinates moves the pin, so the two views never disagree. */
  moveFromForm() {
    const d = this.draft;
    if (!isFinite(d.latitude) || !isFinite(d.longitude)) return;
    const m = this.markers[this.selected], c = this.circles[this.selected];
    if (m) m.setLatLng([d.latitude, d.longitude]);
    if (c) c.setLatLng([d.latitude, d.longitude]);
  },

  renderDays() {
    const host = $("#f_days");
    if (!host) return;
    const days = this.draft.days || (this.draft.days = []);
    host.innerHTML = Content.DAY_NAMES.map((n, i) =>
      '<button type="button" data-day="' + i + '" class="' + (days.indexOf(i) >= 0 ? "on" : "") + '">' + n + "</button>").join("");
    $$("[data-day]", host).forEach(b => {
      b.onclick = () => {
        const i = +b.getAttribute("data-day");
        const at = days.indexOf(i);
        if (at >= 0) days.splice(at, 1); else days.push(i);
        b.classList.toggle("on", days.indexOf(i) >= 0);
        this.renderTimeNote();
      };
    });
  },

  renderSpawnInfo() {
    const host = $("#f_spawnInfo");
    if (!host) return;
    const t = this.draft.spawnTableId ? Content.get("spawns", this.draft.spawnTableId) : null;
    if (!t) {
      host.innerHTML = '<p class="tiny dimmer" style="margin:-4px 0 0">Nothing spawns here. ' +
        "Build spawn tables in the content editor's <b>Spawns</b> tab.</p>";
      return;
    }
    const odds = Content.spawnOdds(t);
    host.innerHTML =
      '<div class="kv"><span>Pack size</span><b>' + t.packMin + "–" + t.packMax + "</b></div>" +
      t.monsters.map((id, i) => {
        const m = Content.get("monsters", id);
        return '<div class="kv"><span>' + (m ? esc(m.name) : "(missing monster)") + "</span><b>" +
          (odds[i] * 100).toFixed(0) + "%</b></div>";
      }).join("");
  },

  renderChest() {
    const host = $("#f_chestWrap");
    if (!host) return;
    const d = this.draft;
    if (!d.chestTier) {
      host.innerHTML = "";
      d.chestLootTableId = "";
      return;
    }
    const tier = Content.chestTier(d.chestTier);
    const lootOpts = [{ value: "", label: "— pick a loot table —" }]
      .concat(Content.list("loot").map(t => ({ value: t.lootTableId, label: t.name })));
    host.innerHTML =
      this.sel("f_chestLootTableId", "Holds", d.chestLootTableId, lootOpts) +
      '<div class="kv"><span>Rolls of that table</span><b>' + Math.max(1, tier.rolls) + "</b></div>";
    this.bind("f_chestLootTableId", "chestLootTableId");
  },

  renderTimeNote() {
    const host = $("#f_timeNote");
    if (!host) return;
    const d = this.draft;
    const parts = [];
    if (d.timeStart && d.timeEnd) {
      const s = Content.minutesOf(d.timeStart), e = Content.minutesOf(d.timeEnd);
      if (s == null || e == null) parts.push("Times need to look like <b>09:00</b>.");
      else if (s === e) parts.push("Start and end are the same, so this counts as always open.");
      else if (s > e) parts.push("This window runs past midnight — open from <b>" +
        esc(d.timeStart) + "</b> until <b>" + esc(d.timeEnd) + "</b> the next morning.");
      else parts.push("Open <b>" + esc(d.timeStart) + "</b> to <b>" + esc(d.timeEnd) + "</b>.");
    } else {
      parts.push("Open at any hour.");
    }
    parts.push((d.days && d.days.length)
      ? "Only on <b>" + d.days.slice().sort().map(i => Content.DAY_NAMES[i]).join(", ") + "</b>."
      : "Every day.");
    parts.push(+d.respawnMinutes
      ? "Comes back <b>" + (+d.respawnMinutes) + " minutes</b> after being cleared."
      : "Once cleared, stays cleared.");
    const openNow = Content.isLocationActive(Object.assign({}, d, { active: true }), Date.now());
    parts.push(openNow ? "Right now: <b>open</b>." : "Right now: <b>closed</b>.");
    host.innerHTML = parts.join(" ");
  },

  /* ------------------------------------------------------------- zone panel */
  zonePanel() {
    const z = this.zone;
    if (!z) return "";
    return '<div class="sect">Zone — ' + esc(z.label || "unnamed") + "</div>" +
      '<label class="f"><span>Zone radius — <b id="z_radLabel">' + Math.round(z.radius) + "</b> m</span>" +
        '<div class="radiusRow">' +
          '<input type="range" id="z_radiusRange" min="60" max="2000" step="10" value="' + Math.round(z.radius) + '">' +
          '<input class="input" id="z_radius" type="number" min="60" value="' + Math.round(z.radius) + '">' +
        "</div></label>" +
      '<div class="row2">' +
        '<button class="btn ghost sm" id="z_rename">Rename zone</button>' +
        '<button class="btn danger sm" id="z_delete">Delete zone</button>' +
      "</div>" +
      '<p class="tiny dimmer" style="margin:8px 0 0">Drag the gold dot on the map to move the anchor. ' +
      "The radius is how far procedural sites scatter, and how far from home distances are measured.</p>";
  },

  wireZonePanel() {
    const z = this.zone;
    if (!z) return;
    const range = $("#z_radiusRange"), num = $("#z_radius");
    if (range && num) {
      const set = (v) => {
        const r = Math.max(60, this.int(v));
        z.radius = r;
        $("#z_radLabel").textContent = r;
        if (range.value != r) range.value = r;
        if (num.value != r) num.value = r;
        if (this.zoneCircle) this.zoneCircle.setRadius(r);
      };
      const commit = () => { this.saveZone(z); this.toast("Zone radius " + z.radius + " m."); };
      range.oninput = () => set(range.value);
      range.onchange = commit;
      num.oninput = () => set(num.value);
      num.onchange = commit;
    }
    const rn = $("#z_rename");
    if (rn) rn.onclick = () => {
      const name = prompt("Zone name", z.label || "");
      if (name == null) return;
      z.label = name; this.saveZone(z); this.renderAll();
    };
    const del = $("#z_delete");
    if (del) del.onclick = () => {
      const mine = this.locations().length;
      if (!confirm("Delete zone \"" + (z.label || "") + "\"" +
          (mine ? " and its " + mine + " location(s)" : "") + "?")) return;
      this.locations().forEach(l => Content.remove("locations", l.locationId));
      Store.patch(K.zones, (all) => { delete all[z.zoneId]; });
      this.zone = null; this.selected = null; this.draft = null;
      this.loadZones();
      this.renderAll();
      this.toast("Zone deleted.", "bad");
    };
  }
});

/* Boot lives at the end of 03-dungeons.js, the last part in the bundle. Me.init()
   renders the dungeon layer, so it cannot run before Md exists. */


/* ==========================================================================
   MOBILE ACTION SHEET
   ========================================================================== */
Object.assign(Me, {
  mobileMenu() {
    const back = el("div", "modalBack");
    back.style.cssText = "position:fixed;inset:0;z-index:100;background:rgba(5,7,11,.8);" +
      "display:flex;align-items:flex-end;justify-content:center;padding:0";
    const m = el("div");
    m.id = "meSheet";
    m.style.cssText = "width:100%;background:var(--bg-2);border-top:1px solid var(--line-2);" +
      "border-radius:14px 14px 0 0;padding:16px 14px calc(16px + env(safe-area-inset-bottom))";
    back.appendChild(m);
    document.body.appendChild(back);
    const add = (label, cls, fn) => {
      const b = el("button", "btn block " + (cls || "ghost"), label);
      b.style.marginBottom = "8px";
      b.onclick = () => { back.remove(); fn(); };
      m.appendChild(b);
    };
    add("New zone here", "primary", () => this.newZoneHere());
    if (this.zone) {
      add(this.zone.authoredOnly ? "Allow procedural sites here" : "Hand-placed only in this zone", "ghost", () => {
        this.zone.authoredOnly = !this.zone.authoredOnly;
        this.saveZone(this.zone);
        this.renderAll();
        this.toast(this.zone.authoredOnly
          ? "This zone now uses only your locations."
          : "Procedural sites will be scattered here as well.", "good");
      });
    }
    const nav = el("div");
    nav.innerHTML =
      '<a class="btn block ghost" href="editor.html" style="margin-bottom:8px">Content editor</a>' +
      '<a class="btn block ghost" href="index.html" style="margin-bottom:8px">Open game →</a>';
    m.appendChild(nav);
    const close = el("button", "btn block", "Close");
    close.onclick = () => back.remove();
    m.appendChild(close);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
  }
});
