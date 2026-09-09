/* -------------------------------------------------------------------------
   17. Node interaction
   ------------------------------------------------------------------------- */
Object.assign(Game, {
  openNode(n) {
    if (this.inCombat) return;
    const d = Loc.distanceTo(n);
    const s = settings();
    const inRange = d != null && d <= s.interactRange;
    const cleared = n.status === "cleared";

    const typeLabel = { combat: "Combat site", treasure: "Cache", boss: "Boss lair", landmark: "Landmark" }[n.type];
    let body =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<div class="avatar" style="width:46px;height:46px;font-size:24px">' + n.icon + "</div>" +
        "<div><b style='font-size:15px'>" + esc(n.name) + "</b><br>" +
        '<span class="tiny dim">' + typeLabel +
        (n.type !== "landmark" ? " · Difficulty " + n.difficulty + "/10" : "") + "</span></div></div>" +
      '<div class="kv"><span>Distance</span><b>' + fmtDist(d) + "</b></div>" +
      '<div class="kv"><span>From home</span><b>' + fmtDist(n.distanceFromHome) + "</b></div>" +
      (n.anchorKind ? '<div class="kv"><span>Standing on</span><b>' + esc(cap(n.anchorKind)) + "</b></div>" : "") +
      '<div class="kv"><span>Status</span><b>' + cap(n.status) + "</b></div>";

    if (n.type !== "landmark" && !cleared) {
      body += '<div class="kv"><span>Expected reward</span><b>' +
        n.rewards.experience + " XP · " + n.rewards.gold + " g</b></div>";
    }
    if (!inRange && !cleared) {
      body += '<p class="tiny" style="color:var(--warn);margin:12px 0 0">' +
        "Walk within " + s.interactRange + " m to interact. You're " + fmtDist(d) + " away." +
        "</p>";
    }

    const buttons = [{ label: "Close", cls: "ghost" }];
    if (!cleared && inRange) {
      if (n.type === "combat" || n.type === "boss") {
        buttons.push({ label: n.type === "boss" ? "Challenge" : "Engage", cls: "danger",
          onClick: () => { Combat.begin(n); } });
      } else if (n.type === "treasure") {
        buttons.push({ label: "Open", cls: "primary", onClick: () => { this.looseTreasure(n); } });
      } else {
        buttons.push({ label: "Rest here", cls: "primary", onClick: () => { this.restAt(n); } });
      }
    }
    UI.modal({ title: cleared ? "Cleared" : typeLabel, icon: n.icon, body, buttons,
               onClose: () => { this._pendingNode = null; } });
  },

  looseTreasure(n) {
    const c = this.ch;
    const gold = Math.round(n.rewards.gold * rnd(0.85, 1.3));
    c.gold += gold;
    const rolls = 1 + (chance(28 + c.attributes.luck) ? 1 : 0);
    const got = [];
    for (let i = 0; i < rolls; i++) {
      const it = Items.generate(c.level, c.attributes.luck, n.difficulty);
      if (this.giveItem(it)) got.push(it);
    }
    const xp = Math.round(n.rewards.experience);
    Characters.addXp(c, xp).forEach(g => this.announceLevel(g));
    Zones.updateNode(n, { status: "cleared", clearedAt: nowTs() });
    this.drawNode(n);
    Characters.save(c);
    this.renderHud();
    this.maybeRespawn();

    UI.modal({
      title: "Cache opened", icon: "📦",
      body: '<div class="rewardRow"><span class="ic">🪙</span><div><b>' + gold + " gold</b></div></div>" +
            '<div class="rewardRow"><span class="ic">★</span><div><b>' + xp + " experience</b></div></div>" +
            got.map(it =>
              '<div class="rewardRow"><span class="ic">' + Content.itemIconHtml(it, 20) + '</span><div><b class="c-' + it.rarity + '">' +
              esc(it.name) + '</b><br><span class="tiny dim mono">' + esc(it.effect) + "</span></div></div>").join(""),
      buttons: [{ label: "Take it all", cls: "primary" }]
    });
  },

  restAt(n) {
    const c = this.ch;
    const heal = Math.round(c.stats.maxHp * 0.45);
    c.stats.hp = clamp(c.stats.hp + heal, 0, c.stats.maxHp);
    c.stats.mana = c.stats.maxMana;
    c.stats.stamina = c.stats.maxStamina;
    Zones.updateNode(n, { status: "cleared", clearedAt: nowTs() });
    this.drawNode(n);
    Characters.save(c);
    this.renderHud();
    UI.toast("Rested. +" + heal + " HP, mana and stamina restored.", "good", 3600);
  },

  maybeRespawn() {
    if (!this.zone) return;
    const made = Zones.respawnCleared(this.zone, this.ch.level);
    if (made > 0) {
      this.nodes = Zones.nodesIn(this.zone.zoneId);
      this.drawNodes();
      UI.toast(made + " new site" + (made > 1 ? "s have" : " has") + " appeared nearby.", "info", 3600);
    }
  }
});

/* -------------------------------------------------------------------------
   18. Combat
   ------------------------------------------------------------------------- */
