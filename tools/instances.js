/* Instances: one open rectangle on its own XY plane, steered with a dial and
   crossed by walking in the real world.

   The floor is not generated. It is the width and height that were typed, and
   the walls that were drawn into it — so what these tests check is that the
   rectangle is what you get, that walls stop you, and that what you have seen
   is tracked. Navigation is the player's job, so rather than driving a
   dungeon-crawling AI around, they stand the player next to each thing in turn
   and check that walking into it does what it should. */
const { chromium } = require('playwright');
const path = require('path');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
const fs = require('fs');
const { mockOverpass } = require('./mock-osm');

const MAP_URL  = BASE + '/mapeditor.html';
const GAME_URL = BASE + '/index.html';
const LEAFLET_JS  = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

async function newPage(browser, opts) {
  const ctx = await browser.newContext(Object.assign({
    viewport: { width: 1400, height: 900 },
    geolocation: { latitude: 41.8827, longitude: -87.6233 },
    permissions: ['geolocation']
  }, opts));
  const page = await ctx.newPage();
  // These suites author their own content, so nothing seeds in underneath them.
  await emptyDatabase(page);
  page.on('dialog', d => d.accept('Test Zone'));
  await page.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await page.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  await page.route('**/api/interpreter', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(mockOverpass(41.8827, -87.6233)) }));
  return { ctx, page };
}

/* Park the player somewhere on the floor with nothing within reach, and make
   sure no fight is left running. Walking into a wall can bump you into
   something on the way, and a step that starts mid-fight proves nothing. */
async function parkClear(page) {
  await page.evaluate(() => { if (SS.Game.inCombat) SS.Combat.end('won'); });
  await page.waitForTimeout(200);
  for (let i = 0; i < 3; i++) {
    const btn = await page.$('.modalFoot .btn:last-child');
    if (!btn) break;
    await btn.click().catch(() => {});
    await page.waitForTimeout(180);
  }
  await page.evaluate(() => {
    const run = SS.Instance.current(), C = SS.Content;
    if (!run) return;
    const live = run.plan.entities.filter(e => !e.dead);
    let best = null, bestD = -1;
    for (let x = 2; x < run.plan.width; x += 2) {
      for (let y = 2; y < run.plan.height; y += 2) {
        if (!C.walkable(run.plan, x, y)) continue;
        const d = live.reduce((min, e) => Math.min(min, Math.hypot(e.x - x, e.y - y)), 1e9);
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
    }
    if (best) { run.pos.x = best.x; run.pos.y = best.y; SS.Instance.saveRun(run); }
  });
}

async function clearModal(page) {
  const btn = await page.$('.modalFoot .btn:last-child');
  if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(180); return true; }
  return false;
}

/** Stand the player next to a point, facing it, ready to walk into it. */
const STAND_BY = (tx, ty, back) => {
  const run = SS.Instance.current(), C = SS.Content;
  // back off along a clear direction, then face the target again
  let best = null;
  for (let h = 0; h < 360; h += 10) {
    const rad = h * Math.PI / 180;
    const px = tx + Math.sin(rad) * back, py = ty - Math.cos(rad) * back;
    if (C.walkable(run.plan, px, py) && C.lineOfSight(run.plan, px, py, tx, ty)) { best = { px, py }; break; }
  }
  if (!best) return false;
  run.pos.x = best.px; run.pos.y = best.py;
  run.heading = Math.atan2(tx - best.px, -(ty - best.py)) * 180 / Math.PI;
  SS.Instance.saveRun(run);
  return true;
};

