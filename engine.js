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

  // Collapse a role slot to the shared clinical service two people would be on
  // together. Returns null for anything that isn't a shared inpatient rotation
  // — electives, vacation, ambulatory (CIMA), call pools, and off-service time.
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
    return null; // Elective, CIMA, Vacation, MSKCC/HSS/Neuro/ED, Jeopardy, ID Consult...
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
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

    // 1) free evenings — next 31 days
    const freeEvenings = [];
    const monthEnd = addDays(from, 31);
    for (let d = new Date(from); d < ye && d < monthEnd; d = addDays(d, 1)) {
      const iso = fmtISO(d);
      const rows = dayRows(iso);
      if (everyone(rows, (r) => r && r.cls !== "night")) {
        freeEvenings.push({
          date: iso,
          statuses: rows.map((r) => ({ duty: r.duty, cls: r.cls, hours: r.hours })),
        });
      }
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
    labelForWeek, normalizeService, analyzeGroup, groupRanges,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CornCalEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