const Combat = {
  enc: null, node: null, root: null, targetIdx: 0, busy: false, buffs: null,

  playerSnapshot() {
    const c = Game.ch;
    return {
      name: c.name,
      attackPower: Calc.attackPower(c), spellPower: Calc.spellPower(c),
      armor: Calc.armor(c) * (this.buffs && this.buffs.armorPct ? 1 + this.buffs.armorPct : 1),
      magicDefense: Calc.magicDefense(c),
      accuracy: Calc.accuracy(c), evasion: Calc.evasion(c) + (this.buffs ? this.buffs.evasion || 0 : 0),
      critChance: Calc.critChance(c), critResist: Calc.critResist(c),
      tempEvasion: 0
    };
  },

  begin(node) {
    const c = Game.ch;
    if (c.stats.hp <= 1) { UI.toast("Too hurt to fight. Rest or drink something.", "bad"); return; }
    Game.inCombat = true;
    this.node = node;
    this.buffs = { armorPct: 0, evasion: 0, regen: 0, rounds: 0, guaranteedCrit: false };
    this.targetIdx = 0;
    this.busy = false;

    const enemies = Bestiary.packFor(node, c.level);
    this.enc = {
      encounterId: uid("enc"), nodeId: node.nodeId, characterId: c.characterId,
      enemies, status: "active", rounds: 0, defending: false,
      startedAt: nowTs(), endedAt: null, log: []
    };
    Store.patch(K.encounters, (all) => { all[this.enc.encounterId] = this.enc; });
    API.request("/combat/start", "POST", this.enc);

    this.mount();
    this.log("sys", "You are set upon at <b>" + esc(node.name) + "</b>.");
    if (node.type === "boss") this.log("sys", "This one has been waiting.");
    this.render();
  },

  mount() {
    this.root = el("div");
    this.root.id = "combatScreen";
    this.root.innerHTML =
      '<div class="cbHead">' +
        '<span style="font-size:19px">' + this.node.icon + "</span>" +
        "<h3>" + esc(this.node.name) + "</h3>" +
        '<span class="badge" id="cbRound">Round 1</span>' +
      "</div>" +
      '<div class="cbEnemies" id="cbEnemies"></div>' +
      '<div class="cbLogWrap"><div class="cbLog" id="cbLog"></div></div>' +
      '<div class="cbActions">' +
        '<div class="bar" style="margin-bottom:9px"><span class="lbl">❤</span>' + UI.bar("hp", 1, 1) + '<span class="num" id="cbHp"></span></div>' +
        '<div class="bar" style="margin-bottom:11px"><span class="lbl" id="cbResIco">⚡</span>' + UI.bar("sp", 1, 1) + '<span class="num" id="cbRes"></span></div>' +
        '<div class="actGrid" id="cbActs"></div>' +
      "</div>";
    document.body.appendChild(this.root);
  },

  unmount() {
    if (this.root) this.root.remove();
    this.root = null;
    Game.inCombat = false;
  },

  log(kind, html) {
    if (!this.enc) return;
    this.enc.log.push({ kind, html, t: nowTs() });
    const host = $("#cbLog");
    if (!host) return;
    const line = el("div", "logLine " + kind, html);
    host.appendChild(line);
    const wrap = host.parentElement;
    wrap.scrollTop = wrap.scrollHeight;
    while (host.children.length > 90) host.removeChild(host.firstChild);
  },

  living() { return this.enc.enemies.filter(e => e.alive); },

  render() {
    const c = Game.ch;
    $("#cbRound").textContent = "Round " + (this.enc.rounds + 1);

    const host = $("#cbEnemies");
    host.innerHTML = "";
    this.enc.enemies.forEach((e, i) => {
      const d = el("div", "enemy" + (e.alive ? "" : " dead") + (i === this.targetIdx && e.alive ? " target" : ""));
      d.id = "en_" + e.enemyId;
      d.innerHTML =
        '<div class="face">' + e.icon + "</div>" +
        '<div class="info"><div class="top"><b>' + esc(e.name) + "</b>" +
          '<span class="tiny dimmer">Lv ' + e.level + (e.boss ? " · BOSS" : "") + "</span></div>" +
          UI.bar("hp", e.hp, e.maxHp) +
          '<div class="hpnum">' + Math.max(0, Math.round(e.hp)) + " / " + e.maxHp +
          (e.slowed > 0 ? "  ❄ slowed" : "") + "</div></div>";
      if (e.alive) d.onclick = () => { this.targetIdx = i; this.render(); };
      host.appendChild(d);
    });

    const resKey = CLASSES[c.class].resource;
    $("#cbResIco").textContent = resKey === "mana" ? "✦" : "⚡";
    setB("cbHp", "hp", c.stats.hp, c.stats.maxHp);
    setB("cbRes", resKey === "mana" ? "mp" : "sp",
         resKey === "mana" ? c.stats.mana : c.stats.stamina,
         resKey === "mana" ? c.stats.maxMana : c.stats.maxStamina);
    const resFill = $("#cbRes").parentElement.querySelector(".fill");
    resFill.className = "fill " + (resKey === "mana" ? "mp" : "sp");

    const acts = $("#cbActs");
    acts.innerHTML = "";
    const mk = (icon, label, sub, disabled, fn) => {
      const b = el("button", "actBtn");
      b.innerHTML = '<span class="ic">' + icon + "</span>" + label + (sub ? "<small>" + sub + "</small>" : "");
      b.disabled = !!disabled || this.busy;
      b.onclick = fn;
      acts.appendChild(b);
      return b;
    };
    mk("⚔️", "Attack", "free", false, () => this.playerAttack());
    Characters.skillsFor(c).forEach(sk => {
      const pool = sk.res === "mana" ? c.stats.mana : c.stats.stamina;
      mk(sk.icon, sk.name, sk.cost + " " + (sk.res === "mana" ? "MP" : "SP"),
         pool < sk.cost, () => this.useSkill(sk));
    });
    mk("🧪", "Item", "potions", false, () => this.itemMenu());
    mk("🛡️", "Defend", "+50% def", false, () => this.defend());
    mk("🏃", "Flee", "risky", false, () => this.flee());

    function setB(id, kind, cur, max) {
      const n = $("#" + id);
      n.textContent = Math.round(cur) + " / " + Math.round(max);
      const f = n.parentElement.querySelector(".fill");
      f.style.width = (max > 0 ? clamp(cur / max * 100, 0, 100) : 0) + "%";
    }
  },

  floatDamage(enemyId, text, color) {
    const host = enemyId === "player" ? $(".cbActions") : $("#en_" + enemyId);
    if (!host) return;
    const f = el("div", "floatDmg", text);
    f.style.color = color || "#fff";
    f.style.left = (30 + Math.random() * 40) + "%";
    f.style.top = "6px";
    host.style.position = "relative";
    host.appendChild(f);
    setTimeout(() => f.remove(), 950);
  },

  shake(enemyId) {
    const n = $("#en_" + enemyId);
    if (!n) return;
    n.classList.add("hit");
    setTimeout(() => n.classList.remove("hit"), 320);
  },

  /* ---- Player actions ---- */
  currentTarget() {
    let e = this.enc.enemies[this.targetIdx];
    if (!e || !e.alive) {
      const idx = this.enc.enemies.findIndex(x => x.alive);
      this.targetIdx = idx;
      e = this.enc.enemies[idx];
    }
    return e;
  },

  playerAttack() {
    const target = this.currentTarget();
    if (!target) return;
    this.busy = true; this.render();
    const atk = this.playerSnapshot();
    const opts = { kind: "phys", mult: 1, guaranteedCrit: this.buffs.guaranteedCrit };
    const r = Calc.resolveHit(atk, target, opts);
    this.buffs.guaranteedCrit = false;
    this.applyToEnemy(target, r, "You strike");
    this.afterPlayerAction();
  },

  useSkill(sk) {
    const c = Game.ch;
    const poolKey = sk.res === "mana" ? "mana" : "stamina";
    if (c.stats[poolKey] < sk.cost) { UI.toast("Not enough " + sk.res + ".", "bad"); return; }
    c.stats[poolKey] -= sk.cost;
    this.busy = true; this.render();
    const atk = this.playerSnapshot();

    if (sk.kind === "buff") {
      Object.assign(this.buffs, sk.buff, { rounds: sk.buff.rounds });
      this.log("you", "<b>" + sk.name + "</b> — " + esc(sk.desc));
    } else if (sk.kind === "heal") {
      const amount = Math.round(atk.spellPower * sk.mult);
      c.stats.hp = clamp(c.stats.hp + amount, 0, c.stats.maxHp);
      this.floatDamage("player", "+" + amount, "#6cbd74");
      this.log("you", "<b>" + sk.name + "</b> knits you back together for <b>" + amount + "</b>.");
    } else {
      let targets = [];
      if (sk.target === "all") targets = this.living();
      else if (sk.target === "random3") {
        const alive = this.living();
        for (let i = 0; i < 3 && alive.length; i++) targets.push(pick(alive));
      } else {
        const t = this.currentTarget();
        if (t) targets = [t];
      }
      this.log("you", "<b>" + sk.name + "</b>!");
      targets.forEach(t => {
        if (!t.alive) return;
        let mult = sk.mult;
        if (sk.execute && t.hp / t.maxHp < 0.3) mult *= 2;
        const r = Calc.resolveHit(atk, t, {
          kind: sk.kind === "magic" ? "magic" : "phys",
          mult, critBonus: sk.critBonus || 0,
          guaranteedCrit: this.buffs.guaranteedCrit
        });
        this.buffs.guaranteedCrit = false;
        this.applyToEnemy(t, r, sk.name);
        if (sk.applies && sk.applies.slow && t.alive) t.slowed = sk.applies.slow + 1;
      });
    }
    this.afterPlayerAction();
  },

  applyToEnemy(target, r, verb) {
    if (!r.hit) {
      this.log("you", "<b>" + esc(verb) + "</b> — and misses " + esc(target.name) + ".");
      this.floatDamage(target.enemyId, "miss", "#8892a4");
      return;
    }
    target.hp -= r.damage;
    this.shake(target.enemyId);
    this.floatDamage(target.enemyId, "-" + r.damage, r.crit ? "#e0a33e" : "#f0f4fa");
    this.log(r.crit ? "crit" : "you",
      "<b>" + esc(verb) + "</b> — " + esc(target.name) + " takes <b>" + r.damage + "</b>" +
      (r.crit ? " <b>· critical!</b>" : "") + ".");
    if (target.hp <= 0) {
      target.hp = 0; target.alive = false;
      this.log("sys", "<b>" + esc(target.name) + "</b> goes down.");
    }
  },

  defend() {
    this.busy = true;
    this.enc.defending = true;
    this.log("you", "You brace behind your guard.");
    this.render();
    this.afterPlayerAction();
  },

  itemMenu() {
    const c = Game.ch;
    const potions = (c.inventory || []).filter(i => i.type === "potion");
    if (!potions.length) { UI.toast("No potions in the pack.", "bad"); return; }
    const list = el("div", "itemList");
    potions.forEach(p => {
      const row = el("div", "item r-" + p.rarity);
      row.innerHTML = '<span class="ico">' + Content.itemIconHtml(p, 18) + '</span><div class="body"><div class="nm">' +
        esc(p.name) + '</div><div class="ds">' + esc(p.effect) + "</div></div>";
      const b = el("button", "btn sm primary", "Drink");
      b.onclick = () => { m.close(); this.drink(p); };
      const acts = el("div", "acts"); acts.appendChild(b); row.appendChild(acts);
      list.appendChild(row);
    });
    const m = UI.modal({ title: "Use an item", icon: "🎒", body: list });
  },

  drink(p) {
    const c = Game.ch;
    const before = { hp: c.stats.hp, mana: c.stats.mana, stamina: c.stats.stamina };
    for (const k in p.restore) c.stats[k] = clamp(c.stats[k] + p.restore[k], 0, c.stats["max" + cap(k)]);
    const healed = Math.round(c.stats.hp - before.hp);
    if (healed > 0) this.floatDamage("player", "+" + healed, "#6cbd74");
    c.inventory.splice(c.inventory.findIndex(i => i.itemId === p.itemId), 1);
    Store.patch(K.inventories, (all) => { all[c.characterId] = c.inventory; });
    this.busy = true;
    this.log("you", "You drink <b>" + esc(p.name) + "</b>.");
    this.render();
    this.afterPlayerAction();
  },

  flee() {
    const c = Game.ch;
    const fastest = this.living().reduce((m, e) => Math.max(m, e.attributes.dexterity), 0);
    const odds = clamp(48 + (Calc.effectiveAttrs(c).dexterity - fastest) * 3.5 +
                       (this.node.type === "boss" ? -25 : 0), 8, 92);
    this.busy = true; this.render();
    if (chance(odds)) {
      this.log("sys", "You break away and run.");
      setTimeout(() => this.end("fled"), 650);
    } else {
      this.log("foe", "You can't shake them.");
      this.afterPlayerAction();
    }
  },

  afterPlayerAction() {
    if (!this.living().length) { setTimeout(() => this.end("won"), 520); return; }
    setTimeout(() => this.enemyTurn(), 620);
  },

  enemyTurn() {
    const c = Game.ch;
    const def = this.playerSnapshot();
    if (this.enc.defending) { def.armor *= 1.5; def.magicDefense *= 1.5; }

    const order = this.living().slice().sort((a, b) => b.attributes.dexterity - a.attributes.dexterity);
    let i = 0;
    const step = () => {
      if (i >= order.length) { this.endRound(); return; }
      const e = order[i++];
      if (!e.alive) { step(); return; }
      if (e.slowed > 0) {
        e.slowed--;
        this.log("foe", esc(e.name) + " is frozen stiff and loses its turn.");
        setTimeout(step, 380);
        return;
      }
      const magic = e.caster && chance(55);
      const r = Calc.resolveHit(e, def, { kind: magic ? "magic" : "phys", mult: e.boss ? 1.15 : 1 });
      if (!r.hit) {
        this.log("foe", esc(e.name) + " swings wide.");
      } else {
        c.stats.hp = clamp(c.stats.hp - r.damage, 0, c.stats.maxHp);
        this.floatDamage("player", "-" + r.damage, r.crit ? "#e0a33e" : "#d1544a");
        const verb = e.attackName ? " uses <b>" + esc(e.attackName) + "</b>"
                   : magic ? " hurls a spell" : " hits you";
        this.log("foe", esc(e.name) + verb +
          (r.crit ? " — <b>critical!</b>" : "") + " for <b>" + r.damage + "</b>.");
      }
      this.render();
      if (c.stats.hp <= 0) { setTimeout(() => this.end("lost"), 600); return; }
      setTimeout(step, 480);
    };
    step();
  },

  endRound() {
    const c = Game.ch;
    this.enc.rounds++;
    this.enc.defending = false;
    if (this.buffs.rounds > 0) {
      this.buffs.rounds--;
      if (this.buffs.regen) {
        c.stats.hp = clamp(c.stats.hp + this.buffs.regen, 0, c.stats.maxHp);
        this.log("you", "Your guard holds — <b>+" + this.buffs.regen + "</b> HP.");
      }
      if (this.buffs.rounds === 0) {
        this.buffs.armorPct = 0; this.buffs.evasion = 0; this.buffs.regen = 0;
        this.log("sys", "Your stance fades.");
      }
    }
    // A little resource trickles back each round so long fights stay playable.
    c.stats.stamina = clamp(c.stats.stamina + c.stats.maxStamina * 0.05, 0, c.stats.maxStamina);
    c.stats.mana    = clamp(c.stats.mana + c.stats.maxMana * 0.04, 0, c.stats.maxMana);
    this.busy = false;
    this.render();
  },

  end(status) {
    const c = Game.ch;
    this.enc.status = status;
    this.enc.endedAt = nowTs();
    Store.patch(K.encounters, (all) => { all[this.enc.encounterId] = this.enc; });
    API.request("/combat/" + this.enc.encounterId + "/end", "PATCH",
      { status, rounds: this.enc.rounds, endedAt: this.enc.endedAt });

    if (status === "won") {
      const xp = this.enc.enemies.reduce((s, e) => s + e.rewards.experience, 0);
      const gold = this.enc.enemies.reduce((s, e) => s + e.rewards.gold, 0);
      c.gold += gold;
      // Authored monsters drop from their own loot table; anything without one
      // falls back to the procedural generator.
      const drops = [];
      let authoredLoot = false;
      this.enc.enemies.forEach(e => {
        if (!e.lootTableId) return;
        authoredLoot = true;
        const rolls = 1 + (e.lootRolls || 0);
        for (let r = 0; r < rolls; r++) {
          Content.rollLoot(e.lootTableId, { luck: c.attributes.luck }).forEach(defId => {
            const it = Content.toGameItem(defId, c.level);
            if (it && Game.giveItem(it)) drops.push(it);
          });
        }
      });
      if (!authoredLoot) {
        const dropRolls = this.node.type === "boss" ? 3 : (chance(55 + c.attributes.luck * 1.4) ? 2 : 1);
        for (let i = 0; i < dropRolls; i++) {
          const it = Items.generate(c.level, c.attributes.luck, this.node.difficulty + (this.node.type === "boss" ? 3 : 0));
          if (Game.giveItem(it)) drops.push(it);
        }
      }
      const gains = Characters.addXp(c, xp);
      Zones.updateNode(this.node, { status: "cleared", clearedAt: nowTs() });
      Game.drawNode(this.node);
      Characters.save(c);

      this.unmount();
      Game.renderHud();
      Game.maybeRespawn();
      UI.modal({
        title: "Victory", icon: "🏆", noClose: true,
        body:
          '<div class="rewardRow"><span class="ic">★</span><div><b>' + xp + " experience</b></div></div>" +
          '<div class="rewardRow"><span class="ic">🪙</span><div><b>' + gold + " gold</b></div></div>" +
          drops.map(it => '<div class="rewardRow"><span class="ic">' + Content.itemIconHtml(it, 20) + '</span><div><b class="c-' +
            it.rarity + '">' + esc(it.name) + '</b><br><span class="tiny dim mono">' + esc(it.effect) +
            "</span></div></div>").join("") +
          gains.map(g => '<div class="rewardRow" style="border:1px solid var(--gold)"><span class="ic">🎖️</span>' +
            "<div><b>Level " + g.level + "</b><br><span class='tiny dim'>+5 attribute points" +
            (g.unlocked.length ? " · unlocked " + g.unlocked.map(s => esc(s.name)).join(", ") : "") +
            "</span></div></div>").join(""),
        buttons: [{ label: "Continue", cls: "primary" }]
      });

    } else if (status === "lost") {
      // Roguelike-lite: you keep the character, you lose gold and wake up home.
      const lost = Math.round(c.gold * 0.25);
      c.gold -= lost;
      c.stats.hp = Math.max(1, Math.round(c.stats.maxHp * 0.3));
      c.stats.stamina = Math.round(c.stats.maxStamina * 0.4);
      Zones.updateNode(this.node, { status: "failed" });
      Game.drawNode(this.node);
      Characters.save(c);
      this.unmount();
      Game.renderHud();
      UI.modal({
        title: "You go down", icon: "💀", noClose: true,
        body: '<p style="margin:0 0 12px;color:var(--ink-2)">Someone drags you back inside. ' +
              "The site holds — it'll be waiting.</p>" +
              '<div class="rewardRow"><span class="ic">🪙</span><div><b>−' + lost + " gold</b></div></div>" +
              '<div class="rewardRow"><span class="ic">❤</span><div><b>Revived at ' + c.stats.hp + " HP</b></div></div>",
        buttons: [{ label: "Get up", cls: "primary" }]
      });

    } else {
      c.stats.stamina = clamp(c.stats.stamina - c.stats.maxStamina * 0.15, 0, c.stats.maxStamina);
      Characters.save(c);
      this.unmount();
      Game.renderHud();
      UI.toast("You got away. Winded, but whole.", "info", 3000);
    }
  }
};

