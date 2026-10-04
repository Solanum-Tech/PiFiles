// PiImageEditor - the image viewer/editor inside the preview window.
//
// Viewing: wheel / +/- zoom around the cursor, drag to pan, double-click toggles Fit / 100%,
//          arrow keys pan, 0 = fit, 1 = 100%.
// Editing: rotate, flip, crop (free or fixed ratios), light & colour adjustments, vignette,
//          and on-device AI tools: Auto enhance (analyses the photo's histogram and colour
//          cast), Portrait light (finds faces with the local YuNet detector and lifts them),
//          Smart crop (frames the faces). Every change is undoable (Ctrl+Z / Ctrl+Y).
// Saving:  Save (the previous file is always kept in File history first) or Save as copy.
//          JPEG metadata (camera, lens, date, GPS) is carried over by the backend.
// Rendering is non-destructive: the edit list is re-applied to the original each time, on the
// GPU via canvas filters, at screen resolution while editing and full resolution on save.
(function () {
  "use strict";
  const core = () => window.__TAURI__?.core;
  const invoke = (c, a) => (core() ? core().invoke(c, a) : Promise.reject(new Error("Editing needs the desktop app")));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const I = n => (window.PiIcons ? PiIcons.ui(n) : "");
  const toast = m => window.toast?.(m);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ADJ = [
    ["exposure", "Exposure", -100, 100], ["contrast", "Contrast", -100, 100], ["highlights", "Highlights", -100, 100],
    ["saturation", "Saturation", -100, 100], ["warmth", "Warmth", -100, 100], ["tint", "Tint", -100, 100],
    ["vignette", "Vignette", 0, 100],
  ];
  const blank = () => ({ rot: 0, flipH: false, flipV: false, crop: null, adj: Object.fromEntries(ADJ.map(a => [a[0], 0])), faceLight: null });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const extOf = p => (String(p).split(".").pop() || "").toLowerCase();
  const NATIVE_SAVE = { jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", png: "image/png", webp: "image/webp" };

  let active = null;

  function mount(host, file, opts) {
    dispose();
    const ed = new Editor(host, file, opts);
    active = ed;
    return ed;
  }
  function dispose() { try { active?.destroy(); } catch {} active = null; }
  async function canClose() { return active ? active.canClose() : true; }

  class Editor {
    constructor(host, file, opts) {
      this.host = host; this.file = file; this.opts = opts || {};
      this.src = opts.src; this.editable = !!opts.editable && !!core();
      this.E = blank(); this.saved = blank(); this.undo = []; this.redo = [];
      this.view = { s: 1, x: 0, y: 0 }; this.mode = "view"; this.panel = null;
      this.img = new Image(); this.img.decoding = "async";
      this.build();
      this.img.onload = () => { this.W0 = this.img.naturalWidth; this.H0 = this.img.naturalHeight; this.hidePh(); this.refresh(true); };
      this.img.onerror = () => this.opts.onError?.(this);
      this.img.src = this.src; // shows immediately (streamed)
      // For editing, the pixels must be same-origin (a canvas fed from the asset protocol is
      // "tainted" and can't be saved), so the original bytes are fetched as a blob in parallel.
      if (this.editable && /^https?:\/\/asset\.localhost\//.test(this.src)) {
        invoke("read_image_bytes", { path: this.file.path }).then(buf => {
          if (!this.host.isConnected) return;
          this.blobUrl = URL.createObjectURL(new Blob([buf]));
          const wasEdited = this.dirty();
          const img = new Image(); img.decoding = "async";
          img.onload = () => { this.img = img; if (wasEdited || this.dirty()) this.refresh(); };
          img.src = this.blobUrl;
        }).catch(() => { this.editable = false; this.host.querySelectorAll("[data-ie=save],[data-ie=save-copy]").forEach(b => (b.title = "This image can't be saved from here")); });
      }
    }

    // ------------------------------------------------------------------ UI
    build() {
      const e = this.editable;
      const btn = (act, icon, title, extra = "") => `<button class="ie-b" data-ie="${act}" title="${esc(title)}" ${extra}>${icon}</button>`;
      this.host.innerHTML = `<div class="ie">
        <div class="ie-bar">
          <div class="ie-grp">${btn("zoom-out", "−", "Zoom out (-)")}<button class="ie-zoom" data-ie="zoom-fit" title="Fit to window (0)">Fit</button>${btn("zoom-in", "+", "Zoom in (+)")}${btn("zoom-100", "1:1", "Actual size (1)")}</div>
          ${e ? `<span class="ie-sep"></span>
          <div class="ie-grp">${btn("rot-l", "⟲", "Rotate left (Shift+R)")}${btn("rot-r", "⟳", "Rotate right (R)")}${btn("flip-h", "⇋", "Flip horizontal")}${btn("flip-v", "⇵", "Flip vertical")}</div>
          <span class="ie-sep"></span>
          <div class="ie-grp">${btn("crop", "⛶ <span>Crop</span>", "Crop (C)", 'class="ie-b wide"')}${btn("adjust", "☀ <span>Adjust</span>", "Light and colour", 'class="ie-b wide"')}${btn("ai", "✦ <span>AI tools</span>", "On-device AI tools", 'class="ie-b wide"')}</div>
          <span class="ie-sep"></span>
          <div class="ie-grp">${btn("undo", I("undo") || "↶", "Undo (Ctrl+Z)", "disabled")}${btn("redo", "↷", "Redo (Ctrl+Y)", "disabled")}${btn("reset", "Reset", "Discard all edits", 'class="ie-b wide" disabled')}</div>` : ""}
          <span class="ie-fill"></span>
          ${e ? `<button class="ie-b wide" data-ie="history" title="Earlier versions of this file">${I("history")} <span>File history</span></button>
          <div class="ie-grp"><button class="pf-btn" data-ie="save-copy" disabled title="Save the edited picture as a new file">Save as copy</button><button class="pf-btn primary" data-ie="save" disabled title="Save (Ctrl+S). The original is kept in File history.">Save</button></div>` : ""}
        </div>
        <div class="ie-main">
          <div class="ie-stage" tabindex="0">
            ${this.opts.thumb ? `<img class="ie-ph" src="${esc(this.opts.thumb)}" alt="">` : `<div class="ie-ph spin"><span class="lm-spin"></span></div>`}
            <div class="ie-layer"></div>
            <div class="ie-crop hidden"><div class="ie-crop-box"><i data-h="nw"></i><i data-h="n"></i><i data-h="ne"></i><i data-h="e"></i><i data-h="se"></i><i data-h="s"></i><i data-h="sw"></i><i data-h="w"></i><b class="g1"></b><b class="g2"></b><b class="g3"></b><b class="g4"></b></div></div>
          </div>
          <aside class="ie-side hidden"></aside>
        </div>
        <div class="ie-foot"><span data-ie-info></span><span class="ie-fill"></span><span class="ie-hint">Scroll to zoom · drag to move · double-click for 100%</span></div>
      </div>`;
      this.$ = s => this.host.querySelector(s);
      this.stage = this.$(".ie-stage"); this.layer = this.$(".ie-layer"); this.side = this.$(".ie-side");
      this.cropEl = this.$(".ie-crop"); this.cropBox = this.$(".ie-crop-box");
      this.onClick = ev => this.click(ev);
      this.host.addEventListener("click", this.onClick);
      this.bindStage();
      this.onKey = ev => this.key(ev);
      document.addEventListener("keydown", this.onKey, true);
      this.ro = new ResizeObserver(() => { if (this.fitted) this.fit(); else this.applyView(); if (this.mode === "crop") this.drawCrop(); });
      this.ro.observe(this.stage);
    }
    hidePh() { this.$(".ie-ph")?.remove(); }
    destroy() {
      document.removeEventListener("keydown", this.onKey, true);
      this.host.removeEventListener("click", this.onClick);
      this.ro?.disconnect();
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    }
    dirty() { return !same(this.E, this.saved); }
    async canClose() {
      if (!this.dirty()) return true;
      return window.PiDialog ? PiDialog.confirm({ title: "Discard your edits?", message: `Your changes to “${this.file.name}” haven't been saved.`, okText: "Discard", danger: true }) : confirm("Discard your edits?");
    }

    // ------------------------------------------------------------------ geometry
    /** Logical (full-resolution) size of the edited picture. */
    dims(E = this.E) {
      const r = E.rot % 180 !== 0;
      let w = r ? this.H0 : this.W0, h = r ? this.W0 : this.H0;
      if (E.crop) { w = Math.max(1, Math.round(w * E.crop.w)); h = Math.max(1, Math.round(h * E.crop.h)); }
      return { w, h };
    }
    /** Upright normalised point → rotated/flipped normalised point (same order as render()). */
    mapPt(u, v, E = this.E) {
      if (E.flipH) u = 1 - u;
      if (E.flipV) v = 1 - v;
      switch ((E.rot % 360 + 360) % 360) { case 90: return [1 - v, u]; case 180: return [1 - u, 1 - v]; case 270: return [v, 1 - u]; default: return [u, v]; }
    }
    mapRect([x, y, w, h], E = this.E) {
      const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([a, b]) => this.mapPt(a, b, E));
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    }

    // ------------------------------------------------------------------ rendering
    filterOf(a) {
      const f = [];
      if (a.exposure) f.push(`brightness(${(1 + a.exposure / 125).toFixed(3)})`);
      if (a.contrast) f.push(`contrast(${(1 + a.contrast / 110).toFixed(3)})`);
      if (a.saturation) f.push(`saturate(${(1 + a.saturation / 100).toFixed(3)})`);
      return f.join(" ") || "none";
    }
    /** Renders the edit list onto a canvas, long side ≤ maxLong (Infinity = full size). */
    render(maxLong, E = this.E) {
      const W0 = this.W0, H0 = this.H0;
      const k = Math.min(1, maxLong / Math.max(W0, H0));
      const uw = Math.max(1, Math.round(W0 * k)), uh = Math.max(1, Math.round(H0 * k));
      const a = E.adj;
      // 1. upright, with light/colour
      const U = document.createElement("canvas"); U.width = uw; U.height = uh;
      const u = U.getContext("2d");
      u.filter = this.filterOf(a);
      u.drawImage(this.img, 0, 0, uw, uh);
      u.filter = "none";
      const overlay = (color, alpha, op) => { if (alpha <= 0) return; u.globalCompositeOperation = op; u.globalAlpha = alpha; u.fillStyle = color; u.fillRect(0, 0, uw, uh); u.globalAlpha = 1; u.globalCompositeOperation = "source-over"; };
      if (a.warmth) overlay(a.warmth > 0 ? "rgb(255,138,40)" : "rgb(40,120,255)", Math.abs(a.warmth) / 260, "soft-light");
      if (a.tint) overlay(a.tint > 0 ? "rgb(230,40,200)" : "rgb(40,220,90)", Math.abs(a.tint) / 320, "soft-light");
      if (a.highlights) overlay(a.highlights > 0 ? "#fff" : "#000", Math.abs(a.highlights) / 400, a.highlights > 0 ? "screen" : "multiply");
      if (E.faceLight?.faces?.length) {
        u.globalCompositeOperation = "soft-light";
        for (const [fx, fy, fw, fh] of E.faceLight.faces) {
          const cx = (fx + fw / 2) * uw, cy = (fy + fh / 2) * uh, r = Math.max(fw * uw, fh * uh) * 1.35;
          const g = u.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
          const amt = E.faceLight.amount / 100;
          g.addColorStop(0, `rgba(255,236,220,${(0.85 * amt).toFixed(3)})`); g.addColorStop(1, "rgba(255,236,220,0)");
          u.fillStyle = g; u.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
        u.globalCompositeOperation = "source-over";
      }
      // 2. rotate + flip
      const rot = (E.rot % 360 + 360) % 360, sw = rot % 180 ? uh : uw, sh = rot % 180 ? uw : uh;
      const R = document.createElement("canvas"); R.width = sw; R.height = sh;
      const r = R.getContext("2d");
      r.translate(sw / 2, sh / 2); r.rotate(rot * Math.PI / 180); r.scale(E.flipH ? -1 : 1, E.flipV ? -1 : 1);
      r.drawImage(U, -uw / 2, -uh / 2);
      // 3. crop
      let C = R;
      if (E.crop) {
        const cx = Math.round(E.crop.x * sw), cy = Math.round(E.crop.y * sh), cw = Math.max(1, Math.round(E.crop.w * sw)), ch = Math.max(1, Math.round(E.crop.h * sh));
        C = document.createElement("canvas"); C.width = cw; C.height = ch;
        C.getContext("2d").drawImage(R, cx, cy, cw, ch, 0, 0, cw, ch);
      }
      // 4. vignette
      if (a.vignette) {
        const c = C.getContext("2d"), w = C.width, h = C.height;
        const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.hypot(w, h) / 2);
        g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${(a.vignette / 100 * 0.75).toFixed(3)})`);
        c.fillStyle = g; c.fillRect(0, 0, w, h);
      }
      return C;
    }
    /** Shows the original (<img>, sharpest) when unedited, else a screen-resolution render. */
    refresh(first) {
      if (!this.W0) return;
      const E = this.mode === "crop" ? { ...this.E, crop: null } : this.E;
      const unedited = same(E, blank());
      let el;
      if (unedited) { el = this.img; el.className = "ie-pic"; el.draggable = false; }
      else {
        const long = Math.min(Math.max(this.W0, this.H0), Math.max(2400, Math.round(Math.max(screen.width, screen.height) * devicePixelRatio)));
        el = this.render(long, E); el.className = "ie-pic";
      }
      const d = this.dims(E);
      el.style.width = d.w + "px"; el.style.height = d.h + "px";
      this.layer.replaceChildren(el);
      this.D = d;
      if (first || this.fitted) this.fit(); else this.applyView();
      this.updateBar();
      const info = this.$("[data-ie-info]");
      if (info) info.textContent = `${this.dims().w} × ${this.dims().h}${this.dirty() ? " · edited" : ""}`;
    }

    // ------------------------------------------------------------------ zoom / pan
    fit() {
      const sw = this.stage.clientWidth, sh = this.stage.clientHeight; if (!this.D || !sw) return;
      const s = Math.min(sw / this.D.w, sh / this.D.h, 1);
      this.view = { s, x: (sw - this.D.w * s) / 2, y: (sh - this.D.h * s) / 2 }; this.fitted = true; this.applyView();
    }
    zoomAt(ns, px, py) {
      const v = this.view, sw = this.stage.clientWidth, sh = this.stage.clientHeight;
      ns = clamp(ns, Math.min(0.02, v.s), 32);
      if (px == null) { px = sw / 2; py = sh / 2; }
      v.x = px - (px - v.x) * (ns / v.s); v.y = py - (py - v.y) * (ns / v.s); v.s = ns; this.fitted = false; this.applyView();
    }
    applyView() {
      const v = this.view, sw = this.stage.clientWidth, sh = this.stage.clientHeight;
      if (this.D) {
        const w = this.D.w * v.s, h = this.D.h * v.s;
        // keep the picture on screen: centred when smaller than the stage, edges clamped when larger
        v.x = w <= sw ? (sw - w) / 2 : clamp(v.x, sw - w, 0);
        v.y = h <= sh ? (sh - h) / 2 : clamp(v.y, sh - h, 0);
        this.stage.classList.toggle("pannable", w > sw + 1 || h > sh + 1);
      }
      this.layer.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
      const z = this.$(".ie-zoom"); if (z) z.textContent = this.fitted ? "Fit" : Math.round(v.s * 100) + "%";
      this.layer.classList.toggle("pixelated", v.s >= 3);
      if (this.mode === "crop") this.drawCrop();
    }
    bindStage() {
      const st = this.stage;
      st.addEventListener("wheel", ev => {
        ev.preventDefault();
        const r = st.getBoundingClientRect();
        this.zoomAt(this.view.s * Math.pow(1.0018, -ev.deltaY * (ev.deltaMode === 1 ? 30 : 1)), ev.clientX - r.left, ev.clientY - r.top);
      }, { passive: false });
      st.addEventListener("dblclick", ev => {
        if (this.mode === "crop") return;
        const r = st.getBoundingClientRect();
        if (this.fitted) this.zoomAt(1, ev.clientX - r.left, ev.clientY - r.top); else this.fit();
      });
      let drag = null;
      st.addEventListener("pointerdown", ev => {
        if (ev.button !== 0 || ev.target.closest(".ie-crop-box")) return;
        drag = { x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y };
        st.setPointerCapture(ev.pointerId); st.classList.add("dragging");
      });
      st.addEventListener("pointermove", ev => {
        if (!drag) return;
        this.view.x = drag.vx + ev.clientX - drag.x; this.view.y = drag.vy + ev.clientY - drag.y; this.fitted = false; this.applyView();
      });
      const end = () => { drag = null; st.classList.remove("dragging"); };
      st.addEventListener("pointerup", end); st.addEventListener("pointercancel", end);
      this.bindCrop();
    }

    // ------------------------------------------------------------------ edits
    push(next, label) {
      if (same(next, this.E)) return;
      this.undo.push(this.E); if (this.undo.length > 100) this.undo.shift();
      this.redo = []; this.E = next; this.refresh(); if (label) this.flash(label);
    }
    edit(fn, label) { const n = structuredClone(this.E); fn(n); this.push(n, label); }
    flash(t) { const i = this.$("[data-ie-info]"); if (!i) return; i.dataset.flash = t; }
    updateBar() {
      const set = (a, on) => { const b = this.$(`[data-ie="${a}"]`); if (b) b.disabled = !on; };
      set("undo", this.undo.length); set("redo", this.redo.length); set("reset", !same(this.E, blank()));
      set("save", this.dirty()); set("save-copy", this.dirty());
      this.host.closest(".viewer-box")?.classList.toggle("pv-dirty", this.dirty());
    }
    doUndo() { if (!this.undo.length) return; this.redo.push(this.E); this.E = this.undo.pop(); this.refresh(); this.renderPanel(); }
    doRedo() { if (!this.redo.length) return; this.undo.push(this.E); this.E = this.redo.pop(); this.refresh(); this.renderPanel(); }

    // ------------------------------------------------------------------ side panels
    openPanel(name) {
      if (this.mode === "crop" && name !== "crop") this.endCrop(false);
      this.panel = this.panel === name ? null : name;
      this.host.querySelectorAll("[data-ie=adjust],[data-ie=ai],[data-ie=crop]").forEach(b => b.classList.toggle("on", b.dataset.ie === this.panel));
      this.renderPanel();
      requestAnimationFrame(() => (this.fitted ? this.fit() : this.applyView()));
    }
    renderPanel() {
      const p = this.panel, side = this.side;
      side.classList.toggle("hidden", !p);
      if (!p) { side.innerHTML = ""; return; }
      if (p === "adjust") {
        side.innerHTML = `<h4>Light & colour</h4>${ADJ.map(([k, l, mn, mx]) => `<label class="ie-sl"><span>${l}<b data-v="${k}">${this.E.adj[k]}</b></span><input type="range" min="${mn}" max="${mx}" value="${this.E.adj[k]}" data-adj="${k}"></label>`).join("")}
          <div class="ie-row"><button class="pf-btn small" data-ie="adj-reset">Reset light & colour</button></div>`;
        side.querySelectorAll("[data-adj]").forEach(inp => {
          let base = null;
          inp.addEventListener("input", () => {
            if (!base) base = structuredClone(this.E); // state before this drag / key press
            const k = inp.dataset.adj; side.querySelector(`[data-v="${k}"]`).textContent = inp.value;
            this.E = structuredClone(this.E); this.E.adj[k] = Number(inp.value);
            cancelAnimationFrame(this._raf); this._raf = requestAnimationFrame(() => this.refresh());
          });
          inp.addEventListener("change", () => { // one undo step per drag
            const before = base; base = null;
            if (before && !same(before, this.E)) { this.undo.push(before); this.redo = []; }
            this.refresh();
          });
        });
      } else if (p === "ai") {
        const fl = this.E.faceLight;
        side.innerHTML = `<h4>AI tools <small>run on this computer</small></h4>
          <button class="ie-tool" data-ie="ai-auto"><b>✦ Auto enhance</b><span>Analyses brightness, contrast and colour cast, then sets the sliders. Fine-tune them in Adjust.</span></button>
          <button class="ie-tool" data-ie="ai-portrait"><b>☺ Portrait light</b><span>Finds faces with the on-device face detector and gently lifts them.</span></button>
          ${fl ? `<label class="ie-sl"><span>Portrait light<b data-v="fl">${fl.amount}</b></span><input type="range" min="0" max="100" value="${fl.amount}" data-fl></label>` : ""}
          <button class="ie-tool" data-ie="ai-smartcrop"><b>⛶ Smart crop</b><span>Frames the people in the photo using the rule of thirds (4:5). Adjust before applying.</span></button>`;
        const r = side.querySelector("[data-fl]");
        if (r) r.addEventListener("change", () => this.edit(n => { n.faceLight.amount = Number(r.value); }));
      } else if (p === "crop") {
        side.innerHTML = `<h4>Crop</h4><div class="ie-ratios">${[["free", "Free"], ["orig", "Original"], ["1", "1:1"], ["0.8", "4:5"], ["1.5", "3:2"], ["1.3333", "4:3"], ["1.7778", "16:9"], ["0.5625", "9:16"]].map(([v, l]) => `<button class="pf-btn small ${String(this.ratio ?? "free") === v ? "on" : ""}" data-ratio="${v}">${l}</button>`).join("")}</div>
          <div class="ie-row"><button class="pf-btn primary" data-ie="crop-apply">Apply crop</button><button class="pf-btn" data-ie="crop-cancel">Cancel</button>${this.E.crop ? `<button class="pf-btn" data-ie="crop-clear">Remove crop</button>` : ""}</div>
          <p class="ie-note">Drag the corners or edges; drag inside to move. Enter applies, Esc cancels.</p>`;
      }
    }

    // ------------------------------------------------------------------ crop
    startCrop(rect) {
      this.mode = "crop"; this.cropRect = rect || this.E.crop || { x: 0, y: 0, w: 1, h: 1 };
      this.cropEl.classList.remove("hidden"); this.panel = "crop";
      this.host.querySelectorAll("[data-ie=adjust],[data-ie=ai],[data-ie=crop]").forEach(b => b.classList.toggle("on", b.dataset.ie === "crop"));
      this.renderPanel(); this.refresh(); this.fit();
    }
    endCrop(apply) {
      const rect = this.cropRect; this.mode = "view"; this.cropEl.classList.add("hidden");
      if (apply && rect) {
        const full = rect.w > 0.995 && rect.h > 0.995;
        this.edit(n => { n.crop = full ? null : { ...rect }; }, "Cropped");
      } else this.refresh();
      this.panel = null; this.renderPanel();
      this.host.querySelectorAll("[data-ie=crop]").forEach(b => b.classList.remove("on"));
      requestAnimationFrame(() => this.fit());
    }
    drawCrop() {
      const v = this.view, D = this.D, c = this.cropRect; if (!D || !c) return;
      Object.assign(this.cropBox.style, { left: v.x + c.x * D.w * v.s + "px", top: v.y + c.y * D.h * v.s + "px", width: c.w * D.w * v.s + "px", height: c.h * D.h * v.s + "px" });
    }
    applyRatio(ratio) {
      this.ratio = ratio;
      if (ratio === "free") return;
      const D = this.D, c = this.cropRect;
      const want = ratio === "orig" ? this.W0 / this.H0 : Number(ratio); // width / height in pixels
      let w = c.w * D.w, h = c.h * D.h;
      if (w / h > want) w = h * want; else h = w / want;
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      let nw = w / D.w, nh = h / D.h;
      this.cropRect = { x: clamp(cx - nw / 2, 0, 1 - nw), y: clamp(cy - nh / 2, 0, 1 - nh), w: nw, h: nh };
      this.drawCrop();
    }
    bindCrop() {
      let g = null;
      this.cropBox.addEventListener("pointerdown", ev => {
        ev.stopPropagation(); this.cropBox.setPointerCapture(ev.pointerId);
        g = { h: ev.target.dataset.h || "move", x: ev.clientX, y: ev.clientY, r: { ...this.cropRect } };
      });
      this.cropBox.addEventListener("pointermove", ev => {
        if (!g) return;
        const D = this.D, s = this.view.s, dx = (ev.clientX - g.x) / (D.w * s), dy = (ev.clientY - g.y) / (D.h * s);
        let { x, y, w, h } = g.r; const min = 0.03;
        if (g.h === "move") { x = clamp(x + dx, 0, 1 - w); y = clamp(y + dy, 0, 1 - h); }
        else {
          if (g.h.includes("w")) { const nx = clamp(x + dx, 0, x + w - min); w += x - nx; x = nx; }
          if (g.h.includes("e")) w = clamp(w + dx, min, 1 - x);
          if (g.h.includes("n")) { const ny = clamp(y + dy, 0, y + h - min); h += y - ny; y = ny; }
          if (g.h.includes("s")) h = clamp(h + dy, min, 1 - y);
          const ratio = this.ratio && this.ratio !== "free" ? (this.ratio === "orig" ? this.W0 / this.H0 : Number(this.ratio)) : 0;
          if (ratio) { const pxw = w * D.w, pxh = h * D.h; if (/[ns]/.test(g.h) && !/[ew]/.test(g.h)) w = Math.min(pxh * ratio / D.w, 1 - x); else h = Math.min(pxw / ratio / D.h, 1 - y); }
        }
        this.cropRect = { x, y, w, h }; this.drawCrop();
      });
      const end = () => { g = null; };
      this.cropBox.addEventListener("pointerup", end); this.cropBox.addEventListener("pointercancel", end);
    }

    // ------------------------------------------------------------------ AI tools
    autoEnhance() {
      const c = this.render(256, { ...this.E, adj: blank().adj, faceLight: null });
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const hist = new Uint32Array(256); let rs = 0, gs = 0, bs = 0, sat = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], l = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
        hist[l]++; rs += r; gs += g; bs += b; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); sat += mx ? (mx - mn) / mx : 0; n++;
      }
      const pct = q => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= q * n) return i / 255; } return 1; };
      const lo = pct(0.01), mid = pct(0.5), hi = pct(0.99);
      const exposure = Math.round(clamp((0.5 - mid) * 140, -45, 45));
      const contrast = Math.round(clamp((0.92 - (hi - lo)) * 70, -15, 40));
      const warmth = Math.round(clamp(((bs - rs) / n / 255) * 160, -35, 35));
      const tint = Math.round(clamp(((gs - (rs + bs) / 2) / n / 255) * -160, -25, 25));
      const saturation = Math.round(clamp((0.32 - sat / n) * 60, -10, 25));
      this.edit(e => { Object.assign(e.adj, { exposure, contrast, warmth, tint, saturation }); }, "Auto enhanced");
      if (this.panel === "adjust") this.renderPanel();
      toast("Auto enhance applied - fine-tune it in Adjust");
    }
    async faces() {
      if (this._faces) return this._faces;
      this.flash("Finding faces…");
      const r = await invoke("image_detect_faces", { path: this.file.path });
      this._faces = r.faces || [];
      return this._faces;
    }
    async portraitLight() {
      const f = await this.faces();
      if (!f.length) { toast("No faces found in this photo"); return; }
      this.edit(e => { e.faceLight = { faces: f, amount: 45 }; }, "Portrait light");
      this.renderPanel();
      toast(`Lifted ${f.length} face${f.length === 1 ? "" : "s"}`);
    }
    async smartCrop() {
      const f = await this.faces();
      const tmp = { ...this.E, crop: null };
      const D = this.dims(tmp), ratio = 0.8;
      // largest 4:5 (w:h in pixels) rectangle that fits
      let w, h;
      if (D.w / D.h > ratio) { h = 1; w = (ratio * D.h) / D.w; } else { w = 1; h = D.w / (ratio * D.h); }
      let cx = 0.5, cy = 0.5;
      if (f.length) {
        const rs = f.map(r => this.mapRect(r, tmp));
        const x0 = Math.min(...rs.map(r => r[0])), y0 = Math.min(...rs.map(r => r[1])), x1 = Math.max(...rs.map(r => r[0] + r[2])), y1 = Math.max(...rs.map(r => r[1] + r[3]));
        cx = (x0 + x1) / 2; cy = (y0 + y1) / 2 + h / 6; // faces on the upper third line
      } else toast("No faces found - centred the crop");
      this.startCrop({ x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h });
      this.ratio = "0.8"; this.renderPanel();
    }

    // ------------------------------------------------------------------ save
    async save(asCopy) {
      if (!this.dirty()) return;
      const ext = extOf(this.file.path);
      const type = NATIVE_SAVE[ext] || "image/jpeg";
      if (!asCopy && !NATIVE_SAVE[ext]) { toast(`.${ext} files are saved as a JPEG copy`); asCopy = true; }
      const btn = this.$(`[data-ie="${asCopy ? "save-copy" : "save"}"]`); if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
      try {
        const full = this.render(Infinity);
        const blob = await new Promise(r => full.toBlob(r, type, type === "image/png" ? undefined : 0.95));
        const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
        const out = await invoke("image_save_edit", { path: this.file.path, data, width: full.width, height: full.height, asCopy: !!asCopy || !NATIVE_SAVE[ext] });
        toast(asCopy ? `Saved as ${out.split(/[\\/]/).pop()}` : "Saved - the original is in File history");
        this.opts.onSaved?.(out, !!asCopy);
        if (!asCopy) {
          // The saved picture becomes the new original (no reload from disk / stale cache).
          if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
          this.blobUrl = URL.createObjectURL(blob);
          this.E = blank(); this.saved = blank(); this.undo = []; this.redo = []; this._faces = null;
          this.img.src = this.blobUrl;
        } else { this.saved = structuredClone(this.E); this.updateBar(); }
      } catch (e) { toast("Couldn't save: " + (e?.message || e)); }
      finally { if (btn) { btn.textContent = asCopy ? "Save as copy" : "Save"; this.updateBar(); } }
    }

    // ------------------------------------------------------------------ input
    click(ev) {
      const b = ev.target.closest("[data-ie],[data-ratio]"); if (!b || b.disabled) return;
      if (b.dataset.ratio) { this.applyRatio(b.dataset.ratio); this.renderPanel(); return; }
      const a = b.dataset.ie;
      const run = {
        "zoom-in": () => this.zoomAt(this.view.s * 1.25), "zoom-out": () => this.zoomAt(this.view.s / 1.25),
        "zoom-fit": () => this.fit(), "zoom-100": () => this.zoomAt(1),
        "rot-l": () => this.edit(e => { e.rot = (e.rot + 270) % 360; e.crop = null; }), "rot-r": () => this.edit(e => { e.rot = (e.rot + 90) % 360; e.crop = null; }),
        "flip-h": () => this.edit(e => { e.flipH = !e.flipH; e.crop = null; }), "flip-v": () => this.edit(e => { e.flipV = !e.flipV; e.crop = null; }),
        crop: () => (this.mode === "crop" ? this.endCrop(false) : this.startCrop()),
        "crop-apply": () => this.endCrop(true), "crop-cancel": () => this.endCrop(false), "crop-clear": () => { this.mode = "view"; this.cropEl.classList.add("hidden"); this.edit(e => { e.crop = null; }); this.panel = null; this.renderPanel(); },
        adjust: () => this.openPanel("adjust"), ai: () => this.openPanel("ai"),
        "adj-reset": () => { this.edit(e => { e.adj = blank().adj; }); this.renderPanel(); },
        undo: () => this.doUndo(), redo: () => this.doRedo(),
        reset: async () => { if (await (window.PiDialog?.confirm({ title: "Discard all edits?", okText: "Discard", danger: true }) ?? true)) this.push(blank()); this.renderPanel(); },
        "ai-auto": () => this.autoEnhance(),
        "ai-portrait": () => this.portraitLight().catch(e => toast(String(e?.message || e))),
        "ai-smartcrop": () => this.smartCrop().catch(e => toast(String(e?.message || e))),
        history: () => window.PiExtras?.restoreVersions(this.file.path),
        save: () => this.save(false), "save-copy": () => this.save(true),
      }[a];
      run?.();
    }
    key(ev) {
      if (!this.host.isConnected) return;
      if (ev.target.closest?.("input:not([type=range]), textarea")) return;
      const k = ev.key, ctrl = ev.ctrlKey || ev.metaKey;
      const stop = () => { ev.preventDefault(); ev.stopImmediatePropagation(); };
      if (ctrl && k.toLowerCase() === "z" && !ev.shiftKey && this.editable) { stop(); this.doUndo(); }
      else if (ctrl && (k.toLowerCase() === "y" || (k.toLowerCase() === "z" && ev.shiftKey)) && this.editable) { stop(); this.doRedo(); }
      else if (ctrl && k.toLowerCase() === "s" && this.editable) { stop(); this.save(false); }
      else if (ctrl) return;
      else if (k === "+" || k === "=") { stop(); this.zoomAt(this.view.s * 1.25); }
      else if (k === "-" || k === "_") { stop(); this.zoomAt(this.view.s / 1.25); }
      else if (k === "0") { stop(); this.fit(); }
      else if (k === "1") { stop(); this.zoomAt(1); }
      else if (k.startsWith("Arrow") && !this.fitted) { stop(); const d = 60; this.view.x += k === "ArrowLeft" ? d : k === "ArrowRight" ? -d : 0; this.view.y += k === "ArrowUp" ? d : k === "ArrowDown" ? -d : 0; this.applyView(); }
      else if (this.mode === "crop" && k === "Enter") { stop(); this.endCrop(true); }
      else if (this.mode === "crop" && k === "Escape") { stop(); this.endCrop(false); }
      else if (this.editable && (k === "r" || k === "R")) { stop(); this.edit(e => { e.rot = (e.rot + (ev.shiftKey ? 270 : 90)) % 360; e.crop = null; }); }
      else if (this.editable && (k === "c" || k === "C")) { stop(); this.mode === "crop" ? this.endCrop(false) : this.startCrop(); }
    }
  }

  window.PiImageEditor = { mount, dispose, canClose, get active() { return active; } };
})();
