/* The chunked world: the grid it is quantised on, the cells filling in as you
   walk, what you can see of them, and what gets thrown away.

   Every Overpass request is answered with a town centred on whatever the query
   asked about, so each chunk has its own geometry rather than every cell being
   handed the same streets — which is the only way "walking into a new chunk"
   means anything here.

   No waiting on clocks. Chunks.sync, Chunks.evict and the spawner all take
   `now`, and this suite hands it to them. */
const { chromium } = require('playwright');
const path = require('path');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
const fs = require('fs');
const { mockOverpass } = require('./mock-osm');

const GAME_URL = BASE + '/index.html';
const LEAFLET_JS  = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

const HOME = { latitude: 41.8827, longitude: -87.6233 };

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

const at = (h, m) => new Date(2026, 8, 11, h, m || 0).getTime();

/* The query carries "(around:radius,lat,lng)". Reading it back is what lets a
   chunk two cells over come back with its own streets instead of a copy of the
   ones under your feet. */
function centreOf(body) {
  const m = /around:[\d.]+,(-?[\d.]+),(-?[\d.]+)/.exec(decodeURIComponent(String(body || '')));
  return m ? { lat: +m[1], lng: +m[2] } : { lat: HOME.latitude, lng: HOME.longitude };
}

let overpassHits = 0, overpassDown = false;
/* Every request the page made, so the policy section can measure overlap and
   spacing rather than taking the code's word for it. `status` lets a test make
   the service answer 429 instead of data. */
let overpassLog = [], overpassStatus = 200, overpassHeaders = {};
let inFlight = 0, maxInFlight = 0;

async function newPage(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 900 },
    geolocation: { latitude: HOME.latitude, longitude: HOME.longitude },
    permissions: ['geolocation']
  });
  const page = await ctx.newPage();
  await emptyDatabase(page);
  await page.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await page.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  await page.route('**/api/interpreter', async r => {
    overpassHits++;
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const entry = { at: Date.now(), url: r.request().url(), status: overpassStatus };
    overpassLog.push(entry);
    try {
      if (overpassDown) { await r.abort(); return; }
      if (overpassStatus !== 200) {
        await r.fulfill({ status: overpassStatus, contentType: 'text/plain',
                          headers: overpassHeaders, body: 'slow down' });
        return;
      }
      const c = centreOf(r.request().postData());
      // A real query is not instant, and an instant one would hide an overlap.
      await new Promise(res => setTimeout(res, 60));
      await r.fulfill({ status: 200, contentType: 'application/json',
                        body: JSON.stringify(mockOverpass(c.lat, c.lng)) });
    } finally {
      inFlight--;
      entry.done = Date.now();
    }
  });
  return { ctx, page };
}

/**
 * Stand somewhere and let the world catch up, on a clock we control.
 *
 * Moving fires the game's own sync, which is async and which no one awaits —
 * so a forced sync issued straight afterwards bounces off the `_chunkBusy`
 * guard and returns without doing anything. Waiting for that one to finish
 * first is the difference between a suite that tests chunk loading and a suite
 * that tests a race.
 */
async function settle(page) {
  await page.waitForFunction(() => !SS.Game._chunkBusy, null, { timeout: 15000 });
}

/**
 * Hand the rate limiter a clean slate.
 *
 * Overpass requests are gated — one at a time, 1.5 s apart, twelve a minute,
 * and a cool-off after a failure. That is the point of the policy section
 * below, and a nuisance everywhere else: a suite that deliberately wipes the
 * cache four times would otherwise spend most of its run sitting out a minute
 * it is not testing. So the sections that are about chunks reset the budget
 * first, and the section that is about the budget never does.
 */
async function freshBudget(page) {
  await page.evaluate(() => {
    SS.OSM.clearCoolOff();
    SS.OSM._recent = [];
    SS.OSM._lastAt = 0;
    const st = SS.Chunks.all();
    Object.keys(st).forEach(k => SS.Chunks.put(k, { failedAt: 0, failCount: 0 }));
  });
}
async function goTo(page, lat, lng, now) {
  await settle(page);
  await freshBudget(page);
  await page.evaluate((a) => { SS.Loc.simulateTo(a.lat, a.lng); }, { lat, lng, now });
  await settle(page);
  await page.evaluate(async (a) => {
    SS.Game._lastChunkSync = 0;
    await SS.Game.syncChunks({ force: true, now: a.now });
  }, { lat, lng, now });
  await settle(page);
  await page.waitForTimeout(150);
}

