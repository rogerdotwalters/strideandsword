/* -------------------------------------------------------------------------
   12b. Art — the PNGs that sit on the map.

   A location can carry a picture: the loading dock, the well, whatever you
   have drawn. It is placed on the ground in metres, so it stays put and stays
   the right size at every zoom, and it goes underneath the pin rather than
   replacing it — the pin is still what you tap.

   Two ways to give it one, both handled here:

     · a path, relative to the page — art/well.png
     · a data: URL, from a file dropped into the editor

   Both end up in the same `image` field. A path keeps the database small and
   is what you want once the art is settled; an upload is what you want while
   you are still trying things, because there is no file to deploy.
   ------------------------------------------------------------------------- */
const Art = {
  /** src -> width/height, so a file is only measured once per session. */
  _aspect: {},
  _pending: {},

  /**
   * Measure a file, then call back. Everything drawn before the measurement
   * lands is square, and is corrected the moment the real ratio is known.
   */
  aspect(src, cb) {
    if (!src) return null;
    if (this._aspect[src] != null) { if (cb) cb(this._aspect[src]); return this._aspect[src]; }
    if (this._pending[src]) { if (cb) this._pending[src].push(cb); return null; }
    this._pending[src] = cb ? [cb] : [];
    const img = new Image();
    img.onload = () => {
      const a = img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      this._aspect[src] = a;
      (this._pending[src] || []).forEach(f => { try { f(a); } catch (e) { /* drawn already */ } });
      delete this._pending[src];
    };
    img.onerror = () => {
      // A missing file is not worth a dialog. It just does not draw, and says
      // so once in the console so a wrong path is findable.
      this._aspect[src] = 0;
      (this._pending[src] || []).forEach(f => { try { f(0); } catch (e) {} });
      delete this._pending[src];
      console.warn("[art] could not load", String(src).slice(0, 80));
    };
    img.src = src;
    return null;
  },

  /** Did this file fail to load? Used to stop drawing a broken box. */
  broken(src) { return this._aspect[src] === 0; },

  /**
   * Put a location's art on a layer group. Returns the overlay, or null when
   * the location has none. Safe to call for every location on every redraw:
   * the group is cleared by the caller, as it is for the pins.
   */
  add(group, loc, opts) {
    // A stubbed or partial Leaflet is a real case in the test harness, and a
    // missing picture should never be what stops the map drawing.
    if (!loc || !loc.image) return null;
    if (typeof L === "undefined" || typeof L.imageOverlay !== "function") return null;
    if (this.broken(loc.image)) return null;
    opts = opts || {};
    const known = this._aspect[loc.image];
    const bounds = Content.locationImageBounds(loc, known || 1);
    if (!bounds) return null;

    const ov = L.imageOverlay(loc.image, bounds, {
      opacity: loc.imageOpacity == null ? 1 : +loc.imageOpacity,
      interactive: false,
      className: "locArt" + (opts.className ? " " + opts.className : ""),
      zIndex: opts.zIndex == null ? 350 : opts.zIndex
    });
    if (!ov) return null;
    group.addLayer(ov);

    const spin = () => {
      const deg = +loc.imageRotation || 0;
      const el = ov.getElement();
      // `rotate` rather than `transform`: Leaflet owns the transform on this
      // element and rewrites it on every pan, which would wipe ours out.
      if (el && deg) el.style.rotate = deg + "deg";
    };
    spin();

    if (known == null) {
      this.aspect(loc.image, (a) => {
        if (!a) { group.removeLayer(ov); return; }
        const b2 = Content.locationImageBounds(loc, a);
        if (b2 && ov._map) { ov.setBounds(L.latLngBounds(b2)); spin(); }
      });
    }
    return ov;
  },

  /**
   * Read a dropped file into a data: URL. Rejects anything that is not an
   * image, and anything big enough to be a problem — the whole database goes
   * through localStorage, which is a few megabytes in total, so a 5 MB PNG
   * would take the game down with it.
   */
  MAX_BYTES: 700 * 1024,

  readFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error("No file."));
      if (!/^image\//.test(file.type)) return reject(new Error("That is not an image."));
      if (file.size > this.MAX_BYTES) {
        return reject(new Error(
          "That file is " + Math.round(file.size / 1024) + " KB. Keep uploads under " +
          Math.round(this.MAX_BYTES / 1024) + " KB, or put the file in art/ and use its path instead."));
      }
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Could not read that file."));
      r.readAsDataURL(file);
    });
  },

  /** A short, honest label for whatever is in the field. */
  describe(src) {
    if (!src) return "No art";
    if (Content.imageIsInline(src)) return "Uploaded image (" + Math.round(src.length / 1024) + " KB)";
    return src;
  },

  /* ======================================================== FACES ==========

     Two ways of showing a creature or a character, and one rule about which:

       token    a **circle** with a coloured ring — for the map, where a thing
                is a dot among other dots and has to read at 34 px
       portrait a **framed rectangle**, the whole picture, nothing cropped —
                for the combat screen and the panels, where there is room to
                actually look at it

     Both take the same two inputs: a picture if one has been drawn, and the
     emoji to fall back on until then. That fallback is the whole reason this
     is one function rather than an `<img>` in nine places — the game shipped
     as emoji and has to keep working with no art at all.

     The ring says **difficulty**, 1–10, green through amber to red, so the
     map answers "can I take that?" before you tap it. Zero means it is not a
     fight — a trader, a quest giver — and takes the blue used everywhere else
     for something friendly. */

  /* Stops the ring colour is interpolated between. Not a gradient function:
     these five are picked to sit beside the rarity colours without being
     mistaken for them. */
  DIFFICULTY_STOPS: [
    { at: 1,  rgb: [84, 179, 122] },     // green
    { at: 4,  rgb: [156, 194, 90] },     // yellow-green
    { at: 6,  rgb: [224, 163, 62] },     // gold
    { at: 8,  rgb: [217, 122, 60] },     // orange
    { at: 10, rgb: [200, 69, 60] }       // blood
  ],
  FRIENDLY: "#4a8fd4",

  difficultyColor(d) {
    const n = +d || 0;
    if (n <= 0) return this.FRIENDLY;
    const s = this.DIFFICULTY_STOPS;
    const v = clamp(n, s[0].at, s[s.length - 1].at);
    for (let i = 1; i < s.length; i++) {
      if (v > s[i].at) continue;
      const a = s[i - 1], b = s[i];
      const t = (v - a.at) / (b.at - a.at || 1);
      const mix = a.rgb.map((c, k) => Math.round(c + (b.rgb[k] - c) * t));
      return "rgb(" + mix.join(",") + ")";
    }
    return "rgb(" + s[s.length - 1].rgb.join(",") + ")";
  },

  /**
   * The inside of a face: the picture, or the emoji we had before it.
   *
   * A file that failed to load falls back too, rather than leaving a hole —
   * `broken()` is already tracking that for the map art.
   */
  faceInner(o) {
    const img = o.image && !this.broken(o.image) ? o.image : "";
    if (img) {
      return '<img src="' + esc(img) + '" alt="" draggable="false">';
    }
    return '<span class="em">' + (o.icon || "❔") + "</span>";
  },

  /**
   * A circular token for the map.
   *
   *   image, icon        the picture and its fallback
   *   difficulty         0–10; colours the ring
   *   size               px across, ring included (default 34)
   *   badge              a corner number, usually the difficulty
   *   cls, data          extra classes and one data-* pair, for hit testing
   *   state              "inrange" | "dead" | "" — decoration only
   */
  tokenHtml(o) {
    o = o || {};
    const size = +o.size || 34;
    const ring = o.ring || this.difficultyColor(o.difficulty);
    const data = o.data ? ' data-' + o.data.key + '="' + esc(o.data.value) + '"' : "";
    return '<div class="tok ' + (o.cls || "") + " " + (o.state || "") +
      '" style="--tokSize:' + size + "px;--ring:" + ring + '"' + data + ">" +
      '<div class="tokIn">' + this.faceInner(o) + "</div>" +
      (o.badge != null && o.badge !== "" ? '<span class="tokBadge">' + esc(o.badge) + "</span>" : "") +
      "</div>";
  },

  /**
   * A framed portrait — the whole picture, not a circle crop.
   *
   * `object-fit: contain` on purpose: this is the view where you are meant to
   * see what you drew, and a square-cropped circle of it is what the map is
   * for. A tall box because characters are taller than they are wide.
   */
  portraitHtml(o) {
    o = o || {};
    const w = +o.w || 56, h = +o.h || Math.round((+o.w || 56) * 1.24);
    const ring = o.ring || this.difficultyColor(o.difficulty);
    return '<div class="port ' + (o.cls || "") + " " + (o.state || "") +
      '" style="--portW:' + w + "px;--portH:" + h + "px;--ring:" + ring + '">' +
      '<div class="portIn">' + this.faceInner(o) + "</div>" +
      (o.badge != null && o.badge !== "" ? '<span class="portBadge">' + esc(o.badge) + "</span>" : "") +
      "</div>";
  },

  /* ---------------------------------------------------------- uploading art

     A portrait is small on screen and there may be thirty of them, so the
     file is **redrawn at 256 px before it is stored** rather than merely
     rejected for being big. A phone camera's 4 MB photo becomes about 60 KB
     of PNG, which is the difference between a portrait set that fits in
     localStorage and one that fills it.

     Everything about this is best-effort: no canvas, a format the browser
     cannot decode, anything odd — and it falls back to storing the file as it
     came, under the ordinary size cap. */

  PORTRAIT_PX: 256,
  PORTRAIT_MAX_BYTES: 300 * 1024,

  shrink(dataUrl, maxPx) {
    return new Promise((resolve) => {
      if (typeof document === "undefined" || !document.createElement) return resolve(dataUrl);
      const max = +maxPx || this.PORTRAIT_PX;
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return resolve(dataUrl);
          if (w <= max && h <= max && dataUrl.length < this.PORTRAIT_MAX_BYTES) return resolve(dataUrl);
          const s = Math.min(max / w, max / h, 1);
          const cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(w * s));
          cv.height = Math.max(1, Math.round(h * s));
          const cx = cv.getContext("2d");
          if (!cx) return resolve(dataUrl);
          cx.drawImage(img, 0, 0, cv.width, cv.height);
          /* The redraw wins even when it is the larger string. A flat 900 px
             PNG can compress smaller than its own 256 px re-encode, and
             keeping the original for being fewer bytes means keeping a
             picture four times the size it will ever be drawn at — which is
             the whole reason this function exists. */
          resolve(cv.toDataURL("image/png"));
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  },

  /* A portrait is allowed to arrive big, because it is not stored as it
     arrived. Eight megabytes is a phone photo; past that something is wrong
     with the file rather than with the camera. */
  PORTRAIT_IN_BYTES: 8 * 1024 * 1024,

  /** Read a portrait file: straight in, redrawn small, then checked. */
  readPortrait(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error("No file."));
      if (!/^image\//.test(file.type)) return reject(new Error("That is not an image."));
      if (file.size > this.PORTRAIT_IN_BYTES) {
        return reject(new Error("That file is " + Math.round(file.size / (1024 * 1024)) +
          " MB. Even a portrait has limits — try an export rather than the original."));
      }
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Could not read that file."));
      r.readAsDataURL(file);
    })
      .then(url => this.shrink(url, this.PORTRAIT_PX))
      .then(url => {
        if (url.length > this.PORTRAIT_MAX_BYTES * 1.4) {
          throw new Error("That picture is still " + Math.round(url.length / 1024) +
            " KB after shrinking. Try a simpler image, or put the file in art/ and use its path.");
        }
        return url;
      });
  }
};
