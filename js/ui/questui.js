"use strict";
/* -------------------------------------------------------------------------
   18b. Quests in the game — the picker, the map, the conversation.

   Three jobs, none of which belong in game.js:

     the picker    naming your real places, at character creation and from
                   the menu afterwards
     the map       drawing the node you are on, and putting it in the sidebar
     the talking   dialogue beats, responses, and what a response does

   The picker is the only part that needs the atlas, and it needs it in a very
   specific way: it offers what has actually been surveyed near you, by name
   and category, and falls back to dropping a pin for anything the survey
   missed. No geocoder, no extra service, no rate limit — the data is already
   on the device because you walked past it.
   ------------------------------------------------------------------------- */
Object.assign(Game, {

  /* ============================================================ THE PICKER */

  /**
   * Choose your places. Opens on the first slot that is still empty, or on
   * whichever one you asked for.
   */
  openHauntPicker(opts) {
    opts = opts || {};
    let slotIndex = 0;
    if (opts.slotKey) {
      const i = Haunts.SLOTS.findIndex(s => s.key === opts.slotKey);
      if (i >= 0) slotIndex = i;
    } else {
      const firstEmpty = Haunts.SLOTS.findIndex(s => !Haunts.get(s.key));
      slotIndex = firstEmpty < 0 ? 0 : firstEmpty;
    }

    const body = el("div", "hauntPick");
    let modal = null;
    const draw = () => {
      const slot = Haunts.SLOTS[slotIndex];
      const have = Haunts.get(slot.key);
      const prog = Haunts.progress();
      const near = this.hauntCandidates(slot);

      body.innerHTML =
        '<div class="hpStep">' +
          '<span class="tiny dimmer">' + (slotIndex + 1) + " of " + Haunts.SLOTS.length + "</span>" +
          "<b>" + esc(slot.label) + (slot.required ? "" : " <span class='tiny dimmer'>— optional</span>") + "</b>" +
          '<span class="tiny dim">' + esc(slot.hint) + "</span>" +
        "</div>" +
        (have
          ? '<div class="hpHave">' +
              '<span class="hpIco">' + Haunts.role(have.role).icon + "</span>" +
              "<div><b>" + esc(have.name) + "</b>" +
              (have.realName ? ' <span class="tiny dimmer">' + esc(have.realName) + "</span>" : "") +
              '<br><span class="tiny dim">' + esc(Haunts.role(have.role).name) +
              (have.ring ? " · real outline" : " · " + Math.round(have.radiusM) + " m circle") + "</span></div>" +
              '<button class="btn sm ghost" id="hpClear">Change</button>' +
            "</div>"
          : (near.length
              ? '<div class="hpList" id="hpList">' + near.map((c, i) =>
                  '<button class="hpRow" data-i="' + i + '">' +
                    '<span class="hpIco">' + (c.icon || "📍") + "</span>" +
                    '<span class="hpText"><b>' + esc(c.label) + "</b>" +
                      '<span class="tiny dim">' + esc(c.sub) + "</span></span>" +
                    '<span class="tiny dimmer mono">' + fmtDist(c.distance) + "</span>" +
                  "</button>").join("") + "</div>"
              : '<p class="tiny dim">Nothing surveyed near you yet for this. Walk a little, or drop a pin where you are standing.</p>')) +
        '<div class="hpPin">' +
          '<button class="btn sm ghost block" id="hpHere">Use where I am standing</button>' +
        "</div>" +
        '<div class="hpRole"><label class="field"><span>What is it in the world?</span>' +
          '<select id="hpRoleSel">' + Haunts.ROLES.map(r =>
            '<option value="' + r.key + '"' +
            ((have ? have.role : slot.role) === r.key ? " selected" : "") + ">" +
            r.icon + " " + esc(r.name) + "</option>").join("") + "</select></label>" +
          '<p class="tiny dimmer" id="hpBlurb"></p>' +
        "</div>" +
        '<div class="hpBar">' +
          '<button class="btn sm ghost" id="hpBack"' + (slotIndex ? "" : " disabled") + ">Back</button>" +
          '<span class="tiny dimmer">' + prog.set + " of " + prog.total + " chosen</span>" +
          '<button class="btn sm ' + (prog.ready ? "primary" : "ghost") + '" id="hpNext">' +
            (slotIndex >= Haunts.SLOTS.length - 1 ? "Done" : "Next") + "</button>" +
        "</div>";

      const roleSel = $("#hpRoleSel", body);
      const blurb = $("#hpBlurb", body);
      const showBlurb = () => { blurb.textContent = Haunts.role(roleSel.value).blurb; };
      showBlurb();
      roleSel.onchange = () => {
        showBlurb();
        const h = Haunts.get(slot.key);
        if (h) { h.role = roleSel.value; Haunts.set(slot.key, h); draw(); }
      };

      const list = $("#hpList", body);
      if (list) {
        list.querySelectorAll(".hpRow").forEach(btn => {
          btn.onclick = () => {
            const c = near[+btn.getAttribute("data-i")];
            Haunts.set(slot.key, Haunts.fromPlace(c.row, slot.key, roleSel.value));
            draw();
          };
        });
      }
      const clear = $("#hpClear", body);
      if (clear) clear.onclick = () => { Haunts.set(slot.key, null); draw(); };

      $("#hpHere", body).onclick = () => {
        const p = Loc.last;
        if (!p) { UI.toast("No position yet.", "bad"); return; }
        Haunts.set(slot.key, Haunts.fromPoint(p.latitude, p.longitude, slot.key, roleSel.value,
                                              slot.label, 70));
        draw();
      };
      $("#hpBack", body).onclick = () => { if (slotIndex) { slotIndex--; draw(); } };
      $("#hpNext", body).onclick = () => {
        if (slotIndex >= Haunts.SLOTS.length - 1) { modal && modal.close(); return; }
        slotIndex++; draw();
      };
    };

    draw();
    modal = UI.modal({
      title: "Your places", icon: "🗺️", body, wide: true,
      buttons: [{ label: "Close", cls: "ghost" }],
      onClose: () => { this.renderSiteList(true); this.drawQuestNodes(); }
    });
    return modal;
  },

  /**
   * What to offer for a slot: surveyed places nearby, the fitting category
   * first, then everything else. A building counts too — your local chippy is
   * a building with a name, not a park.
   */
  hauntCandidates(slot) {
    const p = Loc.last;
    if (!p || typeof Atlas === "undefined") return [];
    const out = [];
    const seen = {};

    (Atlas.nearPlaces(p.latitude, p.longitude, 1500) || []).forEach(x => {
      const row = x.row;
      if (seen[row.key]) return; seen[row.key] = 1;
      out.push({
        row, distance: x.d, icon: row.icon || "📍",
        label: row.name, sub: (row.realName ? row.realName + " · " : "") + (row.categoryLabel || row.category),
        fits: slot.category === "any" || row.category === slot.category ||
              (slot.category === "home" && row.category === "other")
      });
    });

    (Atlas.nearBuildings(p.latitude, p.longitude, 400) || []).forEach(x => {
      const row = x.row;
      if (seen[row.key]) return; seen[row.key] = 1;
      out.push({
        row: Object.assign({ category: "other" }, row),
        distance: x.d, icon: row.icon || "🏠",
        label: row.name, sub: (row.realName ? row.realName + " · " : "") + (row.kindLabel || "building"),
        fits: slot.category === "any" || slot.category === "home"
      });
    });

    // Fitting ones first, then by distance. Capped, because a list you scroll
    // for a minute is one you abandon.
    return out.sort((a, b) => (b.fits - a.fits) || (a.distance - b.distance)).slice(0, 14);
  },

  /* ========================================================== ON THE MAP */

  /** The node of every quest in hand, drawn as its own pin plus its area. */
  drawQuestNodes() {
    if (this.mapless || !this.map) return 0;
    if (!this.questLayer) this.questLayer = L.layerGroup().addTo(this.map);
    this.questLayer.clearLayers();
    const live = Quests.liveNodes();
    live.forEach(n => {
      // The area first, so the pin sits on top of it. It is drawn at all
      // because "somewhere in the park" is the honest shape of the objective —
      // a single pin would imply a precision the boundary does not have.
      if (n.areaM > n.radius) {
        this.questLayer.addLayer(L.circle([n.latitude, n.longitude], {
          radius: n.areaM, color: "#a76fd4", weight: 1, opacity: .35,
          fillColor: "#a76fd4", fillOpacity: .05, interactive: false
        }));
      }
      const m = L.marker([n.latitude, n.longitude], {
        icon: L.divIcon({
          className: "pinWrap", iconSize: [36, 36], iconAnchor: [18, 18],
          html: '<div class="questPin" data-quest="' + esc(n.questId) + '">' + n.icon + "</div>"
        }), zIndexOffset: 500
      });
      m.on("click", () => this.openQuestNode(n));
      this.questLayer.addLayer(m);
    });
    return live.length;
  },

  /** Walking, and standing on a quest node, both checked on a position fix. */
  checkQuestProximity() {
    if (this.inCombat) return;
    const p = Loc.last;
    if (!p) return;
    Quests.liveNodes().forEach(n => {
      const d = haversine(p.latitude, p.longitude, n.latitude, n.longitude);
      const pin = document.querySelector('.questPin[data-quest="' + n.questId + '"]');
      if (pin) pin.classList.toggle("inrange", d <= n.radius);
      // An arrive-node finishes itself: there is nothing to tap and nothing to
      // decide, so asking for a tap would only be ceremony. Everything else
      // waits for you.
      if (d <= n.radius && n.trigger === "arrive" && !n.node.dialogue.length) {
        this.finishQuestNode(n, {});
      }
    });
  },

  /* =========================================================== THE PANELS */

  /** Tapping a quest node: the conversation, or the thing it wants. */
  openQuestNode(live) {
    if (this.inCombat) return;
    const p = Loc.last;
    const d = p ? haversine(p.latitude, p.longitude, live.latitude, live.longitude) : null;
    const near = d != null && d <= live.radius;
    const beats = Quests.beatsFor(live.node, live.run);

    if (near && beats.length) { this.runDialogue(live, beats); return; }

    const t = Quests.TRIGGERS[live.trigger] || Quests.TRIGGERS.arrive;
    let body =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<div class="avatar" style="width:46px;height:46px;font-size:24px">' + live.icon + "</div>" +
        "<div><b style='font-size:15px'>" + esc(live.name) + "</b><br>" +
        '<span class="tiny dim">' + esc(live.questName) + "</span></div></div>" +
      '<div class="kv"><span>Where</span><b>' + esc(live.placeName || "nearby") + "</b></div>" +
      '<div class="kv"><span>Distance</span><b>' + fmtDist(d) + "</b></div>" +
      '<div class="kv"><span>To finish</span><b>' + t.icon + " " + esc(t.name) + "</b></div>" +
      (live.trigger === "walk"
        ? '<div class="kv"><span>Walked here</span><b>' + Math.round(live.walked) + " / " +
          live.walkMeters + " m</b></div>" : "");
    if (!near) {
      body += '<p class="tiny" style="color:var(--warn);margin:12px 0 0">Get within ' +
        live.radius + " m of it." + (live.areaM > live.radius
          ? " It is somewhere in " + esc(live.placeName) + " — the ring is the area it could be in."
          : "") + "</p>";
    }

    const buttons = [{ label: "Close", cls: "ghost" }];
    if (near) {
      if (live.trigger === "fight") {
        buttons.push({ label: "Fight", cls: "danger", onClick: () => this.questFight(live) });
      } else if (live.trigger === "loot") {
        buttons.push({ label: "Search it", cls: "primary", onClick: () => this.questLoot(live) });
      } else if (Quests.triggerMet(live, { at: p })) {
        buttons.push({ label: "Done here", cls: "primary", onClick: () => this.finishQuestNode(live, {}) });
      }
    }
    buttons.push({ label: "Abandon", cls: "ghost", onClick: () => {
      UI.confirm("Give up on " + (live.questName) + "?", "Your progress on it is lost.", () => {
        Quests.abandon(live.questId);
        this.drawQuestNodes(); this.renderSiteList(true);
        UI.toast("Quest abandoned.", "info");
      });
    } });
    UI.modal({ title: "Quest", icon: live.icon, body, buttons });
  },

  /**
   * Beats, one panel at a time, with the responses on the last one.
   *
   * `index` walks the filtered list rather than the authored one, so a beat
   * that needed a flag you do not have is simply not in the sequence.
   */
  runDialogue(live, beats, index) {
    const i = index || 0;
    const beat = beats[i];
    if (!beat) { this.afterDialogue(live, { outcome: "next" }); return; }
    const last = i >= beats.length - 1;
    const responses = last ? Quests.responsesFor(beat, live.run) : [];

    const body =
      (beat.speaker ? '<div class="dlgWho">' + esc(beat.speaker) + "</div>" : "") +
      '<p class="dlgLine">' + esc(beat.text || "…") + "</p>" +
      '<p class="tiny dimmer" style="margin:10px 0 0">' + esc(live.questName) +
        " · " + esc(live.name) + "</p>";

    const buttons = [];
    if (!last) {
      buttons.push({ label: "Go on", cls: "primary",
        onClick: () => { this.runDialogue(live, beats, i + 1); } });
    } else if (responses.length) {
      responses.forEach(r => {
        buttons.push({ label: r.text || "…", cls: r.outcome === "fight" ? "danger" : "primary",
          onClick: () => { this.afterDialogue(live, Quests.choose(live.run, r)); } });
      });
    } else {
      buttons.push({ label: "Close", cls: "ghost",
        onClick: () => { this.afterDialogue(live, { outcome: "next" }); } });
    }
    UI.modal({ title: live.name, icon: live.icon, body, buttons, wide: responses.length > 2 });
  },

  /** What a response actually does. */
  afterDialogue(live, choice) {
    const at = Loc.last;
    switch (choice.outcome) {
      case "fight":  this.questFight(live); return;
      case "finish": this.finishQuestNode(live, { gotoNodeId: choice.gotoNodeId }); return;
      case "goto":   this.finishQuestNode(live, { gotoNodeId: choice.gotoNodeId }); return;
      case "decline": return;
      default: break;
    }
    // A talk-node is finished by having been talked to; everything else goes
    // back to waiting for its own trigger.
    if (live.trigger === "talk" && at &&
        haversine(at.latitude, at.longitude, live.latitude, live.longitude) <= live.radius) {
      this.finishQuestNode(live, {});
      return;
    }
    if (Quests.triggerMet(live, { at })) this.finishQuestNode(live, {});
    else { this.drawQuestNodes(); this.renderSiteList(true); }
  },

  /** The fight a quest node asks for. Transient, like a dungeon's. */
  questFight(live) {
    const table = live.node.spawnTableId || live.quest.spawnTableId || "";
    const node = {
      nodeId: "qnode_" + live.nodeId, name: live.name,
      type: "combat", difficulty: Math.max(1, +live.node.difficulty || 4),
      latitude: live.latitude, longitude: live.longitude,
      icon: live.icon, status: "discovered",
      spawnTableId: table, transient: true,
      rewards: { experience: 0, gold: 0, items: [] },
      onResolved: (status) => {
        if (status !== "won") { UI.toast("Not this time.", "bad", 2600); return; }
        this.finishQuestNode(live, { wonFight: true });
      }
    };
    Combat.begin(node);
  },

  questLoot(live) {
    const n = live.node;
    const c = this.ch;
    const got = [];
    if (n.chestLootTableId) {
      const tier = Content.chestTier(n.chestTier);
      for (let r = 0; r < Math.max(1, tier.rolls); r++) {
        Content.rollLoot(n.chestLootTableId, { luck: c.attributes.luck }).forEach(defId => {
          const it = Content.toGameItem(defId, c.level);
          if (it && this.giveItem(it)) got.push(it);
        });
      }
    }
    if (got.length) {
      UI.toast("Found " + got.map(i => i.name).join(", "), "good", 3600);
    }
    this.finishQuestNode(live, { looted: true });
  },

  /** Finish the node, say what happened, and put the next one on the map. */
  finishQuestNode(live, opts) {
    const r = Quests.completeNode(live.run, Object.assign({ at: Loc.last }, opts || {}));
    if (!r.ok) return;
    this.drawQuestNodes();
    this.renderSiteList(true);
    this.renderHud();

    const paid = (p) => [
      p.experience ? p.experience + " XP" : "",
      p.gold ? p.gold + " gold" : "",
      p.items && p.items.length ? p.items.map(i => i.name).join(", ") : ""
    ].filter(Boolean).join(" · ");

    if (r.finished) {
      UI.modal({
        title: "Quest complete", icon: "🏆",
        body: '<p style="margin:0 0 12px"><b>' + esc(r.quest.name) + "</b> is done.</p>" +
              (paid(r.paid) ? '<div class="kv"><span>That step</span><b>' + esc(paid(r.paid)) + "</b></div>" : "") +
              (paid(r.bonus) ? '<div class="kv"><span>For finishing</span><b>' + esc(paid(r.bonus)) + "</b></div>" : ""),
        buttons: [{ label: "Good", cls: "primary" }]
      });
      return;
    }
    const where = (r.spawn && r.spawn.placeName) || "somewhere nearby";
    UI.toast((paid(r.paid) ? paid(r.paid) + " — n" : "N") + "ext: " +
             (r.next.name || "carry on") + ", at " + where + ".", "good", 5000);
  },

  /* ============================================================ THE GIVER */

  /** A location marked as a quest giver, tapped. */
  openQuestGiver(n, loc) {
    const quests = Quests.forGiver(loc.locationId);
    if (!quests.length) {
      UI.toast("They have nothing for you.", "info", 2600);
      return;
    }
    const q = quests[0];
    const gate = Quests.canAccept(q);
    const run = Quests.runOf(q.questId);
    const d = Loc.distanceTo(n);
    const inRange = d != null && d <= (+n.radius || settings().interactRange);

    let body =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<div class="avatar" style="width:46px;height:46px;font-size:24px">' + (n.icon || "❗") + "</div>" +
        "<div><b style='font-size:15px'>" + esc(q.name) + "</b><br>" +
        '<span class="tiny dim">Offered by ' + esc(n.name) + "</span></div></div>" +
      (q.summary ? '<p style="margin:0 0 12px;color:var(--ink-2)">' + esc(q.summary) + "</p>" : "") +
      '<div class="kv"><span>Steps</span><b>' + Quests.nodesOf(q).length + "</b></div>" +
      '<div class="kv"><span>Recommended</span><b>Level ' + (+q.minLevel || 1) + "+</b></div>" +
      (q.rewards && (q.rewards.experience || q.rewards.gold)
        ? '<div class="kv"><span>On completion</span><b>' +
          (q.rewards.experience ? q.rewards.experience + " XP" : "") +
          (q.rewards.gold ? " · " + q.rewards.gold + " g" : "") + "</b></div>" : "");

    if (run && run.status === "active") {
      const node = Quests.currentNode(run);
      body += '<p class="tiny" style="color:var(--gold);margin:12px 0 0">You are on this one — ' +
              esc((node && node.name) || "in progress") + ".</p>";
    } else if (!Haunts.ready()) {
      body += '<p class="tiny" style="color:var(--warn);margin:12px 0 0">' +
              "You have not named your places yet, so this will guess where to send you. " +
              "Menu → Your places sorts it.</p>";
    }
    if (!inRange) {
      body += '<p class="tiny" style="color:var(--warn);margin:12px 0 0">Walk up to them first.</p>';
    } else if (!gate.ok) {
      body += '<p class="tiny" style="color:var(--warn);margin:12px 0 0">' + esc(gate.why) + "</p>";
    }

    const buttons = [{ label: "Close", cls: "ghost" }];
    if (inRange && gate.ok) {
      buttons.push({ label: "Take it on", cls: "primary", onClick: () => {
        const r = Quests.accept(q, { at: Loc.last });
        if (!r.ok) { UI.toast(r.why, "bad", 3200); return; }
        this.drawQuestNodes();
        this.renderSiteList(true);
        const where = (r.run.spawn && r.run.spawn.placeName) || "somewhere nearby";
        const first = Quests.currentNode(r.run);
        UI.toast("Quest taken. First: " + ((first && first.name) || "get going") +
                 ", at " + where + ".", "good", 5200);
      } });
    }
    UI.modal({ title: "A word with you", icon: "📜", body, buttons });
  },

  /* ============================================================== THE LOG */

  questLog() {
    const rows = Quests.active();
    const body = el("div");
    const tally = Quests.tally((this.ch || {}).characterId);

    body.innerHTML =
      (rows.length
        ? rows.map(({ run, quest }) => {
            const node = Quests.currentNode(run);
            const t = Quests.TRIGGERS[(node && node.trigger) || "arrive"];
            return '<div class="qlRow">' +
              '<div class="qlHead"><b>' + esc(quest.name) + "</b>" +
                '<span class="tiny dimmer">' + ((run.nodeIndex || 0) + 1) + " / " +
                Quests.nodesOf(quest).length + "</span></div>" +
              (quest.summary ? '<p class="tiny dim">' + esc(quest.summary) + "</p>" : "") +
              '<div class="qlNow">' + (node ? t.icon + " " + esc(node.name) : "—") +
                (run.spawn && run.spawn.placeName
                  ? ' <span class="tiny dimmer">at ' + esc(run.spawn.placeName) + "</span>" : "") +
              "</div>" +
              (node && node.trigger === "walk"
                ? '<div class="tiny dimmer mono">' + Math.round(run.walked || 0) + " / " +
                  node.walkMeters + " m walked there</div>" : "") +
              (Object.keys(run.flags || {}).length
                ? '<div class="tiny dimmer">noted: ' + Object.keys(run.flags).join(", ") + "</div>" : "") +
            "</div>";
          }).join("")
        : '<div class="emptyMsg">Nothing in hand.<br>Quest givers are locations with a scroll on them.</div>') +
      (tally.completed
        ? '<div class="qlDone"><b>' + tally.completed + " finished</b>" +
          (tally.unique !== tally.completed ? " · " + tally.unique + " different" : "") +
          "</div>" +
          tally.list.slice(0, 10).map(q =>
            '<div class="qlPast"><span>📜</span><span class="nm">' + esc(q.name) +
            (q.gone ? ' <span class="tiny dimmer">(deleted)</span>' : "") + "</span>" +
            '<span class="tiny dimmer">' + (q.completions > 1 ? "×" + q.completions : "") +
            "</span></div>").join("")
        : "");

    UI.modal({ title: "Quests", icon: "📜", body, wide: true,
               buttons: [{ label: "Close", cls: "ghost" }] });
  }
});

