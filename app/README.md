# Timeline

A timeline for planning projects and a whole life on the same canvas. Notion's
timeline view as a starting point, with the annoying parts fixed.

```bash
npm run dev
```

```bash
npm run tauri dev
```

The first runs it in a browser; the second runs the Mac app. `npm run tauri build`
produces `src-tauri/target/release/bundle/macos/Timeline.app` and a `.dmg`.

## Where things live

| File | What it does |
|---|---|
| `src/lib/time.ts` | The spine. Day-number ↔ pixel mapping, header tiers, unit arithmetic, snapping |
| `src/lib/tree.ts` | Flattens items into visible rows: hierarchy, grouping, search, parent span roll-up |
| `src/lib/deps.ts` | Dependency relaxation (the cascade) and cycle detection |
| `src/components/Timeline.tsx` | Scroller, header, virtualization, zoom, every drag interaction |
| `src/components/Row.tsx` | One row: sticky sidebar cell + bar/milestone |
| `src/components/Minimap.tsx` | The overview strip |
| `src/store.ts` | Zustand store, undo/redo, persistence |
| `src/lib/tauri.ts` | Mac-app-only bits: file backup, native menu events |
| `src-tauri/src/lib.rs` | The macOS menu bar |
| `src/styles.css` | Everything visual, including both themes |

## How the layout works

There is exactly **one scroll container** (`.scroller`). The header and the left
properties table are not separate panes synced by JavaScript — they're
`position: sticky` inside that container (`top: 0` for the header, `left: 0` for
each row's sidebar cell). The browser keeps them aligned, so there is zero
scroll-sync jank.

Three consequences worth knowing:

- **Never put `overflow: hidden` on an ancestor of a sticky element.** It turns
  that ancestor into the sticky element's scrollport and silently kills the
  stickiness. This bit the year labels once; `.tick` has no overflow rule now.
- **Bar labels are sticky too** (`left: sidebarWidth + 8`), which is what keeps a
  long bar's title readable when its start has scrolled off to the left. Free,
  no scroll listener. When a bar is narrower than 46px the label moves outside it
  instead, so nothing is anonymous at decade zoom.
- Only visible rows render, and only visible header ticks are generated.

## How dragging stays at 60fps

Drag handlers never touch the store while the pointer is down. They mutate the
dragged element's `style.transform` / `left` / `width` directly, so nothing
re-renders. The store is written once on `pointerup`, which also means one undo
entry per drag rather than one per frame.

Two gotchas that cost real debugging time:

- Anything mutated directly gets **reset to its original value** before
  committing, so React's virtual DOM record stays truthful.
- `setPointerCapture` **retargets every subsequent pointer event to the capture
  element**, so `e.target` is useless mid-drag. Modes that need to know what's
  under the cursor (linking, reordering) use `document.elementFromPoint` —
  see `hitRowAt`.

## The traffic lights

`titleBarStyle: "Overlay"` leaves the window buttons where macOS puts them —
centred 14pt from the window top — which is 8.5pt above the centre of a 45px
toolbar. `trafficLightPosition` fixes that, but its `y` is not a coordinate:
tao's `inset_traffic_lights` resizes the titlebar container to
`buttonHeight + y` anchored at the window top and leaves the buttons at their
original offset from the container's *bottom*, so the net shift is
`y + buttonHeight - 28`.

For a centre at `toolbarHeight / 2`, that means:

```
y = toolbarHeight / 2 + buttonHeight - 14
```

With a 45px toolbar and AppKit's 14pt button view: `y = 22.5`. If you change the
toolbar height, recompute it. `x: 7` is AppKit's own default close-button origin,
so the horizontal placement is untouched.

## Zoom

`pixelsPerDay` is a continuous float from 0.05 (a 110-year life on one screen) to
90 (a fat day column). The header tiers are *derived* from it rather than picked
from a menu — see `tierFor()`. Zoom is anchored at the cursor: the date under the
pointer stays put, which is what makes it feel right.

## Dependencies

Drag the `○` on either end of a bar onto another bar. Dragging from the right
port means "this blocks that"; from the left port, "this waits for that".
Click any arrow to remove it. Cycles are rejected at creation.

With **Auto-shift dependents** on (View menu, default), moving anything runs
`relax()` in `lib/deps.ts`: a bounded relaxation pass that pushes successors
forward until every gap is satisfied. It only ever moves things *later* —
dragging work earlier because a predecessor moved back is rarely what anyone
means. Moving a parent takes its whole subtree along.

Because relaxation is global, it also repairs violations elsewhere in the graph
the first time it runs. That converges after one pass and is intentional.

## Storage

The browser build persists to `localStorage` under `timeline.v1`, 400ms after any
change. The Mac app writes the same JSON to `timeline.json` in the app data
directory as well, and restores from it if the WebView store ever comes up empty.
Export/import JSON from the View menu or File menu.

Old `linea.v1` data is still read once, for continuity with the earlier name.

## Deliberately different from Notion

1. **Nothing is collapsed by default.** Expansion is per item and defaults to
   open. `E` / `⇧E` expands or collapses everything.
2. **Decade zoom**, so "learn to sail" and "Tuesday's dentist appointment" can
   coexist on one canvas.
3. **Fuzzy dates.** Every date carries a `precision` (`day` → `year`). Anything
   coarser than a day renders hatched and dashed, so "sometime in 2031" never
   looks as certain as "Nov 3–7".
4. **The properties table is a real pane**, not a toggle that resets. Drag the
   divider; double-click it to reset.
5. **Labels stay readable at every zoom.**
6. **Parent bars roll up** from their children, and dragging a rolled-up parent
   moves the whole subtree.
7. **An overview strip** spanning everything you have, at its own scale,
   independent of the canvas zoom.

## Keyboard

| | |
|---|---|
| `T` | Jump to today |
| `E` / `⇧E` | Expand all / collapse all |
| `N` | New item at today |
| `Enter` | Rename selected |
| `↑` `↓` | Move selection |
| `⌥←` `⌥→` | Nudge dates by one snap unit |
| `Tab` / `⇧Tab` | Indent / outdent |
| `⌫` | Delete selection |
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| `⌘F` | Search |
| `⌘=` / `⌘-` | Zoom |
| `⌘`+scroll, pinch | Zoom at cursor |
| drag empty canvas | Create an item |
| `⇧`/`⌘` drag empty canvas | Marquee-select |
| `⌥` drag | Ignore snapping |
| `⇧` drag a bar | Move it with its children |
| drag the row grip | Reorder or nest |

## Not built yet

Lag on dependencies (the field exists, nothing sets it), start-to-start links in
the UI, saved views, and SQLite instead of a JSON file. The data model is
versioned (`version: 1`) so migrations stay possible.
