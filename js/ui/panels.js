/* -------------------------------------------------------------------------
   19. Panels: character sheet, inventory, menu, settings
   ------------------------------------------------------------------------- */
const Panels = {
  sheet() {
    const c = Game.ch;
    Characters.refreshMaxes(c);
    const body = el("div");
    const draw = () => {
      const a = Calc.effectiveAttrs(c);
      body.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">' +
          '<div class="avatar" style="width:48px;height:48px;font-size:25px">' + CLASSES[c.class].icon + "</div>" +
          "<div><b style='font-size:16px'>" + esc(c.name) + "</b><br>" +
          "<span class='tiny dim'>Level " + c.level + " " + c.race + " " + c.class + " · " + c.gold + " gold</span></div></div>" +
        (c.unspentPoints
          ? '<div class="poolBox"><span>Unspent attribute points</span><b>' + c.unspentPoints + "</b></div>"
          : "") +
        '<div class="card" id="attrCard"></div>' +
        '<h4 style="margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">Derived</h4>' +
        '<div class="statGrid">' +
          st("Health", c.stats.maxHp) + st("Mana", c.stats.maxMana) + st("Stamina", c.stats.maxStamina) +
          st("Attack", Math.round(Calc.attackPower(c))) + st("Spell", Math.round(Calc.spellPower(c))) +
          st("Armour", Calc.armor(c)) + st("Magic def", Math.round(Calc.magicDefense(c))) +
          st("Accuracy", Math.round(Calc.accuracy(c))) + st("Evasion", Calc.evasion(c).toFixed(1)) +
          st("Crit %", Calc.critChance(c).toFixed(1)) + st("Crit resist", Calc.critResist(c).toFixed(1)) +
          st("Shop price", Math.round(Calc.priceMod(c) * 100) + "%") +
        "</div>" +
        '<h4 style="margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">Abilities</h4>' +
        '<div class="itemList">' + CLASSES[c.class].skills.map(sk => {
          const known = c.level >= sk.lvl;
          return '<div class="item ' + (known ? "r-uncommon" : "") + '" style="' + (known ? "" : "opacity:.45") + '">' +
            '<span class="ico">' + sk.icon + '</span><div class="body"><div class="nm">' + esc(sk.name) +
            (known ? "" : " <span class='tiny dimmer'>— level " + sk.lvl + "</span>") +
            '</div><div class="ds" style="font-family:var(--font);color:var(--ink-2)">' + esc(sk.desc) +
            "</div></div><div class='acts tiny dimmer mono'>" + sk.cost + " " + (sk.res === "mana" ? "MP" : "SP") + "</div></div>";
        }).join("") + "</div>";

      const card = $("#attrCard", body);
      ATTRS.forEach(at => {
        const row = el("div", "attrRow");
        const bonus = a[at.key] - c.attributes[at.key];
        row.innerHTML =
          '<div class="nm">' + at.name + "<small>" + at.blurb + "</small></div>" +
          "<div></div>" +
          '<div class="val">' + a[at.key] + "</div>" +
          (c.unspentPoints > 0
            ? '<button class="stepper" data-up="' + at.key + '">+</button>'
            : "<div></div>") +
          '<div class="bonus ' + (bonus > 0 ? "pos" : "") + '">' + (bonus > 0 ? "+" + bonus + " gear" : "—") + "</div>";
        card.appendChild(row);
      });
      $$("[data-up]", card).forEach(b => {
        b.onclick = () => {
          if (c.unspentPoints <= 0) return;
          c.attributes[b.getAttribute("data-up")]++;
          c.unspentPoints--;
          Characters.refreshMaxes(c);
          Characters.save(c);
          Game.renderHud();
          draw();
        };
      });
      function st(l, v) { return '<div class="s"><span>' + l + "</span><b>" + v + "</b></div>"; }
    };
    draw();
    UI.modal({ title: "Character", icon: "📋", body, wide: true,
               buttons: [{ label: "Close", cls: "ghost" }] });
  },

  inventory() {
    const c = Game.ch;
    const body = el("div");
    const draw = () => {
      body.innerHTML = "";
      const slots = ["weapon", "armor", "trinket"];
      const slotRow = el("div", "slotRow");
      slots.forEach(sl => {
        const eq = (c.equipment || []).find(i => Items.slotOf(i) === sl);
        const d = el("div", "slot" + (eq ? " filled r-" + eq.rarity : ""));
        d.innerHTML = '<span class="sl">' + sl + "</span>" +
          (eq ? '<span class="nmv c-' + eq.rarity + '">' +
                  '<span class="slotIco">' + Content.itemIconHtml(eq, 15) + "</span>" + esc(eq.name) +
                  '</span><span class="stt">' + esc(eq.effect) + "</span>"
              : '<span class="nmv dimmer">empty</span>');
        if (eq) {
          const b = el("button", "btn sm ghost", "Remove");
          b.style.marginTop = "6px";
          b.onclick = () => { unequip(eq); };
          d.appendChild(b);
        }
        slotRow.appendChild(d);
      });
      body.appendChild(slotRow);

      const head = el("div");
      head.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px";
      head.innerHTML = '<h4 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">Pack</h4>' +
        '<span class="tiny dimmer mono">' + (c.inventory || []).length + " / 20 · " + c.gold + " gold</span>";
      body.appendChild(head);

      const list = el("div", "itemList");
      if (!(c.inventory || []).length) list.innerHTML = '<div class="emptyMsg">Nothing but lint.</div>';
      (c.inventory || []).slice().sort((a, b) => {
        const order = ["legendary","epic","rare","uncommon","common"];
        return order.indexOf(a.rarity) - order.indexOf(b.rarity);
      }).forEach(it => {
        const row = el("div", "item r-" + it.rarity);
        row.innerHTML = '<span class="ico">' + Content.itemIconHtml(it, 18) + '</span>' +
          '<div class="body"><div class="nm c-' + it.rarity + '">' + esc(it.name) +
          ' <span class="badge">' + it.rarity + '</span></div>' +
          '<div class="ds">' + esc(it.effect) + " · " + it.price + " g</div></div>";
        const acts = el("div", "acts");
        if (it.type === "potion") {
          const b = el("button", "btn sm primary", "Drink");
          b.onclick = () => { usePotion(it); };
          acts.appendChild(b);
        } else if (Items.slotOf(it)) {
          const b = el("button", "btn sm primary", "Equip");
          b.onclick = () => { equip(it); };
          acts.appendChild(b);
        }
        const s = el("button", "btn sm ghost", "Sell");
        s.onclick = () => { sell(it); };
        acts.appendChild(s);
        row.appendChild(acts);
        list.appendChild(row);
      });
      body.appendChild(list);
    };

    function persist() {
      Store.patch(K.inventories, (all) => { all[c.characterId] = c.inventory; });
      Characters.refreshMaxes(c);
      Characters.save(c);
      Game.renderHud();
      draw();
    }
    function equip(it) {
      const sl = Items.slotOf(it);
      const cur = (c.equipment || []).find(x => Items.slotOf(x) === sl);
      if (cur) { c.equipment = c.equipment.filter(x => x !== cur); c.inventory.push(cur); }
      c.inventory = c.inventory.filter(x => x.itemId !== it.itemId);
      c.equipment = (c.equipment || []).concat([it]);
      API.request("/inventory/item/" + it.itemId + "/equip", "PATCH", { equipped: true });
      UI.toast("Equipped " + it.name + ".", "good", 1800);
      persist();
    }
    function unequip(it) {
      if (c.inventory.length >= 20) { UI.toast("Pack is full.", "bad"); return; }
      c.equipment = c.equipment.filter(x => x.itemId !== it.itemId);
      c.inventory.push(it);
      persist();
    }
    function usePotion(p) {
      for (const k in p.restore) c.stats[k] = clamp(c.stats[k] + p.restore[k], 0, c.stats["max" + cap(k)]);
      c.inventory = c.inventory.filter(x => x.itemId !== p.itemId);
      UI.toast("Drank " + p.name + ".", "good", 1800);
      persist();
    }
    function sell(it) {
      const price = Math.max(1, Math.round(it.price * 0.45 / Calc.priceMod(c)));
      c.gold += price;
      c.inventory = c.inventory.filter(x => x.itemId !== it.itemId);
      UI.toast("Sold for " + price + " gold.", "info", 1800);
      persist();
    }

    draw();
    UI.modal({ title: "Inventory", icon: "🎒", body, wide: true,
               buttons: [{ label: "Close", cls: "ghost" }] });
  },

  menu() {
    const s = settings();
    const w = Walk.data();
    const atlas = Atlas.stats();
    const body = el("div");
    body.innerHTML =
      '<div class="statGrid" style="margin-bottom:14px">' +
        '<div class="s"><span>Walked today</span><b>' + fmtDist(w.meters) + "</b></div>" +
        '<div class="s"><span>All time</span><b>' + fmtDist(w.total) + "</b></div>" +
        '<div class="s"><span>Daily goal</span><b>' + fmtDist(s.dailyGoalMeters) + "</b></div>" +
        '<div class="s"><span>Sites left</span><b>' +
          Game.nodes.filter(n => n.status !== "cleared").length + "</b></div>" +
      "</div>" +
      '<h4 style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">Location</h4>' +
      '<label class="tick"><input type="checkbox" id="setSim"' + (s.locationMode === "sim" ? " checked" : "") +
        "> <span>Dev test mode <small class='dimmer'>— simulate my location instead of using GPS</small></span></label>" +
      '<label class="tick"><input type="checkbox" id="setFollow"' + (s.followPlayer ? " checked" : "") + "> Keep the map centred on me</label>" +
      '<label class="tick"><input type="checkbox" id="setAcc"' + (s.highAccuracy ? " checked" : "") + "> High-accuracy GPS (uses more battery)</label>" +
      '<div class="divider"></div>' +
      '<h4 style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-3)">The map</h4>' +
      '<label class="tick"><input type="checkbox" id="setFantasy"' + (s.fantasyMap ? " checked" : "") +
        "> <span>Fantasy overlay <small class='dimmer'>— real roads and buildings, renamed</small></span></label>" +
      '<label class="tick"><input type="checkbox" id="setSnap"' + (s.snapNodesToBuildings ? " checked" : "") +
        "> Put sites on real buildings</label>" +
      '<label class="field" style="margin-top:12px"><span>Real map showing through: <b id="tileVal">' +
        Math.round(s.tileOpacity * 100) + '</b>%</span>' +
        '<input type="range" min="0" max="100" step="5" id="setTile" value="' + Math.round(s.tileOpacity * 100) + '" style="width:100%"></label>' +
      '<label class="field"><span>Street names appear at zoom <b id="lblVal">' + s.labelZoom + "</b></span>" +
        '<input type="range" min="15" max="20" step="1" id="setLbl" value="' + s.labelZoom + '" style="width:100%"></label>' +
      '<label class="field"><span>🚗 Street button zooms to <b id="zsVal">' + s.zoomStreet + "</b></span>" +
        '<input type="range" min="13" max="19" step="0.5" id="setZStreet" value="' + s.zoomStreet + '" style="width:100%"></label>' +
      '<label class="field"><span>🚶 Walk button zooms to <b id="zwVal">' + s.zoomWalk + "</b></span>" +
        '<input type="range" min="17" max="24" step="0.5" id="setZWalk" value="' + s.zoomWalk + '" style="width:100%"></label>' +
      '<div class="statGrid" style="margin-bottom:10px">' +
        '<div class="s"><span>Buildings named</span><b>' + atlas.buildings + "</b></div>" +
        '<div class="s"><span>Roads named</span><b>' + atlas.streetNames + "</b></div>" +
        '<div class="s"><span>Street rows</span><b>' + atlas.streetRows + "</b></div>" +
      "</div>" +
      '<label class="field" style="margin-top:12px"><span>Interaction range: <b id="rngVal">' + s.interactRange + '</b> m</span>' +
        '<input type="range" min="10" max="120" step="5" id="setRange" value="' + s.interactRange + '" style="width:100%"></label>' +
      '<label class="field"><span>Daily walking goal: <b id="goalVal">' + s.dailyGoalMeters + '</b> m</span>' +
        '<input type="range" min="500" max="12000" step="250" id="setGoal" value="' + s.dailyGoalMeters + '" style="width:100%"></label>' +
      '<div class="divider"></div>' +
      '<p class="tiny dimmer" style="margin:0 0 10px">Storage: ' +
        (Store.isDurable ? "localStorage, " + (Store.usageBytes() / 1024).toFixed(1) + " KB used"
                         : "in-memory only — this browser is blocking storage, so progress will not survive a reload") +
      "</p>";
    const actions = el("div");
    actions.style.cssText = "display:flex;flex-direction:column;gap:7px";
    const mk = (label, cls, fn) => { const b = el("button", "btn block " + cls, label); b.onclick = fn; actions.appendChild(b); };
    mk("Resurvey the streets", "ghost", () => {
      m.close();
      Store.remove(OSM.cacheKey(Game.zone));
      Game.loadWorld(true);
    });
    mk("Export atlas as JSON", "ghost", () => {
      const data = Atlas.export();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = "stride-atlas-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      UI.toast("Atlas exported: " + Object.keys(data.tables.buildings).length + " buildings, " +
               Object.keys(data.tables.streets).length + " street rows.", "good", 3600);
    });
    mk("Import an atlas file", "ghost", () => {
      const inp = el("input");
      inp.type = "file"; inp.accept = "application/json,.json";
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const r = Atlas.import(JSON.parse(rd.result));
            UI.toast(r.success ? "Atlas merged: " + r.buildings + " buildings, " + r.streets + " street rows."
                               : r.message, r.success ? "good" : "bad", 4000);
            if (r.success && Game.world) Game.renderWorld(Game.world);
          } catch (e) { UI.toast("That file wouldn't parse as JSON.", "bad", 3600); }
        };
        rd.readAsText(f);
      };
      inp.click();
    });
    mk("Rename the whole town", "ghost", () => {
      UI.confirm("Regenerate every name?", "Buildings and roads get fresh fantasy names. Site names update too.", () => {
        Atlas.clear();
        if (Game.world) {
          const els = Store.get(OSM.cacheKey(Game.zone), null);
          Game.nodes.forEach(n => { delete n.anchorKey; });
          if (els) { const w = OSM.digest(els); Game.world = w; Game.renderWorld(w); Game.snapNodesToBuildings(w); }
        }
        UI.toast("The town has forgotten its old names.", "good", 3200);
      });
    });
    mk("Re-anchor zone here", "ghost", () => {
      UI.confirm("Re-anchor zone?", "Your current sites are discarded and a new set is scattered around where you're standing.", () => {
        if (!Loc.last) { UI.toast("No position yet.", "bad"); return; }
        const old = Zones.nodesIn(Game.zone.zoneId);
        Store.patch(K.nodes, (all) => { old.forEach(n => delete all[n.nodeId]); });
        Game.zone.centerLatitude = Loc.last.latitude;
        Game.zone.centerLongitude = Loc.last.longitude;
        Game.zone.seed = uid("seed");
        Game.zone.lastModified = nowTs();
        Store.patch(K.zones, (z) => { z[Game.zone.zoneId] = Game.zone; });
        Game.nodes = Zones.generateNodes(Game.zone, null, Game.ch.level);
        Game.drawZone(); Game.drawNodes();
        UI.toast("Zone re-anchored.", "good");
      });
    });
    mk("Switch character", "ghost", () => { Game.reset(); Screens.show("select"); });
    mk("Sign out", "ghost", () => Auth.logout());
    mk("Wipe all local data", "danger", () => {
      UI.confirm("Wipe everything?", "Accounts, characters, zones and progress in this browser are deleted.", () => {
        Object.values(Store.get(K.zones, {}) || {}).forEach(z => Store.remove(OSM.cacheKey(z)));
        [K.session, K.accounts, K.characters, K.zones, K.nodes, K.inventories, K.encounters,
         K.walk, K.settings, "atlas_buildings", "atlas_streets"].forEach(k => Store.remove(k));
        location.reload();
      });
    });
    body.appendChild(el("div", "divider"));
    body.appendChild(actions);

    const m = UI.modal({ title: "Menu", icon: "☰", body, buttons: [{ label: "Close", cls: "ghost" }] });

    $("#setFollow", body).onchange = (e) => saveSettings({ followPlayer: e.target.checked });
    $("#setAcc", body).onchange = (e) => {
      saveSettings({ highAccuracy: e.target.checked });
      if (settings().locationMode === "gps") { Loc.stop(); Loc.start(); }
    };
    $("#setSim", body).onchange = (e) => Game.setLocationMode(e.target.checked ? "sim" : "gps");
    $("#setSnap", body).onchange = (e) => saveSettings({ snapNodesToBuildings: e.target.checked });
    $("#setFantasy", body).onchange = (e) => {
      saveSettings({ fantasyMap: e.target.checked });
      if (!e.target.checked) {
        if (Game.worldLayer) Game.worldLayer.clearLayers();
        Game.applyZoomDetail();
      } else if (Game.world) { Game.renderWorld(Game.world); }
      else { Game._worldZone = null; Game.loadWorld(); }
    };
    $("#setTile", body).oninput = (e) => {
      $("#tileVal", body).textContent = e.target.value;
      saveSettings({ tileOpacity: +e.target.value / 100 });
      Game.applyZoomDetail();   // owns the deep-zoom fade as well as the slider
    };
    $("#setLbl", body).oninput = (e) => {
      $("#lblVal", body).textContent = e.target.value;
      saveSettings({ labelZoom: +e.target.value });
      Game.applyZoomDetail();
    };
    $("#setZStreet", body).oninput = (e) => {
      $("#zsVal", body).textContent = e.target.value;
      saveSettings({ zoomStreet: +e.target.value });
      Game.syncZoomModes();
    };
    $("#setZWalk", body).oninput = (e) => {
      $("#zwVal", body).textContent = e.target.value;
      saveSettings({ zoomWalk: +e.target.value });
      Game.syncZoomModes();
    };
    $("#setRange", body).oninput = (e) => {
      $("#rngVal", body).textContent = e.target.value;
      saveSettings({ interactRange: +e.target.value });
      Game.onPosition();
    };
    $("#setGoal", body).oninput = (e) => {
      $("#goalVal", body).textContent = e.target.value;
      saveSettings({ dailyGoalMeters: +e.target.value });
    };
  }
};
