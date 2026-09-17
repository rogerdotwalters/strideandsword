/* Buildings: places on the map, and the people who work out of them.

   Three claims, and they fail differently:

     · **the person is the shop.** A building hands one character to the
       living world, that character moves on the clock like every other
       denizen, and everything you can buy or mend is behind meeting them.
       If the resident stops moving, or stops staying near their own
       building, this feature is a menu with extra steps.

     · **the shelf is derived, the receipt is stored.** Stock is a pure
       function of (building, six-hour window, index) — the same on every
       device, before and after a reload — and the only thing written down is
       what has been carried away.

     · **the name is the schema.** "building: Store level 3" out of Google
       Earth has to land as a level 3 store, and a placemark that says
       nothing of the sort must not become one.

   The parser half runs in node against the KML fixtures; everything else
   runs in the real game page. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
const { mockOverpass } = require('./mock-osm');

const GAME_URL   = BASE + '/index.html';
const EDITOR_URL = BASE + '/mapeditor.html';
const LEAFLET_JS  = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

const HOME = { latitude: 41.8827, longitude: -87.6233 };
const NOON = new Date(2026, 8, 14, 12, 0, 0).getTime();

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
  await emptyDatabase(page);
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

/** Make a character and get as far as the map. */
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
  await g.waitForFunction(() => !SS.Game._chunkBusy, null, { timeout: 40000 }).catch(() => {});
  await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
}

/** One building of our own, 60 m east of the player, with everything on. */
async function putOneDown(g, over) {
  return g.evaluate((over) => {
    const p = projectPoint(SS.Loc.last.latitude, SS.Loc.last.longitude, 60, 90);
    const b = SS.Buildings.blank('smithy', p.latitude, p.longitude);
    Object.assign(b, {
      buildingId: 'bld_test', name: 'Ash & Ember', level: 3, radius: 50,
      trades: ['goods', 'rest', 'mend', 'talk']
    }, over || {});
    SS.Buildings.save(b);
    SS.Game.drawBuildings();
    return SS.Buildings.get('bld_test');
  }, over || null);
}

