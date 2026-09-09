const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { mockOverpass } = require('./mock-osm');

const LEAFLET_JS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2,
    geolocation: { latitude: 41.8827, longitude: -87.6233 }, permissions: ['geolocation'] });
  const p = await ctx.newPage();

  // Serve the real Leaflet from node_modules; the CDN is blocked in this sandbox.
  await p.route('**/leaflet.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS }));
  await p.route('**/leaflet.min.css', r => r.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS }));
  // Tiles are unreachable here; paint a flat ground so the vectors are judged alone.
  await p.route('**tile.openstreetmap.org/**', r => r.abort());
  await p.route('**/api/interpreter', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(mockOverpass(41.8827, -87.6233)) }));

  await p.goto('file://' + path.resolve(__dirname, '../public/index.html'));
  await p.waitForTimeout(900);
  await p.screenshot({ path: path.resolve(__dirname, 'screenshots/shot1_auth.png') });

  await p.click('#tReg'); await p.fill('#rgUser', 'roger'); await p.fill('#rgPass', 'walk1234');
  await p.click('#rgGo'); await p.waitForSelector('.stepBar');
  await p.click('.pickGrid .pick:nth-child(2)'); await p.click('#next');
  await p.click('.pickGrid .pick:nth-child(2)'); await p.click('#next');
  for (let g = 0; g < 40; g++) {
    const l = parseInt(await p.textContent('#ptsLeft'), 10); if (!l) break;
    const btn = await p.$('.stepper[data-inc]:not([disabled])'); if (!btn) break; await btn.click();
  }
  await p.click('#next'); await p.fill('#cName', 'Bram Ashwalk'); await p.click('#next');
  await p.waitForSelector('#map');
  await p.waitForFunction(() => window.SS && SS.Game.world, null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(2500);
  await p.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  await p.screenshot({ path: path.resolve(__dirname, 'screenshots/shot4_game.png') });

  // zoomed in: street + building labels, GPS mode
  await p.evaluate(() => { SS.Game.map.setZoom(19.5); });
  await p.waitForTimeout(800);
  await p.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  await p.screenshot({ path: path.resolve(__dirname, 'screenshots/shot8_fantasy_zoom.png') });

  // dev mode on, so the panel shows
  await p.click('#modeToggle');
  await p.waitForTimeout(700);
  await p.evaluate(() => { SS.Game.map.setZoom(17); });
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  await p.screenshot({ path: path.resolve(__dirname, 'screenshots/shot9_devmode.png') });

  // building inspector
  await p.evaluate(() => {
    const t = SS.Atlas.table('buildings');
    SS.Game.describeBuilding(t[Object.keys(t)[3]]);
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.resolve(__dirname, 'screenshots/shot10_building.png') });
  await p.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));

  // menu
  await p.click('#btnMenu'); await p.waitForTimeout(500);
  await p.screenshot({ path: path.resolve(__dirname, 'screenshots/shot11_menu.png'), fullPage: true });
  await p.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));

  await b.close();
  console.log('shots done');
})();
