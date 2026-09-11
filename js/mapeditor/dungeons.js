/* ==========================================================================
   THE DUNGEON LAYER

   Locations are points; dungeons are areas. This module owns the second layer
   of the map editor: drawing a dungeon's footprint, dragging and resizing it,
   and authoring the floors behind it.

   Only two shapes, deliberately. A circle is a centre and a radius; a
   rectangle is a centre and a width and height in metres, axis-aligned. Both
   resize from a single handle, which is the most you can ask of a thumb, and
   both have a containment test you can hold in your head — which matters,
   because that test is what decides whether the door opens.
   ========================================================================== */
const Md = {
  selected: null,
  draft: null,
  isNew: false,
  layer: null,
  shapes: {},
  handles: [],
  sort: { col: "name", dir: 1 },
  openFloor: 0,

  all() {
    if (!Me.zone) return [];
    return Content.list("dungeons").filter(d => d.zoneId === Me.zone.zoneId);
  },
  active() { return Me.mode === "dungeons"; },

  /* ------------------------------------------------------------- drawing */
  draw() {
    if (!this.layer) this.layer = L.layerGroup().addTo(Me.map);
    this.layer.clearLayers();
    this.shapes = {}; this.handles = []; this.handle = null;
    const editing = this.active();

    this.all().forEach(d => {
      const kind = Content.dungeonKind(d.kind);
      const sel = editing && this.selected === d.dungeonId;
      const style = {
        color: sel ? "#e0a33e" : kind.color,
        weight: sel ? 3 : 2,
        opacity: editing ? (sel ? .95 : .6) : .3,
        fillColor: sel ? "#e0a33e" : kind.color,
        fillOpacity: editing ? (sel ? .16 : .08) : .04,
        dashArray: d.active === false ? "5 6" : null,
        interactive: editing
      };
      const shape = d.shape === "rect"
        ? L.rectangle(Content.dungeonCorners(d), style)
        : L.circle([d.latitude, d.longitude], Object.assign({ radius: +d.radius || 40 }, style));
      if (editing) shape.on("click", (e) => {
        if (Me.placing) { L.DomEvent.stop(e); Me.placeAt(e.latlng.lat, e.latlng.lng); return; }
        this.select(d.dungeonId);
      });
      this.layer.addLayer(shape);
      this.shapes[d.dungeonId] = shape;

      // The centre marker is the door: it drags the whole footprint.
      const pin = L.marker([d.latitude, d.longitude], {
        draggable: editing,
        icon: L.divIcon({ className: "pinWrap",
          html: '<div class="dgnPin' + (sel ? " sel" : "") + (d.active === false ? " off" : "") +
                '" data-dungeon="' + d.dungeonId + '">' + kind.icon +
                '<span class="d">' + (d.floors || []).length + "</span></div>",
          iconSize: [36, 36], iconAnchor: [18, 18] })
      });
      pin.bindTooltip(esc(d.name || "(unnamed dungeon)") + " · " + (d.floors || []).length + " floors",
                      { direction: "top", offset: [0, -12] });
      if (editing) {
        pin.on("click", (e) => {
          if (Me.placing) { L.DomEvent.stop(e); Me.placeAt(e.latlng.lat, e.latlng.lng); return; }
          this.select(d.dungeonId);
        });
        pin.on("drag", () => this.reshape(d, pin.getLatLng(), shape));
        pin.on("dragend", () => {
          const p = pin.getLatLng();
          const row = Content.get("dungeons", d.dungeonId);
          row.latitude = p.lat; row.longitude = p.lng;
          Content.save("dungeons", row);
          if (this.selected === d.dungeonId && this.draft) {
            this.draft.latitude = p.lat; this.draft.longitude = p.lng;
            this.renderForm();
          }
          this.draw(); Me.renderTable();
          Me.toast("Moved to " + p.lat.toFixed(5) + ", " + p.lng.toFixed(5));
        });
      }
      this.layer.addLayer(pin);
      if (sel) this.addResizeHandle(d, shape);
    });
  },

  /** Move a footprint to follow its centre while it is being dragged. */
  reshape(d, centre, shape) {
    if (d.shape === "rect") {
      shape.setBounds(Content.dungeonCorners({ latitude: centre.lat, longitude: centre.lng,
                                             width: d.width, height: d.height }));
    } else {
      shape.setLatLng(centre);
    }
  },

  /** Where the handle belongs for the dungeon's current size. */
  handleAt(d) {
    if (d.shape === "rect") { const c = Content.dungeonCorners(d); return [c[1][0], c[1][1]]; }
    const p = projectPoint(d.latitude, d.longitude, Math.max(5, +d.radius || 40), 90);
    return [p.latitude, p.longitude];
  },
  /** Keep the handle on the edge when the size changed from the form. */
  placeHandle(d) {
    if (this.handle) this.handle.setLatLng(this.handleAt(d));
  },

  /**
   * One handle does the dragging: the east edge for a circle, the north-east
   * corner for a rectangle. Everything is computed in metres, so a box stays
   * the size it says it is however far north you drag it. On touch the
   * sliders in the form are the better route — this is the mouse one.
   */
  addResizeHandle(d, shape) {
    const isRect = d.shape === "rect";
    const at = this.handleAt(d);

    const h = L.marker(at, {
      draggable: true, zIndexOffset: 900,
      icon: L.divIcon({ className: "pinWrap",
        html: '<div class="dgnHandle" title="Drag to resize"></div>',
        iconSize: [18, 18], iconAnchor: [9, 9] })
    });
    const apply = (p, commit) => {
      if (isRect) {
        const w = Math.max(5, Math.round(haversine(d.latitude, d.longitude, d.latitude, p.lng) * 2));
        const ht = Math.max(5, Math.round(haversine(d.latitude, d.longitude, p.lat, d.longitude) * 2));
        d.width = w; d.height = ht;
        shape.setBounds(Content.dungeonCorners(d));
      } else {
        d.radius = Math.max(5, Math.round(haversine(d.latitude, d.longitude, p.lat, p.lng)));
        shape.setRadius(d.radius);
      }
      if (this.draft && this.draft.dungeonId === d.dungeonId) {
        this.draft.width = d.width; this.draft.height = d.height; this.draft.radius = d.radius;
      }
      if (commit) {
        const row = Content.get("dungeons", d.dungeonId);
        row.width = d.width; row.height = d.height; row.radius = d.radius;
        Content.save("dungeons", row);
        this.renderForm(); Me.renderTable();
        Me.toast(isRect ? "Resized to " + d.width + " × " + d.height + " m" : "Radius " + d.radius + " m");
      } else {
        this.liveSize(d);
      }
    };
    h.on("drag", () => apply(h.getLatLng(), false));
    h.on("dragend", () => { apply(h.getLatLng(), true); this.draw(); });
    this.layer.addLayer(h);
    this.handle = h;
    this.handles.push(h);
  },

  /** Keep the form's sliders and boxes honest while a handle is dragged. */
  liveSize(d) {
    ["radius", "width", "height"].forEach(k => {
      const num = $("#f_" + k), rg = $("#rg_" + k), out = $("#sz_" + k);
      if (num) num.value = d[k];
      if (rg) rg.value = d[k];
      if (out) out.textContent = d[k];
    });
  },

  /* -------------------------------------------------------------- placing */
  placeAt(lat, lng) {
    if (!Me.zone) { Me.toast("Make a zone first.", "bad"); return; }
    const d = Content.blankDungeon(lat, lng, Me.zone.zoneId);
    d.name = "New dungeon";
    // Saved straight away, exactly like a location. A draft that only exists
    // in the form is lost the moment you switch panes to look at the map,
    // which on a phone is the very next thing you do.
    const saved = Content.save("dungeons", d);
    this.selected = saved.dungeonId;
    this.draft = JSON.parse(JSON.stringify(saved));
    this.isNew = false;
    this.openFloor = 0;
    Me.renderAll();
    if (Me.compact()) Me.setPane("form");
  },

  /* ---------------------------------------------------------------- table */
  renderTable() {
    const wrap = $("#meTableWrap");
    const rows = this.all().slice();
    const s = this.sort;
    const val = (d, c) => c === "name" ? (d.name || "").toLowerCase()
      : c === "kind" ? d.kind
      : c === "floors" ? (d.floors || []).length
      : c === "size" ? (d.shape === "rect" ? d.width * d.height : Math.PI * d.radius * d.radius)
      : c === "walk" ? Content.dungeonLength(d)
      : c === "level" ? (+d.minLevel || 1) : "";
    rows.sort((a, b) => {
      const x = val(a, s.col), y = val(b, s.col);
      return (x > y ? 1 : x < y ? -1 : 0) * s.dir;
    });

    wrap.innerHTML = !rows.length
      ? '<div class="emptyMsg">No dungeons in this zone yet. Hit <b>+ Place dungeon</b> and click the map.</div>'
      : '<table class="grid"><thead><tr>' +
          Me.th("name", "Name") + Me.th("kind", "Kind") + Me.th("floors", "Floors") +
          Me.th("walk", "Walk") + Me.th("size", "Footprint") + Me.th("level", "Lvl") +
          "<th>Open</th></tr></thead><tbody>" +
        rows.map(d => {
          const k = Content.dungeonKind(d.kind);
          const size = d.shape === "rect" ? d.width + " × " + d.height + " m" : "r " + d.radius + " m";
          return '<tr data-id="' + d.dungeonId + '"' +
            (this.selected === d.dungeonId ? ' class="sel"' : "") + ">" +
            '<td data-l="Name"><b>' + esc(d.name || "(unnamed)") + "</b>" +
              (d.origin === "auto" ? ' <span class="autoTag" title="Placed by the spawner; it will be cleared when it expires">auto</span>' : "") +
              "</td>" +
            '<td data-l="Kind">' + k.icon + " " + esc(k.label) + "</td>" +
            '<td data-l="Floors">' + (d.floors || []).length + "</td>" +
            '<td data-l="Walk">' + fmtDist(Content.dungeonLength(d)) + "</td>" +
            '<td data-l="Footprint">' + esc(size) + "</td>" +
            '<td data-l="Lvl">' + (+d.minLevel || 1) + "</td>" +
            '<td data-l="Open">' + (d.active === false ? "—" : "yes") + "</td>" +
            "</tr>";
        }).join("") + "</tbody></table>";

    wrap.querySelectorAll("th[data-sort]").forEach(th => {
      th.onclick = () => {
        const c = th.dataset.sort;
        this.sort = { col: c, dir: this.sort.col === c ? -this.sort.dir : 1 };
        this.renderTable();
      };
    });
    wrap.querySelectorAll("tbody tr").forEach(tr => {
      tr.onclick = () => this.select(tr.dataset.id);
    });
  },

  /* --------------------------------------------------------------- record */
  select(id) {
    this.selected = id;
    this.isNew = false;
    this.openFloor = 0;
    const row = Content.get("dungeons", id);
    this.draft = row ? JSON.parse(JSON.stringify(row)) : null;
    if (this.draft && !this.draft.floors) this.draft.floors = [];
    this.draw();
    this.renderTable();
    this.renderForm();
    if (Me.compact() && this.draft) Me.setPane("form");
  },

  validate(d) {
    if (!d.name || !d.name.trim()) return "Give it a name.";
    if (d.shape === "rect") {
      if (!(+d.width >= 5) || !(+d.height >= 5)) return "A rectangle must be at least 5 m on each side.";
    } else if (!(+d.radius >= 5)) return "Radius must be at least 5 m.";
    if (!(d.floors || []).length) return "A dungeon needs at least one floor.";
    const badFloor = (d.floors || []).findIndex(f => !(+f.lengthMeters >= 20));
    if (badFloor >= 0) return "Floor " + (badFloor + 1) + " must be at least 20 m long.";
    const bad = ["timeStart", "timeEnd"].find(k => d[k] && Content.minutesOf(d[k]) == null);
    if (bad) return "Times must look like 09:00.";
    if ((d.timeStart && !d.timeEnd) || (d.timeEnd && !d.timeStart)) return "Set both ends of the window, or neither.";
    return null;
  },

  save() {
    const d = this.draft;
    const problem = this.validate(d);
    if (problem) { const e = $("#meErr"); if (e) e.textContent = problem; return; }
    (d.floors || []).forEach((f, i) => { f.level = i + 1; });
    const saved = Content.save("dungeons", d);
    this.selected = saved.dungeonId;
    this.draft = JSON.parse(JSON.stringify(saved));
    this.isNew = false;
    const compact = Me.compact();
    Me.renderAll();
    if (compact) Me.setPane("map");
    Me.toast("Saved " + (saved.name || "dungeon") + ".", "good");
  },

  duplicate() {
    const d = JSON.parse(JSON.stringify(this.draft));
    d.dungeonId = "";
    d.name = (d.name || "") + " (copy)";
    d.latitude += 0.0004; d.longitude += 0.0005;
    const saved = Content.save("dungeons", d);
    this.selected = saved.dungeonId;
    this.draft = JSON.parse(JSON.stringify(saved));
    Me.renderAll();
    Me.toast("Duplicated.");
  },

  del() {
    const name = (this.draft && this.draft.name) || "this dungeon";
    if (!confirm("Delete " + name + "? This cannot be undone.")) return;
    Content.remove("dungeons", this.selected);
    this.selected = null; this.draft = null;
    Me.renderAll();
    if (Me.compact()) Me.setPane("list");
    Me.toast("Deleted.", "bad");
  },

  /* ----------------------------------------------------------------- floors */
  addFloor() {
    const f = Content.blankFloor((this.draft.floors || []).length + 1);
    const last = (this.draft.floors || [])[this.draft.floors.length - 1];
    if (last) {
      // A new floor inherits the one above it: nobody wants to retype a spawn
      // table five times, and they get harder rather than resetting to easy.
      Object.assign(f, {
        spawnTableId: last.spawnTableId, chestLootTableId: last.chestLootTableId,
        chestTier: last.chestTier, lengthMeters: last.lengthMeters,
        encounters: last.encounters, chests: last.chests,
        difficulty: Math.min(10, (+last.difficulty || 3) + 1)
      });
    }
    this.draft.floors.push(f);
    this.openFloor = this.draft.floors.length - 1;
    this.renderForm();
  },
  removeFloor(i) {
    this.draft.floors.splice(i, 1);
    this.openFloor = Math.max(0, Math.min(this.openFloor, this.draft.floors.length - 1));
    this.renderForm();
  },
  moveFloor(i, dir) {
    const f = this.draft.floors;
    const j = i + dir;
    if (j < 0 || j >= f.length) return;
    const t = f[i]; f[i] = f[j]; f[j] = t;
    this.openFloor = j;
    this.renderForm();
  }
};

