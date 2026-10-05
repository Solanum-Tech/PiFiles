// PiFiles - user tags: name + colour, assigned to any files or folders.
// Stored by the backend in the app data folder (user_tags.json) so they survive reinstalls of the
// web view's storage; falls back to localStorage in the preview browser.
// Shown in the File tag column, the sidebar (click a tag to list its items), the context menu
// (Tags ▸) and Settings → Tags.
(function () {
  const core = () => window.__TAURI__?.core;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const COLORS = ["#e81123", "#f7630c", "#ffb900", "#16c60c", "#0078d4", "#8764b8", "#e3008c", "#767676"];
  const DEFAULT_TAGS = [
    { id: "t-important", name: "Important", color: "#e81123" },
    { id: "t-work", name: "Work", color: "#0078d4" },
    { id: "t-personal", name: "Personal", color: "#16c60c" },
    { id: "t-todo", name: "To do", color: "#f7630c" },
  ];
  let doc = { tags: [], files: {} };
  let loaded = false;
  const key = p => String(p || "").toLowerCase();

  async function load() {
    try {
      if (core()) doc = await core().invoke("user_tags_get");
      else doc = JSON.parse(localStorage.getItem("pf:userTags") || "null") || doc;
    } catch {}
    if (!Array.isArray(doc.tags)) doc.tags = [];
    if (!doc.files || typeof doc.files !== "object") doc.files = {};
    if (!doc.initialized) { if (!doc.tags.length) doc.tags = DEFAULT_TAGS.map(t => ({ ...t })); doc.initialized = true; persist(); }
    loaded = true;
    changed();
  }
  let saveT = 0;
  function persist() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      if (core()) core().invoke("user_tags_set", { doc }).catch(e => console.error("tags", e));
      else try { localStorage.setItem("pf:userTags", JSON.stringify(doc)); } catch {}
    }, 150);
  }
  function changed() {
    renderSidebar();
    window.dispatchEvent(new CustomEvent("pifiles:tags"));
  }

  const all = () => doc.tags;
  const get = id => doc.tags.find(t => t.id === id);
  const forPath = p => (doc.files[key(p)]?.ids || []).map(get).filter(Boolean);
  const has = (p, id) => (doc.files[key(p)]?.ids || []).includes(id);

  function setFor(path, ids) {
    const k = key(path);
    if (ids.length) doc.files[k] = { path, ids: [...new Set(ids)] };
    else delete doc.files[k];
  }
  /** Adds the tag to all paths, or removes it when every path already has it. */
  function toggle(paths, id) {
    const allHave = paths.every(p => has(p, id));
    for (const p of paths) {
      const cur = doc.files[key(p)]?.ids || [];
      setFor(p, allHave ? cur.filter(x => x !== id) : [...cur, id]);
    }
    persist(); changed();
    return !allHave;
  }
  function create(name, color) {
    name = String(name || "").trim();
    if (!name) return null;
    const existing = doc.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const t = { id: "t-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, color: color || COLORS[doc.tags.length % COLORS.length] };
    doc.tags.push(t);
    persist(); changed();
    return t;
  }
  function update(id, patch) {
    const t = get(id);
    if (!t) return;
    if (patch.name != null && String(patch.name).trim()) t.name = String(patch.name).trim();
    if (patch.color) t.color = patch.color;
    persist(); changed();
  }
  function remove(id) {
    doc.tags = doc.tags.filter(t => t.id !== id);
    for (const [k, v] of Object.entries(doc.files)) {
      v.ids = v.ids.filter(x => x !== id);
      if (!v.ids.length) delete doc.files[k];
    }
    persist(); changed();
  }
  function move(id, delta) {
    const i = doc.tags.findIndex(t => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= doc.tags.length) return;
    [doc.tags[i], doc.tags[j]] = [doc.tags[j], doc.tags[i]];
    persist(); changed();
  }
  const filesWith = id => Object.values(doc.files).filter(v => v.ids.includes(id)).map(v => v.path);
  const count = id => Object.values(doc.files).filter(v => v.ids.includes(id)).length;
  /** Keeps tags attached when items are renamed or moved inside PiFiles. */
  function rename(from, to) {
    const f = doc.files[key(from)];
    if (f) { delete doc.files[key(from)]; doc.files[key(to)] = { path: to, ids: f.ids }; }
    const prefix = key(from).replace(/\\?$/, "\\");
    for (const [k, v] of Object.entries(doc.files)) {
      if (k.startsWith(prefix)) {
        const np = to.replace(/\\?$/, "\\") + v.path.slice(prefix.length);
        delete doc.files[k];
        doc.files[key(np)] = { path: np, ids: v.ids };
      }
    }
    persist();
  }

  /** Chips for the File tag column. */
  function chips(path) {
    const ts = forPath(path);
    if (!ts.length) return "";
    if (ts.length === 1) return `<span class="pf-tagchip" style="--tc:${esc(ts[0].color)}"><i></i>${esc(ts[0].name)}</span>`;
    return `<span class="pf-tagdots" title="${esc(ts.map(t => t.name).join(", "))}">${ts.slice(0, 4).map(t => `<i style="--tc:${esc(t.color)}"></i>`).join("")}<span>${esc(ts[0].name)} +${ts.length - 1}</span></span>`;
  }

  function renderSidebar() {
    const host = document.getElementById("userTagsList");
    if (!host) return;
    const active = host.querySelector(".active")?.dataset.utag;
    host.innerHTML = doc.tags.map(t => `<button class="nav-item nav-sub ${t.id === active ? "active" : ""}" data-utag="${esc(t.id)}" title="${count(t.id)} item${count(t.id) === 1 ? "" : "s"}"><span class="ico tag-dot" style="--dot:${esc(t.color)}"></span><span class="lbl">${esc(t.name)}</span></button>`).join("");
  }

  document.addEventListener("click", e => {
    const b = e.target.closest("#userTagsList [data-utag]");
    if (b) window.__explorer?.go?.({ k: "utag", id: b.dataset.utag });
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else load();

  window.PiTags = { all, get, forPath, has, toggle, create, update, remove, move, filesWith, count, chips, rename, COLORS, get loaded() { return loaded; } };
})();
