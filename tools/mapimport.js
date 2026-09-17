#!/usr/bin/env node
"use strict";
/* ==========================================================================
   MAP IMPORT — turn a real town's water and green cover into game regions.

   Run this once for the place you actually walk around, then open the result
   in regions.html (or QGIS) and draw in everything the map does not know:
   the soil, the floodplain, the low ground behind the school.

       cd tools
       npm run map -- --place "Tyler, Texas"
       npm run map -- --bbox 32.25,-95.45,32.45,-95.15 --out ../data/regions.tyler.geojson
       npm run map -- --file saved-overpass.json        # no network at all
       npm run map -- --file survey.kml                 # straight out of Google Earth
       npm run map -- --file survey.kmz --terrain marsh

   WHY THIS IS A SCRIPT AND NOT A BUTTON

   It is a one-off job over a whole town — tens of megabytes of geometry and a
   couple of minutes of somebody else's server — and the game is a phone app
   that must never make a request that big. The editor's "import terrain here"
   button does the same classification for the screenful in front of you,
   through the app's own rate-limited cache. This is for the county.

   IT IS SOMEBODY ELSE'S SERVER

   One request at a time, spaced, with a real User-Agent, honouring 429 and
   Retry-After, and never failing over to another endpoint after being told to
   stop. Same rules as the app — see claude/osm-policy.md, which this file is
   held to as much as js/world/atlas.js is.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UA = 'stride-and-sword-mapimport/1.0 (personal walking game; one-off region import)';
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MIN_GAP_MS = 2000;          // never two queries closer than this
const MAX_RETRIES = 3;

/* ------------------------------------------------------------------ options */

function parseArgs(argv) {
  const o = {
    place: '', bbox: null, file: '', out: '../data/regions.geojson',
    terrain: 'wood',       // what KML shapes are, when their words do not say
    lineWidthM: 20,        // how wide a traced path becomes; 0 skips them
    guess: true,           // read KML names and folders for a terrain
    minAreaM2: 2000,       // smaller than this is a flowerbed, not a region
    simplifyM: 8,          // Douglas-Peucker tolerance on the ground
    riverWidth: 24, streamWidth: 8, canalWidth: 12,
    tiles: 2,              // split the bbox this many times per axis
    limit: 0, dryRun: false, quiet: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--place') o.place = next();
    else if (a === '--bbox') o.bbox = next().split(',').map(Number);
    else if (a === '--file') o.file = next();
    else if (a === '--out') o.out = next();
    else if (a === '--terrain') o.terrain = next();
    else if (a === '--line-width') o.lineWidthM = +next();
    else if (a === '--no-guess') o.guess = false;
    else if (a === '--min-area') o.minAreaM2 = +next();
    else if (a === '--simplify') o.simplifyM = +next();
    else if (a === '--river-width') o.riverWidth = +next();
    else if (a === '--tiles') o.tiles = Math.max(1, Math.min(6, +next()));
    else if (a === '--limit') o.limit = +next();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
  }
  return o;
}

const HELP = `
Stride & Sword — map import

  --place "Tyler, Texas"     look the place up and use its bounding box
  --bbox s,w,n,e             or give the box yourself
  --file overpass.json       skip the network; classify a saved response
  --file survey.kml|.kmz     convert a Google Earth export instead
  --terrain KEY              what unlabelled KML shapes are (default wood)
  --line-width M             width for a traced path in KML (20, 0 skips)
  --no-guess                 do not read KML names and folders for a terrain
  --out PATH                 where to write (default ../data/regions.geojson)
  --min-area M2              drop regions smaller than this (default 2000)
  --simplify M               corner tolerance in metres (default 8, 0 = off)
  --river-width M            how wide to make a river drawn as a line (24)
  --tiles N                  split the box N x N for the query (default 2)
  --limit N                  stop after N regions (for a quick look)
  --dry-run                  classify and count, write nothing
`;

/* ------------------------------------------------- the shared browser files
   js/world/regions.js and js/world/kml.js are browser files with no module
   system — which is the whole point of this project — so they are evaluated
   here in sandboxes with the handful of globals they expect. One classifier
   and one KML parser, two callers each, and no second copy of either to drift
   out of step with what the game and the editor actually do. */
