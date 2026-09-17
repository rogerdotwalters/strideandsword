"use strict";
/* -------------------------------------------------------------------------
   8h. KML — what comes out of Google Earth.

   Google Earth is the easiest polygon tool most people already have: draw a
   shape over the satellite view, right-click, Save Place As. What lands on
   disk is **KML** (or **KMZ**, which is a zip with a KML inside it), and this
   turns that into regions.

   ============================== THE ONE RULE =============================

   **This produces GeoJSON, not regions.** KML coordinates are `lng,lat,alt`
   — the same order GeoJSON uses and the opposite of the order the rest of
   this project uses — so rather than add a third place that knows about
   coordinate order, everything here comes out as GeoJSON Features and
   `Regions.fromFeature` does the one conversion it already does.

   The single exception is a path, which has to be given a width before it is
   an area at all; that is done in [lat, lng] and flipped back in `feature()`,
   which is the only line in this file that swaps an order.

   ================================ WHAT IT READS ==========================

     Polygon            → a region, with innerBoundaryIs rings as holes
     MultiGeometry      → one region per polygon in it
     LineString         → optionally a band of ground, given a width
     Point              → a **building**, if its name says so; otherwise
                          counted and skipped, because a pin is not an area

   A placemark whose name declares a building — "building: Store level 3" —
   comes out as a building feature whatever shape it was drawn as: a pin
   becomes a building at that point, a polygon becomes the same building with
   its outline as a footprint. `Buildings.parseName` owns that grammar and
   this file only asks it; `docs/google-earth.md` is the copy a person reads.

   Placemark names, folder names and descriptions are read for two reasons:
   the name becomes the region's name, and all three are searched for words
   that say what the ground is ("creek", "pasture", "the back woods") so an
   import can classify itself instead of arriving as forty identical polygons.

   ============================== WHAT IT IGNORES ==========================

   Styles, icons, camera positions, tours, network links, timestamps. None of
   them say anything about the ground. The parser is deliberately a scanner
   rather than an XML tree: a KMZ of a county is megabytes of markup and
   almost all of it is presentation.
   ------------------------------------------------------------------------- */
