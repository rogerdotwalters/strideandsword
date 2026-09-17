/* ==========================================================================
   THE BUILDING LAYER

   A building is a place on the map with somebody working out of it. Putting
   one down is one click; everything after that is the form.

   Two things make this layer different from the other three:

     · **Buildings belong to the world, not to a zone.** Locations, dungeons
       and instances are all filtered by `Me.zone`, because they are the
       contents of a zone. A high street is not, and an imported one would
       vanish the moment you switched zones. So this layer lists *everything*,
       sorted by distance from wherever you are looking.

     · **The outline is optional.** A point and a radius is enough. Trace the
       real footprint if you want the shape drawn — from here, or by importing
       a Google Earth polygon — and the pin follows its middle.
   ========================================================================== */
const Mb = {
  selected: null,
  draft: null,
  isNew: false,
  layer: null,
  markers: {},
  sort: { col: "name", dir: 1 },
  tracing: null,           // an array of [lat, lng] while the trace tool is on

  all() { return (typeof Buildings === "undefined") ? [] : Buildings.all(); },
  active() { return Me.mode === "buildings"; },

  /** Everything, nearest the zone anchor first — the closest thing to "here". */
  sorted() {
    const rows = this.all().slice();
    const z = Me.zone;
    const s = this.sort;
    const dist = (b) => z ? Buildings.distanceTo(b, z.centerLatitude, z.centerLongitude) : 0;
    const val = (b) => s.col === "name" ? (b.name || "").toLowerCase()
      : s.col === "kind" ? b.kind
      : s.col === "level" ? Buildings.levelOf(b)
      : s.col === "trades" ? Buildings.tradesOf(b).join(",")
      : s.col === "size" ? Buildings.sizeM(b)
      : dist(b);
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      return (x > y ? 1 : x < y ? -1 : 0) * s.dir;
    });
    return rows;
  },

  /* ------------------------------------------------------------- drawing */
  draw() {
    if (typeof Buildings === "undefined") return;
    if (!this.layer) this.layer = L.layerGroup().addTo(Me.map);
    this.layer.clearLayers();
    this.markers = {};
    const editing = this.active();

    this.all().forEach(b => {
      const shown = (this.draft && this.selected === b.buildingId) ? this.draft : b;
      const k = Buildings.kind(shown.kind);
      const sel = editing && this.selected === b.buildingId;
      const ring = Buildings.ring(shown);
      const style = {
        color: sel ? "#e0a33e" : k.color,
        weight: sel ? 2.5 : 1.5,
        opacity: editing ? (sel ? .95 : .55) : .25,
        fillColor: sel ? "#e0a33e" : k.color,
        fillOpacity: editing ? (sel ? .16 : .08) : .04,
        dashArray: shown.active === false ? "5 6" : (ring ? null : "6 5"),
        interactive: false
      };
      this.layer.addLayer(ring
        ? L.polygon(ring, style)
        : L.circle([shown.latitude, shown.longitude],
                   Object.assign({ radius: +shown.radius || 45 }, style)));
      // The yard the resident paces, when an outline makes the two different.
      if (ring && editing && sel) {
        const c = Buildings.centroid(shown);
        this.layer.addLayer(L.circle([c.latitude, c.longitude], {
          radius: +shown.radius || 45, color: "#4a8fd4", weight: 1, opacity: .5,
          fill: false, dashArray: "4 6", interactive: false
        }));
      }

      const c = Buildings.centroid(shown);
      const pin = L.marker([c.latitude, c.longitude], {
        draggable: editing && !ring,
        /* Dead to the mouse while another layer is being edited. A marker is
           interactive by default, and buildings are the only layer here that
           is not filtered to the current zone — so a sample building sitting
           on the town centre swallowed the click that was meant to place a
           location, and the third one never landed. */
        interactive: editing,
        icon: L.divIcon({ className: "pinWrap",
          html: '<div class="bldMark' + (sel ? " sel" : "") + (shown.active === false ? " off" : "") +
                '" data-bld="' + b.buildingId + '">' + k.icon +
                '<span class="d">' + Buildings.levelOf(shown) + "</span></div>",
          iconSize: [34, 34], iconAnchor: [17, 17] })
      });
      pin.bindTooltip(esc(shown.name || "(unnamed)") + " · " + esc(k.label) +
                      " · level " + Buildings.levelOf(shown),
                      { direction: "top", offset: [0, -12] });
      if (editing) {
        pin.on("click", (e) => {
          if (Me.placing || this.tracing) { L.DomEvent.stop(e); Me.placeAt(e.latlng.lat, e.latlng.lng); return; }
          this.select(b.buildingId);
        });
        pin.on("dragend", () => {
          const p = pin.getLatLng();
          const row = Buildings.get(b.buildingId);
          row.latitude = p.lat; row.longitude = p.lng;
          Buildings.save(row);
          if (this.selected === b.buildingId && this.draft) {
            this.draft.latitude = p.lat; this.draft.longitude = p.lng;
            this.renderForm();
          }
          this.draw(); Me.renderTable();
          Me.toast("Moved to " + p.lat.toFixed(5) + ", " + p.lng.toFixed(5));
        });
      }
      this.layer.addLayer(pin);
      this.markers[b.buildingId] = pin;
    });

    // The outline being traced right now, as it grows.
    if (this.tracing && this.tracing.length) {
      this.layer.addLayer(L.polyline(this.tracing.concat(
        this.tracing.length > 2 ? [this.tracing[0]] : []), {
        color: "#e0a33e", weight: 2, dashArray: "5 5", interactive: false }));
      this.tracing.forEach(p => this.layer.addLayer(L.circleMarker(p, {
        radius: 4, color: "#e0a33e", fillColor: "#e0a33e", fillOpacity: 1, interactive: false })));
    }
  },

  /* -------------------------------------------------------------- placing */
  placeAt(lat, lng) {
    if (this.tracing) { this.traceAt(lat, lng); return; }
    const b = Buildings.blank("store", lat, lng);
    b.name = "New building";
    const saved = Buildings.save(b);
    this.selected = saved.buildingId;
    this.draft = JSON.parse(JSON.stringify(saved));
    this.isNew = false;
    Me.renderAll();
    if (Me.compact()) Me.setPane("form");
  },

  /* --------------------------------------------------------------- tracing
     Click a corner at a time; three of them is an outline. Deliberately not a
     drag-rectangle: real buildings are rarely axis-aligned and a rectangle
     that has to be rotated afterwards is worse than four clicks. */
  startTrace() {
    this.tracing = [];
    Me.togglePlacing(false);
    Me.map.getContainer().style.cursor = "crosshair";
    const hint = $("#meHint");
    if (hint) { hint.classList.remove("hidden"); hint.textContent = "Click each corner · Enter to finish · Esc to cancel"; }
    if (Me.compact()) Me.setPane("map");
    this.renderForm();
  },
  traceAt(lat, lng) {
    this.tracing.push([lat, lng]);
    this.draw();
    this.renderForm();
  },
  finishTrace(keep) {
    const pts = this.tracing || [];
    this.tracing = null;
    Me.map.getContainer().style.cursor = "";
    const hint = $("#meHint");
    if (hint) hint.classList.add("hidden");
    if (keep && pts.length > 2 && this.draft) {
      this.draft.footprint = pts.map(p => [p[0], p[1]]);
      const c = Buildings.centroid(this.draft);
      this.draft.latitude = c.latitude; this.draft.longitude = c.longitude;
      Me.toast(pts.length + " corners traced. Save to keep it.", "good");
    } else if (keep) {
      Me.toast("An outline needs at least three corners.", "bad");
    }
    this.draw();
    this.renderForm();
  },

  /* ---------------------------------------------------------------- table */
  renderTable() {
    const wrap = $("#meTableWrap");
    const rows = this.sorted();
    const z = Me.zone;

    wrap.innerHTML = !rows.length
      ? '<div class="emptyMsg">No buildings yet. Hit <b>+ Building</b> and tap the map, ' +
        "or import a Google Earth file on the regions page.</div>"
      : '<table class="grid"><thead><tr>' +
          Me.th("name", "Name") + Me.th("kind", "Kind") + Me.th("level", "Lvl", "num") +
          Me.th("trades", "Deals in") + Me.th("size", "Size", "num") +
          Me.th("dist", "From here", "num") + "<th>On</th></tr></thead><tbody>" +
        rows.map(b => {
          const k = Buildings.kind(b.kind);
          const d = z ? Buildings.distanceTo(b, z.centerLatitude, z.centerLongitude) : null;
          return '<tr data-id="' + b.buildingId + '"' +
            (this.selected === b.buildingId ? ' class="on"' : "") + ">" +
            '<td data-l="Name"><b>' + esc(b.name || "(unnamed)") + "</b>" +
              (Buildings.ring(b) ? ' <span class="autoTag" title="Has a traced outline">traced</span>' : "") +
              "</td>" +
            '<td data-l="Kind">' + k.icon + " " + esc(k.label) + "</td>" +
            '<td class="num" data-l="Level">' + Buildings.levelOf(b) + "</td>" +
            '<td data-l="Deals in">' + esc(Buildings.tradesOf(b)
                .map(t => Buildings.TRADES[t].verb).join(", ")) + "</td>" +
            '<td class="num" data-l="Size">' + Buildings.sizeM(b) + " m</td>" +
            '<td class="num" data-l="From here">' + (d == null ? "—" : fmtDist(d)) + "</td>" +
            '<td data-l="On">' + (b.active === false ? "—" : "yes") + "</td>" +
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
      tr.onclick = () => {
        this.select(tr.dataset.id);
        const b = Buildings.get(tr.dataset.id);
        if (b) Me.map.panTo([Buildings.centroid(b).latitude, Buildings.centroid(b).longitude]);
        if (Me.compact()) Me.setPane("form");
      };
    });
  },

  /* --------------------------------------------------------------- record */
  select(id) {
    this.selected = id;
    this.isNew = false;
    this.tracing = null;
    const row = Buildings.get(id);
    this.draft = row ? JSON.parse(JSON.stringify(row)) : null;
    this.draw();
    this.renderTable();
    this.renderForm();
    if (Me.compact() && this.draft) Me.setPane("form");
  },

  validate(b) {
    if (!b.name || !b.name.trim()) return "Give it a name.";
    if (!(+b.radius >= 5)) return "The radius must be at least 5 m.";
    if (!Buildings.tradesOf(b).length) return "Pick at least one thing they do.";
    if ((b.footprint || []).length && (b.footprint || []).length < 3) {
      return "An outline needs at least three corners.";
    }
    return null;
  },

  save() {
    const b = this.draft;
    const problem = this.validate(b);
    if (problem) { const e = $("#meErr"); if (e) e.textContent = problem; return; }
    const saved = Buildings.save(b);
    this.selected = saved.buildingId;
    this.draft = JSON.parse(JSON.stringify(saved));
    this.isNew = false;
    const compact = Me.compact();
    Me.renderAll();
    if (compact) Me.setPane("map");
    Me.toast("Saved " + (saved.name || "building") + ".", "good");
  },

  duplicate() {
    const b = JSON.parse(JSON.stringify(this.draft));
    b.buildingId = "";
    b.name = (b.name || "") + " (copy)";
    b.latitude += 0.0004; b.longitude += 0.0005;
    b.footprint = [];                  // an outline belongs to one building
    const saved = Buildings.save(b);
    this.selected = saved.buildingId;
    this.draft = JSON.parse(JSON.stringify(saved));
    Me.renderAll();
    Me.toast("Duplicated.");
  },

  del() {
    const name = (this.draft && this.draft.name) || "this building";
    if (!confirm("Delete " + name + "? This cannot be undone.")) return;
    Buildings.remove(this.selected);
    this.selected = null; this.draft = null;
    Me.renderAll();
    if (Me.compact()) Me.setPane("list");
    Me.toast("Deleted.", "bad");
  }
};

