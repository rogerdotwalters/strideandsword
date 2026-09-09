/* -------------------------------------------------------------------------
   14. Toasts & tiny UI helpers
   ------------------------------------------------------------------------- */
const UI = {
  toastHost: null,
  toast(msg, kind, ms) {
    if (!this.toastHost) {
      this.toastHost = el("div"); this.toastHost.id = "toasts";
      document.body.appendChild(this.toastHost);
    }
    const t = el("div", "toast " + (kind || ""), msg);
    this.toastHost.appendChild(t);
    while (this.toastHost.children.length > 3) this.toastHost.removeChild(this.toastHost.firstChild);
    setTimeout(() => {
      t.style.transition = "opacity .3s,transform .3s";
      t.style.opacity = "0"; t.style.transform = "translateY(-8px)";
      setTimeout(() => t.remove(), 320);
    }, ms || 2600);
  },
  modal(opts) {
    const back = el("div", "modalBack");
    const m = el("div", "modal" + (opts.wide ? " lg" : ""));
    const head = el("div", "modalHead",
      (opts.icon ? '<span style="font-size:19px">' + opts.icon + "</span>" : "") +
      "<h3>" + esc(opts.title || "") + "</h3>");
    if (!opts.noClose) {
      const x = el("button", "closeX", "✕");
      x.onclick = () => close();
      head.appendChild(x);
    }
    const body = el("div", "modalBody");
    if (typeof opts.body === "string") body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    m.appendChild(head); m.appendChild(body);

    if (opts.buttons && opts.buttons.length) {
      const foot = el("div", "modalFoot");
      opts.buttons.forEach(b => {
        const btn = el("button", "btn " + (b.cls || "ghost"), b.label);
        btn.onclick = () => { const keep = b.onClick && b.onClick(close, body); if (!keep) close(); };
        foot.appendChild(btn);
      });
      m.appendChild(foot);
    }
    back.appendChild(m);
    if (!opts.noClose) back.addEventListener("click", (e) => { if (e.target === back) close(); });
    document.body.appendChild(back);
    function close() { back.remove(); if (opts.onClose) opts.onClose(); }
    return { close, body, root: back };
  },
  confirm(title, msg, onYes) {
    this.modal({
      title, body: '<p style="margin:0;color:var(--ink-2)">' + esc(msg) + "</p>",
      buttons: [
        { label: "Cancel", cls: "ghost" },
        { label: "Confirm", cls: "danger", onClick: () => { onYes(); } }
      ]
    });
  },
  bar(kind, cur, max) {
    const pct = max > 0 ? clamp(cur / max * 100, 0, 100) : 0;
    return '<div class="track"><div class="fill ' + kind + '" style="width:' + pct + '%"></div></div>';
  }
};

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

/* -------------------------------------------------------------------------
   16. Game controller + map + HUD
   ------------------------------------------------------------------------- */
