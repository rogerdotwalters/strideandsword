/* Both editors on a phone and on a desktop: no sideways scrolling, targets big
   enough for a thumb, and every job doable by tapping. */
const { chromium, devices } = require('playwright');
const path = require('path');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
const fs = require('fs');

const EDITOR_URL = BASE + '/editor.html';
const MAP_URL    = BASE + '/mapeditor.html';
const GAME_URL   = BASE + '/index.html';
const LEAFLET_JS  = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
                deviceScaleFactor: 3,
                userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' };
const DESKTOP = { viewport: { width: 1440, height: 900 }, hasTouch: false };

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

async function newPage(browser, profile) {
  const ctx = await browser.newContext(profile);
  const page = await ctx.newPage();
  // These suites author their own content, so nothing seeds in underneath them.
  await emptyDatabase(page);
  page.on('dialog', d => d.accept('Test Zone'));
  await page.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await page.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  await page.route('**nominatim.openstreetmap.org/**', r => r.abort());
  await page.route('**/api/interpreter', r => r.abort());
  return { ctx, page };
}

/* Nothing may stick out sideways — the classic mobile-layout failure. */
async function overflow(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const wide = [];
    const inScroller = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      }
      return false;
    };
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (inScroller(el)) return;              // free to scroll sideways inside its own strip
      if (r.right > w + 1.5 || r.left < -1.5) {
        wide.push((el.id ? '#' + el.id : el.className && typeof el.className === 'string'
          ? '.' + el.className.split(' ')[0] : el.tagName) +
          ' [' + Math.round(r.left) + '…' + Math.round(r.right) + ']');
      }
    });
    return { docWidth: w, scrollWidth: document.documentElement.scrollWidth,
             bodyScroll: document.body.scrollWidth, offenders: wide.slice(0, 6) };
  });
}

/* Every control a finger has to hit should be at least 40px on its short side. */
async function smallTargets(page, extraSelector) {
  return page.evaluate(sel => {
    const out = [];
    document.querySelectorAll(sel).forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;          // hidden
      if (el.closest('.leaflet-container')) return;          // Leaflet's own controls
      if (el.type === 'checkbox' || el.type === 'radio') {
        const label = el.closest('label');
        const lr = label && label.getBoundingClientRect();
        if (lr && lr.height >= 40) return;                   // the label is the target
      }
      if (r.height < 40) {
        out.push((el.id ? '#' + el.id : el.textContent.trim().slice(0, 18) || el.tagName) +
                 ' ' + Math.round(r.width) + '×' + Math.round(r.height));
      }
    });
    return out;
  }, extraSelector);
}

