/* -------------------------------------------------------------------------
   15. Screens: routing
   ------------------------------------------------------------------------- */
const Screens = {
  root: null,
  current: null,
  init() { this.root = $("#app"); },
  show(name, payload) {
    this.current = name;
    this.root.innerHTML = "";
    if (name === "auth")   this.auth();
    if (name === "select") this.characterSelect();
    if (name === "create") this.create();
    if (name === "game")   Game.mount(this.root, payload);
  },

  /* ---- Auth ---- */
  auth() {
    const wrap = el("div", "pageWrap");
    const inner = el("div", "pageInner");
    inner.innerHTML =
      '<div class="brand"><h1>Stride &amp; Sword</h1><p>Walk further · Fight harder</p></div>' +
      '<div class="tabs"><button id="tLogin" class="on">Sign in</button><button id="tReg">Create account</button></div>' +
      '<div class="card" style="padding:18px">' +
        '<div id="formLogin">' +
          '<label class="field"><span>Username</span><input class="input" id="liUser" autocomplete="username"></label>' +
          '<label class="field"><span>Password</span><input class="input" id="liPass" type="password" autocomplete="current-password"></label>' +
          '<div class="err" id="liErr"></div>' +
          '<button class="btn primary block" id="liGo">Enter the world</button>' +
        '</div>' +
        '<div id="formReg" class="hidden">' +
          '<label class="field"><span>Username</span><input class="input" id="rgUser" autocomplete="username"></label>' +
          '<label class="field"><span>Email</span><input class="input" id="rgMail" type="email" autocomplete="email"></label>' +
          '<label class="field"><span>Password</span><input class="input" id="rgPass" type="password" autocomplete="new-password"></label>' +
          '<div class="err" id="rgErr"></div>' +
          '<button class="btn primary block" id="rgGo">Create account</button>' +
        '</div>' +
      '</div>' +
      '<p class="tiny dimmer center" style="margin-top:16px;line-height:1.6">' +
        'Accounts live in this browser only. Passwords are obfuscated, not securely hashed — ' +
        'that moves server-side when the backend lands.' +
      '</p>';
    wrap.appendChild(inner);
    this.root.appendChild(wrap);

    const showTab = (reg) => {
      $("#tLogin").classList.toggle("on", !reg);
      $("#tReg").classList.toggle("on", reg);
      $("#formLogin").classList.toggle("hidden", reg);
      $("#formReg").classList.toggle("hidden", !reg);
    };
    $("#tLogin").onclick = () => showTab(false);
    $("#tReg").onclick   = () => showTab(true);

    const doLogin = async () => {
      const u = $("#liUser").value.trim(), p = $("#liPass").value;
      if (!u || !p) { $("#liErr").textContent = "Both fields are required."; return; }
      const r = await Auth.login(u, p);
      if (!r.success) { $("#liErr").textContent = r.message; return; }
      Screens.show("select");
    };
    const doReg = async () => {
      const u = $("#rgUser").value.trim(), m = $("#rgMail").value.trim(), p = $("#rgPass").value;
      if (u.length < 3) { $("#rgErr").textContent = "Username needs at least 3 characters."; return; }
      if (p.length < 4) { $("#rgErr").textContent = "Password needs at least 4 characters."; return; }
      const r = await Auth.register(u, m, p);
      if (!r.success) { $("#rgErr").textContent = r.message; return; }
      UI.toast("Welcome, " + esc(u) + ".", "good");
      Screens.show("create");
    };
    $("#liGo").onclick = doLogin;
    $("#rgGo").onclick = doReg;
    $("#liPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
    $("#rgPass").addEventListener("keydown", e => { if (e.key === "Enter") doReg(); });
  },

  /* ---- Character select ---- */
  characterSelect() {
    const chars = Object.values(Store.get(K.characters, {}) || {})
      .filter(c => c.userId === Auth.current.userId);
    if (!chars.length) { this.show("create"); return; }

    const wrap = el("div", "pageWrap");
    const inner = el("div", "pageInner");
    inner.innerHTML =
      '<div class="brand"><h1>Stride &amp; Sword</h1><p>Choose your character</p></div>' +
      '<div id="charList" style="display:flex;flex-direction:column;gap:9px;margin-bottom:16px"></div>' +
      '<button class="btn block" id="newChar">+ New character</button>' +
      '<button class="btn ghost block" id="signOut" style="margin-top:8px">Sign out</button>';
    wrap.appendChild(inner);
    this.root.appendChild(wrap);

    const list = $("#charList");
    chars.sort((a, b) => b.createdAt - a.createdAt).forEach(c => {
      Characters.refreshMaxes(c);
      const row = el("button", "pick");
      row.innerHTML =
        '<h4><span class="ico">' + CLASSES[c.class].icon + '</span>' + esc(c.name) + '</h4>' +
        '<p>Level ' + c.level + " " + c.race + " " + c.class +
          ' · <span class="mono">' + c.stats.hp + "/" + c.stats.maxHp + ' HP</span>' +
          ' · <span class="mono">' + c.gold + ' g</span></p>' +
        '<div class="mods">' + ATTRS.map(a =>
            "<span>" + a.short + " " + c.attributes[a.key] + "</span>").join("") + "</div>";
      row.onclick = () => Game.start(c);
      list.appendChild(row);

      const del = el("button", "btn sm ghost", "Delete");
      del.style.cssText = "margin-top:8px";
      del.onclick = (e) => {
        e.stopPropagation();
        UI.confirm("Delete " + c.name + "?", "This cannot be undone.", () => {
          Store.patch(K.characters, (all) => { delete all[c.characterId]; });
          Store.patch(K.inventories, (all) => { delete all[c.characterId]; });
          API.request("/character/" + c.characterId, "DELETE");
          Screens.show("select");
        });
      };
      row.appendChild(del);
    });
    $("#newChar").onclick = () => this.show("create");
    $("#signOut").onclick = () => Auth.logout();
  },

  /* ---- Character creation ---- */
  create() {
    const state = { step: 0, cls: null, race: null, alloc: Characters.blankAllocation(), name: "" };
    const wrap = el("div", "pageWrap");
    const inner = el("div", "pageInner wide");
    wrap.appendChild(inner);
    this.root.appendChild(wrap);

    const spent = () => ATTRS.reduce((s, a) => s + state.alloc[a.key], 0);
    const left  = () => Characters.POOL - spent();

    function render() {
      const steps = ["Class", "Heritage", "Attributes", "Name"];
      inner.innerHTML =
        '<div class="brand"><h1>New Character</h1><p>' + steps[state.step] + '</p></div>' +
        '<div class="stepBar">' + steps.map((s, i) =>
          '<div class="' + (i <= state.step ? "on" : "") + '"></div>').join("") + '</div>' +
        '<div id="stepBody"></div>' +
        '<div style="display:flex;gap:8px;margin-top:18px">' +
          '<button class="btn ghost" id="back">Back</button>' +
          '<button class="btn primary" id="next" style="flex:1">Continue</button>' +
        '</div>';
      const body = $("#stepBody", inner);

      if (state.step === 0) {
        const g = el("div", "pickGrid");
        Object.values(CLASSES).forEach(c => {
          const b = el("button", "pick" + (state.cls === c.name ? " on" : ""));
          b.innerHTML =
            '<h4><span class="ico">' + c.icon + "</span>" + c.name + "</h4><p>" + esc(c.blurb) + "</p>" +
            '<div class="mods">' +
              Object.entries(c.mods).map(([k, v]) => {
                const a = ATTRS.find(x => x.key === k);
                return "<span>+" + v + " " + a.short + "</span>";
              }).join("") +
              "<span>HP ×" + c.hpMul.toFixed(2) + "</span>" +
              "<span>uses " + c.resource + "</span>" +
            "</div>";
          b.onclick = () => { state.cls = c.name; render(); };
          g.appendChild(b);
        });
        body.appendChild(g);

      } else if (state.step === 1) {
        const g = el("div", "pickGrid");
        Object.values(RACES).forEach(r => {
          const b = el("button", "pick" + (state.race === r.name ? " on" : ""));
          b.innerHTML =
            '<h4><span class="ico">' + r.icon + "</span>" + r.name + "</h4><p>" + esc(r.blurb) + "</p>" +
            '<div class="mods">' + Object.entries(r.mods).map(([k, v]) => {
              const a = ATTRS.find(x => x.key === k);
              return "<span>" + (v > 0 ? "+" : "") + v + " " + a.short + "</span>";
            }).join("") + "</div>";
          b.onclick = () => { state.race = r.name; render(); };
          g.appendChild(b);
        });
        body.appendChild(g);

      } else if (state.step === 2) {
        const pool = el("div", "poolBox");
        pool.innerHTML = "<span>Points remaining</span><b id='ptsLeft'>" + left() + "</b>";
        body.appendChild(pool);

        const card = el("div", "card");
        const finals = Characters.finalAttributes(state.alloc, state.race, state.cls);
        ATTRS.forEach(a => {
          const row = el("div", "attrRow");
          const modTotal = finals[a.key] - (Characters.BASE_ATTR + state.alloc[a.key]);
          row.innerHTML =
            '<div class="nm">' + a.name + "<small>" + a.blurb + "</small></div>" +
            '<button class="stepper" data-dec="' + a.key + '"' + (state.alloc[a.key] <= 0 ? " disabled" : "") + ">−</button>" +
            '<div class="val">' + finals[a.key] + "</div>" +
            '<button class="stepper" data-inc="' + a.key + '"' + (left() <= 0 || state.alloc[a.key] >= 6 ? " disabled" : "") + ">+</button>" +
            '<div class="bonus ' + (modTotal > 0 ? "pos" : modTotal < 0 ? "neg" : "") + '">' +
              (modTotal === 0 ? "—" : (modTotal > 0 ? "+" : "") + modTotal) + "</div>";
          card.appendChild(row);
        });
        body.appendChild(card);

        const preview = el("div");
        const draft = Characters.create("preview", "Preview", state.cls, state.race, state.alloc);
        preview.innerHTML =
          '<h4 style="margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">Projected at level 1</h4>' +
          '<div class="previewGrid">' +
            pv("Health", draft.stats.maxHp) + pv("Mana", draft.stats.maxMana) +
            pv("Stamina", draft.stats.maxStamina) +
            pv("Attack", Math.round(Calc.attackPower(draft))) +
            pv("Spell", Math.round(Calc.spellPower(draft))) +
            pv("Armour", Calc.armor(draft)) +
            pv("Crit %", Calc.critChance(draft).toFixed(1)) +
            pv("Evasion", Calc.evasion(draft).toFixed(1)) +
          "</div>";
        body.appendChild(preview);

        body.addEventListener("click", (e) => {
          const inc = e.target.getAttribute && e.target.getAttribute("data-inc");
          const dec = e.target.getAttribute && e.target.getAttribute("data-dec");
          if (inc && left() > 0 && state.alloc[inc] < 6) { state.alloc[inc]++; render(); }
          if (dec && state.alloc[dec] > 0) { state.alloc[dec]--; render(); }
        });

      } else {
        const box = el("div", "card");
        box.style.padding = "18px";
        const draft = Characters.create("preview", "Preview", state.cls, state.race, state.alloc);
        box.innerHTML =
          '<label class="field"><span>Character name</span>' +
            '<input class="input" id="cName" maxlength="22" value="' + esc(state.name) + '" placeholder="e.g. Bram Ashwalk"></label>' +
          '<div class="err" id="cErr"></div>' +
          '<div class="divider"></div>' +
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
            '<div class="avatar" style="width:46px;height:46px;font-size:24px">' + CLASSES[state.cls].icon + "</div>" +
            "<div><b>" + state.race + " " + state.cls + "</b><br>" +
            '<span class="tiny dim">' + RACES[state.race].blurb + "</span></div></div>" +
          '<div class="statGrid">' + ATTRS.map(a =>
            '<div class="s"><span>' + a.short + "</span><b>" + draft.attributes[a.key] + "</b></div>").join("") + "</div>";
        body.appendChild(box);
        setTimeout(() => { const n = $("#cName"); if (n) n.focus(); }, 40);
      }

      $("#back", inner).onclick = () => {
        if (state.step === 0) {
          const has = Object.values(Store.get(K.characters, {}) || {})
            .some(c => c.userId === Auth.current.userId);
          Screens.show(has ? "select" : "auth");
          if (!has) Auth.logout();
        } else { state.step--; render(); }
      };
      const nextBtn = $("#next", inner);
      nextBtn.textContent = state.step === 3 ? "Begin" : "Continue";
      nextBtn.disabled = (state.step === 0 && !state.cls) || (state.step === 1 && !state.race);
      nextBtn.onclick = () => {
        if (state.step === 2 && left() > 0) {
          UI.toast("You still have " + left() + " points to spend.", "bad"); return;
        }
        if (state.step === 3) {
          const nm = ($("#cName").value || "").trim();
          if (nm.length < 2) { $("#cErr").textContent = "Give them a name of at least 2 characters."; return; }
          state.name = nm;
          const ch = Characters.create(Auth.current.userId, nm, state.cls, state.race, state.alloc);
          // A starter kit so round one isn't fists-only.
          const starter = Items.generate(1, ch.attributes.luck, 1,
            ch.class === "Mage" ? "weapon" : "weapon");
          const potion = Items.generate(1, 10, 1, "potion");
          ch.inventory = [starter, potion, Object.assign({}, potion, { itemId: uid("itm") })];
          Store.patch(K.characters, (all) => { all[ch.characterId] = ch; });
          Store.patch(K.inventories, (all) => { all[ch.characterId] = ch.inventory; });
          API.request("/character/create", "POST", ch);
          UI.toast(esc(nm) + " steps outside.", "good");
          Game.start(ch);
          return;
        }
        state.step++; render();
      };
    }
    function pv(label, val) {
      return '<div class="pv"><span>' + label + "</span><b>" + val + "</b></div>";
    }
    render();
  }
};