/**
 * The browser's KML parser, in node.
 *
 * Buildings go into the same context first, because the parser asks
 * `Buildings.parseName` whether a placemark is a shopfront or a piece of
 * ground. Only the pure half of that module is reachable here — enough
 * globals to let it load, and a storage stub that holds nothing.
 */
function loadKml() {
  const sandbox = {
    console, TextDecoder,
    Store: { get: () => null, set: () => {}, patch: () => {} },
    Content: { pointInRing: () => false },
    nowTs: () => Date.now(),
    uid: (p) => p + '_' + Math.random().toString(36).slice(2, 10),
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    cap: (s) => (s ? s[0].toUpperCase() + s.slice(1) : s),
    seededRandom: () => () => 0.5,
    haversine, toRad
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/world/buildings.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/world/kml.js'), 'utf8') +
                  '\n;globalThis.__KML = KML;\n;globalThis.__Buildings = Buildings;', sandbox);
  const KML = sandbox.__KML;
  KML.Buildings = sandbox.__Buildings;
  return KML;
}

function loadRegions() {
  const src = fs.readFileSync(path.resolve(__dirname, '../js/world/regions.js'), 'utf8');
  const sandbox = {
    Store: { get: () => null, set: () => {} },
    Content: { pointInRing: () => false, get: () => null, list: () => [] },
    nowTs: () => Date.now(),
    uid: (p) => p + '_' + Math.random().toString(36).slice(2, 10),
    haversine, toRad, console
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__Regions = Regions;', sandbox);
  return sandbox.__Regions;
}

/* -------------------------------------------------------------- geo helpers */

function toRad(d) { return d * Math.PI / 180; }
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Metres per degree at a latitude — the local frame everything else works in. */
function frame(lat) {
  return { kx: 111320 * Math.cos(toRad(lat)), ky: 110540 };
}

function ringAreaM2(ring) {
  if (!ring || ring.length < 3) return 0;
  const lat = ring[0][0], f = frame(lat);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][1] * f.kx, yi = ring[i][0] * f.ky;
    const xj = ring[j][1] * f.kx, yj = ring[j][0] * f.ky;
    a += xj * yi - xi * yj;
  }
  return Math.abs(a / 2);
}

/**
 * Douglas-Peucker, in metres rather than degrees.
 *
 * Degrees would simplify a north-south edge nearly twice as hard as an
 * east-west one at this latitude, which shows up as lakes with flattened
 * sides. The local frame costs two multiplications and removes the problem.
 */
function simplify(points, toleranceM) {
  if (!toleranceM || points.length < 4) return points;
  const f = frame(points[0][0]);
  const P = points.map(p => [p[1] * f.kx, p[0] * f.ky]);
  const keep = new Array(P.length).fill(false);
  keep[0] = keep[P.length - 1] = true;

  const stack = [[0, P.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let far = -1, fd = toleranceM;
    const [x1, y1] = P[s], [x2, y2] = P[e];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = P[i];
      let d;
      if (!len2) d = Math.hypot(px - x1, py - y1);
      else {
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
        d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      }
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = true; stack.push([s, far], [far, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * A line as a polygon: offset both sides by half the width.
 *
 * A river in OSM is usually a line, and a line has no inside — but standing
 * "in the river" is exactly what the game needs to test. This is a plain
 * two-sided offset with mitre-free joins: good enough for a band of ground
 * twenty metres wide, and it never self-intersects badly enough to matter at
 * the scale a person walks.
 */
function bufferLine(points, widthM) {
  if (points.length < 2) return null;
  const h = widthM / 2;
  const f = frame(points[0][0]);
  const P = points.map(p => [p[1] * f.kx, p[0] * f.ky]);
  const left = [], right = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const nx = -dy * h, ny = dx * h;
    left.push([P[i][0] + nx, P[i][1] + ny]);
    right.push([P[i][0] - nx, P[i][1] - ny]);
  }
  const ring = left.concat(right.reverse());
  return ring.map(p => [p[1] / f.ky, p[0] / f.kx]);
}

/* ----------------------------------------------------------------- the wire */

let lastCall = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function spaced(fn) {
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fn();
}

async function overpass(query, log) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await spaced(() => fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': UA },
      body: query
    }));
    if (res.ok) return res.json();
    if (res.status === 429 || res.status === 504 || res.status === 503) {
      /* Being told to stop. Wait as long as we are told to, or a minute, and
         never move the load onto a different endpoint — that is not reducing
         it, it is relocating it onto another volunteer. */
      const after = +(res.headers.get('retry-after') || 0);
      const waitMs = Math.min(10 * 60000, (after ? after * 1000 : 60000) * attempt);
      log('  the map service asked us to wait ' + Math.round(waitMs / 1000) + 's (attempt ' + attempt + ')');
      await sleep(waitMs);
      continue;
    }
    throw new Error('Overpass answered ' + res.status + ' ' + (await res.text()).slice(0, 200));
  }
  throw new Error('Overpass kept asking us to wait. Try again later.');
}

