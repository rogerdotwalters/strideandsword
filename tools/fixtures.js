/* -------------------------------------------------------------------------
   Shared test fixtures.

   The game seeds itself from data/*.json on first run, which is right for a
   person opening it and wrong for a suite that is testing what happens with an
   empty database. Seeding only fills a table that has never been written, so
   declaring the tables empty up front is all it takes — no test-only branch in
   the game itself.
   ------------------------------------------------------------------------- */

/* Only the world tables. Monsters, loot and items still seed from data/, the
   way the old built-in seed filled them, because a suite that authors a spawn
   table needs monsters to put in it. What a suite must not inherit is the
   sample world: the seeded locations, dungeons and instances would show up
   inside every zone it creates and quietly fail its counts. */
const CONTENT_KEYS = [
  'content_spawns', 'content_locations', 'content_dungeons', 'content_instances'
];

/**
 * An init script: every content table present and empty, so nothing seeds.
 *
 * It runs on every navigation, reloads included, so it only ever writes a key
 * that is not there yet. Wiping on each load would delete whatever the suite
 * had just authored, which is exactly what a reload test is checking for.
 */
const EMPTY_DB = `
(function () {
  var keys = ${JSON.stringify(CONTENT_KEYS)};
  try {
    keys.forEach(function (k) {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, '[]');
    });
  } catch (e) { /* storage blocked; the game falls back to memory anyway */ }
})();
`;

/** Apply it to a page before it navigates. */
async function emptyDatabase(page) {
  await page.addInitScript(EMPTY_DB);
}

module.exports = { EMPTY_DB, CONTENT_KEYS, emptyDatabase };
