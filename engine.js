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
    if (/^POST$/i.test(d)) return "post-call";
    if (/night/i.test(d)) {
      if (family === "MICU") return "6:45p–7a";
      if (family === "4N") return d.includes("^") ? "7p–7a" : "7p–9:30a";
      if (family === "NF") return d.includes("~") || d.includes("^") ? "7p–7a" : "7p–9a";
      if (family === "Geri") return "7p–9a";
      return "nights";
    }
    switch (family) {
      case "MICU":
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
  function classify(kind, duty) {
    if (kind === "off") return "off";
    if (kind === "away") return "away";
    if (kind === "clinic") return "clinic";
    const d = (duty || "").trim();
    if (d === "" ) return "work";
    if (/^OFF$/i.test(d)) return "off";
    if (/^POST$/i.test(d)) return "post";
    if (/night/i.test(d)) return "night";
    if (/admit|late/i.test(d)) return "admit";
    if (/consult/i.test(d)) return "consult";
    return "work";
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
    return {
      ...base,
      rotation: tmplKey,
      duty: duty === "" ? "Work" : duty,
      hours: hoursFor(fam, duty),
      kind: "template",
      cls: classify("template", duty),
    };
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
    familyOf, hoursFor, classify,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CornCalEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
