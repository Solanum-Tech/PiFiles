// PiFiles motion layer - purposeful Fluent 2 motion on top of main.js without touching its rendering.
// - Staggered entrance only for items that are *new* (navigating, new people found) - never on
//    re-renders of the same items (selection clicks) or while the list is being scrolled.
// - Pointer-tracking "reveal" highlight on cards and nav items.
// - Images fade/sharpen in once decoded; skeleton shimmer shows while thumbnails load.
// - View-level transition when switching between Files / People / Devices / search.
// - Busy indicator under the People counter while a face scan is running.
// Uses only transform/opacity animations (compositor-friendly) and honours prefers-reduced-motion.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// ---------- staggered entrance for new items ----------
const LISTS = [
  { sel: "#peopleGrid", item: ".person-card", key: el => el.dataset.key },
  { sel: "#drivesList", item: ".drive-card, .nav-item", key: el => el.dataset.path || el.textContent },
  { sel: "#devicesGrid", item: "*", key: el => el.dataset.key || el.textContent },
  { sel: "#deviceMetaGrid", item: "*", key: el => el.dataset.key || el.textContent },
  { sel: "#cmdList", item: ".cmd-item", key: el => el.textContent },
];

let scrollingUntil = 0;
document.addEventListener("scroll", () => { scrollingUntil = performance.now() + 250; }, { capture: true, passive: true });

function animateNewItems(container, spec, seen) {
  const items = [...container.children].filter(el => el.matches(spec.item));
  const current = new Set();
  let i = 0;
  const animate = !reduceMotion.matches && performance.now() > scrollingUntil;
  for (const el of items) {
    const k = spec.key(el);
    current.add(k);
    if (animate && !seen.has(k) && !el.classList.contains("fx-enter")) {
      el.style.setProperty("--fx-i", String(i++));
      el.classList.add("fx-enter");
      // Drop the class afterwards so the finished animation can't pin `transform` (hover lift).
      el.addEventListener("animationend", () => el.classList.remove("fx-enter"), { once: true });
    }
  }
  return current;
}

function watchList(spec) {
  const container = document.querySelector(spec.sel);
  if (!container) return false;
  let seen = new Set();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      seen = animateNewItems(container, spec, seen);
    });
  }).observe(container, { childList: true });
  seen = animateNewItems(container, spec, seen);
  return true;
}

// ---------- reveal highlight ----------
const REVEAL = ".file-card, .drive-card, .person-card, .group-card, .nav-item, .cmd-item, .tbtn";
document.addEventListener("pointermove", e => {
  const el = e.target.closest?.(REVEAL);
  if (!el) return;
  if (!el.classList.contains("fx-reveal")) el.classList.add("fx-reveal");
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}, { passive: true });

// ---------- image fade-in ----------
const FADE_IMG = ".f-thumb img, .person-avatar img, .person-preview-strip img, .details-preview img, .viewer-content img, .face-crop-img";
function prepImage(img) {
  if (img.classList.contains("fx-img")) return;
  img.classList.add("fx-img");
  if (img.complete && img.naturalWidth > 0) img.classList.add("fx-loaded");
}
document.addEventListener("load", e => {
  const img = e.target;
  if (img instanceof HTMLImageElement) img.classList.add("fx-loaded");
}, true);
// A src swap (placeholder -> real thumbnail) should fade in again.
function watchImages(root) {
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === "attributes" && m.target instanceof HTMLImageElement && m.target.matches(FADE_IMG)) {
        const img = m.target;
        if (!(img.complete && img.naturalWidth > 0)) img.classList.remove("fx-loaded");
        prepImage(img);
        continue;
      }
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (n.matches(FADE_IMG)) prepImage(n);
        n.querySelectorAll?.(FADE_IMG).forEach(prepImage);
      }
    }
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
}

// ---------- view transitions ----------
const VIEWS = ["#searchHeader"]; // page switches are animated by main.js (showView)
function watchViews() {
  for (const sel of VIEWS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    let wasHidden = el.classList.contains("hidden") || getComputedStyle(el).display === "none";
    new MutationObserver(() => {
      const hidden = el.classList.contains("hidden") || el.style.display === "none";
      if (wasHidden && !hidden && !reduceMotion.matches) {
        el.classList.remove("fx-view-enter");
        void el.offsetWidth; // restart the animation
        el.classList.add("fx-view-enter");
        el.addEventListener("animationend", () => el.classList.remove("fx-view-enter"), { once: true });
      }
      wasHidden = hidden;
    }).observe(el, { attributes: true, attributeFilter: ["class", "style"] });
  }
}

// ---------- People scan indicator ----------
function watchPeopleBusy() {
  const count = document.querySelector("#peopleCount");
  if (!count) return;
  const update = () => count.classList.toggle("fx-busy", /analysing|Finding|Updating|Scanning/i.test(count.textContent));
  new MutationObserver(update).observe(count, { childList: true, characterData: true, subtree: true });
  update();
}

function init() {
  const pending = LISTS.filter(spec => !watchList(spec));
  // Some containers are created lazily by main.js; retry briefly.
  if (pending.length) {
    let tries = 0;
    const t = setInterval(() => {
      for (let i = pending.length - 1; i >= 0; i--) if (watchList(pending[i])) pending.splice(i, 1);
      if (!pending.length || ++tries > 20) clearInterval(t);
    }, 500);
  }
  document.querySelectorAll(FADE_IMG).forEach(prepImage);
  watchImages(document.body);
  watchViews();
  watchPeopleBusy();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
