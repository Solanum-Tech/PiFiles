// PiFiles - sharing and restoring:
//   • Share (the system share sheet on Windows), Share on network… (an SMB share like Explorer's
//     "Give access to"), with the list of folders currently shared from this PC;
//   • Restore previous versions… for a file, and Restore deleted files… for a folder, backed by
//     the de-duplicated version store (Settings → Restore).
(function () {
  const core = () => window.__TAURI__?.core;
  const invoke = (c, a) => core() ? core().invoke(c, a) : Promise.reject(new Error("This needs the desktop app"));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const I = n => (window.PiIcons ? PiIcons.ui(n) : "");
  const size = b => (window.__fmtSize ? window.__fmtSize(b) : `${b} B`);
  const base = p => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
  const when = ms => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  /** A ContentDialog-style sheet with arbitrary body; resolves with the clicked button's value. */
  function sheet({ title, body, buttons, wide, onMount }) {
    return new Promise(resolve => {
      const d = document.createElement("div");
      d.className = "pf-dialog";
      d.setAttribute("role", "dialog");
      d.setAttribute("aria-modal", "true");
      d.innerHTML = `<div class="pf-dialog-scrim"></div><div class="pf-dialog-box ${wide ? "pf-dialog-wide" : ""}" role="document">
        <div class="pf-dialog-content"><h2 class="pf-dialog-title">${esc(title)}</h2><div class="pf-sheet-body">${body}</div></div>
        <div class="pf-dialog-footer">${buttons.map(b => `<button class="pf-dialog-btn ${b.primary ? "primary" : ""} ${b.danger ? "danger" : ""}" data-v="${esc(b.value)}">${esc(b.label)}</button>`).join("")}</div>
      </div>`;
      document.body.appendChild(d);
      window.PiMotion?.register(d, ".pf-dialog-box");
      const close = (v) => {
        document.removeEventListener("keydown", onKey, true);
        window.PiMotion ? PiMotion.close(d) : d.classList.add("hidden");
        setTimeout(() => d.remove(), 400);
        resolve(v);
      };
      const onKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); } };
      document.addEventListener("keydown", onKey, true);
      d.addEventListener("click", e => {
        const b = e.target.closest(".pf-dialog-footer [data-v]");
        if (b) close(b.dataset.v || null);
      });
      onMount?.(d, close);
      requestAnimationFrame(() => (window.PiMotion ? PiMotion.open(d) : d.classList.remove("hidden")));
    });
  }

  // ---------------------------------------------------------------- Share
  async function share(paths) {
    if (!paths.length) { window.toast?.("Select something to share"); return; }
    try { await invoke("share_files", { paths }); }
    catch (first) {
      try { await invoke("shell_verb", { paths, verb: "Windows.ModernShare" }); return; } catch {}
      console.warn("share", first);
      // No share sheet on this system: copy the paths so they can be pasted into a message.
      try { await navigator.clipboard.writeText(paths.join("\r\n")); window.toast?.("Sharing isn't available here - paths copied instead"); }
      catch { window.toast?.("Sharing isn't available on this system"); }
    }
  }

  async function shareOnNetwork(folder) {
    let shares = [];
    try { shares = await invoke("list_shares"); } catch {}
    const existing = shares.find(s => s.path.toLowerCase().replace(/\\$/, "") === folder.toLowerCase().replace(/\\$/, ""));
    const others = shares.filter(s => s !== existing);
    const name0 = base(folder).replace(/[\\/[\]:|<>+=;,?*"]/g, "").slice(0, 60) || "Shared";
    const body = existing
      ? `<p class="pf-sheet-p">“${esc(base(folder))}” is shared on your network as <b>${esc(existing.name)}</b>.</p>
         <div class="pf-sheet-path">${esc(netPath(existing.name))}</div>`
      : `<p class="pf-sheet-p">People on your network can open this folder from File Explorer, Finder or a file manager. Windows asks for administrator permission.</p>
         <label class="pf-field"><span>Share name</span><input class="pf-text" data-name value="${esc(name0)}" maxlength="60" spellcheck="false"></label>
         <label class="pf-field"><span>Others can</span><select class="pf-select" data-access><option value="ro">View files (read-only)</option><option value="rw">View, add, change and delete files</option></select></label>`;
    const list = others.length ? `<h3 class="pf-sheet-h">Also shared from this PC</h3><div class="pf-sheet-list">${others.map(s => `<div class="pf-sheet-row"><span>${I("shareNet")}</span><span class="grow"><b>${esc(s.name)}</b><small>${esc(s.path)}</small></span><button class="pf-btn" data-unshare="${esc(s.name)}">Stop sharing</button></div>`).join("")}</div>` : "";
    let nameEl = null, accessEl = null;
    const v = await sheet({
      title: existing ? "Shared on the network" : `Share “${base(folder)}” on the network`,
      body: body + list,
      buttons: existing ? [{ label: "Copy network path", value: "copy" }, { label: "Stop sharing", value: "stop", danger: true }, { label: "Close", value: "" }]
        : [{ label: "Share", value: "share", primary: true }, { label: "Cancel", value: "" }],
      onMount: (d) => { nameEl = d.querySelector("[data-name]"); accessEl = d.querySelector("[data-access]"); d.addEventListener("click", async e => {
        const b = e.target.closest("[data-unshare]");
        if (!b) return;
        b.disabled = true; b.textContent = "Stopping…";
        try { await invoke("remove_share", { name: b.dataset.unshare }); b.closest(".pf-sheet-row").remove(); window.toast?.("Stopped sharing"); }
        catch (err) { window.toast?.(String(err?.message || err)); b.disabled = false; b.textContent = "Stop sharing"; }
      }); },
    });
    if (v === "copy") { navigator.clipboard?.writeText(netPath(existing.name)); window.toast?.("Network path copied"); }
    if (v === "stop") {
      try { await invoke("remove_share", { name: existing.name }); window.toast?.("Stopped sharing"); } catch (e) { window.toast?.(String(e?.message || e)); }
    }
    if (v === "share") {
      const name = (nameEl?.value || name0).trim();
      const ro = (accessEl?.value || "ro") === "ro";
      window.toast?.("Waiting for permission…");
      try {
        const where = await invoke("create_share", { path: folder, name, readOnly: ro });
        await sheet({ title: "Folder shared", body: `<p class="pf-sheet-p">Others on your network can now open it at:</p><div class="pf-sheet-path">${esc(where)}</div>`, buttons: [{ label: "Copy path", value: "copy", primary: true }, { label: "Done", value: "" }] })
          .then(x => { if (x === "copy") { navigator.clipboard?.writeText(where); window.toast?.("Network path copied"); } });
      } catch (e) { window.toast?.(String(e?.message || e)); }
    }
  }
  function netPath(name) {
    const host = window.__pcName || "this-PC";
    return `\\\\${host}\\${name}`;
  }

  // ---------------------------------------------------------------- previous versions
  async function restoreVersions(file) {
    let cfg = null, versions = [];
    try { cfg = await invoke("versions_config"); versions = await invoke("versions_list", { path: file }); } catch {}
    if (!cfg?.enabled && !versions.length) {
      const v = await sheet({
        title: "No previous versions yet",
        body: `<p class="pf-sheet-p">Turn on <b>Restore</b> in Settings to keep previous versions of files in the folders you choose. Versions are stored compressed and de-duplicated, so they take far less space than copies.</p>`,
        buttons: [{ label: "Open Restore settings", value: "settings", primary: true }, { label: "Close", value: "" }],
      });
      if (v === "settings") window.PiSettings?.open("restore");
      return;
    }
    let chosen = versions[0]?.id ?? null;
    const rows = versions.length
      ? versions.map((v, i) => `<label class="pf-sheet-row pf-ver ${i === 0 ? "on" : ""}"><input type="radio" name="ver" value="${v.id}" ${i === 0 ? "checked" : ""}><span>${I("history")}</span><span class="grow"><b>${esc(when(v.captured))}</b><small>Modified ${esc(when(v.modified * 1000))} • ${esc(size(v.size))}</small></span></label>`).join("")
      : `<div class="pf-sheet-empty">No versions of this file have been saved yet. A version is kept each time it changes from now on.</div>`;
    const v = await sheet({
      title: `Previous versions of “${base(file)}”`,
      wide: true,
      body: `<div class="pf-sheet-list pf-ver-list">${rows}</div>`,
      buttons: versions.length ? [{ label: "Restore", value: "restore", primary: true }, { label: "Restore to…", value: "to" }, { label: "Open", value: "open" }, { label: "Cancel", value: "" }] : [{ label: "Close", value: "" }],
      onMount: d => d.addEventListener("change", e => {
        if (e.target.name !== "ver") return;
        chosen = Number(e.target.value);
        d.querySelectorAll(".pf-ver").forEach(r => r.classList.toggle("on", r.contains(e.target)));
      }),
    });
    if (!v || chosen == null) return;
    try {
      if (v === "restore") {
        const ok = await PiDialog.confirm({ title: "Restore this version?", message: `“${base(file)}” is replaced by the version from ${when(chosen)}. The current content is kept as a version too, so you can switch back.`, okText: "Restore" });
        if (!ok) return;
        await invoke("versions_restore", { path: file, id: chosen, target: null });
        window.toast?.("Restored");
        window.dispatchEvent(new CustomEvent("pifiles:refresh"));
      } else if (v === "to") {
        const dir = await invoke("pick_folder", { title: "Restore the version to…", start: file.replace(/[\\/][^\\/]*$/, "") });
        if (!dir) return;
        const stamp = new Date(chosen).toISOString().slice(0, 16).replace(/[:T]/g, "-");
        const dot = base(file).lastIndexOf(".");
        const name = dot > 0 ? `${base(file).slice(0, dot)} (${stamp})${base(file).slice(dot)}` : `${base(file)} (${stamp})`;
        const out = await invoke("versions_restore", { path: file, id: chosen, target: dir.replace(/[\\/]$/, "") + "\\" + name });
        window.toast?.(`Saved ${out}`);
      } else if (v === "open") {
        const out = await invoke("versions_restore_temp", { path: file, id: chosen });
        window.__viewerOpen?.(out);
      }
    } catch (e) { window.toast?.("Couldn't restore: " + (e?.message || e)); }
  }

  async function restoreDeleted(folder) {
    let items = [];
    try { items = await invoke("versions_deleted", { folder }); } catch {}
    if (!items.length) {
      await sheet({ title: "Nothing to restore", body: `<p class="pf-sheet-p">No deleted files from this folder have saved versions. Only files in folders protected under Settings → Restore can be brought back here.</p>`, buttons: [{ label: "Close", value: "" }] });
      return;
    }
    const keep = new Set(items.map((_, i) => i));
    const v = await sheet({
      title: `Deleted from “${base(folder)}”`, wide: true,
      onMount: d => d.addEventListener("change", e => { const i = Number(e.target.dataset.i); if (e.target.checked) keep.add(i); else keep.delete(i); }),
      body: `<div class="pf-sheet-list">${items.map((it, i) => `<label class="pf-sheet-row"><input type="checkbox" data-i="${i}" checked><span>${window.PiIcons ? PiIcons.file({ name: it.path }) : ""}</span><span class="grow"><b>${esc(base(it.path))}</b><small>${esc(it.path)} • last saved ${esc(when(it.version.captured))} • ${esc(size(it.version.size))}</small></span></label>`).join("")}</div>`,
      buttons: [{ label: "Restore selected", value: "go", primary: true }, { label: "Cancel", value: "" }],
    });
    if (v !== "go") return;
    let n = 0;
    for (const i of keep) {
      const it = items[i];
      try { await invoke("versions_restore", { path: it.path, id: it.version.id, target: null }); n++; } catch {}
    }
    window.toast?.(`Restored ${n} file${n === 1 ? "" : "s"}`);
    window.dispatchEvent(new CustomEvent("pifiles:refresh"));
  }

  // ---------------------------------------------------------------- network locations
  async function addNetworkLocation() {
    const v = await PiDialog.prompt({ title: "Add a network location", message: "Type the address of a shared folder, e.g. \\\\NAS\\Photos or \\\\192.168.1.20\\share", placeholder: "\\\\server\\share", okText: "Add" });
    const p = String(v || "").trim();
    if (!p) return null;
    if (!/^\\\\[^\\]+/.test(p) && !/^[a-z]+:\/\//i.test(p)) { window.toast?.("That doesn't look like a network address (\\\\server\\share)"); return null; }
    const list = window.PiSettings?.get("netLocations") || [];
    if (!list.some(x => x.toLowerCase() === p.toLowerCase())) window.PiSettings?.set("netLocations", [...list, p]);
    return p;
  }

  if (core()) invoke("computer_name").then(n => { window.__pcName = n; }).catch(() => {});
  window.PiExtras = { share, shareOnNetwork, restoreVersions, restoreDeleted, addNetworkLocation, sheet };
})();
