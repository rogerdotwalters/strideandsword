/* Derive authored monster numbers from the previously balanced built-in
   bestiary, so seeding the editor does not silently change difficulty.
   Prints rows ready to paste into ContentSeed.MONSTERS. */
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext()).newPage();
  await p.route('**cdnjs.cloudflare.com/**', r => r.abort());
  await p.goto('file://' + path.resolve(__dirname, '../public/index.html'));
  await p.waitForTimeout(700);

  const rows = await p.evaluate(() => {
    /* The old Bestiary.spawn maths, before authored content existed. */
    function old(t, lvl, difficulty) {
      const s = 1 + (lvl - 1) * 0.15;
      const str = Math.round(t.str * s), dex = Math.round(t.dex * s);
      const con = Math.round(t.con * s);
      return {
        hp: Math.round(t.hp * s),
        ap: str * 1.25 + dex * 0.5 + difficulty * 1.4,
        armor: Math.round(con * 0.6 + difficulty * 1.1),
        xp: Math.round(t.xp * (1 + (lvl - 1) * 0.13)),
        gold: Math.round(t.gold * (1 + (lvl - 1) * 0.15))
      };
    }
    const templates = BESTIARY.concat(BOSSES);
    const scale = Content.config().scale;
    return ContentSeed.build().monsters.map(m => {
      const t = templates.find(x => x.name === m.name);
      if (!t) return { name: m.name, missing: true };
      // Authored numbers describe the monster at the bottom of its band, and
      // the encounter level there is about equal to the node difficulty.
      const lvl = m.levelMin, diff = m.levelMin;
      const o = old(t, lvl, diff);
      const s = scale[m.rarity];
      const round = (v) => Math.max(1, Math.round(v));
      return {
        name: m.name, rarity: m.rarity,
        baseHp:     round(o.hp / s.hp),
        armor:      round(o.armor / s.armor),
        attackMin:  round(o.ap * 0.86 / s.dmg),
        attackMax:  round(o.ap * 1.14 / s.dmg),
        expReward:  round(o.xp / s.exp),
        goldReward: round(o.gold / s.exp),
        _effHp: o.hp, _effAtk: Math.round(o.ap * 0.86) + "–" + Math.round(o.ap * 1.14),
        _effXp: o.xp
      };
    });
  });

  console.log("name".padEnd(26) + "baseHp  armor  atkMin  atkMax   exp   gold   | effective at band bottom");
  rows.forEach(r => {
    if (r.missing) { console.log(r.name.padEnd(26) + "  ** no built-in template **"); return; }
    console.log(r.name.padEnd(26) +
      String(r.baseHp).padStart(6) + String(r.armor).padStart(7) +
      String(r.attackMin).padStart(8) + String(r.attackMax).padStart(8) +
      String(r.expReward).padStart(6) + String(r.goldReward).padStart(7) +
      "   | hp " + r._effHp + ", dmg " + r._effAtk + ", xp " + r._effXp);
  });
  console.log("\nPASTE:");
  console.log(JSON.stringify(rows.map(r => [r.name, r.baseHp, r.armor, r.attackMin, r.attackMax, r.expReward, r.goldReward])));
  await b.close();
})();