const KML = {
  /* Words that say what a piece of ground is. Checked against the placemark
     name, its folder and its description, longest first so "dry creek" does
     not match "creek" and land in the water. */
  HINTS: [
    { terrain: "marsh",  words: ["marsh", "swamp", "bog", "fen", "wetland", "slough", "bottoms",
                                 "floodplain", "flood plain", "flood zone", "boggy", "wet ground",
                                 "seep", "muck", "low ground", "lowland", "wet", "swale", "draw",
                                 "sump", "standing water", "holds water"] },
    { terrain: "water",  words: ["river", "creek", "stream", "lake", "pond", "bayou", "branch",
                                 "reservoir", "water", "canal", "ditch", "run", "spring", "shore"] },
    { terrain: "wood",   words: ["wood", "woods", "forest", "timber", "thicket", "copse", "grove",
                                 "brush", "scrub", "tree line", "treeline", "pines"] },
    { terrain: "meadow", words: ["meadow", "park", "lawn", "green", "pasture", "paddock", "common",
                                 "grass", "garden", "playing field", "golf", "cemetery"] },
    { terrain: "plain",  words: ["field", "farm", "crop", "hay", "prairie", "plain", "acreage",
                                 "pivot", "furrow", "stubble"] },
    { terrain: "rock",   words: ["quarry", "rock", "cliff", "bluff", "scarp", "gravel", "pit",
                                 "outcrop", "ridge", "sand"] },
    { terrain: "waste",  words: ["landfill", "dump", "tip", "spoil", "blight", "industrial",
                                 "siding", "yard", "waste", "slag", "brownfield"] },
    { terrain: "town",   words: ["town", "street", "neighbourhood", "neighborhood", "subdivision",
                                 "downtown", "block", "estate", "village"] }
  ],

  /**
   * The terrain a piece of text is talking about, or "" if it is not talking
   * about ground at all. Case-insensitive, whole-word-ish, longest phrase
   * first — "dry creek bed" is water, "creekside meadow" is a meadow because
   * "meadow" is the later, more specific word in the name.
   */
  guessTerrain(...texts) {
    const hay = texts.filter(Boolean).join(" ").toLowerCase();
    if (!hay.trim()) return "";
    let best = "", bestAt = -1, bestLen = 0;
    this.HINTS.forEach(h => {
      h.words.forEach(w => {
        const at = hay.lastIndexOf(w);
        if (at < 0) return;
        // The last mention wins, and a longer phrase beats a shorter one that
        // starts at the same place.
        if (at > bestAt || (at === bestAt && w.length > bestLen)) {
          best = h.terrain; bestAt = at; bestLen = w.length;
        }
      });
    });
    return best;
  },

  /* ----------------------------------------------------------------- KMZ
     A KMZ is a zip. Rather than carry a zip library for one file, the central
     directory is read directly and the entry is inflated by the platform: the
     browser has DecompressionStream, node has zlib. Both have had raw deflate
     for years, and this is the whole of what a KMZ needs. */

  isZip(bytes) {
    return bytes && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
           (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7);
  },

  /**
   * The .kml inside a .kmz.
   *
   * `opts.inflateRaw` is how node passes in zlib; the browser needs nothing.
   * Returns the first .kml found, which for anything Google Earth writes is
   * doc.kml — and for a hand-made zip is whatever they called it.
   */
  async unzipKmz(bytes, opts) {
    opts = opts || {};
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // End of central directory: scan back for its signature.
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("That .kmz is not a zip file.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);

    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!/\.kml$/i.test(name)) continue;

      // The local header repeats the name and extra fields, at its own lengths.
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(start, start + csize);
      if (method === 0) return new TextDecoder().decode(raw);
      if (method !== 8) throw new Error("That .kmz uses a compression this cannot read.");
      if (opts.inflateRaw) return new TextDecoder().decode(opts.inflateRaw(raw));
      if (typeof DecompressionStream === "undefined") {
        throw new Error("This browser cannot unzip a .kmz — unzip it and open the .kml inside.");
      }
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([raw]).stream().pipeThrough(ds);
      return new Response(stream).text();
    }
    throw new Error("No .kml inside that .kmz.");
  },

  /* ------------------------------------------------------------- scanning */

  /** Strip comments and CDATA wrappers, keeping the text inside them. */
  clean(xml) {
    return String(xml)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, inner) => inner.replace(/[<>&]/g, c =>
        c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
  },

  /** Text of the first <tag> in this fragment, namespace prefixes allowed. */
  tagText(frag, tag) {
    const m = new RegExp("<(?:\\w+:)?" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?" + tag + ">", "i").exec(frag);
    return m ? this.unescape(m[1].trim()) : "";
  },

  /** Every <tag>…</tag> block in this fragment, as raw fragments. */
  blocks(frag, tag) {
    const out = [];
    const re = new RegExp("<(?:\\w+:)?" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?" + tag + ">", "gi");
    let m;
    while ((m = re.exec(frag))) out.push(m[1]);
    return out;
  },

  unescape(s) {
    return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  },

  /**
   * A <coordinates> block as [[lng, lat], …].
   *
   * KML separates tuples by any whitespace and the parts by commas, and the
   * third part is an altitude nobody here wants. Google Earth writes these
   * with a newline per point for a polygon and all on one line for a path,
   * so the split has to take both.
   */
  coords(text) {
    const out = [];
    String(text).trim().split(/\s+/).forEach(tuple => {
      const bits = tuple.split(",");
      if (bits.length < 2) return;
      const lng = parseFloat(bits[0]), lat = parseFloat(bits[1]);
      if (isFinite(lng) && isFinite(lat)) out.push([lng, lat]);
    });
    return out;
  },

  /** Close a ring, and drop a repeated last point — KML closes, we do not. */
  ring(pts) {
    const r = pts.slice();
    if (r.length > 3 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    return r;
  },

  /**
   * Which folders a placemark is in.
   *
   * Google Earth's folders are how people organise a survey — "Creeks",
   * "Low ground", "Pastures" — which makes them the best terrain hint in the
   * file. A one-pass scan with a stack rather than a tree, because the rest
   * of this parser is a scanner and a tree would be the only reason to carry
   * a real XML parser.
   */
  placemarks(xml) {
    const src = this.clean(xml);
    const out = [];
    const stack = [];
    const re = /<(\/?)(?:\w+:)?(Folder|Document|Placemark)(\s[^>]*)?(\/?)>/gi;
    let m, last = 0;
    while ((m = re.exec(src))) {
      const closing = m[1] === "/", tag = m[2].toLowerCase(), selfClose = m[4] === "/";
      if (tag === "placemark") {
        if (closing) continue;
        if (selfClose) continue;
        // Everything up to the matching close. Placemarks do not nest.
        const end = src.toLowerCase().indexOf("</placemark>", re.lastIndex);
        const frag = src.slice(re.lastIndex, end < 0 ? src.length : end);
        out.push({ frag, folders: stack.slice() });
        if (end >= 0) re.lastIndex = end + "</placemark>".length;
        continue;
      }
      if (closing) { stack.pop(); continue; }
      if (selfClose) continue;
      /* A <Document>'s name is the file's name — "Tyler survey.kml" — which is
         not a statement about any ground. It still takes a slot on the stack
         so the closing tags balance, but it contributes nothing. */
      if (tag === "document") { stack.push(""); continue; }
      // A folder's own <name> is the first one before any child element.
      const head = src.slice(re.lastIndex, re.lastIndex + 400);
      const nm = /^[\s\S]*?<(?:\w+:)?name(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?name>/i.exec(head);
      stack.push(nm ? this.unescape(nm[1].trim()) : "");
    }
    return out;
  },

  /* ---------------------------------------------------------------- output */

  /** The one line in this file that swaps coordinate order. */
  feature(rings, props) {
    return {
      type: "Feature",
      properties: props,
      geometry: { type: "Polygon", coordinates: rings.map(r => {
        const out = r.slice();
        if (out.length && (out[0][0] !== out[out.length - 1][0] ||
                           out[0][1] !== out[out.length - 1][1])) out.push(out[0].slice());
        return out;
      }) }
    };
  },

  /**
   * A path, given a width, as a ring.
   *
   * Somebody tracing a creek in Google Earth draws a line, and a line has no
   * inside — which is the only question a region is ever asked. Both sides
   * are offset by half the width in a local metre frame.
   */
  bandAround(lngLat, widthM) {
    if (lngLat.length < 2) return null;
    const h = (+widthM || 20) / 2;
    const kx = 111320 * Math.cos(lngLat[0][1] * Math.PI / 180) || 1, ky = 110540;
    const P = lngLat.map(p => [p[0] * kx, p[1] * ky]);
    const left = [], right = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      left.push([P[i][0] - dy * h, P[i][1] + dx * h]);
      right.push([P[i][0] + dy * h, P[i][1] - dx * h]);
    }
    return left.concat(right.reverse()).map(p => [p[0] / kx, p[1] / ky]);
  },

  /**
   * KML text → a GeoJSON FeatureCollection this project can import.
   *
   *   opts.terrain     what to call anything the words do not identify
   *   opts.guess       read names and folders for a terrain (default true)
   *   opts.lineWidthM  0 to skip paths, otherwise how wide to make them
   *   opts.buildings   false to read everything as ground and skip pins
   *   opts.building    the name parser; defaults to `Buildings.parseName`
   */
  toGeoJSON(text, opts) {
    opts = opts || {};
    const fallback = opts.terrain || "wood";
    const guess = opts.guess !== false;
    const lineWidth = opts.lineWidthM == null ? 20 : +opts.lineWidthM;
    /* Injected rather than imported. This file is loaded on its own in a
       couple of places (tools/mapimport.js runs it in a bare sandbox), and a
       hard reference to Buildings would make the parser unusable there. */
    const parseBuilding = opts.buildings === false ? null
      : (opts.building || (typeof Buildings !== "undefined"
          ? Buildings.parseName.bind(Buildings) : null));
    const features = [];
    const skipped = { points: 0, empty: 0, lines: 0 };
    let buildings = 0;

    this.placemarks(text).forEach((pm, i) => {
      const name = this.tagText(pm.frag, "name");
      const desc = this.tagText(pm.frag, "description");
      const folder = pm.folders.filter(Boolean).join(" / ");
      const terrain = (guess && this.guessTerrain(name, folder, desc)) || fallback;
      let part = 0;

      /* Is this a building? Either the name says so outright, or it named a
         kind we know and was drawn as a pin — a pin is not ground, so there
         is nothing else it could usefully be. */
      const b = parseBuilding ? parseBuilding(name, folder) : null;
      const points = this.blocks(pm.frag, "Point");
      const isBuilding = !!b && (b.declared || (!!b.kind && points.length > 0));

      if (isBuilding) {
        const props = {
          feature: "building",
          name: b.name, kind: b.kind || "cottage",
          level: b.level || 1,
          radius: b.radiusM || 45,
          trades: [],                    // "" = whatever the kind does
          notes: [folder && "Folder: " + folder, desc].filter(Boolean).join(" — ").slice(0, 400),
          source: "kml", sourceId: "",
          active: true
        };
        let made = 0;
        points.forEach(pt => {
          const c = this.coords(this.tagText(pt, "coordinates"));
          if (!c.length) { skipped.empty++; return; }
          const p = Object.assign({}, props, { sourceId: "kml/bld/" + (name || "pin") + "/" + i + "/" + (made) });
          features.push({ type: "Feature", properties: p,
                          geometry: { type: "Point", coordinates: [c[0][0], c[0][1]] } });
          made++; buildings++;
        });
        /* Drawn as an outline instead of a pin: same building, with the
           outline kept as its footprint. */
        this.blocks(pm.frag, "Polygon").forEach(poly => {
          const outer = this.blocks(poly, "outerBoundaryIs")
            .map(r => this.ring(this.coords(this.tagText(r, "coordinates"))))
            .filter(r => r.length > 2);
          if (!outer.length) { skipped.empty++; return; }
          const p = Object.assign({}, props, { sourceId: "kml/bld/" + (name || "shape") + "/" + i + "/" + (made) });
          features.push(this.feature([outer[0]], p));
          made++; buildings++;
        });
        if (made) return;         // it was a building; it is not also ground
        skipped.empty++;
        return;
      }
      const props = () => ({
        name: name || folder || "Imported region",
        terrain: terrain,
        /* KML carries no stable identity, so this is the closest thing: the
           placemark's name, where it sat in the file, and which piece of a
           MultiGeometry it was. Re-importing an edited export then updates
           the same rows rather than doubling them. */
        source: "kml",
        sourceId: "kml/" + (name || "placemark") + "/" + i + "/" + (part++),
        notes: [folder && "Folder: " + folder, desc].filter(Boolean).join(" — ").slice(0, 400),
        priority: 0, difficulty: 0, spawnTableId: "", active: true
      });

      this.blocks(pm.frag, "Polygon").forEach(poly => {
        const outer = this.blocks(poly, "outerBoundaryIs")
          .map(b => this.ring(this.coords(this.tagText(b, "coordinates"))))
          .filter(r => r.length > 2);
        if (!outer.length) { skipped.empty++; return; }
        const holes = this.blocks(poly, "innerBoundaryIs")
          .map(b => this.ring(this.coords(this.tagText(b, "coordinates"))))
          .filter(r => r.length > 2);
        features.push(this.feature([outer[0]].concat(holes), props()));
      });

      this.blocks(pm.frag, "LineString").forEach(line => {
        const pts = this.coords(this.tagText(line, "coordinates"));
        if (pts.length < 2) { skipped.empty++; return; }
        if (!lineWidth) { skipped.lines++; return; }
        const band = this.bandAround(pts, lineWidth);
        if (!band) { skipped.empty++; return; }
        const p = props();
        p.notes = (p.notes ? p.notes + " — " : "") + "traced path, drawn " + lineWidth + " m wide";
        features.push(this.feature([band], p));
      });

      skipped.points += points.length;
    });

    return {
      type: "FeatureCollection",
      format: "stride-and-sword.regions",
      note: "Imported from KML. Coordinates are [lng, lat] as GeoJSON requires.",
      features,
      buildings,
      skipped
    };
  }
};