async function lookupPlace(place, log) {
  const url = NOMINATIM + '?format=json&limit=1&q=' + encodeURIComponent(place);
  const res = await spaced(() => fetch(url, { headers: { 'User-Agent': UA } }));
  if (!res.ok) throw new Error('Nominatim answered ' + res.status);
  const rows = await res.json();
  if (!rows.length) throw new Error('Nowhere called "' + place + '" was found.');
  const bb = rows[0].boundingbox.map(Number);      // [south, north, west, east]
  log('  ' + rows[0].display_name);
  return [bb[0], bb[2], bb[1], bb[3]];             // → [s, w, n, e]
}

/** The query: everything that is ground cover, and nothing that is a building. */
function queryFor(s, w, n, e) {
  const box = [s, w, n, e].map(x => x.toFixed(6)).join(',');
  return `[out:json][timeout:180];
/* Stride & Sword — one-off region import for a personal walking game.
   https://github.com/ (local project) — contact via the app author. */
(
  way["natural"~"^(water|wetland|wood|scrub|heath|bare_rock|scree|sand|beach|mud|cliff)$"](${box});
  rel["natural"~"^(water|wetland|wood|scrub|heath)$"](${box});
  way["landuse"~"^(forest|meadow|grass|farmland|farmyard|orchard|vineyard|village_green|cemetery|allotments|recreation_ground|quarry|brownfield|landfill|reservoir|basin|industrial|railway)$"](${box});
  rel["landuse"~"^(forest|meadow|grass|farmland|orchard|recreation_ground|reservoir|quarry)$"](${box});
  way["leisure"~"^(park|garden|golf_course|pitch|nature_reserve|recreation_ground|dog_park|common)$"](${box});
  rel["leisure"~"^(park|nature_reserve|golf_course)$"](${box});
  way["waterway"~"^(river|stream|canal|riverbank|ditch|drain)$"](${box});
);
out geom;`;
}

/* ------------------------------------------------------- element → region(s) */

function ringsFromRelation(el) {
  /* Assemble a multipolygon's members into closed rings. Outer members come
     as open ways that have to be chained end to end; a lake with an island is
     two rings and the island is the hole. */
  const out = { outer: [], inner: [] };
  ['outer', 'inner'].forEach(role => {
    const open = (el.members || [])
      .filter(m => m.type === 'way' && (m.role || 'outer') === role && Array.isArray(m.geometry))
      .map(m => m.geometry.map(p => [p.lat, p.lon]));
    while (open.length) {
      let ring = open.shift();
      let joined = true;
      while (joined && (ring[0][0] !== ring[ring.length - 1][0] ||
                        ring[0][1] !== ring[ring.length - 1][1])) {
        joined = false;
        for (let i = 0; i < open.length; i++) {
          const w = open[i], head = ring[ring.length - 1];
          const same = (a, b) => a[0] === b[0] && a[1] === b[1];
          if (same(head, w[0])) { ring = ring.concat(w.slice(1)); open.splice(i, 1); joined = true; break; }
          if (same(head, w[w.length - 1])) { ring = ring.concat(w.slice(0, -1).reverse()); open.splice(i, 1); joined = true; break; }
        }
      }
      if (ring.length > 3) { ring.pop(); out[role].push(ring); }
    }
  });
  return out;
}

