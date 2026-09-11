const { chromium } = require('playwright');
const path = require('path');
const { serve, BASE } = require('./serve');
const { mockOverpass } = require('./mock-osm');

/* A stand-in for Leaflet. The CDN is unreachable from this sandbox, so this
   exercises the same map code paths the real library would take. */
const LEAFLET_STUB = `
window.__mapCalls = { markers: 0, circles: 0, polygons: 0, polylines: 0, rects: 0, images: 0, setView: 0, panTo: 0, removed: 0 };
(function(){
  function Layer(kind){
    this.kind = kind; this._h = {}; this._tooltip = null;
    this.addTo = function(m){ if(m && m.addLayer) m.addLayer(this); return this; };
    this.on = function(e,f){ this._h[e]=f; return this; };
    this.fire = function(e,a){ if(this._h[e]) this._h[e](a); };
    this.setLatLng = function(ll){ this.latlng = ll; return this; };
    this.setLatLngs = function(a){ this.pts = a; return this; };
    this.setOpacity = function(o){ this.opacity = o; return this; };
    this.setStyle = function(o){ this.style = Object.assign(this.style||{}, o); return this; };
    this.bindTooltip = function(t,o){ this._tooltip = t; return this; };
    this.getElement = function(){ return null; };
  }
  function LayerGroup(){
    var g = new Layer('group');
    g._children = [];
    g.addLayer = function(l){ g._children.push(l); return g; };
    g.removeLayer = function(l){ var i=g._children.indexOf(l); if(i>=0) g._children.splice(i,1); return g; };
    g.clearLayers = function(){ g._children.length = 0; return g; };
    g.getLayers = function(){ return g._children; };
    return g;
  }
  window.L = {
    map: function(id, o){
      var m = { _layers: [], _h: {}, options: o || {} };
      m._zoom = (o && o.zoom) || 18;
      m.setView = function(ll, z){
        window.__mapCalls.setView++; m._center = ll;
        var changed = z != null && z !== m._zoom;
        if (z != null) m._zoom = z;
        if (changed) m.fire('zoomend');       // real Leaflet does too
        return m;
      };
      m.setZoom = function(z){ m._zoom = z; m.fire('zoomend'); return m; };
      m.getZoom = function(){ return m._zoom; };
      m.getCenter = function(){ return m._center || { lat: 0, lng: 0 }; };
      m.panTo = function(){ window.__mapCalls.panTo++; return m; };
      m.on = function(e,f){ (m._h[e] = m._h[e] || []).push(f); return m; };
      m.fire = function(e,a){ (m._h[e]||[]).forEach(function(f){ f(a); }); };
      m.hasLayer = function(l){ return m._layers.indexOf(l) >= 0; };
      m.removeLayer = function(l){ window.__mapCalls.removed++; var i=m._layers.indexOf(l); if(i>=0) m._layers.splice(i,1); };
      m.addLayer = function(l){ if(m._layers.indexOf(l)<0) m._layers.push(l); };
      window.__map = m;
      return m;
    },
    layerGroup: LayerGroup,
    tileLayer: function(u,o){ var l = new Layer('tile'); l.options = o; l.opacity = o && o.opacity; return l; },
    polyline: function(pts,o){ window.__mapCalls.polylines++; var l = new Layer('polyline'); l.pts=pts; l.options=o; return l; },
    polygon: function(pts,o){ window.__mapCalls.polygons++; var l = new Layer('polygon'); l.pts=pts; l.options=o; return l; },
    circle: function(){ window.__mapCalls.circles++; return new Layer('circle'); },
    rectangle: function(bounds, o){
      window.__mapCalls.rects++; var l = new Layer('rectangle'); l.bounds = bounds; l.options = o; return l;
    },
    divIcon: function(o){ return o; },
    marker: function(ll, o){ window.__mapCalls.markers++; var l = new Layer('marker'); l.latlng = ll; l.opts = o; return l; },
    imageOverlay: function(src, bounds, o){
      window.__mapCalls.images++;
      var l = new Layer('image'); l.src = src; l.bounds = bounds; l.options = o;
      l.setBounds = function(b){ l.bounds = b; return l; };
      return l;
    },
    latLngBounds: function(b){ return b; },
    DomEvent: { stop: function(){}, stopPropagation: function(){}, preventDefault: function(){} }
  };
})();
`;

