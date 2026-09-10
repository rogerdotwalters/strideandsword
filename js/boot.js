"use strict";
/* -------------------------------------------------------------------------
   21. Boot

   Load the JSON database first, seed any empty table from it, then show a
   screen. Seeding never overwrites a table you have edited — your rows win.
   ------------------------------------------------------------------------- */
(function boot() {
  async function go() {
    Screens.init();

    if (!Store.isDurable) {
      setTimeout(() => UI.toast(
        "This browser is blocking site storage, so progress lives in memory only and will not survive a reload.",
        "bad", 8000), 600);
    }

    try {
      await DB.load();
      const made = DB.seedAll(false);
      const n = Object.values(made).reduce((a, b) => a + (b || 0), 0);
      if (n) console.log("[db] seeded from data/*.json", made);
    } catch (e) {
      console.error("[db] load failed", e);
    }

    if (DB.problems.length) {
      const overFile = location.protocol === "file:";
      setTimeout(() => UI.toast(
        overFile
          ? "The database in data/ cannot be read from a file:// page. Run `npm run serve` and open http://localhost:8080."
          : "Some database files did not load: " + DB.problems.join("; "),
        "bad", 10000), 400);
    }

    const user = Auth.restore();
    if (!user) { Screens.show("auth"); return; }
    const chars = Object.values(Store.get(K.characters, {}) || {}).filter(c => c.userId === user.userId);
    Screens.show(chars.length ? "select" : "create");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
})();

/* Expose a few internals for console poking / test harnesses. */
window.SS = { Store, API, Auth, Game, Combat, Dungeon, Instance, Loc, Walk, Zones, Characters, Calc, Items,
              Bestiary, Screens, Atlas, OSM, Content, DB, settings, saveSettings, K };
