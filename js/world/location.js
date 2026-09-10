/* -------------------------------------------------------------------------
   12. LocationService
   Wraps geolocation, distance accumulation and node proximity checks.
   Simulated positions from the dev panel flow through the exact same path,
   so nothing downstream needs to know where a fix came from.
   ------------------------------------------------------------------------- */
const Loc = {
  watchId: null,
  simulated: false,
  last: null,           // { latitude, longitude, accuracy, ts }
  lastAccepted: 0,
  status: "idle",       // idle | requesting | live | simulated | denied | error
  listeners: [],

  permissionState: "unknown",   // granted | prompt | denied | unknown

  onUpdate(fn) { this.listeners.push(fn); },
  _emit() { this.listeners.forEach(fn => { try { fn(this.last); } catch (e) { console.error(e); } }); },

  /**
   * Why location might not work here. Browsers only hand out GPS on a secure
   * origin, and Chrome and Safari additionally refuse to remember a permission
   * for a file:// page — there is no origin to attach it to — so the prompt
   * never appears at all. That is the single most common reason this page
   * looks like it "never asked".
   */
  diagnose() {
    const proto = location.protocol;
    const host = location.hostname;
    const localhost = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "";
    return {
      protocol: proto,
      host: host || "(none)",
      href: location.href,
      hasGeo: !!navigator.geolocation,
      isFile: proto === "file:",
      isLocalhost: localhost,
      secureContext: !!window.isSecureContext,
      // file: reports as a secure context but still cannot hold a permission
      canPrompt: !!navigator.geolocation && proto !== "file:" &&
                 (proto === "https:" || localhost),
      permission: this.permissionState
    };
  },

  /** Read the stored permission where the browser exposes it. */
  async permissionQuery() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return "unknown";
      const st = await navigator.permissions.query({ name: "geolocation" });
      this.permissionState = st.state;
      st.onchange = () => {
        this.permissionState = st.state;
        if (st.state === "granted" && settings().locationMode === "gps" && this.watchId == null) this.start();
        Game.renderHud();
      };
      return st.state;
    } catch (e) { return "unknown"; }
  },

  /**
   * Ask for permission. MUST be called from a click or tap: several browsers
   * only surface the prompt while the page has user activation, which is why
   * asking silently at load can look like nothing happened.
   */
  requestPermission() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        return resolve({ ok: false, code: 0, message: "This browser has no Geolocation API." });
      }
      // Permission may already have been granted elsewhere (browser settings,
      // another tab) and a watch may already be feeding us. Don't ask again.
      if (this.status === "live" && this.last && !this.simulated && nowTs() - this.last.ts < 60000) {
        this.permissionState = "granted";
        return resolve({ ok: true, accuracy: this.last.accuracy || 0 });
      }

      this.status = "requesting";
      Game.renderHud();
      let retried = false;

      const onOk = (pos) => {
        this.permissionState = "granted";
        this.simulated = false;
        this.status = "live";
        this.accept({
          latitude: pos.coords.latitude, longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy, ts: nowTs()
        }, true);
        this.start();                        // hold the watch open from here
        resolve({ ok: true, accuracy: pos.coords.accuracy });
      };
      const onErr = (err) => {
        // High accuracy can time out indoors; a coarse fix is better than none.
        if (err.code === 3 && !retried) {
          retried = true;
          navigator.geolocation.getCurrentPosition(onOk, onErr,
            { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
          return;
        }
        this.status = err.code === 1 ? "denied" : "error";
        if (err.code === 1) this.permissionState = "denied";
        Game.renderHud();
        resolve({ ok: false, code: err.code, message: err.message || "" });
      };
      // maximumAge lets the browser answer with a fix it already holds. Asking
      // for a brand-new sample (maximumAge 0) can hang for a stationary device
      // whose position genuinely hasn't changed.
      navigator.geolocation.getCurrentPosition(onOk, onErr,
        { enableHighAccuracy: settings().highAccuracy, timeout: 15000, maximumAge: 30000 });
    });
  },

  /**
   * Real GPS is the default and the only thing that moves you, unless the
   * player has explicitly ticked dev testing. A denial is reported, never
   * papered over with a fake position.
   */
  start() {
    const s = settings();
    if (s.locationMode === "sim") {
      this.stop();
      this.startSimulated();
      Game.setLocStatus("Dev testing — your real location is ignored.");
      return;
    }
    if (!navigator.geolocation) {
      this.status = "error";
      Game.onLocationProblem("This browser has no geolocation support.");
      return;
    }
    this.stop();                 // never stack watches
    this.status = "requesting";
    Game.setLocStatus("Asking for your location…");
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const first = !this.last || this.simulated;
        this.simulated = false;
        this.status = "live";
        this.accept({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          ts: nowTs()
        }, first);
        if (first) Game.setLocStatus("Location locked on. ±" + Math.round(pos.coords.accuracy) + " m.");
      },
      (err) => {
        this.status = err.code === 1 ? "denied" : "error";
        if (err.code === 1) this.permissionState = "denied";
        Game.onLocationProblem(err.code === 1
          ? "Location permission was denied."
          : err.code === 3 ? "Location timed out — no fix yet."
          : "Location is unavailable on this device right now.", err.code);
      },
      { enableHighAccuracy: s.highAccuracy, maximumAge: 3000, timeout: 15000 }
    );
  },

  stop() {
    if (this.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
  },

  startSimulated(lat, lng) {
    this.simulated = true;
    this.status = "simulated";
    const la = lat != null ? lat : (this.last ? this.last.latitude : 41.8827);
    const ln = lng != null ? lng : (this.last ? this.last.longitude : -87.6233);
    this.accept({ latitude: la, longitude: ln, accuracy: 5, ts: nowTs(), sim: true });
  },

  /** Manual/simulated move — same pipeline as a real GPS fix. */
  simulateTo(lat, lng) {
    this.simulated = true;
    if (this.status !== "live") this.status = "simulated";
    this.accept({ latitude: lat, longitude: lng, accuracy: 5, ts: nowTs(), sim: true }, true);
  },

  accept(fix, force) {
    const s = settings();
    if (!force && this.last && nowTs() - this.lastAccepted < s.gpsUpdateInterval) return;
    // Ignore jitter smaller than the reported accuracy — stops the walk
    // counter inflating while you sit still.
    if (this.last) {
      const moved = haversine(this.last.latitude, this.last.longitude, fix.latitude, fix.longitude);
      const noiseFloor = fix.sim ? 0 : Math.max(4, Math.min(25, (fix.accuracy || 15) * 0.6));
      if (moved > noiseFloor) Walk.add(moved);
      else if (!force) { this.last = fix; this.lastAccepted = nowTs(); this._emit(); return; }
    }
    this.last = fix;
    this.lastAccepted = nowTs();
    this._emit();
  },

  nearest(nodes) {
    if (!this.last) return null;
    let best = null;
    for (const n of nodes) {
      if (n.status === "cleared") continue;
      const d = haversine(this.last.latitude, this.last.longitude, n.latitude, n.longitude);
      if (!best || d < best.distance) best = { node: n, distance: d };
    }
    return best;
  },

  distanceTo(node) {
    if (!this.last) return null;
    return haversine(this.last.latitude, this.last.longitude, node.latitude, node.longitude);
  }
};
