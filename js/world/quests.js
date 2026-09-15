"use strict";
/* -------------------------------------------------------------------------
   12e. Quests — a chain of places, with something to say at each one.

   A quest is a **series of nodes**. Each node names a *role* rather than a
   place — "a forest", "the market" — and when it becomes the current one it
   is placed inside whichever of your haunts plays that role (js/world/
   haunts.js). Finish it and the next one appears somewhere else. That is the
   whole shape: the walking between them is the content, and the dialogue is
   what makes the walk mean something.

   WHERE ONE COMES FROM

   A hand-placed location can be marked a **quest giver**. Walk up to it, tap
   it, and it offers its quest instead of a fight. Nothing else changes about
   the location — it is the same row in the same table with one checkbox set,
   which is what keeps the map editor from growing a second kind of pin.

   TRIGGERS: WHAT FINISHES A NODE

     arrive   be inside its radius. The default, and the one that is purely
              about having walked there.
     walk     arrive, then cover N more metres. The node is a place you pace
              around, not a button.
     fight    arrive and win. Uses the node's spawn table, or the quest's.
     loot     arrive and open what is there.
     talk     arrive and get to the end of the dialogue. For the ones that are
              only a conversation.

   DIALOGUE: BEATS, RESPONSES, FLAGS

   A node carries an ordered list of **beats** — a speaker and a line. The last
   beat may offer **responses**, and a response has an outcome: go on, accept,
   decline, fight now, or jump to another node. A response can **set a flag**,
   and any beat or node can **require** one.

   That is deliberately one step short of a dialogue tree. Flags give the
   branching that matters ("did you help the tanner?") without a graph editor,
   a condition language, or cycle detection — and the data is a strict subset
   of a tree, so a canvas could be built over it later without touching the
   model.

   STATE

   Definitions live in `content_quests` with everything else you author.
   Progress is per character in `quest_runs`, because two characters running
   the same quest is normal and their flags must not collide.
   ------------------------------------------------------------------------- */
