/* The living world: things that move, and the boundaries that hold them.

   Two claims are worth a suite of their own, because both are invisible when
   they work and look like bugs when they break:

     1. a creature never leaves its territory — not on the next step, not
        eight hours from now, not at any point in between
     2. where everything is, is a pure function of the clock — the same answer
        on a reload, on another device, after the phone was in a pocket

   Both are cheap to test precisely *because* nothing is simulated: the suite
   just asks where things are at times of its own choosing, thousands of them,
   without waiting for any of it to happen.

   The quest tally rides along at the end: it is the other half of the same
   change (what the player has done, beside what lives near them). */
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
/* A fixed wall-clock instant to ask about. Nothing here waits for real time;
   it names a moment and asks what the world looks like then. */
const NOON = new Date(2026, 8, 14, 12, 0, 0).getTime();

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

async function newPage(browser, opts) {
  const ctx = await browser.newContext(Object.assign({
    viewport: { width: 430, height: 900 },
    geolocation: { latitude: HOME.latitude, longitude: HOME.longitude },
    permissions: ['geolocation']
  }, opts));
  const page = await ctx.newPage();
  await emptyDatabase(page);
  await page.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await page.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  await page.route('**/api/interpreter', r => {
    const m = /around:[\d.]+,(-?[\d.]+),(-?[\d.]+)/.exec(decodeURIComponent(r.request().postData() || ''));
    r.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify(mockOverpass(m ? +m[1] : HOME.latitude, m ? +m[2] : HOME.longitude)) });
  });
  return { ctx, page };
}

/** Make a character and get as far as a map with a surveyed world on it. */
async function intoTheGame(g, who) {
  await g.goto(GAME_URL);
  await g.waitForSelector('#tReg', { timeout: 8000 });
  await g.click('#tReg');
  await g.fill('#rgUser', who); await g.fill('#rgPass', 'walk1234');
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
  await g.waitForFunction(() => !SS.Game._chunkBusy && SS.Atlas.stats().places > 0, null, { timeout: 40000 })
    .catch(() => {});
  await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
}

/**
 * Take two *different* parks, so a travelling character has somewhere to go.
 *
 * The picker offers the same surveyed list for both slots, so the second one
 * skips whatever the first took; if the survey only found one park, the second
 * is a pin dropped a few hundred metres away rather than the same place twice.
 */
async function takeParks(g) {
  return g.evaluate(() => {
    const take = (slot, avoid) => {
      SS.Game.openHauntPicker({ slotKey: slot });
      const rows = Array.from(document.querySelectorAll('.hpRow'));
      const row = rows.find(r => !avoid || r.textContent.indexOf(avoid) < 0) || rows[0];
      if (row) row.click();
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return SS.Haunts.get(slot);
    };
    const a = take('park1', null);
    let b = take('park2', a && a.realName);
    if (!b || !a || b.name === a.name) {
      const p = projectPoint(a.latitude, a.longitude, 400, 90);
      SS.Haunts.set('park2', SS.Haunts.fromPoint(p.latitude, p.longitude, 'park2', 'deepwood',
                                                 'The Farther Wood', 80));
      b = SS.Haunts.get('park2');
    }
    return { a: a && a.name, b: b && b.name, same: !!(a && b && a.name === b.name) };
  });
}

