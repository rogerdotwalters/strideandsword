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
    // Held in a local because the dungeon callback runs when the reward modal is
    // dismissed, by which time this.node may belong to the next fight.
    const n = this.node;
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
      // A dungeon stop is a throwaway node: there is nothing in the zone to mark
      // cleared and no pin to redraw, and respawning sites mid-dungeon would be
      // nonsense. It reports back through onResolved instead.
      if (!this.node.transient) {
        Zones.updateNode(this.node, { status: "cleared", clearedAt: nowTs() });
        Game.drawNode(this.node);
      }
      Characters.save(c);

      this.unmount();
      Game.renderHud();
      if (!this.node.transient) Game.maybeRespawn();
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
        buttons: [{ label: "Continue", cls: "primary" }],
        onClose: () => { if (n.onResolved) n.onResolved("won", { experience: xp, gold, drops }); }
      });

    } else if (status === "lost") {
      // Roguelike-lite: you keep the character, you lose gold and wake up home.
      const lost = Math.round(c.gold * 0.25);
      c.gold -= lost;
      c.stats.hp = Math.max(1, Math.round(c.stats.maxHp * 0.3));
      c.stats.stamina = Math.round(c.stats.maxStamina * 0.4);
      if (!this.node.transient) {
        Zones.updateNode(this.node, { status: "failed" });
        Game.drawNode(this.node);
      }
      Characters.save(c);
      this.unmount();
      Game.renderHud();
      UI.modal({
        title: "You go down", icon: "💀", noClose: true,
        body: '<p style="margin:0 0 12px;color:var(--ink-2)">Someone drags you back inside. ' +
              "The site holds — it'll be waiting.</p>" +
              '<div class="rewardRow"><span class="ic">🪙</span><div><b>−' + lost + " gold</b></div></div>" +
              '<div class="rewardRow"><span class="ic">❤</span><div><b>Revived at ' + c.stats.hp + " HP</b></div></div>",
        buttons: [{ label: "Get up", cls: "primary" }],
        onClose: () => { if (n.onResolved) n.onResolved("lost", null); }
      });

    } else {
      c.stats.stamina = clamp(c.stats.stamina - c.stats.maxStamina * 0.15, 0, c.stats.maxStamina);
      Characters.save(c);
      this.unmount();
      Game.renderHud();
      UI.toast("You got away. Winded, but whole.", "info", 3000);
      if (n.onResolved) n.onResolved("fled", null);
    }
  }
};
