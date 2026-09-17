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

  /* ------------------------------------------------------------ the budget

     Every wearable slot gets a share of what a single piece of gear used to
     be worth. The shares were not guessed: they were tuned against
     `npm run balance` until a character in a **full kit** measured about the
     same as the one-weapon-one-armour reference character the published win
     rates were taken from. Base values × share, summed over a best-in-slot
     heavy kit, come to roughly what one average piece of old armour was
     worth — and the simulation agrees, which is the actual test.

     Chest is the biggest share because that is where armour goes; a belt or a
     ring is a rounding error on its own and only matters once the set is
     nearly full, which is exactly the shape a gear grind should have. */
  SLOT_SHARE: {
    mainhand: 1.00,      // damage, not defence — unchanged from before
    offhand:  0.10,
    chest:    0.16,
    legs:     0.09,
    helm:     0.07,
    shoulders:0.055,
    boots:    0.05,
    gloves:   0.045,
    back:     0.03,
    belt:     0.025,
    neck:     0.50,      // trinkets carry attributes, and there are two of them
    ring:     0.50
  },

  shareFor(slot) {
    const v = this.SLOT_SHARE[slot];
    return v == null ? 0.2 : v;
  },

  /**
   * What a piece of this level asks of you.
   *
   * The base requirement is what the *kind* of thing needs — plate wants
   * strength whoever made it — and it grows slowly with item level, so a
   * level 20 breastplate is genuinely out of a mage's reach rather than
   * merely heavy. One point per five levels: enough to matter by level 15,
   * never enough to lock you out of your own class's gear.
   */
  requirementFor(base, level) {
    const req = {};
    const bump = Math.floor(((+level || 1) - 1) / 5);
    for (const k in (base.req || {})) req[k] = (base.req[k] || 0) + bump;
    return req;
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

    /* A "type" is now a family of slots. Anything that hangs on the paper doll
       can be asked for by name — `forceType: "boots"` — which is what the
       balance sim uses to dress a character properly. */
    let pool;
    if (EQUIP_SLOTS.some(sl => sl.key === type)) pool = GEAR_BASES.filter(g => g.slot === type);
    else if (type === "weapon") pool = WEAPONS;
    else if (type === "armor") pool = ARMORS;
    else pool = TRINKETS;
    if (!pool.length) pool = GEAR_BASES;

    const baseDef = pick(pool);
    const slot = baseDef.slot;
    const share = this.shareFor(slot);
    const icon = baseDef.icon;
    const stats = {};
    if (baseDef.dmg) stats.damage = Math.max(1, Math.round(baseDef.dmg * rm * lvlScale));
    if (baseDef.def) stats.defense = Math.max(1, Math.round(baseDef.def * rm * lvlScale * share));

    const rIdx = ["common","uncommon","rare","epic","legendary"].indexOf(rarity);
    const isTrinket = slot === "ring" || slot === "neck";
    /* Who gets attribute bonuses, and why the bar moved.

       Trinkets always: they have no damage or defence, so a common one would
       otherwise be pure vendor trash. Everything else needs to be **rare**,
       where it used to need uncommon — because a character now wears twelve
       pieces rather than three, and at the old bar every slot would hand out
       at least a point. Roughly one piece of a full kit clears this bar,
       which is about where three-slot gear sat. */
    if (rIdx >= 2 || isTrinket) {
      const n = clamp(Math.round(rIdx * 0.9), 1, 3);
      stats.bonusAttribute = {};
      const pool2 = ATTRS.map(a => a.key);
      const chosen = new Set([baseDef.attr]);
      while (chosen.size < n) chosen.add(pick(pool2));
      for (const k of chosen) {
        // The same share the rest of the piece takes: two rings are worth
        // about what the one old trinket was, not twice it.
        const raw = (1 + rIdx * 0.85) * (0.7 + Math.random() * 0.6) * (1 + (level - 1) * 0.06);
        stats.bonusAttribute[k] = Math.max(1, Math.round(raw * share));
      }
    }

    let name = baseDef.base;
    if (rIdx >= 1) name = pick(PREFIX) + " " + name;
    if (rIdx >= 3) name = name + " " + pick(SUFFIX);

    const price = Math.round((12 + level * 6) * RARITY[rarity].priceMul * (0.4 + share));
    const gameType = baseDef.dmg && slot === "mainhand" ? "weapon" : isTrinket ? "trinket" : "armor";
    return {
      itemId: uid("itm"), name, type: gameType, icon, rarity, level, stats,
      slot, family: baseDef.family || "", weight: baseDef.weight || "",
      twoHanded: !!baseDef.twoHanded,
      req: this.requirementFor(baseDef, level),
      effect: this.describe({ type: gameType, stats }), price, quantity: 1
    };
  },

  /**
   * One level further — what a smith does for gold.
   *
   * The same `lvlScale` the generator used, applied as a ratio, so an
   * improved piece sits exactly where a piece rolled at the new level would
   * have. Two things are deliberately left alone: the **rarity**, because a
   * hammer does not make an iron sword legendary, and the **requirements**,
   * because a piece you can already hold should not become unliftable for
   * having been sharpened.
   */
  improve(item) {
    if (!item) return null;
    const from = +item.level || 1, to = from + 1;
    const ratio = (1 + (to - 1) * 0.16) / (1 + (from - 1) * 0.16);
    item.level = to;
    item.stats = item.stats || {};
    if (item.stats.damage)  item.stats.damage  = Math.max(1, Math.round(item.stats.damage * ratio));
    if (item.stats.defense) item.stats.defense = Math.max(1, Math.round(item.stats.defense * ratio));
    item.price = Math.max(1, Math.round((+item.price || 10) * ratio));
    item.improved = (+item.improved || 0) + 1;
    item.effect = this.describe(item);
    return item;
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

  /* --------------------------------------------------------- the paper doll */

  /**
   * Which slot an item hangs in.
   *
   * Three sources, in order: what the item says, what its authored gear type
   * says, and finally the old three-way guess — which is what keeps a
   * character rolled before any of this existed from losing their gear.
   */
  slotOf(item) {
    if (!item) return null;
    if (item.slot) return item.slot;
    if (item.gearType && typeof Content !== "undefined") {
      const def = Content.slotDef(item.gearType);
      if (def && def.slot) return def.slot;
    }
    return item.type === "weapon" ? "mainhand"
         : item.type === "armor" ? "chest"
         : item.type === "trinket" ? "ring" : null;
  },

  /** The heaviest armour a class may wear, as a number to compare. */
  weightRank(w) { return (ARMOR_WEIGHTS[w] || {}).order || 0; },

  /**
   * Can this character put this on, and if not, why not?
   *
   * One answer for the equip button, the tooltip and the greyed-out row, so
   * they can never disagree about it. The reason is a sentence, not a code:
   * "Too heavy for a Mage" is something a player can act on.
   */
  canEquip(ch, item) {
    if (!ch || !item) return { ok: false, why: "Nothing to wear." };
    const slot = this.slotOf(item);
    if (!slot) return { ok: false, why: "That is not something you wear." };
    const gear = CLASS_GEAR[ch.class] || null;
    const slotDef = EQUIP_SLOTS.find(s => s.key === slot);

    /* Only an explicit requirement gates by level. An item's *level* is what
       it was rolled at, not a demand — treating it as one told a level 1 mage
       that a bow "needs level 2", which is both wrong and hides the real
       reason they cannot draw it. */
    if (item.reqLevel && +item.reqLevel > (+ch.level || 1)) {
      return { ok: false, why: "Needs level " + item.reqLevel + "." };
    }

    // Armour weight: one rule for every armour piece there will ever be.
    if (gear && item.weight && slotDef && (slotDef.armor || slot === "offhand")) {
      if (this.weightRank(item.weight) > this.weightRank(gear.armor)) {
        return { ok: false, why: (ARMOR_WEIGHTS[item.weight] || {}).name +
                                 " armour is too heavy for a " + ch.class + "." };
      }
    }
    // Weapon and offhand families.
    if (gear && item.family) {
      const allowed = slot === "offhand" ? gear.offhand : gear.weapons;
      if (allowed && allowed.indexOf(item.family) < 0) {
        return { ok: false, why: "A " + ch.class + " was never taught the " + item.family + "." };
      }
    }
    // An explicit class list on an authored item wins over all of it.
    if (item.reqClasses && item.reqClasses.length && item.reqClasses.indexOf(ch.class) < 0) {
      return { ok: false, why: "For a " + item.reqClasses.join(" or ") + "." };
    }
    // Attribute minimums, measured against what you have *with* your gear on.
    const have = typeof Calc !== "undefined" && Calc.effectiveAttrs
                 ? Calc.effectiveAttrs(ch) : (ch.attributes || {});
    for (const k in (item.req || {})) {
      const need = +item.req[k] || 0;
      if (need && (+have[k] || 0) < need) {
        const a = ATTRS.find(x => x.key === k);
        return { ok: false, why: "Needs " + need + " " + (a ? a.short : k) + "." };
      }
    }
    return { ok: true, why: "" };
  },

  /** What a piece asks of you, as a line for the tooltip. */
  requirementText(item) {
    const parts = [];
    if (item.weight && ARMOR_WEIGHTS[item.weight]) parts.push(ARMOR_WEIGHTS[item.weight].name);
    if (item.twoHanded) parts.push("Two-handed");
    for (const k in (item.req || {})) {
      const a = ATTRS.find(x => x.key === k);
      parts.push((a ? a.short : k) + " " + item.req[k]);
    }
    if (item.reqClasses && item.reqClasses.length) parts.push(item.reqClasses.join("/"));
    return parts.join(" · ");
  }
};
