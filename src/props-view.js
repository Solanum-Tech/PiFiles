// PiProps - full item properties (General + every detail the OS knows), shared by the
// right-hand details pane (compact) and the separate Properties window (tabs).
(function () {
  "use strict";
  const T = () => window.__TAURI__?.core;
  const call = (cmd, args) => (T() ? T().invoke(cmd, args) : Promise.reject(new Error("no backend")));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ico = n => (window.PiIcons?.ui ? PiIcons.ui(n) : "");

  function size(b) {
    if (b == null || isNaN(b)) return "-";
    if (b < 1024) return `${b} bytes`;
    const u = ["KB", "MB", "GB", "TB"]; let v = b / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${u[i]} (${Number(b).toLocaleString()} bytes)`;
  }
  const short = b => size(b).replace(/ \(.*\)$/, "");
  const date = ms => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) : "-");

  const row = (k, v, opts = {}) =>
    `<div class="pp-row${opts.wide ? " wide" : ""}"><span class="pp-k">${esc(k)}</span><span class="pp-v" title="${esc(opts.title ?? v)}">${opts.html ? v : esc(v)}</span>${opts.copy ? `<button class="pp-copy" data-copy="${esc(v)}" title="Copy">${ico("copy")}</button>` : ""}</div>`;
  const section = (title, body) => (body ? `<section class="pp-sec"><h4>${esc(title)}</h4>${body}</section>` : "");

  function head(p) {
    const icon = window.PiIcons
      ? (p.kind === "drive" ? PiIcons.drive({ path: p.path, type: p.drive?.drive_type }) : p.kind === "folder" ? PiIcons.folder?.() || "" : PiIcons.file?.({ name: p.name, extension: (p.name.split(".").pop() || "").toLowerCase() }) || "")
      : "";
    return `<div class="pp-head"><span class="pp-ico">${icon}</span><div class="pp-title"><b title="${esc(p.name)}">${esc(p.kind === "drive" && p.drive?.label ? `${p.drive.label} (${p.name})` : p.name)}</b><span>${esc(p.type_name)}</span></div></div>`;
  }

  function general(p, compact) {
    let h = "";
    if (p.kind === "drive" && p.drive) {
      const d = p.drive, used = d.total - d.free, pct = d.total ? Math.round((used / d.total) * 100) : 0;
      h += section("Drive", [
        row("Type", d.drive_type), row("File system", d.file_system || "-"), row("Label", d.label || "(none)"), row("Serial number", d.serial || "-"),
      ].join("") + `<div class="pp-donut"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.9" class="bg"/><circle cx="18" cy="18" r="15.9" class="fg" stroke-dasharray="${pct} ${100 - pct}"/></svg><div><div class="pp-legend used"><i></i>Used space<b>${esc(short(used))}</b></div><div class="pp-legend free"><i></i>Free space<b>${esc(short(d.free))}</b></div><div class="pp-legend"><i style="opacity:0"></i>Capacity<b>${esc(short(d.total))}</b></div></div></div>`);
    } else {
      const rows = [row("Type", p.type_name)];
      if (p.opens_with) rows.push(row("Opens with", p.opens_with));
      rows.push(row("Location", p.location || p.path, { copy: !compact }));
      if (p.kind === "folder") {
        rows.push(row("Size", `<span data-pp="fsize">Calculating…</span>`, { html: true }));
        if (!compact) rows.push(row("Size on disk", `<span data-pp="fdisk">Calculating…</span>`, { html: true }));
        rows.push(row("Contains", `<span data-pp="fcount">${compact ? "-" : "Calculating…"}</span>`, { html: true }));
      } else {
        rows.push(row("Size", size(p.size)));
        if (p.size_on_disk != null) rows.push(row("Size on disk", size(p.size_on_disk)));
      }
      if (p.link_target) rows.push(row("Link target", p.link_target, { copy: true }));
      h += section("General", rows.join(""));
    }
    h += section("Dates", [row("Created", date(p.created)), row("Modified", date(p.modified)), row("Accessed", date(p.accessed))].join(""));
    const attrs = p.attributes?.length ? p.attributes.join(", ") : "Normal";
    let sec = row("Attributes", attrs);
    if (p.owner) sec += row("Owner", p.owner);
    if (!compact && p.kind !== "drive") {
      sec += `<div class="pp-checks"><label><input type="checkbox" data-attr="readonly" ${p.readonly ? "checked" : ""}> Read-only</label><label><input type="checkbox" data-attr="hidden" ${p.hidden ? "checked" : ""}> Hidden</label></div>`;
    }
    h += section(compact ? "Attributes" : "Attributes & security", sec);
    return h;
  }

  function details(p) {
    if (!p.details?.length) return `<div class="pp-empty">No additional details for this item.</div>`;
    return p.details.map(g => section(g.title, g.items.map(([k, v]) => row(k, v)).join(""))).join("");
  }

  function hashes(p) {
    if (p.kind !== "file") return "";
    return section("Checksum", `<div class="pp-row wide"><span class="pp-k">SHA-256</span><span class="pp-v mono" data-pp="sha">-</span><button class="pf-btn pp-hash" data-hash>Calculate</button></div>`);
  }

  function wire(root, p, opts = {}) {
    root.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.classList.add("done"); setTimeout(() => b.classList.remove("done"), 900); })));
    root.querySelectorAll("[data-attr]").forEach(cb => cb.addEventListener("change", async () => {
      try { await call("set_file_attributes", { path: p.path, [cb.dataset.attr]: cb.checked }); }
      catch (e) { cb.checked = !cb.checked; alertMsg(root, String(e?.message || e)); }
    }));
    // (event.currentTarget is null once the handler awaits, so keep the button in a variable.)
    const hashBtn = root.querySelector("[data-hash]");
    let hash = null;
    hashBtn?.addEventListener("click", async () => {
      const out = root.querySelector('[data-pp="sha"]');
      if (hash) { navigator.clipboard?.writeText(hash).then(() => { hashBtn.textContent = "Copied"; setTimeout(() => (hashBtn.textContent = "Copy"), 1200); }); return; }
      hashBtn.disabled = true; hashBtn.textContent = "Calculating..."; if (out) out.textContent = "Calculating...";
      try {
        hash = await call("file_sha256", { path: p.path });
        if (out) { out.textContent = hash; out.title = hash; }
        hashBtn.textContent = "Copy";
      } catch (err) {
        if (out) out.textContent = String(err?.message || err);
        hashBtn.textContent = "Retry";
      } finally { hashBtn.disabled = false; }
    });
    if (p.kind === "folder" && opts.folderSize) {
      // The pane reuses the explorer's cached folder size instead of walking the tree on every selection.
      const set = (k, v) => { const el = root.querySelector(`[data-pp="${k}"]`); if (el) el.textContent = v; };
      if (opts.countLabel) set("fcount", opts.countLabel);
      Promise.resolve(opts.folderSize).then(b => set("fsize", b == null ? "-" : size(b))).catch(() => set("fsize", "-"));
    } else if (p.kind === "folder") {
      call("folder_stats", { path: p.path }).then(s => {
        const set = (k, v) => { const el = root.querySelector(`[data-pp="${k}"]`); if (el) el.textContent = v; };
        set("fsize", size(s.size)); set("fdisk", size(s.size_on_disk));
        set("fcount", `${s.files.toLocaleString()} file${s.files === 1 ? "" : "s"}, ${s.folders.toLocaleString()} folder${s.folders === 1 ? "" : "s"}`);
      }).catch(() => {});
    }
  }
  function alertMsg(root, msg) { const n = root.querySelector(".pp-msg") || root.appendChild(Object.assign(document.createElement("div"), { className: "pp-msg" })); n.textContent = msg; }

  /** Compact view for the right-hand pane: General, Dates, Attributes then all details. */
  async function renderPane(root, path, opts = {}) {
    root.innerHTML = `<div class="pp-loading">Reading properties…</div>`;
    let p;
    try { p = await call("file_properties", { path }); } catch (e) { root.innerHTML = `<div class="pp-empty">${esc(e?.message || e)}</div>`; return null; }
    if (root.dataset.for && root.dataset.for !== path) return null;
    root.innerHTML = `<div class="pp pp-compact">${general(p, true)}${details(p)}</div>`;
    wire(root, p, opts);
    return p;
  }

  /** Full Properties window: header, tabs (General / Details), multi-selection summary. */
  async function renderWindow(root, paths) {
    if (!paths.length) { root.innerHTML = `<div class="pp-empty">Nothing to show.</div>`; return; }
    if (paths.length > 1) {
      const all = await Promise.all(paths.map(path => call("file_properties", { path }).catch(() => null)));
      const ok = all.filter(Boolean);
      const files = ok.filter(p => p.kind === "file"), folders = ok.filter(p => p.kind !== "file");
      const total = files.reduce((a, p) => a + p.size, 0), disk = files.reduce((a, p) => a + (p.size_on_disk || 0), 0);
      const types = [...new Set(ok.map(p => p.type_name))];
      root.innerHTML = `<div class="pp"><div class="pp-head"><span class="pp-ico">${ico("copy")}</span><div class="pp-title"><b>${paths.length} items</b><span>${esc(types.length === 1 ? types[0] : "Multiple types")}</span></div></div>
        ${section("General", [row("Contains", `${files.length} file${files.length === 1 ? "" : "s"}, ${folders.length} folder${folders.length === 1 ? "" : "s"}`), row("Location", ok[0]?.location || ""), row("Size of files", size(total)), row("Size on disk", size(disk))].join(""))}
        ${section("Items", ok.map(p => row(p.name, p.kind === "file" ? short(p.size) : p.type_name)).join(""))}</div>`;
      return;
    }
    let p;
    try { p = await call("file_properties", { path: paths[0] }); } catch (e) { root.innerHTML = `<div class="pp-empty">${esc(e?.message || e)}</div>`; return; }
    const hasDetails = p.details?.length > 0;
    root.innerHTML = `<div class="pp">${head(p)}
      <div class="pp-tabs" role="tablist"><button role="tab" class="on" data-tab="general">General</button>${hasDetails ? `<button role="tab" data-tab="details">Details</button>` : ""}</div>
      <div class="pp-pane" data-pane="general">${general(p, false)}${hashes(p)}</div>
      ${hasDetails ? `<div class="pp-pane hidden" data-pane="details">${details(p)}</div>` : ""}</div>`;
    root.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => {
      root.querySelectorAll("[data-tab]").forEach(x => x.classList.toggle("on", x === b));
      root.querySelectorAll("[data-pane]").forEach(x => x.classList.toggle("hidden", x.dataset.pane !== b.dataset.tab));
    }));
    wire(root, p);
  }

  window.PiProps = { renderPane, renderWindow };
})();
