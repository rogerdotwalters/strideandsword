/* -------------------------------------------------------------------------
   14. Toasts & tiny UI helpers
   ------------------------------------------------------------------------- */
const UI = {
  toastHost: null,
  toast(msg, kind, ms) {
    if (!this.toastHost) {
      this.toastHost = el("div"); this.toastHost.id = "toasts";
      document.body.appendChild(this.toastHost);
    }
    const t = el("div", "toast " + (kind || ""), msg);
    this.toastHost.appendChild(t);
    while (this.toastHost.children.length > 3) this.toastHost.removeChild(this.toastHost.firstChild);
    setTimeout(() => {
      t.style.transition = "opacity .3s,transform .3s";
      t.style.opacity = "0"; t.style.transform = "translateY(-8px)";
      setTimeout(() => t.remove(), 320);
    }, ms || 2600);
  },
  modal(opts) {
    const back = el("div", "modalBack");
    const m = el("div", "modal" + (opts.wide ? " lg" : ""));
    const head = el("div", "modalHead",
      (opts.icon ? '<span style="font-size:19px">' + opts.icon + "</span>" : "") +
      "<h3>" + esc(opts.title || "") + "</h3>");
    if (!opts.noClose) {
      const x = el("button", "closeX", "✕");
      x.onclick = () => close();
      head.appendChild(x);
    }
    const body = el("div", "modalBody");
    if (typeof opts.body === "string") body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    m.appendChild(head); m.appendChild(body);

    if (opts.buttons && opts.buttons.length) {
      const foot = el("div", "modalFoot");
      opts.buttons.forEach(b => {
        const btn = el("button", "btn " + (b.cls || "ghost"), b.label);
        btn.onclick = () => { const keep = b.onClick && b.onClick(close, body); if (!keep) close(); };
        foot.appendChild(btn);
      });
      m.appendChild(foot);
    }
    back.appendChild(m);
    if (!opts.noClose) back.addEventListener("click", (e) => { if (e.target === back) close(); });
    document.body.appendChild(back);
    function close() { back.remove(); if (opts.onClose) opts.onClose(); }
    return { close, body, root: back };
  },
  confirm(title, msg, onYes) {
    this.modal({
      title, body: '<p style="margin:0;color:var(--ink-2)">' + esc(msg) + "</p>",
      buttons: [
        { label: "Cancel", cls: "ghost" },
        { label: "Confirm", cls: "danger", onClick: () => { onYes(); } }
      ]
    });
  },
  bar(kind, cur, max) {
    const pct = max > 0 ? clamp(cur / max * 100, 0, 100) : 0;
    return '<div class="track"><div class="fill ' + kind + '" style="width:' + pct + '%"></div></div>';
  }
};
