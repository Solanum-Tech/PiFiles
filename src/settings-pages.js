// PiFiles - Settings pages that need more than rows of switches:
// Themes & icons, File handling, Context menu, Restore (previous versions) and Tags.
(function () {
  const core = () => window.__TAURI__?.core;
  const invoke = (c, a) => core() ? core().invoke(c, a) : Promise.reject(new Error("This needs the desktop app"));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const I = n => (window.PiIcons ? PiIcons.ui(n) : "");
  const S = () => window.PiSettings;
  const size = b => (window.__fmtSize ? window.__fmtSize(b) : `${b} B`);
  const row = (title, desc, ctl) => `<div class="pf-row"><div class="pf-row-text"><div class="pf-row-title">${esc(title)}</div>${desc ? `<div class="pf-row-desc">${desc}</div>` : ""}</div><div class="pf-row-ctl">${ctl}</div></div>`;
  const seg = (name, opts, cur) => `<div class="pf-seg" role="radiogroup">${opts.map(([v, l]) => `<button role="radio" aria-checked="${v === cur}" class="${v === cur ? "on" : ""}" data-${name}="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;

  // ------------------------------------------------------------- Themes & icons
  function themes(el) {
    const mode = (document.documentElement.dataset.theme || "").includes("light") ? "light" : "dark";
    const curT = S().get("themePack"), curI = S().get("iconPack");
    const tcards = PiPacks.themes().map(p => `<div class="pk-card ${p.id === curT ? "on" : ""}" data-theme-pack="${esc(p.id)}" role="radio" aria-checked="${p.id === curT}" tabindex="0">
        <div class="pk-prev pk-theme" style="--a:${PiPacks.swatches(p, mode).map(esc).join(";--x:")}">${PiPacks.swatches(p, mode).map(c => `<i style="background:${esc(c)}"></i>`).join("")}</div>
        <div class="pk-meta"><b>${esc(p.name)}</b><small>${esc(p.description || (p.author ? "by " + p.author : ""))}</small></div>
        <div class="pk-acts">${p.id !== "windows" ? `<button class="pf-btn small" data-export-theme="${esc(p.id)}" title="Export">${I("exportIco")}</button>` : ""}${!p.builtin ? `<button class="pf-btn small danger" data-del-theme="${esc(p.id)}" title="Remove">${I("delete")}</button>` : ""}</div>
      </div>`).join("");
    const icards = PiPacks.iconPacks().map(p => `<div class="pk-card ${p.id === curI ? "on" : ""}" data-icon-pack="${esc(p.id)}" role="radio" aria-checked="${p.id === curI}" tabindex="0">
        <div class="pk-prev pk-icons">${PiPacks.iconPreview(p)}</div>
        <div class="pk-meta"><b>${esc(p.name)}</b><small>${esc(p.description || (p.author ? "by " + p.author : ""))}</small></div>
        <div class="pk-acts">${p.id !== "windows" ? `<button class="pf-btn small" data-export-icons="${esc(p.id)}" title="Export">${I("exportIco")}</button>` : ""}${!p.builtin ? `<button class="pf-btn small danger" data-del-icons="${esc(p.id)}" title="Remove">${I("delete")}</button>` : ""}</div>
      </div>`).join("");
    el.innerHTML = `
      <h3>Theme</h3><div class="pk-grid" role="radiogroup" aria-label="Theme">${tcards}</div>
      <h3>Icon pack</h3><div class="pk-grid" role="radiogroup" aria-label="Icon pack">${icards}</div>
      <div class="pf-card-group">
        ${row("Icons from files", "Programs, shortcuts and .ico files show their own icon. “All file types” uses the system's icon for every type without a thumbnail.", seg("sysicons", [["off", "Off"], ["apps", "Programs & shortcuts"], ["all", "All file types"]], S().get("systemIcons")))}
        ${row("Import a theme or icon pack", "Files ending in .pftheme or .pficons", `<button class="pf-btn" data-import>${I("importIco")} Import…</button>`)}
        ${row("Create your own", "Saves the colours you see now as a .pftheme file to edit and share. The format is described in docs/packs.md.", `<button class="pf-btn" data-snapshot>${I("exportIco")} Save current colours…</button>`)}
      </div>`;
  }
  function themesClick(e) {
    const t = e.target;
    const del = t.closest("[data-del-theme],[data-del-icons]");
    if (del) { e.stopPropagation(); PiPacks.remove(del.dataset.delTheme ? "theme" : "icons", del.dataset.delTheme || del.dataset.delIcons); return; }
    const ex = t.closest("[data-export-theme],[data-export-icons]");
    if (ex) { e.stopPropagation(); PiPacks.export(ex.dataset.exportTheme ? "theme" : "icons", ex.dataset.exportTheme || ex.dataset.exportIcons); return; }
    const tp = t.closest("[data-theme-pack]"); if (tp) { S().set("themePack", tp.dataset.themePack); return; }
    const ip = t.closest("[data-icon-pack]"); if (ip) { S().set("iconPack", ip.dataset.iconPack); return; }
    const si = t.closest("[data-sysicons]"); if (si) { S().set("systemIcons", si.dataset.sysicons); return; }
    if (t.closest("[data-import]")) { PiPacks.import().then(() => S().refresh()); return; }
    if (t.closest("[data-snapshot]")) PiPacks.snapshot();
  }

  // ------------------------------------------------------------- File handling
  const CATS = [
    ["image", "Photos & images", "jpg", "JPG, PNG, HEIC, WebP, GIF, SVG…"],
    ["raw", "RAW camera photos", "cr2", "CR2, CR3, NEF, ARW, DNG, RAF…"],
    ["video", "Movies & videos", "mp4", "MP4, MKV, AVI, MOV - with subtitles and audio tracks"],
    ["audio", "Music & audio", "mp3", "MP3, FLAC, M4A, WAV, OGG…"],
    ["pdf", "PDF documents", "pdf", ""],
    ["sheet", "Spreadsheets", "xlsx", "Excel, OpenDocument, CSV - editable"],
    ["text", "Text & code", "txt", "TXT, Markdown, JSON, source code - editable"],
    ["archive", "Archives", "zip", "ZIP, 7z, RAR, TAR… - including password-protected"],
  ];
  let apps = null;
  function handling(el) {
    const per = S().get("openHandlers") || {};
    const glob = S().get("fileOpenAction");
    if (!apps && core()) invoke("default_apps", { exts: CATS.map(c => c[2]) }).then(a => { apps = a; S().currentPage === "handling" && S().refresh(); }).catch(() => { apps = {}; });
    el.innerHTML = `<div class="pf-card-group">
        ${row("By default, open files in", "Types PiFiles can't show (Word, PowerPoint, programs…) always open in their default app.", seg("global", [["viewer", "PiFiles"], ["app", "The system's default app"]], glob))}
      </div><h3>Per file type</h3><div class="pf-card-group">
      ${CATS.map(([cat, label, ext, desc]) => {
        const app = apps?.[ext]?.name;
        const cur = per[cat] || "";
        return row(label, esc(desc) + (app ? `${desc ? " • " : ""}System default: <b>${esc(app)}</b>` : ""), `<select class="pf-select" data-cat="${cat}">
          <option value="" ${!cur ? "selected" : ""}>Use the default above</option>
          <option value="viewer" ${cur === "viewer" ? "selected" : ""}>PiFiles built-in viewer</option>
          <option value="app" ${cur === "app" ? "selected" : ""}>${esc(app || "System default app")}</option></select>`);
      }).join("")}</div>
      <div class="pf-card-group">${row("Change the system's default apps", "Opens your operating system's default-apps settings", `<button class="pf-btn" data-sysdefaults>${I("open")} Open</button>`)}</div>`;
  }
  function handlingClick(e) {
    const g = e.target.closest("[data-global]"); if (g) { S().set("fileOpenAction", g.dataset.global); return; }
    if (e.target.closest("[data-sysdefaults]")) {
      invoke("open_default_apps_settings").catch(() => window.toast?.("Open your system settings → Default apps"));
    }
  }
  function handlingChange(e) {
    const s = e.target.closest("[data-cat]"); if (!s) return;
    const per = { ...(S().get("openHandlers") || {}) };
    if (s.value) per[s.dataset.cat] = s.value; else delete per[s.dataset.cat];
    S().set("openHandlers", per);
  }

  // ------------------------------------------------------------- Context menu
  function contextmenu(el) {
    const mode = S().get("systemMenu");
    const place = S().get("sysMenuPlacement") || {};
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem("pf:sysSeen") || "{}"); } catch {}
    const names = Object.keys(seen).filter(n => !/^properties$/i.test(n)).sort((a, b) => a.localeCompare(b));
    const acts = S().get("customActions") || [];
    el.innerHTML = `<div class="pf-card-group">
        ${row("System menu entries", "Commands other apps add to the right-click menu: Open in Terminal, 7-Zip, Git, Send to, Scan with…", seg("sysmode", [["submenu", "Under “Show more options”"], ["inline", "In the main menu"], ["off", "Hidden"]], mode))}
      </div>
      <h3>Entries seen on this PC</h3>
      <div class="pf-card-group">${names.length ? names.map((n, i) => { const cur = place[n] || (mode === "inline" ? "main" : "more"); return row(n, "", `${seen[n].icon ? `<img class="cm-ico" src="${esc(seen[n].icon)}" alt="">` : ""}<div class="pf-seg" role="radiogroup">${[["main", "Main menu"], ["more", "More options"], ["hidden", "Hidden"]].map(([v, l]) => `<button role="radio" aria-checked="${v === cur}" class="${v === cur ? "on" : ""}" data-place-i="${i}" data-place-v="${v}">${l}</button>`).join("")}</div>`); }).join("")
        : row("Nothing yet", "Right-click a file or folder once and the system's entries appear here so you can choose where each one goes.", "")}</div>
      <h3>Your actions</h3>
      <div class="pf-card-group cm-actions">${acts.map((a, i) => `<div class="pf-row cm-act" data-i="${i}">
          <div class="cm-fields">
            <input class="pf-text" data-f="name" value="${esc(a.name)}" placeholder="Name shown in the menu">
            <input class="pf-text" data-f="program" value="${esc(a.program)}" placeholder="Program, e.g. code or C:\\Tools\\app.exe">
            <input class="pf-text" data-f="args" value="${esc(a.args || "")}" placeholder='Arguments, e.g. "{path}"'>
            <div class="cm-row2"><select class="pf-select" data-f="on">${[["all", "Everywhere"], ["files", "Files"], ["folders", "Folders"], ["both", "Files and folders"], ["background", "Folder background"]].map(([v, l]) => `<option value="${v}" ${a.on === v ? "selected" : ""}>${l}</option>`).join("")}</select>
            <input class="pf-text" data-f="exts" value="${esc(a.exts || "")}" placeholder="Only for extensions (optional): jpg png"></div>
          </div>
          <button class="pf-btn danger small" data-del-act="${i}" title="Remove">${I("delete")}</button>
        </div>`).join("")}
        ${row("Add an action", "Placeholders: {path} the item, {paths} every selected item, {dir} its folder, {name} its name", `<button class="pf-btn" data-add-act>${I("add")} Add</button>`)}
      </div>`;
  }
  function contextClick(e) {
    const m = e.target.closest("[data-sysmode]"); if (m) { S().set("systemMenu", m.dataset.sysmode); return; }
    const pl = e.target.closest("[data-place-i]");
    if (pl) {
      let seen = {};
      try { seen = JSON.parse(localStorage.getItem("pf:sysSeen") || "{}"); } catch {}
      const names = Object.keys(seen).filter(n => !/^properties$/i.test(n)).sort((a, b) => a.localeCompare(b));
      const name = names[Number(pl.dataset.placeI)];
      if (name) { const place = { ...(S().get("sysMenuPlacement") || {}) }; place[name] = pl.dataset.placeV; S().set("sysMenuPlacement", place); }
      return;
    }
    if (e.target.closest("[data-add-act]")) { S().set("customActions", [...(S().get("customActions") || []), { id: "a" + Date.now(), name: "New action", program: "", args: "\"{path}\"", on: "files", exts: "" }]); return; }
    const d = e.target.closest("[data-del-act]");
    if (d) { const a = [...(S().get("customActions") || [])]; a.splice(Number(d.dataset.delAct), 1); S().set("customActions", a); }
  }
  function contextChange(e) {
    const f = e.target.closest("[data-f]"); if (!f) return;
    const i = Number(f.closest("[data-i]").dataset.i);
    const a = (S().get("customActions") || []).map(x => ({ ...x }));
    a[i][f.dataset.f] = f.value;
    S().set("customActions", a);
  }

  // ------------------------------------------------------------- Restore
  let vcfg = null, vstats = null;
  function restore(el) {
    if (!core()) { el.innerHTML = `<div class="pf-card-group">${row("Previous versions", "Available in the desktop app.", "")}</div>`; return; }
    if (!vcfg) { Promise.all([invoke("versions_config"), invoke("versions_stats")]).then(([c, s]) => { vcfg = c; vstats = s; S().refresh(); }).catch(e => { el.textContent = String(e); }); el.innerHTML = `<div class="pf-card-group">${row("Loading…", "", `<span class="spinner"></span>`)}</div>`; return; }
    const c = vcfg, s = vstats || {};
    const saved = s.logical_bytes > s.stored_bytes ? Math.round(100 * (1 - s.stored_bytes / s.logical_bytes)) : 0;
    el.innerHTML = `<div class="pf-card-group">
        ${row("Keep previous versions of my files", "Lets you restore a file to how it was before a change, or bring back a deleted one (right-click → Restore previous versions). Like Windows' Previous Versions and macOS Time Machine.", `<button class="pf-switch ${c.enabled ? "on" : ""}" role="switch" aria-checked="${c.enabled}" data-v-enabled><span class="pf-switch-label">${c.enabled ? "On" : "Off"}</span><span class="pf-knob"></span></button>`)}
        ${row("Where versions are kept", `${esc(c.store)}<br>A different drive protects against disk failure too.`, `<button class="pf-btn" data-v-store>${I("openFolder")} Change…</button>`)}
      </div>
      <h3>Protected folders</h3>
      <div class="pf-card-group">${(c.protected || []).map((p, i) => row(p, "", `<button class="pf-btn small" data-v-unprotect="${i}">${I("close")} Remove</button>`)).join("")}
        ${row("Add a folder", "Every file in it gets a first version now; after that only changes are stored.", `<button class="pf-btn" data-v-protect>${I("add")} Add folder…</button>`)}</div>
      <h3>Storage</h3>
      <div class="pf-card-group">
        ${row("Space used", `${(s.files || 0).toLocaleString()} files • ${(s.versions || 0).toLocaleString()} versions • ${esc(size(s.stored_bytes || 0))} on disk for ${esc(size(s.logical_bytes || 0))} of file content${saved ? ` (<b>${saved}% saved</b> by compression and de-duplication)` : ""}${s.baseline_running ? " • saving first versions…" : ""}`, `<button class="pf-btn" data-v-refresh>${I("refresh")}</button>`)}
        ${row("How it stays small", "Files are split into chunks that are compressed and stored once. Editing part of a big file saves only the chunks that changed; identical files share everything.", "")}
        ${row("Versions kept per file", "", `<select class="pf-select" data-v-keep>${[5, 10, 20, 30, 50, 100].map(n => `<option ${c.keep === n ? "selected" : ""}>${n}</option>`).join("")}</select>`)}
        ${row("Skip files larger than", "", `<select class="pf-select" data-v-max>${[[100, "100 MB"], [512, "512 MB"], [1024, "1 GB"], [4096, "4 GB"], [16384, "16 GB"]].map(([v, l]) => `<option value="${v}" ${c.max_file_mb === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
        ${row("Watch for changes by other apps", "When off, versions are only saved when PiFiles itself changes or deletes a file.", `<button class="pf-switch ${c.watch ? "on" : ""}" role="switch" aria-checked="${c.watch}" data-v-watch><span class="pf-switch-label">${c.watch ? "On" : "Off"}</span><span class="pf-knob"></span></button>`)}
        ${row("Clean up", "Frees space from versions that are no longer kept", `<button class="pf-btn" data-v-clean>${I("delete")} Clean up</button>`)}
      </div>`;
  }
  async function saveV(patch) {
    try { vcfg = await invoke("versions_set_config", { config: { ...vcfg, ...patch } }); vstats = await invoke("versions_stats"); }
    catch (e) { window.toast?.(String(e?.message || e)); }
    S().refresh();
  }
  async function restoreClick(e) {
    const t = e.target;
    if (t.closest("[data-v-enabled]")) return saveV({ enabled: !vcfg.enabled });
    if (t.closest("[data-v-watch]")) return saveV({ watch: !vcfg.watch });
    if (t.closest("[data-v-store]")) { const d = await invoke("pick_folder", { title: "Keep previous versions in…", start: vcfg.store }).catch(() => null); if (d) saveV({ store: d.replace(/[\\/]$/, "") + "\\PiFiles Versions" }); return; }
    if (t.closest("[data-v-protect]")) { const d = await invoke("pick_folder", { title: "Protect this folder", start: null }).catch(() => null); if (d && !vcfg.protected.includes(d)) saveV({ protected: [...vcfg.protected, d] }); return; }
    const u = t.closest("[data-v-unprotect]"); if (u) { const p = [...vcfg.protected]; p.splice(Number(u.dataset.vUnprotect), 1); return saveV({ protected: p }); }
    if (t.closest("[data-v-refresh]")) { vstats = await invoke("versions_stats").catch(() => vstats); S().refresh(); return; }
    if (t.closest("[data-v-clean]")) { const freed = await invoke("versions_cleanup").catch(() => 0); window.toast?.(`Freed ${size(freed)}`); vstats = await invoke("versions_stats").catch(() => vstats); S().refresh(); }
  }
  function restoreChange(e) {
    if (e.target.matches("[data-v-keep]")) saveV({ keep: Number(e.target.value) });
    if (e.target.matches("[data-v-max]")) saveV({ max_file_mb: Number(e.target.value) });
  }

  // ------------------------------------------------------------- Tags
  function tags(el) {
    const list = window.PiTags?.all() || [];
    el.innerHTML = `<p class="pf-muted">Tags label files and folders anywhere on your PC. Right-click an item → Tags to apply them; the sidebar lists everything with a tag.</p>
      <div class="pf-card-group">${list.map((t, i) => `<div class="pf-row tg-row" data-id="${esc(t.id)}">
          <label class="tg-color" style="--tc:${esc(t.color)}" title="Colour"><input type="color" value="${esc(t.color)}" data-tag-color></label>
          <input class="pf-text tg-name" value="${esc(t.name)}" data-tag-name aria-label="Tag name">
          <span class="pf-muted tg-count">${PiTags.count(t.id).toLocaleString()} item${PiTags.count(t.id) === 1 ? "" : "s"}</span>
          <button class="pf-btn small" data-tag-up ${i === 0 ? "disabled" : ""} title="Move up">${I("up")}</button>
          <button class="pf-btn small danger" data-tag-del title="Delete tag">${I("delete")}</button>
        </div>`).join("")}
        <div class="pf-row tg-new"><div class="tg-swatches">${PiTags.COLORS.map((c, i) => `<button class="pf-sw ${i === 0 ? "on" : ""}" style="--sw:${c}" data-new-color="${c}" title="${c}"></button>`).join("")}</div>
          <input class="pf-text tg-name" placeholder="New tag name" data-new-name><button class="pf-btn" data-tag-add>${I("add")} Add tag</button></div>
      </div>`;
  }
  let newColor = null;
  async function tagsClick(e) {
    const t = e.target, row = t.closest("[data-id]");
    if (t.closest("[data-new-color]")) { newColor = t.closest("[data-new-color]").dataset.newColor; t.closest(".tg-swatches").querySelectorAll(".pf-sw").forEach(b => b.classList.toggle("on", b.dataset.newColor === newColor)); return; }
    if (t.closest("[data-tag-add]")) { const inp = t.closest(".pf-row").querySelector("[data-new-name]"); if (PiTags.create(inp.value, newColor)) S().refresh(); else inp.focus(); return; }
    if (!row) return;
    if (t.closest("[data-tag-up]")) { PiTags.move(row.dataset.id, -1); S().refresh(); return; }
    if (t.closest("[data-tag-del]")) {
      const tag = PiTags.get(row.dataset.id);
      const n = PiTags.count(row.dataset.id);
      if (n && !(await PiDialog.confirm({ title: `Delete “${tag.name}”?`, message: `It's removed from ${n} item${n === 1 ? "" : "s"}. The files themselves aren't touched.`, okText: "Delete tag", danger: true }))) return;
      PiTags.remove(row.dataset.id); S().refresh();
    }
  }
  function tagsChange(e) {
    const row = e.target.closest("[data-id]");
    if (row && e.target.matches("[data-tag-name]")) PiTags.update(row.dataset.id, { name: e.target.value });
    if (row && e.target.matches("[data-tag-color]")) { PiTags.update(row.dataset.id, { color: e.target.value }); row.querySelector(".tg-color").style.setProperty("--tc", e.target.value); }
  }
  function tagsKey(e) { if (e.key === "Enter" && e.target.matches("[data-new-name]")) e.target.closest(".pf-row").querySelector("[data-tag-add]").click(); }

  // ------------------------------------------------------------- Updates
  const upd = { info: null, result: null, error: "", busy: "", progress: null, lastChecked: (() => { try { return Number(localStorage.getItem("pf:updChecked")) || 0; } catch { return 0; } })() };
  const updRefresh = () => S()?.currentPage === "about" && S().refresh();
  async function checkUpdates(silent) {
    if (!core()) { upd.error = "Updates are checked by the desktop app"; updRefresh(); return null; }
    upd.busy = "check"; upd.error = ""; updRefresh();
    try {
      upd.result = await invoke("update_check", { channel: S().get("updateChannel") });
      upd.lastChecked = Date.now(); try { localStorage.setItem("pf:updChecked", String(upd.lastChecked)); } catch {}
      if (silent && upd.result.available) {
        window.toast?.(`PiFiles ${upd.result.version} is available - see Settings › About`);
        document.documentElement.classList.add("pf-update-available");
      }
    } catch (e) { if (!silent) upd.error = String(e?.message || e); }
    upd.busy = ""; updRefresh();
    return upd.result;
  }
  async function installUpdate() {
    upd.busy = "install"; upd.error = ""; S().refresh();
    const un = await window.__TAURI__?.event?.listen?.("update://progress", e => {
      const p = e.payload, bar = document.querySelector("[data-upd-bar]"), t = document.querySelector("[data-upd-pct]");
      if (bar && p.total) bar.style.width = Math.round(p.downloaded / p.total * 100) + "%";
      if (t) t.textContent = p.done ? "Installing…" : p.total ? `${size(p.downloaded)} of ${size(p.total)}` : size(p.downloaded);
    });
    try { await invoke("update_install"); upd.busy = "restart"; }
    catch (e) { upd.error = String(e?.message || e); upd.busy = ""; }
    un?.(); S().refresh();
  }
  function updates(el) {
    if (!upd.info && core()) invoke("app_info").then(i => { upd.info = i; updRefresh(); }).catch(() => {});
    const r = upd.result, ver = upd.info?.version || "0.1.0";
    const when = upd.lastChecked ? new Date(upd.lastChecked).toLocaleString() : "never";
    const store = d => d === "msstore" ? "the Microsoft Store" : d === "winget" ? "winget (winget upgrade PiFiles)" : "your package manager";
    let status;
    if (upd.busy === "check") status = `<div class="upd-status"><span class="lm-spin"></span> Checking GitHub for a newer version…</div>`;
    else if (upd.busy === "install") status = `<div class="upd-status col"><b>Downloading PiFiles ${esc(r?.version || "")}</b><div class="upd-bar"><i data-upd-bar></i></div><small data-upd-pct>Starting…</small></div>`;
    else if (upd.busy === "restart") status = `<div class="upd-status ok">${I("done")} Update installed. <button class="pf-btn primary" data-upd-restart>Restart PiFiles</button></div>`;
    else if (upd.error) status = `<div class="upd-status err">${I("warning")} ${esc(upd.error)}</div>`;
    else if (r && r.available) status = `<div class="upd-status col"><div class="upd-new">${I("done")} <b>PiFiles ${esc(r.version)}</b> is available${r.date ? ` <small>· ${esc(new Date(r.date).toLocaleDateString())}</small>` : ""}</div>
        ${r.notes ? `<div class="upd-notes">${esc(r.notes)}</div>` : ""}
        ${r.can_install ? `<button class="pf-btn primary" data-upd-install>${I("save")} Download and install</button>` : `<small class="pf-muted">This copy is updated by ${esc(store(r.distribution))}.</small>`}</div>`;
    else if (r) status = `<div class="upd-status ok">${I("done")} You're up to date.</div>`;
    else status = `<div class="upd-status">Not checked yet.</div>`;
    const auto = !!S().get("updateCheck");
    el.innerHTML = `
      <div class="pf-card-group">
        ${row("Version " + ver, `Last checked: ${esc(when)}${upd.info ? ` · ${esc(upd.info.platform)} ${esc(upd.info.arch)} · ${esc(upd.info.distribution)}` : ""}`, `<button class="pf-btn" data-upd-check ${upd.busy ? "disabled" : ""}>${I("refresh")} Check for updates</button>`)}
        <div class="pf-row upd-row">${status}</div>
      </div>
      <div class="pf-card-group">
        ${row("Check automatically", "Look for a new version shortly after PiFiles starts (at most once a day)", `<button class="pf-switch ${auto ? "on" : ""}" role="switch" aria-checked="${auto}" data-upd-auto><span class="pf-switch-label">${auto ? "On" : "Off"}</span><span class="pf-knob"></span></button>`)}
        ${row("Update channel", "Beta gets new features first and may be less stable", seg("updch", [["stable", "Stable"], ["beta", "Beta"]], S().get("updateChannel")))}
      </div>
      <p class="pf-muted">Updates come from the GitHub releases of Solanum-Tech/PiFiles and are verified with PiFiles' signing key before they install, so a tampered download is rejected.</p>`;
  }
  function updatesClick(e) {
    const t = e.target;
    if (t.closest("[data-upd-check]")) { upd.result = null; checkUpdates(false); }
    else if (t.closest("[data-upd-install]")) installUpdate();
    else if (t.closest("[data-upd-restart]")) invoke("app_restart");
    else if (t.closest("[data-upd-auto]")) { S().set("updateCheck", !S().get("updateCheck")); S().refresh(); }
    else if (t.closest("[data-updch]")) { S().set("updateChannel", t.closest("[data-updch]").dataset.updch); upd.result = null; S().refresh(); }
  }
  // Silent check ~45 s after start-up, at most once a day.
  setTimeout(() => {
    try { if (core() && S()?.get("updateCheck") && Date.now() - upd.lastChecked > 20 * 3600 * 1000) checkUpdates(true); } catch {}
  }, 45000);

  // ------------------------------------------------------------- wiring
  const PAGES = {
    themes: [themes, themesClick],
    handling: [handling, handlingClick, handlingChange],
    contextmenu: [contextmenu, contextClick, contextChange],
    restore: [restore, restoreClick, restoreChange],
    tags: [tags, tagsClick, tagsChange, tagsKey],
  };
  function define() {
    if (!window.PiSettings?.definePage) return;
    for (const [id, [render, click, change, key]] of Object.entries(PAGES)) {
      PiSettings.definePage(id, (el) => {
        render(el);
        el.onclick = click || null;
        el.onchange = change || null;
        el.onkeydown = key || null;
      });
    }
  }
  define();
  // Updates live in a section of the About page.
  window.PiSettings?.defineEmbed?.("updates", el => { updates(el); el.onclick = updatesClick; });
  window.addEventListener("pifiles:packs", () => S()?.currentPage === "themes" && S().refresh());
  window.addEventListener("pifiles:tags", () => { const a = document.activeElement; if (S()?.currentPage === "tags" && !(a && a.matches?.("[data-tag-name],[data-new-name]"))) S().refresh(); });
})();
