# Timeline app — build plan

A local-first timeline/Gantt app for macOS, for planning projects *and* a whole life on the same
surface. Starting point: match Notion's timeline view, then fix the things that make it annoying.

---

## 1. Stack decision

**Recommendation: web tech (React + TypeScript + Vite), wrapped in Tauri v2 for the Mac app.**

The reason is that ~80% of this app is one hard thing: a custom, virtualized, draggable time canvas.
Everything else — sidebar, toolbar, menus — is the easy 20%.

| | Web (React/TS) in Tauri | SwiftUI native |
|---|---|---|
| Custom timeline canvas | Well-trodden. Absolute positioning + transforms, mature hit-testing, easy text-in-bar rendering | Hand-roll everything in `Canvas`; no built-in hit-testing, painful text layout |
| Iteration speed | Hot reload, instant | Recompile cycles, previews get flaky on complex custom views |
| Mac chrome (menus, sidebar, vibrancy) | Decent via Tauri; needs deliberate work to not feel webby | Free and perfect |
| Trackpad pinch/momentum | `wheel` + `ctrlKey` gets you 90%; momentum needs faking | Native, perfect |
| If you ever want iPhone/web sync | Straight path | Rewrite the view layer |

Tauri over Electron: ~10MB app instead of ~150MB, real native menus, uses the system WebView, and
SQLite/filesystem access is clean. Cost is installing Rust (one command, you never write Rust).
If Rust install ever becomes a hassle, swapping Tauri → Electron is a couple hours — the app code
is identical.

**Escape hatch:** build Phase 1–4 as a plain browser app. Don't wrap it at all until the timeline
feels good. That keeps the wrapper decision reversible for weeks.

### Concrete stack

- **React 19 + TypeScript + Vite**
- **State:** Zustand (small, no boilerplate, easy undo/redo middleware)
- **Dates:** `date-fns` + `@date-fns/tz` — avoid `Date` arithmetic by hand, DST will bite you
- **Rendering:** DOM with absolute positioning, not Canvas. Virtualize rows; horizontally cull bars.
  DOM gives you free text rendering, hover states, inline editing, accessibility. Canvas only if you
  ever exceed ~2000 visible bars, which for a personal life plan you will not.
- **Storage:** SQLite via `@tauri-apps/plugin-sql`. In browser-only phase, back it with IndexedDB or
  a JSON file behind the same repository interface so the swap is one file.
- **Styling:** CSS modules or vanilla CSS with custom properties. Skip Tailwind here — the timeline
  is mostly computed inline styles anyway.

---

## 2. Data model

Keep it boring and portable. Everything should survive an export to JSON.

```ts
type ItemId = string  // uuid

interface Item {
  id: ItemId
  title: string
  parentId: ItemId | null      // nesting; null = top level
  laneId: LaneId | null        // optional swimlane / area-of-life
  order: number                // sibling ordering (fractional indexing, see note)

  start: DateSpec | null
  end: DateSpec | null         // null + start set = milestone

  status: 'idea' | 'planned' | 'active' | 'done' | 'dropped'
  progress: number | null      // 0..1, optional
  colorId: string | null       // resolves through a palette, not a raw hex
  tagIds: string[]
  notes: string                // markdown
  url: string | null           // link out to Notion/Linear/whatever

  createdAt: string
  updatedAt: string
}

// Fuzzy dates matter a lot for life planning: "sometime in 2031" is a real plan.
interface DateSpec {
  date: string                 // ISO date, the anchor
  precision: 'day' | 'week' | 'month' | 'quarter' | 'year'
}

interface Lane {
  id: LaneId
  name: string                 // "Career", "Health", "Side projects", "Travel"
  colorId: string
  order: number
}

interface Dependency {
  id: string
  fromId: ItemId
  toId: ItemId
  type: 'finish-to-start' | 'start-to-start'
  lagDays: number
}

interface View {
  id: string
  name: string                 // "Life", "This quarter", "Q3 launch"
  zoom: ZoomLevel
  centerDate: string
  groupBy: 'lane' | 'status' | 'tag' | 'none'
  filter: FilterSpec
  rowHeight: 'compact' | 'normal' | 'roomy'
  visibleColumns: string[]     // which fields the left table shows
  expanded: Record<ItemId, boolean>   // per-view, persisted, DEFAULT TRUE
}
```

**Notes on a couple of choices:**

- `order` as a **fractional index** (a float, or better a lexicographic string like the
  `fractional-indexing` package) means reordering a row is a single-row write, not a renumber of
  everything below it.
