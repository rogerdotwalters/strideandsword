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
          accuracy: pos.coords.accuracy, speed: pos.coords.speed, ts: nowTs()
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
          // The device's own reading where it has one: doppler off the GPS
          // chip beats anything we can difference out of two fixes.
          speed: pos.coords.speed,
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

  /* ------------------------------------------------------------- how fast
     A speed, and the one decision that hangs off it: are you walking, or are
     you in a car?

     Two sources. The device's own `coords.speed` when it offers one — it is
     computed from doppler on real GPS hardware and is far better than anything
     we can derive — and otherwise the distance between two fixes over the time
     between them.

     Neither is trustworthy sample by sample. A fix that jumps sixty metres
     sideways while you stand at a window reads as twenty miles an hour, so the
     reading used for the decision is the **median** of the recent samples: one
     bad fix cannot move a median, and three in a row are not noise any more.

     Nothing here uses a timer. The speed is recomputed when a fix arrives,
     which is the only moment it can have changed. */

  SPEED_WINDOW_MS: 25000,    // samples older than this stop counting
  SPEED_MAX_SAMPLES: 8,
  ENTER_HOLD_MS: 6000,       // sustained above the line before the veil drops
  LEAVE_HOLD_MS: 12000,      // and below it before the world comes back
  /* A fix this vague cannot be differenced into a speed worth having: the
     error is bigger than the distance walked between two samples. */
  SPEED_ACCURACY_M: 60,

  speedMps: 0,               // the smoothed reading
  travelling: false,
  travelSince: 0,
  _speeds: [],               // { ts, mps }
  _fastSince: 0, _slowSince: 0,

  /** Thresholds in m/s, from the two settings in km/h. */
  travelLimits() {
    const s = settings();
    return { enter: (+s.travelEnterKph || 16) / 3.6, leave: (+s.travelLeaveKph || 8) / 3.6 };
  },

  /**
   * Fold one fix into the speed reading, and decide whether we are travelling.
   * Returns the speed of *this* sample, which is what the walk credit is
   * judged on — separately from the smoothed state, so a single fast sample
   * never earns metres even before the veil is up.
   */
  trackSpeed(fix, moved, prev) {
    /* Simulated fixes are teleports: the dev panel puts you 300 m away in one
       step, which is 60 m/s and would veil the screen every time anybody
       tested anything. Nothing about a simulated position is a speed. */
    if (fix.sim || this.simulated) { this.clearSpeed(); return 0; }

    const now = fix.ts || nowTs();
    let mps = null;
    if (fix.speed != null && isFinite(fix.speed) && fix.speed >= 0) {
      mps = +fix.speed;                                   // the device's own
    } else if (prev) {
      const dt = (now - prev.ts) / 1000;
      const vague = Math.max(fix.accuracy || 0, prev.accuracy || 0) > this.SPEED_ACCURACY_M;
      if (dt >= 0.5 && dt <= 60 && !vague) mps = moved / dt;
    }
    if (mps == null) return 0;

    this._speeds.push({ ts: now, mps });
    this._speeds = this._speeds
      .filter(x => now - x.ts <= this.SPEED_WINDOW_MS)
      .slice(-this.SPEED_MAX_SAMPLES);

    const sorted = this._speeds.map(x => x.mps).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    this.speedMps = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    const lim = this.travelLimits();
    if (this.speedMps >= lim.enter) {
      this._slowSince = 0;
      if (!this._fastSince) this._fastSince = now;
      if (!this.travelling && now - this._fastSince >= this.ENTER_HOLD_MS) this.setTravelling(true, now);
    } else if (this.speedMps <= lim.leave) {
      this._fastSince = 0;
      if (!this._slowSince) this._slowSince = now;
      if (this.travelling && now - this._slowSince >= this.LEAVE_HOLD_MS) this.setTravelling(false, now);
    }
    return mps;
  },

  setTravelling(on, now) {
    if (this.travelling === !!on) return;
    this.travelling = !!on;
    this.travelSince = on ? (now || nowTs()) : 0;
    if (typeof Game !== "undefined" && Game.onTravelChange) Game.onTravelChange(this.travelling);
  },

  /** Back to a standstill: no samples, no state, nothing half-remembered. */
  clearSpeed() {
    this._speeds = [];
    this.speedMps = 0;
    this._fastSince = 0; this._slowSince = 0;
    this.setTravelling(false);
  },

  speedKph() { return this.speedMps * 3.6; },
  speedMph() { return this.speedMps * 2.236936; },

  /**
   * Is the game held? One question, one answer, asked by everything that
   * stops — the walk credit, the map, the survey, the overlay — so turning the
   * setting off cannot leave half of it paused and the other half running.
   */
  pausing() { return this.travelling && settings().travelVeil !== false; },

  accept(fix, force) {
    const s = settings();
    if (!force && this.last && nowTs() - this.lastAccepted < s.gpsUpdateInterval) return;
    // Ignore jitter smaller than the reported accuracy — stops the walk
    // counter inflating while you sit still.
    let walked = 0;
    let sampleMps = 0;
    if (this.last) {
      const moved = haversine(this.last.latitude, this.last.longitude, fix.latitude, fix.longitude);
      sampleMps = this.trackSpeed(fix, moved, this.last);
      const noiseFloor = fix.sim ? 0 : Math.max(4, Math.min(25, (fix.accuracy || 15) * 0.6));
      if (moved > noiseFloor) walked = moved;
      else if (!force) { this.last = fix; this.lastAccepted = nowTs(); this._emit(); return; }
    }
    /* Metres covered faster than anyone runs are not walked metres, whatever
       the smoothed state says yet. Judging the credit on this one sample
       rather than on `travelling` means the six seconds it takes to be sure
       you are in a car are not six seconds of free XP — and it throws away
       the fix that jumped across the street, which was never a walk either. */
    if (walked && settings().travelVeil !== false &&
        (this.travelling || sampleMps >= this.travelLimits().enter)) walked = 0;
    /* Move first, then credit the walk.
       These used to be the other way round, which meant everything downstream
       of Walk.add — the dungeon floor, the XP, anything asking "where am I?" —
       was answered with the position you had just left. Harmless while nothing
       consulted it; wrong the moment the dungeon leash did, because the metres
       that carried you out of a dungeon were still being measured from inside
       it. */
    this.last = fix;
    this.lastAccepted = nowTs();
    if (walked) Walk.add(walked);
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
