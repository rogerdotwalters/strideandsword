/* Dungeons: drawing and resizing a footprint in the map editor, authoring its
   floors, and then walking a whole run in the game — entering, fighting,
   looting, descending, stepping out, coming back, and the cooldown after. */
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

async function newPage(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 950 },
    geolocation: { latitude: 41.8827, longitude: -87.6233 },
    permissions: ['geolocation']
  });
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

/* Dismiss whatever modal is on screen, if any. */
async function clearModal(page) {
  const btn = await page.$('.modalFoot .btn:last-child');
  if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(200); return true; }
  return false;
}

/*
 * Walk the run forward. Fights are resolved by calling Combat.end('won')
 * rather than clicking through every round: the point under test is that the
 * dungeon started the fight and picked the run back up afterwards, and a real
 * clicked fight is covered separately below.
 */
async function walkUntil(page, done, budget) {
  for (let i = 0; i < (budget || 200); i++) {
    if (await page.evaluate(done)) return true;
    if (await page.evaluate(() => SS.Game.inCombat)) {
      await page.evaluate(() => SS.Combat.end('won'));
      await page.waitForTimeout(250);
      await clearModal(page);
      continue;
    }
    if (await clearModal(page)) continue;
    await page.evaluate(() => {
      const c = SS.Game.ch;
      c.stats.hp = c.stats.maxHp;      // the walk is what's under test, not survival
      SS.Walk.add(12);
    });
    await page.waitForTimeout(60);
  }
  return await page.evaluate(done);
}

