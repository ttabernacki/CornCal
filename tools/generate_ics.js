/*
 * Pre-generate one hosted iCalendar per intern into ../cal/<init>.ics.
 * These power the "Add to Google Calendar" subscription link and webcal://
 * subscriptions on Apple devices (Google/Apple need a reachable URL, not a
 * client-side blob). Re-run after regenerating data/.
 *
 *   node tools/generate_ics.js
 *
 * A fixed DTSTAMP keeps the output deterministic so re-runs don't churn diffs.
 */
const fs = require("fs");
const path = require("path");
const E = require("../engine.js");

const root = path.join(__dirname, "..");
const load = (f) => JSON.parse(fs.readFileSync(path.join(root, "data", f), "utf8"));
const data = {
  weeks: load("weeks.json"),
  assignments: load("assignments.json"),
  templates: load("templates.json"),
  meta: load("meta.json"),
};
const ctx = E.makeContext(data);

const STAMP = "20260101T000000Z"; // fixed → deterministic output
const outDir = path.join(root, "cal");
fs.mkdirSync(outDir, { recursive: true });

const seen = new Set();
let n = 0;
for (const p of data.assignments) {
  const safe = String(p.init).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe || seen.has(safe)) {
    console.warn("skip (empty/dup init):", JSON.stringify(p.init), p.name);
    continue;
  }
  seen.add(safe);
  const days = E.resolveYear(p, ctx);
  const ics = E.toICS(p.name, p.init, days, STAMP);
  fs.writeFileSync(path.join(outDir, safe + ".ics"), ics);
  n++;
}
console.log("wrote", n, "ics files to", path.relative(root, outDir) + "/");
