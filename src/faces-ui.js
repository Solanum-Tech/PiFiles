// PiFacesUI - helps people teach PiFiles who is who, right in the People view:
//  • "Who's this?"  - the biggest unnamed groups ("Person 3"…) with a name box each. Typing a
//                     name that already exists merges the two; a new name just labels the group.
//  • "Quick check"  - now and then (Settings > People & media) one question at a time from the
//                     model's own uncertainty: "Is this Anna?" Yes / No (then optionally who) /
//                     Not a face / Skip. Answers train the on-device model immediately.
// Everything stays on this computer.
(function () {
  "use strict";
  const core = () => window.__TAURI__?.core;
  const invoke = (c, a) => (core() ? core().invoke(c, a) : Promise.reject(new Error("desktop app only")));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ex = () => window.__explorer;
  const pref = (k, d) => window.PiSettings?.get(k) ?? d;
  const isDefault = l => /^Person \d+$/.test(l || "");
  const KEY_DAY = "pf:faceAskDay", KEY_SKIPPED = "pf:faceNameSkipped";
  let suggestions = null, asked = 0, dismissedStrip = false;

  const skipped = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY_SKIPPED) || "[]")); } catch { return new Set(); } };
  const skip = key => { const s = skipped(); s.add(key); try { localStorage.setItem(KEY_SKIPPED, JSON.stringify([...s].slice(-500))); } catch {} };
  const avatar = g => {
    const p = (g.preview || [])[0];
    return p && String(p).startsWith("data:image/") ? `<img src="${esc(p)}" alt="">` : `<span>👤</span>`;
  };

  function namedPeople() {
    return (ex()?.state.mediaPeople || []).filter(g => g.face_count != null && !isDefault(g.label));
  }

  // Same flow as renaming from a person card: update the in-memory list right away (a reload
  // from the backend could still return the old "Person N" name until regrouping finishes).
  async function nameGroup(g, name) {
    name = name.trim();
    if (!name) return;
    const st = ex()?.state;
    const same = namedPeople().find(p => p.label.toLowerCase() === name.toLowerCase() && p.key !== g.key);
    if (same) {
      const merged = await invoke("merge_persons", { personKeys: [same.key, g.key], label: same.label });
      if (st) {
        st.mediaPeople = (st.mediaPeople || []).filter(x => x.key !== g.key && x.key !== same.key);
        if (merged && merged.key) { st.mediaPeople.unshift(merged); st.mediaPeople.sort((a, b) => (b.count || 0) - (a.count || 0)); }
      }
      window.toast?.(`Added to ${same.label}`);
    } else {
      const saved = await invoke("rename_person", { personKey: g.key, label: name });
      const cur = st?.mediaPeople?.find(x => x.key === g.key);
      if (cur) cur.label = saved || name;
      window.toast?.(`Named ${saved || name}`);
    }
    ex()?.renderPeople?.();
  }

  function whoStrip() {
    if (dismissedStrip) return "";
    const sk = skipped();
    const groups = (ex()?.state.mediaPeople || [])
      .filter(g => g.face_count != null && isDefault(g.label) && !sk.has(g.key))
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 6);
    if (!groups.length) return "";
    const names = namedPeople().map(p => `<option value="${esc(p.label)}"></option>`).join("");
    return `<section class="fa-card fa-who">
      <header><b>Who's this?</b><span>Name the people PiFiles found. A name you've used before joins the two groups.</span>
        <button class="fa-x" data-fa="hide-strip" title="Hide for now">✕</button></header>
      <datalist id="faNames">${names}</datalist>
      <div class="fa-who-row">${groups.map(g => `
        <div class="fa-who-item" data-key="${esc(g.key)}">
          <div class="fa-ava">${avatar(g)}</div>
          <small>${g.count || 0} photos</small>
          <input type="text" list="faNames" maxlength="48" placeholder="Add a name" data-fa-name="${esc(g.key)}" spellcheck="false">
          <div class="fa-who-acts"><button class="pf-btn small primary" data-fa="save" data-key="${esc(g.key)}">Save</button><button class="pf-btn small" data-fa="skip" data-key="${esc(g.key)}" title="Don't ask about this group again">Skip</button></div>
        </div>`).join("")}
      </div>
    </section>`;
  }

  function wantQuestion() {
    const mode = pref("faceQuestions", "occasional");
    if (mode === "never" || !suggestions?.length || asked >= 3) return null;
    const today = new Date().toDateString();
    let day = ""; try { day = localStorage.getItem(KEY_DAY) || ""; } catch {}
    if (mode === "occasional" && day === today && asked === 0) return null; // at most one round a day
    return suggestions.find(s => s.question_type === "confirm_person" && s.suggested_label && !isDefault(s.suggested_label))
      || suggestions.find(s => s.question_type === "verify_face")
      || null;
  }

  function questionCard(s) {
    if (!s) return "";
    const q = s.question_type === "verify_face"
      ? `Is this a face?`
      : `Is this <b>${esc(s.suggested_label)}</b>?`;
    return `<section class="fa-card fa-quick" data-sug="${esc(s.id)}">
      <div class="fa-ava big">${s.face_thumb ? `<img src="${esc(s.face_thumb)}" alt="">` : "👤"}</div>
      <div class="fa-q">
        <small>Quick check ${asked + 1} of ${Math.min(3, asked + (suggestions?.length || 1))} · helps PiFiles group faces better</small>
        <div class="fa-q-text">${q}</div>
        <div class="fa-q-acts">
          ${s.question_type === "verify_face"
            ? `<button class="pf-btn small primary" data-fa="q-face-yes">Yes, a face</button><button class="pf-btn small" data-fa="q-notface">Not a face</button>`
            : `<button class="pf-btn small primary" data-fa="q-yes">Yes</button><button class="pf-btn small" data-fa="q-no">No</button><button class="pf-btn small" data-fa="q-notface">Not a face</button>`}
          <button class="pf-btn small ghost" data-fa="q-skip">Skip</button>
        </div>
        <div class="fa-q-who hidden"><input type="text" list="faNames" maxlength="48" placeholder="Who is it? (optional)" data-fa-who><button class="pf-btn small primary" data-fa="q-who-save">Save</button><button class="pf-btn small" data-fa="q-skip">Don't know</button></div>
      </div>
      <button class="fa-x" data-fa="q-off" title="Stop asking (change in Settings › People & media)">✕</button>
    </section>`;
  }

  async function answer(s, action, key, label) {
    asked++;
    // Visible confirmation first: the next question may be about the same person, so without
    // it the card would look unchanged.
    const card = document.querySelector(`#peopleAssist .fa-quick[data-sug="${CSS.escape(s.id)}"]`);
    if (card) { card.classList.add("answered"); card.querySelector(".fa-q-text").innerHTML = action ? "✓ Thanks, PiFiles learned from that" : "Skipped"; }
    await new Promise(r => setTimeout(r, 650));
    try { localStorage.setItem(KEY_DAY, new Date().toDateString()); } catch {}
    suggestions = suggestions.filter(x => x.id !== s.id);
    if (action) {
      try {
        await invoke("submit_face_feedback", { payload: {
          action, suggestion_id: s.id, photo_path: s.photo_path,
          target_person_key: key ?? s.suggested_person_key ?? null, target_label: label ?? s.suggested_label ?? null,
          hash: s.hash || 0, embedding: s.embedding || [], thumb_url: s.face_thumb || "" } });
      } catch (e) { window.toast?.(String(e?.message || e)); }
    }
    render();
  }

  function render() {
    const host = document.getElementById("peopleAssist");
    if (!host) return;
    const q = wantQuestion();
    host.innerHTML = questionCard(q) + whoStrip();
    host.hidden = !host.innerHTML.trim();
  }

  async function refresh() {
    if (suggestions === null && core()) {
      try { suggestions = await invoke("get_face_learning_suggestions"); } catch { suggestions = []; }
    }
    render();
  }

  document.addEventListener("click", async e => {
    const b = e.target.closest?.("[data-fa]"); if (!b || !b.closest("#peopleAssist")) return;
    const act = b.dataset.fa;
    const card = b.closest(".fa-quick");
    const s = card && suggestions?.find(x => x.id === card.dataset.sug);
    const people = ex()?.state.mediaPeople || [];
    try {
      if (act === "hide-strip") { dismissedStrip = true; render(); }
      else if (act === "save") { const inp = document.querySelector(`[data-fa-name="${CSS.escape(b.dataset.key)}"]`); const g = people.find(x => x.key === b.dataset.key); if (g && inp?.value.trim()) { b.disabled = true; await nameGroup(g, inp.value); } else inp?.focus(); }
      else if (act === "skip") { skip(b.dataset.key); render(); }
      else if (!s) return;
      else if (act === "q-yes") await answer(s, "confirm");
      else if (act === "q-face-yes") await answer(s, null);
      else if (act === "q-notface") await answer(s, "not_a_face");
      else if (act === "q-skip") await answer(s, null);
      else if (act === "q-no") { card.querySelector(".fa-q-acts").classList.add("hidden"); card.querySelector(".fa-q-who").classList.remove("hidden"); card.querySelector("[data-fa-who]").focus(); }
      else if (act === "q-who-save") {
        const name = card.querySelector("[data-fa-who]").value.trim();
        if (!name) return answer(s, null);
        const existing = namedPeople().find(p => p.label.toLowerCase() === name.toLowerCase());
        await answer(s, "reassign", existing?.key ?? null, existing?.label ?? name);
      }
      else if (act === "q-off") { window.PiSettings?.set("faceQuestions", "never"); render(); window.toast?.("PiFiles won't ask again. Turn it back on in Settings › People & media"); }
    } catch (err) { window.toast?.(String(err?.message || err)); b.disabled = false; }
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const n = e.target.closest?.("#peopleAssist [data-fa-name]");
    if (n) { e.preventDefault(); document.querySelector(`#peopleAssist [data-fa="save"][data-key="${CSS.escape(n.dataset.faName)}"]`)?.click(); }
    const w = e.target.closest?.("#peopleAssist [data-fa-who]");
    if (w) { e.preventDefault(); w.closest(".fa-quick").querySelector('[data-fa="q-who-save"]').click(); }
  });
  window.addEventListener("pifiles:people-rendered", refresh);
  window.PiFacesUI = { refresh, reset: () => { suggestions = null; refresh(); } };
})();