const Game = {
  ch: null, zone: null, nodes: [], map: null, mapless: false,
  playerMarker: null, accCircle: null, zoneCircle: null,
  nodeMarkers: {}, rangeCircle: null,
  inCombat: false, locMsg: "", trail: null, trailPts: [],
  _pendingNode: null, _regenTimer: null,

  reset() {
    Loc.stop();
    if (this._regenTimer) clearInterval(this._regenTimer);
    this.ch = null; this.zone = null; this.nodes = []; this.map = null;
    this.nodeMarkers = {}; this.trailPts = []; this.inCombat = false;
    this.mapless = false;
    this.world = null; this._worldZone = null; this._worldBusy = false;
    this.tiles = null; this.worldLayer = null;
    this.streetLabels = null; this.buildingLabels = null;
    this._locPrompt = false;
  },

  start(ch) {
    Characters.refreshMaxes(ch);
    this.ch = ch;
    const inv = Store.get(K.inventories, {}) || {};
    if (inv[ch.characterId]) ch.inventory = inv[ch.characterId];
    Screens.show("game");
  },

  mount(root) {
    const screen = el("div", "screen");
    screen.id = "gameScreen";
    screen.innerHTML =
      '<div id="map"></div>' +
      '<div class="topBar">' +
        '<div class="charChip">' +
          '<div class="avatar" id="chAvatar"></div>' +
          '<div class="who"><b id="chName"></b><span id="chSub"></span></div>' +
        "</div>" +
        '<div class="spacer"></div>' +
        '<button class="iconBtn" id="btnSheet" title="Character">📋</button>' +
        '<button class="iconBtn" id="btnBag" title="Inventory">🎒</button>' +
        '<button class="iconBtn" id="btnMenu" title="Menu">☰</button>' +
      "</div>" +
      '<div id="devPanel" class="hidden"></div>' +
      '<div class="bars">' +
        '<div class="modeRow" id="modeRow">' +
          '<label class="modeLbl">' +
            '<input type="checkbox" id="modeToggle">' +
            '<span class="lbl">Dev test <small>simulate my location</small></span>' +
          "</label>" +
          '<button class="gpsChip" id="wGps">…</button>' +
        "</div>" +
        '<div class="walkStrip">' +
          '<div class="st"><span>Today</span><b id="wToday">0 m</b></div>' +
          '<div class="st"><span>All time</span><b id="wTotal">0 m</b></div>' +
          '<div class="st"><span>Nearest</span><b id="wNear">--</b></div>' +
        "</div>" +
        '<div class="barsInner">' +
          '<div class="bar"><span class="lbl">❤</span>' + UI.bar("hp", 1, 1) + '<span class="num" id="nHp"></span></div>' +
          '<div class="bar"><span class="lbl">✦</span>' + UI.bar("mp", 1, 1) + '<span class="num" id="nMp"></span></div>' +
          '<div class="bar"><span class="lbl">⚡</span>' + UI.bar("sp", 1, 1) + '<span class="num" id="nSp"></span></div>' +
          '<div class="bar"><span class="lbl">★</span>' + UI.bar("xp", 0, 1) + '<span class="num" id="nXp"></span></div>' +
        "</div>" +
      "</div>";
    root.appendChild(screen);

    $("#btnSheet").onclick = () => Panels.sheet();
    $("#btnBag").onclick   = () => Panels.inventory();
    $("#btnMenu").onclick  = () => Panels.menu();

    const toggle = $("#modeToggle");
    toggle.checked = settings().locationMode === "sim";
    toggle.onchange = (e) => this.setLocationMode(e.target.checked ? "sim" : "gps");
    $("#wGps").onclick = () => {
      if (settings().locationMode === "sim") { this.setLocationMode("gps"); return; }
      if (Loc.status === "live") { this.locationDiagnostics(); return; }
      this.beginLocation(true);
    };

    this.initMap();
    this.renderHud();
    this.buildDevPanel();

    Loc.onUpdate(() => this.onPosition());
    this.beginLocation();

    // If a watch is running but nothing arrives, say so — never silently
    // pretend to be somewhere.
    setTimeout(() => {
      if (!Loc.last && settings().locationMode === "gps" && Loc.watchId != null) {
        this.onLocationProblem("Still waiting on a location fix.", 3);
      }
    }, 25000);

    this._regenTimer = setInterval(() => this.passiveRegen(), 12000);
  },

  /* ---- Map ---- */
  initMap() {
    const s = settings();
    const start = Loc.last || { latitude: 41.8827, longitude: -87.6233 };

    // Leaflet comes off a CDN. If it didn't load (offline, blocked network),
    // fall back to a compass list so the game is still playable.
    if (typeof L === "undefined") {
      this.mapless = true;
      this.buildListView();
      setTimeout(() => UI.toast(
        "Map library didn't load — switched to list view. Reconnect and reload for the map.", "bad", 6500), 400);
      return;
    }

    // maxZoom 22 with maxNativeZoom 19 means deep zoom upscales the last real
    // tile instead of requesting tiles that don't exist and going blank.
    this.map = L.map("map", {
      zoomControl: true, attributionControl: true,
      maxZoom: 22, minZoom: 12, zoomSnap: 0.5, zoomDelta: 0.5
    }).setView([start.latitude, start.longitude], s.mapZoom);

    this.tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 22, maxNativeZoom: 19, minZoom: 12, keepBuffer: 3,
      opacity: s.fantasyMap ? s.tileOpacity : 1,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(this.map);

    this.worldLayer = L.layerGroup().addTo(this.map);   // fantasy roads + buildings
    this.trail = L.polyline([], { color: "#4a8fd4", weight: 3, opacity: .5, dashArray: "4 6" }).addTo(this.map);

    // Dev: click to teleport (only while dev testing is switched on)
    this.map.on("click", (e) => {
      if (settings().locationMode !== "sim") return;
      Loc.simulateTo(e.latlng.lat, e.latlng.lng);
      UI.toast("Moved to " + e.latlng.lat.toFixed(5) + ", " + e.latlng.lng.toFixed(5), "info", 1500);
    });

    this.map.on("zoomend", () => this.applyZoomDetail());
    this.applyZoomDetail();
  },

  /** Buildings and street labels only make sense close in. */
  applyZoomDetail() {
    if (this.mapless || !this.map) return;
    const z = this.map.getZoom();
    const s = settings();
    const host = $("#map");
    if (host) host.classList.toggle("zBuildings", z >= 16);
    const swap = (layer, on) => {
      if (!layer) return;
      const has = this.map.hasLayer(layer);
      if (on && !has) this.map.addLayer(layer);
      if (!on && has) this.map.removeLayer(layer);
    };
    swap(this.streetLabels, s.fantasyMap && z >= s.labelZoom);
    swap(this.buildingLabels, s.fantasyMap && z >= s.labelZoom + 1.5);

    // Stroke width is in pixels, so roads need restyling as you zoom or they
    // read as hairlines up close and as a smear far out.
    if (this.roadLayers && this._styledZoom !== z) {
      this._styledZoom = z;
      this.roadLayers.forEach(r => {
        const st = OSM.roadStyle(r.highway, z);
        r.layer.setStyle({ weight: st.weight, opacity: st.opacity });
      });
    }
  },

  ensureZone() {
    if (this.zone || !Loc.last) return;
    const existing = Zones.zonesFor(this.ch.userId);
    const near = existing.find(z =>
      haversine(z.centerLatitude, z.centerLongitude, Loc.last.latitude, Loc.last.longitude) < z.radius * 1.6);
    if (near) {
      this.zone = near;
      this.nodes = Zones.nodesIn(near.zoneId);
      if (!this.nodes.length) this.nodes = Zones.generateNodes(near, null, this.ch.level);
    } else {
      this.zone = Zones.createZone(this.ch.userId, Loc.last.latitude, Loc.last.longitude, "Office Grounds");
      this.nodes = Zones.generateNodes(this.zone, null, this.ch.level);
      UI.toast("Zone anchored. " + this.nodes.length + " sites scattered nearby.", "good", 3400);
    }
    this.drawZone();
    this.drawNodes();
    this.loadWorld();
  },

  /* ---- The fantasy town: real OSM geometry, renamed and restyled ---- */
  async loadWorld(force) {
    if (this.mapless || !this.zone || this._worldBusy) return;
    if (!settings().fantasyMap) return;
    if (this._worldZone === this.zone.zoneId && !force) return;
    this._worldBusy = true;
    this._worldZone = this.zone.zoneId;

    const cacheKey = OSM.cacheKey(this.zone);
    let elements = force ? null : Store.get(cacheKey, null);

    if (!elements) {
      UI.toast("Surveying the streets…", "info", 2600);
      const r = await OSM.fetchAround(this.zone.centerLatitude, this.zone.centerLongitude,
                                      Math.round(this.zone.radius + 140));
      if (!r.success) {
        this._worldBusy = false;
        this._worldZone = null;
        UI.toast("Couldn't reach the map data service — showing the plain map. " +
                 "Try 'Resurvey the streets' from the menu later.", "bad", 6000);
        if (this.tiles) this.tiles.setOpacity(1);
        return;
      }
      elements = r.elements;
      // Cache geometry so a reload is instant and works offline.
      try {
        const payload = JSON.stringify(elements);
        if (payload.length < 2000000) Store.set(cacheKey, elements);
      } catch (e) { /* over quota — fine, we just refetch next time */ }
    }

    const world = OSM.digest(elements);
    this.world = world;
    this.renderWorld(world);
    this.snapNodesToBuildings(world);
    this._worldBusy = false;

    const st = Atlas.stats();
    UI.toast("The town takes shape: " + world.buildings.length + " buildings and " +
             st.streetNames + " named roads.", "good", 4200);
  },

  renderWorld(world) {
    if (this.mapless || !this.worldLayer) return;
    this.worldLayer.clearLayers();
    if (!this.streetLabels) this.streetLabels = L.layerGroup();
    if (!this.buildingLabels) this.buildingLabels = L.layerGroup();
    this.streetLabels.clearLayers();
    this.buildingLabels.clearLayers();
    const s = settings();
    if (this.tiles) this.tiles.setOpacity(s.fantasyMap ? s.tileOpacity : 1);

    // Roads first so buildings sit on top of them.
    this.roadLayers = [];
    const z0 = this.map.getZoom();
    world.roads.forEach(r => {
      const st = OSM.roadStyle(r.highway, z0);
      const line = L.polyline(r.line, {
        color: st.color, weight: st.weight, opacity: st.opacity,
        dashArray: st.dash, lineCap: "round", lineJoin: "round",
        className: "fRoad " + st.cls, interactive: true
      });
      line.bindTooltip(r.row.name, { className: "streetLabel", direction: "center", sticky: true });
      line.on("click", (e) => {
        L.DomEvent.stop(e);
        this.describeStreet(r.row);
      });
      this.worldLayer.addLayer(line);
      this.roadLayers.push({ layer: line, highway: r.highway });
    });

    world.buildings.forEach(b => {
      const kind = Atlas.KINDS[b.row.kind] || Atlas.KINDS.cottage;
      const poly = L.polygon(b.ring, {
        color: kind.color, weight: 1.2, opacity: .9,
        fillColor: kind.color, fillOpacity: .32,
        className: "fBuilding", interactive: true
      });
      poly.bindTooltip(kind.icon + " " + b.row.name, { className: "buildingLabel", direction: "top", sticky: true });
      poly.on("click", (e) => {
        L.DomEvent.stop(e);
        this.describeBuilding(b.row);
      });
      this.worldLayer.addLayer(poly);
      if (b.area > 140) {
        this.buildingLabels.addLayer(L.marker([b.row.latitude, b.row.longitude], {
          interactive: false, keyboard: false,
          icon: L.divIcon({ className: "pinWrap",
            html: '<div class="worldLabel bLabel">' + kind.icon + " " + esc(b.row.name) + "</div>",
            iconSize: [0, 0], iconAnchor: [0, 0] })
        }));
      }
    });

    // Label every named segment: at label zoom only a handful are on screen,
    // and you want the name of the road you're actually standing on.
    world.roads.forEach(r => {
      if (!r.row.realName) return;             // unnamed alleys stay unlabelled
      const mid = r.line[Math.floor(r.line.length / 2)];
      this.streetLabels.addLayer(L.marker(mid, {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: "pinWrap",
          html: '<div class="worldLabel sLabel">' + esc(r.row.name) + "</div>",
          iconSize: [0, 0], iconAnchor: [0, 0] })
      }));
    });

    this.applyZoomDetail();
  },

  describeBuilding(row) {
    UI.modal({
      title: row.name, icon: (Atlas.KINDS[row.kind] || {}).icon || "🏠",
      body:
        '<div class="kv"><span>Kind</span><b>' + esc(cap(row.kindLabel)) + "</b></div>" +
        '<div class="kv"><span>Footprint</span><b>' + row.area + " m²</b></div>" +
        (row.realName ? '<div class="kv"><span>Known to outsiders as</span><b>' + esc(row.realName) + "</b></div>" : "") +
        (row.address ? '<div class="kv"><span>Address</span><b>' + esc(row.address) + "</b></div>" : "") +
        '<div class="kv"><span>Atlas key</span><b class="tiny">' + esc(row.key) + "</b></div>" +
        '<div class="kv"><span>Source</span><b class="tiny">' + esc(row.osmId || row.source) + "</b></div>",
      buttons: [{ label: "Close", cls: "ghost" }]
    });
  },

  describeStreet(row) {
    UI.modal({
      title: row.name, icon: "🛣️",
      body:
        '<div class="kv"><span>Type</span><b>' + esc(row.kind.replace(/_/g, " ")) + "</b></div>" +
        (row.realName ? '<div class="kv"><span>Known to outsiders as</span><b>' + esc(row.realName) + "</b></div>" : "") +
        '<div class="kv"><span>Segment length</span><b>' + fmtDist(row.lengthM) + "</b></div>" +
        '<div class="kv"><span>Atlas key</span><b class="tiny">' + esc(row.key) + "</b></div>" +
        '<div class="kv"><span>Source</span><b class="tiny">' + esc(row.osmId || row.source) + "</b></div>",
      buttons: [{ label: "Close", cls: "ghost" }]
    });
  },

  /**
   * Move each site onto a real building so "walk to The Crooked Tankard" means
   * walking to an actual doorway. One building per site, nearest wins.
   */
  snapNodesToBuildings(world) {
    if (!settings().snapNodesToBuildings || !world.buildings.length) return;
    const taken = new Set(this.nodes.map(n => n.anchorKey).filter(Boolean));
    const MIN_GAP = 34;   // the same spacing the generator guarantees
    let moved = 0;
    this.nodes.forEach(n => {
      if (n.anchorKey || n.status === "cleared") return;
      // Nearest building that doesn't shove this site onto a neighbour.
      const near = Atlas.nearBuildings(n.latitude, n.longitude, 75, taken).find(cand =>
        this.nodes.every(o => o === n ||
          haversine(cand.row.latitude, cand.row.longitude, o.latitude, o.longitude) >= MIN_GAP));
      if (!near) return;
      taken.add(near.row.key);
      Zones.updateNode(n, {
        latitude: near.row.latitude, longitude: near.row.longitude,
        anchorKey: near.row.key, anchorName: near.row.name,
        anchorKind: near.row.kindLabel,
        name: near.row.name,
        icon: n.type === "boss" ? "👑" : n.type === "treasure" ? "📦" :
              n.type === "landmark" ? "⛲" : (Atlas.KINDS[near.row.kind] || {}).icon || "⚔️"
      });
      moved++;
    });
    if (moved) { this.drawNodes(); this.renderHud(); }
  },

  /* Fallback presentation when Leaflet is unavailable. */
  buildListView() {
    const host = $("#map");
    if (!host) return;
    host.innerHTML =
      '<div id="listView" style="position:absolute;inset:0;overflow-y:auto;padding:58px 12px 190px">' +
        '<div class="card" style="padding:12px;margin-bottom:10px">' +
          '<b style="font-size:13px">List view</b>' +
          '<p class="tiny dim" style="margin:5px 0 0">The map tiles could not load. Sites are listed by ' +
          'distance and bearing instead — walk toward one and it will open the same way.</p>' +
        "</div>" +
        '<div id="listNodes"></div>' +
      "</div>";
  },

  renderListView() {
    const host = $("#listNodes");
    if (!host) return;
    const rows = this.nodes.map(n => {
      const d = Loc.distanceTo(n);
      return { n, d: d == null ? Infinity : d };
    }).sort((a, b) => a.d - b.d);
    const s = settings();
    host.innerHTML = "";
    if (!rows.length) { host.innerHTML = '<div class="emptyMsg">Waiting for a position fix…</div>'; return; }
    rows.forEach(({ n, d }) => {
      const inRange = d <= s.interactRange;
      const row = el("div", "item r-" + (n.status === "cleared" ? "common" :
        n.type === "boss" ? "epic" : n.type === "treasure" ? "legendary" : "rare"));
      row.style.cursor = "pointer";
      const brg = Loc.last ? Game.bearingTo(Loc.last.latitude, Loc.last.longitude, n.latitude, n.longitude) : 0;
      const compass = ["N","NE","E","SE","S","SW","W","NW"][Math.round(brg / 45) % 8];
      row.innerHTML =
        '<span class="ico">' + (n.status === "cleared" ? "✓" : n.icon) + "</span>" +
        '<div class="body"><div class="nm">' + esc(n.name) +
          (n.type !== "landmark" ? ' <span class="badge">d' + n.difficulty + "</span>" : "") + "</div>" +
        '<div class="ds">' + fmtDist(d) + " · " + compass + " · " + cap(n.status) + "</div></div>" +
        '<div class="acts"><span class="badge" style="' +
          (inRange && n.status !== "cleared" ? "border-color:var(--ok);color:var(--ok)" : "") + '">' +
          (n.status === "cleared" ? "done" : inRange ? "in range" : "walk") + "</span></div>";
      row.onclick = () => this.openNode(n);
      host.appendChild(row);
    });
  },

  drawZone() {
    if (this.mapless) return;
    if (this.zoneCircle) this.map.removeLayer(this.zoneCircle);
    this.zoneCircle = L.circle([this.zone.centerLatitude, this.zone.centerLongitude], {
      radius: this.zone.radius, color: "#e0a33e", weight: 1, opacity: .35,
      fillColor: "#e0a33e", fillOpacity: .04, className: "rangeRing", interactive: false
    }).addTo(this.map);
  },

  drawNodes() {
    if (this.mapless) { this.renderListView(); return; }
    for (const id in this.nodeMarkers) this.map.removeLayer(this.nodeMarkers[id]);
    this.nodeMarkers = {};
    this.nodes.forEach(n => this.drawNode(n));
  },

  drawNode(n) {
    if (this.mapless) { this.renderListView(); return; }
    if (this.nodeMarkers[n.nodeId]) { this.map.removeLayer(this.nodeMarkers[n.nodeId]); }
    const cleared = n.status === "cleared";
    const html =
      '<div class="pin ' + n.type + (cleared ? " cleared" : "") + '" data-node="' + n.nodeId + '">' +
        (cleared ? "✓" : n.icon) +
        (n.type !== "landmark" && !cleared ? '<span class="diff">' + n.difficulty + "</span>" : "") +
      "</div>";
    const icon = L.divIcon({ html, className: "pinWrap",
      iconSize: [n.type === "boss" ? 42 : 34, n.type === "boss" ? 42 : 34],
      iconAnchor: [n.type === "boss" ? 21 : 17, n.type === "boss" ? 21 : 17] });
    const m = L.marker([n.latitude, n.longitude], { icon }).addTo(this.map);
    m.on("click", () => this.openNode(n));
    this.nodeMarkers[n.nodeId] = m;
  },

  /* ---- Position pipeline ---- */
  onPosition() {
    const p = Loc.last;
    if (!p) return;

    // Location started working — by the button, by the browser's own settings,
    // or by a watch that finally delivered. Get the dialog out of the way.
    if (this._gate && !Loc.simulated && Loc.status === "live") {
      this._gate.close();
      UI.toast("Location on" + (p.accuracy ? " — ±" + Math.round(p.accuracy) + " m" : "") + ".", "good", 2800);
    }

    this.ch.position = { latitude: p.latitude, longitude: p.longitude, lastUpdated: nowTs() };

    if (this.mapless) {
      this.ensureZone();
      this.checkProximity();
      this.renderListView();
      this.renderHud();
      this.refreshDevReadout();
      Characters.save(this.ch);
      return;
    }

    if (!this.playerMarker) {
      this.playerMarker = L.marker([p.latitude, p.longitude], {
        icon: L.divIcon({ html: '<div class="playerPin"></div>', className: "pinWrap",
                          iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000
      }).addTo(this.map);
      this.map.setView([p.latitude, p.longitude], settings().mapZoom);
    } else {
      this.playerMarker.setLatLng([p.latitude, p.longitude]);
      if (settings().followPlayer) this.map.panTo([p.latitude, p.longitude], { animate: true, duration: .5 });
    }

    if (this.accCircle) this.map.removeLayer(this.accCircle);
    if (p.accuracy && p.accuracy > 8) {
      this.accCircle = L.circle([p.latitude, p.longitude], {
        radius: p.accuracy, color: "#4a8fd4", weight: 1, opacity: .3,
        fillColor: "#4a8fd4", fillOpacity: .07, interactive: false
      }).addTo(this.map);
    }

    if (this.rangeCircle) this.map.removeLayer(this.rangeCircle);
    this.rangeCircle = L.circle([p.latitude, p.longitude], {
      radius: settings().interactRange, color: "#54b37a", weight: 1, opacity: .45,
      fillColor: "#54b37a", fillOpacity: .05, interactive: false
    }).addTo(this.map);

    this.trailPts.push([p.latitude, p.longitude]);
    if (this.trailPts.length > 400) this.trailPts.shift();
    this.trail.setLatLngs(this.trailPts);

    this.ensureZone();
    this.checkProximity();
    this.renderHud();
    this.refreshDevReadout();
    Characters.save(this.ch);
  },

  checkProximity() {
    if (this.inCombat || !this.nodes.length) return;
    const s = settings();
    let changed = false;
    for (const n of this.nodes) {
      const d = Loc.distanceTo(n);
      if (d == null) continue;
      const near = d <= s.interactRange;
      const pinEl = document.querySelector('.pin[data-node="' + n.nodeId + '"]');
      if (pinEl) pinEl.classList.toggle("inrange", near && n.status !== "cleared");

      if (near && n.status === "undiscovered") {
        Zones.updateNode(n, { status: "discovered", discoveredAt: nowTs() });
        changed = true;
        UI.toast("Discovered: " + esc(n.name), "good", 3000);
        this.drawNode(n);
      }
      if (near && n.status === "discovered" && !this._pendingNode) {
        this._pendingNode = n.nodeId;
        this.openNode(n);
      }
      if (!near && this._pendingNode === n.nodeId) this._pendingNode = null;
    }
    if (changed) this.renderHud();
  },

  /* ---- HUD ---- */
  renderHud() {
    const c = this.ch;
    if (!c || !$("#chName")) return;
    Characters.refreshMaxes(c);
    $("#chAvatar").textContent = CLASSES[c.class].icon;
    $("#chName").textContent = c.name;
    $("#chSub").textContent = "Lv " + c.level + " " + c.race + " " + c.class +
      (c.unspentPoints ? "  ·  " + c.unspentPoints + " pts" : "");
    const btn = $("#btnSheet");
    if (btn) {
      const has = c.unspentPoints > 0;
      let dot = btn.querySelector(".dot");
      if (has && !dot) { dot = el("span", "dot"); btn.appendChild(dot); }
      if (!has && dot) dot.remove();
    }

    const s = c.stats;
    setBar("nHp", "hp", s.hp, s.maxHp);
    setBar("nMp", "mp", s.mana, s.maxMana);
    setBar("nSp", "sp", s.stamina, s.maxStamina);
    const need = Calc.xpForLevel(c.level);
    setBar("nXp", "xp", c.experience, need);

    const w = Walk.data();
    $("#wToday").textContent = fmtDist(w.meters);
    $("#wTotal").textContent = fmtDist(w.total);
    const near = Loc.nearest(this.nodes);
    $("#wNear").textContent = near ? fmtDist(near.distance) : "--";
    const gps = $("#wGps");
    const sim = settings().locationMode === "sim";
    const live = Loc.status === "live";
    gps.textContent = sim ? "simulated"
                    : live ? (Loc.last && Loc.last.accuracy ? "GPS ±" + Math.round(Loc.last.accuracy) + " m" : "GPS live")
                    : Loc.status === "requesting" ? "asking…"
                    : "Enable GPS";
    gps.className = "gpsChip" + (sim ? " warn" : live ? " ok" : " action");
    const row = $("#modeRow");
    if (row) row.classList.toggle("simOn", sim);
    const box = $("#modeToggle");
    if (box && box.checked !== sim) box.checked = sim;

    function setBar(numId, kind, cur, max) {
      const numEl = $("#" + numId);
      if (!numEl) return;
      numEl.textContent = Math.round(cur) + " / " + Math.round(max);
      const fill = numEl.parentElement.querySelector(".fill." + kind);
      if (fill) fill.style.width = (max > 0 ? clamp(cur / max * 100, 0, 100) : 0) + "%";
    }
  },

  setLocStatus(msg) {
    this.locMsg = msg;
    if (msg) UI.toast(msg, "info", 3200);
  },

  /** Switch between your real position and simulated dev testing. */
  setLocationMode(mode, quiet) {
    saveSettings({ locationMode: mode, devMode: mode === "sim" ? true : settings().devMode });
    Loc.stop();
    if (this._simWalk) { clearInterval(this._simWalk); this._simWalk = null; }
    if (mode === "gps") {
      Loc.simulated = false;
      Loc.status = "idle";
      this.beginLocation();
      if (!quiet) UI.toast("Using your real location.", "good", 2600);
    } else {
      Loc.startSimulated();
      this.buildDevPanel(true);
      if (!quiet) UI.toast("Dev testing on — click the map to move.", "warn", 3000);
    }
    this.buildDevPanel();
    this.renderHud();
    const box = $("#modeToggle");
    if (box) box.checked = mode === "sim";
  },

  /**
   * Decide how to obtain location. Nothing is requested silently: if the
   * browser hasn't already granted permission we put a button in front of the
   * player, because several browsers only raise the prompt while the page has
   * user activation.
   */
  async beginLocation(force) {
    const s = settings();
    if (s.locationMode === "sim") { Loc.start(); return; }

    const d = Loc.diagnose();
    const perm = await Loc.permissionQuery();
    d.permission = perm;
    this._diag = d;

    if (!d.hasGeo) { this.showLocationGate("nogeo", d); return; }
    // Already granted (and still granted) — nothing to ask, just watch.
    if (perm === "granted" && !force) { Loc.start(); return; }
    // Order matters: file:// is the root cause even when it surfaces as
    // "denied", and Firefox will still grant it, so the button stays live.
    if (d.isFile)     { this.showLocationGate("file", d); return; }
    if (!d.canPrompt) { this.showLocationGate("insecure", d); return; }
    if (perm === "denied") { this.showLocationGate("denied", d); return; }
    this.showLocationGate("ask", d);
  },

  /** The one screen that actually asks for permission. */
  showLocationGate(reason, d) {
    if (this._locPrompt) return;
    this._locPrompt = true;
    this.renderHud();

    const serveCmd = "python3 -m http.server 8000";
    const blocks = {
      ask: {
        title: "Turn on location", icon: "📍",
        lead: "This game moves your character with your phone's GPS, so it needs permission to read your position.",
        detail: "Tap <b>Allow location</b> below and your browser will ask. Choose <b>Allow while using the app</b>. " +
                "Nothing leaves your device — the position is only used to move you on the map.",
        primary: { label: "Allow location", act: "request" }
      },
      denied: {
        title: "Location is blocked", icon: "🚫",
        lead: "Your browser has location switched off for this page, so it won't even show the prompt.",
        detail: "<b>Chrome / Edge:</b> tap the icon to the left of the address bar → <b>Permissions</b> → " +
                "set <b>Location</b> to Allow, then reload.<br><br>" +
                "<b>Safari on iPhone:</b> <b>aA</b> in the address bar → <b>Website Settings</b> → " +
                "<b>Location</b> → Allow. Also check <b>Settings → Privacy &amp; Security → Location Services → Safari</b>.<br><br>" +
                "<b>Firefox:</b> padlock → clear the blocked Location permission, then reload.",
        primary: { label: "Ask again", act: "request" }
      },
      file: {
        title: "Open this over http, not as a file", icon: "🔒",
        lead: "The page is open straight off the disk (<span class='mono tiny'>file://</span>). " +
              "Chrome and Safari can't attach a location permission to a file, so they never ask — " +
              "which is exactly what you're seeing.",
        detail: "<b>On this computer</b> — put the file in a folder, open a terminal there and run:" +
                "<div class='cmd'><code>" + serveCmd + "</code></div>" +
                "then visit <span class='mono'>http://localhost:8000/" +
                  esc((location.pathname.split("/").pop() || "").replace(/^index\.html$/, "")) + "</span>. " +
                "Localhost counts as secure, so the prompt appears.<br><br>" +
                "<b>On your phone</b> — it needs a real <b>https</b> address. Drop the file on any static host " +
                "(GitHub Pages, Netlify Drop, Cloudflare Pages), or tunnel your laptop's server with " +
                "<span class='mono'>cloudflared tunnel --url http://localhost:8000</span>. " +
                "A plain <span class='mono'>http://192.168.x.x</span> address will not work.",
        primary: { label: "Try anyway", act: "request" }
      },
      insecure: {
        title: "This page isn't on a secure origin", icon: "🔒",
        lead: "Browsers only hand out GPS over <b>https</b>, or on <b>localhost</b>. This page is served from " +
              "<span class='mono'>" + esc(d.protocol + "//" + d.host) + "</span>, so location is blocked before it can ask.",
        detail: "Serve the file over https, or reach it as <span class='mono'>http://localhost</span> on the machine " +
                "that's hosting it. A LAN address like <span class='mono'>http://192.168.1.20</span> is not " +
                "treated as secure and will always fail.",
        primary: { label: "Try anyway", act: "request" }
      },
      nogeo: {
        title: "No location support", icon: "🧭",
        lead: "This browser doesn't expose the Geolocation API at all.",
        detail: "Try Chrome, Safari or Firefox. Until then, dev testing lets you play by tapping the map.",
        primary: null
      }
    };
    const b = blocks[reason] || blocks.ask;

    const body = el("div");
    body.innerHTML =
      '<p style="margin:0 0 12px;color:var(--ink-2);line-height:1.55">' + b.lead + "</p>" +
      '<div class="noteBox">' + b.detail + "</div>" +
      '<div id="gateResult" class="err" style="margin-top:10px"></div>' +
      '<button class="btn ghost block sm" id="gateDiag" style="margin-top:4px">Show diagnostics</button>' +
      '<pre class="diagBox hidden" id="gateDiagBox"></pre>';

    const buttons = [{ label: "Dev testing instead", cls: "ghost", onClick: () => { this.setLocationMode("sim"); } }];
    if (b.primary) {
      buttons.push({
        label: b.primary.label, cls: "primary",
        onClick: (close, root) => {
          const out = $("#gateResult", root);
          out.style.color = "var(--ink-2)";
          out.textContent = "Waiting for your browser…";
          Loc.requestPermission().then(r => {
            if (r.ok) {
              UI.toast("Location on. ±" + Math.round(r.accuracy) + " m.", "good", 3000);
              close();
              return;
            }
            out.style.color = "var(--blood)";
            out.textContent = r.code === 1
              ? "Blocked by the browser — see the steps above."
              : r.code === 3 ? "Timed out. Outdoors or by a window helps."
              : (r.message || "Position unavailable.");
            this.renderHud();
          });
          return true;   // keep the dialog open until we know
        }
      });
    }

    this._gate = UI.modal({
      title: b.title, icon: b.icon, body, buttons,
      onClose: () => { this._locPrompt = false; this._gate = null; this.renderHud(); }
    });

    $("#gateDiag", body).onclick = () => {
      const box = $("#gateDiagBox", body);
      box.textContent = JSON.stringify(Loc.diagnose(), null, 2);
      box.classList.toggle("hidden");
    };
  },

  /** Tapping a healthy GPS chip shows what the browser is actually reporting. */
  locationDiagnostics() {
    const d = Loc.diagnose();
    const p = Loc.last;
    UI.modal({
      title: "Location", icon: "📍",
      body:
        '<div class="kv"><span>Source</span><b>' + (Loc.simulated ? "Simulated" : "Device GPS") + "</b></div>" +
        '<div class="kv"><span>Permission</span><b>' + esc(d.permission) + "</b></div>" +
        '<div class="kv"><span>Accuracy</span><b>' + (p && p.accuracy ? "±" + Math.round(p.accuracy) + " m" : "—") + "</b></div>" +
        '<div class="kv"><span>Position</span><b class="tiny">' +
          (p ? p.latitude.toFixed(5) + ", " + p.longitude.toFixed(5) : "—") + "</b></div>" +
        '<div class="kv"><span>Last fix</span><b>' +
          (p ? Math.round((nowTs() - p.ts) / 1000) + " s ago" : "—") + "</b></div>" +
        '<div class="kv"><span>Origin</span><b class="tiny">' + esc(d.protocol + "//" + d.host) + "</b></div>" +
        '<p class="tiny dimmer" style="margin:12px 0 0">Keep the screen awake while you walk — most phones ' +
        "stop feeding GPS to a background tab.</p>",
      buttons: [{ label: "Close", cls: "ghost" }]
    });
  },

  /** A watch that was running has stopped producing fixes. */
  onLocationProblem(reason, code) {
    if (this._locPrompt) return;
    this.renderHud();
    this.showLocationGate(code === 1 ? "denied" : "ask", Loc.diagnose());
    const out = $("#gateResult");
    if (out) { out.style.color = "var(--warn)"; out.textContent = reason; }
  },

  /* ---- Walking rewards: the nag loop ---- */
  onWalked(meters, w) {
    if (!this.ch) return;
    // Stamina trickles back as you move; standing still doesn't refill it.
    const c = this.ch;
    c.stats.stamina = clamp(c.stats.stamina + meters * 0.22, 0, c.stats.maxStamina);
    c.stats.mana    = clamp(c.stats.mana + meters * 0.06, 0, c.stats.maxMana);

    // 1 XP per 4 metres, banked so partial metres aren't lost.
    const bank = (w.xpBanked || 0) + meters / 4;
    const whole = Math.floor(bank);
    w.xpBanked = bank - whole;
    if (whole > 0) {
      const gains = Characters.addXp(c, whole);
      gains.forEach(g => this.announceLevel(g));
    }
    const goal = settings().dailyGoalMeters;
    if (!w.goalHit && w.meters >= goal) {
      w.goalHit = true;
      c.gold += 150;
      const bonus = Items.generate(c.level, c.attributes.luck + 6, 4);
      this.giveItem(bonus);
      UI.toast("Daily goal met — " + fmtDist(goal) + ". +150 gold and " + esc(bonus.name) + ".", "good", 5000);
    }
    Store.set(K.walk, w);
    Characters.save(c);
    this.renderHud();
  },

  passiveRegen() {
    if (!this.ch || this.inCombat) return;
    const c = this.ch;
    const before = c.stats.hp;
    c.stats.hp = clamp(c.stats.hp + Math.max(1, c.stats.maxHp * 0.012), 0, c.stats.maxHp);
    c.stats.mana = clamp(c.stats.mana + Math.max(1, c.stats.maxMana * 0.02), 0, c.stats.maxMana);
    if (c.stats.hp !== before) { Characters.save(c); this.renderHud(); }
  },

  announceLevel(g) {
    const c = this.ch;
    UI.toast("Level " + g.level + "! +5 attribute points.", "good", 4200);
    if (g.unlocked && g.unlocked.length) {
      g.unlocked.forEach(sk => UI.toast("New ability: " + sk.icon + " " + sk.name, "good", 4600));
    }
  },

  giveItem(item) {
    const c = this.ch;
    if (!c.inventory) c.inventory = [];
    if (c.inventory.length >= 20) {
      UI.toast("Pack full — " + esc(item.name) + " left behind.", "bad", 3200);
      return false;
    }
    c.inventory.push(item);
    Store.patch(K.inventories, (all) => { all[c.characterId] = c.inventory; });
    API.request("/inventory/item/add", "POST", { characterId: c.characterId, item });
    return true;
  }
};