/* -------------------------------------------------------------------------
   18c. The living world — creatures and characters on the real map.

   Everything here reads `Denizens`, which computes positions from the clock
   rather than storing them. So this file never simulates anything: it asks
   where things are, draws them, and redraws on the next position fix. A
   creature crosses its clearing while the phone is in a pocket because the
   position was never stored in the first place.
   ------------------------------------------------------------------------- */
Object.assign(Game, {

  /** How far out we bother computing them: what you can see, and no further. */
  denizenRangeM() { return (+settings().sightRadiusM || 300) + 60; },

  /**
   * Draw what is moving nearby, and the territories holding it.
   *
   * Redrawn on every position fix rather than animated: a fix is every second
   * or so and a leg is forty, so the movement reads as movement without a
   * frame loop to keep alive.
   */
  drawDenizens(now) {
    if (this.mapless || !this.map || typeof Denizens === "undefined") return 0;
    if (!this.denizenLayer) this.denizenLayer = L.layerGroup().addTo(this.map);
    this.denizenLayer.clearLayers();
    const p = Loc.last;
    if (!p) return 0;
    const t = now || Date.now();

    /* The territories first, faintly. Seeing the edge of the wolves' patch is
       most of what makes "it cannot leave" legible — without it a creature
       turning at an invisible line looks like a bug. */
    if (settings().showTerritories !== false) {
      Denizens.territories(p.latitude, p.longitude, this.denizenRangeM()).forEach(z => {
        const style = { color: z.zoneKind === "character" ? "#4a8fd4" : "#8a6524",
                        weight: 1, opacity: .35, dashArray: "7 6",
                        fillColor: z.zoneKind === "character" ? "#4a8fd4" : "#8a6524",
                        fillOpacity: .04, interactive: false };
        this.denizenLayer.addLayer(z.points && z.points.length > 2
          ? L.polygon(z.points, style)
          : L.circle([z.latitude, z.longitude], Object.assign({ radius: +z.radiusM || 50 }, style)));
      });
    }

    const live = Denizens.near(p.latitude, p.longitude, this.denizenRangeM(), t);
    live.forEach(d => {
      const near = d.distance <= (+settings().interactRange || 35);
      const m = L.marker([d.latitude, d.longitude], {
        icon: L.divIcon({
          className: "pinWrap", iconSize: [30, 30], iconAnchor: [15, 15],
          html: '<div class="denizenPin ' + d.kind + (near ? " inrange" : "") +
                '" data-denizen="' + esc(d.denizenId) + '">' + d.icon + "</div>"
        }), zIndexOffset: 400
      });
      m.on("click", () => this.openDenizen(d));
      this.denizenLayer.addLayer(m);
    });
    this._denizens = live;
    return live.length;
  },

  /** Tapping one: a fight, or a conversation. */
  openDenizen(d) {
    if (this.inCombat) return;
    const p = Loc.last;
    const dist = p ? haversine(p.latitude, p.longitude, d.latitude, d.longitude) : null;
    const range = +settings().interactRange || 35;
    const near = dist != null && dist <= range;

    if (d.kind === "character") { this.openWanderer(d, dist, near); return; }

    const body =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<div class="avatar" style="width:46px;height:46px;font-size:24px">' + d.icon + "</div>" +
        "<div><b style='font-size:15px'>" + esc(d.name) + "</b><br>" +
        '<span class="tiny dim">Difficulty ' + d.difficulty + "/10</span></div></div>" +
      '<div class="kv"><span>Distance</span><b>' + fmtDist(dist) + "</b></div>" +
      '<div class="kv"><span>Range</span><b>' + esc(d.zone.name || "its own patch") + "</b></div>" +
      (d.zone.placeName ? '<div class="kv"><span>In</span><b>' + esc(d.zone.placeName) + "</b></div>" : "") +
      '<p class="tiny dimmer" style="margin:12px 0 0">It is moving. Walk at it rather than to ' +
        "where it was.</p>" +
      (near ? "" : '<p class="tiny" style="color:var(--warn);margin:8px 0 0">Get within ' +
        range + " m of it.</p>");

    const buttons = [{ label: "Leave it", cls: "ghost" }];
    if (near) buttons.push({ label: "Fight", cls: "danger", onClick: () => this.fightDenizen(d) });
    UI.modal({ title: "A creature", icon: d.icon, body, buttons });
  },

  fightDenizen(d) {
    const node = Denizens.toNode(d);
    node.onResolved = (status) => {
      if (status !== "won") return;
      // It stays dead for a while. Not forever: the wood refills, and a patch
      // you cleared is worth walking back to.
      Denizens.kill(d.denizenId);
      this.drawDenizens();
      this.renderSiteList(true);
    };
    Combat.begin(node);
  },

  /** A character you meet on the road. They may be carrying work. */
  openWanderer(d, dist, near) {
    const quest = d.questId ? Quests.get(d.questId) : null;
    const gate = quest ? Quests.canAccept(quest) : null;
    const run = quest ? Quests.runOf(quest.questId) : null;

    let body =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<div class="avatar" style="width:46px;height:46px;font-size:24px">' + d.icon + "</div>" +
        "<div><b style='font-size:15px'>" + esc(d.name) + "</b><br>" +
        '<span class="tiny dim">' + esc(Denizens.ROAMS[d.roams] ? Denizens.ROAMS[d.roams].name : "wandering") +
        "</span></div></div>" +
      '<div class="kv"><span>Distance</span><b>' + fmtDist(dist) + "</b></div>" +
      (d.zone.placeName ? '<div class="kv"><span>Seen around</span><b>' +
        esc(d.zone.placeName) + "</b></div>" : "");

    if (quest) {
      body += '<p style="margin:12px 0 0;color:var(--ink-2)">' + esc(quest.summary || quest.name) + "</p>";
      if (run && run.status === "active") {
        body += '<p class="tiny" style="color:var(--gold);margin:8px 0 0">You are already on this.</p>';
      } else if (gate && !gate.ok) {
        body += '<p class="tiny" style="color:var(--warn);margin:8px 0 0">' + esc(gate.why) + "</p>";
      }
    } else {
      body += '<p class="tiny dimmer" style="margin:12px 0 0">Nothing for you today.</p>';
    }
    if (!near) {
      body += '<p class="tiny" style="color:var(--warn);margin:8px 0 0">Catch up with them first.</p>';
    }

    const buttons = [{ label: "Close", cls: "ghost" }];
    if (near && quest && gate && gate.ok) {
      buttons.push({ label: "Take it on", cls: "primary", onClick: () => {
        const r = Quests.accept(quest, { at: Loc.last });
        if (!r.ok) { UI.toast(r.why, "bad", 3200); return; }
        this.drawQuestNodes(); this.renderSiteList(true);
        const first = Quests.currentNode(r.run);
        UI.toast("Quest taken. First: " + ((first && first.name) || "get going") + ".", "good", 4600);
      } });
    }
    UI.modal({ title: esc(d.name), icon: d.icon, body, buttons });
  }
});
