# Stride & Sword

A location-based roguelike for walking around the office. Your phone's GPS moves
your character; the real streets and buildings around you are redrawn as a
fantasy town, and the interesting sites are a deliberate walk away.

Three pages: the game, a content editor for its monsters, loot tables and
items, and a map editor for placing the locations, dungeons and instances it
spawns from. Plain files — no framework, no bundler, no build step at all. The
JavaScript is a tree of small files loaded with `<script src>`, and the game's
starting data is a folder of JSON you can open and edit.

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
  crowd. Both send CORS headers, so no proxy is needed.

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
    css/
      game.css        the game's styles
      editor.css      content editor
      mapeditor.css   map editor
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
        zones.js      zones and procedural node scatter
        location.js   geolocation, distance accumulation, proximity
        art.js        the PNGs that sit on the map
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
        panels.js     character sheet, inventory, menu, settings
      dev/devpanel.js the dev-test panel
      boot.js         loads the database, then shows a screen
      editor/app.js    the content editor
      mapeditor/
        app.js        map, table, and the location form
        dungeons.js   the dungeon layer: footprints, resizing, floors
        instances.js  the instance layer: doors and their levels
    data/             the seeded database — see below
    art/              PNGs that locations can put on the map
    tools/            tests and tooling (not deployed)

There are no modules and no bundler. Every file is a classic `<script src>`, so
**load order is the dependency graph** — a top-level `const` in one file is
visible to every file loaded after it. The order is written out in each HTML
page, and it goes core → player → combat maths → world → UI → boot. If you add
a file, add it to the page in the right place.

Both editors reuse the same `core/` and `world/content.js` verbatim, which is
what keeps them honestly in step with the game rather than reimplementing it.

## The seeded database

`data/` holds everything the game starts with, as plain JSON you can open in
any editor:

    data/config.json      the rarity multipliers
    data/items.json       33 items
    data/monsters.json    14 monsters
    data/loot.json        4 loot tables
    data/spawns.json      4 spawn tables
    data/locations.json   3 sample locations, one with a PNG
    data/dungeons.json    2 sample dungeons
    data/instances.json   2 sample instances
    data/players.json     test logins — `tester` / `walk1234`
    data/spawn-rules.json the spawn weights — see below

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
list: every location, dungeon and instance in the zone, nearest first, with
**Walk to it** (a simulated walk at walking pace, so the proximity checks fire
exactly as they would on foot), **Teleport to it**, and **Go straight in**,
which skips the doorstep prompt. **Reload authored** forces a re-read and says
what changed.

One thing to know: a zone created in the map editor belongs to the *world*, not
to a player, so every character sees it. Without that, content authored in the
editor was invisible in the game — which is exactly the bug it fixes.

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
0.15, not 0: a grocery store at 3am is possible, just uncommon.

### Categories

Places come from OpenStreetMap and fall into five coarse buckets — `park`,
`food`, `civic`, `transit`, `other`. Five you can hold in your head beat twenty
you have to look up, and the weights file addresses them by name.

At the default weights a dungeon lands on a park about a third of the time, a
food place a quarter, and an ordinary building about one time in ten.

### Dungeons: one at a time

One live in the zone, always. It lasts about three hours — longer at a park,
shorter at a car park, because the lifetime is weighted too — or until you
clear it, and then the next appears somewhere else about fifteen minutes later.
That fifteen minutes is deliberately a gap, not an overlap: it is what gives a
cleared dungeon a sense of ending.

The separation rule asks for 2000 ft between dungeons. A zone is only 640 m
across, so that is usually unsatisfiable — the rule then stops being a hard
floor and becomes a push, picking from the furthest quarter of what is
available. In practice: a spawn never lands on top of a dungeon you placed by
hand, and a hand-placed dungeon never blocks the spawner, because it does not
fill the single slot.

### Instances: once or twice a day

One or two per zone per day, rolled once and stored, so a reload does not
reroll what you are getting. They arrive inside the hours their category
keeps — parks 06:00–09:00 and 16:00–19:00, food 11:00–14:00 and 17:00–20:00.

**Windows decide *when*; weights decide *where*.** A category with no hours —
`civic`, say — can win the spot once something has opened the door, but it
cannot open the door itself. Without that distinction the day's allowance would
be spent at three in the morning on whatever happened to have no opening times.

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
    npm test                     # 281 assertions, ~17 minutes

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
| `npm run test:map` | 32 assertions: placing, dragging, resizing and deleting locations, zone management, weighted spawn distribution over 6000 draws, opening hours including a window that wraps midnight, day gating, respawn timing, a location driving a real encounter and chest, and the zoom presets following the game's settings. |
| `npm run test:responsive` | 31 assertions: both editors driven on an emulated iPhone (390×844, touch) and at 1440×900. Pane switching, the ⋯ sheet, card-view tables, placing a location by tapping the map, no sideways overflow, and no touch target under 40 px — including the zoom presets, which must not end up buried under another control, the dungeon layer switch, placing both a location and a dungeon by tap, and a refused placement leaving the button usable. |
| `npm run test:dungeons` | 21 assertions: drawing and resizing a footprint, floors inheriting and reordering, rectangle geometry in metres, then a whole run walked in the game — entering, a real clicked fight, a chest, stepping out and picking it back up, the stairs down, and the cooldown at the bottom. |
| `npm run test:instances` | 24 assertions: authoring a door and its levels, drawn lines squaring onto an axis, then inside — the floor being exactly the rectangle asked for with the drawn walls solid, everything on it reachable from the door by flood fill, the dial turning without moving you, pace, walls that stop you without refunding the walk, monsters that step only when you do and close when they see you, contact fights, chests, the boss holding the stairs, the level change, and the cooldown. |
| `npm run test:spawning` | 24 assertions: parks and shops arriving in the Atlas as a third feature class, a park as a polygon and a cafe as a point, point-in-polygon, the category distribution over 6000 rolls, the contrast dial at 0 / 0.55 / 1, many buildings failing to outvote few parks, time windows including one that wraps midnight, out-of-hours staying pickable, the three-hour expiry and fifteen-minute gap, clearing, a dungeon you are standing in surviving its own expiry, hand-placed rows untouched, and the once-or-twice-a-day roll holding across a reload. The clock is injected, so none of it waits. |
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
