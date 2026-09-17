/* Travelling: the speed calculator, and everything that stops because of it.

   The whole feature hangs on one number — how fast are you going — computed
   from fixes whose timestamps this suite chooses. So nothing here waits: a
   forty-second drive and the twenty seconds of walking that end it are eight
   calls to `Loc.accept` with the clock written into them.

   Two things it is really guarding:

     · **the dev panel must never trip it.** A simulated fix is a teleport,
       which differences out at sixty metres a second. If those counted, every
       other suite in this repo would be run behind the veil.
     · **the network really does go quiet.** The Overpass mock counts, because
       "the map stops loading" is the claim that matters and the only way to
       check it is to watch for the requests that must not arrive. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
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

/* Counted, not just mocked: the point of half this suite is a number of
   requests that does not go up. */
let queries = 0;

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
  // The display face is a real request to a real CDN; a test must not make it.
  await page.route('**fonts.googleapis.com/**', r => r.abort());
  await page.route('**fonts.gstatic.com/**', r => r.abort());
  await page.route('**/api/interpreter', r => {
    queries++;
    const m = /around:[\d.]+,(-?[\d.]+),(-?[\d.]+)/.exec(decodeURIComponent(r.request().postData() || ''));
    r.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify(mockOverpass(m ? +m[1] : HOME.latitude, m ? +m[2] : HOME.longitude)) });
  });
  return { ctx, page };
}

/**
 * Feed real (not simulated) fixes along a heading.
 *
 * `metres` every `seconds`, which is the speed. The timestamps are ours, so
 * a minute of driving costs the suite nothing.
 */
const DRIVE = `(metres, seconds, count) => {
  SS.Loc.simulated = false;
  if (SS.Loc.status !== 'live') SS.Loc.status = 'live';
  let t = SS.Loc.last.ts || Date.now();
  let lat = SS.Loc.last.latitude, lng = SS.Loc.last.longitude;
  const seen = [];
  for (let i = 0; i < count; i++) {
    t += seconds * 1000;
    const p = projectPoint(lat, lng, metres, 90);
    lat = p.latitude; lng = p.longitude;
    SS.Loc.accept({ latitude: lat, longitude: lng, accuracy: 8, ts: t }, true);
    seen.push({ kph: Math.round(SS.Loc.speedKph()), travelling: SS.Loc.travelling });
  }
  return seen;
}`;

async function drive(page, metres, seconds, count) {
  return page.evaluate(({ src, a, b, c }) => eval(src)(a, b, c),
                       { src: DRIVE, a: metres, b: seconds, c: count });
}

