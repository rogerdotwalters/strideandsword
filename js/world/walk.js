/* -------------------------------------------------------------------------
   13. Walk tracker — the part that actually nags you to move
   ------------------------------------------------------------------------- */
const Walk = {
  todayKey() { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); },
  data() {
    const w = Store.get(K.walk, null) || { day: this.todayKey(), meters: 0, total: 0, xpBanked: 0, goalHit: false };
    if (w.day !== this.todayKey()) { w.day = this.todayKey(); w.meters = 0; w.xpBanked = 0; w.goalHit = false; }
    return w;
  },
  add(meters) {
    if (!isFinite(meters) || meters <= 0 || meters > 400) return; // 400m in one tick = a car
    const w = this.data();
    w.meters += meters;
    w.total += meters;
    Store.set(K.walk, w);
    Game.onWalked(meters, w);
  },
  reset() { Store.set(K.walk, { day: this.todayKey(), meters: 0, total: 0, xpBanked: 0, goalHit: false }); }
};