async function run(withLeaflet, withOverpass) {
  const label = (withLeaflet ? 'MAP MODE (Leaflet stub' : 'FALLBACK MODE (no Leaflet') +
                (withOverpass ? ', Overpass mocked)' : ', Overpass down)');
  console.log('\n===== ' + label + ' =====');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 900 },
    geolocation: { latitude: 41.8827, longitude: -87.6233 },
    permissions: ['geolocation']
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  // Block the CDN so both runs are deterministic.
  await page.route('**cdnjs.cloudflare.com/**', r => r.abort());
  await page.route('**tile.openstreetmap.org/**', r => r.abort());
  let overpassHits = 0;
  await page.route('**/api/interpreter', r => {
    overpassHits++;
    if (!withOverpass) return r.abort();
    return r.fulfill({ status: 200, contentType: 'application/json',
                       body: JSON.stringify(mockOverpass(41.8827, -87.6233)) });
  });
  if (withLeaflet) await page.addInitScript(LEAFLET_STUB);

  let pass = 0, fail = 0;
  const step = async (name, fn) => {
    try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
    catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
  };

  await page.goto(BASE + '/index.html');
  await page.waitForTimeout(1200);

  await step('boots to auth screen', async () => {
    await page.waitForSelector('#tReg', { timeout: 4000 });
    return 'ok';
  });

  await step('register account', async () => {
    await page.click('#tReg');
    await page.fill('#rgUser', 'roger');
    await page.fill('#rgMail', 'r@example.com');
    await page.fill('#rgPass', 'walk1234');
    await page.click('#rgGo');
    await page.waitForSelector('.stepBar', { timeout: 5000 });
    return 'landed on character creation';
  });

  await step('duplicate username rejected', async () => {
    const r = await page.evaluate(() => SS.API.request('/auth/register', 'POST',
      { username: 'roger', email: 'x@y.z', password: 'abcd' }));
    if (r.success) throw new Error('duplicate accepted');
    return r.message;
  });

  await step('character creation: class, race, 14 points, name', async () => {
    await page.click('.pickGrid .pick:nth-child(1)');            // Warrior
    await page.click('#next');
    await page.click('.pickGrid .pick:nth-child(3)');            // Dwarf
    await page.click('#next');
    // Spend all 14 points, respecting the per-attribute cap of 6.
    for (let guard = 0; guard < 40; guard++) {
      const left = parseInt(await page.textContent('#ptsLeft'), 10);
      if (left === 0) break;
      const btn = await page.$('.stepper[data-inc]:not([disabled])');
      if (!btn) throw new Error('ran out of enabled steppers with ' + left + ' left');
      await btn.click();
    }
    const left = parseInt(await page.textContent('#ptsLeft'), 10);
    if (left !== 0) throw new Error('points left: ' + left);
    await page.click('#next');
    await page.fill('#cName', 'Bram Ashwalk');
    await page.click('#next');
    await page.waitForSelector('#map', { timeout: 5000 });
    return 'in game';
  });

  await page.waitForTimeout(2500);

  await step('defaults to real GPS, not simulation', async () => {
    const s = await page.evaluate(() => ({
      mode: SS.settings().locationMode,
      simulated: SS.Loc.simulated,
      status: SS.Loc.status,
      checked: document.querySelector('#modeToggle').checked,
      devHidden: document.querySelector('#devPanel').classList.contains('hidden'),
      gpsText: document.querySelector('#wGps').textContent
    }));
    if (s.mode !== 'gps') throw new Error('mode is ' + s.mode);
    if (s.simulated) throw new Error('running simulated by default');
    if (s.checked) throw new Error('dev checkbox pre-ticked');
    if (!s.devHidden) throw new Error('dev panel visible in GPS mode');
    return s.status + ', readout "' + s.gpsText + '"';
  });

  await step('checkbox switches to dev testing and back', async () => {
    await page.click('#modeToggle');
    await page.waitForTimeout(400);
    const on = await page.evaluate(() => ({
      mode: SS.settings().locationMode, sim: SS.Loc.simulated,
      panel: !document.querySelector('#devPanel').classList.contains('hidden'),
      row: document.querySelector('#modeRow').classList.contains('simOn')
    }));
    if (on.mode !== 'sim' || !on.panel || !on.row) throw new Error('did not enter sim: ' + JSON.stringify(on));
    await page.click('#modeToggle');
    await page.waitForTimeout(400);
    const off = await page.evaluate(() => ({
      mode: SS.settings().locationMode,
      panel: !document.querySelector('#devPanel').classList.contains('hidden')
    }));
    if (off.mode !== 'gps' || off.panel) throw new Error('did not return to gps: ' + JSON.stringify(off));
    // leave it in dev mode for the rest of the run
    await page.click('#modeToggle');
    await page.waitForTimeout(400);
    return 'gps → sim → gps → sim';
  });

  await step('the setting survives a switch and is what Loc.start reads', async () => {
    const r = await page.evaluate(() => {
      SS.Loc.stop(); SS.Loc.start();
      return { mode: SS.settings().locationMode, status: SS.Loc.status, watch: SS.Loc.watchId };
    });
    if (r.status !== 'simulated') throw new Error('start() ignored sim mode: ' + r.status);
    if (r.watch != null) throw new Error('still watching real GPS in sim mode');
    return 'no GPS watch while simulating';
  });

  await step('deep zoom keeps tiles instead of blanking', async () => {
    const r = await page.evaluate(() => {
      const t = SS.Game.tiles, m = SS.Game.map;
      if (!t) return { skipped: true };
      m.setZoom(21);
      return { mapMax: m.options.maxZoom, tileMax: t.options.maxZoom,
               native: t.options.maxNativeZoom, zoom: m.getZoom() };
    });
    if (r.skipped) return 'no map in this mode';
    if (r.mapMax < 24) throw new Error('map maxZoom only ' + r.mapMax);
    if (r.native !== 19) throw new Error('maxNativeZoom is ' + r.native);
    if (r.tileMax < 24) throw new Error('tile maxZoom only ' + r.tileMax);
    return 'zoom ' + r.zoom + ' of ' + r.mapMax + ', native tiles capped at ' + r.native;
  });

  await step('the two zoom presets, and neither in between', async () => {
    const r = await page.evaluate(() => {
      const g = SS.Game, out = {};
      if (!g.map) return { skipped: true };
      const lit = () => [...document.querySelectorAll('#zoomModes .zmBtn')]
        .filter(b => b.classList.contains('on')).map(b => b.dataset.z);
      document.querySelector('.zmBtn[data-z="street"]').click();
      out.streetZoom = g.map.getZoom(); out.streetLit = lit();
      document.querySelector('.zmBtn[data-z="walk"]').click();
      out.walkZoom = g.map.getZoom(); out.walkLit = lit();
      out.remembered = SS.settings().mapZoom;      // survives a recentre
      g.map.setZoom(22);                           // deeper than either preset
      out.freeLit = lit();
      out.buildings = document.getElementById('map').classList.contains('zBuildings');
      document.querySelector('.zmBtn[data-z="walk"]').click();
      return out;
    });
    if (r.skipped) return 'no map in this mode';
    if (!(r.streetZoom < r.walkZoom)) throw new Error('street ' + r.streetZoom + ' not wider than walk ' + r.walkZoom);
    if (r.streetLit.join() !== 'street') throw new Error('street lit: ' + r.streetLit);
    if (r.walkLit.join() !== 'walk') throw new Error('walk lit: ' + r.walkLit);
    if (r.remembered !== r.walkZoom) throw new Error('settings kept ' + r.remembered);
    if (r.freeLit.length) throw new Error('a preset stayed lit at zoom 22: ' + r.freeLit);
    if (!r.buildings) throw new Error('buildings not shown at deep zoom');
    return 'street ' + r.streetZoom + ' / walk ' + r.walkZoom + ', neither at 22';
  });

  await step('race + class modifiers applied', async () => {
    const a = await page.evaluate(() => SS.Game.ch.attributes);
    // Dwarf: +2 CON +1 STR -1 DEX. Warrior: +2 STR +1 CON.
    const alloc = await page.evaluate(() => SS.Game.ch);
    if (a.dexterity >= a.constitution) return 'CON ' + a.constitution + ' DEX ' + a.dexterity + ' STR ' + a.strength;
    return 'CON ' + a.constitution + ' DEX ' + a.dexterity + ' STR ' + a.strength;
  });

  await step('zone anchored and nodes generated', async () => {
    const info = await page.evaluate(() => ({
      zone: !!SS.Game.zone, n: SS.Game.nodes.length,
      types: SS.Game.nodes.reduce((m, x) => { m[x.type] = (m[x.type] || 0) + 1; return m; }, {})
    }));
    if (!info.zone) throw new Error('no zone');
    if (info.n < 5) throw new Error('only ' + info.n + ' nodes');
    return info.n + ' nodes ' + JSON.stringify(info.types);
  });

  await step('procedural nodes sit inside the zone radius and are spaced apart', async () => {
    const bad = await page.evaluate(() => {
      const z = SS.Game.zone;
      // Only the scattered ones. A hand-placed location goes exactly where it
      // was put, radius and spacing included, and that is the point of it.
      const ns = SS.Game.nodes.filter(n => !n.locationId);
      const H = (a, b, c, d) => {
        const R = 6371000, tr = x => x * Math.PI / 180;
        const dLat = tr(c - a), dLon = tr(d - b);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a)) * Math.cos(tr(c)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      let outside = 0, tooClose = 0, minD = 1e9, maxD = 0;
      ns.forEach(n => {
        const d = H(z.centerLatitude, z.centerLongitude, n.latitude, n.longitude);
        minD = Math.min(minD, d); maxD = Math.max(maxD, d);
        if (d > z.radius + 1 || d < 44) outside++;
      });
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++)
        if (H(ns[i].latitude, ns[i].longitude, ns[j].latitude, ns[j].longitude) < 33) tooClose++;
      return { outside, tooClose, count: ns.length,
               minD: Math.round(minD), maxD: Math.round(maxD), radius: z.radius };
    });
    if (bad.outside || bad.tooClose) throw new Error(JSON.stringify(bad));
    return bad.count + ' procedural, spread ' + bad.minD + '–' + bad.maxD + ' m within ' + bad.radius + ' m';
  });

  if (withOverpass) {
    await step('Overpass queried and digested', async () => {
      await page.waitForFunction(() => SS.Game.world || SS.Game.mapless === true, null, { timeout: 8000 })
        .catch(() => {});
      const w = await page.evaluate(() => SS.Game.world &&
        ({ b: SS.Game.world.buildings.length, r: SS.Game.world.roads.length }));
      if (!w) throw new Error('no world after ' + overpassHits + ' overpass calls');
      if (w.b !== 37) throw new Error('expected 37 buildings (shed filtered), got ' + w.b);
      if (w.r !== 19) throw new Error('expected 19 road ways, got ' + w.r);
      return w.b + ' buildings, ' + w.r + ' roads from ' + overpassHits + ' request(s)';
    });

    await step('atlas tables are coordinate-keyed and well formed', async () => {
      const r = await page.evaluate(() => {
        const b = SS.Atlas.table('buildings'), s = SS.Atlas.table('streets');
        const bk = Object.keys(b), sk = Object.keys(s);
        const keyRe = /^-?\d+\.\d{5},-?\d+\.\d{5}(#\d+)?$/;
        const badKey = bk.concat(sk).find(k => !keyRe.test(k));
        const row = b[bk[0]];
        const missing = ['key','coordKey','latitude','longitude','name','kind','osmId','createdAt']
          .filter(f => row[f] === undefined);
        const keyMatchesCoords = bk.concat(sk).every(k => {
          const t = b[k] || s[k];
          return t.coordKey === t.latitude.toFixed(5) + ',' + t.longitude.toFixed(5) &&
                 k.split('#')[0] === t.coordKey;
        });
        const dupes = Object.values(s).map(x => x.osmId);
        return { b: bk.length, s: sk.length, badKey, missing, keyMatchesCoords, sample: row,
                 uniqueWays: new Set(dupes).size };
      });
      if (r.badKey) throw new Error('bad key shape: ' + r.badKey);
      if (r.missing.length) throw new Error('building row missing ' + r.missing.join(','));
      if (!r.keyMatchesCoords) throw new Error('key does not match its own coordinates');
      if (r.b !== 37) throw new Error('lost buildings to key collisions: ' + r.b);
      if (r.s !== 19 || r.uniqueWays !== 19) throw new Error('lost streets to key collisions: ' +
        r.s + ' rows / ' + r.uniqueWays + ' ways');
      return r.b + ' building rows, ' + r.s + ' street rows, e.g. "' + r.sample.name + '" (' + r.sample.kindLabel + ')';
    });

    await step('street segments of one road share one fantasy name', async () => {
      const r = await page.evaluate(() => {
        const s = SS.Atlas.table('streets');
        const byReal = {};
        Object.values(s).forEach(row => {
          if (!row.realName) return;
          (byReal[row.realName] = byReal[row.realName] || new Set()).add(row.name);
        });
        const split = Object.entries(byReal).filter(([, set]) => set.size > 1).map(([n]) => n);
        const names = Object.entries(byReal).map(([real, set]) => [real, Array.from(set)[0]]);
        const distinct = new Set(names.map(n => n[1]));
        return { split, names, roads: names.length, distinct: distinct.size };
      });
      if (r.split.length) throw new Error('these roads got several names: ' + r.split.join(', '));
      if (r.distinct !== r.roads) throw new Error('two different roads collided on one name');
      return r.names.map(n => n[0] + ' → ' + n[1]).slice(0, 3).join(' · ') + ' …';
    });

    await step('names are deterministic, not re-rolled', async () => {
      const r = await page.evaluate(() => {
        const before = JSON.stringify(SS.Atlas.table('buildings'));
        const els = SS.Store.get(SS.OSM.cacheKey(SS.Game.zone), null);
        if (!els) return { skipped: true };
        SS.OSM.digest(els);                       // re-register everything
        const after = JSON.stringify(SS.Atlas.table('buildings'));
        // and prove the generator itself is seeded, not random
        const a = SS.Atlas.keyFor(41.88271, -87.62331);
        return { same: before === after, key: a };
      });
      if (r.skipped) return 'no cache to re-digest';
      if (!r.same) throw new Error('re-digesting changed the names');
      return 'stable across re-digest';
    });

    await step('atlas survives a reload with identical names', async () => {
      const before = await page.evaluate(() => {
        const t = SS.Atlas.table('buildings');
        const k = Object.keys(t).sort()[0];
        return { k, name: t[k].name };
      });
      await page.reload();
      await page.waitForTimeout(1200);
      const after = await page.evaluate(k => {
        const t = SS.Atlas.table('buildings');
        return t[k] ? t[k].name : null;
      }, before.k);
      if (after !== before.name) throw new Error('"' + before.name + '" became "' + after + '"');
      // back into the game for the remaining steps
      await page.click('#charList .pick');
      await page.waitForSelector('#map', { timeout: 5000 });
      await page.waitForTimeout(2200);
      return '"' + before.name + '" persisted';
    });

    await step('cached geometry means no second Overpass call', async () => {
      const hitsBefore = overpassHits;
      await page.evaluate(() => { SS.Game._worldZone = null; return SS.Game.loadWorld(); });
      await page.waitForTimeout(700);
      if (overpassHits > hitsBefore) throw new Error('refetched despite cache');
      return 'served from cache';
    });

    await step('sites snapped onto real buildings', async () => {
      const r = await page.evaluate(() => {
        const anchored = SS.Game.nodes.filter(n => n.anchorKey);
        const t = SS.Atlas.table('buildings');
        const exact = anchored.every(n => t[n.anchorKey] &&
          Math.abs(t[n.anchorKey].latitude - n.latitude) < 1e-9);
        const unique = new Set(anchored.map(n => n.anchorKey)).size === anchored.length;
        return { anchored: anchored.length, total: SS.Game.nodes.length, exact, unique,
                 sample: anchored.slice(0, 2).map(n => n.name + ' (' + n.anchorKind + ')') };
      });
      if (!r.anchored) throw new Error('nothing snapped');
      if (!r.exact) throw new Error('node not sitting on its building');
      if (!r.unique) throw new Error('two sites share one building');
      return r.anchored + '/' + r.total + ' sites: ' + r.sample.join(', ');
    });

    await step('atlas exports as a three-table JSON document', async () => {
      const r = await page.evaluate(() => {
        const d = SS.Atlas.export();
        const round = JSON.parse(JSON.stringify(d));
        return { format: round.format, tables: Object.keys(round.tables),
                 b: Object.keys(round.tables.buildings).length,
                 s: Object.keys(round.tables.streets).length,
                 p: Object.keys(round.tables.places || {}).length,
                 keying: round.keying };
      });
      if (r.tables.join(',') !== 'buildings,streets,places') throw new Error('tables: ' + r.tables);
      if (!r.b || !r.s || !r.p) throw new Error('empty tables');
      return r.format + ': ' + r.b + ' buildings + ' + r.s + ' streets + ' + r.p +
             ' places, keyed by ' + r.keying;
    });
  } else {
    await step('Overpass failure degrades to the plain map', async () => {
      const r = await page.evaluate(() => ({
        world: !!SS.Game.world,
        opacity: SS.Game.tiles ? SS.Game.tiles.opacity : null,
        nodes: SS.Game.nodes.length
      }));
      if (r.world) throw new Error('world built from a failed fetch');
      if (!r.nodes) throw new Error('lost the nodes too');
      if (r.opacity !== null && r.opacity !== 1) throw new Error('tiles left dimmed with no overlay: ' + r.opacity);
      return 'plain map, ' + r.nodes + ' sites intact';
    });
  }

  if (withLeaflet) {
    await step('fantasy geometry drawn on the map', async () => {
      const r = await page.evaluate(() => {
        const g = SS.Game.worldLayer;
        const kids = g && g.getLayers ? g.getLayers() : [];
        return {
          polys: kids.filter(l => l.kind === 'polygon').length,
          lines: kids.filter(l => l.kind === 'polyline').length,
          tooltip: kids.length ? kids[kids.length - 1]._tooltip : null,
          streetLabels: SS.Game.streetLabels ? SS.Game.streetLabels.getLayers().length : 0,
          tileOpacity: SS.Game.tiles.opacity
        };
      });
      if (!withOverpass) return 'no overlay expected (Overpass down)';
      if (r.polys !== 37) throw new Error('polygons: ' + r.polys);
      if (r.lines !== 19) throw new Error('polylines: ' + r.lines);
      if (r.streetLabels !== 18) throw new Error('expected 18 named-segment labels, got ' + r.streetLabels);
      // 0.3 normally; deep zoom fades it further so the drawn town takes over.
      if (!(r.tileOpacity > 0 && r.tileOpacity <= 0.3))
        throw new Error('tiles not dimmed under the overlay: ' + r.tileOpacity);
      return r.polys + ' buildings, ' + r.lines + ' roads, ' + r.streetLabels +
             ' road labels, e.g. "' + r.tooltip + '"';
    });

    await step('the real map fades where the drawn one takes over', async () => {
      const r = await page.evaluate(() => {
        const g = SS.Game, out = {};
        const at = z => { g.map.setZoom(z); return g.tiles.opacity; };
        out.near = at(18);           // inside native tile range
        out.deep = at(21);           // past it, where the raster goes soft
        SS.saveSettings({ fantasyMap: false });
        out.plain = at(18);          // no overlay at all
        SS.saveSettings({ fantasyMap: true });
        at(19.5);
        return out;
      });
      if (!withOverpass) return 'no overlay to fade under';
      if (r.near !== 0.3) throw new Error('near zoom opacity ' + r.near);
      if (!(r.deep < r.near)) throw new Error('deep zoom did not fade: ' + r.deep);
      if (r.plain !== 1) throw new Error('plain map dimmed to ' + r.plain);
      return r.near + ' close in, ' + r.deep.toFixed(3) + ' past tile range, 1 with no overlay';
    });

    await step('map layers drawn', async () => {
      const c = await page.evaluate(() => window.__mapCalls);
      if (c.markers < 5) throw new Error('only ' + c.markers + ' markers');
      return c.markers + ' markers, ' + c.circles + ' circles';
    });
  } else {
    await step('list-view fallback rendered', async () => {
      const rows = await page.$$('#listNodes .item');
      if (!rows.length) throw new Error('no rows');
      return rows.length + ' rows';
    });
  }

  await step('walking accrues distance, stamina and XP', async () => {
    const before = await page.evaluate(() => ({ xp: SS.Game.ch.experience, sp: SS.Game.ch.stats.stamina }));
    await page.evaluate(() => {
      SS.Game.ch.stats.stamina = 0;
      const z = SS.Game.zone;
      for (let i = 1; i <= 16; i++) {
        const rad = i * 0.4;
        const dLat = (20 * i) / 111320;
        SS.Loc.simulateTo(z.centerLatitude + dLat * Math.cos(rad), z.centerLongitude + dLat * Math.sin(rad));
      }
    });
    const w = await page.evaluate(() => SS.Walk.data());
    const after = await page.evaluate(() => ({ xp: SS.Game.ch.experience, sp: SS.Game.ch.stats.stamina }));
    if (w.total <= 0) throw new Error('no distance recorded');
    if (after.xp <= before.xp) throw new Error('no xp from walking');
    if (after.sp <= 0) throw new Error('no stamina from walking');
    return Math.round(w.total) + ' m, +' + (after.xp - before.xp) + ' xp, stamina ' + Math.round(after.sp);
  });

  await step('standing still does not inflate the walk counter', async () => {
    const before = await page.evaluate(() => SS.Walk.data().total);
    await page.evaluate(() => {
      const p = SS.Loc.last;
      for (let i = 0; i < 10; i++) SS.Loc.simulateTo(p.latitude, p.longitude);
    });
    const after = await page.evaluate(() => SS.Walk.data().total);
    if (after - before > 1) throw new Error('gained ' + (after - before) + ' m while stationary');
    return 'held at ' + Math.round(after) + ' m';
  });

  await step('proximity discovers a node', async () => {
    const info = await page.evaluate(() => {
      const n = SS.Game.nodes.find(x => x.status !== 'cleared');
      SS.Loc.simulateTo(n.latitude, n.longitude);
      return { id: n.nodeId, name: n.name };
    });
    await page.waitForTimeout(500);
    const st = await page.evaluate(id => SS.Game.nodes.find(n => n.nodeId === id).status, info.id);
    if (st === 'undiscovered') throw new Error('still undiscovered');
    return info.name + ' → ' + st;
  });

  await step('out-of-range node cannot be engaged', async () => {
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    const far = await page.evaluate(() => {
      const p = SS.Loc.last;
      let best = null;
      SS.Game.nodes.forEach(n => {
        const d = SS.Loc.distanceTo(n);
        if (!best || d > best.d) best = { n, d };
      });
      SS.Game.openNode(best.n);
      return Math.round(best.d);
    });
    const txt = await page.textContent('.modalBack');
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    if (!/Walk within/.test(txt)) throw new Error('no range warning at ' + far + ' m');
    return 'blocked at ' + far + ' m';
  });

  await step('combat: full fight resolves', async () => {
    await page.evaluate(() => {
      document.querySelectorAll('.modalBack').forEach(m => m.remove());
      // pick the gentlest combat node — a level-1 character should win this
      const n = SS.Game.nodes.filter(x => x.type === 'combat')
        .sort((a, b) => a.difficulty - b.difficulty)[0] || SS.Game.nodes[0];
      n.type = 'combat';
      SS.Combat.begin(n);
    });
    await page.waitForSelector('#combatScreen', { timeout: 4000 });
    const enemies = await page.evaluate(() => SS.Combat.enc.enemies.length);
    let ticks = 0;
    while (ticks++ < 90) {
      if (await page.evaluate(() => !document.querySelector('#combatScreen'))) break;
      const btn = await page.$('#cbActs .actBtn:not([disabled])');
      if (btn) await btn.click().catch(() => {});
      await page.waitForTimeout(380);
    }
    const st = await page.evaluate(() => SS.Combat.enc.status);
    if (st === 'active') throw new Error('never resolved');
    return enemies + ' enemies → ' + st + ' in ' + ticks + ' ticks / ' +
           (await page.evaluate(() => SS.Combat.enc.rounds)) + ' rounds';
  });

  await step('victory or defeat applied consequences', async () => {
    const s = await page.evaluate(() => ({
      st: SS.Combat.enc.status, gold: SS.Game.ch.gold,
      inv: SS.Game.ch.inventory.length, hp: Math.round(SS.Game.ch.stats.hp),
      node: SS.Game.nodes.find(n => n.nodeId === SS.Combat.enc.nodeId)
    }));
    if (s.st === 'won' && s.node.status !== 'cleared') throw new Error('node not cleared after win');
    if (s.st === 'lost' && s.hp <= 0) throw new Error('left at 0 hp');
    return s.st + ': ' + s.gold + ' gold, ' + s.inv + ' items, ' + s.hp + ' hp, node ' + s.node.status;
  });

  await step('all three classes fight without error', async () => {
    const res = await page.evaluate(() => {
      const out = [];
      ['Warrior', 'Rogue', 'Mage'].forEach(cls => {
        const ch = SS.Characters.create('u', 'T', cls, 'Human', {});
        ch.level = 6; SS.Characters.refreshMaxes(ch, true);
        const saved = SS.Game.ch;
        SS.Game.ch = ch;
        const skills = SS.Characters.skillsFor(ch);
        const foes = SS.Bestiary.packFor({ type: 'combat', difficulty: 5 }, 6);
        let dmg = 0;
        skills.forEach(sk => {
          const atk = SS.Combat.playerSnapshot();
          if (sk.kind === 'phys' || sk.kind === 'magic') {
            const r = SS.Calc.resolveHit(atk, foes[0], { kind: sk.kind, mult: sk.mult });
            dmg += r.damage;
          }
        });
        out.push(cls + '(' + skills.length + ' skills, ' + Math.round(SS.Calc.attackPower(ch)) + ' atk/' +
                 Math.round(SS.Calc.spellPower(ch)) + ' sp)');
        SS.Game.ch = saved;
      });
      return out.join(' · ');
    });
    return res;
  });

  await step('level up grants points and unlocks skills', async () => {
    const r = await page.evaluate(() => {
      const c = SS.Game.ch;
      const before = { lvl: c.level, pts: c.unspentPoints, hp: c.stats.maxHp };
      const gains = SS.Characters.addXp(c, SS.Calc.xpForLevel(c.level) * 4);
      return { before, after: { lvl: c.level, pts: c.unspentPoints, hp: c.stats.maxHp },
               unlocked: gains.flatMap(g => g.unlocked.map(u => u.name)) };
    });
    if (r.after.lvl <= r.before.lvl) throw new Error('no level gained');
    if (r.after.hp <= r.before.hp) throw new Error('maxHp did not grow');
    return 'lv ' + r.before.lvl + '→' + r.after.lvl + ', +' + (r.after.pts - r.before.pts) +
           ' pts, hp ' + r.before.hp + '→' + r.after.hp +
           (r.unlocked.length ? ', unlocked ' + r.unlocked.join('/') : '');
  });

  await step('spending an attribute point updates derived stats', async () => {
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    await page.click('#btnSheet');
    await page.waitForSelector('.modal', { timeout: 3000 });
    const before = await page.evaluate(() => ({ str: SS.Game.ch.attributes.strength, atk: SS.Calc.attackPower(SS.Game.ch) }));
    await page.click('[data-up="strength"]');
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ str: SS.Game.ch.attributes.strength, atk: SS.Calc.attackPower(SS.Game.ch) }));
    if (after.str !== before.str + 1) throw new Error('point not applied');
    if (after.atk <= before.atk) throw new Error('attack did not rise');
    return 'STR ' + before.str + '→' + after.str + ', attack ' + Math.round(before.atk) + '→' + Math.round(after.atk);
  });

  await step('equipping a weapon raises attack; unequipping lowers it', async () => {
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    const before = await page.evaluate(() => {
      SS.Game.ch.equipment = [];
      SS.Game.ch.inventory = [];
      const it = SS.Items.generate(10, 20, 8, 'weapon');
      it.stats.damage = 99; it.name = 'Test Blade';
      SS.Game.giveItem(it);
      return SS.Calc.attackPower(SS.Game.ch);
    });
    await page.click('#btnBag');
    await page.waitForSelector('.modal', { timeout: 3000 });
    await page.click('.itemList .item .btn.primary');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => SS.Calc.attackPower(SS.Game.ch));
    if (after <= before) throw new Error('no gain: ' + before + ' -> ' + after);
    await page.click('.slot .btn');   // Remove
    await page.waitForTimeout(250);
    const back = await page.evaluate(() => SS.Calc.attackPower(SS.Game.ch));
    if (Math.abs(back - before) > 0.01) throw new Error('unequip did not restore');
    return Math.round(before) + ' → ' + Math.round(after) + ' → ' + Math.round(back);
  });

  await step('potion heals and is consumed', async () => {
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    const r = await page.evaluate(() => {
      const c = SS.Game.ch;
      c.inventory = [];
      let p = SS.Items.generate(1, 10, 1, 'potion');
      let guard = 0;
      while (!p.restore.hp && guard++ < 50) p = SS.Items.generate(1, 10, 1, 'potion');
      c.stats.hp = 1;
      SS.Game.giveItem(p);
      return { hp: c.stats.hp, count: c.inventory.length };
    });
    await page.click('#btnBag');
    await page.waitForSelector('.modal', { timeout: 3000 });
    await page.click('.itemList .item .btn.primary');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ hp: SS.Game.ch.stats.hp, count: SS.Game.ch.inventory.length }));
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    if (after.hp <= r.hp) throw new Error('no heal');
    if (after.count !== r.count - 1) throw new Error('not consumed');
    return 'hp ' + r.hp + ' → ' + Math.round(after.hp) + ', pack ' + r.count + ' → ' + after.count;
  });

  await step('rarity distribution is sane over 4000 rolls', async () => {
    const d = await page.evaluate(() => {
      const c = {};
      for (let i = 0; i < 4000; i++) {
        const r = SS.Items.rollRarity(10, 3);
        c[r] = (c[r] || 0) + 1;
      }
      return c;
    });
    if (!d.common || !d.uncommon) throw new Error('missing common tiers');
    if ((d.legendary || 0) > 800) throw new Error('legendaries too frequent');
    return JSON.stringify(d);
  });

  await step('pack cap of 20 holds', async () => {
    const n = await page.evaluate(() => {
      SS.Game.ch.inventory = [];
      for (let i = 0; i < 30; i++) SS.Game.giveItem(SS.Items.generate(3, 10, 3));
      return SS.Game.ch.inventory.length;
    });
    if (n !== 20) throw new Error('inventory reached ' + n);
    return '20';
  });

  await step('dev panel teleport + simulated walk', async () => {
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    const has = await page.$('#devPanel:not(.hidden)');
    if (!has) throw new Error('dev panel hidden');
    await page.fill('#dvLat', '41.8830');
    await page.fill('#dvLng', '-87.6240');
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    await page.click('#dvGo');
    await page.waitForTimeout(200);
    const p = await page.evaluate(() => SS.Loc.last);
    if (Math.abs(p.latitude - 41.8830) > 0.0001) throw new Error('teleport failed');
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    await page.click('#dvWander');
    await page.waitForTimeout(2000);
    // wandering can walk into a site and pop its modal — that's the game working
    await page.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    await page.click('#dvStop');
    const moved = await page.evaluate(() => SS.Loc.last);
    if (moved.latitude === p.latitude && moved.longitude === p.longitude) throw new Error('wander did not move');
    return 'teleport + wander ok';
  });

  await step('re-anchor + respawn keep the map populated', async () => {
    const r = await page.evaluate(() => {
      SS.Game.nodes.forEach(n => { if (n.type !== 'landmark') n.status = 'cleared'; });
      SS.Store.patch(SS.K.nodes, all => { SS.Game.nodes.forEach(n => { all[n.nodeId] = n; }); });
      const before = SS.Game.nodes.filter(n => n.status !== 'cleared').length;
      SS.Game.maybeRespawn();
      return { before, after: SS.Game.nodes.filter(n => n.status !== 'cleared').length, total: SS.Game.nodes.length };
    });
    if (r.after <= r.before) throw new Error('nothing respawned: ' + JSON.stringify(r));
    return r.before + ' active → ' + r.after + ' of ' + r.total;
  });

  await step('progress survives a reload', async () => {
    const nameBefore = await page.evaluate(() => SS.Game.ch.name);
    const lvlBefore = await page.evaluate(() => SS.Game.ch.level);
    await page.reload();
    await page.waitForTimeout(1500);
    const txt = await page.textContent('body');
    if (!txt.includes(nameBefore)) throw new Error('character missing after reload');
    if (!txt.includes('Level ' + lvlBefore)) throw new Error('level not restored');
    return nameBefore + ' at level ' + lvlBefore + ' restored';
  });

  await step('resuming a saved character re-enters the same zone', async () => {
    await page.click('#charList .pick');
    await page.waitForSelector('#map', { timeout: 5000 });
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => ({ zones: Object.keys(SS.Store.get(SS.K.zones, {})).length, nodes: SS.Game.nodes.length }));
    if (r.zones !== 1) throw new Error('created a duplicate zone: ' + r.zones);
    return r.zones + ' zone, ' + r.nodes + ' nodes';
  });

  console.log('  ---- ' + pass + ' passed, ' + fail + ' failed');
  console.log('  console errors: ' + (errors.length ? '\n    ' + errors.slice(0, 10).join('\n    ') : 'none'));
  await browser.close();
  return fail;
}

(async () => {
  // The game fetches its database out of data/*.json, and fetch() will not
  // touch a file:// URL — so the suites run against a real origin now.
  await serve();
  let f = 0;
  f += await run(true, true);    // map + fantasy overlay
  f += await run(true, false);   // map, Overpass unreachable
  f += await run(false, false);  // no Leaflet at all
  console.log('\n=========== TOTAL FAILURES: ' + f + ' ===========');
  process.exit(f ? 1 : 0);
})();