(async () => {
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const { ctx, page } = await newPage(browser);
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errs.push(m.text()); });

  await page.goto(GAME_URL);
  await page.waitForSelector('#tReg', { timeout: 8000 });
  await page.click('#tReg');
  await page.fill('#rgUser', 'chunkwalker'); await page.fill('#rgPass', 'walk1234');
  await page.click('#rgGo');
  await page.waitForSelector('.stepBar', { timeout: 6000 });
  await page.click('.pickGrid .pick:nth-child(1)'); await page.click('#next');
  await page.click('.pickGrid .pick:nth-child(1)'); await page.click('#next');
  for (let i = 0; i < 40; i++) {
    const l = parseInt(await page.textContent('#ptsLeft'), 10); if (!l) break;
    const b = await page.$('.stepper[data-inc]:not([disabled])'); if (!b) break; await b.click();
  }
  await page.click('#next'); await page.fill('#cName', 'Bram Ashwalk'); await page.click('#next');
  await page.waitForSelector('#map', { timeout: 6000 });
  await page.waitForFunction(() => !!SS.Game.world, null, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(600);

  /* ================================================================= GRID */
  console.log('\n===== THE GRID =====');

  await step('a chunk is 500 m square wherever you stand', async () => {
    const r = await page.evaluate(() => {
      const H = (a, b, c, d) => {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(c - a), dLon = tr(d - b);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a)) * Math.cos(tr(c)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      return [0.5, 41.88, 55, 71].map(lat => {
        const c = SS.Grid.chunkAt(lat, 12.34);
        return {
          lat,
          w: Math.round(H(c.latitude, c.west, c.latitude, c.east)),
          h: Math.round(H(c.south, c.longitude, c.north, c.longitude))
        };
      });
    });
    const bad = r.find(x => Math.abs(x.w - 500) > 12 || Math.abs(x.h - 500) > 12);
    if (bad) throw new Error(JSON.stringify(bad) + ' is not square');
    return r.map(x => x.lat + '°: ' + x.w + '×' + x.h).join(', ');
  });

  await step('a region is 2 km and holds whole chunks-worth of ground', async () => {
    const r = await page.evaluate(() => {
      const H = (a, b, c, d) => {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(c - a), dLon = tr(d - b);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a)) * Math.cos(tr(c)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      const reg = SS.Grid.regionAt(41.8827, -87.6233);
      const ch = SS.Grid.chunkAt(41.8827, -87.6233);
      return {
        w: Math.round(H(reg.latitude, reg.west, reg.latitude, reg.east)),
        h: Math.round(H(reg.south, reg.longitude, reg.north, reg.longitude)),
        holdsThePoint: SS.Grid.contains(reg, 41.8827, -87.6233) &&
                       SS.Grid.contains(ch, 41.8827, -87.6233),
        chunksWorth: Math.round((reg.north - reg.south) / (ch.north - ch.south)),
        keys: [reg.key[0], ch.key[0]]
      };
    });
    if (Math.abs(r.w - 2000) > 50 || Math.abs(r.h - 2000) > 50) throw new Error(r.w + '×' + r.h);
    // Note what is NOT claimed: the two grids quantise longitude in their own
    // latitude bands, so a region's edges do not line up with chunk edges and a
    // chunk near one straddles two regions. That costs nothing, because a chunk
    // draws instances by coordinate and never by membership.
    if (!r.holdsThePoint) throw new Error('a point fell outside its own region or chunk');
    if (r.chunksWorth !== 4) throw new Error('a region is ' + r.chunksWorth + ' chunks tall, expected 4');
    if (r.keys[0] !== 'r' || r.keys[1] !== 'c') throw new Error('keys are not distinguishable: ' + r.keys);
    return r.w + '×' + r.h + ' m — ' + r.chunksWorth + '×' + r.chunksWorth +
           ' chunks of ground, keys "' + r.keys[0] + '" and "' + r.keys[1] + '"';
  });

  await step('a point lands in exactly one cell, and the key round-trips', async () => {
    const r = await page.evaluate(() => {
      let inOne = 0, roundTrips = 0, n = 0;
      for (let i = 0; i < 200; i++) {
        const lat = 41.86 + Math.random() * 0.05, lng = -87.66 + Math.random() * 0.06;
        const c = SS.Grid.chunkAt(lat, lng);
        n++;
        if (SS.Grid.contains(c, lat, lng)) inOne++;
        const back = SS.Grid.fromKey(c.key);
        if (back && back.key === c.key && SS.Grid.contains(back, lat, lng)) roundTrips++;
      }
      return { inOne, roundTrips, n, junk: SS.Grid.fromKey('not-a-key') };
    });
    if (r.inOne !== r.n) throw new Error(r.n - r.inOne + ' points fell outside their own cell');
    if (r.roundTrips !== r.n) throw new Error(r.n - r.roundTrips + ' keys did not round-trip');
    if (r.junk !== null) throw new Error('a junk key parsed into ' + JSON.stringify(r.junk));
    return r.n + ' points, all in one cell, all keys parsed back';
  });

  await step('only the cells actually within reach are loaded', async () => {
    const r = await page.evaluate(() => {
      const p = SS.Loc.last;
      const radius = SS.Chunks.settingsFor().loadRadiusM;
      const cells = SS.Chunks.inRange(p.latitude, p.longitude);
      const keys = {}; cells.forEach(c => { keys[c.key] = 1; });
      const home = SS.Grid.chunkAt(p.latitude, p.longitude);
      // Every cell in a 5x5 block: in the list if and only if it is in range.
      let wrong = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const c = SS.Grid.cell(home.latIndex + dy, home.lngIndex + dx, SS.Grid.CHUNK_M);
        const near = SS.Grid.distanceTo(c, p.latitude, p.longitude) <= radius;
        if (near !== !!keys[c.key]) wrong++;
      }
      return { n: cells.length, wrong, radius, firstIsHome: cells[0].key === home.key };
    });
    if (r.wrong) throw new Error(r.wrong + ' cells were on the wrong side of the ' + r.radius + ' m line');
    if (!r.firstIsHome) throw new Error('the cell underfoot was not surveyed first');
    return r.n + ' cells within ' + r.radius + ' m, the one underfoot first';
  });

  /* ============================================================== WALKING */
  console.log('\n===== WALKING INTO A CHUNK =====');

  await step('entering a chunk generates all of it at once', async () => {
    await goTo(page, HOME.latitude, HOME.longitude, at(9, 0));
    const r = await page.evaluate(() => {
      const p = SS.Loc.last;
      const home = SS.Grid.chunkAt(p.latitude, p.longitude);
      const st = SS.Chunks.get(home.key);
      const nodes = Object.values(SS.Store.get(SS.K.nodes, {}) || {})
        .filter(n => n.chunkKey === home.key);
      const want = SS.Chunks.settingsFor().perChunk;
      const sight = SS.Chunks.settingsFor().sightM;
      const H = (a, b, c, d) => {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(c - a), dLon = tr(d - b);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a)) * Math.cos(tr(c)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      // The whole point: sites exist beyond what you can currently see. The
      // home cell alone cannot show that — its far corner is 354 m away and the
      // sight radius is 300 — so the claim is about everything generated.
      const everything = Object.values(SS.Store.get(SS.K.nodes, {}) || {}).filter(n => n.chunkKey);
      return {
        want, made: nodes.length, generatedAt: !!(st && st.generatedAt),
        zoned: !!(st && st.zoneId), total: everything.length,
        beyondSight: everything.filter(n => H(p.latitude, p.longitude, n.latitude, n.longitude) > sight).length,
        sight
      };
    });
    if (!r.zoned) throw new Error('the chunk got no zone row');
    if (!r.generatedAt) throw new Error('the chunk was never marked generated');
    if (r.made !== r.want) throw new Error('generated ' + r.made + ' of ' + r.want);
    if (!r.beyondSight) throw new Error('nothing was generated beyond the ' + r.sight + ' m you can see');
    return r.made + ' sites in the cell underfoot, ' + r.total + ' in range, ' +
           r.beyondSight + ' of them past the ' + r.sight + ' m sight line';
  });

  await step('the neighbours in range are generated too, and nothing further', async () => {
    const r = await page.evaluate(() => {
      const p = SS.Loc.last;
      const inRange = {}; SS.Chunks.inRange(p.latitude, p.longitude).forEach(c => { inRange[c.key] = 1; });
      const state = SS.Chunks.all();
      const generated = Object.values(state).filter(c => c.generatedAt).map(c => c.key);
      const strays = generated.filter(k => !inRange[k]);
      const missing = Object.keys(inRange).filter(k => generated.indexOf(k) < 0);
      return { inRange: Object.keys(inRange).length, generated: generated.length, strays, missing };
    });
    if (r.missing.length) throw new Error('in range but not generated: ' + r.missing.join(', '));
    if (r.strays.length) throw new Error('generated out of range: ' + r.strays.join(', '));
    return r.generated + ' chunks generated, exactly the ' + r.inRange + ' in range';
  });

  await step('walking into a new chunk fills it in and leaves the old one alone', async () => {
    const before = await page.evaluate(() => {
      const home = SS.Grid.chunkAt(SS.Loc.last.latitude, SS.Loc.last.longitude);
      return { key: home.key, at: SS.Chunks.get(home.key).generatedAt,
               nodes: Object.values(SS.Store.get(SS.K.nodes, {}) || {}).filter(n => n.chunkKey === home.key).length };
    });
    // A kilometre north: a different cell, none of it touching the old one.
    const hits = overpassHits;
    await goTo(page, HOME.latitude + 0.009, HOME.longitude, at(9, 20));
    const r = await page.evaluate((b) => {
      const p = SS.Loc.last;
      const here = SS.Grid.chunkAt(p.latitude, p.longitude);
      const st = SS.Chunks.get(here.key);
      const old = SS.Chunks.get(b.key);
      const nodes = Object.values(SS.Store.get(SS.K.nodes, {}) || {});
      return {
        here: here.key, newKey: here.key !== b.key,
        madeHere: nodes.filter(n => n.chunkKey === here.key).length,
        generated: !!(st && st.generatedAt),
        oldUntouched: old && old.generatedAt === b.at,
        oldNodesKept: nodes.filter(n => n.chunkKey === b.key).length,
        drawn: SS.Game.nodes.some(n => n.chunkKey === here.key),
        drawsOld: SS.Game.nodes.some(n => n.chunkKey === b.key)
      };
    }, before);
    if (!r.newKey) throw new Error('a kilometre north was the same chunk');
    if (!r.generated || !r.madeHere) throw new Error('the new chunk stayed empty');
    if (!r.oldUntouched) throw new Error('walking away regenerated the chunk behind us');
    if (r.oldNodesKept !== before.nodes) throw new Error('the old chunk lost nodes: ' + r.oldNodesKept);
    if (!r.drawn) throw new Error('the new chunk is not on the map');
    if (r.drawsOld) throw new Error('a chunk a kilometre away is still being drawn');
    return before.key + ' → ' + r.here + ', ' + r.madeHere + ' new sites, ' +
           r.oldNodesKept + ' kept behind us, ' + (overpassHits - hits) + ' queries';
  });

  await step('coming back is free — the cached survey answers instead of Overpass', async () => {
    const hits = overpassHits;
    await goTo(page, HOME.latitude, HOME.longitude, at(9, 40));
    const r = await page.evaluate(() => {
      const home = SS.Grid.chunkAt(SS.Loc.last.latitude, SS.Loc.last.longitude);
      const st = SS.Chunks.get(home.key);
      return { cached: st.cacheBytes > 0, nodes: SS.Game.nodes.length, key: home.key };
    });
    const spent = overpassHits - hits;
    if (!r.cached) throw new Error('the chunk under us kept no cached geometry');
    if (spent > 2) throw new Error('walking back cost ' + spent + ' Overpass queries');
    return 'back in ' + r.key + ' for ' + spent + ' quer' + (spent === 1 ? 'y' : 'ies') +
           ', ' + r.nodes + ' sites drawn';
  });

  /* ================================================================ SIGHT */
  console.log('\n===== WHAT YOU CAN SEE =====');

  await step('out of sight is a ? on the radar, not an empty map', async () => {
    const r = await page.evaluate(() => {
      const p = SS.Loc.last;
      const sight = SS.Chunks.settingsFor().sightM;
      const H = (a, b, c, d) => {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(c - a), dLon = tr(d - b);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a)) * Math.cos(tr(c)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      const far = SS.Game.nodes.filter(n => H(p.latitude, p.longitude, n.latitude, n.longitude) > sight);
      const near = SS.Game.nodes.filter(n => H(p.latitude, p.longitude, n.latitude, n.longitude) <= sight);
      return {
        far: far.length, near: near.length, sight,
        unknownPins: document.querySelectorAll('.pin.unknown').length,
        /* Two shapes of known pin since creatures got faces: a live combat or
           boss site wears the circular token (`.tok.site`), everything else
           keeps the square badge. Both mean "you can see what this is". */
        knownPins: document.querySelectorAll('.pinWrap .pin:not(.unknown), .pinWrap .tok.site').length,
        agrees: far.every(n => SS.Game.inSight(n) === false) && near.every(n => SS.Game.inSight(n) === true)
      };
    });
    if (!r.far) throw new Error('nothing is out of sight to hide');
    if (!r.agrees) throw new Error('inSight disagrees with the distance');
    if (r.unknownPins !== r.far) throw new Error(r.far + ' out of sight but ' + r.unknownPins + ' ? pins');
    if (r.knownPins !== r.near) throw new Error(r.near + ' in sight but ' + r.knownPins + ' real pins');
    return r.near + ' visible, ' + r.far + ' hidden as ? within ' + r.sight + ' m sight';
  });

  await step('walking towards one turns the ? into what it really is', async () => {
    const target = await page.evaluate(() => {
      const p = SS.Loc.last;
      const H = (a, b, c, d) => {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(c - a), dLon = tr(d - b);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a)) * Math.cos(tr(c)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      const far = SS.Game.nodes
        .map(n => ({ n, d: H(p.latitude, p.longitude, n.latitude, n.longitude) }))
        .filter(x => x.d > (SS.Chunks.settingsFor().sightM))
        .sort((a, b) => a.d - b.d)[0];
      return far ? { id: far.n.nodeId, lat: far.n.latitude, lng: far.n.longitude, d: Math.round(far.d) } : null;
    });
    if (!target) throw new Error('nothing was out of sight to walk towards');
    const r = await page.evaluate((t) => {
      const wasUnknown = SS.Game.nodes.find(n => n.nodeId === t.id)._seen === false;
      const before = document.querySelectorAll('.pin.unknown').length;
      // Stand 40 m short of it: inside the sight radius, still not on it.
      // Moving is enough — onPosition calls updateSight itself, which is the
      // behaviour under test; calling it again here would report zero changes
      // simply because the real one had already done the work.
      SS.Loc.simulateTo(t.lat + 0.00036, t.lng);
      const now = SS.Game.nodes.find(n => n.nodeId === t.id);
      return { wasUnknown, nowSeen: now._seen, before,
               after: document.querySelectorAll('.pin.unknown').length,
               // Moving also brings some previously-visible ones out of range,
               // so the count alone is not the test — this node's pin is.
               stillUnknown: SS.Game.updateSight() };
    }, target);
    if (!r.wasUnknown) throw new Error('it was not hidden to begin with');
    if (!r.nowSeen) throw new Error('standing 40 m away it is still a ?');
    if (r.stillUnknown) throw new Error(r.stillUnknown + ' pins were left stale after the fix');
    return 'walked ' + target.d + ' m → it resolved, ' + r.before + ' unknown before, ' +
           r.after + ' after';
  });

  await step('a ? can be prodded but not entered', async () => {
    const r = await page.evaluate(() => {
      const p = SS.Loc.last;
      const H = (a, b, c, d) => {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(c - a), dLon = tr(d - b);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a)) * Math.cos(tr(c)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      const hidden = SS.Game.nodes.find(n =>
        H(p.latitude, p.longitude, n.latitude, n.longitude) > (SS.Chunks.settingsFor().sightM));
      if (!hidden) return { none: true };
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      document.querySelectorAll('.toast').forEach(t => t.remove());
      SS.Game.peekNode(hidden);
      // Other toasts (the location gate, a spawn notice) can be on screen, so
      // look through all of them rather than at whichever is first in the DOM.
      const toasts = Array.from(document.querySelectorAll('.toast')).map(t => t.textContent);
      return {
        toast: toasts.find(t => /over there/i.test(t)) || toasts.join(' | '),
        opened: !!document.querySelector('.modalBack'),
        inSight: SS.Game.inSight(hidden)
      };
    });
    if (r.none) throw new Error('nothing hidden to prod');
    if (r.opened) throw new Error('prodding an unknown site opened it anyway');
    if (!/over there/i.test(r.toast)) throw new Error('no hint given: "' + r.toast + '"');
    return '"' + r.toast.trim().slice(0, 52) + '…", nothing opened';
  });

  /* ============================================================== BUDGETS */
  console.log('\n===== THROWING THINGS AWAY =====');

  await step('an hour old and out of range, a site is destroyed', async () => {
    await goTo(page, HOME.latitude, HOME.longitude, at(10, 0));
    const r = await page.evaluate((now) => {
      const cfg = SS.Chunks.settingsFor();
      const p = SS.Loc.last;
      const keep = {}; SS.Chunks.inRange(p.latitude, p.longitude).forEach(c => { keep[c.key] = 1; });
      const all = Object.values(SS.Store.get(SS.K.nodes, {}) || {}).filter(n => n.chunkKey);
      const away = all.filter(n => !keep[n.chunkKey]);
      const under = all.filter(n => keep[n.chunkKey]);
      // Age everything past the hour — the ones you are standing among included.
      SS.Store.patch(SS.K.nodes, (a) => {
        Object.values(a).forEach(n => { if (n.chunkKey) n.createdAt = now - cfg.nodeTtlMs - 1000; });
      });
      const out = SS.Chunks.evict(now, keep);
      const left = Object.values(SS.Store.get(SS.K.nodes, {}) || {}).filter(n => n.chunkKey);
      return {
        ttlMin: cfg.nodeTtlMs / 60000, away: away.length, under: under.length,
        evicted: out.nodes, left: left.length,
        keptUnderfoot: left.filter(n => keep[n.chunkKey]).length
      };
    }, at(10, 0));
    if (!r.away) throw new Error('nothing was out of range to expire');
    if (r.evicted !== r.away) throw new Error('expired ' + r.evicted + ' of ' + r.away + ' stale sites');
    if (r.keptUnderfoot !== r.under) throw new Error('it deleted sites in a chunk we are standing in');
    return r.evicted + ' stale sites gone after ' + r.ttlMin + ' min, ' +
           r.keptUnderfoot + ' underfoot kept however old';
  });

  await step('a chunk emptied by the sweep regenerates when you walk back', async () => {
    const r = await page.evaluate(() => {
      const state = SS.Chunks.all();
      const emptied = Object.values(state).filter(c => c.generatedAt === 0);
      return { emptied: emptied.length, keys: emptied.slice(0, 2).map(c => c.key) };
    });
    if (!r.emptied) throw new Error('no swept chunk was marked for regeneration');
    // Walk into one of them and check it fills back up.
    const back = await page.evaluate(async (key) => {
      const cell = SS.Grid.fromKey(key);
      SS.Loc.simulateTo(cell.latitude, cell.longitude);
      SS.Game._lastChunkSync = 0;
      await SS.Game.syncChunks({ force: true, now: Date.now() });
      const nodes = Object.values(SS.Store.get(SS.K.nodes, {}) || {}).filter(n => n.chunkKey === key);
      return { key, nodes: nodes.length, generatedAt: !!SS.Chunks.get(key).generatedAt };
    }, r.keys[0]);
    if (!back.generatedAt || !back.nodes) throw new Error(back.key + ' came back empty');
    return r.emptied + ' chunk(s) marked; ' + back.key + ' refilled with ' + back.nodes + ' sites';
  });

  await step('over the cap, the oldest go first', async () => {
    const r = await page.evaluate((now) => {
      const cfg = SS.Chunks.settingsFor();
      const p = SS.Loc.last;
      const keep = {}; SS.Chunks.inRange(p.latitude, p.longitude).forEach(c => { keep[c.key] = 1; });
      // Manufacture far more sites than the cap allows, all in chunks we are
      // nowhere near, each one a minute older than the last.
      const over = cfg.maxNodes + 40;
      const made = [];
      SS.Store.patch(SS.K.nodes, (a) => {
        for (let i = 0; i < over; i++) {
          const id = 'nd_cap_' + i;
          a[id] = { nodeId: id, zoneId: 'zn_nowhere', chunkKey: 'c9000_' + (9000 + i),
                    type: 'combat', difficulty: 1, latitude: 1 + i / 1000, longitude: 1,
                    name: 'Filler ' + i, status: 'undiscovered', enemies: [], rewards: {},
                    createdAt: now - (over - i) * 60000 };
          made.push(id);
        }
      });
      const out = SS.Chunks.evict(now, keep);
      const left = Object.values(SS.Store.get(SS.K.nodes, {}) || {}).filter(n => n.chunkKey);
      const fillersLeft = left.filter(n => n.nodeId.indexOf('nd_cap_') === 0);
      const ages = fillersLeft.map(n => n.createdAt);
      const oldestLeft = ages.length ? Math.min.apply(null, ages) : 0;
      const gone = made.filter(id => !left.some(n => n.nodeId === id));
      // Everything deleted must be older than everything kept.
      const newestGone = Math.max.apply(null, made
        .filter(id => gone.indexOf(id) >= 0)
        .map(id => now - (over - +id.split('_')[2]) * 60000));
      return { cap: cfg.maxNodes, made: over, evicted: out.nodes, left: left.length,
               orderedRight: !ages.length || newestGone <= oldestLeft };
    }, at(11, 0));
    if (r.left > r.cap) throw new Error(r.left + ' sites left against a cap of ' + r.cap);
    if (!r.evicted) throw new Error('nothing was evicted despite being ' + (r.made - r.cap) + ' over');
    if (!r.orderedRight) throw new Error('it deleted a newer site while keeping an older one');
    return r.made + ' sites trimmed to ' + r.left + ' (cap ' + r.cap + '), oldest first';
  });

  await step('the geometry cache is held under its byte budget', async () => {
    const r = await page.evaluate((now) => {
      const cfg = SS.Chunks.settingsFor();
      const state = SS.Chunks.all();
      // Claim every known chunk is holding a big cache, then evict from far away
      // so nothing is protected by being underfoot.
      Object.values(state).forEach((c, i) => {
        SS.Chunks.put(c.key, { cacheBytes: 500000, lastSeenAt: now - (100 - i) * 60000 });
      });
      const before = Object.values(SS.Chunks.all()).reduce((n, c) => n + (c.cacheBytes || 0), 0);
      const out = SS.Chunks.evict(now, {});
      const after = Object.values(SS.Chunks.all()).reduce((n, c) => n + (c.cacheBytes || 0), 0);
      return { budget: cfg.cacheBudget, before, after, dropped: out.caches };
    }, at(11, 30));
    if (r.before <= r.budget) throw new Error('the test never went over budget');
    if (r.after > r.budget) throw new Error('left ' + r.after + ' bytes against a budget of ' + r.budget);
    return Math.round(r.before / 1024) + ' KB trimmed to ' + Math.round(r.after / 1024) +
           ' KB (budget ' + Math.round(r.budget / 1024) + ' KB), ' + r.dropped + ' dropped';
  });

  /* ========================================== WEIGHTS, AND WHAT A CHUNK OWNS */
  console.log('\n===== WEIGHTS AND OWNERSHIP =====');

  await step('chunk sites are nudged onto real buildings, not left on grid points', async () => {
    await page.evaluate(() => { SS.Chunks.reset(); SS.Content.replaceAll('dungeons', []); });
    await freshBudget(page);
    await goTo(page, HOME.latitude, HOME.longitude, at(12, 0));
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const here = SS.Grid.chunkAt(SS.Loc.last.latitude, SS.Loc.last.longitude);
      const mine = SS.Game.nodes.filter(n => n.chunkKey === here.key && !n.locationId);
      const snapped = mine.filter(n => n.anchorKey);
      return { n: mine.length, snapped: snapped.length,
               names: snapped.slice(0, 2).map(n => n.anchorName || n.name) };
    });
    if (!r.n) throw new Error('no sites in the chunk underfoot');
    if (!r.snapped) throw new Error('not one of ' + r.n + ' sites landed on a building');
    return r.snapped + ' of ' + r.n + ' on real buildings — ' + r.names.join(', ');
  });

  await step('each chunk gets its own dungeon, and one zone row apiece', async () => {
    const r = await page.evaluate((now) => {
      SS.Game.runSpawner({ force: true, now });
      const zones = Object.values(SS.Store.get(SS.K.zones, {}) || {}).filter(z => z.kind === 'chunk');
      const keys = zones.map(z => z.chunkKey).sort();
      const dupes = keys.filter((k, i) => i && k === keys[i - 1]);
      const loaded = SS.Chunks.loadedZones().map(z => z.zoneId);
      const dungeons = SS.Content.list('dungeons').filter(d => d.origin === 'auto');
      const perZone = {};
      dungeons.forEach(d => { perZone[d.zoneId] = (perZone[d.zoneId] || 0) + 1; });
      return {
        zones: zones.length, dupes, loaded: loaded.length,
        dungeons: dungeons.length,
        covered: loaded.filter(id => perZone[id]).length,
        most: Math.max.apply(null, Object.values(perZone).concat([0]))
      };
    }, at(12, 5));
    if (r.dupes.length) throw new Error('two zone rows for chunk ' + r.dupes[0]);
    if (r.covered !== r.loaded) throw new Error(r.covered + ' of ' + r.loaded + ' loaded chunks got a dungeon');
    if (r.most > 1) throw new Error('a chunk held ' + r.most + ' spawned dungeons at once');
    return r.dungeons + ' dungeons across ' + r.loaded + ' loaded chunks, one each, ' +
           r.zones + ' chunk zones with no duplicates';
  });

  await step('a chunk draws an instance but never makes or breaks one', async () => {
    const r = await page.evaluate(async (now) => {
      const p = SS.Loc.last;
      const here = SS.Grid.chunkAt(p.latitude, p.longitude);
      SS.Content.replaceAll('instances', []);
      SS.Store.remove(SS.Spawner.KEY + '_regions');
      // Put one inside the chunk we are standing in, by hand, as the region
      // would have: no zoneId, stamped with its region.
      const region = SS.Grid.regionAt(p.latitude, p.longitude);
      const row = SS.Content.blankInstance(here.latitude, here.longitude, '');
      row.origin = 'auto'; row.regionKey = region.key; row.zoneId = '';
      row.radius = 35; row.active = true;
      row.expiresAt = now + 2 * 86400000;
      SS.Content.save('instances', row);
      const id = row.instanceId;

      // Now do everything a chunk does: resync, redraw, let the spawner run.
      SS.Chunks.loaded = {};
      SS.Game._lastChunkSync = 0;
      await SS.Game.syncChunks({ force: true, now });
      SS.Game.runSpawner({ force: true, now });

      const all = SS.Content.list('instances');
      const still = all.find(x => x.instanceId === id);
      const drawn = SS.Game.instances().some(x => x.instanceId === id);
      const inCell = still && SS.Grid.contains(here, still.latitude, still.longitude);
      return { survived: !!still, drawn, inCell,
               total: all.length, sameSpot: still && still.latitude === row.latitude };
    }, at(12, 10));
    if (!r.survived) throw new Error('rendering the chunk destroyed the instance in it');
    if (!r.sameSpot) throw new Error('the chunk moved it');
    if (!r.drawn) throw new Error('the chunk did not draw the instance sitting inside it');
    if (!r.inCell) throw new Error('the test instance was not in the chunk after all');
    return 'drawn by the chunk, owned by the region (' + r.total + ' alive)';
  });

  /* ======================================================= NO MAP DATA AT ALL */
  console.log('\n===== WITH OVERPASS DOWN =====');

  await step('a chunk with no geometry still generates, and snaps once it arrives', async () => {
    overpassDown = true;
    await freshBudget(page);
    const blind = await page.evaluate(async (now) => {
      SS.Chunks.reset();
      SS.Store.remove('osm_cache_' + SS.Grid.chunkAt(SS.Loc.last.latitude, SS.Loc.last.longitude).key);
      // Drop every cached survey, or the "down" service is never consulted.
      Object.keys(localStorage).filter(k => k.indexOf('ss_osm_cache_') === 0 || k.indexOf('osm_cache_') === 0)
        .forEach(k => localStorage.removeItem(k));
      SS.Game._lastChunkSync = 0;
      await SS.Game.syncChunks({ force: true, now });
      const here = SS.Grid.chunkAt(SS.Loc.last.latitude, SS.Loc.last.longitude);
      const st = SS.Chunks.get(here.key);
      const nodes = Object.values(SS.Store.get(SS.K.nodes, {}) || {}).filter(n => n.chunkKey === here.key);
      return { key: here.key, blind: !!st.blind, made: nodes.length,
               anchored: nodes.filter(n => n.anchorKey).length };
    }, at(13, 0));
    if (!blind.made) throw new Error('with Overpass down the chunk produced nothing at all');
    if (!blind.blind) throw new Error('the chunk was not marked as generated without geometry');

    overpassDown = false;
    // The failure just recorded puts that cell on a minute's backoff, which is
    // the policy section's business, not this one's.
    await freshBudget(page);
    const sighted = await page.evaluate(async (now) => {
      SS.Game._lastChunkSync = 0;
      await SS.Game.syncChunks({ force: true, now });
      const here = SS.Grid.chunkAt(SS.Loc.last.latitude, SS.Loc.last.longitude);
      const st = SS.Chunks.get(here.key);
      const nodes = Object.values(SS.Store.get(SS.K.nodes, {}) || {}).filter(n => n.chunkKey === here.key);
      return { blind: !!st.blind, made: nodes.length, anchored: nodes.filter(n => n.anchorKey).length };
    }, at(13, 5));
    if (sighted.blind) throw new Error('geometry arrived but the chunk is still marked blind');
    if (sighted.made !== blind.made) throw new Error('it regenerated the chunk instead of snapping it');
    if (!sighted.anchored) throw new Error('geometry arrived and nothing was snapped onto it');
    return blind.made + ' sites blind (' + blind.anchored + ' anchored), then ' +
           sighted.anchored + ' anchored once the streets arrived';
  });

  /* ================================================ BEING A GOOD CITIZEN */
  /* Overpass, the tiles and Nominatim are all donated infrastructure with a
     published usage policy, and a game that surveys the ground as you walk is
     exactly the client that abuses them if nobody checks. This section is the
     check. Nothing here resets the budget — that is the whole point of it. */
  console.log('\n===== THE USAGE POLICY =====');

  await step('never two queries at once, however they were asked for', async () => {
    await settle(page);
    await freshBudget(page);
    overpassLog = []; maxInFlight = 0;
    const r = await page.evaluate(async (now) => {
      SS.Chunks.reset();
      Object.keys(localStorage).filter(k => k.indexOf('osm_cache_') >= 0)
        .forEach(k => localStorage.removeItem(k));
      SS.Chunks.loaded = {};
      // Four callers at once: the game's sync, a menu resurvey, and two dev
      // panel loads. Before the gate these would have raced each other.
      const p = SS.Loc.last;
      SS.Game._lastChunkSync = 0;
      await Promise.all([
        SS.Game.syncChunks({ force: true, now }),
        SS.Chunks.sync(p.latitude, p.longitude, SS.Game.ch, { now }),
        SS.Chunks.survey(SS.Grid.chunkAt(p.latitude, p.longitude), true, now),
        SS.Chunks.survey(SS.Grid.chunkAt(p.latitude + 0.005, p.longitude), true, now)
      ]);
      return { queries: SS.OSM.stats.requests };
    }, at(14, 0));
    await page.waitForTimeout(200);
    if (maxInFlight > 1) throw new Error(maxInFlight + ' requests were in flight at once');
    if (!overpassLog.length) throw new Error('nothing was requested, so nothing was proved');
    return overpassLog.length + ' queries from four concurrent callers, ' +
           maxInFlight + ' at a time';
  });

  await step('and never two closer together than the minimum gap', async () => {
    const gap = await page.evaluate(() => SS.OSM.MIN_GAP_MS);
    const starts = overpassLog.map(e => e.at).sort((a, b) => a - b);
    if (starts.length < 2) throw new Error('only ' + starts.length + ' request(s) to measure');
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    const tight = gaps.filter(g => g < gap - 120);     // 120 ms of scheduler slack
    if (tight.length) throw new Error(tight.length + ' gap(s) under ' + gap + ' ms: ' + tight.join(', '));
    return starts.length + ' queries, tightest gap ' + Math.min.apply(null, gaps) + ' ms (floor ' + gap + ')';
  });

  await step('a 429 stops us — it does not move us onto another volunteer', async () => {
    await settle(page);
    await freshBudget(page);
    overpassLog = [];
    overpassStatus = 429;
    // Retry-After is not CORS-safelisted, so a server has to opt into letting
    // a browser read it. Overpass does not always; both paths are asserted.
    overpassHeaders = { 'Retry-After': '120', 'Access-Control-Expose-Headers': 'Retry-After' };
    const r = await page.evaluate(async (now) => {
      SS.Chunks.loaded = {};
      Object.keys(localStorage).filter(k => k.indexOf('osm_cache_') >= 0)
        .forEach(k => localStorage.removeItem(k));
      const before = SS.OSM.stats.requests;
      const res = await SS.OSM.fetchAround(41.8827, -87.6233, 400);
      return { spent: SS.OSM.stats.requests - before, res,
               coolOffS: Math.round(SS.OSM.coolOffMs() / 1000),
               endpoints: SS.OSM.ENDPOINTS.length };
    }, at(14, 10));
    overpassStatus = 200; overpassHeaders = {};
    const hosts = new Set(overpassLog.map(e => new URL(e.url).host));
    if (r.spent !== 1) throw new Error('one 429 cost ' + r.spent + ' requests');
    if (hosts.size > 1) throw new Error('it tried ' + hosts.size + ' different hosts after a 429');
    if (r.res.success) throw new Error('it reported success on a 429');
    if (Math.abs(r.coolOffS - 120) > 5) throw new Error('Retry-After: 120 became a ' + r.coolOffS + 's cool-off');
    return 'one request to one of ' + r.endpoints + ' hosts, then ' + r.coolOffS + 's of silence';
  });

  await step('while cooling off, nothing reaches the network at all', async () => {
    overpassLog = [];
    const r = await page.evaluate(async (now) => {
      const before = SS.OSM.stats.requests;
      const out = [];
      for (let i = 0; i < 4; i++) out.push(await SS.OSM.fetchAround(41.88 + i / 1000, -87.62, 400));
      SS.Game._lastChunkSync = 0;
      await SS.Game.syncChunks({ force: true, now });
      return { spent: SS.OSM.stats.requests - before,
               deferred: out.filter(x => x.deferred).length,
               told: out[0].message };
    }, at(14, 12));
    if (overpassLog.length || r.spent) throw new Error(r.spent + ' request(s) went out during the cool-off');
    if (r.deferred !== 4) throw new Error('only ' + r.deferred + ' of 4 were held back');
    return '4 calls and a full sync, 0 requests — "' + r.told + '"';
  });

  await step('the cool-off survives a reload, which is the point of it', async () => {
    const before = await page.evaluate(() => Math.round(SS.OSM.coolOffMs() / 1000));
    await page.reload();
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => Math.round(SS.OSM.coolOffMs() / 1000));
    // Back into the game, or every test after this one has no position.
    const pick = await page.$('#charList .pick');
    if (pick) { await pick.click(); await page.waitForSelector('#map', { timeout: 6000 }); }
    await page.waitForFunction(() => !!SS.Loc.last, null, { timeout: 8000 });
    await settle(page);
    if (!(after > 0)) throw new Error('reloading cleared the cool-off');
    if (after > before) throw new Error('it grew across the reload');
    return before + 's before, ' + after + 's after — a reload is not an escape';
  });

  await step('a dead service backs off per cell instead of retrying every sync', async () => {
    await page.evaluate(() => { SS.OSM.clearCoolOff(); SS.OSM._recent = []; SS.OSM._lastAt = 0; });
    overpassDown = true;
    overpassLog = [];
    const r = await page.evaluate(async (now) => {
      // Chunks.sync directly, not through Game: the game's own 20-second
      // throttle and its in-flight guard would decide how many of these calls
      // even ran, and the backoff is what is under test.
      const p = SS.Loc.last;
      const sync = (t) => SS.Chunks.sync(p.latitude, p.longitude, SS.Game.ch, { now: t });
      SS.Chunks.reset();
      Object.keys(localStorage).filter(k => k.indexOf('osm_cache_') >= 0)
        .forEach(k => localStorage.removeItem(k));
      const started = SS.OSM.stats.requests;
      await sync(now);                                         // fails, records it
      const firstRound = SS.OSM.stats.requests - started;
      const here = SS.Grid.chunkAt(p.latitude, p.longitude);
      const st = SS.Chunks.get(here.key);
      // Three more sweeps inside the backoff window, as standing still for the
      // next few seconds would produce. The cool-off is cleared each time so
      // it is the PER-CELL memory being tested, not the global one.
      for (let i = 1; i <= 3; i++) {
        SS.OSM.clearCoolOff(); SS.OSM._recent = [];
        await sync(now + i * 5000);
      }
      const after = SS.OSM.stats.requests;
      // And once the backoff has expired, it does try again.
      SS.OSM.clearCoolOff(); SS.OSM._recent = [];
      await sync(now + 40 * 60000);
      return {
        firstRound, extra: after - started - firstRound,
        retried: SS.OSM.stats.requests - after,
        marked: Object.values(SS.Chunks.all()).filter(c => c.failedAt).length,
        cells: SS.Chunks.inRange(p.latitude, p.longitude).length,
        failedAt: !!(st && st.failedAt),
        waitMin: Math.round(SS.Chunks.retryAfterMs(st) / 60000)
      };
    }, at(15, 0));
    overpassDown = false;
    if (!r.failedAt) throw new Error('the failure was not remembered against the cell');
    if (r.marked !== r.cells) throw new Error('only ' + r.marked + ' of ' + r.cells + ' cells remembered it');
    if (r.extra) throw new Error('three more syncs cost ' + r.extra + ' more queries');
    if (!r.retried) throw new Error('it never tried again, even 40 minutes later');
    return r.firstRound + ' queries, then ' + r.extra + ' across three more sweeps of ' +
           r.cells + ' cells (' + r.waitMin + ' min backoff), ' + r.retried + ' once it expired';
  });

  await step('what is cached is pruned to what we read, and still digests the same', async () => {
    await settle(page);
    await freshBudget(page);
    const r = await page.evaluate((raw) => {
      // A response as Overpass actually sends one: every tag the surveyor
      // typed, and coordinates to seven decimal places we have no use for.
      const fat = raw.map(el => Object.assign({}, el, {
        tags: Object.assign({ 'addr:housenumber': '1200', 'addr:street': 'W Adams St',
                              'building:levels': '4', source: 'survey;bing',
                              'opening_hours': 'Mo-Fr 09:00-17:00',
                              'operator': 'Some Long Operator Name Ltd',
                              'wheelchair': 'yes', 'roof:shape': 'flat' }, el.tags),
        geometry: el.geometry && el.geometry.map(p => ({
          lat: p.lat + 0.000000123, lon: p.lon + 0.000000456
        }))
      }));
      const pruned = SS.OSM.prune(fat);
      const a = SS.OSM.digest(fat), b = SS.OSM.digest(pruned);
      return {
        fatBytes: JSON.stringify(fat).length,
        prunedBytes: JSON.stringify(pruned).length,
        same: a.buildings.length === b.buildings.length &&
              a.roads.length === b.roads.length &&
              a.places.length === b.places.length,
        counts: [b.buildings.length, b.roads.length, b.places.length]
      };
    }, mockOverpass(HOME.latitude, HOME.longitude).elements);
    if (!r.same) throw new Error('pruning changed what the digest found');
    if (!(r.prunedBytes < r.fatBytes)) throw new Error('pruning made it no smaller');
    const saved = Math.round((1 - r.prunedBytes / r.fatBytes) * 100);
    return Math.round(r.fatBytes / 1024) + ' KB → ' + Math.round(r.prunedBytes / 1024) +
           ' KB (' + saved + '% off), same ' + r.counts.join('/') + ' features';
  });

  await step('standing still asks for nothing', async () => {
    await settle(page);
    await freshBudget(page);
    overpassLog = [];
    const r = await page.evaluate(async (now) => {
      // Survey once so there is something cached to answer from — the tests
      // above deliberately wiped it — then count what standing still costs.
      SS.Game._lastChunkSync = 0;
      await SS.Game.syncChunks({ force: true, now });
      const before = SS.OSM.stats.requests;
      for (let i = 1; i <= 5; i++) {
        SS.OSM._recent = [];                 // not what is under test here
        SS.Game._lastChunkSync = 0;
        await SS.Game.syncChunks({ force: true, now: now + i * 20000 });
      }
      return { spent: SS.OSM.stats.requests - before, cached: SS.Chunks.status().cached,
               survey: before };
    }, at(16, 0));
    if (!r.cached) throw new Error('nothing was cached, so zero queries proves nothing');
    if (r.spent) throw new Error('five syncs in one place cost ' + r.spent + ' queries');
    return 'five forced syncs, 0 queries, ' + r.cached + ' cell(s) answered from cache';
  });

  if (errs.length) { fail++; console.log('  FAIL page errors — ' + errs.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors'); }
  await ctx.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed  (' + overpassHits + ' Overpass queries)');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
