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
