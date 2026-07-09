/*
 * CornCal lookup engine (pure, no DOM).
 *
 * Given the generated data (weeks / assignments / templates / meta) it resolves,
 * for any intern and any calendar date in the 2026-2027 academic year, the
 * rotation + daily duty + approximate hours.
 *
 * Lookup chain (mirrors the manual process):
 *   date -> intern week  -> (block, weekOfBlock, 2-week column)
 *   person.columns[column-1] -> role label (split cells handled per-week)
 *   templates[role][weekOfBlock][weekdayIndex] -> duty
 */
(function (root) {
  "use strict";

  function parseISO(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d); // local midnight
  }
  function fmtISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  function addDays(date, n) {
    const x = new Date(date);
    x.setDate(x.getDate() + n);
    return x;
  }
  // Monday=0 ... Sunday=6 (templates are stored Mon..Sun)
  function weekdayMon0(date) {
    return (date.getDay() + 6) % 7;
  }

  // " | " split cell -> [firstWeekLabel, secondWeekLabel]
  function splitCell(cell) {
    if (!cell) return ["", ""];
    const i = cell.indexOf(" | ");
    if (i === -1) return [cell.trim(), cell.trim()];
    return [cell.slice(0, i).trim(), cell.slice(i + 3).trim()];
  }

  // Build a date -> week resolver from the weeks array.
  function makeWeekResolver(weeks) {
    const sorted = weeks
      .map((w) => ({ ...w, _start: parseISO(w.start) }))
      .sort((a, b) => a._start - b._start);
    const yearStart = sorted[0]._start;
    const yearEnd = addDays(sorted[sorted.length - 1]._start, 7); // exclusive
    return {
      yearStart,
      yearEnd,
      weekFor(date) {
        if (date < yearStart || date >= yearEnd) return null;
        // last week whose start <= date
        let found = null;
        for (const w of sorted) {
          if (w._start <= date) found = w;
          else break;
        }
        return found;
      },
    };
  }

  // ---- duty hours (approximate, from master-schedule footnotes) ----------
  function familyOf(roleLabel) {
    const r = roleLabel || "";
    if (/MICU/i.test(r)) return "MICU";
    if (/4N/i.test(r)) return "4N";
    if (/Nightfloat/i.test(r)) return "NF";
    if (/Geriatrics/i.test(r)) return "Geri";
    if (/Platinum/i.test(r)) return "Platinum";
    if (/Lymphoma/i.test(r)) return "Lymphoma";
    if (/Gold/i.test(r)) return "Gold";
    if (/Jeopardy/i.test(r)) return "Jeopardy";
    if (/Med (Red|Green|Blue|Orange|Yellow)|Renal/i.test(r)) return "GM";
    return "Other";
  }

  function hoursFor(family, duty) {
    const d = (duty || "").trim();
    if (d === "" || /^OFF$/i.test(d)) return "";
    if (/^POST$/i.test(d)) return "off after AM signout";
    // Nightfloat duties are cover labels (GM A, GM B~, 4N, ...) — every
    // non-off cell is a night shift starting 7p and ending the next morning.
    if (family === "NF") {
      if (d.includes("~") || d.includes("^")) return "7p–7a";
      if (d === "4N") return "7p–9:30a";
      return "7p–9a";
    }
    if (/night/i.test(d)) {
      if (family === "MICU") return "6:45p–7a";
      if (family === "4N") return d.includes("^") ? "7p–7a" : "7p–9:30a";
      if (family === "Geri") return "7p–9a";
      return "nights";
    }
    switch (family) {
      case "MICU":
        if (/^Triage$/i.test(d)) return "6:30a–6:45p";
        return /^CCT$/.test(d) ? "7a–6:45p" : "6:30a–6:45p";
      case "4N":
        if (/admit/i.test(d)) return "7a–7p";
        if (/consult/i.test(d)) return "7a–5p";
        return "7a–5p";
      case "GM":
        if (/admit/i.test(d)) return "7a–6:30p (long call)";
        if (/working/i.test(d)) return "7a–~5p";
        return "7a–~5p";
      case "Gold":
        return /admit/i.test(d) ? "7a–6:30p" : "7a–~5p";
      case "Platinum":
        if (/late/i.test(d)) return "to 7p";
        if (/admit/i.test(d)) return "to 5p";
        return "7a–~5p";
      case "Lymphoma":
        if (/late/i.test(d)) return "to 7p";
        return "7a–~5p";
      case "Geri":
        if (/admit/i.test(d)) return "to 5p";
        if (/day/i.test(d)) return "day";
        return "";
      case "Jeopardy":
        return "7p–9a (on call)";
      default:
        return "";
    }
  }

  // Classify a duty for coloring.
  function classify(kind, duty, family) {
    if (kind === "off") return "off";
    if (kind === "away") return "away";
    if (kind === "clinic") return "clinic";
    const d = (duty || "").trim();
    if (d === "" ) return "work";
    if (/^OFF$/i.test(d)) return "off";
    if (/^POST$/i.test(d)) return "post";
    // Every non-off Nightfloat cell is a night shift regardless of its label.
    if (family === "NF") return "night";
    if (/night/i.test(d)) return "night";
    if (/admit|late/i.test(d)) return "admit";
    if (/^Triage$/i.test(d)) return "consult";
    if (/consult/i.test(d)) return "consult";
    return "work";
  }

  // When a night shift ends the next morning (per master-schedule footnotes).
  function nightEndOf(family, duty) {
    const d = (duty || "").trim();
    if (family === "MICU") return "7a";
    if (family === "4N") return d.includes("^") ? "7a" : "9:30a";
    if (family === "NF") {
      if (d.includes("~") || d.includes("^")) return "7a";
      if (d === "4N") return "9:30a";
      return "9a";
    }
    return "9a";
  }

  /*
   * Resolve a single day.
   * Returns { date, weekOfBlock, block, rotation, label, duty, hours, cls, kind }
   * or null if the date is outside the year or the person has no assignment.
   */
  function resolveDay(date, person, ctx) {
    const week = ctx.weekResolver.weekFor(date);
    if (!week) return null;
    const cell = person.columns[week.column - 1];
    if (!cell) return null; // not in the medicine schedule this block

    const [labelA, labelB] = splitCell(cell);
    // first week of a 2-week column has the odd weekOfBlock (1 or 3)
    const isFirstWeekOfColumn = week.weekOfBlock % 2 === 1;
    const label = isFirstWeekOfColumn ? labelA : labelB;
    if (!label) return null;

    const wd = weekdayMon0(date);
    const base = {
      date: fmtISO(date),
      block: week.block,
      weekOfBlock: week.weekOfBlock,
      label,
      rotation: label,
    };

    const meta = ctx.meta;
    if (meta.syntheticClinic.includes(label)) {
      const off = wd >= 5; // Sat/Sun
      return { ...base, duty: off ? "OFF" : "Clinic", hours: off ? "" : "9a–5p",
               kind: off ? "off" : "clinic", cls: off ? "off" : "clinic" };
    }
    if (meta.allOff.includes(label)) {
      return { ...base, duty: "Vacation", hours: "", kind: "off", cls: "off" };
    }
    if (meta.labelOnly.includes(label)) {
      return { ...base, duty: label, hours: "", kind: "away", cls: "away" };
    }

    const tmplKey = meta.roleToTemplate[label];
    const tmpl = tmplKey && ctx.templates[tmplKey];
    if (!tmpl) {
      // unknown -> show the raw label so nothing silently disappears
      return { ...base, duty: label, hours: "", kind: "away", cls: "away" };
    }
    const duty = (tmpl[String(week.weekOfBlock)] || tmpl[week.weekOfBlock] || [])[wd] || "";
    const fam = familyOf(label);
    const cls = classify("template", duty, fam);
    return {
      ...base,
      rotation: tmplKey,
      duty: duty === "" ? "Work" : duty,
      hours: hoursFor(fam, duty),
      kind: "template",
      cls,
      endsNext: cls === "night" ? nightEndOf(fam, duty) : null,
    };
  }

  /*
   * Post-call pass: every night shift ends the NEXT morning, so an
   * otherwise-off day that follows a night is really a post-call day —
   * the person is on service until signout that morning. Rewrite those
   * days so the calendar says when they actually get out.
   * (Explicit POST cells in the MICU/4N templates already carry this.)
   */
  function applyPostCall(days) {
    for (let i = 0; i < days.length - 1; i++) {
      const cur = days[i], nxt = days[i + 1];
      if (cur.cls !== "night" || !cur.endsNext) continue;
      if (fmtISO(addDays(parseISO(cur.date), 1)) !== nxt.date) continue;
      if (nxt.cls !== "off") continue; // another night = mid-stretch; workdays untouched
      nxt.cls = "post";
      nxt.duty = /vacation/i.test(nxt.duty) ? "Vacation (post-call)" : "Post-call";
      nxt.hours = "off after " + cur.endsNext + " signout";
    }
    return days;
  }

  // Produce every day for a person across the whole academic year.
  function resolveYear(person, ctx) {
    const out = [];
    let d = new Date(ctx.weekResolver.yearStart);
    while (d < ctx.weekResolver.yearEnd) {
      const r = resolveDay(d, person, ctx);
      if (r) out.push(r);
      d = addDays(d, 1);
    }
    return applyPostCall(out);
  }

  // ---- group overlap analysis (for the "who's free together" tab) --------

  // The role label a person holds during a given week (split cells resolved).
  function labelForWeek(person, week) {
    const cell = person.columns[week.column - 1];
    if (!cell) return "";
    const [a, b] = splitCell(cell);
    return week.weekOfBlock % 2 === 1 ? a : b;
  }

  // Collapse a role slot to the shared rotation two people would be on together
  // (inpatient services + CIMA ambulatory). Returns null for things that aren't
  // a shared rotation — electives, vacation, call pools, and off-service time.
  function normalizeService(label) {
    const l = (label || "").trim();
    if (!l) return null;
    let m = l.match(/^Med (Red|Green|Blue|Orange|Yellow) Int/i);
    if (m) return "Med " + m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    if (/^Renal Int/i.test(l)) return "Renal";
    if (/^MICU Int/i.test(l)) return "MICU";
    if (/^4N Int/i.test(l)) return "4N";
    if (/^Nightfloat Int/i.test(l)) return "Nightfloat";
    if (/^Med Gold Int/i.test(l)) return "Gold";
    if (/^Platinum Int/i.test(l)) return "Platinum";
    if (/^Lymphoma Int/i.test(l)) return "Lymphoma";
    if (/^Geriatrics Int/i.test(l)) return "Geriatrics";
    if (/^CIMA/i.test(l)) return "CIMA"; // ambulatory continuity block (included)
    return null; // Elective, Vacation, MSKCC/HSS/Neuro/ED, Jeopardy, ID Consult...
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  /*
   * Minute-of-day a person becomes free ("off call") on a given day.
   *   0    = free the whole day (off / vacation / weekend off)
   *   null = NOT reliably free this evening (on a night shift, on Jeopardy
   *          backup call, or an off-service shift whose hours we can't pin down)
   * Otherwise the end-of-shift time. The group is free from the LATEST of these.
   */
  function freeFromMinutes(day) {
    if (!day) return null;
    const d = (day.duty || "").trim();
    switch (day.cls) {
      case "night": return null;            // working that night
      case "off": return 0;                 // free all day
      case "clinic": return 17 * 60;        // clinic out ~5p
      case "post": {                        // free from the morning signout
        const m = (day.hours || "").match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\b/i);
        if (m) { let h = (+m[1] % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
                 return h * 60 + (m[2] ? +m[2] : 0); }
        return 12 * 60;                      // "AM signout" -> noon (free by evening anyway)
      }
      case "away":                          // off-service: ED-type is shift-based/unknown
        return /emergency|ED IM|Psych ED/i.test(d) ? null : 17 * 60;
    }
    const fam = familyOf(day.rotation || "");
    if (fam === "Jeopardy") return null;    // backup call all evening
    if (fam === "MICU") return 18 * 60 + 45;                       // 6:45p
    if (fam === "4N") return /admit/i.test(d) ? 19 * 60 : 17 * 60; // admit 7p else 5p
    if (fam === "GM" || fam === "Gold") return /admit/i.test(d) ? 18 * 60 + 30 : 17 * 60; // long call 6:30p
    if (fam === "Platinum" || fam === "Lymphoma") return /late/i.test(d) ? 19 * 60 : 17 * 60; // late 7p
    return 17 * 60;                          // default: out ~5p
  }

  /*
   * Cross-reference a group of people. `today` bounds the time-limited queries.
   * Returns:
   *   freeEvenings   - next ~month: days where nobody is on a night shift
   *   fullDaysOff    - rest of year: days where everybody is fully off
   *   sharedRotations- whole year: maximal runs on the same clinical service
   */
  function analyzeGroup(people, ctx, today) {
    const maps = people.map((p) => {
      const m = {};
      for (const d of resolveYear(p, ctx)) m[d.date] = d;
      return m;
    });
    const ys = ctx.weekResolver.yearStart;
    const ye = ctx.weekResolver.yearEnd;
    const from = startOfDay(today) > ys ? startOfDay(today) : new Date(ys);

    const dayRows = (iso) => maps.map((m) => m[iso]);
    const everyone = (rows, fn) => rows.length > 0 && rows.every(fn);

    // 1) free evenings — next 31 days. The group is off-call from the LATEST
    //    end-of-work time; a null (nights / Jeopardy / ED shift) disqualifies.
    const freeEvenings = [];
    const monthEnd = addDays(from, 31);
    for (let d = new Date(from); d < ye && d < monthEnd; d = addDays(d, 1)) {
      const iso = fmtISO(d);
      const rows = dayRows(iso);
      if (!everyone(rows, (r) => !!r)) continue;
      const mins = rows.map(freeFromMinutes);
      if (mins.some((m) => m === null)) continue;
      freeEvenings.push({
        date: iso,
        freeFrom: Math.max(...mins), // minutes; 0 = free all day
        statuses: rows.map((r) => ({ duty: r.duty, cls: r.cls, hours: r.hours })),
      });
    }

    // 2) full days off together — from today through end of year
    const fullDaysOff = [];
    for (let d = new Date(from); d < ye; d = addDays(d, 1)) {
      const iso = fmtISO(d);
      const rows = dayRows(iso);
      if (everyone(rows, (r) => r && r.cls === "off")) fullDaysOff.push(iso);
    }

    // 3) shared rotations — maximal consecutive weeks on the same service
    const weeks = [...ctx.weeks].sort((a, b) => (a.start < b.start ? -1 : 1));
    const sharedRotations = [];
    let run = null;
    const flush = () => { if (run) { sharedRotations.push(run); run = null; } };
    for (const w of weeks) {
      const labels = people.map((p) => labelForWeek(p, w));
      const svcs = labels.map(normalizeService);
      const svc = svcs[0];
      const match = svc && svcs.every((s) => s === svc);
      if (match) {
        if (run && run.service === svc) {
          run.endWeek = w;
        } else {
          flush();
          run = { service: svc, startWeek: w, endWeek: w, labels };
        }
      } else {
        flush();
      }
    }
    flush();
    const shaped = sharedRotations.map((r) => ({
      service: r.service,
      start: r.startWeek.start,
      end: fmtISO(addDays(parseISO(r.endWeek.start), 6)),
      roles: r.labels,
    }));

    return { freeEvenings, fullDaysOff, sharedRotations: shaped, count: people.length };
  }

  // The Monday that begins the Mon–Sun week containing `date`.
  function mondayOf(date) {
    return addDays(date, -weekdayMon0(date));
  }

  /*
   * Resolve a single day WITH the post-call rewrite applied, so a day that
   * follows an overnight reads as "Post-call" exactly like the calendar does.
   * (resolveDay alone doesn't run applyPostCall — only resolveYear does.)
   */
  function resolveDayLive(date, person, ctx) {
    const seq = [];
    const prev = resolveDay(addDays(date, -1), person, ctx);
    const cur = resolveDay(date, person, ctx);
    if (prev) seq.push(prev);
    if (cur) seq.push(cur);
    if (!cur) return null;
    applyPostCall(seq);
    return seq[seq.length - 1];
  }

  /*
   * For a selected intern and date: the team rotation they're on that day and
   * every OTHER intern on that same rotation who is working (not off) that day.
   * "Same rotation" uses normalizeService (team level: Med Red ≠ Med Green;
   * MICU/Nightfloat/CIMA grouped), so electives, off-service, vacation and
   * call pools have no shared rotation. Nights and post-call still count as on
   * service; only fully-off interns are excluded.
   */
  function rotationPeersOn(assignments, ctx, dateISO, selfInit) {
    const date = parseISO(dateISO);
    if (date < ctx.weekResolver.yearStart || date >= ctx.weekResolver.yearEnd)
      return { date: dateISO, inYear: false, self: null, service: null, peers: [] };

    const self = assignments.find((p) => p.init === selfInit) || null;
    const selfDay = self ? resolveDayLive(date, self, ctx) : null;
    const service = selfDay ? normalizeService(selfDay.label) : null;
    const selfInfo = selfDay
      ? { name: self.name, role: selfDay.label, rotation: selfDay.rotation,
          duty: selfDay.duty, hours: selfDay.hours, cls: selfDay.cls }
      : null;

    const peers = [];
    if (service) {
      for (const p of assignments) {
        if (self && p.init === self.init) continue;
        const day = resolveDayLive(date, p, ctx);
        if (!day) continue;
        if (normalizeService(day.label) !== service) continue;
        if (day.cls === "off") continue; // excluded: off that day
        peers.push({ name: p.name, init: p.init, track: p.track,
                     role: day.label, duty: day.duty, hours: day.hours, cls: day.cls });
      }
      peers.sort((a, b) => a.name.localeCompare(b.name));
    }
    return { date: dateISO, inYear: true, self: selfInfo, service, peers };
  }

  /*
   * Everyone who is fully OFF on a given date, with the role they hold that
   * week and their whole Mon–Sun schedule. Used by the "Who's off on…" tab.
   */
  function offOnDate(assignments, ctx, dateISO) {
    const date = parseISO(dateISO);
    if (date < ctx.weekResolver.yearStart || date >= ctx.weekResolver.yearEnd)
      return { selected: dateISO, weekDates: [], people: [] };
    const mon = mondayOf(date);
    const weekDates = [];
    for (let i = 0; i < 7; i++) weekDates.push(fmtISO(addDays(mon, i)));

    const people = [];
    for (const p of assignments) {
      const day = resolveDay(date, p, ctx);
      if (!day || day.cls !== "off") continue;
      const week = weekDates.map((iso) => {
        const r = resolveDay(parseISO(iso), p, ctx);
        return r
          ? { date: iso, duty: r.duty, cls: r.cls, hours: r.hours }
          : { date: iso, duty: "—", cls: "none", hours: "" };
      });
      people.push({
        name: p.name, init: p.init, track: p.track,
        role: day.label, rotation: day.rotation, offType: day.duty, week,
      });
    }
    people.sort((a, b) => a.name.localeCompare(b.name));
    return { selected: dateISO, mon: fmtISO(mon), weekDates, people };
  }

  // Collapse a sorted list of ISO dates into [{start,end,days}] ranges.
  function groupRanges(isoDates) {
    const out = [];
    for (const iso of isoDates) {
      const last = out[out.length - 1];
      if (last && fmtISO(addDays(parseISO(last.end), 1)) === iso) {
        last.end = iso; last.days += 1;
      } else {
        out.push({ start: iso, end: iso, days: 1 });
      }
    }
    return out;
  }

  function makeContext(data) {
    return {
      weeks: data.weeks,
      templates: data.templates,
      meta: data.meta,
      weekResolver: makeWeekResolver(data.weeks),
    };
  }

  const api = {
    parseISO, fmtISO, addDays, weekdayMon0, splitCell,
    makeWeekResolver, makeContext, resolveDay, resolveYear,
    familyOf, hoursFor, classify, nightEndOf, applyPostCall,
    labelForWeek, normalizeService, analyzeGroup, groupRanges, freeFromMinutes,
    mondayOf, offOnDate, resolveDayLive, rotationPeersOn,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CornCalEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
