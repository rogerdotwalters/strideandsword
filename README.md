# Stride & Sword

A location-based roguelike for walking around the office. Your phone's GPS moves
your character; the real streets and buildings around you are redrawn as a
fantasy town, and the interesting sites are a deliberate walk away.

Five pages: the game, a content editor for its monsters, loot tables, items and
quests, a map editor for placing the locations, dungeons and instances it spawns
from, a shape editor for drawing your own fantasy buildings over the real map,
and a region editor for saying what the ground *is* — marsh, wood, field — and
what lives on it. Plain files — no framework, no bundler, no build step at all.
The JavaScript is a tree of small files loaded with `<script src>`, and the
game's starting data is a folder of JSON you can open and edit.

---

## Deploying to Cloudflare Pages

**Settings to use when you connect this repo:**

| Field | Value |
|---|---|
| Framework preset | **None** |
| Build command | *(leave blank)* |
| Build output directory | `/` |
| Root directory | *(leave blank — repo root)* |

Steps: Cloudflare dashboard → **Workers & Pages** → **Create application** →
**Pages** → **Connect to Git** → authorise GitHub → pick this repo →
**Install & Authorize** → **Begin setup** → enter the settings above →
**Save and Deploy**.

Every push to the production branch redeploys. Pushes to other branches get
their own preview URL, which is handy for trying a change on your phone before
it goes live.

There is nothing to compile: the repo root *is* the site. That is also why
there is **no `package.json` at the repo root** — Cloudflare's build system
auto-installs dependencies whenever it finds one, and this project needs none.
The tooling manifest lives in `tools/` for exactly that reason; don't move it
up.

### After it's live

- The `.pages.dev` URL is unguessable but public. This build has no real login —
  passwords are obfuscated client-side, not hashed — so treat any account made
  on it as disposable. Cloudflare Access can put a genuine login in front of the
  whole site if that matters.
- Map tiles come from OpenStreetMap's servers and the street survey from the
  public Overpass API, both on fair-use terms. Fine for one office, not for a
  crowd. Both send CORS headers, so no proxy is needed. What the app does to
  stay inside those terms — one query at a time, spaced, backed off when asked,
  and cached hard — is under *Asking nicely* below. If this ever grows past one
  office, the honest next step is your own Overpass instance rather than turning
  any of that off.

---

## Why it must be served, not opened

Two separate reasons, both fatal on `file://`:

**Geolocation** is only granted on a **secure origin**: `https://…` or
`http://localhost`. Open the file directly and Chrome and Safari will never even
show the permission prompt — there is no origin for them to attach the
permission to. A LAN address like `http://192.168.1.20:8000` is also not secure
and always fails.

**The database is fetched.** `data/*.json` is loaded with `fetch()`, which
refuses a `file://` URL outright. Off disk you get the auth screen and a message
telling you to serve it.

Locally:

    cd tools && npm run serve      # or: python3 -m http.server 8000 at the repo root

then open <http://localhost:8000/>.

The app detects all of this and explains the specific blocker rather than
failing silently — see the location gate and its **Show diagnostics** button.

---

