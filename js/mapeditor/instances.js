/* ==========================================================================
   THE INSTANCE LAYER

   Instances are doors. On the real map an instance is a point with a radius,
   exactly like a location — walk into the circle and you can go in. Everything
   interesting is behind the door, on a floor plan that has nothing to do with
   these coordinates, so there is no footprint to draw and nothing to resize.

   What there is to author is the levels. A level is one open rectangle - you
   type its width and height in metres - plus the walls you draw into it. The
   preview under each level shows the floor exactly as it will be, with one
   roll of where the monsters and chests stand.
   ========================================================================== */
const Mi = {
  selected: null,
  draft: null,
  isNew: false,
  layer: null,
  markers: {},
  sort: { col: "name", dir: 1 },
  openLevel: 0,

  all() {
    if (!Me.zone) return [];
    return Content.list("instances").filter(d => d.zoneId === Me.zone.zoneId);
  },
  active() { return Me.mode === "instances"; },

  /* ------------------------------------------------------------- drawing */
  draw() {
    if (!this.layer) this.layer = L.layerGroup().addTo(Me.map);
    this.layer.clearLayers();
    this.markers = {};
    const editing = this.active();

    this.all().forEach(d => {
      const kind = Content.instanceKind(d.kind);
      const sel = editing && this.selected === d.instanceId;
      this.layer.addLayer(L.circle([d.latitude, d.longitude], {
        radius: +d.radius || 30,
        color: sel ? "#e0a33e" : kind.color,
        weight: sel ? 2.5 : 1.5,
        opacity: editing ? (sel ? .95 : .55) : .25,
        fillColor: sel ? "#e0a33e" : kind.color,
        fillOpacity: editing ? (sel ? .14 : .07) : .03,
        dashArray: d.active === false ? "5 6" : null,
        interactive: false
      }));

      const pin = L.marker([d.latitude, d.longitude], {
        draggable: editing,
        icon: L.divIcon({ className: "pinWrap",
          html: '<div class="instMark' + (sel ? " sel" : "") + (d.active === false ? " off" : "") +
                '" data-inst="' + d.instanceId + '">' + kind.icon +
                '<span class="d">' + (d.levels || []).length + "</span></div>",
          iconSize: [36, 36], iconAnchor: [18, 18] })
      });
      pin.bindTooltip(esc(d.name || "(unnamed instance)") + " · " + (d.levels || []).length + " levels",
                      { direction: "top", offset: [0, -12] });
      if (editing) {
        pin.on("click", (e) => {
          if (Me.placing) { L.DomEvent.stop(e); Me.placeAt(e.latlng.lat, e.latlng.lng); return; }
          this.select(d.instanceId);
        });
        pin.on("dragend", () => {
          const p = pin.getLatLng();
          const row = Content.get("instances", d.instanceId);
          row.latitude = p.lat; row.longitude = p.lng;
          Content.save("instances", row);
          if (this.selected === d.instanceId && this.draft) {
            this.draft.latitude = p.lat; this.draft.longitude = p.lng;
            this.renderForm();
          }
          this.draw(); Me.renderTable();
          Me.toast("Door moved to " + p.lat.toFixed(5) + ", " + p.lng.toFixed(5));
        });
      }
      this.layer.addLayer(pin);
      this.markers[d.instanceId] = pin;
    });
  },

  /* -------------------------------------------------------------- placing */
  placeAt(lat, lng) {
    if (!Me.zone) { Me.toast("Make a zone first.", "bad"); return; }
    const d = Content.blankInstance(lat, lng, Me.zone.zoneId);
    d.name = "New instance";
    // Saved on place, like a location — a form-only draft dies the moment you
    // switch panes to look at what you just put down.
    const saved = Content.save("instances", d);
    this.selected = saved.instanceId;
    this.draft = JSON.parse(JSON.stringify(saved));
    this.isNew = false;
    this.openLevel = 0;
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
      : c === "levels" ? (d.levels || []).length
      : c === "size" ? (d.levels || []).reduce((a, l) => a + (+l.width || 0) * (+l.height || 0), 0)
      : c === "foes" ? (d.levels || []).reduce((a, l) => a + (+l.monsters || 0) + (l.hasBoss ? 1 : 0), 0)
      : c === "level" ? (+d.minLevel || 1) : "";
    rows.sort((a, b) => {
      const x = val(a, s.col), y = val(b, s.col);
      return (x > y ? 1 : x < y ? -1 : 0) * s.dir;
    });

    wrap.innerHTML = !rows.length
      ? '<div class="emptyMsg">No instances in this zone yet. Hit <b>+ Instance</b> and tap the map.</div>'
      : '<table class="grid"><thead><tr>' +
          Me.th("name", "Name") + Me.th("kind", "Kind") + Me.th("levels", "Levels") +
          Me.th("size", "Floor") + Me.th("foes", "Monsters") + Me.th("level", "Lvl") +
          "<th>Open</th></tr></thead><tbody>" +
        rows.map(d => {
          const k = Content.instanceKind(d.kind);
          return '<tr data-id="' + d.instanceId + '"' +
            (this.selected === d.instanceId ? ' class="on"' : "") + ">" +
            '<td data-l="Name"><b>' + esc(d.name || "(unnamed)") + "</b>" +
              (d.origin === "auto" ? ' <span class="autoTag" title="Placed by the spawner; it will be cleared when it expires">auto</span>' : "") +
              "</td>" +
            '<td data-l="Kind">' + k.icon + " " + esc(k.label) + "</td>" +
            '<td data-l="Levels">' + (d.levels || []).length + "</td>" +
            '<td data-l="Floor">' + Math.round(val(d, "size")) + " m²</td>" +
            '<td data-l="Monsters">' + val(d, "foes") + "</td>" +
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
    this.openLevel = 0;
    const row = Content.get("instances", id);
    this.draft = row ? JSON.parse(JSON.stringify(row)) : null;
    if (this.draft && !this.draft.levels) this.draft.levels = [];
    this.draw();
    this.renderTable();
    this.renderForm();
    if (Me.compact() && this.draft) Me.setPane("form");
  },

  validate(d) {
    if (!d.name || !d.name.trim()) return "Give it a name.";
    if (!(+d.radius >= 5)) return "The door radius must be at least 5 m.";
    if (!(d.levels || []).length) return "An instance needs at least one level.";
    const bad = (d.levels || []).findIndex(l => !(+l.width >= 8) || !(+l.height >= 8));
    if (bad >= 0) return "Level " + (bad + 1) + " needs a floor at least 8 m on each side.";
    const t = ["timeStart", "timeEnd"].find(k => d[k] && Content.minutesOf(d[k]) == null);
    if (t) return "Times must look like 09:00.";
    if ((d.timeStart && !d.timeEnd) || (d.timeEnd && !d.timeStart)) return "Set both ends of the window, or neither.";
    return null;
  },

  save() {
    const d = this.draft;
    const problem = this.validate(d);
    if (problem) { const e = $("#meErr"); if (e) e.textContent = problem; return; }
    (d.levels || []).forEach((l, i) => { l.level = i + 1; });
    const saved = Content.save("instances", d);
    this.selected = saved.instanceId;
    this.draft = JSON.parse(JSON.stringify(saved));
    this.isNew = false;
    const compact = Me.compact();
    Me.renderAll();
    if (compact) Me.setPane("map");
    Me.toast("Saved " + (saved.name || "instance") + ".", "good");
  },

  duplicate() {
    const d = JSON.parse(JSON.stringify(this.draft));
    d.instanceId = "";
    d.name = (d.name || "") + " (copy)";
    d.latitude += 0.0004; d.longitude += 0.0005;
    const saved = Content.save("instances", d);
    this.selected = saved.instanceId;
    this.draft = JSON.parse(JSON.stringify(saved));
    Me.renderAll();
    Me.toast("Duplicated.");
  },

  del() {
    const name = (this.draft && this.draft.name) || "this instance";
    if (!confirm("Delete " + name + "? This cannot be undone.")) return;
    Content.remove("instances", this.selected);
    this.selected = null; this.draft = null;
    Me.renderAll();
    if (Me.compact()) Me.setPane("list");
    Me.toast("Deleted.", "bad");
  },

  /* ----------------------------------------------------------------- levels */
  addLevel() {
    const l = Content.blankInstanceLevel((this.draft.levels || []).length + 1);
    const last = (this.draft.levels || [])[this.draft.levels.length - 1];
    if (last) {
      Object.assign(l, {
        spawnTableId: last.spawnTableId, chestLootTableId: last.chestLootTableId,
        chestTier: last.chestTier,
        width: +last.width || 64, height: +last.height || 44,
        walls: JSON.parse(JSON.stringify(last.walls || [])),
        monsters: last.monsters, chests: last.chests,
        difficulty: Math.min(10, (+last.difficulty || 3) + 1)
      });
    }
    this.draft.levels.push(l);
    this.openLevel = this.draft.levels.length - 1;
    this.renderForm();
  },
  removeLevel(i) {
    this.draft.levels.splice(i, 1);
    this.openLevel = Math.max(0, Math.min(this.openLevel, this.draft.levels.length - 1));
    this.renderForm();
  },
  moveLevel(i, dir) {
    const f = this.draft.levels, j = i + dir;
    if (j < 0 || j >= f.length) return;
    const t = f[i]; f[i] = f[j]; f[j] = t;
    this.openLevel = j;
    this.renderForm();
  }
};

/* ==========================================================================
   THE INSTANCE FORM
   ========================================================================== */
Object.assign(Mi, {
  bind: Me.bind, int: Me.int, fld: Me.fld, sel: Me.sel,

  bindLevel(id, i, key, cast, after) {
    const n = $("#" + id);
    if (!n) return;
    n.addEventListener(n.type === "checkbox" || n.tagName === "SELECT" ? "change" : "input", () => {
      this.draft.levels[i][key] = cast ? cast(n.type === "checkbox" ? n.checked : n.value)
                                       : (n.type === "checkbox" ? n.checked : n.value);
      if (after) after();
    });
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
          ? "Pick an instance, or hit <b>+ Instance</b> and tap the map to put a door down."
          : "No zone yet — make one on the Locations tab first.") + "</div>";
      return;
    }
    const d = this.draft;
    const kind = Content.instanceKind(d.kind);

    host.innerHTML =
      '<div class="formHead">' +
        '<button class="backBtn" id="meBack" aria-label="Back to the list">‹</button>' +
        "<h3>" + kind.icon + " " + esc(d.name || "New instance") + "</h3>" +
      "</div>" +
      '<div class="err" id="meErr"></div>' +

      this.fld("f_name", "Name", d.name) +
      '<div class="row2">' +
        this.sel("f_kind", "Kind", d.kind,
          Object.keys(Content.INSTANCE_KINDS).map(k => ({ value: k, label: Content.INSTANCE_KINDS[k].label }))) +
        this.fld("f_minLevel", "Min level", d.minLevel, { type: "number", min: 1 }) +
      "</div>" +

      '<div class="sect">The door</div>' +
      '<label class="f"><span>You can go in within <b id="szOut">' + (+d.radius || 30) + "</b> m</span>" +
        '<div class="radiusRow">' +
          '<input type="range" id="rg_radius" min="5" max="200" step="5" value="' + (+d.radius || 30) + '">' +
          '<input class="input" id="f_radius" type="number" min="5" value="' + (+d.radius || 30) + '">' +
        "</div></label>" +
      '<div class="row2">' +
        this.fld("f_latitude", "Latitude", (+d.latitude).toFixed(6)) +
        this.fld("f_longitude", "Longitude", (+d.longitude).toFixed(6)) +
      "</div>" +
      '<label class="f"><span>Pace — 1 m walked buys <b id="paceOut">' + (+d.pace || 1) + "</b> m inside</span>" +
        '<div class="radiusRow">' +
          '<input type="range" id="rg_pace" min="0.25" max="4" step="0.25" value="' + (+d.pace || 1) + '">' +
          '<input class="input" id="f_pace" type="number" min="0.25" step="0.25" value="' + (+d.pace || 1) + '">' +
        "</div></label>" +
      '<p class="tiny dimmer" style="margin:-4px 0 12px">Inside, the player turns with a dial and walks ' +
        "for real to go forward. Pace is the exchange rate between the two.</p>" +

      '<div class="sect">Levels</div>' +
      '<div id="lvList">' + this.levelsUi() + "</div>" +
      '<button class="btn sm ghost block" id="lvAdd">+ Add a level below</button>' +

      '<div class="sect">When it is open</div>' +
      '<div class="row2">' +
        this.fld("f_timeStart", "Opens", d.timeStart, { placeholder: "09:00" }) +
        this.fld("f_timeEnd", "Closes", d.timeEnd, { placeholder: "17:00" }) +
      "</div>" +
      '<div id="inDays"></div>' +
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

    this.bind("f_name", "name", null, () => Me.renderTable());
    this.bind("f_kind", "kind", null, () => { this.draw(); this.renderForm(); });
    this.bind("f_minLevel", "minLevel", this.int);
    this.bind("f_latitude", "latitude", parseFloat, () => this.draw());
    this.bind("f_longitude", "longitude", parseFloat, () => this.draw());
    this.bind("f_timeStart", "timeStart");
    this.bind("f_timeEnd", "timeEnd");
    this.bind("f_respawnMinutes", "respawnMinutes", this.int);
    this.bind("f_active", "active", null, () => this.draw());
    this.bind("f_notes", "notes");
    this.pair("radius", "szOut", 1, () => { this.draw(); Me.renderTable(); });
    this.pair("pace", "paceOut", 0.25);

    this.renderDays();
    this.wireLevels();
    $("#lvAdd").onclick = () => this.addLevel();
    $("#meSave").onclick = () => this.save();
    $("#meDel").onclick = () => this.del();
    $("#meDup").onclick = () => this.duplicate();
    const back = $("#meBack");
    if (back) back.onclick = () => Me.setPane("list");
  },

  /** A slider and a number box that stay in step, for one numeric field. */
  pair(key, outId, min, after) {
    const range = $("#rg_" + key), num = $("#f_" + key), out = $("#" + outId);
    if (!range || !num) return;
    const set = (raw) => {
      const v = Math.max(min, parseFloat(raw) || min);
      this.draft[key] = v;
      if (out) out.textContent = v;
      if (+range.value !== v) range.value = v;
      if (+num.value !== v) num.value = v;
      if (after) after();
    };
    range.oninput = () => set(range.value);
    num.oninput = () => set(num.value);
  },

  renderDays() {
    const host = $("#inDays");
    if (!host) return;
    const days = this.draft.days || [];
    host.innerHTML = '<label class="f"><span>Days ' + (days.length ? "" : "— every day") +
      "</span><div class='dayRow'>" +
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

  levelsUi() {
    const d = this.draft;
    const spawns = this.spawnOptions(), loot = this.lootOptions();
    return (d.levels || []).map((l, i) => {
      const open = i === this.openLevel;
      const summary = (+l.width || 0) + " × " + (+l.height || 0) + " m · " +
        (+l.monsters || 0) + " roaming" +
        ((l.walls || []).length ? " · " + l.walls.length + " walls" : "") +
        (l.hasBoss ? " · boss" : "");
      return '<div class="floorBox' + (open ? " open" : "") + '">' +
        '<div class="floorHead" data-open="' + i + '">' +
          "<b>" + esc(Content.levelName(d, l, i)) + "</b>" +
          '<span class="tiny dimmer">' + summary + "</span>" +
          '<div class="spacer"></div>' +
          '<button type="button" class="btn sm ghost" data-up="' + i + '" title="Move up"' +
            (i === 0 ? " disabled" : "") + ">↑</button>" +
          '<button type="button" class="btn sm ghost" data-down="' + i + '" title="Move down"' +
            (i === d.levels.length - 1 ? " disabled" : "") + ">↓</button>" +
          '<button type="button" class="btn sm danger" data-rm="' + i + '" title="Remove"' +
            (d.levels.length < 2 ? " disabled" : "") + ">✕</button>" +
        "</div>" +
        (open ? '<div class="floorBody">' +
          this.fld("lv_name_" + i, "Level name (blank = " + esc(Content.levelName(d, {}, i)) + ")", l.name) +
          '<div class="row2">' +
            this.fld("lv_w_" + i, "Floor width (m)", l.width, { type: "number", min: 8 }) +
            this.fld("lv_h_" + i, "Floor height (m)", l.height, { type: "number", min: 8 }) +
          "</div>" +
          '<div class="row2">' +
            this.fld("lv_diff_" + i, "Difficulty 1–10", l.difficulty, { type: "number", min: 1 }) +
            this.fld("lv_mon_" + i, "Roaming monsters", l.monsters, { type: "number", min: 0 }) +
          "</div>" +
          '<div class="row2">' +
            this.fld("lv_chests_" + i, "Chests", l.chests, { type: "number", min: 0 }) +
            this.fld("lv_walls_" + i, "Walls drawn", (l.walls || []).length, { type: "number", readonly: true }) +
          "</div>" +
          this.sel("lv_spawn_" + i, "Monsters here", l.spawnTableId, spawns) +
          '<div class="row2">' +
            this.sel("lv_tier_" + i, "Chest tier", l.chestTier,
              Content.CHEST_TIERS.filter(c => c.key).map(c => ({ value: c.key, label: c.label }))) +
            this.sel("lv_loot_" + i, "Chest loot", l.chestLootTableId, loot) +
          "</div>" +
          '<label class="check"><input type="checkbox" id="lv_boss_' + i + '"' + (l.hasBoss ? " checked" : "") +
            "> <span>Something sits on the stairs down</span></label>" +
          (l.hasBoss ? this.sel("lv_bspawn_" + i, "Boss spawn table", l.bossSpawnTableId, spawns) : "") +
          '<div class="row2">' +
            this.fld("lv_xp_" + i, "XP for clearing (0 = auto)", l.experience, { type: "number", min: 0 }) +
            this.fld("lv_gold_" + i, "Gold for clearing (0 = auto)", l.gold, { type: "number", min: 0 }) +
          "</div>" +
          '<div class="sect">The floor</div>' +
          '<div class="floorPrevWrap">' +
            Content.instancePreviewSvg(Content.buildInstanceLevel(d, i, "preview")) + "</div>" +
          '<p class="tiny dimmer" style="margin:6px 0 2px">One open rectangle, ' +
            (+l.width || 0) + " × " + (+l.height || 0) + " m. \ud83d\udeaa is where you come in, " +
            "\ud83e\ude9c the way down. " +
            ((l.walls || []).length
              ? l.walls.length + " walls drawn into it. "
              : "No walls yet. ") +
            "Only where things stand is rolled; the floor is exactly what you typed.</p>" +
        "</div>" : "") +
      "</div>";
    }).join("");
  },

  wireLevels() {
    const host = $("#lvList");
    if (!host) return;
    host.querySelectorAll("[data-open]").forEach(h => {
      h.onclick = (e) => {
        if (e.target.closest("button[data-up],button[data-down],button[data-rm]")) return;
        const i = +h.dataset.open;
        this.openLevel = this.openLevel === i ? -1 : i;
        this.renderForm();
      };
    });
    host.querySelectorAll("[data-up]").forEach(b => { b.onclick = () => this.moveLevel(+b.dataset.up, -1); });
    host.querySelectorAll("[data-down]").forEach(b => { b.onclick = () => this.moveLevel(+b.dataset.down, 1); });
    host.querySelectorAll("[data-rm]").forEach(b => { b.onclick = () => this.removeLevel(+b.dataset.rm); });

    const i = this.openLevel;
    if (i < 0 || !this.draft.levels[i]) return;
    const redraw = () => { this.renderTable(); };
    this.bindLevel("lv_name_" + i, i, "name");
    this.bindLevel("lv_w_" + i, i, "width", this.int, redraw);
    this.bindLevel("lv_h_" + i, i, "height", this.int, redraw);
    this.bindLevel("lv_diff_" + i, i, "difficulty", this.int);
    this.bindLevel("lv_mon_" + i, i, "monsters", this.int, redraw);
    this.bindLevel("lv_chests_" + i, i, "chests", this.int);
    this.bindLevel("lv_spawn_" + i, i, "spawnTableId");
    this.bindLevel("lv_tier_" + i, i, "chestTier");
    this.bindLevel("lv_loot_" + i, i, "chestLootTableId");
    this.bindLevel("lv_boss_" + i, i, "hasBoss", null, () => this.renderForm());
    this.bindLevel("lv_bspawn_" + i, i, "bossSpawnTableId");
    this.bindLevel("lv_xp_" + i, i, "experience", this.int);
    this.bindLevel("lv_gold_" + i, i, "gold", this.int);
  }
});

window.ME = { Me, Md, Mi, Content, Store, DB, K };

/* Loaded last, so every layer exists by the time this runs. Pull data/*.json
   in first, seed anything still empty, then draw. */
async function meBoot() {
  Me.init();
  try {
    await DB.load();
    DB.seedAll(false);
    if (DB.problems.length) {
      Me.toast("Some database files did not load — run `npm run serve` and open over http.", "bad");
      console.warn("[db]", DB.problems);
    }
    Me.renderAll();
  } catch (e) { console.error("[db]", e); }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", meBoot);
else meBoot();
