/* CornCal front-end: load data, drive the person picker + FullCalendar. */
(function () {
  "use strict";
  const E = window.CornCalEngine;

  const els = {
    personInput: document.getElementById("person-input"),
    personClear: document.getElementById("person-clear"),
    personList: document.getElementById("person-list"),
    personCombo: document.getElementById("person-combo"),
    scheduleEmpty: document.getElementById("schedule-empty"),
    calHint: document.getElementById("cal-hint"),
    glossary: document.getElementById("glossary"),
    glossaryBody: document.getElementById("glossary-body"),
    legend: document.getElementById("legend"),
    legendWeekend: document.getElementById("legend-weekend"),
    disclaimer: document.getElementById("disclaimer"),
    gcalBtn: document.getElementById("gcal-btn"),
    icsBtn: document.getElementById("ics-btn"),
    icsHint: document.getElementById("ics-hint"),
    summary: document.getElementById("summary"),
    calendar: document.getElementById("calendar"),
    dayDetail: document.getElementById("day-detail"),
    dayModal: document.getElementById("day-modal"),
    dayClose: document.getElementById("day-close"),
    tabs: document.getElementById("tabs"),
    tgSearch: document.getElementById("together-search"),
    tgPicker: document.getElementById("together-picker"),
    tgClear: document.getElementById("together-clear"),
    tgSelected: document.getElementById("together-selected"),
    tgResults: document.getElementById("together-results"),
    aroundDate: document.getElementById("around-date"),
    aroundTonight: document.getElementById("around-tonight"),
    aroundResults: document.getElementById("around-results"),
    offDate: document.getElementById("off-date"),
    offToday: document.getElementById("off-today"),
    offResults: document.getElementById("off-results"),
    bestInput: document.getElementById("best-input"),
    bestClear: document.getElementById("best-clear"),
    bestList: document.getElementById("best-list"),
    bestCombo: document.getElementById("best-combo"),
    bestResults: document.getElementById("best-results"),
  };
  const selectedInits = new Set();

  let data = null;
  let ctx = null;
  let calendar = null;
  let currentInit = null;  // the person whose schedule is shown
  let eventsByPerson = {}; // init -> FullCalendar events
  let weekendTier = {};    // ISO date (Sat or Sun) -> "gold" | "silver" | "black"
  let dayPicked = null;    // DOM node currently highlighted as the selected day
  let bestInit = null;     // person selected in the Besties tab
  let aroundDate = null;   // date shown in the "Who's around" hub (ISO)

  async function loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`failed to load ${path}: ${r.status}`);
    return r.json();
  }

  function toEvents(days) {
    return days.map((d) => ({
      start: d.date,
      allDay: true,
      title: d.duty,
      classNames: ["ev-" + d.cls],
      extendedProps: { rotation: d.rotation, hours: d.hours, duty: d.duty, cls: d.cls },
    }));
  }

  // Tier each weekend (Sat + Sun) by how many of the two days are OFF:
  //   2 off -> gold, 1 off -> silver, 0 off -> black.
  function buildWeekendTiers(days) {
    weekendTier = {};
    const offByWeekend = {}; // saturdayISO -> count of OFF days that weekend
    for (const d of days) {
      const dt = E.parseISO(d.date);
      const dow = dt.getDay(); // 0 Sun ... 6 Sat
      if (dow !== 6 && dow !== 0) continue;
      const satISO = dow === 6 ? d.date : E.fmtISO(E.addDays(dt, -1));
      if (!(satISO in offByWeekend)) offByWeekend[satISO] = 0;
      if (d.cls === "off") offByWeekend[satISO] += 1;
    }
    for (const satISO in offByWeekend) {
      const off = offByWeekend[satISO];
      const tier = off >= 2 ? "gold" : off === 1 ? "silver" : "black";
      const sunISO = E.fmtISO(E.addDays(E.parseISO(satISO), 1));
      weekendTier[satISO] = tier;
      weekendTier[sunISO] = tier;
    }
  }

  function weekendClassNames(arg) {
    const tier = weekendTier[E.fmtISO(arg.date)];
    if (!tier) return [];
    const dow = arg.date.getDay();
    return ["wk-box", "wk-" + tier, dow === 6 ? "wk-sat" : "wk-sun"];
  }

  function renderSummary(person) {
    if (!person) {
      els.summary.innerHTML = "";
      return;
    }
    const days = eventsByPerson[person.init] || [];
    const counts = { admit: 0, night: 0, off: 0, clinic: 0, away: 0 };
    for (const e of days) {
      const c = e.classNames[0];
      if (c === "ev-admit") counts.admit++;
      else if (c === "ev-night") counts.night++;
      else if (c === "ev-off") counts.off++;
      else if (c === "ev-clinic") counts.clinic++;
      else if (c === "ev-away") counts.away++;
    }
    const card = (k, v) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    els.summary.innerHTML =
      card("Name", fullName(person.name)) +
      card("Track", person.track) +
      card("Admit / long-call days", counts.admit) +
      card("Night days", counts.night) +
      card("Off / vacation days", counts.off) +
      card("Clinic days", counts.clinic);
  }

  function selectPerson(init) {
    const person = data.assignments.find((p) => p.init === init);
    currentInit = person ? person.init : null;
    const days = person ? E.resolveYear(person, ctx) : [];
    const events = toEvents(days);
    buildWeekendTiers(days);
    if (person) eventsByPerson[person.init] = events;

    if (calendar) {
      calendar.getEventSources().forEach((s) => s.remove());
      if (events.length) calendar.addEventSource(events);
      // A fresh function reference forces FullCalendar to re-run the day-cell
      // class hook, re-coloring the weekend boxes for the newly selected person.
      calendar.setOption("dayCellClassNames", (a) => weekendClassNames(a));
    }
    dayPicked = null;
    clearDayDetail(); // stale once the person changes
    renderSummary(person);
    if (person) renderGlossary(days);
    setScheduleEmpty(!person);
    if (els.gcalBtn) els.gcalBtn.hidden = !person;
    if (els.icsBtn) els.icsBtn.hidden = !person;
    if (els.icsHint) els.icsHint.hidden = !person;
    if (els.personClear) els.personClear.hidden = !person;
    if (person && els.personInput && document.activeElement !== els.personInput)
      els.personInput.value = fullName(person.name);

    const url = new URL(window.location);
    if (init) url.searchParams.set("p", init);
    else url.searchParams.delete("p");
    history.replaceState(null, "", url);
  }

  // Empty-state: before a name is picked, show the prompt and hide the calendar,
  // legend, weekend key and disclaimer (nothing to explain yet).
  function setScheduleEmpty(empty) {
    const hide = (el, h) => { if (el) el.hidden = h; };
    hide(els.scheduleEmpty, !empty);
    hide(els.calendar, empty);
    hide(els.calHint, empty);
    hide(els.summary, empty);
    hide(els.glossary, empty);
    hide(els.legend, empty);
    hide(els.legendWeekend, empty);
    hide(els.disclaimer, empty);
    if (!empty && calendar) calendar.updateSize();
  }

  // Per-person glossary: every distinct duty code in their year with its hours,
  // so the insider shorthand (B2, GM B~, CCT…) is at least pinned to real times.
  function renderGlossary(days) {
    if (!els.glossaryBody) return;
    const seen = new Map(); // duty -> { cls, hours, rotations:Set }
    for (const d of days) {
      const key = d.duty;
      if (!seen.has(key)) seen.set(key, { cls: d.cls, hours: d.hours, rotations: new Set() });
      if (d.rotation && d.rotation !== d.duty) seen.get(key).rotations.add(d.rotation);
    }
    // order roughly by kind so related codes sit together
    const order = ["admit", "work", "night", "consult", "clinic", "post", "away", "off"];
    const rows = [...seen.entries()].sort(
      (a, b) => (order.indexOf(a[1].cls) - order.indexOf(b[1].cls)) || a[0].localeCompare(b[0])
    );
    els.glossaryBody.innerHTML = rows
      .map(([duty, v]) => {
        const rots = [...v.rotations].slice(0, 2).join(", ");
        let desc;
        if (v.hours && rots) desc = `<b>${v.hours}</b> · ${rots}`;
        else if (v.hours) desc = `<b>${v.hours}</b>`;
        else if (rots) desc = rots;
        else desc = "&mdash;";
        return `<div class="gl-row"><span class="gl-chip d-${v.cls}">${duty}</span>` +
          `<span class="gl-desc">${desc}</span></div>`;
      })
      .join("");
  }

  // ---------------------- Searchable name picker (combobox) ----------------------
  const peopleSorted = () =>
    [...data.assignments].sort((a, b) => fullName(a.name).localeCompare(fullName(b.name)));

  // Reusable typeahead. `onChoose(init)` gets "" when cleared. Returns a small
  // handle so callers can set the displayed value programmatically (deep-links).
  function makeCombo({ input, clear, list, container, onChoose }) {
    let matches = [];
    let active = -1;
    function render(q) {
      q = (q || "").trim().toLowerCase();
      matches = peopleSorted().filter(
        (p) => !q || (fullName(p.name) + " " + p.name + " " + p.init).toLowerCase().includes(q)
      );
      active = -1;
      list.innerHTML = matches.length
        ? matches
            .map(
              (p, i) =>
                `<li class="combo-opt" role="option" data-init="${p.init}" data-i="${i}">` +
                `<span class="combo-name">${fullName(p.name)}</span>` +
                `<span class="combo-track">${p.track}</span></li>`
            )
            .join("")
        : `<li class="combo-empty">No match</li>`;
    }
    const open = () => { render(input.value); list.hidden = false; input.setAttribute("aria-expanded", "true"); };
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
    function setActive(i) {
      const opts = list.querySelectorAll(".combo-opt");
      if (!opts.length) return;
      active = (i + opts.length) % opts.length;
      opts.forEach((o, k) => o.classList.toggle("is-active", k === active));
      opts[active].scrollIntoView({ block: "nearest" });
    }
    function choose(init) { close(); input.blur(); onChoose(init); }

    input.addEventListener("focus", open);
    input.addEventListener("input", () => { open(); if (clear) clear.hidden = !input.value; });
    input.addEventListener("keydown", (e) => {
      const isOpen = !list.hidden;
      if (e.key === "ArrowDown") { e.preventDefault(); if (!isOpen) open(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") {
        const pick = active >= 0 ? matches[active] : matches[0];
        if (pick) { e.preventDefault(); choose(pick.init); }
      } else if (e.key === "Escape") { close(); }
    });
    list.addEventListener("mousedown", (e) => {
      // mousedown (not click) so it fires before the input's blur closes the list
      const li = e.target.closest(".combo-opt");
      if (li) { e.preventDefault(); choose(li.dataset.init); }
    });
    if (clear) clear.addEventListener("click", () => {
      input.value = ""; clear.hidden = true; onChoose(""); input.focus();
    });
    document.addEventListener("click", (e) => { if (container && !container.contains(e.target)) close(); });

    return { setValue(v) { input.value = v || ""; if (clear) clear.hidden = !v; } };
  }

  function initCalendar() {
    const narrow = window.matchMedia("(max-width: 640px)").matches;
    // Open on the current month (clamped into the academic year) rather than
    // the year start, so a mid-year visitor lands on "now", not last June.
    const ys = ctx.weekResolver.yearStart, ye = ctx.weekResolver.yearEnd;
    const now = new Date();
    const initialDate = now < ys ? ys : now >= ye ? E.addDays(ye, -1) : now;
    calendar = new FullCalendar.Calendar(els.calendar, {
      // list (agenda) reads far better than a cramped month grid on phones
      initialView: narrow ? "listMonth" : "dayGridMonth",
      initialDate: initialDate,
      validRange: {
        start: E.fmtISO(ctx.weekResolver.yearStart),
        end: E.fmtISO(ctx.weekResolver.yearEnd),
      },
      firstDay: 1, // Monday
      height: "auto",
      headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,listMonth" },
      buttonText: { today: "Today", month: "Month", list: "List" },
      views: { listMonth: { listDayFormat: { weekday: "long", month: "short", day: "numeric" }, listDaySideFormat: false } },
      displayEventTime: false,
      dayMaxEvents: false,
      dayCellClassNames: (arg) => weekendClassNames(arg),
      // click a day (month grid) or an event (either view) -> who's on my rotation
      dateClick: (info) => showDayDetail(info.dateStr, info.dayEl),
      eventClick: (info) => showDayDetail(info.event.startStr, info.el),
      eventContent: (arg) => {
        const { rotation, hours, duty, cls } = arg.event.extendedProps;
        // On daytime working assignments, lead with the rotation (e.g. "MICU
        // Int 3") and put the shift code (e.g. "B1") underneath. Nights, OFF
        // and post-call keep the duty as the headline.
        const daytime = ["work", "admit", "clinic", "consult"].includes(cls);
        const swap = daytime && rotation && rotation !== duty;
        const head = swap ? rotation : duty;
        const sub = swap ? duty : rotation;
        const wrap = document.createElement("div");
        wrap.innerHTML =
          `<div class="ev-duty">${head}</div>` +
          `<div class="ev-rot">${sub}</div>` +
          (hours ? `<div class="ev-hrs">${hours}</div>` : "");
        return { domNodes: [wrap] };
      },
    });
    calendar.render();
  }

  // ------------------ Day detail: who's on my rotation ------------------
  const fmtDayLong = (iso) =>
    E.parseISO(iso).toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric",
    });

  // Highlight the WHOLE day — clicking the empty cell or the assignment tile
  // both select the same one clean box. In month view that's the day cell; in
  // list view (no day cells) it's the event row.
  function highlightDay(iso, fallbackEl) {
    if (dayPicked) dayPicked.classList.remove("dd-picked");
    const cell = els.calendar.querySelector(`.fc-daygrid-day[data-date="${iso}"]`);
    dayPicked = cell || fallbackEl || null;
    if (dayPicked) dayPicked.classList.add("dd-picked");
  }

  function closeDayDetail() {
    if (dayPicked) { dayPicked.classList.remove("dd-picked"); dayPicked = null; }
    if (els.dayModal) els.dayModal.hidden = true;
    document.body.classList.remove("dd-open");
  }
  const clearDayDetail = closeDayDetail; // alias used when the person changes

  function openDayModal() {
    if (!els.dayModal) return;
    els.dayModal.hidden = false;
    document.body.classList.add("dd-open");
  }

  function showDayDetail(iso, el) {
    if (!els.dayDetail) return;
    highlightDay(iso, el);
    if (!currentInit) {
      els.dayDetail.innerHTML =
        `<p class="dd-empty">Pick your name above, then tap any day to see who else is on your rotation that day.</p>`;
      openDayModal();
      return;
    }
    const r = E.rotationPeersOn(data.assignments, ctx, iso, currentInit);
    const head = `<div class="dd-head"><span class="dd-date">${fmtDayLong(iso)}</span>` +
      (r.self
        ? `<span class="dd-self"><span class="dd-chip d-${r.self.cls}">${r.self.duty}</span>` +
          `<span class="dd-selfrot">${r.self.role}${r.self.hours ? " · " + r.self.hours : ""}</span></span>`
        : "") +
      `</div>`;

    let body;
    if (!r.self) {
      body = `<p class="dd-empty">You're not on the medicine schedule this day.</p>`;
    } else if (!r.service) {
      body = `<p class="dd-empty">${r.self.duty === "OFF" || r.self.cls === "off"
        ? "You're off this day"
        : "You're on " + r.self.rotation} — not a shared team rotation, so there's no co-rotation list.</p>`;
    } else if (!r.peers.length) {
      body = `<p class="dd-empty">No one else is on <b>${r.service}</b> today (everyone else on the rotation is off).</p>`;
    } else {
      const rows = r.peers
        .map((p) =>
          `<div class="dd-peer"><span class="dd-name">${fullName(p.name)}</span>` +
          `<span class="dd-role">${p.role}</span>` +
          `<span class="dd-chip d-${p.cls}" title="${p.hours || ""}">${p.duty}${p.hours ? " · " + p.hours : ""}</span></div>`
        )
        .join("");
      body =
        `<div class="dd-sub"><b>${r.peers.length}</b> other ${r.peers.length === 1 ? "intern" : "interns"} on <b>${r.service}</b> today` +
        ` <span class="dd-note">· off-that-day excluded</span></div>` + rows;
    }
    els.dayDetail.innerHTML = head + body;
    openDayModal();
  }

  // ---------------- Calendar export: Google subscribe + .ics download --------
  // Public per-intern feeds live under cal/<init>.ics on the same origin.
  function icsFeedUrl(init) {
    return new URL("cal/" + encodeURIComponent(init) + ".ics", window.location.href).href;
  }
  // Google Calendar subscribes to an external feed via ?cid=<webcal URL>.
  function addToGoogle() {
    if (!currentInit) return;
    const webcal = icsFeedUrl(currentInit).replace(/^https?:/, "webcal:");
    const url = "https://calendar.google.com/calendar/render?cid=" + encodeURIComponent(webcal);
    window.open(url, "_blank", "noopener");
  }

  function downloadICS() {
    const person = data.assignments.find((p) => p.init === currentInit);
    if (!person) return;
    const days = E.resolveYear(person, ctx);
    const ics = E.toICS(person.name, person.init, days);
    const fname = "CornCal-" + fullName(person.name).replace(/[^A-Za-z0-9]+/g, "") + ".ics";
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------- Tabs ----------------------------
  function switchTab(name) {
    for (const b of els.tabs.querySelectorAll(".tab-btn"))
      b.classList.toggle("active", b.dataset.tab === name);
    document.getElementById("tab-schedule").hidden = name !== "schedule";
    document.getElementById("tab-together").hidden = name !== "together";
    document.getElementById("tab-off").hidden = name !== "off";
    document.getElementById("tab-besties").hidden = name !== "besties";
    // FullCalendar mis-sizes if it was laid out while hidden — fix on return.
    if (name === "schedule" && calendar) calendar.updateSize();
  }

  // ---------------------- "Besties" ----------------------
  function selectBesties(init) {
    const person = data.assignments.find((p) => p.init === init);
    bestInit = person ? person.init : null;
    if (person && els.bestInput && document.activeElement !== els.bestInput)
      els.bestInput.value = fullName(person.name);
    renderBesties(person);
  }

  function renderBesties(person) {
    if (!els.bestResults) return;
    if (!person) {
      els.bestResults.innerHTML =
        `<div class="empty-state"><div class="empty-emoji" aria-hidden="true">🤝</div>` +
        `<div class="empty-title">Find someone’s besties</div>` +
        `<div class="empty-sub">Search a name above to rank who they share the most rotation weeks with over the year.</div></div>`;
      return;
    }
    const list = E.besties(data.assignments, ctx, person.init);
    if (!list.length) {
      els.bestResults.innerHTML =
        `<p class="tg-none">${fullName(person.name)} never shares a team rotation with anyone this year.</p>`;
      return;
    }
    const head =
      `<div class="bs-head"><b>${fullName(person.name)}</b>’s besties` +
      `<span class="bs-sub">most weeks on the same rotation · whole year</span></div>`;
    const maxW = list[0].weeks;
    const rows = list
      .map((b, i) => {
        const chips = b.services
          .map((s) => `<span class="bs-chip tg-${svcClass(s.service)}">${s.service} · ${s.weeks}w</span>`)
          .join("");
        const bar = Math.max(6, Math.round((b.weeks / maxW) * 100));
        return `<div class="bs-row"><span class="bs-rank">${i + 1}</span>` +
          `<div class="bs-main"><div class="bs-name">${fullName(b.name)} <span class="bs-track">${b.track}</span></div>` +
          `<div class="bs-chips">${chips}</div></div>` +
          `<div class="bs-weeks"><span class="bs-bar" style="width:${bar}%"></span>` +
          `<span class="bs-wk"><b>${b.weeks}</b> wk</span></div></div>`;
      })
      .join("");
    els.bestResults.innerHTML = head + rows;
  }
  // map a shared-service name to a duty color class for the chip
  function svcClass(service) {
    if (/MICU/i.test(service)) return "consult";
    if (/Nightfloat/i.test(service)) return "night";
    if (/CIMA/i.test(service)) return "clinic";
    if (/Geriatrics|Gold|Platinum|Lymphoma/i.test(service)) return "away";
    return "work"; // Med teams, Renal, 4N …
  }

  // ---------------------- "Who's free together" ----------------------
  const firstName = (p) => p.name.split(",")[0];

  function populateTogether() {
    const groups = {};
    for (const p of data.assignments) (groups[p.track] ||= []).push(p);
    const frag = document.createDocumentFragment();
    for (const track of Object.keys(groups)) {
      const g = document.createElement("div");
      g.className = "tg-group";
      const h = document.createElement("div");
      h.className = "tg-group-h";
      h.textContent = track;
      g.appendChild(h);
      groups[track]
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((p) => {
          const lab = document.createElement("label");
          lab.className = "tg-item";
          lab.dataset.name = (p.name + " " + p.init).toLowerCase();
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = p.init;
          cb.addEventListener("change", () => {
            if (cb.checked) selectedInits.add(p.init);
            else selectedInits.delete(p.init);
            runTogether();
          });
          lab.appendChild(cb);
          const s = document.createElement("span");
          s.textContent = p.name;
          lab.appendChild(s);
          g.appendChild(lab);
        });
      frag.appendChild(g);
    }
    els.tgPicker.appendChild(frag);
  }

  function filterTogether(q) {
    q = (q || "").trim().toLowerCase();
    for (const lab of els.tgPicker.querySelectorAll(".tg-item"))
      lab.hidden = q && !lab.dataset.name.includes(q);
    for (const g of els.tgPicker.querySelectorAll(".tg-group")) {
      const any = [...g.querySelectorAll(".tg-item")].some((l) => !l.hidden);
      g.style.display = any ? "" : "none";
    }
  }

  const fmtDate = (iso) =>
    E.parseISO(iso).toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric",
    });
  const fmtRange = (r) => (r.days > 1 ? fmtDate(r.start) + " – " + fmtDate(r.end) : fmtDate(r.start));
  function fmtTime(min) {
    const h = Math.floor(min / 60), m = min % 60;
    const ap = h >= 12 ? "p" : "a";
    let hh = h % 12; if (hh === 0) hh = 12;
    return hh + (m ? ":" + String(m).padStart(2, "0") : "") + ap;
  }
  const freeFromLabel = (min) => (min === 0 ? "off all day" : "free " + fmtTime(min) + " – morning");

  function section(title, sub, body, open) {
    return `<details class="tg-section"${open ? " open" : ""}><summary>${title}${
      sub ? ` <span class="tg-sub">${sub}</span>` : ""
    }</summary>${body}</details>`;
  }

  function renderTogether(g, people) {
    const firsts = people.map(firstName);

    const evenings = g.freeEvenings.length
      ? g.freeEvenings
          .map((e) => {
            const chips = e.statuses
              .map(
                (s, i) =>
                  `<span class="tg-chip tg-${s.cls}">${firsts[i]}: ${s.duty}${
                    s.hours ? " · " + s.hours : ""
                  }</span>`
              )
              .join("");
            return `<div class="tg-row"><b>${fmtDate(e.date)}</b><span class="tg-freefrom">${freeFromLabel(e.freeFrom)}</span><div class="tg-chipwrap">${chips}</div></div>`;
          })
          .join("")
      : `<p class="tg-none">No evening in the next month where everyone is off nights.</p>`;

    const ranges = E.groupRanges(g.fullDaysOff);
    const off = ranges.length
      ? `<div class="tg-chipwrap">${ranges
          .map((r) => `<span class="tg-chip tg-off">${fmtRange(r)}</span>`)
          .join("")}</div>`
      : `<p class="tg-none">No full day this year where everyone is completely off.</p>`;

    const rot = g.sharedRotations.length
      ? g.sharedRotations
          .map(
            (s) =>
              `<div class="tg-row"><b>${fmtDate(s.start)} – ${fmtDate(s.end)}</b>` +
              `<span class="tg-svc">${s.service}</span>` +
              `<span class="tg-roles">${s.roles
                .map((r, i) => firsts[i] + ": " + r)
                .join(" · ")}</span></div>`
          )
          .join("")
      : `<p class="tg-none">Never on the same rotation (electives excluded).</p>`;

    els.tgResults.innerHTML =
      section("Full days off together", `rest of the year · ${g.fullDaysOff.length} day(s)`, off, true) +
      section("On the same rotation", "whole year · electives excluded (CIMA included)", rot, true) +
      section("Free evenings", "next month · when the group is off call", evenings, false);
  }

  function runTogether() {
    const people = [...selectedInits]
      .map((i) => data.assignments.find((p) => p.init === i))
      .filter(Boolean);
    els.tgSelected.innerHTML = people.length
      ? `<b>${people.length} picked:</b> ${people.map(firstName).join(", ")}`
      : "";
    renderAround();
    // longer-range group planning only makes sense for 2+ people
    if (people.length >= 2) {
      renderTogether(E.analyzeGroup(people, ctx, new Date()), people);
    } else {
      els.tgResults.innerHTML =
        people.length === 1
          ? `<p class="tg-empty">Add one more person to see shared days off and overlapping rotations.</p>`
          : "";
    }
  }

  // "Who's around" — everyone free that evening (all, or just the picked crew).
  function renderAround() {
    if (!els.aroundResults) return;
    const inits = selectedInits.size ? [...selectedInits] : null;
    const r = E.whoIsAround(data.assignments, ctx, aroundDate, inits);
    if (!r.inYear) {
      els.aroundResults.innerHTML = `<p class="tg-none">Pick a date within the 2026–2027 year.</p>`;
      return;
    }
    const head =
      `<div class="around-head"><b>${r.around.length}</b> around ${inits ? "of your crew " : ""}` +
      `on ${fmtDateFull(aroundDate)}</div>`;
    let body;
    if (!r.around.length) {
      body = `<p class="tg-none">No one ${inits ? "in your crew " : ""}is off-call that evening.</p>`;
    } else {
      body = `<div class="ar-list">` + r.around
        .map((a) => {
          const when = a.freeFrom === 0 ? "off all day" : "free " + fmtTime(a.freeFrom);
          const whenCls = a.freeFrom === 0 ? "ar-allday" : "";
          const ctxLbl = a.duty + (a.hours ? " · " + a.hours : "");
          return `<div class="ar-row"><span class="ar-name">${fullName(a.name)}</span>` +
            `<span class="ar-when ${whenCls}">${when}</span>` +
            `<span class="ar-duty tg-${a.cls}" title="${ctxLbl}">${a.duty}</span></div>`;
        })
        .join("") + `</div>`;
    }
    let busy = "";
    if (r.busy.length) {
      const chips = r.busy
        .map((b) => `<span class="ar-busychip">${fullName(b.name)} · ${b.duty}</span>`)
        .join("");
      busy = `<details class="ar-busy"><summary>${r.busy.length} working / on nights</summary>` +
        `<div class="ar-busywrap">${chips}</div></details>`;
    }
    els.aroundResults.innerHTML = head + body + busy;
  }

  function initAround() {
    const ys = E.fmtISO(ctx.weekResolver.yearStart);
    const ye = E.fmtISO(E.addDays(ctx.weekResolver.yearEnd, -1));
    const clamp = () => {
      let t = E.fmtISO(new Date());
      if (t < ys) t = ys; if (t > ye) t = ye;
      return t;
    };
    els.aroundDate.min = ys;
    els.aroundDate.max = ye;
    aroundDate = clamp();
    els.aroundDate.value = aroundDate;
    els.aroundDate.addEventListener("change", () => {
      if (els.aroundDate.value) { aroundDate = els.aroundDate.value; renderAround(); }
    });
    els.aroundTonight.addEventListener("click", () => {
      aroundDate = clamp();
      els.aroundDate.value = aroundDate;
      renderAround();
    });
  }

  // ---------------------- "Who's off on…" ----------------------
  const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const fmtDateFull = (iso) =>
    E.parseISO(iso).toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    });
  // person "Last, First" -> "First Last"
  const fullName = (name) => {
    const c = name.indexOf(",");
    return c === -1 ? name : name.slice(c + 1).trim() + " " + name.slice(0, c);
  };

  function renderOff(iso) {
    const r = E.offOnDate(data.assignments, ctx, iso);
    if (!r.people.length) {
      els.offResults.innerHTML = `<p class="tg-none">No one is fully off on ${fmtDateFull(iso)}.</p>`;
      return;
    }
    const head = `<div class="off-head"><b>${r.people.length}</b> off on ${fmtDateFull(iso)}</div>`;
    const rows = r.people
      .map((p) => {
        const cells = p.week
          .map((d, i) => {
            const sel = d.date === iso ? " is-sel" : "";
            const title = d.duty + (d.hours ? " · " + d.hours : "");
            return `<div class="off-day${sel}"><span class="off-dow">${WD[i]}</span>` +
              `<span class="off-duty d-${d.cls}" title="${title}">${d.duty}</span></div>`;
          })
          .join("");
        return `<div class="off-person"><div class="off-who">` +
          `<div class="off-name">${fullName(p.name)}</div>` +
          `<div class="off-role">${p.role} · ${p.track}</div></div>` +
          `<div class="off-week">${cells}</div></div>`;
      })
      .join("");
    els.offResults.innerHTML = head + rows;
  }

  function initOff() {
    const ys = E.fmtISO(ctx.weekResolver.yearStart);
    const ye = E.fmtISO(E.addDays(ctx.weekResolver.yearEnd, -1));
    els.offDate.min = ys;
    els.offDate.max = ye;
    // default to today, clamped into the academic year
    let today = E.fmtISO(new Date());
    if (today < ys) today = ys;
    if (today > ye) today = ye;
    els.offDate.value = today;
    renderOff(today);
    els.offDate.addEventListener("change", () => {
      if (els.offDate.value) renderOff(els.offDate.value);
    });
    els.offToday.addEventListener("click", () => {
      let t = E.fmtISO(new Date());
      if (t < ys) t = ys; if (t > ye) t = ye;
      els.offDate.value = t;
      renderOff(t);
    });
  }

  async function main() {
    const [weeks, assignments, templates, meta] = await Promise.all([
      loadJSON("data/weeks.json"),
      loadJSON("data/assignments.json"),
      loadJSON("data/templates.json"),
      loadJSON("data/meta.json"),
    ]);
    data = { weeks, assignments, templates, meta };
    ctx = E.makeContext(data);

    makeCombo({ input: els.personInput, clear: els.personClear, list: els.personList, container: els.personCombo, onChoose: selectPerson });
    makeCombo({ input: els.bestInput, clear: els.bestClear, list: els.bestList, container: els.bestCombo, onChoose: selectBesties });
    renderBesties(null);
    // Calendar depends on the FullCalendar CDN; if it fails to load, keep the
    // rest of the app working rather than breaking every tab.
    try {
      if (typeof FullCalendar === "undefined") throw new Error("FullCalendar failed to load");
      initCalendar();
    } catch (err) {
      els.calendar.innerHTML =
        `<div class="cal-fallback">Calendar view unavailable (couldn’t load the calendar library). ` +
        `The other tabs still work.</div>`;
      console.error(err);
    }
    populateTogether();
    initAround();
    runTogether();
    initOff();

    els.tabs.addEventListener("click", (e) => {
      const b = e.target.closest(".tab-btn");
      if (b) switchTab(b.dataset.tab);
    });

    if (els.gcalBtn) els.gcalBtn.addEventListener("click", addToGoogle);
    if (els.icsBtn) els.icsBtn.addEventListener("click", downloadICS);

    // Day-detail modal: close on the × button, backdrop tap, or Escape.
    if (els.dayClose) els.dayClose.addEventListener("click", closeDayDetail);
    if (els.dayModal)
      els.dayModal.addEventListener("click", (e) => {
        if (e.target.hasAttribute("data-close")) closeDayDetail();
      });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && els.dayModal && !els.dayModal.hidden) closeDayDetail();
    });
    els.tgSearch.addEventListener("input", (e) => filterTogether(e.target.value));
    els.tgClear.addEventListener("click", () => {
      selectedInits.clear();
      els.tgPicker.querySelectorAll("input:checked").forEach((cb) => (cb.checked = false));
      runTogether();
    });

    // deep-link support: ?p=TT
    const initial = new URL(window.location).searchParams.get("p");
    if (initial && data.assignments.some((p) => p.init === initial)) selectPerson(initial);
    setScheduleEmpty(!currentInit);
  }

  main().catch((err) => {
    els.summary.innerHTML =
      `<div class="card"><div class="k">Error</div><div class="v">${err.message}</div></div>`;
    console.error(err);
  });
})();