/* -------------------------------------------------------------------------
   19. Panels: character sheet, inventory, menu, settings
   ------------------------------------------------------------------------- */
const Panels = {
  sheet() {
    const c = Game.ch;
    Characters.refreshMaxes(c);
    const body = el("div");
    const draw = () => {
      const a = Calc.effectiveAttrs(c);
      body.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">' +
          '<div class="avatar" style="width:48px;height:48px;font-size:25px">' + CLASSES[c.class].icon + "</div>" +
          "<div><b style='font-size:16px'>" + esc(c.name) + "</b><br>" +
          "<span class='tiny dim'>Level " + c.level + " " + c.race + " " + c.class + " · " + c.gold + " gold</span></div></div>" +
        (c.unspentPoints
          ? '<div class="poolBox"><span>Unspent attribute points</span><b>' + c.unspentPoints + "</b></div>"
          : "") +
        '<div class="card" id="attrCard"></div>' +
        '<h4 style="margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">Derived</h4>' +
        '<div class="statGrid">' +
          st("Health", c.stats.maxHp) + st("Mana", c.stats.maxMana) + st("Stamina", c.stats.maxStamina) +
          st("Attack", Math.round(Calc.attackPower(c))) + st("Spell", Math.round(Calc.spellPower(c))) +
          st("Armour", Calc.armor(c)) + st("Magic def", Math.round(Calc.magicDefense(c))) +
          st("Accuracy", Math.round(Calc.accuracy(c))) + st("Evasion", Calc.evasion(c).toFixed(1)) +
          st("Crit %", Calc.critChance(c).toFixed(1)) + st("Crit resist", Calc.critResist(c).toFixed(1)) +
          st("Shop price", Math.round(Calc.priceMod(c) * 100) + "%") +
        "</div>" +
        '<h4 style="margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">Abilities</h4>' +
        '<div class="itemList">' + CLASSES[c.class].skills.map(sk => {
          const known = c.level >= sk.lvl;
          return '<div class="item ' + (known ? "r-uncommon" : "") + '" style="' + (known ? "" : "opacity:.45") + '">' +
            '<span class="ico">' + sk.icon + '</span><div class="body"><div class="nm">' + esc(sk.name) +
            (known ? "" : " <span class='tiny dimmer'>— level " + sk.lvl + "</span>") +
            '</div><div class="ds" style="font-family:var(--font);color:var(--ink-2)">' + esc(sk.desc) +
            "</div></div><div class='acts tiny dimmer mono'>" + sk.cost + " " + (sk.res === "mana" ? "MP" : "SP") + "</div></div>";
        }).join("") + "</div>";

      const card = $("#attrCard", body);
      ATTRS.forEach(at => {
        const row = el("div", "attrRow");
        const bonus = a[at.key] - c.attributes[at.key];
        row.innerHTML =
          '<div class="nm">' + at.name + "<small>" + at.blurb + "</small></div>" +
          "<div></div>" +
          '<div class="val">' + a[at.key] + "</div>" +
          (c.unspentPoints > 0
            ? '<button class="stepper" data-up="' + at.key + '">+</button>'
            : "<div></div>") +
          '<div class="bonus ' + (bonus > 0 ? "pos" : "") + '">' + (bonus > 0 ? "+" + bonus + " gear" : "—") + "</div>";
        card.appendChild(row);
      });
      $$("[data-up]", card).forEach(b => {
        b.onclick = () => {
          if (c.unspentPoints <= 0) return;
          c.attributes[b.getAttribute("data-up")]++;
          c.unspentPoints--;
          Characters.refreshMaxes(c);
          Characters.save(c);
          Game.renderHud();
          draw();
        };
      });
      function st(l, v) { return '<div class="s"><span>' + l + "</span><b>" + v + "</b></div>"; }
    };
    draw();
    UI.modal({ title: "Character", icon: "📋", body, wide: true,
               buttons: [{ label: "Close", cls: "ghost" }] });
  },

  inventory() {
    const c = Game.ch;
    const body = el("div");
    const draw = () => {
      body.innerHTML = "";
      const slots = ["weapon", "armor", "trinket"];
      const slotRow = el("div", "slotRow");
      slots.forEach(sl => {
        const eq = (c.equipment || []).find(i => Items.slotOf(i) === sl);
        const d = el("div", "slot" + (eq ? " filled r-" + eq.rarity : ""));
        d.innerHTML = '<span class="sl">' + sl + "</span>" +
          (eq ? '<span class="nmv c-' + eq.rarity + '">' +
                  '<span class="slotIco">' + Content.itemIconHtml(eq, 15) + "</span>" + esc(eq.name) +
                  '</span><span class="stt">' + esc(eq.effect) + "</span>"
              : '<span class="nmv dimmer">empty</span>');
        if (eq) {
          const b = el("button", "btn sm ghost", "Remove");
          b.style.marginTop = "6px";
          b.onclick = () => { unequip(eq); };
          d.appendChild(b);
        }
        slotRow.appendChild(d);
      });
      body.appendChild(slotRow);

      const head = el("div");
      head.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px";
      head.innerHTML = '<h4 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">Pack</h4>' +
        '<span class="tiny dimmer mono">' + (c.inventory || []).length + " / 20 · " + c.gold + " gold</span>";
      body.appendChild(head);

      const list = el("div", "itemList");
      if (!(c.inventory || []).length) list.innerHTML = '<div class="emptyMsg">Nothing but lint.</div>';
      (c.inventory || []).slice().sort((a, b) => {
        const order = ["legendary","epic","rare","uncommon","common"];
        return order.indexOf(a.rarity) - order.indexOf(b.rarity);
      }).forEach(it => {
        const row = el("div", "item r-" + it.rarity);
        row.innerHTML = '<span class="ico">' + Content.itemIconHtml(it, 18) + '</span>' +
          '<div class="body"><div class="nm c-' + it.rarity + '">' + esc(it.name) +
          ' <span class="badge">' + it.rarity + '</span></div>' +
          '<div class="ds">' + esc(it.effect) + " · " + it.price + " g</div></div>";
        const acts = el("div", "acts");
        if (it.type === "potion") {
          const b = el("button", "btn sm primary", "Drink");
          b.onclick = () => { usePotion(it); };
          acts.appendChild(b);
        } else if (Items.slotOf(it)) {
          const b = el("button", "btn sm primary", "Equip");
          b.onclick = () => { equip(it); };
          acts.appendChild(b);
        }
        const s = el("button", "btn sm ghost", "Sell");
        s.onclick = () => { sell(it); };
        acts.appendChild(s);
        row.appendChild(acts);
        list.appendChild(row);
      });
      body.appendChild(list);
    };

    function persist() {
      Store.patch(K.inventories, (all) => { all[c.characterId] = c.inventory; });
      Characters.refreshMaxes(c);
      Characters.save(c);
      Game.renderHud();
      draw();
    }
    function equip(it) {
      const sl = Items.slotOf(it);
      const cur = (c.equipment || []).find(x => Items.slotOf(x) === sl);
      if (cur) { c.equipment = c.equipment.filter(x => x !== cur); c.inventory.push(cur); }
      c.inventory = c.inventory.filter(x => x.itemId !== it.itemId);
      c.equipment = (c.equipment || []).concat([it]);
      API.request("/inventory/item/" + it.itemId + "/equip", "PATCH", { equipped: true });
      UI.toast("Equipped " + it.name + ".", "good", 1800);
      persist();
    }
    function unequip(it) {
      if (c.inventory.length >= 20) { UI.toast("Pack is full.", "bad"); return; }
      c.equipment = c.equipment.filter(x => x.itemId !== it.itemId);
      c.inventory.push(it);
      persist();
    }
    function usePotion(p) {
      for (const k in p.restore) c.stats[k] = clamp(c.stats[k] + p.restore[k], 0, c.stats["max" + cap(k)]);
      c.inventory = c.inventory.filter(x => x.itemId !== p.itemId);
      UI.toast("Drank " + p.name + ".", "good", 1800);
      persist();
    }
    function sell(it) {
      const price = Math.max(1, Math.round(it.price * 0.45 / Calc.priceMod(c)));
      c.gold += price;
      c.inventory = c.inventory.filter(x => x.itemId !== it.itemId);
      UI.toast("Sold for " + price + " gold.", "info", 1800);
      persist();
    }

    draw();
    UI.modal({ title: "Inventory", icon: "🎒", body, wide: true,
               buttons: [{ label: "Close", cls: "ghost" }] });
  },

  menu() {
    const s = settings();
    const w = Walk.data();
    const atlas = Atlas.stats();
    const body = el("div");
    body.innerHTML =
      '<div class="statGrid" style="margin-bottom:14px">' +
        '<div class="s"><span>Walked today</span><b>' + fmtDist(w.meters) + "</b></div>" +
        '<div class="s"><span>All time</span><b>' + fmtDist(w.total) + "</b></div>" +
        '<div class="s"><span>Daily goal</span><b>' + fmtDist(s.dailyGoalMeters) + "</b></div>" +
        '<div class="s"><span>Sites left</span><b>' +
          Game.nodes.filter(n => n.status !== "cleared").length + "</b></div>" +
      "</div>" +
      '<h4 style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">Location</h4>' +
      '<label class="tick"><input type="checkbox" id="setSim"' + (s.locationMode === "sim" ? " checked" : "") +
        "> <span>Dev test mode <small class='dimmer'>— simulate my location instead of using GPS</small></span></label>" +
      '<label class="tick"><input type="checkbox" id="setFollow"' + (s.followPlayer ? " checked" : "") + "> Keep the map centred on me</label>" +
      '<label class="tick"><input type="checkbox" id="setAcc"' + (s.highAccuracy ? " checked" : "") + "> High-accuracy GPS (uses more battery)</label>" +
      '<div class="divider"></div>' +
      '<h4 style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">The map</h4>' +
      '<label class="tick"><input type="checkbox" id="setFantasy"' + (s.fantasyMap ? " checked" : "") +
        "> <span>Fantasy overlay <small class='dimmer'>— real roads and buildings, renamed</small></span></label>" +
      '<label class="tick"><input type="checkbox" id="setSnap"' + (s.snapNodesToBuildings ? " checked" : "") +
        "> Put sites on real buildings</label>" +
      '<label class="field" style="margin-top:12px"><span>Real map showing through: <b id="tileVal">' +
        Math.round(s.tileOpacity * 100) + '</b>%</span>' +
        '<input type="range" min="0" max="100" step="5" id="setTile" value="' + Math.round(s.tileOpacity * 100) + '" style="width:100%"></label>' +
      '<label class="field"><span>Street names appear at zoom <b id="lblVal">' + s.labelZoom + "</b></span>" +
        '<input type="range" min="15" max="20" step="1" id="setLbl" value="' + s.labelZoom + '" style="width:100%"></label>' +
      '<div class="statGrid" style="margin-bottom:10px">' +
        '<div class="s"><span>Buildings named</span><b>' + atlas.buildings + "</b></div>" +
        '<div class="s"><span>Roads named</span><b>' + atlas.streetNames + "</b></div>" +
        '<div class="s"><span>Street rows</span><b>' + atlas.streetRows + "</b></div>" +
      "</div>" +
      '<label class="field" style="margin-top:12px"><span>Interaction range: <b id="rngVal">' + s.interactRange + '</b> m</span>' +
        '<input type="range" min="10" max="120" step="5" id="setRange" value="' + s.interactRange + '" style="width:100%"></label>' +
      '<label class="field"><span>Daily walking goal: <b id="goalVal">' + s.dailyGoalMeters + '</b> m</span>' +
        '<input type="range" min="500" max="12000" step="250" id="setGoal" value="' + s.dailyGoalMeters + '" style="width:100%"></label>' +
      '<div class="divider"></div>' +
      '<p class="tiny dimmer" style="margin:0 0 10px">Storage: ' +
        (Store.isDurable ? "localStorage, " + (Store.usageBytes() / 1024).toFixed(1) + " KB used"
                         : "in-memory only — this browser is blocking storage, so progress will not survive a reload") +
      "</p>";
    const actions = el("div");
    actions.style.cssText = "display:flex;flex-direction:column;gap:7px";
    const mk = (label, cls, fn) => { const b = el("button", "btn block " + cls, label); b.onclick = fn; actions.appendChild(b); };
    mk("Resurvey the streets", "ghost", () => {
      m.close();
      Store.remove(OSM.cacheKey(Game.zone));
      Game.loadWorld(true);
    });
    mk("Export atlas as JSON", "ghost", () => {
      const data = Atlas.export();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = "stride-atlas-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      UI.toast("Atlas exported: " + Object.keys(data.tables.buildings).length + " buildings, " +
               Object.keys(data.tables.streets).length + " street rows.", "good", 3600);
    });
    mk("Import an atlas file", "ghost", () => {
      const inp = el("input");
      inp.type = "file"; inp.accept = "application/json,.json";
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const r = Atlas.import(JSON.parse(rd.result));
            UI.toast(r.success ? "Atlas merged: " + r.buildings + " buildings, " + r.streets + " street rows."
                               : r.message, r.success ? "good" : "bad", 4000);
            if (r.success && Game.world) Game.renderWorld(Game.world);
          } catch (e) { UI.toast("That file wouldn't parse as JSON.", "bad", 3600); }
        };
        rd.readAsText(f);
      };
      inp.click();
    });
    mk("Rename the whole town", "ghost", () => {
      UI.confirm("Regenerate every name?", "Buildings and roads get fresh fantasy names. Site names update too.", () => {
        Atlas.clear();
        if (Game.world) {
          const els = Store.get(OSM.cacheKey(Game.zone), null);
          Game.nodes.forEach(n => { delete n.anchorKey; });
          if (els) { const w = OSM.digest(els); Game.world = w; Game.renderWorld(w); Game.snapNodesToBuildings(w); }
        }
        UI.toast("The town has forgotten its old names.", "good", 3200);
      });
    });
    mk("Re-anchor zone here", "ghost", () => {
      UI.confirm("Re-anchor zone?", "Your current sites are discarded and a new set is scattered around where you're standing.", () => {
        if (!Loc.last) { UI.toast("No position yet.", "bad"); return; }
        const old = Zones.nodesIn(Game.zone.zoneId);
        Store.patch(K.nodes, (all) => { old.forEach(n => delete all[n.nodeId]); });
        Game.zone.centerLatitude = Loc.last.latitude;
        Game.zone.centerLongitude = Loc.last.longitude;
        Game.zone.seed = uid("seed");
        Game.zone.lastModified = nowTs();
        Store.patch(K.zones, (z) => { z[Game.zone.zoneId] = Game.zone; });
        Game.nodes = Zones.generateNodes(Game.zone, null, Game.ch.level);
        Game.drawZone(); Game.drawNodes();
        UI.toast("Zone re-anchored.", "good");
      });
    });
    mk("Switch character", "ghost", () => { Game.reset(); Screens.show("select"); });
    mk("Sign out", "ghost", () => Auth.logout());
    mk("Wipe all local data", "danger", () => {
      UI.confirm("Wipe everything?", "Accounts, characters, zones and progress in this browser are deleted.", () => {
        Object.values(Store.get(K.zones, {}) || {}).forEach(z => Store.remove(OSM.cacheKey(z)));
        [K.session, K.accounts, K.characters, K.zones, K.nodes, K.inventories, K.encounters,
         K.walk, K.settings, "atlas_buildings", "atlas_streets"].forEach(k => Store.remove(k));
        location.reload();
      });
    });
    body.appendChild(el("div", "divider"));
    body.appendChild(actions);

    const m = UI.modal({ title: "Menu", icon: "☰", body, buttons: [{ label: "Close", cls: "ghost" }] });

    $("#setFollow", body).onchange = (e) => saveSettings({ followPlayer: e.target.checked });
    $("#setAcc", body).onchange = (e) => {
      saveSettings({ highAccuracy: e.target.checked });
      if (settings().locationMode === "gps") { Loc.stop(); Loc.start(); }
    };
    $("#setSim", body).onchange = (e) => Game.setLocationMode(e.target.checked ? "sim" : "gps");
    $("#setSnap", body).onchange = (e) => saveSettings({ snapNodesToBuildings: e.target.checked });
    $("#setFantasy", body).onchange = (e) => {
      saveSettings({ fantasyMap: e.target.checked });
      if (!e.target.checked) {
        if (Game.worldLayer) Game.worldLayer.clearLayers();
        if (Game.tiles) Game.tiles.setOpacity(1);
      } else if (Game.world) { Game.renderWorld(Game.world); }
      else { Game._worldZone = null; Game.loadWorld(); }
    };
    $("#setTile", body).oninput = (e) => {
      $("#tileVal", body).textContent = e.target.value;
      saveSettings({ tileOpacity: +e.target.value / 100 });
      if (Game.tiles) Game.tiles.setOpacity(settings().fantasyMap ? +e.target.value / 100 : 1);
    };
    $("#setLbl", body).oninput = (e) => {
      $("#lblVal", body).textContent = e.target.value;
      saveSettings({ labelZoom: +e.target.value });
      Game.applyZoomDetail();
    };
    $("#setRange", body).oninput = (e) => {
      $("#rngVal", body).textContent = e.target.value;
      saveSettings({ interactRange: +e.target.value });
      Game.onPosition();
    };
    $("#setGoal", body).oninput = (e) => {
      $("#goalVal", body).textContent = e.target.value;
      saveSettings({ dailyGoalMeters: +e.target.value });
    };
  }
};