- `DateSpec.precision` is the feature that makes this a *life* planner rather than a project
  planner. A `year`-precision item renders as a soft, hatched, low-opacity band; a `day`-precision
  one renders as a crisp bar. You get "2033: sabbatical?" and "Nov 3–7: conference" on the same
  canvas without them lying to you about equal certainty.
- Store dates as **date-only ISO strings** (`2026-08-20`), not timestamps. Timeline planning is
  calendar-day work; introducing time-of-day and timezones buys you nothing and costs you DST bugs.

---

## 3. The rendering core

This is the part worth getting right before anything else.

### Time scale

One pure function is the spine of the whole app:

```ts
// pixelsPerDay derived from zoom level; x = (date - originDate) * pixelsPerDay
dateToX(date: Date): number
xToDate(x: number): Date
```

Zoom is a **continuum**, not discrete tabs. Store `pixelsPerDay` as a float, and derive which header
tiers to draw from it:

| pixelsPerDay | Header row 1 | Header row 2 | Feel |
|---|---|---|---|
| > 40 | Month | Day | Day planning |
| 8 – 40 | Month | Week | Sprint planning |
| 1.5 – 8 | Year | Month | Quarter/year planning |
| 0.3 – 1.5 | Year | Quarter | Multi-year |
| < 0.3 | Decade | Year | **Life view** |

Notion effectively stops at the month level. The decade tier is where your use case lives, and it's
a small amount of extra code once zoom is a float.

### Layout

- **Left pane:** a resizable table of item properties. Always visible, never auto-collapses.
  Sticky first column (title). Width persisted per view.
- **Right pane:** the scrolling time canvas. Vertical scroll is shared with the left pane (one
  scroll container driving both, or synced `scrollTop`).
- **Header:** two sticky header rows for the time tiers + a "today" indicator.
- **Rows:** virtualize vertically — render only visible rows plus overscan. Rows are a fixed height
  per density setting, which makes virtualization trivial (no measurement pass).
- **Bars:** for each visible row, cull bars outside `[scrollLeft - overscan, scrollLeft + width + overscan]`.

### Interactions

| Gesture | Behavior |
|---|---|
| Drag bar body | Move item; snap to the current tier's unit (day/week/month) |
| Drag bar edge | Resize start or end |
| ⌥ while dragging | Disable snapping (free positioning) |
| ⇧ while dragging | Move item *and* all its dependents (cascade) |
| Drag on empty row | Create a new item spanning the drag |
| Double-click bar | Inline rename |
| ⌘ + scroll / pinch | Zoom, anchored at cursor position (not at viewport center — anchoring at the cursor is what makes zoom feel good) |
| Two-finger scroll | Pan horizontally + vertically |
| Space + drag | Pan (for trackpad-less situations) |
| `T` | Jump to today |
| `E` / `⇧E` | Expand all / collapse all |
| ⌘↑ / ⌘↓ | Move selection between rows |
| ⌥← / ⌥→ | Nudge selected item by one unit |

Zoom anchoring math: keep the date under the cursor fixed.
```
dateUnderCursor = xToDate(cursorX + scrollLeft)
// apply new pixelsPerDay
scrollLeft = dateToX(dateUnderCursor) - cursorX
```

---

## 4. What makes it better than Notion

Ranked by how much they'll actually improve your day.

1. **Nothing is collapsed by default.** Expansion state lives in the view, defaults to expanded, and
   persists. `E` / `⇧E` for expand-all / collapse-all. The left properties table is a real pane, not
   a toggle that resets.
2. **Decade-scale zoom.** Continuous zoom from single days out to a 40-year view, so "learn to sail"
   and "Tuesday's dentist appointment" coexist.
3. **Fuzzy dates.** `precision` on every date, rendered honestly — a hatched translucent band for
   "sometime in 2031", a crisp bar for a scheduled week. This is the single most distinctive feature
   and Notion has no equivalent.
4. **Overview strip + detail pane.** A thin always-visible minimap of your entire life at the top;
   brush a region on it to drive the detail view below. Two scales at once.
5. **Sticky bar labels.** When a bar extends past the viewport edge, its label pins to the visible
   portion instead of scrolling off. Small thing, constantly noticeable.
6. **Real dependencies with cascade.** Move one thing, optionally push everything downstream.
7. **Swimlanes by area of life** — Career / Health / Relationships / Money / Projects — as a
   first-class grouping with per-lane collapse and color.
8. **Keyboard-first editing.** Create, rename, nudge, and re-parent without touching the mouse.
9. **Density control.** Compact rows to fit a decade of commitments on one screen.

---

## 5. Phases

Each phase ends somewhere you could stop and still have something usable.

