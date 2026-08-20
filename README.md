# Timeline

A timeline for planning projects and a whole life on the same canvas — a
Mac app built because Notion's timeline view is close but not quite right.

<img src="app/icon.png" width="96" alt="">

**What's different from Notion**

- Nothing is collapsed by default, and expansion state sticks
- Continuous zoom from a single day out to a 110-year life view
- **Fuzzy dates** — every date carries a precision, so "sometime in 2031"
  renders hatched and uncertain rather than looking as scheduled as "Nov 3–7"
- The properties table is a real resizable pane, not a toggle that resets
- Dependencies with auto-shift, an overview strip, and labels that stay
  readable at every zoom level

**Stack** — React + TypeScript + Vite, wrapped in Tauri. The whole Mac app is
about 10 MB.

## Running it

```bash
cd app
npm install
npm run dev        # browser
npm run tauri dev  # Mac app
npm run tauri build
```

## Docs

- [`app/README.md`](app/README.md) — architecture, the non-obvious bits, full keyboard map
- [`PLAN.md`](PLAN.md) — the original design doc and build plan
