/* Regions: the ground, what it spawns, and the file it travels in.

   Three things are being checked, and they fail in different ways:

     · **the geometry** — a point is in a marsh or it is not, holes are holes,
       and the pond inside the park wins without anybody setting a number
     · **the game** — a site standing in a region rolls that region's monsters,
       and the bestiary is biome-shaped enough for that to be visible
     · **the file** — GeoJSON in [lng, lat], read back identically, and
       readable by anything else that reads GeoJSON

   The importer gets its own section at the end, run against a canned Overpass
   response rather than the network: it is the one piece of this project that
   would otherwise need somebody else's server to test. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { serve, BASE } = require('./serve');
const { mockOverpass } = require('./mock-osm');

/**
 * The newest toast, and a way to clear them first.
 *
 * Toasts stack, and `querySelector` returns the oldest — which had three of
 * the assertions below reading a message from a step two tests earlier.
 */
async function clearToasts(page) {
  await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
}
async function lastToast(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll('#toasts .toast');
    return all.length ? all[all.length - 1].textContent : '';
  });
}

/** The browser's KML parser, loaded in node the way mapimport.js loads it. */
function MI_KML() { return require('./mapimport.js').loadKml(); }

const GAME_URL    = BASE + '/index.html';
const REGIONS_URL = BASE + '/regions.html';
const LEAFLET_JS  = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

const HOME = { latitude: 41.8827, longitude: -87.6233 };

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

async function newPage(browser, opts) {
  const ctx = await browser.newContext(Object.assign({
    viewport: { width: 1400, height: 900 },
    geolocation: { latitude: HOME.latitude, longitude: HOME.longitude },
    permissions: ['geolocation']
  }, opts));
  const page = await ctx.newPage();
  /* No emptyDatabase here on purpose: it declares content_spawns empty, and
     the spawn tables are the thing under test. The seeded sample world coming
     with them is harmless — every assertion below names the node it rolls. */
  await page.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await page.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  await page.route('**fonts.googleapis.com/**', r => r.abort());
  await page.route('**/api/interpreter', r => {
    const m = /around:[\d.]+,(-?[\d.]+),(-?[\d.]+)/.exec(decodeURIComponent(r.request().postData() || ''));
    r.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify(mockOverpass(m ? +m[1] : HOME.latitude, m ? +m[2] : HOME.longitude)) });
  });
  return { ctx, page };
}