function regionsFrom(el, Regions, opts) {
  const tags = el.tags || {};
  const terrain = Regions.classify(tags);
  if (!terrain) return [];
  const name = tags.name || '';
  const mk = (rings, extra) => {
    const r = Regions.blank(terrain, rings);
    r.name = name || Regions.terrain(terrain).name;
    r.source = 'osm';
    r.sourceId = (el.type || 'way') + '/' + el.id;
    r.notes = extra || '';
    return r;
  };

  if (el.type === 'relation') {
    const { outer, inner } = ringsFromRelation(el);
    return outer.map(o => {
      const holes = inner.filter(h => ringAreaM2(h) < ringAreaM2(o));
      return mk([o].concat(holes).map(ring => simplify(ring, opts.simplifyM)));
    });
  }

  const geo = (el.geometry || []).filter(p => p && isFinite(p.lat) && isFinite(p.lon));
  if (geo.length < 2) return [];
  const pts = geo.map(p => [p.lat, p.lon]);
  const closed = pts.length > 3 &&
                 pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];

  if (closed) {
    pts.pop();
    return [mk([simplify(pts, opts.simplifyM)])];
  }
  // An open way: only water earns a width. A field boundary drawn as a line is
  // a fence, and fencing off the county is not what anybody wants.
  const ww = tags.waterway;
  if (!ww) return [];
  const width = ww === 'river' ? opts.riverWidth
              : ww === 'canal' ? opts.canalWidth
              : opts.streamWidth;
  const ring = bufferLine(simplify(pts, opts.simplifyM), width);
  if (!ring) return [];
  return [mk([ring], ww + ', drawn ' + width + ' m wide')];
}