(async () => {
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ============================================== THE NAME IS THE SCHEMA == */
  console.log('\n===== NAMES OUT OF GOOGLE EARTH =====');

  const KML = require('./mapimport.js').loadKml();
  const B = KML.Buildings;

  await step('"building: Store level 3" is a level 3 store called Store', async () => {
    const r = B.parseName('building: Store level 3');
    if (!r.declared) throw new Error('not read as a declaration');
    if (r.kind !== 'store') throw new Error('kind came out ' + r.kind);
    if (r.level !== 3) throw new Error('level came out ' + r.level);
    if (r.name !== 'Store') throw new Error('name came out "' + r.name + '"');
    return r.name + ' / ' + r.kind + ' / level ' + r.level;
  });

  await step('the kind can lead, and the trailing kind word is dropped', async () => {
    const a = B.parseName('smithy: Ash & Ember level 5 radius 40m');
    if (!(a.declared && a.kind === 'smithy' && a.level === 5 && a.radiusM === 40)) {
      throw new Error(JSON.stringify(a));
    }
    if (a.name !== 'Ash & Ember') throw new Error('name came out "' + a.name + '"');
    const b = B.parseName('building: The Gilded Flask, tavern, level 2');
    if (b.name !== 'The Gilded Flask' || b.kind !== 'tavern') throw new Error(JSON.stringify(b));
    return a.name + ' · ' + b.name;
  });

  await step('ordinary ground is not a building', async () => {
    const a = B.parseName('Black Fork Creek');
    if (a.declared || a.kind) throw new Error('a creek came out as ' + a.kind);
    const b = B.parseName('Note: the old forge');
    if (b.declared) throw new Error('"Note:" was read as a declaration');
    return 'creek and note both left alone';
  });

  await step('the name beats the folder it was filed in', async () => {
    const r = B.parseName('smithy: Ash & Ember', 'Shops');
    if (r.kind !== 'smithy') throw new Error('a smithy in a folder called Shops became a ' + r.kind);
    const f = B.parseName('building: The Corner', 'Taverns');
    if (f.kind !== 'tavern') throw new Error('a nameless building ignored its folder: ' + f.kind);
    return 'name first, folder second';
  });

  await step('a level is clamped to 1–10', async () => {
    if (B.parseName('building: Store level 40').level !== 10) throw new Error('level 40 was not clamped');
    if (B.parseName('building: Store level 0').level !== 1) throw new Error('level 0 was not clamped');
    return '1..10';
  });

  /* ------------------------------------------------------- the file itself */

  const KML_TEXT = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Survey.kml</name>
<Folder><name>Shops</name>
<Placemark><name>building: Store level 3</name><Point><coordinates>-95.3,32.35,0</coordinates></Point></Placemark>
<Placemark><name>smithy: Ash &amp; Ember level 5</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
-95.301,32.351,0 -95.3005,32.351,0 -95.3005,32.3505,0 -95.301,32.3505,0 -95.301,32.351,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Folder>
<Folder><name>Low ground</name>
<Placemark><name>The wet field</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
-95.32,32.37,0 -95.318,32.37,0 -95.318,32.368,0 -95.32,32.368,0 -95.32,32.37,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>A lone pin</name><Point><coordinates>-95.33,32.33,0</coordinates></Point></Placemark>
</Folder></Document></kml>`;

  let doc = null;
  await step('a pin becomes a building, a nameless pin is still skipped', async () => {
    doc = KML.toGeoJSON(KML_TEXT, {});
    if (doc.buildings !== 2) throw new Error(doc.buildings + ' buildings, expected 2');
    if (doc.skipped.points !== 1) throw new Error(doc.skipped.points + ' pins skipped, expected 1');
    const ground = doc.features.filter(f => f.properties.feature !== 'building');
    if (ground.length !== 1) throw new Error(ground.length + ' regions, expected 1');
    return '2 buildings, 1 region, 1 pin left alone';
  });

  await step('a traced shopfront keeps its outline and is not also a region', async () => {
    const poly = doc.features.find(f => f.properties.feature === 'building' &&
                                        f.geometry.type === 'Polygon');
    if (!poly) throw new Error('the traced smithy did not come through');
    const b = B.fromFeature(poly);
    if (b.kind !== 'smithy' || b.level !== 5) throw new Error(JSON.stringify(b).slice(0, 80));
    if (b.footprint.length !== 4) throw new Error(b.footprint.length + ' corners, expected 4');
    // The centroid of the traced ring, not [0,0].
    if (!(Math.abs(b.latitude - 32.35075) < 0.001)) throw new Error('centroid is at ' + b.latitude);
    return b.footprint.length + ' corners, middle at ' + b.latitude.toFixed(5);
  });

  /* ====================================================== IN THE GAME ===== */
  console.log('\n===== THE PERSON IS THE SHOP =====');

  const { ctx, page: g } = await newPage(browser);
  const errors = [];
  g.on('pageerror', e => errors.push(e.message));
  g.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });

  await intoTheGame(g, 'shopkeep');
  await putOneDown(g);

  await step('a building puts one person into the living world', async () => {
    const r = await g.evaluate((t) => {
      const b = SS.Buildings.get('bld_test');
      const zones = SS.Denizens.territories(SS.Loc.last.latitude, SS.Loc.last.longitude, 400)
        .filter(z => z.buildingId === 'bld_test');
      const live = SS.Denizens.near(SS.Loc.last.latitude, SS.Loc.last.longitude, 400, t)
        .filter(d => d.buildingId === 'bld_test');
      return { zones: zones.length, live: live.length, kind: live[0] && live[0].kind,
               name: live[0] && live[0].name, trades: (live[0] && live[0].trades) || [] };
    }, NOON);
    if (r.zones !== 1) throw new Error(r.zones + ' territories, expected 1');
    if (r.live !== 1) throw new Error(r.live + ' residents, expected 1');
    if (r.kind !== 'character') throw new Error('the resident is a ' + r.kind);
    if (r.trades.length !== 4) throw new Error('trades came through as ' + JSON.stringify(r.trades));
    return r.name + ', who will ' + r.trades.join(', ');
  });

  await step('they are named the same thing on every look', async () => {
    const names = await g.evaluate((t) => {
      const b = SS.Buildings.get('bld_test');
      return [0, 1, 2].map(i => {
        const d = SS.Buildings.residentOf(b, t + i * 97000);
        return d && d.name;
      });
    }, NOON);
    if (new Set(names).size !== 1) throw new Error('three looks gave ' + names.join(' / '));
    return names[0];
  });

  await step('they move, and they stay in their own yard', async () => {
    const r = await g.evaluate((t) => {
      const b = SS.Buildings.get('bld_test');
      const c = SS.Buildings.centroid(b);
      let out = 0, moved = 0, last = null;
      /* 71 s apart against a 40 s leg, so the samples walk every phase of the
         movement rather than landing on the waypoints. */
      for (let i = 0; i < 300; i++) {
        const d = SS.Buildings.residentOf(b, t + i * 71000);
        const away = haversine(c.latitude, c.longitude, d.latitude, d.longitude);
        if (away > (+b.radius || 45) + 1) out++;
        if (last && haversine(last.latitude, last.longitude, d.latitude, d.longitude) > 1) moved++;
        last = d;
      }
      return { out, moved };
    }, NOON);
    if (r.out) throw new Error(r.out + ' of 300 samples were outside the yard');
    if (r.moved < 250) throw new Error('only moved on ' + r.moved + ' of 300 samples');
    return '300 samples, none outside, ' + r.moved + ' of them a step from the last';
  });

  await step('the building card names who works there and how far off they are', async () => {
    const txt = await g.evaluate(() => {
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      SS.Game.openBuilding(SS.Buildings.get('bld_test'));
      const m = document.querySelector('.modalBack .modalBody');
      return m ? m.textContent : '';
    });
    if (!/Worked by/.test(txt)) throw new Error('the card does not say who works there');
    if (!/Right now/.test(txt)) throw new Error('the card does not say where they are');
    if (!/Level 3|level 3/.test(txt)) throw new Error('the card does not say what level it is');
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    return txt.replace(/\s+/g, ' ').slice(0, 64) + '…';
  });

  /* ==================================================== THE SHELF ========= */
  console.log('\n===== WHAT THEY CARRY =====');

  await step('stock is the same on every look, and different next window', async () => {
    const r = await g.evaluate((t) => {
      const b = SS.Buildings.get('bld_test');
      const a1 = SS.Buildings.stockOf(b, t).map(s => s.item.name + '/' + s.item.level);
      const a2 = SS.Buildings.stockOf(b, t + 60000).map(s => s.item.name + '/' + s.item.level);
      const a3 = SS.Buildings.stockOf(b, t + 7 * 3600 * 1000).map(s => s.item.name + '/' + s.item.level);
      return { a1, a2, a3 };
    }, NOON);
    if (r.a1.join('|') !== r.a2.join('|')) throw new Error('a minute later the shelf had changed');
    if (r.a1.join('|') === r.a3.join('|')) throw new Error('the shelf never restocks');
    return r.a1.length + ' things: ' + r.a1.slice(0, 2).join(', ') + '…';
  });

  await step('a reload finds the same shelf', async () => {
    const before = await g.evaluate((t) =>
      SS.Buildings.stockOf(SS.Buildings.get('bld_test'), t).map(s => s.item.itemId + ':' + s.item.name), NOON);
    await g.reload();
    await g.waitForSelector('#charList .pick', { timeout: 10000 });
    await g.click('#charList .pick');
    await g.waitForSelector('#map', { timeout: 8000 });
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    const after = await g.evaluate((t) =>
      SS.Buildings.stockOf(SS.Buildings.get('bld_test'), t).map(s => s.item.itemId + ':' + s.item.name), NOON);
    if (before.join('|') !== after.join('|')) throw new Error('the world was rebuilt with different stock');
    return after.length + ' rows, identical';
  });

  await step('buying charges gold, fills the pack, and clears the shelf', async () => {
    const r = await g.evaluate((t) => {
      const c = SS.Game.ch;
      c.gold = 5000;
      const b = SS.Buildings.get('bld_test');
      const row = SS.Buildings.stockOf(b, t).find(s => !s.taken);
      const price = SS.Buildings.buyPrice(row.item, c);
      const before = { gold: c.gold, pack: (c.inventory || []).length };
      const res = SS.Buildings.buy(b, row.index, c, t);
      const still = SS.Buildings.stockOf(b, t)[row.index];
      return { ok: res.ok, why: res.why, price, paid: before.gold - c.gold,
               got: (c.inventory || []).length - before.pack,
               name: res.item && res.item.name,
               inPack: (c.inventory || []).some(i => i.itemId === row.item.itemId),
               stillThere: !still.taken };
    }, NOON);
    if (!r.ok) throw new Error(r.why);
    if (r.paid !== r.price) throw new Error('paid ' + r.paid + ' for a ' + r.price + ' gold thing');
    if (r.got !== 1 || !r.inPack) throw new Error('it did not land in the pack');
    if (r.stillThere) throw new Error('it is still on the shelf');
    return r.name + ' for ' + r.price + ' gold';
  });

  await step('what was bought is still gone after a reload', async () => {
    await g.reload();
    await g.waitForSelector('#charList .pick', { timeout: 10000 });
    await g.click('#charList .pick');
    await g.waitForSelector('#map', { timeout: 8000 });
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    const n = await g.evaluate((t) =>
      SS.Buildings.stockOf(SS.Buildings.get('bld_test'), t).filter(s => s.taken).length, NOON);
    if (n !== 1) throw new Error(n + ' rows marked sold, expected 1');
    return 'one row still sold';
  });

  await step('an empty purse is refused in words', async () => {
    const r = await g.evaluate((t) => {
      const c = SS.Game.ch;
      c.gold = 0;
      const b = SS.Buildings.get('bld_test');
      const row = SS.Buildings.stockOf(b, t).find(s => !s.taken);
      const res = SS.Buildings.buy(b, row.index, c, t);
      return { ok: res.ok, why: res.why, gold: c.gold };
    }, NOON);
    if (r.ok) throw new Error('it sold on credit');
    if (!/gold short/.test(r.why)) throw new Error('the refusal was "' + r.why + '"');
    return r.why;
  });

  await step('selling pays out and empties the row', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      c.gold = 0;
      /* Put something in the pack here rather than relying on the purchase
         two tests ago: that one was never written down, and a reload since
         has rebuilt the character from storage. */
      c.inventory.push(SS.Items.generate(5, 10, 3, 'boots'));
      const item = c.inventory[c.inventory.length - 1];
      const b = SS.Buildings.get('bld_test');
      const res = SS.Buildings.sell(b, item, c);
      return { ok: res.ok, price: res.price, gold: c.gold,
               gone: !c.inventory.some(i => i.itemId === item.itemId) };
    });
    if (!r.ok) throw new Error('it would not buy');
    if (r.gold !== r.price) throw new Error('paid ' + r.gold + ' for a ' + r.price + ' sale');
    if (!r.gone) throw new Error('it is still in the pack');
    return r.price + ' gold';
  });

  await step('a shop of the wrong kind sells the right sort of thing', async () => {
    const r = await g.evaluate((t) => {
      const a = SS.Buildings.blank('apothecary', SS.Loc.last.latitude, SS.Loc.last.longitude);
      a.buildingId = 'bld_apoth'; a.level = 4;
      SS.Buildings.save(a);
      const types = SS.Buildings.stockOf(SS.Buildings.get('bld_apoth'), t).map(s => s.item.type);
      SS.Buildings.remove('bld_apoth');
      return types;
    }, NOON);
    if (r.some(t => t !== 'potion')) throw new Error('an apothecary was selling ' + r.join(', '));
    return r.length + ' draughts and nothing else';
  });

  /* ======================================================= REST AND MEND == */
  console.log('\n===== REST, AND THE SMITH =====');

  await step('a rest costs gold and gives back a share of each pool', async () => {
    const r = await g.evaluate((t) => {
      const c = SS.Game.ch;
      c.gold = 500;
      c.stats.hp = 1; c.stats.mana = 0; c.stats.stamina = 0;
      const b = SS.Buildings.get('bld_test');
      const res = SS.Buildings.rest(b, c, t);
      return { ok: res.ok, why: res.why, cost: res.cost, gold: c.gold,
               hp: c.stats.hp, maxHp: c.stats.maxHp,
               want: Math.round(c.stats.maxHp * SS.Buildings.restFraction(b)) };
    }, NOON);
    if (!r.ok) throw new Error(r.why);
    if (r.gold !== 500 - r.cost) throw new Error('the bill was not taken');
    if (Math.abs(r.hp - (1 + r.want)) > 1) throw new Error('got ' + r.hp + ' HP, expected about ' + (1 + r.want));
    return '+' + (r.hp - 1) + ' HP of ' + r.maxHp + ' for ' + r.cost + ' gold';
  });

  await step('a full character is not charged for a bed', async () => {
    const r = await g.evaluate((t) => {
      const c = SS.Game.ch;
      c.gold = 500;
      c.stats.hp = c.stats.maxHp; c.stats.mana = c.stats.maxMana; c.stats.stamina = c.stats.maxStamina;
      const res = SS.Buildings.rest(SS.Buildings.get('bld_test'), c, t);
      return { ok: res.ok, why: res.why, gold: c.gold };
    }, NOON);
    if (r.ok) throw new Error('it charged for nothing');
    if (r.gold !== 500) throw new Error('it took the money anyway');
    return r.why;
  });

  await step('a smith takes a piece one level further', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      c.gold = 5000;
      const it = SS.Items.generate(4, 10, 3, 'mainhand');
      c.inventory.push(it);
      const b = SS.Buildings.get('bld_test');
      const before = { level: it.level, dmg: it.stats.damage, price: it.price };
      const res = SS.Buildings.improve(b, it, c);
      return { ok: res.ok, why: res.why, cost: res.cost, before,
               after: { level: it.level, dmg: it.stats.damage, price: it.price },
               gold: c.gold, improved: it.improved, effect: it.effect };
    });
    if (!r.ok) throw new Error(r.why);
    if (r.after.level !== r.before.level + 1) throw new Error('level went ' + r.before.level + ' → ' + r.after.level);
    if (!(r.after.dmg > r.before.dmg)) throw new Error('damage did not move: ' + r.before.dmg + ' → ' + r.after.dmg);
    if (!/DMG/.test(r.effect)) throw new Error('the description was not rewritten');
    return 'level ' + r.before.level + ' → ' + r.after.level + ', ' +
           r.before.dmg + ' → ' + r.after.dmg + ' DMG for ' + r.cost + ' gold';
  });

  await step('their own level is the ceiling, and the refusal says so', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      c.gold = 99999;
      const b = SS.Buildings.get('bld_test');       // level 3 → item level 9
      const it = SS.Items.generate(20, 10, 3, 'mainhand');
      const gate = SS.Buildings.canImprove(b, it);
      const res = SS.Buildings.improve(b, it, c);
      return { cap: SS.Buildings.improveCap(b), why: gate.why, ok: res.ok,
               gold: c.gold, level: it.level };
    });
    if (r.ok) throw new Error('a level 3 smith reforged a level 20 weapon');
    if (r.level !== 20) throw new Error('it was changed anyway');
    if (r.gold !== 99999) throw new Error('it charged for the refusal');
    if (!new RegExp('item level ' + r.cap).test(r.why)) throw new Error('the refusal was "' + r.why + '"');
    return r.why;
  });

  await step('a potion is not a piece of gear', async () => {
    const why = await g.evaluate(() => {
      const p = SS.Items.generate(3, 10, 1, 'potion');
      return SS.Buildings.canImprove(SS.Buildings.get('bld_test'), p).why;
    });
    if (!/not a piece of gear/.test(why)) throw new Error('the refusal was "' + why + '"');
    return why;
  });

  /* ================================================= MEETING THEM ========= */
  console.log('\n===== CATCHING UP WITH THEM =====');

  await step('the trade buttons only appear once you are close enough', async () => {
    const r = await g.evaluate(() => {
      const b = SS.Buildings.get('bld_test');
      const d = SS.Buildings.residentOf(b);
      return {
        near: SS.Game.tradeButtons(d, true).map(x => x.label),
        far: SS.Game.tradeButtons(d, false).map(x => x.label)
      };
    });
    if (r.far.length) throw new Error('you could trade from across the street');
    if (r.near.length !== 3) throw new Error('got ' + JSON.stringify(r.near));
    return r.near.join(' · ');
  });

  await step('a wanderer with no building has nothing to sell', async () => {
    const n = await g.evaluate(() =>
      SS.Game.tradeButtons({ name: 'Somebody', buildingId: '', trades: [] }, true).length);
    if (n) throw new Error(n + ' trade buttons on a stranger');
    return 'none, as it should be';
  });

  await step('meeting the resident opens the shop, and buying from it persists', async () => {
    const r = await g.evaluate(async () => {
      const c = SS.Game.ch;
      c.gold = 5000;
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      const b = SS.Buildings.get('bld_test');
      const d = SS.Buildings.residentOf(b);
      SS.Game.openShop(d, b);
      const buy = document.querySelector('#shopBuy .item .acts button:not([disabled])');
      if (!buy) return { err: 'no buy button' };
      const before = (c.inventory || []).length;
      buy.click();
      const saved = (SS.Store.get(SS.K.inventories, {}) || {})[c.characterId] || [];
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return { before, after: (c.inventory || []).length, saved: saved.length };
    });
    if (r.err) throw new Error(r.err);
    if (r.after !== r.before + 1) throw new Error('the pack did not grow');
    if (r.saved !== r.after) throw new Error('the pack was not written down (' + r.saved + ' vs ' + r.after + ')');
    return 'bought through the panel, ' + r.saved + ' rows saved';
  });

  await step('the building is in the list of things around you', async () => {
    const r = await g.evaluate(() => {
      const list = SS.Game.interactables().filter(x => x.kind === 'building');
      // By name: the sample buildings are rehomed next to you as well, and
      // the list is sorted by distance rather than by who put them there.
      const mine = list.find(x => x.name === 'Ash & Ember');
      return { n: list.length, mine: mine && { name: mine.name, note: mine.note },
               names: list.map(x => x.name) };
    });
    if (!r.mine) throw new Error('mine is not in the list: ' + r.names.join(', '));
    if (!/level 3/.test(r.mine.note)) throw new Error('the row says "' + r.mine.note + '"');
    return r.n + ' buildings listed, mine reads "' + r.mine.note + '"';
  });

  await step('a building that is closed puts nobody on the street', async () => {
    const r = await g.evaluate((t) => {
      const b = SS.Buildings.get('bld_test');
      b.active = false; SS.Buildings.save(b);
      const live = SS.Denizens.near(SS.Loc.last.latitude, SS.Loc.last.longitude, 400, t)
        .filter(d => d.buildingId === 'bld_test').length;
      const resident = SS.Buildings.residentOf(b, t);
      b.active = true; SS.Buildings.save(b);
      return { live, resident: !!resident };
    }, NOON);
    if (r.resident) throw new Error('a closed building still has somebody in it');
    if (r.live) throw new Error(r.live + ' residents outside a closed building');
    return 'shuttered';
  });

  /* ================================================== THE FILE ============ */
  console.log('\n===== THE FILE =====');

  await step('export and import come back the same building', async () => {
    const r = await g.evaluate(() => {
      const doc = SS.Buildings.export();
      const mine = SS.Buildings.get('bld_test');
      SS.Buildings.clear();
      const res = SS.Buildings.import(doc, false);
      const back = SS.Buildings.get('bld_test');
      return { added: res.added, ok: !!back,
               same: back && back.name === mine.name && back.kind === mine.kind &&
                     SS.Buildings.levelOf(back) === SS.Buildings.levelOf(mine) &&
                     Math.abs(back.latitude - mine.latitude) < 1e-9,
               trades: back && back.trades.join(',') };
    });
    if (!r.ok) throw new Error('it did not come back');
    if (!r.same) throw new Error('it came back different');
    return r.added + ' back, dealing in ' + r.trades;
  });

  await step('importing the same file twice does not lay a second town on the first', async () => {
    const r = await g.evaluate(() => {
      const doc = SS.Buildings.export();
      const before = SS.Buildings.all().length;
      const a = SS.Buildings.import(doc, false);
      const mid = SS.Buildings.all().length;
      const b = SS.Buildings.import(doc, false);
      return { before, mid, after: SS.Buildings.all().length, a, b };
    });
    if (r.mid !== r.before || r.after !== r.before) {
      throw new Error(r.before + ' → ' + r.mid + ' → ' + r.after);
    }
    return r.before + ' buildings, twice imported, still ' + r.after;
  });

  await step('nothing threw along the way', async () => {
    if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
    return 'clean console';
  });

  await ctx.close();

  /* ============================================ DROPPING THE REAL FILE IN = */
  console.log('\n===== A GOOGLE EARTH FILE, DROPPED IN =====');

  const BLD_FILE = path.resolve(__dirname, 'fixtures-google-earth-buildings.kml');
  const { ctx: rctx, page: r } = await newPage(browser);
  const rErrors = [];
  r.on('pageerror', ev => rErrors.push(ev.message));
  await r.goto(BASE + '/regions.html');
  await r.waitForSelector('#reFile', { timeout: 10000 });

  await step('one file fills both tables', async () => {
    await r.evaluate(() => { RE.Regions.clear(); RE.Buildings.clear(); });
    await r.click('#reFile');
    await r.waitForTimeout(250);
    await r.setInputFiles('#reUp', BLD_FILE);
    await r.waitForTimeout(1200);
    const out = await r.evaluate(() => ({
      regions: RE.Regions.all().map(x => x.name),
      buildings: RE.Buildings.all().map(b => b.name + '/' + b.kind + '/L' + b.level),
      traced: RE.Buildings.all().filter(b => RE.Buildings.ring(b)).length,
      toast: (() => { const t = document.querySelectorAll('#toasts .toast');
                      return t.length ? t[t.length - 1].textContent : ''; })()
    }));
    if (out.buildings.length !== 3) throw new Error(out.buildings.length + ' buildings: ' + out.buildings.join(', '));
    if (out.regions.length !== 1) throw new Error(out.regions.length + ' regions: ' + out.regions.join(', '));
    if (out.traced !== 1) throw new Error(out.traced + ' traced outlines, expected 1');
    if (!/building/.test(out.toast)) throw new Error('the toast did not mention the buildings: ' + out.toast);
    if (!/pin skipped/.test(out.toast)) throw new Error('it did not report the parked car: ' + out.toast);
    return out.buildings.join(', ') + ' · ' + out.regions[0];
  });

  await step('dropping it again updates rather than duplicates', async () => {
    const before = await r.evaluate(() => RE.Buildings.all().length);
    await r.click('#reFile');
    await r.waitForTimeout(250);
    await r.setInputFiles('#reUp', BLD_FILE);
    await r.waitForTimeout(1200);
    const after = await r.evaluate(() => RE.Buildings.all().length);
    if (after !== before) throw new Error(before + ' → ' + after);
    if (rErrors.length) throw new Error(rErrors.slice(0, 2).join(' | '));
    return before + ' buildings, still ' + after;
  });

  await rctx.close();

  /* ==================================================== THE EDITOR ======== */
  console.log('\n===== PLACING ONE BY HAND =====');

  const { ctx: ectx, page: e } = await newPage(browser);
  const eErrors = [];
  e.on('pageerror', ev => eErrors.push(ev.message));
  await e.goto(EDITOR_URL);
  await e.waitForSelector('.meTableBar', { timeout: 10000 });

  await step('the editor has a Buildings layer', async () => {
    const tabs = await e.$$eval('.layerSwitch button', bs => bs.map(b => b.textContent.trim()));
    if (!tabs.some(t => /Buildings/.test(t))) throw new Error('tabs are ' + tabs.join(' / '));
    return tabs.join(' · ');
  });

  await step('placing one needs no zone, and it lands where you clicked', async () => {
    await e.click('.layerSwitch button[data-mode="buildings"]');
    const r = await e.evaluate(() => {
      const n = ME.Buildings.all().length;
      ME.Me.mode = 'buildings';
      ME.Me.placeAt(41.8840, -87.6240);
      const all = ME.Buildings.all();
      const made = all[all.length - 1];
      return { grew: all.length - n, lat: made.latitude, lng: made.longitude,
               zoneless: made.zoneId === undefined, id: made.buildingId };
    });
    if (r.grew !== 1) throw new Error('the table grew by ' + r.grew);
    if (Math.abs(r.lat - 41.8840) > 1e-6) throw new Error('it landed at ' + r.lat);
    if (!r.zoneless) throw new Error('a building was given a zone');
    return 'placed at ' + r.lat.toFixed(4) + ', ' + r.lng.toFixed(4);
  });

  await step('the form saves a kind, a level and a trade', async () => {
    const r = await e.evaluate(() => {
      const all = ME.Buildings.all();
      const made = all[all.length - 1];
      ME.Mb.select(made.buildingId);
      const setField = (id, v) => {
        const n = document.getElementById(id);
        n.value = v;
        n.dispatchEvent(new Event(n.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      };
      setField('f_name', 'The Crooked Nail');
      setField('f_kind', 'tavern');
      setField('f_level', '6');
      ME.Mb.save();
      const back = ME.Buildings.get(made.buildingId);
      return { name: back.name, kind: back.kind, level: back.level,
               trades: ME.Buildings.tradesOf(back).join(',') };
    });
    if (r.name !== 'The Crooked Nail') throw new Error('the name came back "' + r.name + '"');
    if (r.kind !== 'tavern' || r.level !== 6) throw new Error(JSON.stringify(r));
    if (!/rest/.test(r.trades)) throw new Error('a tavern that does not let you rest: ' + r.trades);
    return r.name + ', a level ' + r.level + ' tavern that will ' + r.trades;
  });

  await step('tracing an outline moves the pin onto its middle', async () => {
    const r = await e.evaluate(() => {
      const all = ME.Buildings.all();
      const made = all[all.length - 1];
      ME.Mb.select(made.buildingId);
      ME.Mb.startTrace();
      [[41.8850, -87.6250], [41.8850, -87.6248], [41.8848, -87.6248], [41.8848, -87.6250]]
        .forEach(p => ME.Mb.traceAt(p[0], p[1]));
      ME.Mb.finishTrace(true);
      ME.Mb.save();
      const back = ME.Buildings.get(made.buildingId);
      return { corners: (back.footprint || []).length, lat: back.latitude,
               size: ME.Buildings.sizeM(back), tracing: !!ME.Mb.tracing };
    });
    if (r.corners !== 4) throw new Error(r.corners + ' corners');
    if (Math.abs(r.lat - 41.8849) > 0.0002) throw new Error('the pin sits at ' + r.lat);
    if (r.tracing) throw new Error('the trace tool stayed armed');
    return r.corners + ' corners, ' + r.size + ' m across';
  });

  await step('the other three layers still work', async () => {
    for (const m of ['locations', 'dungeons', 'instances', 'buildings']) {
      await e.click('.layerSwitch button[data-mode="' + m + '"]');
      const on = await e.evaluate(() => ME.Me.mode);
      if (on !== m) throw new Error('the switch would not go to ' + m);
    }
    if (eErrors.length) throw new Error(eErrors.slice(0, 2).join(' | '));
    return 'four layers, no errors';
  });

  await ectx.close();
  await browser.close();

  console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' OK, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();