/* ==========================================================================
   THE BUILDING FORM
   ========================================================================== */
Object.assign(Mb, {
  bind: Me.bind, int: Me.int, fld: Me.fld, sel: Me.sel, pair: Mi.pair,

  renderForm() {
    const host = $("#meForm");
    if (!this.draft) {
      host.innerHTML = '<div class="emptyForm">' +
        "Pick a building, or hit <b>+ Building</b> and tap the map.<br><br>" +
        '<span class="tiny dimmer">Buildings are not tied to a zone — every one you have ' +
        "is listed, nearest first.</span></div>";
      return;
    }
    const b = this.draft;
    const k = Buildings.kind(b.kind);
    const ring = Buildings.ring(b);

    host.innerHTML =
      '<div class="formHead">' +
        '<button class="backBtn" id="meBack" aria-label="Back to the list">‹</button>' +
        "<h3>" + k.icon + " " + esc(b.name || "New building") + "</h3>" +
      "</div>" +
      '<div class="err" id="meErr"></div>' +

      this.fld("f_name", "Name", b.name) +
      '<div class="row2">' +
        this.sel("f_kind", "Kind", b.kind,
          Buildings.KINDS.map(x => ({ value: x.key, label: x.icon + " " + cap(x.label) }))) +
        this.fld("f_level", "Level 1–10", Buildings.levelOf(b), { type: "number", min: 1 }) +
      "</div>" +
      '<p class="tiny dimmer" style="margin:-4px 0 12px">Level is the only dial: it sets what the ' +
        "resident carries, what they charge, how much a rest gives back and how far a smith will go.</p>" +

      '<div class="sect">On the ground</div>' +
      '<label class="f"><span>The yard around it is <b id="szOut">' + (+b.radius || 45) + "</b> m</span>" +
        '<div class="radiusRow">' +
          '<input type="range" id="rg_radius" min="10" max="250" step="5" value="' + (+b.radius || 45) + '">' +
          '<input class="input" id="f_radius" type="number" min="10" value="' + (+b.radius || 45) + '">' +
        "</div></label>" +
      '<p class="tiny dimmer" style="margin:-4px 0 10px">How far the resident strays, and how close you ' +
        "have to be for the building to count as here.</p>" +
      '<div class="row2">' +
        this.fld("f_latitude", "Latitude", (+b.latitude).toFixed(6)) +
        this.fld("f_longitude", "Longitude", (+b.longitude).toFixed(6)) +
      "</div>" +
      '<div class="row2">' +
        '<button class="btn sm ghost" id="bTrace">' +
          (this.tracing ? "Finish outline (" + this.tracing.length + ")" : ring ? "Retrace outline" : "Trace outline") +
        "</button>" +
        '<button class="btn sm ghost" id="bClear"' + (ring ? "" : " disabled") + ">Clear outline</button>" +
      "</div>" +
      '<p class="tiny dimmer" style="margin:6px 0 12px">' +
        (this.tracing
          ? "Click each corner on the map. Enter finishes, Esc cancels."
          : ring ? ring.length + " corners traced · " + Buildings.sizeM(b) + " m across."
                 : "Optional. Without one the building is drawn as a circle.") + "</p>" +

      '<div class="sect">Who works there</div>' +
      this.fld("f_residentName", "Name (blank = " + esc(Buildings.residentName(
        Object.assign({}, b, { residentName: "" }))) + ")", b.residentName) +
      '<div class="portRow">' +
        Art.tokenHtml({ image: b.residentPortrait, icon: b.residentIcon || "🧍", difficulty: 0, size: 44 }) +
        Art.portraitHtml({ image: b.residentPortrait, icon: b.residentIcon || "🧍", difficulty: 0, w: 60, h: 74 }) +
        '<div class="portActs">' +
          '<label class="btn sm ghost" for="f_resPortFile">Upload a face</label>' +
          '<input type="file" id="f_resPortFile" accept="image/*" hidden>' +
          '<button type="button" class="btn sm danger" id="f_resPortClear"' +
            (b.residentPortrait ? "" : " disabled") + ">Clear</button>" +
        "</div>" +
      "</div>" +
      '<div class="row2">' +
        this.fld("f_residentIcon", "Icon", b.residentIcon, { placeholder: "🧍" }) +
        this.sel("f_questId", "Hands out", b.questId,
          [{ value: "", label: "— nothing —" }].concat(
            (typeof Content !== "undefined" ? Content.list("quests") : [])
              .map(q => ({ value: q.questId, label: q.name || q.questId })))) +
      "</div>" +
      '<div class="sect">What they do</div>' +
      '<div id="bTrades"></div>' +

      '<label class="check"><input type="checkbox" id="f_active"' + (b.active === false ? "" : " checked") +
        "> <span>Open for business</span></label>" +
      '<label class="f"><span>Notes</span><textarea class="input" id="f_notes" rows="2">' +
        esc(b.notes || "") + "</textarea></label>" +

      '<div class="formActions">' +
        '<button class="btn danger sm" id="meDel"' + (this.isNew ? " disabled" : "") + ">Delete</button>" +
        '<button class="btn ghost sm" id="meDup"' + (this.isNew ? " disabled" : "") + ">Duplicate</button>" +
        '<div class="spacer"></div>' +
        '<button class="btn primary" id="meSave">Save</button>' +
      "</div>";

    this.bind("f_name", "name", null, () => { this.draw(); Me.renderTable(); });
    this.bind("f_kind", "kind", null, () => {
      // Switching kind moves the default trades with it, unless they were set.
      this.draft.trades = Buildings.kind(this.draft.kind).trades.slice();
      this.draw(); this.renderForm(); Me.renderTable();
    });
    this.bind("f_level", "level", this.int, () => { this.draw(); Me.renderTable(); });
    this.bind("f_latitude", "latitude", parseFloat, () => this.draw());
    this.bind("f_longitude", "longitude", parseFloat, () => this.draw());
    this.bind("f_residentName", "residentName");
    this.bind("f_residentIcon", "residentIcon", null, () => this.renderForm());
    const pf = $("#f_resPortFile"), pc = $("#f_resPortClear");
    if (pf) pf.onchange = () => {
      const f = pf.files && pf.files[0];
      pf.value = "";
      if (!f) return;
      Art.readPortrait(f).then(url => {
        this.draft.residentPortrait = url;
        this.renderForm();
        Me.toast("Face attached (" + Math.round(url.length / 1024) + " KB). Save to keep it.", "good");
      }).catch(e => Me.toast(e.message, "bad", 4200));
    };
    if (pc) pc.onclick = () => { this.draft.residentPortrait = ""; this.renderForm(); };
    this.bind("f_questId", "questId");
    this.bind("f_active", "active", null, () => this.draw());
    this.bind("f_notes", "notes");
    this.pair("radius", "szOut", 10, () => { this.draw(); Me.renderTable(); });

    this.renderTrades();
    $("#bTrace").onclick = () => {
      if (this.tracing) this.finishTrace(true); else this.startTrace();
    };
    $("#bClear").onclick = () => {
      this.draft.footprint = [];
      this.draw(); this.renderForm();
    };
    $("#meSave").onclick = () => this.save();
    $("#meDel").onclick = () => this.del();
    $("#meDup").onclick = () => this.duplicate();
    const back = $("#meBack");
    if (back) back.onclick = () => Me.setPane("list");
  },

  renderTrades() {
    const host = $("#bTrades");
    if (!host) return;
    const have = Buildings.tradesOf(this.draft);
    host.innerHTML = Buildings.TRADE_ORDER.map(t => {
      const tr = Buildings.TRADES[t];
      return '<label class="check"><input type="checkbox" data-trade="' + t + '"' +
        (have.indexOf(t) >= 0 ? " checked" : "") + "> <span>" + tr.icon + " " + tr.name +
        " <small class='dimmer'>— " + esc(tr.blurb) + "</small></span></label>";
    }).join("");
    host.querySelectorAll("[data-trade]").forEach(box => {
      box.onchange = () => {
        const t = box.dataset.trade;
        const list = Buildings.tradesOf(this.draft).filter(x => x !== t);
        if (box.checked) list.push(t);
        this.draft.trades = Buildings.TRADE_ORDER.filter(x => list.indexOf(x) >= 0);
        Me.renderTable();
      };
    });
  }
});

window.ME = { Me, Md, Mi, Mb, Content, Store, DB, K, Buildings };

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
