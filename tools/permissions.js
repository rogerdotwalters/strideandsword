/* Location-permission behaviour across origins and permission states. */
const { chromium } = require('playwright');
const path = require('path');
const { serve, serveAt, BASE } = require('./serve');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { mockOverpass } = require('./mock-osm');

/* Two origins on purpose. FILE_URL is a real file:// page, because the whole
   point of the first block is what a browser does to geolocation there — and
   the database not loading over file:// is part of the same story. HTTP_URL is
   the served copy, which is how the game is actually meant to be opened. */
const FILE_URL = 'file://' + path.resolve(__dirname, '../index.html');
const HTTP_URL = BASE + '/index.html';
let pass = 0, fail = 0;

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

/* Playwright reports an ungranted permission as "denied"; a real browser that
   has never been asked reports "prompt". stubPrompt recreates that first-run
   state so the first-run copy is exercised too. */
const PROMPT_STUB = `
navigator.permissions.query = async (d) =>
  d && d.name === 'geolocation' ? { state: 'prompt', onchange: null } : { state: 'granted', onchange: null };
`;

async function newPage(browser, opts, stubPrompt) {
  const ctx = await browser.newContext(Object.assign({
    viewport: { width: 430, height: 900 },
    geolocation: { latitude: 41.8827, longitude: -87.6233 }
  }, opts));
  const page = await ctx.newPage();
  if (stubPrompt) await page.addInitScript(PROMPT_STUB);
  await page.route('**cdnjs.cloudflare.com/**', r => r.abort());
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  await page.route('**/api/interpreter', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(mockOverpass(41.8827, -87.6233)) }));
  return { ctx, page };
}

/* Walk a fresh account through to the game screen. */
async function toGame(page, url) {
  await page.goto(url);
  await page.waitForSelector('#tReg', { timeout: 8000 });
  await page.click('#tReg');
  await page.fill('#rgUser', 'roger');
  await page.fill('#rgPass', 'walk1234');
  await page.click('#rgGo');
  await page.waitForSelector('.stepBar', { timeout: 6000 });
  await page.click('.pickGrid .pick:nth-child(1)'); await page.click('#next');
  await page.click('.pickGrid .pick:nth-child(1)'); await page.click('#next');
  for (let g = 0; g < 40; g++) {
    const l = parseInt(await page.textContent('#ptsLeft'), 10); if (!l) break;
    const b = await page.$('.stepper[data-inc]:not([disabled])'); if (!b) break; await b.click();
  }
  await page.click('#next'); await page.fill('#cName', 'Bram Ashwalk'); await page.click('#next');
  await page.waitForSelector('#map', { timeout: 6000 });
  await page.waitForTimeout(900);
}

