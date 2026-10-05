// PiKeys - customizable keyboard shortcuts.
//
// Every app action has a default key (the one main.js / guard.js / shell.js already handle).
// Users can bind a different key or turn a shortcut off in Settings > Advanced. This layer runs
// first (window, capture phase): a custom key is translated into the action's default key and
// re-dispatched, and a default key whose action was moved or disabled is swallowed. So the
// existing handlers stay the single source of behaviour.
(function () {
  "use strict";
  const ACTIONS = [
    // group, id, label, default
    ["Tabs & windows", "newTab", "New tab", "Ctrl+T"],
    ["Tabs & windows", "closeTab", "Close tab", "Ctrl+W"],
    ["Tabs & windows", "nextTab", "Next tab", "Ctrl+Tab"],
    ["Tabs & windows", "prevTab", "Previous tab", "Ctrl+Shift+Tab"],
    ["Tabs & windows", "settings", "Open Settings", "Ctrl+,"],
    ["Tabs & windows", "palette", "Command palette", "Ctrl+Shift+P"],
    ["Navigation", "back", "Back", "Alt+ArrowLeft"],
    ["Navigation", "backAlt", "Back (alternative)", "Backspace"],
    ["Navigation", "forward", "Forward", "Alt+ArrowRight"],
    ["Navigation", "address", "Edit the address", "Ctrl+L"],
    ["Navigation", "search", "Search", "Ctrl+F"],
    ["Navigation", "searchAlt", "Search (alternative)", "Ctrl+K"],
    ["Navigation", "refresh", "Refresh", "F5"],
    ["Files", "open", "Open selection", "Enter"],
    ["Files", "rename", "Rename", "F2"],
    ["Files", "properties", "Properties", "Alt+Enter"],
    ["Files", "copy", "Copy", "Ctrl+C"],
    ["Files", "cut", "Cut", "Ctrl+X"],
    ["Files", "paste", "Paste", "Ctrl+V"],
    ["Files", "selectAll", "Select all", "Ctrl+A"],
    ["Files", "delete", "Delete (to Recycle Bin)", "Delete"],
    ["Files", "deletePermanent", "Delete permanently", "Shift+Delete"],
    ["Files", "copyPath", "Copy path", "Ctrl+Shift+C"],
    ["Files", "newFolder", "New folder", "Ctrl+Shift+N"],
    ["Panes", "previewPane", "Show preview pane", "Ctrl+P"],
    ["Panes", "detailsPane", "Show details pane", "Ctrl+I"],
    ["Panes", "togglePane", "Hide or show the right pane", "Ctrl+Shift+D"],
    // Only while a movie or song is open in the viewer (scope "player").
    ["Movie player", "mPlay", "Play or pause", "Space", "player"],
    ["Movie player", "mPlayAlt", "Play or pause (alternative)", "K", "player"],
    ["Movie player", "mBack", "Back (short step)", "ArrowLeft", "player"],
    ["Movie player", "mFwd", "Forward (short step)", "ArrowRight", "player"],
    ["Movie player", "mJumpBack", "Back (long step)", "J", "player"],
    ["Movie player", "mJumpFwd", "Forward (long step)", "L", "player"],
    ["Movie player", "mVolUp", "Volume up", "ArrowUp", "player"],
    ["Movie player", "mVolDown", "Volume down", "ArrowDown", "player"],
    ["Movie player", "mMute", "Mute", "M", "player"],
    ["Movie player", "mFull", "Full screen", "F", "player"],
    ["Movie player", "mSubs", "Subtitles on/off", "C", "player"],
    ["Movie player", "mAudio", "Next audio track", "A", "player"],
  ].map(([group, id, label, def, scope = "app"]) => ({ group, id, label, def, scope }));
  const byId = new Map(ACTIONS.map(a => [a.id, a]));

  const S = () => window.PiSettings;
  const overrides = () => (S()?.get("shortcuts")) || {};
  /** The key currently bound to an action ("" = turned off). */
  function bindingOf(id) {
    const o = overrides();
    return Object.prototype.hasOwnProperty.call(o, id) ? o[id] : byId.get(id)?.def || "";
  }

  const NAMES = { " ": "Space", Esc: "Escape", Del: "Delete", Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" };
  /** "Ctrl+Shift+K" from a keyboard event (null for lone modifier keys). */
  function comboOf(e) {
    if (typeof e.key !== "string") return null; // datalist picks etc. carry no key
    let k = NAMES[e.key] || e.key;
    if (["Control", "Shift", "Alt", "Meta", "OS"].includes(k)) return null;
    if (k.length === 1) k = k.toUpperCase();
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    return [...mods, k].join("+");
  }
  const norm = c => String(c || "").split("+").map(p => (p.length === 1 ? p.toUpperCase() : p)).join("+");

  /** Synthetic key event carrying a combo, so the existing handlers run unchanged. */
  function fire(combo, target) {
    const parts = combo.split("+"), name = parts.pop(), key = name === "Space" ? " " : name;
    const init = { key: key.length === 1 ? key.toLowerCase() : key, ctrlKey: parts.includes("Ctrl"), altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift"), bubbles: true, cancelable: true };
    const ev = new KeyboardEvent("keydown", init);
    ev.__pfRemapped = true;
    (target || document.activeElement || document.body).dispatchEvent(ev);
  }

  const typing = el => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  let recording = null; // editor captures the next key instead

  window.addEventListener("keydown", e => {
    // Picking a <datalist>/autocomplete suggestion fires a keydown without a `key`; no app
    // handler expects that, so it stops here (the input still receives its value).
    if (typeof e.key !== "string") { e.stopImmediatePropagation(); return; }
    if (e.__pfRemapped) return;
    if (recording) return; // the editor handles it
    const o = overrides();
    if (!Object.keys(o).length) return; // nothing customised: zero overhead
    const combo = comboOf(e);
    if (!combo) return;
    // In text fields only modifier shortcuts are remapped; plain keys type text.
    if (typing(e.target) && !/^(Ctrl|Alt)\+/.test(combo) && !/^F\d+$/.test(combo)) return;
    // Movie-player keys only apply while a player is open, so moving them never affects browsing.
    const scopes = document.querySelector(".pv-player") ? ["player", "app"] : ["app"];
    const inScope = a => scopes.includes(a.scope);
    const custom = ACTIONS.find(a => inScope(a) && norm(bindingOf(a.id)) === combo && norm(a.def) !== combo);
    if (custom) {
      e.preventDefault(); e.stopImmediatePropagation();
      fire(custom.def, e.target);
      return;
    }
    const moved = ACTIONS.find(a => inScope(a) && norm(a.def) === combo && norm(bindingOf(a.id)) !== combo);
    if (moved && !(typing(e.target) && ["copy", "cut", "paste", "selectAll"].includes(moved.id))) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);

  // ---------------------------------------------------------------- Settings editor
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pretty = c => (c ? c.replace(/^ $/, "Space").replace("ArrowLeft", "Left").replace("ArrowRight", "Right").replace("ArrowUp", "Up").replace("ArrowDown", "Down") : "Off");
  function conflicts() {
    const seen = new Map(), dup = new Set();
    for (const a of ACTIONS) { const b = a.scope + ":" + norm(bindingOf(a.id)); if (!bindingOf(a.id)) continue; if (seen.has(b)) { dup.add(a.id); dup.add(seen.get(b)); } else seen.set(b, a.id); }
    return dup;
  }
  function render(el) {
    const dup = conflicts();
    let html = "", group = "";
    for (const a of ACTIONS) {
      if (a.group !== group) {
        const open = !(window.PiSettingsSections?.collapsed("keys:" + a.group));
        html += `${group ? "</div></details>" : ""}<details class="pf-sec pk-sec" data-sec="keys:${esc(a.group)}" ${open ? "open" : ""}><summary class="pk-group-title">${esc(a.group)}${a.scope === "player" ? `<span class="pk-scope">while a video or song is playing</span>` : ""}</summary><div class="pf-card-group">`;
        group = a.group;
      }
      const b = bindingOf(a.id), changed = norm(b) !== norm(a.def);
      html += `<div class="pf-row key-row${dup.has(a.id) ? " conflict" : ""}"><div class="pf-row-text"><div class="pf-row-title">${esc(a.label)}</div>${dup.has(a.id) ? `<div class="pf-row-desc warn">Same key as another action</div>` : changed ? `<div class="pf-row-desc">Default: ${esc(pretty(a.def))}</div>` : ""}</div>
        <div class="pf-row-ctl"><button class="key-cap${b ? "" : " off"}" data-key-rec="${a.id}" title="Click, then press the new keys">${esc(pretty(b))}</button>
        ${changed ? `<button class="pf-btn small" data-key-reset="${a.id}" title="Restore the default">Reset</button>` : ""}
        ${b ? `<button class="pf-btn small" data-key-off="${a.id}" title="Turn this shortcut off">Off</button>` : ""}</div></div>`;
    }
    el.innerHTML = html + `</div></details><div class="pf-row-ctl key-foot"><button class="pf-btn" data-key-reset-all>Reset all shortcuts</button></div>`;
    el.onclick = ev => {
      const t = ev.target;
      const set = (id, v) => { const o = { ...overrides() }; if (v === undefined) delete o[id]; else o[id] = v; S().set("shortcuts", o); render(el); };
      const rec = t.closest("[data-key-rec]");
      if (rec) {
        recording = rec.dataset.keyRec; rec.textContent = "Press keys..."; rec.classList.add("rec");
        const onKey = k => {
          k.preventDefault(); k.stopImmediatePropagation();
          if (k.key === "Escape") { done(); render(el); return; }
          const c = comboOf(k); if (!c) return;
          const id = recording; done();
          set(id, norm(c) === norm(byId.get(id).def) ? undefined : c);
        };
        const done = () => { window.removeEventListener("keydown", onKey, true); recording = null; };
        window.addEventListener("keydown", onKey, true);
        return;
      }
      const r = t.closest("[data-key-reset]"); if (r) return set(r.dataset.keyReset, undefined);
      const off = t.closest("[data-key-off]"); if (off) return set(off.dataset.keyOff, "");
      if (t.closest("[data-key-reset-all]")) { S().set("shortcuts", {}); render(el); }
    };
  }

  window.PiKeys = { actions: ACTIONS, bindingOf, comboOf, render, pretty };
})();
