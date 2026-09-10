/* -------------------------------------------------------------------------
   17. Node interaction
   ------------------------------------------------------------------------- */
Object.assign(Game, {
  openNode(n) {
    if (this.inCombat) return;
    const d = Loc.distanceTo(n);
    const s = settings();
    const range = +n.radius || s.interactRange;
    const inRange = d != null && d <= range;
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
      (n.locationId ? Game.authoredNodeDetail(n) : "") +
      '<div class="kv"><span>Status</span><b>' + (n.closed ? "Closed right now" : cap(n.status)) + "</b></div>";

    if (n.type !== "landmark" && !cleared) {
      body += '<div class="kv"><span>Expected reward</span><b>' +
        n.rewards.experience + " XP · " + n.rewards.gold + " g</b></div>";
    }
    if (!inRange && !cleared) {
      body += '<p class="tiny" style="color:var(--warn);margin:12px 0 0">' +
        "Walk within " + range + " m to interact. You're " + fmtDist(d) + " away." +
        "</p>";
    }

    const buttons = [{ label: "Close", cls: "ghost" }];
    if (n.closed) {
      body += '<p class="tiny" style="color:var(--warn);margin:12px 0 0">' +
        "This place is shut right now. Come back during its opening hours.</p>";
    }
    if (!cleared && inRange && !n.closed) {
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
    const got = [];
    if (n.chestLootTableId) {
      // A hand-placed chest holds exactly what its loot table says, with the
      // chest tier deciding how many times that table is rolled.
      const tier = Content.chestTier(n.chestTier);
      const rolls = Math.max(1, tier.rolls);
      for (let r = 0; r < rolls; r++) {
        Content.rollLoot(n.chestLootTableId, { luck: c.attributes.luck }).forEach(defId => {
          const it = Content.toGameItem(defId, c.level);
          if (it && this.giveItem(it)) got.push(it);
        });
      }
    } else {
      const rolls = 1 + (chance(28 + c.attributes.luck) ? 1 : 0);
      for (let i = 0; i < rolls; i++) {
        const it = Items.generate(c.level, c.attributes.luck, n.difficulty);
        if (this.giveItem(it)) got.push(it);
      }
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
