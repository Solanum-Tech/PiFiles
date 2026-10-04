// PiFiles built-in viewers: movies & music (FFmpeg-backed), archives (ZIP/7z/RAR/TAR… with passwords)
// and spreadsheets (Excel/ODS/CSV). main.js's openViewer() delegates to PiViewer.render() for these.
(function () {
  const invoke = (c, a) => window.__TAURI__?.core?.invoke(c, a) ?? Promise.reject(new Error("no backend"));
  const I = (n) => (window.PiIcons ? PiIcons.ui(n) : "");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pref = (k, d) => { try { const v = window.PiSettings?.get(k); return v === undefined ? d : v; } catch { return d; } };
  const toast = (m) => window.toast?.(m);
  const extOf = (name) => String(name || "").split(".").pop().toLowerCase();
  const lower = (s) => String(s || "").toLowerCase();
  // Local media always goes through the asset protocol with the path percent-encoded (the same
  // URL Tauri's convertFileSrc builds), so a raw path or other URL never becomes a media source.
  const assetMediaUrl = (p) => {
    const enc = encodeURIComponent(String(p));
    return /Windows|Android/.test(navigator.userAgent) ? `http://asset.localhost/${enc}` : `asset://localhost/${enc}`;
  };

  const VIDEO = new Set(["mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "mts", "3gp", "ogv", "vob", "divx", "rmvb", "asf"]);
  const AUDIO = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "ac3", "eac3", "dts", "ape", "alac", "aiff", "aif", "mka", "weba", "amr"]);
  const ARCHIVE = new Set(["zip", "jar", "apk", "xpi", "epub", "cbz", "war", "appx", "nupkg", "vsix", "7z", "cb7", "rar", "cbr", "tar", "cbt", "gz", "tgz", "bz2", "tbz", "tbz2", "xz", "txz"]);
  const DOC = new Set(["docx", "docm", "dotx", "dotm", "odt", "ott", "odp", "otp", "pptx", "pptm", "ppsx", "potx", "rtf", "doc", "ppt", "pps"]);
  const SHEET = new Set(["xlsx", "xlsm", "xlsb", "xls", "xla", "xlam", "ods", "csv", "tsv"]);

  function kind(file) {
    if (!file || file.is_dir) return null;
    const e = extOf(file.name || file.path);
    if (VIDEO.has(e)) return "video";
    if (AUDIO.has(e)) return "audio";
    if (ARCHIVE.has(e)) return "archive";
    if (SHEET.has(e)) return "sheet";
    if (DOC.has(e)) return "doc";
    if (TEXT.has(e) || /^(readme|license|licence|changelog|makefile|dockerfile)$/i.test(file.name || "")) return "text";
    return null;
  }

  let active = null;
  function dispose() { try { active?.dispose?.(); } catch (e) { console.error(e); } active = null; }

  const spinner = (text) => `<div class="pv-state"><span class="spinner"></span><span>${esc(text)}</span></div>`;
  const failure = (title, detail, file) => `<div class="pv-state pv-error">
      <div class="pv-state-ico">${I("warning")}</div><div class="pv-state-title">${esc(title)}</div>
      ${detail ? `<div class="pv-state-detail">${esc(detail)}</div>` : ""}
      ${file ? `<button class="pf-btn" data-open-external>${I("open")} Open with default app</button>` : ""}</div>`;
  function wireExternal(host, file) {
    host.querySelector("[data-open-external]")?.addEventListener("click", () => window.__openExternal?.(file.path));
  }

  // ---------- passwords ----------
  const passwords = new Map(); // archive path -> password that worked (this session only)
  async function withPassword(file, fn) {
    let pw = passwords.get(file.path) ?? null;
    let error = null;
    for (;;) {
      try {
        const r = await fn(pw);
        if (pw != null) passwords.set(file.path, pw);
        return r;
      } catch (e) {
        const m = String(e?.message || e);
        if (m !== "PASSWORD_REQUIRED" && m !== "WRONG_PASSWORD") throw e;
        if (m === "WRONG_PASSWORD" && pw != null) error = "That password isn't correct. Try again.";
        passwords.delete(file.path);
        pw = await PiDialog.prompt({
          title: "Password required",
          message: `"${file.name}" is protected. Enter its password to continue.`,
          password: true, placeholder: "Password", okText: "Unlock", error,
        });
        if (pw === null) throw new Error("CANCELLED");
      }
    }
  }

  // ======================================================================
  // Archives
  // ======================================================================
  function buildTree(entries) {
    const root = { name: "", dirs: new Map(), files: [] };
    for (const e of entries) {
      const parts = e.name.replace(/\\/g, "/").split("/").filter(Boolean);
      if (!parts.length) continue;
      let node = root;
      const last = e.is_dir ? parts.length : parts.length - 1;
      for (let i = 0; i < last; i++) {
        if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], dirs: new Map(), files: [] });
        node = node.dirs.get(parts[i]);
      }
      if (!e.is_dir) node.files.push({ ...e, base: parts[parts.length - 1] });
    }
    return root;
  }
  const countFiles = (n) => n.files.length + [...n.dirs.values()].reduce((s, d) => s + countFiles(d), 0);

  // Remembered position inside each archive (folder names from the root), so coming back from a
  // previewed file returns to the folder it was in, not the archive root.
  const archivePlaces = new Map();

  async function renderArchive(file, host, ctx) {
    host.innerHTML = spinner("Reading archive…");
    let listing;
    try {
      listing = await withPassword(file, (pw) => invoke("archive_list", { path: file.path, password: pw }));
    } catch (e) {
      if (String(e?.message || e) === "CANCELLED") { host.innerHTML = failure("Locked archive", "A password is needed to see what's inside.", file); wireExternal(host, file); return; }
      host.innerHTML = failure("Can't open this archive", String(e?.message || e), file); wireExternal(host, file); return;
    }
    const tree = buildTree(listing.entries);
    let trail = [tree];
    for (const name of archivePlaces.get(file.path) || []) {
      const next = trail[trail.length - 1].dirs.get(name);
      if (!next) break;
      trail.push(next);
    }
    let selection = new Set(); // keys: "d:<name>" | "f:<entry name>"
    let anchor = -1;
    let focusIdx = -1;
    const remember = () => archivePlaces.set(file.path, trail.slice(1).map(n => n.name));
    const basePath = () => trail.slice(1).map(n => n.name).join("/");
    const rowsNow = () => [...host.querySelectorAll(".pv-row")];

    const draw = () => {
      remember();
      const node = trail[trail.length - 1];
      const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
      const files = [...node.files].sort((a, b) => a.base.localeCompare(b.base));
      const crumbs = trail.map((n, i) => `<button class="pv-crumb" data-depth="${i}">${i === 0 ? esc(file.name) : esc(n.name)}</button>`).join(`<span class="pv-crumb-sep">${I("chevronRight")}</span>`);
      const n = selection.size;
      host.innerHTML = `<div class="pv-archive">
        <div class="pv-bar">
          <button class="pv-icon-btn" data-up ${trail.length === 1 ? "disabled" : ""} title="Up one level (Backspace)">${I("upLevel")}</button>
          <div class="pv-crumbs">${crumbs}</div>
          <span class="pv-pill">${esc(listing.format)}</span>
          <span class="pv-pill">${listing.entries.filter(e => !e.is_dir).length.toLocaleString()} files</span>
          ${listing.encrypted || passwords.has(file.path) ? `<span class="pv-pill pv-lock" title="Password protected">${I("lock")} Protected</span>` : ""}
          <button class="pf-btn" data-extract-here title="Extract everything into a new folder next to the archive">${I("extract")} Extract here</button>
          <button class="pf-btn pv-primary" data-extract-to title="Choose where to extract">${I("openFolder")} ${n ? `Extract ${n} item${n === 1 ? "" : "s"}…` : "Extract all to…"}</button>
        </div>
        ${listing.truncated ? `<div class="pv-note">Showing the first ${listing.entries.length.toLocaleString()} entries.</div>` : ""}
        <div class="pv-list pv-selectable" role="listbox" aria-multiselectable="true" tabindex="0">
          <div class="pv-row pv-head"><span class="pv-check ${n && n === dirs.length + files.length ? "on" : n ? "partial" : ""}" data-check-all title="Select all (Ctrl+A)"></span><span></span><span class="pv-name">Name</span><span class="pv-meta">Size</span></div>
          ${dirs.map(d => { const k = "d:" + d.name; return `<div class="pv-row ${selection.has(k) ? "selected" : ""}" data-key="${esc(k)}" data-dir="${esc(d.name)}" role="option" aria-selected="${selection.has(k)}"><span class="pv-check ${selection.has(k) ? "on" : ""}"></span><span class="pv-ico">${PiIcons.folder()}</span><span class="pv-name">${esc(d.name)}</span><span class="pv-meta">${countFiles(d)} item${countFiles(d) === 1 ? "" : "s"}</span></div>`; }).join("")}
          ${files.map(f => { const k = "f:" + f.name; return `<div class="pv-row ${selection.has(k) ? "selected" : ""}" data-key="${esc(k)}" data-file="${esc(f.name)}" role="option" aria-selected="${selection.has(k)}"><span class="pv-check ${selection.has(k) ? "on" : ""}"></span><span class="pv-ico">${PiIcons.file({ name: f.base })}</span><span class="pv-name">${esc(f.base)}${f.encrypted ? ` <span class="pv-lock-inline" title="Encrypted">${I("lock")}</span>` : ""}</span><span class="pv-meta">${f.size ? window.__fmtSize?.(f.size) ?? f.size : ""}</span></div>`; }).join("")}
          ${!dirs.length && !files.length ? `<div class="pv-empty">This folder is empty</div>` : ""}
        </div>
        <div class="pv-hint">${pref("openWith", "double") === "single" ? "Click" : "Double-click"} to open • Ctrl/Shift+click to select several • Backspace goes up a level</div>
      </div>`;
      host.querySelector(".pv-list")?.focus({ preventScroll: true });
    };

    const enter = (name) => { trail.push(trail[trail.length - 1].dirs.get(name)); selection.clear(); anchor = focusIdx = -1; draw(); };
    const up = () => { if (trail.length > 1) { const from = trail.pop().name; selection = new Set(["d:" + from]); draw(); } };

    const openRow = async (row) => {
      if (row.dataset.dir) { enter(row.dataset.dir); return; }
      const entry = row.dataset.file;
      row.classList.add("pv-busy");
      try {
        const tmp = await withPassword(file, (pw) => invoke("archive_extract_entry", { path: file.path, entry, password: pw }));
        const name = entry.split("/").pop();
        ctx.openInner?.({ name, path: tmp, is_dir: false, size: 0, extension: extOf(name), modified: "", backTo: file });
      } catch (e) {
        if (String(e?.message || e) !== "CANCELLED") toast("Couldn't preview: " + (e?.message || e));
      } finally { row.classList.remove("pv-busy"); }
    };

    // Entries for the selection: folders as "path/" prefixes, files by their full entry name.
    const selectedEntries = () => [...selection].map(k => k.startsWith("d:") ? (basePath() ? basePath() + "/" : "") + k.slice(2) + "/" : k.slice(2));

    async function extract(where, btn) {
      let dest = null;
      if (where === "to") {
        const parent = file.path.replace(/[\\/][^\\/]*$/, "");
        dest = await invoke("pick_folder", { title: selection.size ? "Extract the selected items to…" : `Extract “${file.name}” to…`, start: parent }).catch(() => null);
        if (!dest) return;
      }
      const label = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Extracting…`;
      try {
        if (where === "here") {
          const r = await withPassword(file, (pw) => invoke("archive_extract_all", { path: file.path, password: pw }));
          toast(`Extracted ${r.count} file${r.count === 1 ? "" : "s"} to ${r.dest}`);
          ctx.navigate?.(r.dest);
        } else {
          const entries = selection.size ? selectedEntries() : [];
          const count = await withPassword(file, (pw) => invoke("archive_extract_selected", { path: file.path, entries, base: selection.size ? basePath() : "", dest, password: pw }));
          toast(`Extracted ${count} file${count === 1 ? "" : "s"} to ${dest}`);
          ctx.navigate?.(dest);
        }
      } catch (err) {
        if (String(err?.message || err) !== "CANCELLED") toast("Extract failed: " + (err?.message || err));
      } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
    }

    const setSel = (keys) => {
      selection = new Set(keys);
      rowsNow().forEach(r => {
        if (!r.dataset.key) return;
        const on = selection.has(r.dataset.key);
        r.classList.toggle("selected", on);
        r.setAttribute("aria-selected", String(on));
        r.querySelector(".pv-check")?.classList.toggle("on", on);
      });
      const all = rowsNow().filter(r => r.dataset.key).length;
      const ca = host.querySelector("[data-check-all]");
      ca?.classList.toggle("on", selection.size > 0 && selection.size === all);
      ca?.classList.toggle("partial", selection.size > 0 && selection.size < all);
      const b = host.querySelector("[data-extract-to]");
      if (b && !b.disabled) b.innerHTML = `${I("openFolder")} ${selection.size ? `Extract ${selection.size} item${selection.size === 1 ? "" : "s"}…` : "Extract all to…"}`;
    };

    host.onclick = async (e) => {
      const crumb = e.target.closest("[data-depth]");
      if (crumb) { trail = trail.slice(0, Number(crumb.dataset.depth) + 1); selection.clear(); draw(); return; }
      if (e.target.closest("[data-up]")) { up(); return; }
      const ex = e.target.closest("[data-extract-here],[data-extract-to]");
      if (ex) { extract(ex.dataset.extractHere !== undefined ? "here" : "to", ex); return; }
      if (e.target.closest("[data-check-all]")) {
        const keys = rowsNow().map(r => r.dataset.key).filter(Boolean);
        setSel(selection.size === keys.length ? [] : keys);
        return;
      }
      const row = e.target.closest(".pv-row[data-key]");
      if (!row) return;
      const rows = rowsNow().filter(r => r.dataset.key);
      const idx = rows.indexOf(row);
      const key = row.dataset.key;
      if (e.target.closest(".pv-check") || e.ctrlKey || e.metaKey) {
        const s = new Set(selection);
        s.has(key) ? s.delete(key) : s.add(key);
        setSel(s); anchor = idx; focusIdx = idx;
        return;
      }
      if (e.shiftKey && anchor >= 0) {
        const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
        setSel(rows.slice(a, b + 1).map(r => r.dataset.key)); focusIdx = idx;
        return;
      }
      setSel([key]); anchor = focusIdx = idx;
      if (pref("openWith", "double") === "single" || e.detail === 2) openRow(row);
    };
    host.onkeydown = (e) => {
      const rows = rowsNow().filter(r => r.dataset.key);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = Math.max(0, Math.min(rows.length - 1, (focusIdx < 0 ? -1 : focusIdx) + (e.key === "ArrowDown" ? 1 : -1)));
        const r = rows[i];
        if (!r) return;
        if (e.shiftKey && anchor >= 0) setSel(rows.slice(Math.min(anchor, i), Math.max(anchor, i) + 1).map(x => x.dataset.key));
        else { setSel([r.dataset.key]); anchor = i; }
        focusIdx = i;
        r.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && focusIdx >= 0 && rows[focusIdx]) { e.preventDefault(); openRow(rows[focusIdx]); }
      else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) { e.preventDefault(); up(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(rows.map(r => r.dataset.key)); }
    };
    // Mouse "back" button / Alt+← inside an archive go up one level before leaving it.
    const onCommand = (ev) => {
      if (ev.detail === "back" && trail.length > 1 && host.isConnected && !host.closest(".hidden")) { ev.stopImmediatePropagation(); up(); }
    };
    window.addEventListener("pifiles:command", onCommand, true);
    draw();
    active = { dispose() { host.onclick = null; host.onkeydown = null; window.removeEventListener("pifiles:command", onCommand, true); }, goUp() { if (trail.length > 1) { up(); return true; } return false; } };
  }

  // ======================================================================
  // Spreadsheets - a small editor: resizable columns, cell editing, save back
  // ======================================================================
  const colName = (i) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const numeric = /^-?[\d,]*\.?\d+(e[+-]?\d+)?%?$/i;
  const ROW_PX = 26;
  const colWidths = new Map(); // file path -> widths[]

  async function renderSheet(file, host) {
    const ext = extOf(file.name);
    const inPlace = ["csv", "tsv", "xlsx", "xlsm"].includes(ext);
    let d = null, current = null;
    let edits = new Map(); // "r,c" -> value
    let sel = { r: 0, c: 0 };
    let editor = null;
    let extraRows = 0, extraCols = 0;
    const dirty = () => edits.size > 0;
    const widths = () => {
      if (!colWidths.has(file.path)) colWidths.set(file.path, []);
      return colWidths.get(file.path);
    };
    const val = (r, c) => edits.has(`${r},${c}`) ? edits.get(`${r},${c}`) : (d.rows[r]?.[c] ?? "");
    const nRows = () => d.rows.length + extraRows;
    const nCols = () => Math.min(Math.max(...d.rows.map(r => r.length), 1), 200) + extraCols;

    const load = async (sheet) => {
      if (!host.querySelector(".pv-sheet")) host.innerHTML = spinner("Opening workbook…");
      try { d = await invoke("sheet_read", { path: file.path, sheet }); }
      catch (e) { host.innerHTML = failure("Can't read this spreadsheet", String(e?.message || e), file); wireExternal(host, file); return; }
      current = d.sheet; edits = new Map(); extraRows = 0; extraCols = 0; sel = { r: 0, c: 0 };
      shell();
    };

    function shell() {
      host.innerHTML = `<div class="pv-sheet">
        <div class="pv-bar">
          <span class="pv-pill">${I("sheet")} ${esc(ext.toUpperCase())}</span>
          <span class="pv-pill" data-size>${d.total_rows.toLocaleString()} rows × ${d.total_cols.toLocaleString()} columns</span>
          ${d.truncated ? `<span class="pv-pill pv-warn" title="Edits still save to the whole file">Showing the first ${d.rows.length.toLocaleString()} rows</span>` : ""}
          <span class="pv-cellref" data-ref>A1</span>
          <input class="pv-formula" data-formula spellcheck="false" aria-label="Cell contents">
          <button class="pf-btn" data-add-row title="Add a row">${I("add")} Row</button>
          <button class="pf-btn" data-add-col title="Add a column">${I("add")} Column</button>
          <button class="pf-btn" data-discard disabled>${I("undo")} Discard</button>
          <button class="pf-btn pv-primary" data-save disabled title="Save (Ctrl+S)">${I("save")} ${inPlace ? "Save" : "Save as .xlsx"}</button>
          <button class="pf-btn" data-open-external>${I("open")} Open in ${ext === "csv" || ext === "tsv" ? "default app" : "Excel"}</button>
        </div>
        <div class="pv-sheet-body" tabindex="0"><table class="pv-table"><colgroup></colgroup><thead></thead><tbody></tbody></table><div class="pv-sheet-pad"></div></div>
        ${d.sheets.length > 1 ? `<div class="pv-tabs">${d.sheets.map(s => `<button class="pv-tab ${s === current ? "active" : ""}" data-sheet="${esc(s)}">${esc(s)}</button>`).join("")}</div>` : ""}
      </div>`;
      wireExternal(host, file);
      const body = host.querySelector(".pv-sheet-body");
      body.addEventListener("scroll", () => requestAnimationFrame(paintRows), { passive: true });
      paintHead();
      paintRows();
      syncBar();
      body.focus({ preventScroll: true });
    }

    function paintHead() {
      const w = widths();
      const cols = nCols();
      host.querySelector("colgroup").innerHTML = `<col style="width:52px">` + Array.from({ length: cols }, (_, i) => `<col style="width:${w[i] || 120}px">`).join("");
      host.querySelector("thead").innerHTML = `<tr><th class="pv-corner"></th>${Array.from({ length: cols }, (_, i) => `<th data-col="${i}">${colName(i)}<span class="pv-col-rs" data-rs="${i}" title="Drag to resize • double-click to fit"></span></th>`).join("")}</tr>`;
      host.querySelector("table").style.width = (52 + Array.from({ length: cols }, (_, i) => w[i] || 120).reduce((a, b) => a + b, 0)) + "px";
    }

    // Only the rows in view are in the DOM, so 5,000-row sheets scroll smoothly.
    function paintRows() {
      const body = host.querySelector(".pv-sheet-body");
      if (!body) return;
      const total = nRows();
      const cols = nCols();
      const first = Math.max(0, Math.floor(body.scrollTop / ROW_PX) - 10);
      const last = Math.min(total, first + Math.ceil(body.clientHeight / ROW_PX) + 20);
      const top = first * ROW_PX, bottom = (total - last) * ROW_PX;
      let html = top ? `<tr style="height:${top}px"><td colspan="${cols + 1}" class="pv-spacer"></td></tr>` : "";
      for (let r = first; r < last; r++) {
        html += `<tr><th>${r + 1}</th>`;
        for (let c = 0; c < cols; c++) {
          const v = val(r, c);
          const cls = [numeric.test(String(v).trim()) ? "num" : "", edits.has(`${r},${c}`) ? "edited" : "", sel.r === r && sel.c === c ? "cur" : ""].filter(Boolean).join(" ");
          html += `<td data-r="${r}" data-c="${c}" class="${cls}">${esc(v)}</td>`;
        }
        html += `</tr>`;
      }
      if (bottom) html += `<tr style="height:${bottom}px"><td colspan="${cols + 1}" class="pv-spacer"></td></tr>`;
      if (!total) html = `<tr><td class="pv-empty" colspan="2">This sheet is empty - type to add data</td></tr>`;
      host.querySelector("tbody").innerHTML = html;
      if (editor) placeEditor();
    }

    function syncBar() {
      const ref = host.querySelector("[data-ref]");
      if (ref) ref.textContent = colName(sel.c) + (sel.r + 1);
      const f = host.querySelector("[data-formula]");
      if (f && document.activeElement !== f) f.value = val(sel.r, sel.c);
      host.querySelector("[data-save]").disabled = !dirty();
      host.querySelector("[data-discard]").disabled = !dirty();
      const box = host.closest(".viewer-box");
      box?.classList.toggle("pv-dirty", dirty());
    }

    function select(r, c, scroll = true) {
      commit();
      sel = { r: Math.max(0, Math.min(Math.max(nRows(), 1) - 1 + 1, r)), c: Math.max(0, Math.min(nCols() - 1, c)) };
      if (sel.r >= nRows()) extraRows = sel.r - d.rows.length + 1;
      host.querySelectorAll("td.cur").forEach(td => td.classList.remove("cur"));
      const td = host.querySelector(`td[data-r="${sel.r}"][data-c="${sel.c}"]`);
      td?.classList.add("cur");
      if (scroll) {
        const body = host.querySelector(".pv-sheet-body");
        const y = sel.r * ROW_PX;
        if (y < body.scrollTop) body.scrollTop = y;
        else if (y + ROW_PX * 2 > body.scrollTop + body.clientHeight) body.scrollTop = y + ROW_PX * 2 - body.clientHeight;
        if (!td) paintRows();
        host.querySelector(`td[data-r="${sel.r}"][data-c="${sel.c}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      syncBar();
    }

    function setVal(r, c, v) {
      const orig = d.rows[r]?.[c] ?? "";
      if (v === orig) edits.delete(`${r},${c}`); else edits.set(`${r},${c}`, v);
      const td = host.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
      if (td) { td.textContent = v; td.classList.toggle("edited", edits.has(`${r},${c}`)); td.classList.toggle("num", numeric.test(String(v).trim())); }
      syncBar();
    }

    function placeEditor() {
      const td = host.querySelector(`td[data-r="${editor.r}"][data-c="${editor.c}"]`);
      if (!td) { editor.el.style.display = "none"; return; }
      const body = host.querySelector(".pv-sheet-body");
      const br = body.getBoundingClientRect(), tr = td.getBoundingClientRect();
      Object.assign(editor.el.style, { display: "block", left: `${tr.left - br.left + body.scrollLeft}px`, top: `${tr.top - br.top + body.scrollTop}px`, width: `${Math.max(tr.width, 120)}px`, height: `${tr.height}px` });
    }
    function beginEdit(initial) {
      commit();
      const el = document.createElement("input");
      el.className = "pv-cell-editor";
      el.spellcheck = false;
      el.value = initial ?? val(sel.r, sel.c);
      host.querySelector(".pv-sheet-body").appendChild(el);
      editor = { el, r: sel.r, c: sel.c };
      placeEditor();
      el.focus();
      if (initial == null) el.select(); else el.setSelectionRange(el.value.length, el.value.length);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); select(sel.r + (e.shiftKey ? -1 : 1), sel.c); host.querySelector(".pv-sheet-body").focus(); }
        else if (e.key === "Tab") { e.preventDefault(); commit(); select(sel.r, sel.c + (e.shiftKey ? -1 : 1)); host.querySelector(".pv-sheet-body").focus(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelEdit(); host.querySelector(".pv-sheet-body").focus(); }
      });
      el.addEventListener("blur", () => commit());
    }
    function commit() {
      if (!editor) return;
      const { el, r, c } = editor;
      editor = null;
      setVal(r, c, el.value);
      el.remove();
    }
    function cancelEdit() { if (!editor) return; editor.el.remove(); editor = null; }

    async function save() {
      commit();
      if (!dirty()) return;
      const btn = host.querySelector("[data-save]");
      btn.disabled = true;
      const list = [...edits].map(([k, value]) => { const [row, col] = k.split(",").map(Number); return { row, col, value }; });
      try {
        const r = await invoke("sheet_save", { path: file.path, sheet: current, edits: list });
        for (const { row, col, value } of list) { while (d.rows.length <= row) d.rows.push([]); d.rows[row][col] = value; }
        edits.clear();
        extraRows = 0;
        paintRows(); syncBar();
        toast(r.converted ? `Saved a copy as ${r.path.split(/[\\/]/).pop()}` : "Saved");
      } catch (e) { toast("Couldn't save: " + (e?.message || e)); syncBar(); }
    }

    // column resizing
    host.addEventListener("pointerdown", (e) => {
      const h = e.target.closest("[data-rs]");
      if (!h) return;
      e.preventDefault();
      const i = Number(h.dataset.rs);
      const w = widths();
      const start = e.clientX, startW = w[i] || 120;
      const col = host.querySelectorAll("col")[i + 1];
      h.setPointerCapture(e.pointerId);
      const move = (ev) => { w[i] = Math.max(36, Math.min(800, startW + ev.clientX - start)); col.style.width = w[i] + "px"; host.querySelector("table").style.width = (52 + Array.from({ length: nCols() }, (_, k) => w[k] || 120).reduce((a, b) => a + b, 0)) + "px"; };
      const upFn = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", upFn); };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", upFn);
    });
    host.addEventListener("dblclick", (e) => {
      const h = e.target.closest("[data-rs]");
      if (h) { // fit the column to its contents
        const i = Number(h.dataset.rs);
        const ctx2 = document.createElement("canvas").getContext("2d");
        ctx2.font = getComputedStyle(host.querySelector(".pv-table td") || host).font;
        let max = 40;
        for (let r = 0; r < Math.min(nRows(), 2000); r++) max = Math.max(max, ctx2.measureText(String(val(r, i))).width);
        widths()[i] = Math.min(600, Math.ceil(max + 20));
        paintHead();
        return;
      }
      const td = e.target.closest("td[data-r]");
      if (td) { select(Number(td.dataset.r), Number(td.dataset.c), false); beginEdit(); }
    });
    host.onclick = async (e) => {
      const t = e.target.closest("[data-sheet]");
      if (t && t.dataset.sheet !== current) {
        if (dirty() && !(await PiDialog.confirm({ title: "Discard changes?", message: "Your edits on this sheet haven't been saved.", okText: "Discard", danger: true }))) return;
        load(t.dataset.sheet); return;
      }
      if (e.target.closest("[data-save]")) { save(); return; }
      if (e.target.closest("[data-discard]")) { edits.clear(); extraRows = 0; extraCols = 0; paintHead(); paintRows(); syncBar(); return; }
      if (e.target.closest("[data-add-row]")) { extraRows++; paintRows(); select(nRows() - 1, 0); return; }
      if (e.target.closest("[data-add-col]")) { extraCols++; paintHead(); paintRows(); select(sel.r, nCols() - 1); return; }
      const td = e.target.closest("td[data-r]");
      if (td && !e.target.closest(".pv-cell-editor")) { select(Number(td.dataset.r), Number(td.dataset.c), false); host.querySelector(".pv-sheet-body").focus({ preventScroll: true }); }
    };
    host.addEventListener("input", (e) => {
      if (e.target.matches("[data-formula]")) setVal(sel.r, sel.c, e.target.value);
    });
    host.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
      if (editor || e.target.matches("input")) return;
      const k = e.key;
      if (k.startsWith("Arrow")) { e.preventDefault(); select(sel.r + (k === "ArrowDown") - (k === "ArrowUp"), sel.c + (k === "ArrowRight") - (k === "ArrowLeft")); }
      else if (k === "Tab") { e.preventDefault(); select(sel.r, sel.c + (e.shiftKey ? -1 : 1)); }
      else if (k === "Enter" || k === "F2") { e.preventDefault(); beginEdit(); }
      else if (k === "Delete" || k === "Backspace") { e.preventDefault(); setVal(sel.r, sel.c, ""); }
      else if (k === "PageDown" || k === "PageUp") { e.preventDefault(); select(sel.r + (k === "PageDown" ? 20 : -20), sel.c); }
      else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "c") { navigator.clipboard?.writeText(String(val(sel.r, sel.c))); }
      else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "v") { navigator.clipboard?.readText().then(t => setVal(sel.r, sel.c, t)).catch(() => {}); }
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); beginEdit(k); }
    };
    await load(null);
    active = {
      dispose() { host.onclick = null; host.onkeydown = null; host.closest(".viewer-box")?.classList.remove("pv-dirty"); },
      async canClose() {
        commit();
        if (!dirty()) return true;
        return PiDialog.confirm({ title: "Close without saving?", message: `Your changes to “${file.name}” haven't been saved.`, okText: "Close without saving", danger: true });
      },
    };
  }

  // ======================================================================
  // Text - a plain editor that keeps the file's encoding and line endings
  // ======================================================================
  const TEXT = new Set(["txt", "md", "markdown", "log", "json", "jsonc", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "properties",
    "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "svelte", "py", "rs", "java", "kt", "swift", "dart",
    "c", "cc", "cpp", "h", "hpp", "cs", "go", "rb", "php", "lua", "r", "pl", "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd", "sql",
    "gitignore", "gitattributes", "editorconfig", "dockerfile", "makefile", "gradle", "srt", "vtt", "ass", "nfo", "reg", "inf", "csproj", "sln"]);

  /** Read-only, virtualised view for big text: only the lines on screen exist in the DOM, so a
   *  multi-megabyte log or JSON opens instantly. "Edit" switches to the full editor. */
  function renderBigText(file, host, doc, toEditor) {
    const lines = doc.text.split("\n");
    const LH = 20, digits = String(lines.length).length;
    host.innerHTML = `<div class="pv-text">
      <div class="pv-bar">
        <span class="pv-pill">${esc(extOf(file.name).toUpperCase() || "TEXT")}</span>
        <span class="pv-pill" title="Encoding">${esc(doc.encoding.toUpperCase())}${doc.bom ? " BOM" : ""}</span>
        <span class="pv-pill">${lines.length.toLocaleString()} lines</span>
        ${doc.editable ? "" : `<span class="pv-pill pv-warn">Large file - first part shown, read-only</span>`}
        <span style="flex:1"></span>
        <button class="pf-btn" data-copyall title="Copy the whole file">${I("copy")} Copy all</button>
        ${doc.editable ? `<button class="pf-btn pv-primary" data-edit title="Open in the editor">${I("edit")} Edit</button>` : ""}
      </div>
      <div class="pv-vtext" tabindex="0" style="--lh:${LH}px;--gw:${digits + 2}ch"><div class="pv-vspace" style="height:${lines.length * LH}px"></div><div class="pv-vrows"></div></div>
    </div>`;
    const sc = host.querySelector(".pv-vtext"), rows = host.querySelector(".pv-vrows");
    let raf = 0, first = -1;
    const draw = () => {
      raf = 0;
      const start = Math.max(0, Math.floor(sc.scrollTop / LH) - 20);
      const end = Math.min(lines.length, Math.ceil((sc.scrollTop + sc.clientHeight) / LH) + 20);
      if (start === first && rows.childElementCount === end - start) return;
      first = start;
      rows.style.transform = `translateY(${start * LH}px)`;
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        const r = document.createElement("div"); r.className = "pv-vl";
        const n = document.createElement("span"); n.className = "pv-vn"; n.textContent = i + 1;
        const t = document.createElement("span"); t.className = "pv-vt"; t.textContent = lines[i] || " ";
        r.append(n, t); frag.appendChild(r);
      }
      rows.replaceChildren(frag);
    };
    sc.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(draw); }, { passive: true });
    new ResizeObserver(() => { first = -1; draw(); }).observe(sc);
    draw();
    host.onclick = (e) => {
      if (e.target.closest("[data-copyall]")) navigator.clipboard?.writeText(doc.text).then(() => toast("Copied the whole file"));
      else if (e.target.closest("[data-edit]")) toEditor();
    };
    host.onkeydown = null;
    active = { dispose() { host.onclick = null; }, canClose: async () => true };
  }

  async function renderText(file, host, forceEditor) {
    host.innerHTML = spinner("Opening…");
    let doc;
    try { doc = await invoke("text_open", { path: file.path }); }
    catch (e) { host.innerHTML = failure("Can't open this file as text", String(e?.message || e), file); wireExternal(host, file); return; }
    // Big files: instant virtual view first; the editor only when asked for.
    if (!forceEditor && (doc.text.length > 400000 || !doc.editable)) {
      renderBigText(file, host, doc, () => renderTextEditor(file, host, doc));
      return;
    }
    renderTextEditor(file, host, doc);
  }

  function renderTextEditor(file, host, doc) {
    let saved = doc.text;
    const wrap = pref("editorWrap", false);
    host.innerHTML = `<div class="pv-text">
      <div class="pv-bar">
        <span class="pv-pill">${esc(extOf(file.name).toUpperCase() || "TEXT")}</span>
        <span class="pv-pill" title="Encoding">${esc(doc.encoding.toUpperCase())}${doc.bom ? " BOM" : ""}</span>
        <span class="pv-pill" title="Line endings">${doc.crlf ? "CRLF" : "LF"}</span>
        <span class="pv-pill" data-pos>Ln 1, Col 1</span>
        ${doc.editable ? "" : `<span class="pv-pill pv-warn">Large file - read-only preview</span>`}
        <span style="flex:1"></span>
        ${LIVE.has(extOf(file.name)) ? `<button class="pf-btn" data-live title="Show a live preview next to the code">${I("eye")} Preview</button>` : ""}
        <button class="pf-btn ${wrap ? "on" : ""}" data-wrap title="Word wrap">Wrap</button>
        ${doc.editable ? `<button class="pf-btn" data-revert disabled>${I("undo")} Revert</button><button class="pf-btn pv-primary" data-save disabled title="Save (Ctrl+S)">${I("save")} Save</button>` : ""}
      </div>
      <div class="pv-editor ${wrap ? "wrap" : ""}">
        <pre class="pv-gutter" aria-hidden="true"></pre>
        <textarea class="pv-textarea" spellcheck="false" ${doc.editable ? "" : "readonly"} wrap="${wrap ? "soft" : "off"}"></textarea>
      </div>
    </div>`;
    const ta = host.querySelector("textarea");
    const gutter = host.querySelector(".pv-gutter");
    ta.value = doc.text;
    // Line numbers are rebuilt only when the line count changes (not on every keystroke).
    let lineCount = -1;
    const countLines = (t) => { let n = 1, i = -1; while ((i = t.indexOf("\n", i + 1)) !== -1) n++; return n; };
    const lines = () => { const n = countLines(ta.value); if (n === lineCount) return; lineCount = n; let s = ""; for (let i = 1; i <= n; i++) s += i + "\n"; gutter.textContent = s; };
    const dirty = () => ta.value !== saved;
    const sync = () => {
      host.querySelector("[data-save]") && (host.querySelector("[data-save]").disabled = !dirty());
      host.querySelector("[data-revert]") && (host.querySelector("[data-revert]").disabled = !dirty());
      host.closest(".viewer-box")?.classList.toggle("pv-dirty", dirty());
    };
    const pos = () => {
      const v = ta.value, at = ta.selectionStart;
      let ln = 1, i = -1, last = -1;
      while ((i = v.indexOf("\n", i + 1)) !== -1 && i < at) { ln++; last = i; }
      const col = at - last;
      host.querySelector("[data-pos]").textContent = `Ln ${ln}, Col ${col}`;
    };
    lines();
    // Live preview (HTML / Markdown / SVG): updates as you type, in a sandboxed frame.
    let live = null, liveT = 0;
    const updateLive = () => { if (live) live.srcdoc = livePreviewDoc(extOf(file.name), ta.value); };
    const toggleLive = (on) => {
      const ed = host.querySelector(".pv-editor"), btn = host.querySelector("[data-live]");
      if (on && !live) { live = sandboxFrame("pv-live"); ed.after(live); host.querySelector(".pv-text").classList.add("with-live"); updateLive(); }
      else if (!on && live) { live.remove(); live = null; host.querySelector(".pv-text").classList.remove("with-live"); }
      btn?.classList.toggle("on", !!live);
      try { localStorage.setItem("pf:livePreview", live ? "1" : "0"); } catch {}
    };
    ta.addEventListener("input", () => { lines(); sync(); clearTimeout(liveT); liveT = setTimeout(updateLive, 180); });
    ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; });
    ["keyup", "click", "select"].forEach(ev => ta.addEventListener(ev, pos));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.ctrlKey && doc.editable) { // indent instead of leaving the editor
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText("    ", s, ta.selectionEnd, "end");
        lines(); sync();
      }
    });
    async function save() {
      if (!doc.editable || !dirty()) return;
      try {
        await invoke("text_save", { path: file.path, text: ta.value, encoding: doc.encoding, bom: doc.bom, crlf: doc.crlf });
        saved = ta.value; sync(); toast("Saved");
      } catch (e) { toast("Couldn't save: " + (e?.message || e)); }
    }
    host.onclick = (e) => {
      if (e.target.closest("[data-live]")) toggleLive(!live);
      else if (e.target.closest("[data-save]")) save();
      else if (e.target.closest("[data-revert]")) { ta.value = saved; lines(); sync(); }
      else if (e.target.closest("[data-wrap]")) {
        const on = !host.querySelector(".pv-editor").classList.contains("wrap");
        window.PiSettings?.set("editorWrap", on);
        host.querySelector(".pv-editor").classList.toggle("wrap", on);
        ta.setAttribute("wrap", on ? "soft" : "off");
        e.target.closest("[data-wrap]").classList.toggle("on", on);
      }
    };
    host.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } };
    ta.focus({ preventScroll: true });
    if (LIVE.has(extOf(file.name))) { let want = true; try { want = localStorage.getItem("pf:livePreview") !== "0"; } catch {} if (want) toggleLive(true); }
    active = {
      dispose() { host.onclick = null; host.onkeydown = null; host.closest(".viewer-box")?.classList.remove("pv-dirty"); },
      async canClose() {
        if (!dirty()) return true;
        return PiDialog.confirm({ title: "Close without saving?", message: `Your changes to “${file.name}” haven't been saved.`, okText: "Close without saving", danger: true });
      },
    };
  }

  // ======================================================================
  // Movies & music
  // ======================================================================
  const langName = (code) => {
    if (!code || code === "und") return "";
    try { return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(code.length === 3 ? ({ eng: "en", tam: "ta", jpn: "ja", hin: "hi", mal: "ml", tel: "te", kan: "kn", spa: "es", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", kor: "ko", chi: "zh", zho: "zh", rus: "ru", por: "pt", ara: "ar" }[code] || code) : code) || code; }
    catch { return code; }
  };
  const channels = (n) => n === 1 ? "Mono" : n === 2 ? "Stereo" : n === 6 ? "5.1" : n === 8 ? "7.1" : n ? `${n}ch` : "";
  const CODEC = { eac3: "Dolby Digital Plus", ac3: "Dolby Digital", truehd: "Dolby TrueHD", dts: "DTS", aac: "AAC", mp3: "MP3", opus: "Opus", flac: "FLAC", vorbis: "Vorbis", subrip: "SRT", ass: "ASS", ssa: "SSA", webvtt: "WebVTT", mov_text: "Text", hdmv_pgs_subtitle: "PGS", dvd_subtitle: "VobSub", srt: "SRT", vtt: "WebVTT" };
  const fmtTime = (t) => {
    if (!isFinite(t) || t < 0) t = 0;
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60);
    return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
  };
  const vttTime = (s) => { const p = s.trim().split(":").map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  function parseVtt(text) {
    const cues = [];
    for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
      const lines = block.split("\n");
      const i = lines.findIndex(l => l.includes("-->"));
      if (i < 0) continue;
      const [a, b] = lines[i].split("-->");
      const body = lines.slice(i + 1).join("\n").trim();
      if (body) cues.push({ start: vttTime(a), end: vttTime(b.trim().split(/\s+/)[0]), text: body });
    }
    return cues.sort((x, y) => x.start - y.start);
  }
  const cueHtml = (t) => esc(t.replace(/\{\\[^}]*\}/g, "")) // strip ASS override tags, then allow simple styling
    .replace(/&lt;(\/?)(i|b|u)&gt;/gi, "<$1$2>").replace(/&lt;[^&]*&gt;/g, "").replace(/\n/g, "<br>");

  const subCache = new Map();

  async function renderMedia(file, host, isAudio) {
    let info = null;
    try { info = await invoke("media_probe", { path: file.path }); } catch (e) { info = null; }

    // No FFmpeg / unprobeable: let WebView2 try on its own.
    const direct = !info || info.direct_play;
    const vcodec = info?.video?.codec || "";
    const hevcOk = !!window.MediaSource?.isTypeSupported?.('video/mp4; codecs="hvc1.1.6.L93.B0"');
    let copyOk = ["h264", "vp9", "av1"].includes(vcodec) || (vcodec === "hevc" && hevcOk);
    const audioOnly = isAudio || (info && !info.video);
    const audios = info?.audio || [];
    const subs = (info?.subtitles || []).filter(s => !audioOnly);

    // Preferred tracks (Settings → Media)
    const prefAudio = lower(pref("preferredAudioLang", ""));
    const prefSub = lower(pref("preferredSubLang", ""));
    const matchLang = (code, want) => want && (lower(code) === want || lower(langName(code)).startsWith(want) || lower(code).startsWith(want));
    let audioIdx = (audios.find(a => matchLang(a.language, prefAudio)) || audios.find(a => a.default) || audios[0])?.index ?? null;
    let subSel = null;
    if (pref("subtitlesDefault", false) || subs.some(s => s.forced)) {
      subSel = (subs.find(s => s.text && matchLang(s.language, prefSub)) || subs.find(s => s.text && s.forced) || (pref("subtitlesDefault", false) ? subs.find(s => s.text) : null))?.id ?? null;
    }

    host.innerHTML = `<div class="pv-player ${audioOnly ? "pv-audio" : ""}" tabindex="0">
      ${audioOnly ? `<div class="pv-art">${PiIcons.place("music")}<div class="pv-art-title">${esc(file.name)}</div>${info?.duration ? `<div class="pv-art-sub">${fmtTime(info.duration)}${audios[0] ? " • " + esc(CODEC[audios[0].codec] || audios[0].codec.toUpperCase()) : ""}</div>` : ""}</div>` : ""}
      <video class="pv-video" playsinline preload="auto"></video>
      <div class="pv-subs"></div>
      <div class="pv-loading hidden"><span class="spinner"></span><span class="pv-loading-text">Loading…</span></div>
      <button class="pv-center" aria-label="Play">${I("play")}</button>
      <div class="pv-controls">
        <div class="pv-seek"><div class="pv-seek-buf"></div><div class="pv-seek-fill"></div><div class="pv-seek-thumb"></div><div class="pv-seek-tip"></div></div>
        <div class="pv-row-ctl">
          <button class="pv-btn" data-a="play" title="Play (Space)">${I("play")}</button>
          <button class="pv-btn" data-a="back" title="Back ${Math.max(1, Number(pref("seekLong", 10)) || 10)} s (J)">${I("back10")}</button>
          <button class="pv-btn" data-a="fwd" title="Forward ${Math.max(1, Number(pref("seekLong", 10)) || 10)} s (L)">${I("fwd10")}</button>
          <span class="pv-time">0:00 / ${fmtTime(info?.duration || 0)}</span>
          <span class="pv-spacer"></span>
          <span class="pv-mode" title=""></span>
          ${audios.length > 1 ? `<button class="pv-btn" data-a="audio" title="Audio track (A)">${I("music")}</button>` : ""}
          ${subs.length ? `<button class="pv-btn" data-a="subs" title="Subtitles (C)">${I("cc")}</button>` : ""}
          <button class="pv-btn pv-speed" data-a="speed" title="Playback speed">1×</button>
          <button class="pv-btn" data-a="mute" title="Mute (M)">${I("volume")}</button>
          <input class="pv-volume" type="range" min="0" max="1" step="0.02" aria-label="Volume">
          ${audioOnly ? "" : `<button class="pv-btn" data-a="fs" title="Full screen (F)">${I("fullscreen")}</button>`}
        </div>
      </div>
      <div class="pv-menu hidden" role="menu"></div>
    </div>`;

    const root = host.querySelector(".pv-player");
    const video = root.querySelector("video");
    const subsEl = root.querySelector(".pv-subs");
    const loading = root.querySelector(".pv-loading");
    const loadingText = root.querySelector(".pv-loading-text");
    const seek = root.querySelector(".pv-seek");
    const menu = root.querySelector(".pv-menu");
    const timeEl = root.querySelector(".pv-time");
    const modeEl = root.querySelector(".pv-mode");
    const vol = root.querySelector(".pv-volume");
    const SHORT = Math.max(1, Number(pref("seekShort", 5)) || 5), LONG = Math.max(1, Number(pref("seekLong", 10)) || 10);
    let streamPlanned = false;
    let offset = 0, streaming = false, disposed = false, cues = [], dragging = false, hideTimer = 0, raf = 0;
    const duration = () => info?.duration || (isFinite(video.duration) ? video.duration : 0);
    const now = () => offset + (video.currentTime || 0);

    try { video.volume = Number(localStorage.getItem("pf:volume") ?? 1); video.muted = localStorage.getItem("pf:muted") === "1"; } catch {}
    vol.value = video.muted ? 0 : video.volume;
    root.classList.toggle(`pv-subsize-${pref("subtitleSize", "medium")}`, true);

    const setLoading = (on, text) => { loading.classList.toggle("hidden", !on); if (text) loadingText.textContent = text; };
    const setMode = () => {
      modeEl.textContent = !info ? "" : !streaming ? "Direct" : copyOk ? "Remux" : `Converting (${(info.encoder || "").replace("h264_", "").replace("lib", "").toUpperCase()})`;
      modeEl.title = !streaming ? "Playing the file as-is" : copyOk ? "Repackaged on the fly - original quality" : "Converted on the fly for playback";
    };

    // Converted playback: FFmpeg's fragmented MP4 is pulled over the app's own IPC into a
    // MediaSource. No network port is involved, so nothing outside PiFiles can reach the stream.
    let sess = null, gen = 0;
    const closeSession = () => { if (sess != null) { invoke("media_close", { id: sess }).catch(() => {}); sess = null; } };
    const tenBit = () => /10/.test(info?.video?.pix_fmt || "") || /10/.test(info?.video?.profile || "");
    const mimeFor = (mode) => {
      if (mode === "audio") return 'audio/mp4; codecs="mp4a.40.2"';
      const v = mode === "encode" ? "avc1.640033"
        : vcodec === "hevc" ? (tenBit() ? "hvc1.2.4.L153.B0" : "hvc1.1.6.L153.B0")
        : vcodec === "vp9" ? (tenBit() ? "vp09.02.51.10" : "vp09.00.51.08")
        : vcodec === "av1" ? (tenBit() ? "av01.0.13M.10" : "av01.0.13M.08")
        : "avc1.640033";
      return `video/mp4; codecs="${v}${audios.length ? ",mp4a.40.2" : ""}"`;
    };
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const untilUpdated = (buf) => new Promise(res => buf.addEventListener("updateend", res, { once: true }));

    async function startStream(at, reason) {
      if (!info) return;
      const my = ++gen;
      setLoading(true, reason || "Preparing…");
      const wasPlaying = !video.paused || video.autoplay;
      closeSession();
      let mode = audioOnly ? "audio" : copyOk ? "copy" : "encode";
      if (mode === "copy" && !MediaSource.isTypeSupported(mimeFor("copy"))) { copyOk = false; mode = "encode"; }
      let r;
      const liveIdx = audioOnly ? [] : subs.filter(s => s.text && s.index != null && !s.external).map(s => s.index);
      try { r = await invoke("media_open", { path: file.path, audio: audioIdx, start: Math.max(0, at), mode, hevc: vcodec === "hevc", subs: liveIdx }); }
      catch (e) {
        if (my !== gen) return;
        setLoading(false); host.querySelector(".pv-center").classList.add("hidden"); toast("Can't play: " + (e?.message || e)); return;
      }
      if (disposed || my !== gen) { invoke("media_close", { id: r.id }).catch(() => {}); return; }
      sess = r.id; streaming = true; offset = r.offset; setMode();
      const source = new MediaSource();
      const url = URL.createObjectURL(source);
      video.src = url;
      await new Promise(res => source.addEventListener("sourceopen", res, { once: true }));
      URL.revokeObjectURL(url);
      if (disposed || my !== gen) return;
      let buf;
      try { buf = source.addSourceBuffer(mimeFor(mode)); }
      catch (e) {
        if (mode === "copy") { copyOk = false; return startStream(at, "Converting for playback…"); }
        return streamFailed(e);
      }
      if (wasPlaying || pref("autoplay", true)) video.play().catch(() => {});
      pump(my, r.id, source, buf, mode, at);
      pollSubs(my, r.id, r.offset || 0);
    }
    async function pump(my, id, source, buf, mode, at) {
      const live = () => !disposed && my === gen && source.readyState === "open";
      const read = () => { const r = invoke("media_read", { id }); r.catch(() => {}); return r; };
      let next = null, first = true;
      while (live()) {
        const b = buf.buffered, end = b.length ? b.end(b.length - 1) : 0;
        // Keep about a minute ready; FFmpeg pauses (pipe back-pressure) while we're ahead.
        if (end - video.currentTime > 60) { await wait(400); continue; }
        // Let go of what's well behind the playhead so long movies don't grow memory.
        if (b.length && video.currentTime - b.start(0) > 60) { buf.remove(0, video.currentTime - 30); await untilUpdated(buf); continue; }
        let chunk;
        try { chunk = await (next || read()); next = null; }
        catch (e) {
          if (!live()) return;
          if (mode === "copy" && !audioOnly) { copyOk = false; return startStream(now(), "Converting for playback…"); }
          return streamFailed(e);
        }
        if (!live()) return;
        if (!chunk || !chunk.byteLength) { try { source.endOfStream(); } catch {} return; }
        next = read(); // fetch the next chunk while this one is decoded into the buffer
        for (;;) {
          try {
            buf.appendBuffer(chunk); await untilUpdated(buf);
            // Codec-copy streams start on the keyframe before the requested time: skip ahead to it.
            if (first) { first = false; const rel = at - offset; if (rel > 0.2 && rel < 30) video.currentTime = rel; }
            break;
          }
          catch (e) {
            if (e?.name !== "QuotaExceededError" || !live()) return;
            await wait(500); // buffer full: wait for playback to move on, then retry
            const bb = buf.buffered;
            if (bb.length && video.currentTime - bb.start(0) > 10) { buf.remove(0, video.currentTime - 5); await untilUpdated(buf); }
          }
        }
      }
    }
    function streamFailed(e) {
      setLoading(false);
      if (host.querySelector(".pv-player .pv-error")) return;
      // The message can contain file paths or FFmpeg output: it is set as text, never as HTML.
      const box = document.createElement("div");
      box.innerHTML = failure("This file can't be played", "", file);
      const panel = box.firstElementChild;
      const detail = document.createElement("div");
      detail.className = "pv-state-detail";
      detail.textContent = String(e?.message || e || "The stream stopped unexpectedly.");
      panel.querySelector(".pv-state-title")?.after(detail);
      host.querySelector(".pv-player").appendChild(panel);
      wireExternal(host, file);
    }
    function startDirect() {
      streaming = false; offset = 0; setMode();
      video.src = assetMediaUrl(file.path);
      if (pref("autoplay", true)) video.play().catch(() => {});
    }
    function seekTo(t) {
      t = Math.max(0, Math.min(duration() || Infinity, t));
      if (!streaming) { video.currentTime = t; return; }
      const rel = t - offset;
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) if (rel >= b.start(i) && rel <= b.end(i)) { video.currentTime = rel; return; }
      startStream(t, "Seeking…");
    }

    // --- subtitles ---
    // Embedded subtitles of a streamed movie come from the stream's own FFmpeg run (no separate
    // pass over the file): cues collect per track as playback moves, across seeks.
    const live = new Map(); // stream index -> { cues, seen }
    const liveTrack = (idx) => { if (!live.has(idx)) live.set(idx, { cues: [], seen: new Set() }); return live.get(idx); };
    const isLive = (t) => t && t.text && t.index != null && !t.external && (streaming || streamPlanned);
    async function pollSubs(my, id, off) {
      const from = new Map();
      while (!disposed && my === gen) {
        const t = subs.find(s => s.id === subSel);
        if (isLive(t)) {
          try {
            const c = await invoke("media_subs", { id, stream: t.index, from: from.get(t.index) || 0 });
            if (my !== gen) return;
            from.set(t.index, c.next);
            if (c.text) {
              const tr = liveTrack(t.index);
              let added = false;
              for (const cue of parseVtt(c.text)) { cue.start += off; cue.end += off; const k = cue.start.toFixed(2) + "|" + cue.text; if (!tr.seen.has(k)) { tr.seen.add(k); tr.cues.push(cue); added = true; } }
              if (added) { tr.cues.sort((x, y) => x.start - y.start); if (subSel === t.id) cues = tr.cues; lastCueKey = "\u0000"; }
            }
            if (c.done) return;
          } catch (e) { console.warn("[subtitles]", e); await wait(1000); continue; } // keep trying; never silently stop
        }
        await wait(from.size ? 700 : 150);
      }
    }
    async function selectSubs(id) {
      subSel = id; cues = []; subsEl.innerHTML = "";
      root.querySelector('[data-a="subs"]')?.classList.toggle("on", !!id);
      if (!id) return;
      const t = subs.find(s => s.id === id);
      if (isLive(t)) { cues = liveTrack(t.index).cues; return; } // instant; fills in as the stream runs
      const key = file.path + "|" + id;
      if (!subCache.has(key)) {
        setLoading(true, "Loading subtitles…");
        try { subCache.set(key, parseVtt(await invoke("media_subtitle", { path: file.path, stream: t.index ?? null, external: t.external ?? null }))); }
        catch (e) { toast("Couldn't load subtitles: " + (e?.message || e)); subSel = null; }
        finally { setLoading(!video.paused && video.readyState < 3, "Loading…"); }
      }
      if (subSel === id) cues = subCache.get(key) || [];
    }
    let lastCueKey = "";
    function drawSubs() {
      if (!cues.length) { if (lastCueKey) { subsEl.innerHTML = ""; lastCueKey = ""; } return; }
      const t = now();
      let lo = 0, hi = cues.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cues[m].start <= t) lo = m + 1; else hi = m; }
      const on = [];
      for (let i = lo - 1; i >= 0 && i >= lo - 8; i--) if (cues[i].end > t) on.unshift(cues[i]);
      const key = on.map(c => c.start).join(",");
      if (key !== lastCueKey) { lastCueKey = key; subsEl.innerHTML = on.map(c => `<span>${cueHtml(c.text)}</span>`).join(""); }
    }

    // --- UI updates ---
    function tick() {
      const d = duration(), t = now();
      timeEl.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
      if (!dragging && d) {
        const p = Math.min(1, t / d);
        seek.style.setProperty("--p", p);
        const b = video.buffered;
        let end = 0;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 1) end = Math.max(end, b.end(i));
        seek.style.setProperty("--b", Math.min(1, (offset + end) / d));
      }
      drawSubs();
      if (!disposed && !video.paused) raf = requestAnimationFrame(tick);
    }
    const syncPlay = () => {
      const playing = !video.paused;
      root.classList.toggle("pv-playing", playing);
      root.querySelector('[data-a="play"]').innerHTML = I(playing ? "pause" : "play");
      root.querySelector('[data-a="play"]').title = playing ? "Pause (Space)" : "Play (Space)";
      cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
    };
    const syncVolume = () => {
      root.querySelector('[data-a="mute"]').innerHTML = I(video.muted || video.volume === 0 ? "mute" : "volume");
      vol.value = video.muted ? 0 : video.volume;
      vol.style.setProperty("--v", vol.value);
      try { localStorage.setItem("pf:volume", String(video.volume)); localStorage.setItem("pf:muted", video.muted ? "1" : "0"); } catch {}
    };
    const poke = () => {
      root.classList.remove("pv-idle");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!video.paused && menu.classList.contains("hidden")) root.classList.add("pv-idle"); }, 2600);
    };

    video.addEventListener("play", syncPlay);
    video.addEventListener("pause", () => { syncPlay(); root.classList.remove("pv-idle"); });
    // Short decoder hiccups (start, seek, resize) don't flash a spinner; a real stall does.
    let waitT = 0;
    video.addEventListener("waiting", () => {
      clearTimeout(waitT);
      waitT = setTimeout(() => { if (!disposed && !video.paused && video.readyState < 3) setLoading(true, video.currentTime > 0.5 ? (streaming && !copyOk ? "Converting…" : "Loading…") : "Loading…"); }, 450);
    });
    video.addEventListener("playing", () => { clearTimeout(waitT); setLoading(false); });
    video.addEventListener("canplay", () => { clearTimeout(waitT); setLoading(false); });
    video.addEventListener("timeupdate", () => { if (video.paused) tick(); });
    video.addEventListener("volumechange", syncVolume);
    video.addEventListener("ended", syncPlay);
    video.addEventListener("error", () => {
      if (disposed) return;
      // Direct play refused (unsupported codec/container): switch to FFmpeg transparently.
      if (!streaming && info) startStream(now(), "Converting for playback…");
      // The engine claimed it could decode this codec but couldn't (e.g. HEVC without the Windows extension):
      // convert instead of giving up.
      else if (streaming && copyOk && !audioOnly) { copyOk = false; startStream(now(), "Converting for playback…"); }
      else streamFailed(info ? (video.error?.message || "The stream stopped unexpectedly.") : "The bundled FFmpeg isn't available.");
    });

    // --- menus ---
    function openMenu(kindName, anchor) {
      const items = kindName === "audio"
        ? audios.map((a, i) => ({ id: a.index, on: a.index === audioIdx, label: [langName(a.language) || `Track ${i + 1}`, a.title && a.title !== a.language ? a.title : "", CODEC[a.codec] || a.codec.toUpperCase(), channels(a.channels)].filter(Boolean).join(" · ") }))
        : kindName === "subs"
        ? [{ id: "", on: !subSel, label: "Off" }, ...subs.map((s, i) => ({ id: s.id, on: s.id === subSel, disabled: !s.text,
            label: [langName(s.language) || s.title || `Track ${i + 1}`, s.title && langName(s.language) ? s.title : "", s.forced ? "Forced" : "", s.external ? "File" : "", CODEC[s.codec] || s.codec.toUpperCase()].filter(Boolean).join(" · ") + (s.text ? "" : " - image subtitles aren't supported") }))]
        : [0.5, 0.75, 1, 1.25, 1.5, 2].map(r => ({ id: r, on: video.playbackRate === r, label: r === 1 ? "Normal" : `${r}×` }));
      menu.innerHTML = `<div class="pv-menu-title">${kindName === "audio" ? "Audio track" : kindName === "subs" ? "Subtitles" : "Speed"}</div>` +
        items.map(it => `<button class="pv-menu-item ${it.on ? "on" : ""}" ${it.disabled ? "disabled" : ""} data-k="${kindName}" data-id="${esc(it.id)}"><span class="pv-check">${it.on ? I("check") : ""}</span>${esc(it.label)}</button>`).join("");
      menu.classList.remove("hidden");
      const r = anchor.getBoundingClientRect(), pr = root.getBoundingClientRect();
      menu.style.right = `${Math.max(8, pr.right - r.right)}px`;
      menu.style.bottom = `${pr.bottom - r.top + 8}px`;
    }
    const closeMenu = () => menu.classList.add("hidden");

    async function chooseAudio(index) {
      if (index === audioIdx) return;
      audioIdx = index;
      const at = now();
      const first = audios[0]?.index;
      if (!streaming && info?.direct_play && index === first) { startDirect(); video.currentTime = at; }
      else startStream(at, "Switching audio…");
    }
    const cycle = (arr, cur) => arr[(arr.indexOf(cur) + 1) % arr.length];

    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      const item = e.target.closest(".pv-menu-item");
      if (item) {
        const { k, id } = item.dataset;
        closeMenu();
        if (k === "audio") chooseAudio(Number(id));
        else if (k === "subs") selectSubs(id || null);
        else { video.playbackRate = Number(id); root.querySelector(".pv-speed").textContent = `${Number(id)}×`; }
        return;
      }
      if (!b) {
        if (e.target.closest(".pv-controls, .pv-menu")) return;
        if (!menu.classList.contains("hidden")) { closeMenu(); return; }
        if (e.target.closest(".pv-video, .pv-center, .pv-art, .pv-subs")) video.paused ? video.play() : video.pause();
        return;
      }
      switch (b.dataset.a) {
        case "play": video.paused ? video.play() : video.pause(); break;
        case "back": seekTo(now() - LONG); break;
        case "fwd": seekTo(now() + LONG); break;
        case "mute": video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 0.5; break;
        case "fs": toggleFullscreen(); break;
        case "audio": case "subs": case "speed":
          menu.classList.contains("hidden") || menu.dataset.for !== b.dataset.a ? (menu.dataset.for = b.dataset.a, openMenu(b.dataset.a, b)) : closeMenu();
          break;
      }
    });
    root.addEventListener("dblclick", (e) => { if (!audioOnly && e.target.closest(".pv-video, .pv-subs")) toggleFullscreen(); });
    root.addEventListener("mousemove", poke);
    vol.addEventListener("input", () => { video.volume = Number(vol.value); video.muted = video.volume === 0; });

    // seek bar with hover time tip; scrubbing only commits on release
    const posToTime = (clientX) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration(); };
    seek.addEventListener("pointermove", (e) => {
      const t = posToTime(e.clientX), r = seek.getBoundingClientRect();
      seek.style.setProperty("--tip", `${e.clientX - r.left}px`);
      seek.querySelector(".pv-seek-tip").textContent = fmtTime(t);
      if (dragging) seek.style.setProperty("--p", t / (duration() || 1));
    });
    seek.addEventListener("pointerdown", (e) => { dragging = true; seek.setPointerCapture(e.pointerId); seek.style.setProperty("--p", posToTime(e.clientX) / (duration() || 1)); });
    seek.addEventListener("pointerup", (e) => { if (!dragging) return; dragging = false; seekTo(posToTime(e.clientX)); });

    // Full screen without the browser's Fullscreen API, so PiFiles controls the order of steps:
    //  in:  the player covers the whole app (black) first, then the window grows to the monitor;
    //  out: the window shrinks back while the player still covers everything, and only once it has
    //       settled does the app reappear.
    // The see-through window background is never exposed mid-change, so nothing behind PiFiles
    // shows through. The window is only restored if the player made it full screen (F11 stays).
    let fsOn = false, ownsWindowFs = false, fsBusy = false;
    const tauri = window.__TAURI__?.core;
    const frames = (n = 2) => new Promise(r => { const step = () => (--n <= 0 ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); });
    const settled = () => new Promise(r => { let t; const done = () => { clearTimeout(t); removeEventListener("resize", done); frames(2).then(r); }; addEventListener("resize", done, { once: true }); t = setTimeout(done, 150); });
    function markFs(on) {
      fsOn = on;
      root.classList.toggle("pv-fs", on);
      document.documentElement.classList.toggle("pf-player-fs", on);
      const fs = root.querySelector('[data-a="fs"]');
      if (fs) { fs.innerHTML = I(on ? "fullscreenExit" : "fullscreen"); fs.title = on ? "Exit full screen (F or Esc)" : "Full screen (F)"; }
    }
    async function setFullscreen(on) {
      if (fsBusy || on === fsOn || audioOnly) return;
      fsBusy = true;
      try {
        // The current picture is frozen under a native cover first; the window resize and layout
        // change happen underneath, then the cover crossfades away. Nothing in between is visible.
        if (tauri) await tauri.invoke("fs_cover").catch(() => {}); // freezes the current picture (about one frame)
        if (on) {
          markFs(true);
          await tauri?.invoke("player_backdrop", { opaque: true }).catch(() => {});
          const already = await tauri?.invoke("is_fullscreen").catch(() => false);
          ownsWindowFs = !!tauri && !already;
          if (ownsWindowFs) await tauri.invoke("toggle_fullscreen", { on: true }).catch(() => {});
          await settled();
        } else {
          if (ownsWindowFs) { ownsWindowFs = false; await tauri.invoke("toggle_fullscreen", { on: false }).catch(() => {}); }
          await settled();
          markFs(false);
          await frames(2);
          await tauri?.invoke("player_backdrop", { opaque: false }).catch(() => {});
          await frames(2);
        }
      } finally {
        fsBusy = false;
        tauri?.invoke("fs_reveal", { ms: 170 }).catch(() => {}); // crossfade into the new layout
        root.focus({ preventScroll: true });
      }
    }
    const toggleFullscreen = () => setFullscreen(!fsOn);

    function onKey(e) {
      if (disposed || e.target.closest?.("input, textarea, select") && e.target !== vol) return;
      if (typeof e.key !== "string") return;
      const k = e.key.toLowerCase();
      if (k === "escape" && fsOn) { e.preventDefault(); e.stopImmediatePropagation(); setFullscreen(false); return; }
      const handled = {
        " ": () => (video.paused ? video.play() : video.pause()), k: () => (video.paused ? video.play() : video.pause()),
        arrowleft: () => seekTo(now() - SHORT), arrowright: () => seekTo(now() + SHORT), j: () => seekTo(now() - LONG), l: () => seekTo(now() + LONG),
        arrowup: () => (video.volume = Math.min(1, video.volume + 0.05)), arrowdown: () => (video.volume = Math.max(0, video.volume - 0.05)),
        m: () => (video.muted = !video.muted), f: () => !audioOnly && toggleFullscreen(),
        c: () => subs.length && selectSubs(cycle([null, ...subs.filter(s => s.text).map(s => s.id)], subSel)),
        a: () => audios.length > 1 && chooseAudio(cycle(audios.map(a => a.index), audioIdx)),
      }[k];
      if (handled) { e.preventDefault(); e.stopPropagation(); handled(); poke(); }
    }
    document.addEventListener("keydown", onKey, true);

    active = {
      dispose() {
        disposed = true;
        cancelAnimationFrame(raf); clearTimeout(hideTimer);
        document.removeEventListener("keydown", onKey, true);
        if (ownsWindowFs) { ownsWindowFs = false; tauri?.invoke("toggle_fullscreen", { on: false }).catch(() => {}); }
        if (fsOn) tauri?.invoke("player_backdrop", { opaque: false }).catch(() => {});
        document.documentElement.classList.remove("pf-player-fs");
        gen++; closeSession(); // stops FFmpeg
        video.pause(); video.removeAttribute("src"); video.load();
      },
    };

    syncVolume();
    const firstAudio = audios[0]?.index ?? null;
    streamPlanned = !(direct && (audioIdx === firstAudio || audioIdx == null));
    if (subSel) selectSubs(subSel);
    if (!streamPlanned) startDirect();
    else startStream(0, copyOk || audioOnly ? "Preparing…" : "Converting for playback…");
    root.focus({ preventScroll: true });
    poke();
  }


  // ---------------------------------------------------------------- safe rendered previews
  // Documents and live HTML/Markdown previews render in a sandboxed frame: no scripts, no
  // same-origin access, no navigation of the app. Network loads are blocked by the app's CSP.
  const FRAME_CSS = `body{font:15px/1.6 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;color:#1f1f1f;background:#fff;margin:0;padding:28px 40px;max-width:900px}
    h1{font-size:1.9em;margin:.6em 0 .3em}h2{font-size:1.45em;margin:.8em 0 .3em}h3{font-size:1.2em}h4{font-size:1.05em}
    p{margin:.35em 0}p.gap{height:.6em}img{max-width:100%;height:auto}table{border-collapse:collapse;margin:.8em 0}
    td,th{border:1px solid #d0d0d0;padding:4px 8px;vertical-align:top}blockquote{border-left:3px solid #c7c7c7;margin:.6em 0;padding:.2em 1em;color:#555}
    pre{background:#f4f4f4;padding:10px 12px;border-radius:6px;overflow:auto}code{background:#f4f4f4;padding:1px 4px;border-radius:4px;font-family:ui-monospace,Consolas,monospace}
    pre code{background:none;padding:0}.al-center{display:block;text-align:center}.al-right{display:block;text-align:right}.al-both{display:block;text-align:justify}
    section.slide{border:1px solid #ddd;border-radius:10px;padding:18px 24px;margin:0 0 18px;box-shadow:0 2px 8px rgba(0,0,0,.06)}.slide-no{font-size:12px;color:#888;margin-bottom:6px}hr.slide{margin:24px 0}
    a{color:#0067c0}`;
  function sandboxFrame(cls) {
    const f = document.createElement("iframe");
    f.className = cls; f.setAttribute("sandbox", ""); f.setAttribute("referrerpolicy", "no-referrer"); f.setAttribute("title", "Preview");
    return f;
  }
  const docShell = (body, css = FRAME_CSS) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;

  /** Small, safe Markdown renderer: text is escaped first; only known constructs become tags. */
  function markdown(src) {
    const e = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    // Allow-list: web links, mail, anchors, relative paths and bare domains. Any other scheme
    // (script, data, file...) becomes "#". The preview frame is also sandboxed without scripts.
    const safeUrl = u => /^(https?:|mailto:|#|\.{0,2}\/|[\w-]+\.)/i.test(u) ? u : "#";
    const inline = t => e(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, a, u) => `<img alt="${a}" src="${safeUrl(u)}">`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, a, u) => `<a href="${safeUrl(u)}">${a}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>").replace(/~~([^~]+)~~/g, "<s>$1</s>");
    const lines = String(src).replace(/\r\n/g, "\n").split("\n");
    let out = "", list = null, inCode = false, code = [], para = [];
    const flushPara = () => { if (para.length) { out += `<p>${inline(para.join(" "))}</p>`; para = []; } };
    const flushList = () => { if (list) { out += `</${list}>`; list = null; } };
    for (const line of lines) {
      if (/^```/.test(line)) { if (inCode) { out += `<pre><code>${e(code.join("\n"))}</code></pre>`; code = []; inCode = false; } else { flushPara(); flushList(); inCode = true; } continue; }
      if (inCode) { code.push(line); continue; }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
      else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushPara(); flushList(); out += "<hr>"; }
      else if ((m = line.match(/^\s*>\s?(.*)$/))) { flushPara(); flushList(); out += `<blockquote>${inline(m[1])}</blockquote>`; }
      else if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) { flushPara(); const t = /\d/.test(m[1]) ? "ol" : "ul"; if (list !== t) { flushList(); out += `<${t}>`; list = t; } out += `<li>${inline(m[2])}</li>`; }
      else if (!line.trim()) { flushPara(); flushList(); }
      else para.push(line.trim());
    }
    if (inCode) out += `<pre><code>${e(code.join("\n"))}</code></pre>`;
    flushPara(); flushList();
    return out;
  }
  const LIVE = new Set(["html", "htm", "xhtml", "md", "markdown", "svg"]);
  function livePreviewDoc(ext, text) {
    if (ext === "md" || ext === "markdown") return docShell(markdown(text));
    if (ext === "svg") return docShell(text, "body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff}svg{max-width:100%;height:auto}");
    return text; // HTML as written (scripts can't run in the sandbox)
  }

  async function renderDoc(file, host) {
    host.innerHTML = spinner("Opening document…");
    let html;
    try { html = await invoke("doc_render", { path: file.path }); }
    catch (e) { host.innerHTML = failure("Can't preview this document", String(e?.message || e), file); wireExternal(host, file); return; }
    host.innerHTML = `<div class="pv-doc"><div class="pv-bar"><span class="pv-pill">${esc(extOf(file.name).toUpperCase())}</span><span class="pv-pill">Preview (formatting simplified)</span><span style="flex:1"></span><button class="pf-btn" data-open-external>${I("open")} Open in default app</button></div></div>`;
    const frame = sandboxFrame("pv-docframe");
    frame.srcdoc = docShell(html);
    host.querySelector(".pv-doc").appendChild(frame);
    wireExternal(host, file);
    active = { dispose() {}, canClose: async () => true };
  }

  async function render(file, host, ctx = {}) {
    dispose();
    const k = kind(file);
    const box = host.closest(".viewer-box");
    box?.classList.toggle("pf-viewer-wide", k === "video" || k === "sheet" || k === "archive" || k === "text" || k === "doc");
    box?.classList.toggle("pf-viewer-media", k === "video");
    host.classList.remove("has-text");
    if (k === "video" || k === "audio") return renderMedia(file, host, k === "audio");
    if (k === "archive") return renderArchive(file, host, ctx);
    if (k === "sheet") return renderSheet(file, host);
    if (k === "text") return renderText(file, host);
    if (k === "doc") return renderDoc(file, host);
  }

  /** Lets an editor with unsaved changes ask before the viewer closes. */
  async function canClose() {
    try { return active?.canClose ? await active.canClose() : true; } catch { return true; }
  }

  window.PiViewer = { kind, render, dispose, canClose };
})();