/* ==========================================================================
   THE DUNGEON FORM
   ========================================================================== */
Object.assign(Md, {
  bind: Me.bind, int: Me.int, fld: Me.fld, sel: Me.sel,

  /** Same as bind, but the target is one floor inside the draft. */
  bindFloor(id, i, key, cast, after) {
    const n = $("#" + id);
    if (!n) return;
    n.addEventListener(n.type === "checkbox" || n.tagName === "SELECT" ? "change" : "input", () => {
      this.draft.floors[i][key] = cast ? cast(n.type === "checkbox" ? n.checked : n.value)
                                       : (n.type === "checkbox" ? n.checked : n.value);
      if (after) after();
    });
  },

  /**
   * A slider and a number box for one footprint dimension. Dragging an 18px
   * handle on a map is a mouse gesture; a slider is what a thumb wants, and
   * the box is what someone who knows the number wants.
   */
  sizeRow(key, label, value) {
    const v = Math.max(5, +value || 5);
    return '<label class="f"><span>' + label + ' — <b id="sz_' + key + '">' + v + "</b> m</span>" +
      '<div class="radiusRow">' +
        '<input type="range" id="rg_' + key + '" min="5" max="400" step="5" value="' + v + '">' +
        '<input class="input" id="f_' + key + '" type="number" min="5" value="' + v + '">' +
      "</div></label>";
  },

  wireSize(key) {
    const range = $("#rg_" + key), num = $("#f_" + key), out = $("#sz_" + key);
    if (!range || !num) return;
    const set = (raw) => {
      const v = Math.max(5, this.int(raw));
      this.draft[key] = v;
      if (out) out.textContent = v;
      if (range.value != v) range.value = v;
      if (num.value != v) num.value = v;
      this.resizeLive();
    };
    range.oninput = () => set(range.value);
    num.oninput = () => set(num.value);
  },

  /** Reshape the drawn footprint in place — redrawing would drop the handle. */
  resizeLive() {
    const d = this.draft;
    const shape = this.shapes[d.dungeonId];
    if (!shape) { this.draw(); return; }
    if (d.shape === "rect") shape.setBounds(Content.dungeonCorners(d));
    else shape.setRadius(Math.max(5, +d.radius || 5));
    this.placeHandle(d);
    Me.renderTable();
  },

  spawnOptions() {
    return [{ value: "", label: "— none —" }].concat(
      Content.list("spawns").map(s => ({ value: s.spawnTableId, label: s.name || s.spawnTableId })));
  },
  lootOptions() {
    return [{ value: "", label: "— none —" }].concat(
      Content.list("loot").map(l => ({ value: l.lootTableId, label: l.name || l.lootTableId })));
  },

  renderForm() {
    const host = $("#meForm");
    if (!this.draft) {
      host.innerHTML = '<div class="emptyForm">' +
        (Me.zone
          ? "Pick a dungeon, or hit <b>+ Place dungeon</b> and click the map to draw one."
          : "No zone yet — make one on the Locations tab first.") + "</div>";
      return;
    }
    const d = this.draft;
    const kind = Content.dungeonKind(d.kind);
    const rect = d.shape === "rect";

    host.innerHTML =
      '<div class="formHead">' +
        '<button class="backBtn" id="meBack" aria-label="Back to the list">‹</button>' +
        "<h3>" + kind.icon + " " + esc(d.name || "New dungeon") + "</h3>" +
      "</div>" +
      '<div class="err" id="meErr"></div>' +

      this.fld("f_name", "Name", d.name) +
      '<div class="row2">' +
        this.sel("f_kind", "Kind", d.kind,
          Object.keys(Content.DUNGEON_KINDS).map(k => ({ value: k, label: Content.DUNGEON_KINDS[k].label }))) +
        this.sel("f_shape", "Shape", d.shape, Content.DUNGEON_SHAPES.map(s => ({ value: s.key, label: s.label }))) +
      "</div>" +

      '<div class="sect">Footprint</div>' +
      (rect
        ? this.sizeRow("width", "Width — east to west", d.width) +
          this.sizeRow("height", "Height — north to south", d.height)
        : this.sizeRow("radius", "Radius", d.radius)) +
      '<div class="row2">' +
        this.fld("f_latitude", "Latitude", (+d.latitude).toFixed(6)) +
        this.fld("f_longitude", "Longitude", (+d.longitude).toFixed(6)) +
      "</div>" +
      '<div class="row2">' +
        this.fld("f_entryRange", "Entry range (m)", d.entryRange, { type: "number", min: 5 }) +
        this.fld("f_minLevel", "Min level", d.minLevel, { type: "number", min: 1 }) +
      "</div>" +
      '<p class="tiny dimmer" style="margin:-4px 0 12px">Resize with the sliders, or drag the gold ' +
        "square on the map. The door opens within the entry range of the <b>edge</b>, not the centre.</p>" +

      '<div class="sect">Floors <span class="tiny dimmer">— ' +
        fmtDist(Content.dungeonLength(d)) + " of walking in total</span></div>" +
      '<div id="flList">' + this.floorsUi() + "</div>" +
      '<button class="btn sm ghost block" id="flAdd">+ Add a floor below</button>' +

      '<div class="sect">When it is open</div>' +
      '<div class="row2">' +
        this.fld("f_timeStart", "Opens", d.timeStart, { placeholder: "09:00" }) +
        this.fld("f_timeEnd", "Closes", d.timeEnd, { placeholder: "17:00" }) +
      "</div>" +
      '<div id="dvDays"></div>' +
      this.fld("f_respawnMinutes", "Reopens after (minutes, 0 = never)", d.respawnMinutes, { type: "number", min: 0 }) +
      '<label class="check"><input type="checkbox" id="f_active"' + (d.active === false ? "" : " checked") +
        "> <span>Available</span></label>" +
      '<label class="f"><span>Notes</span><textarea class="input" id="f_notes" rows="2">' +
        esc(d.notes || "") + "</textarea></label>" +

      '<div class="formActions">' +
        '<button class="btn danger sm" id="meDel"' + (this.isNew ? " disabled" : "") + ">Delete</button>" +
        '<button class="btn ghost sm" id="meDup"' + (this.isNew ? " disabled" : "") + ">Duplicate</button>" +
        '<div class="spacer"></div>' +
        '<button class="btn primary" id="meSave">Save</button>' +
      "</div>";

    const redrawShape = () => { this.draw(); this.renderForm(); };
    this.bind("f_name", "name", null, () => Me.renderTable());
    this.bind("f_kind", "kind", null, () => redrawShape());
    this.bind("f_shape", "shape", null, () => redrawShape());
    if (rect) { this.wireSize("width"); this.wireSize("height"); }
    else this.wireSize("radius");
    this.bind("f_latitude", "latitude", parseFloat, () => this.draw());
    this.bind("f_longitude", "longitude", parseFloat, () => this.draw());
    this.bind("f_entryRange", "entryRange", this.int);
    this.bind("f_minLevel", "minLevel", this.int);
    this.bind("f_timeStart", "timeStart");
    this.bind("f_timeEnd", "timeEnd");
    this.bind("f_respawnMinutes", "respawnMinutes", this.int);
    this.bind("f_active", "active", null, () => this.draw());
    this.bind("f_notes", "notes");

    this.renderDays();
    this.wireFloors();
    $("#flAdd").onclick = () => this.addFloor();
    $("#meSave").onclick = () => this.save();
    $("#meDel").onclick = () => this.del();
    $("#meDup").onclick = () => this.duplicate();
    const back = $("#meBack");
    if (back) back.onclick = () => Me.setPane("list");
  },

  renderDays() {
    const host = $("#dvDays");
    if (!host) return;
    const days = this.draft.days || [];
    host.innerHTML = '<label class="f"><span>Days ' +
      (days.length ? "" : "— every day") + "</span><div class='dayRow'>" +
      Content.DAY_NAMES.map((n, i) => '<button type="button" class="dayBtn' +
        (days.indexOf(i) >= 0 ? " on" : "") + '" data-d="' + i + '">' + n + "</button>").join("") +
      "</div></label>";
    host.querySelectorAll(".dayBtn").forEach(b => {
      b.onclick = () => {
        const i = +b.dataset.d;
        const list = this.draft.days || (this.draft.days = []);
        const at = list.indexOf(i);
        if (at >= 0) list.splice(at, 1); else list.push(i);
        list.sort();
        this.renderDays();
      };
    });
  },

  /**
   * One block per floor, only the open one expanded. A dungeon with six
   * floors is otherwise a wall of forty identical inputs.
   */
  floorsUi() {
    const d = this.draft;
    const spawns = this.spawnOptions(), loot = this.lootOptions();
    return (d.floors || []).map((f, i) => {
      const open = i === this.openFloor;
      const plan = Content.planFloor(d, i, "preview");
      const summary = plan.filter(s => s.kind === "fight").length + " fights · " +
        plan.filter(s => s.kind === "chest").length + " chests" + (f.hasBoss ? " · boss" : "");
      return '<div class="floorBox' + (open ? " open" : "") + '">' +
        '<div class="floorHead" data-open="' + i + '">' +
          '<b>' + esc(Content.floorName(d, f, i)) + "</b>" +
          '<span class="tiny dimmer">' + fmtDist(+f.lengthMeters || 0) + " · " + summary + "</span>" +
          '<div class="spacer"></div>' +
          '<button type="button" class="btn sm ghost" data-up="' + i + '" title="Move up"' +
            (i === 0 ? " disabled" : "") + ">↑</button>" +
          '<button type="button" class="btn sm ghost" data-down="' + i + '" title="Move down"' +
            (i === d.floors.length - 1 ? " disabled" : "") + ">↓</button>" +
          '<button type="button" class="btn sm danger" data-rm="' + i + '" title="Remove"' +
            (d.floors.length < 2 ? " disabled" : "") + ">✕</button>" +
        "</div>" +
        (open ? '<div class="floorBody">' +
          this.fld("fl_name_" + i, "Floor name (blank = " + esc(Content.floorName(d, {}, i)) + ")", f.name) +
          '<div class="row2">' +
            this.fld("fl_len_" + i, "Walk to the stairs (m)", f.lengthMeters, { type: "number", min: 20 }) +
            this.fld("fl_diff_" + i, "Difficulty 1–10", f.difficulty, { type: "number", min: 1 }) +
          "</div>" +
          '<div class="row2">' +
            this.fld("fl_enc_" + i, "Fights", f.encounters, { type: "number", min: 0 }) +
            this.fld("fl_chests_" + i, "Chests", f.chests, { type: "number", min: 0 }) +
          "</div>" +
          this.sel("fl_spawn_" + i, "Monsters here", f.spawnTableId, spawns) +
          '<div class="row2">' +
            this.sel("fl_tier_" + i, "Chest tier", f.chestTier,
              Content.CHEST_TIERS.filter(c => c.key).map(c => ({ value: c.key, label: c.label }))) +
            this.sel("fl_loot_" + i, "Chest loot", f.chestLootTableId, loot) +
          "</div>" +
          '<label class="check"><input type="checkbox" id="fl_boss_' + i + '"' + (f.hasBoss ? " checked" : "") +
            "> <span>Something waits at the bottom of this floor</span></label>" +
          (f.hasBoss ? this.sel("fl_bspawn_" + i, "Boss spawn table", f.bossSpawnTableId, spawns) : "") +
          '<div class="row2">' +
            this.fld("fl_xp_" + i, "XP for clearing (0 = auto)", f.experience, { type: "number", min: 0 }) +
            this.fld("fl_gold_" + i, "Gold for clearing (0 = auto)", f.gold, { type: "number", min: 0 }) +
          "</div>" +
        "</div>" : "") +
      "</div>";
    }).join("");
  },

  wireFloors() {
    const host = $("#flList");
    if (!host) return;
    host.querySelectorAll("[data-open]").forEach(h => {
      h.onclick = (e) => {
        if (e.target.closest("button[data-up],button[data-down],button[data-rm]")) return;
        const i = +h.dataset.open;
        this.openFloor = this.openFloor === i ? -1 : i;
        this.renderForm();
      };
    });
    host.querySelectorAll("[data-up]").forEach(b => { b.onclick = () => this.moveFloor(+b.dataset.up, -1); });
    host.querySelectorAll("[data-down]").forEach(b => { b.onclick = () => this.moveFloor(+b.dataset.down, 1); });
    host.querySelectorAll("[data-rm]").forEach(b => { b.onclick = () => this.removeFloor(+b.dataset.rm); });

    const i = this.openFloor;
    if (i < 0 || !this.draft.floors[i]) return;
    const head = () => { this.renderTable(); };
    this.bindFloor("fl_name_" + i, i, "name");
    this.bindFloor("fl_len_" + i, i, "lengthMeters", this.int, head);
    this.bindFloor("fl_diff_" + i, i, "difficulty", this.int);
    this.bindFloor("fl_enc_" + i, i, "encounters", this.int);
    this.bindFloor("fl_chests_" + i, i, "chests", this.int);
    this.bindFloor("fl_spawn_" + i, i, "spawnTableId");
    this.bindFloor("fl_tier_" + i, i, "chestTier");
    this.bindFloor("fl_loot_" + i, i, "chestLootTableId");
    this.bindFloor("fl_boss_" + i, i, "hasBoss", null, () => this.renderForm());
    this.bindFloor("fl_bspawn_" + i, i, "bossSpawnTableId");
    this.bindFloor("fl_xp_" + i, i, "experience", this.int);
    this.bindFloor("fl_gold_" + i, i, "gold", this.int);
  },

  renderTable_() {}
});

/* Boot lives at the end of 04-instances.js, the last part in the bundle:
   Me.init() renders every layer, so it cannot run before they all exist. */
