/* -------------------------------------------------------------------------
   1. StorageService
   localStorage-backed, with a transparent in-memory fallback so the game
   still runs in sandboxed frames / private modes where storage throws.
   ------------------------------------------------------------------------- */
const Store = (function () {
  const mem = Object.create(null);
  let durable = true;
  try {
    const probe = "__ss_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
  } catch (e) { durable = false; }

  function raw(key) {
    if (durable) { try { return localStorage.getItem(key); } catch (e) { durable = false; } }
    return key in mem ? mem[key] : null;
  }
  function setRaw(key, val) {
    mem[key] = val;
    if (durable) {
      try { localStorage.setItem(key, val); }
      catch (e) {
        durable = false;
        console.warn("[Store] localStorage unavailable, using memory:", e && e.message);
      }
    }
  }
  return {
    get isDurable() { return durable; },
    get(key, fallback) {
      const v = raw(key);
      if (v == null) return fallback === undefined ? null : fallback;
      try { return JSON.parse(v); }
      catch (e) { console.warn("[Store] corrupt key", key); return fallback === undefined ? null : fallback; }
    },
    set(key, value) { setRaw(key, JSON.stringify(value)); return value; },
    patch(key, mutator) {
      const cur = this.get(key, {}) || {};
      mutator(cur);
      return this.set(key, cur);
    },
    remove(key) {
      delete mem[key];
      if (durable) { try { localStorage.removeItem(key); } catch (e) {} }
    },
    /* Session (tab-scoped) values, same fallback story. */
    session: {
      get(key, fb) {
        try { const v = sessionStorage.getItem(key); return v == null ? (fb ?? null) : JSON.parse(v); }
        catch (e) { return key in mem ? JSON.parse(mem["__s_" + key] || "null") : (fb ?? null); }
      },
      set(key, val) {
        mem["__s_" + key] = JSON.stringify(val);
        try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
      },
      remove(key) {
        delete mem["__s_" + key];
        try { sessionStorage.removeItem(key); } catch (e) {}
      }
    },
    usageBytes() {
      let n = 0;
      try { for (const k in localStorage) if (Object.prototype.hasOwnProperty.call(localStorage, k)) n += (localStorage[k] || "").length; }
      catch (e) {}
      return n;
    }
  };
})();

/* Canonical localStorage keys, per the storage strategy in the design doc. */
const K = {
  session:     "user_session",
  accounts:    "accounts",
  characters:  "characters",
  zones:       "zones",
  nodes:       "nodes",
  inventories: "inventories",
  encounters:  "encounters",
  settings:    "settings",
  walk:        "walk_stats",
  dungeonRuns:   "dungeon_runs",
  instanceRuns: "instance_runs"
};
