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
  walk:        "walk_stats"
};

/* -------------------------------------------------------------------------
   2. APIService  (scaffolded)
   Every persistence call in the game goes through API.request(). Today it
   short-circuits to the localStorage handlers below. Point BASE_URL at a
   deployed backend and `isOnline` flips: the same call sites then hit
   real endpoints, with localStorage as the offline fallback.

   Endpoints the backend must implement (Phase 5):
     POST   /auth/register              POST  /combat/start
     POST   /auth/login                 POST  /combat/{id}/action
     GET    /user/profile               GET   /combat/{id}
     PATCH  /user/profile               PATCH /combat/{id}/end
     POST   /location/create-zone       POST  /inventory/item/add
     GET    /location/zone/{userId}     DELETE/inventory/item/{itemId}
     POST   /nodes/generate             PATCH /inventory/item/{id}/equip
     GET    /nodes/zone/{zoneId}        GET   /inventory/{characterId}
     PATCH  /nodes/{nodeId}/status      PATCH /character/{id}/experience
     GET    /nodes/{nodeId}/encounters  POST  /character/{id}/levelup
     GET    /leaderboard                GET   /character/{id}/progression
   ------------------------------------------------------------------------- */
const API = (function () {
  const BASE_URL = null; // <-- set to "https://your-host/api" once the backend exists

  class APIService {
    constructor(baseURL) {
      this.baseURL = baseURL || "http://localhost:3000/api";
      this.isOnline = !!baseURL;
      this.log = [];
    }
    getToken() {
      const s = Store.get(K.session, {}) || {};
      return s.token || null;
    }
    async request(endpoint, method = "GET", data = null) {
      this.log.push({ t: nowTs(), method, endpoint });
      if (this.log.length > 200) this.log.shift();

      if (!this.isOnline) return this.handleLocal(endpoint, method, data);

      try {
        const options = {
          method,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + this.getToken()
          }
        };
        if (data) options.body = JSON.stringify(data);
        const res = await fetch(this.baseURL + endpoint, options);
        if (res.status === 401) { Auth.logout(); return { success: false, message: "Session expired" }; }
        if (!res.ok) return { success: false, message: "HTTP " + res.status };
        return await res.json();
      } catch (err) {
        console.error("API Error:", err);
        return this.handleLocal(endpoint, method, data); // offline fallback
      }
    }
    /* Local mode: resolved by Local.route() below. */
    handleLocal(endpoint, method, data) {
      const out = Local.route(endpoint, method, data);
      if (!out) {
        console.warn("[LOCAL MODE] unhandled " + method + " " + endpoint);
        return { success: false, message: "Not implemented locally" };
      }
      return out;
    }
  }
  return new APIService(BASE_URL);
})();

/* -------------------------------------------------------------------------
   3. Local backend emulation
   The localStorage implementation of every endpoint above. When the real
   backend lands, this module is what gets deleted.
   ------------------------------------------------------------------------- */
