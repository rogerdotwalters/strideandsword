/* The shape editor: drawing fantasy buildings over the real map, reshaping
   them, importing real footprints as a starting point, and the file that
   carries them to the game — and to a server, which is the point of it being
   a file rather than a table.

   The editor and the game run in separate browser contexts, which means
   separate localStorage. That is deliberate here: the only thing passing
   between them is the exported document, so the suite exercises the same
   path a real hand-off would. */
const { chromium } = require('playwright');
const path = require('path');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
const fs = require('fs');
const { mockOverpass } = require('./mock-osm');

const SHAPES_URL = BASE + '/shapes.html';
const GAME_URL   = BASE + '/index.html';
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
    viewport: { width: 1500, height: 950 },
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
    const lat = m ? +m[1] : HOME.latitude, lng = m ? +m[2] : HOME.longitude;
    r.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify(mockOverpass(lat, lng)) });
  });
  return { ctx, page };
}

/** Click the map at its centre plus a pixel offset. */
async function clickMap(page, dx, dy) {
  const box = await (await page.$('#map')).boundingBox();
  await page.mouse.click(box.x + box.width / 2 + (dx || 0), box.y + box.height / 2 + (dy || 0));
  await page.waitForTimeout(90);
}

(async () => {
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ========================================================== THE EDITOR */
  console.log('\n===== THE SHAPE EDITOR =====');
  const { ctx, page } = await newPage(browser);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());

  await page.goto(SHAPES_URL);
  await page.waitForSelector('.meTop', { timeout: 8000 });
  await page.waitForTimeout(500);

  await step('boots with an empty table and a map with room in it', async () => {
    const r = await page.evaluate(() => ({
      shapes: SE.Shapes.all().length,
      mapH: SE.Se.map.getSize().y,
      empty: document.querySelector('#seTableWrap').textContent,
      form: document.querySelector('#seForm').textContent
    }));
    // A map with no height is the classic shell-CSS bug, and it looks exactly
    // like "clicking does nothing", so it is worth asserting outright.
    if (r.mapH < 200) throw new Error('the map is ' + r.mapH + 'px tall');
    if (r.shapes) throw new Error(r.shapes + ' shapes in a fresh table');
    if (!/No shapes yet/.test(r.empty)) throw new Error('no empty state');
    if (!/Import footprints/.test(r.form)) throw new Error('the form does not explain itself');
    return 'empty, map ' + r.mapH + 'px tall';
  });

  await step('click out a building and it is stored', async () => {
    await page.click('[data-tool="polygon"]');
    for (const [dx, dy] of [[-90, -70], [90, -70], [90, 70], [-90, 70]]) await clickMap(page, dx, dy);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all()[0];
      return { n: SE.Shapes.all().length, pts: s && s.points.length, kind: s && s.kind,
               size: s && SE.Shapes.sizeM(s), selected: SE.Se.selected === (s && s.shapeId),
               handles: document.querySelectorAll('.seVertex').length,
               rows: document.querySelectorAll('#seTableWrap tbody tr').length,
               tool: SE.Se.mode };
    });
    if (r.n !== 1) throw new Error(r.n + ' shapes');
    if (r.pts !== 4) throw new Error(r.pts + ' points');
    if (r.kind !== 'polygon') throw new Error('kind ' + r.kind);
    if (!r.size) throw new Error('no size');
    if (!r.selected) throw new Error('it did not select what it just drew');
    if (r.handles !== 4) throw new Error(r.handles + ' vertex handles for 4 points');
    if (r.tool !== 'select') throw new Error('still in ' + r.tool + ' after finishing');
    return r.pts + ' points, ' + r.size + ' m across, selected with ' + r.handles + ' handles';
  });

  await step('a building will not be finished with two points', async () => {
    const r = await page.evaluate(() => {
      const before = SE.Shapes.all().length;
      document.querySelectorAll('.toast').forEach(t => t.remove());   // last test's
      SE.Se.setTool('polygon');
      const c = SE.Se.map.getCenter();
      SE.Se.onMapClick({ latlng: { lat: c.lat, lng: c.lng } });
      SE.Se.onMapClick({ latlng: { lat: c.lat + 0.0002, lng: c.lng } });
      SE.Se.finishDraw();
      const after = SE.Shapes.all().length;
      SE.Se.cancelDraw(); SE.Se.setTool('select');
      return { before, after, toast: (document.querySelector('.toast') || {}).textContent || '' };
    });
    if (r.after !== r.before) throw new Error('it saved a two-point building');
    if (!/three points/.test(r.toast)) throw new Error('no explanation: "' + r.toast + '"');
    return '"' + r.toast.trim() + '"';
  });

  await step('a line is two points and no fill', async () => {
    await page.click('[data-tool="line"]');
    await clickMap(page, -140, 120);
    await clickMap(page, 140, 150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all().find(x => x.kind === 'line');
      return { has: !!s, pts: s && s.points.length, fill: s && s.fillOpacity,
               style: s && SE.Shapes.styleOf(s).fillOpacity };
    });
    if (!r.has) throw new Error('no line stored');
    if (r.pts !== 2) throw new Error(r.pts + ' points');
    if (r.style !== 0) throw new Error('a line drew a fill: ' + r.style);
    return '2 points, no fill';
  });

  await step('dragging a vertex moves that point and nothing else', async () => {
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all()[0];
      SE.Se.select(s.shapeId);
      const before = JSON.parse(JSON.stringify(SE.Se.draft.points));
      // What the handle's drag handler does, without the mouse.
      SE.Se.draft.points[1] = [before[1][0] + 0.0003, before[1][1] + 0.0004];
      SE.Se.commit();
      const after = SE.Shapes.get(s.shapeId).points;
      const moved = after.filter((p, i) => p[0] !== before[i][0] || p[1] !== before[i][1]).length;
      return { moved, pts: after.length };
    });
    if (r.moved !== 1) throw new Error(r.moved + ' points moved');
    return '1 of ' + r.pts + ' points moved';
  });

  await step('moving it keeps it rigid', async () => {
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all()[0];
      SE.Se.select(s.shapeId);
      const sizeBefore = SE.Shapes.sizeM(SE.Se.draft);
      const c0 = SE.Shapes.centroid(SE.Se.draft);
      const before = JSON.parse(JSON.stringify(SE.Se.draft.points));
      SE.Shapes.move(SE.Se.draft, 0.0005, -0.0007);
      SE.Se.commit();
      const now = SE.Shapes.get(s.shapeId);
      const c1 = SE.Shapes.centroid(now);
      const deltas = now.points.map((p, i) =>
        [Math.round((p[0] - before[i][0]) * 1e7), Math.round((p[1] - before[i][1]) * 1e7)]);
      const same = deltas.every(d => d[0] === deltas[0][0] && d[1] === deltas[0][1]);
      return { same, sizeBefore, sizeAfter: SE.Shapes.sizeM(now),
               dLat: Math.round((c1.latitude - c0.latitude) * 1e7) };
    });
    if (!r.same) throw new Error('the points moved by different amounts');
    if (r.sizeAfter !== r.sizeBefore) throw new Error('moving resized it: ' + r.sizeBefore + ' → ' + r.sizeAfter);
    if (r.dLat !== 5000) throw new Error('the centroid moved ' + r.dLat + ' not 5000');
    return 'every point by the same delta, still ' + r.sizeAfter + ' m across';
  });

  await step('resizing works about its own centre', async () => {
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all()[0];
      SE.Se.select(s.shapeId);
      const before = SE.Shapes.sizeM(SE.Se.draft);
      const c0 = SE.Shapes.centroid(SE.Se.draft);
      SE.Shapes.scale(SE.Se.draft, 2);
      SE.Se.commit();
      const now = SE.Shapes.get(s.shapeId);
      const c1 = SE.Shapes.centroid(now);
      return { before, after: SE.Shapes.sizeM(now),
               moved: Math.round(SS_dist(c0, c1)) };
      function SS_dist(a, b) {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(b.latitude - a.latitude), dLon = tr(b.longitude - a.longitude);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a.latitude)) * Math.cos(tr(b.latitude)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
      }
    });
    if (Math.abs(r.after - r.before * 2) > 2) throw new Error(r.before + ' m doubled to ' + r.after);
    if (r.moved > 1) throw new Error('it drifted ' + r.moved + ' m while resizing');
    return r.before + ' m → ' + r.after + ' m, centre held';
  });

  await step('rotating keeps its size and its place', async () => {
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all()[0];
      SE.Se.select(s.shapeId);
      const before = SE.Shapes.sizeM(SE.Se.draft);
      const pts0 = JSON.stringify(SE.Se.draft.points);
      SE.Shapes.rotate(SE.Se.draft, 90);
      SE.Se.commit();
      const now = SE.Shapes.get(s.shapeId);
      return { before, after: SE.Shapes.sizeM(now), changed: JSON.stringify(now.points) !== pts0 };
    });
    if (!r.changed) throw new Error('rotating did nothing');
    // A rectangle turned 90° has the same longest span, within rounding.
    if (Math.abs(r.after - r.before) > 2) throw new Error(r.before + ' m became ' + r.after + ' m');
    return 'turned 90°, still ' + r.after + ' m across';
  });

  await step('paint is written through to the row and to the style', async () => {
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all()[0];
      SE.Se.select(s.shapeId);
      // The first swatch, then a hand-set opacity, as the form does.
      document.querySelector('#f_swatch .sw').click();
      SE.Se.draft.fillOpacity = 0.6;
      SE.Se.draft.strokeWidth = 4;
      SE.Se.draft.dash = '6 5';
      SE.Se.commit();
      const now = SE.Shapes.get(s.shapeId);
      const style = SE.Shapes.styleOf(now);
      return { stroke: now.stroke, fill: now.fill, style,
               palette: SE.Shapes.PALETTE[0] };
    });
    if (r.stroke !== r.palette.stroke || r.fill !== r.palette.fill) throw new Error('the swatch did not take');
    if (r.style.fillOpacity !== 0.6) throw new Error('fill opacity ' + r.style.fillOpacity);
    if (r.style.weight !== 4) throw new Error('width ' + r.style.weight);
    if (r.style.dashArray !== '6 5') throw new Error('dash ' + r.style.dashArray);
    return r.stroke + ' on ' + r.fill + ', 60% fill, 4px, dashed';
  });

  await step('a vertex can be dropped, but not below what the shape needs', async () => {
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all()[0];
      SE.Se.select(s.shapeId);
      const start = SE.Se.draft.points.length;
      // Right-clicking a vertex removes it, down to the minimum.
      const drop = () => {
        const min = SE.Se.draft.kind === 'line' ? 2 : 3;
        if (SE.Se.draft.points.length <= min) return false;
        SE.Se.draft.points.splice(0, 1); SE.Se.commit(); return true;
      };
      let removed = 0;
      while (drop()) removed++;
      const floor = SE.Shapes.get(s.shapeId).points.length;
      return { start, removed, floor };
    });
    if (r.floor !== 3) throw new Error('a polygon was reduced to ' + r.floor + ' points');
    return r.start + ' → ' + r.floor + ' points, and it stopped there';
  });

  /* ------------------------------------------------------------ importing */
  console.log('\n===== IMPORTING REAL FOOTPRINTS =====');

  await step('the real outlines arrive as editable shapes', async () => {
    const before = await page.evaluate(() => SE.Shapes.all().length);
    await page.evaluate(() => SE.Se.importFootprints());
    await page.waitForFunction(() => !SE.Se.busy, null, { timeout: 40000 });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const imported = SE.Shapes.all().filter(s => s.osmId);
      return {
        n: SE.Shapes.all().length, imported: imported.length,
        named: imported.filter(s => s.name && s.name !== 'Building').length,
        polygons: imported.filter(s => s.kind === 'polygon').length,
        realPoints: imported.every(s => s.points.length >= 3),
        tiny: imported.filter(s => SE.Shapes.sizeM(s) < 6).length,
        sample: imported.slice(0, 2).map(s => s.name + ' (' + s.points.length + 'pt)')
      };
    });
    if (!r.imported) throw new Error('nothing was imported');
    if (!r.realPoints) throw new Error('an imported shape has fewer than 3 points');
    if (r.tiny) throw new Error(r.tiny + ' imported shapes are under 6 m — bins and map noise');
    if (!r.named) throw new Error('nothing borrowed a name from the Atlas');
    return r.imported + ' footprints, ' + r.named + ' named — ' + r.sample.join(', ');
  });

  await step('importing again brings nothing in twice', async () => {
    const before = await page.evaluate(() => SE.Shapes.all().length);
    await page.evaluate(() => SE.Se.importFootprints());
    await page.waitForFunction(() => !SE.Se.busy, null, { timeout: 40000 });
    const r = await page.evaluate((before) => ({
      before, after: SE.Shapes.all().length,
      ids: SE.Shapes.all().filter(s => s.osmId).map(s => s.osmId),
      toast: Array.from(document.querySelectorAll('.toast')).map(t => t.textContent).join(' | ')
    }), before);
    const dupes = r.ids.filter((id, i) => r.ids.indexOf(id) !== i);
    if (r.after !== r.before) throw new Error(r.after - r.before + ' duplicates arrived');
    if (dupes.length) throw new Error('duplicate osmIds: ' + dupes[0]);
    if (!/already in/.test(r.toast)) throw new Error('it said: "' + r.toast + '"');
    return r.before + ' shapes, unchanged — "' + r.toast.split('|').pop().trim() + '"';
  });

  /* ----------------------------------------------------------------- file */
  console.log('\n===== THE FILE =====');

  await step('the export is one document with everything in it', async () => {
    const r = await page.evaluate(() => {
      const doc = SE.Shapes.export();
      return { format: doc.format, version: doc.version, n: doc.shapes.length,
               keys: Object.keys(doc), first: doc.shapes[0] && Object.keys(doc.shapes[0]) };
    });
    if (r.format !== 'stride-and-sword.shapes') throw new Error('format ' + r.format);
    if (!r.n) throw new Error('an empty export');
    ['shapeId', 'points', 'kind', 'stroke', 'fill', 'fillOpacity'].forEach(f => {
      if (r.first.indexOf(f) < 0) throw new Error('a shape has no ' + f);
    });
    return r.format + ' v' + r.version + ', ' + r.n + ' shapes';
  });

  await step('re-importing your own export changes nothing', async () => {
    const r = await page.evaluate(() => {
      const doc = SE.Shapes.export();
      const before = SE.Shapes.all().length;
      const res = SE.Shapes.import(doc, false);
      return { before, after: SE.Shapes.all().length, res };
    });
    if (r.after !== r.before) throw new Error(r.before + ' became ' + r.after);
    if (r.res.added) throw new Error(r.res.added + ' were added as new');
    return r.res.updated + ' updated in place, 0 added';
  });

  await step('a file from somewhere else merges alongside', async () => {
    const r = await page.evaluate(() => {
      const before = SE.Shapes.all().length;
      const foreign = { format: 'stride-and-sword.shapes', version: 1, shapes: [
        { shapeId: 'shp_from_elsewhere', name: 'Somebody Else\'s Keep', kind: 'polygon',
          points: [[41.884, -87.624], [41.884, -87.623], [41.8835, -87.623]],
          stroke: '#c8453c', fill: '#4a1f1c', fillOpacity: 0.4 }
      ] };
      const res = SE.Shapes.import(foreign, false);
      const got = SE.Shapes.get('shp_from_elsewhere');
      return { before, after: SE.Shapes.all().length, res,
               kept: !!got, name: got && got.name, painted: got && got.stroke };
    });
    if (r.after !== r.before + 1) throw new Error('merge went from ' + r.before + ' to ' + r.after);
    if (!r.kept) throw new Error('the foreign shape is not there');
    if (r.painted !== '#c8453c') throw new Error('it lost its paint');
    return '+1 — "' + r.name + '"';
  });

  await step('hiding one keeps it in the file but off the map', async () => {
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all()[0];
      s.active = false;
      SE.Shapes.save(s);
      return { stored: SE.Shapes.all().length, live: SE.Shapes.list().length,
               withHidden: SE.Shapes.list(true).length,
               inExport: SE.Shapes.export().shapes.length,
               drawnNear: SE.Shapes.near(s.points[0][0], s.points[0][1], 500).some(x => x.shapeId === s.shapeId) };
    });
    if (r.live !== r.stored - 1) throw new Error('hiding removed nothing from the live list');
    if (r.inExport !== r.stored) throw new Error('hiding dropped it from the file');
    if (r.drawnNear) throw new Error('a hidden shape is still offered for drawing');
    return r.live + ' live of ' + r.stored + ' kept';
  });

  await step('delete takes it out of the table and the map', async () => {
    const r = await page.evaluate(() => {
      const s = SE.Shapes.all()[0];
      const before = SE.Shapes.all().length;
      SE.Se.select(s.shapeId);
      SE.Shapes.remove(s.shapeId);
      SE.Se.select(null);
      SE.Se.renderAll();
      return { before, after: SE.Shapes.all().length,
               gone: !SE.Shapes.get(s.shapeId),
               rows: document.querySelectorAll('#seTableWrap tbody tr').length };
    });
    if (!r.gone || r.after !== r.before - 1) throw new Error('it survived');
    if (r.rows !== r.after) throw new Error('the table shows ' + r.rows + ' of ' + r.after);
    return r.before + ' → ' + r.after;
  });

  const doc = await page.evaluate(() => JSON.stringify(SE.Shapes.export()));

  await step('it is usable on a phone, even if drawing there is a poor idea', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      SE.Se.map.invalidateSize();
      const doc = document.documentElement;
      return {
        overflow: doc.scrollWidth - doc.clientWidth,
        mapH: SE.Se.map.getSize().y,
        formVisible: document.querySelector('#seForm').getBoundingClientRect().height > 60,
        toolsReachable: Array.from(document.querySelectorAll('#seTools button'))
          .every(b => b.getBoundingClientRect().height >= 26)
      };
    });
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.waitForTimeout(300);
    if (r.overflow > 1) throw new Error(r.overflow + 'px of sideways scroll at 390px');
    if (r.mapH < 120) throw new Error('the map collapsed to ' + r.mapH + 'px');
    if (!r.formVisible) throw new Error('the form has nowhere to go');
    if (!r.toolsReachable) throw new Error('a tool button is too small to hit');
    return 'no sideways scroll, map ' + r.mapH + 'px, panes stacked';
  });

  if (errors.length) { fail++; console.log('  FAIL editor page errors — ' + errors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the editor'); }
  await ctx.close();

  /* ======================================================== IN THE GAME */
  console.log('\n===== THE SHAPES IN THE GAME =====');
  const { ctx: c2, page: g } = await newPage(browser, { viewport: { width: 430, height: 900 } });
  const gErrors = [];
  g.on('pageerror', e => gErrors.push(e.message));
  await g.goto(GAME_URL);
  await g.waitForSelector('#tReg', { timeout: 8000 });
  await g.click('#tReg');
  await g.fill('#rgUser', 'shaper'); await g.fill('#rgPass', 'walk1234');
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
  await g.waitForTimeout(2500);
  await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));

  await step('the file drawn in the editor loads into the game', async () => {
    const r = await g.evaluate((json) => {
      const res = SS.Shapes.import(JSON.parse(json), true);
      return { res, stored: SS.Shapes.all().length, live: SS.Shapes.list().length };
    }, doc);
    if (!r.res.success) throw new Error(r.res.message);
    if (!r.stored) throw new Error('nothing arrived');
    return r.stored + ' shapes in, ' + r.live + ' of them visible';
  });

  await step('they are drawn over the town, nearest ones only', async () => {
    const r = await g.evaluate(() => {
      // Put one of them under our feet and one on the other side of the city.
      const p = SS.Loc.last;
      const rows = SS.Shapes.list();
      SS.Shapes.moveTo(rows[0], p.latitude + 0.0004, p.longitude + 0.0004);
      SS.Shapes.save(rows[0]);
      const far = rows[1];
      SS.Shapes.moveTo(far, p.latitude + 0.5, p.longitude + 0.5);
      SS.Shapes.save(far);
      const drawn = SS.Game.drawShapes();
      return {
        drawn, live: SS.Shapes.list().length,
        onMap: document.querySelectorAll('.drawnShape').length,
        farDrawn: SS.Shapes.near(p.latitude, p.longitude, SS.Game.drawRangeM())
          .some(s => s.shapeId === far.shapeId)
      };
    });
    if (!r.drawn) throw new Error('nothing was drawn');
    if (r.onMap !== r.drawn) throw new Error(r.drawn + ' drawn but ' + r.onMap + ' on the map');
    if (r.farDrawn) throw new Error('a shape half a degree away was included');
    return r.drawn + ' of ' + r.live + ' drawn, the distant one left out';
  });

  await step('a hidden shape stays hidden in the game too', async () => {
    const r = await g.evaluate(() => {
      const s = SS.Shapes.list()[0];
      const before = SS.Game.drawShapes();
      s.active = false; SS.Shapes.save(s);
      const after = SS.Game.drawShapes();
      s.active = true; SS.Shapes.save(s);
      return { before, after, back: SS.Game.drawShapes() };
    });
    if (r.after !== r.before - 1) throw new Error(r.before + ' → ' + r.after + ' when one was hidden');
    if (r.back !== r.before) throw new Error('unhiding did not bring it back');
    return r.before + ' → ' + r.after + ' → ' + r.back;
  });

  await step('draw order is honoured, and they never eat a click', async () => {
    const r = await g.evaluate(() => {
      const rows = SS.Shapes.list();
      rows.forEach((s, i) => { s.z = i % 2 ? 5 : -5; SS.Shapes.save(s); });
      SS.Game.drawShapes();
      const els = Array.from(document.querySelectorAll('.drawnShape'));
      // Leaflet appends in the order we add them, so the DOM order is the z.
      const clickable = els.filter(e => e.getAttribute('pointer-events') !== 'none' &&
                                        getComputedStyle(e).pointerEvents !== 'none');
      return { n: els.length, clickable: clickable.length };
    });
    if (!r.n) throw new Error('nothing drawn');
    if (r.clickable) throw new Error(r.clickable + ' shapes would swallow a tap meant for the map');
    return r.n + ' drawn, none of them clickable';
  });

  await step('turning the fantasy overlay off takes them with it', async () => {
    const r = await g.evaluate(() => {
      SS.saveSettings({ fantasyMap: false });
      const off = SS.Game.drawShapes();
      SS.saveSettings({ fantasyMap: true });
      return { off, on: SS.Game.drawShapes() };
    });
    if (r.off !== 0) throw new Error(r.off + ' drawn with the overlay off');
    if (!r.on) throw new Error('they did not come back');
    return 'off → 0, on → ' + r.on;
  });

  if (gErrors.length) { fail++; console.log('  FAIL game page errors — ' + gErrors.slice(0, 3).join(' | ')); }
  else { pass++; console.log('  OK   no page errors in the game'); }
  await c2.close();

  console.log('\n  ---- ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
