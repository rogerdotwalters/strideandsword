/* Faces: what a creature looks like, and where.

   Two components and one rule about which goes where:

     · a **token** — a circle with a ring coloured by difficulty — on the map,
       where a creature is a dot among other dots
     · a **portrait** — a framed rectangle showing the whole picture — in a
       fight and in the panels, where there is room to look at it

   Three things are worth a suite of their own:

     the fallback   the game shipped as emoji and has to keep working with no
                    art at all, so every face falls back rather than leaving a
                    hole — including when the file is a bad path
     the plumbing   a picture uploaded in the editor has to survive the save,
                    the reload, and the walk from a monster row to the enemy
                    standing in front of you
     the sizing     Leaflet resets `width:auto` on every image inside its
                    marker pane, with a selector more specific than ours, and
                    a 256 px portrait at natural size covers the whole map.
                    That one is a regression guard, not a theory. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { serve, BASE } = require('./serve');
const { emptyDatabase } = require('./fixtures');
const { mockOverpass } = require('./mock-osm');

const GAME_URL   = BASE + '/index.html';
const EDITOR_URL = BASE + '/editor.html';
const SHAPES_URL = BASE + '/shapes.html';
const PORTRAIT   = path.resolve(__dirname, 'fixtures-portrait.png');
const LEAFLET_JS  = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

const HOME = { latitude: 41.8827, longitude: -87.6233 };

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const r = await fn(); pass++; console.log('  OK   ' + name + (r ? '  — ' + r : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '  — ' + String(e.message).split('\n')[0]); }
}

async function newPage(browser, viewport) {
  const ctx = await browser.newContext({
    viewport: viewport || { width: 430, height: 900 },
    geolocation: HOME, permissions: ['geolocation']
  });
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

(async () => {
  await serve();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ================================================== THE COMPONENTS ====== */
  console.log('\n===== A CIRCLE, AND A FRAME =====');

  const { ctx, page: g } = await newPage(browser);
  const errors = [];
  g.on('pageerror', e => errors.push(e.message));
  g.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  await intoTheGame(g, 'faces');
  await g.waitForFunction(() => !!window.SS && !!window.SS.Art, null, { timeout: 8000 });

  // The fixture, as a data URL, so the page can hand it around like an upload.
  const FACE = 'data:image/png;base64,' + fs.readFileSync(PORTRAIT).toString('base64');

  await step('the ring says difficulty, and nothing else is a difficulty', async () => {
    const r = await g.evaluate(() => ({
      easy: SS.Art.difficultyColor(1),
      mid: SS.Art.difficultyColor(6),
      hard: SS.Art.difficultyColor(10),
      over: SS.Art.difficultyColor(40),
      friendly: SS.Art.difficultyColor(0),
      // Read out of the page: `SS` is a global in the browser, not in node,
      // and comparing against it out here is a ReferenceError, not a failure.
      FRIENDLY: SS.Art.FRIENDLY
    }));
    const rgb = (s) => (s.match(/\d+/g) || []).map(Number);
    const [er, , eb] = rgb(r.easy), [hr] = rgb(r.hard);
    if (!(hr > er)) throw new Error('10 is not redder than 1: ' + r.easy + ' vs ' + r.hard);
    if (r.over !== r.hard) throw new Error('40 was not clamped to 10');
    if (r.friendly !== r.FRIENDLY) throw new Error('0 should be the friendly colour, got ' + r.friendly);
    if (r.mid === r.easy || r.mid === r.hard) throw new Error('the middle is not interpolated');
    return '1 ' + r.easy + ' · 6 ' + r.mid + ' · 10 ' + r.hard + ' · 0 ' + r.friendly;
  });

  await step('a picture is shown; without one the emoji still is', async () => {
    const r = await g.evaluate((face) => {
      const withArt = SS.Art.tokenHtml({ image: face, icon: '🐗', difficulty: 4, size: 34, badge: 4 });
      const without = SS.Art.tokenHtml({ icon: '🐗', difficulty: 4, size: 34 });
      return { withArt, without };
    }, FACE);
    if (!/<img/.test(r.withArt)) throw new Error('the picture did not make it into the token');
    if (/<img/.test(r.without)) throw new Error('a token with no picture drew an img anyway');
    if (!/class="em"/.test(r.without)) throw new Error('nothing fell back to the emoji');
    if (!/--ring:/.test(r.withArt)) throw new Error('no ring colour on the token');
    return 'picture when there is one, emoji when there is not';
  });

  await step('a bad path falls back rather than leaving a hole', async () => {
    const r = await g.evaluate(async () => {
      await new Promise(res => SS.Art.aspect('art/does-not-exist.png', res));
      return { broken: SS.Art.broken('art/does-not-exist.png'),
               html: SS.Art.tokenHtml({ image: 'art/does-not-exist.png', icon: '🐗', difficulty: 2 }) };
    });
    if (!r.broken) throw new Error('a missing file was not noticed');
    if (/<img/.test(r.html)) throw new Error('it drew the broken image anyway');
    if (!/class="em"/.test(r.html)) throw new Error('it did not fall back to the emoji');
    return 'missing file → the emoji';
  });

  await step('an oversized picture is redrawn small rather than refused', async () => {
    const r = await g.evaluate(async (face) => {
      const before = face.length;
      const small = await SS.Art.shrink(face, 256);
      const im = new Image();
      const size = await new Promise(res => {
        im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight);
        im.onerror = () => res('0x0');
        im.src = small;
      });
      return { before, after: small.length, size };
    }, FACE);
    const [w, h] = r.size.split('x').map(Number);
    if (Math.max(w, h) > 256) throw new Error('it came back ' + r.size);
    /* Pixels, not bytes. A flat picture can re-encode *larger* at a quarter
       the size — this fixture does — which is exactly why `shrink` stopped
       comparing lengths and keeps the redraw either way. The byte check here
       is only a guard against it ballooning. */
    if (r.after > r.before * 1.5) throw new Error('it ballooned: ' + r.before + ' → ' + r.after);
    return Math.round(r.before / 1024) + ' KB → ' + Math.round(r.after / 1024) + ' KB, ' + r.size;
  });

  await step('something that is not an image is refused in words', async () => {
    const why = await g.evaluate(async () => {
      const f = new File([new Blob(['nope'])], 'notes.txt', { type: 'text/plain' });
      try { await SS.Art.readPortrait(f); return ''; } catch (e) { return e.message; }
    });
    if (!/not an image/i.test(why)) throw new Error('the refusal was "' + why + '"');
    return why;
  });

  /* ==================================================== ON THE MAP ======== */
  console.log('\n===== ON THE MAP =====');

  await step('a monster with a picture wears it on the map', async () => {
    const r = await g.evaluate((face) => {
      // One park, so there is something alive near enough to draw.
      const p = SS.Loc.last;
      SS.Haunts.set('park1', SS.Haunts.fromPoint(p.latitude, p.longitude, 'park1', 'forest',
                                                 'The Elder Ring', 90));
      SS.Content.list('monsters').forEach(m => { m.portrait = face; SS.Content.save('monsters', m); });
      SS.Game.drawDenizens();
      const beasts = (SS.Game._denizens || []).filter(d => d.kind === 'creature');
      return {
        beasts: beasts.length,
        withFace: beasts.filter(d => d.portrait).length,
        imgs: document.querySelectorAll('.leaflet-marker-pane .tok img').length
      };
    }, FACE);
    if (!r.beasts) throw new Error('nothing alive near the player to draw');
    if (r.withFace !== r.beasts) throw new Error(r.withFace + ' of ' + r.beasts + ' carried the picture');
    if (!r.imgs) throw new Error('none of them drew it');
    return r.beasts + ' creatures, ' + r.imgs + ' pictures on the map';
  });

  await step('a token in a map pin is the size it asked for', async () => {
    /* The regression guard. Leaflet resets `width:auto` on any img inside its
       marker pane, with a selector more specific than ours, so the portrait
       came out at its natural 256 px and covered the map. */
    const r = await g.evaluate(() => {
      const im = document.querySelector('.leaflet-marker-pane .tok img');
      if (!im) return null;
      const box = im.getBoundingClientRect();
      const tok = im.closest('.tok').getBoundingClientRect();
      return { imgW: Math.round(box.width), tokW: Math.round(tok.width),
               natural: im.naturalWidth };
    });
    if (!r) throw new Error('no token on the map to measure');
    if (r.imgW > r.tokW + 1) throw new Error('the picture is ' + r.imgW + ' px inside a ' + r.tokW + ' px token');
    if (r.natural < 200) throw new Error('the fixture is too small to prove anything');
    return r.natural + ' px picture drawn at ' + r.imgW + ' px';
  });

  await step('the ring on the map is the creature’s own difficulty', async () => {
    const r = await g.evaluate(() => {
      const d = (SS.Game._denizens || []).find(x => x.kind === 'creature');
      const el = document.querySelector('[data-denizen="' + d.denizenId + '"]');
      return { want: SS.Art.difficultyColor(d.difficulty),
               got: el ? getComputedStyle(el).getPropertyValue('--ring').trim() : '',
               difficulty: d.difficulty };
    });
    if (!r.got) throw new Error('that creature drew no token');
    if (r.got !== r.want) throw new Error('ring is ' + r.got + ', difficulty ' + r.difficulty + ' wants ' + r.want);
    return 'difficulty ' + r.difficulty + ' → ' + r.got;
  });

  await step('somebody who is not a fight gets the friendly ring', async () => {
    const r = await g.evaluate(() => {
      const d = (SS.Game._denizens || []).find(x => x.kind === 'character');
      if (!d) return { skip: true };
      const el = document.querySelector('[data-denizen="' + d.denizenId + '"]');
      return { got: el ? getComputedStyle(el).getPropertyValue('--ring').trim() : '',
               want: SS.Art.FRIENDLY, name: d.name };
    });
    if (r.skip) throw new Error('no character nearby — the sample buildings should have put one there');
    if (r.got !== r.want) throw new Error(r.name + ' has a ' + r.got + ' ring');
    return r.name + ' → ' + r.got;
  });

  /* ==================================================== IN A FIGHT ======== */
  console.log('\n===== IN A FIGHT =====');

  await step('the enemy is a framed picture, and you are beside it', async () => {
    const r = await g.evaluate((face) => {
      SS.Content.setPortrait('class:' + SS.Game.ch.class, face);
      const n = SS.Game.nodes.find(x => x.type === 'combat') || SS.Game.nodes[0];
      n.status = 'discovered';
      SS.Loc.last = { latitude: n.latitude, longitude: n.longitude, accuracy: 5 };
      SS.Combat.begin(n);
      const foe = document.querySelector('#cbEnemies .port');
      const you = document.querySelector('.cbYou .port');
      return {
        foes: document.querySelectorAll('#cbEnemies .port').length,
        foeImg: !!(foe && foe.querySelector('img')),
        youImg: !!(you && you.querySelector('img')),
        fit: foe ? getComputedStyle(foe.querySelector('img') || foe).objectFit : '',
        badge: foe ? (foe.querySelector('.portBadge') || {}).textContent : '',
        ring: foe ? getComputedStyle(foe).getPropertyValue('--ring').trim() : '',
        want: SS.Art.difficultyColor(SS.Combat.enc.enemies[0].difficulty || n.difficulty)
      };
    }, FACE);
    if (!r.foes) throw new Error('no enemy portrait in the fight');
    if (!r.foeImg) throw new Error('the enemy portrait has no picture in it');
    if (!r.youImg) throw new Error('your own portrait has no picture in it');
    if (r.fit !== 'contain') throw new Error('the portrait crops rather than showing the whole picture');
    if (!/Lv/.test(r.badge || '')) throw new Error('no level on the frame: "' + r.badge + '"');
    if (r.ring !== r.want) throw new Error('the enemy ring is ' + r.ring + ', expected ' + r.want);
    return r.foes + ' framed, ' + r.badge + ', ring ' + r.ring;
  });

  await step('a dead enemy’s frame goes grey', async () => {
    const r = await g.evaluate(() => {
      const e = SS.Combat.enc.enemies[0];
      e.alive = false; e.hp = 0;
      SS.Combat.render();
      const port = document.querySelector('#cbEnemies .port');
      return { cls: port ? port.className : '', filter: port ? getComputedStyle(port).filter : '' };
    });
    if (!/dead/.test(r.cls)) throw new Error('the frame is still "' + r.cls + '"');
    if (!/grayscale/.test(r.filter)) throw new Error('it is not greyed: ' + r.filter);
    return 'greyed out';
  });

  await step('your class portrait is on the chip and the sheet, and survives a reload', async () => {
    await g.evaluate(() => {
      document.querySelectorAll('#combatScreen,.modalBack').forEach(x => x.remove());
      SS.Game.inCombat = false;
    });
    await g.reload();
    await g.waitForSelector('#charList .pick', { timeout: 10000 });
    const onPicker = await g.evaluate(() =>
      !!document.querySelector('#charList .pick .port img'));
    await g.click('#charList .pick');
    await g.waitForSelector('#map', { timeout: 8000 });
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    const r = await g.evaluate(() => {
      SS.Panels.sheet();
      return {
        chip: !!document.querySelector('#chAvatar .port img'),
        sheet: !!document.querySelector('.modalBack .port img'),
        stored: !!SS.Content.classPortrait(SS.Game.ch.class)
      };
    });
    await g.evaluate(() => document.querySelectorAll('.modalBack').forEach(m => m.remove()));
    if (!r.stored) throw new Error('the class portrait did not survive the reload');
    if (!onPicker) throw new Error('the character picker has no face on it');
    if (!r.chip) throw new Error('the chip has no face on it');
    if (!r.sheet) throw new Error('the character sheet has no face on it');
    return 'picker, chip and sheet';
  });

  await step('nothing threw along the way', async () => {
    if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
    return 'clean console';
  });

  await ctx.close();

  /* ==================================================== THE EDITORS ======= */
  console.log('\n===== AUTHORING A FACE =====');

  const { ctx: ectx, page: e } = await newPage(browser, { width: 1400, height: 900 });
  const eErrors = [];
  e.on('pageerror', ev => eErrors.push(ev.message));
  await e.goto(EDITOR_URL);
  await e.waitForSelector('#edTabs', { timeout: 10000 });
  await e.waitForTimeout(600);

  await step('the Portraits tab offers one card per class', async () => {
    await e.click('[data-tab="portraits"]');
    await e.waitForTimeout(250);
    const r = await e.evaluate(() => ({
      cards: document.querySelectorAll('.portCard').length,
      names: Array.from(document.querySelectorAll('.portCard b')).map(b => b.textContent),
      frames: document.querySelectorAll('.portCard .port').length,
      form: document.querySelector('#edForm').classList.contains('hidden')
    }));
    if (r.cards !== 3) throw new Error(r.cards + ' cards: ' + r.names.join(', '));
    if (r.frames !== 3) throw new Error('only ' + r.frames + ' of them drew a frame');
    if (!r.form) throw new Error('the CRUD form is still showing on a tab with no rows');
    return r.names.join(' · ');
  });

  await step('uploading a class portrait stores it, shrunk', async () => {
    await e.setInputFiles('#pf_Warrior', PORTRAIT);
    await e.waitForTimeout(900);
    const r = await e.evaluate(() => {
      const url = Content.portrait('class:Warrior');
      return { len: url.length, isData: /^data:image\/png/.test(url),
               img: !!document.querySelector('.portCard .port img') };
    });
    if (!r.isData) throw new Error('what was stored is not an image');
    if (r.len > 300 * 1024) throw new Error('it was stored at ' + Math.round(r.len / 1024) + ' KB');
    if (!r.img) throw new Error('the card did not redraw with it');
    return Math.round(r.len / 1024) + ' KB stored';
  });

  await step('clearing one takes it out of the table', async () => {
    await e.evaluate(() => document.querySelector('[data-clear="class:Warrior"]').click());
    await e.waitForTimeout(400);
    const still = await e.evaluate(() => !!Content.portrait('class:Warrior'));
    if (still) throw new Error('it is still there');
    return 'gone';
  });

  await step('a monster’s form shows both faces and saves the picture', async () => {
    await e.click('[data-tab="monsters"]');
    await e.waitForTimeout(300);
    await e.evaluate(() => { const r = document.querySelector('tbody tr'); if (r) r.click(); });
    await e.waitForTimeout(300);
    const both = await e.evaluate(() => ({
      tok: document.querySelectorAll('#f_portRow .tok').length,
      port: document.querySelectorAll('#f_portRow .port').length
    }));
    if (both.tok !== 1 || both.port !== 1) throw new Error('the form shows ' + JSON.stringify(both));
    await e.setInputFiles('#f_portraitFile', PORTRAIT);
    await e.waitForTimeout(900);
    await e.click('#edSave');
    await e.waitForTimeout(400);
    const r = await e.evaluate(() => {
      const id = Ed.selected;
      const row = Content.get('monsters', id);
      return { saved: !!(row && row.portrait), name: row && row.name,
               drawn: !!document.querySelector('#f_portRow .tok img') };
    });
    if (!r.saved) throw new Error('the picture was not saved on the row');
    if (!r.drawn) throw new Error('the preview did not pick it up');
    return r.name + ' now has a face';
  });

  await step('what the editor saved is what the game fights', async () => {
    const r = await e.evaluate(() => {
      const row = Content.list('monsters').find(m => m.portrait);
      const enemy = Content.toEnemy(row, 5, 3);
      return { name: enemy.name, portrait: !!enemy.portrait, difficulty: enemy.difficulty };
    });
    if (!r.portrait) throw new Error('the enemy came out faceless');
    if (r.difficulty !== 5) throw new Error('the enemy carries difficulty ' + r.difficulty);
    if (eErrors.length) throw new Error(eErrors.slice(0, 2).join(' | '));
    return r.name + ', difficulty ' + r.difficulty;
  });

  await ectx.close();

  /* The shape editor gives a hand-drawn character a face the same way. */
  const { ctx: sctx, page: sp } = await newPage(browser, { width: 1400, height: 900 });
  const sErrors = [];
  sp.on('pageerror', ev => sErrors.push(ev.message));
  await sp.goto(SHAPES_URL);
  await sp.waitForSelector('#shTools, .meTop', { timeout: 10000 });
  await sp.waitForTimeout(700);

  await step('a drawn character can be given a face too', async () => {
    const r = await sp.evaluate(() => {
      const Shapes = SE.Shapes;
      const s = Shapes.blank('polygon', [[41.883, -87.624], [41.883, -87.622], [41.8815, -87.622]]);
      s.purpose = 'zone'; s.zoneKind = 'character'; s.name = 'The tanner';
      const saved = Shapes.save(s);
      SE.Se.select(saved.shapeId);
      return { form: document.querySelectorAll('.portRow .tok, .portRow .port').length,
               upload: !!document.querySelector('#z_portFile'),
               field: 'npcPortrait' in saved };
    });
    if (!r.field) throw new Error('a zone has nowhere to put a face');
    if (!r.upload) throw new Error('no upload on the character form');
    if (r.form !== 2) throw new Error('the form drew ' + r.form + ' previews');
    await sp.setInputFiles('#z_portFile', PORTRAIT);
    await sp.waitForTimeout(900);
    const saved = await sp.evaluate(() => {
      const z = SE.Shapes.list().find(x => x.zoneKind === 'character');
      return { stored: !!(z && z.npcPortrait), len: (z && z.npcPortrait || '').length };
    });
    if (!saved.stored) throw new Error('the face was not written to the shape');
    if (sErrors.length) throw new Error(sErrors.slice(0, 2).join(' | '));
    return Math.round(saved.len / 1024) + ' KB on the drawn character';
  });

  await sctx.close();
  await browser.close();

  console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' OK, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();