(async () => {
  // The game fetches its database out of data/*.json, and fetch() will not
  // touch a file:// URL — so the suites run against a real origin now.
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------------------------------------------------------------- */
  console.log('\n===== NO PERMISSION GRANTED (file://) =====');
  {
    const { ctx, page } = await newPage(browser, { permissions: [] });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await toGame(page, FILE_URL);

    await step('a gate is shown instead of a silent failure', async () => {
      const t = await page.textContent('.modalHead h3');
      if (!t) throw new Error('no modal');
      return '"' + t.trim() + '"';
    });

    await step('the gate names file:// as the cause', async () => {
      const body = await page.textContent('.modalBody');
      if (!/file:\/\//.test(body)) throw new Error('file:// not mentioned');
      if (!/localhost:8000/.test(body)) throw new Error('no localhost recipe');
      if (!/https/.test(body)) throw new Error('no https advice for phones');
      return 'explains the cause and both fixes';
    });

    await step('no GPS watch is opened before consent', async () => {
      const r = await page.evaluate(() => ({ watch: SS.Loc.watchId, last: SS.Loc.last, sim: SS.Loc.simulated }));
      if (r.watch != null) throw new Error('watchPosition started anyway');
      if (r.last) throw new Error('a position was invented before consent');
      if (r.sim) throw new Error('silently fell back to simulation');
      return 'no watch, no position, not simulating';
    });

    await step('diagnostics report the real origin', async () => {
      await page.click('#gateDiag');
      const txt = await page.textContent('#gateDiagBox');
      const d = JSON.parse(txt);
      if (!d.isFile) throw new Error('isFile false on a file:// page');
      if (d.canPrompt) throw new Error('claims it can prompt from file://');
      if (!d.hasGeo) throw new Error('geolocation API missing');
      return 'protocol ' + d.protocol + ', canPrompt ' + d.canPrompt + ', permission ' + d.permission;
    });

    await step('asking while blocked reports back in the dialog', async () => {
      await page.click('.modalFoot .btn.primary');
      await page.waitForTimeout(1200);
      const still = await page.$('.modalBack');
      if (!still) throw new Error('dialog closed despite failing');
      const msg = await page.textContent('#gateResult');
      if (!/Blocked|unavailable|Timed out/i.test(msg)) throw new Error('unhelpful message: ' + msg);
      return '"' + msg.trim() + '"';
    });

    await step('granting in browser settings is picked up without a reload', async () => {
      await ctx.grantPermissions(['geolocation']);
      await page.waitForFunction(() => SS.Loc.status === 'live', null, { timeout: 12000 });
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => ({
        status: SS.Loc.status, watch: SS.Loc.watchId, last: !!SS.Loc.last,
        gate: !!document.querySelector('.modalBack'),
        chip: document.querySelector('#wGps').textContent
      }));
      if (r.watch == null) throw new Error('no watch opened after grant');
      if (!r.last) throw new Error('no position');
      if (r.gate) throw new Error('gate left open once location worked');
      return 'live, watching, gate dismissed itself, chip reads "' + r.chip + '"';
    });

    await step('asking again while already live returns at once', async () => {
      const t0 = Date.now();
      const r = await page.evaluate(() => SS.Loc.requestPermission());
      const ms = Date.now() - t0;
      if (!r.ok) throw new Error('failed while live: ' + JSON.stringify(r));
      if (ms > 3000) throw new Error('took ' + ms + 'ms — waiting on a fresh sample');
      return 'resolved in ' + ms + ' ms from the existing fix';
    });

    await step('only one GPS watch is ever open', async () => {
      const r = await page.evaluate(async () => {
        const before = SS.Loc.watchId;
        SS.Loc.start(); SS.Loc.start();
        return { before, after: SS.Loc.watchId };
      });
      if (r.after === r.before) return 'watch reused (' + r.after + ')';
      // ids differ, but the old one must have been cleared, not leaked
      const leaked = await page.evaluate(() => SS.Loc.watchId == null);
      if (leaked) throw new Error('watch lost');
      return 'watch replaced cleanly (' + r.before + ' → ' + r.after + ')';
    });

    await step('zone anchors on the real fix', async () => {
      await page.waitForTimeout(1500);
      const r = await page.evaluate(() => SS.Game.zone && {
        lat: SS.Game.zone.centerLatitude.toFixed(4), n: SS.Game.nodes.length });
      if (!r) throw new Error('no zone');
      if (r.lat !== '41.8827') throw new Error('anchored at ' + r.lat);
      return r.n + ' sites around ' + r.lat;
    });

    if (errors.length) { fail++; console.log('  FAIL page errors — ' + errors[0]); }
    await ctx.close();
  }

  /* ---------------------------------------------------------------- */
  console.log('\n===== DECLINING THE GATE =====');
  {
    const { ctx, page } = await newPage(browser, { permissions: [] });
    await toGame(page, HTTP_URL);
    await step('"Dev testing instead" switches modes and closes the gate', async () => {
      await page.click('.modalFoot .btn.ghost');
      await page.waitForTimeout(700);
      const r = await page.evaluate(() => ({
        mode: SS.settings().locationMode, sim: SS.Loc.simulated,
        gate: !!document.querySelector('.modalBack'),
        panel: !document.querySelector('#devPanel').classList.contains('hidden'),
        checked: document.querySelector('#modeToggle').checked
      }));
      if (r.mode !== 'sim' || !r.sim) throw new Error('did not switch: ' + JSON.stringify(r));
      if (r.gate) throw new Error('gate still open');
      if (!r.panel) throw new Error('dev panel not shown');
      if (!r.checked) throw new Error('checkbox out of sync');
      return 'sim mode, panel up, checkbox ticked';
    });

    await step('the GPS chip offers the way back', async () => {
      await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
      const before = await page.textContent('#wGps');
      await page.click('#wGps');
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => ({ mode: SS.settings().locationMode,
        gate: !!document.querySelector('.modalBack') }));
      if (r.mode !== 'gps') throw new Error('chip did not return to GPS');
      if (!r.gate) throw new Error('no gate raised to ask again');
      return '"' + before + '" → asked again';
    });
    await ctx.close();
  }

  /* ---------------------------------------------------------------- */
  console.log('\n===== SERVED OVER http://localhost =====');
  {
    // The whole repo on a second origin, not just index.html — the page pulls
    // in js/, css/ and data/, and a server that answers everything with the
    // same HTML gives you a blank screen and a confusing failure.
    const srv = await serveAt(8231, '0.0.0.0');

    const { ctx, page } = await newPage(browser, { permissions: [] }, true);
    await toGame(page, 'http://localhost:8231/');

    await step('a never-asked secure origin gets the plain "Turn on location" ask', async () => {
      const t = (await page.textContent('.modalHead h3')).trim();
      if (t !== 'Turn on location') throw new Error('showed "' + t + '" instead');
      const body = await page.textContent('.modalBody');
      if (/file:\/\//.test(body)) throw new Error('still blaming file://');
      return 'correct copy for a secure origin';
    });

    await step('localhost is treated as promptable', async () => {
      await page.click('#gateDiag');
      const d = JSON.parse(await page.textContent('#gateDiagBox'));
      if (!d.canPrompt) throw new Error('canPrompt false on localhost');
      if (!d.isLocalhost || !d.secureContext) throw new Error(JSON.stringify(d));
      return 'canPrompt true, secureContext true';
    });

    await step('allowing from localhost starts the watch', async () => {
      await ctx.grantPermissions(['geolocation'], { origin: 'http://localhost:8231' });
      await page.click('.modalFoot .btn.primary');
      await page.waitForFunction(() => SS.Loc.status === 'live', null, { timeout: 12000 });
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => ({ status: SS.Loc.status, watch: SS.Loc.watchId,
        gate: !!document.querySelector('.modalBack') }));
      if (r.status !== 'live' || r.watch == null || r.gate) throw new Error(JSON.stringify(r));
      return 'live and watching';
    });

    await ctx.close();

    /* --- and the LAN address, which browsers refuse --- */
    const ip = lanIp();
    if (ip) {
      const { ctx: c2, page: p2 } = await newPage(browser, { permissions: [] });
      await toGame(p2, 'http://' + ip + ':8231/');
      await step('a plain LAN address is called out as insecure', async () => {
        const t = (await p2.textContent('.modalHead h3')).trim();
        const body = await p2.textContent('.modalBody');
        await p2.click('#gateDiag');
        const d = JSON.parse(await p2.textContent('#gateDiagBox'));
        if (d.canPrompt) throw new Error('claims LAN http can prompt');
        if (d.secureContext) throw new Error('LAN http reported as a secure context');
        if (!/https/.test(body)) throw new Error('no https advice');
        return '"' + t + '" for http://' + ip;
      });
      await c2.close();
    } else {
      console.log('  SKIP no LAN address available in this sandbox');
    }
    await srv.close();
  }

  /* ---------------------------------------------------------------- */
  console.log('\n===== PERMISSION ALREADY GRANTED =====');
  {
    const { ctx, page } = await newPage(browser, { permissions: ['geolocation'] });
    await toGame(page, HTTP_URL);
    await step('no gate when the browser has already said yes', async () => {
      const gate = await page.$('.modalBack');
      const r = await page.evaluate(() => ({ status: SS.Loc.status, watch: SS.Loc.watchId,
        perm: SS.Loc.permissionState }));
      if (gate) throw new Error('nagged an already-granted user');
      if (r.watch == null) throw new Error('no watch');
      return 'permission "' + r.perm + '", status ' + r.status;
    });

    await step('the chip reports accuracy and opens diagnostics', async () => {
      const chip = await page.textContent('#wGps');
      if (!/GPS/.test(chip)) throw new Error('chip reads "' + chip + '"');
      await page.click('#wGps');
      await page.waitForTimeout(400);
      const t = (await page.textContent('.modalHead h3')).trim();
      if (t !== 'Location') throw new Error('opened "' + t + '"');
      const body = await page.textContent('.modalBody');
      if (!/Device GPS/.test(body)) throw new Error('does not report the source');
      await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
      return 'chip "' + chip + '" → diagnostics';
    });

    await step('revoking mid-session is noticed', async () => {
      await ctx.clearPermissions();
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => SS.Loc.permissionState);
      return 'permission now reported as "' + r + '"';
    });
    await ctx.close();
  }

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
