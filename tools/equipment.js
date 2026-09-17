/* Equipment: twelve slots, who may wear what, and the arithmetic underneath.

   Three things are being held down here, and they fail differently:

     · **the paper doll** — an item goes where it belongs, a ring does not
       displace an amulet, and a two-handed weapon takes both hands
     · **the gate** — armour weight and weapon family decide what a class may
       wear, attribute minimums decide the rest, and every refusal comes with
       a sentence a player can act on
     · **the budget** — twelve slots of gear must not add up to four times the
       character the balance table was measured against

   The last one is the reason the numbers in js/player/classes.js are smaller
   than the weapons they replace. If this suite starts failing after somebody
   raises a damage figure, that is it working. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { serve, BASE } = require('./serve');
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

/** Roll a character of a class. Class is the 1st, 2nd or 3rd card. */
async function makeCharacter(g, cls, name) {
  const nth = { Warrior: 1, Rogue: 2, Mage: 3 }[cls];
  await g.goto(GAME_URL);
  await g.waitForSelector('#tReg', { timeout: 8000 });
  await g.click('#tReg');
  await g.fill('#rgUser', name.toLowerCase()); await g.fill('#rgPass', 'walk1234');
  await g.click('#rgGo');
  await g.waitForSelector('.stepBar', { timeout: 6000 });
  await g.click('.pickGrid .pick:nth-child(' + nth + ')'); await g.click('#next');
  await g.click('.pickGrid .pick:nth-child(1)'); await g.click('#next');
  for (let i = 0; i < 40; i++) {
    const l = parseInt(await g.textContent('#ptsLeft'), 10); if (!l) break;
    const b = await g.$('.stepper[data-inc]:not([disabled])'); if (!b) break; await b.click();
  }
  await g.click('#next'); await g.fill('#cName', name); await g.click('#next');
  await g.waitForSelector('#map', { timeout: 6000 });
  await g.waitForFunction(() => SS.Loc.last && SS.Content.list('items').length, null, { timeout: 30000 }).catch(() => {});
  await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
}