## Layout

    index.html        the game
    editor.html       the content editor
    mapeditor.html    the map editor
    shapes.html       the shape editor
    regions.html      the region editor
    css/
      game.css        the game's styles
      editor.css      content editor
      mapeditor.css   map editor (the shape editor borrows this too)
      shapes.css      only what the shape editor adds to it
      regions.css     only what the region editor adds to it
    js/
      core/
        util.js       helpers, geo maths, formatting
        store.js      localStorage wrapper + the key registry
        api.js        the API scaffold and the local backend behind it
        settings.js   defaults, the zoom presets, read/write
        db.js         loads data/*.json and seeds anything still empty
      player/
        auth.js       register, log in, restore a session
        classes.js    attributes, races, classes, skills, fallback bestiary
        player.js     the character: create, level, derive, save
      combat/
        calc.js       every derived stat and damage calculation, nothing else
        fight.js      the turn-based fight itself
      world/
        content.js    the authored database: CRUD, rarity, icons, geometry
        items.js      procedural item generation
        bestiary.js   turning an authored monster into an enemy
        atlas.js      the coordinate-keyed name database + Overpass client
        grid.js       the two grids: 500 m chunks and 2 km regions
        chunks.js     the world filling in as you walk, and what it throws away
        zones.js      zones and procedural node scatter
        location.js   geolocation, distance accumulation, proximity
        art.js        the PNGs that sit on the map, and the faces on everything
        shapes.js     hand-drawn buildings: the model, shared with the editor
        regions.js    terrain regions: what the ground is, and what it spawns
        kml.js        Google Earth exports (KML/KMZ) turned into GeoJSON
        haunts.js     your real places, and what they are in the world
        quests.js     quest definitions, runs, dialogue and flags
        denizens.js   things that move, and the boundaries that hold them
        buildings.js  places on the map, and the people who work out of them
        placement.js  the scoring core: what goes where, and how often
        spawner.js    the lifecycle: what appears when, and what expires
        walk.js       the pedometer and the daily goal
        dungeons.js   dungeon runs: entering, walking a floor, descending
        instances.js  instance runs: steering, walls, roaming monsters
      ui/
        ui.js         toasts and small helpers
        screens.js    routing between screens
        game.js       the game controller, map and HUD
        nodes.js      node interaction
        questui.js    the places picker, quest nodes on the map, dialogue
        tradeui.js    buildings on the map, and doing business with a resident
        panels.js     character sheet, inventory, menu, settings
      dev/devpanel.js the dev-test panel
      boot.js         loads the database, then shows a screen
      editor/
        app.js        the content editor
        quests.js     its Quests tab
      mapeditor/
        app.js        map, table, and the location form
        dungeons.js   the dungeon layer: footprints, resizing, floors
        instances.js  the instance layer: doors and their levels
        buildings.js  the building layer: points, outlines, residents
      shapes/app.js   the shape editor
      regions/app.js  the region editor
    data/             the seeded database — see below
    docs/             google-earth.md: how to name what you draw there
    art/              PNGs that locations can put on the map
    tools/            tests and tooling (not deployed)

There are no modules and no bundler. Every file is a classic `<script src>`, so
**load order is the dependency graph** — a top-level `const` in one file is
visible to every file loaded after it. The order is written out in each HTML
page, and it goes core → player → combat maths → world → UI → boot. If you add
a file, add it to the page in the right place.

Every editor reuses the same `core/` and `world/content.js` verbatim, which is
what keeps them honestly in step with the game rather than reimplementing it.

## The seeded database

`data/` holds everything the game starts with, as plain JSON you can open in
any editor:

    data/config.json      the rarity multipliers
    data/items.json       33 items
    data/monsters.json    29 monsters, grouped by terrain
    data/loot.json        4 loot tables
    data/spawns.json      12 spawn tables: one per terrain, plus three depth tiers
    data/locations.json   3 sample locations, one with a PNG
    data/dungeons.json    2 sample dungeons
    data/instances.json   2 sample instances
    data/regions.json     terrain regions (empty until you import or draw some)
    data/buildings.json   5 sample buildings and the people in them
    data/players.json     test logins — `tester` / `walk1234`
    data/spawn-rules.json the spawn weights — see below
    data/shapes.json      hand-drawn scenery — empty until you draw some
    data/quests.json      one sample quest, three steps

On boot, `js/core/db.js` fetches all of it and seeds any table that has **never
been written**. A table you have edited — or deliberately emptied — is left
alone, so your work always wins over the seed and deleting the last monster
does not conjure fourteen back on the next reload. "Reseed from JSON" in the
content editor forces it.

Sample locations, dungeons and instances carry placeholder coordinates. The
first time a zone is anchored, every seeded row is shifted by the same offset
so the samples land around wherever you actually are rather than in a car park
in Chicago.

`data/players.json` holds plain-text passwords on purpose. It is a stand-in for
a real accounts service and everything in it is throwaway — see *Where the
backend goes* at the bottom.

## The content editor

`/editor.html` is a desktop CRUD tool over three tables that the game reads
live from the same `localStorage`:

    content_monsters   name, icon, type, rarity, boss flag, level range,
                       base HP, armour, attack name and min/max, damage type,
                       XP and gold, loot table
    content_loot       parallel `loot` and `chances` arrays sharing an index,
                       plus dropsMin / dropsMax
    content_items      name, gear type, icon, rarity, damage type and min/max,
                       armour, resistance, restores, level, value, description
    content_spawns     weighted monster lists with a pack size
    content_locations  hand-placed sites, each able to carry a PNG
    content_dungeons   a walk: a footprint and a stack of floors
    content_instances  a place: a door, and a rectangle behind it

**Rarity scales monsters, and only on read.** What you type is the base; the
Rarity tab holds a multiplier per tier for HP, damage, armour, XP and extra
loot rolls. Nothing is ever written back multiplied, so changing a multiplier
moves every monster of that tier at once. The monster form shows base and
effective side by side.

**Loot percentages are never normalised.** Each entry is rolled independently
against exactly the number you typed — a table can total 12% or 900%. The drop
count then clamps the result: a surplus is trimmed at random, a shortfall is
topped up from the entries that missed, weighted by their own chance.

**Authored gear maps onto the game's three equipment slots** via each gear
type's `gameType` — sword/axe/staff and friends are weapons, helm/chest/shield
are armour, ring/amulet/gem are trinkets. Items carry an inline SVG icon from a
set of 25 originals in `js/world/content.js`, tinted by rarity, rendered in the
pack and the reward screens.

The monster numbers in `data/monsters.json` were derived by
`tools/calibrate.js` from the pre-authoring combat maths, so seeding reproduces
the original difficulty curve rather than quietly changing it. Re-run that
script if the fallback bestiary in `js/player/classes.js` is ever retuned. An
empty content database falls back to that built-in bestiary, so the game still
runs if you delete everything.

## The map editor

`/mapeditor.html` places the sites the game spawns from, instead of leaving
them to the procedural scatter. Click **+ Place location** then click the map;
drag a pin to move it; the radius slider resizes its trigger circle live. The
table underneath carries every column and stays in step with the map. The
🚗/🚶 buttons are the same two zoom presets the game uses, which is what makes
it practical to drop a pin on a particular doorway.

Each location holds a **building type**, a **spawn table** (or none), a
**chest** with its own loot table (or none), and its **spawning times**:

- an opening window like `09:00`–`17:00`, which may wrap past midnight
- the days of the week it is open, or all of them
- a respawn cooldown in minutes, or zero to stay cleared once beaten

A closed location shows a clock on the game map and refuses to be engaged.
A location whose cooldown has elapsed comes back on the next position fix.

A location is nudged onto something real once the street survey lands, and
that nudge is weighted now rather than nearest-wins: what the building is, what
it sits inside, and how near a road it is all count (`locations` in
`data/spawn-rules.json`). Nothing is excluded — the dullest building in range is
still a possible answer, just a less likely one than the market by the road.

Locations belong to a **zone**. A zone can be marked *hand-placed only*, and
the game then stops scattering procedural sites inside it — the procedural ones
stay in storage untouched, so the flag is reversible. Zones can be created,
renamed, moved (drag the gold anchor) and resized here too.

Editing a location updates its site in the game in place, keeping whatever
progress the player has made against it. The node id is derived from the
location id, which is what makes that possible. A hand-placed site is never
snapped onto the nearest building the way a procedural one is — you put it on
that doorway on purpose.

### Art on the map

A location can carry a **PNG that lies on the map** underneath its pin. Give it
either a path — `art/loading-dock.png`, relative to the page — or upload a file
in the editor, which stores it inline as a `data:` URL. Both end up in the same
`image` field, so nothing downstream cares which you used.

The picture is **sized in metres, not pixels**: set its width on the ground and
its height follows the file's own proportions, so it holds its size against the
real buildings however far you zoom. That is the only way a drawing of the
loading dock can sit on the actual loading dock. There is a rotation field for
squaring it up to a building that isn't aligned north.

A path keeps the database small and is what you want once the art is settled;
an upload is what you want while you are still trying things, because there is
no file to deploy. Uploads are capped at 700 KB — the whole database goes
through `localStorage`, which is a few megabytes in total.

### Testing what you place

Everything the game reads lives in the same `localStorage`, so the map editor
and the game are two tabs over one database. Switch to the game tab and it
re-reads what changed — on focus, and on the browser's own storage event — so
you no longer have to reload to see something you just placed.

To get to it, turn on **Dev test** and use the dev panel's *Authored content*
list: every location, dungeon and instance you have authored, nearest first
(capped at 25, because the world now generates plenty of its own), with
**Walk to it** (a simulated walk at walking pace, so the proximity checks fire
exactly as they would on foot), **Teleport to it**, and **Go straight in**,
which skips the doorstep prompt. **Reload authored** forces a re-read and says
what changed.

The panel also has a **chunked world** section — load the cells around you now,
or wipe them and watch them regenerate — and a **spawning** section with what is
live, what is next, and buttons to force or clear a spawn rather than waiting
hours for the schedule.

One thing to know: a zone created in the map editor belongs to the *world*, not
to a player, so every character sees it. Without that, content authored in the
editor was invisible in the game — which is exactly the bug it fixes. The zone
picker lists only zones somebody made by hand; the 500 m cells the game
generates as you walk are counted in the status bar but kept out of the list,
which would otherwise fill with them after a single walk.

## The world fills in as you walk

There is no home base. The world is quantised onto two grids, and everything
you see belongs to a cell of one of them:

    local chunks   500 m   locations and dungeons, an hour or three of life
    regions       2000 m   instances only, one to three days of life

Walk into a chunk and **its whole set of locations is generated at once** —
eight of them, placed with the same weights as everything else, then nudged
onto real buildings once the map data for that cell arrives. Seeing them is a
separate question: inside the **300 m sight radius** a site is itself, and
outside it shows as a `?` you can prod for a distance but not enter. That is
the radar.

A chunk *is* a zone row — `kind: "chunk"`, a `chunkKey`, and a radius of 354 m
so the circle covers the square — which is what lets the spawner, the placement
scoring and the map editor carry on unchanged. A zone you made by hand still
wins wherever you are standing inside one, so the office you set up
deliberately is never paved over by the grid; mark it **hand-placed only** and
nothing procedural is generated inside it at all.

The grid quantises latitude uniformly (500 m is 0.004523°) and longitude per
**latitude band**, `latStep / cos(lat)`, so cells stay about 500 m square from
the equator to well past the Arctic Circle rather than turning into letterboxes
away from one chosen latitude.

### Three budgets, because the pieces are wildly different sizes

    one location row         ~400 bytes
    one Atlas building row    319 bytes
    one chunk's raw geometry  370 KB – 2 MB

localStorage is about 5 MB in total, so only one of those can actually fill it:

- **raw geometry** — a byte budget (1.8 MB, and no single chunk over 800 KB),
  least-recently-seen evicted first. It is the only thing big enough to matter
  and the only thing that costs one query to get back.
- **Atlas rows** — kept. They are small, they are what the spawner reads, and
  dropping them would rename every street you walk back down.
- **locations** — an hour, then a cap of 300, oldest first. Never one you are
  standing in range of, and never one you are mid-fight with. A chunk left with
  nothing is forgotten entirely, so walking back into it generates a fresh set
  rather than an empty one.

Surveys are done one cell at a time, and only for the cells within 350 m, which
is five to seven of them — see *Asking nicely* below — and the map draws as soon
as the cell underfoot lands rather than waiting for its neighbours. **If
Overpass cannot be reached the chunk is generated anyway** and marked blind; the
geometry snaps its sites onto real buildings later, when it arrives. The game
has always been playable on a plain map and it stays that way.

## Asking nicely

Three donated services hold this game up — the Overpass API for geometry, OSM's
tile servers for the base map, Nominatim for the map editor's search — and each
publishes a usage policy. A game that surveys the ground as you walk is exactly
the client those policies exist to restrain, so the restraint is written into
the code rather than left to good intentions.

**Every Overpass request goes through one gate.** One in flight at a time
whatever the caller, 1.5 s apart, twelve a minute. A 429 or a 504 sets a
cool-off — honouring `Retry-After` when the server lets a browser read it — and
is deliberately **not** retried on another endpoint, because that moves the load
onto a different volunteer rather than reducing it. The cool-off is stored, so
reloading the page is not a way out of it.

**A cell that failed is not asked again for a minute**, doubling to half an
hour. This is the one that mattered most: with Overpass unreachable the old code
re-asked every cell in range on every sync — around sixty requests a minute,
indefinitely. It is three now, and then silence.

**The cache is the real politeness**, so it was made to hold much more. A
response is pruned to the ten tags anything actually reads and its coordinates
rounded to about 10 cm before storage — 56% smaller on the test town — and kept
for a month. Standing still costs nothing; walking back over ground you covered
this morning costs nothing. "Resurvey the streets" only drops the cells you can
see, and "Rename the whole town" re-digests what is already cached rather than
asking again.

**Tiles** update when the map settles rather than on every GPS nudge, keep a
buffer so walking back asks for nothing, and stop requesting real tiles past
zoom 19. **Nominatim** is held to one search a second with its answers
remembered.

The dev panel shows the running total, and `npm run test:chunks` ends with eight
assertions that measure it — request overlap, the gaps between requests, which
hosts were contacted after a 429, and what a reload does to a cool-off.

## Where things spawn, and how often

Everything the game puts on the map by itself is placed by one scoring core
(`js/world/placement.js`), tuned from one file you are meant to edit
(`data/spawn-rules.json`). Nothing there is code.

**A weight is never a filter.** Every category keeps a floor, every category
outside its hours keeps a multiplier rather than a zero, and `other` — anywhere
public we could not categorise — always carries some weight. An office with no
mapped parks and no mapped shops still gets dungeons; they just land on
ordinary buildings. There is no empty case to special-case.

### The two dials

**`contrast`** decides how much any of this is noticeable. Raw weights are
raised to this power before anything is picked, so the default 0.55 turns a
ten-to-one spread into about three-and-a-half to one — a park is clearly
favoured without the corner shop feeling dead. Set it to 1 to feel the weights
exactly as written, or 0 to make everywhere equally likely.

**`outOfWindowMultiplier`** is what a category is worth outside its hours.
0.35, not 0: a grocery store at 3am is possible, just uncommon. Dungeons keep
no hours at all, so theirs sits at 1.

### Categories

Places come from OpenStreetMap and fall into five coarse buckets — `park`,
`food`, `civic`, `transit`, `other`. Five you can hold in your head beat twenty
you have to look up, and the weights file addresses them by name.

At the default weights a dungeon lands on a park about a third of the time, a
food place a quarter, and an ordinary building about one time in ten.

### Dungeons: one per chunk

One live in each 500 m chunk you have loaded, always, so the world fills in as
you explore rather than all at once. It lasts about three hours — longer at a
park, shorter at a car park, because the lifetime is weighted too — or until
you clear it, and then the next appears somewhere else in that cell about
fifteen minutes later. That fifteen minutes is deliberately a gap, not an
overlap: it is what gives a cleared dungeon a sense of ending.

A fresh spawn is also kept **120 m away from you**. A dungeon is something you
walk to, and a cell you have just stepped into would otherwise open its door
prompt in your face. Expired dungeons are swept wherever they are, not only in
the cells you are standing among, so a long walk does not leave a trail of them
in storage.

The separation rule asks for 2000 ft between dungeons. A chunk is only 500 m
across, so that is usually unsatisfiable — the rule then stops being a hard
floor and becomes a push, picking from the furthest quarter of what is
available. In practice: a spawn never lands on top of a dungeon you placed by
hand, and a hand-placed dungeon never blocks the spawner, because it does not
fill the single slot.

### Instances: one or two per region, lasting days

Instances are **not** owned by local chunks. A 2 km region rolls one or two the
first time you come into it, each lasting **one to three days**; a local chunk
only ever *draws* the ones whose coordinates fall inside it, and never creates
or destroys one. Walking through a cell reveals an instance that was already
there. When a region's instances run out of days it rolls again.

The weights favour **parks and trails** (12 and 10, against 8 for food and 0.5
for anything else), and a trail is a genuine category rather than a building —
`footway|path|steps|cycleway|track` already arrive in the Atlas, so an instance
on one is placed at a point *along the way*.

Because something that lives two days is alive across every window, the hours
— parks 06:00–09:00 and 16:00–19:00, food 11:00–14:00 and 17:00–20:00 — are no
longer a gate. They survive as a **placement preference at the moment a region
rolls**: come into one at lunchtime and a food place is likelier, at eight in
the morning and a park is. That keeps the intent in the only way that still
means anything at this lifetime.

### What it spawns

Clones of what you have already authored. Any hand-placed dungeon is a template
unless it carries `spawnable: false`, weighted by an optional `spawnWeight`, so
placing one good dungeon teaches the spawner what a dungeon looks like here.
With nothing authored at all it falls back to a plain generated one.

A spawned row is an ordinary row in `content_dungeons` or `content_instances`,
marked `origin: "auto"` with an `expiresAt`. Everything downstream — the pin,
the door prompt, the run — treats it like any other, which is the point: no
parallel code path to keep honest. It shows in the map editor tagged **auto**,
and you can edit it like anything else, knowing it will be swept when it
expires. The spawner only ever removes rows it marked, and never one you are
standing inside.

### No timers

Inside a dungeon, walking is the clock, and that stays true. These rules are
wall-clock, so rather than ticking in the background the spawner recomputes
"should something be here now?" whenever the game already happens to look — on
a position fix, and when the tab comes back to the front, rate-limited to about
twice a minute. Nothing runs while nobody is watching, and the answer is the
same either way because it is derived from the time rather than accumulated.

## What you can wear

Twelve slots, in the order a person puts them on:

    main hand   off hand    helm     shoulders
    chest       gloves      belt     legs
    boots       back        neck     ring

**A two-handed weapon takes both hands.** A greatsword, a great axe, a bow or a
staff puts down whatever was in the off hand — out loud, in the toast, because a
shield that vanishes silently is a bug report — and the off-hand slot then reads
*held by both hands* until you swap back.

### Weight is the class rule

Every piece of armour is **light**, **medium** or **heavy**, and a class wears up
to its own limit:

| | wears | wields | off hand |
|---|---|---|---|
| Warrior | up to heavy | blade, axe, blunt, dagger, polearm, bow | shield, dagger, blade |
| Rogue | up to medium | blade, dagger, bow, polearm | dagger, blade, shield |
| Mage | light only | staff, wand, dagger, blunt | focus, wand, dagger |

One rule covers every armour piece that will ever exist, present or authored
later, instead of a list of classes on each item — and weapons are gated by
**family**, so "swords" does not have to mean naming every sword. On top of that
any piece can ask for an **attribute minimum** (plate wants STR 15 and CON 12, a
wand wants INT 13), measured against your attributes *with your gear on*, so a
ring of strength is a legitimate way into the breastplate. Requirements grow one
point per five item levels.

Refusals are sentences, not codes: *"Heavy armour is too heavy for a Mage."*,
*"A Warrior was never taught the staff."*, *"Needs 15 STR."* The same sentence
appears on the greyed-out row in your pack, on the disabled button's tooltip, and
in the toast if you get there another way — one function answers all three, so
they cannot disagree.

An authored item can override any of it: its own weight, its own attribute
minimums, a minimum level, or an explicit list of classes that beats the weight
rules entirely. All of it is in the content editor's item form.

### Why the numbers got smaller

Eight armour slots where there used to be one would have made a fully-kitted
character eight times as armoured as the win-rate table was measured against. So
**every slot carries a share of the old single-piece budget** — chest 0.16, legs
0.09, helm 0.07, down to 0.025 for a belt — and the shares add up to about one.
A full kit is worth roughly what one good piece was; each individual piece is a
small improvement, which is the shape a gear grind should have.

Two more consequences, both deliberate:

- **Attribute bonuses need rare, not uncommon.** Trinkets always carry one (they
  have nothing else to offer), but at the old bar every one of twelve slots would
  have handed out at least a point. Two trinkets are together worth about what
  the single trinket was.
- **Weapon damage came down.** Before class gating, a warrior's weapon was drawn
  from every weapon in the game, wands included, and the table was measured
  against that average. Now each class draws only from what it can wield, so the
  families were scaled until the *allowed* pool averages what the ungated pool
  did. `npm run balance` is what decided the numbers, not a guess.

## What's around you

**Walking near something no longer opens it.** It used to: the first fix inside
a site's radius opened its panel, and the guard against repeating only cleared
once you left again — so standing at the edge, where GPS wanders by a few
metres, reopened the same modal over and over, and a modal covers the map
underneath it.

Proximity now only *discovers*. Opening is a tap, and the **📍 sidebar** is
where you do it: every site, dungeon door and instance door you could walk up
to, nearest first, with what it is and how far. In range, a row is lit; out of
range it is greyed — but still tappable, because its panel telling you how far
away it is beats a dead row that tells you nothing.

The list shows what you can actually name: a site outside your 300 m sight is a
`?` on the map, and listing it by name would hand you exactly what the `?`
exists to withhold. It is open beside the map on a wide screen and a drawer on
a phone, and it remembers which you chose.

## Travelling

A phone in a car walks at fifty miles an hour. Left alone that is about 1,600 XP
an hour for sitting still, a chunk of the world generated every thirty seconds
for ground nobody will ever set foot on, and an Overpass query for each one —
which is precisely the traffic *Asking nicely* above promises not to make.

So the game measures how fast you are going, and above walking pace it stops.

**The measurement.** Every accepted fix produces a speed: the device's own
`coords.speed` when it offers one — that is doppler off the GPS chip and beats
anything derived — and otherwise the distance since the last fix over the time
between them. Sample by sample that is noisy: one fix that jumps sixty metres
sideways while you stand at a window reads as 25 mph. The number used for the
decision is therefore the **median** of the last few samples inside a 25-second
window. One bad fix cannot move a median; three in a row are not noise any more.

**The threshold is two numbers, not one.** You are travelling once the median
holds above **16 km/h** for six seconds, and walking again once it is under
**8 km/h** for twelve. A single figure would flap on and off at every traffic
light. Both are in Settings.

**What "stops" means.** Everything:

- metres stop counting, so no XP, no daily goal, no dungeon floor, no quest
  walk step — and the credit is refused per *sample*, on that fix's own speed,
  so the six seconds before the veil is certain are not six seconds of free XP
- the tile layer comes off the map, because Leaflet has no pause and a layer on
  a moving map fetches
- chunk surveying stops dead: no cells generated, no Overpass queries
- the site list, the spawner, proximity, quest nodes and denizens are all left
  where they were

**What you see** is a veil over the game — dimmed, blurred, **Traveling** in
carved gold — with your speed under it in km/h and mph, and a line saying the
road is passing without you. It sits below modals on purpose, so the menu still
opens over it and the switch that turns it off is reachable while it is up. What
you drove is not drawn as a walked trail, and when you slow down the world comes
back once, where you actually got out, rather than for every cell in between.

A simulated fix from the dev panel is a teleport, and a teleport is not a speed:
dev testing never raises the veil. The panel has a **Drive** button for looking
at it from a desk.

## Dungeons

A location is a point you stand on. A **dungeon** is an area you walk into: a
dungeon, a cave, a wood, a building. It has a footprint drawn on the map and,
behind that footprint, a stack of floors.

**Progress is metres walked, not squares moved.** Once you are inside, the
distance you cover is the only thing that carries you along the floor —
nothing else advances the run. That is deliberate: the footprint you draw only
has to be big enough to walk *up to*, not big enough to hold a dungeon, so one
works over a broom cupboard or a car park equally well, and it keeps working
indoors where GPS goes vague.

Entering rolls a **plan** for the floor: fights and chests spread over the
first four fifths with a little jitter, the boss just before the end, and the
stairs down at exactly the floor's length. Walk past a stop and it fires.
Clearing the stairs pays the floor's reward and re-plans the next one; clearing
the last floor pays a completion bonus and seals it for its cooldown.

**Stepping out holds your place.** Interruptions are normal when the dungeon
is your office, so leaving pauses the run at the metre you left it, and walking
back to the door offers *Pick it up* or *Start over*. Being killed does end the
run — but it leaves the dungeon itself untouched, so you can go back in.

**A run is leashed to its door.** Metres walked are the whole mechanic, which
left a hole: a walk across town counted every one of those metres as progress
along a floor. So a run remembers where it went in, the bar warns as you near
the limit (250 m by default, in the menu), and past it the run is *paused* —
the same thing stepping out does, so nothing is lost and walking back picks it
up. Metres walked while you are outside do not count.

Authoring is the **Dungeons** tab of the map editor. Draw a circle or a
rectangle, drag the door to move it, and resize it either with the sliders in
the form or by dragging the gold square on the map — both shapes are measured
in metres, so a box stays the size it says it is however far north you drag it.
A dungeon is saved the moment you place it, so nothing is lost by switching panes
to look at what you drew. Each floor carries its own length, difficulty, fight and
chest counts, spawn table, chest tier and loot table, an optional boss with its
own spawn table, and optional hand-set XP and gold. A new floor inherits the
one above it and steps the difficulty up by one, because nobody wants to retype
a spawn table six times.

## Instances

A dungeon is a *walk*: metres carry you along a floor. An **instance** is a
*place*. On the real map it is a door — a point with a radius, like a location.
Walk into the circle, go in, and the GPS layer is put away: you are now on an
XY plane that owes nothing to your coordinates.

Two controls, and only two:

- **The dial turns you**, and turning is free.
- **Walking, in the real world, carries you forward** along that heading.

Which way you actually walk is never consulted. The map is drawn rotated so you
are always at the centre facing up the screen, because "forward" has to be a
direction you can see rather than one you work out.

**A level is one open rectangle, plus the walls you draw into it.** Nothing is
generated: the floor is exactly the width and height you typed, and every wall
inside it is one you put there. Collision is therefore "inside the floor,
outside every wall" — a point-in-rectangle test, cheap enough to run on every
step and obvious when something walks where it should not.

Walk at a wall and you slide along it or stop; the metres still count toward
your day's walking, they just don't take you anywhere. That is what makes the
heading matter: you have to point yourself at the gap before you set off.

The wall list is the whole extension point. A brush or line tool only ever has
to push rectangles into it — `Content.wallFromLine()` already squares a drawn
line onto the nearer axis, and `Content.normRect()` fixes up a rectangle dragged
backwards — so nothing else has to change when the drawing tools land.

**Nothing runs on a timer.** Monsters wander to somewhere they can see, and
close on you once they have a clear line to you — but they take their step when
you take yours. Stand still and the whole floor stands still with you. It is
the only honest reading of "you have to walk to move".

Walk into a monster and the fight starts; into a chest and it opens. Something
sits between you and the stairs down if the level says so. What you have seen
is tracked on a 3.5 m grid rather than room by room — with an open floor there
are no rooms to light up — so the dark lifts as far as you can actually see
from where you stand, and the bar reads out the percentage explored.

Authoring is the **Instances** tab of the map editor: place the door, set its
radius and pace, then add levels — the floor's width and height in metres,
roaming monsters, chests, and whether something guards the stairs. The preview
under each level is the floor exactly as it will be, with one roll of where
things stand. Only the contents are rolled; the floor is what you typed.

## Quests

A quest is a **chain of places**, and the places are yours.

### Name your places first

Menu → **Your places**. Eight slots — home, two parks, the grocery, and four
food-or-recreation spots — each assigned a role in the fantasy world: your park
is the Greenwood, the second one the Deep Wood, the supermarket the Market
Square, and so on through the tanner, the meat cutter, the guild hall.

You pick them from **what the map survey already found near you**, by name, with
a dropped pin for anything it missed. No geocoder and no rate limit: the data is
already on the device because you walked past it. A park chosen this way arrives
with its **real outline**, which is what lets a quest land inside it rather than
somewhere near the middle.

They belong to your account, not to one character — your home does not move when
you roll a new one.

### A quest node names a role, not a place

That is the whole trick. A step that said "park1" would be a quest about your
park; a step that says "a forest" is a quest anybody can run against their own
wood. If you have not named your places yet, quests improvise from the survey
rather than stalling.

Each step has a **trigger**:

- **arrive** — be there
- **walk** — be there, then cover a set distance *there*. Metres only count
  while you are at the place; walking home is not progress on pacing the wood.
- **fight** — arrive and win
- **search** — arrive and open what is there
- **talk** — arrive and hear them out

### Where inside the park it lands

Three numbers, and they resolve in a fixed order: a **boundary percentage** (100
is the whole park, 50 the middle half), a **floor** so a small park does not
collapse to a point, and an optional **ceiling**. The floor beats the
percentage, and the park's own size beats the floor — a 15 m pocket park cannot
hold a 25 m quest area, and pretending otherwise puts the objective in the road.
The editor previews all three against a 40 m, a 120 m and a 400 m park as you
drag the slider.

On the map the objective is drawn as a **ring plus a pin**, because "somewhere
in the greenwood" is the honest shape of it.

### Quest givers

Tick **This is a quest giver** on any hand-placed location in the map editor,
then point a quest at it from the content editor. The pin becomes a scroll and
walking up to it offers the quest instead of a fight. Same row, same table, one
checkbox.

### Dialogue: lines, answers, and flags

Each step carries an ordered list of **lines** — a speaker and what they say.
The last line can offer up to four **answers**, and an answer does something:
carry on, accept, walk away, start the fight, finish the step, or **jump to
another step**. An answer can **set a flag**, and any line or step can require
one.

That is deliberately one step short of a dialogue tree. A canvas with edges and
conditions is a large build serving branching nobody writes for a walking game,
where the walking is the content and dialogue is flavour plus a decision. Flags
give you the branch that matters — did you go back, or did you follow the
tracks? — and the sample quest's last step has a different line for each. The
data is a strict subset of a tree, so a canvas could be built over it later
without changing anything.

One authoring rule worth knowing: a flag on the **step** is set whichever answer
you gave, a flag on the **answer** records the choice. Put "saw the beast" on
the answer, "reached the clearing" on the step.

📜 in the top bar is the quest log — what is in hand, which step, where, and how
far through a walk you are.

### What you have finished

XP says how much you have done; the quest tally says *what*. Finishing the last
step of a quest bumps `questsCompleted` on the character, and the detail behind
that number is derived from the runs rather than stored beside them, so the two
cannot drift: **Deeds** on the character sheet gives the count, and the quest log
lists what was finished, how many times each, most recent first. A run snapshots
its quest's name when it finishes, so deleting a quest from the editor leaves the
tally able to name what you did — marked as gone, still counted.

## The living world

A park with a quest node in it is still an empty park. `js/world/denizens.js`
puts things in it: creatures that pace their own patch of ground, and characters
who walk between places — on the real map, at real coordinates, moving while you
are not looking.

### Position is a pure function of the clock

Nothing ticks. Nothing accumulates. Nothing is stored. Ask where a creature is at
time *T* and the answer is computed from its seed and *T*, so it is the same
answer on every device, after every reload, whether or not anybody was watching
in between.

Time is cut into **legs** of forty seconds. Each leg has a waypoint picked by a
seeded random from inside the territory, and a position is the point between this
leg's waypoint and the next one, eased in and out so a thing pauses where it
arrives instead of cornering like a cursor. That follows the project's no-timers
rule and buys three things a simulation loop would not: it moves while the phone
is in a pocket, it cannot drift or double-step, and a test can ask where
everything is at noon tomorrow, instantly.

### It cannot leave

**Every waypoint is inside the boundary, so containment is by construction** —
not a collision test that has to be right on every step.

Two waypoints inside a shape do not make a *path* inside it, though: cut across
the inside corner of an L and both ends are in the shape while the middle of the
walk is out in the street. A circle cannot do that, so drawn polygons get a
**den** — one point per creature, picked once, that every other leg returns to,
and a waypoint is only accepted if the den can see it in a straight line. The
path is then inside the boundary for the same reason the waypoints are. It reads
better too: a thing that keeps coming back to one spot has a home, and pacing out
and back is what an animal with a territory does.

### What holds them

A **territory** is a polygon with a purpose, from one of two places:

- **drawn** — a shape from the shape editor with its purpose set to *territory*.
  Same tool, same polygon, same handles; only what it means differs. The form
  then asks what lives there: creatures from a spawn table and how many, or a
  named character with an icon and optionally a quest to hand out.
- **derived** — a park with nothing drawn in it is quartered automatically, so
  the feature works before anybody authors anything. How many live in each
  quarter follows how much ground there is: one apiece in a forty-metre pocket
  park, three by the time it is a hundred and fifty metres across. Anything drawn
  inside a place wins outright — the quarters only fill a vacuum.

Creatures are bound to their territory. Characters have a reach: **this patch**,
**the whole place** (the park ring, not just the quarter), or **travelling**,
which is what lets the tanner turn up at the market — a trip lasts several legs,
so they stay somewhere long enough to be met rather than teleporting between
parks every forty seconds.

### Meeting them

Nearby denizens are drawn as round pins — round on purpose, because every other
pin on the map is a square-ish badge — and their territories as faint dashed
outlines, on by default: a creature turning at an invisible line looks like a
bug, and the same creature turning at a drawn edge looks like a territory. They
are in the sidebar list with everything else, with the distance read from where
they are *now*, which is a different number every time the list refreshes.

Tapping a creature out of range tells you how close you need to get; in range it
offers a fight, run as a throwaway combat node the way a dungeon stop is. Killing
one takes it off the map for forty-five minutes — shorter than the three hours a
generation lasts, so a patch you cleared is worth walking back to, and a creature
you never killed is gone eventually anyway. The wood is not a fixed cast list.

## Faces

Every creature and character can carry a picture, and it is shown two ways.

**On the map: a token.** A circle with a bevelled ring, the picture cropped
square inside it. The ring colour is **difficulty**, green through amber to red,
so the map answers "can I take that?" before you tap anything — and somebody who
is not a fight at all (a trader, a quest giver) takes the friendly blue instead.
Live combat and boss sites wear one too; caches, landmarks and cleared sites keep
their square badge, because the shape of the pin is the difference between
"something lives here" and "something is here".

**Everywhere else: a portrait.** A framed rectangle showing the *whole* picture
rather than a crop — in a fight, where the enemy carries a `Lv n` badge and you
sit in the same frame beside your own bars; on the character sheet, the chip, the
character picker; and on both panels for someone you meet on the road.

**Nothing breaks without art.** Every face falls back to the emoji the game
always had: no picture, a blank field, a path that 404s. A fresh install looks
exactly as it did before.

### Giving something a face

| what | where |
|---|---|
| a monster | the content editor's monster form — it previews the token and the portrait side by side, because they crop differently |
| your class | the content editor's new **Portraits** tab |
| a character you drew | the shape editor, on a character territory |
| a building's resident | the map editor's Buildings layer |

Uploads are **redrawn at 256 px** before they are stored rather than merely
refused for being big: a phone photo becomes tens of kilobytes, which is the
difference between a portrait set that fits in this browser's storage and one
that fills it. You can also point at a file under `art/` by path, exactly as
location art already works.

## Places, and the people in them

A **building** is somewhere on the real map with somebody working out of it: a
smithy on your corner, a store in the strip mall, an inn where the pub actually
is. (Not to be confused with the shapes you draw in `shapes.html`, further down
— a shape is a drawing, a building is a place.)

### The building does not serve you

There is no "enter shop" button and no panel on the structure. Every building
puts **one person** into the living world, and that person is an ordinary
denizen: their position is a pure function of the clock, they pace the ground
around the building, and you trade with them wherever you catch them. Walk to
the smithy at the wrong moment and the smith is round the back.

Tapping the building tells you who works there and how far off they have
wandered right now. Tapping *them*, once you are close enough, is where the
trade is. A shop you can use from across the street is a menu, and this game is
about walking to things.

### Four things a person can do

**Buy and sell.** Stock is derived, never stored: a building, a six-hour window
and an index give one item, the same on every device and after every reload.
What *is* written down is the short list of what has been carried away, so
something you bought does not reappear on the shelf until the restock. Prices
are marked up and then run through the same charisma curve as everything else.

**Rest.** Food, a fire and a bed give back a share of each pool for a price.
A character who needs nothing is not charged for it.

**Improve gear.** There is no durability in this game, so "repair" would be a
button with nothing to do. What a smith does instead is take a piece one level
further, at the same scaling the generator used — and their own level is the
ceiling, so a village smith cannot make you a legend's sword however much gold
is on the counter. Rarity and requirements are left alone: a hammer does not
make an iron sword legendary, and a piece you could already hold should not
become unliftable for having been sharpened.

**Talk.** The quest offer characters already had.

### One dial

A building's **level, 1–10**, decides all of it: a level 1 store is a cart with
three things on it, a level 10 store stocks item level 20 and is worth walking
across town for; a level 1 bed gives back 47% of each pool and a level 10 bed
all of it; a level 3 smith stops at item level 9.

### Authoring them

The map editor has a fourth layer, **🏪 Buildings** — drop a point, set the kind
and the level, tick what the resident does, and trace the real outline if you
want the shape drawn. Unlike locations, dungeons and instances, buildings are
**not tied to a zone**: a high street is not 500 m wide, so the layer lists
every building you have, nearest first, and you can place one before any zone
exists.

Or draw them in Google Earth. A placemark named `building: Store level 3`
arrives as a level 3 store; name a polygon the same way and its outline becomes
the building's footprint. **`docs/google-earth.md`** is the whole naming scheme
— what a pin, a line and a polygon each become, every word that names a kind or
a terrain, and what to do when something does not arrive.

## The ground decides what lives on it

A generated world is the same everywhere: any monster that fits the difficulty
can turn up on any site. That is fine for one office block and wrong for a
county — a creek bottom should not hold what a hayfield holds.

A **region** is a polygon with a terrain class. Stand inside one and encounters
roll from that terrain's spawn table. Nothing else changes: the same sites are
generated in the same places by the same rules, and only what is waiting on them
differs. Eight classes, because this is a vocabulary the importer, the editor,
the spawn tables and the player all have to share:

| | | rolls from |
|---|---|---|
| 🌊 | River & lake | `sp_water` — Reed Nippers, Drowned Lanterns, a River Troll |
| 🥾 | Marsh & fen | `sp_marsh` — Bog Leeches, Marsh Wisps, the Mire Hag |
| 🌲 | Woodland | `sp_wood` — Thicket Boars, Bark Lurkers, Dire Wolves |
| 🌾 | Meadow & park | `sp_meadow` — Meadow Sprites, Waylayers, a Pasture Wyvernling |
| 🌱 | Open field | `sp_plain` — Rick Kobolds, Scarecrow Husks, Plains Ogres |
| 🪨 | Rock & scarp | `sp_rock` — Scree Skitters, Quarry Golems, Cliffside Harpies |
| ☠️ | Blighted | `sp_waste` — Ash Rats, Rust Wraiths, Blight Ghouls |
| 🏘️ | Built-up | `sp_town` — Gutter Imps, Alley Cutpurses, Rooftop Stalkers |

A region can name a different table, and carry a **difficulty nudge** for ground
that is worse than it looks. Where two overlap, higher **priority** wins; on a
tie the **smaller** one does, so a pond inside a park beats the park without
anybody setting a number. Rings after the first are **holes** — an island in a
lake, a dry knoll in a fen — and nothing spawns in them.

### Its own page, and plain GeoJSON

**`regions.html`** is the editor: draw, drag corners, cut holes, label, set the
terrain and the table, filter the map to one class at a time. **Import terrain
here** turns the real water and green cover in view into regions through the
game's own cache and rate limiting.

The file is a **GeoJSON FeatureCollection** — the format the rest of the world
agrees on — so the same file opens in QGIS or geojson.io, and anything you
produce there opens here. Coordinates are `[lng, lat]` on disk as the spec
requires and `[lat, lng]` in memory as Leaflet requires, and exactly two
functions know that.

### Straight out of Google Earth

Google Earth is the easiest polygon tool most people already have: draw over the
satellite view, **Save Place As**, and drop the `.kml` or `.kmz` into the
editor's Export / Import panel. It is also `npm run map -- --file survey.kml`
if you would rather do it at the command line.

- **Polygons become regions**, with Google Earth's inner boundaries as holes,
  and a **MultiGeometry** split into one region per part.
- **Folders and names classify the ground.** A placemark called *Black Fork
  Creek* is water; anything in a folder called *Low ground* is marsh; *North
  pasture* is meadow. The words are the ones people actually use — bottoms,
  slough, swale, timber, hay, gravel pit — and whatever is left takes the
  terrain you pick in the dialog. Turn it off with one checkbox.
- **A traced path becomes a band of ground**, 20 m wide by default, because a
  line has no inside and "am I in the creek" is the only question a region is
  ever asked. Set the width, or skip paths entirely.
- **Pins are counted and skipped** — a point is not an area — and the import
  says how many it left behind.
- **Re-importing an edited export updates the same regions** rather than laying
  a second copy on top: KML carries no ids, so they are matched on where they
  came from (the placemark's name and its position in the file).

A `.kmz` is just a zip with a `.kml` inside it. The browser unzips it with
`DecompressionStream` and node with `zlib`, so nothing here carries a zip
library for one file.

### A whole town at once

```
cd tools
npm run map -- --place "Tyler, Texas"
npm run map -- --bbox 32.25,-95.45,32.45,-95.15 --out ../data/regions.tyler.geojson
```

`tools/mapimport.js` asks Overpass for every piece of water and green cover in
the box, classifies it, and writes the GeoJSON. It is a script rather than a
button because it is a one-off job over a whole county — tens of megabytes and a
couple of minutes of somebody else's server — and the phone must never make a
request that size. It keeps the same manners as the app: one request at a time,
two seconds apart, a real User-Agent, `Retry-After` honoured, and never a
failover to a second endpoint after a 429.

Things it does that are worth knowing:

- **rivers drawn as lines become ground you can stand in**, buffered to a width
  by type (24 m for a river, 8 m for a stream) — a line has no inside, and
  "am I in the river" is the question the game actually asks
- **lakes with islands keep their islands**, by assembling multipolygon
  relations into outer rings and holes
- **Douglas-Peucker in metres, not degrees**, or a north-south edge simplifies
  nearly twice as hard as an east-west one and lakes come out with flat sides
- buildings, roads and anything under 2,000 m² are dropped
- `--file saved.json` runs the whole pipeline on a saved response, so it can be
  re-run — and tested — without touching the network at all

Soil class and flood zones are not in OpenStreetMap, which is the point of the
editor: import what the map knows, then draw in what it does not.

## Drawing your own buildings

The fantasy town is real OSM geometry renamed and restyled — the right shape,
but nobody's design. **`shapes.html`** is the other half: draw over the real
map, and the game paints what you drew on top of the generated town.

A shape is polygons and lines with a colour, a line width, a fill and a
transparency. Click to drop points, double-click or Enter to finish. Select one
and its vertices become handles you can drag; the ✥ in the middle moves the
whole thing; ±10% resizes it and ±15° turns it, both about its own centre;
right-click a vertex to drop it. Everything is stored as real coordinates, so a
building sits on the ground you drew it on at every zoom rather than drifting
when you pan.

**Import footprints** is the thing that makes it bearable. Tracing a building
by eye is miserable and the outlines are already surveyed, so it brings in every
real building in view as an editable polygon — already the right shape, in the
right place, wearing the fantasy name the atlas gave it. Restyle rather than
trace. It reads the same cached map data the game uses, so it usually costs
nothing, and it never imports the same footprint twice.

**Its own file, on purpose.** Shapes live in their own table and export as one
document (`stride-and-sword.shapes`) you can download, upload to a server of
your own, or drop into `data/shapes.json` so every fresh install starts with it.
Import merges by id, so re-importing your own export updates in place instead of
duplicating. Nothing else in the game writes to that table.

In the game they draw above the generated town — so a keep you drew sits over
the footprint you traced it from — nearest ones only, ordered by their draw
order, never intercepting a tap meant for the map, and hidden entirely when the
fantasy overlay is off. A shape marked not visible stays in the file but off the
map.

## Two zoom levels, because the map does two jobs

The map is answering two different questions depending on what you're doing, so
there are two buttons for it — top right on the game map, and the same pair on
the map editor:

- **🚗 Street** (zoom 16) — the whole zone at once: the roads, and every site
  in it. This is the view for deciding where to walk next, or for glancing at
  the map from a car.
- **🚶 Walk** (zoom 19.5) — individual buildings, close enough that they carry
  their invented names. This is the view for working out which door you're
  standing beside.

Pinching to anything in between is fine: neither button lights up, and nothing
snaps you back. Whatever zoom you leave it at is remembered and is what a
recentre returns to. Both numbers are sliders in **Menu → The map**, and the
map editor reads them from the same setting, so retuning them moves both.

**The ceiling is now zoom 24, up from 22.** OpenStreetMap has no tiles past 19,
so beyond that the last real tile is upscaled rather than requested — which
would go blank. That would be a poor trade on its own, but the fantasy town is
drawn as vectors from the Overpass geometry, so it stays sharp all the way in.
Past zoom 19 the photographic layer therefore fades to a little over half its
usual strength and lets the drawing carry the picture. If the street survey
failed there is no drawing to carry it, and the plain map stays at full
strength instead.

## Both editors on a phone

The editors were desktop tools; they are now usable from the phone you are
already walking around with, without giving up anything on a big screen.

**One pane at a time.** Below 860 px the content editor stops being a
list-beside-form and becomes two panes switched by `body[data-pane]` — the list,
or the record you tapped, with a back arrow in the form header. The map editor
does the same with three: **Map**, **List** and **Details**, switched from a bar
along the bottom. Placing moves from a toolbar button to a floating **+ Place**
button over the map, which turns red while armed.

**Tables become cards.** Below 700 px every `table.grid` drops its header row and
each cell renders its own label from a `data-l` attribute, so a monster or a
location reads as a labelled card instead of a strip you have to scroll
sideways. Nothing in the app scrolls the page sideways at 390 px.

**Placing must always disarm.** The one bug that made the editor feel broken on
a phone: `placeAt` returned early when there was no zone yet, but left the place
button armed. The next tap on it turned placing *off*, so the map tap did
nothing, and the editor looked like it simply refused to place anything. It now
disarms first and returns second, whatever the reason, and a phone with no zone
is sent straight to the **New zone here** button in the details pane — the
toolbar's own copy of that button is desktop-only, so it was telling people to
press something they could not see.

**The map keeps its corner.** The map editor used to put four things on top of
the map: Leaflet's +/− control, the two zoom presets stacked vertically, the
hint bar and the place button. That is fine on a desktop and absurd on a phone
held sideways, where the map is about 180 px tall and the controls alone were
160 px of it. On a narrow screen they collapse into one 🗺️ button in the corner
whose dropdown carries **Street**, **Walking** (ticked to show which you are in),
**Zoom in**, **Zoom out** and **Back to *your zone***. Choosing a view closes the
menu; the zoom steps leave it open, because nobody zooms in exactly once. It
closes on a tap anywhere else, including the map, and is capped in height so it
never runs under the pane switcher. Pinching still zooms as it always did, the
floating **+ Place** button stays where it is, and the desktop keeps its presets
out in the open — a control you can see and hit in one movement beats one behind
a menu whenever there is room for it.

A phone on its side also drops the toolbar's forced line break, so the zone
picker, the search field and the ⋯ menu share one row: about 60 px of header
instead of 125, which is a third of the screen handed back to the map.

**Touch sizing is a separate axis from width.** Everything under
`@media (pointer:coarse)` — buttons, the back arrow, sliders, checkbox labels —
is at least 44 px, and every text input is 16 px so iOS doesn't zoom the page
when you focus one. A desktop browser at a narrow window gets the layout but not
the enlarged controls.

Desktop gains from the same pass: the panes widen at 1600 px and narrow at
1150 px rather than staying fixed, and the toolbar links that don't fit a phone
collapse into a ⋯ sheet instead of wrapping.

## Working on it

    cd tools
    npm install                  # playwright + leaflet, for the tests only
    npm run serve                # http://localhost:8000
    npm test                     # 526 assertions, ~48 minutes

Edit a file and reload. There is no build step and nothing to regenerate — the
files you edit are the files that get served, which is the point of the
layout. Adding a new `js/` file means adding a `<script src>` to whichever
pages need it, in dependency order.

The suites start their own static server on port 8123, so `npm run serve` is
for you, not for them.

### Tests

| Command | What it covers |
|---|---|
| `npm run test:game` | 104 assertions × 3 configurations: with the map, with Overpass unreachable, and with Leaflet itself blocked. Registration through combat, loot, levelling, the Atlas, persistence, the zoom presets and the tile fade. |
| `npm run test:editor` | 27 assertions: CRUD round-trips, rarity scaling staying derived, loot percentages measured over 4000 rolls, drop-count clamping, referential cleanup on delete, and authored monsters actually fighting and dropping in the game. |
| `npm run test:equipment` | 22 assertions: twelve slots with eight of them armour, every seeded item landing in a real one, the generator filling any slot you name, and a ring that does not push the amulet off; the two hands — a bow putting the shield back in the pack and saying so, the off hand refusing to fill while it is held; the gate — a warrior in plate and refused a staff, a mage in light only, an attribute minimum that lifts when a ring of strength takes you over it, an explicit class list beating the weight rules, and a greyed pack row whose dead button carries the reason; the budget — a full kit worth about what one unshared piece was, shares that sum to about one, attribute bonuses that did not multiply by twelve, and gear from before the paper doll still finding a slot; and the editor writing weight, attributes and classes through to what the game gates on. |
| `npm run test:map` | 33 assertions: placing, dragging, resizing and deleting locations, zone management, weighted spawn distribution over 6000 draws, opening hours including a window that wraps midnight, day gating, respawn timing, a location driving a real encounter and chest, the zoom presets following the game's settings, and the generated chunk zones staying out of the zone picker. |
| `npm run test:responsive` | 34 assertions: both editors driven on an emulated iPhone (390×844, touch) and at 1440×900. Pane switching, the ⋯ sheet, card-view tables, placing a location by tapping the map, no sideways overflow, and no touch target under 40 px — including the dungeon layer switch, placing both a location and a dungeon by tap, and a refused placement leaving the button usable. Then the map editor's phone controls: the preset stack and Leaflet's own zoom gone from the map surface, one thumb-sized button in their place, a dropdown that fits the screen and stops above the pane switcher, a preset that changes the zoom and closes it, zoom steps that leave it open, a tap on the map that dismisses it — and, at 1440 px, the presets still out in the open with no dropdown in sight. |
| `npm run test:dungeons` | 26 assertions: drawing and resizing a footprint, floors inheriting and reordering, rectangle geometry in metres, then a whole run walked in the game — entering, a real clicked fight, a chest, stepping out and picking it back up, the stairs down, and the cooldown at the bottom. Then the leash: anchored on the door, the warning band, the pause past the limit with nothing lost, metres not counting once you have left, and picking the run back up. |
| `npm run test:instances` | 24 assertions: authoring a door and its levels, drawn lines squaring onto an axis, then inside — the floor being exactly the rectangle asked for with the drawn walls solid, everything on it reachable from the door by flood fill, the dial turning without moving you, pace, walls that stop you without refunding the walk, monsters that step only when you do and close when they see you, contact fights, chests, the boss holding the stairs, the level change, and the cooldown. |
| `npm run test:spawning` | 26 assertions: parks and shops arriving in the Atlas as a third feature class, a park as a polygon and a cafe as a point, point-in-polygon, the category distribution over 6000 rolls, the contrast dial at 0 / 0.55 / 1, many buildings failing to outvote few parks, time windows including one that wraps midnight, out-of-hours staying pickable, the three-hour dungeon expiry and fifteen-minute gap, clearing, a dungeon you are standing in surviving its own expiry, hand-placed rows untouched, and on the region side: one or two rolled and then left alone for hours, lifetimes measured in days, a region rolling again once its days are up, the favoured categories winning without shutting the dull ones out, and nothing opening at your feet. The clock is injected, so none of it waits. |
| `npm run test:chunks` | 28 assertions: the grid measured at four latitudes, keys round-tripping, only the cells in reach loaded; a chunk generating all at once and its neighbours with it, walking into a new one without disturbing the old, and coming back on the cache; sight — what is drawn as a `?`, what resolves as you approach, and what a `?` does when prodded; the three budgets — the hour, the cap oldest-first, the byte budget, and a swept chunk regenerating when you walk back; a dungeon per chunk with one zone row apiece; a chunk drawing a region's instance without creating or destroying it; and a chunk generating anyway with Overpass down, then snapping when the geometry arrives. Then the usage policy: no two requests in flight at once from four concurrent callers, none closer than the minimum gap, a 429 costing exactly one request to one host, nothing reaching the network during a cool-off, the cool-off surviving a reload, a dead service backing off per cell, the cache pruned to what we read without changing what digests out of it, and standing still asking for nothing. |
| `npm run test:shapes` | 25 assertions: drawing a building and a line by clicking the map, the minimum point counts, dragging one vertex without disturbing the others, moving rigidly, resizing and rotating about the centroid, paint written through to the row and the style, removing vertices down to the floor; importing real footprints — named from the atlas, nothing under 6 m, nothing twice; the export document, re-importing your own export as a no-op, a foreign file merging alongside, hiding and deleting; and in the game: the file loading, near ones drawn and distant ones not, hidden ones skipped, none of them clickable, and all of them gone with the fantasy overlay off. Plus a phone check, because a map with no height looks exactly like a page that ignores clicks. |
| `npm run test:quests` | 25 assertions: the picker offering surveyed places with their real outlines and a pin where it missed one, places keyed to the account, a role resolving to your place and falling back rather than failing; the boundary — the percentage shrinking about the middle, the floor stopping a small park collapsing, the park beating the floor, and forty points landing inside a real polygon; a whole run — a giver offering instead of fighting, the first step landing in your park, walk metres counting there and nowhere else, steps chaining, an answer branching and its flag being remembered, a line appearing only for the flag you have, the payout at the end; and the editor — the list, the form, the slider and box as one number, dialogue writing through, and four ways a broken quest is refused. |
| `npm run test:denizens` | 23 assertions: a park quartered and the population following its size, a drawn territory taking over from the quarters; containment — eight creatures sampled four hundred times each across eight hours of clock with none outside, and four in a deliberately concave L where a bounding box would be no alibi; the clock — three looks at one instant agreeing, the same positions after a reload, real movement at walking pace and not vehicle pace, a leg boundary landing exactly on its waypoint, and a cast that is steady within a generation and rolled at the join; a character wandering its whole park but never leaving it and a traveller turning up at your other place; a kill that holds for forty-five minutes and then comes back, and a kill list that prunes itself; pins, list rows and the fight offered only in range; and the quest tally — the count saved on the character, a repeat counting again without counting twice, a deleted quest still nameable, and the sheet and log agreeing. |
| `npm run test:travel` | 15 assertions: a speed out of two fixes and a clock, the device's own doppler reading preferred over differencing, a single jumped fix that must not read as a car, and a dev-panel teleport that is never a speed at all; then the threshold — sustained pace rather than one fast sample, the veil and what it says, zero Overpass queries and no tile layer across 2.6 km of driving, nothing credited for it, and a 12 km/h crawl that does not end the drive; then getting out — tiles back, one survey for where you actually are, the drive not drawn as a walked trail, metres counting again, the menu switch turning the whole thing off, the dev panel's fake drive, and a reload that starts at a standstill. The clock is written into the fixes, so none of it waits. |
| `npm run test:regions` | 39 assertions: the seeded content carrying nothing office-themed and every terrain's table resolving to real monsters; the geometry — a hole that is not inside, a hidden region that decides nothing, and the pond-beats-park tie-break; the game — forty rolls in a marsh that are all marsh, the same site off-region that is not, a per-region table override with a difficulty nudge, and a region naming a table nobody wrote falling through instead of producing an empty fight; the editor — drawing, cutting a hole by clicking inside, GeoJSON out in [lng,lat] with closed rings, a re-import that changes nothing, a foreign file whose lines and points are refused, a MultiPolygon split into one region per part, and importing the terrain here twice without doubling it; and the importer run against a canned Overpass response — buildings dropped, flowerbeds dropped, a river line buffered into standable ground, a lake keeping its island, one classifier shared with the browser, and simplification that keeps corners. Then a Google Earth export driven through the editor's own file picker: a .kml and a .kmz both becoming regions, coordinates landing in east Texas rather than the Indian Ocean, folders and names classifying the ground, an inner boundary staying a hole, a MultiGeometry split, a traced path given width, a pin dropped, a re-import that updates instead of doubling, the terrain picker and width obeyed, a shopping list refused with a sentence that says what the page accepts, and the CLI agreeing with the browser. |
| `npm run test:buildings` | 38 assertions: the naming grammar out of Google Earth — `building: Store level 3` landing as a level 3 store, a kind leading instead of the word building, a trailing "…, tavern" dropped from the name, levels clamped, a creek and a "Note:" left as ground, and a smithy filed under a folder called Shops staying a smithy; the file — a pin becoming a building and a nameless one still skipped, a traced shopfront keeping its outline without also becoming a region, one real .kml dropped through the page's own file picker filling both tables, and a second drop updating rather than doubling; the person — one resident per building, named the same on every look, 300 clock samples with none outside their yard and movement on 299 of them, a card that says where they are now, trade buttons only in range and none at all on a stranger, and a shuttered building putting nobody on the street; the shelf — identical on two looks, different a window later, identical after a reload, gold taken and the row cleared on a purchase that survives a reload, an empty purse refused in words, an apothecary selling nothing but draughts; rest, and the smith's ceiling with the refusal naming it; and the editor — a fourth layer, a building placed with no zone at all, the form writing kind, level and trades through, and a traced outline moving the pin onto its middle. |
| `npm run test:faces` | 19 assertions: the two components — a picture shown when there is one and the emoji when there is not, a 404 falling back rather than leaving a hole, a ring that interpolates and clamps and turns friendly-blue at zero, a 900 px upload redrawn to 256, and a text file refused in words; on the map — every creature wearing its own picture, the ring matching its own difficulty, a trader getting the friendly one, and a token in a map pin measured against its own size, because Leaflet resets `width:auto` on images in its marker pane and a portrait at natural size covers the whole map; in a fight — the enemy framed with a level badge and the right ring, your own class portrait beside the bars, a dead one greyed, and the class portrait still on the picker, the chip and the sheet after a reload; and authoring — three class cards, an upload stored shrunk and cleared again, a monster's form previewing both crops and saving through to the enemy you fight, and a hand-drawn character given a face in the shape editor. |
| `npm run test:permissions` | 18 assertions across four origins: no permission on `file://`, declining the gate, `http://localhost`, a LAN address, already granted. |
| `npm run balance` | Simulates 400 fights per class/level/difficulty cell and prints win rates. Run it after touching any combat number. |
| `npm run shots` | Screenshots into `tools/screenshots/` using the real Leaflet from `node_modules`. |
| `npm run verify` | A look at what the current build renders: the map with location art on it, an instance floor on arrival and after walking, and both editor forms. Prints the seeded table counts and any page errors. |

The tests never hit the network: the pages come off a local static server
(`tools/serve.js`), Overpass is served from `mock-osm.js`, and Leaflet is either
stubbed or loaded from `node_modules`.

Suites that author their own world declare the world tables empty before the
page loads (`tools/fixtures.js`), so the sample locations, dungeons and
instances never seed in underneath them and skew a count. Monsters, loot and
items still seed normally — a suite that builds a spawn table needs monsters to
put in it.

---

## Where the backend goes

Every persistence call already routes through `API.request()` in
`js/core/api.js`.
Set `BASE_URL` at the top of that module and `API.isOnline` flips: the same call
sites hit real endpoints, with `localStorage` as the offline fallback. The
`Local` module is the throwaway. The full endpoint list is in the comment block
above `const API`.

A server must own password hashing, XP and level arithmetic, combat resolution,
and node clear state — all of it is client-trusted today. `data/players.json`
is the stand-in for the accounts half of that: plain-text test logins, seeded on
first run, hashed on the way in by the same weak function the register endpoint
uses. Both go when the backend lands.
