/* Quests: naming your real places, and then being sent between them.

   The clock is not involved anywhere here, but position very much is, so the
   suite drives `Loc.simulateTo` and checks what the world does about it. The
   seeded quest in data/quests.json is the fixture — three steps, three roles,
   one of each interesting trigger, and a response that branches. */
const { chromium } = require('playwright');
const path = require('path');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
const fs = require('fs');
const { mockOverpass } = require('./mock-osm');

const GAME_URL   = BASE + '/index.html';
const EDITOR_URL = BASE + '/editor.html';
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
    viewport: { width: 430, height: 900 },
    geolocation: { latitude: HOME.latitude, longitude: HOME.longitude },
    permissions: ['geolocation']
  }, opts));
  const page = await ctx.newPage();
  // Quests seed from data/quests.json; the world tables stay empty so the
  // sample locations do not clutter what the sidebar is asserting.
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

async function clearModal(page) {
  const btn = await page.$('.modalFoot .btn:last-child');
  if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(180); return true; }
  return false;
}

(async () => {
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ======================================================== YOUR PLACES */
  console.log('\n===== NAMING YOUR PLACES =====');
  const { ctx, page: g } = await newPage(browser);
  const errors = [];
  g.on('pageerror', e => errors.push(e.message));
  g.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });

  await g.goto(GAME_URL);
  await g.waitForSelector('#tReg', { timeout: 8000 });
  await g.click('#tReg');
  await g.fill('#rgUser', 'questor'); await g.fill('#rgPass', 'walk1234');
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
  await g.waitForTimeout(600);
  await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));

  await step('the seeded quest arrives with the rest of the database', async () => {
    const r = await g.evaluate(() => {
      const q = SS.Quests.list()[0];
      return { n: SS.Quests.list().length, name: q && q.name,
               steps: q ? SS.Quests.nodesOf(q).length : 0,
               roles: q ? SS.Quests.nodesOf(q).map(x => x.role) : [],
               valid: SS.Quests.validate(q) };
    });
    if (r.n !== 1) throw new Error(r.n + ' quests seeded');
    if (r.steps !== 3) throw new Error(r.steps + ' steps');
    if (r.valid) throw new Error('the sample quest does not validate: ' + r.valid);
    return '"' + r.name + '", ' + r.steps + ' steps across ' + r.roles.join(' → ');
  });

  await step('the picker offers what has actually been surveyed', async () => {
    const r = await g.evaluate(() => {
      SS.Game.openHauntPicker({ slotKey: 'park1' });
      const rows = Array.from(document.querySelectorAll('.hpRow'));
      const first = rows[0];
      if (first) first.click();
      const h = SS.Haunts.get('park1');
      return {
        offered: rows.length,
        chosen: h && { name: h.name, role: h.role, ring: !!h.ring, r: h.radiusM, source: h.source },
        ready: SS.Haunts.ready()
      };
    });
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    if (!r.offered) throw new Error('nothing offered — the atlas had places but the picker showed none');
    if (!r.chosen) throw new Error('clicking a row chose nothing');
    if (!r.chosen.ring) throw new Error('a park from the atlas arrived without its outline');
    if (r.chosen.source !== 'atlas') throw new Error('source ' + r.chosen.source);
    return r.offered + ' offered, took "' + r.chosen.name + '" (' + r.chosen.r + ' m, real outline)';
  });

  await step('a pin works where the survey missed something', async () => {
    const r = await g.evaluate(() => {
      const p = SS.Loc.last;
      SS.Haunts.set('home', SS.Haunts.fromPoint(p.latitude, p.longitude, 'home', 'holdfast', 'My place', 70));
      const h = SS.Haunts.get('home');
      return { name: h.name, role: h.role, ring: h.ring, source: h.source, ready: SS.Haunts.ready() };
    });
    if (r.ring) throw new Error('a dropped pin invented an outline');
    if (r.source !== 'pin') throw new Error('source ' + r.source);
    if (!r.ready) throw new Error('home and a park are set but it is still not ready');
    return '"' + r.name + '" as a circle, required slots now filled';
  });

  await step('places belong to the account, not to one character', async () => {
    const r = await g.evaluate(() => {
      const mine = SS.Haunts.all();
      const key = Object.keys(SS.Store.get('player_haunts', {}) || {})[0];
      const session = SS.Store.get(SS.K.session, {});
      return { keyedBy: key, userId: session.userId, slots: Object.keys(mine).length };
    });
    if (r.keyedBy !== r.userId) throw new Error('keyed by ' + r.keyedBy + ', not the account');
    return r.slots + ' slots under the account';
  });

  await step('a role resolves to your place, and falls back rather than failing', async () => {
    const r = await g.evaluate(() => {
      const forest = SS.Haunts.resolve('forest');
      const tavern = SS.Haunts.resolve('tavern');       // nothing assigned to it
      // And with nothing at all set, it should still find somewhere.
      const kept = JSON.parse(JSON.stringify(SS.Store.get('player_haunts', {})));
      SS.Haunts.clear();
      const bare = SS.Haunts.resolve('forest', { at: SS.Loc.last });
      SS.Store.set('player_haunts', kept);
      return {
        forest: forest && forest.name, forestRole: forest && forest.role,
        tavern: tavern && tavern.name,
        bare: bare && { name: bare.name, improvised: !!bare.improvised }
      };
    });
    if (!r.forest || r.forestRole !== 'forest') throw new Error('the forest role missed its own place');
    if (!r.tavern) throw new Error('an unassigned role found nowhere at all');
    if (!r.bare) throw new Error('with no places set it gave up');
    if (!r.bare.improvised) throw new Error('it invented one without saying so');
    return '"' + r.forest + '" for a forest, "' + r.tavern + '" borrowed for a tavern, "' +
           r.bare.name + '" improvised from the atlas';
  });

  /* ========================================================= THE BOUNDARY */
  console.log('\n===== THE BOUNDARY =====');

  await step('the percentage shrinks the area about the middle', async () => {
    const r = await g.evaluate(() => {
      const h = SS.Haunts.get('park1');
      return {
        full: SS.Haunts.areaRadiusM(h, 100, 5, 0),
        half: SS.Haunts.areaRadiusM(h, 50, 5, 0),
        tenth: SS.Haunts.areaRadiusM(h, 10, 5, 0),
        size: h.radiusM
      };
    });
    if (r.full !== r.size) throw new Error('100% gave ' + r.full + ' of ' + r.size);
    if (Math.abs(r.half - r.size / 2) > 1) throw new Error('50% gave ' + r.half);
    if (r.tenth >= r.half) throw new Error('10% was not smaller than 50%');
    return r.size + ' m park → ' + r.full + ' / ' + r.half + ' / ' + r.tenth + ' m at 100/50/10%';
  });

  await step('the floor stops a small park collapsing, and the park beats the floor', async () => {
    const r = await g.evaluate(() => {
      const small = { radiusM: 15 }, big = { radiusM: 400 };
      return {
        smallAt10: SS.Haunts.areaRadiusM(small, 10, 25, 0),   // floor 25 > park 15
        bigAt10: SS.Haunts.areaRadiusM(big, 10, 25, 0),       // 40, above the floor
        capped: SS.Haunts.areaRadiusM(big, 100, 25, 60),      // max wins
        never0: SS.Haunts.areaRadiusM(small, 5, 5, 0)
      };
    });
    if (r.smallAt10 > 15) throw new Error('a 15 m park was given a ' + r.smallAt10 + ' m area');
    if (r.smallAt10 < 10) throw new Error('it collapsed to ' + r.smallAt10 + ' m');
    if (r.bigAt10 !== 40) throw new Error('10% of 400 m gave ' + r.bigAt10);
    if (r.capped !== 60) throw new Error('the ceiling was ignored: ' + r.capped);
    return '15 m park at 10% → ' + r.smallAt10 + ' m (floor 25 clamped to the park), ' +
           '400 m → ' + r.bigAt10 + ' m, ceiling honoured at ' + r.capped;
  });

  await step('a node lands inside the park, not merely near it', async () => {
    const r = await g.evaluate(() => {
      const h = SS.Haunts.get('park1');
      let inRing = 0, inside = 0;
      const n = 40;
      for (let i = 0; i < n; i++) {
        const p = SS.Haunts.pointIn(h, 100, 10, 0);
        if (p.inRing) inRing++;
        if (SS.Content.pointInRing(h.ring, p.latitude, p.longitude)) inside++;
      }
      // And a tight boundary keeps them near the middle.
      let far = 0;
      for (let i = 0; i < n; i++) {
        const p = SS.Haunts.pointIn(h, 30, 5, 0);
        if (SS.haversine(h.latitude, h.longitude, p.latitude, p.longitude) > h.radiusM * 0.6) far++;
      }
      return { n, inRing, inside, far, ring: h.ring.length };
    });
    if (r.inside !== r.n) throw new Error(r.n - r.inside + ' of ' + r.n + ' points fell outside the park');
    if (!r.inRing) throw new Error('none of them used the real outline');
    if (r.far) throw new Error(r.far + ' points at a 30% boundary were out near the edge');
    return r.n + '/' + r.n + ' inside a ' + r.ring + '-point outline, and a 30% boundary stayed central';
  });

  /* ========================================================== RUNNING ONE */
  console.log('\n===== RUNNING A QUEST =====');

  await step('a location marked a giver offers its quest instead of a fight', async () => {
    const r = await g.evaluate(() => {
      const p = SS.Loc.last;
      const q = SS.Quests.list()[0];
      const loc = SS.Content.blankLocation(p.latitude, p.longitude, SS.Game.zone.zoneId);
      loc.name = 'The Tanner'; loc.kind = 'combat'; loc.radius = 40;
      loc.isQuestGiver = true;
      const saved = SS.Content.save('locations', loc);
      q.giverLocationId = saved.locationId;
      SS.Content.save('quests', q);
      SS.Game.syncAuthoredLocations();
      const node = SS.Game.nodes.find(n => n.locationId === saved.locationId);
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      SS.Game.openNode(node);
      const modal = document.querySelector('.modalBack');
      return {
        icon: node && node.icon,
        title: modal && modal.querySelector('.modalHead h3').textContent,
        body: modal ? modal.querySelector('.modalBody').textContent : '',
        buttons: modal ? Array.from(modal.querySelectorAll('.modalFoot .btn')).map(b => b.textContent) : []
      };
    });
    if (r.icon !== '📜') throw new Error('a giver draws as ' + r.icon);
    if (!/word with you/i.test(r.title || '')) throw new Error('opened "' + r.title + '" instead');
    if (r.buttons.indexOf('Take it on') < 0) throw new Error('no way to accept: ' + r.buttons.join(', '));
    if (/Engage|Challenge/.test(r.buttons.join(' '))) throw new Error('it offered a fight as well');
    return '"' + r.title + '" — ' + r.buttons.join(' / ');
  });

  await step('taking it on puts the first step in one of your places', async () => {
    await g.evaluate(() => {
      Array.from(document.querySelectorAll('.modalFoot .btn'))
        .find(b => b.textContent === 'Take it on').click();
    });
    await g.waitForTimeout(300);
    const r = await g.evaluate(() => {
      const live = SS.Quests.liveNodes();
      const n = live[0];
      const h = SS.Haunts.get('park1');
      return {
        live: live.length, name: n && n.name, place: n && n.placeName,
        trigger: n && n.trigger, area: n && n.areaM,
        insidePark: n ? SS.Content.pointInRing(h.ring, n.latitude, n.longitude) : false,
        pins: document.querySelectorAll('.questPin').length,
        inSidebar: SS.Game.interactables().some(x => x.kind === 'quest'),
        sidebarFirst: (SS.Game.interactables()[0] || {}).kind
      };
    });
    if (r.live !== 1) throw new Error(r.live + ' live nodes');
    if (!r.insidePark) throw new Error('step one landed outside ' + r.place);
    if (r.pins !== 1) throw new Error(r.pins + ' pins drawn');
    if (!r.inSidebar) throw new Error('it is not in the sidebar');
    if (r.sidebarFirst !== 'quest') throw new Error('the sidebar buried it under ' + r.sidebarFirst);
    return '"' + r.name + '" in ' + r.place + ', ' + r.area + ' m area, first in the sidebar';
  });

  await step('a walk step counts metres there and nowhere else', async () => {
    const r = await g.evaluate(() => {
      const live = SS.Quests.liveNodes()[0];
      // Half a kilometre from it: nothing should count.
      const away = SS.projectPoint(live.latitude, live.longitude, 500, 90);
      SS.Loc.simulateTo(away.latitude, away.longitude);
      SS.Walk.add(200);
      const afterAway = SS.Quests.liveNodes()[0].walked;
      // Standing on it: it counts.
      SS.Loc.simulateTo(live.latitude, live.longitude);
      SS.Walk.add(120);
      const afterThere = SS.Quests.liveNodes()[0].walked;
      return { afterAway, afterThere, need: live.walkMeters };
    });
    if (r.afterAway !== 0) throw new Error('walking across town counted ' + r.afterAway + ' m');
    if (Math.round(r.afterThere) !== 120) throw new Error('walking there counted ' + r.afterThere);
    return '0 m from 200 m away, ' + Math.round(r.afterThere) + ' / ' + r.need + ' m on the spot';
  });

  await step('finishing a step moves the quest to the next place', async () => {
    const r = await g.evaluate(() => {
      const before = SS.Quests.liveNodes()[0];
      SS.Walk.add(200);                              // over the 300 m it wanted
      const live = SS.Quests.liveNodes()[0];
      const met = SS.Quests.triggerMet(live, { at: SS.Loc.last });
      SS.Game.finishQuestNode(live, {});
      const now = SS.Quests.liveNodes()[0];
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return {
        met, wasName: before.name, nowName: now && now.name,
        nowPlace: now && now.placeName, nowTrigger: now && now.trigger,
        moved: now && (now.latitude !== before.latitude),
        index: now && now.run.nodeIndex,
        xp: SS.Game.ch.experience
      };
    });
    if (!r.met) throw new Error('300 m walked and the trigger still was not met');
    if (r.index !== 1) throw new Error('on step index ' + r.index);
    if (!r.moved) throw new Error('the next step landed in the same spot');
    return '"' + r.wasName + '" → "' + r.nowName + '" at ' + r.nowPlace + ' (' + r.nowTrigger + ')';
  });

  await step('a response can branch, and the flag it sets is remembered', async () => {
    const r = await g.evaluate(() => {
      const live = SS.Quests.liveNodes()[0];
      SS.Loc.simulateTo(live.latitude, live.longitude);
      const beats = SS.Quests.beatsFor(live.node, live.run);
      const responses = SS.Quests.responsesFor(beats[beats.length - 1], live.run);
      // Take the second answer: mark the spot and go back, which finishes the
      // step early and sets its own flag.
      const chosen = responses[1];
      const out = SS.Quests.choose(live.run, chosen);
      return { beats: beats.length, responses: responses.map(x => x.text),
               outcome: out.outcome, flags: Object.keys(live.run.flags) };
    });
    if (r.responses.length !== 2) throw new Error(r.responses.length + ' answers offered');
    if (r.outcome !== 'finish') throw new Error('outcome ' + r.outcome);
    if (r.flags.indexOf('went_back') < 0) throw new Error('flags: ' + r.flags.join(','));
    return '"' + r.responses[1] + '" → ' + r.outcome + ', flag noted';
  });

  await step('a line only shown for a flag you have is the one you get', async () => {
    const r = await g.evaluate(() => {
      const live = SS.Quests.liveNodes()[0];
      SS.Game.finishQuestNode(live, {});                 // onto the last step
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      const last = SS.Quests.liveNodes()[0];
      SS.Loc.simulateTo(last.latitude, last.longitude);
      const withBack = SS.Quests.beatsFor(last.node, last.run).map(b => b.requireFlag || '-');
      // Now pretend the other branch had been taken instead.
      const kept = Object.assign({}, last.run.flags);
      last.run.flags = { saw_the_beast: true };
      SS.Quests.saveRun(last.run);
      const withBeast = SS.Quests.beatsFor(last.node, last.run).map(b => b.requireFlag || '-');
      last.run.flags = kept; SS.Quests.saveRun(last.run);
      return { withBack, withBeast, name: last.name };
    });
    if (r.withBack.indexOf('went_back') < 0) throw new Error('the flag line is missing: ' + r.withBack.join(','));
    if (r.withBack.indexOf('saw_the_beast') >= 0) throw new Error('a line for a flag we do not have showed up');
    if (r.withBeast.indexOf('saw_the_beast') < 0) throw new Error('the other branch never appears');
    return 'went_back → [' + r.withBack.join(', ') + '], saw_the_beast → [' + r.withBeast.join(', ') + ']';
  });

  await step('the last step finishes the quest and pays for it', async () => {
    const r = await g.evaluate(() => {
      const gold = SS.Game.ch.gold;
      const live = SS.Quests.liveNodes()[0];
      SS.Game.finishQuestNode(live, {});
      const modal = document.querySelector('.modalBack');
      // The whole panel, not just its body: "Quest complete" is the heading.
      const text = modal ? modal.textContent : '';
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      const run = SS.Quests.runOf(SS.Quests.list()[0].questId);
      return {
        status: run.status, live: SS.Quests.liveNodes().length,
        completions: run.completions, goldUp: SS.Game.ch.gold - gold,
        text, pins: document.querySelectorAll('.questPin').length
      };
    });
    if (r.status !== 'done') throw new Error('status ' + r.status);
    if (r.live) throw new Error(r.live + ' nodes still live after finishing');
    if (r.pins) throw new Error(r.pins + ' pins left on the map');
    if (r.goldUp <= 0) throw new Error('it paid ' + r.goldUp + ' gold');
    if (!/complete/i.test(r.text)) throw new Error('no completion panel');
    return 'done, ' + r.goldUp + ' gold over the last step and the bonus';
  });

  await step('a repeatable quest can be taken again; a one-off cannot', async () => {
    const r = await g.evaluate(() => {
      const q = SS.Quests.list()[0];
      const again = SS.Quests.canAccept(q);
      q.repeatable = false;
      SS.Content.save('quests', q);
      const once = SS.Quests.canAccept(q);
      q.repeatable = true; SS.Content.save('quests', q);
      return { again, once };
    });
    if (!r.again.ok) throw new Error('a repeatable quest refused: ' + r.again.why);
    if (r.once.ok) throw new Error('a one-off quest was offered twice');
    return 'repeatable yes · one-off "' + r.once.why + '"';
  });

  await step('the quest log shows what is in hand and where it wants you', async () => {
    const r = await g.evaluate(() => {
      const q = SS.Quests.list()[0];
      SS.Quests.accept(q, { at: SS.Loc.last });
      SS.Game.questLog();
      const modal = document.querySelector('.modalBack');
      const text = modal ? modal.querySelector('.modalBody').textContent : '';
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return { text, live: SS.Quests.liveNodes().length };
    });
    if (!/Greenwood/.test(r.text)) throw new Error('the log does not name the quest: ' + r.text.slice(0, 80));
    if (!/Walk the tree line/.test(r.text)) throw new Error('it does not say what to do next');
    return 'log lists it with its current step';
  });

  if (errors.length) { fail++; console.log('  FAIL game page errors — ' + errors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the game'); }
  await ctx.close();

  /* ========================================================== THE EDITOR */
  console.log('\n===== THE QUESTS TAB =====');
  const { ctx: c2, page: e } = await newPage(browser, { viewport: { width: 1500, height: 950 } });
  const eErrors = [];
  e.on('pageerror', x => eErrors.push(x.message));
  e.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) eErrors.push(m.text()); });
  e.on('dialog', d => d.accept());
  await e.goto(EDITOR_URL);
  await e.waitForSelector('.edTop', { timeout: 8000 });
  await e.waitForTimeout(600);

  await step('the tab lists quests by where they send you', async () => {
    await e.click('[data-tab="quests"]');
    await e.waitForTimeout(300);
    const r = await e.evaluate(() => ({
      rows: document.querySelectorAll('#edListWrap tbody tr').length,
      text: (document.querySelector('#edListWrap tbody tr') || {}).textContent || '',
      newLabel: (document.querySelector('#edNew') || {}).textContent
    }));
    if (r.rows !== 1) throw new Error(r.rows + ' rows');
    if (!/🌲/.test(r.text)) throw new Error('the roles are not shown: ' + r.text);
    if (!/New quest/.test(r.newLabel || '')) throw new Error('the button says "' + r.newLabel + '"');
    return r.rows + ' quest, roles shown, "' + r.newLabel + '"';
  });

  await step('the form opens its first step, with the boundary explained', async () => {
    await e.click('#edListWrap tbody tr');
    await e.waitForTimeout(400);
    const r = await e.evaluate(() => ({
      steps: document.querySelectorAll('.floorBox').length,
      open: document.querySelectorAll('.floorBox.open').length,
      beats: document.querySelectorAll('.beatBox').length,
      preview: (document.querySelector('[id^=qn_prev]') || {}).textContent || ''
    }));
    if (r.steps !== 3) throw new Error(r.steps + ' steps');
    if (r.open !== 1) throw new Error(r.open + ' steps open');
    if (!/pocket park/.test(r.preview)) throw new Error('no boundary preview: ' + r.preview);
    return r.steps + ' steps, one open, ' + r.beats + ' line(s) — "' + r.preview.slice(0, 44) + '…"';
  });

  await step('the slider and the box are one number', async () => {
    const r = await e.evaluate(() => {
      const range = document.querySelector('[id^=qn_bpr]');
      const box = document.querySelector('[id^=qn_bp]:not([id^=qn_bpr])');
      range.value = 40; range.dispatchEvent(new Event('input', { bubbles: true }));
      const afterSlider = { box: box.value, draft: ED.Ed.draft.nodes[0].boundaryPercent };
      box.value = 65; box.dispatchEvent(new Event('input', { bubbles: true }));
      const afterBox = { range: range.value, draft: ED.Ed.draft.nodes[0].boundaryPercent };
      return { afterSlider, afterBox,
               preview: document.querySelector('[id^=qn_prev]').textContent };
    });
    if (+r.afterSlider.box !== 40 || r.afterSlider.draft !== 40) throw new Error('the slider did not reach the box');
    if (+r.afterBox.range !== 65 || r.afterBox.draft !== 65) throw new Error('the box did not reach the slider');
    if (!/At 65%/.test(r.preview)) throw new Error('the preview did not follow: ' + r.preview.slice(0, 30));
    return 'slider 40 → box 40, box 65 → slider 65, preview followed';
  });

  await step('dialogue edits write through, answers and all', async () => {
    const r = await e.evaluate(() => {
      const txt = document.querySelector('[data-btext]');
      txt.value = 'Changed line.'; txt.dispatchEvent(new Event('input', { bubbles: true }));
      const spk = document.querySelector('[data-bspk]');
      spk.value = 'Somebody'; spk.dispatchEvent(new Event('input', { bubbles: true }));
      ED.Ed.openNode = 1; ED.Ed.renderQuestNodes();
      const rt = document.querySelector('[data-rtext]');
      rt.value = 'A new answer'; rt.dispatchEvent(new Event('input', { bubbles: true }));
      const sel = document.querySelector('[data-rout]');
      sel.value = 'goto'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      const n0 = ED.Ed.draft.nodes[0], n1 = ED.Ed.draft.nodes[1];
      return {
        line: n0.dialogue[0].text, speaker: n0.dialogue[0].speaker,
        answer: n1.dialogue[0].responses[0].text,
        outcome: n1.dialogue[0].responses[0].outcome,
        gotoPicker: !!document.querySelector('[data-rgoto]')
      };
    });
    if (r.line !== 'Changed line.') throw new Error('the line did not save');
    if (r.speaker !== 'Somebody') throw new Error('the speaker did not save');
    if (r.answer !== 'A new answer') throw new Error('the answer did not save');
    if (r.outcome !== 'goto') throw new Error('outcome ' + r.outcome);
    if (!r.gotoPicker) throw new Error('choosing "jump to a step" offered no step to jump to');
    return 'line, speaker, answer and outcome all written; the jump picker appeared';
  });

  await step('it refuses a quest that cannot be run', async () => {
    const r = await e.evaluate(() => {
      const d = ED.Ed.draft;
      // The test above left an answer set to "jump", with nowhere to jump to.
      // Put it back before asking whether a good quest passes.
      d.nodes[1].dialogue[0].responses[0].outcome = 'next';
      d.nodes[1].dialogue[0].responses[0].gotoNodeId = '';
      const before = ED.Ed.validate(d);
      // An answer that jumps, pointing nowhere.
      d.nodes[1].dialogue[0].responses[0].outcome = 'goto';
      d.nodes[1].dialogue[0].responses[0].gotoNodeId = 'qn_does_not_exist';
      const dangling = ED.Ed.validate(d);
      d.nodes[1].dialogue[0].responses[0].outcome = 'next';
      d.nodes[1].dialogue[0].responses[0].gotoNodeId = '';
      // A walk step with no distance.
      d.nodes[0].trigger = 'walk'; d.nodes[0].walkMeters = 0;
      const noWalk = ED.Ed.validate(d);
      d.nodes[0].walkMeters = 300;
      // And a boundary outside its range.
      d.nodes[0].boundaryPercent = 140;
      const badBoundary = ED.Ed.validate(d);
      d.nodes[0].boundaryPercent = 80;
      return { before, dangling, noWalk, badBoundary, after: ED.Ed.validate(d) };
    });
    if (r.before) throw new Error('the sample quest was rejected: ' + r.before);
    if (!/not there/.test(r.dangling || '')) throw new Error('a dangling jump passed: ' + r.dangling);
    if (!/no distance/.test(r.noWalk || '')) throw new Error('a walk step with no distance passed');
    if (!/5% and 100%/.test(r.badBoundary || '')) throw new Error('a 140% boundary passed');
    return '"' + r.dangling + '" / "' + r.noWalk + '"';
  });

  await step('a new quest starts with one step and saves', async () => {
    await e.click('#edNew');
    await e.waitForTimeout(300);
    const r = await e.evaluate(() => {
      const nm = document.querySelector('#f_name');
      nm.value = 'A Second Errand'; nm.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#edSave').click();
      return { n: SS_count(), names: ED.Content.list('quests').map(q => q.name),
               steps: ED.Content.list('quests').find(q => q.name === 'A Second Errand').nodes.length };
      function SS_count() { return ED.Content.list('quests').length; }
    });
    if (r.n !== 2) throw new Error(r.n + ' quests after saving a new one');
    if (r.steps !== 1) throw new Error('a new quest started with ' + r.steps + ' steps');
    return r.n + ' quests: ' + r.names.join(', ');
  });

  if (eErrors.length) { fail++; console.log('  FAIL editor page errors — ' + eErrors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the editor'); }
  await c2.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
