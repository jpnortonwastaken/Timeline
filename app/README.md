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
| `src/lib/tree.ts` | Flattens items into visible rows: lanes, hierarchy, search, parent span roll-up |
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

## Dragging the window

The toolbar carries `data-tauri-drag-region="deep"`. **`-webkit-app-region: drag`
does nothing here** — it's a Chromium property, and the Mac app runs on
WKWebView, so the CSS approach silently fails. Tauri injects its own
`drag.js` which walks the composed path looking for that attribute; `"deep"`
makes the whole subtree draggable while the walker automatically bails on
`A / BUTTON / INPUT / SELECT / TEXTAREA / LABEL / SUMMARY`, anything
contenteditable, anything with a real `tabindex`, and any interactive ARIA role.
So every control in the bar keeps working without needing opt-outs.

Double-clicking a drag region zooms the window, which macOS users expect.

## The traffic lights

`titleBarStyle: "Overlay"` leaves the window buttons where macOS puts them —
centered 14pt from the window top — which is well above the middle of a 45px
toolbar. `trafficLightPosition` moves them, but its `y` is not a coordinate:
tao's `inset_traffic_lights` resizes the titlebar container to
`buttonHeight + y` anchored at the window top and leaves the buttons at their
original offset from the container's *bottom*. Working that through:

```
centerFromTop = y + buttonHeight - 14
```

AppKit's window button view is 12pt tall, so `y = 24.5` centers them in a 45px
toolbar. The frame's top inset is then `y - 8 = 16.5`, and `x` is a plain left
inset, so `x: 16.5` gives equal spacing on the left and top.

If you change the toolbar height, recompute `y` from the formula. AppKit's own
default `x` is `7`, which looks too tight once the buttons move down.

## Scrolling

WebKit locks a trackpad gesture to whichever axis dominates, so diagonal
panning is impossible with native scrolling — which is why this feels different
from Notion, whose desktop app is Electron/Chromium. The wheel handler therefore
takes over: it reads both deltas off the event and applies them itself.
Momentum survives because macOS keeps delivering wheel events through the
inertia phase; we're only choosing where they land.

## Zoom

`pixelsPerDay` is a continuous float from 0.05 (a 110-year life on one screen) to
90 (a fat day column). The header tiers are *derived* from it rather than picked
from a menu — see `tierFor()`. Zoom is anchored at the cursor: the date under the
pointer stays put, which is what makes it feel right.

## Dependencies

Drag the `○` on either end of a bar onto another bar. Dragging from the right
port means "this blocks that"; from the left port, "this waits for that".
Click any arrow to remove it. Cycles are rejected at creation.

Arrows are orthogonal polylines run through `roundedPolyline()`, which replaces
each corner with a quadratic curve. The radius is clamped to half the shorter
adjoining segment, so a tight elbow degrades into a smaller curve rather than
overshooting and doubling back. Tune `DEP_STUB` / `DEP_BACK` / `DEP_RADIUS` at
the top of `Timeline.tsx` to change how the routing looks.

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
8. **A date picker that follows precision** — pick a day, a month, a quarter or
   a year from the grid that matches how sure you actually are.

## Keyboard

