/* Weighted spawning: parks and shops arriving in the Atlas, then the rules
   that decide what appears where and when.

   The schedule is measured in hours, so nothing here waits on a clock — the
   spawner takes `now` as an argument and the suite drives it. Everything that
   looks like the passage of time in this file is a number being handed in. */
const { chromium } = require('playwright');
const path = require('path');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
const fs = require('fs');
const { mockOverpass } = require('./mock-osm');

const GAME_URL = BASE + '/index.html';
const LEAFLET_JS  = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

/* A fixed local time on a fixed day, so a window test means something.
   Month is 0-based: this is 11 September 2026. */
const at = (h, m) => new Date(2026, 8, 11, h, m || 0).getTime();

async function newPage(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 900 },
    geolocation: { latitude: 41.8827, longitude: -87.6233 },
    permissions: ['geolocation']
  });
  const page = await ctx.newPage();
  // The suite authors its own world; the samples in data/ would skew counts.
  await emptyDatabase(page);
  await page.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await page.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  await page.route('**/api/interpreter', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(mockOverpass(41.8827, -87.6233)) }));
  return { ctx, page };
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
  await page.fill('#rgUser', 'spawner'); await page.fill('#rgPass', 'walk1234');
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

  /* ===================================================== THE PLACES TABLE */
  console.log('\n===== PARKS AND SHOPS IN THE ATLAS =====');

  await step('the survey brings back places, not just buildings and roads', async () => {
    const r = await page.evaluate(() => {
      const s = SS.Atlas.stats();
      return { places: s.places, byCat: s.placesByCategory, buildings: s.buildings };
    });
    if (!r.places) throw new Error('no places recorded at all');
    ['park', 'food', 'civic', 'transit'].forEach(c => {
      if (!r.byCat[c]) throw new Error('no ' + c + ' places: ' + JSON.stringify(r.byCat));
    });
    return r.places + ' places — ' + Object.entries(r.byCat).map(([k, v]) => v + ' ' + k).join(', ');
  });

  await step('a park arrives as a polygon and a cafe as a point', async () => {
    const r = await page.evaluate(() => {
      const t = SS.Atlas.table('places');
      const rows = Object.values(t);
      const park = rows.find(x => x.osmKind === 'leisure=park');
      const cafe = rows.find(x => x.osmKind === 'amenity=cafe');
      return {
        parkRing: park && park.ring ? park.ring.length : 0,
        parkName: park && park.name,
        parkReal: park && park.realName,
        cafeRing: cafe ? cafe.ring : 'missing',
        cafeCat: cafe && cafe.category
      };
    });
    if (r.parkRing < 3) throw new Error('the park has no usable ring: ' + r.parkRing);
    if (r.cafeRing !== null) throw new Error('a node POI should carry no ring, got ' + r.cafeRing);
    if (r.cafeCat !== 'food') throw new Error('cafe categorised as ' + r.cafeCat);
    if (!r.parkName) throw new Error('the park got no fantasy name');
    return '"' + r.parkName + '" (' + r.parkReal + '), ' + r.parkRing + '-point ring';
  });

  await step('a supermarket is both a building and a place', async () => {
    const r = await page.evaluate(() => {
      const places = Object.values(SS.Atlas.table('places'));
      const builds = Object.values(SS.Atlas.table('buildings'));
      const shop = places.find(x => x.osmKind === 'shop=supermarket');
      const asBuilding = shop && builds.find(b => b.osmId === shop.osmId);
      return { shopCat: shop && shop.category, alsoBuilding: !!asBuilding,
               buildingKind: asBuilding && asBuilding.kind };
    });
    if (r.shopCat !== 'food') throw new Error('supermarket is ' + r.shopCat);
    if (!r.alsoBuilding) throw new Error('it was recorded as a place but lost as a building');
    return 'food place + ' + r.buildingKind + ' building, same OSM way';
  });

  await step('point-in-polygon beats distance-to-centroid', async () => {
    const r = await page.evaluate(() => {
      const park = Object.values(SS.Atlas.table('places')).find(x => x.osmKind === 'leisure=park');
      const ring = park.ring;
      let minLat = 1e9, maxLat = -1e9, minLng = 1e9, maxLng = -1e9;
      ring.forEach(p => {
        minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]);
        minLng = Math.min(minLng, p[1]); maxLng = Math.max(maxLng, p[1]);
      });
      const inside = SS.Content.pointInRing(ring, (minLat + maxLat) / 2, (minLng + maxLng) / 2);
      // A corner just outside the box is nearer the centroid than some points
      // that are genuinely inside a long thin park — the whole reason for this.
      const outside = SS.Content.pointInRing(ring, maxLat + 0.0004, maxLng + 0.0004);
      const found = SS.Atlas.placeAt((minLat + maxLat) / 2, (minLng + maxLng) / 2, 5);
      return { inside, outside, foundName: found && found.name, foundCat: found && found.category };
    });
    if (!r.inside) throw new Error('the centre of the park is not in the park');
    if (r.outside) throw new Error('a point outside the ring read as inside');
    if (r.foundCat !== 'park') throw new Error('placeAt found ' + r.foundCat);
    return 'inside yes, outside no, placeAt -> "' + r.foundName + '"';
  });

  /* ======================================================== THE WEIGHTING */
  console.log('\n===== WEIGHTS =====');

  await step('the rules file loaded, not the flat fallback', async () => {
    const r = await page.evaluate(() => ({
      contrast: SS.Placement.rules().contrast,
      parkW: SS.Placement.rulesFor('dungeons').categories.park.weight,
      foodWindows: SS.Placement.rulesFor('instances').categories.food.windows
    }));
    if (r.parkW == null) throw new Error('no park weight — data/spawn-rules.json did not load');
    if (!r.foodWindows.length) throw new Error('food has no windows');
    return 'contrast ' + r.contrast + ', park ' + r.parkW + ', food windows ' +
           r.foodWindows.map(w => w.join('-')).join(' & ');
  });

  await step('popular places win more often, but not overwhelmingly', async () => {
    const r = await page.evaluate((when) => {
      const zone = SS.Game.zone;
      const cands = SS.Placement.candidates(zone, 'dungeons', when);
      const counts = {};
      const N = 6000;
      for (let i = 0; i < N; i++) {
        const c = SS.Placement.pickByCategory(cands, 'dungeons', when);
        counts[c.category] = (counts[c.category] || 0) + 1;
      }
      const pct = {};
      Object.keys(counts).forEach(k => { pct[k] = counts[k] / N; });
      return { pct, nCands: cands.length };
    }, at(12, 0));
    const p = r.pct;
    if (!p.park || !p.other) throw new Error('a category never came up: ' + JSON.stringify(p));
    if (!(p.park > p.food && p.food > p.civic && p.civic > p.transit && p.transit > p.other)) {
      throw new Error('order is wrong: ' + JSON.stringify(p));
    }
    // The point of the contrast dial: favoured, not dominant.
    const ratio = p.park / p.other;
    if (ratio > 6) throw new Error('park beats other ' + ratio.toFixed(1) + ':1 — too stark');
    if (ratio < 2) throw new Error('park beats other only ' + ratio.toFixed(1) + ':1 — not noticeable');
    return Object.entries(p).map(([k, v]) => k + ' ' + Math.round(v * 100) + '%').join(', ') +
           ' (park:other ' + ratio.toFixed(1) + ':1 over ' + r.nCands + ' candidates)';
  });

  await step('many buildings do not outvote few parks', async () => {
    const r = await page.evaluate((when) => {
      const zone = SS.Game.zone;
      const cands = SS.Placement.candidates(zone, 'dungeons', when);
      const byCat = {};
      cands.forEach(c => { byCat[c.category] = (byCat[c.category] || 0) + 1; });
      let parks = 0;
      for (let i = 0; i < 3000; i++) {
        if (SS.Placement.pickByCategory(cands, 'dungeons', when).category === 'park') parks++;
      }
      return { byCat, parkShare: parks / 3000 };
    }, at(12, 0));
    // There are far more buildings than parks in the fixture; if candidates
    // were weighted one by one the parks would be swamped.
    if (r.byCat.other < r.byCat.park * 3) throw new Error('fixture does not exercise this');
    if (r.parkShare < 0.2) throw new Error('parks only won ' + Math.round(r.parkShare * 100) +
      '% against ' + r.byCat.other + ' buildings — candidates are being weighted individually');
    return r.byCat.other + ' buildings vs ' + r.byCat.park + ' parks, parks still won ' +
           Math.round(r.parkShare * 100) + '%';
  });

  await step('the contrast dial flattens and sharpens', async () => {
    const r = await page.evaluate((when) => {
      const spread = (c) => {
        SS.DB.raw.spawnRules.contrast = c;
        const hi = SS.Placement.categoryWeight('dungeons', 'park', when);
        const lo = SS.Placement.categoryWeight('dungeons', 'other', when);
        return hi / lo;
      };
      const flat = spread(0), soft = spread(0.55), hard = spread(1);
      SS.DB.raw.spawnRules.contrast = 0.55;
      return { flat, soft, hard };
    }, at(12, 0));
    if (Math.abs(r.flat - 1) > 0.01) throw new Error('contrast 0 should be uniform, got ' + r.flat);
    if (!(r.soft > 2 && r.soft < r.hard)) throw new Error('0.55 did not sit between: ' + JSON.stringify(r));
    if (Math.abs(r.hard - 10) > 0.1) throw new Error('contrast 1 should be the raw 10:1, got ' + r.hard);
    return '0 -> ' + r.flat.toFixed(1) + ':1, 0.55 -> ' + r.soft.toFixed(1) +
           ':1, 1 -> ' + r.hard.toFixed(1) + ':1';
  });

  /* ============================================================= WINDOWS */
  console.log('\n===== TIME WINDOWS =====');

  await step('parks favour mornings and evenings, food favours meals', async () => {
    const r = await page.evaluate((times) => {
      const w = (cat, t) => SS.Placement.categoryWeight('instances', cat, t);
      return {
        parkMorning: w('park', times.morning), parkNoon: w('park', times.noon),
        foodNoon: w('food', times.noon), foodMorning: w('food', times.morning),
        parkEvening: w('park', times.evening), foodDinner: w('food', times.dinner)
      };
    }, { morning: at(7, 30), noon: at(12, 30), evening: at(17, 30), dinner: at(18, 30) });
    if (!(r.parkMorning > r.parkNoon)) throw new Error('parks are not favoured at 07:30');
    if (!(r.foodNoon > r.foodMorning)) throw new Error('food is not favoured at 12:30');
    if (!(r.parkEvening > r.parkNoon)) throw new Error('parks are not favoured at 17:30');
    if (!(r.foodDinner > r.foodMorning)) throw new Error('food is not favoured at 18:30');
    return 'park 07:30 ' + r.parkMorning.toFixed(2) + ' vs 12:30 ' + r.parkNoon.toFixed(2) +
           '; food 12:30 ' + r.foodNoon.toFixed(2) + ' vs 07:30 ' + r.foodMorning.toFixed(2);
  });

  await step('out of hours is quieter, never silent', async () => {
    const r = await page.evaluate((t) => {
      const w = SS.Placement.categoryWeight('instances', 'food', t.closed);
      const open = SS.Placement.categoryWeight('instances', 'food', t.open);
      const cands = [{ category: 'food', row: {}, latitude: 0, longitude: 0 }];
      let picked = 0;
      for (let i = 0; i < 200; i++) if (SS.Placement.pickByCategory(cands, 'instances', t.closed)) picked++;
      return { closed: w, open, picked };
    }, { closed: at(3, 0), open: at(12, 30) });
    if (!(r.closed > 0)) throw new Error('a closed category fell to zero — it is a weight, not a gate');
    if (!(r.closed < r.open)) throw new Error('closed is not quieter than open');
    if (r.picked !== 200) throw new Error('a closed category became unpickable');
    return '3am ' + r.closed.toFixed(2) + ' vs 12:30 ' + r.open.toFixed(2) + ', still always pickable';
  });

  await step('a window that wraps past midnight still works', async () => {
    const r = await page.evaluate((times) => {
      const night = [['22:00', '02:00']];
      return {
        atEleven: SS.Placement.windowOpen(night, times.eleven),
        atOne: SS.Placement.windowOpen(night, times.one),
        atNoon: SS.Placement.windowOpen(night, times.noon)
      };
    }, { eleven: at(23, 0), one: at(1, 0), noon: at(12, 0) });
    if (!r.atEleven || !r.atOne) throw new Error('the wrap is broken: ' + JSON.stringify(r));
    if (r.atNoon) throw new Error('noon read as inside a 22:00-02:00 window');
    return '23:00 yes, 01:00 yes, 12:00 no';
  });

  /* ============================================================ LIFECYCLE */
  console.log('\n===== THE DUNGEON CYCLE =====');

  await step('a tick puts exactly one dungeon out', async () => {
    const r = await page.evaluate((now) => {
      SS.Spawner.reset(SS.Game.zone);
      SS.Content.replaceAll('dungeons', []);
      const first = SS.Spawner.tick(SS.Game.zone, { now });
      const again = SS.Spawner.tick(SS.Game.zone, { now: now + 1000 });
      const rows = SS.Content.list('dungeons');
      return { first, again, n: rows.length, row: rows[0] && {
        origin: rows[0].origin, cat: rows[0].placeCategory, name: rows[0].name,
        radius: rows[0].radius, lifeMins: Math.round((rows[0].expiresAt - now) / 60000)
      } };
    }, at(12, 0));
    if (r.n !== 1) throw new Error(r.n + ' dungeons after two ticks');
    if (r.again !== 0) throw new Error('the second tick spawned another');
    if (r.row.origin !== 'auto') throw new Error('not marked as ours');
    if (!(r.row.lifeMins >= 120 && r.row.lifeMins <= 220)) {
      throw new Error('lifetime is ' + r.row.lifeMins + ' min, expected about 180');
    }
    return '"' + r.row.name + '" at a ' + r.row.cat + ', ' + r.row.radius + ' m, ' +
           r.row.lifeMins + ' min';
  });

  await step('the lifetime is weighted too — a park holds longer than a car park', async () => {
    const r = await page.evaluate(() => ({
      park: SS.Placement.lifetimeMs('dungeons', 'park') / 60000,
      other: SS.Placement.lifetimeMs('dungeons', 'other') / 60000,
      base: SS.Placement.rulesFor('dungeons').lifetimeMinutes
    }));
    if (!(r.park > r.base && r.other < r.base)) throw new Error(JSON.stringify(r));
    return 'park ' + r.park + ' min, base ' + r.base + ', other ' + r.other;
  });

  await step('after three hours it goes, and the next waits fifteen minutes', async () => {
    const r = await page.evaluate((now) => {
      const zone = SS.Game.zone;
      const before = SS.Content.list('dungeons').length;
      const live = SS.Content.list('dungeons')[0];
      const past = live.expiresAt + 1000;
      const swept = SS.Spawner.tick(zone, { now: past });
      const mid = SS.Content.list('dungeons').length;
      // Still inside the gap — nothing should come back yet.
      const early = SS.Spawner.tick(zone, { now: past + 5 * 60000 });
      const duringGap = SS.Content.list('dungeons').length;
      // Past the gap.
      SS.Spawner.tick(zone, { now: past + 16 * 60000 });
      const after = SS.Content.list('dungeons').length;
      return { before, mid, duringGap, after, swept, early };
    }, at(12, 0));
    if (r.before !== 1) throw new Error('nothing was live to expire');
    if (r.mid !== 0) throw new Error('the expired dungeon stayed');
    if (r.duringGap !== 0) throw new Error('a replacement arrived during the fifteen-minute gap');
    if (r.after !== 1) throw new Error('no replacement after the gap: ' + r.after);
    return 'expired, empty for 15 min, then replaced';
  });

  await step('clearing one also starts the gap', async () => {
    const r = await page.evaluate((now) => {
      const zone = SS.Game.zone;
      const d = SS.Content.list('dungeons')[0];
      SS.Dungeon.markCleared(d.dungeonId);
      const swept = SS.Spawner.tick(zone, { now });
      const emptied = SS.Content.list('dungeons').length;
      const during = (SS.Spawner.tick(zone, { now: now + 60000 }),
                      SS.Content.list('dungeons').length);
      SS.Spawner.tick(zone, { now: now + 16 * 60000 });
      return { swept, emptied, during, after: SS.Content.list('dungeons').length };
    }, at(14, 0));
    if (r.emptied !== 0) throw new Error('a cleared dungeon was left on the map');
    if (r.during !== 0) throw new Error('replaced during the gap');
    if (r.after !== 1) throw new Error('never replaced');
    return 'cleared -> swept -> 15 min gap -> replaced';
  });

  await step('it will not delete one you are standing in', async () => {
    const r = await page.evaluate((now) => {
      const zone = SS.Game.zone;
      const d = SS.Content.list('dungeons')[0];
      d.expiresAt = now - 1000;               // overdue
      SS.Content.save('dungeons', d);
      SS.Dungeon.begin(d);
      const inside = !!SS.Dungeon.current();
      SS.Spawner.tick(zone, { now });
      const survived = !!SS.Content.get('dungeons', d.dungeonId);
      SS.Dungeon.abandon(true);
      return { inside, survived };
    }, at(15, 0));
    if (!r.inside) throw new Error('could not get into it to test');
    if (!r.survived) throw new Error('it swept the floor out from under the player');
    return 'overdue but occupied, left alone';
  });

  await step('hand-placed dungeons are never touched', async () => {
    const r = await page.evaluate((now) => {
      const zone = SS.Game.zone;
      const mine = SS.Content.blankDungeon(zone.centerLatitude + 0.001,
                                           zone.centerLongitude + 0.001, zone.zoneId);
      mine.name = 'Mine, by hand';
      mine.floors = [SS.Content.blankFloor(1)];
      mine.expiresAt = now - 999999;          // even if it looks overdue
      SS.Content.save('dungeons', mine);

      /* Six hours of ticks. A spawned dungeon lives two to three and a half
         hours depending on where it landed, so over this span some will be
         swept and replaced — which is the point. What is checked is the
         invariant across every one of them: the hand-placed dungeon is always
         there, and there is never more than one spawned beside it. */
      let maxAutos = 0, everMissing = false, gapSeen = -1;
      for (let i = 0; i < 6; i++) {
        SS.Spawner.tick(zone, { now: now + i * 3600000 });
        if (!SS.Content.get('dungeons', mine.dungeonId)) everMissing = true;
        const live = SS.Content.list('dungeons').filter(d => d.origin === 'auto');
        maxAutos = Math.max(maxAutos, live.length);
        if (live.length && gapSeen < 0) gapSeen = i;
      }
      const still = everMissing ? null : SS.Content.get('dungeons', mine.dungeonId);
      const autos = SS.Content.list('dungeons').filter(d => d.origin === 'auto');
      const sample = autos[0] || SS.Content.list('dungeons').find(d => d.origin === 'auto');
      const H = (a, b, c, d) => {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(c - a), dLon = tr(d - b);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a)) * Math.cos(tr(c)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      return {
        still: !!still, name: still && still.name, maxAutos, everMissing,
        gap: sample ? Math.round(H(mine.latitude, mine.longitude,
                                   sample.latitude, sample.longitude)) : -1
      };
    }, at(16, 0));
    if (r.everMissing || !r.still) throw new Error('it deleted a hand-placed dungeon');
    if (r.maxAutos > 1) throw new Error(r.maxAutos + ' spawned dungeons alive at once');
    // A hand-placed dungeon must not block spawning — it is not one of ours,
    // so it does not fill the single slot.
    if (r.maxAutos !== 1) throw new Error('a hand-placed dungeon blocked the spawner entirely');
    if (r.gap >= 0 && r.gap < 60) throw new Error('spawned ' + r.gap + ' m from the hand-placed one');
    return '"' + r.name + '" survived six hours of ticks; never more than ' + r.maxAutos +
           ' spawned beside it' + (r.gap >= 0 ? ', ' + r.gap + ' m away' : '');
  });

  await step('a spawn keeps its distance from what is already there', async () => {
    const r = await page.evaluate((now) => {
      const zone = SS.Game.zone;
      const sep = SS.Placement.rulesFor('dungeons').minSeparationM;
      const H = (a, b, c, d) => {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(c - a), dLon = tr(d - b);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a)) * Math.cos(tr(c)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      // Fill the zone with hand-placed dungeons, then see where a spawn lands.
      SS.Content.replaceAll('dungeons', []);
      SS.Spawner.reset(zone);
      const anchor = SS.Content.blankDungeon(zone.centerLatitude, zone.centerLongitude, zone.zoneId);
      anchor.floors = [SS.Content.blankFloor(1)];
      SS.Content.save('dungeons', anchor);
      SS.Spawner.tick(zone, { now });
      const spawned = SS.Content.list('dungeons').find(d => d.origin === 'auto');
      return {
        sep,
        gap: spawned ? Math.round(H(anchor.latitude, anchor.longitude,
                                    spawned.latitude, spawned.longitude)) : -1
      };
    }, at(17, 0));
    if (r.gap < 0) throw new Error('nothing spawned to measure');
    // The zone is smaller than the separation, so the fallback is expected to
    // kick in — what must not happen is landing on top of the anchor.
    if (r.gap < 30) throw new Error('spawned ' + r.gap + ' m from an existing dungeon');
    return 'separation asks for ' + r.sep + ' m; in a ' +
           (2 * 320) + ' m zone it got ' + r.gap + ' m and did not stack';
  });

  /* ============================================================ INSTANCES */
  console.log('\n===== THE INSTANCE DAY =====');

  await step('one or two a day, and a reload does not reroll it', async () => {
    const r = await page.evaluate((now) => {
      const zone = SS.Game.zone;
      SS.Content.replaceAll('instances', []);
      SS.Spawner.reset(zone);
      SS.Spawner.tick(zone, { now });
      const first = SS.Spawner.state(zone.zoneId).target;
      // Tick many more times across the same day: the target must not move.
      for (let h = 0; h < 14; h++) SS.Spawner.tick(zone, { now: now + h * 3600000 });
      const still = SS.Spawner.state(zone.zoneId).target;
      const lo = SS.Placement.rulesFor('instances').perDayMin;
      const hi = SS.Placement.rulesFor('instances').perDayMax;
      return { first, still, lo, hi, spawned: SS.Spawner.state(zone.zoneId).spawned };
    }, at(7, 0));
    if (!(r.first >= r.lo && r.first <= r.hi)) throw new Error('target ' + r.first + ' outside ' + r.lo + '-' + r.hi);
    if (r.still !== r.first) throw new Error('the day rerolled: ' + r.first + ' -> ' + r.still);
    if (r.spawned > r.first) throw new Error('spawned ' + r.spawned + ' against a target of ' + r.first);
    return 'target ' + r.first + ' (' + r.lo + '-' + r.hi + '), held across 14 ticks, ' +
           r.spawned + ' placed';
  });

  await step('the allowance is not spent at 3am', async () => {
    const r = await page.evaluate((night) => {
      const zone = SS.Game.zone;
      SS.Content.replaceAll('instances', []);
      SS.Spawner.reset(zone);
      for (let i = 0; i < 5; i++) SS.Spawner.tick(zone, { now: night + i * 60000 });
      const atNight = SS.Content.list('instances').length;
      // Now move to a lunchtime on the same day.
      const lunch = night + 9 * 3600000;
      SS.Spawner.tick(zone, { now: lunch });
      return { atNight, atLunch: SS.Content.list('instances').length };
    }, at(3, 0));
    if (r.atNight) throw new Error('spawned ' + r.atNight + ' instances at 3am');
    if (!r.atLunch) throw new Error('nothing arrived at lunch either');
    return 'nothing at 3am, ' + r.atLunch + ' at noon';
  });

  await step('a new day rolls a fresh allowance', async () => {
    const r = await page.evaluate((noon) => {
      const zone = SS.Game.zone;
      const dayOne = SS.Spawner.state(zone.zoneId).day;
      const tomorrow = noon + 24 * 3600000;
      SS.Content.replaceAll('instances', []);
      SS.Spawner.tick(zone, { now: tomorrow });
      const st = SS.Spawner.state(zone.zoneId);
      return { dayOne, dayTwo: st.day, spawnedToday: st.spawned };
    }, at(12, 0));
    if (r.dayOne === r.dayTwo) throw new Error('the day never turned over: ' + r.dayOne);
    if (r.spawnedToday > 1) throw new Error('the new day started mid-count');
    return r.dayOne + ' -> ' + r.dayTwo;
  });

  /* ============================================================= LOCATIONS */
  console.log('\n===== WEIGHTED LOCATION SNAPPING =====');

  await step('a building by a road scores above one in the middle of nowhere', async () => {
    const r = await page.evaluate(() => {
      const roads = SS.Game.world.roads;
      const builds = Object.values(SS.Atlas.table('buildings'));
      const scored = builds.map(b => ({
        kind: b.kind,
        d: Math.round(SS.Placement.distanceToRoad(b.latitude, b.longitude, roads)),
        w: SS.Placement.scoreBuilding(b, roads, Date.now())
      })).sort((a, b) => a.d - b.d);
      const near = scored[0], far = scored[scored.length - 1];
      return { near, far, n: scored.length };
    });
    if (!(r.near.w > r.far.w)) {
      throw new Error('nearest-to-a-road (' + r.near.d + ' m) did not outscore the farthest (' +
        r.far.d + ' m): ' + r.near.w.toFixed(2) + ' vs ' + r.far.w.toFixed(2));
    }
    return r.near.d + ' m away scores ' + r.near.w.toFixed(2) + ', ' +
           r.far.d + ' m away scores ' + r.far.w.toFixed(2) + ' (' + r.n + ' buildings)';
  });

  await step('every building stays reachable — nothing is scored to zero', async () => {
    const r = await page.evaluate(() => {
      const roads = SS.Game.world.roads;
      const builds = Object.values(SS.Atlas.table('buildings'));
      const ws = builds.map(b => SS.Placement.scoreBuilding(b, roads, Date.now()));
      return { min: Math.min.apply(null, ws), max: Math.max.apply(null, ws), n: ws.length };
    });
    if (!(r.min > 0)) throw new Error('a building scored ' + r.min);
    return 'lowest ' + r.min.toFixed(2) + ', highest ' + r.max.toFixed(2) + ' across ' + r.n;
  });

  if (errs.length) { fail++; console.log('  FAIL page errors — ' + errs.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors'); }
  await ctx.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
