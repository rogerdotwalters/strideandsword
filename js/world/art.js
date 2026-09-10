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
  }
};
