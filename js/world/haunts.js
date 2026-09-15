"use strict";
/* -------------------------------------------------------------------------
   8e. Haunts — your real places, and what they are in the world.

   The generated world is the same everywhere: a park is a park wherever you
   are. A quest needs something stronger — "go to the greenwood" has to mean a
   *particular* wood, the one you actually walk to, or the quest is just
   another procedural site with a story bolted on.

   So you name your places once: home, two parks, the grocery, a handful of
   food and recreation spots. Each is assigned a **role** — what it is in the
   fantasy world — and from then on a quest says "spawn this at a forest" and
   never has to know where your forest is.

   WHY ROLE AND NOT PLACE

   A quest that referred to `park1` would be a quest about your park. A quest
   that refers to `forest` is a quest anyone can run, against their own wood.
   That is the whole difference between content you author for yourself and
   content you can hand to someone else, and it costs nothing to get right
   now.

   WHY PER ACCOUNT, NOT PER CHARACTER

   Your home does not move when you roll a new character. The table is keyed
   by userId, so a second character inherits the places the first one chose
   and the picker is a one-time job rather than a tax on every new character.

   WHAT A HAUNT KEEPS

   Coordinates, obviously. Also the **ring** when there is one: a park picked
   out of the atlas comes with its real polygon, and that is what lets a quest
   node land *inside* the park rather than somewhere near its middle. A haunt
   dropped by hand has no ring and falls back to a radius.
   ------------------------------------------------------------------------- */
