/* The map editor: placing, moving, resizing and deleting locations, plus the
   spawn tables and time rules that hang off them, and the game honouring both. */
const { chromium } = require('playwright');
const path = require('path');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
const fs = require('fs');
const { mockOverpass } = require('./mock-osm');

const MAP_URL    = BASE + '/mapeditor.html';
const EDITOR_URL = BASE + '/editor.html';
const GAME_URL   = BASE + '/index.html';
const LEAFLET_JS  = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

async function newPage(browser, opts) {
  const ctx = await browser.newContext(Object.assign({
    viewport: { width: 1500, height: 950 },
    geolocation: { latitude: 41.8827, longitude: -87.6233 },
    permissions: ['geolocation']
  }, opts));
  const page = await ctx.newPage();
  // These suites author their own content, so nothing seeds in underneath them.
  await emptyDatabase(page);
  page.on('dialog', d => d.accept('Test Zone'));
  // real Leaflet from node_modules; the CDN is unreachable in this sandbox
  await page.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await page.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  await page.route('**nominatim.openstreetmap.org/**', r => r.fulfill({ status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ lat: '51.5074', lon: '-0.1278', display_name: 'London, England, UK' }]) }));
  await page.route('**/api/interpreter', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(mockOverpass(41.8827, -87.6233)) }));
  return { ctx, page };
}

/* Click the map at its centre plus an offset in pixels. */
async function clickMap(page, dx, dy) {
  const box = await (await page.$('#map')).boundingBox();
  await page.mouse.click(box.x + box.width / 2 + (dx || 0), box.y + box.height / 2 + (dy || 0));
}

