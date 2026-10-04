// PiFiles - File operations: copy, move, recycle, delete as background jobs with live progress.
//
// Starting an operation shows a preview card (what, how many, where to) that then flies into the
// File operations button in the title bar. The button carries a progress ring for everything
// in flight; its panel lists each job with bytes moved, speed, time left, the current file, and
// pause / cancel. Progress comes from the backend's `fileop://update` events (~8 per second).
(function () {
  const core = () => window.__TAURI__?.core;
  const invoke = (c, a) => core() ? core().invoke(c, a) : Promise.reject(new Error("no backend"));
  const I = (n) => (window.PiIcons ? PiIcons.ui(n) : "");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pref = (k, d) => { try { const v = window.PiSettings?.get(k); return v === undefined ? d : v; } catch { return d; } };
  const base = p => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
  const size = b => (window.__fmtSize ? window.__fmtSize(b) : `${b} B`);

  const jobs = new Map(); // id -> status
  let panel, list, btn, badge, ringFill, summary;
  let renderQueued = false;

  const VERB = {
    copy: ["Copying", "Copied", "copyTo"],
    move: ["Moving", "Moved", "moveTo"],
    recycle: ["Moving to the Recycle Bin", "Moved to the Recycle Bin", "delete"],
    delete: ["Deleting", "Deleted", "delete"],
  };

  function fmtSpeed(bps) {
    if (!bps) return "";
    return size(bps) + "/s";
  }
  function fmtEta(s) {
    if (s == null) return "";
    if (s < 60) return `${Math.max(1, s)} s left`;
    if (s < 3600) return `${Math.round(s / 60)} min left`;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return `${h} h ${m} min left`;
  }
  function fmtDur(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  }
  const items = n => `${n.toLocaleString()} item${n === 1 ? "" : "s"}`;

  function title(st) {
    const [ing, ed] = VERB[st.kind] || [st.kind, st.kind];
    const n = st.sources.length;
    const what = n === 1 ? `“${base(st.sources[0])}”` : items(n);
    const to = st.dest ? ` to ${base(st.dest)}` : "";
    return (finished(st) ? ed : ing) + " " + what + (st.kind === "copy" || st.kind === "move" ? to : "");
  }
  const finished = st => ["done", "failed", "cancelled"].includes(st.state);
  const active = () => [...jobs.values()].filter(s => !finished(s));

  function pct(st) {
    if (st.bytes_total > 0) return Math.min(100, (st.bytes_done / st.bytes_total) * 100);
    if (st.files_total > 0) return Math.min(100, (st.files_done / st.files_total) * 100);
    return finished(st) ? 100 : 0;
  }

  function detail(st) {
    if (st.state === "scanning") return "Counting items…";
    if (st.state === "cancelled") return "Cancelled";
    if (finished(st)) {
      const took = st.finished_ms && st.started_ms ? ` in ${fmtDur(st.finished_ms - st.started_ms)}` : "";
      const err = st.errors.length ? ` • ${st.errors.length} couldn't be processed` : "";
      const sk = st.skipped ? ` • ${st.skipped} skipped` : "";
      const vol = st.bytes_total ? ` • ${size(st.bytes_total)}` : "";
      return `${items(st.files_done)}${vol}${took}${sk}${err}`;
    }
    const parts = [];
    if (st.bytes_total) parts.push(`${size(st.bytes_done)} of ${size(st.bytes_total)}`);
    else if (st.files_total) parts.push(`${st.files_done.toLocaleString()} of ${items(st.files_total)}`);
    if (st.state === "paused") parts.push("Paused");
    else {
      if (st.speed_bps) parts.push(fmtSpeed(st.speed_bps));
      const eta = fmtEta(st.eta_secs);
      if (eta) parts.push(eta);
    }
    return parts.join(" • ");
  }

  function jobHtml(st) {
    const [, , ico] = VERB[st.kind] || [0, 0, "operations"];
    const p = pct(st);
    const fin = finished(st);
    const stateIco = st.state === "failed" || (fin && st.errors.length) ? I("error") : st.state === "done" ? I("done") : st.state === "cancelled" ? I("cancel") : I(ico);
    const cur = !fin && st.current ? `<div class="ops-cur" title="${esc(st.current)}">${esc(base(st.current))}</div>` : "";
    const errs = st.errors.length ? `<details class="ops-errs"><summary>${st.errors.length === 1 ? "1 problem" : `${st.errors.length} problems`}</summary>${st.errors.slice(0, 50).map(e => `<div>${esc(e)}</div>`).join("")}</details>` : "";
    const actions = fin
      ? `${st.dest && st.state === "done" && (st.kind === "copy" || st.kind === "move") ? `<button class="ops-act" data-open="${esc(st.dest)}" title="Open ${esc(base(st.dest))}">${I("openFolder")}</button>` : ""}<button class="ops-act" data-dismiss="${esc(st.id)}" title="Remove from list">${I("close")}</button>`
      : `<button class="ops-act" data-pause="${esc(st.id)}" title="${st.state === "paused" ? "Resume" : "Pause"}">${I(st.state === "paused" ? "play" : "pause")}</button><button class="ops-act" data-cancel="${esc(st.id)}" title="Cancel">${I("close")}</button>`;
    return `<div class="ops-job ${fin ? "fin" : ""} ops-${st.state}" data-id="${esc(st.id)}">
      <div class="ops-ico">${stateIco}</div>
      <div class="ops-main">
        <div class="ops-title" title="${esc(st.sources.join("\n"))}">${esc(title(st))}</div>
        <div class="ops-bar"><div class="ops-fill" style="transform:scaleX(${(p / 100).toFixed(4)})"></div></div>
        <div class="ops-detail">${esc(detail(st))}</div>
        ${cur}${errs}
      </div>
      <div class="ops-actions">${actions}</div>
    </div>`;
  }

  function render() {
    renderQueued = false;
    if (!btn) return;
    const all = [...jobs.values()].sort((a, b) => b.started_ms - a.started_ms);
    const act = active();
    // Ring = combined progress of everything still running.
    let done = 0, total = 0;
    for (const s of act) {
      if (s.bytes_total) { done += s.bytes_done; total += s.bytes_total; }
      else if (s.files_total) { done += s.files_done / s.files_total; total += 1; }
    }
    const frac = act.length ? (total ? done / total : 0) : 0;
    btn.classList.toggle("busy", act.length > 0);
    btn.classList.toggle("paused", act.length > 0 && act.every(s => s.state === "paused"));
    ringFill.style.strokeDashoffset = String(94.25 * (1 - frac));
    badge.hidden = act.length < 2;
    badge.textContent = String(act.length);
    btn.title = act.length ? `File operations - ${act.length === 1 ? title(act[0]) : `${act.length} running`} (${Math.round(frac * 100)}%)` : "File operations";
    if (panel && !panel.hidden) {
      summary.textContent = act.length ? `${act.length} running` : all.length ? "All done" : "";
      // Patch existing rows in place so hovering buttons doesn't flicker.
      const want = all.map(s => s.id);
      const have = [...list.children].map(el => el.dataset.id);
      if (want.join("|") !== have.join("|")) {
        list.innerHTML = all.length ? all.map(jobHtml).join("") : `<div class="ops-empty">${I("operations")}<div>No file operations yet</div><div class="ops-empty-sub">Copying, moving and deleting show up here with live progress.</div></div>`;
      } else {
        for (const st of all) {
          const el = list.querySelector(`[data-id="${CSS.escape(st.id)}"]`);
          if (!el) continue;
          const sig = `${st.state}|${st.errors.length}|${st.current}|${st.files_done}|${st.bytes_done}|${st.speed_bps}`;
          if (el.dataset.sig === sig) continue;
          el.dataset.sig = sig;
          const tmp = document.createElement("div");
          tmp.innerHTML = jobHtml(st);
          const fresh = tmp.firstElementChild;
          // keep <details> open state
          const wasOpen = el.querySelector("details")?.open;
          el.className = fresh.className;
          el.querySelector(".ops-ico").innerHTML = fresh.querySelector(".ops-ico").innerHTML;
          el.querySelector(".ops-title").textContent = fresh.querySelector(".ops-title").textContent;
          el.querySelector(".ops-fill").style.transform = fresh.querySelector(".ops-fill").style.transform;
          el.querySelector(".ops-detail").textContent = fresh.querySelector(".ops-detail").textContent;
          el.querySelector(".ops-main").querySelectorAll(".ops-cur, .ops-errs").forEach(n => n.remove());
          fresh.querySelectorAll(".ops-cur, .ops-errs").forEach(n => el.querySelector(".ops-main").appendChild(n));
          if (wasOpen) el.querySelector("details")?.setAttribute("open", "");
          const acts = el.querySelector(".ops-actions");
          if (acts.innerHTML !== fresh.querySelector(".ops-actions").innerHTML) acts.innerHTML = fresh.querySelector(".ops-actions").innerHTML;
        }
      }
    }
  }
  const queueRender = () => { if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); } };

  // ---------- panel ----------
  function openPanel() {
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const r = btn.getBoundingClientRect();
    panel.style.top = `${r.bottom + 6}px`;
    panel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    panel.classList.remove("open");
    void panel.offsetWidth;
    panel.classList.add("open");
    render();
  }
  function closePanel() {
    if (panel.hidden) return;
    panel.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    setTimeout(() => { if (!panel.classList.contains("open")) panel.hidden = true; }, 160);
  }

  // ---------- the card that flies into the button ----------
  function flyCard(st, origin) {
    if (pref("animations", true) === false || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { pulse(); return; }
    const [, , ico] = VERB[st.kind] || [0, 0, "operations"];
    const card = document.createElement("div");
    card.className = "ops-fly";
    const n = st.sources.length;
    card.innerHTML = `<div class="ops-fly-ico">${I(ico)}</div><div class="ops-fly-text"><div class="ops-fly-title">${esc(title(st))}</div><div class="ops-fly-sub">${esc(n === 1 ? base(st.sources[0]) : items(n))}${st.dest ? " → " + esc(st.dest) : ""}</div></div>`;
    document.body.appendChild(card);
    // Appear near where the action happened (button / menu / centre).
    const or = origin?.getBoundingClientRect?.();
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x = window.innerWidth / 2 - cw / 2, y = window.innerHeight - ch - 64;
    if (or && or.width) { x = Math.min(window.innerWidth - cw - 16, Math.max(16, or.left + or.width / 2 - cw / 2)); y = Math.min(window.innerHeight - ch - 16, or.bottom + 10); }
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.animate([{ opacity: 0, transform: "translateY(10px) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(0,0,0,1)", fill: "forwards" });
    setTimeout(() => {
      const b = btn.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const dx = b.left + b.width / 2 - (c.left + c.width / 2);
      const dy = b.top + b.height / 2 - (c.top + c.height / 2);
      const a = card.animate([
        { transform: "none", opacity: 1 },
        { transform: `translate(${dx * 0.6}px, ${dy * 0.55}px) scale(.55)`, opacity: .95, offset: .55 },
        { transform: `translate(${dx}px, ${dy}px) scale(.08)`, opacity: 0 },
      ], { duration: 520, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
      a.onfinish = () => { card.remove(); pulse(); };
    }, 900);
  }
  function pulse() {
    btn.classList.remove("pulse");
    void btn.offsetWidth;
    btn.classList.add("pulse");
  }

  // ---------- conflict question ----------
  function askConflict(names, kind) {
    return new Promise(resolve => {
      const d = document.createElement("div");
      d.className = "pf-dialog";
      d.setAttribute("role", "dialog");
      d.setAttribute("aria-modal", "true");
      const list = names.slice(0, 6).map(n => `<li>${esc(n)}</li>`).join("") + (names.length > 6 ? `<li>…and ${names.length - 6} more</li>` : "");
      d.innerHTML = `<div class="pf-dialog-scrim"></div><div class="pf-dialog-box ops-conflict" role="document">
        <div class="pf-dialog-content">
          <h2 class="pf-dialog-title">${names.length === 1 ? "An item with this name already exists" : `${names.length} items already exist here`}</h2>
          <ul class="ops-conflict-list">${list}</ul>
          <div class="ops-choices">
            <button class="ops-choice" data-c="replace">${I("copyTo")}<span><b>Replace</b><small>Overwrite what's there (a previous version is kept when Restore is on)</small></span></button>
            <button class="ops-choice" data-c="rename">${I("copy")}<span><b>Keep both</b><small>The ${kind === "move" ? "moved" : "copied"} item gets a new name like “name (2)”</small></span></button>
            <button class="ops-choice" data-c="newer">${I("history")}<span><b>Replace if newer</b><small>Only when the incoming file was changed more recently</small></span></button>
            <button class="ops-choice" data-c="skip">${I("forward")}<span><b>Skip</b><small>Leave existing items alone</small></span></button>
          </div>
        </div>
        <div class="pf-dialog-footer"><button class="pf-dialog-btn" data-c="">Cancel</button></div>
      </div>`;
      document.body.appendChild(d);
      window.PiMotion?.register(d, ".pf-dialog-box");
      requestAnimationFrame(() => { window.PiMotion ? PiMotion.open(d) : d.classList.remove("hidden"); d.querySelector('[data-c="rename"]').focus(); });
      const done = (c) => {
        document.removeEventListener("keydown", onKey, true);
        window.PiMotion ? PiMotion.close(d) : d.classList.add("hidden");
        setTimeout(() => d.remove(), 400);
        resolve(c || null);
      };
      const onKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); } };
      document.addEventListener("keydown", onKey, true);
      d.addEventListener("click", e => { const b = e.target.closest("[data-c]"); if (b) done(b.dataset.c); });
    });
  }

  // ---------- starting jobs ----------
  async function start(kind, sources, dest, opts = {}) {
    sources = (sources || []).filter(Boolean);
    if (!sources.length) return null;
    let conflict = opts.conflict || null;
    if ((kind === "copy" || kind === "move") && !conflict) {
      const def = pref("conflictDefault", "ask");
      let names = [];
      try { names = await invoke("fileop_conflicts", { sources, dest }); } catch {}
      if (names.length) conflict = def === "ask" ? await askConflict(names, kind) : def;
      if (names.length && !conflict) return null; // cancelled
    }
    let id;
    if (core()) {
      try { id = await invoke("fileop_start", { kind, sources, dest: dest || null, conflict }); }
      catch (e) { const m = String(e?.message || e); if (m !== "Cancelled") window.toast?.(m); return null; }
    } else {
      id = simulate(kind, sources, dest);
    }
    const st = { id, kind, state: "scanning", sources, dest: dest || null, current: "", files_done: 0, files_total: 0, bytes_done: 0, bytes_total: 0, speed_bps: 0, eta_secs: null, errors: [], skipped: 0, started_ms: Date.now(), finished_ms: null, outputs: [] };
    jobs.set(id, st);
    queueRender();
    flyCard(st, opts.origin);
    return id;
  }

  function onUpdate(st) {
    const prev = jobs.get(st.id);
    jobs.set(st.id, st);
    queueRender();
    if (finished(st) && (!prev || !finished(prev))) {
      const [, ed] = VERB[st.kind] || ["", "Done"];
      if (st.state === "done") {
        btn.classList.add("ok"); setTimeout(() => btn.classList.remove("ok"), 1400);
        const msg = st.errors.length ? `${ed} ${items(st.files_done)} - ${st.errors.length} couldn't be processed` : `${ed} ${st.sources.length === 1 ? `“${base(st.sources[0])}”` : items(st.sources.length)}`;
        window.toast?.(msg);
      } else if (st.state === "failed") {
        window.toast?.(st.errors[0] || "The operation failed");
        openPanel();
      }
      window.dispatchEvent(new CustomEvent("pifiles:fileop-done", { detail: st }));
    }
  }

  // Preview-browser fallback (no backend): a believable simulated job so the UI can be exercised.
  function simulate(kind, sources, dest) {
    const id = "sim" + Date.now();
    const total = 1.4e9, t0 = Date.now();
    const tick = () => {
      const j = jobs.get(id);
      if (!j) return;
      if (j._cancel) { onUpdate({ ...j, state: "cancelled", finished_ms: Date.now() }); return; }
      if (j._paused) { onUpdate({ ...j, state: "paused", speed_bps: 0, eta_secs: null }); setTimeout(tick, 150); return; }
      const done = Math.min(total, (j.bytes_done || 0) + 2.2e7);
      const st = { ...j, state: done >= total ? "done" : "running", files_total: 240, files_done: Math.round(240 * done / total), bytes_total: total, bytes_done: done, speed_bps: 1.45e8, eta_secs: Math.round((total - done) / 1.45e8), current: `${sources[0]}\\IMG_${1000 + Math.round(240 * done / total)}.jpg`, finished_ms: done >= total ? Date.now() : null };
      onUpdate(st);
      if (st.state === "running") setTimeout(tick, 120);
    };
    setTimeout(tick, 300);
    return id;
  }

  async function control(id, what) {
    const j = jobs.get(id);
    if (!j) return;
    if (what === "pause") {
      const paused = j.state !== "paused";
      if (core()) invoke("fileop_pause", { id, paused }).catch(() => {});
      else j._paused = paused;
      jobs.set(id, { ...j, state: paused ? "paused" : "running" });
      queueRender();
    } else if (what === "cancel") {
      if (core()) invoke("fileop_cancel", { id }).catch(() => {});
      else j._cancel = true;
    } else if (what === "dismiss") {
      jobs.delete(id);
      if (core()) invoke("fileop_dismiss", { id }).catch(() => {});
      queueRender();
    }
  }

  function init() {
    btn = document.getElementById("opsBtn");
    panel = document.getElementById("opsPanel");
    if (!btn || !panel) return;
    list = document.getElementById("opsList");
    badge = document.getElementById("opsBadge");
    summary = document.getElementById("opsSummary");
    ringFill = btn.querySelector(".ops-ring-fill");
    btn.addEventListener("click", e => { e.stopPropagation(); panel.hidden ? openPanel() : closePanel(); });
    document.addEventListener("pointerdown", e => { if (!panel.hidden && !e.target.closest("#opsPanel, #opsBtn")) closePanel(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) closePanel(); });
    window.addEventListener("resize", () => { if (!panel.hidden) openPanel(); });
    panel.addEventListener("click", e => {
      const b = e.target.closest("[data-pause],[data-cancel],[data-dismiss],[data-open]");
      if (!b) return;
      if (b.dataset.open) { closePanel(); window.__explorer?.navigateTo(b.dataset.open); return; }
      control(b.dataset.pause || b.dataset.cancel || b.dataset.dismiss, b.dataset.pause ? "pause" : b.dataset.cancel ? "cancel" : "dismiss");
    });
    document.getElementById("opsClear")?.addEventListener("click", () => {
      for (const [id, s] of jobs) if (finished(s)) jobs.delete(id);
      if (core()) invoke("fileop_dismiss", { id: null }).catch(() => {});
      queueRender();
    });
    window.__TAURI__?.event?.listen?.("fileop://update", ev => onUpdate(ev.payload));
    // Jobs that were already running (e.g. the window was reloaded).
    if (core()) invoke("fileop_list").then(v => { v.forEach(s => jobs.set(s.id, s)); queueRender(); }).catch(() => {});
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  window.PiOps = {
    copy: (sources, dest, opts) => start("copy", sources, dest, opts),
    move: (sources, dest, opts) => start("move", sources, dest, opts),
    recycle: (paths, opts) => start("recycle", paths, null, opts),
    remove: (paths, opts) => start("delete", paths, null, opts),
    open: () => openPanel(),
    get running() { return active().length; },
  };
})();
