"use strict";
/* -------------------------------------------------------------------------
   THE SHAPE EDITOR — draw the buildings the generator cannot.

   The town the game draws is real OSM geometry renamed and restyled. It is
   the right shape but it is nobody's design. This page is the other half: you
   draw over the real map, keep the result in its own file, and the game paints
   it on top.

   THREE THINGS IT HAS TO GET RIGHT

   1. Real coordinates. A shape is [lat, lng] points, so it sits on the ground
      it was drawn on at every zoom, in the editor and in the game, with no
      projection of its own to keep in step.
   2. A rough start. Tracing a building by eye is miserable; the footprints
      are already surveyed, so "Import footprints" hands you the real outlines
      as editable polygons and the work becomes restyling rather than tracing.
   3. Its own file. Nothing else writes to shape_defs, and Export gives you one
      document you can drop on a server or into data/shapes.json.

   WHAT DRAWING MEANS HERE
     draw      click to drop vertices, double-click / Enter to finish, Esc to bin
     select    click a shape; its vertices become draggable handles
     move      drag the middle handle, or the shape itself
     resize    the scale buttons and slider, about the shape's own centroid
   ------------------------------------------------------------------------- */
const Se = {
  map: null,
  layer: null,          // finished shapes
  editLayer: null,      // handles for the selected one
  drawLayer: null,      // the shape being drawn
  mode: "select",       // select | polygon | line
  selected: null,       // shapeId
  draft: null,          // the shape being edited, or drawn
  drawing: null,        // [[lat,lng], …] while drawing
  busy: false,

  /* ------------------------------------------------------------------ boot */

  async init() {
    const root = $("#se");
    root.innerHTML =
      '<div class="meTop">' +
        '<div class="meBrand"><b>Stride &amp; Sword</b><span>Shapes</span></div>' +
        '<div class="layerSwitch" id="seTools">' +
          '<button data-tool="select" class="on">Select</button>' +
          '<button data-tool="polygon">+ Building</button>' +
          '<button data-tool="line">+ Line</button>' +
        "</div>" +
        '<button class="btn ghost sm" id="seImport" title="Bring in the real building outlines here">⬇ Import footprints</button>' +
        '<input class="input" id="seSearch" placeholder="lat, lng" style="width:190px">' +
        '<div class="spacer"></div>' +
        '<button class="btn ghost sm" id="seFile">Export / Import</button>' +
        '<a class="btn ghost sm" href="index.html">Game</a>' +
        '<a class="btn ghost sm" href="mapeditor.html">Map editor</a>' +
      "</div>" +
      '<div class="meBody">' +
        '<div class="meLeft">' +
          '<div class="mapWrap">' +
            '<div id="map"></div>' +
            '<div class="mapHint hidden" id="seHint"></div>' +
            '<div class="seLegend" id="seLegend"></div>' +
          "</div>" +
          '<div class="meTable">' +
            '<div class="meTableBar">' +
              "<b>Shapes</b>" +
              '<span class="tiny dimmer" id="seCount"></span>' +
              '<span class="spacer"></span>' +
              '<button class="btn sm ghost" id="seHideAll">Show all</button>' +
              '<button class="btn sm danger" id="seDel" disabled>Delete</button>' +
            "</div>" +
            '<div class="meTableWrap" id="seTableWrap"></div>' +
          "</div>" +
        "</div>" +
        '<div class="meForm" id="seForm"></div>' +
      "</div>" +
      '<footer class="meStatus" id="seStatus"></footer>';

    // The database is fetched, so a fresh install seeds its shapes before the
    // first render rather than flashing an empty table.
    try { await DB.load(); DB.seedShapes(false); } catch (e) { /* offline is fine */ }

    this.initMap();
    this.bind();
    this.renderAll();
  },

  bind() {
    $("#seTools").querySelectorAll("button").forEach(b => {
      b.onclick = () => this.setTool(b.getAttribute("data-tool"));
    });
    $("#seImport").onclick = () => this.importFootprints();
    $("#seFile").onclick = () => this.fileMenu();
    $("#seDel").onclick = () => this.deleteSelected();
    $("#seHideAll").onclick = () => this.toggleHidden();
    $("#seSearch").onkeydown = (e) => { if (e.key === "Enter") this.jumpTo(); };
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
    const start = Store.session.get("shapeEditorView", null) || { lat: 41.8827, lng: -87.6233, z: 19 };
    this.map = L.map("map", { zoomControl: true, maxZoom: 24, minZoom: 3, zoomSnap: 0.5 })
      .setView([start.lat, start.lng], start.z);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 24, maxNativeZoom: 19, keepBuffer: 3,
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
      Store.session.set("shapeEditorView", { lat: c.lat, lng: c.lng, z: this.map.getZoom() });
      this.renderStatus();
    });
  },

  /* ----------------------------------------------------------------- tools */

  setTool(tool) {
    this.cancelDraw();
    this.mode = tool || "select";
    $("#seTools").querySelectorAll("button").forEach(b =>
      b.classList.toggle("on", b.getAttribute("data-tool") === this.mode));
    // A draw tool wants clicks on the map, not on the shapes underneath.
    this.map.getContainer().style.cursor = this.mode === "select" ? "" : "crosshair";
    this.hint(this.mode === "select" ? null
      : "Click to drop points · double-click or Enter to finish · Esc to cancel");
    this.renderShapes();
  },

  hint(text) {
    const h = $("#seHint");
    h.classList.toggle("hidden", !text);
    if (text) h.textContent = text;
  },

  /* ---------------------------------------------------------------- drawing */

  onMapClick(e) {
    if (this.mode === "select") { this.select(null); return; }
    if (!this.drawing) this.drawing = [];
    this.drawing.push([e.latlng.lat, e.latlng.lng]);
    this.renderDraw();
  },

  renderDraw() {
    this.drawLayer.clearLayers();
    if (!this.drawing || !this.drawing.length) return;
    const pts = this.drawing;
    if (pts.length > 1) {
      const line = this.mode === "polygon" && pts.length > 2
        ? L.polygon(pts, { color: "#e0a33e", weight: 2, dashArray: "5 5", fillOpacity: .12 })
        : L.polyline(pts, { color: "#e0a33e", weight: 2, dashArray: "5 5" });
      this.drawLayer.addLayer(line);
    }
    pts.forEach((p, i) => {
      this.drawLayer.addLayer(L.marker(p, {
        icon: L.divIcon({ className: "pinWrap", iconSize: [12, 12], iconAnchor: [6, 6],
          html: '<div class="seVertex draft' + (i === 0 ? " first" : "") + '"></div>' })
      }));
    });
    this.hint(pts.length + " point" + (pts.length === 1 ? "" : "s") +
              " · double-click or Enter to finish · Esc to cancel");
  },

  finishDraw() {
    const pts = this.drawing || [];
    const min = this.mode === "polygon" ? 3 : 2;
    if (pts.length < min) {
      this.toast("A " + (this.mode === "polygon" ? "building needs at least three points"
                                                 : "line needs at least two"), "bad");
      return;
    }
    const s = Shapes.save(Shapes.blank(this.mode, pts));
    this.cancelDraw();
    this.setTool("select");
    this.select(s.shapeId);
    this.renderAll();
    this.toast("Drawn. " + Shapes.sizeM(s) + " m across.");
  },

  cancelDraw() {
    this.drawing = null;
    this.drawLayer.clearLayers();
    if (this.mode !== "select") this.hint("Click to drop points · double-click or Enter to finish");
    else this.hint(null);
  },

  /* -------------------------------------------------------------- selection */

  select(id) {
    this.selected = id || null;
    this.draft = id ? JSON.parse(JSON.stringify(Shapes.get(id) || {})) : null;
    $("#seDel").disabled = !id;
    this.renderShapes();
    this.renderHandles();
    this.renderForm();
    this.renderTable();
  },

  /** Write the working copy back to the table and redraw. */
  commit(quiet) {
    if (!this.draft) return;
    Shapes.save(this.draft);
    this.renderShapes();
    this.renderHandles();
    this.renderTable();
    this.renderStatus();
    if (!quiet) this.renderForm();
  },

  deleteSelected() {
    if (!this.selected) return;
    const s = Shapes.get(this.selected);
    if (!s) return;
    if (!confirm("Delete " + (s.name || "this shape") + "?")) return;
    Shapes.remove(this.selected);
    this.select(null);
    this.renderAll();
    this.toast("Deleted.", "bad");
  },

  toggleHidden() {
    this._showHidden = !this._showHidden;
    $("#seHideAll").textContent = this._showHidden ? "Hide hidden" : "Show all";
    this.renderAll();
  },

  /* ---------------------------------------------------------------- drawing */

  renderShapes() {
    this.layer.clearLayers();
    this.shapeLayers = {};
    const rows = Shapes.list(this._showHidden).slice().sort((a, b) => (+a.z || 0) - (+b.z || 0));
    rows.forEach(s => {
      const style = Shapes.styleOf(s);
      // A territory reads as a boundary rather than a building: dashed, barely
      // filled, so you can see what is inside it while you draw.
      if (s.purpose === "zone") { style.dashArray = style.dashArray || "8 6"; style.fillOpacity = 0.08; }
      if (s.active === false) { style.opacity = 0.35; style.fillOpacity = 0.08; style.dashArray = "3 5"; }
      if (s.shapeId === this.selected) { style.weight = Math.max(3, style.weight + 1); }
      const layer = s.kind === "line"
        ? L.polyline(s.points, style)
        : L.polygon(s.points, style);
      layer.on("click", (e) => {
        if (this.mode !== "select") { L.DomEvent.stop(e); this.onMapClick(e); return; }
        L.DomEvent.stop(e);
        this.select(s.shapeId);
      });
      layer.bindTooltip(esc(s.name || "Shape"), { direction: "top", sticky: true });
      this.layer.addLayer(layer);
      this.shapeLayers[s.shapeId] = layer;
    });
    this.renderLegend();
  },

  /**
   * Handles for the selected shape: one per vertex to reshape it, and one in
   * the middle to move the whole thing. Dragging a vertex rewrites that point
   * only; dragging the middle shifts them all.
   */
  renderHandles() {
    this.editLayer.clearLayers();
    const s = this.draft;
    if (!s || !s.points || this.mode !== "select") return;

    s.points.forEach((p, i) => {
      const m = L.marker(p, {
        draggable: true, zIndexOffset: 800,
        icon: L.divIcon({ className: "pinWrap", iconSize: [14, 14], iconAnchor: [7, 7],
                          html: '<div class="seVertex"></div>' })
      });
      m.on("drag", (e) => {
        const ll = e.target.getLatLng();
        s.points[i] = [ll.lat, ll.lng];
        this.previewDraft();
      });
      m.on("dragend", () => this.commit());
      // Right-click a vertex to drop it, as long as the shape survives it.
      m.on("contextmenu", (e) => {
        L.DomEvent.stop(e);
        const min = s.kind === "line" ? 2 : 3;
        if (s.points.length <= min) { this.toast("That is as few points as it can have.", "bad"); return; }
        s.points.splice(i, 1);
        this.commit();
      });
      this.editLayer.addLayer(m);
    });

    const c = Shapes.centroid(s);
    if (!c) return;
    const mid = L.marker([c.latitude, c.longitude], {
      draggable: true, zIndexOffset: 900,
      icon: L.divIcon({ className: "pinWrap", iconSize: [20, 20], iconAnchor: [10, 10],
                        html: '<div class="seMove" title="Drag to move">✥</div>' })
    });
    let from = c;
    mid.on("dragstart", () => { from = Shapes.centroid(s); });
    mid.on("drag", (e) => {
      const ll = e.target.getLatLng();
      Shapes.move(s, ll.lat - from.latitude, ll.lng - from.longitude);
      from = { latitude: ll.lat, longitude: ll.lng };
      this.previewDraft();
    });
    mid.on("dragend", () => this.commit());
    this.editLayer.addLayer(mid);
  },

  /** Redraw just the selected shape while a handle is being dragged. */
  previewDraft() {
    const layer = this.shapeLayers && this.shapeLayers[this.selected];
    if (!layer || !this.draft) return;
    layer.setLatLngs(this.draft.points);
  },

  renderLegend() {
    const st = Shapes.stats();
    $("#seLegend").innerHTML =
      "<b>" + st.shapes + "</b> shapes · " + st.polygons + " buildings · " +
      st.lines + " lines" + (st.zones ? " · <b>" + st.zones + "</b> territories" : "") +
      (st.imported ? " · " + st.imported + " imported" : "");
  },

  /* ------------------------------------------------------------------- form */

  renderForm() {
    const host = $("#seForm");
    const s = this.draft;
    if (!s) {
      host.innerHTML =
        '<div class="emptyForm">' +
          "<p><b>Nothing selected.</b></p>" +
          "<p>Draw a building or a line with the buttons above, or click one to edit it.</p>" +
          "<p><b>Import footprints</b> brings in the real outlines around the middle of the map " +
          "as editable shapes — a rough start you can restyle rather than trace.</p>" +
          "<p class='tiny dimmer'>Right-click a vertex to remove it. Drag ✥ to move the whole shape.</p>" +
        "</div>";
      return;
    }
    const c = Shapes.centroid(s);
    host.innerHTML =
      '<div class="formHead"><h3>' + esc(s.name || "Shape") + "</h3>" +
        '<span class="tag">' + esc(s.kind) + "</span></div>" +
      '<label class="f"><span>Name</span><input class="input" id="f_name" value="' + esc(s.name || "") + '"></label>' +
      '<div class="sect">Paint</div>' +
      '<div class="swatches" id="f_swatch">' +
        Shapes.PALETTE.map(p =>
          '<button class="sw" title="' + p.name + '" data-stroke="' + p.stroke + '" data-fill="' + p.fill + '"' +
          ' style="background:' + p.fill + ';border-color:' + p.stroke + '"></button>').join("") +
      "</div>" +
      '<div class="row2">' +
        '<label class="f"><span>Line</span><input type="color" class="input" id="f_stroke" value="' + esc(s.stroke) + '"></label>' +
        '<label class="f"><span>Fill</span><input type="color" class="input" id="f_fill" value="' + esc(s.fill) + '"></label>' +
      "</div>" +
      '<label class="f"><span>Line width — <b id="f_swLabel">' + (+s.strokeWidth || 2) + "</b> px</span>" +
        '<input type="range" id="f_strokeWidth" min="1" max="10" step="0.5" value="' + (+s.strokeWidth || 2) + '"></label>' +
      '<label class="f"><span>Line opacity — <b id="f_soLabel">' +
        Math.round((s.strokeOpacity == null ? .95 : s.strokeOpacity) * 100) + "</b>%</span>" +
        '<input type="range" id="f_strokeOpacity" min="0" max="1" step="0.05" value="' +
        (s.strokeOpacity == null ? .95 : s.strokeOpacity) + '"></label>' +
      (s.kind === "line" ? "" :
        '<label class="f"><span>Fill opacity — <b id="f_foLabel">' +
        Math.round((s.fillOpacity == null ? .35 : s.fillOpacity) * 100) + "</b>%</span>" +
        '<input type="range" id="f_fillOpacity" min="0" max="1" step="0.05" value="' +
        (s.fillOpacity == null ? .35 : s.fillOpacity) + '"></label>') +
      '<label class="f"><span>Dashes</span><select id="f_dash">' +
        [["", "solid"], ["6 5", "dashed"], ["2 5", "dotted"], ["12 6 3 6", "dot-dash"]].map(([v, l]) =>
          '<option value="' + v + '"' + (s.dash === v ? " selected" : "") + ">" + l + "</option>").join("") +
      "</select></label>" +

      '<div class="sect">Shape</div>' +
      '<div class="kv"><span>Points</span><b>' + s.points.length + "</b></div>" +
      '<div class="kv"><span>Size</span><b>' + Shapes.sizeM(s) + " m</b></div>" +
      '<div class="kv"><span>Centre</span><b>' + (c ? c.latitude.toFixed(5) + ", " + c.longitude.toFixed(5) : "—") + "</b></div>" +
      (s.osmId ? '<div class="kv"><span>From</span><b class="tiny">' + esc(s.osmId) + "</b></div>" : "") +
      '<div class="btnRow">' +
        '<button class="btn sm" id="f_small">− 10%</button>' +
        '<button class="btn sm" id="f_big">+ 10%</button>' +
        '<button class="btn sm" id="f_left">↺ 15°</button>' +
        '<button class="btn sm" id="f_right">↻ 15°</button>' +
      "</div>" +
      '<label class="f"><span>Draw order — <b id="f_zLabel">' + (+s.z || 0) + "</b></span>" +
        '<input type="range" id="f_z" min="-5" max="5" step="1" value="' + (+s.z || 0) + '"></label>' +
      '<label class="check"><input type="checkbox" id="f_active"' + (s.active === false ? "" : " checked") +
        "> Visible in the game</label>" +

      /* Scenery or territory. The same polygon either way — this only says
         what it means, and a territory grows a few more fields. */
      '<div class="sect">What it is for</div>' +
      '<div class="layerSwitch" id="f_purpose" style="width:100%">' +
        '<button data-purpose="scenery" style="flex:1"' +
          (s.purpose === "zone" ? "" : ' class="on"') + ">Scenery</button>" +
        '<button data-purpose="zone" style="flex:1"' +
          (s.purpose === "zone" ? ' class="on"' : "") + ">Territory</button>" +
      "</div>" +
      '<div id="f_zoneWrap"></div>' +
      '<label class="f"><span>Notes</span><textarea id="f_notes">' + esc(s.notes || "") + "</textarea></label>" +
      '<div class="formActions">' +
        '<button class="btn ghost block" id="f_dup">Duplicate</button>' +
        '<button class="btn danger block" id="f_del">Delete</button>' +
      "</div>";

    const set = (id, fn, ev) => {
      const elx = $("#" + id);
      if (elx) elx[ev || "oninput"] = () => { fn(elx.value); this.commit(true); this.renderLabels(); };
    };
    set("f_name", v => { this.draft.name = v; });
    set("f_stroke", v => { this.draft.stroke = v; });
    set("f_fill", v => { this.draft.fill = v; });
    set("f_strokeWidth", v => { this.draft.strokeWidth = +v; });
    set("f_strokeOpacity", v => { this.draft.strokeOpacity = +v; });
    set("f_fillOpacity", v => { this.draft.fillOpacity = +v; });
    set("f_z", v => { this.draft.z = +v; });
    set("f_notes", v => { this.draft.notes = v; });
    const dash = $("#f_dash");
    if (dash) dash.onchange = () => { this.draft.dash = dash.value; this.commit(true); };
    const act = $("#f_active");
    if (act) act.onchange = () => { this.draft.active = act.checked; this.commit(true); };

    $("#f_purpose").querySelectorAll("button").forEach(b => {
      b.onclick = () => {
        this.draft.purpose = b.getAttribute("data-purpose");
        this.commit();
      };
    });
    this.renderZoneFields();

    $("#f_swatch").querySelectorAll(".sw").forEach(b => {
      b.onclick = () => {
        this.draft.stroke = b.getAttribute("data-stroke");
        this.draft.fill = b.getAttribute("data-fill");
        this.commit();
      };
    });
    $("#f_small").onclick = () => { Shapes.scale(this.draft, 0.9); this.commit(); };
    $("#f_big").onclick   = () => { Shapes.scale(this.draft, 1.1); this.commit(); };
    $("#f_left").onclick  = () => { Shapes.rotate(this.draft, -15); this.commit(); };
    $("#f_right").onclick = () => { Shapes.rotate(this.draft, 15); this.commit(); };
    $("#f_del").onclick   = () => this.deleteSelected();
    $("#f_dup").onclick   = () => {
      const copy = JSON.parse(JSON.stringify(this.draft));
      copy.shapeId = null; copy.osmId = "";
      copy.name = (copy.name || "Shape") + " copy";
      // Offset a little so the copy is not hidden exactly under the original.
      Shapes.move(copy, 0.00012, 0.00012);
      const saved = Shapes.save(copy);
      this.select(saved.shapeId);
      this.renderAll();
    };
  },

  /**
   * The extra fields a territory needs: what lives in it, how many, and how
   * far a character is allowed to wander from it.
   */
  renderZoneFields() {
    const wrap = $("#f_zoneWrap");
    const s = this.draft;
    if (!wrap || !s) return;
    if (s.purpose !== "zone") {
      wrap.innerHTML = '<p class="tiny dimmer">Drawn and nothing more. ' +
        "Make it a territory to put something in it.</p>";
      return;
    }
    const spawns = [{ value: "", label: "— whatever is in the bestiary —" }].concat(
      (typeof Content !== "undefined" ? Content.list("spawns") : [])
        .map(t => ({ value: t.spawnTableId, label: t.name })));
    const quests = [{ value: "", label: "— no quest —" }].concat(
      (typeof Content !== "undefined" ? Content.list("quests") : [])
        .map(q => ({ value: q.questId, label: q.name })));
    const isChar = s.zoneKind === "character";

    wrap.innerHTML =
      '<label class="f"><span>What lives here</span><select id="z_kind">' +
        Object.values(Denizens.KINDS).map(k =>
          '<option value="' + k.key + '"' + (s.zoneKind === k.key ? " selected" : "") + ">" +
          k.icon + " " + k.name + " — " + k.blurb + "</option>").join("") +
      "</select></label>" +
      (isChar
        ? '<div class="row2">' +
            '<label class="f"><span>Name</span><input class="input" id="z_npc" value="' +
              esc(s.npcName || "") + '" placeholder="Wend the tanner"></label>' +
            '<label class="f"><span>Icon</span><input class="input" id="z_icon" value="' +
              esc(s.npcIcon || "") + '" placeholder="🧍"></label>' +
          "</div>" +
          '<label class="f"><span>Hands out</span><select id="z_quest">' +
            quests.map(q => '<option value="' + esc(q.value) + '"' +
              (s.questId === q.value ? " selected" : "") + ">" + esc(q.label) + "</option>").join("") +
          "</select></label>" +
          '<label class="f"><span>How far they wander</span><select id="z_roams">' +
            Object.values(Denizens.ROAMS).map(r =>
              '<option value="' + r.key + '"' + (s.roams === r.key ? " selected" : "") + ">" +
              esc(r.name) + " — " + esc(r.blurb) + "</option>").join("") +
          "</select></label>"
        : '<div class="row2">' +
            '<label class="f"><span>How many</span><input class="input" id="z_count" type="number" ' +
              'min="0" max="8" value="' + (s.count == null ? 2 : s.count) + '"></label>' +
            '<label class="f"><span>Tougher by</span><input class="input" id="z_diff" type="number" ' +
              'min="0" max="6" value="' + (+s.difficulty || 0) + '"></label>' +
          "</div>" +
          '<label class="f"><span>Which creatures</span><select id="z_spawn">' +
            spawns.map(o => '<option value="' + esc(o.value) + '"' +
              (s.spawnTableId === o.value ? " selected" : "") + ">" + esc(o.label) + "</option>").join("") +
          "</select></label>" +
          '<p class="noteBox">Creatures never leave this outline — every step they take is ' +
            "picked from inside it, so the boundary holds by construction rather than by " +
            "bouncing them off a wall.</p>");

    const on = (id, fn, ev) => {
      const e = $("#" + id);
      if (e) e.addEventListener(ev || "input", () => fn(e.value));
    };
    on("z_kind", v => { this.draft.zoneKind = v; this.commit(); }, "change");
    on("z_count", v => { this.draft.count = clamp(parseInt(v, 10) || 0, 0, 8); this.commit(true); });
    on("z_diff", v => { this.draft.difficulty = clamp(parseInt(v, 10) || 0, 0, 6); this.commit(true); });
    on("z_spawn", v => { this.draft.spawnTableId = v; this.commit(true); }, "change");
    on("z_npc", v => { this.draft.npcName = v; this.commit(true); });
    on("z_icon", v => { this.draft.npcIcon = v; this.commit(true); });
    on("z_quest", v => { this.draft.questId = v; this.commit(true); }, "change");
    on("z_roams", v => { this.draft.roams = v; this.commit(true); }, "change");
  },

  /** Keep the slider read-outs honest without rebuilding the whole form. */
  renderLabels() {
    const s = this.draft;
    if (!s) return;
    const put = (id, v) => { const e = $("#" + id); if (e) e.textContent = v; };
    put("f_swLabel", +s.strokeWidth || 2);
    put("f_soLabel", Math.round((s.strokeOpacity == null ? .95 : s.strokeOpacity) * 100));
    put("f_foLabel", Math.round((s.fillOpacity == null ? .35 : s.fillOpacity) * 100));
    put("f_zLabel", +s.z || 0);
  },

  /* ------------------------------------------------------------------ table */

  renderTable() {
    const host = $("#seTableWrap");
    const rows = Shapes.list(this._showHidden);
    $("#seCount").textContent = rows.length ? rows.length + " shown" : "";
    if (!rows.length) {
      host.innerHTML = '<div class="emptyMsg">No shapes yet.<br>' +
        "Draw one, or import the real footprints around you.</div>";
      return;
    }
    const c0 = this.map.getCenter();
    const withD = rows.map(s => {
      const c = Shapes.centroid(s);
      return { s, d: c ? haversine(c0.lat, c0.lng, c.latitude, c.longitude) : Infinity };
    }).sort((a, b) => a.d - b.d);

    host.innerHTML =
      '<table class="grid"><thead><tr>' +
        "<th>Name</th><th>Kind</th><th class='num'>Points</th><th class='num'>Size</th>" +
        "<th>Paint</th><th class='num'>From centre</th><th>State</th>" +
      "</tr></thead><tbody>" +
      withD.map(({ s, d }) =>
        '<tr data-id="' + s.shapeId + '"' + (s.shapeId === this.selected ? ' class="on"' : "") + ">" +
          "<td>" + esc(s.name || "Shape") + "</td>" +
          "<td>" + esc(s.kind) + "</td>" +
          "<td class='num'>" + s.points.length + "</td>" +
          "<td class='num'>" + Shapes.sizeM(s) + " m</td>" +
          '<td><span class="swDot" style="background:' + esc(s.fill) + ";border-color:" + esc(s.stroke) + '"></span></td>' +
          "<td class='num'>" + (isFinite(d) ? Math.round(d) + " m" : "—") + "</td>" +
          "<td>" + (s.active === false ? '<span class="tag warn">hidden</span>'
                 : s.purpose === "zone"
                   ? '<span class="tag" style="border-color:var(--mana);color:var(--mana)">' +
                     (s.zoneKind === "character" ? "character" : (s.count == null ? 2 : s.count) + " creatures") +
                     "</span>"
                 : s.osmId ? '<span class="tag">imported</span>' : '<span class="tag ok">drawn</span>') + "</td>" +
        "</tr>").join("") +
      "</tbody></table>";

    host.querySelectorAll("tbody tr").forEach(tr => {
      tr.onclick = () => {
        const id = tr.getAttribute("data-id");
        this.select(id);
        const c = Shapes.centroid(Shapes.get(id));
        if (c) this.map.panTo([c.latitude, c.longitude]);
      };
    });
  },

  /* ----------------------------------------------------------- importing */

  /**
   * Bring the real footprints around the middle of the map in as shapes.
   *
   * Everything here goes through Chunks.survey, so it reads the cache the game
   * already filled and, when it has to ask Overpass, does it through the same
   * gate with the same rate limiting. An `osmId` on each imported shape is what
   * stops the same building arriving twice.
   */
  async importFootprints() {
    if (this.busy) return;
    this.busy = true;
    const c = this.map.getCenter();
    this.toast("Reading the map data around here…", "info", 2500);
    try {
      const cells = Grid.chunksWithin(c.lat, c.lng, 260);
      const already = {};
      Shapes.all().forEach(s => { if (s.osmId) already[s.osmId] = 1; });

      let made = 0, surveyed = 0, waited = false;
      for (const cell of cells) {
        const digest = await Chunks.survey(cell);
        if (!digest) { waited = true; continue; }
        surveyed++;
        const elements = Store.get(Chunks.cacheKeyFor(cell.key), null) || [];
        for (const el of elements) {
          if (made >= 60) break;                      // one screenful at a time
          const tags = el.tags || {};
          if (!tags.building && !tags.leisure && !tags.landuse) continue;
          if (!el.geometry || el.geometry.length < 3) continue;
          const osmId = (el.type || "way") + "/" + el.id;
          if (already[osmId]) continue;
          // Only what is actually on screen — importing a whole chunk from a
          // zoomed-out view drops hundreds of shapes you never asked for.
          const mid = el.geometry[0];
          if (!this.map.getBounds().pad(0.15).contains([mid.lat, mid.lon])) continue;
          // The Atlas has already given this footprint a fantasy name; borrow
          // it, so an imported building arrives called The Gilded Ledger
          // rather than "Building".
          const named = Atlas.nearestBuilding(mid.lat, mid.lon, 40);
          const s = Shapes.fromOsmWay(el, (named && named.row && named.row.name) || tags.name || "");
          if (!s) continue;
          // Bins, bike shelters and mapping noise. Nothing you would draw a
          // fantasy building over is two metres across.
          if (Shapes.sizeM(s) < 6) continue;
          Shapes.save(s);
          already[osmId] = 1;
          made++;
        }
        if (made >= 60) break;
      }
      this.renderAll();
      if (!made && waited) {
        this.toast("No map data here yet, and the map service is being rested. Try again shortly.", "bad", 5000);
      } else if (!made) {
        this.toast("Nothing new to import in this view — everything here is already in.", "info", 4000);
      } else {
        this.toast("Imported " + made + " footprint" + (made === 1 ? "" : "s") +
                   " from " + surveyed + " cell" + (surveyed === 1 ? "" : "s") + ".", "good", 4000);
      }
    } catch (e) {
      this.toast("Import failed: " + (e && e.message), "bad", 5000);
    } finally {
      this.busy = false;
    }
  },

  /* ----------------------------------------------------------------- files */

  fileMenu() {
    const st = Shapes.stats();
    const wrap = el("div", "seFile");
    wrap.innerHTML =
      "<p class='tiny dim'>Shapes live in their own table and their own file. " +
      "Export gives you one document to keep, upload, or drop into " +
      "<b>data/shapes.json</b> so every install starts with it.</p>" +
      '<div class="kv"><span>Shapes</span><b>' + st.shapes + "</b></div>" +
      '<div class="kv"><span>Size</span><b>' + (st.bytes / 1024).toFixed(1) + " KB</b></div>";
    const acts = el("div");
    acts.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-top:14px";
    const mk = (label, cls, fn) => {
      const b = el("button", "btn block " + cls, label); b.onclick = fn; acts.appendChild(b);
    };
    mk("Download shapes.json", "primary", () => { this.download(); });
    mk("Import a file (merge)", "ghost", () => this.upload(false));
    mk("Import a file (replace everything)", "danger", () => this.upload(true));
    wrap.appendChild(acts);
    this.modal("Shapes file", wrap);
  },

  download() {
    const doc = Shapes.export();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "shapes.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    this.toast("shapes.json saved.", "good");
  },

  upload(replace) {
    const inp = el("input");
    inp.type = "file"; inp.accept = "application/json,.json";
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const r = Shapes.import(JSON.parse(rd.result), replace);
          if (!r.success) { this.toast(r.message, "bad", 4000); return; }
          this.select(null);
          this.renderAll();
          this.toast(r.added + " added, " + r.updated + " updated.", "good", 4000);
        } catch (e) {
          this.toast("That file would not parse as JSON.", "bad", 4000);
        }
      };
      rd.readAsText(f);
    };
    inp.click();
  },

  /* ------------------------------------------------------------------ bits */

  jumpTo() {
    const q = $("#seSearch").value.trim();
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
    if (!m) { this.toast("Give it a \"lat, lng\" pair.", "bad"); return; }
    this.map.setView([+m[1], +m[2]], 19);
    this.renderTable();
  },

  renderStatus() {
    const st = Shapes.stats();
    const c = this.map.getCenter();
    $("#seStatus").innerHTML =
      "<span><b>" + st.shapes + "</b> shapes</span>" +
      "<span><b>" + st.polygons + "</b> buildings</span>" +
      "<span><b>" + st.lines + "</b> lines</span>" +
      (st.hidden ? "<span><b>" + st.hidden + "</b> hidden</span>" : "") +
      "<span><b>" + (st.bytes / 1024).toFixed(1) + "</b> KB</span>" +
      '<span class="spacer"></span>' +
      "<span>" + c.lat.toFixed(5) + ", " + c.lng.toFixed(5) + " · z" + this.map.getZoom() + "</span>";
  },

  renderAll() {
    this.renderShapes();
    this.renderHandles();
    this.renderTable();
    this.renderForm();
    this.renderStatus();
  },

  modal(title, bodyEl) {
    const back = el("div", "modalBack");
    const box = el("div", "modalBox");
    box.innerHTML = '<div class="modalHead"><h3>' + esc(title) + "</h3></div>";
    const body = el("div", "modalBody");
    body.appendChild(bodyEl);
    box.appendChild(body);
    const foot = el("div", "modalFoot");
    const close = el("button", "btn ghost", "Close");
    close.onclick = () => back.remove();
    foot.appendChild(close);
    box.appendChild(foot);
    back.appendChild(box);
    back.onclick = (e) => { if (e.target === back) back.remove(); };
    document.body.appendChild(back);
    return back;
  },

  toast(msg, kind, ms) {
    let host = $("#toasts");
    if (!host) { host = el("div"); host.id = "toasts"; document.body.appendChild(host); }
    const t = el("div", "toast " + (kind || ""), esc(msg));
    host.appendChild(t);
    while (host.children.length > 3) host.removeChild(host.firstChild);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0";
      setTimeout(() => t.remove(), 320); }, ms || 2600);
  }
};

window.SE = { Se, Shapes, Denizens, Haunts, Store, Content, Atlas, Chunks, Grid, OSM, DB, K,
              haversine, projectPoint };
document.addEventListener("DOMContentLoaded", () => Se.init());
