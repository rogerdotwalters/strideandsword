/* -------------------------------------------------------------------------
   19. Instances — a place, not a distance.

   A dungeon is a walk: metres carry you along a floor. An instance is somewhere
   you *are*. Walk up to its door on the real map, go in, and the GPS layer is
   put away: you are now on an XY plane — one open rectangle with whatever
   walls have been drawn into it — that owes nothing to your actual coordinates.

   Two controls, and only two:

     · The dial turns you. Turning is free.
     · Walking, in the real world, carries you forward along your heading.

   Walls stop you. That is what makes the heading matter, and it is why the
   map is drawn rotated with you always facing up — "forward" has to be a
   direction you can see, not one you have to work out.

   Nothing in here runs on a timer. The monsters take their step when you take
   yours, so the walking is the clock for the whole floor.
   ------------------------------------------------------------------------- */
const Instance = {
  busy: false,

  CONTACT: 2.2,        // metres — close enough to be on top of something
  SIGHT: 26,           // how far a monster can notice you, with a clear line

  /* ------------------------------------------------------------- storage */
  slotFor(characterId) {
    const all = Store.get(K.instanceRuns, {}) || {};
    return all[characterId] || { active: null, state: {} };
  },
  writeSlot(characterId, slot) {
    Store.patch(K.instanceRuns, (all) => { all[characterId] = slot; });
  },
  current() {
    const c = Game.ch;
    if (!c) return null;
    const run = this.slotFor(c.characterId).active;
    return run && run.status === "active" ? run : null;
  },
  pausedFor(instanceId) {
    const c = Game.ch;
    if (!c) return null;
    const run = this.slotFor(c.characterId).active;
    return run && run.status === "paused" && run.instanceId === instanceId ? run : null;
  },
  saveRun(run) {
    const c = Game.ch;
    if (!c) return;
    const slot = this.slotFor(c.characterId);
    slot.active = run;
    this.writeSlot(c.characterId, slot);
  },
  markCleared(instanceId) {
    const c = Game.ch;
    if (!c) return;
    const slot = this.slotFor(c.characterId);
    const st = slot.state[instanceId] || { completions: 0 };
    st.clearedAt = nowTs();
    st.completions = (st.completions || 0) + 1;
    slot.state[instanceId] = st;
    slot.active = null;
    this.writeSlot(c.characterId, slot);
  },

  def(id) { return Content.get("instances", id); },

  /** How many instance metres one real metre buys. */
  paceOf(inst) {
    const p = +((inst && inst.pace) || 1);
    return isFinite(p) && p > 0 ? clamp(p, 0.1, 10) : 1;
  },

  cooldownLeft(d) {
    const c = Game.ch;
    if (!c || !d) return 0;
    const st = this.slotFor(c.characterId).state[d.instanceId];
    if (!st || !st.clearedAt) return 0;
    const mins = +d.respawnMinutes || 0;
    if (!mins) return Infinity;
    return Math.max(0, st.clearedAt + mins * 60000 - nowTs());
  },

  canEnter(d, distance) {
    const c = Game.ch;
    if (!c) return { ok: false, why: "No character." };
    if (this.current()) return { ok: false, why: "You're already inside an instance." };
    if (Dungeon.current()) return { ok: false, why: "Finish or step out of your dungeon first." };
    if (!Content.isLocationActive(d)) return { ok: false, why: "Shut right now — come back during its hours." };
    const cd = this.cooldownLeft(d);
    if (cd === Infinity) return { ok: false, why: "Already cleared. This one doesn't come back." };
    if (cd > 0) return { ok: false, why: "Sealed for another " + fmtMins(cd) + "." };
    if (!(d.levels || []).length) return { ok: false, why: "This instance has no levels yet." };
    if (c.level < (+d.minLevel || 1)) return { ok: false, why: "You need to be level " + d.minLevel + " to go in." };
    const range = +d.radius || 30;
    if (distance != null && distance > range) {
      return { ok: false, why: "Walk within " + range + " m of the door. You're " + fmtDist(distance) + " out." };
    }
    return { ok: true };
  },

  /* --------------------------------------------------------------- a run */
  enterLevel(run, inst, index) {
    const plan = Content.buildInstanceLevel(inst, index, run.seed);
    if (!plan) return false;
    run.level = index;
    run.plan = plan;
    run.pos = { x: plan.start.x, y: plan.start.y };
    run.heading = 90;                       // facing east, into the floor
    this.look(run);
    return true;
  },

  /** Light up everything you can see from where you are standing. */
  look(run) {
    if (!run.plan) return;
    if (!run.plan.fog) Content.buildFog(run.plan);
    Content.markSeen(run.plan, run.pos.x, run.pos.y, this.SIGHT);
  },

  begin(d) {
    const c = Game.ch;
    const run = {
      runId: uid("run"), instanceId: d.instanceId, characterId: c.characterId,
      seed: uid("seed"),
      level: 0, status: "active", startedAt: nowTs(),
      totals: { meters: 0, kills: 0, chests: 0, levels: 0, experience: 0, gold: 0 }
    };
    if (!this.enterLevel(run, d, 0)) { UI.toast("That instance has no levels.", "bad"); return; }
    this.saveRun(run);
    Game.enterInstanceView();
    const kind = Content.instanceKind(d.kind);
    UI.modal({
      title: "You go in", icon: kind.icon,
      body: '<p style="margin:0 0 12px;color:var(--ink-2)">' +
              esc(d.name || cap(kind.label)) + " closes behind you. " +
              (d.levels.length > 1 ? d.levels.length + " levels down." : "One level down.") + "</p>" +
            this.levelBrief(d, 0) +
            '<p class="tiny dim" style="margin:12px 0 0">Use the <b>dial</b> to turn — that part is free. ' +
            "To go forward you have to <b>walk, for real</b>. Walls stop you, so point yourself at a " +
            "doorway before you set off.</p>",
      buttons: [{ label: "Onward", cls: "primary" }]
    });
  },

  resume(d) {
    const run = this.pausedFor(d.instanceId);
    if (!run) return;
    run.status = "active";
    this.saveRun(run);
    Game.enterInstanceView();
    UI.toast("Back inside — " + Content.levelName(d, d.levels[run.level], run.level) + ".", "good", 3400);
  },

  leave(quiet) {
    const run = this.current();
    if (!run) return;
    run.status = "paused";
    this.saveRun(run);
    Game.exitInstanceView();
    if (!quiet) UI.toast("You back out into the daylight. Your progress is held.", "info", 4000);
  },

  abandon(quiet) {
    const c = Game.ch;
    if (!c) return;
    const slot = this.slotFor(c.characterId);
    slot.active = null;
    this.writeSlot(c.characterId, slot);
    Game.exitInstanceView();
    if (!quiet) UI.toast("You leave the instance behind.", "info", 3000);
  },

  /* ------------------------------------------------------------- turning */
  /** Free, and the only thing you can do without moving your feet. */
  turn(deltaDeg) {
    const run = this.current();
    if (!run || !isFinite(deltaDeg)) return;
    // A non-finite heading would be stored as null and the whole floor would
    // render as rotate(null) — cheap to refuse, miserable to debug.
    run.heading = ((run.heading + deltaDeg) % 360 + 360) % 360;
    this.saveRun(run);
    Game.renderInstanceMap();
    Game.renderInstanceBar();
  },
  faceTo(deg) {
    const run = this.current();
    if (!run || !isFinite(deg)) return;
    run.heading = ((deg % 360) + 360) % 360;
    this.saveRun(run);
    Game.renderInstanceMap();
    Game.renderInstanceBar();
  },

  /* --------------------------------------------------------- the walking */
  /**
   * Real metres from the pedometer. Which way you actually walked is never
   * consulted: the heading you set on the dial is the direction you go.
   */
  advance(realMetres) {
    const run = this.current();
    if (!run || !isFinite(realMetres) || realMetres <= 0) return;
    if (this.busy || Game.inCombat) return;
    const inst = this.def(run.instanceId);
    if (!inst) { this.abandon(true); return; }

    const m = realMetres * this.paceOf(inst);
    run.totals.meters += realMetres;

    // Step in short hops so a long GPS tick can't jump through a wall.
    let togo = m, hitWall = false;
    while (togo > 0.001) {
      const hop = Math.min(0.8, togo);
      const r = Content.stepThrough(run.plan, run.pos.x, run.pos.y, run.heading, hop);
      if (r.hit) hitWall = true;
      if (r.x === run.pos.x && r.y === run.pos.y) break;      // hard against a wall
      run.pos.x = r.x; run.pos.y = r.y;
      togo -= hop;
    }
    this.look(run);
    this.moveMonsters(run, m);
    this.saveRun(run);
    Game.renderInstanceMap();
    Game.renderInstanceBar();

    if (hitWall && togo > 0.001) Game.instanceHint("A wall. Turn, then keep walking.");
    this.checkContact(inst, run);
  },

  /* ------------------------------------------------------------ monsters */
  /**
   * Everything alive on the floor steps when you do. No timers anywhere —
   * stand still and the dungeon stands still with you, which is the only
   * honest reading of "you have to walk to move".
   */
  moveMonsters(run, playerMetres) {
    const plan = run.plan;
    (plan.entities || []).forEach(e => {
      if (e.kind !== "monster" && e.kind !== "boss") return;
      if (e.dead) return;
      const sees = Content.lineOfSight(plan, e.x, e.y, run.pos.x, run.pos.y, this.SIGHT);
      e.alert = sees;
      // A boss holds its ground until you come to it; the rest give chase.
      const speed = e.kind === "boss" ? (sees ? 0.5 : 0) : (sees ? 0.85 : 0.35);
      let step = playerMetres * speed;
      if (step <= 0) return;

      let tx, ty;
      if (sees) { tx = run.pos.x; ty = run.pos.y; }
      else {
        // Wander to a nearby spot it can actually see, so it never sets off
        // into a wall and grinds there.
        if (!e.wander || Math.hypot(e.wander.x - e.x, e.wander.y - e.y) < 1.2) {
          e.wander = null;
          for (let t = 0; t < 12 && !e.wander; t++) {
            const th = Math.random() * Math.PI * 2, r = 4 + Math.random() * 9;
            const wx = e.x + Math.cos(th) * r, wy = e.y + Math.sin(th) * r;
            if (Content.lineOfSight(plan, e.x, e.y, wx, wy)) e.wander = { x: wx, y: wy };
          }
          if (!e.wander) return;
        }
        tx = e.wander.x; ty = e.wander.y;
      }
      const dx = tx - e.x, dy = ty - e.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.05) return;
      e.facing = Math.atan2(dx, -dy) * 180 / Math.PI;
      const moved = Content.stepThrough(plan, e.x, e.y, e.facing, Math.min(step, d));
      e.x = moved.x; e.y = moved.y;
    });
  },

  /** Anything you are now standing on top of. */
  checkContact(inst, run) {
    if (this.busy || Game.inCombat) return;
    const plan = run.plan;
    const near = (e) => Math.hypot(e.x - run.pos.x, e.y - run.pos.y) <= this.CONTACT;

    const foe = (plan.entities || []).find(e => !e.dead && (e.kind === "monster" || e.kind === "boss") && near(e));
    if (foe) { this.fight(inst, run, foe); return; }

    const chest = (plan.entities || []).find(e => !e.dead && e.kind === "chest" && near(e));
    if (chest) { this.openChest(inst, run, chest); return; }

    const stairs = plan.stairs;
    if (stairs && Math.hypot(stairs.x - run.pos.x, stairs.y - run.pos.y) <= this.CONTACT * 2) {
      const guard = (plan.entities || []).some(e => !e.dead && e.kind === "boss");
      if (guard) { Game.instanceHint("Something is still guarding the way down."); return; }
      this.descend(inst, run);
    }
  },

  /* ------------------------------------------------------------- combat */
  entityNode(inst, run, e) {
    const kind = Content.instanceKind(inst.kind);
    const boss = e.kind === "boss";
    return {
      nodeId: "instfoe_" + run.runId + "_" + e.id,
      transient: true,
      type: boss ? "boss" : "combat",
      difficulty: clamp(+run.plan.difficulty || 3, 1, 10) + (boss ? 2 : 0),
      name: boss ? (inst.name || cap(kind.label)) + " · the thing on the stairs"
                 : (inst.name || cap(kind.label)) + " · " +
                   Content.levelName(inst, (inst.levels || [])[run.level], run.level),
      icon: boss ? "👑" : kind.icon,
      spawnTableId: e.spawnTableId || "",
      radius: Infinity, status: "discovered",
      latitude: +inst.latitude, longitude: +inst.longitude,
      distanceFromHome: 0,
      rewards: { experience: 0, gold: 0, items: [] },
      onResolved: (status, tally) => this.afterFight(status, tally, e.id)
    };
  },

  fight(inst, run, e) {
    if (Game.ch.stats.hp <= 1) {
      Game.instanceHint("It has you, and you can barely stand.");
      return;
    }
    this.busy = true;
    Combat.begin(this.entityNode(inst, run, e));
  },

  afterFight(status, tally, entityId) {
    this.busy = false;
    const run = this.current();
    if (!run) return;
    const e = (run.plan.entities || []).find(x => x.id === entityId);
    if (status === "won") {
      if (e) e.dead = true;
      run.totals.kills++;
      if (tally) {
        run.totals.experience += tally.experience || 0;
        run.totals.gold += tally.gold || 0;
      }
      this.saveRun(run);
      Game.renderInstanceMap();
      Game.renderInstanceBar();
      return;
    }
    if (status === "lost") {
      this.abandon(true);
      UI.toast("You're dragged out of the instance. The run is lost.", "bad", 5000);
      return;
    }
    // Fled: shove it off you so the fight doesn't restart on the same step.
    if (e) {
      const away = Math.atan2(e.x - run.pos.x, -(e.y - run.pos.y)) * 180 / Math.PI;
      const back = Content.stepThrough(run.plan, e.x, e.y, away, this.CONTACT * 2);
      e.x = back.x; e.y = back.y;
      this.saveRun(run);
    }
    UI.toast("You break away — but it is still between you and the rest of the floor.", "info", 4200);
    Game.renderInstanceMap();
  },

  /* -------------------------------------------------------------- chests */
  openChest(inst, run, e) {
    const c = Game.ch;
    const tier = Content.chestTier(e.chestTier);
    const got = [];
    if (e.lootTableId) {
      for (let r = 0; r < Math.max(1, tier.rolls); r++) {
        Content.rollLoot(e.lootTableId, { luck: c.attributes.luck }).forEach(defId => {
          const it = Content.toGameItem(defId, c.level);
          if (it && Game.giveItem(it)) got.push(it);
        });
      }
    } else {
      for (let i = 0; i < Math.max(1, tier.rolls); i++) {
        const it = Items.generate(c.level, c.attributes.luck, +run.plan.difficulty || 3);
        if (Game.giveItem(it)) got.push(it);
      }
    }
    const gold = Math.round((14 + (+run.plan.difficulty || 3) * 11) * rnd(0.8, 1.4) * (1 + run.level * 0.3));
    c.gold += gold;
    e.dead = true;
    run.totals.chests++;
    run.totals.gold += gold;
    this.saveRun(run);
    Characters.save(c);
    Game.renderHud();
    Game.renderInstanceMap();

    UI.modal({
      title: tier.label, icon: "🧰",
      body: '<div class="rewardRow"><span class="ic">🪙</span><div><b>' + gold + " gold</b></div></div>" +
            got.map(it => '<div class="rewardRow"><span class="ic">' + Content.itemIconHtml(it, 20) +
              '</span><div><b class="c-' + it.rarity + '">' + esc(it.name) +
              '</b><br><span class="tiny dim mono">' + esc(it.effect) + "</span></div></div>").join("") +
            (got.length ? "" : '<p class="tiny dim" style="margin:10px 0 0">Nothing but dust in it.</p>'),
      buttons: [{ label: "Take it", cls: "primary" }]
    });
  },

  /* -------------------------------------------------------- level change */
  descend(inst, run) {
    const c = Game.ch;
    const lvl = (inst.levels || [])[run.level];
    const pay = Content.instanceLevelRewards(inst, run.level);
    c.gold += pay.gold;
    Characters.addXp(c, pay.experience).forEach(g => Game.announceLevel(g));
    run.totals.levels++;
    run.totals.experience += pay.experience;
    run.totals.gold += pay.gold;

    const last = run.level >= (inst.levels.length - 1);
    if (last) { this.saveRun(run); this.finish(inst, run); return; }

    this.enterLevel(run, inst, run.level + 1);
    this.saveRun(run);
    Characters.save(c);
    Game.renderHud();
    Game.renderInstanceMap();
    Game.renderInstanceBar();

    UI.modal({
      title: Content.levelName(inst, lvl, run.level - 1) + " cleared", icon: "🪜",
      body: '<div class="rewardRow"><span class="ic">★</span><div><b>' + pay.experience + " experience</b></div></div>" +
            '<div class="rewardRow"><span class="ic">🪙</span><div><b>' + pay.gold + " gold</b></div></div>" +
            '<p style="margin:12px 0 0;color:var(--ink-2)">Down the stairs into <b>' +
            esc(Content.levelName(inst, inst.levels[run.level], run.level)) + "</b>.</p>" +
            this.levelBrief(inst, run.level),
      buttons: [{ label: "Go down", cls: "primary" }]
    });
  },

  finish(inst, run) {
    const c = Game.ch;
    const kind = Content.instanceKind(inst.kind);
    const bonusXp = Math.round(60 * inst.levels.length * (1 + (+inst.minLevel || 1) * 0.1));
    const bonusGold = Math.round(40 * inst.levels.length);
    c.gold += bonusGold;
    Characters.addXp(c, bonusXp).forEach(g => Game.announceLevel(g));
    const t = run.totals;
    this.markCleared(inst.instanceId);
    Characters.save(c);
    Game.exitInstanceView();
    Game.renderHud();

    const cd = +inst.respawnMinutes || 0;
    UI.modal({
      title: "Instance cleared", icon: kind.icon, noClose: true,
      body:
        '<p style="margin:0 0 12px;color:var(--ink-2)">You climb back out of <b>' +
          esc(inst.name || cap(kind.label)) + "</b>.</p>" +
        '<div class="rewardRow"><span class="ic">★</span><div><b>' + bonusXp + " experience</b><br>" +
          '<span class="tiny dim">completion bonus</span></div></div>' +
        '<div class="rewardRow"><span class="ic">🪙</span><div><b>' + bonusGold + " gold</b><br>" +
          '<span class="tiny dim">completion bonus</span></div></div>' +
        '<div class="statGrid" style="margin-top:12px">' +
          '<div class="s"><span>Levels</span><b>' + t.levels + "</b></div>" +
          '<div class="s"><span>Kills</span><b>' + t.kills + "</b></div>" +
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

  /* ---------------------------------------------------------- describing */
  levelBrief(d, index) {
    const l = (d.levels || [])[index];
    if (!l) return "";
    return '<div class="statGrid" style="margin-top:10px">' +
      '<div class="s"><span>Rooms</span><b>' + (+l.rooms || 6) + "</b></div>" +
      '<div class="s"><span>Monsters</span><b>' + (+l.monsters || 0) + (l.hasBoss ? " + boss" : "") + "</b></div>" +
      '<div class="s"><span>Chests</span><b>' + (+l.chests || 0) + "</b></div>" +
      "</div>";
  },

  /** The panel when you walk up to the door. */
  open(d, distance) {
    const kind = Content.instanceKind(d.kind);
    const run = this.current();
    const paused = this.pausedFor(d.instanceId);
    const levels = (d.levels || []).length;
    const gate = this.canEnter(d, distance);
    const pace = this.paceOf(d);

    let body =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<div class="avatar" style="width:46px;height:46px;font-size:24px">' + kind.icon + "</div>" +
        "<div><b style='font-size:15px'>" + esc(d.name || cap(kind.label)) + "</b><br>" +
        '<span class="tiny dim">' + cap(kind.label) + " · " + levels + " level" +
        (levels === 1 ? "" : "s") + "</span></div></div>" +
      '<div class="kv"><span>Distance</span><b>' + fmtDist(distance) + "</b></div>" +
      '<div class="kv"><span>Recommended</span><b>Level ' + (+d.minLevel || 1) + "+</b></div>" +
      '<div class="kv"><span>Pace</span><b>' + (pace === 1 ? "1 m walked = 1 m inside"
        : "1 m walked = " + pace + " m inside") + "</b></div>" +
      (d.notes ? '<p class="tiny dim" style="margin:10px 0 0">' + esc(d.notes) + "</p>" : "");

    const buttons = [{ label: "Close", cls: "ghost" }];
    if (run && run.instanceId === d.instanceId) {
      body += '<p class="tiny" style="color:var(--gold);margin:12px 0 0">You are inside this one right now.</p>';
    } else if (paused) {
      body += this.levelBrief(d, paused.level) +
        '<p class="tiny" style="color:var(--gold);margin:12px 0 0">A run is held here on ' +
        esc(Content.levelName(d, d.levels[paused.level], paused.level)) + ".</p>";
      buttons.push({ label: "Start over", cls: "ghost",
        onClick: () => { this.abandon(true); this.begin(d); } });
      buttons.push({ label: "Pick it up", cls: "primary", onClick: () => this.resume(d) });
    } else if (gate.ok) {
      body += this.levelBrief(d, 0);
      buttons.push({ label: "Go in", cls: "danger", onClick: () => this.begin(d) });
    } else {
      body += '<p class="tiny" style="color:var(--warn);margin:12px 0 0">' + esc(gate.why) + "</p>";
    }
    UI.modal({ title: cap(kind.label), icon: kind.icon, body, buttons,
               onClose: () => { Game._pendingInst = null; } });
  }
};