(async () => {
  // The game fetches its database out of data/*.json, and fetch() will not
  // touch a file:// URL — so the suites run against a real origin now.
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ======================================================= DRAWING A DUNGEON */
  console.log('\n===== MAP EDITOR · THE DUNGEON LAYER =====');
  const { ctx, page } = await newPage(browser);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });

  await page.goto(MAP_URL);
  await page.waitForSelector('.meTop', { timeout: 8000 });
  await page.click('#meZoneNew');
  await page.waitForTimeout(400);

  await step('the layer switch swaps the table and the form', async () => {
    const before = await page.textContent('#meTableWrap');
    await page.click('[data-mode="dungeons"]');
    await page.waitForTimeout(250);
    const after = await page.textContent('#meTableWrap');
    const mode = await page.evaluate(() => ME.Me.mode);
    if (mode !== 'dungeons') throw new Error('mode is ' + mode);
    if (!/No dungeons/.test(after)) throw new Error('dungeon table did not take over');
    if (before === after) return 'switched';
    const label = await page.textContent('#mePlace');
    if (!/dungeon/i.test(label)) throw new Error('place button still says "' + label + '"');
    return 'locations → dungeons, button reads "' + label.trim() + '"';
  });

  await step('click the map to draw one', async () => {
    await page.click('#mePlace');
    const box = await (await page.$('#map')).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    const d = await page.evaluate(() => ME.Md.draft && {
      shape: ME.Md.draft.shape, radius: ME.Md.draft.radius, floors: ME.Md.draft.floors.length
    });
    if (!d) throw new Error('nothing drafted');
    if (d.shape !== 'circle') throw new Error('default shape is ' + d.shape);
    if (d.floors !== 1) throw new Error('started with ' + d.floors + ' floors');
    return 'a ' + d.radius + ' m circle with one floor';
  });

  await step('a new floor inherits the one above and gets harder', async () => {
    await page.fill('#f_name', 'The Sump');
    await page.fill('#fl_spawn_0', '').catch(() => {});
    await page.evaluate(() => { ME.Md.draft.floors[0].difficulty = 4; ME.Md.draft.floors[0].lengthMeters = 150; });
    await page.click('#flAdd');
    await page.waitForTimeout(250);
    const f = await page.evaluate(() => ME.Md.draft.floors.map(x => ({ len: x.lengthMeters, d: x.difficulty })));
    if (f.length !== 2) throw new Error(f.length + ' floors');
    if (f[1].len !== 150) throw new Error('length not inherited: ' + f[1].len);
    if (f[1].d !== 5) throw new Error('difficulty went ' + f[0].d + ' → ' + f[1].d);
    return 'floor 2 inherited 150 m and stepped difficulty 4 → 5';
  });

  await step('floors reorder and renumber on save', async () => {
    await page.evaluate(() => { ME.Md.draft.floors[0].name = 'Upper'; ME.Md.draft.floors[1].name = 'Lower'; });
    await page.evaluate(() => ME.Md.moveFloor(0, 1));
    await page.waitForTimeout(200);
    await page.click('#meSave');
    await page.waitForTimeout(400);
    const rows = await page.evaluate(() => {
      const d = ME.Content.list('dungeons')[0];
      return d.floors.map(f => f.name + ':' + f.level);
    });
    if (rows.join(',') !== 'Lower:1,Upper:2') throw new Error(rows.join(','));
    return rows.join(' then ');
  });

  await step('a rectangle is sized in metres, not degrees', async () => {
    const r = await page.evaluate(() => {
      const d = ME.Content.list('dungeons')[0];
      d.shape = 'rect'; d.width = 80; d.height = 40;
      ME.Content.save('dungeons', d);
      const C = ME.Content;
      const P = (dist, brg) => {
        const o = { latitude: d.latitude, longitude: d.longitude };
        // borrow the game's own projection so this measures what it draws
        return window.projectPoint ? window.projectPoint(o.latitude, o.longitude, dist, brg) : null;
      };
      const corners = C.dungeonCorners(d);
      return {
        inside: C.dungeonContains(d, d.latitude, d.longitude),
        // 30 m east is inside (half-width 40); 30 m north is outside (half-height 20)
        east30: C.distanceToDungeon(d, d.latitude, corners[1][1] - (corners[1][1] - d.longitude) * 0.25),
        north30: C.distanceToDungeon(d, d.latitude + (corners[1][0] - d.latitude) * 2, d.longitude),
        corners
      };
    });
    if (!r.inside) throw new Error('the centre is not inside its own box');
    if (r.east30 !== 0) throw new Error('a point well inside reads ' + r.east30 + ' m out');
    if (!(r.north30 > 15 && r.north30 < 25)) throw new Error('twice the half-height north reads ' + r.north30);
    return 'centre inside, ' + Math.round(r.north30) + ' m outside the north edge at 2× half-height';
  });

  await step('drag the corner handle to resize it', async () => {
    await page.evaluate(() => {
      const d = ME.Content.list('dungeons')[0];
      ME.Me.map.setView([d.latitude, d.longitude], 19.5);
      ME.Md.select(d.dungeonId);
    });
    await page.waitForTimeout(900);
    const before = await page.evaluate(() => {
      const d = ME.Content.list('dungeons')[0]; return { w: d.width, h: d.height };
    });
    const h = await page.$('.dgnHandle');
    if (!h) throw new Error('no resize handle on the selected dungeon');
    const hb = await h.boundingBox();
    await page.mouse.move(hb.x + 9, hb.y + 9);
    await page.mouse.down();
    await page.mouse.move(hb.x + 60, hb.y - 40, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => {
      const d = ME.Content.list('dungeons')[0]; return { w: d.width, h: d.height };
    });
    if (!(after.w > before.w && after.h > before.h)) {
      throw new Error(before.w + '×' + before.h + ' → ' + after.w + '×' + after.h);
    }
    const shown = await page.inputValue('#f_width');
    if (+shown !== after.w) throw new Error('form shows ' + shown + ', stored ' + after.w);
    return before.w + '×' + before.h + ' → ' + after.w + '×' + after.h + ' m, form kept in step';
  });

  await step('validation catches a dungeon with no floors', async () => {
    const msg = await page.evaluate(() => {
      const d = JSON.parse(JSON.stringify(ME.Md.draft));
      d.floors = [];
      return ME.Md.validate(d);
    });
    if (!msg || !/floor/i.test(msg)) throw new Error('accepted it: ' + msg);
    const short = await page.evaluate(() => {
      const d = JSON.parse(JSON.stringify(ME.Md.draft));
      d.floors = [Object.assign(ME.Content.blankFloor(1), { lengthMeters: 5 })];
      return ME.Md.validate(d);
    });
    if (!short) throw new Error('a 5 m floor was accepted');
    return '"' + msg + '" / "' + short + '"';
  });

  await step('locations are untouched by any of it', async () => {
    await page.click('[data-mode="locations"]');
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => ({
      mode: ME.Me.mode, locs: ME.Content.list('locations').length,
      dungeons: ME.Content.list('dungeons').length,
      text: document.querySelector('#meTableWrap').textContent
    }));
    if (r.mode !== 'locations') throw new Error('stuck in ' + r.mode);
    if (!/No locations/.test(r.text)) throw new Error('wrong table showing');
    if (r.dungeons !== 1) throw new Error(r.dungeons + ' dungeons');
    return 'switched back with ' + r.dungeons + ' dungeon and ' + r.locs + ' locations stored';
  });

  if (errors.length) { fail++; console.log('  FAIL editor page errors — ' + errors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the map editor'); }
  await ctx.close();

  /* ======================================================= WALKING THROUGH */
  console.log('\n===== A DUNGEON IN THE GAME =====');
  const { ctx: c2, page: g } = await newPage(browser);
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

  await step('an authored dungeon is drawn on the game map', async () => {
    const r = await g.evaluate(() => {
      const z = SS.Game.zone;
      const d = SS.Content.blankDungeon(z.centerLatitude, z.centerLongitude, z.zoneId);
      d.name = 'The Sump'; d.kind = 'cave'; d.shape = 'rect';
      d.width = 60; d.height = 40; d.entryRange = 25; d.minLevel = 1;
      d.respawnMinutes = 180;
      d.floors = [
        Object.assign(SS.Content.blankFloor(1), { lengthMeters: 120, encounters: 2, chests: 1, difficulty: 2 }),
        Object.assign(SS.Content.blankFloor(2), { lengthMeters: 90, encounters: 1, chests: 0, hasBoss: true, difficulty: 3 })
      ];
      SS.Content.save('dungeons', d);
      SS.Game.drawDungeons();
      return {
        id: d.dungeonId,
        listed: SS.Game.dungeons().length,
        pin: !!document.querySelector('.dungeonPin[data-dungeon="' + d.dungeonId + '"]'),
        edge: SS.Content.distanceToDungeon(d, SS.Loc.last.latitude, SS.Loc.last.longitude)
      };
    });
    if (!r.listed) throw new Error('not in the zone list');
    if (!r.pin) throw new Error('no door on the map');
    if (r.edge !== 0) throw new Error('player should be inside the footprint, reads ' + r.edge);
    return 'footprint and door drawn, player standing in it';
  });

  await step('the door stays shut from too far away, and below the level', async () => {
    const far = await g.evaluate(() => {
      const d = SS.Content.list('dungeons')[0];
      return SS.Dungeon.canEnter(d, 400);
    });
    if (far.ok) throw new Error('let us in from 400 m');
    const low = await g.evaluate(() => {
      const d = SS.Content.list('dungeons')[0];
      d.minLevel = 9; SS.Content.save('dungeons', d);
      const gate = SS.Dungeon.canEnter(d, 0);
      d.minLevel = 1; SS.Content.save('dungeons', d);
      return gate;
    });
    if (low.ok) throw new Error('let a level 1 into a level 9 dungeon');
    return '"' + far.why + '" / "' + low.why + '"';
  });

  await step('entering rolls a plan that ends at the stairs', async () => {
    await g.evaluate(() => SS.Dungeon.begin(SS.Content.list('dungeons')[0]));
    await g.waitForTimeout(300);
    await clearModal(g);
    const r = await g.evaluate(() => {
      const run = SS.Dungeon.current();
      return run && {
        floor: run.floor, walked: run.walked,
        kinds: run.plan.map(s => s.kind),
        ats: run.plan.map(s => s.at),
        len: SS.Content.list('dungeons')[0].floors[0].lengthMeters
      };
    });
    if (!r) throw new Error('no run started');
    const ordered = r.ats.every((a, i) => i === 0 || r.ats[i - 1] <= a);
    if (!ordered) throw new Error('stops out of order: ' + r.ats.join(','));
    if (r.kinds[r.kinds.length - 1] !== 'stairs') throw new Error('last stop is ' + r.kinds[r.kinds.length - 1]);
    if (r.ats[r.ats.length - 1] !== r.len) throw new Error('stairs at ' + r.ats[r.ats.length - 1] + ' not ' + r.len);
    if (r.kinds.filter(k => k === 'fight').length !== 2) throw new Error('fights: ' + r.kinds.join(','));
    if (r.kinds.filter(k => k === 'chest').length !== 1) throw new Error('chests: ' + r.kinds.join(','));
    return r.kinds.join(' → ') + ' at ' + r.ats.join(', ') + ' m';
  });

  await step('the bar shows the floor and what is coming', async () => {
    const txt = (await g.textContent('#dungeonBar')).replace(/\s+/g, ' ').trim();
    if (!/Depth 1/.test(txt)) throw new Error('bar says "' + txt + '"');
    if (!/0 \/ 120 m/.test(txt)) throw new Error('no progress readout: ' + txt);
    if (!/in \d+ m/.test(txt)) throw new Error('no next-stop readout: ' + txt);
    return txt.replace(/Step out/, '·');
  });

  await step('walking is what starts the first fight', async () => {
    const first = await g.evaluate(() => SS.Dungeon.current().plan[0].at);
    // stop just short of it
    await g.evaluate(a => { SS.Walk.add(Math.max(1, a - 6)); }, first);
    await g.waitForTimeout(200);
    const before = await g.evaluate(() => ({ combat: SS.Game.inCombat, walked: Math.round(SS.Dungeon.current().walked) }));
    if (before.combat) throw new Error('fight fired early, at ' + before.walked + ' of ' + first);
    await g.evaluate(() => SS.Walk.add(12));
    await g.waitForTimeout(400);
    const after = await g.evaluate(() => ({ combat: SS.Game.inCombat, name: SS.Combat.node && SS.Combat.node.name,
                                            transient: SS.Combat.node && SS.Combat.node.transient }));
    if (!after.combat) throw new Error('walked past ' + first + ' m and nothing happened');
    if (!after.transient) throw new Error('the dungeon fight wrote itself into the zone');
    return 'quiet at ' + before.walked + ' m, ambushed past ' + first + ' m: ' + after.name;
  });

  await step('a real clicked fight hands the run back', async () => {
    for (let k = 0; k < 300; k++) {
      if (!(await g.evaluate(() => SS.Game.inCombat))) break;
      // Every action is disabled while the enemy's turn plays out, so a missing
      // button means "wait", not "the fight is over".
      const btn = await g.$('#cbActs .actBtn:not([disabled])');
      if (!btn) { await g.waitForTimeout(150); continue; }
      await btn.click().catch(() => {});
      await g.waitForTimeout(120);
      await g.evaluate(() => { const c = SS.Game.ch; c.stats.hp = c.stats.maxHp; });
    }
    await g.waitForTimeout(300);
    await clearModal(g);
    const r = await g.evaluate(() => {
      const run = SS.Dungeon.current();
      return run && { si: run.stopIndex, fights: run.totals.fights, combat: SS.Game.inCombat };
    });
    if (!r) throw new Error('the run vanished');
    if (r.combat) throw new Error('still in combat');
    if (r.si !== 1) throw new Error('stop index is ' + r.si);
    if (r.fights !== 1) throw new Error('tally says ' + r.fights + ' fights');
    return 'stop 0 cleared, run resumed at stop ' + r.si;
  });

  await step('stepping out holds your place, and you can pick it up', async () => {
    const at = await g.evaluate(() => Math.round(SS.Dungeon.current().walked));
    await g.click('#dgnLeave');
    await g.waitForTimeout(300);
    const paused = await g.evaluate(() => ({
      active: !!SS.Dungeon.current(),
      held: !!SS.Dungeon.pausedFor(SS.Content.list('dungeons')[0].dungeonId),
      barHidden: document.querySelector('#dungeonBar').classList.contains('hidden')
    }));
    if (paused.active) throw new Error('still inside after stepping out');
    if (!paused.held) throw new Error('the run was thrown away, not held');
    if (!paused.barHidden) throw new Error('the bar stayed up');
    await g.evaluate(() => SS.Dungeon.resume(SS.Content.list('dungeons')[0]));
    await g.waitForTimeout(250);
    const back = await g.evaluate(() => {
      const r = SS.Dungeon.current(); return r && { walked: Math.round(r.walked), si: r.stopIndex };
    });
    if (!back) throw new Error('could not get back in');
    if (back.walked !== at) throw new Error('resumed at ' + back.walked + ' m, left at ' + at);
    return 'left at ' + at + ' m, picked it up at ' + back.walked + ' m, stop ' + back.si;
  });

  await step('a chest pays out and the run carries on past it', async () => {
    const got = await walkUntil(g, () => {
      const r = SS.Dungeon.current();
      return !!r && r.totals.chests > 0;
    }, 120);
    if (!got) throw new Error('never reached the chest');
    await clearModal(g);
    const r = await g.evaluate(() => {
      const run = SS.Dungeon.current();
      return run && { chests: run.totals.chests, si: run.stopIndex, gold: SS.Game.ch.gold };
    });
    if (!r) throw new Error('run lost at the chest');
    if (!r.gold) throw new Error('no gold from it');
    return r.chests + ' chest opened, ' + r.gold + ' gold in hand, now at stop ' + r.si;
  });

  await step('the stairs take you down and re-plan the next floor', async () => {
    const reached = await walkUntil(g, () => {
      const r = SS.Dungeon.current();
      return !!r && r.floor === 1;
    }, 200);
    if (!reached) throw new Error('never got off floor 1');
    await clearModal(g);
    const r = await g.evaluate(() => {
      const run = SS.Dungeon.current();
      const d = SS.Content.list('dungeons')[0];
      return run && {
        floor: run.floor, walked: Math.round(run.walked), si: run.stopIndex,
        kinds: run.plan.map(s => s.kind),
        last: run.plan[run.plan.length - 1].at,
        len: d.floors[1].lengthMeters,
        floors: run.totals.floors
      };
    });
    if (!r) throw new Error('run lost on the way down');
    if (r.walked !== 0) throw new Error('the new floor started at ' + r.walked + ' m');
    if (r.si !== 0) throw new Error('stop index carried over: ' + r.si);
    if (r.last !== r.len) throw new Error('new stairs at ' + r.last + ' not ' + r.len);
    if (r.kinds.indexOf('boss') < 0) throw new Error('the boss floor has no boss: ' + r.kinds.join(','));
    if (r.floors !== 1) throw new Error('floor tally is ' + r.floors);
    return 'floor 2 replanned: ' + r.kinds.join(' → ') + ', stairs at ' + r.last + ' m';
  });

  await step('finishing pays a bonus and seals it for the cooldown', async () => {
    const done = await walkUntil(g, () => !SS.Dungeon.current(), 220);
    if (!done) throw new Error('never reached the bottom');
    await clearModal(g);
    const r = await g.evaluate(() => {
      const d = SS.Content.list('dungeons')[0];
      const slot = SS.Store.get('dungeon_runs', {})[SS.Game.ch.characterId] || {};
      const st = (slot.state || {})[d.dungeonId];
      return {
        active: !!slot.active,
        completions: st && st.completions,
        cooldown: SS.Dungeon.cooldownLeft(d),
        gate: SS.Dungeon.canEnter(d, 0),
        barHidden: document.querySelector('#dungeonBar').classList.contains('hidden')
      };
    });
    if (r.active) throw new Error('a run is still open');
    if (r.completions !== 1) throw new Error('completions: ' + r.completions);
    if (!(r.cooldown > 0)) throw new Error('no cooldown was set');
    if (r.gate.ok) throw new Error('walked straight back in');
    if (!r.barHidden) throw new Error('the bar stayed up after finishing');
    return 'sealed: "' + r.gate.why + '"';
  });

  await step('a dungeon with no floors is refused rather than crashing', async () => {
    const r = await g.evaluate(() => {
      const z = SS.Game.zone;
      const d = SS.Content.blankDungeon(z.centerLatitude, z.centerLongitude, z.zoneId);
      d.name = 'Empty'; d.floors = [];
      SS.Content.save('dungeons', d);
      SS.Game.drawDungeons();
      const gate = SS.Dungeon.canEnter(d, 0);
      SS.Content.remove('dungeons', d.dungeonId);
      SS.Game.drawDungeons();
      return gate;
    });
    if (r.ok) throw new Error('it let us into an empty dungeon');
    return '"' + r.why + '"';
  });

  if (gErrors.length) { fail++; console.log('  FAIL game page errors — ' + gErrors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the game'); }
  await c2.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
