"use strict";
/* ==========================================================================
   REGION EDITOR — the ground, and what lives on it.

   Sibling of the shape editor, and deliberately a separate page: a shape is
   scenery you drew, a region is a statement about real ground. They are
   authored at different scales (a building vs a floodplain), they are looked
   at with different questions, and they live in different files.

   The file is plain **GeoJSON**. That is the whole point of this page: draw
   here and open the same file in QGIS, or produce it in QGIS and open it
   here, or generate it from real map data with `tools/mapimport.js` and then
   fix it up by hand. Nothing in the format is ours except a few properties,
   which every other reader will ignore.
   ========================================================================== */
const Re = {
  mode: "select",          // select | draw | hole
  drawing: null,           // points of the ring being drawn
  selected: null,
  draft: null,
  filter: "",              // show one terrain only
  layers: {},

  async init() {
    const root = $("#re");
    root.innerHTML =
      '<div class="meTop">' +
        '<div class="meBrand"><b>Stride &amp; Sword</b><span>Regions</span></div>' +
        '<div class="layerSwitch" id="reTools">' +
          '<button data-tool="select" class="on">Select</button>' +
          '<button data-tool="draw">+ Region</button>' +
          '<button data-tool="hole">+ Hole</button>' +
        "</div>" +
        '<button class="btn ghost sm" id="reImport" title="Turn the real water and green cover here into regions">⬇ Import terrain here</button>' +
        '<input class="input" id="reSearch" placeholder="lat, lng" style="width:180px">' +
        '<div class="spacer"></div>' +
        '<button class="btn ghost sm" id="reFile">Export / Import</button>' +
        '<a class="btn ghost sm" href="index.html">Game</a>' +
        '<a class="btn ghost sm" href="shapes.html">Shapes</a>' +
        '<a class="btn ghost sm" href="mapeditor.html">Map editor</a>' +
      "</div>" +
      '<div class="meBody">' +
        '<div class="meLeft">' +
          '<div class="mapWrap">' +
            '<div id="map"></div>' +
            '<div class="mapHint hidden" id="reHint"></div>' +
            '<div class="reLegend" id="reLegend"></div>' +
          "</div>" +
          '<div class="meTable">' +
            '<div class="meTableBar">' +
              "<b>Regions</b>" +
              '<span class="tiny dimmer" id="reCount"></span>' +
              '<span class="spacer"></span>' +
              '<button class="btn sm ghost" id="reFit" disabled>Zoom to it</button>' +
              '<button class="btn sm danger" id="reDel" disabled>Delete</button>' +
            "</div>" +
            '<div class="meTableWrap" id="reTableWrap"></div>' +
          "</div>" +
        "</div>" +
        '<div class="meForm" id="reForm"></div>' +
      "</div>" +
      '<footer class="meStatus" id="reStatus"></footer>';

    /* Seeded regions come out of data/regions.json the same way shapes do —
       and the rest of the database with them, because the spawn-table picker
       on this page is useless without the spawn tables in it. */
    try { await DB.load(); DB.seedAll(false); } catch (e) { /* offline is fine */ }

    this.initMap();
    this.bind();
    this.renderAll();
  },

  bind() {
    $("#reTools").querySelectorAll("button").forEach(b => {
      b.onclick = () => this.setTool(b.getAttribute("data-tool"));
    });
    $("#reImport").onclick = () => this.importTerrain();
    $("#reFile").onclick = () => this.fileMenu();
    $("#reDel").onclick = () => this.deleteSelected();
    $("#reFit").onclick = () => this.fitSelected();
    $("#reSearch").onkeydown = (e) => { if (e.key === "Enter") this.jumpTo(); };
    document.addEventListener("keydown", (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ""))) return;
      if (e.key === "Escape") { this.cancelDraw(); this.select(null); }
      if (e.key === "Enter" && this.drawing) this.finishDraw();
      if ((e.key === "Delete" || e.key === "Backspace") && this.selected) {
        e.preventDefault(); this.deleteSelected();
      }
    });
  },

  initMap() {
    const start = Store.session.get("regionEditorView", null) || { lat: 32.3513, lng: -95.3011, z: 13 };
    this.map = L.map("map", { zoomControl: true, maxZoom: 22, minZoom: 3, zoomSnap: 0.5 })
      .setView([start.lat, start.lng], start.z);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 22, maxNativeZoom: 19, keepBuffer: 3,
      updateWhenIdle: true, updateWhenZooming: false,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" ' +
                   'target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(this.map);

    this.layer = L.layerGroup().addTo(this.map);
    this.editLayer = L.layerGroup().addTo(this.map);
    this.drawLayer = L.layerGroup().addTo(this.map);

    this.map.on("click", (e) => this.onMapClick(e));
    this.map.on("dblclick", (e) => {
      if (!this.drawing) return;
      L.DomEvent.stop(e);
      this.finishDraw();
    });
    this.map.on("moveend zoomend", () => {
      const c = this.map.getCenter();
      Store.session.set("regionEditorView", { lat: c.lat, lng: c.lng, z: this.map.getZoom() });
      this.renderStatus();
    });
  },

  /* ----------------------------------------------------------------- tools */

  setTool(tool) {
    this.cancelDraw();
    this.mode = tool || "select";
    $("#reTools").querySelectorAll("button").forEach(b =>
      b.classList.toggle("on", b.getAttribute("data-tool") === this.mode));
    if (this.mode === "draw") this.hint("Click the corners of the region · double-click or Enter to close it · Esc to bin it");
    else if (this.mode === "hole") {
      if (!this.selected) { this.toast("Select the region to cut a hole in first.", "bad"); this.setTool("select"); return; }
      this.hint("Click the corners of the hole · double-click or Enter to cut it out");
    } else this.hint("");
    this.renderHandles();
  },

  hint(text) {
    const el = $("#reHint");
    el.classList.toggle("hidden", !text);
    el.textContent = text || "";
  },

  onMapClick(e) {
    if (this.mode === "select") { this.select(null); return; }
    if (!this.drawing) this.drawing = [];
    this.drawing.push([e.latlng.lat, e.latlng.lng]);
    this.renderDraw();
  },

  renderDraw() {
    this.drawLayer.clearLayers();
    if (!this.drawing || !this.drawing.length) return;
    if (this.drawing.length > 2) {
      this.drawLayer.addLayer(L.polygon(this.drawing, {
        color: this.mode === "hole" ? "#c8453c" : "#e0a33e", weight: 2, dashArray: "5 5",
        fillOpacity: 0.12, interactive: false
      }));
    } else if (this.drawing.length === 2) {
      this.drawLayer.addLayer(L.polyline(this.drawing, { color: "#e0a33e", weight: 2, dashArray: "5 5" }));
    }
    this.drawing.forEach(p => this.drawLayer.addLayer(L.circleMarker(p, {
      radius: 4, color: "#e0a33e", fillColor: "#e0a33e", fillOpacity: 1, weight: 1
    })));
  },

  finishDraw() {
    const pts = this.drawing || [];
    if (pts.length < 3) { this.toast("A region needs at least three corners.", "bad"); return; }
    if (this.mode === "hole") {
      const r = Regions.get(this.selected);
      if (!r) { this.cancelDraw(); return; }
      r.rings.push(pts.slice());
      Regions.save(r);
      this.cancelDraw();
      this.setTool("select");
      this.draft = Regions.get(this.selected);
      this.renderAll();
      this.toast("Hole cut. Nothing spawns in it.", "good");
      return;
    }
    const r = Regions.blank("wood", [pts.slice()]);
    r.name = "New region";
    Regions.save(r);
    this.cancelDraw();
    this.setTool("select");
    this.select(r.regionId);
    this.renderAll();
  },

  cancelDraw() {
    this.drawing = null;
    if (this.drawLayer) this.drawLayer.clearLayers();
    this.hint("");
  },

  /* ------------------------------------------------------------- selection */

  select(id) {
    this.selected = id || null;
    this.draft = id ? JSON.parse(JSON.stringify(Regions.get(id) || null)) : null;
    $("#reDel").disabled = !this.selected;
    $("#reFit").disabled = !this.selected;
    this.renderRegions();
    this.renderHandles();
    this.renderForm();
    this.renderTable();
  },

  commit(quiet) {
    if (!this.draft) return;
    Regions.save(this.draft);
    this.draft = JSON.parse(JSON.stringify(Regions.get(this.draft.regionId)));
    if (!quiet) this.renderAll();
  },

  deleteSelected() {
    const r = Regions.get(this.selected);
    if (!r) return;
    if (!confirm("Delete " + r.name + "?")) return;
    Regions.remove(r.regionId);
    this.select(null);
    this.renderAll();
    this.toast("Deleted.", "info");
  },

  fitSelected() {
    const r = Regions.get(this.selected);
    const b = r && Regions.bounds(r);
    if (b) this.map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [40, 40] });
  },

  /* ---------------------------------------------------------------- drawing */

  renderRegions() {
    this.layer.clearLayers();
    this.layers = {};
    const rows = Regions.list(true)
      .filter(r => !this.filter || r.terrain === this.filter);
    rows.forEach(r => {
      const rings = Regions.rings(r);
      if (!rings.length || rings[0].length < 3) return;
      const style = Regions.styleOf(r);
      style.interactive = true;
      if (r.active === false) { style.opacity = 0.25; style.fillOpacity = 0.05; }
      if (r.regionId === this.selected) {
        style.weight = 3; style.opacity = 1; style.fillOpacity = 0.3; style.dashArray = null;
      }
      const poly = L.polygon(rings, style);
      poly.on("click", (e) => {
        L.DomEvent.stop(e);
        /* While a tool is armed the polygon must not eat the click: you draw a
           hole by clicking *inside* the region, which is precisely where its
           own click handler is. Forward it to the map's handler instead. */
        if (this.mode !== "select") { this.onMapClick(e); return; }
        this.select(r.regionId);
      });
      this.layer.addLayer(poly);
      this.layers[r.regionId] = poly;
    });
    this.renderBuildings();
    return rows.length;
  },

  /**
   * The buildings, faintly, on the same map.
   *
   * They are not edited here — the map editor's Buildings layer does that —
   * but a Google Earth file usually carries both, and importing forty
   * shopfronts into a page that draws none of them looks exactly like an
   * import that silently failed.
   */
  renderBuildings() {
    if (typeof Buildings === "undefined") return 0;
    const rows = Buildings.list(true);
    rows.forEach(b => {
      const k = Buildings.kind(b.kind);
      const ring = Buildings.ring(b);
      const style = { color: k.color, weight: 1.5, opacity: .7, fillColor: k.color,
                      fillOpacity: .18, interactive: false };
      this.layer.addLayer(ring
        ? L.polygon(ring, style)
        : L.circle([b.latitude, b.longitude],
                   Object.assign({ radius: +b.radius || 45 }, style, { dashArray: "5 5" })));
      const c = Buildings.centroid(b);
      const m = L.marker([c.latitude, c.longitude], {
        interactive: false,
        icon: L.divIcon({ className: "pinWrap", iconSize: [28, 28], iconAnchor: [14, 14],
          html: '<div class="reBld">' + k.icon + "</div>" })
      });
      m.bindTooltip(esc(b.name || cap(k.label)) + " · level " + Buildings.levelOf(b),
                    { direction: "top", offset: [0, -10] });
      this.layer.addLayer(m);
    });
    return rows.length;
  },

  /**
   * Handles for every ring, holes included.
   *
   * A hole is a ring like any other, so it gets the same draggable corners —
   * which is the argument for storing them as rings rather than as a separate
   * kind of object with its own editor.
   */
  renderHandles() {
    this.editLayer.clearLayers();
    const r = this.draft;
    if (!r || this.mode !== "select") return;
    Regions.rings(r).forEach((ring, ri) => {
      ring.forEach((p, i) => {
        const m = L.marker(p, {
          draggable: true, zIndexOffset: 800,
          icon: L.divIcon({ className: "pinWrap", iconSize: [12, 12], iconAnchor: [6, 6],
                            html: '<div class="reVertex' + (ri ? " hole" : "") + '"></div>' })
        });
        m.on("drag", (e) => {
          const ll = e.target.getLatLng();
          r.rings[ri][i] = [ll.lat, ll.lng];
          this.preview();
        });
        m.on("dragend", () => this.commit());
        m.on("contextmenu", (e) => {
          L.DomEvent.stop(e);
          if (ring.length <= 3) {
            // Dropping below three corners deletes the ring — which is how a
            // hole is removed, and must never happen to the outline.
            if (ri === 0) { this.toast("An outline needs three corners.", "bad"); return; }
            r.rings.splice(ri, 1);
            this.commit();
            this.toast("Hole removed.", "info");
            return;
          }
          r.rings[ri].splice(i, 1);
          this.commit();
        });
        this.editLayer.addLayer(m);
      });
    });
  },

  preview() {
    const poly = this.layers[this.selected];
    if (poly && this.draft) poly.setLatLngs(Regions.rings(this.draft));
  },

  renderLegend() {
    const host = $("#reLegend");
    const stats = Regions.stats();
    host.innerHTML = Regions.TERRAINS.map(t =>
      '<button class="reLeg' + (this.filter === t.key ? " on" : "") + '" data-t="' + t.key + '" ' +
        'title="' + esc(t.blurb) + '">' +
        '<i style="background:' + t.fill + ';border-color:' + t.stroke + '"></i>' +
        t.icon + " " + esc(t.name) +
        '<b>' + (stats.terrains[t.key] || 0) + "</b></button>").join("");
    host.querySelectorAll(".reLeg").forEach(b => {
      b.onclick = () => {
        const k = b.getAttribute("data-t");
        this.filter = this.filter === k ? "" : k;
        this.renderAll();
      };
    });
  },

  /* ------------------------------------------------------------------ form */

  renderForm() {
    const host = $("#reForm");
    const r = this.draft;
    if (!r) {
      host.innerHTML =
        '<div class="emptyForm">' +
          "<b>Nothing selected.</b><br>" +
          "Draw a region, or click one on the map.<br><br>" +
          "<span class='tiny dimmer'>Regions decide what spawns on the ground they cover. " +
          "The file is plain GeoJSON — export it, edit it anywhere, bring it back.</span>" +
        "</div>";
      return;
    }
    const t = Regions.terrain(r.terrain);
    const tables = (typeof Content !== "undefined" ? Content.list("spawns") : []);
    host.innerHTML =
      '<div class="formHead"><h3>' + t.icon + " " + esc(r.name) + "</h3></div>" +
      '<label class="f"><span>Name</span><input class="input" id="f_name" value="' + esc(r.name) + '"></label>' +
      '<label class="f"><span>Terrain</span><select class="input" id="f_terrain">' +
        Regions.TERRAINS.map(x => '<option value="' + x.key + '"' + (x.key === r.terrain ? " selected" : "") +
          ">" + x.icon + " " + esc(x.name) + "</option>").join("") +
      "</select></label>" +
      '<p class="noteBox" id="f_blurb">' + esc(t.blurb) + "</p>" +
      '<label class="f"><span>Spawn table</span><select class="input" id="f_table">' +
        '<option value="">— ' + esc(t.name) + ' default (' + esc(t.table) + ") —</option>" +
        tables.map(x => '<option value="' + esc(x.spawnTableId) + '"' +
          (x.spawnTableId === r.spawnTableId ? " selected" : "") + ">" + esc(x.name) + "</option>").join("") +
      "</select></label>" +
      '<div class="row2">' +
        '<label class="f"><span>Priority</span><input class="input" id="f_priority" type="number" step="1" value="' +
          (+r.priority || 0) + '"></label>' +
        '<label class="f"><span>Difficulty nudge</span><input class="input" id="f_difficulty" type="number" step="1" min="-4" max="4" value="' +
          (+r.difficulty || 0) + '"></label>' +
      "</div>" +
      '<p class="tiny dimmer">Higher priority wins where regions overlap. On a tie the smaller one wins, ' +
        "so a pond inside a park needs no numbers at all.</p>" +
      '<label class="f"><span>Notes</span><textarea class="input" id="f_notes" rows="2">' + esc(r.notes || "") + "</textarea></label>" +
      '<label class="check"><input type="checkbox" id="f_active"' + (r.active !== false ? " checked" : "") +
        "> Live in the game</label>" +
      '<div class="kv"><span>Rings</span><b>' + Regions.rings(r).length +
        (Regions.rings(r).length > 1 ? " (" + (Regions.rings(r).length - 1) + " hole" +
          (Regions.rings(r).length === 2 ? "" : "s") + ")" : "") + "</b></div>" +
      '<div class="kv"><span>Corners</span><b>' + Regions.rings(r).reduce((n, x) => n + x.length, 0) + "</b></div>" +
      '<div class="kv"><span>Across</span><b>' + fmtDist(Regions.sizeM(r)) + "</b></div>" +
      '<div class="kv"><span>Area</span><b>' + this.areaLabel(Regions.areaM2(r)) + "</b></div>" +
      '<div class="kv"><span>Source</span><b>' + esc(r.source || "hand") + "</b></div>";

    const bind = (id, fn) => { const el = $("#" + id, host); if (el) el.oninput = el.onchange = fn; };
    bind("f_name", (e) => { this.draft.name = e.target.value; this.commit(true); this.renderTable(); });
    bind("f_terrain", (e) => {
      this.draft.terrain = e.target.value;
      this.commit();
    });
    bind("f_table", (e) => { this.draft.spawnTableId = e.target.value; this.commit(true); });
    bind("f_priority", (e) => { this.draft.priority = +e.target.value || 0; this.commit(true); this.renderTable(); });
    bind("f_difficulty", (e) => { this.draft.difficulty = clamp(+e.target.value || 0, -4, 4); this.commit(true); });
    bind("f_notes", (e) => { this.draft.notes = e.target.value; this.commit(true); });
    bind("f_active", (e) => { this.draft.active = e.target.checked; this.commit(); });
  },

  areaLabel(m2) {
    if (m2 >= 1e6) return (m2 / 1e6).toFixed(2) + " km²";
    if (m2 >= 10000) return (m2 / 10000).toFixed(1) + " ha";
    return Math.round(m2) + " m²";
  },

  /* ----------------------------------------------------------------- table */

  renderTable() {
    const host = $("#reTableWrap");
    const rows = Regions.list(true)
      .filter(r => !this.filter || r.terrain === this.filter)
      .sort((a, b) => (a.terrain || "").localeCompare(b.terrain || "") ||
                      (a.name || "").localeCompare(b.name || ""));
    $("#reCount").textContent = rows.length + " shown · " + Regions.stats().regions + " in the file";
    if (!rows.length) {
      host.innerHTML = '<div class="emptyMsg">No regions yet.<br>' +
        "Draw one, import the terrain here, or bring in a GeoJSON file.</div>";
      return;
    }
    host.innerHTML =
      '<table class="grid"><thead><tr>' +
        "<th>Name</th><th>Terrain</th><th>Spawns</th><th class='num'>Across</th>" +
        "<th class='num'>Area</th><th class='num'>Pri</th><th>Source</th>" +
      "</tr></thead><tbody>" +
      rows.map(r => {
        const t = Regions.terrain(r.terrain);
        return '<tr data-id="' + esc(r.regionId) + '"' +
          (r.regionId === this.selected ? ' class="on"' : "") +
          (r.active === false ? ' style="opacity:.55"' : "") + ">" +
          '<td data-l="Name"><span class="nameCell">' + t.icon + " " + esc(r.name) + "</span></td>" +
          '<td data-l="Terrain">' + esc(t.name) + "</td>" +
          '<td data-l="Spawns">' + esc(r.spawnTableId || t.table) + "</td>" +
          '<td class="num" data-l="Across">' + fmtDist(Regions.sizeM(r)) + "</td>" +
          '<td class="num" data-l="Area">' + this.areaLabel(Regions.areaM2(r)) + "</td>" +
          '<td class="num" data-l="Pri">' + (+r.priority || 0) + "</td>" +
          '<td data-l="Source">' + esc(r.source || "hand") + "</td>" +
        "</tr>";
      }).join("") + "</tbody></table>";
    host.querySelectorAll("tbody tr").forEach(tr => {
      tr.onclick = () => this.select(tr.getAttribute("data-id"));
    });
  },

  /* -------------------------------------------------------- importing OSM
     The same cache and the same rate limiting the game uses — see
     claude/osm-policy.md. This page must not be a way around any of it. */

  async importTerrain() {
    if (this.busy) return;
    if (typeof Chunks === "undefined") { this.toast("The world module is not loaded.", "bad"); return; }
    this.busy = true;
    const c = this.map.getCenter();
    this.toast("Reading the map data around here…", "info", 2500);
    try {
      const cells = Grid.chunksWithin(c.lat, c.lng, 700);
      const have = {};
      Regions.all().forEach(r => { if (r.sourceId) have[r.sourceId] = true; });

      let made = 0, surveyed = 0, waited = false, skipped = 0;
      for (const cell of cells) {
        const digest = await Chunks.survey(cell);
        if (!digest) { waited = true; continue; }
        surveyed++;
        const elements = Store.get(Chunks.cacheKeyFor(cell.key), null) || [];
        for (const el of elements) {
          if (made >= 80) break;
          const terrain = Regions.classify(el.tags || {});
          if (!terrain) continue;
          const geo = el.geometry || [];
          if (geo.length < 4) continue;
          // Closed ways only. A creek drawn as a line has no inside, and
          // guessing how wide it is belongs in tools/mapimport.js, not here.
          const a = geo[0], z = geo[geo.length - 1];
          if (a.lat !== z.lat || a.lon !== z.lon) continue;
          const sourceId = (el.type || "way") + "/" + el.id;
          if (have[sourceId]) { skipped++; continue; }
          if (!this.map.getBounds().pad(0.25).contains([a.lat, a.lon])) continue;
          const pts = geo.slice(0, -1).filter(p => isFinite(p.lat) && isFinite(p.lon))
                         .map(p => [p.lat, p.lon]);
          if (pts.length < 3) continue;
          const r = Regions.blank(terrain, [pts]);
          r.name = (el.tags && el.tags.name) || Regions.terrain(terrain).name;
          r.source = "osm";
          r.sourceId = sourceId;
          // A flowerbed is not a region. 400 m² is about a tennis court.
          if (Regions.areaM2(r) < 400) continue;
          Regions.save(r);
          have[sourceId] = 1;
          made++;
        }
        if (made >= 80) break;
      }
      this.renderAll();
      if (!made && waited) {
        this.toast("No map data here yet, and the map service is being rested. Try again shortly.", "bad", 5000);
      } else if (!made) {
        this.toast(skipped ? "Everything here is already in." : "No water or green cover mapped in this view.", "info", 4000);
      } else {
        this.toast("Imported " + made + " region" + (made === 1 ? "" : "s") +
                   " from " + surveyed + " cell" + (surveyed === 1 ? "" : "s") + ".", "good", 4000);
      }
    } catch (e) {
      this.toast("Import failed: " + (e && e.message), "bad", 4000);
    } finally { this.busy = false; }
  },

  /* ------------------------------------------------------------------ file */

  fileMenu() {
    const body = el("div");
    const s = Regions.stats();
    const terrainOpts = Regions.TERRAINS.map(t =>
      '<option value="' + t.key + '"' + (t.key === "wood" ? " selected" : "") + ">" +
      t.icon + " " + esc(t.name) + "</option>").join("");
    body.innerHTML =
      "<p class='tiny dim'>Regions are plain GeoJSON. The same file opens in QGIS, geojson.io, " +
      "or anything else that reads a FeatureCollection — and " +
      "<code>tools/mapimport.js</code> writes one for a whole town.</p>" +
      '<div class="kv"><span>Regions</span><b>' + s.regions + "</b></div>" +
      '<div class="kv"><span>From the map</span><b>' + s.imported + "</b></div>" +
      '<div class="kv"><span>Size</span><b>' + Math.round(s.bytes / 1024) + " KB</b></div>" +
      '<div class="sect tiny">Export</div>' +
      '<button class="btn block" id="reDl">Download regions.geojson</button>' +
      '<div class="sect tiny">Import</div>' +
      '<p class="tiny dim" style="margin-top:0">GeoJSON, or <b>KML / KMZ straight out of Google Earth</b> — ' +
        "draw your shapes there, <i>Save Place As</i>, and drop the file in here.</p>" +
      '<p class="tiny dim" style="margin-top:-4px">Pins come in too: a placemark named ' +
        "<code>building: Store level 3</code> becomes a building rather than a piece of ground. " +
        "<code>docs/google-earth.md</code> has the whole naming scheme.</p>" +
      '<input type="file" id="reUp" class="input" ' +
        'accept=".geojson,.json,.kml,.kmz,application/geo+json,application/json,' +
        'application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz">' +
      '<div class="row2" style="margin-top:10px">' +
        '<label class="f"><span>KML terrain</span><select class="input" id="reTerrain">' + terrainOpts + "</select></label>" +
        '<label class="f"><span>Traced paths</span><select class="input" id="reBand">' +
          '<option value="20" selected>20 m wide</option>' +
          '<option value="8">8 m wide</option>' +
          '<option value="40">40 m wide</option>' +
          '<option value="0">skip them</option>' +
        "</select></label>" +
      "</div>" +
      '<label class="check"><input type="checkbox" id="reGuess" checked> ' +
        "Read names and folders for the terrain</label>" +
      '<p class="tiny dimmer" style="margin-top:-4px">A placemark called “Black Fork Creek”, or anything ' +
        "in a folder called “Low ground”, classifies itself. The picker above covers whatever is left.</p>" +
      '<label class="check" style="margin-top:8px"><input type="checkbox" id="reRepl"> Replace everything</label>' +
      '<p class="tiny dimmer">Merging keeps what you have and updates anything with a matching id.</p>';
    const m = this.modal("The region file", body);
    $("#reDl", body).onclick = () => this.download();
    $("#reUp", body).onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      this.readImport(f, body, m);
    };
  },

  /**
   * Take whatever file was handed over.
   *
   * Three shapes arrive here: GeoJSON, KML, and KMZ — which is a zip and so
   * has to be read as bytes rather than text. The sniff is on the content
   * rather than the extension, because a file renamed .json that is really a
   * KML should still work and saying "that file is not JSON" to someone
   * holding a Google Earth export is a bad answer.
   */
  async readImport(file, body, modal) {
    const replace = $("#reRepl", body).checked;
    const opts = {
      terrain: $("#reTerrain", body).value,
      lineWidthM: +$("#reBand", body).value,
      guess: $("#reGuess", body).checked
    };
    try {
      let doc = null, from = "GeoJSON";
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);

      if (KML.isZip(bytes)) {
        from = "KMZ";
        doc = KML.toGeoJSON(await KML.unzipKmz(bytes), opts);
      } else {
        const text = new TextDecoder().decode(bytes);
        if (/<\s*(\w+:)?kml[\s>]/i.test(text) || /<\s*(\w+:)?Placemark[\s>]/i.test(text)) {
          from = "KML";
          doc = KML.toGeoJSON(text, opts);
        } else {
          try {
            doc = JSON.parse(text);
          } catch (bad) {
            /* Handing somebody a raw parser error — "Unexpected token 'h'" —
               tells them nothing about what to do next. Name the three things
               this accepts instead. */
            throw new Error("That is not a map file. Drop in GeoJSON, or a .kml or .kmz from Google Earth.");
          }
        }
      }

      const skipped = doc.skipped || null;
      /* One file, two tables. A Google Earth survey is usually the ground and
         the places standing on it in the same folder tree, so both halves are
         taken from the same drop and reported together. Buildings first, so a
         file of nothing but shopfronts is not answered with "no polygons". */
      const bld = (typeof Buildings !== "undefined")
        ? Buildings.import(doc, replace) : { added: 0, updated: 0 };
      const res = Regions.import(doc, replace);
      if (!res.success && !(bld.added || bld.updated)) { this.toast(res.message, "bad", 4500); return; }
      modal.remove();
      this.select(null);
      this.renderAll();
      const extra = skipped && (skipped.points || skipped.lines)
        ? " (" + [skipped.points && skipped.points + " pin" + (skipped.points === 1 ? "" : "s"),
                  skipped.lines && skipped.lines + " path" + (skipped.lines === 1 ? "" : "s")]
                 .filter(Boolean).join(", ") + " skipped)"
        : "";
      const built = (bld.added || bld.updated)
        ? " · " + (bld.added + bld.updated) + " building" + ((bld.added + bld.updated) === 1 ? "" : "s")
        : "";
      this.toast(from + ": " + (res.added || 0) + " added, " + (res.updated || 0) + " updated" +
                 built + extra + ".", "good", 4500);
      // Land on what just arrived rather than leaving them looking at nothing.
      if (res.added) {
        const last = Regions.all()[Regions.all().length - 1];
        const b = last && Regions.bounds(last);
        if (b) this.map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [60, 60] });
      }
    } catch (err) {
      this.toast(String((err && err.message) || err).slice(0, 160), "bad", 5000);
    }
  },

  download() {
    const doc = Regions.export();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/geo+json" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "regions.geojson";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  },

  jumpTo() {
    const v = $("#reSearch").value.trim();
    const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(v);
    if (!m) { this.toast("Give it a lat, lng.", "bad"); return; }
    this.map.setView([+m[1], +m[2]], Math.max(this.map.getZoom(), 15));
  },

  renderStatus() {
    const c = this.map.getCenter();
    const here = Regions.at(c.lat, c.lng);
    const s = Regions.stats();
    $("#reStatus").innerHTML =
      "<span>" + s.regions + " regions</span>" +
      "<span>middle of the map: <b>" + (here ? esc(here.name) + " · " +
        esc(Regions.terrain(here.terrain).name) : "nothing drawn") + "</b></span>" +
      '<span class="mono">' + c.lat.toFixed(5) + ", " + c.lng.toFixed(5) + "</span>" +
      '<span class="mono">z' + this.map.getZoom() + "</span>";
  },

  renderAll() {
    this.renderRegions();
    this.renderHandles();
    this.renderLegend();
    this.renderTable();
    this.renderForm();
    this.renderStatus();
  },

  /* ----------------------------------------------------------- small UI bits */

  modal(title, bodyEl) {
    const back = el("div", "modalBack");
    back.style.cssText = "position:fixed;inset:0;z-index:1000;background:rgba(5,7,11,.8);" +
      "display:flex;align-items:center;justify-content:center;padding:16px";
    const box = el("div");
    box.style.cssText = "width:100%;max-width:460px;max-height:88vh;overflow:auto;background:var(--bg-2);" +
      "border:1px solid var(--line-2);border-radius:14px;padding:16px";
    box.innerHTML = "<h3 style='margin:0 0 12px'>" + esc(title) + "</h3>";
    box.appendChild(bodyEl);
    const close = el("button", "btn block ghost", "Close");
    close.style.marginTop = "12px";
    close.onclick = () => back.remove();
    box.appendChild(close);
    back.appendChild(box);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    return back;
  },

  toast(msg, kind, ms) {
    let host = $("#toasts");
    if (!host) { host = el("div"); host.id = "toasts"; document.body.appendChild(host); }
    const t = el("div", "toast " + (kind || "info"), msg);
    host.appendChild(t);
    setTimeout(() => t.remove(), ms || 2600);
  }
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => Re.init());
else Re.init();
window.RE = { Re, Regions, Buildings, KML, Content, Store, Chunks, Grid, settings, haversine };