(async () => {
  // The game fetches its database out of data/*.json, and fetch() will not
  // touch a file:// URL — so the suites run against a real origin now.
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ==================================================== CONTENT EDITOR — PHONE */
  console.log('\n===== CONTENT EDITOR · iPhone 390×844 =====');
  {
    const { ctx, page } = await newPage(browser, PHONE);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(EDITOR_URL);
    await page.waitForSelector('.edTabs', { timeout: 8000 });

    await step('nothing overflows sideways', async () => {
      const o = await overflow(page);
      if (o.offenders.length) throw new Error(o.offenders.join(' | '));
      if (o.scrollWidth > o.docWidth + 1) throw new Error('page scrolls sideways: ' + o.scrollWidth + ' > ' + o.docWidth);
      return 'document ' + o.docWidth + 'px, no element past the edge';
    });

    await step('starts on the list, with the table as cards', async () => {
      const pane = await page.getAttribute('body', 'data-pane');
      if (pane !== 'list') throw new Error('opened on "' + pane + '"');
      const headerVisible = await page.evaluate(() => {
        const th = document.querySelector('table.grid thead');
        return th ? getComputedStyle(th).display !== 'none' : null;
      });
      if (headerVisible !== false) throw new Error('table header still shown on a phone');
      const label = await page.evaluate(() => {
        const td = document.querySelector('table.grid tbody td:nth-child(3)');
        return td && getComputedStyle(td, '::before').content;
      });
      if (!label || label === 'none') throw new Error('cells are not labelling themselves');
      return 'cards with labels, e.g. ' + label;
    });

    await step('the toolbar collapses into a menu', async () => {
      const hidden = await page.evaluate(() =>
        [...document.querySelectorAll('.desktopOnly')].every(e => getComputedStyle(e).display === 'none'));
      if (!hidden) throw new Error('desktop-only buttons still showing');
      await page.tap('#edMenu');
      await page.waitForTimeout(250);
      const txt = await page.textContent('.modal');
      if (!/Seed defaults/.test(txt) || !/Export JSON/.test(txt)) throw new Error('menu is missing its actions');
      await page.tap('#edMenuClose');
      return 'actions moved into the ⋯ sheet';
    });

    await step('tapping a row opens the details pane', async () => {
      await page.tap('table.grid tbody tr:first-child');
      await page.waitForTimeout(300);
      const pane = await page.getAttribute('body', 'data-pane');
      if (pane !== 'form') throw new Error('pane is "' + pane + '"');
      const formVisible = await page.evaluate(() => {
        const f = document.querySelector('.edForm');
        return getComputedStyle(f).display !== 'none' && f.getBoundingClientRect().width > 300;
      });
      if (!formVisible) throw new Error('form pane not filling the screen');
      return 'form fills the screen';
    });

    await step('the save bar is pinned within reach', async () => {
      const r = await page.evaluate(() => {
        const a = document.querySelector('.formActions');
        const st = getComputedStyle(a);
        const b = a.getBoundingClientRect();
        return { pos: st.position, bottom: Math.round(window.innerHeight - b.bottom), h: Math.round(b.height) };
      });
      if (r.pos !== 'fixed') throw new Error('save bar is ' + r.pos + ', not pinned');
      if (r.bottom > 4) throw new Error('save bar sits ' + r.bottom + 'px off the bottom');
      return 'fixed, ' + r.h + 'px tall at the bottom';
    });

    await step('no cramped touch targets on the form', async () => {
      const bad = await smallTargets(page, '.edForm button, .edForm input, .edForm select, .edForm textarea');
      if (bad.length) throw new Error(bad.slice(0, 5).join(' | '));
      return 'every control at least 40px tall';
    });

    await step('text inputs are 16px, so iOS does not zoom in', async () => {
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('.edForm input, .edForm select, .edForm textarea')]
          .filter(e => !['range', 'checkbox', 'radio', 'color'].includes(e.type))
          .map(e => parseFloat(getComputedStyle(e).fontSize))
          .filter(s => s && s < 16));
      if (small.length) throw new Error(small.length + ' fields under 16px: ' + small.join(', '));
      return 'all at 16px or larger';
    });

    await step('the back button returns to the list', async () => {
      await page.tap('#edBack');
      await page.waitForTimeout(250);
      const pane = await page.getAttribute('body', 'data-pane');
      if (pane !== 'list') throw new Error('pane is "' + pane + '"');
      return 'back on the list';
    });

    await step('a monster can be created start to finish by tapping', async () => {
      await page.tap('#edNew');
      await page.waitForTimeout(250);
      await page.fill('#f_name', 'Phone Beast');
      await page.fill('#f_baseHp', '55');
      await page.tap('#edSave');
      await page.waitForTimeout(350);
      const saved = await page.evaluate(() =>
        ED.Content.list('monsters').find(m => m.name === 'Phone Beast'));
      if (!saved) throw new Error('not saved');
      if (saved.baseHp !== 55) throw new Error('fields lost');
      const pane = await page.getAttribute('body', 'data-pane');
      if (pane !== 'list') throw new Error('did not return to the list after saving');
      const inList = await page.textContent('table.grid tbody');
      if (!/Phone Beast/.test(inList)) throw new Error('missing from the list');
      return 'created, saved, back on the list showing it';
    });

    await step('every tab works and none overflows', async () => {
      const report = [];
      for (const tab of ['loot', 'items', 'spawns', 'rarity']) {
        await page.tap('[data-tab="' + tab + '"]');
        await page.waitForTimeout(250);
        const o = await overflow(page);
        if (o.offenders.length) throw new Error(tab + ': ' + o.offenders.join(' | '));
        report.push(tab);
      }
      return report.join(', ') + ' all fit';
    });

    if (errors.length) { fail++; console.log('  FAIL page errors — ' + errors.slice(0, 3).join(' | ')); }
    else { pass++; console.log('  OK   no page errors'); }
    await ctx.close();
  }

  /* ======================================================== MAP EDITOR — PHONE */
  console.log('\n===== MAP EDITOR · iPhone 390×844 =====');
  {
    const { ctx, page } = await newPage(browser, PHONE);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(MAP_URL);
    await page.waitForSelector('.meTop', { timeout: 8000 });

    await step('nothing overflows sideways', async () => {
      const o = await overflow(page);
      if (o.offenders.length) throw new Error(o.offenders.join(' | '));
      return 'document ' + o.docWidth + 'px, clean';
    });

    await step('opens on the map with a pane switcher', async () => {
      const pane = await page.getAttribute('body', 'data-pane');
      if (pane !== 'map') throw new Error('opened on "' + pane + '"');
      const bar = await page.evaluate(() => {
        const b = document.querySelector('.paneBar');
        const r = b.getBoundingClientRect();
        return { shown: getComputedStyle(b).display !== 'none', h: Math.round(r.height),
                 buttons: b.querySelectorAll('button').length };
      });
      if (!bar.shown) throw new Error('no pane bar');
      if (bar.buttons !== 3) throw new Error(bar.buttons + ' buttons');
      return bar.buttons + ' panes, bar ' + bar.h + 'px tall';
    });

    await step('the map has real height to work with', async () => {
      const h = await page.evaluate(() => Math.round(document.querySelector('#map').getBoundingClientRect().height));
      if (h < 380) throw new Error('map is only ' + h + 'px tall');
      return h + 'px of map';
    });

    await step('a refused placement leaves the button usable', async () => {
      // The bug this guards: placeAt returning while still armed. The next tap
      // on the button then turns placing OFF, and the editor looks like it
      // simply refuses to place anything, forever.
      await page.tap('#meFab');
      await page.waitForTimeout(200);
      if (!(await page.evaluate(() => ME.Me.placing))) throw new Error('did not arm');
      const box = await (await page.$('#map')).boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(400);
      if (await page.evaluate(() => ME.Me.placing)) throw new Error('still armed after a refused place');
      const pane = await page.getAttribute('body', 'data-pane');
      if (pane !== 'form') throw new Error('did not send us to the zone button, pane is "' + pane + '"');
      const mk = await page.$('#meZoneNew2');
      if (!mk || !(await mk.isVisible())) throw new Error('no way to make a zone on a phone');
      const r = await mk.boundingBox();
      if (r.height < 40) throw new Error('zone button is only ' + Math.round(r.height) + 'px tall');
      return 'disarmed, and the zone button is right there at ' + Math.round(r.height) + 'px';
    });

    await step('create a zone from the mobile menu', async () => {
      await page.tap('#meMenu');
      await page.waitForTimeout(250);
      const btn = await page.$('#meSheet button:has-text("New zone here")');
      if (!btn) throw new Error('no zone action in the sheet');
      await btn.tap();
      await page.waitForTimeout(400);
      const z = await page.evaluate(() => ME.Me.zone);
      if (!z) throw new Error('no zone made');
      // The refused-placement step above left us on the details pane.
      await page.evaluate(() => ME.Me.setPane('map'));
      await page.waitForTimeout(300);
      return z.label;
    });

    await step('place a location by tapping the map', async () => {
      await page.tap('#meFab');
      await page.waitForTimeout(200);
      const placing = await page.evaluate(() => ME.Me.placing);
      if (!placing) throw new Error('the place button did not arm');
      const box = await (await page.$('#map')).boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2 - 40, box.y + box.height / 2 - 60);
      await page.waitForTimeout(400);
      const n = await page.evaluate(() => ME.Me.locations().length);
      if (n !== 1) throw new Error(n + ' locations after one tap');
      const pane = await page.getAttribute('body', 'data-pane');
      if (pane !== 'form') throw new Error('did not open the details, pane is "' + pane + '"');
      return 'tapped, placed, details opened';
    });

    await step('fill it in and save without a keyboard trap', async () => {
      await page.fill('#f_name', 'Phone Dock');
      await page.fill('#f_radius', '75');
      const bad = await smallTargets(page, '.meForm button, .meForm input, .meForm select, .meForm textarea');
      if (bad.length) throw new Error('cramped: ' + bad.slice(0, 4).join(' | '));
      await page.tap('#meSave');
      await page.waitForTimeout(350);
      const l = await page.evaluate(() => ME.Me.locations()[0]);
      if (l.name !== 'Phone Dock' || l.radius !== 75) throw new Error(JSON.stringify(l));
      const pane = await page.getAttribute('body', 'data-pane');
      if (pane !== 'map') throw new Error('did not return to the map');
      return 'saved at 75 m, back on the map';
    });

    await step('the list pane shows it as a labelled card', async () => {
      await page.tap('.paneBar [data-pane="list"]');
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const tr = document.querySelector('table.grid tbody tr');
        const td = tr && tr.querySelector('td:nth-child(5)');
        return { text: tr && tr.textContent, label: td && getComputedStyle(td, '::before').content,
                 mapHidden: getComputedStyle(document.querySelector('.mapWrap')).display === 'none' };
      });
      if (!/Phone Dock/.test(r.text || '')) throw new Error('row missing');
      if (!r.label || r.label === 'none') throw new Error('cells are not labelling themselves');
      if (!r.mapHidden) throw new Error('map still taking up the screen');
      return 'card view, label ' + r.label;
    });

    await step('tapping the card opens its details', async () => {
      await page.tap('table.grid tbody tr');
      await page.waitForTimeout(300);
      const pane = await page.getAttribute('body', 'data-pane');
      if (pane !== 'form') throw new Error('pane is "' + pane + '"');
      await page.tap('#meBack');
      await page.waitForTimeout(250);
      if (await page.getAttribute('body', 'data-pane') !== 'map') throw new Error('back did not reach the map');
      return 'card → details → back to the map';
    });

    await step('place a dungeon by tapping, and resize it with the slider', async () => {
      await page.evaluate(() => ME.Me.setPane('list'));
      await page.waitForTimeout(200);
      await page.tap('[data-mode="dungeons"]');
      await page.waitForTimeout(250);
      await page.evaluate(() => ME.Me.setPane('map'));
      await page.waitForTimeout(300);
      const label = (await page.textContent('#meFab')).trim();
      if (!/dungeon/i.test(label)) throw new Error('the button does not say what it places: "' + label + '"');
      await page.tap('#meFab');
      await page.waitForTimeout(200);
      const box = await (await page.$('#map')).boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(500);
      // Saved on place, like a location — a form-only draft is lost the moment
      // you tap Map to look at what you just drew.
      const stored = await page.evaluate(() => ME.Content.list('dungeons').length);
      if (stored !== 1) throw new Error(stored + ' dungeons stored after one tap');
      const slider = await page.$('#rg_radius');
      if (!slider) throw new Error('no radius slider — dragging an 18px map handle is not a touch gesture');
      const sr = await slider.boundingBox();
      if (sr.height < 40) throw new Error('slider is only ' + Math.round(sr.height) + 'px tall');
      await page.evaluate(() => {
        const r = document.querySelector('#rg_radius');
        r.value = 150; r.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForTimeout(250);
      const shown = await page.textContent('#sz_radius');
      if (+shown !== 150) throw new Error('readout says ' + shown);
      await page.tap('#meSave');
      await page.waitForTimeout(400);
      const saved = await page.evaluate(() => ME.Content.list('dungeons')[0].radius);
      if (saved !== 150) throw new Error('saved radius is ' + saved);
      return 'tapped, stored, resized to ' + saved + ' m on a ' + Math.round(sr.height) + 'px slider';
    });

    await step('the layer switch works with a thumb', async () => {
      await page.evaluate(() => ME.Me.setPane('list'));
      await page.waitForTimeout(250);
      const size = await page.$$eval('.layerSwitch button', bs => bs.map(b => {
        const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) };
      }));
      if (size.length !== 3) throw new Error(size.length + ' layer buttons');
      const small = size.filter(s => s.h < 40 || s.w < 55);
      if (small.length) throw new Error('too small: ' + JSON.stringify(small));
      // Three tabs is the point where the strip could start pushing the bar
      // sideways, so every layer is tapped and checked for overflow.
      for (const m of ['dungeons', 'instances', 'locations']) {
        await page.tap('[data-mode="' + m + '"]');
        await page.waitForTimeout(300);
        const mode = await page.evaluate(() => ME.Me.mode);
        if (mode !== m) throw new Error('tap did not reach ' + m + ', still ' + mode);
        const o = await overflow(page);
        if (o.offenders.length) throw new Error(m + ' list overflows: ' + o.offenders.join(' | '));
      }
      return size.map(s => s.w + '×' + s.h).join(', ') + ', all three tap cleanly';
    });

    await step('the zoom presets are reachable and thumb-sized', async () => {
      await page.evaluate(() => ME.Me.setPane('map'));
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('#meZoom .zmBtn')];
        return btns.map(b => {
          const x = b.getBoundingClientRect();
          // Whatever is actually on top at the button's centre.
          const top = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
          return { z: b.dataset.z, w: Math.round(x.width), h: Math.round(x.height),
                   clear: b.contains(top) };
        });
      });
      if (r.length !== 2) throw new Error('expected two presets, saw ' + r.length);
      const small = r.filter(b => b.w < 40 || b.h < 40);
      if (small.length) throw new Error('too small: ' + JSON.stringify(small));
      const buried = r.filter(b => !b.clear);
      if (buried.length) throw new Error('covered by something: ' + JSON.stringify(buried));
      return r.map(b => b.z + ' ' + b.w + '×' + b.h).join(', ');
    });

    await step('no overflow on any pane', async () => {
      for (const p of ['map', 'list', 'form']) {
        await page.evaluate(x => ME.Me.setPane(x), p);
        await page.waitForTimeout(200);
        const o = await overflow(page);
        if (o.offenders.length) throw new Error(p + ': ' + o.offenders.join(' | '));
      }
      return 'map, list and form all fit';
    });

    if (errors.length) { fail++; console.log('  FAIL page errors — ' + errors.slice(0, 3).join(' | ')); }
    else { pass++; console.log('  OK   no page errors'); }
    await ctx.close();
  }

  /* ============================================================ DESKTOP CHECK */
  console.log('\n===== DESKTOP 1440×900 =====');
  {
    const { ctx, page } = await newPage(browser, DESKTOP);
    await page.goto(EDITOR_URL);
    await page.waitForSelector('.edTabs', { timeout: 8000 });

    await step('content editor keeps both panes side by side', async () => {
      const r = await page.evaluate(() => {
        const list = document.querySelector('.edList').getBoundingClientRect();
        const form = document.querySelector('.edForm').getBoundingClientRect();
        const th = document.querySelector('table.grid thead');
        return { listW: Math.round(list.width), formW: Math.round(form.width),
                 sideBySide: form.left >= list.right - 2,
                 header: th ? getComputedStyle(th).display : null,
                 paneBarHidden: true };
      });
      if (!r.sideBySide) throw new Error('panes are stacked on a desktop');
      if (r.header === 'none') throw new Error('table header hidden on a desktop');
      if (r.formW < 300) throw new Error('form pane collapsed to ' + r.formW);
      return 'list ' + r.listW + 'px + form ' + r.formW + 'px, real table';
    });

    await step('desktop toolbar shows its buttons, not the ⋯ menu', async () => {
      const r = await page.evaluate(() => ({
        desktop: [...document.querySelectorAll('.desktopOnly')].filter(e => getComputedStyle(e).display !== 'none').length,
        mobile: [...document.querySelectorAll('.mobileOnly')].filter(e => getComputedStyle(e).display !== 'none').length
      }));
      if (!r.desktop) throw new Error('toolbar buttons hidden');
      if (r.mobile) throw new Error('mobile menu showing on a desktop');
      return r.desktop + ' toolbar buttons, no ⋯';
    });

    await step('selecting a row does not hijack the layout', async () => {
      await page.click('table.grid tbody tr:first-child');
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        const list = document.querySelector('.edList');
        const back = document.querySelector('#edBack');
        return { listShown: getComputedStyle(list).display !== 'none',
                 backShown: back ? getComputedStyle(back).display !== 'none' : false };
      });
      if (!r.listShown) throw new Error('the list disappeared on a desktop');
      if (r.backShown) throw new Error('the mobile back button is showing');
      return 'list stays put, no back button';
    });

    await page.goto(MAP_URL);
    await page.waitForSelector('.meTop', { timeout: 8000 });

    await step('map editor keeps map, table and form together', async () => {
      const r = await page.evaluate(() => {
        const map = document.querySelector('.mapWrap').getBoundingClientRect();
        const table = document.querySelector('.meTable').getBoundingClientRect();
        const form = document.querySelector('.meForm').getBoundingClientRect();
        const bar = document.querySelector('.paneBar');
        const fab = document.querySelector('.fab');
        return { map: Math.round(map.height), table: Math.round(table.height),
                 form: Math.round(form.width),
                 barHidden: getComputedStyle(bar).display === 'none',
                 fabHidden: getComputedStyle(fab).display === 'none' };
      });
      if (!r.barHidden) throw new Error('the mobile pane bar is showing on a desktop');
      if (!r.fabHidden) throw new Error('the floating button is showing on a desktop');
      if (r.map < 200 || r.table < 150 || r.form < 300) throw new Error(JSON.stringify(r));
      return 'map ' + r.map + 'px, table ' + r.table + 'px, form ' + r.form + 'px';
    });

    await step('desktop has no sideways scroll either', async () => {
      const o = await overflow(page);
      if (o.scrollWidth > o.docWidth + 1) throw new Error('scrolls sideways at 1440');
      return 'clean at 1440px';
    });

    await ctx.close();
  }

  /* =============================================== THE GAME ITSELF, ON A PHONE */
  console.log('\n===== GAME · iPhone 390×844 =====');
  {
    const { ctx, page } = await newPage(browser, Object.assign({}, PHONE, {
      geolocation: { latitude: 41.8827, longitude: -87.6233 }, permissions: ['geolocation'] }));
    await page.goto(GAME_URL);
    await page.waitForSelector('#tReg', { timeout: 8000 });
    await step('the game still fits, as it always did', async () => {
      const o = await overflow(page);
      if (o.offenders.length) throw new Error(o.offenders.join(' | '));
      return 'auth screen clean at 390px';
    });
    await ctx.close();
  }

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
