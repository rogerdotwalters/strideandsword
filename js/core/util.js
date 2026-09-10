"use strict";
/* ==========================================================================
   STRIDE & SWORD
   A location-based roguelike. Phases 1-3 of the spec, single file, no build.

   Module map (mirrors the component tree in the design doc):
     Utils/StorageService      -> Store
     Utils/APIService          -> API           (scaffolded, local fallback)
     Utils/LocationService     -> Loc
     Utils/CombatCalculator    -> Calc
     Auth/*                    -> Auth + Screens.auth
     CharacterCreation/*       -> Screens.create
     MainGame/Map/*            -> MapView
     MainGame/HUD/*            -> HUD
     MainGame/Combat/*         -> Combat
     MainGame/Node/*           -> Nodes
   ========================================================================== */

/* -------------------------------------------------------------------------
   0. Utilities
   ------------------------------------------------------------------------- */
const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const uid = (p) => (p ? p + "_" : "") +
  Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd  = (a, b) => a + Math.random() * (b - a);
const rndI = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (pct) => Math.random() * 100 < pct;
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const nowTs = () => Date.now();

/* Seeded PRNG so a given zone always generates the same node layout. */
function seededRandom(seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return function () {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5;  h >>>= 0;
    return h / 4294967296;
  };
}

/* Geo helpers ------------------------------------------------------------ */
const EARTH_R = 6371000; // metres
const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;

/** Great-circle distance in metres between two {lat,lng}-ish points. */
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Project a point `dist` metres from origin along `bearing` degrees. */
function projectPoint(lat, lng, dist, bearingDeg) {
  const br = toRad(bearingDeg), d = dist / EARTH_R;
  const la1 = toRad(lat), lo1 = toRad(lng);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1),
                               Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { latitude: toDeg(la2), longitude: ((toDeg(lo2) + 540) % 360) - 180 };
}

const fmtDist = (m) => m == null ? "--" : (m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(2) + " km");
