// PiFiles dialogs + origin-aware motion (classic script, loaded before main.js).
//
// PiMotion: modals grow out of the control that opened them and shrink back into it on close.
//   Each registered modal stays laid out while "hidden" (visibility + transitions, see explorer.css);
//   before it opens we store the opener's position as --pf-dx/--pf-dy/--pf-s on the modal, so the
//   hidden state *is* "shrunk onto the opener" and CSS transitions do the rest in both directions.
//
// PiDialog: Windows 11 ContentDialog replacements for prompt()/confirm()/alert(), which in a
//   webview show "127.0.0.1 says" and block the UI thread.
(function () {
  const MODALS = new Map(); // root element -> box selector
  let lastTrigger = null;

  function originFor(modal, trigger) {
    const box = modal.querySelector(MODALS.get(modal));
    if (!box) return;
    // Layout box (offset*) ignores the current transform; the modal root is fixed at 0,0.
    const bw = box.offsetWidth || 1, bh = box.offsetHeight || 1;
    let bx = box.offsetLeft + bw / 2, by = box.offsetTop + bh / 2;
    for (let p = box.offsetParent; p && p !== modal && p !== document.body; p = p.offsetParent) { bx += p.offsetLeft; by += p.offsetTop; }
    let dx = 0, dy = 24, s = 0.92; // no opener: gentle rise
    if (trigger && trigger.isConnected && trigger.getClientRects().length) {
      const r = trigger.getBoundingClientRect();
      dx = r.left + r.width / 2 - bx;
      dy = r.top + r.height / 2 - by;
      s = Math.max(0.06, Math.min(0.5, Math.max(r.width / bw, r.height / bh)));
    }
    // Move the (invisible) hidden state onto the opener instantly - it must not transition there - 
    // then commit it so the open transition starts exactly from the opener.
    box.style.transition = "none";
    modal.style.setProperty("--pf-dx", `${dx.toFixed(1)}px`);
    modal.style.setProperty("--pf-dy", `${dy.toFixed(1)}px`);
    modal.style.setProperty("--pf-s", s.toFixed(3));
    void getComputedStyle(box).transform;
    box.style.transition = "";
    void getComputedStyle(box).transform;
  }

  const TRIGGER = "button, [role=button], a, .file-row, .file-card, .person-card, .nav-item, .drive-card, [data-open-settings]";
  function remember(target) {
    const el = target?.closest?.(TRIGGER) || null;
    if (!el || el.closest(".pf-motion")) return; // clicks inside an open dialog don't move its origin
    lastTrigger = el;
    MODALS.forEach((_, modal) => { if (modal.classList.contains("hidden")) originFor(modal, el); });
  }
  document.addEventListener("pointerdown", e => remember(e.target), true);
  document.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") remember(document.activeElement); }, true);

  window.PiMotion = {
    register(modal, boxSelector) {
      if (!modal || MODALS.has(modal)) return;
      MODALS.set(modal, boxSelector);
      modal.classList.add("pf-motion");
      modal.querySelector(boxSelector)?.classList.add("pf-motion-box");
      if (modal.classList.contains("hidden")) originFor(modal, lastTrigger);
    },
    /** Opens a registered modal from `trigger` (defaults to the last clicked control). */
    open(modal, trigger) {
      originFor(modal, trigger || lastTrigger);
      modal.classList.remove("hidden");
    },
    close(modal) { modal.classList.add("hidden"); },
    /** Closes a modal into `target` (e.g. the file a viewer was opened from), wherever it is now. */
    closeTo(modal, target) {
      const box = modal.querySelector(MODALS.get(modal));
      if (box && target && target.isConnected && target.getClientRects().length) {
        const bw = box.offsetWidth || 1, bh = box.offsetHeight || 1;
        let bx = box.offsetLeft + bw / 2, by = box.offsetTop + bh / 2;
        for (let p = box.offsetParent; p && p !== modal && p !== document.body; p = p.offsetParent) { bx += p.offsetLeft; by += p.offsetTop; }
        const r = target.getBoundingClientRect();
        // Transitions stay on: the closing animation heads for the new spot.
        modal.style.setProperty("--pf-dx", `${(r.left + r.width / 2 - bx).toFixed(1)}px`);
        modal.style.setProperty("--pf-dy", `${(r.top + r.height / 2 - by).toFixed(1)}px`);
        modal.style.setProperty("--pf-s", Math.max(0.04, Math.min(0.5, Math.max(r.width / bw, r.height / bh))).toFixed(3));
      }
      modal.classList.add("hidden");
    },
    get lastTrigger() { return lastTrigger; },
  };

  // ---------- dialogs ----------
  let root = null, queue = Promise.resolve();
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function build() {
    root = document.createElement("div");
    root.className = "pf-dialog hidden";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `<div class="pf-dialog-scrim"></div>
      <div class="pf-dialog-box" role="document">
        <div class="pf-dialog-content">
          <h2 class="pf-dialog-title"></h2>
          <div class="pf-dialog-message"></div>
          <div class="pf-dialog-field">
            <input class="pf-dialog-input" type="text" spellcheck="false" autocomplete="off">
            <button class="pf-dialog-reveal" type="button" hidden aria-label="Show password" aria-pressed="false"></button>
          </div>
          <div class="pf-dialog-error" hidden></div>
        </div>
        <div class="pf-dialog-footer">
          <button class="pf-dialog-btn primary" data-r="ok"></button>
          <button class="pf-dialog-btn" data-r="cancel"></button>
        </div>
      </div>`;
    document.body.appendChild(root);
    PiMotion.register(root, ".pf-dialog-box");
  }

  function show(kind, opts) {
    const run = () => new Promise(resolve => {
      if (!root) build();
      const o = typeof opts === "string" ? { message: opts } : (opts || {});
      const title = root.querySelector(".pf-dialog-title");
      const msg = root.querySelector(".pf-dialog-message");
      const input = root.querySelector(".pf-dialog-input");
      const ok = root.querySelector('[data-r="ok"]');
      const cancel = root.querySelector('[data-r="cancel"]');
      title.textContent = o.title || (kind === "prompt" ? "Enter a value" : "PiFiles");
      msg.innerHTML = esc(o.message || "").replace(/\n/g, "<br>");
      msg.hidden = !o.message;
      const field = root.querySelector(".pf-dialog-field");
      const reveal = root.querySelector(".pf-dialog-reveal");
      const error = root.querySelector(".pf-dialog-error");
      field.hidden = kind !== "prompt";
      input.value = o.value ?? "";
      input.placeholder = o.placeholder || "";
      // Password mode: masked input with a show/hide toggle (Windows "reveal" button).
      input.type = o.password ? "password" : "text";
      input.autocomplete = o.password ? "off" : "off";
      reveal.hidden = !o.password;
      const setReveal = (on) => {
        input.type = on ? "text" : "password";
        reveal.setAttribute("aria-pressed", String(on));
        reveal.setAttribute("aria-label", on ? "Hide password" : "Show password");
        reveal.title = on ? "Hide password" : "Show password";
        reveal.innerHTML = window.PiIcons ? PiIcons.ui(on ? "eyeOff" : "eye") : (on ? "Hide" : "Show");
      };
      if (o.password) setReveal(false);
      reveal.onclick = () => { setReveal(input.type === "password"); input.focus(); };
      error.hidden = !o.error;
      error.textContent = o.error || "";
      ok.textContent = o.okText || "OK";
      ok.classList.toggle("danger", !!o.danger);
      cancel.textContent = o.cancelText || "Cancel";
      cancel.hidden = kind === "alert";
      const trigger = o.origin || PiMotion.lastTrigger;
      const prevFocus = document.activeElement;

      const finish = (result) => {
        document.removeEventListener("keydown", onKey, true);
        root.removeEventListener("click", onClick);
        PiMotion.close(root);
        prevFocus?.focus?.({ preventScroll: true });
        resolve(result);
      };
      const accept = () => finish(kind === "prompt" ? input.value : true);
      const dismiss = () => finish(kind === "prompt" ? null : false);
      const onClick = e => {
        const b = e.target.closest("[data-r]");
        if (b) (b.dataset.r === "ok" ? accept : dismiss)();
        else if (e.target.classList.contains("pf-dialog-scrim") && kind !== "alert") shake();
      };
      const onKey = e => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismiss(); }
        else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); accept(); }
        else if (e.key === "Tab") { // keep focus inside the dialog
          const f = [...root.querySelectorAll("input, button")].filter(el => !el.hidden && !el.closest("[hidden]"));
          const i = f.indexOf(document.activeElement);
          e.preventDefault();
          f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
        }
      };
      const shake = () => { const b = root.querySelector(".pf-dialog-box"); b.classList.remove("pf-shake"); void b.offsetWidth; b.classList.add("pf-shake"); };

      root.addEventListener("click", onClick);
      document.addEventListener("keydown", onKey, true);
      PiMotion.open(root, trigger);
      requestAnimationFrame(() => {
        if (kind === "prompt") {
          input.focus();
          // Like Explorer's rename: select the name, not the extension.
          const dot = o.selectBaseName ? input.value.lastIndexOf(".") : -1;
          input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
        } else ok.focus();
      });
    });
    const p = queue.then(run);
    queue = p.catch(() => {});
    return p;
  }

  // Existing app modals get the same open/close motion.
  function registerAppModals() {
    PiMotion.register(document.getElementById("viewerModal"), ".viewer-box");
    PiMotion.register(document.getElementById("faceSuggestionModal"), ".face-modal-box");
    PiMotion.register(document.getElementById("movePhotosModal"), ".face-modal-box");
    PiMotion.register(document.getElementById("commandPalette"), ".cmd-box");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", registerAppModals);
  else registerAppModals();

  window.PiDialog = {
    confirm: (opts) => show("confirm", opts),
    prompt: (opts) => show("prompt", opts),
    alert: (opts) => show("alert", opts),
  };
})();