(async () => {
  // The game fetches its database out of data/*.json, and fetch() will not
  // touch a file:// URL — so the suites run against a real origin now.
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ===================================================== AUTHORING ======= */
  console.log('\n===== MAP EDITOR · THE INSTANCE LAYER =====');
  const { ctx, page } = await newPage(browser);
  const eErr = [];
  page.on('pageerror', e => eErr.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) eErr.push(m.text()); });
  await page.goto(MAP_URL);
  await page.waitForSelector('.meTop', { timeout: 8000 });
  await page.click('#meZoneNew');
  await page.waitForTimeout(400);

  await step('three layers now, and instances is one of them', async () => {
    const tabs = await page.$$eval('.layerSwitch button', bs => bs.map(b => b.textContent.trim()));
    if (tabs.length !== 3) throw new Error(tabs.length + ' tabs: ' + tabs.join(' | '));
    await page.click('[data-mode="instances"]');
    await page.waitForTimeout(250);
    const mode = await page.evaluate(() => ME.Me.mode);
    if (mode !== 'instances') throw new Error('mode is ' + mode);
    const dungeons = await page.evaluate(() => ME.Content.list('dungeons').length);
    if (dungeons !== 0) throw new Error('the dungeon table was disturbed');
    return tabs.join(' · ');
  });

  await step('placing a door stores it straight away', async () => {
    await page.click('#mePlace');
    const box = await (await page.$('#map')).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(450);
    const r = await page.evaluate(() => {
      const d = ME.Content.list('instances')[0];
      return d && { levels: d.levels.length, radius: d.radius, pace: d.pace,
                    w: d.levels[0].width, h: d.levels[0].height,
                    walls: (d.levels[0].walls || []).length };
    });
    if (!r) throw new Error('nothing stored');
    if (r.levels !== 1) throw new Error(r.levels + ' levels');
    if (r.pace !== 1) throw new Error('pace defaults to ' + r.pace);
    if (!(r.w >= 8 && r.h >= 8)) throw new Error('floor is ' + r.w + ' x ' + r.h);
    if (r.walls !== 0) throw new Error('a fresh level came with ' + r.walls + ' walls');
    return 'one empty ' + r.w + ' x ' + r.h + ' m floor, door radius ' + r.radius +
           ' m, pace ' + r.pace;
  });

  await step('the preview is the rectangle you typed, plus the walls you drew', async () => {
    await page.evaluate(() => {
      const d = ME.Mi.draft;
      Object.assign(d.levels[0], {
        width: 80, height: 50, monsters: 4, chests: 2, hasBoss: true,
        walls: [{ x: 30, y: 0, w: 1.5, h: 34 }, { x: 55, y: 16, w: 1.5, h: 34 }]
      });
      ME.Mi.renderForm();
    });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const floor = document.querySelector('.instPrev .pr.floor');
      return {
        floors: document.querySelectorAll('.instPrev .pr').length,
        walls: document.querySelectorAll('.instPrev .pw').length,
        glyphs: document.querySelectorAll('.instPrev text').length,
        box: floor && [+floor.getAttribute('width'), +floor.getAttribute('height')]
      };
    });
    if (r.floors !== 1) throw new Error(r.floors + ' floor rectangles — a level is one');
    if (!r.box || r.box[0] !== 80 || r.box[1] !== 50) throw new Error('floor drawn as ' + JSON.stringify(r.box));
    if (r.walls !== 2) throw new Error(r.walls + ' walls drawn for the 2 authored');
    // 4 monsters + 2 chests + boss + door + stairs
    if (r.glyphs < 8) throw new Error('only ' + r.glyphs + ' things marked on it');
    return '80 x 50 m, 2 walls, ' + r.glyphs + ' things on it';
  });

  await step('a drawn line becomes an axis-aligned wall', async () => {
    const r = await page.evaluate(() => {
      const C = ME.Content;
      const across = C.wallFromLine(10, 20, 60, 21, 1.4);   // near-horizontal
      const down   = C.wallFromLine(30, 5, 31, 45, 1.4);    // near-vertical
      const back   = C.normRect({ x: 40, y: 40, w: -10, h: -6 });  // drawn right-to-left
      return { across, down, back };
    });
    if (!(r.across.w > r.across.h)) throw new Error('a near-horizontal line came out vertical');
    if (!(r.down.h > r.down.w)) throw new Error('a near-vertical line came out horizontal');
    if (Math.abs(r.across.h - 1.4) > 0.001) throw new Error('thickness is ' + r.across.h);
    if (r.back.x !== 30 || r.back.y !== 34 || r.back.w !== 10 || r.back.h !== 6) {
      throw new Error('a backwards drag came out as ' + JSON.stringify(r.back));
    }
    return 'horizontal ' + Math.round(r.across.w) + ' m, vertical ' + Math.round(r.down.h) +
           ' m, backwards drags squared up';
  });

  await step('validation catches an instance with no levels', async () => {
    const msg = await page.evaluate(() => {
      const d = JSON.parse(JSON.stringify(ME.Mi.draft));
      d.levels = [];
      return ME.Mi.validate(d);
    });
    if (!msg || !/level/i.test(msg)) throw new Error('accepted it: ' + msg);
    const tiny = await page.evaluate(() => {
      const d = JSON.parse(JSON.stringify(ME.Mi.draft));
      d.levels = [Object.assign(ME.Content.blankInstanceLevel(1), { width: 3, height: 3 })];
      return ME.Mi.validate(d);
    });
    if (!tiny) throw new Error('a 3 x 3 m floor was accepted');
    return '"' + msg + '" / "' + tiny + '"';
  });

  await step('dungeons and locations are untouched by any of it', async () => {
    await page.click('#meSave');
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ME.Content.stats());
    if (r.dungeons !== 0 || r.locations !== 0) throw new Error(JSON.stringify(r));
    if (r.instances !== 1) throw new Error(r.instances + ' instances');
    await page.click('[data-mode="dungeons"]');
    await page.waitForTimeout(250);
    const txt = await page.textContent('#meTableWrap');
    if (!/No dungeons/.test(txt)) throw new Error('the dungeon tab shows the wrong table');
    return 'instances ' + r.instances + ', dungeons ' + r.dungeons + ', locations ' + r.locations;
  });

  if (eErr.length) { fail++; console.log('  FAIL editor page errors — ' + eErr.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the map editor'); }
  await ctx.close();

  /* ================================================== THE FLOOR ITSELF === */
  console.log('\n===== INSIDE AN INSTANCE =====');
  const { ctx: c2, page: g } = await newPage(browser, { viewport: { width: 430, height: 900 } });
  const gErr = [];
  g.on('pageerror', e => gErr.push(e.message));
  g.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) gErr.push(m.text()); });
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

  await step('the floor is exactly the rectangle asked for, walls excepted', async () => {
    const r = await g.evaluate(() => {
      const C = SS.Content;
      const inst = C.blankInstance(0, 0, 'z');
      inst.instanceId = 'probe';
      inst.levels = [Object.assign(C.blankInstanceLevel(1), {
        width: 70, height: 45, monsters: 3, chests: 2, hasBoss: true,
        walls: [{ x: 25, y: 0, w: 1.5, h: 30 }, { x: 48, y: 15, w: 1.5, h: 30 }]
      })];
      const p = C.buildInstanceLevel(inst, 0, 'probe');
      const corners = [[0.5, 0.5], [69.5, 0.5], [0.5, 44.5], [69.5, 44.5]].map(c => C.walkable(p, c[0], c[1]));
      const outside = [[-1, 20], [71, 20], [35, -1], [35, 46]].map(c => C.walkable(p, c[0], c[1]));
      return {
        w: p.width, h: p.height, floors: p.floors.length, walls: p.walls.length,
        corners, outside,
        inWall: C.walkable(p, 25.7, 10),
        startOnFloor: C.walkable(p, p.start.x, p.start.y),
        stairsOnFloor: C.walkable(p, p.stairs.x, p.stairs.y),
        entsOnFloor: p.entities.every(e => C.walkable(p, e.x, e.y)),
        ents: p.entities.length
      };
    });
    if (r.floors !== 1) throw new Error('a level came out as ' + r.floors + ' rectangles');
    if (r.w !== 70 || r.h !== 45) throw new Error('floor is ' + r.w + ' x ' + r.h);
    if (r.walls !== 2) throw new Error(r.walls + ' walls for the 2 authored');
    if (!r.corners.every(Boolean)) throw new Error('a corner of the rectangle is not floor');
    if (r.outside.some(Boolean)) throw new Error('you can stand outside the rectangle');
    if (r.inWall) throw new Error('a drawn wall is walkable');
    if (!r.startOnFloor || !r.stairsOnFloor) throw new Error('the door or the stairs are inside a wall');
    if (!r.entsOnFloor) throw new Error('something was placed inside a wall');
    return '70 x 45 m open, 2 walls solid, ' + r.ents + ' things all on the floor';
  });

  await step('everything on the floor can be reached from the door', async () => {
    const r = await g.evaluate(() => {
      const C = SS.Content;
      const inst = C.blankInstance(0, 0, 'z');
      inst.instanceId = 'probe2';
      inst.levels = [Object.assign(C.blankInstanceLevel(1), {
        width: 80, height: 52, monsters: 4, chests: 2, hasBoss: true,
        // a dogleg: two walls that overlap in x, so the way round is not straight
        walls: [{ x: 26, y: 0, w: 1.5, h: 38 }, { x: 52, y: 14, w: 1.5, h: 38 }]
      })];
      const p = C.buildInstanceLevel(inst, 0, 'probe2');

      // Flood fill the floor on a 1 m grid from the door. Anything the fill
      // does not reach is walled off, which is the only way this geometry can
      // strand you.
      const step = 1;
      const key = (x, y) => Math.round(x) + ',' + Math.round(y);
      const seen = new Set([key(p.start.x, p.start.y)]);
      const q = [{ x: Math.round(p.start.x), y: Math.round(p.start.y) }];
      while (q.length) {
        const c = q.shift();
        [[step, 0], [-step, 0], [0, step], [0, -step]].forEach(d => {
          const nx = c.x + d[0], ny = c.y + d[1];
          if (seen.has(key(nx, ny))) return;
          if (!C.walkable(p, nx, ny)) return;
          seen.add(key(nx, ny)); q.push({ x: nx, y: ny });
        });
      }
      const near = (x, y) => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
          if (seen.has(key(x + dx, y + dy))) return true;
        return false;
      };
      const stranded = p.entities.filter(e => !near(e.x, e.y)).map(e => e.kind);
      return { reached: seen.size, stranded, stairs: near(p.stairs.x, p.stairs.y) };
    });
    if (!r.stairs) throw new Error('the stairs are walled off from the door');
    if (r.stranded.length) throw new Error('walled off: ' + r.stranded.join(', '));
    return r.reached + ' m² reachable from the door, stairs and every entity among them';
  });

  const instId = await g.evaluate(() => {
    const z = SS.Game.zone;
    const d = SS.Content.blankInstance(z.centerLatitude, z.centerLongitude, z.zoneId);
    d.name = 'The Undercroft'; d.kind = 'crypt'; d.radius = 40; d.pace = 1;
    d.levels = [
      Object.assign(SS.Content.blankInstanceLevel(1),
        { width: 70, height: 46, monsters: 2, chests: 1, hasBoss: true, difficulty: 2 }),
      Object.assign(SS.Content.blankInstanceLevel(2),
        { width: 60, height: 40, monsters: 1, chests: 1, difficulty: 3 })
    ];
    SS.Content.save('instances', d);
    SS.Game.drawInstanceDoors();
    return d.instanceId;
  });

  await step('the door shows on the real map and gates who comes in', async () => {
    const pin = await g.evaluate(id => !!document.querySelector('.instDoor[data-inst="' + id + '"]'), instId);
    if (!pin) throw new Error('no door drawn');
    const far = await g.evaluate(id => SS.Instance.canEnter(SS.Content.get('instances', id), 900), instId);
    if (far.ok) throw new Error('let us in from 900 m');
    const low = await g.evaluate(id => {
      const d = SS.Content.get('instances', id);
      d.minLevel = 9; SS.Content.save('instances', d);
      const gate = SS.Instance.canEnter(d, 0);
      d.minLevel = 1; SS.Content.save('instances', d);
      return gate;
    }, instId);
    if (low.ok) throw new Error('let a level 1 into a level 9 instance');
    return '"' + far.why + '"';
  });

  await step('going in swaps the GPS map for the floor', async () => {
    await g.evaluate(id => SS.Instance.begin(SS.Content.get('instances', id)), instId);
    await g.waitForTimeout(350);
    await clearModal(g);
    const r = await g.evaluate(() => {
      const run = SS.Instance.current();
      const mapHidden = getComputedStyle(document.querySelector('#map')).visibility === 'hidden';
      return run && {
        inView: document.body.classList.contains('inInstance'),
        mapHidden, svg: !!document.querySelector('.instSvg'),
        floor: [run.plan.width, run.plan.height],
        explored: SS.Content.exploredFraction(run.plan),
        atDoor: Math.hypot(run.pos.x - run.plan.start.x, run.pos.y - run.plan.start.y),
        onFloor: SS.Content.walkable(run.plan, run.pos.x, run.pos.y),
        fogRects: SS.Content.fogRects(run.plan).length
      };
    });
    if (!r) throw new Error('no run started');
    if (!r.inView || !r.svg) throw new Error('the instance view did not take over');
    if (!r.mapHidden) throw new Error('the GPS map is still showing');
    if (!r.onFloor) throw new Error('started off the floor');
    if (r.atDoor > 0.01) throw new Error('started ' + r.atDoor.toFixed(1) + ' m from the door');
    if (!(r.explored > 0)) throw new Error('arrived with nothing lit at all');
    if (r.explored >= 0.999) throw new Error('the whole floor was lit on arrival');
    if (!r.fogRects) throw new Error('nothing is drawn as unexplored');
    return r.floor.join(' x ') + ' m, ' + Math.round(r.explored * 100) + '% lit from the door';
  });

  await step('the dial turns you, and turning moves nothing', async () => {
    const before = await g.evaluate(() => {
      const r = SS.Instance.current(); return { h: r.heading, x: r.pos.x, y: r.pos.y };
    });
    await g.click('#turnR'); await g.click('#turnR'); await g.click('#turnL');
    await g.waitForTimeout(150);
    const after = await g.evaluate(() => {
      const r = SS.Instance.current(); return { h: r.heading, x: r.pos.x, y: r.pos.y };
    });
    if (after.h === before.h) throw new Error('the heading did not move');
    if (after.x !== before.x || after.y !== before.y) throw new Error('turning moved the player');
    const bad = await g.evaluate(() => {
      SS.Instance.faceTo(NaN); return SS.Instance.current().heading;
    });
    if (!isFinite(bad)) throw new Error('a bad heading was accepted: ' + bad);
    return before.h + '° → ' + after.h + '°, position untouched';
  });

  await step('walking carries you along the heading, whatever the pace says', async () => {
    const one = await g.evaluate(() => {
      const r = SS.Instance.current(), C = SS.Content;
      // face the way with the most room, from the middle of the entrance
      r.pos.x = r.plan.width / 2; r.pos.y = r.plan.height / 2;
      let best = 0, bd = 0;
      for (let h = 0; h < 360; h += 5) {
        const s = C.stepThrough(r.plan, r.pos.x, r.pos.y, h, 9);
        const d = Math.hypot(s.x - r.pos.x, s.y - r.pos.y);
        if (d > bd) { bd = d; best = h; }
      }
      r.heading = best; SS.Instance.saveRun(r);
      const from = { x: r.pos.x, y: r.pos.y };
      SS.Walk.add(6);
      const now = SS.Instance.current().pos;
      return { moved: Math.hypot(now.x - from.x, now.y - from.y), heading: best };
    });
    if (Math.abs(one.moved - 6) > 0.4) throw new Error('walked 6 m, moved ' + one.moved.toFixed(2));
    const two = await g.evaluate(id => {
      const d = SS.Content.get('instances', id); d.pace = 2; SS.Content.save('instances', d);
      const r = SS.Instance.current(), C = SS.Content;
      r.pos.x = r.plan.width / 2; r.pos.y = r.plan.height / 2; SS.Instance.saveRun(r);
      const from = { x: r.pos.x, y: r.pos.y };
      SS.Walk.add(4);
      const now = SS.Instance.current().pos;
      d.pace = 1; SS.Content.save('instances', d);
      return Math.hypot(now.x - from.x, now.y - from.y);
    }, instId);
    if (Math.abs(two - 8) > 0.6) throw new Error('at pace 2, 4 m walked moved ' + two.toFixed(2));
    return '6 m walked = ' + one.moved.toFixed(1) + ' m at pace 1, 4 m = ' + two.toFixed(1) + ' m at pace 2';
  });

  await step('walls stop you, and the walk is not refunded', async () => {
    const r = await g.evaluate(() => {
      const run = SS.Instance.current(), C = SS.Content;
      run.pos.x = run.plan.width / 2; run.pos.y = run.plan.height / 2;
      // Put the player against the west wall and face straight into it. On an
      // open rectangle the outer edge is the wall, and it has to hold.
      run.pos.x = 1; run.pos.y = run.plan.height / 2;
      const blocked = 270;
      run.heading = blocked; SS.Instance.saveRun(run);
      const from = { x: run.pos.x, y: run.pos.y };
      const walkedBefore = SS.Instance.current().totals.meters;
      SS.Walk.add(60);
      const now = SS.Instance.current();
      return {
        blocked,
        moved: Math.hypot(now.pos.x - from.x, now.pos.y - from.y),
        counted: now.totals.meters - walkedBefore,
        inside: C.walkable(now.plan, now.pos.x, now.pos.y)
      };
    });
    if (r.blocked == null) return 'no wall within reach of this entrance';
    if (r.moved > 40) throw new Error('walked through a wall: moved ' + r.moved.toFixed(1) + ' m');
    if (!r.inside) throw new Error('ended up inside a wall');
    if (Math.abs(r.counted - 60) > 0.01) throw new Error('the walk was refunded: ' + r.counted);
    return '60 m walked at a wall moved ' + r.moved.toFixed(1) + ' m, still on the floor, all 60 m counted';
  });

  await parkClear(g);
  await step('the floor only moves when you do', async () => {
    const still = await g.evaluate(async () => {
      const snap = () => SS.Instance.current().plan.entities
        .filter(e => e.kind !== 'chest').map(e => [+e.x.toFixed(3), +e.y.toFixed(3)]);
      const a = JSON.stringify(snap());
      await new Promise(r => setTimeout(r, 600));
      return a === JSON.stringify(snap());
    });
    if (!still) throw new Error('monsters moved while the player stood still');
    const moved = await g.evaluate(() => {
      const snap = () => SS.Instance.current().plan.entities
        .filter(e => e.kind !== 'chest').map(e => [+e.x.toFixed(3), +e.y.toFixed(3)]);
      const a = JSON.stringify(snap());
      SS.Walk.add(10);
      return a !== JSON.stringify(snap());
    });
    if (!moved) throw new Error('monsters did not step when the player walked');
    return 'still for 600 ms with nothing moving, then a step each when we walked';
  });

  await step('a monster that can see you comes for you', async () => {
    const r = await g.evaluate(() => {
      const run = SS.Instance.current(), C = SS.Content;
      const foe = run.plan.entities.find(e => e.kind === 'monster' && !e.dead);
      if (!foe) return { skip: true };
      // put it in the middle, then stand in sight of it but out of contact
      foe.x = run.plan.width / 2; foe.y = run.plan.height / 2;
      let spot = null;
      for (let h = 0; h < 360; h += 10) {
        const rad = h * Math.PI / 180;
        const px = foe.x + Math.sin(rad) * 7, py = foe.y - Math.cos(rad) * 7;
        if (C.walkable(run.plan, px, py) && C.lineOfSight(run.plan, px, py, foe.x, foe.y)) { spot = { px, py }; break; }
      }
      if (!spot) return { skip: true };
      run.pos.x = spot.px; run.pos.y = spot.py;
      run.heading = 0;
      SS.Instance.saveRun(run);
      const before = Math.hypot(foe.x - run.pos.x, foe.y - run.pos.y);
      SS.Instance.moveMonsters(run, 3);
      const after = Math.hypot(foe.x - run.pos.x, foe.y - run.pos.y);
      return { before, after, alert: foe.alert };
    });
    if (r.skip) return 'no monster in a usable spot on this layout';
    if (!r.alert) throw new Error('it never noticed us from 7 m with a clear line');
    if (!(r.after < r.before - 0.5)) throw new Error('it closed only ' + (r.before - r.after).toFixed(2) + ' m');
    return 'closed from ' + r.before.toFixed(1) + ' m to ' + r.after.toFixed(1) + ' m in one 3 m step';
  });

  await step('walking into a monster starts the fight, and winning clears it', async () => {
    await parkClear(g);
    const ready = await g.evaluate((standBy) => {
      const run = SS.Instance.current();
      const foe = run.plan.entities.find(e => e.kind === 'monster' && !e.dead);
      if (!foe) return null;
      const fn = new Function('tx', 'ty', 'back', 'return (' + standBy + ')(tx,ty,back)');
      return fn(foe.x, foe.y, 3.2) ? foe.id : null;
    }, STAND_BY.toString());
    if (!ready) throw new Error('could not line up on a monster');
    await g.evaluate(() => { SS.Game.ch.stats.hp = SS.Game.ch.stats.maxHp; SS.Walk.add(2); });
    await g.waitForTimeout(300);
    if (!(await g.evaluate(() => SS.Game.inCombat))) throw new Error('walking into it started nothing');
    const transient = await g.evaluate(() => SS.Combat.node.transient);
    if (!transient) throw new Error('the instance fight wrote itself into the zone');
    await g.evaluate(() => SS.Combat.end('won'));
    await g.waitForTimeout(250);
    await clearModal(g);
    const r = await g.evaluate(id => {
      const run = SS.Instance.current();
      const e = run.plan.entities.find(x => x.id === id);
      return { dead: !!e.dead, kills: run.totals.kills, combat: SS.Game.inCombat };
    }, ready);
    if (!r.dead) throw new Error('it survived its own death');
    if (r.combat) throw new Error('still in combat');
    if (!r.kills) throw new Error('the tally says ' + r.kills + ' kills');
    return 'contact → fight → cleared, ' + r.kills + ' down';
  });

  await step('walking into a chest opens it', async () => {
    const ok = await g.evaluate((standBy) => {
      const run = SS.Instance.current();
      const chest = run.plan.entities.find(e => e.kind === 'chest' && !e.dead);
      if (!chest) return false;
      const fn = new Function('tx', 'ty', 'back', 'return (' + standBy + ')(tx,ty,back)');
      return fn(chest.x, chest.y, 3.2);
    }, STAND_BY.toString());
    if (!ok) throw new Error('could not line up on a chest');
    const goldBefore = await g.evaluate(() => SS.Game.ch.gold);
    await g.evaluate(() => SS.Walk.add(2));
    await g.waitForTimeout(300);
    await clearModal(g);
    const r = await g.evaluate(() => ({
      chests: SS.Instance.current().totals.chests,
      gold: SS.Game.ch.gold,
      left: SS.Instance.current().plan.entities.filter(e => e.kind === 'chest' && !e.dead).length
    }));
    if (!r.chests) throw new Error('nothing was opened');
    if (r.gold <= goldBefore) throw new Error('no gold came out of it');
    return r.chests + ' chest opened for ' + (r.gold - goldBefore) + ' gold, ' + r.left + ' left';
  });

  await step('the boss holds the stairs until it is dealt with', async () => {
    const blocked = await g.evaluate((standBy) => {
      const run = SS.Instance.current(), C = SS.Content;
      const stairs = run.plan.stairs;
      const fn = new Function('tx', 'ty', 'back', 'return (' + standBy + ')(tx,ty,back)');
      if (!fn(stairs.x, stairs.y, 3)) return null;
      const lvl = run.level;
      SS.Walk.add(2);
      return { sameLevel: SS.Instance.current().level === lvl,
               bossAlive: run.plan.entities.some(e => e.kind === 'boss' && !e.dead) };
    }, STAND_BY.toString());
    if (!blocked) throw new Error('could not line up on the stairs');
    if (!blocked.bossAlive) throw new Error('there was no boss to hold them');
    if (!blocked.sameLevel) throw new Error('we went down past a living boss');
    await g.waitForTimeout(200);
    await clearModal(g);
    return 'the stairs refused us while the boss lived';
  });

  await step('killing the boss and reaching the stairs takes you down', async () => {
    await g.evaluate(() => {
      const run = SS.Instance.current();
      run.plan.entities.filter(e => e.kind === 'boss').forEach(e => { e.dead = true; });
      SS.Instance.saveRun(run);
    });
    const ok = await g.evaluate((standBy) => {
      const run = SS.Instance.current(), C = SS.Content;
      const stairs = run.plan.stairs;
      const fn = new Function('tx', 'ty', 'back', 'return (' + standBy + ')(tx,ty,back)');
      return fn(stairs.x, stairs.y, 3);
    }, STAND_BY.toString());
    if (!ok) throw new Error('could not line up on the stairs');
    await g.evaluate(() => SS.Walk.add(2));
    await g.waitForTimeout(350);
    await clearModal(g);
    const r = await g.evaluate(() => {
      const run = SS.Instance.current();
      return run && { level: run.level, levels: run.totals.levels,
                      floor: [run.plan.width, run.plan.height],
                      explored: SS.Content.exploredFraction(run.plan),
                      atDoor: Math.hypot(run.pos.x - run.plan.start.x,
                                         run.pos.y - run.plan.start.y) };
    });
    if (!r) throw new Error('the run vanished on the way down');
    if (r.level !== 1) throw new Error('still on level ' + (r.level + 1));
    if (r.atDoor > 0.01) throw new Error('landed ' + r.atDoor.toFixed(1) + ' m from the new door');
    if (r.explored >= 0.999) throw new Error('the new level arrived fully lit');
    return 'level 2: a fresh ' + r.floor.join(' x ') + ' m floor, ' +
           Math.round(r.explored * 100) + '% lit, back at its door';
  });

  await step('stepping out holds the run, and you can pick it back up', async () => {
    const at = await g.evaluate(() => {
      const r = SS.Instance.current(); return { x: +r.pos.x.toFixed(2), y: +r.pos.y.toFixed(2), level: r.level };
    });
    await g.click('#instLeave');
    await g.waitForTimeout(300);
    const paused = await g.evaluate(id => ({
      active: !!SS.Instance.current(),
      held: !!SS.Instance.pausedFor(id),
      view: document.body.classList.contains('inInstance')
    }), instId);
    if (paused.active) throw new Error('still inside');
    if (!paused.held) throw new Error('the run was thrown away');
    if (paused.view) throw new Error('the instance view stayed up');
    await g.evaluate(id => SS.Instance.resume(SS.Content.get('instances', id)), instId);
    await g.waitForTimeout(250);
    const back = await g.evaluate(() => {
      const r = SS.Instance.current(); return { x: +r.pos.x.toFixed(2), y: +r.pos.y.toFixed(2), level: r.level };
    });
    if (back.x !== at.x || back.y !== at.y || back.level !== at.level) {
      throw new Error('came back to ' + JSON.stringify(back) + ', left ' + JSON.stringify(at));
    }
    return 'left and resumed on the same spot of level ' + (back.level + 1);
  });

  await step('clearing the last level pays out and seals it', async () => {
    await g.evaluate(() => {
      const run = SS.Instance.current();
      run.plan.entities.forEach(e => { e.dead = true; });
      SS.Instance.saveRun(run);
    });
    const ok = await g.evaluate((standBy) => {
      const run = SS.Instance.current(), C = SS.Content;
      const stairs = run.plan.stairs;
      const fn = new Function('tx', 'ty', 'back', 'return (' + standBy + ')(tx,ty,back)');
      return fn(stairs.x, stairs.y, 3);
    }, STAND_BY.toString());
    if (!ok) throw new Error('could not line up on the stairs');
    await g.evaluate(() => SS.Walk.add(2));
    await g.waitForTimeout(400);
    await clearModal(g);
    const r = await g.evaluate(id => {
      const slot = SS.Store.get('instance_runs', {})[SS.Game.ch.characterId] || {};
      const st = (slot.state || {})[id];
      return {
        active: !!slot.active,
        completions: st && st.completions,
        cooldown: SS.Instance.cooldownLeft(SS.Content.get('instances', id)),
        gate: SS.Instance.canEnter(SS.Content.get('instances', id), 0),
        view: document.body.classList.contains('inInstance')
      };
    }, instId);
    if (r.active) throw new Error('a run is still open');
    if (r.completions !== 1) throw new Error('completions: ' + r.completions);
    if (!(r.cooldown > 0)) throw new Error('no cooldown was set');
    if (r.gate.ok) throw new Error('walked straight back in');
    if (r.view) throw new Error('the instance view stayed up');
    return 'sealed: "' + r.gate.why + '"';
  });

  await step('an instance and a dungeon cannot both be open at once', async () => {
    const r = await g.evaluate(() => {
      const z = SS.Game.zone;
      const dv = SS.Content.blankDungeon(z.centerLatitude, z.centerLongitude, z.zoneId);
      dv.name = 'A dungeon'; dv.floors = [SS.Content.blankFloor(1)];
      SS.Content.save('dungeons', dv);
      SS.Dungeon.begin(dv);
      const inst = SS.Content.blankInstance(z.centerLatitude, z.centerLongitude, z.zoneId);
      inst.name = 'Busy'; inst.levels = [SS.Content.blankInstanceLevel(1)];
      SS.Content.save('instances', inst);
      const gate = SS.Instance.canEnter(inst, 0);
      SS.Dungeon.abandon(true);
      SS.Content.remove('dungeons', dv.dungeonId);
      SS.Content.remove('instances', inst.instanceId);
      return gate;
    });
    await g.waitForTimeout(200);
    await clearModal(g);
    if (r.ok) throw new Error('it let us into both');
    return '"' + r.why + '"';
  });

  if (gErr.length) { fail++; console.log('  FAIL game page errors — ' + gErr.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the game'); }
  await c2.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