Every control in the top bar has a binding, and each button's `title`
advertises it — if you add a toolbar button, add the shortcut too.

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
| `⌘\` | Show / hide the table |
| `⌘,` | Settings |
| `1`–`6` | Zoom preset: day, week, month, quarter, year, decade |
| `⌘=` / `⌘-` | Zoom |
| `⌘`+scroll, pinch | Zoom at cursor |
| drag empty canvas | Marquee-select |
| `⇧` drag empty canvas | Add to the selection |
| `⌘` drag empty canvas | Drag out a new item |
| double-click empty canvas | New item there |
| `⌥` drag | Ignore snapping |
| `⇧` drag a bar | Move it with its children |
| drag the row grip | Reorder or nest |
| drag a bar vertically | Move it to another row (dates untouched) |
| right-click | Context menu: duplicate, sub-item, color, delete |
| `⌘D` | Duplicate selection |

## The table column

It collapses to zero from the toolbar, and the width you'd set is remembered.
Collapsing is implemented as `sidebarWidth = 0` rather than a separate mode, so
every downstream calculation — sticky offsets, tick culling, drag maths — keeps
working untouched. `box-sizing: border-box` can't shrink a box below its own
padding and border, so the collapsed cells also get `padding: 0; border: 0`,
otherwise a 15px sliver stays behind.

Column widths are fixed so the header and cells line up, which means a narrow
table would let them overflow onto the canvas. `fitColumns()` drops the ones
that don't fit (header and rows share it, so they can't disagree), and
`overflow: hidden` on the cell is the backstop for anything mid-resize.

## Lanes

Lanes are the only grouping — the old `groupBy` (lane/status/none) is gone, along
with its branches in `flatten`, which also removed the `tree.ts` → `store.ts`
import and with it a circular dependency.

Create one from the `+ New lane` row at the foot of the list or the lane
context menu; rename, recolour and delete from that same menu. New lanes are
created *pre-named* rather than blank: `setEditingLane` targets a row, and if
that row happens not to be mounted the editor never opens — a blank name would
then strand an invisible lane.

`No lane` is synthetic, with no `Lane` record, so its collapse state lives on
the store as `noLaneCollapsed` rather than on the lane. That is why its chevron
used to do nothing.

## The toolbar at small widths

The bar sheds controls as it narrows, and it decides what to shed by
**measuring**, not by width breakpoints. It renders the richest layout, checks
whether the centre group collides with either side, and steps down a tier until
it clears. Any width change resets to tier 0 so the bar fills back out again.

Two reasons not to use breakpoints. The Mac app's traffic-light padding eats
92px, so every threshold would need a second value; and because the centre group
is truly centred, the layout needs `centre + 2 x widestSide` — meaning trimming
the *right* side buys twice what trimming the centre does, and trimming the left
buys nothing at all while the right side is wider. Hand-computed numbers got
that wrong on the first attempt.

One gotcha in the reset: `setTier(0)` when the tier is already 0 is a no-op, so
React skips the render and the measuring effect never runs. It needs a separate
counter to force the render.

The title is never shed — it's the app's identity, and it costs nothing anyway:
the left track only constrains the layout once it's wider than the right, and
the right never drops below icon-search + settings + sidebar.

Search collapses to an icon rather than shrinking, and opening it hides the
centre group so the field gets full width. Its `min-width` is what *forces* the
tier step — dropping it to 0 lets the field squeeze to nothing instead, which
looks far worse than either state. It closes on an outside press rather than on
blur: focus events don't fire while the window itself is unfocused.

## Jumping

`goToDay` animates `scrollLeft` itself rather than using `behavior: 'smooth'`,
whose duration grows with the distance travelled. At day zoom a jump can be
half a million pixels, which native smooth scrolling crawls through — this stays
between 220ms and 520ms however far it goes. Any wheel or pointer input aborts
the animation so a manual scroll always wins.

## Off-screen blocks

Rows whose bar is entirely off the canvas get a small marker pinned to the edge
it went off, with the item's title; clicking it selects the item and scrolls to
where the block starts.

The markers are positioned by a zero-size `position: sticky` anchor rather than
by arithmetic on `scrollLeft`, so they can't drift if scroll state is a frame
behind. Which rows get one is still computed from the visible range, but being
one frame stale there is invisible.

That anchor needs its own `z-index`. `position: sticky` **always** creates a
stacking context, so without one the markers' `z-index` is scoped inside the
wrapper and the rows paint straight over them — they stay visible but stop
being clickable.

## Tree guides in the table

Indentation alone reads poorly past one level, so each row draws file-tree
connectors: a vertical line per ancestor column and an elbow into the parent
(`└` for a last child, `├` otherwise).

The drag grip sits ahead of the guides at every depth, so the handles line up in
one column down the left edge. It also supplies the leading offset, which is why
the guide cells inset their line by 9px: that lands each child's vertical exactly
on the centre of its parent's twisty, giving a clean 20px ladder
(33 -> 53 -> 73 -> 93). The corner is a rounded border box (`border-left` +
`border-bottom` + `border-bottom-left-radius`) rather than two straight rules,
so the line turns into the row instead of meeting it at a hard angle.

`flatten` computes two fields for this. `isLast` picks the elbow shape, and
`trail` holds one boolean per *pass-through* column — so `trail[i]` maps
straight onto indent cell `i`. Its length is `depth - 1`, not `depth`, because
the final cell is the elbow.

That off-by-one is the whole subtlety. The line in column `i` belongs to the
ancestor whose *siblings* live in that column, which is one level deeper than
the ancestor at index `i` would suggest. Getting it wrong looks fine at depth 1
and only breaks at depth 2, where a parent with later siblings loses its
pass-through line.

## Showing nesting on the canvas

The table column shows nesting with indent and a twisty, but the canvas had no
cue at all — a child block looked exactly like one that merely sat below its
neighbour. Nested rows now get a faint tint plus a soft inset shadow, so they
read as a recessed well.

The shadow is only drawn on the **first and last row of each nested run**
(`nestTop` / `nestBottom`, computed in a pass over the flattened rows). Shading
every child would put a line between siblings, which reads as a divider rather
than as one container.

The rules are declared before `:hover` and `.selected` so those still win on the
background, and the sticky table cell is opaque and painted above, so the
shading only shows on the canvas — exactly where the cue was missing.

## Expanding and collapsing

Toggling a twisty fades the affected rows and glides everything below into
place over `--reveal` (190ms). Three things make it work, and each of them is
a trap worth knowing about.

**The transition cannot be gated behind a class.** The obvious shape is
`.layer.revealing .row { transition: top ... }`, switched on while an
animation is in flight. It does not fire. The class is added by a
layout-effect re-render, which happens *after* React has already committed
the new `top` values - so the transition becomes live only once there is
nothing left to animate. `.row` carries the transition unconditionally
instead, which is order-independent. It costs nothing when idle: `top` is
derived from the absolute row index, so it never changes on scroll, only when
the list actually reshapes.

**No `transform`, anywhere in the reveal.** `.side` is `position: sticky`
inside every row. A transformed ancestor becomes its containing block and
detaches the pinned table column for the length of the animation. `top` and
`opacity` do the same job and leave sticky alone.

**Rows that leave have to outlive the state change.** A collapsing subtree is
gone from `flatten()` the instant the store updates, so `Timeline` keeps a
copy of the departing rows (`Reveal.exit`) mounted at their old `y` until the
fade ends. Those copies render with `ghost`, which drops `data-item-id`,
`data-bar-id` and `data-row-index` - otherwise `querySelector('[data-bar-id]')`
in the drag path could pick a fading ghost over the real bar. They are culled
to the viewport, so collapsing a large subtree doesn't mount hundreds of
throwaway rows.

Dependency arrows and jump markers are positioned from `index * rowH`, so
they jump to their final geometry the moment the list changes, while the bars
they point at are still moving. They are hidden outright for the duration
(instantly, so no wrong frame is ever painted) and faded back in once the
rows settle.

Testing this in the preview pane is miserable: a hidden page freezes CSS
transitions mid-flight and never finishes them, so a stale transition leaves
`getComputedStyle().top` disagreeing with `style.top` and the *next* toggle
looks like it silently failed to animate. Flush with
`el.getAnimations().forEach(a => a.finish())` before measuring anything.

## Beware bare class names

Three bugs so far have come from a generic class matching something it was
never meant to. `.tick` (header cell) caught a menu checkmark; `.icon` (SVG
sizing) caught square icon buttons; and `.col` - the table's column *cell*,
which carries `height: 100%` and a left border - caught the detail panel's
`className="field col"`, stretching the notes field to the panel's full
height and leaving a screenful of dead space under it. The panel modifier is
now `.field.stack`.

When a style looks inexplicable, dump the *matched rules* rather than reading
computed values: computed style tells you the number, not who set it.

```js
[...document.styleSheets].flatMap(s => [...s.cssRules])
  .filter(r => r.selectorText && el.matches(r.selectorText))
