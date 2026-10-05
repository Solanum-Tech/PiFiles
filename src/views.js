// PiFiles - the non-folder pages: Home, Gallery, Devices and Network.
// main.js owns navigation (tabs, history, which page is visible) and calls PiViews.<page>(…)
// to fill the page's container. Every page is rendered into its own <section>, so switching
// between them never rebuilds the rest of the window.
const core = () => window.__TAURI__?.core;
const invoke = (c, a) => core() ? core().invoke(c, a) : Promise.reject(new Error("no backend"));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const I = n => (window.PiIcons ? PiIcons.ui(n) : "");
const P = n => (window.PiIcons ? PiIcons.place(n) : "");
const ex = () => window.__explorer || {};
const size = b => (window.__fmtSize ? window.__fmtSize(b) : `${b} B`);
const base = p => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const pref = (k, d) => { try { const v = window.PiSettings?.get(k); return v === undefined ? d : v; } catch { return d; } };
const $ = id => document.getElementById(id);

// ------------------------------------------------------------------ shared helpers
const thumbObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target;
    thumbObserver.unobserve(img);
    const p = img.dataset.thumb;
    if (!p) continue;
    (ex().thumb ? ex().thumb(p) : Promise.resolve("")).then(url => {
      if (url) { img.src = url; img.closest(".gv-tile, .dv-card, .hv-recent-row")?.classList.add("loaded"); }
      else img.closest(".gv-tile, .dv-card")?.classList.add("nothumb");
    });
  }
}, { rootMargin: "400px 0px" });

function openItem(path, el) {
  const name = base(path);
  ex().openFile?.({ name, path, is_dir: false, size: 0, extension: (name.split(".").pop() || "").toLowerCase(), modified: "" }, el);
}
function fileMenu(e, path, isDir) {
  e.preventDefault();
  ex().showFileMenu?.(e.clientX, e.clientY, path, isDir);
}
// Single/double click follows Settings → Mouse & keyboard, like the file list.
function bindActivate(host, selector, onSelect, onOpen) {
  host.addEventListener("click", e => {
    const el = e.target.closest(selector);
    if (!el) return;
    onSelect?.(el, e);
    if (pref("openWith", "double") === "single" ? e.detail === 1 : e.detail === 2) onOpen(el, e);
  });
  host.addEventListener("keydown", e => {
    const el = e.target.closest(selector);
    if (el && e.key === "Enter") { e.preventDefault(); onOpen(el, e); }
  });
}
function monthKey(t) {
  const d = new Date(t * 1000);
  return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}

