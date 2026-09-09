/* The content editor: CRUD round-trips, rarity scaling, loot maths, and the
   authored content actually reaching the game. */
const { chromium } = require('playwright');
const path = require('path');
const { mockOverpass } = require('./mock-osm');

const EDITOR_URL = 'file://' + path.resolve(__dirname, '../public/editor.html');
const GAME_URL   = 'file://' + path.resolve(__dirname, '../public/index.html');

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

async function newPage(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    geolocation: { latitude: 41.8827, longitude: -87.6233 },
    permissions: ['geolocation']
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());          // confirm() prompts say yes
  await page.route('**cdnjs.cloudflare.com/**', r => r.abort());
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  await page.route('**/api/interpreter', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(mockOverpass(41.8827, -87.6233)) }));
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ================================================================ EDITOR */
  console.log('\n===== EDITOR =====');
  const { ctx, page } = await newPage(browser);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  await page.goto(EDITOR_URL);
  await page.waitForSelector('.edTabs', { timeout: 8000 });

  await step('boots and seeds the three tables on first run', async () => {
    const s = await page.evaluate(() => ED.Content.stats());
    if (s.monsters !== 14) throw new Error('monsters: ' + s.monsters);
    if (s.loot !== 4) throw new Error('loot tables: ' + s.loot);
    if (s.items !== 33) throw new Error('items: ' + s.items);
    const rows = await page.$$('table.grid tbody tr');
    return s.monsters + ' monsters, ' + s.loot + ' tables, ' + s.items + ' items; ' + rows.length + ' rows shown';
  });

  await step('the icon set is complete and renders', async () => {
    const r = await page.evaluate(() => {
      const keys = ED.Content.ICON_KEYS;
      const bad = keys.filter(k => !/^<(path|circle)/.test(ED.Content.ICONS[k]));
      const slotsWithoutIcon = ED.Content.GEAR_SLOTS.filter(s => !ED.Content.ICONS[s.icon]);
      return { n: keys.length, bad, slotsWithoutIcon: slotsWithoutIcon.map(s => s.key) };
    });
    if (r.n < 24) throw new Error('only ' + r.n + ' icons');
    if (r.bad.length) throw new Error('malformed icon markup: ' + r.bad.join(','));
    if (r.slotsWithoutIcon.length) throw new Error('gear slots with no icon: ' + r.slotsWithoutIcon.join(','));
    return r.n + ' icons, every gear slot covered';
  });

  await step('create a monster through the form', async () => {
    await page.click('#edNew');
    await page.fill('#f_name', 'Ledger Wraith');
    await page.fill('#f_icon', '📕');
    await page.selectOption('#f_type', 'undead');
    await page.selectOption('#f_rarity', 'epic');
    await page.fill('#f_levelMin', '5');
    await page.fill('#f_levelMax', '9');
    await page.fill('#f_baseHp', '100');
    await page.fill('#f_armor', '10');
    await page.fill('#f_attackName', 'Overdue Notice');
    await page.fill('#f_attackMin', '20');
    await page.fill('#f_attackMax', '30');
    await page.selectOption('#f_damageType', 'shadow');
    await page.fill('#f_expReward', '500');
    await page.click('#edSave');
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => ED.Content.list('monsters').find(x => x.name === 'Ledger Wraith'));
    if (!m) throw new Error('not saved');
    if (m.baseHp !== 100 || m.attackMax !== 30) throw new Error('fields did not stick');
    if (!m.monsterId) throw new Error('no id assigned');
    return m.monsterId;
  });

  await step('rarity scaling is derived, never baked into the row', async () => {
    const r = await page.evaluate(() => {
      const m = ED.Content.list('monsters').find(x => x.name === 'Ledger Wraith');
      const e = ED.Content.effective(m);
      const s = ED.Content.config().scale.epic;
      return { baseHp: m.baseHp, effHp: e.hp, mult: s.hp,
               baseExp: m.expReward, effExp: e.exp, expMult: s.exp,
               effAtk: [e.atkMin, e.atkMax], dmgMult: s.dmg };
    });
    if (r.effHp !== Math.round(r.baseHp * r.mult)) throw new Error('hp ' + r.baseHp + '×' + r.mult + ' ≠ ' + r.effHp);
    if (r.effExp !== Math.round(r.baseExp * r.expMult)) throw new Error('exp scaling wrong');
    if (r.baseHp !== 100) throw new Error('base was overwritten with the scaled value');
    return '100 hp × ' + r.mult + ' = ' + r.effHp + ', 500 xp × ' + r.expMult + ' = ' + r.effExp +
           ', damage ' + r.effAtk.join('–');
  });

  await step('changing a multiplier restyles every monster of that rarity', async () => {
    const before = await page.evaluate(() =>
      ED.Content.list('monsters').filter(m => m.rarity === 'epic')
        .map(m => ({ base: m.baseHp, eff: ED.Content.effective(m).hp })));
    await page.evaluate(() => {
      const c = ED.Content.config();
      c.scale.epic.hp = 3;
      ED.Content.saveConfig(c);
    });
    const after = await page.evaluate(() =>
      ED.Content.list('monsters').filter(m => m.rarity === 'epic')
        .map(m => ({ base: m.baseHp, eff: ED.Content.effective(m).hp })));
    if (after.some((a, i) => a.base !== before[i].base)) throw new Error('a stored base value changed');
    if (after.some((a, i) => a.eff !== Math.round(a.base * 3))) throw new Error('effective did not follow the multiplier');
    await page.evaluate(() => {
      const c = ED.Content.config();
      c.scale.epic.hp = ED.Content.DEFAULT_SCALE.epic.hp;
      ED.Content.saveConfig(c);
    });
    return before.length + ' epic monsters moved together, bases untouched';
  });

  await step('validation refuses an inverted level range', async () => {
    await page.click('#edNew');
    await page.fill('#f_name', 'Broken');
    await page.fill('#f_levelMin', '9');
    await page.fill('#f_levelMax', '2');
    await page.click('#edSave');
    await page.waitForTimeout(200);
    const err = await page.textContent('#edErr');
    const saved = await page.evaluate(() => ED.Content.list('monsters').some(m => m.name === 'Broken'));
    if (saved) throw new Error('saved anyway');
    if (!/Minimum level/.test(err)) throw new Error('unhelpful message: ' + err);
    return '"' + err.trim() + '"';
  });

  await step('build a loot table with paired item and percentage lists', async () => {
    await page.click('[data-tab="loot"]');
    await page.click('#edNew');
    await page.fill('#f_name', 'Wraith Hoard');
    await page.fill('#f_dropsMin', '1');
    await page.fill('#f_dropsMax', '2');
    for (let i = 0; i < 3; i++) await page.click('#edAddLoot');
    const itemIds = await page.evaluate(() => ED.Content.list('items').slice(0, 3).map(i => i.itemId));
    for (let i = 0; i < 3; i++) {
      await page.selectOption('[data-loot="' + i + '"]', itemIds[i]);
      await page.fill('[data-chance="' + i + '"]', String([100, 42.5, 0][i]));
    }
    await page.click('#edSave');
    await page.waitForTimeout(300);
    const t = await page.evaluate(() => ED.Content.list('loot').find(x => x.name === 'Wraith Hoard'));
    if (!t) throw new Error('not saved');
    if (t.loot.length !== 3 || t.chances.length !== 3) throw new Error('lists out of step');
    if (t.loot[1] !== itemIds[1]) throw new Error('index pairing broken');
    if (t.chances.join(',') !== '100,42.5,0') throw new Error('percentages changed on save: ' + t.chances.join(','));
    return 'chances stored verbatim as ' + t.chances.join(', ');
  });

  await step('percentages are never normalised', async () => {
    const r = await page.evaluate(() => {
      const t = ED.Content.list('loot').find(x => x.name === 'Wraith Hoard');
      t.chances = [80, 80, 80];
      ED.Content.save('loot', t);
      const back = ED.Content.list('loot').find(x => x.name === 'Wraith Hoard');
      return { total: back.chances.reduce((s, c) => s + c, 0), chances: back.chances };
    });
    if (r.total !== 240) throw new Error('total became ' + r.total);
    return '240% total left exactly as typed';
  });

  await step('loot rolls honour the declared percentages', async () => {
    const r = await page.evaluate(() => {
      const t = ED.Content.list('loot').find(x => x.name === 'Wraith Hoard');
      t.chances = [100, 50, 0];
      t.dropsMin = 0; t.dropsMax = 3;
      ED.Content.save('loot', t);
      const N = 4000;
      const hits = [0, 0, 0];
      for (let i = 0; i < N; i++) {
        ED.Content.rollLoot(t.lootTableId, { luck: 0 }).forEach(id => {
          const k = t.loot.indexOf(id);
          if (k >= 0) hits[k]++;
        });
      }
      return { pct: hits.map(h => h / N * 100), t };
    });
    if (r.pct[0] < 99.5) throw new Error('a 100% entry dropped only ' + r.pct[0].toFixed(1) + '% of the time');
    if (Math.abs(r.pct[1] - 50) > 3) throw new Error('a 50% entry landed at ' + r.pct[1].toFixed(1) + '%');
    if (r.pct[2] !== 0) throw new Error('a 0% entry dropped ' + r.pct[2].toFixed(1) + '% of the time');
    return '100/50/0 measured at ' + r.pct.map(p => p.toFixed(1)).join(' / ') + ' over 4000 rolls';
  });

  await step('drop count clamps to min and max', async () => {
    const r = await page.evaluate(() => {
      const t = ED.Content.list('loot').find(x => x.name === 'Wraith Hoard');
      t.chances = [100, 100, 100]; t.dropsMin = 0; t.dropsMax = 2;
      ED.Content.save('loot', t);
      let over = 0, maxSeen = 0;
      for (let i = 0; i < 500; i++) {
        const n = ED.Content.rollLoot(t.lootTableId).length;
        maxSeen = Math.max(maxSeen, n);
        if (n > 2) over++;
      }
      t.chances = [0, 0, 0]; t.dropsMin = 2; t.dropsMax = 3;
      ED.Content.save('loot', t);
      let under = 0, minSeen = 99;
      for (let i = 0; i < 500; i++) {
        const n = ED.Content.rollLoot(t.lootTableId).length;
        minSeen = Math.min(minSeen, n);
        if (n < 2) under++;
      }
      return { over, maxSeen, under, minSeen };
    });
    if (r.over) throw new Error(r.over + ' rolls exceeded dropsMax');
    if (r.under) throw new Error(r.under + ' rolls fell short of dropsMin');
    return 'three certain drops trimmed to ' + r.maxSeen + '; three impossible drops topped up to ' + r.minSeen;
  });

  await step('create an item and map it onto a game slot', async () => {
    await page.click('[data-tab="items"]');
    await page.click('#edNew');
    await page.fill('#f_name', 'Auditor\'s Bulwark');
    await page.selectOption('#f_gearType', 'shield');
    await page.selectOption('#f_rarity', 'legendary');
    await page.fill('#f_armor', '22');
    await page.fill('#f_resistance', '9');
    await page.fill('#f_itemLevel', '12');
    await page.fill('#f_value', '640');
    await page.fill('#f_description', 'Every claim bounces off it.');
    await page.click('[data-icon="shield"]');
    await page.click('#edSave');
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const it = ED.Content.list('items').find(x => x.name === "Auditor's Bulwark");
      const inst = ED.Content.toGameItem(it.itemId, 12);
      return { def: it, type: inst.type, stats: inst.stats, effect: inst.effect, price: inst.price };
    });
    if (r.type !== 'armor') throw new Error('shield mapped to ' + r.type);
    if (r.stats.defense !== 22 || r.stats.resistance !== 9) throw new Error('stats lost: ' + JSON.stringify(r.stats));
    if (r.def.iconKey !== 'shield') throw new Error('icon not stored');
    return 'shield → ' + r.type + ' slot, "' + r.effect + '"';
  });

  await step('rarity colours come from one shared table', async () => {
    const r = await page.evaluate(() => {
      const keys = ED.Content.RARITY_ORDER;
      const colors = keys.map(k => ED.Content.rarityColor(k));
      return { keys, colors, unique: new Set(colors).size, unknown: ED.Content.rarityColor('nonsense') };
    });
    if (r.unique !== r.keys.length) throw new Error('two tiers share a colour');
    if (r.unknown !== r.colors[0]) throw new Error('unknown rarity did not fall back to common');
    return r.keys.length + ' tiers, distinct colours, unknown falls back';
  });

  await step('deleting an item scrubs it from every loot table', async () => {
    const before = await page.evaluate(() => {
      const it = ED.Content.list('items').find(x => x.name === "Auditor's Bulwark");
      const t = ED.Content.list('loot')[0];
      t.loot.push(it.itemId); t.chances.push(25);
      ED.Content.save('loot', t);
      return { itemId: it.itemId, tableId: t.lootTableId, len: t.loot.length };
    });
    await page.evaluate(() => { Ed.tab = 'items'; Ed.renderAll(); });
    await page.evaluate(id => { Ed.select(id); }, before.itemId);
    await page.click('#edDel');
    await page.waitForTimeout(300);
    const after = await page.evaluate(o => {
      const t = ED.Content.get('loot', o.tableId);
      return { len: t.loot.length, chances: t.chances.length,
               stillThere: t.loot.indexOf(o.itemId) >= 0,
               itemGone: !ED.Content.get('items', o.itemId) };
    }, before);
    if (!after.itemGone) throw new Error('item survived deletion');
    if (after.stillThere) throw new Error('loot table still references the deleted item');
    if (after.len !== after.chances) throw new Error('parallel lists fell out of step: ' + after.len + ' vs ' + after.chances);
    return 'table went from ' + before.len + ' to ' + after.len + ' entries, lists still paired';
  });

  await step('deleting a loot table clears monster references', async () => {
    const r = await page.evaluate(() => {
      const t = ED.Content.list('loot').find(x => x.name === 'Wraith Hoard');
      const m = ED.Content.list('monsters').find(x => x.name === 'Ledger Wraith');
      m.lootTableId = t.lootTableId;
      ED.Content.save('monsters', m);
      Ed.tab = 'loot'; Ed.renderAll(); Ed.select(t.lootTableId);
      return { tableId: t.lootTableId, monsterId: m.monsterId };
    });
    await page.click('#edDel');
    await page.waitForTimeout(300);
    const after = await page.evaluate(o => ED.Content.get('monsters', o.monsterId).lootTableId, r);
    if (after) throw new Error('monster still points at the deleted table: ' + after);
    return 'reference cleared';
  });

  await step('duplicate makes an independent copy', async () => {
    await page.evaluate(() => { Ed.tab = 'monsters'; Ed.renderAll(); });
    const id = await page.evaluate(() => ED.Content.list('monsters')[0].monsterId);
    await page.evaluate(i => Ed.select(i), id);
    await page.click('#edDup');
    await page.click('#edSave');
    await page.waitForTimeout(300);
    const r = await page.evaluate(o => {
      const all = ED.Content.list('monsters');
      const orig = all.find(m => m.monsterId === o);
      const copy = all.find(m => m.name === orig.name + ' (copy)');
      return { has: !!copy, sameId: copy && copy.monsterId === o, n: all.length };
    }, id);
    if (!r.has) throw new Error('no copy created');
    if (r.sameId) throw new Error('the copy reused the original id');
    return 'copy saved with its own id, ' + r.n + ' monsters total';
  });

  await step('everything survives a reload', async () => {
    const before = await page.evaluate(() => ED.Content.stats());
    await page.reload();
    await page.waitForSelector('.edTabs', { timeout: 8000 });
    const after = await page.evaluate(() => ED.Content.stats());
    const wraith = await page.evaluate(() =>
      ED.Content.list('monsters').find(m => m.name === 'Ledger Wraith'));
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('counts changed across reload');
    if (!wraith || wraith.baseHp !== 100) throw new Error('the authored monster did not come back intact');
    return JSON.stringify(after);
  });

  await step('export and re-import round-trips', async () => {
    const r = await page.evaluate(() => {
      const dump = JSON.parse(JSON.stringify(ED.Content.exportAll()));
      const before = ED.Content.stats();
      ED.Content.clearAll();
      const empty = ED.Content.stats();
      const res = ED.Content.importAll(dump, 'replace');
      const after = ED.Content.stats();
      const wraith = ED.Content.list('monsters').find(m => m.name === 'Ledger Wraith');
      return { format: dump.format, before, empty, after, res, wraithHp: wraith && wraith.baseHp };
    });
    if (r.empty.monsters !== 0) throw new Error('clear did not empty the tables');
    if (JSON.stringify(r.before) !== JSON.stringify(r.after)) throw new Error('round-trip lost rows');
    if (r.wraithHp !== 100) throw new Error('a value changed in the round-trip');
    return r.format + ' → cleared → restored ' + r.after.monsters + '/' + r.after.loot + '/' + r.after.items;
  });

  if (errors.length) { fail++; console.log('  FAIL page errors — ' + errors.slice(0, 3).join(' | ')); }
  else console.log('  OK   no console or page errors');
  pass += errors.length ? 0 : 1;
  await ctx.close();

  /* =========================================================== INTEGRATION */
  console.log('\n===== AUTHORED CONTENT IN THE GAME =====');
  const { ctx: c2, page: g } = await newPage(browser);
  const gErrors = [];
  g.on('pageerror', e => gErrors.push(e.message));
  await g.goto(GAME_URL);
  await g.waitForSelector('#tReg', { timeout: 8000 });

  await step('the game seeds the same content on first run', async () => {
    const s = await g.evaluate(() => SS.Content.stats());
    if (!s.monsters) throw new Error('game did not seed');
    return s.monsters + ' monsters available to the game';
  });

  await step('an authored monster is what you actually fight', async () => {
    // straight into the game with a character
    await g.evaluate(() => {
      SS.Store.set(SS.K.accounts, {});
      const r = SS.Local ? null : null;
    });
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
    await g.waitForTimeout(2200);

    const r = await g.evaluate(() => {
      const node = { type: 'combat', difficulty: 3, nodeId: 'test', name: 'Test Site', icon: '⚔️' };
      const pack = SS.Bestiary.packFor(node, 2);
      return pack.map(e => ({ name: e.name, authored: !!e.authored, attackName: e.attackName,
                              hp: e.hp, atk: [e.atkMin, e.atkMax], loot: !!e.lootTableId }));
    });
    if (!r.length) throw new Error('empty pack');
    if (!r.every(e => e.authored)) throw new Error('built-in monsters were used instead');
    if (!r.every(e => e.loot)) throw new Error('an authored monster arrived with no loot table');
    return r.map(e => e.name + ' (' + e.hp + ' hp, ' + e.atk.join('–') + ', "' + e.attackName + '")').join('; ');
  });

  await step('authored damage ranges are what land', async () => {
    const r = await g.evaluate(() => {
      const e = SS.Content.toEnemy(SS.Content.list('monsters')[0], 1, 1);
      e.atkMin = 40; e.atkMax = 40;         // a flat, unmistakable range
      const target = { armor: 0, magicDefense: 0, evasion: -999, critResist: 999 };
      const rolls = [];
      for (let i = 0; i < 300; i++) {
        const hit = SS.Calc.resolveHit(e, target, { kind: 'phys', mult: 1 });
        if (hit.hit && !hit.crit) rolls.push(hit.damage);
      }
      return { min: Math.min.apply(null, rolls), max: Math.max.apply(null, rolls), n: rolls.length };
    });
    if (r.min < 39 || r.max > 41) throw new Error('a 40–40 monster dealt ' + r.min + '–' + r.max);
    return r.n + ' unmitigated hits all landed at ' + r.min + '–' + r.max;
  });

  await step('a kill drops from the monster\'s own loot table', async () => {
    const r = await g.evaluate(async () => {
      const c = SS.Game.ch;
      c.inventory = [];
      c.level = 20; SS.Characters.refreshMaxes(c, true);
      c.stats.maxHp = 99999; c.stats.hp = 99999;
      const node = SS.Game.nodes.find(n => n.type === 'combat') || SS.Game.nodes[0];
      node.type = 'combat';
      SS.Combat.begin(node);
      // one-shot everything, then let the engine finish
      SS.Combat.enc.enemies.forEach(e => { e.hp = 1; });
      const tableIds = SS.Combat.enc.enemies.map(e => e.lootTableId);
      SS.Combat.enc.enemies.forEach(e => { e.hp = 0; e.alive = false; });
      SS.Combat.end('won');
      const authoredIds = new Set();
      tableIds.filter(Boolean).forEach(id => {
        const t = SS.Content.get('loot', id);
        (t ? t.loot : []).forEach(i => authoredIds.add(i));
      });
      return {
        drops: c.inventory.map(i => ({ name: i.name, authored: !!i.authored, defId: i.defId,
                                       fromTable: authoredIds.has(i.defId) })),
        tables: tableIds.filter(Boolean).length
      };
    });
    if (!r.drops.length) throw new Error('no drops at all');
    const off = r.drops.filter(d => !d.authored || !d.fromTable);
    if (off.length) throw new Error('drops not from the loot table: ' + JSON.stringify(off));
    return r.drops.length + ' drops, all from the ' + r.tables + ' loot table(s) in play: ' +
           r.drops.map(d => d.name).join(', ');
  });

  await step('authored gear equips and its resistance counts', async () => {
    const r = await g.evaluate(() => {
      const c = SS.Game.ch;
      c.equipment = [];
      const before = SS.Calc.magicDefense(c);
      const def = SS.Content.list('items').find(i => +i.resistance > 0);
      const inst = SS.Content.toGameItem(def.itemId, c.level);
      c.equipment = [inst];
      const after = SS.Calc.magicDefense(c);
      return { before, after, res: +def.resistance, name: def.name, icon: inst.iconKey };
    });
    if (Math.round(r.after - r.before) !== r.res) throw new Error('resistance not applied: ' + r.before + ' → ' + r.after);
    return r.name + ' (+' + r.res + ' res) moved magic defence ' + Math.round(r.before) + ' → ' + Math.round(r.after);
  });

  await step('authored items render their SVG icon in the pack', async () => {
    await g.evaluate(() => {
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      const c = SS.Game.ch;
      c.inventory = [SS.Content.toGameItem(SS.Content.list('items')[0].itemId, 5)];
    });
    await g.click('#btnBag');
    await g.waitForSelector('.modal', { timeout: 4000 });
    const r = await g.evaluate(() => {
      const svg = document.querySelector('.itemList .item .ico svg.gicon');
      return { hasSvg: !!svg, stroke: svg && svg.getAttribute('stroke') };
    });
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    if (!r.hasSvg) throw new Error('no inline SVG icon rendered');
    if (!/^#/.test(r.stroke || '')) throw new Error('icon not tinted by rarity: ' + r.stroke);
    return 'tinted ' + r.stroke;
  });

  await step('a fresh monster authored now shows up in the next fight', async () => {
    const r = await g.evaluate(() => {
      const m = SS.Content.blankMonster();
      m.name = 'Test Specimen';
      m.levelMin = 1; m.levelMax = 40;
      m.baseHp = 5; m.attackMin = 1; m.attackMax = 1;
      m.rarity = 'mythic';
      SS.Content.replaceAll('monsters', [SS.Content.save('monsters', m)]);
      const pack = SS.Bestiary.packFor({ type: 'combat', difficulty: 4 }, 3);
      return { names: pack.map(e => e.name), hp: pack[0].hp,
               scaled: Math.round(5 * SS.Content.config().scale.mythic.hp) };
    });
    if (!r.names.every(n => n === 'Test Specimen')) throw new Error('pack was ' + r.names.join(','));
    if (r.hp < r.scaled) throw new Error('mythic scaling not applied: ' + r.hp + ' < ' + r.scaled);
    return 'pack of ' + r.names.length + ', hp ' + r.hp + ' (base 5 × mythic, grown by level)';
  });

  await step('an empty content database falls back to the built-in bestiary', async () => {
    const r = await g.evaluate(() => {
      SS.Content.clearAll();
      const pack = SS.Bestiary.packFor({ type: 'combat', difficulty: 3 }, 2);
      return { names: pack.map(e => e.name), authored: pack.some(e => e.authored) };
    });
    if (!r.names.length) throw new Error('no fallback pack');
    if (r.authored) throw new Error('claims to be authored with an empty database');
    return 'fell back to ' + r.names.join(', ');
  });

  if (gErrors.length) { fail++; console.log('  FAIL game page errors — ' + gErrors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the game'); }
  await c2.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
