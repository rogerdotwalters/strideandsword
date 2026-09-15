"use strict";
/* -------------------------------------------------------------------------
   THE QUESTS TAB — a chain of steps, and what is said at each one.

   Its own file for the same reason the dungeon layer has one in the map
   editor: a quest form is a list of nodes, each of which is a list of dialogue
   beats, each of which is a list of responses. Three levels of nesting is
   enough to swamp a file that also owns four other screens.

   WHY IT IS HERE AND NOT ON A MAP

   A quest node has no fixed position. It names a *role* — a forest, the market
   — and the game places it inside whichever of your real places plays that
   role, when you get there. There is nothing to drag, so there is nothing for
   a map to show, and the editor is a form.

   THE THREE NUMBERS THAT DECIDE WHERE A NODE LANDS

     boundary %   how much of the place it may use. 100 is the whole park,
                  50 is the middle half.
     min radius   the floor, so a small park does not collapse to a point
     max radius   a ceiling, 0 for "the place's own size"

   The floor beats the percentage, and the place's own size beats the floor —
   a 15 m pocket park cannot hold a 25 m quest area, and pretending otherwise
   puts the node in the road. That order is in `Haunts.areaRadiusM` and the
   preview in this form reads it rather than restating it.
   ------------------------------------------------------------------------- */