(async () => {
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ==================================================== THE BESTIARY ===== */
  console.log('\n===== A BESTIARY WITH BIOMES IN IT =====');
  const { ctx: c0, page: g } = await newPage(browser, { viewport: { width: 430, height: 900 } });
  const errors = [];
  g.on('pageerror', e => errors.push(e.message));
  g.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });

  await g.goto(GAME_URL);
  await g.waitForSelector('#tReg', { timeout: 8000 });
  await g.click('#tReg');
  await g.fill('#rgUser', 'ranger'); await g.fill('#rgPass', 'walk1234');
  await g.click('#rgGo');
  await g.waitForSelector('.stepBar', { timeout: 6000 });
  await g.click('.pickGrid .pick:nth-child(1)'); await g.click('#next');
  await g.click('.pickGrid .pick:nth-child(1)'); await g.click('#next');
  for (let i = 0; i < 40; i++) {
    const l = parseInt(await g.textContent('#ptsLeft'), 10); if (!l) break;
    const b = await g.$('.stepper[data-inc]:not([disabled])'); if (!b) break; await b.click();
  }
  await g.click('#next'); await g.fill('#cName', 'Bram Ashwalk'); await g.click('#next');
  await g.waitForSelector('#map', { timeout: 6000 });
  await g.waitForFunction(() => SS.Loc.last && SS.Content.list('monsters').length, null, { timeout: 30000 }).catch(() => {});
  await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));

  await step('nothing in the bestiary works in an office any more', async () => {
    const r = await g.evaluate(() => {
      const names = SS.Content.list('monsters').map(m => m.name)
        .concat(SS.Content.list('loot').map(l => l.name))
        .concat(SS.Content.list('items').map(i => i.name))
        .concat(SS.Content.list('spawns').map(s => s.name));
      const office = /office|stapler|copier|cubicle|fluorescent|break.?room|vending|quarterly|skyway|facilities|intern|stairwell|parking|coffee|filing|ledger of small/i;
      return { offenders: names.filter(n => office.test(n)), monsters: SS.Content.list('monsters').length };
    });
    if (r.offenders.length) throw new Error('still office-themed: ' + r.offenders.join(', '));
    if (r.monsters < 24) throw new Error('only ' + r.monsters + ' monsters');
    return r.monsters + ' monsters, nothing named after a photocopier';
  });

  await step('every terrain has a spawn table with monsters in it', async () => {
    const r = await g.evaluate(() => {
      const out = [];
      SS.Regions.TERRAINS.forEach(t => {
        const table = SS.Content.get('spawns', t.table);
        out.push({ terrain: t.key, table: t.table, n: table ? table.monsters.length : 0,
                   weights: table ? table.weights.length : 0,
                   known: table ? table.monsters.filter(id => SS.Content.get('monsters', id)).length : 0 });
      });
      return out;
    });
    const bad = r.filter(x => !x.n || x.n !== x.known || x.n !== x.weights);
    if (bad.length) throw new Error('broken tables: ' + JSON.stringify(bad));
    return r.length + ' terrains, ' + r.reduce((n, x) => n + x.n, 0) + ' entries, all resolving';
  });

  await step('the built-in fallback bestiary is fantasy too', async () => {
    // It only shows up when the content database is empty, which is exactly
    // when a fresh install is being looked at for the first time.
    const r = await g.evaluate(() => {
      const node = { nodeId: 'x', type: 'combat', difficulty: 3, latitude: SS.Loc.last.latitude,
                     longitude: SS.Loc.last.longitude };
      return SS.Bestiary.packFromBuiltins(node, 3).map(e => e.name);
    });
    if (!r.length) throw new Error('the fallback produced nothing');
    if (/office|stapler|copier|corridor|break/i.test(r.join(' '))) throw new Error('office fallback: ' + r.join(', '));
    return r.join(', ');
  });

  /* ================================================== THE GEOMETRY ======= */
  console.log('\n===== THE GROUND ITSELF =====');

  await step('a point is inside a region, and a hole is not inside it', async () => {
    const r = await g.evaluate(() => {
      SS.Regions.clear();
      const p = SS.Loc.last, d = 0.0015, h = 0.0003;
      const outer = [[p.latitude - d, p.longitude - d], [p.latitude - d, p.longitude + d],
                     [p.latitude + d, p.longitude + d], [p.latitude + d, p.longitude - d]];
      const hole = [[p.latitude - h, p.longitude - h], [p.latitude - h, p.longitude + h],
                    [p.latitude + h, p.longitude + h], [p.latitude + h, p.longitude - h]];
      const fen = SS.Regions.blank('marsh', [outer, hole]);
      fen.name = 'The Long Fen';
      SS.Regions.save(fen);
      const edgeIn = { lat: p.latitude + d * 0.8, lng: p.longitude };
      return {
        centre: SS.Regions.contains(fen, p.latitude, p.longitude),
        inside: SS.Regions.contains(fen, edgeIn.lat, edgeIn.lng),
        outside: SS.Regions.contains(fen, p.latitude + d * 1.5, p.longitude),
        terrainInHole: SS.Regions.terrainAt(p.latitude, p.longitude),
        terrainInside: SS.Regions.terrainAt(edgeIn.lat, edgeIn.lng)
      };
    });
    if (r.centre) throw new Error('the hole is being treated as inside');
    if (!r.inside) throw new Error('a point plainly inside reads as outside');
    if (r.outside) throw new Error('a point outside reads as inside');
    if (r.terrainInHole !== 'town') throw new Error('the hole says "' + r.terrainInHole + '"');
    if (r.terrainInside !== 'marsh') throw new Error('inside says "' + r.terrainInside + '"');
    return 'inside marsh, hole falls through to built-up';
  });

  await step('the smaller region wins where two overlap', async () => {
    const r = await g.evaluate(() => {
      SS.Regions.clear();
      const p = SS.Loc.last;
      const box = (d) => [[p.latitude - d, p.longitude - d], [p.latitude - d, p.longitude + d],
                          [p.latitude + d, p.longitude + d], [p.latitude + d, p.longitude - d]];
      const park = SS.Regions.blank('meadow', [box(0.002)]); park.name = 'The Commons';
      const pond = SS.Regions.blank('water', [box(0.0004)]); pond.name = 'The Pond';
      SS.Regions.save(park); SS.Regions.save(pond);
      const bySize = SS.Regions.at(p.latitude, p.longitude).name;
      // And an explicit priority beats size, for when size is the wrong answer.
      park.priority = 5; SS.Regions.save(park);
      const byPriority = SS.Regions.at(p.latitude, p.longitude).name;
      const both = SS.Regions.allAt(p.latitude, p.longitude).map(x => x.name);
      return { bySize, byPriority, both };
    });
    if (r.bySize !== 'The Pond') throw new Error('size tie-break gave "' + r.bySize + '"');
    if (r.byPriority !== 'The Commons') throw new Error('priority did not win: "' + r.byPriority + '"');
    if (r.both.length !== 2) throw new Error('allAt returned ' + r.both.length);
    return 'pond by size, park by priority, both listed';
  });

  await step('a hidden region decides nothing', async () => {
    const r = await g.evaluate(() => {
      const p = SS.Loc.last;
      const rows = SS.Regions.all();
      rows.forEach(x => { x.active = false; SS.Regions.save(x); });
      const off = SS.Regions.at(p.latitude, p.longitude);
      rows.forEach(x => { x.active = true; SS.Regions.save(x); });
      const on = SS.Regions.at(p.latitude, p.longitude);
      return { off: off && off.name, on: on && on.name, listed: SS.Regions.list(true).length };
    });
    if (r.off) throw new Error('a hidden region still decided: ' + r.off);
    if (!r.on) throw new Error('turning it back on did not restore it');
    return 'hidden regions are out of the lookup, still in the file';
  });

  /* ================================================== IN THE GAME ======== */
  console.log('\n===== WHAT THE GROUND SPAWNS =====');

  await step('a site in a marsh fights marsh things', async () => {
    const r = await g.evaluate(() => {
      SS.Regions.clear();
      const p = SS.Loc.last, d = 0.002;
      const box = [[p.latitude - d, p.longitude - d], [p.latitude - d, p.longitude + d],
                   [p.latitude + d, p.longitude + d], [p.latitude + d, p.longitude - d]];
      const fen = SS.Regions.blank('marsh', [box]); fen.name = 'The Long Fen';
      SS.Regions.save(fen);
      const marshNames = SS.Content.get('spawns', 'sp_marsh').monsters
        .map(id => SS.Content.get('monsters', id).name);
      const node = { nodeId: 'n1', type: 'combat', difficulty: 4,
                     latitude: p.latitude, longitude: p.longitude };
      const seen = {};
      for (let i = 0; i < 40; i++) {
        SS.Bestiary.packFor(node, 5).forEach(e => { seen[e.name] = (seen[e.name] || 0) + 1; });
      }
      const names = Object.keys(seen);
      return { names, marshNames, foreign: names.filter(n => marshNames.indexOf(n) < 0),
               table: SS.Regions.tableAt(p.latitude, p.longitude) };
    });
    if (r.table !== 'sp_marsh') throw new Error('the marsh resolved to "' + r.table + '"');
    if (!r.names.length) throw new Error('forty rolls produced nothing');
    if (r.foreign.length) throw new Error('not from the marsh: ' + r.foreign.join(', '));
    return '40 rolls, all from the fen: ' + r.names.join(', ');
  });

  await step('the same site on dry ground fights something else', async () => {
    const r = await g.evaluate(() => {
      const p = SS.Loc.last;
      const far = { lat: p.latitude + 0.02, lng: p.longitude + 0.02 };   // outside every region
      const node = { nodeId: 'n2', type: 'combat', difficulty: 4, latitude: far.lat, longitude: far.lng };
      const marsh = SS.Content.get('spawns', 'sp_marsh').monsters
        .map(id => SS.Content.get('monsters', id).name);
      const seen = {};
      for (let i = 0; i < 40; i++) {
        SS.Bestiary.packFor(node, 5).forEach(e => { seen[e.name] = 1; });
      }
      const names = Object.keys(seen);
      return { names, onlyMarsh: names.every(n => marsh.indexOf(n) >= 0),
               table: SS.Regions.tableAt(far.lat, far.lng) };
    });
    if (r.table) throw new Error('unmapped ground claimed table "' + r.table + '"');
    if (!r.names.length) throw new Error('nothing rolled off-region');
    if (r.onlyMarsh) throw new Error('off-region rolls are still all marsh: ' + r.names.join(', '));
    return 'off-region rolls span ' + r.names.length + ' monsters from the ordinary pick';
  });

  await step('a region can name its own table and nudge the difficulty', async () => {
    const r = await g.evaluate(() => {
      const p = SS.Loc.last;
      const reg = SS.Regions.at(p.latitude, p.longitude);
      reg.spawnTableId = 'sp_rock';
      reg.difficulty = 2;
      SS.Regions.save(reg);
      const rock = SS.Content.get('spawns', 'sp_rock').monsters
        .map(id => SS.Content.get('monsters', id).name);
      const node = { nodeId: 'n3', type: 'combat', difficulty: 4,
                     latitude: p.latitude, longitude: p.longitude };
      const seen = {};
      for (let i = 0; i < 30; i++) SS.Bestiary.packFor(node, 5).forEach(e => { seen[e.name] = 1; });
      const out = { table: SS.Regions.tableAt(p.latitude, p.longitude),
                    bump: SS.Regions.difficultyAt(p.latitude, p.longitude),
                    names: Object.keys(seen), foreign: Object.keys(seen).filter(n => rock.indexOf(n) < 0) };
      reg.spawnTableId = ''; reg.difficulty = 0; SS.Regions.save(reg);
      return out;
    });
    if (r.table !== 'sp_rock') throw new Error('the override did not take: ' + r.table);
    if (r.bump !== 2) throw new Error('difficulty nudge reads ' + r.bump);
    if (r.foreign.length) throw new Error('not from the scarp: ' + r.foreign.join(', '));
    return 'overridden to the scarp at +2 difficulty';
  });

  await step('a region naming a table nobody wrote falls through, it does not break', async () => {
    const r = await g.evaluate(() => {
      const p = SS.Loc.last;
      const reg = SS.Regions.at(p.latitude, p.longitude);
      reg.spawnTableId = 'sp_does_not_exist';
      SS.Regions.save(reg);
      const node = { nodeId: 'n4', type: 'combat', difficulty: 4,
                     latitude: p.latitude, longitude: p.longitude };
      const pack = SS.Bestiary.packFor(node, 5);
      const out = { table: SS.Regions.tableAt(p.latitude, p.longitude), pack: pack.map(e => e.name) };
      reg.spawnTableId = ''; SS.Regions.save(reg);
      return out;
    });
    if (r.table) throw new Error('a missing table was handed out anyway: ' + r.table);
    if (!r.pack.length) throw new Error('the encounter came out empty');
    return 'fell through to the ordinary pick: ' + r.pack.join(', ');
  });

  await step('the map draws the ground, and says what you are standing on', async () => {
    const r = await g.evaluate(() => {
      const drawn = SS.Game.drawRegions();
      SS.Game.toggleSiteList(true);
      SS.Game.renderSiteList(true);
      const here = SS.Game.terrainHere();
      const ground = document.querySelector('.slGround');
      const layers = SS.Game.regionLayer.getLayers().length;
      saveSettings({ showRegions: false });
      const off = SS.Game.drawRegions();
      saveSettings({ showRegions: true });
      return { drawn, layers, off, label: here && here.label,
               ground: ground && ground.textContent.replace(/\s+/g, ' ').trim() };
    });
    if (!r.drawn || !r.layers) throw new Error('nothing drawn');
    if (r.off) throw new Error('turning them off still drew ' + r.off);
    if (!/Fen|Commons|Pond/.test(r.ground || '')) throw new Error('the sidebar does not name the ground: ' + r.ground);
    return r.drawn + ' drawn, sidebar says "' + r.ground + '"';
  });

  if (errors.length) { fail++; console.log('  FAIL game page errors — ' + errors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the game'); }
  await c0.close();

  /* ===================================================== THE FILE ======== */
  console.log('\n===== THE FILE =====');
  const { ctx: c1, page: e } = await newPage(browser);
  const eErrors = [];
  e.on('pageerror', x => eErrors.push(x.message));
  e.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) eErrors.push(m.text()); });
  await e.goto(REGIONS_URL);
  await e.waitForSelector('#map', { timeout: 8000 });
  await e.waitForTimeout(1200);

  await step('drawing a region on the map stores it', async () => {
    const box = await (await e.$('#map')).boundingBox();
    await e.click('#reTools button[data-tool="draw"]');
    for (const [dx, dy] of [[-140, -90], [140, -90], [140, 90], [-140, 90]]) {
      await e.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    }
    await e.keyboard.press('Enter');
    await e.waitForTimeout(350);
    const r = await e.evaluate(() => ({
      n: RE.Regions.all().length, selected: !!RE.Re.selected,
      rows: document.querySelectorAll('#reTableWrap tbody tr').length,
      form: !!document.querySelector('#f_terrain'),
      legend: document.querySelectorAll('.reLeg').length
    }));
    if (r.n !== 1) throw new Error(r.n + ' regions after drawing one');
    if (!r.selected || !r.form) throw new Error('it did not select what was drawn');
    if (r.rows !== 1) throw new Error('the table shows ' + r.rows);
    if (r.legend !== 8) throw new Error(r.legend + ' terrains in the legend');
    return 'drawn, selected, listed, ' + r.legend + ' terrains offered';
  });

  await step('a hole is cut by drawing inside the region', async () => {
    await e.selectOption('#f_terrain', 'marsh');
    await e.fill('#f_name', 'The Long Fen');
    await e.waitForTimeout(250);
    const box = await (await e.$('#map')).boundingBox();
    await e.click('#reTools button[data-tool="hole"]');
    for (const [dx, dy] of [[-40, -30], [40, -30], [40, 30], [-40, 30]]) {
      await e.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    }
    await e.keyboard.press('Enter');
    await e.waitForTimeout(350);
    const r = await e.evaluate(() => {
      const reg = RE.Regions.all()[0];
      const c = RE.Regions.centroid(reg);
      return { rings: reg.rings.length, name: reg.name, terrain: reg.terrain,
               inHole: RE.Regions.contains(reg, c.latitude, c.longitude),
               tool: RE.Re.mode };
    });
    if (r.rings !== 2) throw new Error(r.rings + ' rings after cutting a hole');
    if (r.inHole) throw new Error('the hole is still inside the region');
    if (r.name !== 'The Long Fen' || r.terrain !== 'marsh') throw new Error('the form did not write through');
    if (r.tool !== 'select') throw new Error('it stayed in hole mode');
    return '2 rings, the middle is out, back on the select tool';
  });

  await step('export is GeoJSON that anything can read', async () => {
    const r = await e.evaluate(() => {
      const doc = RE.Regions.export();
      const f = doc.features[0];
      const outer = f.geometry.coordinates[0];
      return {
        type: doc.type, ftype: f.type, gtype: f.geometry.type,
        rings: f.geometry.coordinates.length,
        closed: outer[0][0] === outer[outer.length - 1][0] && outer[0][1] === outer[outer.length - 1][1],
        first: outer[0], props: Object.keys(f.properties).sort()
      };
    });
    if (r.type !== 'FeatureCollection' || r.ftype !== 'Feature' || r.gtype !== 'Polygon') {
      throw new Error('not GeoJSON: ' + JSON.stringify(r));
    }
    if (!r.closed) throw new Error('the ring is not closed, which most readers reject');
    // [lng, lat] — the single most common way to produce a map of the wrong hemisphere.
    if (!(r.first[0] < -60 && r.first[1] > 20)) throw new Error('coordinates look like [lat,lng]: ' + r.first);
    ['name', 'terrain', 'spawnTableId', 'priority', 'difficulty'].forEach(k => {
      if (r.props.indexOf(k) < 0) throw new Error('no "' + k + '" property');
    });
    return r.rings + ' rings, closed, [lng,lat], ' + r.props.length + ' properties';
  });

  await step('re-importing our own export changes nothing', async () => {
    const r = await e.evaluate(() => {
      const before = RE.Regions.all();
      const doc = JSON.parse(JSON.stringify(RE.Regions.export()));
      const res = RE.Regions.import(doc, false);
      const after = RE.Regions.all();
      const same = JSON.stringify(before.map(x => [x.regionId, x.name, x.terrain, x.rings])) ===
                   JSON.stringify(after.map(x => [x.regionId, x.name, x.terrain, x.rings]));
      return { res, n: after.length, same };
    });
    if (r.n !== 1) throw new Error('a round trip turned 1 region into ' + r.n);
    if (r.res.added) throw new Error(r.res.added + ' added on a re-import');
    if (!r.same) throw new Error('the geometry changed on the way round');
    return 'updated in place, geometry identical';
  });

  await step('a foreign GeoJSON file imports, lines and points are refused', async () => {
    const r = await e.evaluate(() => {
      const foreign = {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { name: 'Someone Else\'s Wood', terrain: 'wood' },
            geometry: { type: 'Polygon', coordinates: [[[-87.61, 41.89], [-87.60, 41.89],
                                                        [-87.60, 41.90], [-87.61, 41.90], [-87.61, 41.89]]] } },
          { type: 'Feature', properties: { name: 'A Path' },
            geometry: { type: 'LineString', coordinates: [[-87.62, 41.88], [-87.61, 41.89]] } },
          { type: 'Feature', properties: { name: 'A Bench' },
            geometry: { type: 'Point', coordinates: [-87.62, 41.88] } }
        ]
      };
      const res = RE.Regions.import(foreign, false);
      const wood = RE.Regions.all().find(x => x.name === "Someone Else's Wood");
      return { res, n: RE.Regions.all().length,
               inside: wood ? RE.Regions.contains(wood, 41.895, -87.605) : false,
               terrain: wood && wood.terrain, source: wood && wood.source };
    });
    if (!r.res.success) throw new Error(r.res.message);
    if (r.res.added !== 1) throw new Error(r.res.added + ' features became regions — the line or the point got in');
    if (!r.inside) throw new Error('the imported polygon does not contain its own middle');
    if (r.source !== 'import') throw new Error('source reads "' + r.source + '"');
    return '1 polygon in, the line and the point refused';
  });

  await step('a MultiPolygon becomes one region per part', async () => {
    const r = await e.evaluate(() => {
      const doc = { type: 'Feature', properties: { name: 'Two Ponds', terrain: 'water' },
        geometry: { type: 'MultiPolygon', coordinates: [
          [[[-87.64, 41.87], [-87.63, 41.87], [-87.63, 41.88], [-87.64, 41.88], [-87.64, 41.87]]],
          [[[-87.66, 41.87], [-87.65, 41.87], [-87.65, 41.88], [-87.66, 41.88], [-87.66, 41.87]]]
        ] } };
      const made = RE.Regions.fromFeature(doc);
      return { n: made.length, ids: new Set(made.map(x => x.regionId)).size,
               terrains: made.map(x => x.terrain) };
    });
    if (r.n !== 2) throw new Error('a two-part MultiPolygon made ' + r.n + ' regions');
    if (r.ids !== 2) throw new Error('both parts share an id');
    if (r.terrains.join() !== 'water,water') throw new Error('terrain lost: ' + r.terrains);
    return '2 parts, 2 ids, both water';
  });

  await step('importing the terrain around here reads the real map', async () => {
    const before = await e.evaluate(() => RE.Regions.all().length);
    await e.evaluate(() => RE.Re.map.setView([41.8827, -87.6233], 16));
    await e.waitForTimeout(400);
    await e.click('#reImport');
    await e.waitForFunction(() => !RE.Re.busy, null, { timeout: 40000 }).catch(() => {});
    await e.waitForTimeout(600);
    const r = await e.evaluate(() => {
      const osm = RE.Regions.all().filter(x => x.source === 'osm');
      return { n: RE.Regions.all().length, osm: osm.length,
               named: osm.filter(x => x.sourceId).length,
               terrains: Array.from(new Set(osm.map(x => x.terrain))),
               anyBuilding: osm.some(x => /building/i.test(x.notes || '')) };
    });
    if (r.osm < 1) throw new Error('nothing imported from the map data');
    if (r.named !== r.osm) throw new Error('imported regions without an OSM id');
    return r.osm + ' regions from the map: ' + r.terrains.join(', ');
  });

  await step('importing twice does not double anything', async () => {
    const before = await e.evaluate(() => RE.Regions.all().length);
    await e.click('#reImport');
    await e.waitForFunction(() => !RE.Re.busy, null, { timeout: 40000 }).catch(() => {});
    await e.waitForTimeout(500);
    const after = await e.evaluate(() => RE.Regions.all().length);
    if (after !== before) throw new Error(before + ' → ' + after + ' on a second import');
    return before + ' regions, unchanged';
  });

  /* ================================================== GOOGLE EARTH ======= */
  console.log('\n===== A GOOGLE EARTH EXPORT =====');
  const KML_FILE = path.resolve(__dirname, 'fixtures-google-earth.kml');
  const KMZ_FILE = path.resolve(__dirname, 'fixtures-google-earth.kmz');

  await step('a .kml dropped into the editor becomes regions', async () => {
    const before = await e.evaluate(() => { RE.Regions.clear(); return 0; });
    await clearToasts(e);
    await e.click('#reFile');
    await e.waitForTimeout(250);
    await e.setInputFiles('#reUp', KML_FILE);
    await e.waitForTimeout(1200);
    const r = await e.evaluate(() => ({
      n: RE.Regions.all().length,
      names: RE.Regions.all().map(x => x.name),
      sources: Array.from(new Set(RE.Regions.all().map(x => x.source))),
      modalGone: !document.querySelector('.modalBack')
    }));
    r.toast = await lastToast(e);
    if (r.n !== 6) throw new Error(r.n + ' regions from the fixture, expected 6');
    if (r.sources.join() !== 'kml') throw new Error('source reads ' + r.sources.join());
    if (!r.modalGone) throw new Error('the file dialog stayed open');
    if (!/pin skipped/.test(r.toast)) throw new Error('it did not report the skipped pin: ' + r.toast);
    return r.n + ' regions: ' + r.names.slice(0, 3).join(', ') + '…';
  });

  await step('coordinates land the right way round', async () => {
    // KML is lng,lat and this project is [lat,lng]. Getting it wrong puts
    // Tyler in the Indian Ocean, and nothing else in the suite would notice.
    const r = await e.evaluate(() => {
      const pt = RE.Regions.all()[0].rings[0][0];
      return { lat: pt[0], lng: pt[1] };
    });
    if (!(r.lat > 32 && r.lat < 33)) throw new Error('latitude reads ' + r.lat);
    if (!(r.lng < -95 && r.lng > -96)) throw new Error('longitude reads ' + r.lng);
    return r.lat.toFixed(4) + ', ' + r.lng.toFixed(4) + ' — east Texas, as drawn';
  });

  await step('folders and names classify the ground', async () => {
    const r = await e.evaluate(() => {
      const by = {};
      RE.Regions.all().forEach(x => { by[x.name] = x.terrain; });
      return by;
    });
    if (r['Behind the school'] !== 'marsh') throw new Error('"Behind the school" read as ' + r['Behind the school']);
    if (r['Two wet corners'] !== 'marsh') throw new Error('the "Low ground" folder was not read');
    if (r['North pasture'] !== 'meadow') throw new Error('"North pasture" read as ' + r['North pasture']);
    if (r['Black Fork Creek'] !== 'water') throw new Error('the creek read as ' + r['Black Fork Creek']);
    if (r['Unnamed shape'] !== 'wood') throw new Error('the unnamed shape did not take the fallback');
    return 'marsh from a folder, meadow and water from names, the rest fell back';
  });

  await step('a hole in Google Earth is a hole here', async () => {
    const r = await e.evaluate(() => {
      const reg = RE.Regions.all().find(x => x.name === 'Behind the school');
      /* A point well inside the hole, not the outer ring's centroid — that
         sits exactly on the hole's edge in this fixture, and a point on a
         boundary is undefined for any ray-casting test. */
      return { rings: reg.rings.length,
               middle: RE.Regions.contains(reg, 32.3495, -95.3035),
               edge: RE.Regions.contains(reg, 32.3485, -95.3045) };
    });
    if (r.rings !== 2) throw new Error(r.rings + ' rings — the innerBoundaryIs was dropped');
    if (r.middle) throw new Error('the hole is not a hole');
    if (!r.edge) throw new Error('a point plainly inside reads as outside');
    return 'outer + inner ring, the middle is out';
  });

  await step('a MultiGeometry is split, a traced path is given width, a pin is dropped', async () => {
    const r = await e.evaluate(() => {
      const rows = RE.Regions.all();
      const two = rows.filter(x => x.name === 'Two wet corners');
      const creek = rows.find(x => x.name === 'Black Fork Creek');
      return {
        parts: two.length, ids: new Set(two.map(x => x.regionId)).size,
        sourceIds: new Set(two.map(x => x.sourceId)).size,
        creekArea: creek ? Math.round(RE.Regions.areaM2(creek)) : 0,
        creekNotes: creek ? creek.notes : '',
        pins: rows.filter(x => /parked/i.test(x.name)).length
      };
    });
    if (r.parts !== 2) throw new Error('the MultiGeometry made ' + r.parts + ' regions');
    if (r.ids !== 2 || r.sourceIds !== 2) throw new Error('its two parts share an id');
    if (r.creekArea < 20000) throw new Error('the traced creek is only ' + r.creekArea + ' m²');
    if (!/20 m wide/.test(r.creekNotes)) throw new Error('the width was not recorded: ' + r.creekNotes);
    if (r.pins) throw new Error('a pin became a region');
    return '2 parts, ' + r.creekArea.toLocaleString() + ' m² of creek, no pins';
  });

  await step('re-importing the same export updates rather than doubles', async () => {
    const before = await e.evaluate(() => RE.Regions.all().length);
    await clearToasts(e);
    await e.click('#reFile');
    await e.waitForTimeout(250);
    await e.setInputFiles('#reUp', KML_FILE);
    await e.waitForTimeout(1200);
    const r = { n: await e.evaluate(() => RE.Regions.all().length), toast: await lastToast(e) };
    if (r.n !== before) throw new Error(before + ' → ' + r.n + ' on a second import of the same file');
    if (!/0 added/.test(r.toast)) throw new Error('it did not report an update: ' + r.toast);
    return before + ' regions, matched by where they came from';
  });

  await step('a .kmz is unzipped in the browser', async () => {
    await e.evaluate(() => RE.Regions.clear());
    await clearToasts(e);
    await e.click('#reFile');
    await e.waitForTimeout(250);
    await e.setInputFiles('#reUp', KMZ_FILE);
    await e.waitForTimeout(1500);
    const r = await e.evaluate(() => ({
      n: RE.Regions.all().length,
      terrains: Array.from(new Set(RE.Regions.all().map(x => x.terrain))).sort()
    }));
    r.toast = await lastToast(e);
    if (r.n !== 6) throw new Error(r.n + ' regions out of the .kmz');
    if (!/^KMZ/.test(r.toast)) throw new Error('it did not know it was a .kmz: ' + r.toast);
    return '6 regions, ' + r.terrains.join('/') + ', unzipped with DecompressionStream';
  });

  await step('the terrain picker and the path width are obeyed', async () => {
    await e.evaluate(() => RE.Regions.clear());
    await clearToasts(e);
    await e.click('#reFile');
    await e.waitForTimeout(250);
    await e.selectOption('#reTerrain', 'rock');
    await e.selectOption('#reBand', '0');
    await e.uncheck('#reGuess');
    await e.setInputFiles('#reUp', KML_FILE);
    await e.waitForTimeout(1200);
    const r = await e.evaluate(() => ({
      terrains: Array.from(new Set(RE.Regions.all().map(x => x.terrain))),
      creek: RE.Regions.all().filter(x => /Creek/.test(x.name)).length,
      n: RE.Regions.all().length
    }));
    r.toast = await lastToast(e);
    if (r.terrains.join() !== 'rock') throw new Error('with guessing off, terrains are ' + r.terrains.join());
    if (r.creek) throw new Error('the path was imported despite being set to skip');
    if (!/path skipped/.test(r.toast)) throw new Error('the skipped path was not reported: ' + r.toast);
    return r.n + ' regions, all rock, the traced path skipped';
  });

  await step('a file that is neither is refused politely', async () => {
    await clearToasts(e);
    await e.click('#reFile');
    await e.waitForTimeout(250);
    const junk = path.resolve(__dirname, 'screenshots/.not-a-map.txt');
    fs.writeFileSync(junk, 'this is a shopping list, not a map\nmilk\nbread\n');
    await e.setInputFiles('#reUp', junk);
    await e.waitForTimeout(800);
    const r = { toast: await lastToast(e),
                stillOpen: await e.evaluate(() => !!document.querySelector('.modalBack')) };
    fs.unlinkSync(junk);
    if (!r.toast) throw new Error('it said nothing at all');
    if (/undefined|\[object|Unexpected token/.test(r.toast)) {
      throw new Error('a raw parser error reached the player: ' + r.toast);
    }
    if (!/kml|kmz|GeoJSON/i.test(r.toast)) throw new Error('it does not say what it accepts: ' + r.toast);
    if (!r.stillOpen) throw new Error('the dialog closed on a failed import');
    return '"' + r.toast.slice(0, 60) + '"';
  });

  await step('the same KML gives the same answer at the command line', async () => {
    const out = path.resolve(__dirname, 'screenshots/.kml-test.geojson');
    execFileSync('node', [path.resolve(__dirname, 'mapimport.js'),
      '--file', KML_FILE, '--out', out, '--quiet'], { encoding: 'utf8' });
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    const byName = {};
    doc.features.forEach(f => { byName[f.properties.name] = f.properties.terrain; });
    fs.unlinkSync(out);
    if (doc.features.length !== 6) throw new Error(doc.features.length + ' features from the CLI');
    if (byName['Behind the school'] !== 'marsh' || byName['North pasture'] !== 'meadow') {
      throw new Error('the CLI classified differently: ' + JSON.stringify(byName));
    }
    const first = doc.features[0].geometry.coordinates[0][0];
    if (!(first[0] < -95 && first[1] > 32)) throw new Error('CLI coordinates are [lat,lng]: ' + first);
    return '6 features, same classification, [lng,lat] out';
  });

  await step('a .kmz at the command line goes through zlib', async () => {
    const out = path.resolve(__dirname, 'screenshots/.kmz-test.geojson');
    execFileSync('node', [path.resolve(__dirname, 'mapimport.js'),
      '--file', KMZ_FILE, '--terrain', 'plain', '--out', out, '--quiet'], { encoding: 'utf8' });
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    const fallbacks = doc.features.filter(f => f.properties.terrain === 'plain');
    fs.unlinkSync(out);
    if (doc.features.length !== 6) throw new Error(doc.features.length + ' features out of the .kmz');
    if (!fallbacks.length) throw new Error('--terrain was ignored');
    return doc.features.length + ' features, ' + fallbacks.length + ' took the --terrain fallback';
  });

  await step('the words people actually use classify correctly', async () => {
    const KML = MI_KML();
    const cases = [
      ['Black Fork Creek', 'water'], ['The back woods', 'wood'],
      ['North pasture', 'meadow'], ['Low ground behind the barn', 'marsh'],
      ['Old gravel pit', 'rock'], ['Hay field', 'plain'],
      ['County landfill', 'waste'], ['Downtown block', 'town'],
      ['Flood zone', 'marsh'], ['Creekside meadow', 'meadow'],
      ['Plot 4', ''], ['', '']
    ];
    const wrong = cases.filter(([text, want]) => KML.guessTerrain(text) !== want);
    if (wrong.length) throw new Error('misread: ' + JSON.stringify(wrong.map(([t, w]) => [t, w, KML.guessTerrain(t)])));
    return cases.length + ' phrases, including two that correctly say nothing';
  });

  if (eErrors.length) { fail++; console.log('  FAIL editor page errors — ' + eErrors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the editor'); }
  await c1.close();
  await browser.close();

  /* =================================================== THE IMPORTER ====== */
  console.log('\n===== THE MAP IMPORTER =====');
  const MI = require('./mapimport.js');
  const FIXTURE = path.resolve(__dirname, 'fixtures-overpass-tyler.json');
  const OUT = path.resolve(__dirname, 'screenshots/.regions-test.geojson');

  await step('it classifies a whole town without touching the network', async () => {
    // The fixture is a canned Overpass answer, so this exercises every line of
    // the pipeline except the socket — which is the only part somebody else's
    // server would have to be involved in.
    const out = execFileSync('node', [path.resolve(__dirname, 'mapimport.js'),
      '--file', FIXTURE, '--out', OUT, '--quiet'], { encoding: 'utf8' });
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const terrains = {};
    doc.features.forEach(f => { terrains[f.properties.terrain] = (terrains[f.properties.terrain] || 0) + 1; });
    if (doc.type !== 'FeatureCollection') throw new Error('not a FeatureCollection');
    if (doc.features.length < 6) throw new Error('only ' + doc.features.length + ' regions');
    ['water', 'marsh', 'wood', 'meadow', 'plain', 'rock'].forEach(t => {
      if (!terrains[t]) throw new Error('nothing classified as ' + t);
    });
    return doc.features.length + ' regions: ' +
           Object.keys(terrains).sort().map(k => k + ' ' + terrains[k]).join(', ');
  });

  await step('buildings are dropped and flowerbeds are too small', async () => {
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const names = doc.features.map(f => f.properties.name);
    if (names.indexOf('Courthouse') >= 0) throw new Error('a building became a region');
    const tiny = doc.features.filter(f => {
      const ring = f.geometry.coordinates[0].map(c => [c[1], c[0]]);
      return MI.ringAreaM2(ring) < 2000;
    });
    if (tiny.length) throw new Error(tiny.length + ' regions under the minimum area');
    return 'no buildings, nothing under 2000 m²';
  });

  await step('a river drawn as a line becomes ground you can stand in', async () => {
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const river = doc.features.find(f => /Black Fork/.test(f.properties.name || ''));
    if (!river) throw new Error('the river did not survive the import');
    const ring = river.geometry.coordinates[0];
    if (ring.length < 4) throw new Error('the river has ' + ring.length + ' corners');
    const area = MI.ringAreaM2(ring.map(c => [c[1], c[0]]));
    if (area < 1000) throw new Error('the buffered river is only ' + Math.round(area) + ' m²');
    if (river.properties.terrain !== 'water') throw new Error('classified as ' + river.properties.terrain);
    return Math.round(area).toLocaleString() + ' m² of river, ' + (ring.length - 1) + ' corners';
  });

  await step('a lake with an island keeps its hole', async () => {
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const lake = doc.features.find(f => /Lake Tyler/.test(f.properties.name || ''));
    if (!lake) throw new Error('the lake relation did not assemble');
    if (lake.geometry.coordinates.length !== 2) {
      throw new Error(lake.geometry.coordinates.length + ' rings — the island was lost');
    }
    const outer = MI.ringAreaM2(lake.geometry.coordinates[0].map(c => [c[1], c[0]]));
    const inner = MI.ringAreaM2(lake.geometry.coordinates[1].map(c => [c[1], c[0]]));
    if (inner >= outer) throw new Error('the hole is not smaller than the lake');
    return 'lake ' + Math.round(outer / 10000) + ' ha with a ' + Math.round(inner / 10000) + ' ha island';
  });

  await step('the same tag table decides both here and in the browser', async () => {
    // The importer loads js/world/regions.js rather than keeping its own copy;
    // this is the assertion that says so, and it fails the day somebody forks
    // the classifier.
    const Regions = MI.loadRegions();
    const cases = [
      [{ natural: 'water' }, 'water'], [{ waterway: 'river' }, 'water'],
      [{ natural: 'wetland' }, 'marsh'], [{ landuse: 'forest' }, 'wood'],
      [{ leisure: 'park' }, 'meadow'], [{ landuse: 'farmland' }, 'plain'],
      [{ landuse: 'quarry' }, 'rock'], [{ landuse: 'brownfield' }, 'waste'],
      [{ landuse: 'residential' }, 'town'],
      [{ building: 'yes' }, ''], [{ highway: 'residential' }, ''], [{ amenity: 'cafe' }, '']
    ];
    const wrong = cases.filter(([tags, want]) => Regions.classify(tags) !== want);
    if (wrong.length) throw new Error('misclassified: ' + JSON.stringify(wrong));
    if (Regions.TERRAINS.length !== 8) throw new Error(Regions.TERRAINS.length + ' terrains in node');
    return cases.length + ' tag cases, one classifier, loaded straight from the browser file';
  });

  await step('simplifying keeps the shape and drops the noise', async () => {
    // 200 points along a straight line with a metre of wobble should come out
    // as a handful; a real corner must survive.
    const line = [];
    for (let i = 0; i < 200; i++) line.push([41.88 + i * 0.00002, -87.62 + (i % 2) * 0.000005]);
    line.push([41.884, -87.60]);                     // a genuine corner
    const out = MI.simplify(line, 8);
    if (out.length > 12) throw new Error('200 noisy points simplified to ' + out.length);
    if (out.length < 3) throw new Error('simplified away to ' + out.length + ' points');
    const last = out[out.length - 1];
    if (last[1] !== -87.60) throw new Error('the corner was lost');
    return '201 points → ' + out.length + ', corner kept';
  });

  try { fs.unlinkSync(OUT); } catch (e) { /* nothing to clean */ }

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
