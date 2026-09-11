/* A look at what the last round of changes actually renders: an instance floor
   (one rectangle with walls and fog), the real map with a location's PNG on it,
   and the map editor's art panel. Screenshots land in tools/screenshots/. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { serve, BASE } = require('./serve');
const { mockOverpass } = require('./mock-osm');

const LEAFLET_JS  = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');
const OUT = path.resolve(__dirname, 'screenshots');

(async () => {
  await serve();
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2,
    geolocation: { latitude: 41.8827, longitude: -87.6233 }, permissions: ['geolocation'] });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errs.push(m.text()); });
  await p.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await p.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  await p.route('**tile.openstreetmap.org/**', r => r.abort());
  await p.route('**/api/interpreter', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(mockOverpass(41.8827, -87.6233)) }));

  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#tReg', { timeout: 8000 });
  await p.click('#tReg');
  await p.fill('#rgUser', 'shot'); await p.fill('#rgPass', 'walk1234');
  await p.click('#rgGo');
  await p.waitForSelector('.stepBar', { timeout: 6000 });
  await p.click('.pickGrid .pick:nth-child(1)'); await p.click('#next');
  await p.click('.pickGrid .pick:nth-child(1)'); await p.click('#next');
  for (let i = 0; i < 40; i++) {
    const l = parseInt(await p.textContent('#ptsLeft'), 10); if (!l) break;
    const s = await p.$('.stepper[data-inc]:not([disabled])'); if (!s) break; await s.click();
  }
  await p.click('#next'); await p.fill('#cName', 'Bram Ashwalk'); await p.click('#next');
  await p.waitForSelector('#map', { timeout: 6000 });
  await p.waitForTimeout(3000);

  console.log('seeded tables:', await p.evaluate(() => SS.Content.stats()));
  console.log('zone:', await p.evaluate(() => SS.Game.zone && SS.Game.zone.label));
  console.log('art overlays on the map:', await p.evaluate(() =>
    document.querySelectorAll('img.locArt, .locArt').length));
  console.log('seed rehomed:', await p.evaluate(() => !!SS.Store.get('seed_rehomed', null)));
  await p.evaluate(() => SS.Game.map.setZoom(19));
  await p.waitForTimeout(900);
  await p.screenshot({ path: path.join(OUT, 'v-map-with-art.png') });

  // --- spawning: force one out and look at it on the map.
  console.log('atlas places:', await p.evaluate(() => SS.Atlas.stats().placesByCategory));
  console.log('spawned:', await p.evaluate(() => {
    const zone = SS.Game.zone;
    // ONE clock for the whole sequence, including the readout. Mixing an
    // injected time with Date.now() gives a nonsense countdown — the container
    // runs in the small hours, so a 15-minute gap reads as nine hours.
    const noon = new Date(); noon.setHours(12, 30, 0, 0);
    const T = noon.getTime();
    SS.Spawner.reset(zone);
    SS.Spawner.tick(zone, { now: T });
    const st = SS.Spawner.state(zone.zoneId);
    st.target = 2; SS.Spawner.saveState(zone.zoneId, st);
    SS.Spawner.tick(zone, { now: T + 60000 });
    const auto = (t) => SS.Content.list(t).filter(r => r.origin === 'auto')
      .map(r => r.name + ' [' + r.placeCategory + ']');
    return { dungeons: auto('dungeons'), instances: auto('instances'),
             status: SS.Spawner.status(zone, T + 60000) };
  }));
  await p.evaluate(() => { SS.Game.drawDungeons(); SS.Game.drawInstanceDoors(); SS.Game.map.setZoom(16); });
  await p.waitForTimeout(900);
  await p.screenshot({ path: path.join(OUT, 'v-spawned-map.png') });

  // The dev panel's spawn readout.
  await p.evaluate(() => { SS.saveSettings({ locationMode: 'sim' }); SS.Game.buildDevPanel(true); });
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(OUT, 'v-dev-panel.png') });
  await p.evaluate(() => { SS.saveSettings({ locationMode: 'gps' }); SS.Game.buildDevPanel(); });

  // Into the seeded instance, with the walls its second level carries.
  await p.evaluate(() => {
    const d = SS.Content.list('instances')[0];
    d.minLevel = 1; SS.Content.save('instances', d);
    SS.Instance.begin(d);
  });
  await p.waitForTimeout(600);
  await p.evaluate(() => { const m = document.querySelector('.modalFoot .btn:last-child'); if (m) m.click(); });
  await p.waitForTimeout(400);
  console.log('inside:', await p.evaluate(() => {
    const r = SS.Instance.current();
    return r && { floor: [r.plan.width, r.plan.height], walls: r.plan.walls.length,
                  explored: Math.round(SS.Content.exploredFraction(r.plan) * 100) + '%',
                  entities: r.plan.entities.length };
  }));
  await p.screenshot({ path: path.join(OUT, 'v-instance-arrive.png') });

  // Walk around a bit so the fog opens up.
  for (let i = 0; i < 26; i++) {
    await p.evaluate((h) => {
      const r = SS.Instance.current(); if (!r) return;
      SS.Game.ch.stats.hp = SS.Game.ch.stats.maxHp;
      r.heading = h; SS.Instance.saveRun(r); SS.Walk.add(6);
    }, (i * 47) % 360);
    await p.waitForTimeout(60);
    await p.evaluate(() => { if (SS.Game.inCombat) SS.Combat.end('won'); });
    await p.evaluate(() => { const m = document.querySelector('.modalFoot .btn:last-child'); if (m) m.click(); });
  }
  await p.waitForTimeout(400);
  console.log('after walking:', await p.evaluate(() => {
    const r = SS.Instance.current();
    return r && { explored: Math.round(SS.Content.exploredFraction(r.plan) * 100) + '%', level: r.level };
  }));
  await p.screenshot({ path: path.join(OUT, 'v-instance-explored.png') });

  // The map editor's art panel, on a wide screen.
  const ctx2 = await b.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1.4,
    geolocation: { latitude: 41.8827, longitude: -87.6233 }, permissions: ['geolocation'] });
  const e = await ctx2.newPage();
  e.on('pageerror', x => errs.push('editor: ' + x.message));
  await e.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await e.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  await e.route('**tile.openstreetmap.org/**', r => r.abort());
  e.on('dialog', d => d.accept('Office Grounds'));
  await e.goto(BASE + '/mapeditor.html');
  await e.waitForSelector('.meTop', { timeout: 8000 });
  await e.click('#meZoneNew');
  await e.waitForTimeout(600);
  await e.evaluate(() => {
    const l = ME.Content.list('locations')[0];
    if (l) { l.zoneId = ME.Me.zone.zoneId; ME.Content.save('locations', l);
             ME.Me.renderAll(); ME.Me.select(l.locationId); }
  });
  await e.waitForTimeout(700);
  console.log('editor art preview:', await e.evaluate(() => {
    const img = document.querySelector('#f_artPrev img');
    return { src: img && img.getAttribute('src'), note: (document.querySelector('#f_artNote') || {}).textContent };
  }));
  await e.screenshot({ path: path.join(OUT, 'v-editor-art.png') });

  // And the instance form, showing width/height instead of rooms.
  await e.click('[data-mode="instances"]');
  await e.waitForTimeout(300);
  await e.evaluate(() => {
    const d = ME.Content.list('instances')[0];
    if (d) { d.zoneId = ME.Me.zone.zoneId; ME.Content.save('instances', d);
             ME.Me.renderAll(); ME.Mi.select(d.instanceId); }
  });
  await e.waitForTimeout(600);
  await e.evaluate(() => { ME.Mi.openLevel = 1; ME.Mi.renderForm(); });
  await e.waitForTimeout(500);
  await e.screenshot({ path: path.join(OUT, 'v-editor-instance.png') });

  console.log('page errors:', errs.length ? errs.slice(0, 5) : 'none');
  await b.close();
  process.exit(0);
})();