### Phase 0 — Scaffold (half a day)
Vite + React + TS. Zustand store. Seed with ~50 fake items across 5 lanes and a 10-year range so
you're never testing against an empty canvas. No persistence yet.

### Phase 1 — Read-only canvas (the hard part, ~2–4 days)
`dateToX`/`xToDate`. Two-tier sticky header driven by `pixelsPerDay`. Rows + bars, virtualized.
Pan and cursor-anchored zoom. Today line. **Stop and live with it** — if pan/zoom doesn't feel
right here, nothing after this will save it.

### Phase 2 — Persistence + CRUD (~2 days)
Repository interface with two implementations (JSON-file/IndexedDB now, SQLite later). Create,
rename, delete, edit dates via a detail panel. Undo/redo as a Zustand middleware that snapshots
the item map — cheap and correct at this data size.

### Phase 3 — Direct manipulation (~3 days)
Drag to move, drag edges to resize, drag empty space to create. Snapping tied to the zoom tier.
Multi-select with ⇧-click and marquee. This is when it starts feeling like a tool.

### Phase 4 — Hierarchy, lanes, left table (~3 days)
Nesting with always-expanded default. Grouping by lane. The resizable properties table with
configurable columns. Parent bars that summarize their children's span. Filters and saved views.

### Phase 5 — Mac app (~1–2 days)
Install Rust, `npm create tauri-app` around the existing code. Native menu bar, window state
restore, ⌘-shortcuts, dark mode following the system. Data file in `~/Library/Application Support/`.
Export to JSON and to `.ics`.

### Phase 6 — The differentiators (ongoing)
Fuzzy dates, the overview/minimap strip, dependencies with cascade, sticky labels, density modes.

**Realistic total to something you use daily: 2–3 weeks of evenings for Phases 0–4.**

---

## 6. Risks worth naming up front

- **Phase 1 is deceptively hard.** Smooth pan/zoom on a virtualized canvas is where most timeline
  projects die. Budget more time than feels reasonable, and don't move on until it's good.
- **Scope creep toward "Notion replacement."** Resist adding databases, docs, and relations. This is
  a timeline. Keep a `url` field on items so it can *link* to wherever the real content lives.
- **Data model churn.** Version the JSON export from day one (`{ version: 1, items: [...] }`) so
  migrations are possible when the model changes — and it will.
- **Rust toolchain.** Not installed yet. `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
  when you get to Phase 5. If it's a pain, use Electron instead; nothing else changes.

---

## 7. Name

**Timeline.** Plain and literal, which is what the app is.

It was briefly called Linea (Latin for *a line*); that name collided with the
ConsenSys Ethereum L2, and plain "Timeline" says what it does. Old `linea.v1`
localStorage data is still read once so nothing was lost in the rename.

Other candidates, kept here in case it ever needs a distinctive name for public
release: Aevum (a lifetime), Olim (someday), Spatium (an interval of time),
Cursus (a course), Saeculum (an age), Longview, Span, Throughline.

---

## 8. Status

All six phases are built. The app lives in `app/`; see `app/README.md` for
architecture notes, gotchas and the full keyboard map.

- [x] **Phase 0** — Vite + React + TS scaffold, seeded with a plausible life plan
- [x] **Phase 1** — Time scale, two-tier header, virtualized rows, cursor-anchored zoom, today marker
- [x] **Phase 2** — Persistence, CRUD, undo/redo, JSON export/import
- [x] **Phase 3** — Drag to move, resize by edge, drag empty canvas to create, snapping
- [x] **Phase 4** — Hierarchy (expanded by default), lane grouping, resizable properties table, search, detail panel
- [x] **Phase 5** — Tauri wrapper, native macOS menu bar, overlay title bar, durable JSON file in the app data dir
- [x] **Phase 6** — Dependencies with cascade, overview strip, marquee selection, drag-to-reorder, fuzzy dates

Styling was rebuilt on Notion's design language: their warm ink `rgb(55, 53, 47)`,
their colour palette, borderless toolbar buttons, tag pills, 33px rows, and the
"+ New" row at the foot of each group.

### What's deliberately left

- **Lag on dependencies** — the `lagDays` field exists; nothing sets it yet.
- **Start-to-start links** — supported by the relaxer, not exposed in the UI.
- **Saved views** — one view today; the `View` shape in section 2 anticipates more.
- **SQLite** — the Mac app writes a JSON file, which is durable and portable.
  SQLite only starts paying off in the thousands of items.
- **Code signing** — the bundle is unsigned, so the first launch needs
  right-click → Open. Signing needs a paid Apple Developer account.