/* --------------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(process.argv);
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  if (opts.help) { console.log(HELP); return 0; }

  const Regions = loadRegions();
  let elements = [];

  let kmlDoc = null;
  if (opts.file) {
    log('Reading ' + opts.file);
    const bytes = fs.readFileSync(opts.file);
    const KML = loadKml();
    /* What kind of file is this? Sniffed rather than trusted to its
       extension: a Google Earth export renamed .json is still a KML, and
       "that file is not JSON" would be a useless thing to say about it. */
    if (KML.isZip(bytes)) {
      const zlib = require('zlib');
      const text = await KML.unzipKmz(new Uint8Array(bytes),
                                      { inflateRaw: (b) => zlib.inflateRawSync(Buffer.from(b)) });
      kmlDoc = KML.toGeoJSON(text, opts);
    } else {
      const text = bytes.toString('utf8');
      if (/<\s*(\w+:)?kml[\s>]/i.test(text) || /<\s*(\w+:)?Placemark[\s>]/i.test(text)) {
        kmlDoc = KML.toGeoJSON(text, opts);
      } else {
        elements = (JSON.parse(text).elements) || [];
      }
    }
  } else {
    let box = opts.bbox;
    if (!box && opts.place) {
      log('Looking up "' + opts.place + '"…');
      box = await lookupPlace(opts.place, log);
    }
    if (!box || box.length !== 4 || box.some(x => !isFinite(x))) {
      console.error('Give me a --place or a --bbox s,w,n,e. --help for the rest.');
      return 2;
    }
    const [s, w, n, e] = box;
    log('Box: ' + [s, w, n, e].map(x => x.toFixed(4)).join(', ') +
        '  (' + Math.round(haversine(s, w, n, w) / 1000) + ' x ' +
        Math.round(haversine(s, w, s, e) / 1000) + ' km)');

    const t = opts.tiles;
    log('Querying Overpass in ' + (t * t) + ' tile' + (t * t === 1 ? '' : 's') +
        ', one at a time, ' + (MIN_GAP_MS / 1000) + 's apart…');
    for (let i = 0; i < t; i++) {
      for (let j = 0; j < t; j++) {
        const ts = s + (n - s) * i / t, tn = s + (n - s) * (i + 1) / t;
        const tw = w + (e - w) * j / t, te = w + (e - w) * (j + 1) / t;
        const doc = await overpass(queryFor(ts, tw, tn, te), log);
        const got = (doc.elements || []).length;
        elements = elements.concat(doc.elements || []);
        log('  tile ' + (i * t + j + 1) + '/' + (t * t) + ': ' + got + ' elements');
      }
    }
  }

  if (kmlDoc) {
    const counts = {};
    /* Two kinds of thing come out of one file. Buildings are separated first:
       they are not ground, they have no area to be under the minimum, and a
       pin's coordinates are a point rather than a ring — running the area
       filter over one throws. They are written to their own file beside the
       regions, because the game seeds them from their own file. */
    const bldFeatures = kmlDoc.features.filter(f => f.properties && f.properties.feature === "building");
    const kept = kmlDoc.features.filter(f => {
      if (f.properties && f.properties.feature === "building") return false;
      const ring = f.geometry.coordinates[0].map(c => [c[1], c[0]]);
      if (ringAreaM2(ring) < opts.minAreaM2) return false;
      counts[f.properties.terrain] = (counts[f.properties.terrain] || 0) + 1;
      return true;
    });
    const doc = {
      type: 'FeatureCollection',
      format: Regions.FORMAT, version: Regions.VERSION,
      exportedAt: new Date().toISOString(),
      note: 'Converted from a Google Earth KML by tools/mapimport.js. ' +
            'Open in regions.html to edit.',
      features: kept
    };
    log('');
    Object.keys(counts).sort().forEach(k => log('  ' + k.padEnd(8) + counts[k]));
    log('  ' + 'total'.padEnd(8) + kept.length + ' regions');
    const sk = kmlDoc.skipped || {};
    log('  skipped: ' + (sk.points || 0) + ' pins, ' + (sk.lines || 0) + ' paths, ' +
        (kmlDoc.features.length - kept.length) + ' under the minimum area');
    if (bldFeatures.length) log('  buildings: ' + bldFeatures.length + ' (written separately)');
    if (opts.dryRun) { log('\n--dry-run: nothing written.'); return 0; }
    const outK = path.resolve(process.cwd(), opts.out);
    fs.writeFileSync(outK, JSON.stringify(doc, null, 1));
    log('\nWrote ' + outK + '  (' + Math.round(fs.statSync(outK).size / 1024) + ' KB)');
    if (bldFeatures.length) {
      const outB = outK.replace(/(\.geojson|\.json)$/i, '') + '.buildings.geojson';
      fs.writeFileSync(outB, JSON.stringify({
        type: 'FeatureCollection',
        format: 'stride-and-sword.buildings', version: 1,
        exportedAt: new Date().toISOString(),
        note: 'Buildings converted from a Google Earth KML by tools/mapimport.js. ' +
              'Drop it on regions.html, or copy it to data/buildings.json.',
        features: bldFeatures
      }, null, 1));
      log('Wrote ' + outB + '  (' + bldFeatures.length + ' buildings)');
    }
    return 0;
  }

  log('Classifying ' + elements.length + ' elements…');
  const seen = {};
  const regions = [];
  const counts = {}, dropped = { small: 0, unclassified: 0, notGround: 0, duplicate: 0 };

  elements.forEach(el => {
    const id = (el.type || 'way') + '/' + el.id;
    if (seen[id]) { dropped.duplicate++; return; }       // tiles overlap at the seams
    seen[id] = 1;
    const made = regionsFrom(el, Regions, opts);
    if (!made.length) {
      if (Regions.classify(el.tags || {})) dropped.notGround++; else dropped.unclassified++;
      return;
    }
    made.forEach(r => {
      const area = ringAreaM2(r.rings[0]);
      if (area < opts.minAreaM2) { dropped.small++; return; }
      if (opts.limit && regions.length >= opts.limit) return;
      counts[r.terrain] = (counts[r.terrain] || 0) + 1;
      regions.push(r);
    });
  });

  const doc = {
    type: 'FeatureCollection',
    format: Regions.FORMAT, version: Regions.VERSION,
    exportedAt: new Date().toISOString(),
    note: 'Terrain regions imported from OpenStreetMap by tools/mapimport.js. ' +
          'Data © OpenStreetMap contributors, ODbL. Open in regions.html to edit.',
    features: regions.map(r => Regions.toFeature(r))
  };

  log('');
  Object.keys(counts).sort().forEach(k => log('  ' + k.padEnd(8) + counts[k]));
  log('  ' + 'total'.padEnd(8) + regions.length + ' regions');
  log('  dropped: ' + dropped.small + ' too small, ' + dropped.unclassified +
      ' not ground cover, ' + dropped.notGround + ' unusable geometry, ' +
      dropped.duplicate + ' seen twice');

  if (opts.dryRun) { log('\n--dry-run: nothing written.'); return 0; }
  const out = path.resolve(process.cwd(), opts.out);
  fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  log('\nWrote ' + out + '  (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
  log('Open regions.html → Export / Import → pick that file, or drop it in as data/regions.json.');
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code || 0))
        .catch(err => { console.error('\n' + (err && err.message || err)); process.exit(1); });
}
module.exports = { parseArgs, simplify, bufferLine, ringAreaM2, regionsFrom, loadRegions,
                   loadKml, ringsFromRelation, queryFor };