// ------------------------------------------------------------------ Home
let netCache = null;
async function home() {
  const host = $("homeView");
  const kf = ex().state?.knownFolders || {};
  const quick = [["desktop", "Desktop"], ["downloads", "Downloads"], ["documents", "Documents"], ["pictures", "Pictures"], ["music", "Music"], ["videos", "Videos"]]
    .filter(([k]) => kf[k]).map(([k, label]) => ({ k, label, path: kf[k] }));
  // The user's own folder (C:\Users\name, /Users/name, /home/name), shown by its folder name.
  if (kf.home) quick.unshift({ k: "userFolder", label: String(kf.home).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Home folder", path: kf.home });
  const drives = ex().state?.drives || [];
  const recent = (ex().recent?.() || []).slice(0, 8);
  host.innerHTML = `<div class="pv-page hv">
    <section class="hv-sec"><h2 class="hv-h">Quick access</h2>
      <div class="hv-quick">${quick.map(q => `<button class="hv-tile" data-path="${esc(q.path)}" data-dir="1" title="${esc(q.path)}"><span class="hv-tile-ico">${P(q.k)}</span><span class="hv-tile-text"><b>${esc(q.label)}</b><small>${esc(q.path)}</small></span></button>`).join("")}</div>
    </section>
    <section class="hv-sec"><h2 class="hv-h">Drives <span class="hv-count">${drives.length}</span></h2>
      <div class="hv-drives">${drives.map(driveCard).join("") || `<div class="hv-empty">No drives found</div>`}</div>
    </section>
    <section class="hv-sec"><h2 class="hv-h">Network locations <span class="hv-count" id="hvNetCount"></span><span class="grow"></span><button class="pf-btn small" data-net-refresh title="Look for network locations again">${I("refresh")}</button><button class="pf-btn small" data-net-add>${I("add")} Add network location</button></h2>
      <div class="hv-net" id="hvNet">${netCache ? netCards(netCache) : `<div class="hv-empty"><span class="spinner"></span> Looking for network locations…</div>`}</div>
    </section>
    ${recent.length ? `<section class="hv-sec"><h2 class="hv-h">Recent files<span class="grow"></span><button class="pf-btn small" data-recent-clear title="Forget recently opened files">${I("close")} Clear</button></h2><div class="hv-recent">${recent.map(r => `<button class="hv-recent-row" data-path="${esc(r.path)}" title="${esc(r.path)}"><span class="hv-recent-ico">${window.PiIcons ? PiIcons.file({ name: r.path }) : ""}</span><span class="grow"><b>${esc(base(r.path))}</b><small>${esc(r.path.replace(/[\\/][^\\/]*$/, ""))}</small></span><span class="hv-when">${esc(ex().fmtDate ? ex().fmtDate(String(Math.floor(r.t / 1000))) : "")}</span></button>`).join("")}</div></section>` : ""}
  </div>`;
  if (!netCache) loadNet();
}
function driveCard(d) {
  const total = d.total_space || 0, free = d.free_space || 0;
  const used = total ? Math.round(100 * (1 - free / total)) : 0;
  const warn = used >= 90;
  return `<button class="hv-drive" data-path="${esc(d.path)}" data-dir="1" title="${esc(d.name)}">
    <span class="hv-drive-ico">${window.PiIcons ? PiIcons.drive(d) : ""}</span>
    <span class="hv-drive-text"><b>${esc(d.name)}</b>
      <span class="hv-bar ${warn ? "warn" : ""}"><i style="width:${used}%"></i></span>
      <small>${total ? `${esc(size(free))} free of ${esc(size(total))}` : esc(d.drive_type || "")}${d.file_system ? ` • ${esc(d.file_system)}` : ""}</small></span>
  </button>`;
}
function netIcon(kind) {
  return kind === "computer" ? I("computer") : kind === "drive" ? (window.PiIcons ? PiIcons.drive({ drive_type: "Remote" }) : "") : I("server");
}
function netCards(list) {
  const saved = (pref("netLocations", []) || []).map(p => ({ name: base(p) || p, path: p, kind: "saved" }));
  const all = [...list, ...saved.filter(s => !list.some(l => l.path.toLowerCase() === s.path.toLowerCase()))];
  const c = $("hvNetCount");
  if (c) c.textContent = all.length ? String(all.length) : "";
  if (!all.length) return `<div class="hv-empty">No network locations found. Mapped drives, shortcuts added in Explorer, computers on your network and places you add here appear in this list.</div>`;
  return all.map(n => `<button class="hv-tile hv-nettile" data-path="${esc(n.path)}" data-dir="1" title="${esc(n.path)}"><span class="hv-tile-ico">${netIcon(n.kind)}</span><span class="hv-tile-text"><b>${esc(n.name)}</b><small>${esc(n.path)}</small></span>${n.kind === "saved" ? `<span class="hv-x" data-net-remove="${esc(n.path)}" title="Remove">${I("close")}</span>` : ""}</button>`).join("");
}
async function loadNet(force) {
  if (force) netCache = null;
  try { netCache = core() ? await invoke("network_locations") : [{ name: "NAS", path: "\\\\NAS", kind: "computer" }, { name: "Photos (\\\\NAS)", path: "\\\\NAS\\Photos", kind: "shortcut" }]; }
  catch { netCache = []; }
  const el = $("hvNet"); if (el) el.innerHTML = netCards(netCache);
  const el2 = $("nvNet"); if (el2) el2.innerHTML = netCards(netCache);
  renderSidebarNet();
}
function renderSidebarNet() {
  const host = $("netList");
  if (!host || !netCache) return;
  const saved = (pref("netLocations", []) || []).map(p => ({ name: base(p) || p, path: p, kind: "saved" }));
  const all = [...netCache, ...saved.filter(s => !netCache.some(l => l.path.toLowerCase() === s.path.toLowerCase()))].slice(0, 12);
  host.innerHTML = all.map(n => `<button class="nav-item nav-sub" data-netpath="${esc(n.path)}" title="${esc(n.path)}"><span class="ico">${netIcon(n.kind)}</span><span class="lbl">${esc(n.name)}</span></button>`).join("");
}
document.addEventListener("click", e => {
  const b = e.target.closest("#netList [data-netpath]");
  if (b) ex().navigateTo?.(b.dataset.netpath);
});

// ------------------------------------------------------------------ Network page
async function network() {
  const host = $("networkView");
  host.innerHTML = `<div class="pv-page hv">
    <section class="hv-sec"><h2 class="hv-h">Network locations<span class="grow"></span><button class="pf-btn small" data-net-refresh>${I("refresh")} Refresh</button><button class="pf-btn small" data-net-add>${I("add")} Add network location</button></h2>
      <div class="hv-net" id="nvNet">${netCache ? netCards(netCache) : `<div class="hv-empty"><span class="spinner"></span> Looking for network locations…</div>`}</div></section>
    <section class="hv-sec"><h2 class="hv-h">Shared from this PC</h2><div class="hv-net" id="nvShares"><div class="hv-empty"><span class="spinner"></span></div></div></section>
  </div>`;
  if (!netCache) loadNet();
  let shares = [];
  try { shares = core() ? await invoke("list_shares") : []; } catch {}
  const el = $("nvShares");
  if (el) el.innerHTML = shares.length ? shares.map(s => `<button class="hv-tile" data-path="${esc(s.path)}" data-dir="1" title="${esc(s.path)}"><span class="hv-tile-ico">${I("shareNet")}</span><span class="hv-tile-text"><b>${esc(s.name)}</b><small>${esc(s.path)}</small></span></button>`).join("")
    : `<div class="hv-empty">Nothing is shared from this PC. Right-click a folder and choose “Share on network…”.</div>`;
}

// ------------------------------------------------------------------ Gallery (+ one device)
const gal = { kind: "image", device: null, offset: 0, total: 0, loading: false, months: new Map(), token: 0, selected: null };
const MOCK = Array.from({ length: 180 }, (_, i) => ({ path: `C:\\Users\\You\\Pictures\\IMG_${2000 + i}.${i % 7 === 0 ? "mp4" : "jpg"}`, kind: i % 7 === 0 ? "video" : "image", size: 2e6 + i * 1e4, mtime: 1.79e9 - i * 86400 * 3, taken: 1.79e9 - i * 86400 * 3, device: i % 3 ? "Apple iPhone 13" : "Canon EOS R5" }));

async function gallery(opts = {}) {
  const host = $("galleryView");
  gal.kind = opts.kind || "image";
  gal.device = opts.device || null;
  gal.offset = 0; gal.total = 0; gal.months = new Map(); gal.token++; gal.selected = null;
  const tabs = gal.device ? [["all", "All"], ["image", "Photos"], ["video", "Videos"]] : [["image", "Images"], ["video", "Videos"]];
  if (gal.device && !opts.kind) gal.kind = "all";
  host.innerHTML = `<div class="gv">
    <div class="gv-head">
      ${gal.device ? `<span class="gv-dev-ico">${deviceIcon(gal.device)}</span>` : ""}
      <h2>${esc(gal.device || "Gallery")}</h2>
      <div class="pf-seg gv-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="${gal.kind === k ? "on" : ""}" aria-selected="${gal.kind === k}" data-gkind="${k}">${l}</button>`).join("")}</div>
      <span class="gv-count" id="gvCount"></span>
      <span class="grow"></span>
      <span class="gv-status" id="gvStatus"></span>
      <button class="pf-btn small" data-rescan title="Look for new photos and videos">${I("refresh")}</button>
    </div>
    <div class="gv-scroll" id="gvScroll" tabindex="0"><div id="gvBody"></div><div class="gv-sentinel" id="gvSentinel"></div></div>
  </div>`;
  const sentinel = $("gvSentinel");
  new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { root: $("gvScroll"), rootMargin: "800px 0px" }).observe(sentinel);
  await more();
  status();
}
async function more() {
  if (gal.loading || (gal.offset && gal.offset >= gal.total)) return;
  gal.loading = true;
  const token = gal.token;
  let page;
  try {
    page = core() ? await invoke("library_query", { kind: gal.kind, device: gal.device, offset: gal.offset, limit: 360 })
      : (() => { const m = MOCK.filter(i => (gal.kind === "all" || i.kind === gal.kind) && (!gal.device || i.device === gal.device)); return { items: m.slice(gal.offset, gal.offset + 360), total: m.length, scanning: false }; })();
  } catch { page = { items: [], total: 0, scanning: false }; }
  gal.loading = false;
  if (token !== gal.token) return;
  gal.total = page.total;
  gal.offset += page.items.length;
  const body = $("gvBody");
  if (!body) return;
  const cnt = $("gvCount");
  if (cnt) cnt.textContent = `${page.total.toLocaleString()} ${gal.kind === "video" ? "video" : gal.kind === "image" ? "photo" : "item"}${page.total === 1 ? "" : "s"}`;
  if (!page.total && !page.scanning) {
    body.innerHTML = `<div class="hv-empty gv-empty">${I(gal.kind === "video" ? "videoClip" : "images")}<div>No ${gal.kind === "video" ? "videos" : "photos"} found yet</div><small>PiFiles looks through your Pictures, Videos, Desktop, Downloads, Documents and other drives.</small></div>`;
    return;
  }
  for (const it of page.items) {
    const m = monthKey(it.taken || it.mtime);
    let grid = gal.months.get(m.key);
    if (!grid) {
      const sec = document.createElement("section");
      sec.className = "gv-month";
      sec.innerHTML = `<h3>${esc(m.label)}</h3><div class="gv-grid"></div>`;
      body.appendChild(sec);
      grid = sec.querySelector(".gv-grid");
      gal.months.set(m.key, grid);
    }
    const b = document.createElement("button");
    b.className = "gv-tile" + (it.kind === "video" ? " vid" : "");
    b.dataset.path = it.path;
    b.title = `${base(it.path)}${it.device ? " • " + it.device : ""}`;
    b.innerHTML = `<img alt="" data-thumb="${esc(it.path)}">${it.kind === "video" ? `<span class="gv-play">${I("play")}</span>` : ""}`;
    grid.appendChild(b);
    thumbObserver.observe(b.firstElementChild);
  }
}
async function status() {
  const el = $("gvStatus");
  if (!el || !core()) return;
  try {
    const s = await invoke("library_status");
    el.innerHTML = s.scanning ? `<span class="spinner"></span> ${s.phase === "walking" ? "Finding photos and videos…" : `Reading details (${(s.items - s.pending_metadata).toLocaleString()} of ${s.items.toLocaleString()})`}` : "";
    if (s.scanning) setTimeout(status, 1500);
  } catch {}
}
function initGallery() {
  const host = $("galleryView");
  host.addEventListener("click", e => {
    const t = e.target.closest("[data-gkind]");
    if (t) { ex().go?.(gal.device ? { k: "device", name: gal.device, tab: t.dataset.gkind } : { k: "gallery", tab: t.dataset.gkind }, { replace: true }); return; }
    if (e.target.closest("[data-rescan]")) { invoke("library_rescan").catch(() => {}); setTimeout(status, 300); window.toast?.("Looking for new photos and videos…"); }
  });
  bindActivate(host, ".gv-tile", el => {
    host.querySelectorAll(".gv-tile.sel").forEach(x => x.classList.remove("sel"));
    el.classList.add("sel");
    gal.selected = el.dataset.path;
    ex().previewPath?.(el.dataset.path);
  }, el => openItem(el.dataset.path, el.querySelector("img")));
  host.addEventListener("contextmenu", e => { const t = e.target.closest(".gv-tile"); if (t) fileMenu(e, t.dataset.path, false); });
}

// Refresh the visible gallery/devices when the library changes (new photos found, details read).
let libT = 0;
window.__TAURI__?.event?.listen?.("library://changed", () => {
  clearTimeout(libT);
  libT = setTimeout(() => {
    const loc = ex().state?.loc;
    if (!loc) return;
    if (loc.k === "devices") devices();
    else if ((loc.k === "gallery" || loc.k === "device") && $("gvScroll")?.scrollTop < 40) gallery({ kind: gal.kind, device: gal.device });
    else status();
  }, 1500);
});

// ------------------------------------------------------------------ Devices
function deviceIcon(name) {
  const s = String(name || "").toLowerCase();
  if (/iphone|ipad|pixel|galaxy|samsung|sm-|oneplus|xiaomi|redmi|poco|oppo|vivo|realme|motorola|moto |huawei|honor|nokia|phone|nothing/.test(s)) return I("phone");
  if (/gopro|dji|insta360|osmo/.test(s)) return I("videoClip");
  return I("camera");
}
async function devices() {
  const host = $("devicesView");
  let list = [], st = null;
  try {
    list = core() ? await invoke("library_devices") : [{ name: "Apple iPhone 13", count: 120, images: 110, videos: 10, cover: MOCK[1].path }, { name: "Canon EOS R5", count: 60, images: 60, videos: 0, cover: MOCK[0].path }];
    st = core() ? await invoke("library_status") : null;
  } catch {}
  const busy = st?.scanning;
  host.innerHTML = `<div class="pv-page">
    <div class="gv-head"><h2>Devices</h2><span class="gv-count">${list.length} device${list.length === 1 ? "" : "s"}</span><span class="grow"></span>
      <span class="gv-status">${busy ? `<span class="spinner"></span> ${st.phase === "walking" ? "Finding photos and videos…" : `Reading camera details (${(st.items - st.pending_metadata).toLocaleString()} of ${st.items.toLocaleString()})`}` : ""}</span></div>
    <p class="dv-note">Photos and videos grouped by the phone or camera that took them, read from each file's metadata.</p>
    <div class="dv-grid">${list.map(d => `<button class="dv-card" data-device="${esc(d.name)}" title="${esc(d.name)}">
        <span class="dv-cover"><img alt="" data-thumb="${esc(d.cover)}"></span>
        <span class="dv-text"><span class="dv-ico">${deviceIcon(d.name)}</span><span class="grow"><b>${esc(d.name)}</b><small>${[d.images ? `${d.images.toLocaleString()} photo${d.images === 1 ? "" : "s"}` : "", d.videos ? `${d.videos.toLocaleString()} video${d.videos === 1 ? "" : "s"}` : ""].filter(Boolean).join(" • ")}</small></span></span>
      </button>`).join("") || `<div class="hv-empty">${busy ? "Reading which device took each photo…" : "No camera or phone information was found in your photos and videos."}</div>`}</div>
  </div>`;
  host.querySelectorAll("img[data-thumb]").forEach(i => thumbObserver.observe(i));
  if (busy) { clearTimeout(devices._t); devices._t = setTimeout(() => { if (ex().state?.loc?.k === "devices") devices(); }, 4000); }
}
function initDevices() {
  bindActivate($("devicesView"), ".dv-card", null, el => ex().go?.({ k: "device", name: el.dataset.device }));
}

// ------------------------------------------------------------------ shared clicks (home/network)
function initHome() {
  for (const id of ["homeView", "networkView"]) {
    const host = $(id);
    bindActivate(host, "[data-path]", el => {
      host.querySelectorAll(".sel").forEach(x => x.classList.remove("sel"));
      el.classList.add("sel");
    }, (el) => el.dataset.dir ? ex().navigateTo?.(el.dataset.path) : openItem(el.dataset.path, el));
    host.addEventListener("click", async e => {
      if (e.target.closest("[data-net-add]")) { const p = await window.PiExtras?.addNetworkLocation(); if (p) loadNet(); return; }
      if (e.target.closest("[data-net-refresh]")) { loadNet(true); return; }
      if (e.target.closest("[data-recent-clear]")) { e.stopPropagation(); window.__clearRecent?.(); return; }
      const rm = e.target.closest("[data-net-remove]");
      if (rm) { e.stopPropagation(); window.PiSettings?.set("netLocations", (pref("netLocations", []) || []).filter(p => p !== rm.dataset.netRemove)); loadNet(); }
    }, true);
    host.addEventListener("contextmenu", e => { const t = e.target.closest("[data-path]"); if (t) fileMenu(e, t.dataset.path, !!t.dataset.dir); });
  }
}

initGallery();
initDevices();
initHome();
window.addEventListener("pifiles:settings", e => { if (e.detail?.key === "trackRecent" && ex().state?.loc?.k === "home") home(); });
window.addEventListener("pifiles:icons", () => { const loc = ex().state?.loc?.k; if (loc === "home") home(); if (loc === "devices") devices(); renderSidebarNet(); });
loadNet();

window.PiViews = { home, gallery, devices, network, refreshNetwork: () => loadNet(true) };
window.dispatchEvent(new CustomEvent("pifiles:views-ready"));
