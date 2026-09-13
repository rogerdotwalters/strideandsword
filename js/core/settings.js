/* -------------------------------------------------------------------------
   9. Settings
   ------------------------------------------------------------------------- */
const DEFAULT_SETTINGS = {
  locationMode: "gps",       // "gps" = your real position | "sim" = dev testing
  gpsUpdateInterval: 6000,   // ms between accepted position updates
  interactRange: 35,         // metres to trigger a node
  zoneRadius: 320,           // metres — a hand-made zone's reach
  nodeCount: 11,             // sites in a hand-made zone

  /* The chunked world. A chunk is 500 m of ground; you generate the ones near
     you and see the things inside your sight radius. */
  sightRadiusM: 300,         // beyond this a site is a "?" on the map
  /* Which chunks get surveyed. From a cell's centre its own edges are 251 m
     away, so 350 m reaches the four neighbours you can see into without
     pulling in the diagonals as well — five Overpass queries on a cold start
     rather than nine. Standing near a corner it picks up the cells that
     actually meet there, because the test is distance-to-edge. */
  chunkLoadRadiusM: 350,
  locationsPerChunk: 8,      // ~the old density, for a 500 m cell
  chunkNodeTtlMinutes: 60,   // how long a generated site lives
  maxProceduralNodes: 300,   // hard cap, oldest evicted first
  chunkCacheBudgetBytes: 1800000,  // total raw geometry kept in storage
  chunkCacheMaxBytes: 800000,      // a single chunk bigger than this is not cached
  mapZoom: 19.5,             // the live zoom — remembered between sessions
  zoomMode: "walk",          // which preset the zoom buttons show as selected
  zoomStreet: 16,            // "driving" preset — the whole zone and its roads
  zoomWalk: 19.5,            // "walking" preset — individual buildings, named
  followPlayer: true,
  devMode: false,            // dev panel visibility (forced on in sim mode)
  highAccuracy: true,
  dailyGoalMeters: 3000,
  fantasyMap: true,          // draw real roads/buildings as a fantasy town
  tileOpacity: 0.3,          // how much of the real map shows under the overlay
  labelZoom: 18,             // zoom at which street names appear
  snapNodesToBuildings: true
};
/* Two zoom presets, because the map is doing two different jobs. Street is for
   working out where to go; walk is for working out which door you're beside.
   Anything you pinch to in between is simply "free" — neither button lights up
   and nothing snaps you back. */
const ZOOM_MODES = [
  { key: "street", icon: "🚗", label: "Street", setting: "zoomStreet",
    hint: "Street view — the roads and every site in the zone" },
  { key: "walk", icon: "🚶", label: "Walk", setting: "zoomWalk",
    hint: "Walking view — individual buildings, close enough to name them" }
];
/** The zoom a preset means right now, honouring anything the player retuned. */
function zoomOf(key, s) {
  const m = ZOOM_MODES.find(x => x.key === key);
  s = s || settings();
  return m ? (+s[m.setting] || DEFAULT_SETTINGS[m.setting]) : (+s.mapZoom || 18);
}
/** Which preset a given zoom counts as, or "" when it sits between them. */
function zoomModeAt(z, s) {
  s = s || settings();
  const hit = ZOOM_MODES.find(m => Math.abs(zoomOf(m.key, s) - z) < 0.4);
  return hit ? hit.key : "";
}

function settings() {
  return Object.assign({}, DEFAULT_SETTINGS, Store.get(K.settings, {}) || {});
}
function saveSettings(patch) {
  const s = Object.assign(settings(), patch);
  Store.set(K.settings, s);
  return s;
}