(async () => {
  // The game fetches its database out of data/*.json, and fetch() will not
  // touch a file:// URL — so the suites run against a real origin now.
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ============================================================ MAP EDITOR */
  console.log('\n===== MAP EDITOR =====');
  const { ctx, page } = await newPage(browser);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });

  await page.goto(MAP_URL);
  await page.waitForSelector('.meTop', { timeout: 8000 });

  await step('boots with no zone and says what to do', async () => {
    const txt = await page.textContent('.meForm');
    if (!/New zone here/.test(txt)) throw new Error('no guidance for an empty state');
    const rows = await page.$$('#meTableWrap table tbody tr');
    if (rows.length) throw new Error('rows with no zone');
    return 'empty state explained';
  });

  await step('create a zone at the map centre', async () => {
    await page.click('#meZoneNew');
    await page.waitForTimeout(400);
    const z = await page.evaluate(() => ME.Me.zone);
    if (!z) throw new Error('no zone created');
    if (!z.authoredOnly) throw new Error('new zones should default to hand-placed only');
    if (Math.abs(z.centerLatitude - 41.8827) > 0.01) throw new Error('anchored somewhere unexpected');
    return z.label + ' at ' + z.centerLatitude.toFixed(4) + ', radius ' + z.radius + ' m';
  });

  await step('place three locations by clicking the map', async () => {
    for (const [dx, dy] of [[0, 0], [90, -60], [-110, 70]]) {
      await page.click('#mePlace');
      await clickMap(page, dx, dy);
      await page.waitForTimeout(250);
    }
    const n = await page.evaluate(() => ME.Me.locations().length);
    if (n !== 3) throw new Error('expected 3, got ' + n);
    const pins = await page.$$('.locPin');
    if (pins.length !== 3) throw new Error(pins.length + ' pins drawn');
    const rows = await page.$$('#meTableWrap table tbody tr');
    if (rows.length !== 3) throw new Error(rows.length + ' table rows');
    return '3 locations, 3 pins, 3 rows';
  });

  await step('placing puts them at genuinely different points', async () => {
    const pts = await page.evaluate(() => ME.Me.locations().map(l => [l.latitude, l.longitude]));
    const same = pts.some((p, i) => pts.some((q, j) => i !== j &&
      Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9));
    if (same) throw new Error('two locations share a coordinate');
    return pts.map(p => p[0].toFixed(5)).join(' / ');
  });

  await step('fill in a location and save it', async () => {
    const id = await page.evaluate(() => ME.Me.locations()[0].locationId);
    await page.evaluate(i => ME.Me.select(i), id);
    await page.fill('#f_name', 'The Loading Dock');
    await page.selectOption('#f_kind', 'combat');
    await page.selectOption('#f_buildingType', 'foundry');
    await page.fill('#f_difficulty', '6');
    await page.click('#meSave');
    await page.waitForTimeout(250);
    const l = await page.evaluate(i => ME.Content.get('locations', i), id);
    if (l.name !== 'The Loading Dock') throw new Error('name not saved');
    if (l.buildingType !== 'foundry') throw new Error('building type not saved: ' + l.buildingType);
    if (+l.difficulty !== 6) throw new Error('difficulty not saved');
    const rowText = await page.textContent('#meTableWrap table tbody');
    if (!/Loading Dock/.test(rowText) || !/Foundry/.test(rowText)) throw new Error('table did not follow');
    return 'saved and reflected in the table';
  });

  await step('resize a location, on the slider and in the box', async () => {
    const id = await page.evaluate(() => ME.Me.selected);
    await page.fill('#f_radius', '120');
    await page.waitForTimeout(150);
    const mid = await page.evaluate(() => ({ draft: ME.Me.draft.radius,
      circle: ME.Me.circles[ME.Me.selected].getRadius(), label: document.querySelector('#f_radLabel').textContent }));
    if (mid.draft !== 120 || Math.round(mid.circle) !== 120) throw new Error('circle did not follow the box');
    await page.evaluate(() => {
      const r = document.querySelector('#f_radiusRange');
      r.value = 45; r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    await page.click('#meSave');
    await page.waitForTimeout(200);
    const saved = await page.evaluate(i => ME.Content.get('locations', i).radius, id);
    if (saved !== 45) throw new Error('saved radius is ' + saved);
    return 'box 120 → slider 45 → stored 45, circle tracked both';
  });

  await step('drag a pin and the row follows', async () => {
    const before = await page.evaluate(() => {
      const l = ME.Me.locations()[1];
      ME.Me.select(l.locationId);
      return { id: l.locationId, lat: l.latitude, lng: l.longitude };
    });
    // Leaflet drag needs real mouse events across a few frames
    const pin = (await page.$$('.locPin'))[1];
    const box = await pin.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 40, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    const after = await page.evaluate(i => ME.Content.get('locations', i), before.id);
    if (Math.abs(after.latitude - before.lat) < 1e-7 && Math.abs(after.longitude - before.lng) < 1e-7) {
      throw new Error('nothing moved');
    }
    const formLat = await page.inputValue('#f_latitude');
    if (Math.abs(parseFloat(formLat) - after.latitude) > 1e-5) throw new Error('form out of step with the pin');
    return 'moved ' + (after.latitude - before.lat).toFixed(6) + ' lat, form and store agree';
  });

  await step('typing coordinates moves the pin', async () => {
    const id = await page.evaluate(() => ME.Me.selected);
    await page.fill('#f_latitude', '41.88500');
    await page.waitForTimeout(200);
    const p = await page.evaluate(i => ME.Me.markers[i].getLatLng(), id);
    if (Math.abs(p.lat - 41.885) > 1e-6) throw new Error('marker at ' + p.lat);
    await page.click('#meSave');
    return 'pin followed the field to 41.88500';
  });

  await step('street and walk zoom presets, shared with the game', async () => {
    // The jump is animated, so read the zoom after it has settled.
    const read = () => page.evaluate(() => ({
      zoom: ME.Me.map.getZoom(),
      lit: [...document.querySelectorAll('#meZoom .zmBtn')]
        .filter(b => b.classList.contains('on')).map(b => b.dataset.z)
    }));
    const r = { max: await page.evaluate(() => ME.Me.map.options.maxZoom) };
    await page.click('#meZoom .zmBtn[data-z="walk"]');
    await page.waitForTimeout(900);
    const w = await read(); r.walk = w.zoom; r.walkLit = w.lit;
    await page.click('#meZoom .zmBtn[data-z="street"]');
    await page.waitForTimeout(900);
    const st = await read(); r.street = st.zoom; r.streetLit = st.lit;
    // The game owns the numbers; the editor should follow them.
    await page.evaluate(() => ME.Store.patch(ME.K.settings, s => { s.zoomWalk = 21; }));
    await page.click('#meZoom .zmBtn[data-z="walk"]');
    await page.waitForTimeout(900);
    r.retuned = (await read()).zoom;
    if (r.max < 24) throw new Error('map editor maxZoom only ' + r.max);
    if (!(r.street < r.walk)) throw new Error('street ' + r.street + ' not wider than walk ' + r.walk);
    if (r.walkLit.join() !== 'walk' || r.streetLit.join() !== 'street')
      throw new Error('wrong button lit: ' + r.walkLit + ' / ' + r.streetLit);
    if (r.retuned !== 21) throw new Error('editor ignored the retuned setting, went to ' + r.retuned);
    return 'street ' + r.street + ' / walk ' + r.walk + ', follows the game to ' + r.retuned;
  });

  await step('resize the zone', async () => {
    await page.evaluate(() => {
      const r = document.querySelector('#z_radiusRange');
      r.value = 700; r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    const z = await page.evaluate(() => ME.Me.zone);
    const stored = await page.evaluate(id => (ME.Store.get(ME.K.zones, {}) || {})[id].radius, await page.evaluate(() => ME.Me.zone.zoneId));
    if (z.radius !== 700 || stored !== 700) throw new Error('zone radius ' + z.radius + ' / stored ' + stored);
    return '320 → 700 m, persisted';
  });

  await step('validation catches a malformed time window', async () => {
    await page.fill('#f_timeStart', '9am');
    await page.fill('#f_timeEnd', '17:00');
    await page.click('#meSave');
    await page.waitForTimeout(200);
    const err = await page.textContent('#meErr');
    if (!/09:00/.test(err)) throw new Error('unhelpful message: ' + err);
    await page.fill('#f_timeStart', '09:00');
    await page.click('#meSave');
    await page.waitForTimeout(200);
    return '"' + err.trim() + '"';
  });

  await step('day buttons toggle and persist', async () => {
    const id = await page.evaluate(() => ME.Me.selected);
    await page.click('[data-day="1"]');
    await page.click('[data-day="3"]');
    await page.click('#meSave');
    await page.waitForTimeout(250);
    const days = await page.evaluate(i => ME.Content.get('locations', i).days, id);
    if (days.slice().sort().join(',') !== '1,3') throw new Error('days are ' + JSON.stringify(days));
    return 'Mon + Wed stored';
  });

  await step('delete removes the pin and the row', async () => {
    const before = await page.evaluate(() => ME.Me.locations().length);
    await page.click('#meDel');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ME.Me.locations().length);
    const pins = await page.$$('.locPin');
    const rows = await page.$$('#meTableWrap table tbody tr');
    if (after !== before - 1) throw new Error('count went ' + before + ' → ' + after);
    if (pins.length !== after || rows.length !== after) throw new Error('map or table out of step');
    return before + ' → ' + after + ', map and table both followed';
  });

  await step('place search accepts coordinates and place names', async () => {
    await page.fill('#meSearch', '51.5, -0.12');
    await page.click('#meGo');
    await page.waitForTimeout(300);
    const c1 = await page.evaluate(() => ME.Me.map.getCenter());
    if (Math.abs(c1.lat - 51.5) > 0.01) throw new Error('coordinates ignored');
    await page.fill('#meSearch', 'London');
    await page.click('#meGo');
    await page.waitForTimeout(600);
    const c2 = await page.evaluate(() => ME.Me.map.getCenter());
    if (Math.abs(c2.lat - 51.5074) > 0.01) throw new Error('name search ignored');
    return 'both forms move the map';
  });

  await step('everything survives a reload', async () => {
    const before = await page.evaluate(() => ({
      zone: ME.Me.zone.zoneId, radius: ME.Me.zone.radius,
      locs: ME.Content.list('locations').length
    }));
    await page.reload();
    await page.waitForSelector('.meTop', { timeout: 8000 });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      zone: ME.Me.zone.zoneId, radius: ME.Me.zone.radius,
      locs: ME.Content.list('locations').length
    }));
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(JSON.stringify(after));
    return after.locs + ' locations, zone radius ' + after.radius + ' m';
  });

  if (errors.length) { fail++; console.log('  FAIL page errors — ' + errors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no console or page errors'); }
  await ctx.close();

  /* ========================================================== SPAWN TABLES */
  console.log('\n===== SPAWN TABLES =====');
  const { ctx: c2, page: ed } = await newPage(browser);
  await ed.goto(EDITOR_URL);
  await ed.waitForSelector('.edTabs', { timeout: 8000 });

  await step('the Spawns tab exists and starts empty', async () => {
    await ed.click('[data-tab="spawns"]');
    await ed.waitForTimeout(250);
    const n = await ed.evaluate(() => ED.Content.list('spawns').length);
    if (n !== 0) throw new Error('seeded ' + n + ' unexpectedly');
    return 'empty, as seeded content has none';
  });

  await step('build a weighted spawn table', async () => {
    await ed.click('#edNew');
    await ed.fill('#f_name', 'Loading Dock Vermin');
    await ed.fill('#f_packMin', '2');
    await ed.fill('#f_packMax', '3');
    // pin down that the fields reached the draft before anything else happens,
    // so a later mismatch points at saving rather than at typing
    const typed = await ed.evaluate(() => ({ min: Ed.draft.packMin, max: Ed.draft.packMax }));
    if (typed.min !== 2 || typed.max !== 3) throw new Error('pack fields did not reach the draft: ' + JSON.stringify(typed));
    for (let i = 0; i < 3; i++) await ed.click('#edAddSpawn');
    const ids = await ed.evaluate(() => ED.Content.list('monsters').slice(0, 3).map(m => m.monsterId));
    for (let i = 0; i < 3; i++) {
      await ed.selectOption('[data-spawn="' + i + '"]', ids[i]);
      await ed.fill('[data-weight="' + i + '"]', String([60, 30, 10][i]));
    }
    await ed.click('#edSave');
    await ed.waitForTimeout(300);
    const t = await ed.evaluate(() => ED.Content.list('spawns')[0]);
    if (!t) throw new Error('not saved');
    if (t.monsters.length !== 3 || t.weights.join(',') !== '60,30,10') throw new Error(JSON.stringify(t.weights));
    if (t.packMin !== 2 || t.packMax !== 3) throw new Error('pack size is ' + JSON.stringify([t.packMin, t.packMax]) + ' in ' + JSON.stringify(t));
    return 'weights ' + t.weights.join('/') + ', pack ' + t.packMin + '–' + t.packMax;
  });

  await step('weights produce the stated proportions', async () => {
    const r = await ed.evaluate(() => {
      const t = ED.Content.list('spawns')[0];
      const odds = ED.Content.spawnOdds(t);
      const counts = [0, 0, 0];
      const N = 6000;
      for (let i = 0; i < N; i++) {
        const id = ED.Content.pickWeighted(t.monsters, t.weights);
        counts[t.monsters.indexOf(id)]++;
      }
      return { odds, pct: counts.map(c => c / N * 100) };
    });
    const want = [60, 30, 10];
    r.pct.forEach((p, i) => {
      if (Math.abs(p - want[i]) > 2.5) throw new Error('slot ' + i + ' came out at ' + p.toFixed(1) + '%');
      if (Math.abs(r.odds[i] * 100 - want[i]) > 0.01) throw new Error('displayed odds disagree');
    });
    return 'measured ' + r.pct.map(p => p.toFixed(1)).join(' / ') + ' over 6000 draws';
  });

  await step('pack size is respected', async () => {
    const r = await ed.evaluate(() => {
      const t = ED.Content.list('spawns')[0];
      let min = 99, max = 0;
      for (let i = 0; i < 400; i++) {
        const n = ED.Content.rollSpawn(t.spawnTableId, 4, 3).length;
        min = Math.min(min, n); max = Math.max(max, n);
      }
      return { min, max };
    });
    if (r.min < 2 || r.max > 3) throw new Error('packs of ' + r.min + '–' + r.max);
    return 'packs of ' + r.min + '–' + r.max + ' as declared';
  });

  await step('deleting a monster scrubs it from spawn tables', async () => {
    const r = await ed.evaluate(() => {
      const t = ED.Content.list('spawns')[0];
      const victim = t.monsters[1];
      Ed.tab = 'monsters'; Ed.renderAll(); Ed.select(victim);
      return { victim, before: t.monsters.length };
    });
    await ed.click('#edDel');
    await ed.waitForTimeout(300);
    const after = await ed.evaluate(v => {
      const t = ED.Content.list('spawns')[0];
      return { len: t.monsters.length, weights: t.weights.length, still: t.monsters.indexOf(v) >= 0 };
    }, r.victim);
    if (after.still) throw new Error('still referenced');
    if (after.len !== after.weights) throw new Error('parallel lists fell out of step');
    return r.before + ' → ' + after.len + ' entries, lists still paired';
  });
  await c2.close();

  /* ====================================================== IN-GAME BEHAVIOUR */
  console.log('\n===== LOCATIONS IN THE GAME =====');
  const { ctx: c3, page: g } = await newPage(browser);
  const gErrors = [];
  g.on('pageerror', e => gErrors.push(e.message));
  await g.goto(GAME_URL);
  await g.waitForSelector('#tReg', { timeout: 8000 });
  await g.click('#tReg');
  await g.fill('#rgUser', 'roger'); await g.fill('#rgPass', 'walk1234');
  await g.click('#rgGo');
  await g.waitForSelector('.stepBar', { timeout: 6000 });
  await g.click('.pickGrid .pick:nth-child(1)'); await g.click('#next');
  await g.click('.pickGrid .pick:nth-child(1)'); await g.click('#next');
  for (let i = 0; i < 40; i++) {
    const left = parseInt(await g.textContent('#ptsLeft'), 10); if (!left) break;
    const b = await g.$('.stepper[data-inc]:not([disabled])'); if (!b) break; await b.click();
  }
  await g.click('#next'); await g.fill('#cName', 'Bram Ashwalk'); await g.click('#next');
  await g.waitForSelector('#map', { timeout: 6000 });
  await g.waitForTimeout(2500);

  await step('an authored location becomes a site on the game map', async () => {
    const r = await g.evaluate(() => {
      const zone = SS.Game.zone;
      const loc = SS.Content.blankLocation(zone.centerLatitude + 0.0004, zone.centerLongitude, zone.zoneId);
      loc.name = 'The Loading Dock';
      loc.kind = 'combat'; loc.buildingType = 'foundry'; loc.difficulty = 5; loc.radius = 60;
      SS.Content.save('locations', loc);
      const res = SS.Game.syncAuthoredLocations();
      const node = SS.Game.nodes.find(n => n.locationId === loc.locationId);
      return { res, has: !!node, name: node && node.name, radius: node && node.radius,
               nodeId: node && node.nodeId, locId: loc.locationId };
    });
    if (!r.has) throw new Error('no node materialised');
    if (r.name !== 'The Loading Dock') throw new Error('name is ' + r.name);
    if (r.radius !== 60) throw new Error('radius is ' + r.radius);
    if (r.nodeId.indexOf(r.locId) < 0) throw new Error('node id not derived from the location');
    return r.res.added + ' added, node "' + r.name + '" with a ' + r.radius + ' m trigger';
  });

  await step('editing the location updates the site in place', async () => {
    const r = await g.evaluate(() => {
      const loc = SS.Content.list('locations')[0];
      const before = SS.Game.nodes.filter(n => n.locationId).length;
      loc.name = 'The Deep Dock'; loc.difficulty = 8;
      SS.Content.save('locations', loc);
      const res = SS.Game.syncAuthoredLocations();
      const after = SS.Game.nodes.filter(n => n.locationId);
      return { res, before, count: after.length, name: after[0].name, diff: after[0].difficulty };
    });
    if (r.count !== r.before) throw new Error('duplicated: ' + r.before + ' → ' + r.count);
    if (r.name !== 'The Deep Dock' || r.diff !== 8) throw new Error('edit not adopted');
    return 'updated in place, still ' + r.count + ' site';
  });

  await step('progress survives an edit', async () => {
    const r = await g.evaluate(() => {
      const node = SS.Game.nodes.find(n => n.locationId);
      SS.Zones.updateNode(node, { status: 'cleared', clearedAt: Date.now() });
      const loc = SS.Content.list('locations')[0];
      loc.name = 'Renamed Again';
      SS.Content.save('locations', loc);
      SS.Game.syncAuthoredLocations();
      const after = SS.Game.nodes.find(n => n.locationId);
      return { status: after.status, name: after.name };
    });
    if (r.status !== 'cleared') throw new Error('clearing was lost, status is ' + r.status);
    return 'still cleared, renamed to "' + r.name + '"';
  });

  await step('a respawn cooldown brings it back', async () => {
    const r = await g.evaluate(() => {
      const loc = SS.Content.list('locations')[0];
      loc.respawnMinutes = 30;
      SS.Content.save('locations', loc);
      const node = SS.Game.nodes.find(n => n.locationId);
      // cleared 10 minutes ago: still down
      SS.Zones.updateNode(node, { status: 'cleared', clearedAt: Date.now() - 10 * 60000 });
      SS.Game.refreshAuthoredState();
      const early = SS.Game.nodes.find(n => n.locationId).status;
      // cleared 45 minutes ago: back
      SS.Zones.updateNode(node, { status: 'cleared', clearedAt: Date.now() - 45 * 60000 });
      SS.Game.refreshAuthoredState();
      const late = SS.Game.nodes.find(n => n.locationId).status;
      return { early, late };
    });
    if (r.early !== 'cleared') throw new Error('came back too early');
    if (r.late === 'cleared') throw new Error('never came back');
    return '10 min → ' + r.early + ', 45 min → ' + r.late;
  });

  await step('opening hours close and open the site', async () => {
    const r = await g.evaluate(() => {
      const loc = SS.Content.list('locations')[0];
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const at = (mins) => { const d = new Date(now.getTime() + mins * 60000);
        return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
      // a window that starts in an hour: shut
      loc.timeStart = at(60); loc.timeEnd = at(180); loc.days = []; loc.respawnMinutes = 0;
      SS.Content.save('locations', loc);
      SS.Game.syncAuthoredLocations();
      const shut = SS.Game.nodes.find(n => n.locationId).closed;
      // a window that already started: open
      loc.timeStart = at(-60); loc.timeEnd = at(60);
      SS.Content.save('locations', loc);
      SS.Game.syncAuthoredLocations();
      const open = SS.Game.nodes.find(n => n.locationId).closed;
      // and a window that wraps past midnight, covering now
      loc.timeStart = at(-30); loc.timeEnd = at(-60);
      SS.Content.save('locations', loc);
      const wrap = SS.Content.isLocationActive(SS.Content.list('locations')[0]);
      return { shut, open, wrap };
    });
    if (r.shut !== true) throw new Error('a future window did not close the site');
    if (r.open !== false) throw new Error('a current window did not open it');
    if (r.wrap !== true) throw new Error('a window wrapping midnight was misread');
    return 'future → closed, current → open, midnight wrap handled';
  });

  await step('the wrong day closes it', async () => {
    const r = await g.evaluate(() => {
      const loc = SS.Content.list('locations')[0];
      loc.timeStart = ''; loc.timeEnd = '';
      const today = new Date().getDay();
      loc.days = [(today + 3) % 7];
      SS.Content.save('locations', loc);
      SS.Game.syncAuthoredLocations();
      const shut = SS.Game.nodes.find(n => n.locationId).closed;
      loc.days = [today];
      SS.Content.save('locations', loc);
      SS.Game.syncAuthoredLocations();
      const open = SS.Game.nodes.find(n => n.locationId).closed;
      return { shut, open };
    });
    if (r.shut !== true || r.open !== false) throw new Error(JSON.stringify(r));
    return 'other day → closed, today → open';
  });

  await step('a location with a spawn table fights exactly those monsters', async () => {
    const r = await g.evaluate(() => {
      const wanted = SS.Content.list('monsters').slice(0, 2);
      const t = SS.Content.blankSpawnTable();
      t.name = 'Dock Vermin';
      t.monsters = wanted.map(m => m.monsterId);
      t.weights = [50, 50];
      t.packMin = 3; t.packMax = 3;
      const saved = SS.Content.save('spawns', t);
      const loc = SS.Content.list('locations')[0];
      loc.spawnTableId = saved.spawnTableId;
      loc.days = []; loc.timeStart = ''; loc.timeEnd = '';
      SS.Content.save('locations', loc);
      SS.Game.syncAuthoredLocations();
      const node = SS.Game.nodes.find(n => n.locationId);
      const pack = SS.Bestiary.packFor(node, 5);
      return { names: pack.map(e => e.name), allowed: wanted.map(m => m.name), size: pack.length };
    });
    if (r.size !== 3) throw new Error('pack of ' + r.size + ', wanted 3');
    const stray = r.names.filter(n => r.allowed.indexOf(n) < 0);
    if (stray.length) throw new Error('unexpected monsters: ' + stray.join(', '));
    return 'pack of ' + r.size + ': ' + r.names.join(', ');
  });

  await step('a chest holds its own loot table', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      c.inventory = [];
      const table = SS.Content.list('loot')[0];
      const loc = SS.Content.list('locations')[0];
      loc.kind = 'treasure'; loc.chestTier = 'gilded'; loc.chestLootTableId = table.lootTableId;
      SS.Content.save('locations', loc);
      SS.Game.syncAuthoredLocations();
      const node = SS.Game.nodes.find(n => n.locationId);
      SS.Zones.updateNode(node, { status: 'discovered', clearedAt: null });
      SS.Game.looseTreasure(node);
      const allowed = new Set(table.loot);
      return { drops: c.inventory.map(i => ({ name: i.name, from: allowed.has(i.defId) })),
               tier: SS.Content.chestTier('gilded').rolls, table: table.name };
    });
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    if (!r.drops.length) throw new Error('the chest was empty');
    const stray = r.drops.filter(d => !d.from);
    if (stray.length) throw new Error('drops from outside the table: ' + stray.map(d => d.name).join(', '));
    return r.drops.length + ' items, all from "' + r.table + '" (' + r.tier + ' rolls)';
  });

  await step('deleting the location removes its site', async () => {
    const r = await g.evaluate(() => {
      const loc = SS.Content.list('locations')[0];
      SS.Content.remove('locations', loc.locationId);
      const res = SS.Game.syncAuthoredLocations();
      const left = SS.Game.nodes.filter(n => n.locationId).length;
      const inStore = Object.values(SS.Store.get(SS.K.nodes, {}) || {}).filter(n => n.locationId).length;
      return { res, left, inStore };
    });
    if (r.left || r.inStore) throw new Error('node survived: ' + r.left + ' live, ' + r.inStore + ' stored');
    return 'removed from the live list and from storage';
  });

  await step('a hand-placed zone stops scattering procedural sites', async () => {
    const r = await g.evaluate(() => {
      const zone = SS.Game.zone;
      const proceduralBefore = SS.Zones.nodesIn(zone.zoneId).filter(n => !n.locationId).length;
      zone.authoredOnly = true;
      SS.Store.patch(SS.K.zones, all => { all[zone.zoneId] = zone; });
      // re-enter the zone the way the game does on load
      SS.Game.zone = null; SS.Game.nodes = [];
      SS.Game.ensureZone();
      const live = SS.Game.nodes.length;
      const stillStored = SS.Zones.nodesIn(zone.zoneId).filter(n => !n.locationId).length;
      const respawned = SS.Zones.respawnCleared(zone, 5);
      return { proceduralBefore, live, stillStored, respawned };
    });
    if (!r.proceduralBefore) throw new Error('no procedural sites to begin with');
    if (r.live) throw new Error(r.live + ' sites still live in a hand-placed zone');
    if (r.stillStored !== r.proceduralBefore) throw new Error('procedural sites were destroyed, not hidden');
    if (r.respawned) throw new Error('respawn reshuffled a hand-placed zone');
    return r.proceduralBefore + ' procedural sites hidden but kept, respawn suppressed';
  });

  if (gErrors.length) { fail++; console.log('  FAIL game page errors — ' + gErrors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the game'); }
  await c3.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
