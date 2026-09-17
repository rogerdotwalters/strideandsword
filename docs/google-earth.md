# Drawing your world in Google Earth

Google Earth is the best polygon tool most people already have: satellite
imagery, a pen, and a file you can save. This is how Stride & Sword reads what
you draw there — what each shape becomes, and exactly how to name it.

**Keep this file up to date.** If you change how a name is parsed, change this
first. It is the only place a person can look the rules up, and a naming scheme
you have to read the source to use is not a naming scheme.

---

## The whole thing in one minute

1. In Google Earth, draw your shapes and drop your pins.
2. Name each one. The name is the only thing you control, so it carries
   everything: `building: Store level 3`, or `Black Fork Creek`.
3. Right-click the folder → **Save Place As** → `.kml` or `.kmz`.
4. Open `regions.html`, press **Export / Import**, and drop the file in.

Both halves of the file land in the right place: ground becomes regions,
buildings become buildings. Import the same file again after editing it and the
same rows are updated rather than doubled.

---

## What each shape becomes

| You drew | It becomes | Notes |
|---|---|---|
| **Polygon** | a **region** — a piece of ground with a terrain class | Inner rings become holes: an island in a lake, a copse in a field |
| **Polygon** named as a building | a **building**, outline and all | The outline is kept as its footprint |
| **Path** (line) | a **band of ground** | A line has no inside, so it is given a width — 20 m by default, set on the import panel |
| **Pin** named as a building | a **building** at that point | |
| **Pin** named anything else | nothing | Counted and reported, so you can see it was skipped |
| **Folder** | context | The folder name is read as a hint, and kept in the row's notes |

Styles, icons, camera positions, tours and timestamps are all ignored. None of
them say anything about the ground.

---

## Naming a building

The grammar, in full:

```
building: Store level 3
building: The Gilded Flask, tavern, level 2
smithy: Ash & Ember level 5 radius 40m
tavern: The Crooked Nail
```

**The prefix.** `building:` — or `bldg:`, `place:`, `shop:` — says "this is a
building, not a piece of ground". You can also lead with the kind itself:
`smithy:`, `tavern:`, `temple:`. Either way, everything before the colon is a
declaration and never part of the name.

**`level N`** sets the building's level, 1–10. Anything higher is clamped to
10, anything lower to 1. Leave it out and you get level 1. `lvl` and `lv` work
too.

**`radius Nm`** sets how far the resident strays from the door, in metres
(5–400). Leave it out and you get 45 m.

**The kind** is whatever word in the name names one — see the table below. The
name is read first and the folder only as a fallback, so a `smithy:` filed
inside a folder called *Shops* is still a smithy.

**The name** is what is left. A trailing comma-separated piece that is *only* a
kind word is dropped, so `The Gilded Flask, tavern` is called **The Gilded
Flask**. If nothing is left, the building is named after its kind.

### A pin that forgot to say `building:`

If a pin's name contains a kind word — `Ash & Ember Forge`, `The Corner Store`
— it is taken as a building anyway. A pin is not an area, so there is nothing
else useful it could be. That is a guess, though, and the prefix is not: use
`building:` when you want to be certain.

A **polygon** with no prefix is always ground, whatever words are in its name.
A shopfront you traced without saying `building:` becomes a very small region.

### The kinds

Every word listed here identifies its kind:

| Kind | What its resident does by default | Words that name it |
|---|---|---|
| store | buy and sell | store, shop, general store, trader, emporium, market, mercantile, outfitter, supply |
| market stall | buy and sell | market stall, stall, bazaar, market square |
| tavern | rest, talk | tavern, inn, alehouse, pub, bar, lodge, hostel, public house, brewery |
| smithy | improve gear, buy and sell | smithy, smith, blacksmith, forge, armoury, armory, weaponsmith, hardware |
| foundry | improve gear | foundry, smelter, ironworks, works |
| apothecary | buy and sell, rest | apothecary, herbalist, alchemist, chemist, pharmacy, drug store, infirmary |
| temple | rest, talk | temple, church, chapel, shrine, abbey, cathedral, mosque, synagogue, meeting house |
| guild hall | talk | guild, guild hall, hall, town hall, court, office, chapter house |
| library | talk | library, archive, scriptorium, school, college, university, museum |
| counting house | buy and sell | counting house, bank, exchange, treasury, mint, credit union |
| stable | buy and sell, rest | stable, stables, mews, livery, garage, depot |
| granary | buy and sell | granary, mill, silo, barn, grain, bakery, grocer, grocery, supermarket |
| barracks | improve gear, talk | barracks, garrison, watch house, guardhouse, station, fire station, police |
| bathhouse | rest | bathhouse, baths, spa, pool, gym, leisure centre |
| keep | talk | keep, castle, fort, fortress, citadel, manor |
| tower | talk, buy and sell | tower, spire, observatory, mast, lighthouse |
| cottage | talk | cottage, house, home, hut, farmhouse, residence, apartments, flat |

