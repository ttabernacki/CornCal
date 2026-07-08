/* CornCal front-end: load data, drive the person picker + FullCalendar. */
(function () {
  "use strict";
  const E = window.CornCalEngine;

  const els = {
    person: document.getElementById("person"),
    summary: document.getElementById("summary"),
    calendar: document.getElementById("calendar"),
    tabs: document.getElementById("tabs"),
    tgSearch: document.getElementById("together-search"),
    tgPicker: document.getElementById("together-picker"),
    tgClear: document.getElementById("together-clear"),
    tgSelected: document.getElementById("together-selected"),
    tgResults: document.getElementById("together-results"),
  };
  const selectedInits = new Set();

  let data = null;
  let ctx = null;
  let calendar = null;
  let eventsByPerson = {}; // init -> FullCalendar events
  let weekendTier = {};    // ISO date (Sat or Sun) -> "gold" | "silver" | "black"

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
      extendedProps: { rotation: d.rotation, hours: d.hours, duty: d.duty },
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
      card("Name", person.name) +
      card("Track", person.track) +
      card("Admit / long-call days", counts.admit) +
      card("Night days", counts.night) +
      card("Off / vacation days", counts.off) +
      card("Clinic days", counts.clinic);
  }

  function selectPerson(init) {
    const person = data.assignments.find((p) => p.init === init);
    const days = person ? E.resolveYear(person, ctx) : [];
    const events = toEvents(days);
    buildWeekendTiers(days);
    if (person) eventsByPerson[person.init] = events;

    const src = calendar.getEventSources();
    src.forEach((s) => s.remove());
    if (events.length) calendar.addEventSource(events);
    // A fresh function reference forces FullCalendar to re-run the day-cell
    // class hook, re-coloring the weekend boxes for the newly selected person.
    calendar.setOption("dayCellClassNames", (a) => weekendClassNames(a));
    renderSummary(person);

    const url = new URL(window.location);
    if (init) url.searchParams.set("p", init);
    else url.searchParams.delete("p");
    history.replaceState(null, "", url);
  }

  function populatePicker() {
    const groups = {};
    for (const p of data.assignments) (groups[p.track] ||= []).push(p);
    for (const track of Object.keys(groups)) {
      const og = document.createElement("optgroup");
      og.label = track;
      groups[track]
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((p) => {
          const o = document.createElement("option");
          o.value = p.init;
          o.textContent = `${p.name} (${p.init})`;
          og.appendChild(o);
        });
      els.person.appendChild(og);
    }
  }

  function initCalendar() {
    calendar = new FullCalendar.Calendar(els.calendar, {
      initialView: "dayGridMonth",
      initialDate: ctx.weekResolver.yearStart,
      validRange: {
        start: E.fmtISO(ctx.weekResolver.yearStart),
        end: E.fmtISO(ctx.weekResolver.yearEnd),
      },
      firstDay: 1, // Monday
      height: "auto",
      headerToolbar: { left: "prev,next today", center: "title", right: "" },
      displayEventTime: false,
      dayMaxEvents: false,
      dayCellClassNames: (arg) => weekendClassNames(arg),
      eventContent: (arg) => {
        const { rotation, hours, duty } = arg.event.extendedProps;
        const wrap = document.createElement("div");
        wrap.innerHTML =
          `<div class="ev-duty">${duty}</div>` +
          `<div class="ev-rot">${rotation}</div>` +
          (hours ? `<div class="ev-hrs">${hours}</div>` : "");
        return { domNodes: [wrap] };
      },
    });
    calendar.render();
  }

  // ---------------------------- Tabs ----------------------------
  function switchTab(name) {
    for (const b of els.tabs.querySelectorAll(".tab-btn"))
      b.classList.toggle("active", b.dataset.tab === name);
    document.getElementById("tab-schedule").hidden = name !== "schedule";
    document.getElementById("tab-together").hidden = name !== "together";
    // FullCalendar mis-sizes if it was laid out while hidden — fix on return.
    if (name === "schedule" && calendar) calendar.updateSize();
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

  function section(title, sub, body) {
    return `<div class="tg-section"><h3>${title}${
      sub ? ` <span class="tg-sub">${sub}</span>` : ""
    }</h3>${body}</div>`;
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
            return `<div class="tg-row"><b>${fmtDate(e.date)}</b><div class="tg-chipwrap">${chips}</div></div>`;
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
      : `<p class="tg-none">Never on the same inpatient service (electives & clinic excluded).</p>`;

    els.tgResults.innerHTML =
      section("Free evenings", "next month · nobody on an overnight", evenings) +
      section("Full days off together", `rest of the year · ${g.fullDaysOff.length} day(s)`, off) +
      section("On the same rotation", "whole year · electives &amp; clinic excluded", rot);
  }

  function runTogether() {
    const people = [...selectedInits]
      .map((i) => data.assignments.find((p) => p.init === i))
      .filter(Boolean);
    els.tgSelected.innerHTML = people.length
      ? `<b>${people.length} selected:</b> ${people.map(firstName).join(", ")}`
      : "";
    if (!people.length) {
      els.tgResults.innerHTML = `<p class="tg-empty">Select people on the left to find when they’re free together and when they overlap on service.</p>`;
      return;
    }
    renderTogether(E.analyzeGroup(people, ctx, new Date()), people);
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

    populatePicker();
    initCalendar();
    populateTogether();
    runTogether();

    els.tabs.addEventListener("click", (e) => {
      const b = e.target.closest(".tab-btn");
      if (b) switchTab(b.dataset.tab);
    });
    els.tgSearch.addEventListener("input", (e) => filterTogether(e.target.value));
    els.tgClear.addEventListener("click", () => {
      selectedInits.clear();
      els.tgPicker.querySelectorAll("input:checked").forEach((cb) => (cb.checked = false));
      runTogether();
    });

    els.person.addEventListener("change", (e) => selectPerson(e.target.value));

    // deep-link support: ?p=TT
    const initial = new URL(window.location).searchParams.get("p");
    if (initial && data.assignments.some((p) => p.init === initial)) {
      els.person.value = initial;
      selectPerson(initial);
    }
  }

  main().catch((err) => {
    els.summary.innerHTML =
      `<div class="card"><div class="k">Error</div><div class="v">${err.message}</div></div>`;
    console.error(err);
  });
})();