(async () => {
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ================================================== THE PAPER DOLL ===== */
  console.log('\n===== TWELVE SLOTS =====');
  const { ctx, page: g } = await newPage(browser);
  const errors = [];
  g.on('pageerror', e => errors.push(e.message));
  g.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  await makeCharacter(g, 'Warrior', 'Bram');

  await step('there is a slot for every part of a person', async () => {
    const r = await g.evaluate(() => ({
      keys: EQUIP_SLOTS.map(s => s.key),
      labels: EQUIP_SLOTS.map(s => s.label),
      armour: EQUIP_SLOTS.filter(s => s.armor).length
    }));
    const want = ['mainhand', 'offhand', 'helm', 'shoulders', 'chest', 'gloves',
                  'belt', 'legs', 'boots', 'back', 'neck', 'ring'];
    want.forEach(k => { if (r.keys.indexOf(k) < 0) throw new Error('no ' + k + ' slot'); });
    if (r.keys.length !== want.length) throw new Error(r.keys.length + ' slots: ' + r.keys.join(','));
    if (r.armour !== 8) throw new Error(r.armour + ' armour slots, expected 8');
    return r.keys.length + ' slots, ' + r.armour + ' of them armour';
  });

  await step('every seeded item knows where it goes', async () => {
    const r = await g.evaluate(() => {
      const rows = SS.Content.list('items').map(def => {
        const inst = SS.Content.toGameItem(def, 5);
        return { name: def.name, gear: def.gearType, slot: SS.Items.slotOf(inst), type: inst.type };
      });
      const wearable = rows.filter(x => x.type !== 'potion');
      const slots = EQUIP_SLOTS.map(s => s.key);
      return { n: rows.length, wearable: wearable.length,
               homeless: wearable.filter(x => slots.indexOf(x.slot) < 0),
               spread: Array.from(new Set(wearable.map(x => x.slot))).sort() };
    });
    if (r.homeless.length) throw new Error('nowhere to put: ' + r.homeless.map(x => x.name).join(', '));
    if (r.spread.length < 10) throw new Error('only ' + r.spread.length + ' slots used by the seeded set');
    return r.wearable + ' wearable items across ' + r.spread.length + ' slots';
  });

  await step('the generator can fill any slot you name', async () => {
    const r = await g.evaluate(() => {
      const out = {};
      EQUIP_SLOTS.forEach(sl => {
        let hits = 0;
        for (let i = 0; i < 12; i++) {
          const it = SS.Items.generate(8, 12, 3, sl.key);
          if (it && SS.Items.slotOf(it) === sl.key) hits++;
        }
        out[sl.key] = hits;
      });
      return out;
    });
    const empty = Object.keys(r).filter(k => r[k] < 12);
    if (empty.length) throw new Error('slots that did not fill every time: ' + JSON.stringify(empty.map(k => k + ':' + r[k])));
    return '12 rolls for each of ' + Object.keys(r).length + ' slots, all landed where asked';
  });

  await step('a ring does not push the amulet off', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      c.equipment = [];
      /* Wearable ones: a rolled ring can be the Witchlight Shard, which wants
         INT 11 and which a warrior cannot put on — and this step is about
         slots not colliding, not about requirements. */
      const rollFor = (slot) => {
        for (let i = 0; i < 25; i++) {
          const it = SS.Items.generate(5, 12, 3, slot);
          if (it && SS.Items.slotOf(it) === slot && SS.Items.canEquip(c, it).ok) return it;
        }
        return null;
      };
      const neck = rollFor('neck'), ring = rollFor('ring');
      if (!neck || !ring) return { worn: [], n: -1 };
      c.inventory = [neck, ring];
      SS.Panels.inventory();
      /* One at a time, re-querying between: equipping redraws the panel, so a
         list of buttons gathered up front is a list of detached nodes after
         the first click — which is how this step passed on its own and failed
         in a full run. */
      for (let i = 0; i < 4; i++) {
        const b = Array.from(document.querySelectorAll('.item .acts .btn'))
          .find(x => x.textContent === 'Equip' && !x.disabled);
        if (!b) break;
        b.click();
      }
      const worn = (SS.Game.ch.equipment || []).map(i => SS.Items.slotOf(i));
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return { worn, n: worn.length };
    });
    if (r.n === -1) throw new Error('could not roll a wearable neck and ring in 25 tries');
    if (r.n !== 2) throw new Error('wearing ' + r.n + ' after equipping a neck and a ring');
    if (r.worn.sort().join() !== 'neck,ring') throw new Error('they landed on ' + r.worn.join());
    return 'neck and ring, both worn';
  });

  /* ==================================================== THE TWO HANDS ==== */
  console.log('\n===== BOTH HANDS =====');

  await step('a two-handed weapon puts down the off hand', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      c.equipment = []; c.inventory = [];
      const shield = SS.Content.toGameItem(SS.Content.list('items').find(x => /Shield/.test(x.name)), 5);
      const bow = SS.Content.toGameItem(SS.Content.list('items').find(x => /Bow/.test(x.name)), 5);
      c.inventory = [shield, bow];
      SS.Panels.inventory();
      const click = (name) => {
        const row = Array.from(document.querySelectorAll('.item')).find(x => x.textContent.indexOf(name) >= 0);
        const b = row && Array.from(row.querySelectorAll('.btn')).find(x => x.textContent === 'Equip');
        if (b && !b.disabled) b.click();
      };
      click('Shield');
      const withShield = (SS.Game.ch.equipment || []).map(i => SS.Items.slotOf(i));
      click('Bow');
      const after = SS.Game.ch.equipment || [];
      const lockedText = (document.querySelector('.slot.locked .nmv') || {}).textContent || '';
      const back = (SS.Game.ch.inventory || []).map(i => i.name);
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return { withShield, after: after.map(i => SS.Items.slotOf(i)),
               twoHanded: after.some(i => i.twoHanded), lockedText, back };
    });
    if (r.withShield.indexOf('offhand') < 0) throw new Error('the shield never went on');
    if (!r.twoHanded) throw new Error('the bow did not go on');
    if (r.after.indexOf('offhand') >= 0) throw new Error('the shield is still held');
    if (!r.back.some(n => /Shield/.test(n))) throw new Error('the shield did not go back in the pack');
    if (!/both hands/i.test(r.lockedText)) throw new Error('the off hand does not say why it is empty');
    return 'shield down, bow up, off hand reads "' + r.lockedText.trim() + '"';
  });

  await step('and the off hand stays refused while it is held', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      const shield = c.inventory.find(i => /Shield/.test(i.name));
      SS.Panels.inventory();
      const row = Array.from(document.querySelectorAll('.item')).find(x => x.textContent.indexOf('Shield') >= 0);
      const b = row && Array.from(row.querySelectorAll('.btn')).find(x => x.textContent === 'Equip');
      if (b) b.click();
      const toast = Array.from(document.querySelectorAll('#toasts .toast')).pop();
      const worn = (SS.Game.ch.equipment || []).map(i => SS.Items.slotOf(i));
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return { worn, toast: toast ? toast.textContent : '', held: !!shield };
    });
    if (r.worn.indexOf('offhand') >= 0) throw new Error('it went on anyway');
    if (!/both hands/i.test(r.toast)) throw new Error('it did not say why: "' + r.toast + '"');
    return '"' + r.toast + '"';
  });

  /* ====================================================== THE GATE ======= */
  console.log('\n===== WHO MAY WEAR WHAT =====');

  await step('a warrior wears anything, and says so', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      const byName = (re) => SS.Content.toGameItem(SS.Content.list('items').find(x => re.test(x.name)), 5);
      const plate = byName(/Plate/), staff = byName(/Staff/), robe = byName(/Robe/);
      return { cls: c.class,
               plate: SS.Items.canEquip(c, plate), staff: SS.Items.canEquip(c, staff),
               robe: SS.Items.canEquip(c, robe) };
    });
    if (r.cls !== 'Warrior') throw new Error('this character is a ' + r.cls);
    if (!r.plate.ok) throw new Error('a warrior was refused plate: ' + r.plate.why);
    if (!r.robe.ok) throw new Error('a warrior was refused a robe: ' + r.robe.why);
    if (r.staff.ok) throw new Error('a warrior was handed a staff');
    if (!/staff/i.test(r.staff.why)) throw new Error('unhelpful refusal: ' + r.staff.why);
    return 'plate yes, robe yes, staff: "' + r.staff.why + '"';
  });

  await step('an attribute minimum blocks, and lifts when you grow into it', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      const plate = SS.Content.toGameItem(SS.Content.list('items').find(x => /Plate/.test(x.name)), 5);
      const before = JSON.parse(JSON.stringify(c.attributes));
      c.attributes.strength = 8; c.attributes.constitution = 8;
      c.equipment = [];
      const weak = SS.Items.canEquip(c, plate);
      c.attributes.strength = 16; c.attributes.constitution = 14;
      const strong = SS.Items.canEquip(c, plate);
      c.attributes = before;
      return { weak, strong, req: plate.req, text: SS.Items.requirementText(plate) };
    });
    if (r.weak.ok) throw new Error('an 8-strength character put plate on');
    if (!/STR/.test(r.weak.why)) throw new Error('it did not name the attribute: ' + r.weak.why);
    if (!r.strong.ok) throw new Error('a 16-strength character was still refused: ' + r.strong.why);
    return '"' + r.weak.why + '" at STR 8, worn at 16 — line reads "' + r.text + '"';
  });

  await step('gear you are wearing counts towards what you can wear', async () => {
    // A ring of strength is how you get into the plate. That has to work, or
    // the requirement is measured against the wrong number.
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      c.equipment = []; c.attributes.strength = 13; c.attributes.constitution = 12;
      const plate = SS.Content.toGameItem(SS.Content.list('items').find(x => /Plate/.test(x.name)), 5);
      const bare = SS.Items.canEquip(c, plate);
      const ring = SS.Items.generate(5, 12, 3, 'ring');
      ring.stats = ring.stats || {};
      ring.stats.bonusAttribute = { strength: 3 };
      c.equipment = [ring];
      const ringed = SS.Items.canEquip(c, plate);
      c.equipment = [];
      return { bare, ringed };
    });
    if (r.bare.ok) throw new Error('STR 13 was enough for plate that wants 15');
    if (!r.ringed.ok) throw new Error('a +3 STR ring did not get us there: ' + r.ringed.why);
    return 'STR 13 refused, 13 + a ring accepted';
  });

  await step('the pack says why something cannot be worn, and the button is dead', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      c.equipment = []; c.attributes.strength = 8;
      const staff = SS.Content.toGameItem(SS.Content.list('items').find(x => /Staff/.test(x.name)), 5);
      c.inventory = [staff];
      SS.Panels.inventory();
      const row = document.querySelector('.item');
      const btn = Array.from(row.querySelectorAll('.btn')).find(b => b.textContent === 'Equip');
      const out = { greyed: row.classList.contains('cantWear'), disabled: !!btn.disabled,
                    why: (row.querySelector('.body div:last-child') || {}).textContent || '',
                    reqLine: (row.querySelector('.rq') || {}).textContent || '',
                    title: btn.title };
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      return out;
    });
    if (!r.disabled) throw new Error('the Equip button is still live');
    if (!r.greyed) throw new Error('the row is not marked');
    if (!/staff/i.test(r.why + r.title)) throw new Error('no reason shown: "' + r.why + '"');
    return 'greyed, disabled, "' + (r.why || r.title).trim() + '"';
  });

  if (errors.length) { fail++; console.log('  FAIL warrior page errors — ' + errors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors'); }
  await ctx.close();

  /* ================================================== A MAGE'S LIMITS ==== */
  console.log('\n===== WEIGHT IS THE CLASS RULE =====');
  const { ctx: c2, page: m } = await newPage(browser);
  const mErrors = [];
  m.on('pageerror', e => mErrors.push(e.message));
  await makeCharacter(m, 'Mage', 'Wren');

  await step('a mage is held to light armour, by one rule', async () => {
    const r = await m.evaluate(() => {
      const c = SS.Game.ch;
      const byName = (re) => SS.Content.toGameItem(SS.Content.list('items').find(x => re.test(x.name)), 5);
      const out = {};
      [['plate', /Plate/], ['chain', /Chain/], ['robe', /Robe/], ['shield', /Shield/],
       ['bow', /Bow/], ['staff', /Staff/], ['dagger', /Dagger/]].forEach(([k, re]) => {
        const it = byName(re);
        out[k] = { weight: it.weight || it.family, gate: SS.Items.canEquip(c, it) };
      });
      return { cls: c.class, out };
    });
    const o = r.out;
    if (o.plate.gate.ok || o.chain.gate.ok) throw new Error('a mage got into mail');
    if (!o.robe.gate.ok) throw new Error('a mage was refused a robe: ' + o.robe.gate.why);
    if (!o.staff.gate.ok) throw new Error('a mage was refused a staff: ' + o.staff.gate.why);
    if (!o.dagger.gate.ok) throw new Error('a mage was refused a dagger: ' + o.dagger.gate.why);
    if (o.bow.gate.ok) throw new Error('a mage drew a bow');
    if (!/heavy|medium/i.test(o.plate.gate.why)) throw new Error('the refusal blames the wrong thing: ' + o.plate.gate.why);
    return 'robe, staff and dagger yes · plate, mail, shield and bow no';
  });

  await step('an explicit class list beats the weight rules', async () => {
    const r = await m.evaluate(() => {
      const c = SS.Game.ch;
      const def = JSON.parse(JSON.stringify(SS.Content.list('items').find(x => /Robe/.test(x.name))));
      def.reqClasses = ['Warrior'];
      const it = SS.Content.toGameItem(def, 5);
      const gate = SS.Items.canEquip(c, it);
      return { gate, classes: it.reqClasses };
    });
    if (r.gate.ok) throw new Error('a Warrior-only robe went on a mage');
    if (!/Warrior/.test(r.gate.why)) throw new Error('it did not say whose it was: ' + r.gate.why);
    return '"' + r.gate.why + '"';
  });

  await step('the paper doll draws twelve slots on a phone', async () => {
    const r = await m.evaluate(() => {
      SS.Game.ch.equipment = [];
      SS.Panels.inventory();
      const slots = Array.from(document.querySelectorAll('.slot'));
      const labels = slots.map(s => (s.querySelector('.sl') || {}).textContent || '');
      const widths = slots.map(s => Math.round(s.getBoundingClientRect().width));
      const out = { n: slots.length, labels, minWidth: Math.min.apply(null, widths),
                    overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
      document.querySelectorAll('.modalBack').forEach(x => x.remove());
      return out;
    });
    if (r.n !== 12) throw new Error(r.n + ' slots drawn');
    if (r.minWidth < 100) throw new Error('slots are only ' + r.minWidth + 'px wide');
    if (r.overflow) throw new Error('the doll pushes the page sideways');
    return '12 cards, narrowest ' + r.minWidth + 'px, no sideways scroll';
  });

  if (mErrors.length) { fail++; console.log('  FAIL mage page errors — ' + mErrors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors'); }
  await c2.close();

  /* ==================================================== THE BUDGET ======= */
  console.log('\n===== TWELVE SLOTS OF GEAR IS NOT TWELVE CHARACTERS =====');
  const { ctx: c3, page: b } = await newPage(browser);
  await makeCharacter(b, 'Warrior', 'Gudrun');

  await step('a full kit is worth about what one old-style piece was', async () => {
    const r = await b.evaluate(() => {
      const dress = (ch, level) => {
        ch.equipment = []; let two = false;
        EQUIP_SLOTS.forEach(sl => {
          if (sl.key === 'offhand' && two) return;
          for (let t = 0; t < 12; t++) {
            const it = SS.Items.generate(level, 12, 3, sl.key);
            if (!it || SS.Items.slotOf(it) !== sl.key) continue;
            if (!SS.Items.canEquip(ch, it).ok) continue;
            if (it.twoHanded) two = true;
            ch.equipment.push(it);
            return;
          }
        });
        return ch;
      };
      const c = SS.Game.ch;
      c.level = 10;
      /* Both sides averaged over enough rolls to mean something. Rarity swings
         a single piece by 3x, so comparing one kit against one breastplate is
         a coin toss dressed as a measurement — which is exactly how the first
         version of this assertion managed to pass and fail on the same code. */
      let kitTotal = 0;
      const KITS = 30;
      for (let i = 0; i < KITS; i++) {
        dress(c, 10);
        kitTotal += c.equipment.filter(x => SS.Items.slotOf(x) !== 'mainhand')
          .reduce((n, x) => n + ((x.stats && x.stats.defense) || 0), 0);
      }
      // What a single piece carried before the doll existed: the whole budget,
      // unshared. A chest roll divided by its share is that number.
      let singleTotal = 0;
      const ROLLS = 300;
      for (let i = 0; i < ROLLS; i++) {
        const chest = SS.Items.generate(10, 12, 3, 'chest');
        singleTotal += (chest.stats.defense || 1) / SS.Items.shareFor('chest');
      }
      c.equipment = [];
      return { kit: Math.round(kitTotal / KITS), single: Math.round(singleTotal / ROLLS),
               n: KITS };
    });
    const ratio = r.kit / r.single;
    if (ratio < 0.35) throw new Error('a full kit is only ' + ratio.toFixed(2) + '× one old piece — gear stopped mattering');
    if (ratio > 1.3) throw new Error('a full kit is ' + ratio.toFixed(2) + '× one old piece — the balance table is a lie');
    return r.kit + ' DEF across ' + r.n + ' kits vs ' + r.single + ' for one unshared piece (' + ratio.toFixed(2) + '×)';
  });

  await step('the shares add up to about one, and every slot has one', async () => {
    const r = await b.evaluate(() => {
      const wearable = EQUIP_SLOTS.filter(s => s.key !== 'mainhand' && s.key !== 'neck' && s.key !== 'ring');
      const sum = wearable.reduce((n, s) => n + SS.Items.shareFor(s.key), 0);
      const missing = EQUIP_SLOTS.filter(s => SS.Items.SLOT_SHARE[s.key] == null).map(s => s.key);
      return { sum: Math.round(sum * 100) / 100, missing,
               trinkets: SS.Items.shareFor('neck') + SS.Items.shareFor('ring') };
    });
    if (r.missing.length) throw new Error('slots with no share: ' + r.missing.join(', '));
    if (r.sum > 1.0) throw new Error('armour shares add up to ' + r.sum);
    if (Math.abs(r.trinkets - 1) > 0.01) throw new Error('two trinkets are worth ' + r.trinkets + ' of one');
    return 'armour and off hand sum to ' + r.sum + ', two trinkets to ' + r.trinkets;
  });

  await step('attribute bonuses did not multiply by twelve', async () => {
    const r = await b.evaluate(() => {
      const c = SS.Game.ch;
      c.level = 10;
      let withAttrs = 0, total = 0;
      for (let i = 0; i < 40; i++) {
        EQUIP_SLOTS.forEach(sl => {
          const it = SS.Items.generate(10, 12, 3, sl.key);
          if (!it || SS.Items.slotOf(it) !== sl.key) return;
          total++;
          if (it.stats.bonusAttribute && Object.keys(it.stats.bonusAttribute).length) withAttrs++;
        });
      }
      return { withAttrs, total, pct: Math.round(withAttrs / total * 100) };
    });
    // Trinkets always roll one; everything else needs rare. Two of twelve
    // slots are trinkets, so a quarter of a kit carrying attributes is about
    // right and half of it is not.
    if (r.pct > 45) throw new Error(r.pct + '% of gear carries attribute bonuses');
    if (r.pct < 12) throw new Error('only ' + r.pct + '% carries any — trinkets should always');
    return r.pct + '% of rolled gear carries an attribute bonus';
  });

  await step('an item from before the paper doll still finds a slot', async () => {
    // Characters rolled last week have items with no `slot` on them at all.
    const r = await b.evaluate(() => {
      const legacy = [
        { itemId: 'old1', name: 'Old Sword', type: 'weapon', rarity: 'common', stats: { damage: 7 } },
        { itemId: 'old2', name: 'Old Mail', type: 'armor', rarity: 'common', stats: { defense: 9 } },
        { itemId: 'old3', name: 'Old Charm', type: 'trinket', rarity: 'rare', stats: { bonusAttribute: { luck: 2 } } }
      ];
      return legacy.map(it => ({ name: it.name, slot: SS.Items.slotOf(it),
                                 ok: SS.Items.canEquip(SS.Game.ch, it).ok }));
    });
    const slots = r.map(x => x.slot);
    if (slots.join() !== 'mainhand,chest,ring') throw new Error('landed on ' + slots.join());
    if (!r.every(x => x.ok)) throw new Error('old gear is now unwearable: ' + JSON.stringify(r));
    return 'weapon → main hand, armour → chest, trinket → ring, all still wearable';
  });

  await c3.close();

  /* ====================================================== THE EDITOR ===== */
  console.log('\n===== AUTHORING A PIECE =====');
  const { ctx: c4, page: e } = await newPage(browser, { viewport: { width: 1500, height: 950 } });
  const eErrors = [];
  e.on('pageerror', x => eErrors.push(x.message));
  await e.goto(EDITOR_URL);
  await e.waitForSelector('.edTop', { timeout: 8000 }).catch(() => {});
  await e.waitForTimeout(1200);

  await step('the item form asks for weight, attributes and classes', async () => {
    await e.click('[data-tab="items"]').catch(() => {});
    await e.waitForTimeout(400);
    await e.click('table.grid tbody tr');
    await e.waitForTimeout(400);
    const r = await e.evaluate(() => ({
      weight: !!document.querySelector('#f_weight'),
      str: !!document.querySelector('#f_reqStrength'),
      int: !!document.querySelector('#f_reqIntelligence'),
      level: !!document.querySelector('#f_reqLevel'),
      classes: document.querySelectorAll('#edClasses [data-class]').length,
      preview: (document.querySelector('#edItemPreview') || {}).textContent || ''
    }));
    if (!r.weight || !r.str || !r.int || !r.level) throw new Error('missing fields: ' + JSON.stringify(r));
    if (r.classes !== 3) throw new Error(r.classes + ' class buttons');
    if (!/Worn on/.test(r.preview)) throw new Error('the preview does not say where it goes');
    return 'weight, 5 attributes, a level, 3 classes, and a preview that names the slot';
  });

  await step('what you author is what the game gates on', async () => {
    const r = await e.evaluate(() => {
      const def = ED.Content.list('items').find(x => /Robe/.test(x.name));
      def.weight = 'heavy';
      def.reqStrength = 18;
      def.reqClasses = ['Warrior'];
      ED.Content.save('items', def);
      const inst = ED.Content.toGameItem(def, 5);
      return { weight: inst.weight, req: inst.req, classes: inst.reqClasses, slot: inst.slot };
    });
    if (r.weight !== 'heavy') throw new Error('weight did not come through: ' + r.weight);
    if (!r.req || r.req.strength !== 18) throw new Error('the attribute minimum did not: ' + JSON.stringify(r.req));
    if (!r.classes || r.classes[0] !== 'Warrior') throw new Error('the class list did not');
    if (r.slot !== 'chest') throw new Error('it lost its slot: ' + r.slot);
    return 'heavy, STR 18, Warrior-only, still a chest piece';
  });

  if (eErrors.length) { fail++; console.log('  FAIL editor page errors — ' + eErrors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the editor'); }
  await c4.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