(async () => {
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ================================================= TERRITORIES ======== */
  console.log('\n===== WHAT HOLDS THEM =====');
  const { ctx, page: g } = await newPage(browser);
  const errors = [];
  g.on('pageerror', e => errors.push(e.message));
  g.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });

  await intoTheGame(g, 'denizen');
  const parks = await takeParks(g);

  await step('a park with nothing drawn in it is quartered', async () => {
    const r = await g.evaluate(() => {
      const h = SS.Haunts.get('park1');
      const z = SS.Denizens.derivedZones(h);
      return {
        n: z.length,
        names: z.map(x => x.name),
        inside: z.every(x => haversine(h.latitude, h.longitude, x.latitude, x.longitude) + x.radiusM
                             <= (+h.radiusM || 60) + 1),
        distinct: new Set(z.map(x => x.shapeId)).size
      };
    });
    if (r.n !== 4) throw new Error(r.n + ' quarters, expected 4');
    if (r.distinct !== 4) throw new Error('the quarters share ids');
    if (!r.inside) throw new Error('a quarter reaches outside the park it came from');
    return r.names.join(', ');
  });

  await step('how many live there follows how much ground there is', async () => {
    const r = await g.evaluate(() => {
      const mk = (radiusM) => SS.Haunts.fromPoint(41.88, -87.62, 'park1', 'forest', 'Test wood', radiusM);
      const count = (radiusM) => SS.Denizens.derivedZones(mk(radiusM))
        .reduce((n, z) => n + SS.Denizens.inZone(z, Date.now()).length, 0);
      return { pocket: count(40), park: count(90), wood: count(200) };
    });
    if (r.pocket > r.park || r.park > r.wood) throw new Error(JSON.stringify(r) + ' is not rising');
    if (r.pocket > 6) throw new Error(r.pocket + ' creatures inside a 40 m pocket park');
    if (r.wood < 8) throw new Error('a 200 m wood held only ' + r.wood);
    return '40 m → ' + r.pocket + ' · 90 m → ' + r.park + ' · 200 m → ' + r.wood;
  });

  await step('a drawn zone takes over from the automatic quarters', async () => {
    const r = await g.evaluate(() => {
      const h = SS.Haunts.get('park1');
      // Only this park's own quarters count: the other park is close enough
      // to be in the same list and has nothing drawn in it either.
      const mine = (list) => list.filter(z => z.derived && z.placeName === h.name);
      const before = SS.Denizens.territories(h.latitude, h.longitude, 400);
      // A small square inside the park, marked as somewhere things live.
      const d = 0.00035;
      const s = SS.Shapes.blank('polygon', [
        [h.latitude - d, h.longitude - d], [h.latitude - d, h.longitude + d],
        [h.latitude + d, h.longitude + d], [h.latitude + d, h.longitude - d]
      ]);
      s.name = 'The bramble'; s.purpose = 'zone'; s.zoneKind = 'creature'; s.count = 3;
      SS.Shapes.save(s);
      const after = SS.Denizens.territories(h.latitude, h.longitude, 400);
      SS.Shapes.remove(s.shapeId);
      return {
        before: before.length, beforeDerived: mine(before).length,
        after: after.length, afterDerived: mine(after).length,
        named: after.some(z => z.name === 'The bramble')
      };
    });
    if (!r.named) throw new Error('the drawn zone is not in the list');
    if (r.afterDerived) throw new Error(r.afterDerived + ' quarters survived a drawn zone in the same park');
    if (r.beforeDerived !== 4) throw new Error('the park was quartered into ' + r.beforeDerived +
                                               ' to begin with');
    return 'its 4 automatic quarters gave way to the one drawn zone';
  });

  /* ================================================== CONTAINMENT ======= */
  console.log('\n===== IT CANNOT LEAVE =====');

  await step('no creature leaves its territory over eight hours of clock', async () => {
    const r = await g.evaluate((t0) => {
      const p = SS.Loc.last;
      const live = SS.Denizens.near(p.latitude, p.longitude, 600, t0);
      let samples = 0, escaped = 0, worst = 0, worstName = '';
      live.forEach(d => {
        for (let i = 0; i < 400; i++) {
          // 72 s apart: not a multiple of the 40 s leg, so the sampling walks
          // through every phase of the movement rather than landing on the
          // waypoints where containment is trivially true.
          const t = t0 + i * 72000;
          const q = SS.Denizens.positionAt(d, t);
          samples++;
          if (!SS.Denizens.contains(d.zone, q.latitude, q.longitude)) escaped++;
          const out = haversine(d.zone.latitude, d.zone.longitude, q.latitude, q.longitude)
                      - (+d.zone.radiusM || 0);
          if (out > worst) { worst = out; worstName = d.name; }
        }
      });
      return { live: live.length, samples, escaped, worst: Math.round(worst * 10) / 10, worstName };
    }, NOON);
    if (!r.live) throw new Error('nothing lives near the player, so the test proves nothing');
    if (r.escaped) throw new Error(r.escaped + ' of ' + r.samples + ' positions were outside the boundary');
    if (r.worst > 0.01) throw new Error(r.worstName + ' reached ' + r.worst + ' m past its own edge');
    return r.live + ' creatures × ' + (r.samples / r.live) + ' samples, none outside';
  });

  await step('a creature in a drawn polygon stays inside the polygon', async () => {
    const r = await g.evaluate((t0) => {
      const p = SS.Loc.last;
      // A deliberately awkward shape: an L, so a bounding box is not an alibi.
      const d = 0.0004;
      const ring = [
        [p.latitude, p.longitude], [p.latitude + d, p.longitude],
        [p.latitude + d, p.longitude + d / 2], [p.latitude + d / 2, p.longitude + d / 2],
        [p.latitude + d / 2, p.longitude + d], [p.latitude, p.longitude + d]
      ];
      const s = SS.Shapes.blank('polygon', ring);
      s.name = 'The crook'; s.purpose = 'zone'; s.count = 4;
      SS.Shapes.save(s);
      const zone = SS.Denizens.drawnZones().find(z => z.shapeId === s.shapeId);
      const live = SS.Denizens.inZone(zone, t0);
      let samples = 0, escaped = 0;
      live.forEach(x => {
        for (let i = 0; i < 300; i++) {
          const q = SS.Denizens.positionAt(x, t0 + i * 53000);
          samples++;
          if (!SS.Content.pointInRing(ring, q.latitude, q.longitude)) escaped++;
        }
      });
      SS.Shapes.remove(s.shapeId);
      return { live: live.length, samples, escaped };
    }, NOON);
    if (!r.live) throw new Error('the drawn zone held nothing');
    if (r.escaped) throw new Error(r.escaped + ' of ' + r.samples + ' positions left the L');
    return r.live + ' in an L-shaped patch, ' + r.samples + ' samples, none outside';
  });

  await step('the boundary is what holds them, not the drawing of it', async () => {
    // Turning the outlines off must not change where anything is.
    const r = await g.evaluate((t0) => {
      const p = SS.Loc.last;
      const at = () => SS.Denizens.near(p.latitude, p.longitude, 600, t0)
        .map(d => d.latitude.toFixed(9) + ',' + d.longitude.toFixed(9)).join('|');
      const shown = at();
      saveSettings({ showTerritories: false });
      const hidden = at();
      saveSettings({ showTerritories: true });
      return { same: shown === hidden, n: shown.split('|').length };
    }, NOON);
    if (!r.same) throw new Error('hiding the outlines moved things');
    return r.n + ' positions identical with the outlines off';
  });

  /* =================================================== THE CLOCK ======== */
  console.log('\n===== POSITION IS A FUNCTION OF THE CLOCK =====');

  await step('the same moment always gives the same answer', async () => {
    const r = await g.evaluate((t0) => {
      const p = SS.Loc.last;
      const snap = () => SS.Denizens.near(p.latitude, p.longitude, 600, t0)
        .map(d => d.denizenId + '@' + d.latitude.toFixed(10) + ',' + d.longitude.toFixed(10)).join('\n');
      const a = snap(), b = snap(), c = snap();
      return { same: a === b && b === c, n: a ? a.split('\n').length : 0, first: a.split('\n')[0] };
    }, NOON);
    if (!r.n) throw new Error('nothing to compare');
    if (!r.same) throw new Error('three looks at the same instant disagreed');
    return r.n + ' denizens, identical on every look';
  });

  await step('and gives it again after a reload', async () => {
    const before = await g.evaluate((t0) => {
      const p = SS.Loc.last;
      return SS.Denizens.near(p.latitude, p.longitude, 600, t0)
        .map(d => d.denizenId + '@' + d.latitude.toFixed(10) + ',' + d.longitude.toFixed(10)).join('\n');
    }, NOON);
    await g.reload();
    // A reload comes back at the character picker, which is the real test: the
    // world is rebuilt from storage, not from anything this session had in hand.
    await g.waitForSelector('#charList .pick', { timeout: 10000 });
    await g.click('#charList .pick');
    await g.waitForFunction(() => window.SS && SS.Loc && SS.Loc.last && document.querySelector('#map'),
                            null, { timeout: 20000 });
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    const after = await g.evaluate((t0) => {
      const p = SS.Loc.last;
      return SS.Denizens.near(p.latitude, p.longitude, 600, t0)
        .map(d => d.denizenId + '@' + d.latitude.toFixed(10) + ',' + d.longitude.toFixed(10)).join('\n');
    }, NOON);
    if (!before) throw new Error('nothing was there before the reload');
    if (before !== after) {
      const b = before.split('\n'), a = after.split('\n');
      const i = b.findIndex((x, k) => x !== a[k]);
      throw new Error('drifted: ' + (b[i] || 'missing') + ' → ' + (a[i] || 'missing'));
    }
    return before.split('\n').length + ' denizens in the same places after a reload';
  });

  await step('it moves, and it moves at a believable pace', async () => {
    const r = await g.evaluate((t0) => {
      const p = SS.Loc.last;
      const d = SS.Denizens.near(p.latitude, p.longitude, 600, t0)[0];
      let moved = 0, still = 0, fastest = 0, total = 0;
      let prev = SS.Denizens.positionAt(d, t0);
      for (let i = 1; i <= 240; i++) {
        const t = t0 + i * 5000;              // a look every five seconds
        const q = SS.Denizens.positionAt(d, t);
        const m = haversine(prev.latitude, prev.longitude, q.latitude, q.longitude);
        if (m > 0.05) moved++; else still++;
        fastest = Math.max(fastest, m / 5);    // metres per second
        total += m;
        prev = q;
      }
      return { name: d.name, moved, still, fastest: Math.round(fastest * 100) / 100,
               metres: Math.round(total) };
    }, NOON);
    if (r.moved < 200) throw new Error('it barely moved: ' + r.moved + ' of 240 steps');
    if (r.fastest > 3) throw new Error('it hit ' + r.fastest + ' m/s, which is a vehicle');
    return r.name + ' covered ' + r.metres + ' m in 20 minutes, top speed ' + r.fastest + ' m/s';
  });

  await step('a leg boundary is exactly its waypoint', async () => {
    const r = await g.evaluate((t0) => {
      const p = SS.Loc.last;
      const d = SS.Denizens.near(p.latitude, p.longitude, 600, t0)[0];
      const leg = Math.ceil(t0 / SS.Denizens.LEG_MS);
      const w = SS.Denizens.waypoint(d, leg);
      const at = SS.Denizens.positionAt(d, leg * SS.Denizens.LEG_MS);
      return { off: haversine(w.latitude, w.longitude, at.latitude, at.longitude),
               leg: SS.Denizens.LEG_MS };
    }, NOON);
    if (r.off > 0.01) throw new Error('it was ' + r.off + ' m from its own waypoint');
    return 'a ' + (r.leg / 1000) + ' s leg lands on its waypoint';
  });

  await step('the cast is rolled again between generations, not within one', async () => {
    const r = await g.evaluate((t0) => {
      /* One park's own territories, rather than everything within some radius
         of the player: a creature in a farther park drifting across that line
         is a change in what is *visible*, not a change in the cast. */
      const h = SS.Haunts.get('park1');
      const zones = SS.Denizens.derivedZones(h);
      const cast = (t) => zones.reduce((out, z) => out.concat(SS.Denizens.inZone(z, t)), [])
        .map(d => d.name).sort().join(',');
      const gen = SS.Denizens.GENERATION_MS;
      // Start of the generation NOON falls in, so "half a generation later" is
      // inside it rather than across the join.
      const start = Math.floor(t0 / gen) * gen;
      const early = cast(start + 1000);
      const late = cast(start + gen - 1000);      // same generation, hours later
      const next = cast(start + gen + 1000);      // one tick into the next
      return { early, late, next, same: early === late, rolled: early !== next };
    }, NOON);
    if (!r.same) throw new Error('the cast changed inside one generation: [' + r.early + '] vs [' + r.late + ']');
    if (!r.rolled) throw new Error('the same cast after a generation rolled over');
    return 'steady within a generation, "' + r.early.split(',')[0] + '" → "' + r.next.split(',')[0] + '"';
  });

  /* ==================================================== CHARACTERS ====== */
  console.log('\n===== CHARACTERS TRAVEL =====');

  await step('a wanderer bound to a place stays in that place', async () => {
    const r = await g.evaluate((t0) => {
      const h = SS.Haunts.get('park1');
      const z = SS.Denizens.derivedZones(h)[0];
      z.zoneKind = 'character'; z.roams = 'place'; z.npcName = 'Wend the tanner';
      const d = SS.Denizens.inZone(z, t0)[0];
      let outOfPatch = 0, outOfPlace = 0, n = 0;
      for (let i = 0; i < 400; i++) {
        const q = SS.Denizens.positionAt(d, t0 + i * 61000);
        n++;
        if (!SS.Denizens.contains(z, q.latitude, q.longitude)) outOfPatch++;
        if (haversine(h.latitude, h.longitude, q.latitude, q.longitude) > (+h.radiusM || 60) + 15) outOfPlace++;
      }
      return { name: d.name, n, outOfPatch, outOfPlace };
    }, NOON);
    if (r.outOfPlace) throw new Error(r.outOfPlace + ' of ' + r.n + ' positions left the park');
    if (!r.outOfPatch) throw new Error('"wanders the place" never left its own quarter — it is behaving like a creature');
    return r.name + ' left the quarter ' + r.outOfPatch + '/' + r.n + ' and the park never';
  });

  await step('a traveller turns up at your other places', async () => {
    const r = await g.evaluate((t0) => {
      const places = SS.Haunts.list();
      const h = SS.Haunts.get('park1');
      const z = SS.Denizens.derivedZones(h)[0];
      z.zoneKind = 'character'; z.roams = 'world'; z.npcName = 'Old Maugrim';
      const d = SS.Denizens.inZone(z, t0)[0];
      const seen = {};
      let trips = 0, prev = '';
      for (let i = 0; i < 600; i++) {
        const q = SS.Denizens.positionAt(d, t0 + i * 120000);   // two minutes apart
        let best = '', bd = 1e9;
        places.forEach(pl => {
          const m = haversine(pl.latitude, pl.longitude, q.latitude, q.longitude);
          if (m < bd) { bd = m; best = pl.name; }
        });
        if (bd <= (places.find(pl => pl.name === best).radiusM || 60) + 40) {
          seen[best] = (seen[best] || 0) + 1;
          if (best !== prev) { trips++; prev = best; }
        }
      }
      return { places: places.length, visited: Object.keys(seen), trips };
    }, NOON);
    if (r.places < 2) throw new Error('only ' + r.places + ' places are set, so travel cannot be observed');
    if (r.visited.length < 2) throw new Error('a world-roaming character only ever appeared at ' +
                                              (r.visited[0] || 'nowhere'));
    return r.visited.length + ' places visited across ' + r.trips + ' journeys: ' + r.visited.join(' → ');
  });

  /* ======================================================== KILLING ===== */
  console.log('\n===== KILLING ONE, AND THE WOOD REFILLING =====');

  await step('a killed creature is gone, and comes back later', async () => {
    const r = await g.evaluate((t0) => {
      const p = SS.Loc.last;
      const live = SS.Denizens.near(p.latitude, p.longitude, 600, t0);
      const victim = live[0];
      SS.Denizens.kill(victim.denizenId, t0);
      const after = SS.Denizens.near(p.latitude, p.longitude, 600, t0).map(d => d.denizenId);
      const soon = SS.Denizens.near(p.latitude, p.longitude, 600,
                                    t0 + SS.Denizens.RESPAWN_MS - 60000).map(d => d.denizenId);
      const later = SS.Denizens.near(p.latitude, p.longitude, 600,
                                     t0 + SS.Denizens.RESPAWN_MS + 60000).map(d => d.denizenId);
      const kept = Object.keys(SS.Store.get('denizen_kills', {}) || {}).length;
      // Leave the table as we found it.
      SS.Store.set('denizen_kills', {});
      return {
        before: live.length, after: after.length,
        goneNow: after.indexOf(victim.denizenId) < 0,
        goneSoon: soon.indexOf(victim.denizenId) < 0,
        backLater: later.indexOf(victim.denizenId) >= 0,
        kept, name: victim.name, mins: SS.Denizens.RESPAWN_MS / 60000
      };
    }, NOON);
    if (!r.goneNow) throw new Error('it was still there after being killed');
    if (!r.goneSoon) throw new Error('it came back before its time');
    if (!r.backLater) throw new Error('it never came back');
    if (r.after !== r.before - 1) throw new Error('killing one removed ' + (r.before - r.after));
    return r.name + ' gone for ' + r.mins + ' minutes, then back';
  });

  await step('the kill list does not grow forever', async () => {
    const r = await g.evaluate((t0) => {
      SS.Store.set('denizen_kills', { a: t0 - 1000, b: t0 - 5, c: t0 + 600000 });
      const live = SS.Denizens.killed(t0);
      return { left: Object.keys(live), stored: Object.keys(SS.Store.get('denizen_kills', {})) };
    }, NOON);
    if (r.left.length !== 1 || r.left[0] !== 'c') throw new Error('expired kills survived: ' + r.left.join(','));
    if (r.stored.length !== 1) throw new Error('the stored table was not pruned');
    return 'two expired entries swept, one live one kept';
  });

  /* ===================================================== ON THE MAP ===== */
  console.log('\n===== MEETING THEM =====');

  await step('they are drawn, and they are in the list of things to do', async () => {
    const r = await g.evaluate((t0) => {
      SS.Store.set('denizen_kills', {});
      const n = SS.Game.drawDenizens(t0);
      const rows = SS.Game.interactables().filter(x => x.kind === 'denizen');
      return {
        drawn: n, pins: document.querySelectorAll('.denizenPin').length,
        rows: rows.length,
        sorted: rows.every((x, i) => !i || x.distance >= rows[i - 1].distance),
        note: (rows[0] || {}).note || '',
        far: rows.filter(x => !x.inRange).length
      };
    }, NOON);
    if (!r.drawn) throw new Error('nothing was drawn');
    if (r.pins !== r.drawn) throw new Error(r.drawn + ' computed but ' + r.pins + ' pins on the map');
    if (r.rows !== r.drawn) throw new Error(r.drawn + ' on the map but ' + r.rows + ' in the list');
    if (!/difficulty/.test(r.note)) throw new Error('the list row says nothing useful: "' + r.note + '"');
    return r.pins + ' pins, ' + r.rows + ' rows (' + r.far + ' out of reach), "' + r.note + '"';
  });

  await step('one out of range cannot be fought, only looked at', async () => {
    const r = await g.evaluate((t0) => {
      const far = SS.Game.interactables().filter(x => x.kind === 'denizen' && !x.inRange)[0];
      const d = (SS.Game._denizens || []).find(x => x.name === far.name);
      SS.Game.openDenizen(d);
      const modal = document.querySelector('.modalBack');
      const text = modal ? modal.textContent : '';
      const buttons = modal ? Array.from(modal.querySelectorAll('.modalFoot .btn')).map(b => b.textContent.trim()) : [];
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return { text, buttons, dist: Math.round(far.distance) };
    }, NOON);
    if (r.buttons.indexOf('Fight') >= 0) throw new Error('it offered a fight at ' + r.dist + ' m');
    if (!/Get within/.test(r.text)) throw new Error('it did not say how to reach it');
    return 'at ' + r.dist + ' m: ' + r.buttons.join(' / ');
  });

  await step('walking up to one puts the fight on the table', async () => {
    const r = await g.evaluate((t0) => {
      const d = (SS.Game._denizens || [])[0];
      // Stand on it. The suite moves the player rather than waiting for the
      // creature to wander over.
      SS.Loc.last = { latitude: d.latitude, longitude: d.longitude, accuracy: 5 };
      SS.Game.openDenizen(d);
      const modal = document.querySelector('.modalBack');
      const buttons = modal ? Array.from(modal.querySelectorAll('.modalFoot .btn')).map(b => b.textContent.trim()) : [];
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      const node = SS.Denizens.toNode(d);
      return { buttons, node: { type: node.type, transient: node.transient, name: node.name } };
    }, NOON);
    if (r.buttons.indexOf('Fight') < 0) throw new Error('standing on it offered ' + r.buttons.join('/'));
    if (r.node.type !== 'combat' || !r.node.transient) throw new Error('its combat node is wrong: ' + JSON.stringify(r.node));
    return r.buttons.join(' / ') + ' → a transient combat node';
  });

  /* ================================================== THE QUEST TALLY === */
  console.log('\n===== WHAT YOU HAVE FINISHED =====');

  await step('finishing a quest counts, on the character and in the tally', async () => {
    const r = await g.evaluate(() => {
      // Read the count back out of storage, not off the object in hand: the
      // claim is that finishing a quest is *saved* on the character.
      const stored = () => (SS.Store.get(SS.K.characters, {}) || {})[SS.Game.ch.characterId] || {};
      const q = SS.Quests.list()[0];
      const before = +(stored().questsCompleted || 0);
      const run = SS.Quests.accept(q, { at: SS.Loc.last }).run || SS.Quests.runOf(q.questId);
      let guard = 0, finished = false;
      while (!finished && guard++ < 12) {
        const out = SS.Quests.completeNode(SS.Quests.runOf(q.questId), { at: SS.Loc.last });
        if (!out.ok) break;
        finished = !!out.finished;
      }
      const t = SS.Quests.tally(SS.Game.ch.characterId);
      return {
        finished, steps: guard,
        before, after: +(stored().questsCompleted || 0),
        completed: t.completed, unique: t.unique, inHand: t.inHand,
        named: (t.list[0] || {}).name || ''
      };
    });
    if (!r.finished) throw new Error('the quest never finished after ' + r.steps + ' steps');
    if (r.after !== r.before + 1) throw new Error('questsCompleted went ' + r.before + ' → ' + r.after);
    if (r.completed !== 1 || r.unique !== 1) throw new Error('the tally says ' + JSON.stringify(r));
    return r.after + ' on the character, tally "' + r.named + '" ×' + r.completed;
  });

  await step('a repeat counts again but is still one quest', async () => {
    const r = await g.evaluate(() => {
      const stored = () => (SS.Store.get(SS.K.characters, {}) || {})[SS.Game.ch.characterId] || {};
      const q = SS.Quests.list()[0];
      SS.Quests.accept(q, { at: SS.Loc.last });
      let guard = 0, finished = false;
      while (!finished && guard++ < 12) {
        const out = SS.Quests.completeNode(SS.Quests.runOf(q.questId), { at: SS.Loc.last });
        if (!out.ok) break;
        finished = !!out.finished;
      }
      const t = SS.Quests.tally(SS.Game.ch.characterId);
      return { completed: t.completed, unique: t.unique,
               ch: +stored().questsCompleted };
    });
    if (r.completed !== 2) throw new Error('a second run tallied ' + r.completed);
    if (r.unique !== 1) throw new Error('the same quest twice counted as ' + r.unique + ' different ones');
    if (r.ch !== 2) throw new Error('the character says ' + r.ch);
    return r.completed + ' finished, ' + r.unique + ' different';
  });

  await step('a deleted quest can still be named in the tally', async () => {
    const r = await g.evaluate(() => {
      const q = SS.Quests.list()[0];
      const name = q.name;
      SS.Content.remove('quests', q.questId);
      const t = SS.Quests.tally(SS.Game.ch.characterId);
      return { name, row: t.list[0], completed: t.completed };
    });
    if (!r.row) throw new Error('the tally lost the run with the quest');
    if (r.row.name !== r.name) throw new Error('it is now called "' + r.row.name + '"');
    if (!r.row.gone) throw new Error('it is not marked as gone');
    return '"' + r.row.name + '" still counted, marked gone';
  });

  await step('the character sheet and the quest log both show it', async () => {
    const r = await g.evaluate(() => {
      SS.Panels.sheet();
      const sheet = document.querySelector('.modalBack');
      const sheetText = sheet ? sheet.textContent : '';
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      SS.Game.questLog();
      const log = document.querySelector('.modalBack');
      const logText = log ? log.textContent : '';
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return { sheetText, logText };
    });
    if (!/Deeds/.test(r.sheetText)) throw new Error('no Deeds block on the sheet');
    if (!/\b2\b/.test(r.sheetText)) throw new Error('the sheet does not show the count');
    if (!/finished/.test(r.logText)) throw new Error('the quest log does not show what is finished');
    return 'sheet and log agree';
  });

  if (errors.length) { fail++; console.log('  FAIL page errors — ' + errors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors'); }
  await ctx.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed'
              + (parks.same ? '  (both parks resolved to the same place)' : ''));
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
