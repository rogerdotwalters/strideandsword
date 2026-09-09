const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext()).newPage();
  await p.route('**cdnjs.cloudflare.com/**', r => r.abort());
  await p.goto('file://' + path.resolve(__dirname, '../public/index.html'));
  await p.waitForTimeout(800);

  const out = await p.evaluate(() => {
    const S = window.SS;
    // Headless auto-battle: player always uses the best affordable skill,
    // drinks nothing, never flees. A pessimistic floor on real play.
    function simulate(cls, level, difficulty, nodeType) {
      const alloc = {};
      // spread 14 points the way a sensible player would for the class
      const favor = { Warrior: ['strength','constitution'], Rogue: ['dexterity','luck'], Mage: ['intelligence','wisdom'] }[cls];
      alloc[favor[0]] = 6; alloc[favor[1]] = 6; alloc.constitution = (alloc.constitution || 0) + 2;
      const ch = S.Characters.create('u', 'Sim', cls, 'Human', alloc);
      ch.level = level;
      // level-up points spent in the same favoured attributes
      for (let i = 1; i < level; i++) { ch.attributes[favor[0]] += 3; ch.attributes[favor[1]] += 2; }
      // gear roughly matching level
      ch.equipment = [S.Items.generate(level, 12, 3, 'weapon'), S.Items.generate(level, 12, 3, 'armor')];
      S.Characters.refreshMaxes(ch, true);

      const foes = S.Bestiary.packFor({ type: nodeType, difficulty }, level);
      const skills = S.Characters.skillsFor(ch);
      let rounds = 0;
      while (rounds++ < 40) {
        const atk = {
          attackPower: S.Calc.attackPower(ch), spellPower: S.Calc.spellPower(ch),
          accuracy: S.Calc.accuracy(ch), critChance: S.Calc.critChance(ch),
          armor: S.Calc.armor(ch), magicDefense: S.Calc.magicDefense(ch),
          evasion: S.Calc.evasion(ch), critResist: S.Calc.critResist(ch)
        };
        const alive = foes.filter(f => f.alive);
        if (!alive.length) return { win: true, rounds, hpLeft: ch.stats.hp / ch.stats.maxHp };
        // best affordable damage skill, else basic attack
        const usable = skills.filter(sk => (sk.kind === 'phys' || sk.kind === 'magic') &&
          ch.stats[sk.res] >= sk.cost).sort((a, c) => (c.mult || 0) - (a.mult || 0));
        const sk = usable[0];
        const targets = sk && sk.target === 'all' ? alive : [alive[0]];
        if (sk) ch.stats[sk.res] -= sk.cost;
        targets.forEach(t => {
          const r = S.Calc.resolveHit(atk, t, { kind: sk ? sk.kind : 'phys', mult: sk ? sk.mult : 1, critBonus: sk ? (sk.critBonus || 0) : 0 });
          if (r.hit) { t.hp -= r.damage; if (t.hp <= 0) t.alive = false; }
        });
        foes.filter(f => f.alive).forEach(f => {
          const r = S.Calc.resolveHit(f, atk, { kind: f.caster ? 'magic' : 'phys' });
          if (r.hit) ch.stats.hp -= r.damage;
        });
        if (ch.stats.hp <= 0) return { win: false, rounds, hpLeft: 0 };
        ch.stats.stamina = Math.min(ch.stats.maxStamina, ch.stats.stamina + ch.stats.maxStamina * 0.05);
        ch.stats.mana = Math.min(ch.stats.maxMana, ch.stats.mana + ch.stats.maxMana * 0.04);
      }
      return { win: false, rounds, hpLeft: ch.stats.hp / ch.stats.maxHp, timeout: true };
    }

    const rows = [];
    [['Warrior',1],['Rogue',1],['Mage',1],['Warrior',5],['Rogue',5],['Mage',5],['Warrior',10],['Mage',10]].forEach(([cls, lvl]) => {
      const line = { cls, lvl, d: {} };
      [1,2,3,4,5,6,8,10].forEach(diff => {
        let wins = 0, rSum = 0, hp = 0;
        const N = 400;
        for (let i = 0; i < N; i++) { const r = simulate(cls, lvl, diff, 'combat'); if (r.win) { wins++; hp += r.hpLeft; } rSum += r.rounds; }
        line.d[diff] = { win: Math.round(wins / N * 100), rounds: +(rSum / N).toFixed(1), hp: wins ? Math.round(hp / wins * 100) : 0 };
      });
      rows.push(line);
    });
    // boss check
    const boss = {};
    [1,5,10].forEach(lvl => {
      let w = 0; for (let i = 0; i < 300; i++) if (simulate('Warrior', lvl, 6, 'boss').win) w++;
      boss[lvl] = Math.round(w / 300 * 100);
    });
    return { rows, boss };
  });

  console.log('win% (avg rounds, avg HP% remaining on a win)\n');
  const diffs = [1,2,3,4,5,6,8,10];
  console.log('class/lvl '.padEnd(14) + diffs.map(d => ('d' + d).padStart(16)).join(''));
  out.rows.forEach(r => {
    console.log((r.cls + ' L' + r.lvl).padEnd(14) +
      diffs.map(d => (r.d[d].win + '% (' + r.d[d].rounds + 'r,' + r.d[d].hp + '%)').padStart(16)).join(''));
  });
  console.log('\nBoss node (difficulty 6) as Warrior: ' + JSON.stringify(out.boss));
  await b.close();
})();
