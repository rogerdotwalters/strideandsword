/* -------------------------------------------------------------------------
   7. Item generation
   ------------------------------------------------------------------------- */
const Items = {
  rollRarity(luck, difficulty) {
    const tilt = 1 + (luck - 10) * 0.045 + (difficulty || 1) * 0.05;
    const entries = Object.entries(RARITY).map(([k, v]) => {
      const rareness = ["common","uncommon","rare","epic","legendary"].indexOf(k);
      return [k, v.weight * Math.pow(tilt, rareness)];
    });
    const total = entries.reduce((s, e) => s + e[1], 0);
    let r = Math.random() * total;
    for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
    return "common";
  },

  generate(level, luck, difficulty, forceType) {
    const type = forceType || pick(["weapon", "weapon", "armor", "armor", "trinket", "potion"]);
    if (type === "potion") {
      const p = pick(POTIONS);
      return { itemId: uid("itm"), name: p.name, type: "potion", icon: p.icon,
               rarity: "common", level, stats: {}, restore: p.restore,
               effect: Object.entries(p.restore).map(([k, v]) => "+" + v + " " + k.toUpperCase()).join(", "),
               price: p.price, quantity: 1 };
    }
    const rarity = this.rollRarity(luck, difficulty);
    const rm = RARITY[rarity].mult;
    const lvlScale = 1 + (level - 1) * 0.16;

    let baseDef, icon, name, stats = {};
    if (type === "weapon") {
      baseDef = pick(WEAPONS); icon = baseDef.icon;
      stats.damage = Math.max(1, Math.round(baseDef.dmg * rm * lvlScale));
    } else if (type === "armor") {
      baseDef = pick(ARMORS); icon = baseDef.icon;
      stats.defense = Math.max(1, Math.round(baseDef.def * rm * lvlScale));
    } else {
      baseDef = pick(TRINKETS); icon = baseDef.icon;
    }

    const rIdx = ["common","uncommon","rare","epic","legendary"].indexOf(rarity);
    // Trinkets have no damage or defence, so they always carry at least one
    // attribute bonus — otherwise a common trinket would be pure vendor trash.
    if (rIdx >= 1 || type === "trinket") {
      const n = clamp(Math.round(rIdx * 0.9), 1, 3);
      stats.bonusAttribute = {};
      const pool = ATTRS.map(a => a.key);
      const chosen = new Set([baseDef.attr]);
      while (chosen.size < n) chosen.add(pick(pool));
      for (const k of chosen) {
        stats.bonusAttribute[k] = Math.max(1,
          Math.round((1 + rIdx * 0.85) * (0.7 + Math.random() * 0.6) * (1 + (level - 1) * 0.06)));
      }
    }

    name = baseDef.base;
    if (rIdx >= 1) name = pick(PREFIX) + " " + name;
    if (rIdx >= 3) name = name + " " + pick(SUFFIX);

    const price = Math.round((12 + level * 6) * RARITY[rarity].priceMul);
    return { itemId: uid("itm"), name, type, icon, rarity, level, stats,
             effect: this.describe({ type, stats }), price, quantity: 1 };
  },

  describe(it) {
    const parts = [];
    if (it.stats.damage)  parts.push("+" + it.stats.damage + " DMG");
    if (it.stats.defense) parts.push("+" + it.stats.defense + " DEF");
    if (it.stats.bonusAttribute) {
      for (const k in it.stats.bonusAttribute) {
        const a = ATTRS.find(x => x.key === k);
        parts.push("+" + it.stats.bonusAttribute[k] + " " + (a ? a.short : k.slice(0, 3).toUpperCase()));
      }
    }
    if (it.restore) for (const k in it.restore) parts.push("+" + it.restore[k] + " " + k.toUpperCase());
    return parts.join("  ") || "No bonuses";
  },

  slotOf(item) {
    return item.type === "weapon" ? "weapon" : item.type === "armor" ? "armor" :
           item.type === "trinket" ? "trinket" : null;
  }
};