const Haunts = {
  KEY: "player_haunts",

  /* ------------------------------------------------------------------ roles

     The fantasy presets. `category` is what kind of real place suits it, and
     is only ever a suggestion — if you want your gym to be the Shrine of the
     Iron Saint, nothing stops you. */
  ROLES: [
    { key: "holdfast",  name: "Holdfast",      icon: "🏰", category: "home",
      blurb: "Where you live. The streets around it are the kingdom's roads." },
    { key: "forest",    name: "Greenwood",     icon: "🌲", category: "park",
      blurb: "A wood. Quests that want somewhere open and green come here." },
    { key: "deepwood",  name: "Deep wood",     icon: "🌲", category: "park",
      blurb: "The further, wilder one. Meaner things live here." },
    { key: "market",    name: "Market square", icon: "🧺", category: "food",
      blurb: "Where everything is bought and sold." },
    { key: "tavern",    name: "Tavern",        icon: "🍺", category: "food",
      blurb: "Rumours, contracts, and somewhere to sit down." },
    { key: "cookhouse", name: "Meat cutter",   icon: "🍖", category: "food",
      blurb: "The butcher's block. Not a delicate place." },
    { key: "tanner",    name: "Tanner",        icon: "🧵", category: "any",
      blurb: "Hides, thread, and a smell you get used to." },
    { key: "guildhall", name: "Guild hall",    icon: "⚔️", category: "any",
      blurb: "Where work is posted and arguments are settled." },
    { key: "shrine",    name: "Shrine",        icon: "⛲", category: "any",
      blurb: "Quiet, and older than the town around it." },
    { key: "wharf",     name: "Wharf",         icon: "⚓", category: "any",
      blurb: "Water, cargo, and people who did not want to be seen." }
  ],

  /* ------------------------------------------------------------------ slots

     What the picker asks for, in order. The counts are the ones that matter:
     one home, two parks, one grocery, four spots — enough for a quest chain
     to visit somewhere different at every step without becoming a form nobody
     finishes. */
  SLOTS: [
    { key: "home",   label: "Home",              category: "home", required: true,  role: "holdfast",
      hint: "Where you start and end the day." },
    { key: "park1",  label: "Favourite park",    category: "park", required: true,  role: "forest",
      hint: "The one you actually walk in." },
    { key: "park2",  label: "Second park",       category: "park", required: false, role: "deepwood",
      hint: "Further out, or just the other one." },
    { key: "market", label: "Grocery store",     category: "food", required: false, role: "market",
      hint: "Where the food comes from." },
    { key: "spot1",  label: "Food or recreation", category: "any", required: false, role: "tavern",
      hint: "A regular haunt." },
    { key: "spot2",  label: "Food or recreation", category: "any", required: false, role: "cookhouse",
      hint: "Another one." },
    { key: "spot3",  label: "Food or recreation", category: "any", required: false, role: "guildhall",
      hint: "The gym, the pub, the library." },
    { key: "spot4",  label: "Food or recreation", category: "any", required: false, role: "tanner",
      hint: "Anywhere you end up." }
  ],

  role(key) { return this.ROLES.find(r => r.key === key) || this.ROLES[0]; },
  slot(key) { return this.SLOTS.find(s => s.key === key) || null; },

  /* ------------------------------------------------------------------ store */

  userId() {
    const s = Store.get(K.session, null);
    return (s && s.userId) || "local";
  },

  all(userId) {
    const book = Store.get(this.KEY, {}) || {};
    return book[userId || this.userId()] || {};
  },

  /** One slot, or null. */
  get(slotKey, userId) { return this.all(userId)[slotKey] || null; },

  set(slotKey, haunt, userId) {
    const id = userId || this.userId();
    Store.patch(this.KEY, (book) => {
      book[id] = book[id] || {};
      if (!haunt) delete book[id][slotKey];
      else book[id][slotKey] = Object.assign({ slotKey, setAt: nowTs() }, haunt);
    });
    return this.get(slotKey, userId);
  },

  clear(userId) {
    Store.patch(this.KEY, (book) => { delete book[userId || this.userId()]; });
  },

  /** Every haunt set, in slot order. */
  list(userId) {
    const mine = this.all(userId);
    return this.SLOTS.map(s => mine[s.key]).filter(Boolean);
  },

  /** Have the required ones been chosen? The picker asks until they have. */
  ready(userId) {
    const mine = this.all(userId);
    return this.SLOTS.filter(s => s.required).every(s => mine[s.key]);
  },

  /** How far through the picker you are. */
  progress(userId) {
    const mine = this.all(userId);
    return { set: Object.keys(mine).length, total: this.SLOTS.length,
             required: this.SLOTS.filter(s => s.required).length,
             ready: this.ready(userId) };
  },

  /* --------------------------------------------------------------- making */

  /**
   * A haunt from an atlas place — the good case. It arrives with the real
   * polygon, which is what a quest boundary needs, and with the fantasy name
   * the atlas already gave it.
   */
  fromPlace(row, slotKey, roleKey) {
    const slot = this.slot(slotKey);
    return {
      slotKey,
      role: roleKey || (slot && slot.role) || "shrine",
      name: row.name || row.realName || "Somewhere",
      realName: row.realName || "",
      latitude: +row.latitude, longitude: +row.longitude,
      placeKey: row.key || "",
      category: row.category || (slot && slot.category) || "any",
      ring: Array.isArray(row.ring) && row.ring.length > 2 ? row.ring.slice() : null,
      radiusM: this.radiusFromRing(row.ring) || 60,
      source: "atlas"
    };
  },

  /** A haunt from a pin you dropped. No ring, so it is a circle. */
  fromPoint(lat, lng, slotKey, roleKey, name, radiusM) {
    const slot = this.slot(slotKey);
    return {
      slotKey,
      role: roleKey || (slot && slot.role) || "shrine",
      name: name || (slot && slot.label) || "Somewhere",
      realName: "",
      latitude: +lat, longitude: +lng,
      placeKey: "",
      category: (slot && slot.category) || "any",
      ring: null,
      radiusM: +radiusM || 70,
      source: "pin"
    };
  },

  /** The radius of a circle that roughly covers a ring. */
  radiusFromRing(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return 0;
    let la = 0, ln = 0;
    ring.forEach(p => { la += p[0]; ln += p[1]; });
    const c = [la / ring.length, ln / ring.length];
    let max = 0;
    ring.forEach(p => { max = Math.max(max, haversine(c[0], c[1], p[0], p[1])); });
    return Math.round(max);
  },

  centroid(haunt) {
    if (!haunt) return null;
    return { latitude: +haunt.latitude, longitude: +haunt.longitude };
  },

  /* ------------------------------------------------------------- resolving

     What a quest actually asks: "give me somewhere that is a forest". Never
     dead-ends — a quest that cannot find its place is a quest that silently
     stops, which is worse than one that happens somewhere slightly wrong. */

  /** Every haunt playing this role. */
  byRole(roleKey, userId) {
    return this.list(userId).filter(h => h.role === roleKey);
  },

  /**
   * Somewhere to put a quest node.
   *
   * In order: a haunt with exactly this role; a haunt whose slot category
   * matches the role's; any haunt at all; and finally a real place of the
   * right category near the player, invented on the spot. The last one is
   * what keeps a quest running for somebody who never opened the picker.
   */
  resolve(roleKey, opts) {
    opts = opts || {};
    const rnd = opts.rnd || Math.random;
    const pick = (list) => list.length ? list[Math.floor(rnd() * list.length)] : null;

    const exact = this.byRole(roleKey, opts.userId);
    if (exact.length) return pick(exact);

    const role = this.role(roleKey);
    const sameKind = this.list(opts.userId).filter(h => h.category === role.category);
    if (sameKind.length) return pick(sameKind);

    const any = this.list(opts.userId);
    if (any.length) return pick(any);

    return this.improvise(role, opts);
  },

  /**
   * No haunts at all: borrow from the atlas. Not stored — this is a stand-in
   * for one run, so choosing your places later still changes where quests go.
   */
  improvise(role, opts) {
    const at = (opts && opts.at) || (typeof Loc !== "undefined" ? Loc.last : null);
    if (!at || typeof Atlas === "undefined") return null;
    const wanted = role.category === "park" ? "park" : role.category === "food" ? "food" : null;
    const near = Atlas.nearPlaces(at.latitude, at.longitude, 1200) || [];
    const fit = near.filter(p => !wanted || p.row.category === wanted);
    const row = (fit[0] || near[0] || {}).row;
    if (!row) return null;
    const h = this.fromPlace(row, "improvised", role.key);
    h.improvised = true;
    return h;
  },

  /* --------------------------------------------------------------- geometry

     A quest node lands *inside* a haunt, and how far inside is the quest's
     business: 100% of the park, or the middle half of it, with a floor so a
     small park does not collapse to a point.
   */

  /**
   * The ring shrunk toward its centroid by `percent`, so a boundary of 50 is
   * the middle half of the park rather than a circle drawn over it. Returns
   * null when the haunt has no ring.
   */
  shrunkRing(haunt, percent) {
    if (!haunt || !Array.isArray(haunt.ring) || haunt.ring.length < 3) return null;
    const f = clamp((+percent || 100) / 100, 0.05, 1);
    if (f >= 0.999) return haunt.ring.slice();
    let la = 0, ln = 0;
    haunt.ring.forEach(p => { la += p[0]; ln += p[1]; });
    const c = [la / haunt.ring.length, ln / haunt.ring.length];
    return haunt.ring.map(p => [c[0] + (p[0] - c[0]) * f, c[1] + (p[1] - c[1]) * f]);
  },

  /**
   * How big the quest area actually is, in metres, after the percentage and
   * the floor have both had their say. The floor is the important half: a
   * boundary of 20% on a small park is a spot you cannot stand outside of.
   */
  areaRadiusM(haunt, percent, minRadiusM, maxRadiusM) {
    const full = Math.max(10, +((haunt && haunt.radiusM) || 60));
    const want = full * clamp((+percent || 100) / 100, 0.05, 1);
    const floor = Math.max(10, +minRadiusM || 25);
    const ceil = +maxRadiusM > 0 ? Math.min(+maxRadiusM, full) : full;
    // The floor wins over the percentage, and the place's own size wins over
    // the floor — a 15 m pocket park cannot hold a 25 m quest area, and
    // pretending otherwise puts the node in the road.
    return Math.round(clamp(Math.max(want, Math.min(floor, full)), 10, ceil));
  },

  /**
   * A point inside the haunt, respecting the boundary.
   *
   * With a ring: rejection sampling inside the shrunk polygon, which is the
   * only way to be honest about a park that is long and thin. Without one, or
   * if sampling gives up: a point in the circle.
   */
  pointIn(haunt, percent, minRadiusM, maxRadiusM, rnd) {
    const r = rnd || Math.random;
    if (!haunt) return null;
    const ring = this.shrunkRing(haunt, percent);
    const radius = this.areaRadiusM(haunt, percent, minRadiusM, maxRadiusM);

    if (ring && typeof Content !== "undefined" && Content.pointInRing) {
      let s = ring[0][0], n = ring[0][0], w = ring[0][1], e = ring[0][1];
      ring.forEach(p => {
        s = Math.min(s, p[0]); n = Math.max(n, p[0]);
        w = Math.min(w, p[1]); e = Math.max(e, p[1]);
      });
      // Content.pointInRing takes the ring FIRST. Passing it (lat, lng, ring)
      // reads perfectly and silently does nothing: `ring.length` on a number is
      // undefined, every sample is rejected, and the whole thing quietly falls
      // back to the circle — a park-shaped feature that never used the park.
      for (let i = 0; i < 60; i++) {
        const lat = s + r() * (n - s), lng = w + r() * (e - w);
        if (Content.pointInRing(ring, lat, lng)) return { latitude: lat, longitude: lng, inRing: true };
      }
    }

    // sqrt keeps the circle area-uniform rather than clustering in the middle.
    const d = Math.sqrt(r()) * radius;
    const p = projectPoint(haunt.latitude, haunt.longitude, d, r() * 360);
    return { latitude: p.latitude, longitude: p.longitude, inRing: false };
  },

  /* ---------------------------------------------------------------- export */

  export(userId) {
    return {
      format: "stride-and-sword.haunts", version: 1,
      exportedAt: new Date().toISOString(),
      haunts: this.list(userId)
    };
  },

  stats(userId) {
    const list = this.list(userId);
    return {
      set: list.length, total: this.SLOTS.length,
      withRing: list.filter(h => h.ring).length,
      roles: list.map(h => h.role)
    };
  }
};
