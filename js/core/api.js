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
    /* Exposed so the JSON seed can install a test account that login will
       actually accept. Hashing is the one thing an account row cannot be
       written without, and it belongs here, with the rest of the fake backend. */
    hashPassword: pseudoHash,

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