```

Related: `.field-label` is `flex: 0 0 62px`, which is a column *width* in a row
field but becomes a 62px *height* in a stacked one. `.field.stack` resets it.

## Popovers and panels

Entry animations are free - a CSS animation runs on mount. Leaving is the
problem: React unmounts the node the moment the flag flips, so there is
nothing left to animate. `usePresence(open, ms)` in `lib/presence.ts` holds
the node for `ms` with a `leaving` flag, then drops it. The `ms` must match
the exit keyframes, or the node is pulled out from under a half-played
animation.

The context menu is the awkward one: its data lives in `Timeline`, which sets
`menu` to null on close. `lastMenu` keeps the previous value so the popover
still has something to render on the way out.

## Creating from a "+ New" row

Hovering one moves its dashed preview to the snapped day under the cursor, so
the block starts where you press rather than at a fixed date you then have to
drag it away from. `left` is transitioned, because days snap and the preview
would otherwise hop between whole units.

The press itself is a `create` drag: release without moving for a
`DEFAULT_DAYS` block, or drag to size it. Both paths run through the same
commit as a canvas create.

Two traps in that:

- `pointerup` has an `if (!d.moved) return` guard, on the reasoning that a
  press that never moved is only a click. That guard runs *before* the create
  branch, so click-to-create silently did nothing. `createCtx.defaultDays`
  marks the gestures allowed through it - it stays null for canvas creates,
  where a click really must leave nothing behind.
- The preview's `left` starts life as a React style prop. Mutating it during
  hover means React will not put it back: its diff compares against previous
  props, not the DOM, so the value looks unchanged and is never rewritten.
  `resetNewPreview()` restores it by hand when the pointer leaves.

## Vertical drags

Two gestures move a block up or down: the grip, and dragging the bar itself
once the axis locks to y. Both offer the same three targets - above, below, or
nested inside - split by where in the hovered row the pointer sits (<0.3,
>0.7, else child). `showDropTarget()` owns that split, the indicator, and the
tooltip, so the two gestures can't drift apart.

Nesting inside is a filled row (`.drop-into`); above/below is a line
(`.drop-line`). Different shapes on purpose: a line reads as "between", a fill
reads as "into".

`reorderItem` already refuses to drop a branch inside itself, but silently -
so the gesture checks the same thing up front and says
"Can't nest inside itself" rather than offering a target that will do nothing.

## Never animate `transform` on the detail panel

The panel holds three `position: fixed` popovers - the Lane and Status
pickers and the two date pickers - which position themselves from
`getBoundingClientRect()`, i.e. in viewport coordinates.

An element with a transform becomes the containing block for its fixed
descendants, and that includes an element whose transform animation has
merely *finished* while filling (`animation-fill-mode: both`), even though
the computed value is back to `none`. Giving `.detail` a slide-in animation
therefore re-anchored every popover to the panel instead of the viewport:

    panel at x=776 + field at x=857  ->  popover rendered at x=1634

which is off the right edge of the window, so clicking a dropdown appeared to
do nothing at all. The panel is deliberately unanimated now. If it ever needs
one, animate `opacity` only, or move the popovers to a portal outside it.

Same family as the `overflow: hidden` and sticky traps above: a containing
block appearing where you didn't expect one.

## Bar edges

The resize grips and the dependency ports are both scoped to their own hover
zone rather than the whole bar or row - showing every affordance at once made a
hovered block look like a control panel. Each grip lives in a 9px edge zone;
each port has a 22px invisible target sitting just clear of that zone, with the
visible dot drawn by a pseudo-element so "near enough" reveals it.

Hovering or dragging an edge also drops a full-height guide with the date on it,
so a block's start or end can be lined up against the others. Grabbing an edge
deliberately does *not* select the block - swapping the detail panel out from
under you mid-drag was worse than useless.

## Dragging bars vertically

A bar drag is two-dimensional: horizontal changes the dates, vertical moves the
item to another row. Because snapping is *absolute* (bars align to week or month
boundaries depending on zoom), a purely vertical drag would otherwise pull the
date onto the nearest boundary — so the date is only recomputed once the pointer
has actually moved sideways.

## Not built yet

Lag on dependencies (the field exists, nothing sets it), start-to-start links in
the UI, saved views, and SQLite instead of a JSON file. The data model is
versioned (`version: 1`) so migrations stay possible.
