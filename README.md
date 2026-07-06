# CornCal

A schedule harmonizer for the internal-medicine intern year (AY **2026–2027**).
It folds three separate documents — the **assignment table**, the **block
schedule**, and the **master / MICU call templates** — into one place: pick your
name and see your whole year, day by day, on a calendar.

🔗 **Live site:** https://ttabernacki.github.io/CornCal/ (deep link: `/?p=TT`)

Static site, no backend. Deployed to GitHub Pages via GitHub Actions.

## How it works

The schedule lives across three sources that have to be joined:

1. **Block schedule** — the calendar backbone. 13 blocks × 4 weeks. It maps every
   calendar week to a block number and a *week-of-block* (1–4).
2. **Assignment table** — per person, 26 two-week columns. Each cell is a *role
   slot* (e.g. `MICU Int 3`, `Med Red Int 1`, `Nightfloat Int 2`) or an
   off-template block (`CIMA`, `Elective`, `Vacation`, `MSKCC`, …).
3. **Master / MICU templates** — for each rotation + role + week-of-block, the
   seven weekday duties (Admit, Nights, OFF, Consults, call length, …).

### The lookup chain (per person, per day)

```
date ─▶ intern week ─▶ (block, week-of-block 1–4, 2-week column)
        │
        ├─ assignment[person][column]  ─▶ role label  (split cells: 1 label per week)
        │
        └─ template[role][week-of-block][weekday] ─▶ duty + hours
```

A two-week assignment column is one half of a four-week block: week-of-block
**1–2** come from the odd column, **3–4** from the even column. A rotation in the
first half of a block therefore follows template weeks 1–2; one in the second
half follows weeks 3–4.

### Rendering rules (v1)

- `CIMA` / `Elective` → clinic **9a–5p Mon–Fri**, off weekends.
- `Vacation` → off all week.
- **MICU with vs. without ED interns:** Int 1–4 are identical in both variants
  (verified cell-by-cell); only slot 5 differs. The roster label picks the
  variant — `MICU Int 5` → no-ED template, `MICU Int 5a`/`5b` → with-ED slots
  (half Triage, half the no-ED Int-5 duties; the ED intern covers the other half).
- **Nights & post-call:** every non-off Nightfloat cell (`GM A`, `GM B~`, `4N`, …)
  is a night shift — 7p–9a base, 7p–7a for the `~`/`^` handoff nights,
  7p–9:30a for 4N cover; MICU nights 6:45p–7a. A night ends the *next*
  morning, so an otherwise-off day following a night renders as **Post-call**
  with its signout time, and post-call days do **not** count as off days for
  the weekend gold/silver/black tiers.
- Split cells `A | B` → week 1 = `A`, week 2 = `B`.
- Off-service blocks (MSKCC, HSS, Neurology, ED, Psych ED, ID Consult, Core
  Research, …) render as labeled "away" time (no day-level detail).
- **Interns only** for v1 — resident (PGY-2/3) slots are not yet modeled.

## Project layout

```
index.html, app.js, styles.css   the web app (FullCalendar month view)
engine.js                        pure lookup engine (also runnable in Node)
data/*.json                      generated data the app fetches
tools/extract_templates.py       coordinate-aware template extraction from the master PDF
tools/generate_data.py           builds weeks/assignments/meta + validates role labels
sources/*.pdf                    the original schedule PDFs
```

> Note: `tools/` and `sources/` are kept in the local working copy for
> reproducibility. The deployed site only needs the web files + `data/*.json`.

## Regenerating the data

The templates are extracted from the master PDF using **word coordinates** (plain
text loses the grid layout, so weekday alignment would be wrong). Requires
`pymupdf`.

```bash
pip install pymupdf
python3 tools/extract_templates.py \
    sources/Master_Schedule_2026-2027.pdf \
    sources/MICU_Schedule_2026-2027.pdf      # -> data/templates.json
python3 tools/generate_data.py               # -> weeks/assignments/meta.json (+ validation)
```

`generate_data.py` validates that **every** role label in the roster resolves to a
known template or a known synthetic/label-only rotation, so any transcription
typo surfaces immediately instead of silently dropping a day.

## Running locally

```bash
python3 -m http.server 8000
# open http://localhost:8000/   (deep link: /?p=TT)
```

## ⚠️ Disclaimer

This is a best-effort harmonization of source PDFs and may contain errors. Always
verify against the official schedules before relying on it.
