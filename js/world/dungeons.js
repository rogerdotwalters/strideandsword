/* -------------------------------------------------------------------------
   18. Dungeons — instanced dungeons you walk into and walk through.

   A location is a point you stand on. A dungeon is an area you enter, and once
   you are inside, the metres you walk are what carry you along the floor. The
   footprint on the map decides where the door is; it does not have to be big
   enough to hold the dungeon, because the dungeon is a distance, not a place.

   A run is one attempt: a floor index, how far you have walked into it, and
   the plan of stops that floor rolled at entry. Stops fire in order as you
   pass their distance — fights, chests, a boss, and finally the stairs down.
   Leaving pauses the run so it can be picked up later; going down abandons it.
   ------------------------------------------------------------------------- */
const Dungeon = {
  busy: false,

  /* ------------------------------------------------------------- storage */
  slotFor(characterId) {
    const all = Store.get(K.dungeonRuns, {}) || {};
    return all[characterId] || { active: null, state: {} };
  },
  writeSlot(characterId, slot) {
    Store.patch(K.dungeonRuns, (all) => { all[characterId] = slot; });
  },
  /** The run in progress for the character at the table, if there is one. */
  current() {
    const c = Game.ch;
    if (!c) return null;
    const run = this.slotFor(c.characterId).active;
    return run && run.status === "active" ? run : null;
  },
  /** A paused run for this dungeon, if one was left behind. */
  pausedFor(dungeonId) {
    const c = Game.ch;
    if (!c) return null;
    const run = this.slotFor(c.characterId).active;
    return run && run.status === "paused" && run.dungeonId === dungeonId ? run : null;
  },
  saveRun(run) {
    const c = Game.ch;
    if (!c) return;
    const slot = this.slotFor(c.characterId);
    slot.active = run;
    this.writeSlot(c.characterId, slot);
  },
  markCleared(dungeonId) {
    const c = Game.ch;
    if (!c) return;
    const slot = this.slotFor(c.characterId);
    const st = slot.state[dungeonId] || { completions: 0 };
    st.clearedAt = nowTs();
    st.completions = (st.completions || 0) + 1;
    slot.state[dungeonId] = st;
    slot.active = null;
    this.writeSlot(c.characterId, slot);
  },

  def(id) { return Content.get("dungeons", id); },

  /** Milliseconds until a completed dungeon opens again; 0 when it's ready. */
  cooldownLeft(d) {
    const c = Game.ch;
    if (!c || !d) return 0;
    const st = this.slotFor(c.characterId).state[d.dungeonId];
    if (!st || !st.clearedAt) return 0;
    const mins = +d.respawnMinutes || 0;
    if (!mins) return Infinity;                    // once only, ever
    return Math.max(0, st.clearedAt + mins * 60000 - nowTs());
  },

  /** Everything that has to be true before the door opens. */
  canEnter(d, distance) {
    const c = Game.ch;
    if (!c) return { ok: false, why: "No character." };
    if (this.current()) return { ok: false, why: "You're already inside a dungeon." };
    if (!Content.isLocationActive(d)) return { ok: false, why: "Shut right now — come back during its hours." };
    const cd = this.cooldownLeft(d);
    if (cd === Infinity) return { ok: false, why: "Already cleared. This one doesn't come back." };
    if (cd > 0) return { ok: false, why: "Sealed for another " + fmtMins(cd) + "." };
    if (!(d.floors || []).length) return { ok: false, why: "This dungeon has no floors yet." };
    if (c.level < (+d.minLevel || 1)) return { ok: false, why: "You need to be level " + d.minLevel + " to go in." };
    const range = +d.entryRange || 25;
    if (distance != null && distance > range) {
      return { ok: false, why: "Walk within " + range + " m of it. You're " + fmtDist(distance) + " out." };
    }
    return { ok: true };
  },

  /* --------------------------------------------------------------- a run */
  begin(d) {
    const c = Game.ch;
    const run = {
      runId: uid("run"), dungeonId: d.dungeonId, characterId: c.characterId,
      seed: uid("seed"),
      floor: 0, walked: 0, stopIndex: 0,
      plan: [], status: "active",
      startedAt: nowTs(),
      totals: { fights: 0, chests: 0, floors: 0, experience: 0, gold: 0, meters: 0 }
    };
    run.plan = Content.planFloor(d, 0, run.seed);
    this.saveRun(run);
    Game.renderDungeonBar();
    Game.drawDungeons();
    const kind = Content.dungeonKind(d.kind);
    UI.modal({
      title: "You go in", icon: kind.icon,
      body: '<p style="margin:0 0 12px;color:var(--ink-2)">' +
              esc(d.name || cap(kind.label)) + " swallows the light behind you. " +
              (d.floors.length > 1 ? d.floors.length + " floors down." : "One floor down.") + "</p>" +
            this.floorBrief(d, 0) +
            '<p class="tiny dim" style="margin:12px 0 0">Walking is what moves you. ' +
            "Keep going and the place will find you.</p>",
      buttons: [{ label: "Onward", cls: "primary" }]
    });
  },

  resume(d) {
    const run = this.pausedFor(d.dungeonId);
    if (!run) return;
    run.status = "active";
    this.saveRun(run);
    Game.renderDungeonBar();
    Game.drawDungeons();
    UI.toast("Back inside — " + Content.floorName(d, d.floors[run.floor], run.floor) +
             ", " + Math.round(run.walked) + " m in.", "good", 3600);
  },

  /** Step out. The run keeps its place until you come back or start over. */
  leave(quiet) {
    const run = this.current();
    if (!run) return;
    run.status = "paused";
    this.saveRun(run);
    Game.renderDungeonBar();
    Game.drawDungeons();
    if (!quiet) UI.toast("You step back out into the daylight. Your progress is held.", "info", 4000);
  },

  /** Give up on the run entirely. */
  abandon(quiet) {
    const c = Game.ch;
    if (!c) return;
    const slot = this.slotFor(c.characterId);
    slot.active = null;
    this.writeSlot(c.characterId, slot);
    Game.renderDungeonBar();
    Game.drawDungeons();
    if (!quiet) UI.toast("You leave the dungeon behind.", "info", 3000);
  },

  /* --------------------------------------------------------- the walking */
  /**
   * Metres walked, fed straight from the pedometer. This is the whole
   * progression mechanic: nothing else moves you along a floor.
   */
  advance(meters) {
    const run = this.current();
    if (!run || !isFinite(meters) || meters <= 0) return;
    const d = this.def(run.dungeonId);
    if (!d) { this.abandon(true); return; }

    run.walked += meters;
    run.totals.meters += meters;
    this.saveRun(run);
    Game.renderDungeonBar();
    this.checkStops();
  },

  /** Fire every stop the player has now walked past, one at a time. */
  checkStops() {
    if (this.busy || Game.inCombat) return;
    const run = this.current();
    if (!run) return;
    const stop = run.plan[run.stopIndex];
    if (!stop || run.walked < stop.at) return;
    const d = this.def(run.dungeonId);
    if (!d) return;
    this.fireStop(d, run, stop);
  },

  fireStop(d, run, stop) {
    const floor = (d.floors || [])[run.floor];
    if (!floor) { this.descend(d, run); return; }
    if (stop.kind === "stairs") { this.descend(d, run); return; }
    if (stop.kind === "chest")  { this.openChest(d, run, stop, floor); return; }
    this.fight(d, run, stop, floor);
  },

  /** Move past the stop we just resolved and see if the next one is due too. */
  clearStop() {
    const run = this.current();
    if (!run) return;
    run.stopIndex++;
    this.saveRun(run);
    Game.renderDungeonBar();
    this.checkStops();
  },

  /* ------------------------------------------------------------- combat */
  /**
   * Combat wants a node. A dungeon has none, so it gets a throwaway one marked
   * `transient` — Combat then skips writing it to the zone or drawing a pin,
   * and calls onResolved instead of respawning anything.
   */
  stopNode(d, run, stop, floor) {
    const kind = Content.dungeonKind(d.kind);
    const boss = stop.kind === "boss";
    const label = Content.floorName(d, floor, run.floor);
    return {
      nodeId: "dgnstop_" + run.runId + "_" + stop.index,
      transient: true,
      dungeonId: d.dungeonId,
      type: boss ? "boss" : "combat",
      difficulty: clamp(+floor.difficulty || 3, 1, 10) + (boss ? 2 : 0),
      name: boss ? (d.name || cap(kind.label)) + " · the thing at the bottom"
                 : (d.name || cap(kind.label)) + " · " + label,
      icon: boss ? "👑" : kind.icon,
      spawnTableId: stop.spawnTableId || "",
      radius: Infinity,
      status: "discovered",
      latitude: +d.latitude, longitude: +d.longitude,
      distanceFromHome: 0,
      rewards: { experience: 0, gold: 0, items: [] },
      onResolved: (status, tally) => this.afterFight(status, tally, stop)
    };
  },

  fight(d, run, stop, floor) {
    const node = this.stopNode(d, run, stop, floor);
    if (Game.ch.stats.hp <= 1) {
      // Don't shove a broken character into a fight they cannot act in.
      UI.toast("Something is ahead and you can barely stand. Rest, or step out.", "bad", 5000);
      return;
    }
    this.busy = true;
    Combat.begin(node);
  },

  afterFight(status, tally, stop) {
    this.busy = false;
    const run = this.current();
    if (!run) return;
    if (status === "won") {
      run.totals.fights++;
      if (tally) {
        run.totals.experience += tally.experience || 0;
        run.totals.gold += tally.gold || 0;
      }
      this.saveRun(run);
      this.clearStop();
      return;
    }
    if (status === "lost") {
      // Dragged out. The dungeon itself is untouched — it can be run again.
      this.abandon(true);
      UI.toast("You're hauled out of the dungeon. The run is lost.", "bad", 5000);
      return;
    }
    // Fled: you're still inside, and the thing is still ahead of you.
    UI.toast("You break away, but it's still between you and the stairs.", "info", 4200);
    Game.renderDungeonBar();
  },

  /* -------------------------------------------------------------- chests */
  openChest(d, run, stop, floor) {
    const c = Game.ch;
    const tier = Content.chestTier(stop.chestTier);
    const got = [];
    if (stop.lootTableId) {
      for (let r = 0; r < Math.max(1, tier.rolls); r++) {
        Content.rollLoot(stop.lootTableId, { luck: c.attributes.luck }).forEach(defId => {
          const it = Content.toGameItem(defId, c.level);
          if (it && Game.giveItem(it)) got.push(it);
        });
      }
    } else {
      const rolls = Math.max(1, tier.rolls);
      for (let i = 0; i < rolls; i++) {
        const it = Items.generate(c.level, c.attributes.luck, +floor.difficulty || 3);
        if (Game.giveItem(it)) got.push(it);
      }
    }
    const gold = Math.round((14 + (+floor.difficulty || 3) * 11) * rnd(0.8, 1.4) * (1 + run.floor * 0.3));
    c.gold += gold;
    run.totals.chests++;
    run.totals.gold += gold;
    this.saveRun(run);
    Characters.save(c);
    Game.renderHud();

    UI.modal({
      title: tier.label, icon: "🧰",
      body: '<div class="rewardRow"><span class="ic">🪙</span><div><b>' + gold + " gold</b></div></div>" +
            got.map(it => '<div class="rewardRow"><span class="ic">' + Content.itemIconHtml(it, 20) +
              '</span><div><b class="c-' + it.rarity + '">' + esc(it.name) +
              '</b><br><span class="tiny dim mono">' + esc(it.effect) + "</span></div></div>").join("") +
            (got.length ? "" : '<p class="tiny dim" style="margin:10px 0 0">Nothing but dust in it.</p>'),
      // onClose fires for the button too, so the button must not also advance
      // the run — that would skip the next stop entirely.
      buttons: [{ label: "Take it", cls: "primary" }],
      onClose: () => this.clearStop()
    });
  },

  /* -------------------------------------------------------- floor change */
  descend(d, run) {
    const c = Game.ch;
    const floor = (d.floors || [])[run.floor];
    const pay = Content.floorRewards(d, run.floor);
    c.gold += pay.gold;
    const gains = Characters.addXp(c, pay.experience);
    gains.forEach(g => Game.announceLevel(g));
    run.totals.floors++;
    run.totals.experience += pay.experience;
    run.totals.gold += pay.gold;

    const last = run.floor >= (d.floors.length - 1);
    if (last) { this.saveRun(run); this.finish(d, run, pay); return; }

    run.floor++;
    run.walked = 0;
    run.stopIndex = 0;
    run.plan = Content.planFloor(d, run.floor, run.seed);
    this.saveRun(run);
    Characters.save(c);
    Game.renderHud();
    Game.renderDungeonBar();

    const nextName = Content.floorName(d, d.floors[run.floor], run.floor);
    UI.modal({
      title: Content.floorName(d, floor, run.floor - 1) + " cleared", icon: "🪜",
      body: '<div class="rewardRow"><span class="ic">★</span><div><b>' + pay.experience + " experience</b></div></div>" +
            '<div class="rewardRow"><span class="ic">🪙</span><div><b>' + pay.gold + " gold</b></div></div>" +
            '<p style="margin:12px 0 0;color:var(--ink-2)">Stairs down. <b>' + esc(nextName) + "</b> is next.</p>" +
            this.floorBrief(d, run.floor),
      buttons: [{ label: "Go down", cls: "primary" }]
    });
  },

  finish(d, run, pay) {
    const c = Game.ch;
    const kind = Content.dungeonKind(d.kind);
    const bonusXp = Math.round(60 * d.floors.length * (1 + (+d.minLevel || 1) * 0.1));
    const bonusGold = Math.round(40 * d.floors.length);
    c.gold += bonusGold;
    Characters.addXp(c, bonusXp).forEach(g => Game.announceLevel(g));
    const t = run.totals;
    this.markCleared(d.dungeonId);
    Characters.save(c);
    Game.renderHud();
    Game.renderDungeonBar();
    Game.drawDungeons();

    const cd = +d.respawnMinutes || 0;
    UI.modal({
      title: "Dungeon complete", icon: kind.icon, noClose: true,
      body:
        '<p style="margin:0 0 12px;color:var(--ink-2)">You come back up out of <b>' +
          esc(d.name || cap(kind.label)) + "</b>.</p>" +
        '<div class="rewardRow"><span class="ic">★</span><div><b>' + bonusXp + " experience</b><br>" +
          '<span class="tiny dim">completion bonus</span></div></div>' +
        '<div class="rewardRow"><span class="ic">🪙</span><div><b>' + bonusGold + " gold</b><br>" +
          '<span class="tiny dim">completion bonus</span></div></div>' +
        '<div class="statGrid" style="margin-top:12px">' +
          '<div class="s"><span>Floors</span><b>' + t.floors + "</b></div>" +
          '<div class="s"><span>Fights</span><b>' + t.fights + "</b></div>" +
          '<div class="s"><span>Chests</span><b>' + t.chests + "</b></div>" +
          '<div class="s"><span>Walked</span><b>' + fmtDist(t.meters) + "</b></div>" +
          '<div class="s"><span>Total XP</span><b>' + (t.experience + bonusXp) + "</b></div>" +
          '<div class="s"><span>Total gold</span><b>' + (t.gold + bonusGold) + "</b></div>" +
        "</div>" +
        (cd ? '<p class="tiny dim" style="margin:12px 0 0">It reopens in ' + fmtMins(cd * 60000) + ".</p>"
            : '<p class="tiny dim" style="margin:12px 0 0">This one does not reopen.</p>'),
      buttons: [{ label: "Out into the light", cls: "primary" }]
    });
  },

  /* ------------------------------------------------------------ describing */
  floorBrief(d, index) {
    const f = (d.floors || [])[index];
    if (!f) return "";
    const plan = Content.planFloor(d, index, "brief");
    const fights = plan.filter(s => s.kind === "fight").length;
    const chests = plan.filter(s => s.kind === "chest").length;
    const boss = plan.some(s => s.kind === "boss");
    return '<div class="statGrid" style="margin-top:10px">' +
      '<div class="s"><span>Walk</span><b>' + fmtDist(+f.lengthMeters || 200) + "</b></div>" +
      '<div class="s"><span>Fights</span><b>' + fights + (boss ? " + boss" : "") + "</b></div>" +
      '<div class="s"><span>Chests</span><b>' + chests + "</b></div>" +
      "</div>";
  },

  /** What's coming, and how far off it is. */
  nextStop() {
    const run = this.current();
    if (!run) return null;
    const stop = run.plan[run.stopIndex];
    if (!stop) return null;
    return { stop, away: Math.max(0, stop.at - run.walked) };
  },

  /** The panel that opens when you walk up to a dungeon. */
  open(d, distance) {
    const kind = Content.dungeonKind(d.kind);
    const run = this.current();
    const paused = this.pausedFor(d.dungeonId);
    const floors = (d.floors || []).length;
    const gate = this.canEnter(d, distance);

    let body =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<div class="avatar" style="width:46px;height:46px;font-size:24px">' + kind.icon + "</div>" +
        "<div><b style='font-size:15px'>" + esc(d.name || cap(kind.label)) + "</b><br>" +
        '<span class="tiny dim">' + cap(kind.label) + " · " + floors + " floor" + (floors === 1 ? "" : "s") +
        " · " + fmtDist(Content.dungeonLength(d)) + " of walking</span></div></div>" +
      '<div class="kv"><span>Distance</span><b>' + fmtDist(distance) + "</b></div>" +
      '<div class="kv"><span>Recommended</span><b>Level ' + (+d.minLevel || 1) + "+</b></div>" +
      (d.notes ? '<p class="tiny dim" style="margin:10px 0 0">' + esc(d.notes) + "</p>" : "");

    const buttons = [{ label: "Close", cls: "ghost" }];
    if (run && run.dungeonId === d.dungeonId) {
      body += '<p class="tiny" style="color:var(--gold);margin:12px 0 0">You are inside this one right now.</p>';
    } else if (paused) {
      body += this.floorBrief(d, paused.floor) +
        '<p class="tiny" style="color:var(--gold);margin:12px 0 0">A run is held here at ' +
        esc(Content.floorName(d, d.floors[paused.floor], paused.floor)) + ", " +
        Math.round(paused.walked) + " m in.</p>";
      buttons.push({ label: "Start over", cls: "ghost",
        onClick: () => { this.abandon(true); this.begin(d); } });
      buttons.push({ label: "Pick it up", cls: "primary", onClick: () => this.resume(d) });
    } else if (gate.ok) {
      body += this.floorBrief(d, 0);
      buttons.push({ label: "Dungeon in", cls: "danger", onClick: () => this.begin(d) });
    } else {
      body += '<p class="tiny" style="color:var(--warn);margin:12px 0 0">' + esc(gate.why) + "</p>";
    }
    UI.modal({ title: cap(kind.label), icon: kind.icon, body, buttons,
               onClose: () => { Game._pendingDungeon = null; } });
  }
};

/** "2h 05m" / "18m" / "40s" — for cooldowns and countdowns. */
function fmtMins(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}
