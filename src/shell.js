// PiFiles shell - behaviour for the Files-style chrome (runs after main.js).
// Icons, collapsible navigation sections, sortable column headers, the "New" menu,
// copy-path / properties commands, navigation-pane collapse and the Settings entry points.

const invoke = (cmd, args) => window.__TAURI__?.core?.invoke(cmd, args) ?? Promise.reject(new Error("no backend"));
const toast = (msg) => window.toast?.(msg);
const explorer = () => window.__explorer || {};

// ---------- icons ----------
function fillIcons(root = document) {
  if (!window.PiIcons) return;
  root.querySelectorAll("[data-icon]").forEach(el => {
    if (el.dataset.iconDone) return;
    const [kind, name] = el.dataset.icon.split(":");
    el.innerHTML = kind === "place" ? PiIcons.place(name) : PiIcons.ui(name);
    el.dataset.iconDone = "1";
  });
}

// ---------- settings entry points ----------
document.addEventListener("click", e => {
  const t = e.target.closest("[data-open-settings]");
  if (t) PiSettings.open(t.dataset.openSettings || null, t);
});
document.addEventListener("keydown", e => {
  if (e.ctrlKey && e.key === ",") { e.preventDefault(); PiSettings.open(null, document.querySelector(".sidebar-foot [data-open-settings]")); }
});

// Navigation pane: on desktop widths the title-bar button collapses the pane (like Files);
// narrow windows keep main.js's slide-over behaviour.
document.getElementById("sidebarToggle")?.addEventListener("click", e => {
  if (window.innerWidth > 720) {
    e.stopImmediatePropagation();
    PiSettings.set("sidebarCollapsed", !PiSettings.get("sidebarCollapsed"));
  }
}, true);

document.querySelectorAll("[data-toggle-section]").forEach(btn =>
  btn.addEventListener("click", () => PiSettings.toggleSection(btn.dataset.toggleSection)));

// ---------- sortable column headers ----------
const sortSelect = document.getElementById("sortSelect");
function updateSortIndicators() {
  if (!sortSelect) return;
  const [key, dir] = sortSelect.value.split("-");
  document.querySelectorAll("#fileHeader [data-sort]").forEach(h => {
    const on = h.dataset.sort === key;
    h.classList.toggle("sorted", on);
    h.classList.toggle("desc", on && dir === "desc"); // CSS flips the chevron for ascending
    h.querySelector(".sort-ind").innerHTML = on ? PiIcons.ui("chevronDown") : "";
  });
}
document.getElementById("fileHeader")?.addEventListener("click", e => {
  const h = e.target.closest("[data-sort]");
  if (!h || !sortSelect) return;
  const [key, dir] = sortSelect.value.split("-");
  const k = h.dataset.sort;
  // First click: natural direction (names A→Z, newest/largest first); second click flips it.
  const natural = k === "date" || k === "size" ? "desc" : "asc";
  const next = key === k ? (dir === "asc" ? "desc" : "asc") : natural;
  sortSelect.value = `${k}-${next}`;
  sortSelect.dispatchEvent(new Event("change"));
});
sortSelect?.addEventListener("change", updateSortIndicators);

// Header checkbox mirrors the selection; clicking it selects all / clears.
const headerCheck = document.getElementById("headerCheck");
function syncHeaderCheck() {
  const st = explorer().state;
  if (!st || !headerCheck) return;
  const n = st.selected?.size || 0;
  const total = document.querySelectorAll("#fileContainer .file-row, #fileContainer .file-card").length;
  headerCheck.classList.toggle("on", n > 0 && n >= total);
  headerCheck.classList.toggle("partial", n > 0 && n < total);
}
headerCheck?.addEventListener("click", () => {
  const ex = explorer();
  if (ex.state?.selected?.size) ex.clearSelection?.();
  else document.getElementById("selectAllBtn")?.click();
  setTimeout(syncHeaderCheck, 0);
});
const selCount = document.getElementById("selectionCount");
if (selCount) new MutationObserver(syncHeaderCheck).observe(selCount, { attributes: true, childList: true, characterData: true, subtree: true });

// ---------- New menu ----------
let menu = null;
function closeMenu() { menu?.remove(); menu = null; }
function openNewMenu(anchor) {
  closeMenu();
  menu = document.createElement("div");
  menu.className = "ctx-menu pf-flyout";
  menu.setAttribute("role", "menu");
  const items = [
    ["newFolder", "Folder", () => explorer().doCreateFolder?.()],
    ["newFile", "Text document", () => createFile("New Text Document.txt")],
    ["newFile", "Empty file…", () => createFile("")],
  ];
  menu.innerHTML = items.map(([ico, label], i) =>
    `<button class="ctx-item" role="menuitem" data-i="${i}"><span class="ctx-ico">${PiIcons.ui(ico)}</span>${label}</button>`).join("");
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.addEventListener("click", e => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    closeMenu();
    items[Number(b.dataset.i)][2]();
  });
}
document.addEventListener("click", e => { if (menu && !e.target.closest(".pf-flyout, #newBtn")) closeMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
document.getElementById("newBtn")?.addEventListener("click", e => {
  e.stopImmediatePropagation(); // replaces main.js's direct "new folder" action with the menu
  menu ? closeMenu() : openNewMenu(e.currentTarget);
}, true);

async function createFile(suggested) {
  const ex = explorer();
  const dir = ex.state?.path;
  if (!dir) { toast("Open a folder first"); return; }
  const name = ((await PiDialog.prompt({ title: "New file", message: "Name the new file", value: suggested || "New file", okText: "Create", selectBaseName: true, origin: document.getElementById("newBtn") })) || "").trim();
  if (!name) return;
  if (/[\\/:*?"<>|]/.test(name)) { toast('A file name can\'t contain \\ / : * ? " < > |'); return; }
  const full = dir.replace(/\\$/, "") + "\\" + name;
  try {
    await invoke("create_file", { path: full });
    toast(`Created "${name}"`);
    await ex.loadDir?.(dir);
  } catch (err) {
    toast("Couldn't create file: " + (err?.message || err));
  }
}

// ---------- share / properties ----------
// Share: the system share sheet for the selection (or the open folder).
document.getElementById("shareBtn")?.addEventListener("click", () => {
  const st = explorer().state;
  const paths = st?.selected?.size ? [...st.selected] : [st?.loc?.k === "dir" ? st.path : ""].filter(Boolean);
  window.PiExtras?.share(paths);
});
window.__createFile = createFile;

function showProperties() {
  // Same as Alt+Enter: the separate Properties window for the selection (or the open folder).
  const st = window.__explorer?.state;
  const paths = st ? (st.selected.size ? [...st.selected] : (st.loc?.k === "dir" ? [st.path] : [])) : [];
  window.__openProperties?.(paths);
}
document.getElementById("propertiesBtn")?.addEventListener("click", showProperties);

// ---------- boot ----------
function init() {
  fillIcons();
  updateSortIndicators();
  syncHeaderCheck();
  // Toolbar buttons created later (e.g. by main.js) get icons too.
  new MutationObserver(() => fillIcons()).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("pifiles:settings", () => syncHeaderCheck());
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