const Local = (function () {
  /* Deliberately weak: a stand-in for a real server-side hash. Never ship. */
  function pseudoHash(pw) {
    let h = 5381;
    for (let i = 0; i < pw.length; i++) h = ((h << 5) + h + pw.charCodeAt(i)) | 0;
    return "lh$" + (h >>> 0).toString(16) + "$" + pw.length;
  }

  const routes = [
    ["POST", /^\/auth\/register$/, (m, d) => {
      const accounts = Store.get(K.accounts, {}) || {};
      const taken = Object.values(accounts).some(a =>
        a.username.toLowerCase() === d.username.toLowerCase());
      if (taken) return { success: false, message: "That username is already taken." };
      const userId = uid("usr");
      accounts[userId] = {
        userId, username: d.username, email: d.email || "",
        passwordHash: pseudoHash(d.password),
        createdAt: nowTs(), lastLogin: nowTs()
      };
      Store.set(K.accounts, accounts);
      return { success: true, user: publicUser(accounts[userId]), token: "local." + userId };
    }],

    ["POST", /^\/auth\/login$/, (m, d) => {
      const accounts = Store.get(K.accounts, {}) || {};
      const acct = Object.values(accounts).find(a =>
        a.username.toLowerCase() === d.username.toLowerCase());
      if (!acct || acct.passwordHash !== pseudoHash(d.password))
        return { success: false, message: "Wrong username or password." };
      acct.lastLogin = nowTs();
      Store.set(K.accounts, accounts);
      return { success: true, user: publicUser(acct), token: "local." + acct.userId };
    }],

    ["GET", /^\/user\/profile$/, () => {
      const s = Store.get(K.session, {}) || {};
      const accounts = Store.get(K.accounts, {}) || {};
      const a = accounts[s.userId];
      return a ? { success: true, user: publicUser(a) } : { success: false, message: "No session" };
    }],

    ["PATCH", /^\/user\/profile$/, (m, d) => {
      const s = Store.get(K.session, {}) || {};
      Store.patch(K.accounts, (acc) => { if (acc[s.userId]) Object.assign(acc[s.userId], d); });
      return { success: true };
    }],

    /* --- characters --- */
    ["POST", /^\/character\/create$/, (m, d) => {
      Store.patch(K.characters, (chars) => { chars[d.characterId] = d; });
      Store.patch(K.inventories, (inv) => { inv[d.characterId] = []; });
      return { success: true, character: d };
    }],
    ["PATCH", /^\/character\/[^/]+$/, (m, d) => {
      Store.patch(K.characters, (chars) => {
        if (chars[m[0].split("/")[2]]) Object.assign(chars[m[0].split("/")[2]], d);
      });
      return { success: true };
    }],
    ["GET", /^\/character\/list\/[^/]+$/, (m) => {
      const userId = m[0].split("/")[3];
      const chars = Store.get(K.characters, {}) || {};
      return { success: true, characters: Object.values(chars).filter(c => c.userId === userId) };
    }],
    ["DELETE", /^\/character\/[^/]+$/, (m) => {
      const id = m[0].split("/")[2];
      Store.patch(K.characters, (c) => { delete c[id]; });
      Store.patch(K.inventories, (i) => { delete i[id]; });
      return { success: true };
    }],

    /* --- zones & nodes --- */
    ["POST", /^\/location\/create-zone$/, (m, d) => {
      Store.patch(K.zones, (z) => { z[d.zoneId] = d; });
      return { success: true, zone: d };
    }],
    ["GET", /^\/location\/zone\/[^/]+$/, (m) => {
      const userId = m[0].split("/")[3];
      const zones = Store.get(K.zones, {}) || {};
      return { success: true, zones: Object.values(zones).filter(z => z.userId === userId) };
    }],
    ["POST", /^\/nodes\/generate$/, (m, d) => {
      Store.patch(K.nodes, (all) => { d.nodes.forEach(n => { all[n.nodeId] = n; }); });
      return { success: true, nodes: d.nodes };
    }],
    ["GET", /^\/nodes\/zone\/[^/]+$/, (m) => {
      const zoneId = m[0].split("/")[3];
      const all = Store.get(K.nodes, {}) || {};
      return { success: true, nodes: Object.values(all).filter(n => n.zoneId === zoneId) };
    }],
    ["PATCH", /^\/nodes\/[^/]+\/status$/, (m, d) => {
      const nodeId = m[0].split("/")[2];
      Store.patch(K.nodes, (all) => { if (all[nodeId]) Object.assign(all[nodeId], d); });
      return { success: true };
    }],

    /* --- combat --- */
    ["POST", /^\/combat\/start$/, (m, d) => {
      Store.patch(K.encounters, (e) => { e[d.encounterId] = d; });
      return { success: true, encounter: d };
    }],
    ["PATCH", /^\/combat\/[^/]+\/end$/, (m, d) => {
      const id = m[0].split("/")[2];
      Store.patch(K.encounters, (e) => { if (e[id]) Object.assign(e[id], d); });
      return { success: true };
    }],

    /* --- inventory --- */
    ["GET", /^\/inventory\/[^/]+$/, (m) => {
      const cid = m[0].split("/")[2];
      const inv = Store.get(K.inventories, {}) || {};
      return { success: true, items: inv[cid] || [] };
    }],
    ["POST", /^\/inventory\/item\/add$/, (m, d) => {
      Store.patch(K.inventories, (inv) => {
        if (!inv[d.characterId]) inv[d.characterId] = [];
        inv[d.characterId].push(d.item);
      });
      return { success: true };
    }],
    ["POST", /^\/inventory\/sync$/, (m, d) => {
      Store.patch(K.inventories, (inv) => { inv[d.characterId] = d.items; });
      return { success: true };
    }]
  ];

  function publicUser(a) {
    return { userId: a.userId, username: a.username, email: a.email,
             createdAt: a.createdAt, lastLogin: a.lastLogin };
  }

  return {
    route(endpoint, method, data) {
      for (const [verb, re, fn] of routes) {
        if (verb !== method) continue;
        const m = endpoint.match(re);
        if (m) { m[0] = endpoint; return fn(m, data || {}); }
      }
      return null;
    }
  };
})();

/* -------------------------------------------------------------------------
   4. Auth
   ------------------------------------------------------------------------- */
const Auth = {
  current: null,
  async register(username, email, password) {
    const r = await API.request("/auth/register", "POST", { username, email, password });
    if (r.success) this._startSession(r);
    return r;
  },
  async login(username, password) {
    const r = await API.request("/auth/login", "POST", { username, password });
    if (r.success) this._startSession(r);
    return r;
  },
  _startSession(r) {
    const sess = { sessionId: uid("sess"), userId: r.user.userId, loginTime: nowTs(), token: r.token };
    Store.set(K.session, sess);
    Store.session.set("currentUserId", r.user.userId);
    this.current = r.user;
  },
  restore() {
    const s = Store.get(K.session, null);
    if (!s || !s.userId) return null;
    const accounts = Store.get(K.accounts, {}) || {};
    const a = accounts[s.userId];
    if (!a) { Store.remove(K.session); return null; }
    this.current = { userId: a.userId, username: a.username, email: a.email,
                     createdAt: a.createdAt, lastLogin: a.lastLogin };
    Store.session.set("currentUserId", a.userId);
    return this.current;
  },
  logout() {
    Store.remove(K.session);
    Store.session.remove("currentUserId");
    this.current = null;
    Game.reset();
    Screens.show("auth");
  }
};
