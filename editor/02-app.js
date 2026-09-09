/* ==========================================================================
   CONTENT EDITOR
   Three CRUD screens over the shared Content tables, plus a Rarity screen for
   the multipliers that scale every monster. Writes to the same localStorage
   the game reads, so a save here is live in the game on its next encounter.
   ========================================================================== */
const Ed = {
  tab: "monsters",
  selected: null,       // id of the row being edited
  draft: null,          // working copy; only written on Save
  isNew: false,
  search: "",
  sort: {
    monsters: { col: "name", dir: 1 },
    loot:     { col: "name", dir: 1 },
    items:    { col: "name", dir: 1 }
  },

  /* ------------------------------------------------------------------ boot */
  init() {
    this.root = $("#ed");
    this.root.innerHTML =
      '<header class="edTop">' +
        '<div class="edBrand"><b>Stride &amp; Sword</b><span>Content Editor</span></div>' +
        '<nav class="edTabs" id="edTabs"></nav>' +
        '<div class="spacer"></div>' +
        '<button class="btn ghost sm" id="edSeed">Seed defaults</button>' +
        '<button class="btn ghost sm" id="edImport">Import</button>' +
        '<button class="btn ghost sm" id="edExport">Export JSON</button>' +
        '<a class="btn sm" id="edPlay" href="index.html">Open game →</a>' +
      "</header>" +
      '<div class="edBody">' +
        '<section class="edList">' +
          '<div class="listBar" id="edListBar"></div>' +
          '<div class="listWrap" id="edListWrap"></div>' +
        "</section>" +
        '<aside class="edForm" id="edForm"></aside>' +
      "</div>" +
      '<footer class="edStatus" id="edStatus"></footer>';

    $("#edSeed").onclick   = () => this.seed();
    $("#edExport").onclick = () => this.exportJson();
    $("#edImport").onclick = () => this.importJson();

    // First run with nothing authored: install the game's original content so
    // there is something to look at rather than three empty tables.
    if (Content.isEmpty()) ContentSeed.install();

    this.renderAll();
  },

  setTab(t) {
    if (this.dirtyCheck()) return;
    this.tab = t; this.selected = null; this.draft = null; this.isNew = false; this.search = "";
    this.renderAll();
  },

  /** Warn once before throwing away edits. Returns true to cancel navigation. */
  dirtyCheck() {
    if (!this.draft) return false;
    const original = this.isNew ? null : Content.get(this.tab, this.selected);
    if (original && JSON.stringify(original) === JSON.stringify(this.draft)) return false;
    if (this.isNew && !this.draft.name) return false;
    return !confirm("Discard unsaved changes?");
  },

  renderAll() {
    this.renderTabs();
    this.renderListBar();
    this.renderList();
    this.renderForm();
    this.renderStatus();
    $("#edForm").classList.toggle("hidden", this.tab === "rarity");
  },

  renderTabs() {
    const s = Content.stats();
    const tabs = [
      ["monsters", "Monsters", s.monsters],
      ["loot", "Loot Tables", s.loot],
      ["items", "Items", s.items],
      ["rarity", "Rarity", null]
    ];
    const host = $("#edTabs");
    host.innerHTML = tabs.map(([k, label, n]) =>
      '<button data-tab="' + k + '" class="' + (this.tab === k ? "on" : "") + '">' + label +
      (n != null ? '<span class="n">' + n + "</span>" : "") + "</button>").join("");
    $$("[data-tab]", host).forEach(b => { b.onclick = () => this.setTab(b.getAttribute("data-tab")); });
  },

  renderListBar() {
    const bar = $("#edListBar");
    if (this.tab === "rarity") {
      bar.innerHTML = '<b style="font-size:13px">Rarity tiers &amp; monster scaling</b>' +
        '<div class="spacer"></div>' +
        '<button class="btn ghost sm" id="edResetScale">Reset to defaults</button>';
      $("#edResetScale").onclick = () => {
        if (!confirm("Reset every multiplier to its default?")) return;
        Content.saveConfig({ scale: JSON.parse(JSON.stringify(Content.DEFAULT_SCALE)) });
        this.renderAll(); this.toast("Multipliers reset.", "good");
      };
      return;
    }
    const noun = { monsters: "monster", loot: "loot table", items: "item" }[this.tab];
    bar.innerHTML =
      '<input class="input" id="edSearch" placeholder="Search ' + noun + 's…" value="' + esc(this.search) + '">' +
      '<div class="spacer"></div>' +
      '<span class="tiny dimmer" id="edCount"></span>' +
      '<button class="btn primary sm" id="edNew">+ New ' + noun + "</button>";
    const inp = $("#edSearch");
    inp.oninput = () => { this.search = inp.value; this.renderList(); };
    $("#edNew").onclick = () => this.newRow();
  },

  rows() {
    const all = Content.list(this.tab);
    const q = this.search.trim().toLowerCase();
    const filtered = !q ? all.slice() : all.filter(r =>
      (r.name || "").toLowerCase().includes(q) ||
      (r.type || "").toLowerCase().includes(q) ||
      (r.gearType || "").toLowerCase().includes(q) ||
      (r.rarity || "").toLowerCase().includes(q));
    const s = this.sort[this.tab];
    const val = (r) => {
      const v = this.sortValue(r, s.col);
      return v == null ? "" : v;
    };
    filtered.sort((a, b) => {
      const av = val(a), bv = val(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * s.dir;
      return String(av).localeCompare(String(bv)) * s.dir;
    });
    return filtered;
  },

  sortValue(r, col) {
    if (col === "rarity") return (Content.RARITY[r.rarity] || {}).order || 0;
    if (col === "level")  return +r.levelMin || 0;
    if (col === "hp")     return Content.effective(r).hp;
    if (col === "exp")    return Content.effective(r).exp;
    if (col === "entries")return (r.loot || []).length;
    if (col === "value")  return +r.value || 0;
    if (col === "armor")  return +r.armor || 0;
    return r[col];
  },

  th(col, label, cls) {
    const s = this.sort[this.tab];
    const arrow = s.col === col ? ' <span class="ar">' + (s.dir > 0 ? "▲" : "▼") + "</span>" : "";
    return '<th class="' + (cls || "") + '" data-sort="' + col + '">' + label + arrow + "</th>";
  },

  renderList() {
    const wrap = $("#edListWrap");
    if (this.tab === "rarity") { this.renderRarity(wrap); return; }

    const rows = this.rows();
    const cnt = $("#edCount");
    if (cnt) cnt.textContent = rows.length + " of " + Content.list(this.tab).length;

    let head = "", body = "";
    if (this.tab === "monsters") {
      head = this.th("name", "Name") + this.th("type", "Type") + this.th("rarity", "Rarity") +
             this.th("level", "Levels", "num") + this.th("hp", "HP", "num") +
             "<th class='num'>Attack</th>" + this.th("exp", "XP", "num") + "<th>Loot table</th>";
      body = rows.map(m => {
        const e = Content.effective(m);
        const lt = m.lootTableId ? Content.get("loot", m.lootTableId) : null;
        return '<tr data-id="' + m.monsterId + '" class="' + (this.selected === m.monsterId ? "on" : "") + '">' +
          '<td><div class="nameCell"><span class="emojiIcon">' + esc(m.icon || "👹") + "</span>" +
            "<b>" + esc(m.name || "(unnamed)") + "</b>" +
            (m.isBoss ? ' <span class="tag" style="border-color:var(--gold);color:var(--gold)">boss</span>' : "") +
            "</div></td>" +
          '<td><span class="tag">' + esc(m.type) + "</span></td>" +
          "<td>" + this.rarityChip(m.rarity) + "</td>" +
          '<td class="num">' + m.levelMin + "–" + m.levelMax + "</td>" +
          '<td class="num">' + e.hp + "</td>" +
          '<td class="num">' + e.atkMin + "–" + e.atkMax + "</td>" +
          '<td class="num">' + e.exp + "</td>" +
          "<td>" + (lt ? esc(lt.name) : '<span class="dimmer">—</span>') + "</td></tr>";
      }).join("");

    } else if (this.tab === "loot") {
      head = this.th("name", "Name") + this.th("entries", "Entries", "num") +
             "<th class='num'>Total %</th><th class='num'>Drops</th><th>Contains</th>";
      body = rows.map(t => {
        const total = (t.chances || []).reduce((s, c) => s + (+c || 0), 0);
        const names = (t.loot || []).slice(0, 3).map(id => {
          const it = Content.get("items", id);
          return it ? esc(it.name) : "?";
        }).join(", ");
        const more = (t.loot || []).length > 3 ? " +" + ((t.loot || []).length - 3) : "";
        return '<tr data-id="' + t.lootTableId + '" class="' + (this.selected === t.lootTableId ? "on" : "") + '">' +
          "<td><b>" + esc(t.name || "(unnamed)") + "</b></td>" +
          '<td class="num">' + (t.loot || []).length + "</td>" +
          '<td class="num">' + total.toFixed(1) + "</td>" +
          '<td class="num">' + t.dropsMin + "–" + t.dropsMax + "</td>" +
          '<td class="dim">' + names + more + "</td></tr>";
      }).join("");

    } else {
      head = this.th("name", "Name") + this.th("gearType", "Slot") + this.th("rarity", "Rarity") +
             "<th class='num'>Damage</th>" + this.th("armor", "Armour", "num") +
             "<th class='num'>Res</th>" + this.th("itemLevel", "Lvl", "num") + this.th("value", "Value", "num");
      body = rows.map(it => {
        const slot = Content.slotDef(it.gearType);
        const dmg = (+it.damageMin || +it.damageMax)
          ? it.damageMin + "–" + it.damageMax : '<span class="dimmer">—</span>';
        return '<tr data-id="' + it.itemId + '" class="' + (this.selected === it.itemId ? "on" : "") + '">' +
          '<td><div class="nameCell"><span class="iconBox" style="color:' + Content.rarityColor(it.rarity) + '">' +
            Content.iconSvg(it.iconKey, 18) + "</span><b>" + esc(it.name || "(unnamed)") + "</b></div></td>" +
          '<td><span class="tag">' + esc(slot.label) + "</span></td>" +
          "<td>" + this.rarityChip(it.rarity) + "</td>" +
          '<td class="num">' + dmg + "</td>" +
          '<td class="num">' + (+it.armor || '<span class="dimmer">—</span>') + "</td>" +
          '<td class="num">' + (+it.resistance || '<span class="dimmer">—</span>') + "</td>" +
          '<td class="num">' + (it.itemLevel || 1) + "</td>" +
          '<td class="num">' + (it.value || 0) + "</td></tr>";
      }).join("");
    }

    wrap.innerHTML = rows.length
      ? '<table class="grid"><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table>"
      : '<div class="emptyForm">Nothing here yet.<br>Use <b>+ New</b> to add one, or <b>Seed defaults</b> for the game\'s original content.</div>';

    $$("tbody tr", wrap).forEach(tr => {
      tr.onclick = () => this.select(tr.getAttribute("data-id"));
    });
    $$("th[data-sort]", wrap).forEach(th => {
      th.onclick = () => {
        const col = th.getAttribute("data-sort");
        const s = this.sort[this.tab];
        if (s.col === col) s.dir *= -1; else { s.col = col; s.dir = 1; }
        this.renderList();
      };
    });
  },

  rarityChip(r) {
    const d = Content.RARITY[r] || Content.RARITY.common;
    return '<span class="rchip" style="color:' + d.color + '"><span class="rdot"></span>' + d.name + "</span>";
  },

  /* --------------------------------------------------------------- selection */
  select(id) {
    if (this.dirtyCheck()) return;
    this.selected = id;
    this.isNew = false;
    const row = Content.get(this.tab, id);
    this.draft = row ? JSON.parse(JSON.stringify(row)) : null;
    this.renderList();
    this.renderForm();
  },

  newRow() {
    if (this.dirtyCheck()) return;
    this.draft = this.tab === "monsters" ? Content.blankMonster()
               : this.tab === "loot" ? Content.blankLootTable()
               : Content.blankItem();
    this.selected = null;
    this.isNew = true;
    this.renderList();
    this.renderForm();
    setTimeout(() => { const n = $("#f_name"); if (n) n.focus(); }, 30);
  },

  /* -------------------------------------------------------------------- save */
  save() {
    const d = this.draft;
    const problem = this.validate(d);
    if (problem) { $("#edErr").textContent = problem; return; }
    const idKey = this.tab === "monsters" ? "monsterId" : this.tab === "loot" ? "lootTableId" : "itemId";
    const saved = Content.save(this.tab, d);
    this.selected = saved[idKey];
    this.isNew = false;
    this.draft = JSON.parse(JSON.stringify(saved));
    this.renderAll();
    this.toast("Saved " + (saved.name || "row") + ".", "good");
  },

  validate(d) {
    if (!d.name || !d.name.trim()) return "Give it a name.";
    if (this.tab === "monsters") {
      if (+d.levelMin > +d.levelMax) return "Minimum level is above the maximum.";
      if (+d.attackMin > +d.attackMax) return "Minimum attack is above the maximum.";
      if (+d.baseHp < 1) return "Base HP must be at least 1.";
    }
    if (this.tab === "items") {
      if (+d.damageMin > +d.damageMax) return "Minimum damage is above the maximum.";
    }
    if (this.tab === "loot") {
      if (+d.dropsMin > +d.dropsMax) return "Minimum drops is above the maximum.";
      const bad = (d.chances || []).findIndex(c => !(+c >= 0) || +c > 100);
      if (bad >= 0) return "Row " + (bad + 1) + " has a percentage outside 0–100.";
      if ((d.loot || []).some(id => !id)) return "Every row needs an item selected.";
    }
    return null;
  },

  duplicate() {
    const d = JSON.parse(JSON.stringify(this.draft));
    const idKey = this.tab === "monsters" ? "monsterId" : this.tab === "loot" ? "lootTableId" : "itemId";
    d[idKey] = "";
    d.name = (d.name || "") + " (copy)";
    this.draft = d;
    this.selected = null;
    this.isNew = true;
    this.renderForm();
    this.toast("Duplicated — save to keep it.");
  },

  del() {
    const name = (this.draft && this.draft.name) || "this row";
    if (!confirm("Delete " + name + "? This cannot be undone.")) return;
    const id = this.selected;
    Content.remove(this.tab, id);
    // Clean up references so nothing points at a row that no longer exists.
    if (this.tab === "loot") {
      Content.list("monsters").forEach(m => {
        if (m.lootTableId === id) { m.lootTableId = ""; Content.save("monsters", m); }
      });
    }
    if (this.tab === "items") {
      Content.list("loot").forEach(t => {
        const keep = [], keepC = [];
        (t.loot || []).forEach((iid, i) => { if (iid !== id) { keep.push(iid); keepC.push(t.chances[i]); } });
        if (keep.length !== (t.loot || []).length) { t.loot = keep; t.chances = keepC; Content.save("loot", t); }
      });
    }
    this.selected = null; this.draft = null; this.isNew = false;
    this.renderAll();
    this.toast("Deleted.", "bad");
  },

  /* ------------------------------------------------------------------ toast */
  toast(msg, kind) {
    let host = $("#toasts");
    if (!host) { host = el("div"); host.id = "toasts"; document.body.appendChild(host); }
    const t = el("div", "toast " + (kind || ""), esc(msg));
    host.appendChild(t);
    while (host.children.length > 3) host.removeChild(host.firstChild);
    setTimeout(() => {
      t.style.transition = "opacity .3s"; t.style.opacity = "0";
      setTimeout(() => t.remove(), 320);
    }, 2400);
  },

  renderStatus() {
    const s = Content.stats();
    const kb = (Store.usageBytes() / 1024).toFixed(1);
    $("#edStatus").innerHTML =
      "<span><b>" + s.monsters + "</b> monsters</span>" +
      "<span><b>" + s.loot + "</b> loot tables</span>" +
      "<span><b>" + s.items + "</b> items</span>" +
      '<span class="spacer"></span>' +
      "<span>" + (Store.isDurable ? "localStorage · " + kb + " KB" : "in-memory only — changes will not survive a reload") + "</span>";
  }
};

/* ==========================================================================
   FORMS
   ========================================================================== */
Object.assign(Ed, {

  /* Bind an input to a key on the draft. `cast` converts the raw string. */
  bind(id, key, cast, after) {
    const n = $("#" + id);
    if (!n) return;
    const handler = () => {
      const raw = n.type === "checkbox" ? n.checked : n.value;
      this.draft[key] = cast ? cast(raw) : raw;
      if (after) after();
    };
    n.addEventListener(n.type === "checkbox" || n.tagName === "SELECT" ? "change" : "input", handler);
  },

  num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; },
  int(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; },

  fld(id, label, value, opts) {
    opts = opts || {};
    return '<label class="f"><span>' + label + "</span>" +
      '<input class="input" id="' + id + '" type="' + (opts.type || "text") + '"' +
      (opts.step ? ' step="' + opts.step + '"' : "") +
      (opts.min != null ? ' min="' + opts.min + '"' : "") +
      (opts.max != null ? ' max="' + opts.max + '"' : "") +
      (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : "") +
      ' value="' + esc(value == null ? "" : value) + '"></label>';
  },

  sel(id, label, value, options) {
    return '<label class="f"><span>' + label + "</span><select id=\"" + id + '">' +
      options.map(o => {
        const v = typeof o === "string" ? o : o.value;
        const t = typeof o === "string" ? cap(o) : o.label;
        return '<option value="' + esc(v) + '"' + (String(v) === String(value) ? " selected" : "") + ">" + esc(t) + "</option>";
      }).join("") + "</select></label>";
  },

  raritySelect(id, value) {
    return '<label class="f"><span>Rarity <em style="font-style:normal;color:' +
      Content.rarityColor(value) + '">● ' + Content.rarityName(value) + "</em></span><select id=\"" + id + '">' +
      Content.RARITY_ORDER.map(r => '<option value="' + r + '"' + (r === value ? " selected" : "") + ">" +
        Content.RARITY[r].name + "</option>").join("") + "</select></label>";
  },

  formHeader(title) {
    return '<div class="formHead"><h3>' + esc(title) + "</h3></div>";
  },

  formActions() {
    return '<div class="err" id="edErr"></div>' +
      '<div class="formActions">' +
        '<button class="btn primary" id="edSave" style="flex:1">Save</button>' +
        (this.isNew ? "" : '<button class="btn ghost" id="edDup">Duplicate</button>') +
        (this.isNew ? "" : '<button class="btn danger" id="edDel">Delete</button>') +
      "</div>";
  },

  wireActions() {
    const s = $("#edSave"); if (s) s.onclick = () => this.save();
    const d = $("#edDup");  if (d) d.onclick = () => this.duplicate();
    const x = $("#edDel");  if (x) x.onclick = () => this.del();
  },

  renderForm() {
    const host = $("#edForm");
    if (this.tab === "rarity") { host.innerHTML = ""; return; }
    if (!this.draft) {
      const noun = { monsters: "monster", loot: "loot table", items: "item" }[this.tab];
      host.innerHTML = '<div class="emptyForm">Select a ' + noun + " from the list,<br>or create a new one.</div>";
      return;
    }
    if (this.tab === "monsters") this.monsterForm(host);
    else if (this.tab === "loot") this.lootForm(host);
    else this.itemForm(host);
    this.wireActions();
  },

  /* ------------------------------------------------------------- monsters */
  monsterForm(host) {
    const d = this.draft;
    const lootOptions = [{ value: "", label: "— none —" }]
      .concat(Content.list("loot").map(t => ({ value: t.lootTableId, label: t.name })));

    host.innerHTML =
      this.formHeader(this.isNew ? "New monster" : d.name) +
      '<div class="row2">' +
        this.fld("f_name", "Name", d.name, { placeholder: "Break Room Rat" }) +
        this.fld("f_icon", "Icon", d.icon, { placeholder: "🐀" }) +
      "</div>" +
      '<div class="row2">' +
        this.sel("f_type", "Type", d.type, Content.MONSTER_TYPES) +
        this.raritySelect("f_rarity", d.rarity) +
      "</div>" +
      '<label class="check"><input type="checkbox" id="f_isBoss"' + (d.isBoss ? " checked" : "") +
        "> Boss — only spawns at boss sites</label>" +

      '<div class="sect">Level range</div>' +
      '<div class="row2">' +
        this.fld("f_levelMin", "Level min", d.levelMin, { type: "number", min: 1 }) +
        this.fld("f_levelMax", "Level max", d.levelMax, { type: "number", min: 1 }) +
      "</div>" +

      '<div class="sect">Base stats</div>' +
      '<div class="row2">' +
        this.fld("f_baseHp", "Base HP", d.baseHp, { type: "number", min: 1 }) +
        this.fld("f_armor", "Armour", d.armor, { type: "number", min: 0 }) +
      "</div>" +

      '<div class="sect">Attack</div>' +
      this.fld("f_attackName", "Attack name", d.attackName, { placeholder: "Gnaw" }) +
      '<div class="row3">' +
        this.fld("f_attackMin", "Min", d.attackMin, { type: "number", min: 0 }) +
        this.fld("f_attackMax", "Max", d.attackMax, { type: "number", min: 0 }) +
        this.sel("f_damageType", "Damage type", d.damageType, Content.DAMAGE_TYPES) +
      "</div>" +

      '<div class="sect">Rewards</div>' +
      '<div class="row2">' +
        this.fld("f_expReward", "Experience", d.expReward, { type: "number", min: 0 }) +
        this.fld("f_goldReward", "Gold", d.goldReward, { type: "number", min: 0 }) +
      "</div>" +
      this.sel("f_lootTableId", "Loot table", d.lootTableId, lootOptions) +

      '<div class="sect">After rarity scaling</div>' +
      '<div class="preview" id="edPreview"></div>' +
      this.formActions();

    this.bind("f_name", "name", null, () => this.refreshPreview());
    this.bind("f_icon", "icon");
    this.bind("f_type", "type");
    this.bind("f_rarity", "rarity", null, () => { this.renderForm(); });
    this.bind("f_isBoss", "isBoss", Boolean);
    ["levelMin", "levelMax", "baseHp", "armor", "attackMin", "attackMax", "expReward", "goldReward"]
      .forEach(k => this.bind("f_" + k, k, this.int, () => this.refreshPreview()));
    this.bind("f_attackName", "attackName");
    this.bind("f_damageType", "damageType", null, () => this.refreshPreview());
    this.bind("f_lootTableId", "lootTableId");
    this.refreshPreview();
  },

  refreshPreview() {
    const box = $("#edPreview");
    if (!box || this.tab !== "monsters") return;
    const d = this.draft;
    const e = Content.effective(d);
    const s = e.scale;
    const line = (label, base, val, mult) =>
      '<div class="pr"><span>' + label + "</span><span>" +
        (mult !== 1 ? '<span class="was">' + base + " ×" + mult + "</span>" : "") +
        "<b" + (mult !== 1 ? ' class="up"' : "") + ">" + val + "</b></span></div>";
    const magic = Content.MAGIC_DAMAGE.indexOf(d.damageType) >= 0;
    box.innerHTML =
      line("Health", d.baseHp, e.hp, s.hp) +
      line("Damage", d.attackMin + "–" + d.attackMax, e.atkMin + "–" + e.atkMax, s.dmg) +
      line("Armour", d.armor, e.armor, s.armor) +
      line("Experience", d.expReward, e.exp, s.exp) +
      line("Gold", d.goldReward, e.gold, s.exp) +
      '<div class="pr"><span>Extra loot rolls</span><b>' + s.lootRolls + "</b></div>" +
      '<div class="pr"><span>Resolves against</span><b>' + (magic ? "magic defence" : "armour") + "</b></div>";
  },

  /* ----------------------------------------------------------- loot tables */
  lootForm(host) {
    const d = this.draft;
    if (!d.loot) d.loot = [];
    if (!d.chances) d.chances = [];

    host.innerHTML =
      this.formHeader(this.isNew ? "New loot table" : d.name) +
      this.fld("f_name", "Name", d.name, { placeholder: "Office Salvage" }) +
      '<div class="sect">Drop count</div>' +
      '<div class="row2">' +
        this.fld("f_dropsMin", "Minimum drops", d.dropsMin, { type: "number", min: 0 }) +
        this.fld("f_dropsMax", "Maximum drops", d.dropsMax, { type: "number", min: 0 }) +
      "</div>" +
      '<div class="sect">Entries</div>' +
      '<div id="edLootRows"></div>' +
      '<button class="btn ghost block sm" id="edAddLoot" style="margin-top:6px">+ Add entry</button>' +
      '<div class="lootSum" id="edLootSum"></div>' +
      '<div class="noteBox">Each percentage is rolled on its own and is never ' +
        "normalised — a table can total 12% or 900%. The drop count then clamps the result: " +
        "a surplus is trimmed at random, a shortfall is topped up from the entries that missed, " +
        "weighted by their own chance.</div>" +
      this.formActions();

    this.bind("f_name", "name");
    this.bind("f_dropsMin", "dropsMin", this.int, () => this.refreshLootSum());
    this.bind("f_dropsMax", "dropsMax", this.int, () => this.refreshLootSum());
    $("#edAddLoot").onclick = () => {
      this.draft.loot.push("");
      this.draft.chances.push(10);
      this.renderLootRows();
    };
    this.renderLootRows();
  },

  renderLootRows() {
    const host = $("#edLootRows");
    if (!host) return;
    const d = this.draft;
    const items = Content.list("items");
    if (!d.loot.length) {
      host.innerHTML = '<div class="dimmer tiny" style="padding:8px 0">No entries yet.</div>';
    } else {
      host.innerHTML = d.loot.map((itemId, i) => {
        const opts = '<option value="">— pick an item —</option>' + items.map(it =>
          '<option value="' + it.itemId + '"' + (it.itemId === itemId ? " selected" : "") + ">" +
          esc(it.name) + " · " + esc(Content.slotDef(it.gearType).label) + "</option>").join("");
        return '<div class="lootRow">' +
          '<select data-loot="' + i + '">' + opts + "</select>" +
          '<span class="pct"><input class="input" type="number" step="0.1" min="0" max="100" ' +
            'data-chance="' + i + '" value="' + (d.chances[i] != null ? d.chances[i] : 0) + '"></span>' +
          '<button class="xBtn" data-rm="' + i + '">✕</button></div>';
      }).join("");
    }
    $$("[data-loot]", host).forEach(s => {
      s.onchange = () => { this.draft.loot[+s.getAttribute("data-loot")] = s.value; this.refreshLootSum(); };
    });
    $$("[data-chance]", host).forEach(inp => {
      inp.oninput = () => {
        this.draft.chances[+inp.getAttribute("data-chance")] = this.num(inp.value);
        this.refreshLootSum();
      };
    });
    $$("[data-rm]", host).forEach(b => {
      b.onclick = () => {
        const i = +b.getAttribute("data-rm");
        this.draft.loot.splice(i, 1);
        this.draft.chances.splice(i, 1);
        this.renderLootRows();
      };
    });
    this.refreshLootSum();
  },

  refreshLootSum() {
    const box = $("#edLootSum");
    if (!box) return;
    const d = this.draft;
    const total = (d.chances || []).reduce((s, c) => s + (+c || 0), 0);
    const expected = total / 100;
    const min = +d.dropsMin || 0, max = +d.dropsMax || 0;
    const clamped = Math.min(Math.max(expected, min), Math.max(min, max));
    box.innerHTML =
      "<span>" + (d.loot || []).length + " entries · total " + total.toFixed(1) + "%</span>" +
      "<span>≈ " + expected.toFixed(2) + " hits → " + clamped.toFixed(2) + " drops</span>";
  },

  /* ---------------------------------------------------------------- items */
  itemForm(host) {
    const d = this.draft;
    const slot = Content.slotDef(d.gearType);
    const consumable = slot.gameType === "potion" || slot.gameType === "consumable";

    host.innerHTML =
      this.formHeader(this.isNew ? "New item" : d.name) +
      this.fld("f_name", "Name", d.name, { placeholder: "Chain Hauberk" }) +
      '<div class="row2">' +
        this.sel("f_gearType", "Gear type", d.gearType,
          Content.GEAR_SLOTS.map(s => ({ value: s.key, label: s.label }))) +
        this.raritySelect("f_rarity", d.rarity) +
      "</div>" +

      '<div class="sect">Icon</div>' +
      '<div class="iconGrid" id="edIcons"></div>' +

      '<div class="sect">Offence</div>' +
      '<div class="row3">' +
        this.fld("f_damageMin", "Dmg min", d.damageMin, { type: "number", min: 0 }) +
        this.fld("f_damageMax", "Dmg max", d.damageMax, { type: "number", min: 0 }) +
        this.sel("f_damageType", "Damage type", d.damageType, Content.DAMAGE_TYPES) +
      "</div>" +

      '<div class="sect">Defence</div>' +
      '<div class="row2">' +
        this.fld("f_armor", "Armour", d.armor, { type: "number", min: 0 }) +
        this.fld("f_resistance", "Resistance", d.resistance, { type: "number", min: 0 }) +
      "</div>" +

      (consumable
        ? '<div class="sect">Restores</div><div class="row3">' +
            this.fld("f_restoreHp", "HP", d.restoreHp || 0, { type: "number", min: 0 }) +
            this.fld("f_restoreMana", "Mana", d.restoreMana || 0, { type: "number", min: 0 }) +
            this.fld("f_restoreStamina", "Stamina", d.restoreStamina || 0, { type: "number", min: 0 }) +
          "</div>"
        : "") +

      '<div class="sect">Game values</div>' +
      '<div class="row2">' +
        this.fld("f_itemLevel", "Item level", d.itemLevel, { type: "number", min: 1 }) +
        this.fld("f_value", "Value (gold)", d.value, { type: "number", min: 0 }) +
      "</div>" +
      '<label class="f"><span>Description</span><textarea id="f_description" placeholder="A line of flavour.">' +
        esc(d.description || "") + "</textarea></label>" +

      '<div class="sect">The game will see</div>' +
      '<div class="preview" id="edItemPreview"></div>' +
      this.formActions();

    this.bind("f_name", "name");
    this.bind("f_gearType", "gearType", null, () => {
      // Follow the slot's default icon unless a different one was chosen.
      const prev = Content.GEAR_SLOTS.find(s => s.icon === this.draft.iconKey);
      if (!prev || prev.key !== this.draft.gearType) this.draft.iconKey = Content.slotDef(this.draft.gearType).icon;
      this.renderForm();
    });
    this.bind("f_rarity", "rarity", null, () => this.renderForm());
    ["damageMin", "damageMax", "armor", "resistance", "itemLevel", "value",
     "restoreHp", "restoreMana", "restoreStamina"]
      .forEach(k => this.bind("f_" + k, k, this.int, () => this.refreshItemPreview()));
    this.bind("f_damageType", "damageType", null, () => this.refreshItemPreview());
    this.bind("f_description", "description", null, () => this.refreshItemPreview());

    const grid = $("#edIcons");
    grid.innerHTML = Content.ICON_KEYS.map(k =>
      '<button data-icon="' + k + '" class="' + (d.iconKey === k ? "on" : "") + '" title="' + k + '">' +
      Content.iconSvg(k, 20) + "</button>").join("");
    $$("[data-icon]", grid).forEach(b => {
      b.onclick = () => {
        this.draft.iconKey = b.getAttribute("data-icon");
        $$("[data-icon]", grid).forEach(o => o.classList.toggle("on", o === b));
        this.refreshItemPreview();
      };
    });
    this.refreshItemPreview();
  },

  refreshItemPreview() {
    const box = $("#edItemPreview");
    if (!box) return;
    const inst = Content.toGameItem(this.draft, this.draft.itemLevel);
    const slot = Content.slotDef(this.draft.gearType);
    box.innerHTML =
      '<div class="pr"><span>Equipment slot</span><b>' + cap(inst.type) + "</b></div>" +
      '<div class="pr"><span>Stat line</span><b>' + esc(inst.effect || "—") + "</b></div>" +
      '<div class="pr"><span>Sells for</span><b>' + Math.round(inst.price * 0.45) + " g</b></div>" +
      '<div class="pr"><span>Preview</span><span style="color:' + Content.rarityColor(this.draft.rarity) + '">' +
        Content.iconSvg(this.draft.iconKey, 18) + "</span></div>" +
      (slot.gameType === "quest" ? '<div class="pr"><span class="dimmer tiny">Tomes are carried, not equipped.</span></div>' : "");
  },

  /* --------------------------------------------------------------- rarity */
  renderRarity(wrap) {
    const cfg = Content.config();
    wrap.innerHTML =
      '<div class="pad">' +
        '<div class="noteBox" style="margin:0 0 14px">These multipliers turn a monster\'s authored base ' +
          "numbers into the numbers the game uses. Nothing is written back multiplied, so changing a row " +
          "here restyles every monster of that rarity at once. Items are unaffected — their numbers are " +
          "exactly what you type.</div>" +
        '<table class="scaleGrid"><thead><tr><th>Tier</th><th>Health</th><th>Damage</th>' +
          "<th>Armour</th><th>XP &amp; gold</th><th>Extra loot rolls</th><th>Loot tilt</th></tr></thead><tbody>" +
        Content.RARITY_ORDER.map(r => {
          const s = cfg.scale[r], c = Content.RARITY[r];
          return "<tr><td>" + this.rarityChip(r) + "</td>" +
            ["hp", "dmg", "armor", "exp"].map(k =>
              '<td><input class="input" type="number" step="0.05" min="0.1" data-scale="' + r + ':' + k +
              '" value="' + s[k] + '"></td>').join("") +
            '<td><input class="input" type="number" step="1" min="0" data-scale="' + r + ':lootRolls" value="' + s.lootRolls + '"></td>' +
            '<td><input class="input" type="number" step="0.05" min="0.1" data-scale="' + r + ':lootTilt" value="' + s.lootTilt + '"></td>' +
            "</tr>";
        }).join("") +
        "</tbody></table>" +
        '<div class="sect" style="margin-top:22px">Effect on the current bestiary</div>' +
        '<div id="edScaleEffect"></div>' +
      "</div>";

    $$("[data-scale]", wrap).forEach(inp => {
      inp.onchange = () => {
        const [r, k] = inp.getAttribute("data-scale").split(":");
        const c = Content.config();
        c.scale[r][k] = parseFloat(inp.value) || 0;
        Content.saveConfig(c);
        this.renderRarityEffect();
        this.toast("Updated " + Content.rarityName(r) + " " + k + ".");
      };
    });
    this.renderRarityEffect();
  },

  renderRarityEffect() {
    const host = $("#edScaleEffect");
    if (!host) return;
    const byRarity = {};
    Content.list("monsters").forEach(m => {
      const e = Content.effective(m);
      const b = byRarity[m.rarity] || (byRarity[m.rarity] = { n: 0, hp: 0, exp: 0 });
      b.n++; b.hp += e.hp; b.exp += e.exp;
    });
    const rows = Content.RARITY_ORDER.filter(r => byRarity[r]);
    host.innerHTML = rows.length
      ? '<table class="scaleGrid"><thead><tr><th>Tier</th><th>Monsters</th><th>Average HP</th>' +
        "<th>Average XP</th></tr></thead><tbody>" +
        rows.map(r => {
          const b = byRarity[r];
          return "<tr><td>" + this.rarityChip(r) + "</td><td>" + b.n + "</td>" +
            "<td>" + Math.round(b.hp / b.n) + "</td><td>" + Math.round(b.exp / b.n) + "</td></tr>";
        }).join("") + "</tbody></table>"
      : '<div class="dimmer tiny">No monsters yet.</div>';
  },

  /* --------------------------------------------------------- import/export */
  seed() {
    const empty = Content.isEmpty();
    if (!empty && !confirm("Replace everything with the game's original content?\n\nAnything you have authored will be lost.")) return;
    const r = ContentSeed.install(true);
    this.selected = null; this.draft = null;
    this.renderAll();
    this.toast("Seeded " + r.monsters + " monsters, " + r.loot + " loot tables, " + r.items + " items.", "good");
  },

  exportJson() {
    const data = Content.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "stride-content-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    const s = Content.stats();
    this.toast("Exported " + s.monsters + " monsters, " + s.loot + " tables, " + s.items + " items.", "good");
  },

  importJson() {
    const inp = el("input");
    inp.type = "file"; inp.accept = "application/json,.json";
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        let json;
        try { json = JSON.parse(rd.result); }
        catch (e) { this.toast("That file wouldn't parse as JSON.", "bad"); return; }
        const mode = confirm("Merge into what's already here?\n\nOK = merge (matching ids are overwritten)\nCancel = replace everything")
          ? "merge" : "replace";
        const r = Content.importAll(json, mode);
        if (!r.success) { this.toast(r.message, "bad"); return; }
        this.selected = null; this.draft = null;
        this.renderAll();
        this.toast("Imported — now " + r.monsters + " monsters, " + r.loot + " tables, " + r.items + " items.", "good");
      };
      rd.readAsText(f);
    };
    inp.click();
  }
});

/* Expose for the console and the test harness. */
window.ED = { Ed, Content, ContentSeed, Store };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => Ed.init());
else Ed.init();
