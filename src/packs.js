// PiFiles - theme packs and icon packs.
//
// Built in: "Windows" (Fluent, the default look) and "macOS" (Finder-like colours, typography,
// traffic-light window buttons, blue folders and document icons). More can be imported from
// .pftheme / .pficons files and exported to share - the format is documented in docs/packs.md.
//
// Theme pack  → CSS custom properties per light/dark mode + optional extra CSS (scoped to the pack
//               with native CSS nesting), font stack and corner radii.
// Icon pack   → SVG strings keyed "folder", "drive:<kind>", "file:<kind>", "ext:<ext>",
//               "place:<name>", "ui:<name>"; anything missing falls back to the built-in icons.
// Imported SVG/CSS is sanitised: no scripts, event handlers, foreign objects or remote URLs.
(function () {
  const core = () => window.__TAURI__?.core;
  const pref = (k, d) => { try { const v = window.PiSettings?.get(k); return v === undefined ? d : v; } catch { return d; } };

  // ---------------------------------------------------------------- tokens
  const TOKENS = ["--bg", "--bg-2", "--bg-3", "--bg-hover", "--bg-active", "--border", "--border-strong", "--text", "--text-2", "--text-3",
    "--accent", "--accent-hover", "--accent-bg", "--accent-text", "--on-accent", "--layer", "--layer-2", "--card", "--card-hover",
    "--flyout", "--mica", "--chrome", "--surface", "--surface-2", "--surface-solid", "--stroke", "--hover", "--pressed", "--sel",
    "--sel-hover", "--sel-text", "--r-ctl", "--r-card", "--r-dlg", "--skeleton", "--reveal"];

  // ---------------------------------------------------------------- built-in macOS theme
  const MAC_THEME = {
    format: "pifiles-theme", version: 1, id: "macos", name: "macOS", author: "PiFiles",
    description: "Finder: full-height translucent sidebar with traffic lights, unified toolbar, SF typography, accent-blue sidebar symbols.",
    chrome: "mac",
    font: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"Segoe UI Variable Text\", system-ui, sans-serif",
    radius: { control: 6, card: 10, dialog: 12 },
    modes: {
      dark: {
        "--bg": "#1e1e1e", "--bg-2": "#2a2a2a", "--bg-3": "#323232", "--bg-hover": "rgba(255,255,255,.06)", "--bg-active": "rgba(255,255,255,.10)",
        "--border": "rgba(255,255,255,.08)", "--border-strong": "rgba(255,255,255,.14)",
        "--text": "rgba(255,255,255,.88)", "--text-2": "rgba(255,255,255,.68)", "--text-3": "rgba(255,255,255,.44)",
        "--accent": "#0a84ff", "--accent-hover": "#409cff", "--accent-bg": "rgba(10,132,255,.20)", "--accent-text": "#4ea6ff", "--on-accent": "#ffffff",
        "--mica": "#2b2b2d", "--chrome": "rgba(255,255,255,.02)", "--surface": "#1e1e1e", "--surface-2": "#262626", "--surface-solid": "#2a2a2a",
        "--stroke": "rgba(255,255,255,.07)", "--hover": "rgba(255,255,255,.06)", "--pressed": "rgba(255,255,255,.10)",
        "--sel": "#0059d1", "--sel-hover": "#0a64dc", "--sel-text": "#ffffff",
        "--flyout": "rgba(40,40,42,.94)", "--card": "rgba(255,255,255,.04)", "--card-hover": "rgba(255,255,255,.07)", "--layer": "rgba(255,255,255,.03)", "--layer-2": "rgba(255,255,255,.05)",
      },
      light: {
        "--bg": "#ffffff", "--bg-2": "#f5f5f7", "--bg-3": "#ececee", "--bg-hover": "rgba(0,0,0,.045)", "--bg-active": "rgba(0,0,0,.08)",
        "--border": "rgba(0,0,0,.08)", "--border-strong": "rgba(0,0,0,.14)",
        "--text": "rgba(0,0,0,.86)", "--text-2": "rgba(0,0,0,.62)", "--text-3": "rgba(0,0,0,.42)",
        "--accent": "#007aff", "--accent-hover": "#1a87ff", "--accent-bg": "rgba(0,122,255,.12)", "--accent-text": "#0066d6", "--on-accent": "#ffffff",
        "--mica": "#e8e8ea", "--chrome": "rgba(255,255,255,.35)", "--surface": "#ffffff", "--surface-2": "#f7f7f7", "--surface-solid": "#ffffff",
        "--stroke": "rgba(0,0,0,.08)", "--hover": "rgba(0,0,0,.045)", "--pressed": "rgba(0,0,0,.08)",
        "--sel": "#0064e1", "--sel-hover": "#0a6ee8", "--sel-text": "#ffffff",
        "--flyout": "rgba(246,246,246,.95)", "--card": "rgba(255,255,255,.8)", "--card-hover": "#ffffff", "--layer": "rgba(255,255,255,.6)", "--layer-2": "rgba(255,255,255,.8)",
      },
    },
    css: `
      .file-row.selected, .file-card.selected { background: var(--sel) !important; color: var(--sel-text); }
      .file-row.selected :is(.f-date, .f-type, .f-size, .f-tag) { color: color-mix(in srgb, var(--sel-text) 85%, transparent); }
      #fileContainer.file-list > .file-row:nth-child(even):not(.selected) { background: color-mix(in srgb, var(--text) 3.5%, transparent); }
      .nav-item.active { background: color-mix(in srgb, var(--text) 10%, transparent) !important; }
      .nav-item.active::before { display: none; }
      .nav-title { font-size: 11px; font-weight: 700; color: var(--text-3); letter-spacing: .02em; }
      .tab.active { box-shadow: none; }
      .pf-dialog-box, .pf-settings-box, .viewer-box { box-shadow: 0 22px 70px rgba(0,0,0,.45), 0 0 0 .5px rgba(0,0,0,.4); }
      /* ---- one unified, flat window like Finder ---- */
      & { --sidebar-w: 236px; --mica: var(--surface); }
      html, body { background: var(--surface) !important; }
      #tabBar { height: 40px; min-height: 40px; align-items: center; padding-left: 0; background: var(--surface) !important; }
      .tab { height: 28px; border-radius: 7px !important; font-weight: 500; color: var(--text-2); }
      .tab.active { background: color-mix(in srgb, var(--text) 9%, transparent) !important; font-weight: 500; }
      #tabList:has(> .tab:only-child) { display: none; }
      .tab-new { height: 28px; width: 28px; margin: 0 0 0 2px; }
      #topbar { height: 46px; min-height: 46px; padding: 0 14px 0 12px; gap: 12px; background: var(--surface) !important; }
      .nav-cluster { gap: 0; padding: 2px; border-radius: 999px; background: color-mix(in srgb, var(--text) 7%, transparent); }
      .nav-cluster .icon-btn { width: 32px; height: 28px; border-radius: 999px; }
      .nav-cluster .icon-btn .pi-ico { width: 16px; height: 16px; }
      #upBtn { display: none; }
      .omnibar { background: transparent; border: none; padding: 0; min-width: 120px; box-shadow: none !important; }
      .breadcrumb-view .crumb:not(:last-child), .breadcrumb-view .crumb-sep { display: none; }
      .breadcrumb-view .crumb button { font-size: 16px; font-weight: 700; padding: 0 4px; gap: 0; }
      .breadcrumb-view .crumb-home .pi-ico { display: none; }
      .omnibar #addressEditBtn, .omnibar #addressCopyBtn { display: none; }
      .search-wrap { height: 32px; border: none; border-radius: 9px; width: clamp(180px, 22vw, 300px); background: color-mix(in srgb, var(--text) 7%, transparent); }
      .search-wrap:focus-within { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 45%, transparent); }
      #topbar .top-right .icon-btn { width: 32px; height: 30px; border-radius: 8px; }


      /* ---- Finder window: full-height sidebar, traffic lights on it, unified toolbar ---- */
      .mac-lights { position: absolute; top: 0; left: 0; height: 52px; display: flex !important; align-items: center; gap: 8px; padding: 0 0 0 18px !important; z-index: 5; background: none !important; }
      #topbar > .mac-lights { position: static; height: auto; padding: 0 10px 0 4px !important; }
      .mac-lights .win-btn { width: 12px !important; height: 12px !important; min-width: 12px !important; border-radius: 50% !important; padding: 0 !important; display: grid; place-items: center; border: none; }
      .mac-lights .win-btn svg { opacity: 0; width: 6px; height: 6px; color: rgba(0,0,0,.6); transition: opacity 90ms; }
      .mac-lights:hover .win-btn svg { opacity: 1; }
      .mac-lights #windowCloseBtn { order: -1; background: #ff5f57 !important; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.2); }
      .mac-lights #windowMinBtn { background: #febc2e !important; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.2); }
      .mac-lights #windowMaxBtn { background: #28c840 !important; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.2); }
      .mac-lights .win-btn:hover { filter: none; }
      .mac-lights .win-btn:active { filter: brightness(.82); }
      @media (min-width: 900px) {
        &.pf-mac-chrome #app { display: grid !important; grid-template-columns: auto auto minmax(0, 1fr) auto auto; grid-template-rows: auto auto minmax(0, 1fr); }
        &.pf-mac-chrome #layout { display: contents !important; }
        &.pf-mac-chrome #sidebar { grid-column: 1; grid-row: 1 / -1; position: relative !important; margin: 0 !important; height: auto !important; padding-top: 52px !important; border-radius: 0 !important; border: none !important; border-right: .5px solid var(--stroke) !important; box-shadow: none !important;
          background: color-mix(in srgb, var(--text) 4.5%, var(--mica-solid, var(--surface))) !important; }
        &.pf-mac-chrome.pf-effect-on #sidebar { background: color-mix(in srgb, var(--surface-solid) 38%, transparent) !important; }
        &.pf-mac-chrome #sidebarResizer { grid-column: 2; grid-row: 1 / -1; }
        &.pf-mac-chrome #tabBar { grid-column: 3 / -1; grid-row: 1; }
        &.pf-mac-chrome #tabBar:has(#tabList > .tab:only-child) { display: none !important; }
        &.pf-mac-chrome #topbar { grid-column: 3 / -1; grid-row: 2; height: 52px; min-height: 52px; }
        &.pf-mac-chrome #main { grid-column: 3; grid-row: 3; min-width: 0; }
        &.pf-mac-chrome #detailsResizer { grid-column: 4; grid-row: 3; }
        &.pf-mac-chrome #detailsPane { grid-column: 5; grid-row: 3; }
        &.pf-mac-chrome #overlay { position: fixed; }
      }
      /* centred Finder status line ("68 items, 236.2 GB available") */
      .statusbar { justify-content: center; }
      #statusText { order: 0; margin: 0 auto; }
      /* ---- floating translucent sidebar ---- */
      #layout { padding: 0 !important; }
      #sidebar { margin: 0 0 10px 10px; padding: 8px 6px 0; border-radius: 12px;
        background: color-mix(in srgb, var(--text) 5%, var(--surface)) !important; border: .5px solid var(--stroke) !important;
        box-shadow: 0 1px 2px rgba(0,0,0,.18); }
      #sidebarResizer { width: 6px; }
      .sidebar-scroll { padding: 2px 2px 10px; }
      .nav-item, .nav-title { height: 28px; font-size: 13px; gap: 8px; border-radius: 6px !important; }
      .nav-top, .nav-children .nav-item, .drive-card { padding-left: 10px !important; }
      .nav-item .ico, .nav-item .ico .pi-ico, .drive-icon, .drive-icon .pi-ico { width: 17px !important; height: 17px !important; }
      .nav-item .ico, .drive-icon { color: var(--accent); }
      .nav-item.active, .drive-card.active { background: color-mix(in srgb, var(--text) 11%, transparent) !important; }
      .nav-item.active::before, .nav-item::before { display: none !important; }
      .nav-item .count { display: none; }
      .nav-section { margin-top: 12px; }
      .nav-title { height: 22px; padding-left: 10px !important; font-size: 11px; font-weight: 700; color: var(--text-3); }
      .nav-title:hover { background: transparent; }
      .nav-title .ico { display: none; }
      .nav-title .chev { order: 2; margin-left: auto; opacity: 0; }
      .nav-title:hover .chev { opacity: 1; }
      [data-section="pinned"] > .nav-title .lbl, [data-section="drives"] > .nav-title .lbl { font-size: 0; }
      [data-section="pinned"] > .nav-title .lbl::after { content: "Favorites"; font-size: 11px; }
      [data-section="drives"] > .nav-title .lbl::after { content: "Locations"; font-size: 11px; }
      .drive-card { min-height: 28px; }
      .drive-label { font-size: 13px; }
      .sidebar-foot .nav-item { height: 28px; }

      /* ---- flat content, Finder toolbar ---- */
      #main { padding-top: 0; }
      .toolbar { min-height: 40px; margin: 0; padding: 0 10px !important; border: none !important; border-radius: 0; background: var(--surface) !important; }
      .toolbar .icon-btn.cmd, .toolbar .tbtn.cmd-new, .cmd-select { height: 30px; min-width: 30px; border-radius: 7px; }
      .toolbar .view-toggle { padding: 2px; border-radius: 9px; background: color-mix(in srgb, var(--text) 7%, transparent) !important; }
      .toolbar .view-toggle button { width: 34px; height: 26px; border-radius: 7px; color: var(--text-2); }
      .toolbar .view-toggle button.active { background: color-mix(in srgb, var(--text) 16%, transparent); color: var(--text); }
      .cmd-sep { opacity: 0; }
      #searchHeader, .file-header, .viewport-wrap, .statusbar, #mediaView, .pf-view { border: none !important; border-radius: 0 !important; background: var(--surface) !important; }
      .file-header { height: 28px; font-size: 11.5px; font-weight: 500; color: var(--text-3); border-bottom: .5px solid var(--stroke) !important; }
      .file-header > span { padding: 0 8px; border-right: .5px solid var(--stroke); }
      .file-row { border-radius: 5px; font-size: 13px; }
      .file-row .f-name { font-size: 13px; }
      .file-row .f-icon .pi-ico, .file-row .thumb-ph .pi-ico { width: 18px; height: 18px; }
      .file-row.focused { outline: none; }

      /* ---- icon view: grey tile behind the icon, blue pill behind the name ---- */
      .file-grid { gap: 18px 8px !important; padding: 16px 18px !important; }
      .file-card, .file-card:hover, .file-card.selected { background: transparent !important; border-color: transparent !important; padding: 2px !important; }
      .file-card .f-thumb { aspect-ratio: 1; padding: 10%; border-radius: 8px; border: none !important; }
      .file-card .thumb-ph { background: none !important; animation: none !important; }
      .file-card.selected .f-thumb { background: color-mix(in srgb, var(--text) 13%, transparent) !important; }
      .file-card .f-thumb .pi-ico, .file-card .thumb-ph .pi-ico { width: 78%; height: 78%; filter: none; }
      .file-card .f-thumb img { border-radius: 2px; box-shadow: 0 0 0 3px #fff, 0 2px 6px rgba(0,0,0,.45); }
      .file-card .f-name { justify-self: center; width: fit-content; max-width: 100%; margin: 4px auto 0; padding: 1px 6px; border-radius: 5px; font-size: 12.5px; }
      .file-card.selected .f-name { background: var(--sel); color: var(--sel-text); }
      .file-card .f-meta, .file-card .check { display: none !important; }

      /* ---- path bar ---- */
      #pathBar { display: flex !important; }
      .statusbar { height: 28px; min-height: 28px; font-size: 11.5px; border-top: .5px solid var(--stroke) !important; }
      #statusText { color: var(--text-2); }

      /* ---- panes, menus, dialogs ---- */
      #detailsPane { margin: 0 !important; border-radius: 0 !important; border: none !important; border-left: .5px solid var(--stroke) !important; background: var(--surface) !important; }
      .ctx-menu, .ctx-sub { padding: 5px !important; border-radius: 9px !important; min-width: 220px; }
      .ctx-item { height: 24px; font-size: 13px; border-radius: 5px; margin: 0; width: 100%; padding: 0 10px; }
      .ctx-item .ctx-ico { display: none; }
      .ctx-item[aria-checked="true"] .ctx-ico { display: grid; width: 14px; }
      .ctx-item:hover:not([disabled]), .ctx-item:focus:not([disabled]), .ctx-item.open { background: var(--accent) !important; color: #fff; }
      .ctx-item:hover .ctx-hint, .ctx-item:hover .ctx-more .pi-ico, .ctx-item:focus .ctx-hint { color: rgba(255,255,255,.85); }
      .ctx-sep { margin: 5px 10px; }
      .pf-dialog-box, .pf-settings-box, .viewer-box, .ops-panel { border-radius: 12px !important; }
      .pf-dialog-btn.primary { border-radius: 7px; }
      *::-webkit-scrollbar { width: 9px; height: 9px; }
      *::-webkit-scrollbar-thumb { border-width: 2px; box-shadow: inset 0 0 0 5px color-mix(in srgb, var(--text) 30%, transparent); }
    `,
  };

  // ---------------------------------------------------------------- built-in macOS icons
  const S48 = (body, defs = "") => `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
  const SYM = (d) => `<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const macDefs = `
    <linearGradient id="macFoldB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ab9f2"/><stop offset="1" stop-color="#3fa4e8"/></linearGradient>
    <linearGradient id="macFoldF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8cd4fb"/><stop offset=".08" stop-color="#74cafa"/><stop offset="1" stop-color="#5bbcf5"/></linearGradient>
    <linearGradient id="macDisk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f4f6"/><stop offset=".6" stop-color="#d6d6db"/><stop offset="1" stop-color="#b9b9c0"/></linearGradient>
    <linearGradient id="macExt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd67a"/><stop offset="1" stop-color="#f2a73b"/></linearGradient>
    <linearGradient id="macPage" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef0f3"/></linearGradient>`;
  // Finder folder: small rounded tab, flat light-blue body, soft highlight along the top edge.
  const macFolder = S48(
    `<path d="M4.5 12.2A2.7 2.7 0 0 1 7.2 9.5h9.6c.8 0 1.5.3 2 .9l1.8 2c.5.6 1.2.9 2 .9h18.2a2.7 2.7 0 0 1 2.7 2.7v21.3a2.7 2.7 0 0 1-2.7 2.7H7.2a2.7 2.7 0 0 1-2.7-2.7Z" fill="url(#macFoldB)"/>` +
    `<rect x="4.5" y="15.6" width="39" height="24.4" rx="2.7" fill="url(#macFoldF)"/>` +
    `<path d="M7.2 16.2h33.6" stroke="#c6ebff" stroke-width=".8" opacity=".9"/>`, macDefs);
  const macDisk = (accent) => S48(
    `<rect x="5" y="15" width="38" height="21" rx="4" fill="${accent || "url(#macDisk)"}"/>` +
    `<rect x="5" y="15" width="38" height="21" rx="4" fill="none" stroke="rgba(0,0,0,.18)" stroke-width=".8"/>` +
    `<path d="M5.4 29.5h37.2" stroke="rgba(0,0,0,.12)" stroke-width="1"/>` +
    `<circle cx="37.5" cy="32.7" r="1.4" fill="#3ddc6a"/><circle cx="10" cy="19.5" r="1" fill="rgba(0,0,0,.25)"/><circle cx="38" cy="19.5" r="1" fill="rgba(0,0,0,.25)"/>`, macDefs);
  const macRemote = S48(
    `<rect x="5" y="17" width="38" height="19" rx="4" fill="url(#macDisk)" stroke="rgba(0,0,0,.18)" stroke-width=".8"/>` +
    `<circle cx="24" cy="15" r="9" fill="#2f8cf0"/><path d="M15 15h18M24 6c2.6 2.4 3.9 5.4 3.9 9s-1.3 6.6-3.9 9c-2.6-2.4-3.9-5.4-3.9-9S21.4 8.4 24 6Z" stroke="#d8ecff" stroke-width="1.2" fill="none"/>` +
    `<circle cx="37.5" cy="31.5" r="1.4" fill="#3ddc6a"/>`, macDefs);
  const macDoc = (glyph, label, color) => S48(
    `<path d="M11 4h18l10 10v28.5a2.5 2.5 0 0 1-2.5 2.5h-25A2.5 2.5 0 0 1 9 42.5v-36A2.5 2.5 0 0 1 11.5 4Z" fill="url(#macPage)" stroke="rgba(0,0,0,.16)" stroke-width=".8"/>` +
    `<path d="M29 4v7.5a2.5 2.5 0 0 0 2.5 2.5H39" fill="#dfe3e8" stroke="rgba(0,0,0,.14)" stroke-width=".8"/>` +
    (glyph || "") +
    (label ? `<text x="24" y="40" font-size="6.2" font-weight="700" text-anchor="middle" fill="${color || "#7a7f87"}" font-family="-apple-system, 'SF Pro Text', 'Segoe UI', sans-serif" letter-spacing=".3">${label}</text>` : ""), macDefs);
  const MAC_ICONS = {
    format: "pifiles-iconpack", version: 1, id: "macos", name: "macOS", author: "PiFiles",
    description: "Blue Finder-style folders, white document icons and accent-coloured sidebar symbols.",
    icons: {
      "folder": macFolder,
      "drive:fixed": macDisk(), "drive:windows": macDisk(), "drive:removable": macDisk("url(#macExt)"), "drive:remote": macRemote,
      "file:generic": macDoc("", "", ""),
      "file:text": macDoc(`<path d="M15 18h18M15 22h18M15 26h18M15 30h12" stroke="#a8aeb6" stroke-width="1.4" stroke-linecap="round"/>`, "TXT"),
      "file:image": macDoc(`<rect x="14" y="16" width="20" height="15" rx="2" fill="#4aa4ff"/><path d="m14 28.5 5.2-5.2 3.6 3.6 2.4-2.4 8.8 8.8v-.3H16a2 2 0 0 1-2-2Z" fill="#bfe3ff"/><circle cx="29" cy="20.5" r="2" fill="#ffd60a"/>`, "IMG", "#2f8cf0"),
      "file:video": macDoc(`<rect x="14" y="17" width="20" height="14" rx="2.5" fill="#5e5ce6"/><path d="M22 20.5v7l5.6-3.5Z" fill="#fff"/>`, "VIDEO", "#5e5ce6"),
      "file:audio": macDoc(`<circle cx="24" cy="24" r="9" fill="#ff375f"/><path d="M22.4 27.6V20l5-1.2v7.3" stroke="#fff" stroke-width="1.5" fill="none" stroke-linejoin="round"/><circle cx="21" cy="27.6" r="1.6" fill="#fff"/><circle cx="26" cy="26.2" r="1.6" fill="#fff"/>`, "AUDIO", "#ff375f"),
      "file:pdf": macDoc(`<path d="M16 29c4-1.5 8-6 9.5-11.5.6-2.3-1.6-2.6-1.8-.6-.4 4 3.2 9.4 8.3 10.4 2 .4 2.3-1.6.3-1.7-5.2-.3-11 2.4-14.8 5.4-1.5 1.2-.8 2.8 1 1.5" fill="none" stroke="#ff3b30" stroke-width="1.4" stroke-linecap="round"/>`, "PDF", "#ff3b30"),
      "file:archive": macDoc(`<path d="M24 4v24" stroke="#8e8e93" stroke-width="3" stroke-dasharray="2 2"/><rect x="21.5" y="26" width="5" height="6" rx="1.2" fill="#8e8e93"/>`, "ZIP", "#8e8e93"),
      "file:word": macDoc(`<rect x="14" y="16" width="20" height="16" rx="3" fill="#2b7cd3"/><path d="m17.5 20 1.8 8 2.3-6.5 2.3 6.5 1.8-8" stroke="#fff" stroke-width="1.5" fill="none" stroke-linejoin="round"/>`, "DOC", "#2b7cd3"),
      "file:excel": macDoc(`<rect x="14" y="16" width="20" height="16" rx="3" fill="#1d8f50"/><path d="m19 20 8 8m0-8-8 8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>`, "XLS", "#1d8f50"),
      "file:ppt": macDoc(`<rect x="14" y="16" width="20" height="16" rx="3" fill="#e0592a"/><path d="M20.5 28v-8h3.5a2.6 2.6 0 0 1 0 5.2h-3.5" stroke="#fff" stroke-width="1.6" fill="none"/>`, "PPT", "#e0592a"),
      "file:code": macDoc(`<path d="m19.5 19.5-4.5 4.5 4.5 4.5M28.5 19.5l4.5 4.5-4.5 4.5M25.5 18l-3 12" stroke="#5e5ce6" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`, "CODE", "#5e5ce6"),
      "file:raw": macDoc(`<rect x="14" y="17" width="20" height="14" rx="3" fill="#3a3a3c"/><circle cx="24" cy="24" r="4.6" fill="#8fd0ff" stroke="#e5e5ea" stroke-width="1.2"/><rect x="16" y="15" width="5" height="3" rx="1" fill="#3a3a3c"/>`, "RAW", "#ff9f0a"),
      "file:exe": S48(`<rect x="6" y="6" width="36" height="36" rx="9" fill="#3a3a3c"/><rect x="6" y="6" width="36" height="36" rx="9" fill="none" stroke="rgba(255,255,255,.12)"/><path d="M15 31l9-14 9 14Z" fill="#0a84ff"/><circle cx="24" cy="27" r="2.2" fill="#fff"/>`),
      "file:config": macDoc(`<circle cx="24" cy="24" r="6" fill="none" stroke="#8e8e93" stroke-width="2" stroke-dasharray="2.4 1.6"/><circle cx="24" cy="24" r="2.2" fill="#8e8e93"/>`, "", ""),
      // Finder sidebar: monochrome symbols in the accent colour
      "place:home": SYM("M3.5 9.5 10 4l6.5 5.5M5.5 8v8h9V8M8.5 16v-4.5h3V16"),
      "place:desktop": SYM("M3 4.5h14v9H3zM7.5 16.5h5M10 13.5v3"),
      "place:downloads": SYM("M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM10 6.8v6.4M7.3 10.6 10 13.2l2.7-2.6"),
      "place:documents": SYM("M5.5 3h6l3.5 3.5V17h-9.5zM11.5 3v3.5H15M7.8 10h4.6M7.8 12.8h4.6"),
      "place:pictures": SYM("M3 5h14v10.5H3zM3 13l4-4 3 3 2-2 5 5M13 8h.01"),
      "place:music": SYM("M8 14.5V5l7.5-1.5v9.5M8 14.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM15.5 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z"),
      "place:videos": SYM("M3 4.5h14v11H3zM6 4.5v11M14 4.5v11M3 8h3M3 12h3M14 8h3M14 12h3"),
      "place:recycle": SYM("M4 5.5h12M8 5.5V4h4v1.5M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5.5M11.5 8.5v5.5"),
      "place:network": SYM("M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM3 10h14M10 3c2 2 3 4.3 3 7s-1 5-3 7c-2-2-3-4.3-3-7s1-5 3-7Z"),
      "place:recent": SYM("M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM10 6.5V10l2.5 1.8"),
      "place:tags": SYM("M3.5 9.6V4.5c0-.6.4-1 1-1h5.1l6.8 6.8c.4.4.4 1 0 1.4l-5.1 5.1c-.4.4-1 .4-1.4 0ZM7 7h.01"),
      "place:people": SYM("M7.5 9a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6ZM2.5 16c.5-2.7 2.5-4.3 5-4.3s4.5 1.6 5 4.3M13 9a2.3 2.3 0 1 0 0-4.6M14.5 11.8c1.5.5 2.6 1.9 3 4.2"),
      "place:devices": SYM("M2.5 5h10v7h-10zM1.5 14.5h12M14.5 7.5h4v9h-4zM16 14.5h1"),
      "place:media": SYM("M5 6V4h12v10h-2M3 6h12v10H3zM3 13.5l3.5-3.5 2.5 2.5 2-2 4 4"),
      "place:pin": SYM("M12.5 3 17 7.5l-2.5 1-3 3 .5 3-1.5 1.5-7-7L5 7.5l3 .5 3-3ZM6 14l-3 3"),
      "place:settings": SYM("M10 7.3a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4ZM8.6 3h2.8l.4 1.6 1.5.9 1.6-.5 1.4 2.4-1.2 1.1v1.8l1.2 1.1-1.4 2.4-1.6-.5-1.5.9-.4 1.6H8.6l-.4-1.6-1.5-.9-1.6.5-1.4-2.4 1.2-1.1V9.1L3.7 8l1.4-2.4 1.6.5 1.5-.9Z"),
    },
  };

  // ---------------------------------------------------------------- sanitising
  // Icon packs are untrusted files, so SVG is cleaned with an allow-list: only drawing elements
  // and presentation attributes survive. Anything else (scripts, links, animation, foreign
  // content, event handlers, external references) is removed.
  const SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use", "title", "desc", "image",
    "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "feflood", "fecomposite", "femerge", "femergenode", "fedropshadow"]);
  const SVG_ATTRS = new Set(["id", "class", "viewbox", "xmlns", "xmlns:xlink", "version", "preserveaspectratio", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "width", "height", "points", "pathlength",
    "fill", "fill-rule", "fill-opacity", "clip-rule", "clip-path", "mask", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
    "opacity", "transform", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod", "patternunits", "patterncontentunits", "patterntransform", "clippathunits", "maskunits", "maskcontentunits",
    "filter", "filterunits", "primitiveunits", "in", "in2", "result", "stddeviation", "dx", "dy", "mode", "type", "values", "operator", "k1", "k2", "k3", "k4", "flood-color", "flood-opacity",
    "color", "display", "visibility", "vector-effect", "shape-rendering", "href", "xlink:href", "style"]);
  const SAFE_IMAGE = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]*$/i;
  function cleanSvg(text, cls) {
    try {
      const d = new DOMParser().parseFromString(String(text), "image/svg+xml");
      const svg = d.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== "svg" || d.querySelector("parsererror")) return null;
      for (const el of [...svg.querySelectorAll("*")]) if (!SVG_TAGS.has(el.nodeName.toLowerCase())) el.remove();
      for (const el of [svg, ...svg.querySelectorAll("*")]) {
        const tag = el.nodeName.toLowerCase();
        for (const a of [...el.attributes]) {
          const n = a.name.toLowerCase(), v = a.value.trim();
          if (!SVG_ATTRS.has(n)) el.removeAttribute(a.name);
          // References: same-document only ("#id"); <image> may embed a raster data: URL.
          else if ((n === "href" || n === "xlink:href") && !(v.startsWith("#") || (tag === "image" && SAFE_IMAGE.test(v)))) el.removeAttribute(a.name);
          // Inline styles and presentation values may only reference "#id" paint servers.
          else if (/url\(\s*['"]?(?!#)/i.test(v) || /expression\s*\(|javascript\s*:|@import/i.test(v)) el.removeAttribute(a.name);
        }
      }
      // Hoist gradients/patterns into the shared defs so hidden copies can't break visible ones.
      svg.querySelectorAll("defs").forEach(d => { window.PiIconDefs?.add(d.innerHTML); d.remove(); });
      svg.removeAttribute("width"); svg.removeAttribute("height");
      svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      svg.setAttribute("class", `pi-ico ${cls || ""} pi-pack`);
      return svg.outerHTML;
    } catch { return null; }
  }
  function cleanCss(css) {
    // The CSS only ever goes into style.textContent (never parsed as HTML); "<" is removed anyway
    // so no tag-like text survives in any form.
    return String(css || "")
      .replace(/</g, "")
      .replace(/@import[^;]*;?/gi, "")
      .replace(/url\(\s*(['"]?)(?!data:|#)[^)]*\)/gi, "none")
      .replace(/expression\s*\(/gi, "(")
      .slice(0, 200000);
  }
  function validTheme(p) { return p && p.format === "pifiles-theme" && p.id && p.name && p.modes && (p.modes.dark || p.modes.light); }
  function validIcons(p) { return p && p.format === "pifiles-iconpack" && p.id && p.name && p.icons && typeof p.icons === "object"; }

  // ---------------------------------------------------------------- registry
  const themes = new Map([["windows", { id: "windows", name: "Windows", author: "PiFiles", description: "Fluent design like Windows 11 File Explorer (the default).", builtin: true }], ["macos", { ...MAC_THEME, builtin: true }]]);
  const iconPacks = new Map([["windows", { id: "windows", name: "Windows", author: "PiFiles", description: "Fluent icons like Windows 11 (the default).", builtin: true, icons: {} }], ["macos", { ...MAC_ICONS, builtin: true }]]);
  let iconCache = new Map();

  /** Packs shipped with the app (src/packs/index.json): listed and exportable, not deletable. */
  async function loadBundled() {
    try {
      const idx = await fetch("packs/index.json", { cache: "no-cache" }).then(r => r.json());
      await Promise.all((idx.packs || []).map(async f => {
        try {
          const pk = await fetch("packs/" + f, { cache: "no-cache" }).then(r => r.json());
          if (validTheme(pk)) themes.set(pk.id, { ...pk, builtin: true, bundled: true });
          else if (validIcons(pk)) iconPacks.set(pk.id, { ...pk, builtin: true, bundled: true });
        } catch (e) { console.warn("pack", f, e); }
      }));
    } catch (e) { console.warn("bundled packs", e); }
  }

  async function loadInstalled() {
    await loadBundled();
    applyAll();
    window.dispatchEvent(new CustomEvent("pifiles:packs"));
    if (!core()) return;
    try {
      for (const p of (await core().invoke("packs_list", { kind: "theme" })) || []) if (validTheme(p) && !themes.get(p.id)?.builtin) themes.set(p.id, p);
      for (const p of (await core().invoke("packs_list", { kind: "icons" })) || []) if (validIcons(p) && !iconPacks.get(p.id)?.builtin) iconPacks.set(p.id, p);
    } catch (e) { console.error("packs", e); }
    applyAll();
    window.dispatchEvent(new CustomEvent("pifiles:packs"));
  }

  // ---------------------------------------------------------------- applying a theme
  function themeCss(p) {
    const sel = `:root[data-pack="${CSS.escape(p.id)}"]`;
    const block = (mode) => {
      const t = p.modes[mode] || p.modes.dark || p.modes.light || {};
      return Object.entries(t).filter(([k]) => TOKENS.includes(k)).map(([k, v]) => `${k}: ${String(v).replace(/[;{}<>]/g, "")};`).join(" ");
    };
    let css = `${sel}:not([data-theme*="light"]) { ${block("dark")} }\n${sel}[data-theme*="light"] { ${block("light")} }\n`;
    const r = p.radius || {};
    css += `${sel} { ${r.control != null ? `--r-ctl: ${Number(r.control)}px;` : ""} ${r.card != null ? `--r-card: ${Number(r.card)}px;` : ""} ${r.dialog != null ? `--r-dlg: ${Number(r.dialog)}px;` : ""} }\n`;
    if (p.font) css += `${sel} :is(html, body), ${sel} { font-family: ${String(p.font).replace(/[;{}<>]/g, "")} !important; }\n`;
    if (p.css) css += `${sel} {\n${cleanCss(p.css)}\n}\n`; // native CSS nesting scopes the pack's rules
    return css;
  }
  // Window chrome layout a theme asks for. "mac": Finder-style - the sidebar runs the full
  // window height with the traffic lights on top of it, and one unified toolbar beside it.
  let chromeObserver = null;
  function placeLights() {
    const wc = document.getElementById("windowControls"), side = document.getElementById("sidebar"), top = document.getElementById("topbar");
    if (!wc || !side || !top) return;
    const mac = document.documentElement.classList.contains("pf-mac-chrome");
    const collapsed = document.documentElement.classList.contains("pf-sidebar-collapsed") || getComputedStyle(side).display === "none" || getComputedStyle(side).position === "fixed";
    if (!wc.__home) wc.__home = { parent: wc.parentElement, next: wc.nextSibling };
    const target = !mac ? wc.__home.parent : collapsed ? top : side;
    if (wc.parentElement !== target) {
      if (target === wc.__home.parent) target.insertBefore(wc, wc.__home.next && wc.__home.next.parentElement === target ? wc.__home.next : null);
      else target.prepend(wc);
    }
    wc.classList.toggle("mac-lights", mac);
  }
  function setChrome(kind) {
    const root = document.documentElement;
    root.classList.toggle("pf-mac-chrome", kind === "mac");
    placeLights();
    if (kind === "mac" && !chromeObserver) {
      chromeObserver = new MutationObserver(placeLights);
      chromeObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
      addEventListener("resize", placeLights);
    } else if (kind !== "mac" && chromeObserver) {
      chromeObserver.disconnect(); chromeObserver = null; removeEventListener("resize", placeLights);
    }
  }
  function applyTheme() {
    const id = pref("themePack", "windows");
    const p = themes.get(id);
    let style = document.getElementById("pf-theme-pack");
    const ready = fn => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn());
    ready(() => setChrome(p && id !== "windows" ? (p.chrome || (p.id === "macos" ? "mac" : "")) : ""));
    if (!p || id === "windows") {
      delete document.documentElement.dataset.pack;
      style?.remove();
      return;
    }
    if (!style) { style = document.createElement("style"); style.id = "pf-theme-pack"; document.head.appendChild(style); }
    style.textContent = themeCss(p);
    document.documentElement.dataset.pack = p.id;
  }

  // ---------------------------------------------------------------- applying an icon pack
  const base = {};
  function wrapIcons() {
    if (!window.PiIcons || base.ui) return;
    Object.assign(base, window.PiIcons);
    const pick = (key, cls) => {
      const pack = iconPacks.get(pref("iconPack", "windows"));
      if (!pack || !pack.icons || !pack.icons[key]) return null;
      const ck = pack.id + "|" + key + "|" + cls;
      if (!iconCache.has(ck)) iconCache.set(ck, cleanSvg(pack.icons[key], cls));
      return iconCache.get(ck);
    };
    const driveKind = (d) => {
      const t = d.drive_type || d.type || "Fixed";
      const p = String(d.path || d.mount_point || "").toUpperCase();
      return t === "Removable" || t === "CDRom" ? "removable" : t === "Remote" ? "remote" : p === "C:\\" ? "windows" : "fixed";
    };
    const extOf = f => String(f.ext || f.extension || (f.name || "").split(".").pop() || "").toLowerCase();
    window.PiIcons.ui = n => pick("ui:" + n, "pi-fluent") || base.ui(n);
    window.PiIcons.place = n => pick("place:" + n, "pi-place") || base.place(n);
    window.PiIcons.folder = () => pick("folder", "pi-folder") || base.folder();
    window.PiIcons.drive = d => pick("drive:" + driveKind(d), "pi-drive") || base.drive(d);
    window.PiIcons.file = f => pick("ext:" + extOf(f), "pi-file") || pick("file:" + base.fileKind(f), "pi-file") || base.file(f);
  }
  function refreshIcons() {
    document.querySelectorAll("[data-icon][data-icon-done]").forEach(el => {
      const [kind, name] = el.dataset.icon.split(":");
      el.innerHTML = kind === "place" ? PiIcons.place(name) : PiIcons.ui(name);
    });
    window.dispatchEvent(new CustomEvent("pifiles:icons"));
  }

  function applyAll() { applyTheme(); refreshIcons(); }

  // ---------------------------------------------------------------- import / export
  async function importPack() {
    if (!core()) { window.toast?.("Importing needs the desktop app"); return null; }
    try {
      const p = await core().invoke("packs_import", { path: null });
      if (!p) return null;
      if (p.format === "pifiles-theme") { if (!validTheme(p)) throw new Error("That theme has no colours (\"modes\")"); themes.set(p.id, p); }
      else { if (!validIcons(p)) throw new Error("That icon pack has no \"icons\""); iconPacks.set(p.id, p); iconCache = new Map(); }
      window.dispatchEvent(new CustomEvent("pifiles:packs"));
      window.toast?.(`Imported “${p.name}”`);
      return p;
    } catch (e) { window.toast?.(String(e?.message || e)); return null; }
  }
  function packJson(kind, id) {
    const p = kind === "icons" ? iconPacks.get(id) : themes.get(id);
    if (!p) return null;
    const out = { ...p };
    delete out.builtin;
    if (kind === "icons") out.format = "pifiles-iconpack"; else out.format = "pifiles-theme";
    out.version = 1;
    if (id === "windows" && kind === "theme") Object.assign(out, currentThemeSnapshot("windows-copy", "Windows (copy)"));
    return out;
  }
  async function exportPack(kind, id) {
    const p = packJson(kind, id);
    if (!p) return;
    const json = JSON.stringify(p, null, 2);
    const name = `${p.id}.${kind === "icons" ? "pficons" : "pftheme"}`;
    if (core()) {
      const path = await core().invoke("packs_export", { content: json, fileName: name }).catch(e => { window.toast?.(String(e)); return null; });
      if (path) window.toast?.(`Saved ${path}`);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = name; a.click();
    }
  }
  async function removePack(kind, id) {
    const map = kind === "icons" ? iconPacks : themes;
    if (map.get(id)?.builtin) return;
    map.delete(id);
    if (core()) await core().invoke("packs_delete", { kind, id }).catch(() => {});
    if (pref(kind === "icons" ? "iconPack" : "themePack", "windows") === id) window.PiSettings?.set(kind === "icons" ? "iconPack" : "themePack", "windows");
    window.dispatchEvent(new CustomEvent("pifiles:packs"));
  }
  /** A theme file from the colours currently on screen - a starting point for authors. */
  function currentThemeSnapshot(id, name) {
    const cs = getComputedStyle(document.documentElement);
    const mode = (document.documentElement.dataset.theme || "").includes("light") ? "light" : "dark";
    const tokens = {};
    for (const t of TOKENS) { const v = cs.getPropertyValue(t).trim(); if (v) tokens[t] = v; }
    return { format: "pifiles-theme", version: 1, id, name, author: "", description: "", modes: { [mode]: tokens } };
  }

  // ---------------------------------------------------------------- previews for Settings
  function swatches(p, mode) {
    if (p.id === "windows") return mode === "light" ? ["#f3f3f3", "#fbfbfb", "#005fb8", "#1a1a1a"] : ["#1c1c1c", "#2b2b2b", "#60cdff", "#ffffff"];
    const t = (p.modes && (p.modes[mode] || p.modes.dark || p.modes.light)) || {};
    return [t["--mica"] || t["--bg"], t["--surface"] || t["--bg-2"], t["--accent"], t["--text"]].map(c => c || "#888");
  }
  function iconPreview(p) {
    // The pack's own icons where it has them, otherwise what it would fall back to.
    const pick = (key, fallback) => p.icons?.[key] ? cleanSvg(p.icons[key], "") : fallback;
    return [
      pick("folder", base.folder()),
      pick("file:image", base.file({ name: "a.jpg" })),
      pick("file:pdf", base.file({ name: "a.pdf" })),
      pick("file:code", base.file({ name: "a.js" })),
      pick("drive:fixed", base.drive({ path: "D:\\" })),
      pick("place:downloads", base.place("downloads")),
    ].join("");
  }

  wrapIcons();
  applyTheme();
  window.addEventListener("pifiles:settings", e => {
    const k = e.detail?.key;
    if (k === "themePack") applyTheme();
    if (k === "iconPack") { iconCache = new Map(); refreshIcons(); }
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadInstalled); else loadInstalled();

  window.PiPacks = {
    themes: () => [...themes.values()],
    iconPacks: () => [...iconPacks.values()],
    import: importPack,
    export: exportPack,
    remove: removePack,
    snapshot: () => {
      const p = currentThemeSnapshot("my-theme", "My theme");
      const json = JSON.stringify(p, null, 2);
      if (core()) core().invoke("packs_export", { content: json, fileName: "my-theme.pftheme" }).then(path => path && window.toast?.(`Saved ${path}`)).catch(e => window.toast?.(String(e)));
    },
    swatches,
    iconPreview,
    TOKENS,
  };
})();