const Quests = {
  KEY: "quest_runs",

  TRIGGERS: {
    arrive: { key: "arrive", name: "Arrive",       icon: "📍", blurb: "Be inside the node's radius." },
    walk:   { key: "walk",   name: "Walk about",   icon: "🚶", blurb: "Arrive, then cover a set distance." },
    fight:  { key: "fight",  name: "Fight",        icon: "⚔️", blurb: "Arrive and win a fight." },
    loot:   { key: "loot",   name: "Search",       icon: "📦", blurb: "Arrive and open what is there." },
    talk:   { key: "talk",   name: "Talk",         icon: "💬", blurb: "Arrive and hear them out." }
  },
  TRIGGER_KEYS: ["arrive", "walk", "fight", "loot", "talk"],

  OUTCOMES: {
    next:    { key: "next",    name: "Carry on",        blurb: "Close the dialogue; the node's own trigger decides the rest." },
    accept:  { key: "accept",  name: "Accept the quest", blurb: "Take it on. Only means anything on a giver's dialogue." },
    decline: { key: "decline", name: "Walk away",        blurb: "Close it. The quest stays on offer." },
    fight:   { key: "fight",   name: "Start the fight",  blurb: "Straight into it, whatever the trigger says." },
    finish:  { key: "finish",  name: "Finish the node",  blurb: "Complete it here and now, trigger or no trigger." },
    goto:    { key: "goto",    name: "Jump to a node",   blurb: "Skip ahead or back. The branching one." }
  },

  /* ------------------------------------------------------------ definitions */

  list() { return Content.list("quests"); },
  get(id) { return Content.get("quests", id); },
  save(q) { return Content.save("quests", q); },

  /** Every quest handed out by this location. */
  forGiver(locationId) {
    if (!locationId) return [];
    return this.list().filter(q => q.active !== false && q.giverLocationId === locationId);
  },

  blank() {
    return {
      questId: "", name: "New quest", summary: "",
      giverLocationId: "",
      minLevel: 1,
      repeatable: false,
      active: true,
      notes: "",
      rewards: { experience: 0, gold: 0, itemIds: [] },
      nodes: [this.blankNode(1)]
    };
  },

  blankNode(index) {
    return {
      nodeId: uid("qn"),
      name: "Step " + (index || 1),
      role: "forest",                 // which of your places it lands in
      icon: "❗",
      /* Where inside that place it may land. The floor is what stops a small
         park being asked for a 25 m area it does not have. */
      boundaryPercent: 80,
      minRadiusM: 25,
      maxRadiusM: 0,                  // 0 = the place's own size
      radius: 30,                     // how close you must be to be "there"
      trigger: "arrive",
      walkMeters: 0,                  // trigger "walk"
      spawnTableId: "",               // trigger "fight"
      chestTier: "", chestLootTableId: "",   // trigger "loot"
      requireFlag: "",
      setFlag: "",
      dialogue: [],
      rewards: { experience: 0, gold: 0, itemIds: [] }
    };
  },

  blankBeat(speaker) {
    return { speaker: speaker || "", text: "", requireFlag: "", responses: [] };
  },

  blankResponse() {
    return { text: "Go on.", outcome: "next", gotoNodeId: "", setFlag: "", requireFlag: "" };
  },

  /** Nodes as authored, with anything unusable filtered out. */
  nodesOf(q) {
    return ((q && q.nodes) || []).filter(n => n && n.nodeId);
  },

  nodeAt(q, index) { return this.nodesOf(q)[index] || null; },
  nodeById(q, id) { return this.nodesOf(q).find(n => n.nodeId === id) || null; },
  indexOfNode(q, id) { return this.nodesOf(q).findIndex(n => n.nodeId === id); },

  /** What is wrong with this quest, in plain words, or "". */
  validate(q) {
    if (!q) return "No quest.";
    if (!String(q.name || "").trim()) return "A quest needs a name.";
    const nodes = this.nodesOf(q);
    if (!nodes.length) return "A quest needs at least one step.";
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!String(n.name || "").trim()) return "Step " + (i + 1) + " needs a name.";
      if (!Haunts.ROLES.some(r => r.key === n.role)) return "Step " + (i + 1) + " has no place to go.";
      if (n.trigger === "walk" && !(+n.walkMeters > 0)) {
        return "Step " + (i + 1) + " asks you to walk, but for no distance.";
      }
      if (+n.boundaryPercent < 5 || +n.boundaryPercent > 100) {
        return "Step " + (i + 1) + "'s boundary must be between 5% and 100%.";
      }
      const bad = (n.dialogue || []).some(b =>
        (b.responses || []).some(r => r.outcome === "goto" && !this.nodeById(q, r.gotoNodeId)));
      if (bad) return "Step " + (i + 1) + " has a response jumping to a step that is not there.";
    }
    return "";
  },

  /* ----------------------------------------------------------------- state */

  slotFor(characterId) {
    const all = Store.get(this.KEY, {}) || {};
    return all[characterId] || {};
  },
  writeSlot(characterId, slot) {
    Store.patch(this.KEY, (all) => { all[characterId] = slot; });
  },

  /** This character's progress on one quest, or null. */
  runOf(questId, characterId) {
    const id = characterId || (Game.ch && Game.ch.characterId);
    if (!id) return null;
    return this.slotFor(id)[questId] || null;
  },

  saveRun(run, characterId) {
    const id = characterId || (Game.ch && Game.ch.characterId);
    if (!id || !run) return null;
    const slot = this.slotFor(id);
    slot[run.questId] = run;
    this.writeSlot(id, slot);
    return run;
  },

  /** Every quest this character has in hand. */
  active(characterId) {
    const id = characterId || (Game.ch && Game.ch.characterId);
    if (!id) return [];
    return Object.values(this.slotFor(id))
      .filter(r => r.status === "active")
      .map(r => ({ run: r, quest: this.get(r.questId) }))
      .filter(x => !!x.quest);
  },

  status(questId, characterId) {
    const r = this.runOf(questId, characterId);
    return r ? r.status : "none";
  },

  /** Can this character take this quest on right now, and if not, why not? */
  canAccept(q, characterId) {
    if (!q) return { ok: false, why: "There is no quest here." };
    if (q.active === false) return { ok: false, why: "That is not on offer." };
    const ch = Game.ch;
    if (ch && ch.level < (+q.minLevel || 1)) {
      return { ok: false, why: "You need to be level " + q.minLevel + " for this." };
    }
    const run = this.runOf(q.questId, characterId);
    if (run && run.status === "active") return { ok: false, why: "You are already on this one." };
    if (run && run.status === "done" && !q.repeatable) {
      return { ok: false, why: "You have done this already." };
    }
    return { ok: true, why: "" };
  },

  /* ---------------------------------------------------------------- placing

     Putting the current node somewhere real. This is the only part that
     touches Haunts, and it runs once per node — the position is *stored* on
     the run, so a node does not wander every time the map redraws. */

  placeNode(q, node, opts) {
    opts = opts || {};
    const rnd = opts.rnd || Math.random;
    const haunt = Haunts.resolve(node.role, { rnd, at: opts.at, userId: opts.userId });
    if (!haunt) {
      // Nowhere at all — not even the atlas. Put it near the player so the
      // quest can still be finished; a stalled quest is worse than a vague one.
      const at = opts.at || Loc.last;
      if (!at) return null;
      const p = projectPoint(at.latitude, at.longitude, 80 + rnd() * 120, rnd() * 360);
      return { latitude: p.latitude, longitude: p.longitude, placeName: "somewhere nearby",
               role: node.role, improvised: true };
    }
    const spot = Haunts.pointIn(haunt, node.boundaryPercent, node.minRadiusM, node.maxRadiusM, rnd);
    return {
      latitude: spot.latitude, longitude: spot.longitude,
      placeName: haunt.name, realName: haunt.realName || "",
      role: node.role, slotKey: haunt.slotKey,
      areaM: Haunts.areaRadiusM(haunt, node.boundaryPercent, node.minRadiusM, node.maxRadiusM),
      inRing: !!spot.inRing, improvised: !!haunt.improvised
    };
  },

  /* ------------------------------------------------------------- the run */

  accept(q, opts) {
    const gate = this.canAccept(q);
    if (!gate.ok) return { ok: false, why: gate.why };
    const node = this.nodeAt(q, 0);
    if (!node) return { ok: false, why: "That quest has no steps in it." };
    const run = {
      questId: q.questId,
      characterId: (Game.ch || {}).characterId,
      status: "active",
      nodeIndex: 0,
      nodeId: node.nodeId,
      spawn: this.placeNode(q, node, opts),
      flags: {},
      walked: 0,
      startedAt: nowTs(),
      completions: (this.runOf(q.questId) || {}).completions || 0
    };
    this.saveRun(run);
    return { ok: true, run };
  },

  abandon(questId) {
    const run = this.runOf(questId);
    if (!run) return false;
    run.status = "abandoned";
    this.saveRun(run);
    return true;
  },

  /** The node this run is on, as authored. */
  currentNode(run) {
    const q = this.get(run && run.questId);
    if (!q) return null;
    return this.nodeById(q, run.nodeId) || this.nodeAt(q, run.nodeIndex || 0);
  },

  /**
   * Somewhere to draw, for every quest in hand. Shaped like the other things
   * on the map so the sidebar and the drawing code do not need to care which
   * kind of thing they are looking at.
   */
  liveNodes(characterId) {
    return this.active(characterId).map(({ run, quest }) => {
      const node = this.currentNode(run);
      if (!node || !run.spawn) return null;
      return {
        questId: quest.questId, nodeId: node.nodeId,
        name: node.name || quest.name,
        questName: quest.name,
        icon: node.icon || "❗",
        latitude: run.spawn.latitude, longitude: run.spawn.longitude,
        radius: +node.radius || 30,
        areaM: run.spawn.areaM || 0,
        placeName: run.spawn.placeName || "",
        trigger: node.trigger || "arrive",
        walkMeters: +node.walkMeters || 0,
        walked: +run.walked || 0,
        run, quest, node
      };
    }).filter(Boolean);
  },

  /* ------------------------------------------------------------- progress */

  /** Walking, while a walk-trigger node is the current one and you are on it. */
  addWalk(metres) {
    if (!isFinite(metres) || metres <= 0) return 0;
    let touched = 0;
    this.liveNodes().forEach(live => {
      if (live.trigger !== "walk") return;
      const at = Loc.last;
      if (!at) return;
      const d = haversine(at.latitude, at.longitude, live.latitude, live.longitude);
      // Only counts while you are actually at the place. Pacing about the
      // greenwood is the point; walking home is not progress on it.
      if (d > Math.max(live.radius, live.areaM || 0) + 20) return;
      live.run.walked = (+live.run.walked || 0) + metres;
      this.saveRun(live.run);
      touched++;
    });
    return touched;
  },

  /** Is this node's trigger satisfied right now? */
  triggerMet(live, opts) {
    opts = opts || {};
    const at = opts.at || Loc.last;
    if (!at) return false;
    const there = haversine(at.latitude, at.longitude, live.latitude, live.longitude) <= live.radius;
    if (!there) return false;
    switch (live.trigger) {
      case "walk":  return (+live.run.walked || 0) >= live.walkMeters;
      case "fight": return !!opts.wonFight;
      case "loot":  return !!opts.looted;
      case "talk":  return !!opts.talked;
      default:      return true;
    }
  },

  /**
   * Finish the current node and move on. Returns what happened so the caller
   * can say it out loud.
   */
  completeNode(run, opts) {
    opts = opts || {};
    const q = this.get(run.questId);
    const node = this.currentNode(run);
    if (!q || !node) return { ok: false };

    if (node.setFlag) run.flags[node.setFlag] = true;
    const paid = this.payOut(node.rewards);

    // Where next: an explicit jump wins, otherwise the next node in order.
    let nextIndex = (this.indexOfNode(q, node.nodeId) + 1);
    if (opts.gotoNodeId && this.nodeById(q, opts.gotoNodeId)) {
      nextIndex = this.indexOfNode(q, opts.gotoNodeId);
    }
    const next = this.nodeAt(q, nextIndex);

    if (!next) {
      run.status = "done";
      run.nodeId = "";
      run.spawn = null;
      run.completions = (+run.completions || 0) + 1;
      run.finishedAt = nowTs();
      /* Snapshot the name. A run outlives the quest that made it — delete the
         definition and the tally would otherwise list a row it cannot name. */
      run.name = q.name;
      const ch = Game.ch;
      if (ch) {
        ch.questsCompleted = (+ch.questsCompleted || 0) + 1;
        Characters.save(ch);
      }
      this.saveRun(run);
      const bonus = this.payOut(q.rewards);
      return { ok: true, finished: true, quest: q, node, paid, bonus };
    }

    run.nodeIndex = nextIndex;
    run.nodeId = next.nodeId;
    run.walked = 0;
    run.spawn = this.placeNode(q, next, opts);
    this.saveRun(run);
    return { ok: true, finished: false, quest: q, node, next, paid, spawn: run.spawn };
  },

  /** XP, gold and items from a rewards block. */
  payOut(rewards) {
    const c = Game.ch;
    const out = { experience: 0, gold: 0, items: [] };
    if (!c || !rewards) return out;
    const xp = Math.max(0, Math.round(+rewards.experience || 0));
    const gold = Math.max(0, Math.round(+rewards.gold || 0));
    if (xp) { Characters.addXp(c, xp).forEach(g => Game.announceLevel(g)); out.experience = xp; }
    if (gold) { c.gold += gold; out.gold = gold; }
    (rewards.itemIds || []).forEach(defId => {
      const it = Content.toGameItem(defId, c.level);
      if (it && Game.giveItem(it)) out.items.push(it);
    });
    if (xp || gold || out.items.length) { Characters.save(c); Game.renderHud(); }
    return out;
  },

  /* -------------------------------------------------------------- dialogue

     Beats are filtered by their flag requirement at the moment they are read,
     which is all the conditionality the model has and all it needs: a line
     that only makes sense if you helped the tanner simply is not there if you
     did not. */

  beatsFor(node, run) {
    const flags = (run && run.flags) || {};
    return (node.dialogue || []).filter(b => !b.requireFlag || flags[b.requireFlag]);
  },

  responsesFor(beat, run) {
    const flags = (run && run.flags) || {};
    return (beat.responses || []).filter(r => !r.requireFlag || flags[r.requireFlag]);
  },

  /** A response was chosen: record its flag and say what should happen. */
  choose(run, response) {
    if (!response) return { outcome: "next" };
    if (response.setFlag && run) {
      run.flags = run.flags || {};
      run.flags[response.setFlag] = true;
      this.saveRun(run);
    }
    return { outcome: response.outcome || "next", gotoNodeId: response.gotoNodeId || "" };
  },

  /* ---------------------------------------------------------------- admin */

  reset(characterId) {
    const id = characterId || (Game.ch && Game.ch.characterId);
    if (!id) return 0;
    const n = Object.keys(this.slotFor(id)).length;
    this.writeSlot(id, {});
    return n;
  },

  /**
   * What this character has finished, and how often.
   *
   * Derived from the runs rather than stored, so it cannot drift from them —
   * the number on the character is the headline, this is the detail behind it.
   */
  tally(characterId) {
    const id = characterId || (Game.ch && Game.ch.characterId);
    const rows = id ? Object.values(this.slotFor(id)) : [];
    const done = rows.filter(r => (+r.completions || 0) > 0);
    const list = done.map(r => {
      const q = this.get(r.questId);
      return {
        questId: r.questId,
        name: (q && q.name) || r.name || "A forgotten errand",
        completions: +r.completions || 0,
        lastAt: r.finishedAt || 0,
        gone: !q
      };
    }).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    return {
      completed: list.reduce((n, x) => n + x.completions, 0),
      unique: list.length,
      inHand: rows.filter(r => r.status === "active").length,
      list
    };
  },

  stats(characterId) {
    const id = characterId || (Game.ch && Game.ch.characterId);
    const slot = id ? this.slotFor(id) : {};
    const rows = Object.values(slot);
    return {
      defined: this.list().length,
      active: rows.filter(r => r.status === "active").length,
      done: rows.filter(r => r.status === "done").length,
      flags: rows.reduce((n, r) => n + Object.keys(r.flags || {}).length, 0)
    };
  }
};