Object.assign(Ed, {

  /* ------------------------------------------------------------------ list */

  questRows(rows) {
    const head = this.th("name", "Name") + "<th class='num'>Steps</th>" +
      "<th>Goes to</th><th class='num'>Level</th><th>Giver</th><th>State</th>";
    const body = rows.map(q => {
      const nodes = Quests.nodesOf(q);
      const roles = nodes.map(n => Haunts.role(n.role).icon).join(" ");
      const giver = q.giverLocationId ? Content.get("locations", q.giverLocationId) : null;
      return '<tr data-id="' + q.questId + '" class="' + (this.selected === q.questId ? "on" : "") + '">' +
        '<td data-l="Name"><div class="nameCell"><span class="emojiIcon">📜</span><b>' +
          esc(q.name || "(unnamed)") + "</b></div></td>" +
        '<td class="num" data-l="Steps">' + nodes.length + "</td>" +
        '<td data-l="Goes to">' + roles + "</td>" +
        '<td class="num" data-l="Level">' + (+q.minLevel || 1) + "</td>" +
        '<td data-l="Giver">' + (giver ? esc(giver.name || "a location")
          : '<span class="dimmer">nobody yet</span>') + "</td>" +
        '<td data-l="State">' + (q.active === false ? '<span class="tag warn">off</span>'
          : q.repeatable ? '<span class="tag">repeatable</span>' : '<span class="tag ok">on</span>') + "</td></tr>";
    }).join("");
    return { head, body };
  },

  /* ------------------------------------------------------------------ form */

  questForm(host) {
    const d = this.draft;
    /* Open the first step unless the last thing you did was collapse one.
       A quest form with every step shut is a list of headings, and the first
       thing anybody does is open one. */
    const count = (d.nodes || []).length;
    if (this.openNode == null || this.openNode >= count) this.openNode = count ? 0 : -1;
    const locOptions = [{ value: "", label: "— nobody yet —" }].concat(
      Content.list("locations").map(l => ({
        value: l.locationId,
        label: (l.name || "(unnamed)") + (l.isQuestGiver ? "" : "  ⚠ not marked a giver")
      })));

    host.innerHTML =
      this.formHeader(d.name || "Quest") +
      '<div class="err" id="edErr"></div>' +
      this.fld("f_name", "Name", d.name) +
      '<label class="f"><span>Summary — the one line it is offered with</span>' +
        '<textarea id="f_summary">' + esc(d.summary || "") + "</textarea></label>" +
      this.sel("f_giverLocationId", "Handed out by", d.giverLocationId, locOptions) +
      '<p class="noteBox">A location only offers a quest if <b>This is a quest giver</b> is ticked ' +
        "on it in the map editor. Tick it there, pick it here.</p>" +
      '<div class="row2">' +
        this.fld("f_minLevel", "Minimum level", d.minLevel, { type: "number", min: 1 }) +
        '<label class="check" style="margin-top:22px"><input type="checkbox" id="f_repeatable"' +
          (d.repeatable ? " checked" : "") + "> Can be done again</label>" +
      "</div>" +
      '<label class="check"><input type="checkbox" id="f_active"' +
        (d.active === false ? "" : " checked") + "> On offer</label>" +

      '<div class="sect">Reward for finishing</div>' +
      '<div class="row2">' +
        this.fld("f_rewExp", "Experience", (d.rewards || {}).experience, { type: "number", min: 0 }) +
        this.fld("f_rewGold", "Gold", (d.rewards || {}).gold, { type: "number", min: 0 }) +
      "</div>" +

      '<div class="sect">Steps <span class="tiny dimmer">— in order</span></div>' +
      '<div id="qnList"></div>' +
      '<button class="btn ghost block" id="qnAdd">+ Add a step</button>' +
      '<label class="f" style="margin-top:14px"><span>Notes</span>' +
        '<textarea id="f_notes">' + esc(d.notes || "") + "</textarea></label>" +
      this.formActions();

    this.bind("f_name", "name", null, () => {
      const h = host.querySelector(".formHead h3");
      if (h) h.textContent = this.draft.name || "Quest";
    });
    this.bind("f_summary", "summary");
    this.bind("f_notes", "notes");
    this.bind("f_giverLocationId", "giverLocationId");
    this.bind("f_minLevel", "minLevel", this.int);
    this.bind("f_repeatable", "repeatable");
    this.bind("f_active", "active");
    const rew = (id, key) => {
      const n = $("#" + id);
      if (n) n.addEventListener("input", () => {
        this.draft.rewards = this.draft.rewards || {};
        this.draft.rewards[key] = this.int(n.value);
      });
    };
    rew("f_rewExp", "experience");
    rew("f_rewGold", "gold");

    $("#qnAdd").onclick = () => {
      this.draft.nodes = this.draft.nodes || [];
      this.draft.nodes.push(Quests.blankNode(this.draft.nodes.length + 1));
      this.openNode = this.draft.nodes.length - 1;
      this.renderQuestNodes();
    };
    this.renderQuestNodes();
  },

  /* ----------------------------------------------------------------- steps */

  renderQuestNodes() {
    const host = $("#qnList");
    if (!host) return;
    const nodes = this.draft.nodes || [];
    if (!nodes.length) {
      host.innerHTML = '<div class="emptyMsg">No steps yet. A quest is a chain of places —<br>' +
        "add the first one.</div>";
      return;
    }
    host.innerHTML = nodes.map((n, i) => {
      const open = this.openNode === i;
      const role = Haunts.role(n.role);
      const t = Quests.TRIGGERS[n.trigger] || Quests.TRIGGERS.arrive;
      return '<div class="floorBox' + (open ? " open" : "") + '" data-n="' + i + '">' +
        '<div class="floorHead" data-toggle="' + i + '">' +
          "<b>" + (i + 1) + ". " + esc(n.name || "(unnamed)") + "</b>" +
          '<span class="tiny dimmer">' + role.icon + " " + esc(role.name) + " · " + t.icon + " " +
            esc(t.name.toLowerCase()) +
            (n.trigger === "walk" ? " " + (+n.walkMeters || 0) + " m" : "") + "</span>" +
          '<span class="spacer"></span>' +
          (i > 0 ? '<button class="btn sm ghost" data-up="' + i + '" title="Earlier">↑</button>' : "") +
          (i < nodes.length - 1 ? '<button class="btn sm ghost" data-down="' + i + '" title="Later">↓</button>' : "") +
          '<button class="btn sm danger" data-del="' + i + '">✕</button>' +
        "</div>" +
        (open ? '<div class="floorBody">' + this.questNodeBody(n, i) + "</div>" : "") +
      "</div>";
    }).join("");

    host.querySelectorAll("[data-toggle]").forEach(el2 => {
      el2.onclick = (e) => {
        if (e.target.closest("button[data-up],button[data-down],button[data-del]")) return;
        const i = +el2.getAttribute("data-toggle");
        this.openNode = this.openNode === i ? -1 : i;
        this.renderQuestNodes();
      };
    });
    host.querySelectorAll("[data-up]").forEach(b => {
      b.onclick = () => { this.moveQuestNode(+b.getAttribute("data-up"), -1); };
    });
    host.querySelectorAll("[data-down]").forEach(b => {
      b.onclick = () => { this.moveQuestNode(+b.getAttribute("data-down"), 1); };
    });
    host.querySelectorAll("[data-del]").forEach(b => {
      b.onclick = () => {
        const i = +b.getAttribute("data-del");
        if (!confirm("Remove step " + (i + 1) + "?")) return;
        this.draft.nodes.splice(i, 1);
        this.openNode = -1;
        this.renderQuestNodes();
      };
    });
    if (this.openNode >= 0 && nodes[this.openNode]) this.wireQuestNode(nodes[this.openNode], this.openNode);
  },

  moveQuestNode(i, dir) {
    const nodes = this.draft.nodes;
    const j = i + dir;
    if (j < 0 || j >= nodes.length) return;
    const tmp = nodes[i]; nodes[i] = nodes[j]; nodes[j] = tmp;
    this.openNode = j;
    this.renderQuestNodes();
  },

  questNodeBody(n, i) {
    const spawnOptions = [{ value: "", label: "— none —" }].concat(
      Content.list("spawns").map(t => ({ value: t.spawnTableId, label: t.name })));
    const lootOptions = [{ value: "", label: "— none —" }].concat(
      Content.list("loot").map(t => ({ value: t.lootTableId, label: t.name })));
    const preview = this.boundaryPreview(n);

    return '<div class="row2">' +
        this.fld("qn_name" + i, "Name", n.name) +
        this.fld("qn_icon" + i, "Icon", n.icon) +
      "</div>" +
      this.sel("qn_role" + i, "Where it lands", n.role,
        Haunts.ROLES.map(r => ({ value: r.key, label: r.icon + " " + r.name + " — " + r.blurb.split(".")[0] }))) +

      '<div class="sect">How much of the place</div>' +
      '<div class="radiusRow">' +
        '<input type="range" id="qn_bpr' + i + '" min="5" max="100" step="5" value="' +
          (+n.boundaryPercent || 100) + '">' +
        '<input class="input" id="qn_bp' + i + '" type="number" min="5" max="100" value="' +
          (+n.boundaryPercent || 100) + '">' +
      "</div>" +
      '<div class="row2">' +
        this.fld("qn_min" + i, "Never smaller than (m)", n.minRadiusM, { type: "number", min: 5 }) +
        this.fld("qn_max" + i, "Never larger than (m, 0 = the place)", n.maxRadiusM, { type: "number", min: 0 }) +
      "</div>" +
      '<p class="noteBox" id="qn_prev' + i + '">' + preview + "</p>" +

      '<div class="sect">What finishes it</div>' +
      this.sel("qn_trigger" + i, "Trigger", n.trigger,
        Quests.TRIGGER_KEYS.map(k => ({ value: k,
          label: Quests.TRIGGERS[k].icon + " " + Quests.TRIGGERS[k].name + " — " + Quests.TRIGGERS[k].blurb }))) +
      '<div class="row2">' +
        this.fld("qn_radius" + i, "How close counts as there (m)", n.radius, { type: "number", min: 5 }) +
        this.fld("qn_walk" + i, "Metres to walk there", n.walkMeters, { type: "number", min: 0 }) +
      "</div>" +
      this.sel("qn_spawn" + i, "Monsters (for a fight)", n.spawnTableId, spawnOptions) +
      this.sel("qn_loot" + i, "Loot table (for a search)", n.chestLootTableId, lootOptions) +

      '<div class="sect">Flags</div>' +
      '<div class="row2">' +
        this.fld("qn_req" + i, "Only if this flag is set", n.requireFlag, { placeholder: "e.g. helped_tanner" }) +
        this.fld("qn_set" + i, "Set this flag when done", n.setFlag, { placeholder: "e.g. saw_the_beast" }) +
      "</div>" +

      '<div class="sect">Reward for this step</div>' +
      '<div class="row2">' +
        this.fld("qn_exp" + i, "Experience", (n.rewards || {}).experience, { type: "number", min: 0 }) +
        this.fld("qn_gold" + i, "Gold", (n.rewards || {}).gold, { type: "number", min: 0 }) +
      "</div>" +

      '<div class="sect">Dialogue</div>' +
      '<div id="qnBeats' + i + '"></div>' +
      '<button class="btn ghost block" id="qnBeatAdd' + i + '">+ Add a line</button>';
  },

  /** What the three numbers actually add up to, in metres, against real parks. */
  boundaryPreview(n) {
    const pct = +n.boundaryPercent || 100;
    const sizes = [{ label: "a 40 m pocket park", r: 40 },
                   { label: "a 120 m park", r: 120 },
                   { label: "a 400 m park", r: 400 }];
    const out = sizes.map(s => {
      const fake = { radiusM: s.r };
      return s.label + " → " + Haunts.areaRadiusM(fake, pct, n.minRadiusM, n.maxRadiusM) + " m";
    }).join(" · ");
    return "At " + pct + "%: " + out +
      ". The floor wins over the percentage, and the place's own size wins over the floor.";
  },

  wireQuestNode(n, i) {
    const on = (id, fn, ev) => {
      const e = $("#" + id);
      if (e) e.addEventListener(ev || "input", () => fn(e.type === "checkbox" ? e.checked : e.value));
    };
    const redrawHead = () => {
      // Only the summary line, so typing a name does not rebuild the open body
      // and lose the caret.
      const box = document.querySelector('.floorBox[data-n="' + i + '"] .floorHead b');
      if (box) box.textContent = (i + 1) + ". " + (n.name || "(unnamed)");
    };
    on("qn_name" + i, v => { n.name = v; redrawHead(); });
    on("qn_icon" + i, v => { n.icon = v; });
    on("qn_role" + i, v => { n.role = v; }, "change");
    on("qn_radius" + i, v => { n.radius = this.int(v); });
    on("qn_walk" + i, v => { n.walkMeters = this.int(v); });
    on("qn_trigger" + i, v => { n.trigger = v; this.renderQuestNodes(); }, "change");
    on("qn_spawn" + i, v => { n.spawnTableId = v; }, "change");
    on("qn_loot" + i, v => { n.chestLootTableId = v; if (v && !n.chestTier) n.chestTier = "iron"; }, "change");
    on("qn_req" + i, v => { n.requireFlag = v.trim(); });
    on("qn_set" + i, v => { n.setFlag = v.trim(); });
    on("qn_exp" + i, v => { n.rewards = n.rewards || {}; n.rewards.experience = this.int(v); });
    on("qn_gold" + i, v => { n.rewards = n.rewards || {}; n.rewards.gold = this.int(v); });

    /* The boundary: slider and box are two views of one number, and the
       preview under them updates as you move either. */
    const range = $("#qn_bpr" + i), box = $("#qn_bp" + i), prev = $("#qn_prev" + i);
    const syncBoundary = (v) => {
      n.boundaryPercent = clamp(this.int(v), 5, 100);
      if (range && +range.value !== n.boundaryPercent) range.value = n.boundaryPercent;
      if (box && +box.value !== n.boundaryPercent) box.value = n.boundaryPercent;
      if (prev) prev.innerHTML = this.boundaryPreview(n);
    };
    if (range) range.addEventListener("input", () => syncBoundary(range.value));
    if (box) box.addEventListener("input", () => syncBoundary(box.value));
    on("qn_min" + i, v => { n.minRadiusM = this.int(v); if (prev) prev.innerHTML = this.boundaryPreview(n); });
    on("qn_max" + i, v => { n.maxRadiusM = this.int(v); if (prev) prev.innerHTML = this.boundaryPreview(n); });

    this.renderBeats(n, i);
    $("#qnBeatAdd" + i).onclick = () => {
      n.dialogue = n.dialogue || [];
      n.dialogue.push(Quests.blankBeat(""));
      this.renderBeats(n, i);
    };
  },

  /* -------------------------------------------------------------- dialogue

     A beat is a speaker and a line. The last beat can carry responses, and a
     response is text plus an outcome — which is the whole branching model:
     no graph, no conditions, just "this answer sets a flag" and "this line
     only appears if that flag is set". */

  renderBeats(n, i) {
    const host = $("#qnBeats" + i);
    if (!host) return;
    const beats = n.dialogue || [];
    if (!beats.length) {
      host.innerHTML = '<p class="tiny dimmer">Nothing said here. Fine for a step that is ' +
        "purely somewhere to walk to.</p>";
      return;
    }
    host.innerHTML = beats.map((b, j) => {
      const last = j === beats.length - 1;
      return '<div class="beatBox">' +
        '<div class="beatHead"><span class="tiny dimmer">Line ' + (j + 1) +
          (last ? " · answers go here" : "") + "</span>" +
          '<span class="spacer"></span>' +
          (j > 0 ? '<button class="btn sm ghost" data-bup="' + j + '">↑</button>' : "") +
          '<button class="btn sm danger" data-bdel="' + j + '">✕</button>' +
        "</div>" +
        '<div class="row2">' +
          '<label class="f"><span>Speaker</span><input class="input" data-bspk="' + j +
            '" value="' + esc(b.speaker || "") + '" placeholder="The tanner"></label>' +
          '<label class="f"><span>Only if flag</span><input class="input" data-breq="' + j +
            '" value="' + esc(b.requireFlag || "") + '" placeholder="optional"></label>' +
        "</div>" +
        '<label class="f"><span>Line</span><textarea data-btext="' + j + '">' +
          esc(b.text || "") + "</textarea></label>" +
        (last ? this.responseBlock(b, j) : "") +
      "</div>";
    }).join("");

    host.querySelectorAll("[data-bspk]").forEach(e2 => {
      e2.oninput = () => { beats[+e2.getAttribute("data-bspk")].speaker = e2.value; };
    });
    host.querySelectorAll("[data-btext]").forEach(e2 => {
      e2.oninput = () => { beats[+e2.getAttribute("data-btext")].text = e2.value; };
    });
    host.querySelectorAll("[data-breq]").forEach(e2 => {
      e2.oninput = () => { beats[+e2.getAttribute("data-breq")].requireFlag = e2.value.trim(); };
    });
    host.querySelectorAll("[data-bdel]").forEach(b2 => {
      b2.onclick = () => { beats.splice(+b2.getAttribute("data-bdel"), 1); this.renderBeats(n, i); };
    });
    host.querySelectorAll("[data-bup]").forEach(b2 => {
      b2.onclick = () => {
        const j = +b2.getAttribute("data-bup");
        const t = beats[j]; beats[j] = beats[j - 1]; beats[j - 1] = t;
        this.renderBeats(n, i);
      };
    });

    const last = beats[beats.length - 1];
    const addR = $("#beatAddR" + i);
    if (addR) addR.onclick = () => {
      last.responses = last.responses || [];
      if (last.responses.length >= 4) { this.toast("Four answers is as many as fit.", "bad"); return; }
      last.responses.push(Quests.blankResponse());
      this.renderBeats(n, i);
    };
    host.querySelectorAll("[data-rtext]").forEach(e2 => {
      e2.oninput = () => { last.responses[+e2.getAttribute("data-rtext")].text = e2.value; };
    });
    host.querySelectorAll("[data-rout]").forEach(e2 => {
      e2.onchange = () => {
        last.responses[+e2.getAttribute("data-rout")].outcome = e2.value;
        this.renderBeats(n, i);
      };
    });
    host.querySelectorAll("[data-rgoto]").forEach(e2 => {
      e2.onchange = () => { last.responses[+e2.getAttribute("data-rgoto")].gotoNodeId = e2.value; };
    });
    host.querySelectorAll("[data-rset]").forEach(e2 => {
      e2.oninput = () => { last.responses[+e2.getAttribute("data-rset")].setFlag = e2.value.trim(); };
    });
    host.querySelectorAll("[data-rreq]").forEach(e2 => {
      e2.oninput = () => { last.responses[+e2.getAttribute("data-rreq")].requireFlag = e2.value.trim(); };
    });
    host.querySelectorAll("[data-rdel]").forEach(b2 => {
      b2.onclick = () => { last.responses.splice(+b2.getAttribute("data-rdel"), 1); this.renderBeats(n, i); };
    });
  },

  responseBlock(beat, j) {
    const rs = beat.responses || [];
    const nodeOptions = (this.draft.nodes || []).map((x, k) =>
      ({ value: x.nodeId, label: (k + 1) + ". " + (x.name || "step") }));
    return '<div class="respWrap">' +
      '<div class="tiny dimmer" style="margin-bottom:6px">Answers ' +
        "<span class='dimmer'>— none means a plain Close</span></div>" +
      rs.map((r, k) =>
        '<div class="respRow">' +
          '<input class="input" data-rtext="' + k + '" value="' + esc(r.text || "") +
            '" placeholder="What they say back">' +
          '<select data-rout="' + k + '">' +
            Object.values(Quests.OUTCOMES).map(o =>
              '<option value="' + o.key + '"' + (r.outcome === o.key ? " selected" : "") + ">" +
              esc(o.name) + "</option>").join("") +
          "</select>" +
          (r.outcome === "goto"
            ? '<select data-rgoto="' + k + '">' +
                [{ value: "", label: "— which step? —" }].concat(nodeOptions).map(o =>
                  '<option value="' + esc(o.value) + '"' +
                  (r.gotoNodeId === o.value ? " selected" : "") + ">" + esc(o.label) + "</option>").join("") +
              "</select>"
            : "") +
          '<input class="input" data-rset="' + k + '" value="' + esc(r.setFlag || "") +
            '" placeholder="sets flag">' +
          '<input class="input" data-rreq="' + k + '" value="' + esc(r.requireFlag || "") +
            '" placeholder="needs flag">' +
          '<button class="btn sm danger" data-rdel="' + k + '">✕</button>' +
        "</div>").join("") +
      '<button class="btn ghost sm" id="beatAddR' + this.openNode + '">+ Add an answer</button>' +
    "</div>";
  }
});
