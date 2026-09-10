/* -------------------------------------------------------------------------
   6. CombatCalculator — all derived stats and damage maths
   ------------------------------------------------------------------------- */
const Calc = {
  /** Effective attributes = base (already includes race mods) + equipment. */
  effectiveAttrs(ch) {
    const a = Object.assign({}, ch.attributes);
    for (const it of (ch.equipment || [])) {
      if (it && it.stats && it.stats.bonusAttribute) {
        for (const k in it.stats.bonusAttribute) a[k] = (a[k] || 0) + it.stats.bonusAttribute[k];
      }
    }
    return a;
  },
  maxHp(ch) {
    const a = this.effectiveAttrs(ch), c = CLASSES[ch.class];
    return Math.round((44 + a.constitution * 6.5 + a.strength * 1.6 + (ch.level - 1) * 13) * c.hpMul);
  },
  maxMana(ch) {
    const a = this.effectiveAttrs(ch), c = CLASSES[ch.class];
    return Math.round((14 + a.intelligence * 4.4 + a.wisdom * 1.8 + (ch.level - 1) * 6) * c.mpMul);
  },
  maxStamina(ch) {
    const a = this.effectiveAttrs(ch), c = CLASSES[ch.class];
    return Math.round((46 + a.constitution * 3 + a.dexterity * 2.4 + (ch.level - 1) * 5) * c.spMul);
  },
  weaponDamage(ch) {
    const w = (ch.equipment || []).find(i => i && i.type === "weapon");
    return w ? (w.stats.damage || 0) : 2; // bare fists
  },
  armor(ch) {
    const a = this.effectiveAttrs(ch);
    let def = a.constitution * 0.55;
    for (const it of (ch.equipment || [])) if (it && it.stats && it.stats.defense) def += it.stats.defense;
    return Math.round(def);
  },
  attackPower(ch) {
    const a = this.effectiveAttrs(ch);
    const c = CLASSES[ch.class];
    const boost = c.name === "Warrior" ? 1.2 : c.name === "Rogue" ? 1.05 : 0.85;
    return (a.strength * 1.15 + a.dexterity * 0.55 + this.weaponDamage(ch) * 1.6) * boost;
  },
  spellPower(ch) {
    const a = this.effectiveAttrs(ch);
    const c = CLASSES[ch.class];
    const boost = c.name === "Mage" ? 1.35 : 0.8;
    return (a.intelligence * 1.45 + a.wisdom * 0.5 + this.weaponDamage(ch) * 0.7) * boost;
  },
  accuracy(ch)   { const a = this.effectiveAttrs(ch); return 74 + a.dexterity * 1.5 + a.luck * 0.4; },
  evasion(ch)    { const a = this.effectiveAttrs(ch); return a.dexterity * 1.35 + a.luck * 0.45; },
  critChance(ch) {
    const a = this.effectiveAttrs(ch);
    const base = 4 + a.luck * 0.85 + a.dexterity * 0.32;
    return clamp(base + (ch.class === "Rogue" ? 7 : 0), 0, 70);
  },
  critResist(ch) { const a = this.effectiveAttrs(ch); return a.wisdom * 0.65; },
  magicDefense(ch) {
    const a = this.effectiveAttrs(ch);
    let res = 0;
    for (const it of (ch.equipment || [])) if (it && it.stats && it.stats.resistance) res += it.stats.resistance;
    return a.wisdom * 1.25 + a.intelligence * 0.35 + res;
  },
  initiative(ch) { const a = this.effectiveAttrs(ch); return a.dexterity * 2 + a.luck * 0.5 + rnd(0, 8); },
  priceMod(ch)   { const a = this.effectiveAttrs(ch); return clamp(1 - (a.charisma - 10) * 0.02, 0.6, 1.4); },

  /** Mitigation curve: armour has diminishing returns, never full immunity. */
  mitigate(raw, defence) { return Math.max(1, raw * (100 / (100 + Math.max(0, defence)))); },

  xpForLevel(level) { return 1000 + (level - 1) * 450; },

  /** One attack resolution. Returns {hit, crit, damage}. */
  resolveHit(atk, def, opts) {
    opts = opts || {};
    const acc = (atk.accuracy || 80) + (opts.accBonus || 0);
    const evd = (def.evasion || 0) + (def.tempEvasion || 0);
    const hitChance = clamp(acc - evd * 0.75, 22, 96);
    if (!chance(hitChance)) return { hit: false, crit: false, damage: 0 };

    const critC = clamp((atk.critChance || 5) + (opts.critBonus || 0) - (def.critResist || 0), 0, 92);
    const crit = opts.guaranteedCrit || chance(critC);

    const defence = opts.kind === "magic" ? def.magicDefense : def.armor;
    let raw;
    if (atk.atkMin != null && atk.atkMax != null) {
      // An authored monster states its damage range outright, so use it as
      // written rather than deriving a figure from attributes.
      raw = rnd(atk.atkMin, atk.atkMax) * (opts.mult || 1);
    } else {
      const power = opts.kind === "magic" ? atk.spellPower : atk.attackPower;
      raw = power * (opts.mult || 1) * rnd(0.86, 1.14);
    }
    if (crit) raw *= 1.85;
    return { hit: true, crit, damage: Math.max(1, Math.round(this.mitigate(raw, defence))) };
  }
};
