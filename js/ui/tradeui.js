/* -------------------------------------------------------------------------
   18d. Buildings on the map, and doing business with the people in them.

   The structure is drawn here; the trade happens with a person. Tapping a
   building tells you who works there and where they are *at this moment* —
   which is usually not the doorstep, because the resident is an ordinary
   wandering character and moves while you are not looking. Everything you can
   actually do is behind `openWanderer`, one tap further on, once you have
   caught up with them.

   That split is the whole design: a shop you can use from across the street
   is a menu, and this game is about walking to things.
   ------------------------------------------------------------------------- */
Object.assign(Game, {

  /**
   * Draw the buildings near you: the outline if one was traced, a circle if
   * not, and a pin carrying the kind's icon and its level.
   *
   * Redrawn on every position fix alongside the denizens, for the same
   * reason — there is no state to animate, only a question to re-ask.
   */
  drawBuildings() {
    if (this.mapless || !this.map || typeof Buildings === "undefined") return 0;
    if (!this.buildingLayer) this.buildingLayer = L.layerGroup().addTo(this.map);
    this.buildingLayer.clearLayers();
    const p = Loc.last;
    if (!p) return 0;

    const near = Buildings.near(p.latitude, p.longitude, this.denizenRangeM() + 200);
    near.forEach(b => {
      const k = Buildings.kind(b.kind);
      const ring = Buildings.ring(b);
      const style = { color: k.color, weight: 1.5, opacity: .6,
                      fillColor: k.color, fillOpacity: .12, interactive: false };
      this.buildingLayer.addLayer(ring
        ? L.polygon(ring, style)
        : L.circle([b.latitude, b.longitude],
                   Object.assign({ radius: +b.radius || 45 }, style, { fillOpacity: .06, dashArray: "6 5" })));

      const c = Buildings.centroid(b);
      const m = L.marker([c.latitude, c.longitude], {
        icon: L.divIcon({
          className: "pinWrap", iconSize: [34, 34], iconAnchor: [17, 17],
          html: '<div class="bldPin" data-building="' + esc(b.buildingId) + '">' + k.icon +
                '<span class="lv">' + Buildings.levelOf(b) + "</span></div>"
        }), zIndexOffset: 300
      });
      m.bindTooltip(esc(b.name || cap(k.label)) + " · level " + Buildings.levelOf(b),
                    { direction: "top", offset: [0, -12] });
      m.on("click", () => this.openBuilding(b));
      this.buildingLayer.addLayer(m);
    });
    this._buildings = near;
    return near.length;
  },

  /** The card for the structure itself: who works here, and where they are. */
  openBuilding(b) {
    const k = Buildings.kind(b.kind);
    const p = Loc.last;
    const dist = p ? Buildings.distanceTo(b, p.latitude, p.longitude) : null;
    const d = Buildings.residentOf(b);
    const away = (d && p) ? haversine(p.latitude, p.longitude, d.latitude, d.longitude) : null;
    const range = +settings().interactRange || 35;

    const body =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<div class="avatar" style="width:46px;height:46px;font-size:24px">' + k.icon + "</div>" +
        "<div><b style='font-size:15px'>" + esc(b.name || cap(k.label)) + "</b><br>" +
        '<span class="tiny dim">' + esc(cap(k.label)) + " · level " + Buildings.levelOf(b) + "</span></div></div>" +
      '<div class="kv"><span>Distance</span><b>' + fmtDist(dist) + "</b></div>" +
      '<div class="kv"><span>Deals in</span><b>' +
        Buildings.tradesOf(b).map(t => Buildings.TRADES[t].name).join(", ") + "</b></div>" +
      (d
        ? '<div class="kv"><span>Worked by</span><b>' + esc(d.name) + "</b></div>" +
          '<div class="kv"><span>Right now</span><b>' + fmtDist(away) +
            (away != null && away <= range ? " — within reach" : " away") + "</b></div>"
        : '<p class="tiny dimmer" style="margin:12px 0 0">Nobody is working here.</p>') +
      (b.notes ? '<p style="margin:12px 0 0;color:var(--ink-2)">' + esc(b.notes) + "</p>" : "") +
      '<p class="tiny dimmer" style="margin:12px 0 0">The building does not serve you — ' +
        (d ? esc(d.name.split(" ")[0]) : "whoever works here") + " does, and they walk about. " +
        "Find them to trade.</p>";

    const buttons = [{ label: "Close", cls: "ghost" }];
    if (d) {
      buttons.push({ label: "Go to " + d.name.split(" ")[0], cls: "primary", onClick: () => {
        if (this.map) this.map.panTo([d.latitude, d.longitude]);
        this.openDenizen(d);
      } });
    }
    UI.modal({ title: esc(b.name || cap(k.label)), icon: k.icon, body, buttons });
  },

  /* ================================================== MEETING THE RESIDENT */

  /**
   * The trade buttons on a character's panel.
   *
   * Returned rather than rendered, because `openWanderer` in questui.js owns
   * that modal and a second panel for "the same person, but they work
   * somewhere" would be one panel too many.
   */
  tradeButtons(d, near) {
    if (!d.buildingId || typeof Buildings === "undefined") return [];
    const b = Buildings.get(d.buildingId);
    if (!b || !near) return [];
    const out = [];
    Buildings.tradesOf(b).forEach(t => {
      if (t === "talk") return;                    // the quest offer is that
      const trade = Buildings.TRADES[t];
      out.push({ label: trade.icon + " " + trade.verb, cls: "primary", onClick: () => {
        if (t === "goods") this.openShop(d, b);
        else if (t === "rest") this.openRest(d, b);
        else if (t === "mend") this.openImprove(d, b);
      } });
    });
    return out;
  },

  /** Save what a trade changed. The same three lines the inventory panel runs. */
  afterTrade() {
    const c = this.ch;
    Store.patch(K.inventories, (all) => { all[c.characterId] = c.inventory; });
    Characters.refreshMaxes(c);
    Characters.save(c);
    this.renderHud();
  },

  /* ------------------------------------------------------------------ goods */

  openShop(d, b) {
    const c = this.ch;
    const body = el("div");
    const draw = () => {
      const now = Date.now();
      const stock = Buildings.stockOf(b, now);
      const left = Math.max(0, Buildings.restocksAt(now) - now);
      body.innerHTML =
        '<div class="kv"><span>Your gold</span><b>' + c.gold + "</b></div>" +
        '<div class="kv"><span>Restocks in</span><b>' +
          (left > 3600000 ? Math.round(left / 3600000) + " h" : Math.round(left / 60000) + " min") + "</b></div>" +
        '<h4 class="tradeHead">On offer</h4>' +
        '<div class="itemList" id="shopBuy"></div>' +
        '<h4 class="tradeHead">Your pack</h4>' +
        '<div class="itemList" id="shopSell"></div>';

      const buyList = $("#shopBuy", body);
      const live = stock.filter(s => !s.taken);
      if (!live.length) buyList.innerHTML = '<div class="emptyMsg">Cleaned out. Come back after the restock.</div>';
      live.forEach(s => {
        const it = s.item;
        const price = Buildings.buyPrice(it, c);
        const gate = Items.slotOf(it) ? Items.canEquip(c, it) : { ok: true, why: "" };
        const row = el("div", "item r-" + it.rarity);
        row.innerHTML = '<span class="ico">' + Content.itemIconHtml(it, 18) + "</span>" +
          '<div class="body"><div class="nm c-' + it.rarity + '">' + esc(it.name) +
          ' <span class="badge">' + it.rarity + "</span></div>" +
          '<div class="ds">' + esc(it.effect) + " · level " + it.level + "</div>" +
          (Items.requirementText(it) ? '<div class="rq">' + esc(Items.requirementText(it)) + "</div>" : "") +
          (gate.ok ? "" : '<div class="tiny" style="color:var(--blood)">' + esc(gate.why) + "</div>") +
          "</div>";
        const acts = el("div", "acts");
        const buy = el("button", "btn sm " + ((+c.gold || 0) >= price ? "primary" : "ghost"), price + " g");
        if ((+c.gold || 0) < price) { buy.disabled = true; buy.title = "Not enough gold."; }
        buy.onclick = () => {
          const r = Buildings.buy(b, s.index, c, Date.now());
          if (!r.ok) { UI.toast(r.why, "bad", 2600); return; }
          UI.toast("Bought " + r.item.name + " for " + r.price + " gold.", "good", 2400);
          this.afterTrade();
          draw();
        };
        acts.appendChild(buy);
        row.appendChild(acts);
        buyList.appendChild(row);
      });

      const sellList = $("#shopSell", body);
      const pack = (c.inventory || []).slice();
      if (!pack.length) sellList.innerHTML = '<div class="emptyMsg">Nothing but lint.</div>';
      pack.forEach(it => {
        const price = Buildings.sellPrice(it, c);
        const row = el("div", "item r-" + it.rarity);
        row.innerHTML = '<span class="ico">' + Content.itemIconHtml(it, 18) + "</span>" +
          '<div class="body"><div class="nm c-' + it.rarity + '">' + esc(it.name) + "</div>" +
          '<div class="ds">' + esc(it.effect) + "</div></div>";
        const acts = el("div", "acts");
        const sell = el("button", "btn sm ghost", "Sell " + price + " g");
        sell.onclick = () => {
          const r = Buildings.sell(b, it, c);
          if (!r.ok) { UI.toast(r.why, "bad", 2400); return; }
          UI.toast("Sold for " + r.price + " gold.", "info", 1800);
          this.afterTrade();
          draw();
        };
        acts.appendChild(sell);
        row.appendChild(acts);
        sellList.appendChild(row);
      });
    };
    draw();
    UI.modal({ title: d.name, icon: Buildings.kind(b.kind).icon, body, wide: true,
               buttons: [{ label: "Done", cls: "ghost" }] });
  },

  /* ------------------------------------------------------------------- rest */

  openRest(d, b) {
    const c = this.ch;
    const body = el("div");
    const draw = () => {
      const cost = Buildings.restCost(b, c);
      const pct = Math.round(Buildings.restFraction(b) * 100);
      body.innerHTML =
        '<p style="margin:0 0 12px;color:var(--ink-2)">A level ' + Buildings.levelOf(b) + " " +
          esc(Buildings.kind(b.kind).label) + " gives back <b>" + pct + "%</b> of each pool.</p>" +
        '<div class="kv"><span>Health</span><b>' + c.stats.hp + " / " + c.stats.maxHp + "</b></div>" +
        '<div class="kv"><span>Mana</span><b>' + c.stats.mana + " / " + c.stats.maxMana + "</b></div>" +
        '<div class="kv"><span>Stamina</span><b>' + c.stats.stamina + " / " + c.stats.maxStamina + "</b></div>" +
        '<div class="kv"><span>Your gold</span><b>' + c.gold + "</b></div>" +
        '<div class="kv"><span>The bill</span><b>' + cost + " gold</b></div>";
    };
    draw();
    UI.modal({ title: d.name, icon: "🔥", body, buttons: [
      { label: "Not now", cls: "ghost" },
      { label: "Rest", cls: "primary", onClick: (close) => {
        const r = Buildings.rest(b, c, Date.now());
        if (!r.ok) { UI.toast(r.why, "bad", 2800); return true; }
        this.afterTrade();
        UI.toast("Rested: +" + r.gained.hp + " HP, +" + r.gained.mana + " MP, +" +
                 r.gained.stamina + " SP for " + r.cost + " gold.", "good", 3200);
        draw();
        return true;              // keep the panel open so you can see the bars
      } }
    ] });
  },

  /* ---------------------------------------------------------------- improve */

  openImprove(d, b) {
    const c = this.ch;
    const body = el("div");
    const draw = () => {
      body.innerHTML =
        '<p style="margin:0 0 10px;color:var(--ink-2)">' + esc(d.name) +
          " will take a piece as far as <b>item level " + Buildings.improveCap(b) +
          "</b>. One level at a time.</p>" +
        '<div class="kv"><span>Your gold</span><b>' + c.gold + "</b></div>" +
        '<div class="itemList" id="mendList"></div>';
      const list = $("#mendList", body);
      const all = (c.equipment || []).concat(c.inventory || [])
        .filter(it => it && it.type !== "potion" && Items.slotOf(it));
      if (!all.length) { list.innerHTML = '<div class="emptyMsg">No gear to work on.</div>'; return; }
      all.forEach(it => {
        const worn = (c.equipment || []).indexOf(it) >= 0;
        const gate = Buildings.canImprove(b, it);
        const cost = Buildings.improveCost(b, it);
        const row = el("div", "item r-" + it.rarity);
        row.innerHTML = '<span class="ico">' + Content.itemIconHtml(it, 18) + "</span>" +
          '<div class="body"><div class="nm c-' + it.rarity + '">' + esc(it.name) +
            (worn ? ' <span class="badge">worn</span>' : "") + "</div>" +
          '<div class="ds">' + esc(it.effect) + " · level " + it.level +
            ((+it.improved || 0) ? " · improved " + it.improved + "×" : "") + "</div>" +
          (gate.ok ? "" : '<div class="tiny" style="color:var(--blood)">' + esc(gate.why) + "</div>") +
          "</div>";
        const acts = el("div", "acts");
        const go = el("button", "btn sm " + (gate.ok && c.gold >= cost ? "primary" : "ghost"), cost + " g");
        if (!gate.ok || c.gold < cost) { go.disabled = true; go.title = gate.ok ? "Not enough gold." : gate.why; }
        go.onclick = () => {
          const r = Buildings.improve(b, it, c);
          if (!r.ok) { UI.toast(r.why, "bad", 3000); return; }
          this.afterTrade();
          UI.toast(it.name + " is now level " + it.level + " — " + it.effect + ".", "good", 3400);
          draw();
        };
        acts.appendChild(go);
        row.appendChild(acts);
        list.appendChild(row);
      });
    };
    draw();
    UI.modal({ title: d.name, icon: "🔨", body, wide: true,
               buttons: [{ label: "Done", cls: "ghost" }] });
  }
});
