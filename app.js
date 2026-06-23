/* CornCal front-end: load data, drive the person picker + FullCalendar. */
(function () {
  "use strict";
  const E = window.CornCalEngine;

  const els = {
    person: document.getElementById("person"),
    summary: document.getElementById("summary"),
    calendar: document.getElementById("calendar"),
  };

  let data = null;
  let ctx = null;
  let calendar = null;
  let eventsByPerson = {}; // init -> FullCalendar events

  async function loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`failed to load ${path}: ${r.status}`);
    return r.json();
  }

  function toEvents(person) {
    const days = E.resolveYear(person, ctx);
    return days.map((d) => ({
      start: d.date,
      allDay: true,
      title: d.duty,
      classNames: ["ev-" + d.cls],
      extendedProps: { rotation: d.rotation, hours: d.hours, duty: d.duty },
    }));
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
    const events = person ? toEvents(person) : [];
    if (person) eventsByPerson[person.init] = events;

    const src = calendar.getEventSources();
    src.forEach((s) => s.remove());
    if (events.length) calendar.addEventSource(events);
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
