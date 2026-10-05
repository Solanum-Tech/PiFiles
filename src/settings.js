// PiFiles settings - persistent user preferences, applied live, plus the Settings window.
// Loaded before main.js (classic script) so `window.PiSettings` exists when main.js boots.
// Visual options become classes / CSS variables on <html>; behavioural ones are read by main.js
// through PiSettings.get() and a `pifiles:settings` event.
(function () {
  const KEY = "pifiles:settings";

  // ---- About page: edit these to match your organisation ----
  const ABOUT = {
    organization: "Solanum Tech",
    github: "https://github.com/Solanum-Tech/PiFiles",
    website: "",                                         // optional, e.g. "https://pifiles.app"
  };

  const DEFAULTS = {
    // General
    startup: "home",            // home | last | path
    startupPath: "",
    confirmDelete: true,
    trackRecent: true,
    // Appearance
    theme: (() => {
      try { return localStorage.getItem("fe:theme") || "fluent-dark"; } catch { return "fluent-dark"; }
    })(),                       // system | fluent-dark | fluent-light | material-dark | material-light
    accent: "default",          // default | #rrggbb
    tint: "none",               // none | blue | purple | crimson | green | amber | teal
    tintStrength: 55,           // 0..100
    transparency: true,
    windowEffect: "none",       // none | mica | acrylic | glass (liquid glass)
    performance: "auto",        // auto | saver | balanced | max
    updateCheck: true,          // check GitHub releases on start-up
    updateChannel: "stable",    // stable | beta
    shortcuts: {},              // action id -> key combo ("" = off); see keys.js
    animations: true,
    corners: "rounded",         // rounded | square
    textSize: "default",        // small | default | large
    // Layout
    density: "comfortable",     // compact | default | comfortable
    gridSize: "medium",         // small | medium | large
    showCheckboxes: true,
    colTag: true,
    colDate: true,
    colType: true,
    colSize: true,
    showStatusBar: true,
    toolbarLabels: false,
    showExtraToolbar: false,
    showToolbarInfo: false,
    // Files & folders
    showHidden: (() => { try { return localStorage.getItem("fe:showHidden") === "1"; } catch { return false; } })(),
    showExtensions: true,
    autoFolderSizes: true,
    showThumbnails: true,
    foldersFirst: true,
    dateFormat: "relative",     // relative | long | short | iso
    sizeUnits: "binary",        // binary (KiB) | decimal (KB)
    // Navigation pane
    showPinned: true,
    showDrives: true,
    showMedia: true,
    showNetwork: true,
    showTags: true,
    driveDetails: "compact",    // compact | detailed
    sidebarCollapsed: false,
    collapsedSections: [],
    // Search
    showSearchStatus: true,
    // People & media
    scanMode: "eco",            // eco | fast
    showFaceStrip: true,
    faceQuestions: "occasional", // occasional | never - quick "Is this Anna?" checks in People
    // Mouse & keyboard
    openWith: "double",          // double | single
    fileOpenAction: "viewer",    // viewer | app
    middleClickFolder: "newTab", // newTab | none
    // Media
    autoplay: true,
    subtitlesDefault: false,
    preferredSubLang: "",
    preferredAudioLang: "",
    subtitleSize: "medium",      // small | medium | large
    seekShort: "5",              // seconds for Left/Right in the player
    seekLong: "10",              // seconds for J/L and the skip buttons
    // Themes & icons
    themePack: "windows",        // windows | macos | <imported id>
    iconPack: "windows",         // windows | macos | <imported id>
    systemIcons: "apps",         // off | apps (programs, shortcuts, .ico) | all
    // File operations
    conflictDefault: "ask",      // ask | rename | replace | newer | skip
    // Context menu
    systemMenu: "submenu",       // submenu ("Show more options") | inline | off
    sysMenuPlacement: {},        // system entry label -> main | more | hidden
    customActions: navigator.userAgent.includes("Windows") ? [
      { id: "ps", name: "Open PowerShell here", program: "powershell.exe", args: "-NoExit -Command Set-Location -LiteralPath {dir}", on: "all", exts: "" },
    ] : [],
    // File handling
    openHandlers: {},            // category -> viewer | app
    // Network
    netLocations: [],
    // Editors
    editorWrap: false,
    // Advanced
    showDebugInfo: false,
  };

  let values = { ...DEFAULTS };
  try { Object.assign(values, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch {}

  const listeners = new Set();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(values)); } catch {} }

  // ---------- colour helpers ----------
  const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgbToHex = (r, g, b) => "#" + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const mix = (hex, target, t) => { const a = hexToRgb(hex), b = hexToRgb(target); return rgbToHex(...a.map((v, i) => v + (b[i] - v) * t)); };
  const lum = hex => { const [r, g, b] = hexToRgb(hex).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };

  const TINTS = { blue: 212, purple: 272, crimson: 345, green: 145, amber: 32, teal: 184 };
  const ROW = { compact: 32, default: 38, comfortable: 44 };
  const TEXT = { small: "13px", default: "14px", large: "15.5px" };
  const GRID = { small: "112px", medium: "150px", large: "200px" };

  // Hardware tier guess (sync) until the backend's exact profile arrives (cores + RAM + battery).
  let hwTier = (() => {
    const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 8;
    return cores <= 4 || mem < 8 ? "low" : cores >= 8 ? "high" : "mid";
  })();
  function perfTier() { return hwTier; }
  window.__TAURI__?.core?.invoke("system_profile").then(p => {
    if (!p) return;
    window.__pfProfile = p;
    const t = p.battery && p.tier === "high" ? "mid" : p.tier;
    if (t !== hwTier) { hwTier = t; try { apply(); } catch {} }
  }).catch(() => {});

  // OS backdrop (Mica/Acrylic/vibrancy). The page only turns see-through once the OS effect
  // is confirmed, so platforms without it keep a solid, readable window.
  let lastFx = null;
  function applyWindowEffect(fx) {
    if (fx === lastFx) return;
    lastFx = fx;
    const root = document.documentElement, core = window.__TAURI__?.core;
    if (!core || fx === "none") { root.classList.remove("pf-effect-on"); if (core) core.invoke("set_window_effect", { effect: "none" }).catch(() => {}); return; }
    core.invoke("set_window_effect", { effect: fx }).then(ok => root.classList.toggle("pf-effect-on", !!ok)).catch(() => root.classList.remove("pf-effect-on"));
  }

  function isDark() {
    const t = document.documentElement.getAttribute("data-theme") || "";
    return !t.includes("light");
  }

  function resolvedTheme() {
    if (values.theme !== "system") return values.theme;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "fluent-light" : "fluent-dark";
  }

  function applyTheme() {
    const theme = resolvedTheme();
    // main.js restores from fe:theme on boot - keep it in agreement.
    try { localStorage.setItem("fe:theme", theme); } catch {}
    if (document.documentElement.getAttribute("data-theme") !== theme) document.documentElement.setAttribute("data-theme", theme);
    const sel = document.getElementById("themeSelect");
    if (sel && sel.value !== theme) {
      sel.value = theme;
      sel.dispatchEvent(new Event("change")); // main.js setTheme keeps its own state in sync
    } else if (!sel) {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }

  // Row/header column templates (hidden columns are removed, not zero-width, so cells never shift).
  function columnTemplates() {
    const cols = [];
    if (values.colTag) cols.push("minmax(90px,.55fr)");
    if (values.colDate) cols.push("minmax(150px,.8fr)");
    if (values.colType) cols.push("minmax(110px,.7fr)");
    if (values.colSize) cols.push("minmax(90px,.45fr)");
    const check = values.showCheckboxes ? "30px " : "";
    return {
      row: `${check}32px minmax(180px,2fr) ${cols.join(" ")}`.trim(),
      head: `${check}minmax(212px,2fr) ${cols.join(" ")}`.trim(),
    };
  }

  function apply() {
    const root = document.documentElement;
    const c = root.classList;
    applyTheme();

    // accent
    const st = root.style;
    if (values.accent && values.accent !== "default") {
      const base = values.accent;
      const dark = isDark();
      const acc = dark ? mix(base, "#ffffff", .38) : base;
      st.setProperty("--accent", acc);
      st.setProperty("--accent-hover", dark ? mix(acc, "#000000", .12) : mix(base, "#ffffff", .12));
      st.setProperty("--accent-text", acc);
      st.setProperty("--accent-bg", `color-mix(in srgb, ${acc} ${dark ? 16 : 11}%, transparent)`);
      st.setProperty("--on-accent", lum(acc) > .45 ? "#0a0a0a" : "#ffffff");
    } else {
      ["--accent", "--accent-hover", "--accent-text", "--accent-bg", "--on-accent"].forEach(p => st.removeProperty(p));
    }

    // backdrop tint
    const hue = TINTS[values.tint];
    c.toggle("pf-tinted", hue != null);
    if (hue != null) {
      st.setProperty("--tint-h", hue);
      st.setProperty("--tint-a", (values.tintStrength / 100).toFixed(2));
    }

    // Performance tier: auto follows the hardware (see perfTier); saver also drops blur & motion.
    const tier = values.performance === "auto" ? perfTier() : ({ saver: "low", balanced: "mid", max: "high" }[values.performance] || "mid");
    root.dataset.perf = tier;
    root.dataset.glass = values.transparency ? values.windowEffect : "none";
    applyWindowEffect(root.dataset.glass);
    c.toggle("pf-no-anim", !values.animations);
    c.toggle("pf-no-transparency", !values.transparency);
    c.toggle("pf-square", values.corners === "square");
    st.setProperty("--fs-base", TEXT[values.textSize] || TEXT.default);
    st.setProperty("--row-h", (ROW[values.density] || 38) + "px");
    st.setProperty("--grid-min", GRID[values.gridSize] || GRID.medium);
    root.dataset.density = values.density;

    const t = columnTemplates();
    st.setProperty("--row-cols", t.row);
    st.setProperty("--head-cols", t.head);
    c.toggle("pf-hide-checkboxes", !values.showCheckboxes);
    c.toggle("pf-hide-col-tag", !values.colTag);
    c.toggle("pf-hide-col-date", !values.colDate);
    c.toggle("pf-hide-col-type", !values.colType);
    c.toggle("pf-hide-col-size", !values.colSize);
    c.toggle("pf-hide-statusbar", !values.showStatusBar);
    c.toggle("pf-toolbar-labels", values.toolbarLabels);
    c.toggle("pf-show-extra-toolbar", values.showExtraToolbar);
    c.toggle("pf-show-toolbar-info", values.showToolbarInfo);

    c.toggle("pf-hide-sec-pinned", !values.showPinned);
    c.toggle("pf-hide-sec-drives", !values.showDrives);
    c.toggle("pf-hide-sec-media", !values.showMedia);
    c.toggle("pf-hide-sec-network", !values.showNetwork);
    c.toggle("pf-hide-sec-tags", !values.showTags);
    c.toggle("pf-drives-detailed", values.driveDetails === "detailed");
    c.toggle("pf-sidebar-collapsed", !!values.sidebarCollapsed);
    document.querySelectorAll("[data-section]").forEach(sec =>
      sec.classList.toggle("collapsed", values.collapsedSections.includes(sec.dataset.section)));

    c.toggle("pf-hide-search-status", !values.showSearchStatus);
    c.toggle("pf-hide-face-strip", !values.showFaceStrip);
    c.toggle("pf-show-debug", values.showDebugInfo);

    const hidden = document.getElementById("hiddenToggle");
    if (hidden && hidden.checked !== values.showHidden) {
      hidden.checked = values.showHidden;
      hidden.dispatchEvent(new Event("change"));
    }
  }

  function set(key, value) {
    if (values[key] === value) return;
    values[key] = value;
    save();
    apply();
    if (key === "scanMode") {
      try { window.__TAURI__?.core?.invoke("set_fast_scan_mode", { fast: value === "fast" }); } catch {}
    }
    listeners.forEach(fn => { try { fn(key, values); } catch (e) { console.error(e); } });
    window.dispatchEvent(new CustomEvent("pifiles:settings", { detail: { key, values } }));
    if (dialog) refreshDialog();
  }

  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (values.theme === "system") apply();
  });

  // ---------- Settings window ----------
  const I = (n) => (window.PiIcons ? PiIcons.ui(n) : "");
  const ACCENTS = ["#0078d4", "#0099bc", "#00b294", "#107c10", "#ca5010", "#e81123", "#e3008c", "#8764b8", "#6b69d6", "#767676"];

  const PAGES = [
    { id: "general", title: "General", icon: "settings", items: [
      { key: "startup", type: "select", title: "On startup, open", desc: "What PiFiles shows when it launches",
        options: [["home", "Home"], ["last", "The last folder I had open"], ["path", "A specific folder"]] },
      { key: "startupPath", type: "text", title: "Startup folder", desc: "e.g. C:\\Users\\You\\Pictures", show: v => v.startup === "path" },
      { key: "confirmDelete", type: "toggle", title: "Ask before deleting", desc: "Show a confirmation before items are deleted" },
      { heading: "Privacy" },
      { key: "trackRecent", type: "toggle", title: "Remember recently opened files", desc: "Shown under Recent and on Home. Turning this off also hides the list" },
      { type: "action", title: "Clear recent files", desc: "Forget the list of files you opened", label: "Clear", run: () => { window.__clearRecent?.(); window.toast?.("Recent files cleared"); } },
      { type: "action", title: "Clear history", desc: "Forget the last location PiFiles reopens at startup", label: "Clear", run: () => { try { ["pf:lastLoc", "fe:lastPath"].forEach(k => localStorage.removeItem(k)); } catch {} window.toast?.("History cleared"); } },
    ]},
    { id: "appearance", title: "Appearance", icon: "palette", items: [
      { key: "theme", type: "segmented", title: "Color mode", desc: "Light, dark, or follow the system. Themes and icon packs are under Themes & icons",
        options: [["system", "Use system setting"], ["fluent-light", "Light"], ["fluent-dark", "Dark"]] },
      { key: "theme", type: "select", title: "Design language", desc: "Fluent (Windows 11) or Material You styling",
        options: [["fluent-dark", "Fluent - Dark"], ["fluent-light", "Fluent - Light"], ["material-dark", "Material - Dark"], ["material-light", "Material - Light"], ["system", "Fluent - follow system"]] },
      { key: "accent", type: "swatches", title: "Accent color", desc: "Used for selection, links and highlights", swatches: ACCENTS, custom: true },
      { key: "tint", type: "tints", title: "Background tint", desc: "Colour the window backdrop, like Mica with a wallpaper tint" },
      { key: "tintStrength", type: "range", title: "Tint intensity", min: 10, max: 100, show: v => v.tint !== "none" },
      { key: "transparency", type: "toggle", title: "Transparency effects", desc: "Blurred, translucent menus and panes" },
      { key: "windowEffect", type: "segmented", title: "Window material", desc: "See-through window backdrop. Liquid glass adds refractive, glossy panels (uses more GPU)", show: v => v.transparency,
        options: [["none", "Solid"], ["mica", "Mica"], ["acrylic", "Acrylic"], ["glass", "Liquid glass"]] },
      { key: "animations", type: "toggle", title: "Animation effects", desc: "Motion when opening folders, menus and dialogs" },
      { key: "corners", type: "segmented", title: "Corners", options: [["rounded", "Rounded"], ["square", "Square"]] },
      { key: "textSize", type: "segmented", title: "Text size", options: [["small", "Small"], ["default", "Default"], ["large", "Large"]] },
    ]},
    { id: "themes", title: "Themes & icons", icon: "brush", items: [] },
    { id: "performance", title: "Performance", icon: "speed", items: [
      { key: "performance", type: "select", title: "Performance mode", desc: "Automatic adapts effects, thumbnail loading and background work to this PC",
        options: [["auto", "Automatic (recommended)"], ["saver", "Battery & low-end saver"], ["balanced", "Balanced"], ["max", "Maximum performance"]] },
      { type: "info", title: "This PC", desc: () => { const p = window.__pfProfile; return p ? `${p.cores} CPU threads · ${p.ram_gb} GB memory${p.battery ? " · on battery" : ""} → ${({ low: "low-end", mid: "mid-range", high: "high-end" })[p.tier]} profile` : "Detecting…"; } },
      { type: "action", title: "Clear thumbnail cache", desc: "Thumbnails are saved so folders open instantly next time. Clearing frees disk space; they're rebuilt as you browse", label: "Clear", run: () => window.__TAURI__?.core?.invoke("clear_thumbnail_cache").then(b => window.toast?.(`Freed ${(b / 1048576).toFixed(1)} MB`)) },
      { type: "action", title: "Free memory now", desc: "Release caches PiFiles isn't using (they reload when needed)", label: "Free memory", run: () => window.__TAURI__?.core?.invoke("set_background_mode", { background: true }).then(() => window.__TAURI__.core.invoke("set_background_mode", { background: false })).then(() => window.toast?.("Memory released")) },
    ]},
    { id: "layout", title: "Layout", icon: "layoutIco", items: [
      { key: "density", type: "segmented", title: "Spacing", desc: "Row height in the file list",
        options: [["compact", "Compact"], ["default", "Default"], ["comfortable", "Comfortable"]] },
      { key: "gridSize", type: "segmented", title: "Grid item size", options: [["small", "Small"], ["medium", "Medium"], ["large", "Large"]] },
      { key: "showCheckboxes", type: "toggle", title: "Selection checkboxes", desc: "Show a checkbox on every item" },
      { heading: "Columns (Details view)" },
      { key: "colTag", type: "toggle", title: "File tag" },
      { key: "colDate", type: "toggle", title: "Date modified" },
      { key: "colType", type: "toggle", title: "Type" },
      { key: "colSize", type: "toggle", title: "Size" },
      { heading: "Command bar & status bar" },
      { key: "toolbarLabels", type: "toggle", title: "Show labels on command bar buttons" },
      { key: "showExtraToolbar", type: "toggle", title: "Show Select all, New folder and Split view buttons" },
      { key: "showToolbarInfo", type: "toggle", title: "Show path and item count chips in the command bar" },
      { key: "showStatusBar", type: "toggle", title: "Status bar", desc: "Item count and selection summary at the bottom" },
    ]},
    { id: "files", title: "Files & folders", icon: "folderLine", items: [
      { key: "showHidden", type: "toggle", title: "Show hidden files", desc: "Include items starting with . or $" },
      { key: "showExtensions", type: "toggle", title: "Show file extensions", desc: "e.g. photo.jpg instead of photo" },
      { key: "showThumbnails", type: "toggle", title: "Show thumbnails", desc: "Previews for photos, videos and PDFs instead of icons" },
      { key: "foldersFirst", type: "toggle", title: "List folders before files" },
      { key: "autoFolderSizes", type: "toggle", title: "Calculate folder sizes automatically", desc: "Fills the Size column for visible folders in the background. Off: sizes appear on demand" },
      { key: "dateFormat", type: "select", title: "Date format",
        options: [["relative", "Relative for recent (4 days ago)"], ["long", "12 June 2026"], ["short", "12/06/2026"], ["iso", "2026-06-12"]] },
      { key: "sizeUnits", type: "segmented", title: "Size units", desc: "Binary matches Windows' own calculation",
        options: [["binary", "KiB, MiB (1024)"], ["decimal", "KB, MB (1000)"]] },
    ]},
    { id: "handling", title: "File handling", icon: "openWith", items: [] },
    { id: "contextmenu", title: "Context menu", icon: "more", items: [] },
    { id: "operations", title: "File operations", icon: "operations", items: [
      { key: "conflictDefault", type: "select", title: "When an item with the same name exists", desc: "What copying or moving does when the destination already has it",
        options: [["ask", "Ask me each time"], ["rename", "Keep both (rename the new one)"], ["replace", "Replace"], ["newer", "Replace if newer"], ["skip", "Skip"]] },
      { type: "info", title: "Progress", desc: "Copying, moving and deleting run in the background. Their live progress, speed and time left are in the File operations button at the top right, where they can be paused or cancelled." },
      { type: "info", title: "Speed", desc: "Large files use the operating system's own copy engine (unbuffered I/O for very large files, server-side copy on network shares); many small files are copied in parallel. Moves on the same drive are instant renames." },
    ]},
    { id: "restore", title: "Restore", icon: "history", items: [] },
    { id: "tags", title: "Tags", icon: "tags", items: [] },
    { id: "media", title: "Media", icon: "play", items: [
      { key: "autoplay", type: "toggle", title: "Start playing when a movie or song opens" },
      { key: "subtitlesDefault", type: "toggle", title: "Turn subtitles on automatically", desc: "Forced subtitles (e.g. for foreign dialogue) always show" },
      { key: "preferredSubLang", type: "text", title: "Preferred subtitle language", desc: "e.g. en, English, ta - used when several tracks exist" },
      { key: "preferredAudioLang", type: "text", title: "Preferred audio language", desc: "e.g. ta, Tamil, ja - picks that track when a movie has several" },
      { key: "subtitleSize", type: "segmented", title: "Subtitle size", options: [["small", "Small"], ["medium", "Medium"], ["large", "Large"]] },
      { key: "seekShort", type: "select", title: "Short skip", desc: "Left and Right arrow keys",
        options: [["2", "2 seconds"], ["3", "3 seconds"], ["5", "5 seconds"], ["10", "10 seconds"], ["15", "15 seconds"], ["30", "30 seconds"]] },
      { key: "seekLong", type: "select", title: "Long skip", desc: "J and L keys, and the skip buttons",
        options: [["5", "5 seconds"], ["10", "10 seconds"], ["15", "15 seconds"], ["30", "30 seconds"], ["60", "1 minute"], ["120", "2 minutes"], ["300", "5 minutes"]] },
      { type: "action", title: "Player keyboard shortcuts", desc: "Change the keys for play, skip, volume, subtitles and more", label: "Edit…", run: () => { page = "advanced"; refreshDialog(); setTimeout(() => dialog?.querySelector('[data-sec="keys:Movie player"]')?.scrollIntoView({ block: "start", behavior: "smooth" }), 60); } },
      { type: "info", title: "Playback engine", desc: "Bundled FFmpeg 9.0 (LGPL). Formats WebView2 can't play (MKV, AVI, HEVC, AC-3/DTS…) are repackaged or converted on the fly using your GPU when available." },
    ]},
    { id: "navigation", title: "Navigation pane", icon: "sidebarNav", items: [
      { key: "sidebarCollapsed", type: "toggle", title: "Hide navigation pane", desc: "Also toggled with the button at the top-left" },
      { key: "showPinned", type: "toggle", title: "Pinned" },
      { key: "showDrives", type: "toggle", title: "Drives" },
      { key: "driveDetails", type: "segmented", title: "Drive display", desc: "Detailed shows free space and a usage bar",
        options: [["compact", "Compact"], ["detailed", "Detailed"]], show: v => v.showDrives },
      { key: "showMedia", type: "toggle", title: "Media (Gallery, People, Devices)" },
      { key: "showNetwork", type: "toggle", title: "Network" },
      { key: "showTags", type: "toggle", title: "Tags" },
    ]},
    { id: "search", title: "Search", icon: "search", items: [
      { key: "showSearchStatus", type: "toggle", title: "Show index status in the search box", desc: "Number of indexed files and query time" },
      { type: "action", title: "Rebuild search index", desc: "Re-scan drives for instant search", label: "Rebuild", run: () => { window.__TAURI__?.core?.invoke("rebuild_index").catch(() => {}); window.toast?.("Rebuilding the search index…"); } },
    ]},
    { id: "people", title: "People & media", icon: "person", items: [
      { key: "faceQuestions", type: "segmented", title: "Quick face checks", desc: "Now and then, ask one or two \"Is this Anna?\" questions in People to improve grouping (on this computer only)", options: [["occasional", "Occasionally"], ["never", "Never"]] },
      { key: "scanMode", type: "segmented", title: "Face scanning", desc: "Eco uses one core in the background; Fast uses all cores",
        options: [["eco", "Eco"], ["fast", "Fast"]] },
      { type: "info", title: "What PiFiles has learned from you", desc: () => document.getElementById("aiModelStats")?.textContent || "-" },
      { key: "showFaceStrip", type: "toggle", title: "Show face previews on person cards" },
      { type: "action", title: "Re-detect faces", desc: "Scan for new photos now at full speed", label: "Re-detect", run: () => document.getElementById("peopleRefreshBtn")?.click() },
      { type: "action", title: "Reset learned recognition", desc: "Forget confirmations, merges and corrections", label: "Reset…", danger: true, run: () => document.getElementById("aiResetModelBtn")?.click() },
    ]},
    { id: "advanced", title: "Advanced", icon: "advanced", items: [
      { heading: "Mouse" },
      { key: "openWith", type: "segmented", title: "Open items with", desc: "Applies to files and folders everywhere: lists, grid, search results and archives",
        options: [["double", "Double-click"], ["single", "Single-click"]] },
      { key: "fileOpenAction", type: "segmented", title: "When opening a file", desc: "Movies, music, archives, spreadsheets, images, PDFs and text open inside PiFiles",
        options: [["viewer", "Built-in viewer"], ["app", "Default app"]] },
      { key: "middleClickFolder", type: "segmented", title: "Middle-click", desc: "Folders open in a new tab; files open",
        options: [["newTab", "Open"], ["none", "Do nothing"]] },
      { heading: "Keyboard shortcuts" },
      { type: "embed", id: "shortcuts" },
      { heading: "Diagnostics and maintenance" },
      { key: "showDebugInfo", type: "toggle", title: "Show diagnostic info", desc: "Theme, zoom and backend details in the status bar" },
      { type: "action", title: "Export settings", desc: "Save your preferences to a file", label: "Export", run: exportSettings },
      { type: "action", title: "Import settings", desc: "Load preferences from a file", label: "Import", run: importSettings },
      { type: "action", title: "Reset all settings", desc: "Restore every option to its default", label: "Reset", danger: true, run: resetAll },
    ]},
    { id: "about", title: "About", icon: "info", items: [] },
  ];

  let dialog = null;
  let page = "general";
  // Collapsed settings sections (per viewer, remembered across launches).
  const sections = {
    get() { try { return JSON.parse(localStorage.getItem("pf:collapsedSections") || "[]"); } catch { return []; } },
    collapsed(id) { return this.get().includes(id); },
    set(id, collapsed) {
      const all = new Set(this.get());
      collapsed ? all.add(id) : all.delete(id);
      try { localStorage.setItem("pf:collapsedSections", JSON.stringify([...all])); } catch {}
    },
  };
  window.PiSettingsSections = sections;
  const EMBEDS = { shortcuts: el => window.PiKeys?.render(el) };

  function esc(s) { return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }

  // Only real colours reach HTML/CSS (values can come from an imported settings file).
  const color = (c, d) => (typeof c === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c) ? c : d);
  const num = (n, d) => (Number.isFinite(Number(n)) ? Number(n) : d);

  function control(it) {
    const v = values[it.key];
    switch (it.type) {
      case "toggle":
        return `<button class="pf-switch ${v ? "on" : ""}" role="switch" aria-checked="${!!v}" data-set="${it.key}" data-bool="1"><span class="pf-switch-label">${v ? "On" : "Off"}</span><span class="pf-knob"></span></button>`;
      case "select":
        return `<select class="pf-select" data-set="${it.key}">${it.options.map(([val, lbl]) => `<option value="${esc(val)}" ${val === v ? "selected" : ""}>${esc(lbl)}</option>`).join("")}</select>`;
      case "segmented":
        return `<div class="pf-seg" role="radiogroup">${it.options.map(([val, lbl]) => `<button role="radio" aria-checked="${val === v}" class="${val === v ? "on" : ""}" data-set="${it.key}" data-val="${esc(val)}">${esc(lbl)}</button>`).join("")}</div>`;
      case "text":
        return `<input class="pf-text" type="text" value="${esc(v || "")}" data-set="${it.key}" spellcheck="false">`;
      case "range":
        return `<div class="pf-range"><input type="range" min="${num(it.min, 0)}" max="${num(it.max, 100)}" value="${num(v, 0)}" data-set="${esc(it.key)}" data-num="1"><span>${num(v, 0)}%</span></div>`;
      case "swatches": {
        const custom = v !== "default" ? color(v, null) : null;
        return `<div class="pf-swatches"><button class="pf-sw auto ${v === "default" ? "on" : ""}" data-set="${esc(it.key)}" data-val="default" title="Theme default">A</button>` +
          it.swatches.map(sw => color(sw, null)).filter(Boolean).map(sw => `<button class="pf-sw ${v === sw ? "on" : ""}" style="--sw:${sw}" data-set="${esc(it.key)}" data-val="${sw}" title="${sw}"></button>`).join("") +
          `<label class="pf-sw custom ${custom && !it.swatches.includes(custom) ? "on" : ""}" title="Custom colour" style="--sw:${custom || "#888"}"><input type="color" value="${custom || "#0078d4"}" data-set="${esc(it.key)}"></label></div>`;
      }
      case "tints":
        return `<div class="pf-swatches">` + [["none", null], ...Object.entries(TINTS)].map(([name, h]) =>
          `<button class="pf-sw tint ${v === name ? "on" : ""}" style="--sw:${h == null ? "transparent" : `hsl(${num(h, 0)} 55% 42%)`}" data-set="${esc(it.key)}" data-val="${esc(name)}" title="${esc(name)}">${h == null ? "∅" : ""}</button>`).join("") + `</div>`;
      case "action":
        return `<button class="pf-btn ${it.danger ? "danger" : ""}" data-action="${esc(it.title)}">${esc(it.label)}</button>`;
    }
    return "";
  }

  function renderPage() {
    const p = PAGES.find(x => x.id === page) || PAGES[0];
    if (p.id === "about") {
      const ver = window.__pfAppInfo?.version || "0.1.0";
      if (!window.__pfAppInfo) window.__TAURI__?.core?.invoke("app_info").then(i => { window.__pfAppInfo = i; if (page === "about") refreshDialog(); }).catch(() => {});
      const link = (url, label) => url ? `<a href="#" class="pf-link" data-ext-url="${esc(url)}">${esc(label || url.replace(/^https?:\/\//, ""))}</a>` : "";
      return `<h2>${esc(p.title)}</h2>
        <div class="pf-about">
          <div class="pf-about-logo"><img src="logo.svg" alt="PiFiles logo" width="72" height="72"></div>
          <div><div class="pf-about-name">PiFiles</div><div class="pf-muted">Version ${esc(ver)} · by ${esc(ABOUT.organization)}</div></div>
        </div>
        <div class="pf-card-group">
          <div class="pf-row"><div class="pf-row-text"><div class="pf-row-title">What PiFiles is</div><div class="pf-row-desc">A fast, private file manager built for photographers. Browse, search and organise your whole library, preview RAW files, find photos by camera, person or tag, and copy large shoots quickly. Everything runs on your own computer.</div></div></div>
          <div class="pf-row"><div class="pf-row-text"><div class="pf-row-title">Our goal</div><div class="pf-row-desc">To get the best performance out of your computer for everyday work, with privacy built in from the start. Rather than juggling several tools, PiFiles brings browsing, previewing, organising and editing together in one fast application. We keep improving it based on your suggestions and feedback, and we're building more tools to make your work easier.</div></div></div>
          <div class="pf-row"><div class="pf-row-text"><div class="pf-row-title">Our vision</div><div class="pf-row-desc">One home for a photographer's files, from card import to final delivery. It should be fast on modest hardware, respect your privacy by keeping your files and faces on your device, and look at home on Windows, macOS and Linux.</div></div></div>
        </div>
        <h3>Updates</h3>
        <div class="pf-embed" data-embed="updates"></div>
        <h3>Project</h3>
        <div class="pf-card-group">
          <div class="pf-row"><div class="pf-row-text"><div class="pf-row-title">Organization</div><div class="pf-row-desc">${esc(ABOUT.organization)}</div></div></div>
          <div class="pf-row"><div class="pf-row-text"><div class="pf-row-title">Source code and issues</div><div class="pf-row-desc">${link(ABOUT.github)}</div></div></div>
          ${ABOUT.website ? `<div class="pf-row"><div class="pf-row-text"><div class="pf-row-title">Website</div><div class="pf-row-desc">${link(ABOUT.website)}</div></div></div>` : ""}
        </div>`;
    }
    if (p.render) return `<h2>${esc(p.title)}</h2><div class="pf-custom" data-custom="${esc(p.id)}"></div>`;
    let html = `<h2>${esc(p.title)}</h2><div class="pf-card-group">`, inSec = false;
    for (const it of p.items) {
      if (it.heading) {
        // Each heading starts a collapsible section (remembered per section).
        const id = `${p.id}:${it.heading}`;
        html += `</div>${inSec ? "</details>" : ""}<details class="pf-sec" data-sec="${esc(id)}" ${sections.collapsed(id) ? "" : "open"}><summary><h3>${esc(it.heading)}</h3></summary><div class="pf-card-group">`;
        inSec = true;
        continue;
      }
      if (it.type === "embed") { html += `</div><div class="pf-embed" data-embed="${esc(it.id)}"></div><div class="pf-card-group">`; continue; }
      if (it.show && !it.show(values)) continue;
      const desc = typeof it.desc === "function" ? it.desc() : it.desc;
      html += `<div class="pf-row"><div class="pf-row-text"><div class="pf-row-title">${esc(it.title)}</div>${desc ? `<div class="pf-row-desc">${esc(desc)}</div>` : ""}</div><div class="pf-row-ctl">${control(it)}</div></div>`;
    }
    return html + `</div>${inSec ? "</details>" : ""}`;
  }

  function refreshDialog() {
    if (!dialog) return;
    const body = dialog.querySelector(".pf-settings-body");
    const scroll = body.scrollTop;
    body.innerHTML = renderPage();
    const custom = body.querySelector(".pf-custom");
    if (custom) { try { PAGES.find(x => x.id === page)?.render(custom); } catch (e) { console.error("settings page", e); } }
    body.querySelectorAll(".pf-embed").forEach(el => { try { EMBEDS[el.dataset.embed]?.(el); } catch (e) { console.error("settings embed", e); } });
    body.querySelectorAll(".pf-card-group:empty").forEach(g => g.remove());
    body.scrollTop = scroll;
    dialog.querySelectorAll(".pf-settings-nav button").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  }

  function buildDialog() {
    dialog = document.createElement("div");
    dialog.id = "settingsModal";
    dialog.className = "pf-settings hidden";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Settings");
    dialog.innerHTML = `
      <div class="pf-settings-backdrop"></div>
      <div class="pf-settings-box">
        <aside class="pf-settings-nav">
          <div class="pf-settings-title">Settings</div>
          ${PAGES.map(p => `<button data-page="${p.id}"><span class="pf-nav-ico">${I(p.icon)}</span>${esc(p.title)}</button>`).join("")}
        </aside>
        <section class="pf-settings-main">
          <button class="pf-settings-close" title="Close (Esc)" aria-label="Close settings">${I("close")}</button>
          <div class="pf-settings-body"></div>
        </section>
      </div>`;
    document.body.appendChild(dialog);
    window.PiMotion?.register(dialog, ".pf-settings-box");

    dialog.querySelector(".pf-settings-backdrop").onclick = close;
    // "toggle" doesn't bubble; listen in the capture phase for every section.
    dialog.addEventListener("toggle", e => { const d = e.target; if (d?.classList?.contains("pf-sec") && d.dataset.sec) sections.set(d.dataset.sec, !d.open); }, true);
    dialog.querySelector(".pf-settings-close").onclick = close;
    dialog.querySelector(".pf-settings-nav").addEventListener("click", e => {
      const b = e.target.closest("[data-page]");
      if (b) { page = b.dataset.page; refreshDialog(); dialog.querySelector(".pf-settings-body").scrollTop = 0; }
    });
    const body = dialog.querySelector(".pf-settings-body");
    body.addEventListener("click", e => {
      const ext = e.target.closest("[data-ext-url]");
      if (ext) {
        e.preventDefault();
        const url = ext.dataset.extUrl;
        if (/^https:\/\//.test(url)) window.__TAURI__?.core?.invoke("plugin:opener|open_url", { url }).catch(() => window.toast?.(url));
        return;
      }
      const go = e.target.closest("[data-goto-page]");
      if (go) { page = go.dataset.gotoPage; refreshDialog(); return; }
      const act = e.target.closest("[data-action]");
      if (act) {
        const it = PAGES.flatMap(p => p.items).find(x => x.type === "action" && x.title === act.dataset.action);
        it?.run();
        return;
      }
      const b = e.target.closest("button[data-set]");
      if (!b) return;
      const key = b.dataset.set;
      set(key, b.dataset.bool ? !values[key] : b.dataset.val);
    });
    body.addEventListener("input", e => {
      const el = e.target;
      if (el.type === "range") { el.nextElementSibling.textContent = el.value + "%"; set(el.dataset.set, Number(el.value)); }
      else if (el.type === "color") set(el.dataset.set, el.value);
    });
    body.addEventListener("change", e => {
      const el = e.target;
      if (el.matches("select[data-set], input.pf-text")) set(el.dataset.set, el.value);
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && dialog && !dialog.classList.contains("hidden")) close(); });
  }

  // Opens out of the control that launched it (gear, sidebar entry) and closes back into it;
  // the gear icons spin while the window is open.
  function open(pageId, trigger) {
    if (!dialog) buildDialog();
    if (pageId) page = pageId;
    refreshDialog();
    document.documentElement.classList.add("pf-settings-open");
    if (window.PiMotion) PiMotion.open(dialog, trigger);
    else dialog.classList.remove("hidden");
  }
  function close() {
    if (!dialog || dialog.classList.contains("hidden")) return;
    document.documentElement.classList.remove("pf-settings-open");
    dialog.classList.add("hidden");
  }

  function exportSettings() {
    const blob = new Blob([JSON.stringify(values, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pifiles-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importSettings() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json,.json";
    inp.onchange = async () => {
      try {
        const data = JSON.parse(await inp.files[0].text());
        // Known settings only, and only with the same type as the default (a file can't put a
        // string where a number, flag or colour belongs).
        const sameType = (a, b) => (Array.isArray(a) ? Array.isArray(b) : a === null || typeof a !== "object" ? typeof a === typeof b : b !== null && typeof b === "object" && !Array.isArray(b));
        for (const k of Object.keys(DEFAULTS)) {
          if (!(k in data) || !sameType(DEFAULTS[k], data[k])) continue;
          if (typeof data[k] === "string" && data[k].length > 2000) continue;
          set(k, data[k]);
        }
        window.toast?.("Settings imported");
      } catch { window.toast?.("That file isn't a PiFiles settings file"); }
    };
    inp.click();
  }
  async function resetAll() {
    const ok = await window.PiDialog?.confirm({ title: "Reset all settings?", message: "Every option goes back to its default. Your files, people and names aren't affected.", okText: "Reset", danger: true });
    if (!ok) return;
    for (const k of Object.keys(DEFAULTS)) set(k, DEFAULTS[k]);
    window.toast?.("Settings reset");
  }

  window.PiSettings = {
    get: (k) => (k ? values[k] : values),
    set,
    open,
    close,
    onChange: (fn) => listeners.add(fn),
    /** Gives a page (by id) its own renderer: `render(container)`. */
    definePage(id, render) {
      const pg = PAGES.find(x => x.id === id);
      if (pg) pg.render = render;
      if (dialog && page === id) refreshDialog();
    },
    /** Gives a section inside a page (`{ type: "embed", id }` or a .pf-embed) its own renderer. */
    defineEmbed(id, render) {
      EMBEDS[id] = render;
      if (dialog) refreshDialog();
    },
    /** Re-draws the open page (e.g. after async data arrived). */
    refresh: () => refreshDialog(),
    get currentPage() { return dialog && !dialog.classList.contains("hidden") ? page : null; },
    rowHeight: () => ROW[values.density] || 38,
    toggleSection(id) {
      const s = new Set(values.collapsedSections);
      s.has(id) ? s.delete(id) : s.add(id);
      set("collapsedSections", [...s]);
    },
  };

  // Apply as early as possible (no flash), then again once the DOM exists.
  apply();
  document.addEventListener("DOMContentLoaded", apply);
  window.addEventListener("load", apply); // after main.js has bound its controls
})();
