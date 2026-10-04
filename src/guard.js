// PiFiles behaves like a desktop program, not a web page: no browser context menu (Inspect,
// Reload, Back…), no DevTools / reload / print / view-source / browser-zoom shortcuts, no
// dragging the page itself around. The native side also disables DevTools and browser
// accelerator keys in WebView2 (system.rs); this covers what reaches the page.
// Keys that mean something in a file manager are re-routed to the app (F5 = refresh, Ctrl+F =
// search, Alt+←/→ = history) via `pifiles:command` events.
(function () {
  const command = (name) => window.dispatchEvent(new CustomEvent("pifiles:command", { detail: name }));

  // Our own menus are built by the app; the browser's never appears. Text gets an editing menu
  // of ours (the WebView's native one is disabled): in fields Undo/Cut/Copy/Paste/Delete/Select
  // all, and over readable text (previews, editors, properties, selected text) Copy/Select all.
  const FIELD = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=button]):not([type=submit]), textarea, [contenteditable=true], [contenteditable=plaintext-only]";
  const TEXT = "pre, code, .pp-v, [data-text-menu], #detailsPreview, #viewerContent, .pf-settings-main p, .toast";
  let menu = null;
  function closeTextMenu() { if (menu) { menu.remove(); menu = null; } }
  function textMenu(x, y, items) {
    closeTextMenu();
    menu = document.createElement("div");
    menu.className = "ctx-menu pf-text-menu";
    menu.setAttribute("role", "menu");
    for (const it of items) {
      if (it === "-") { menu.appendChild(Object.assign(document.createElement("div"), { className: "ctx-sep" })); continue; }
      const b = document.createElement("button");
      b.className = "ctx-item"; b.type = "button"; b.setAttribute("role", "menuitem"); b.disabled = !!it.disabled;
      b.innerHTML = `<span class="ctx-label"></span><span class="ctx-hint"></span>`;
      b.firstChild.textContent = it.label; b.lastChild.textContent = it.hint || "";
      b.addEventListener("mousedown", ev => ev.preventDefault()); // keep focus + selection in the field
      b.addEventListener("click", () => { closeTextMenu(); it.run(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + "px";
    menu.querySelector(".ctx-item:not(:disabled)")?.focus({ preventScroll: true });
  }
  const insert = (text) => { if (!document.execCommand("insertText", false, text)) { const f = document.activeElement; if (f && "value" in f) f.setRangeText(text, f.selectionStart, f.selectionEnd, "end"); } };
  async function readClip() { try { return await navigator.clipboard.readText(); } catch { return null; } }
  function fieldMenu(e, f) {
    f.focus({ preventScroll: true });
    const isInput = "value" in f;
    const sel = isInput ? (f.value || "").slice(f.selectionStart ?? 0, f.selectionEnd ?? 0) : String(getSelection());
    const ro = f.readOnly || f.disabled || (!isInput && !f.isContentEditable);
    const secret = f.type === "password";
    textMenu(e.clientX, e.clientY, [
      { label: "Undo", hint: "Ctrl+Z", disabled: ro, run: () => document.execCommand("undo") },
      "-",
      { label: "Cut", hint: "Ctrl+X", disabled: ro || !sel || secret, run: () => { navigator.clipboard?.writeText(sel); insert(""); } },
      { label: "Copy", hint: "Ctrl+C", disabled: !sel || secret, run: () => navigator.clipboard?.writeText(sel) },
      { label: "Paste", hint: "Ctrl+V", disabled: ro, run: async () => { const t = await readClip(); if (t != null) { f.focus(); insert(t); } } },
      { label: "Delete", hint: "Del", disabled: ro || !sel, run: () => insert("") },
      "-",
      { label: "Select all", hint: "Ctrl+A", run: () => { f.focus(); if (isInput) f.select(); else document.execCommand("selectAll"); } },
    ]);
  }
  function readMenu(e, host) {
    const s = getSelection();
    const text = String(s);
    textMenu(e.clientX, e.clientY, [
      { label: "Copy", hint: "Ctrl+C", disabled: !text, run: () => navigator.clipboard?.writeText(text) },
      { label: "Select all", hint: "Ctrl+A", run: () => { const r = document.createRange(); r.selectNodeContents(host); s.removeAllRanges(); s.addRange(r); } },
    ]);
  }
  document.addEventListener("contextmenu", e => {
    closeTextMenu();
    const t = e.target;
    const field = t.closest?.(FIELD);
    if (field) { e.preventDefault(); e.stopImmediatePropagation(); fieldMenu(e, field); return; }
    // Right-click inside selected text, or on readable text areas, copies text rather than
    // acting on files - unless the click is on an item the app has its own menu for.
    const s = getSelection();
    const inSel = s && !s.isCollapsed && s.rangeCount && s.getRangeAt(0).intersectsNode(t);
    const host = t.closest?.(TEXT);
    const item = t.closest?.("[data-path], .ctx-item, button, a");
    if ((inSel && !item) || (host && !item)) { e.preventDefault(); e.stopImmediatePropagation(); readMenu(e, host || t); return; }
    e.preventDefault();
  }, true);
  for (const ev of ["mousedown", "wheel", "blur", "resize"]) window.addEventListener(ev, e => { if (menu && !(e.target instanceof Node && menu.contains(e.target))) closeTextMenu(); }, true);
  document.addEventListener("keydown", e => { if (menu && e.key === "Escape") { e.stopImmediatePropagation(); closeTextMenu(); } }, true);

  document.addEventListener("keydown", e => {
    const k = e.key;
    if (typeof k !== "string") return; // e.g. picking a suggestion from a <datalist>
    const ctrl = e.ctrlKey || e.metaKey;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    // DevTools and page-inspection shortcuts.
    if (k === "F12" || (ctrl && e.shiftKey && ["i", "j", "c", "k", "m"].includes(lower)) || (ctrl && lower === "u")) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    // Reload → refresh the current view instead of reloading the whole app.
    if (k === "F5" || (ctrl && lower === "r")) {
      e.preventDefault(); e.stopImmediatePropagation(); command("refresh"); return;
    }
    // Browser print / save page / find / caret browsing / zoom.
    if (ctrl && ["p", "s", "g", "o", "n", "h", "j", "d"].includes(lower) && !e.shiftKey && !e.altKey) {
      // Ctrl+P (preview pane), Ctrl+S (save in editors) and others are handled by the app; only
      // stop the browser default here.
      e.preventDefault(); return;
    }
    if (ctrl && lower === "f") { e.preventDefault(); command("search"); return; }
    if (k === "F7" || k === "F3") { e.preventDefault(); return; }
    if (ctrl && ["+", "=", "-", "_", "0"].includes(k)) { e.preventDefault(); command(k === "0" ? "zoom-reset" : (k === "-" || k === "_") ? "zoom-out" : "zoom-in"); return; }
    // Browser history keys → the app's own history.
    if (e.altKey && (k === "ArrowLeft" || k === "ArrowRight")) { e.preventDefault(); command(k === "ArrowLeft" ? "back" : "forward"); return; }
    if (k === "BrowserBack" || k === "BrowserForward") { e.preventDefault(); command(k === "BrowserBack" ? "back" : "forward"); }
  }, true);

  // Mouse back/forward buttons navigate the app's history, not the web view's.
  window.addEventListener("mouseup", e => {
    if (e.button === 3 || e.button === 4) { e.preventDefault(); command(e.button === 3 ? "back" : "forward"); }
  }, true);
  window.addEventListener("mousedown", e => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);

  // Ctrl+wheel zooms the app's content, never the web view.
  window.addEventListener("wheel", e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false, capture: true });

  // Dropping a file on the window must not navigate the web view to it.
  window.addEventListener("dragover", e => { if (!e.target.closest?.("[data-drop]")) e.preventDefault(); });
  window.addEventListener("drop", e => { if (!e.target.closest?.("[data-drop]")) e.preventDefault(); });

  // No text selection of UI chrome by accident (lists, buttons); text fields and content still select.
  document.documentElement.classList.add("pf-app");
})();
