"use strict";
/* -------------------------------------------------------------------------
   11b. Grid — the two grids the world is generated on.

     local chunks   500 m   locations and dungeons
     regions       2000 m   instances only

   Two grids rather than one because the two things keep different time. A
   location churns hourly and a dungeon every few hours, so they belong to a
   cell small enough that walking through it is an event. An instance should
   still be there tomorrow, so tying its life to a 500 m square you happened to
   cross would throw it away for no reason.

   WHY THE LONGITUDE STEP IS NOT CONSTANT

   A degree of latitude is about 110.5 km everywhere. A degree of longitude is
   111.3 km at the equator and nothing at all at the pole. Quantising both by
   the same number of degrees gives cells that are square in Chicago and
   letterbox-shaped in Reykjavik.

   So latitude quantises uniformly, and the longitude step is computed per
   **latitude band** as latStep / cos(lat). Within one band every cell is the
   same size; crossing a band shifts the longitude grid very slightly, which at
   500 m is a few metres and invisible. The alternative — a fixed degree step —
   is simpler to write and wrong everywhere but one latitude.

   Keys are local to this database. Nothing needs them to agree across devices,
   which is what lets the band trick be good enough.
   ------------------------------------------------------------------------- */
const Grid = {
  CHUNK_M: 500,
  REGION_M: 2000,

  /** Metres per degree of latitude. Near enough constant to treat as one. */
  M_PER_DEG_LAT: 110540,

  /** Degrees of latitude for a cell of this size. */
  latStep(sizeM) { return sizeM / this.M_PER_DEG_LAT; },

  /**
   * Degrees of longitude for a cell of this size, at this latitude band.
   * Clamped near the poles, where cos(lat) heads for zero and the step would
   * otherwise run away to infinity.
   */
  lngStep(sizeM, latIndex) {
    const step = this.latStep(sizeM);
    const bandLat = (latIndex + 0.5) * step;
    const c = Math.max(0.05, Math.cos(toRad(bandLat)));
    return step / c;
  },

  /** Which cell of this size holds this point? */
  cellAt(lat, lng, sizeM) {
    const ls = this.latStep(sizeM);
    const latIndex = Math.floor(lat / ls);
    const gs = this.lngStep(sizeM, latIndex);
    const lngIndex = Math.floor(lng / gs);
    return this.cell(latIndex, lngIndex, sizeM);
  },

  /** The cell at these indices, with its bounds and centre worked out. */
  cell(latIndex, lngIndex, sizeM) {
    const ls = this.latStep(sizeM);
    const gs = this.lngStep(sizeM, latIndex);
    const south = latIndex * ls, north = south + ls;
    const west = lngIndex * gs, east = west + gs;
    return {
      key: (sizeM === this.REGION_M ? "r" : "c") + latIndex + "_" + lngIndex,
      sizeM, latIndex, lngIndex,
      south, north, west, east,
      latitude: (south + north) / 2,
      longitude: (west + east) / 2,
      /* Half the diagonal: the radius of a circle that covers the square, which
         is what a survey has to reach and what a chunk-zone's radius becomes. */
      coverM: Math.round(sizeM * Math.SQRT2 / 2)
    };
  },

  chunkAt(lat, lng) { return this.cellAt(lat, lng, this.CHUNK_M); },
  regionAt(lat, lng) { return this.cellAt(lat, lng, this.REGION_M); },

  /** Parse a key back into its cell. Returns null for anything unrecognised. */
  fromKey(key) {
    const m = /^([cr])(-?\d+)_(-?\d+)$/.exec(String(key || ""));
    if (!m) return null;
    return this.cell(+m[2], +m[3], m[1] === "r" ? this.REGION_M : this.CHUNK_M);
  },

  contains(cell, lat, lng) {
    return lat >= cell.south && lat < cell.north && lng >= cell.west && lng < cell.east;
  },

  /**
   * Metres from a point to the nearest edge of a cell; 0 when inside it.
   *
   * This is what decides which neighbours are worth generating: standing near
   * an edge, the cell next door is within sight even though you are not in it,
   * and a blank strip at the edge of vision would be obvious.
   */
  distanceTo(cell, lat, lng) {
    if (this.contains(cell, lat, lng)) return 0;
    const clampedLat = clamp(lat, cell.south, cell.north);
    const clampedLng = clamp(lng, cell.west, cell.east);
    return haversine(lat, lng, clampedLat, clampedLng);
  },

  /**
   * Every cell of this size whose nearest edge is within `radiusM`, the one
   * you are standing in first. Walks outward ring by ring and stops when a
   * whole ring is out of range, so it costs a handful of checks rather than a
   * scan of anything.
   */
  cellsWithin(lat, lng, radiusM, sizeM) {
    const home = this.cellAt(lat, lng, sizeM);
    const out = [home];
    const maxRing = Math.max(1, Math.ceil(radiusM / sizeM) + 1);
    for (let ring = 1; ring <= maxRing; ring++) {
      let anyInRange = false;
      for (let dLat = -ring; dLat <= ring; dLat++) {
        for (let dLng = -ring; dLng <= ring; dLng++) {
          // Only the edge of this ring; the inside was covered already.
          if (Math.max(Math.abs(dLat), Math.abs(dLng)) !== ring) continue;
          const c = this.cell(home.latIndex + dLat, home.lngIndex + dLng, sizeM);
          if (this.distanceTo(c, lat, lng) > radiusM) continue;
          out.push(c);
          anyInRange = true;
        }
      }
      if (!anyInRange) break;
    }
    return out;
  },

  chunksWithin(lat, lng, radiusM) { return this.cellsWithin(lat, lng, radiusM, this.CHUNK_M); },

  /** A random point inside a cell, inset so nothing lands exactly on an edge. */
  pointIn(cell, rnd, insetFraction) {
    const r = rnd || Math.random;
    const f = insetFraction == null ? 0.06 : insetFraction;
    const dLat = (cell.north - cell.south), dLng = (cell.east - cell.west);
    return {
      latitude: cell.south + dLat * (f + r() * (1 - 2 * f)),
      longitude: cell.west + dLng * (f + r() * (1 - 2 * f))
    };
  }
};