The everyday words are there on purpose: name a pin `supermarket` or `fire
station` while walking your own town and it lands somewhere sensible. What each
kind actually does can be changed afterwards in the map editor — the words only
pick the starting point.

**A building is a place; the person who works there is what you trade with.**
They walk around the building and you have to catch them. `claude/buildings.md`
covers why.

---

## Naming ground

Ground classifies itself from its name, its folder, and its description —
whichever mentions a terrain word last wins, so `creekside meadow` is a meadow
and `dry creek bed` is water. Unlike buildings, **the folder is read as the
better statement**: a survey organised as folders called *Low ground*,
*Pastures*, *Creeks* classifies itself without a single placemark being renamed.

| Terrain | Words that name it |
|---|---|
| marsh | marsh, swamp, bog, fen, wetland, slough, bottoms, floodplain, flood zone, boggy, wet ground, seep, muck, low ground, lowland, wet, swale, draw, sump, standing water, holds water |
| water | river, creek, stream, lake, pond, bayou, branch, reservoir, water, canal, ditch, run, spring, shore |
| wood | wood, woods, forest, timber, thicket, copse, grove, brush, scrub, tree line, pines |
| meadow | meadow, park, lawn, green, pasture, paddock, common, grass, garden, playing field, golf, cemetery |
| plain | field, farm, crop, hay, prairie, plain, acreage, pivot, furrow, stubble |
| rock | quarry, rock, cliff, bluff, scarp, gravel, pit, outcrop, ridge, sand |
| waste | landfill, dump, tip, spoil, blight, industrial, siding, yard, waste, slag, brownfield |
| town | town, street, neighbourhood, subdivision, downtown, block, estate, village |

Anything the words do not identify falls back to whatever the import panel's
**KML terrain** picker is set to. What a terrain then spawns is in
`claude/regions.md`.

---

## A worked example

One folder tree in Google Earth:

```
Tyler survey.kml
├── Low ground
│   ├── Behind the school              → marsh (the folder said so)
│   └── Black Fork Creek       (path)  → a 20 m band of water
├── Shops
│   ├── building: Store level 3 (pin)  → a level 3 store called "Store"
│   ├── smithy: Ash & Ember level 5    → a level 5 smithy, outline kept
│   └── building: The Gilded Flask, tavern, level 2  → a level 2 tavern
└── Where I parked             (pin)   → skipped, and reported
```

One drop on `regions.html` gives you two regions and three buildings, and the
toast says so.

---

## Doing it from the command line instead

`tools/mapimport.js` reads the same files without a browser, and also pulls
real water and green cover straight from OpenStreetMap:

```sh
cd tools
npm run map -- --file ~/Desktop/Tyler\ survey.kml --out ../data/regions.geojson
npm run map -- --place "Tyler, Texas" --out ../data/regions.geojson
```

Buildings found in a KML are written to a second file beside the first —
`regions.buildings.geojson` — because the game seeds them from their own file
(`data/buildings.json`). Regions go to `data/regions.json`.

`--dry-run` prints what it would write and touches nothing. The OSM half obeys
the one-request-at-a-time rule in `claude/osm-policy.md`.

---

## When something does not arrive

**"That is not a map file."** The file is not GeoJSON, KML or KMZ. Google Earth
Pro writes `.kml`; Google Earth on the web gives you a `.kmz`. Both work.

**A pin was skipped.** Its name did not say `building:` and contained no kind
word. The toast counts them.

**A shopfront became a tiny region.** The polygon had no `building:` prefix.
Rename it and drop the file in again — it updates in place.

**Everything came in as woodland.** Nothing in the names or folders matched a
terrain word, so the fallback picker was used. Name the folders.

**The KMZ would not open.** A KMZ is a zip; very old browsers cannot unzip one.
Unzip it yourself and drop in the `.kml` inside.

**It all imported, and the game shows nothing.** Regions and buildings are
world-scoped, but the game only draws what is near you. Check the coordinates
are where you think they are — `regions.html` draws both, and buildings appear
in the map editor's Buildings layer with their distance from the current zone.
