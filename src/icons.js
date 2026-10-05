// PiFiles icon set - Fluent-style SVG icons (20px grid).
// UI glyphs are 1.5px outlines in currentColor; places, folders, drives and file types are
// colourful like Windows 11 / Files. Exposed as window.PiIcons for main.js and settings.js.
(function () {
  const svg = (body, cls = "", vb = "0 0 20 20") =>
    `<svg class="pi-ico ${cls}" viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;
  const line = (d, extra = "") =>
    svg(`<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`);

  const ui = {
    back: line("M16 10H4m5-5-5 5 5 5"),
    forward: line("M4 10h12m-5-5 5 5-5 5"),
    up: line("M10 16V4M5 9l5-5 5 5"),
    refresh: line("M15.5 6.5A6.5 6.5 0 1 0 16.5 11M16 3v4h-4"),
    chevronRight: line("m8 5 5 5-5 5"),
    chevronDown: line("m5 8 5 5 5-5"),
    search: line("M8.5 3.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm3.6 8.6L16.5 16.5"),
    add: line("M10 4v12M4 10h12"),
    addCircle: line("M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm0 4v6m-3-3h6"),
    cut: line("M6 13.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm8 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM7.3 14 14 3M12.7 14 6 3"),
    copy: line("M7 6.5V4.8C7 3.8 7.8 3 8.8 3h6.4c1 0 1.8.8 1.8 1.8v8.4c0 1-.8 1.8-1.8 1.8H13.5M4.8 6.5h6.4c1 0 1.8.8 1.8 1.8v6.9c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8V8.3c0-1 .8-1.8 1.8-1.8Z"),
    paste: line("M7.5 3.5h5v2.5h-5zM12.5 4.5h1.2c1 0 1.8.8 1.8 1.8v9.9c0 1-.8 1.8-1.8 1.8H6.3c-1 0-1.8-.8-1.8-1.8V6.3c0-1 .8-1.8 1.8-1.8h1.2"),
    rename: line("M3.5 6.5h9M3.5 13.5h6M14.5 3.5v13M12.5 3.5h4M12.5 16.5h4"),
    share: line("M12 3.5 16.5 8 12 12.5M16 8H10c-3.3 0-5.5 2.2-5.5 5.5v3"),
    delete: line("M3.5 5.5h13M8 5.5V4c0-.6.4-1 1-1h2c.6 0 1 .4 1 1v1.5M5 5.5l.8 10.2c.1 1 .9 1.8 1.9 1.8h4.6c1 0 1.8-.8 1.9-1.8L15 5.5M8.5 9v5M11.5 9v5"),
    properties: line("M12.6 3.4a3.7 3.7 0 0 0-4.5 4.8L3.6 12.7a1.9 1.9 0 0 0 2.7 2.7l4.5-4.5a3.7 3.7 0 0 0 4.8-4.5L13.3 8.7 11.3 6.7Z"),
    filter: line("M3.5 5.5h13M6 10h8M8.5 14.5h3"),
    sort: line("M6 16V4M3 7l3-3 3 3M14 4v12M11 13l3 3 3-3"),
    group: line("M3.5 4.5h13M3.5 10h13M3.5 15.5h13M6 4.5v11"),
    list: line("M7 5h9.5M7 10h9.5M7 15h9.5M3.5 5h.01M3.5 10h.01M3.5 15h.01"),
    details: line("M3.5 4.5h13v11h-13zM3.5 8h13M8 8v7.5"),
    grid: line("M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z"),
    pane: line("M4.8 3.5h10.4c.7 0 1.3.6 1.3 1.3v10.4c0 .7-.6 1.3-1.3 1.3H4.8c-.7 0-1.3-.6-1.3-1.3V4.8c0-.7.6-1.3 1.3-1.3ZM12 3.5v13"),
    sidebar: line("M4.8 3.5h10.4c.7 0 1.3.6 1.3 1.3v10.4c0 .7-.6 1.3-1.3 1.3H4.8c-.7 0-1.3-.6-1.3-1.3V4.8c0-.7.6-1.3 1.3-1.3ZM8 3.5v13"),
    settings: line("M10 7.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6ZM8.6 2.9l-.4 1.6-1.5.9-1.6-.5-1.4 2.4 1.2 1.1v1.8l-1.2 1.1 1.4 2.4 1.6-.5 1.5.9.4 1.6h2.8l.4-1.6 1.5-.9 1.6.5 1.4-2.4-1.2-1.1V9.1l1.2-1.1-1.4-2.4-1.6.5-1.5-.9-.4-1.6Z"),
    close: line("M5 5l10 10M15 5 5 15"),
    more: svg(`<circle cx="4.5" cy="10" r="1.3" fill="currentColor"/><circle cx="10" cy="10" r="1.3" fill="currentColor"/><circle cx="15.5" cy="10" r="1.3" fill="currentColor"/>`),
    copyPath: line("M8 12l4-4M9.3 5.7l1.5-1.5a3 3 0 0 1 4.2 4.2l-1.5 1.5M10.7 14.3l-1.5 1.5a3 3 0 0 1-4.2-4.2l1.5-1.5"),
    edit: line("M13.5 3.5 16.5 6.5 7 16H4v-3Z"),
    selectAll: line("M4.5 3.5h11c.6 0 1 .4 1 1v11c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1v-11c0-.6.4-1 1-1ZM7 10l2 2 4-4"),
    newFolder: line("M3.5 6V5c0-.8.7-1.5 1.5-1.5h3l2 2h5c.8 0 1.5.7 1.5 1.5v2M3.5 6v8.5c0 .8.7 1.5 1.5 1.5h5M14 11.5v5M11.5 14h5"),
    newFile: line("M11 3.5H6c-.8 0-1.5.7-1.5 1.5v10c0 .8.7 1.5 1.5 1.5h3.5M11 3.5l4.5 4.5M11 3.5V8h4.5v2M14 12.5v5M11.5 15h5"),
    recent: line("M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm0 3.5V10l2.5 2"),
    tag: line("M3.5 9.6V4.5c0-.6.4-1 1-1h5.1c.3 0 .5.1.7.3l6.1 6.1c.4.4.4 1 0 1.4l-5.1 5.1c-.4.4-1 .4-1.4 0L3.8 10.3a1 1 0 0 1-.3-.7ZM7 6.2h.01"),
    split: line("M3.5 4.5h13v11h-13zM10 4.5v11"),
    reload: line("M15.5 6.5A6.5 6.5 0 1 0 16.5 11M16 3v4h-4"),
    check: line("m4.5 10.5 3.5 3.5 7.5-8"),
    info: line("M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm0 6v4.5M10 6.5h.01"),
    palette: line("M10 3a7 7 0 0 0 0 14c1 0 1.5-.8 1.2-1.6-.4-1 .3-2.1 1.4-2.1H14c1.7 0 3-1.3 3-3A7 7 0 0 0 10 3ZM6.5 9.5h.01M8.5 6.5h.01M12 6.5h.01"),
    layoutIco: line("M3.5 4.5h13v4h-13zM3.5 11.5h6v4h-6zM12.5 11.5h4v4h-4z"),
    folderLine: line("M3.5 6V5c0-.8.7-1.5 1.5-1.5h3l2 2h5c.8 0 1.5.7 1.5 1.5v7.5c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5Z"),
    sidebarNav: line("M3.5 5h13M3.5 10h13M3.5 15h13"),
    person: line("M10 3.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM4 16.5c.7-2.7 3-4.5 6-4.5s5.3 1.8 6 4.5"),
    advanced: line("M4 5.5h7M14 5.5h2M4 10h2M9 10h7M4 14.5h9M16 14.5h0M11 4v3M6 8.5v3M13 13v3"),
    keyboard: line("M3.5 5.5h13v9h-13zM6 8.5h.01M9 8.5h.01M12 8.5h.01M14.5 8.5h.01M7 11.5h6"),
    starFill: svg(`<path d="m10 3 2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.8 5.8 16l.8-4.7L3.2 8l4.7-.7Z" fill="currentColor"/>`),
  };

  // ---- colourful places (sidebar / Home) ----
  const place = {
    userFolder: svg(`<path d="M2.5 6c0-.8.7-1.5 1.5-1.5h3.8l1.7 1.7H16c.8 0 1.5.7 1.5 1.5V15c0 .8-.7 1.5-1.5 1.5H4c-.8 0-1.5-.7-1.5-1.5Z" fill="#ffb900"/><path d="M2.5 8h15v7c0 .8-.7 1.5-1.5 1.5H4c-.8 0-1.5-.7-1.5-1.5Z" fill="#ffd75e"/><circle cx="10" cy="10.4" r="1.9" fill="#0f6cbd"/><path d="M6.7 15.6c.4-1.8 1.7-2.9 3.3-2.9s2.9 1.1 3.3 2.9Z" fill="#0f6cbd"/>`),
    home: svg(`<path d="M3 9.2 10 3l7 6.2V16c0 .6-.4 1-1 1h-3.5v-4.5h-5V17H4c-.6 0-1-.4-1-1Z" fill="#f7630c"/><path d="M8 17v-4.5h4V17" fill="#fce100" opacity=".9"/>`),
    pin: svg(`<path d="m12.2 2.8 5 5-2.3.8-3.4 3.4.3 3.1-1.3 1.3-3.1-3.1L3.8 17 3 16.2l3.7-3.6-3.1-3.1 1.3-1.3 3.1.3 3.4-3.4Z" fill="#3a96dd"/>`),
    desktop: svg(`<rect x="2.5" y="3.5" width="15" height="10" rx="1.5" fill="#0f6cbd"/><rect x="3.5" y="4.5" width="13" height="8" rx="1" fill="#62b7f4"/><path d="M7.5 16.5h5M10 13.5v3" stroke="#6e6e6e" stroke-width="1.5" stroke-linecap="round"/>`),
    downloads: svg(`<path d="M10 2.5v10m-4-4 4 4 4-4" stroke="#16c60c" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16.5h12" stroke="#16c60c" stroke-width="1.9" stroke-linecap="round"/>`),
    documents: svg(`<path d="M5 2.5h6.5L15.5 6.5V16c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5V4c0-.8.7-1.5 1.5-1.5Z" fill="#8fa3bf"/><path d="M11.5 2.5v4h4" fill="#c6d4e6"/><path d="M6.5 10h6M6.5 12.5h6M6.5 15h4" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>`),
    pictures: svg(`<rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="#0078d4"/><path d="m2.5 14 4.5-4.5 3 3 2-2 5.5 5.5v.5c0 .8-.7 1.5-1.5 1.5H4c-.8 0-1.5-.7-1.5-1.5Z" fill="#9ad6ff"/><circle cx="13" cy="7.5" r="1.6" fill="#fce100"/>`),
    music: svg(`<circle cx="10" cy="10" r="7.5" fill="#e3008c"/><path d="M8.3 13.2V6.8l4.5-1.2v6.3" stroke="#fff" stroke-width="1.3" fill="none" stroke-linejoin="round"/><circle cx="7.3" cy="13.2" r="1.3" fill="#fff"/><circle cx="11.8" cy="11.9" r="1.3" fill="#fff"/>`),
    videos: svg(`<rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="#8764b8"/><path d="M8.3 7.3v5.4l4.6-2.7Z" fill="#fff"/><path d="M2.5 6.5h15M2.5 13.5h15" stroke="#b39ddb" stroke-width="1"/>`),
    recycle: svg(`<path d="M5 5.5h10l-.9 10.6c-.1.8-.7 1.4-1.5 1.4H7.4c-.8 0-1.4-.6-1.5-1.4Z" fill="#62b7f4"/><rect x="3.5" y="3.5" width="13" height="2.5" rx="1" fill="#0f6cbd"/><path d="M8.2 9.3 10 8l1.8 1.3M10 8v4.5" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/>`),
    network: svg(`<circle cx="10" cy="10" r="7.5" fill="#16c60c"/><path d="M2.5 10h15M10 2.5c2 2.2 3 4.7 3 7.5s-1 5.3-3 7.5c-2-2.2-3-4.7-3-7.5s1-5.3 3-7.5Z" stroke="#0e7a0d" stroke-width="1.1" fill="none"/>`),
    tags: svg(`<path d="M2.5 9.6V4c0-.8.7-1.5 1.5-1.5h5.6c.4 0 .8.2 1.1.4l6.6 6.6c.6.6.6 1.5 0 2.1l-5.6 5.6c-.6.6-1.5.6-2.1 0L2.9 10.7c-.3-.3-.4-.7-.4-1.1Z" fill="#ffb900"/><circle cx="6.3" cy="6.3" r="1.3" fill="#8a5a00"/>`),
    recent: svg(`<circle cx="10" cy="10" r="7.5" fill="#0f6cbd"/><path d="M10 6v4.3l2.8 1.7" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/>`),
    media: svg(`<rect x="2.5" y="4.5" width="12" height="11" rx="2" fill="#00b7c3"/><rect x="5.5" y="2.5" width="12" height="11" rx="2" fill="#0078d4"/><circle cx="14" cy="6" r="1.3" fill="#fce100"/><path d="m5.5 11.5 3.5-3.5 3 3 1.5-1.5 4 4" stroke="#9ad6ff" stroke-width="1.3" fill="none"/>`),
    people: svg(`<circle cx="7.5" cy="7" r="3" fill="#0f6cbd"/><path d="M2 16.5c.6-2.8 2.8-4.5 5.5-4.5S12.4 13.7 13 16.5Z" fill="#0f6cbd"/><circle cx="13.5" cy="7.5" r="2.5" fill="#62b7f4"/><path d="M11 12.4c.8-.3 1.6-.4 2.5-.4 2.3 0 4.2 1.5 4.7 4H14" fill="#62b7f4"/>`),
    devices: svg(`<rect x="2.5" y="4.5" width="11" height="8" rx="1.2" fill="#6e6e6e"/><rect x="3.5" y="5.5" width="9" height="6" rx=".6" fill="#b4d6fa"/><rect x="12" y="7.5" width="5.5" height="9" rx="1.2" fill="#0f6cbd"/><rect x="13" y="8.5" width="3.5" height="6" rx=".5" fill="#62b7f4"/>`),
    settings: svg(`<path d="M8.6 2.9h2.8l.4 1.6 1.5.9 1.6-.5 1.4 2.4-1.2 1.1v1.8l1.2 1.1-1.4 2.4-1.6-.5-1.5.9-.4 1.6H8.6l-.4-1.6-1.5-.9-1.6.5-1.4-2.4 1.2-1.1V9.1L3.7 8l1.4-2.4 1.6.5 1.5-.9Z" fill="#8a8a8a"/><circle cx="10" cy="10" r="2.6" fill="#1c1c1c"/>`),
  };

  // ---- folders & drives (Windows 11 style, 48-unit grid for crisp detail at any size) ----
  const defs = `<defs>
    <linearGradient id="pfFoldBack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3b33d"/><stop offset="1" stop-color="#e39b1f"/></linearGradient>
    <linearGradient id="pfFoldFront" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd86b"/><stop offset="1" stop-color="#fbbd33"/></linearGradient>
    <linearGradient id="pfDrive" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c5cbd3"/><stop offset=".5" stop-color="#9aa3ae"/><stop offset="1" stop-color="#6e7782"/></linearGradient>
    <linearGradient id="pfDriveTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9edf1"/><stop offset="1" stop-color="#c9ced6"/></linearGradient>
    <linearGradient id="pfWin" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ccbf4"/><stop offset="1" stop-color="#0063b1"/></linearGradient>
    <linearGradient id="pfScreen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a4f9c"/><stop offset=".55" stop-color="#2d8ae0"/><stop offset="1" stop-color="#8fd3ff"/></linearGradient>
    <linearGradient id="pfGreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3ccf6e"/><stop offset="1" stop-color="#16994a"/></linearGradient>
    <linearGradient id="pfBin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fd8fb"/><stop offset="1" stop-color="#3a96dd"/></linearGradient>
    <linearGradient id="pfTag" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd15c"/><stop offset="1" stop-color="#f7a21b"/></linearGradient>
  </defs>`;
  // Gradients live once in an always-rendered (zero-size, not display:none) <svg> so icons inside
  // hidden elements can't break the url(#…) references of every other icon.
  window.PiIconDefs = {
    add(markup) {
      let host = document.getElementById("pf-icon-defs");
      if (!host) {
        if (!document.body) { document.addEventListener("DOMContentLoaded", () => this.add(markup), { once: true }); return; }
        host = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        host.id = "pf-icon-defs";
        host.setAttribute("aria-hidden", "true");
        host.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none");
        host.innerHTML = "<defs></defs>";
        document.body.prepend(host);
      }
      const tmp = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      tmp.innerHTML = markup;
      const target = host.firstElementChild;
      [...tmp.querySelectorAll("[id]")].filter(n => n.parentNode === tmp || n.parentNode.nodeName === "defs").forEach(n => {
        if (!target.querySelector("#" + CSS.escape(n.id))) target.appendChild(n);
      });
    },
  };
  PiIconDefs.add(defs.replace(/<\/?defs>/g, ""));
  const svg48 = (body, cls) => `<svg class="pi-ico ${cls}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${body}</svg>`;

  const folder = () => svg48(
    `<path d="M4 12a4 4 0 0 1 4-4h10.3a4 4 0 0 1 2.83 1.17L24 12h16a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="url(#pfFoldBack)"/>` +
    `<path d="M4 20a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v16a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="url(#pfFoldFront)"/>` +
    `<path d="M7 17.6h34" stroke="#fff3c4" stroke-width="1.2" opacity=".85"/>`, "pi-folder");

  const drive = (kind) => {
    const body =
      `<rect x="4" y="21" width="40" height="17" rx="4" fill="url(#pfDrive)"/>` +
      `<path d="M8 21h32a4 4 0 0 1 4 4v1H4v-1a4 4 0 0 1 4-4Z" fill="url(#pfDriveTop)"/>` +
      `<rect x="9" y="30.5" width="20" height="2" rx="1" fill="#5b636d" opacity=".55"/>` +
      `<circle cx="37.5" cy="31.5" r="2" fill="#3ee06f"/><circle cx="37.5" cy="31.5" r="3.4" fill="#3ee06f" opacity=".2"/>`;
    const extra = kind === "windows"
      ? `<g transform="translate(9 3)"><rect width="7.4" height="7.4" rx=".8" fill="url(#pfWin)"/><rect x="8.6" width="7.4" height="7.4" rx=".8" fill="url(#pfWin)"/><rect y="8.6" width="7.4" height="7.4" rx=".8" fill="url(#pfWin)"/><rect x="8.6" y="8.6" width="7.4" height="7.4" rx=".8" fill="url(#pfWin)"/></g>`
      : kind === "removable"
      ? `<rect x="15" y="6" width="18" height="12" rx="2.5" fill="#6e7782"/><rect x="19" y="10" width="3" height="3" rx=".6" fill="#e9edf1"/><rect x="26" y="10" width="3" height="3" rx=".6" fill="#e9edf1"/>`
      : kind === "remote"
      ? `<circle cx="24" cy="10" r="6.5" fill="url(#pfGreen)"/><path d="M17.5 10h13M24 3.5c2 1.8 3 4 3 6.5s-1 4.7-3 6.5c-2-1.8-3-4-3-6.5s1-4.7 3-6.5Z" stroke="#e7fbe9" stroke-width="1.1" fill="none"/>`
      : "";
    return svg48(body + extra, "pi-drive");
  };

  place.desktop = svg48(
    `<rect x="4" y="7" width="40" height="27" rx="3.5" fill="#3b4652"/><rect x="6.5" y="9.5" width="35" height="22" rx="1.8" fill="url(#pfScreen)"/>` +
    `<path d="M6.5 27c8-6 16-8.5 35-6v8.7a1.8 1.8 0 0 1-1.8 1.8H8.3a1.8 1.8 0 0 1-1.8-1.8Z" fill="#9ad6ff" opacity=".55"/>` +
    `<path d="M20 34h8l1.5 6h-11Z" fill="#8a949f"/><rect x="14" y="39.5" width="20" height="3" rx="1.5" fill="#a8b1bb"/>`, "pi-place");
  place.downloads = svg48(
    `<path d="M24 5a3 3 0 0 1 3 3v17.8l5.9-5.9a3 3 0 1 1 4.2 4.2l-11 11a3 3 0 0 1-4.2 0l-11-11a3 3 0 1 1 4.2-4.2l5.9 5.9V8a3 3 0 0 1 3-3Z" fill="url(#pfGreen)"/>` +
    `<rect x="7" y="38" width="34" height="5" rx="2.5" fill="#16994a"/>`, "pi-place");
  place.recycle = svg48(
    `<path d="M10 14h28l-2.3 26.2a3.5 3.5 0 0 1-3.5 3.2H15.8a3.5 3.5 0 0 1-3.5-3.2Z" fill="url(#pfBin)"/>` +
    `<rect x="7" y="8" width="34" height="7" rx="2.5" fill="#1f76c2"/><path d="M19 8V6.5A2.5 2.5 0 0 1 21.5 4h5A2.5 2.5 0 0 1 29 6.5V8" stroke="#1f76c2" stroke-width="2.4" fill="none"/>` +
    `<path d="M18 21v15M24 21v15M30 21v15" stroke="#e8f6ff" stroke-width="2.2" stroke-linecap="round" opacity=".9"/>`, "pi-place");
  place.tags = svg48(
    `<path d="M5 22.3V9a4 4 0 0 1 4-4h13.3a4 4 0 0 1 2.83 1.17l16.7 16.7a4 4 0 0 1 0 5.66L28.53 41.83a4 4 0 0 1-5.66 0L6.17 25.13A4 4 0 0 1 5 22.3Z" fill="url(#pfTag)"/>` +
    `<circle cx="14.5" cy="14.5" r="3.5" fill="#fff6d6"/>`, "pi-place");

  // ---- file types ----
  const page = (color, glyph, label) => svg(
    `<path d="M5 2h6.8L16 6.2V16.5c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5v-13C3.5 2.7 4.2 2 5 2Z" fill="var(--pi-page, #f3f3f3)"/>` +
    `<path d="M11.8 2v3.7c0 .3.2.5.5.5H16" fill="#d6d6d6"/>` +
    (glyph || "") +
    (label ? `<rect x="2" y="10" width="${4 + label.length * 3.4}" height="6.5" rx="1.2" fill="${color}"/><text x="${4 + label.length * 1.7}" y="14.9" font-size="4.6" font-weight="700" fill="#fff" text-anchor="middle" font-family="Segoe UI, sans-serif">${label}</text>` : ""),
    "pi-file");
  const types = {
    image: page("#0078d4", `<rect x="5.5" y="8" width="8.5" height="7.5" rx="1" fill="#0078d4"/><path d="m5.5 14 2.8-2.8 1.8 1.8 1.2-1.2 2.7 2.7v.3c0 .4-.3.7-.7.7H6.2c-.4 0-.7-.3-.7-.7Z" fill="#9ad6ff"/><circle cx="11.7" cy="9.9" r=".9" fill="#fce100"/>`),
    raw: page("#ca5010", `<rect x="5.2" y="8.6" width="9.2" height="6.4" rx="1.3" fill="#3a3a3a"/><circle cx="9.8" cy="11.8" r="2.1" fill="#9ad6ff" stroke="#ddd" stroke-width=".6"/><rect x="6" y="7.6" width="2.4" height="1.4" rx=".4" fill="#3a3a3a"/>`, "RAW"),
    video: page("#8764b8", `<rect x="5.5" y="8" width="8.5" height="7.5" rx="1.2" fill="#8764b8"/><path d="M8.8 10v3.5l3-1.75Z" fill="#fff"/>`),
    audio: page("#e3008c", `<circle cx="9.8" cy="11.8" r="3.8" fill="#e3008c"/><path d="M9 13.4V10l2.3-.6v3.2" stroke="#fff" stroke-width=".9" fill="none"/><circle cx="8.4" cy="13.4" r=".7" fill="#fff"/>`),
    pdf: page("#d13438", "", "PDF"),
    archive: page("#8e562e", `<path d="M9 2v12" stroke="#8e562e" stroke-width="2.2" stroke-dasharray="1.3 1.3"/><rect x="7.8" y="12" width="2.4" height="3.2" rx=".6" fill="#8e562e"/>`),
    word: page("#185abd", "", "W"),
    excel: page("#107c41", "", "X"),
    ppt: page("#c43e1c", "", "P"),
    code: page("#6e6e6e", `<path d="m8 9.5-2 2 2 2M11.5 9.5l2 2-2 2" stroke="#0078d4" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
    text: page("#6e6e6e", `<path d="M6 9h7.5M6 11.3h7.5M6 13.6h5" stroke="#9a9a9a" stroke-width="1" stroke-linecap="round"/>`),
    exe: svg(`<rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="#3a3a3a"/><rect x="2.5" y="3.5" width="15" height="3" rx="1.5" fill="#0078d4"/><path d="M6 10.5h8M6 13h5" stroke="#9a9a9a" stroke-width="1.1" stroke-linecap="round"/>`, "pi-file"),
    config: page("#6e6e6e", `<circle cx="9.8" cy="12" r="2.8" fill="none" stroke="#8a8a8a" stroke-width="1.2" stroke-dasharray="1.4 .8"/><circle cx="9.8" cy="12" r="1" fill="#8a8a8a"/>`),
    generic: page("#6e6e6e", ""),
  };
  const EXT = {
    image: "jpg jpeg png gif webp bmp heic heif svg ico tif tiff avif jxl psd",
    raw: "raw cr2 cr3 crw nef nrw arw srf sr2 dng raf orf rw2 pef srw x3f 3fr iiq erf kdc mef mos rwl",
    video: "mp4 mkv mov avi wmv webm m4v flv mpg mpeg 3gp",
    audio: "mp3 wav flac m4a ogg aac wma opus",
    pdf: "pdf",
    archive: "zip rar 7z tar gz tgz bz2 xz cab iso jar apk",
    word: "doc docx odt rtf",
    excel: "xls xlsx csv ods",
    ppt: "ppt pptx odp",
    code: "js ts jsx tsx py rs java c cpp h hpp cs go rb php html htm css scss json xml yml yaml toml sh bat ps1 sql",
    text: "txt md log",
    exe: "exe msi appx msix com",
    config: "ini cfg conf dll sys inf reg dat",
  };
  const extMap = {};
  for (const [kind, list] of Object.entries(EXT)) list.split(" ").forEach(e => (extMap[e] = kind));

  function extOf(f) {
    return String(f.ext || f.extension || (f.name || "").split(".").pop() || "").toLowerCase();
  }

  const FI = window.PiFluentIcons || { regular: {}, color: {} };
  const tag = (svgStr, cls) => svgStr.replace("<svg ", `<svg class="pi-ico ${cls}" `);
  const uiIcon = (name) => FI.regular[name] ? tag(FI.regular[name], "pi-fluent") : (ui[name] || "");
  // Places: Fluent colour icons where Microsoft ships one, hand-tuned Windows 11 style otherwise.
  const CUSTOM_PLACE = new Set(["desktop", "downloads", "recycle", "tags"]);
  const placeIcon = (name) => !CUSTOM_PLACE.has(name) && FI.color[name] ? tag(FI.color[name], "pi-fluent-color") : (place[name] || uiIcon("folderLine"));

  window.PiIcons = {
    ui: uiIcon,
    place: placeIcon,
    folder: () => folder(),
    drive: (d) => {
      const t = d.drive_type || d.type || "Fixed";
      const p = String(d.path || d.mount_point || "").toUpperCase();
      if (t === "Removable" || t === "CDRom") return drive("removable");
      if (t === "Remote") return drive("remote");
      if (p === "C:\\") return drive("windows");
      return drive("fixed");
    },
    fileKind: (f) => extMap[extOf(f)] || "generic",
    file: (f) => types[extMap[extOf(f)] || "generic"],
  };
})();
