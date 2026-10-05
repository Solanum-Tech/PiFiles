// Boot for the separate Properties window (properties.html).
(async () => {
  const core = window.__TAURI__?.core;
  const close = () => (core ? core.invoke("close_window") : window.close());
  document.getElementById("ppClose").onclick = close;
  document.getElementById("ppOk").onclick = close;
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  const params = new URLSearchParams(location.search);
  const paths = core ? await core.invoke("properties_window_paths") : params.getAll("p");
  document.getElementById("ppTitle").textContent = document.title =
    paths.length === 1 ? `${paths[0].replace(/[\\/]+$/, "").split(/[\\/]/).pop() || paths[0]} Properties` : `${paths.length} items Properties`;
  await PiProps.renderWindow(document.getElementById("ppRoot"), paths);
})();