(async () => {
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const { ctx, page: g } = await newPage(browser);
  const errors = [];
  g.on('pageerror', e => errors.push(e.message));
  g.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });

  await g.goto(GAME_URL);
  await g.waitForSelector('#tReg', { timeout: 8000 });
  await g.click('#tReg');
  await g.fill('#rgUser', 'driver'); await g.fill('#rgPass', 'walk1234');
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
  await g.waitForFunction(() => !SS.Game._chunkBusy && SS.Loc.last, null, { timeout: 40000 }).catch(() => {});
  await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));

  /* ===================================================== THE READING ===== */
  console.log('\n===== HOW FAST =====');

  await step('two fixes and a clock make a speed', async () => {
    const r = await g.evaluate(() => {
      SS.Loc.simulated = false;
      let t = Date.now();
      let lat = SS.Loc.last.latitude, lng = SS.Loc.last.longitude;
      SS.Loc.accept({ latitude: lat, longitude: lng, accuracy: 8, ts: t }, true);
      SS.Loc.clearSpeed();           // from a standstill, with a position in hand
      for (let i = 0; i < 3; i++) {  // three legs of 15 m in 10 s
        t += 10000;
        const p = projectPoint(lat, lng, 15, 90);
        lat = p.latitude; lng = p.longitude;
        SS.Loc.accept({ latitude: lat, longitude: lng, accuracy: 8, ts: t }, true);
      }
      return { mps: SS.Loc.speedMps, kph: SS.Loc.speedKph(), mph: SS.Loc.speedMph() };
    });
    if (Math.abs(r.mps - 1.5) > 0.06) throw new Error('15 m in 10 s read as ' + r.mps + ' m/s');
    if (Math.abs(r.kph - 5.4) > 0.3) throw new Error('km/h is wrong: ' + r.kph);
    if (Math.abs(r.mph - 3.36) > 0.2) throw new Error('mph is wrong: ' + r.mph);
    return r.mps.toFixed(2) + ' m/s = ' + r.kph.toFixed(1) + ' km/h = ' + r.mph.toFixed(1) + ' mph';
  });

  await step("the device's own speed wins over differencing", async () => {
    const r = await g.evaluate(() => {
      SS.Loc.clearSpeed();
      const t = Date.now();
      const a = SS.Loc.last;
      // Standing still by the coordinates, but the GPS chip says 12 m/s.
      SS.Loc.accept({ latitude: a.latitude, longitude: a.longitude, accuracy: 8, ts: t }, true);
      SS.Loc.accept({ latitude: a.latitude, longitude: a.longitude, accuracy: 8,
                      speed: 12, ts: t + 5000 }, true);
      return SS.Loc.speedMps;
    });
    if (Math.abs(r - 12) > 0.01) throw new Error('read ' + r + ' m/s, not the 12 the device reported');
    return 'doppler 12 m/s used, not the 0 the coordinates imply';
  });

  await step('one jumped fix is not a car', async () => {
    const r = await g.evaluate(() => {
      SS.Loc.clearSpeed();
      let t = Date.now();
      let lat = SS.Loc.last.latitude, lng = SS.Loc.last.longitude;
      const feed = (m, s) => {
        t += s * 1000;
        const p = projectPoint(lat, lng, m, 90);
        lat = p.latitude; lng = p.longitude;
        SS.Loc.accept({ latitude: lat, longitude: lng, accuracy: 8, ts: t }, true);
      };
      for (let i = 0; i < 4; i++) feed(6, 5);      // walking, 4.3 km/h
      feed(90, 5);                                  // one fix across the street
      const after = { kph: SS.Loc.speedKph(), travelling: SS.Loc.travelling };
      for (let i = 0; i < 2; i++) feed(6, 5);
      return { after, settled: SS.Loc.speedKph() };
    });
    if (r.after.travelling) throw new Error('a single bad fix put us in a car');
    if (r.after.kph > 12) throw new Error('the median moved to ' + r.after.kph + ' km/h on one sample');
    return 'a 65 km/h fix left the median at ' + r.after.kph.toFixed(1) + ' km/h';
  });

  await step('a dev-panel teleport is never a speed', async () => {
    // This one protects every other suite in the repo.
    const r = await g.evaluate(() => {
      SS.Loc.clearSpeed();
      const a = SS.Loc.last;
      const far = projectPoint(a.latitude, a.longitude, 400, 0);
      SS.Loc.simulateTo(far.latitude, far.longitude);
      const out = { mps: SS.Loc.speedMps, travelling: SS.Loc.travelling, samples: SS.Loc._speeds.length };
      SS.Loc.simulated = false;
      return out;
    });
    if (r.travelling) throw new Error('a 400 m teleport read as travelling');
    if (r.mps || r.samples) throw new Error('a simulated fix left a speed sample behind');
    return '400 m in one step, still 0 m/s';
  });

  /* ==================================================== THE THRESHOLD ==== */
  console.log('\n===== GETTING IN THE CAR =====');

  await step('it takes sustained speed, not one fast sample', async () => {
    const r = await g.evaluate(() => { SS.Loc.clearSpeed(); return true; });
    const seen = await drive(g, 110, 5, 5);           // 79 km/h
    const first = seen.findIndex(x => x.travelling);
    if (first < 0) throw new Error('never triggered: ' + JSON.stringify(seen));
    if (first === 0) throw new Error('triggered on the very first fast sample');
    const held = (first + 1) * 5;
    if (held < 5) throw new Error('held for only ' + held + ' s');
    return 'travelling after ' + held + ' s at ' + seen[first].kph + ' km/h';
  });

  await step('the veil says where you are and how fast', async () => {
    const r = await g.evaluate(() => {
      const veil = document.querySelector('#travelVeil');
      const word = document.querySelector('.tvWord');
      const speed = document.querySelector('#tvSpeed');
      return { shown: !veil.classList.contains('hidden'),
               body: document.body.classList.contains('travelling'),
               word: word && word.textContent.trim(),
               speed: speed && speed.textContent.trim(),
               z: veil ? +getComputedStyle(veil).zIndex : 0,
               covers: veil.getBoundingClientRect().height };
    });
    if (!r.shown || !r.body) throw new Error('no veil');
    if (r.word !== 'Traveling') throw new Error('it says "' + r.word + '"');
    if (!/km\/h/.test(r.speed || '') || !/mph/.test(r.speed || '')) throw new Error('speed reads "' + r.speed + '"');
    // Below modals on purpose: the switch that turns this off is in the menu.
    if (r.z >= 1000) throw new Error('at z-index ' + r.z + ' it would cover the menu');
    if (r.covers < 400) throw new Error('it only covers ' + r.covers + 'px');
    return '"' + r.word + '" · ' + r.speed + ' at z-index ' + r.z;
  });

  await step('the map stops asking for ground you drive past', async () => {
    const before = queries;
    const tilesGone = await g.evaluate(() => !SS.Game.map.hasLayer(SS.Game.tiles));
    const seen = await drive(g, 220, 5, 12);          // 2.6 km at 158 km/h
    await g.waitForTimeout(1200);
    const r = await g.evaluate(() => ({
      travelling: SS.Loc.travelling,
      tiles: SS.Game.map.hasLayer(SS.Game.tiles),
      busy: !!SS.Game._chunkBusy
    }));
    if (!tilesGone) throw new Error('the tile layer is still on the map');
    if (r.tiles) throw new Error('tiles came back mid-drive');
    if (!r.travelling) throw new Error('stopped travelling mid-drive');
    if (queries !== before) throw new Error((queries - before) + ' Overpass queries while driving 2.6 km');
    return '2.6 km driven, ' + (queries - before) + ' queries, tiles off the map';
  });

  await step('driving earns nothing', async () => {
    const r = await g.evaluate(() => ({ m: SS.Walk.data().meters, xp: SS.Game.ch.experience }));
    const before = r;
    const seen = await drive(g, 200, 5, 6);           // another 1.2 km
    const after = await g.evaluate(() => ({ m: SS.Walk.data().meters, xp: SS.Game.ch.experience }));
    if (after.m !== before.m) throw new Error((after.m - before.m) + ' m credited for a drive');
    if (after.xp !== before.xp) throw new Error((after.xp - before.xp) + ' XP earned in a car');
    return '1.2 km driven, ' + (after.m - before.m) + ' m and ' + (after.xp - before.xp) + ' XP earned';
  });

  await step('a slow patch in traffic does not end it', async () => {
    // 12 km/h: under the 16 that starts it, over the 8 that ends it. Without
    // hysteresis every traffic light would flap the veil.
    const seen = await drive(g, 20, 6, 5);
    const still = await g.evaluate(() => ({ t: SS.Loc.travelling, kph: SS.Loc.speedKph() }));
    if (!still.t) throw new Error('12 km/h ended the drive');
    return 'held at ' + still.kph.toFixed(1) + ' km/h, between the two thresholds';
  });

  /* ======================================================= GETTING OUT === */
  console.log('\n===== GETTING OUT =====');

  await step('walking pace brings the world back', async () => {
    const before = queries;
    const seen = await drive(g, 7, 6, 6);             // 4.2 km/h, a walk
    await g.waitForTimeout(1500);
    const r = await g.evaluate(() => ({
      travelling: SS.Loc.travelling,
      veil: !document.querySelector('#travelVeil').classList.contains('hidden'),
      body: document.body.classList.contains('travelling'),
      tiles: SS.Game.map.hasLayer(SS.Game.tiles),
      trail: SS.Game.trailPts.length
    }));
    if (r.travelling || r.veil || r.body) throw new Error('still travelling after a minute at walking pace');
    if (!r.tiles) throw new Error('the tiles did not come back');
    if (r.trail > 3) throw new Error('the drive was drawn as a walked trail (' + r.trail + ' points)');
    if (queries === before) throw new Error('the world never re-surveyed where we got out');
    return 'veil gone, tiles back, ' + (queries - before) + ' queries for where we actually are';
  });

  await step('and the metres count again', async () => {
    const before = await g.evaluate(() => SS.Walk.data().meters);
    await drive(g, 9, 6, 4);                          // 5.4 km/h
    const after = await g.evaluate(() => SS.Walk.data().meters);
    if (after - before < 20) throw new Error('only ' + (after - before) + ' m credited for 36 m walked');
    return Math.round(after - before) + ' m credited for 36 m walked';
  });

  await step('the switch in the menu turns the whole thing off', async () => {
    const r = await g.evaluate(async () => {
      saveSettings({ travelVeil: false });
      SS.Loc.clearSpeed();
      const before = SS.Walk.data().meters;
      let t = Date.now(), lat = SS.Loc.last.latitude, lng = SS.Loc.last.longitude;
      for (let i = 0; i < 6; i++) {
        t += 5000;
        const p = projectPoint(lat, lng, 110, 90);
        lat = p.latitude; lng = p.longitude;
        SS.Loc.accept({ latitude: lat, longitude: lng, accuracy: 8, ts: t }, true);
      }
      const out = {
        travelling: SS.Loc.travelling, pausing: SS.Loc.pausing(),
        veil: !document.querySelector('#travelVeil').classList.contains('hidden'),
        credited: SS.Walk.data().meters - before
      };
      saveSettings({ travelVeil: true });
      SS.Loc.clearSpeed();
      SS.Game.onTravelChange(false);
      return out;
    });
    if (!r.travelling) throw new Error('the reading stopped being taken');
    if (r.pausing) throw new Error('it still paused with the setting off');
    if (r.veil) throw new Error('the veil showed anyway');
    if (r.credited < 500) throw new Error('only ' + Math.round(r.credited) + ' m credited with the pause off');
    return 'still measured, nothing paused, ' + Math.round(r.credited) + ' m credited';
  });

  await step('the dev panel can fake a drive from a desk', async () => {
    const r = await g.evaluate(() => {
      SS.Loc.clearSpeed();
      // The panel only exists while dev testing is on; forceOpen builds it
      // without switching the location mode out from under the suite.
      SS.Game.buildDevPanel(true);
      const btn = document.querySelector('#dvDrive');
      if (!btn) return { missing: true };
      btn.click();
      const on = { t: SS.Loc.travelling, kph: Math.round(SS.Loc.speedKph()),
                   veil: !document.querySelector('#travelVeil').classList.contains('hidden') };
      btn.click();
      const off = { t: SS.Loc.travelling,
                    veil: !document.querySelector('#travelVeil').classList.contains('hidden') };
      SS.Game.buildDevPanel();       // put it away again
      return { on, off };
    });
    if (r.missing) throw new Error('no Drive button in the dev panel');
    if (!r.on.t || !r.on.veil) throw new Error('one click did not raise the veil');
    if (!r.on.kph) throw new Error('the veil would read 0 km/h');
    if (r.off.t || r.off.veil) throw new Error('a second click did not put it away');
    return 'on at ' + r.on.kph + ' km/h, off again';
  });

  await step('a fresh page starts at a standstill', async () => {
    await g.reload();
    await g.waitForSelector('#charList .pick', { timeout: 10000 });
    await g.click('#charList .pick');
    await g.waitForFunction(() => window.SS && SS.Loc && SS.Loc.last, null, { timeout: 20000 });
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    const r = await g.evaluate(() => ({
      mps: SS.Loc.speedMps, travelling: SS.Loc.travelling,
      veil: !document.querySelector('#travelVeil').classList.contains('hidden'),
      tiles: SS.Game.map.hasLayer(SS.Game.tiles)
    }));
    if (r.travelling || r.veil) throw new Error('reloaded into a car');
    if (r.mps) throw new Error('a speed survived the reload: ' + r.mps);
    if (!r.tiles) throw new Error('the map came back without its tiles');
    return 'nothing about a drive is stored';
  });

  if (errors.length) { fail++; console.log('  FAIL page errors — ' + errors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors'); }
  await ctx.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed  (' + queries + ' Overpass queries in total)');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
