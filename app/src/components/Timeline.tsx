import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { descendants, flatten } from '../lib/tree'
import type { Row as TreeRow, Span } from '../lib/tree'
import type { Unit } from '../lib/time'
import type { ItemId } from '../types'
import {
  clampPpd,
  dayToIso,
  dayToX,
  formatDate,
  formatSpan,
  isoToDay,
  snapDay,
  ticks,
  tierFor,
  todayDay,
  totalWidth,
  xToDay,
} from '../lib/time'
import { cmd, COLUMN_WIDTH, DENSITY_HEIGHT, fitColumns, HEADER_HEIGHT, TIER_HEIGHT } from '../lib/viewport'
import { TimelineRow } from './Row'
import { ContextMenu } from './ContextMenu'
import { POP_OUT_MS, usePresence } from '../lib/presence'
import type { MenuState } from './ContextMenu'

const OVERSCAN_PX = 400
const OVERSCAN_ROWS = 6
/**
 * Extra rows kept mounted *below* the fold.
 *
 * Collapsing pulls rows up from below, and a row can only glide to its new
 * position if it was already on screen - one that mounts fresh has no previous
 * position to animate from. With only six rows of slack, collapsing anything
 * larger than a small subtree closed the gap with a jump, because everything
 * that should have slid up was still unmounted. Deep plans collapse whole
 * branches at once, so the slack below has to cover that.
 */
const OVERSCAN_BELOW = 60
/** Keep in step with --reveal in styles.css. */
const REVEAL_MS = 240
/** Length of a block made by clicking rather than dragging one out. */
const DEFAULT_DAYS = 7

interface Reveal {
  /** Keys of rows that just appeared, so they fade in. */
  enter: Set<string>
  /** Rows that just left, held at their old y until the fade finishes. */
  exit: { row: TreeRow; top: number }[]
  /** Wells that just appeared, so they grow open instead of popping. */
  enterWells: Set<string>
  /** Wells that just left, held on screen to shrink closed. */
  exitWells: Well[]
}

/** One contiguous recessed region - a run of rows nested at >= its depth. */
interface Well {
  key: string
  start: number
  end: number
  depth: number
}

const rowDepth = (r: TreeRow) => (r.kind === 'item' || r.kind === 'new' ? r.depth : 0)

/**
 * The nesting wells, one element per run rather than painted per row. A
 * per-row wash can only fade with its row; a single element's `top` and
 * `height` can transition, so the well grows and shrinks in step with the
 * rows gliding around it. Keyed by the first row of the run, so a run that
 * merely gains or loses rows keeps its element - that persistence is what
 * makes the height glide instead of remount.
 */
function computeWells(rows: TreeRow[]): Well[] {
  const out: Well[] = []
  const open: { start: number; key: string }[] = []
  rows.forEach((r, i) => {
    const d = rowDepth(r)
    while (open.length > d) {
      const run = open.pop()!
      out.push({ key: run.key, start: run.start, end: i - 1, depth: open.length + 1 })
    }
    while (open.length < d) {
      open.push({ start: i, key: r.key + ':' + (open.length + 1) })
    }
  })
  while (open.length) {
    const run = open.pop()!
    out.push({ key: run.key, start: run.start, end: rows.length - 1, depth: open.length + 1 })
  }
  return out
}

type Mode = 'move' | 'start' | 'end' | 'create' | 'link' | 'marquee' | 'reorder' | 'new-lane' | 'lane'

interface Drag {
  mode: Mode
  ids: string[]
  els: HTMLElement[]
  primary: HTMLElement | null
  anchorDay: number
  origStart: number
  origEnd: number
  origLeft: number
  origWidth: number
  snapUnit: Unit
  startClientX: number
  startClientY: number
  moved: boolean
  finalStart: number
  finalEnd: number
  ghost: HTMLElement | null
  /** Translucent stand-in that follows the pointer on a vertical drag. */
  copy: HTMLElement | null
  /** Pointer-to-copy-top offset, so the copy doesn't jump under the cursor. */
  copyDy: number
  /** Where a lane's menu should open if the press turns out not to be a drag. */
  menuAt: { x: number; y: number } | null
  /** Canvas scroll at press time. Dates follow the pointer's position over the
      *content*, so any scrolling during the gesture counts as movement too. */
  startScrollLeft: number
  /** Last pointer position, so an auto-scroll frame can re-run the drag
      without a pointer event to trigger it. */
  lastClientX: number
  lastClientY: number
  lastAlt: boolean
  createCtx: {
    laneId: string | null
    parentId: string | null
    /** Non-null when a press without a drag should still create. */
    defaultDays: number | null
  } | null
  /** link mode */
  linkFrom: string | null
  linkDir: 'in' | 'out'
  linkTarget: string | null
  /** reorder mode, and vertical dragging of a bar */
  dropTarget: { id: string; position: 'before' | 'after' | 'child' } | null
  sourceIndex: number
  /** Locked once at the start of a bar drag: dates or rows, never both. */
  axis: 'x' | 'y' | null
  /** Selection to union with, when a marquee is additive. */
  baseSelection: string[]
  /** Last selection pushed while sweeping, so we only re-render on a change. */
  lastHits: string
}

type Pt = [number, number]

/**
 * Turn an orthogonal polyline into a path with rounded corners.
 *
 * The radius at each corner is clamped to half of the shorter adjoining
 * segment, so a tight elbow degrades gracefully into a smaller curve instead
 * of overshooting and doubling back on itself.
 */
function roundedPolyline(pts: Pt[], radius: number): string {
  const p = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1])
  if (p.length < 2) return ''

  let d = `M${p[0][0]},${p[0][1]}`
  for (let i = 1; i < p.length - 1; i++) {
    const [px, py] = p[i - 1]
    const [cx, cy] = p[i]
    const [nx, ny] = p[i + 1]
    const inLen = Math.hypot(cx - px, cy - py) || 1
    const outLen = Math.hypot(nx - cx, ny - cy) || 1
    const r = Math.min(radius, inLen / 2, outLen / 2)
    d += `L${cx - ((cx - px) / inLen) * r},${cy - ((cy - py) / inLen) * r}`
    d += `Q${cx},${cy} ${cx + ((nx - cx) / outLen) * r},${cy + ((ny - cy) / outLen) * r}`
  }
  const last = p[p.length - 1]
  return d + `L${last[0]},${last[1]}`
}

/** How far the line runs straight out of a bar before it turns. */
const DEP_STUB = 15
/** How far left of the target it comes back when routing around. */
const DEP_BACK = 22
/** Maximum corner radius; the clamp above shrinks it where there's no room. */
const DEP_RADIUS = 14
/** Gap left for the arrowhead. */
const DEP_HEAD = 7

/** An empty drag record; each mode fills in only the fields it needs. */
const blank = (e: { clientX: number; clientY: number }): Drag => ({
  mode: 'move',
  ids: [],
  els: [],
  primary: null,
  anchorDay: 0,
  origStart: 0,
  origEnd: 0,
  origLeft: 0,
  origWidth: 0,
  snapUnit: 'day',
  startClientX: e.clientX,
  startClientY: e.clientY,
  moved: false,
  finalStart: 0,
  finalEnd: 0,
  ghost: null,
  copy: null,
  copyDy: 0,
  menuAt: null,
  startScrollLeft: 0,
  lastClientX: e.clientX,
  lastClientY: e.clientY,
  lastAlt: false,
  createCtx: null,
  linkFrom: null,
  linkDir: 'out',
  linkTarget: null,
  dropTarget: null,
  sourceIndex: 0,
  axis: null,
  baseSelection: [],
  lastHits: '',
})

const COLUMN_LABELS: Record<string, string> = {
  status: 'Status',
  dates: 'Date',
  span: 'Span',
}

/**
 * How far a milestone's marker reaches from its centre, in px.
 *
 * A milestone is drawn centred on its day, unlike a bar which starts on it. Its
 * marker is a square inset 19% of the bar height and rotated 45deg (see
 * `.milestone::before`), so the horizontal reach is half the rotated square's
 * diagonal. Keep in step with that CSS rule.
 */
function milestoneReach(rowH: number) {
  const barTop = Math.round(rowH * 0.13)
  const barH = rowH - barTop * 2
  return barH * 0.62 * Math.SQRT1_2
}

/** Spans a live drag is overriding, keyed by item. */
type SpanOverride = Map<ItemId, { startDay: number; endDay: number }>

interface DepGeom {
  deps: ReturnType<typeof useStore.getState>['deps']
  geo: Map<ItemId, { index: number; span: Span }>
  ppd: number
  sidebarWidth: number
  rowH: number
  scrollLeft: number
  viewW: number
  firstRow: number
  lastRow: number
  /** Set while dragging, so arrows track the bar instead of waiting for the
      store commit on pointerup. */
  override?: SpanOverride
}

function buildDepPaths(g: DepGeom): { id: string; d: string; head: string; cx: number; cy: number }[] {
  const { ppd, sidebarWidth, rowH, firstRow, lastRow } = g
  const xLo = g.scrollLeft - sidebarWidth - OVERSCAN_PX
  const xHi = g.scrollLeft + g.viewW - sidebarWidth + OVERSCAN_PX
  const out: { id: string; d: string; head: string; cx: number; cy: number }[] = []
  const spanOf = (id: ItemId, base: Span) => g.override?.get(id) ?? base

  for (const dep of Object.values(g.deps)) {
    const a = g.geo.get(dep.fromId)
    const b = g.geo.get(dep.toId)
    if (!a || !b) continue
    if (a.index < firstRow - 40 && b.index < firstRow - 40) continue
    if (a.index > lastRow + 40 && b.index > lastRow + 40) continue

    const aSpan = spanOf(dep.fromId, a.span)
    const bSpan = spanOf(dep.toId, b.span)
    // Milestone-ness comes from the stored span: a drag changes dates, never
    // whether the block is a point in time.
    const reach = milestoneReach(rowH)
    // A bar ends at the day boundary after its last day; a milestone has no
    // width in days, so leaving from `endDay + 1` puts the arrow a whole day's
    // pixels to the right of the marker. Leave from its right vertex instead.
    const fromX = a.span.milestone
      ? dayToX(aSpan.startDay, ppd) + reach
      : dayToX(dep.type === 'start-to-start' ? aSpan.startDay : aSpan.endDay + 1, ppd)
    // Likewise arriving: a bar's start day is its left edge, but a milestone's
    // is its centre, so the arrowhead would land inside the marker.
    const toX = b.span.milestone
      ? dayToX(bSpan.startDay, ppd) - reach
      : dayToX(bSpan.startDay, ppd)
    if (Math.max(fromX, toX) < xLo || Math.min(fromX, toX) > xHi) continue

    const x1 = sidebarWidth + fromX
    const x2 = sidebarWidth + toX
    const y1 = (a.index + 0.5) * rowH
    const y2 = (b.index + 0.5) * rowH

    // Standard Gantt elbow; route around when the successor starts too early.
    const tip = x2 - DEP_HEAD
    const direct = tip - x1 > DEP_STUB + 6
    const midY = y1 + (y2 > y1 ? rowH / 2 : -rowH / 2)
    const pts: Pt[] = direct
      ? [
          [x1, y1],
          [x1 + DEP_STUB, y1],
          [x1 + DEP_STUB, y2],
          [tip, y2],
        ]
      : [
          [x1, y1],
          [x1 + DEP_STUB, y1],
          [x1 + DEP_STUB, midY],
          [x2 - DEP_BACK, midY],
          [x2 - DEP_BACK, y2],
          [tip, y2],
        ]

    /*
     * Where the remove button sits: the middle of the connector's longest
     * straight run. On a plain elbow that is the vertical drop between the two
     * rows; on a routed one it is the long horizontal doubling back. A corner
     * would put the button on a curve, and either end would bury it under a bar
     * or an arrowhead.
     */
    const cx = direct ? x1 + DEP_STUB : (x1 + DEP_STUB + x2 - DEP_BACK) / 2
    const cy = direct ? (y1 + y2) / 2 : midY

    out.push({
      id: dep.id,
      d: roundedPolyline(pts, DEP_RADIUS),
      head: `M${tip},${y2 - 4.5} L${x2 - 0.5},${y2} L${tip},${y2 + 4.5} Z`,
      cx,
      cy,
    })
  }
  return out
}

export function Timeline() {
  const scrollerRef = useRef<HTMLDivElement>(null)
  /** Latest applyHorizontal, for the scroll handler to reach. */
  const isDateDragRef = useRef<((d: NonNullable<typeof dragRef.current>) => boolean) | null>(null)
  const applyHorizontalRef = useRef<
    ((d: NonNullable<typeof dragRef.current>, x: number, y: number, alt: boolean) => void) | null
  >(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const depsSvgRef = useRef<SVGSVGElement>(null)
  const headRangeRef = useRef<HTMLDivElement>(null)
  /** The "+ New" row whose preview we last moved, so it can be put back. */
  const hoverNewRef = useRef<HTMLElement | null>(null)
  const guideRef = useRef<HTMLDivElement>(null)
  const edgeLabelRef = useRef<HTMLDivElement>(null)
  const linkPathRef = useRef<SVGPathElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const pendingScrollLeft = useRef<number | null>(null)
  const rafRef = useRef(0)
  const timerRef = useRef(0)
  const animRef = useRef(0)

  const items = useStore((s) => s.items)
  const lanes = useStore((s) => s.lanes)
  const deps = useStore((s) => s.deps)
  const search = useStore((s) => s.search)
  const ppd = useStore((s) => s.ppd)
  const sidebarWidthSetting = useStore((s) => s.sidebarWidth)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const density = useStore((s) => s.density)
  const allColumns = useStore((s) => s.visibleColumns)

  // Collapsing the table is just a zero-width one, so every downstream
  // calculation - sticky offsets, culling, drag maths - works unchanged.
  const sidebarWidth = sidebarOpen ? sidebarWidthSetting : 0
  const columns = useMemo(
    () => (sidebarOpen ? fitColumns(allColumns, sidebarWidth) : []),
    [allColumns, sidebarWidth, sidebarOpen],
  )
  const selection = useStore((s) => s.selection)
  const editingId = useStore((s) => s.editingId)
  const editingLaneId = useStore((s) => s.editingLaneId)
  const noLaneCollapsed = useStore((s) => s.noLaneCollapsed)
  const draftChildren = useStore((s) => s.draftChildren)

  const setPpd = useStore((s) => s.setPpd)
  const select = useStore((s) => s.select)
  const toggleSelect = useStore((s) => s.toggleSelect)
  const setEditing = useStore((s) => s.setEditing)
  const updateItems = useStore((s) => s.updateItems)
  const createItem = useStore((s) => s.createItem)
  const commit = useStore((s) => s.commit)
  const addDep = useStore((s) => s.addDep)
  const removeDep = useStore((s) => s.removeDep)
  const cascade = useStore((s) => s.cascade)
  const reorderItem = useStore((s) => s.reorderItem)
  const reorderLane = useStore((s) => s.reorderLane)
  const createLane = useStore((s) => s.createLane)
  const setEditingLane = useStore((s) => s.setEditingLane)
  const setViewRange = useStore((s) => s.setViewRange)

  const [view, setView] = useState({ scrollTop: 0, scrollLeft: 0, w: 1200, h: 800 })
  const [linkingActive, setLinkingActive] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)

  // Live values for listeners that must not be re-bound on every render.
  const ppdRef = useRef(ppd)
  const sidebarRef = useRef(sidebarWidth)
  const rowHRef = useRef(DENSITY_HEIGHT[density])
  ppdRef.current = ppd
  sidebarRef.current = sidebarWidth
  rowHRef.current = DENSITY_HEIGHT[density]

  const { rows } = useMemo(
    () => flatten({ items, lanes, search, noLaneCollapsed, draftChildren }),
    [items, lanes, search, noLaneCollapsed, draftChildren],
  )

  const rowH = DENSITY_HEIGHT[density]
  const rowsHeight = rows.length * rowH
  const contentWidth = sidebarWidth + totalWidth(ppd)
  /** Rows plus slack, but never less than the viewport - otherwise the grid
      stops mid-air and the page below it reads as a rendering fault. */
  const bodyHeight = Math.max(rowsHeight + 120, view.h - HEADER_HEIGHT)
  const tier = tierFor(ppd)
  const today = todayDay()

  /** Row index + span for every item that's currently in the flattened list. */
  const geo = useMemo(() => {
    const m = new Map<ItemId, { index: number; span: Span }>()
    rows.forEach((r, i) => {
      if (r.kind === 'item' && r.span) m.set(r.id, { index: i, span: r.span })
    })
    return m
  }, [rows])

  const indexById = useMemo(() => {
    const m = new Map<ItemId, number>()
    rows.forEach((r, i) => {
      if (r.kind === 'item') m.set(r.id, i)
    })
    return m
  }, [rows])

  /* ---- expand/collapse reveal ----------------------------------------
     Driven off the disclosure state alone, so the many other things that
     reshape the list - editing, searching, reordering, undo - stay instant
     and keep their direct-style-mutation fast paths.

     Draft lines count as disclosure: opening one on a childless block adds a
     row exactly the way expanding a real parent does, and it should arrive
     the same way rather than popping in. */
  const collapseSig = useMemo(() => {
    const parts: string[] = []
    for (const id in items) if (items[id].collapsed) parts.push(id)
    for (const id in lanes) if (lanes[id].collapsed) parts.push('g:' + id)
    for (const id in draftChildren) parts.push('d:' + id)
    if (noLaneCollapsed) parts.push('g:none')
    return parts.sort().join(',')
  }, [items, lanes, noLaneCollapsed, draftChildren])

  // The menu data outlives `menu` by one exit animation, so the popover has
  // something to render while it fades.
  const menuPresence = usePresence(!!menu, POP_OUT_MS)
  const [lastMenu, setLastMenu] = useState<MenuState | null>(null)
  useEffect(() => {
    if (menu) setLastMenu(menu)
  }, [menu])

  const wells = useMemo(() => computeWells(rows), [rows])
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const prevRowsRef = useRef(rows)
  const collapseSigRef = useRef(collapseSig)
  const revealTimer = useRef(0)

  useLayoutEffect(() => {
    const prev = prevRowsRef.current
    prevRowsRef.current = rows
    if (collapseSigRef.current === collapseSig) return
    collapseSigRef.current = collapseSig

    const before = new Set(prev.map((r) => r.key))
    const after = new Set(rows.map((r) => r.key))
    const enter = new Set(rows.filter((r) => !before.has(r.key)).map((r) => r.key))
    const exit = prev
      .map((row, i) => ({ row, top: i * rowH }))
      .filter((x) => !after.has(x.row.key))

    const prevWells = computeWells(prev)
    const curKeys = new Set(computeWells(rows).map((w) => w.key))
    const prevKeys = new Set(prevWells.map((w) => w.key))
    const enterWells = new Set(
      computeWells(rows)
        .filter((w) => !prevKeys.has(w.key))
        .map((w) => w.key),
    )
    const exitWells = prevWells.filter((w) => !curKeys.has(w.key))
    if (!enter.size && !exit.length && !enterWells.size && !exitWells.length) return

    setReveal({ enter, exit, enterWells, exitWells })
    // A ref rather than effect cleanup: `rows` can change again mid-flight,
    // and a cleanup would cancel the reset and strand ghosts on screen.
    window.clearTimeout(revealTimer.current)
    revealTimer.current = window.setTimeout(() => setReveal(null), REVEAL_MS)
  }, [collapseSig, rows, rowH])

  useEffect(() => () => window.clearTimeout(revealTimer.current), [])
  useEffect(() => () => cancelAnimationFrame(edgeScrollRef.current), [])

  // -- scroll tracking -------------------------------------------------------
  const syncView = useCallback(() => {
    // A bare rAF token can latch: if the window is occluded the callback may
    // never run, and the token then blocks every later sync - scroll position
    // silently freezes at whatever it was. A timeout races the frame so the
    // state can't get permanently stuck; whichever fires first cancels both.
    if (rafRef.current || timerRef.current) return

    const flush = () => {
      cancelAnimationFrame(rafRef.current)
      clearTimeout(timerRef.current)
      rafRef.current = 0
      timerRef.current = 0

      const el = scrollerRef.current
      if (!el) return
      const sw = sidebarRef.current
      // A drag's dates follow the pointer over the *content*, so a scroll is
      // movement even when the pointer is still.
      const drag = dragRef.current
      if (drag?.moved && applyHorizontalRef.current && isDateDragRef.current?.(drag)) {
        applyHorizontalRef.current(drag, drag.lastClientX, drag.lastClientY, drag.lastAlt)
      }

      const rh = rowHRef.current
      setViewRange(
        xToDay(el.scrollLeft, ppdRef.current),
        xToDay(el.scrollLeft + el.clientWidth - sw, ppdRef.current),
        Math.floor(el.scrollTop / rh),
        Math.ceil((el.scrollTop + el.clientHeight - HEADER_HEIGHT) / rh),
      )
      setView((v) =>
        v.scrollTop === el.scrollTop &&
        v.scrollLeft === el.scrollLeft &&
        v.w === el.clientWidth &&
        v.h === el.clientHeight
          ? v
          : {
              scrollTop: el.scrollTop,
              scrollLeft: el.scrollLeft,
              w: el.clientWidth,
              h: el.clientHeight,
            },
      )
    }

    rafRef.current = requestAnimationFrame(flush)
    timerRef.current = setTimeout(flush, 120) as unknown as number
  }, [setViewRange])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const ro = new ResizeObserver(syncView)
    ro.observe(el)
    syncView()
    return () => ro.disconnect()
  }, [syncView])

  // -- commands --------------------------------------------------------------
  /** Abort any in-flight jump, so a manual scroll always wins. */
  const stopScrollAnimation = useCallback(() => {
    cancelAnimationFrame(animRef.current)
    animRef.current = 0
  }, [])

  /**
   * Animate scrollLeft ourselves rather than using `behavior: 'smooth'`, whose
   * duration grows with distance - at day zoom a jump can be hundreds of
   * thousands of pixels, which native smooth scrolling would crawl through.
   * This stays between 220ms and 520ms however far it travels.
   */
  const animateScrollLeft = useCallback(
    (to: number) => {
      const el = scrollerRef.current
      if (!el) return
      stopScrollAnimation()
      const from = el.scrollLeft
      const delta = to - from
      if (Math.abs(delta) < 1) return

      const duration = Math.min(520, Math.max(220, Math.abs(delta) * 0.35))
      const start = performance.now()
      const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration)
        el.scrollLeft = from + delta * easeOutCubic(t)
        animRef.current = t < 1 ? requestAnimationFrame(step) : 0
      }
      animRef.current = requestAnimationFrame(step)
    },
    [stopScrollAnimation],
  )

  const goToDay = useCallback(
    (day: number, align = 0.32, smooth = true) => {
      const el = scrollerRef.current
      if (!el) return
      const sw = sidebarRef.current
      const left = Math.max(0, dayToX(day, ppdRef.current) - (el.clientWidth - sw) * align)
      if (smooth) {
        animateScrollLeft(left)
      } else {
        stopScrollAnimation()
        el.scrollLeft = left
      }
    },
    [animateScrollLeft, stopScrollAnimation],
  )

  const zoom = useCallback(
    (next: number, anchorClientX?: number) => {
      const el = scrollerRef.current
      if (!el) return
      const cur = ppdRef.current
      const nextPpd = clampPpd(next)
      if (Math.abs(nextPpd - cur) < 1e-9) return
      const sw = sidebarRef.current
      const rect = el.getBoundingClientRect()
      // Never anchor at a point hidden under the sticky sidebar.
      const ax =
        anchorClientX != null
          ? Math.max(anchorClientX - rect.left, sw)
          : sw + (el.clientWidth - sw) / 2
      const day = xToDay(el.scrollLeft + ax - sw, cur)
      pendingScrollLeft.current = Math.max(0, dayToX(day, nextPpd) + sw - ax)
      setPpd(nextPpd)
    },
    [setPpd],
  )

  useLayoutEffect(() => {
    if (pendingScrollLeft.current != null && scrollerRef.current) {
      scrollerRef.current.scrollLeft = pendingScrollLeft.current
      pendingScrollLeft.current = null
      syncView()
    }
  }, [ppd, syncView])

  useEffect(() => () => cancelAnimationFrame(animRef.current), [])

  useEffect(() => {
    cmd.zoom = zoom
    cmd.goToDay = goToDay
    cmd.revealRow = (index) => {
      const el = scrollerRef.current
      if (!el) return
      const y = index * rowH
      const visibleBottom = el.scrollTop + el.clientHeight - HEADER_HEIGHT
      if (y < el.scrollTop) el.scrollTo({ top: y - 8, behavior: 'smooth' })
      else if (y + rowH > visibleBottom)
        el.scrollTo({ top: y + rowH - (el.clientHeight - HEADER_HEIGHT) + 8, behavior: 'smooth' })
    }
    cmd.scrollToRow = (row) => {
      const el = scrollerRef.current
      if (!el) return
      // Direct, not eased: this follows a pointer, so it has to be exact.
      el.scrollTop = Math.max(0, row * rowH)
    }
    cmd.visibleDays = () => {
      const el = scrollerRef.current
      if (!el) return { from: today, to: today }
      const sw = sidebarRef.current
      return {
        from: xToDay(el.scrollLeft, ppdRef.current),
        to: xToDay(el.scrollLeft + el.clientWidth - sw, ppdRef.current),
      }
    }
  }, [zoom, goToDay, rowH, today])

  // Land on today, but only once the scroller has been measured for real -
  // running this at mount lands in the wrong place if the window then resizes.
  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current || view.w < 2) return
    didInit.current = true
    goToDay(today, 0.28, false)
  }, [goToDay, today, view.w])

  // -- wheel: pinch/cmd zoom, and panning ------------------------------------
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      stopScrollAnimation()
      // Pinch on a trackpad arrives as a wheel event with ctrlKey set.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoom(ppdRef.current * Math.exp(-e.deltaY * 0.0125), e.clientX)
        return
      }

      // WebKit locks a trackpad gesture to whichever axis dominates, so a
      // diagonal swipe only ever moves one way. The deltas themselves carry
      // both axes, so applying them ourselves restores free diagonal panning.
      // Momentum survives because macOS keeps delivering wheel events through
      // the inertia phase - we're just choosing where they land.
      let dx = e.deltaX
      let dy = e.deltaY
      if (e.deltaMode === 1) {
        // DOM_DELTA_LINE, typically a physical mouse wheel.
        dx *= 16
        dy *= 16
      } else if (e.deltaMode === 2) {
        dx *= el.clientWidth
        dy *= el.clientHeight
      }
      // A mouse with no horizontal wheel pans sideways with shift held.
      if (e.shiftKey && dx === 0) {
        dx = dy
        dy = 0
      }
      if (dx === 0 && dy === 0) return

      e.preventDefault()
      el.scrollTo({
        left: el.scrollLeft + dx,
        top: el.scrollTop + dy,
        behavior: 'instant',
      })
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom, stopScrollAnimation])

  // -- visible ranges --------------------------------------------------------
  const { majorTicks, minorTicks } = useMemo(() => {
    const from = Math.floor(xToDay(view.scrollLeft - sidebarWidth - OVERSCAN_PX, ppd))
    const to = Math.ceil(xToDay(view.scrollLeft + view.w - sidebarWidth + OVERSCAN_PX, ppd))
    return {
      majorTicks: ticks(tier.major, from, to, ppd),
      minorTicks: ticks(tier.minor, from, to, ppd),
    }
  }, [view.scrollLeft, view.w, ppd, sidebarWidth, tier.major, tier.minor])

  const firstRow = Math.max(0, Math.floor(view.scrollTop / rowH) - OVERSCAN_ROWS)
  const lastRow = Math.min(rows.length, Math.ceil((view.scrollTop + view.h) / rowH) + OVERSCAN_BELOW)
  const visibleRows = rows.slice(firstRow, lastRow)
  const selectionSet = useMemo(() => new Set(selection), [selection])

  // -- dependency arrows -----------------------------------------------------
  const depGeom: DepGeom = {
    deps,
    geo,
    ppd,
    sidebarWidth,
    rowH,
    scrollLeft: view.scrollLeft,
    viewW: view.w,
    firstRow,
    lastRow,
  }
  const depPaths = useMemo(
    () => buildDepPaths(depGeom),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deps, geo, ppd, sidebarWidth, rowH, view.scrollLeft, view.w, firstRow, lastRow],
  )

  /**
   * Rows whose bar sits entirely off the left or right of the canvas. Computed
   * here rather than in Row so the rows stay memoised - these depend on scroll
   * position, which would otherwise re-render every row on every frame.
   */
  const offscreen = useMemo(() => {
    const viewL = view.scrollLeft + sidebarWidth
    const viewR = view.scrollLeft + view.w
    const out: { id: string; title: string; index: number; left: boolean; day: number }[] = []
    for (let i = firstRow; i < lastRow; i++) {
      const r = rows[i]
      if (r?.kind !== 'item' || !r.span) continue
      const x = sidebarWidth + dayToX(r.span.startDay, ppd)
      const w = Math.max(6, (r.span.endDay + 1 - r.span.startDay) * ppd)
      const off = x + w < viewL ? true : x > viewR ? false : null
      if (off !== null) {
        out.push({ id: r.id, title: r.item.title, index: i, left: off, day: r.span.startDay })
      }
    }
    return out
  }, [rows, firstRow, lastRow, view.scrollLeft, view.w, ppd, sidebarWidth])

  // -- drag helpers ----------------------------------------------------------
  const showTip = (clientX: number, clientY: number, text: string) => {
    const tip = tipRef.current
    if (!tip) return
    tip.textContent = text
    tip.style.display = 'block'
    tip.style.transform = `translate(${clientX + 14}px, ${clientY - 34}px)`
  }
  const hideTip = () => {
    if (tipRef.current) tipRef.current.style.display = 'none'
  }

  /**
   * Vertical rule at a bar edge with its date, for lining a block up against
   * the others. The label flips to the far side for a start edge so it never
   * sits on top of the block it belongs to.
   */
  /** Repaint the arrows against provisional spans, without a React render. */
  const paintDepPaths = (override?: SpanOverride) => {
    const svg = depsSvgRef.current
    if (!svg) return
    const next = new Map(buildDepPaths({ ...depGeom, override }).map((x) => [x.id, x]))
    svg.querySelectorAll<SVGGElement>('g[data-dep-id]').forEach((g) => {
      const nx = next.get(g.dataset.depId!)
      if (!nx) return
      g.querySelector('.dep-path')?.setAttribute('d', nx.d)
      g.querySelector('.dep-hit')?.setAttribute('d', nx.d)
      g.querySelector('.dep-head')?.setAttribute('d', nx.head)
      g.querySelector('.dep-x')?.setAttribute('transform', `translate(${nx.cx},${nx.cy})`)
    })
  }

  /** Spans for whatever the current drag is moving. */
  const dragOverride = (d: NonNullable<typeof dragRef.current>): SpanOverride => {
    const m: SpanOverride = new Map()
    if (d.mode === 'move') {
      const shift = d.finalStart - d.origStart
      for (const id of d.ids) {
        const g = geo.get(id)
        if (g) m.set(id, { startDay: g.span.startDay + shift, endDay: g.span.endDay + shift })
      }
    } else if (d.mode === 'start' || d.mode === 'end') {
      m.set(d.ids[0], { startDay: d.finalStart, endDay: d.finalEnd })
    }
    return m
  }

  const showHeadRange = (startDay: number, endDay: number) => {
    const el = headRangeRef.current
    if (!el) return
    const ppdNow = ppdRef.current
    el.style.display = 'block'
    el.style.left = `${sidebarRef.current + dayToX(startDay, ppdNow)}px`
    el.style.width = `${Math.max(2, (endDay + 1 - startDay) * ppdNow)}px`
    const [from, to] = Array.from(el.children) as HTMLElement[]
    from.textContent = formatDate(dayToIso(startDay))
    // A milestone is a single day; a second label would just repeat it.
    to.textContent = endDay === startDay ? '' : formatDate(dayToIso(endDay))
  }
  const hideHeadRange = () => {
    if (headRangeRef.current) headRangeRef.current.style.display = 'none'
  }

  /**
   * Put a "+ New" row's preview back to its resting day. React set that `left`
   * from a style prop, so it will not rewrite the value we mutated here - the
   * DOM has to be restored by hand or the preview stays wherever it was last
   * dragged to.
   */
  const resetNewPreview = (rowEl: HTMLElement) => {
    const outline = rowEl.querySelector<HTMLElement>('.new-outline')
    const row = rows[Number(rowEl.dataset.rowIndex)]
    if (!outline || row?.kind !== 'new') return
    outline.style.transform = `translateX(${dayToX(row.previewStart, ppdRef.current)}px)`
  }

  const showGuide = (contentX: number, rowIndex: number, text: string, isStart: boolean) => {
    const g = guideRef.current
    if (g) {
      g.style.display = 'block'
      g.style.left = `${contentX}px`
    }
    const l = edgeLabelRef.current
    if (l) {
      l.style.display = 'block'
      l.style.left = `${contentX}px`
      l.style.top = `${rowIndex * rowH + rowH / 2}px`
      l.className = 'edge-label' + (isStart ? ' start' : '')
      l.textContent = text
    }
  }
  const hideGuide = () => {
    if (guideRef.current) guideRef.current.style.display = 'none'
    if (edgeLabelRef.current) edgeLabelRef.current.style.display = 'none'
  }

  const spanLabel = (a: number, b: number, milestone: boolean) =>
    milestone
      ? formatDate(dayToIso(a))
      : `${formatDate(dayToIso(a))} → ${formatDate(dayToIso(b))}  ·  ${formatSpan(b + 1 - a)}`

  /**
   * What's under the cursor right now. Pointer capture retargets every move
   * event to the capture element, so `e.target` is useless mid-drag.
   */
  const hitRowAt = (clientX: number, clientY: number) =>
    (document.elementFromPoint(clientX, clientY)?.closest('[data-item-id]') ??
      null) as HTMLElement | null

  /** Which bars a marquee rectangle (in layer coordinates) covers. */
  const marqueeHits = (x0: number, y0: number, x1: number, y1: number) => {
    const hits: string[] = []
    for (const [id, g] of geo) {
      const bx0 = sidebarWidth + dayToX(g.span.startDay, ppd)
      const bx1 = sidebarWidth + dayToX(g.span.endDay + 1, ppd)
      const by0 = g.index * rowH
      if (bx1 >= x0 && bx0 <= x1 && by0 + rowH >= y0 && by0 <= y1) hits.push(id)
    }
    return hits
  }

  /** Client coords → coordinates inside the rows layer. */
  const toLayer = (clientX: number, clientY: number) => {
    const el = scrollerRef.current!
    const rect = el.getBoundingClientRect()
    return {
      x: clientX - rect.left + el.scrollLeft,
      y: clientY - rect.top + el.scrollTop - HEADER_HEIGHT,
    }
  }

  /** Snapped day under a client x, in canvas terms. Negative left of day 0. */
  const dayAtClientX = (clientX: number) => {
    const rect = layerRef.current?.getBoundingClientRect()
    if (!rect) return todayDay()
    const x = clientX - rect.left - sidebarRef.current
    // Always days. The tier's snap unit grows to weeks and months when zoomed
    // out, which makes the preview leap around under the cursor.
    return snapDay(Math.round(xToDay(x, ppdRef.current)), 'day')
  }

  /**
   * Is this client x out on the canvas, rather than over the table column?
   *
   * Measured from the scroller, not the layer. The layer spans the whole
   * content and slides left as you scroll, so `clientX - layer.left` is a
   * content coordinate - scrolled right, a press on the pinned table column
   * looks like a press far out on the canvas. The column is `position: sticky`
   * against the scroller, so that is what it has to be compared with.
   */
  const overCanvas = (clientX: number) => {
    const rect = scrollerRef.current?.getBoundingClientRect()
    return !!rect && clientX - rect.left - sidebarRef.current > 0
  }

  const newItemIn = (laneId: string | null, status?: string, parentId?: string | null) => {
    // A sub-item starts where its parent does, so it lands beside its siblings
    // rather than off at today on its own. Top-level ones start at today.
    // Read from geo, not item.start: a parent whose dates are rolled up from
    // its children has no stored start, and geo holds the computed span.
    const parentStart = parentId
      ? (geo.get(parentId)?.span.startDay ??
         (items[parentId]?.start ? isoToDay(items[parentId]!.start!.date) : undefined))
      : undefined
    const t = parentStart ?? todayDay()
    const id = createItem({
      laneId,
      ...(parentId ? { parentId } : {}),
      start: { date: dayToIso(t), precision: 'day' },
      end: { date: dayToIso(t + 6), precision: 'day' },
      ...(status ? { status: status as never } : {}),
    })
    if (parentId) updateItems([{ id: parentId, patch: { collapsed: false } }], true)
    setEditing(id)
    goToDay(t, 0.32)
  }

  // -- pointer down ----------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    stopScrollAnimation()
    const target = e.target as HTMLElement
    if (target.closest('.title-input') || target.closest('.disclosure')) return
    if (target.closest('.jump')) return

    /*
     * Only the button removes a dependency, never the line. A connector crosses
     * the canvas wherever its two blocks happen to sit, so catching one by
     * accident is easy - and the arrow simply vanished, with nothing to suggest
     * what had happened or how to get it back.
     */
    const depX = target.closest('.dep-x')
    if (depX) {
      const id = depX.closest('[data-dep-id]')?.getAttribute('data-dep-id')
      if (id) {
        /*
         * Removed on release, not on press, and only if the pointer is still on
         * the button. Pressing something irreversible and sliding off to think
         * better of it is how every button on the platform behaves, and this one
         * deletes work.
         */
        const onUp = (ev: PointerEvent) => {
          window.removeEventListener('pointerup', onUp, true)
          depX.classList.remove('pressing')
          const still = (ev.target as Element | null)?.closest?.('.dep-x')
          if (still === depX) removeDep(id)
        }
        depX.classList.add('pressing')
        window.addEventListener('pointerup', onUp, true)
      }
      return
    }

    const sw0 = sidebarRef.current
    const startMarquee = (additive: boolean) => {
      const p = toLayer(e.clientX, e.clientY)
      const box = document.createElement('div')
      box.className = 'marquee'
      box.style.left = `${p.x}px`
      box.style.top = `${p.y}px`
      layerRef.current?.appendChild(box)
      dragRef.current = {
        ...blank(e),
        mode: 'marquee',
        ghost: box,
        anchorDay: p.x,
        origStart: p.y,
        baseSelection: additive ? selection : [],
      }
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* pointer already gone */
      }
    }

    const sw = sidebarRef.current
    const perDay = ppdRef.current
    const snapUnit = tierFor(perDay).snap
    const base: Drag = {
      ...blank(e),
      snapUnit,
      startScrollLeft: scrollerRef.current?.scrollLeft ?? 0,
    }
    const capture = () => {
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* pointer already gone; the window-level move/up handlers still work */
      }
    }

    const rowEl = target.closest('[data-row-index]') as HTMLElement | null
    if (!rowEl) {
      // Empty space below the last row is still a valid place to start one.
      const overCanvas =
        e.clientX - (scrollerRef.current?.getBoundingClientRect().left ?? 0) > sw0
      if (overCanvas) startMarquee(e.shiftKey)
      else select([])
      return
    }
    const kind = rowEl.dataset.rowKind
    const itemId = rowEl.dataset.itemId ?? null

    // preventDefault stops the compatibility mousedown, which would otherwise
    // move focus off the inline title editor the moment it mounts.
    if (kind === 'new') {
      e.preventDefault()
      // Out on the canvas the press is a create gesture: release without
      // moving for a default-length block, or drag to size it. Over the table
      // column there's no date under the cursor, so fall back to the old
      // "create at the row's preview day" behaviour.
      if (!overCanvas(e.clientX)) {
        newItemIn(
          rowEl.dataset.laneId || null,
          rowEl.dataset.status || undefined,
          rowEl.dataset.parentId || null,
        )
        return
      }

      const anchor = dayAtClientX(e.clientX)
      const rowTop = Number(rowEl.style.top.replace('px', ''))
      const barTop = Math.round(rowH * 0.13)

      const ghost = document.createElement('div')
      ghost.className = 'bar ghost c-blue'
      ghost.style.left = `${sw + dayToX(anchor, perDay)}px`
      // Starts at the length a plain click would give, so the press reads as
      // "this is what you're about to get" before any drag.
      ghost.style.width = `${Math.max(2, DEFAULT_DAYS * perDay)}px`
      ghost.style.top = `${rowTop + barTop}px`
      ghost.style.height = `${rowH - barTop * 2}px`
      layerRef.current?.appendChild(ghost)

      dragRef.current = {
        ...base,
        mode: 'create',
        // Days, matching the preview that led you here.
        snapUnit: 'day',
        anchorDay: anchor,
        origStart: anchor,
        origEnd: anchor,
        finalStart: anchor,
        finalEnd: anchor,
        ghost,
        createCtx: {
          laneId: rowEl.dataset.laneId || null,
          parentId: rowEl.dataset.parentId || null,
          defaultDays: DEFAULT_DAYS,
        },
        sourceIndex: Number(rowEl.dataset.rowIndex),
      }
      capture()
      return
    }
    // Only the table column makes a lane - a lane isn't something you place on
    // the canvas. Out on the canvas this row falls through to the ordinary
    // empty-canvas gestures below, so it can still be marquee-dragged or
    // cmd-dragged like any other empty space.
    if (kind === 'new-lane' && target.closest('.side')) {
      e.preventDefault()
      // Armed here, made on release - so a press you drag away from or think
      // better of doesn't leave a lane behind.
      dragRef.current = { ...base, mode: 'new-lane' }
      capture()
      return
    }
    // A lane row: the whole cell drags to reorder, and releasing on the title
    // without moving opens its menu - the same press-or-drag split the blocks
    // use, so a lane can be grabbed by the obvious part of it.
    const laneBtn = target.closest('[data-lane-menu]') as HTMLElement | null
    if (kind === 'group' && (laneBtn || target.closest('.side')) && !target.closest('[data-group-add]')) {
      e.preventDefault()
      const gid = rowEl.dataset.groupId ?? ''
      const b = laneBtn?.getBoundingClientRect()
      const menuAt = b ? { x: b.left, y: b.bottom + 4 } : null
      // "No lane" is synthetic - it has no order to change, so it only ever
      // opens its menu.
      if (gid && gid !== '__none' && lanes[gid]) {
        dragRef.current = { ...base, mode: 'lane', ids: [gid], menuAt }
        capture()
      } else if (menuAt && gid) {
        setMenu({ x: menuAt.x, y: menuAt.y, target: { kind: 'group', id: gid } })
      }
      return
    }
    if (target.closest('[data-group-add]')) {
      e.preventDefault()
      const gid = rowEl.dataset.groupId
      newItemIn(gid && gid !== '__none' ? gid : null)
      return
    }


    // 1. Dependency port -> drag a link out.
    const port = target.closest('[data-port]') as HTMLElement | null
    if (port && itemId) {
      dragRef.current = {
        ...base,
        mode: 'link',
        linkFrom: itemId,
        linkDir: port.dataset.port as 'in' | 'out',
      }
      setLinkingActive(true)
      capture()
      return
    }

    // 2. Grip -> reorder rows.
    if (target.closest('[data-grip]') && itemId) {
      dragRef.current = { ...base, mode: 'reorder', ids: [itemId] }
      capture()
      return
    }

    // 3. The table column selects - and arms a reorder, so the whole row is a
    //    drag handle, not just the grip. Nothing happens unless the pointer
    //    actually moves, so a plain press is still just a click. The cursor is
    //    deliberately left alone: a grab cursor on every row would advertise
    //    dragging over the whole table.
    if (target.closest('.side')) {
      if (itemId) {
        if (e.shiftKey || e.metaKey) toggleSelect(itemId)
        else select([itemId])
        dragRef.current = { ...base, mode: 'reorder', ids: [itemId] }
        capture()
      } else {
        select([])
      }
      return
    }

    // 4. A bar -> move or resize.
    const barEl = target.closest('[data-bar-id]') as HTMLElement | null
    if (barEl && itemId) {
      const row = rows[Number(rowEl.dataset.rowIndex)]
      if (!items[itemId] || !row || row.kind !== 'item' || !row.span) return

      const handle = (target.closest('[data-handle]') as HTMLElement | null)?.dataset.handle
      const mode = (handle as 'start' | 'end' | undefined) ?? 'move'

      // Grabbing an edge is a date edit, not a pick - selecting the block there
      // would swap the detail panel out from under you mid-drag.
      if (mode === 'move') {
        if (e.shiftKey || e.metaKey) toggleSelect(itemId)
        else if (!selectionSet.has(itemId)) select([itemId])
      }

      // A parent whose span is rolled up from children moves the whole subtree,
      // as does an explicit shift-drag.
      const kin =
        mode === 'move' && (row.span.derived || e.shiftKey) ? descendants(items, itemId) : []
      const ids = [itemId, ...kin]
      const els = ids
        .map((id) => layerRef.current?.querySelector<HTMLElement>(`[data-bar-id="${id}"]`))
        .filter((x): x is HTMLElement => !!x)

      dragRef.current = {
        ...base,
        mode,
        ids,
        els,
        primary: barEl,
        anchorDay: row.span.startDay,
        origStart: row.span.startDay,
        origEnd: row.span.endDay,
        origLeft: barEl.offsetLeft,
        origWidth: barEl.offsetWidth,
        finalStart: row.span.startDay,
        finalEnd: row.span.endDay,
        sourceIndex: Number(rowEl.dataset.rowIndex),
      }
      // The dragged bars must not intercept hit-testing for the row underneath.
      for (const el of els) el.style.pointerEvents = 'none'
      capture()
      return
    }

    // 5. Empty canvas: dragging sweeps out a selection, as it does in Notion.
    //    Holding cmd drags out a new item instead.
    if (!e.metaKey) {
      startMarquee(e.shiftKey)
      return
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const anchor = snapDay(Math.round(xToDay(e.clientX - rect.left - sw, perDay)), 'day')
    const row = rows[Number(rowEl.dataset.rowIndex)]
    // No defaultDays: out here a press that never moves is just a click, and
    // clicking bare canvas must not leave a block behind.
    const createCtx =
      row?.kind === 'item'
        ? { laneId: row.item.laneId, parentId: row.item.parentId, defaultDays: null }
        : {
            laneId: rowEl.dataset.groupId === '__none' ? null : rowEl.dataset.groupId ?? null,
            parentId: null,
            defaultDays: null,
          }

    const ghost = document.createElement('div')
    ghost.className = 'bar ghost c-blue'
    ghost.style.left = `${sw + dayToX(anchor, perDay)}px`
    ghost.style.width = '2px'
    const gTop = Number(rowEl.style.top.replace('px', '')) + Math.round(rowH * 0.17)
    ghost.style.top = `${gTop}px`
    ghost.style.height = `${rowH - Math.round(rowH * 0.17) * 2}px`
    layerRef.current?.appendChild(ghost)

    dragRef.current = {
      ...base,
      mode: 'create',
      // Creating always works in whole days. The tier's snap unit is right for
      // nudging something that already exists, but drawing a new block at year
      // zoom in month-sized jumps just feels broken.
      snapUnit: 'day',
      anchorDay: anchor,
      origStart: anchor,
      origEnd: anchor,
      finalStart: anchor,
      finalEnd: anchor,
      ghost,
      createCtx,
    }
    capture()
    select([])
  }

  // -- pointer move ----------------------------------------------------------
  /**
   * The bars a drag resizes or moves directly, and so the ones worth easing.
   * Deliberately not the marquee - a selection box has to track the pointer
   * exactly - and not the vertical drag copy, which already follows it.
   */
  const dragSmoothEls = (d: NonNullable<typeof dragRef.current>): HTMLElement[] => {
    if (d.mode === 'move') return d.els
    if (d.mode === 'create') return d.ghost ? [d.ghost] : []
    return d.primary ? [d.primary] : []
  }

  /**
   * Paint the drop indicator for a vertical drag and record where it would
   * land. Shared by the grip drag and by dragging a bar itself up or down, so
   * the two gestures offer the same three targets: above, below, or nested
   * inside. `rel` is how far down the hovered row the pointer is, 0..1.
   */
  const showDropTarget = (
    d: NonNullable<typeof dragRef.current>,
    clientX: number,
    clientY: number,
    rowIndex: number,
    rel: number,
  ) => {
    const forbidden = (target: string) =>
      target === d.ids[0] || descendants(items, d.ids[0]).includes(target)
    const hovered = rows[rowIndex]

    /*
     * The middle band nests inside the hovered row. A "+ New sub-item" line
     * counts: it is literally the slot where a child of that parent would go,
     * so aiming at it should drop the block into that slot rather than resolve
     * to the gap above it. A lane's own "+ New" has no parent to nest into, so
     * it still falls through and is treated purely as a gap - which is what
     * keeps the strip below a branch usable rather than dead.
     */
    const childTarget =
      hovered?.kind === 'item'
        ? hovered.id
        : hovered?.kind === 'new'
          ? hovered.parentId
          : null

    if (rel >= 0.3 && rel <= 0.7 && childTarget) {
      if (forbidden(childTarget)) {
        showTip(clientX, clientY, 'Can’t nest inside itself')
        return
      }
      d.dropTarget = { id: childTarget, position: 'child' }
      const marker = document.createElement('div')
      marker.className = 'drop-into'
      marker.style.top = `${rowIndex * rowH}px`
      marker.style.height = `${rowH}px`
      layerRef.current?.appendChild(marker)
      showTip(clientX, clientY, `Nest under “${items[childTarget]?.title || 'Untitled'}”`)
      return
    }

    /*
     * Otherwise the target is a *gap* between rows, not a row - the line is
     * drawn at the gap under the pointer, and what the drop means is read off
     * the rows either side of it.
     *
     * This is what makes deep branches behave. The row below a gap decides:
     * at the bottom of a parent's heading the next row is its first child, so
     * the block lands inside; at the bottom of a branch's last leaf the next
     * row is shallower, so the block lands after the whole branch. Both times
     * the line sits exactly where the pointer is. Keying off the hovered row
     * instead meant the pointer and the line pointed at different gaps.
     */
    const gap = rel < 0.3 ? rowIndex : rowIndex + 1
    const below = rows[gap]
    const above = rows[gap - 1]

    let target: { id: string; position: 'before' | 'after' } | null = null
    if (below?.kind === 'item' && !forbidden(below.id)) {
      target = { id: below.id, position: 'before' }
    } else if (above?.kind === 'item' && !forbidden(above.id)) {
      // Nothing usable below - the end of a lane, or a "+ New" line.
      target = { id: above.id, position: 'after' }
    } else {
      // Both neighbours are affordance rows, which happens at the foot of a
      // lane where a "+ New sub-item" line sits above the lane's own "+ New".
      // Walk back to the nearest real row so the gap still means something
      // rather than being a dead strip.
      for (let i = gap - 1; i >= 0; i--) {
        const r = rows[i]
        if (r.kind === 'item' && !forbidden(r.id)) {
          target = { id: r.id, position: 'after' }
          break
        }
        if (r.kind === 'group') break
      }
    }
    if (!target) {
      showTip(clientX, clientY, 'Can’t drop here')
      return
    }

    d.dropTarget = target
    const marker = document.createElement('div')
    marker.className = 'drop-line'
    marker.style.top = `${gap * rowH - 1}px`
    layerRef.current?.appendChild(marker)

    const name = items[target.id]?.title || 'Untitled'
    showTip(
      clientX,
      clientY,
      target.position === 'before' ? `Above “${name}”` : `Below “${name}”`,
    )
  }

  /**
   * Auto-scroll while a date drag is held near the left or right edge, so a
   * block can be taken far beyond the current view. The frame both scrolls and
   * re-applies the drag, which is what keeps the block under the cursor: the
   * pointer isn't moving, so nothing else would update it.
   *
   * Speed ramps with how far into the edge zone the pointer is, and is capped
   * per frame rather than per second - a slow frame then scrolls less, instead
   * of overshooting past where the drag maths can follow.
   */
  const edgeScrollRef = useRef(0)
  const EDGE_ZONE = 56
  const EDGE_MAX_PX = 26

  const edgeScroll = (d: NonNullable<typeof dragRef.current>) => {
    if (!isDateDrag(d) || edgeScrollRef.current) return

    const step = () => {
      edgeScrollRef.current = 0
      const cur = dragRef.current
      const el = scrollerRef.current
      if (!cur || !el || !cur.moved) return

      const rect = el.getBoundingClientRect()
      const left = rect.left + sidebarRef.current
      const right = rect.right
      let push = 0
      if (cur.lastClientX > right - EDGE_ZONE) {
        push = Math.min(1, (cur.lastClientX - (right - EDGE_ZONE)) / EDGE_ZONE)
      } else if (cur.lastClientX < left + EDGE_ZONE) {
        push = -Math.min(1, (left + EDGE_ZONE - cur.lastClientX) / EDGE_ZONE)
      }

      if (push !== 0) {
        const before = el.scrollLeft
        el.scrollLeft = before + push * EDGE_MAX_PX
        // Only worth re-running if the canvas actually moved - at either end
        // of the timeline it can't, and the block should simply hold still.
        if (el.scrollLeft !== before) {
          applyHorizontal(cur, cur.lastClientX, cur.lastClientY, cur.lastAlt)
        }
      }
      edgeScrollRef.current = requestAnimationFrame(step)
    }
    edgeScrollRef.current = requestAnimationFrame(step)
  }

  const stopEdgeScroll = () => {
    cancelAnimationFrame(edgeScrollRef.current)
    edgeScrollRef.current = 0
  }

  /**
   * The date-changing half of a drag: move, resize either edge, or draw a new
   * block out.
   *
   * Separate from the pointer handler because it also has to run when nothing
   * moved but the canvas scrolled under the cursor - during an edge
   * auto-scroll there are no pointer events at all, and without re-running
   * this the block simply stops following.
   */
  /** Modes whose result depends on where the pointer sits over the content. */
  const isDateDrag = (d: NonNullable<typeof dragRef.current>) =>
    d.mode === 'start' || d.mode === 'end' || d.mode === 'create' ||
    (d.mode === 'move' && d.axis === 'x')

  const applyHorizontal = (
    d: NonNullable<typeof dragRef.current>,
    clientX: number,
    clientY: number,
    free: boolean,
  ) => {
    const perDay = ppdRef.current
    const sw = sidebarRef.current
    // Screen movement plus whatever the canvas scrolled: what matters is where
    // the pointer sits over the *content*, not over the window.
    const scrolled = (scrollerRef.current?.scrollLeft ?? 0) - d.startScrollLeft
    const dx = clientX - d.startClientX + scrolled
    const toDay = (raw: number) => (free ? Math.round(raw) : snapDay(Math.round(raw), d.snapUnit))

    if (d.mode === 'move') {
      const ns = toDay(d.origStart + dx / perDay)
      d.finalStart = ns
      d.finalEnd = ns + (d.origEnd - d.origStart)
      for (const el of d.els) el.style.transform = `translateX(${(ns - d.origStart) * perDay}px)`
      showTip(clientX, clientY, spanLabel(d.finalStart, d.finalEnd, d.origStart === d.origEnd))
      paintDepPaths(dragOverride(d))
      showHeadRange(d.finalStart, d.finalEnd)
    } else if (d.mode === 'start') {
      const ns = Math.min(toDay(d.origStart + dx / perDay), d.origEnd)
      d.finalStart = ns
      d.finalEnd = d.origEnd
      const left = d.origLeft + (ns - d.origStart) * perDay
      if (d.primary) {
        d.primary.style.left = `${left}px`
        d.primary.style.width = `${Math.max(6, (d.origEnd + 1 - ns) * perDay)}px`
      }
      showGuide(left, d.sourceIndex, formatDate(dayToIso(ns)), true)
      showTip(clientX, clientY, spanLabel(d.finalStart, d.finalEnd, false))
      paintDepPaths(dragOverride(d))
      showHeadRange(d.finalStart, d.finalEnd)
    } else if (d.mode === 'end') {
      const ne = Math.max(toDay(d.origEnd + dx / perDay), d.origStart)
      d.finalStart = d.origStart
      d.finalEnd = ne
      const width = Math.max(6, (ne + 1 - d.origStart) * perDay)
      if (d.primary) d.primary.style.width = `${width}px`
      showGuide(d.origLeft + width, d.sourceIndex, formatDate(dayToIso(ne)), false)
      showTip(clientX, clientY, spanLabel(d.finalStart, d.finalEnd, false))
      paintDepPaths(dragOverride(d))
      showHeadRange(d.finalStart, d.finalEnd)
    } else if (d.mode === 'create') {
      const ns = toDay(d.anchorDay + dx / perDay)
      const a = Math.min(d.anchorDay, ns)
      const b = Math.max(d.anchorDay, ns)
      d.finalStart = a
      d.finalEnd = b
      if (d.ghost) {
        d.ghost.style.left = `${sw + dayToX(a, perDay)}px`
        d.ghost.style.width = `${Math.max(2, (b + 1 - a) * perDay)}px`
      }
      showTip(clientX, clientY, spanLabel(a, b, false))
    }
  }

  applyHorizontalRef.current = applyHorizontal
  isDateDragRef.current = isDateDrag

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) {
      const h = (e.target as HTMLElement).closest('[data-handle]') as HTMLElement | null
      // Any bar, not just one grabbed by an edge - hovering anywhere on a block
      // should surface its dates.
      const anyBar = (e.target as HTMLElement).closest('[data-bar-id]') as HTMLElement | null
      const anySpan = anyBar?.dataset.barId ? geo.get(anyBar.dataset.barId)?.span : undefined
      if (anySpan) showHeadRange(anySpan.startDay, anySpan.endDay)
      else if (!(e.target as HTMLElement).closest('[data-row-kind="new"]')) hideHeadRange()

      // The "+ New" preview tracks the cursor: the block starts where you
      // press, not at some fixed date you then have to drag it away from.
      const newRow = (e.target as HTMLElement).closest(
        '[data-row-kind="new"]',
      ) as HTMLElement | null
      if (hoverNewRef.current && hoverNewRef.current !== newRow) {
        resetNewPreview(hoverNewRef.current)
        hoverNewRef.current = null
      }
      if (newRow) {
        hoverNewRef.current = newRow
        const outline = newRow.querySelector<HTMLElement>('.new-outline')
        const row = rows[Number(newRow.dataset.rowIndex)]
        const resting = row?.kind === 'new' ? row.previewStart : todayDay()
        const day = overCanvas(e.clientX) ? dayAtClientX(e.clientX) : resting
        if (outline) {
          if (overCanvas(e.clientX)) {
            outline.style.transform = `translateX(${dayToX(day, ppdRef.current)}px)`
          } else {
            resetNewPreview(newRow)
          }
        }
        // The preview is a block-to-be, so call out its dates like any other.
        showHeadRange(day, day + DEFAULT_DAYS - 1)
      }

      const barEl = h?.closest('[data-bar-id]') as HTMLElement | null
      const hovered = barEl?.dataset.barId ? geo.get(barEl.dataset.barId) : undefined
      if (h && barEl && hovered) {
        const isStart = h.dataset.handle === 'start'
        showGuide(
          isStart ? barEl.offsetLeft : barEl.offsetLeft + barEl.offsetWidth,
          hovered.index,
          formatDate(dayToIso(isStart ? hovered.span.startDay : hovered.span.endDay)),
          isStart,
        )
      } else {
        hideGuide()
      }
      return
    }
    const dx = e.clientX - d.startClientX
    const dy = e.clientY - d.startClientY
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    if (!d.moved) {
      d.moved = true
      // Lock to whichever way the drag set off. Re-deciding mid-gesture makes
      // the bar feel like it's fighting you, so this sticks until pointerup.
      d.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
      // Pointer capture sends every move to the layer, so the cursor would
      // otherwise take on whatever it happens to fly over. Pin it for the
      // gesture instead.
      document.body.dataset.drag = d.mode

      // Vertical drags leave the bar where it is and move a drop line, which
      // gives you nothing to follow. A translucent copy does.
      if (d.mode === 'reorder' || (d.mode === 'move' && d.axis === 'y')) {
        const src = layerRef.current?.querySelector<HTMLElement>(`[data-bar-id="${d.ids[0]}"]`)
        if (src) {
          const copy = src.cloneNode(true) as HTMLElement
          copy.classList.add('drag-copy')
          // Strip the hooks so hit-testing and DOM queries can't find the copy.
          copy.removeAttribute('data-bar-id')
          copy
            .querySelectorAll('[data-handle], [data-port]')
            .forEach((n) => {
              n.removeAttribute('data-handle')
              n.removeAttribute('data-port')
            })
          // The source's `top` is relative to its row; the copy hangs off the
          // layer, so it needs an absolute one.
          const barTop = d.sourceIndex * rowH + Math.round(rowH * 0.13)
          copy.style.top = `${barTop}px`
          d.copyDy = toLayer(d.startClientX, d.startClientY).y - barTop
          layerRef.current?.appendChild(copy)
          d.copy = copy
        }
      }
      // Dates snap to whole days/weeks/months, so a bar tracks the pointer in
      // steps. A short ease turns those steps into a glide.
      for (const el of dragSmoothEls(d)) el.classList.add('drag-smooth')
    }

    const perDay = ppdRef.current
    const sw = sidebarRef.current

    // Remembered so an auto-scroll frame can carry on without a pointer event.
    d.lastClientX = e.clientX
    d.lastClientY = e.clientY
    d.lastAlt = e.altKey
    edgeScroll(d)

    if (d.mode === 'link') {
      const from = geo.get(d.linkFrom!)
      if (!from) return
      const p = toLayer(e.clientX, e.clientY)
      const reach = from.span.milestone ? milestoneReach(rowH) : 0
      const x1 =
        sw +
        (d.linkDir === 'out'
          ? dayToX(from.span.endDay + (from.span.milestone ? 0 : 1), perDay) + reach
          : dayToX(from.span.startDay, perDay) - reach)
      const y1 = (from.index + 0.5) * rowH
      linkPathRef.current?.setAttribute('d', `M${x1},${y1} L${p.x},${p.y}`)
      const hovered = hitRowAt(e.clientX, e.clientY)
      const id = hovered?.dataset.itemId ?? null
      d.linkTarget = id && id !== d.linkFrom ? id : null
      showTip(
        e.clientX,
        e.clientY,
        d.linkTarget ? `Link to “${items[d.linkTarget]?.title || 'Untitled'}”` : 'Drop on a bar',
      )
      return
    }

    if (d.mode === 'marquee') {
      const p = toLayer(e.clientX, e.clientY)
      const x0 = Math.min(d.anchorDay, p.x)
      const y0 = Math.min(d.origStart, p.y)
      const x1 = Math.max(d.anchorDay, p.x)
      const y1 = Math.max(d.origStart, p.y)
      const box = d.ghost!
      box.style.left = `${x0}px`
      box.style.top = `${y0}px`
      box.style.width = `${x1 - x0}px`
      box.style.height = `${y1 - y0}px`

      // Select as we sweep, so it's obvious what's being caught. Only push to
      // the store when the set actually changes - otherwise every pointermove
      // would re-render the whole canvas.
      const hits = marqueeHits(x0, y0, x1, y1)
      const next = d.baseSelection.length ? [...new Set([...d.baseSelection, ...hits])] : hits
      const key = next.join(',')
      if (key !== d.lastHits) {
        d.lastHits = key
        select(next)
      }
      return
    }

    if (d.copy) d.copy.style.top = `${toLayer(e.clientX, e.clientY).y - d.copyDy}px`

    if (d.mode === 'lane') {
      layerRef.current?.querySelectorAll('.drop-line, .drop-into').forEach((n) => n.remove())
      d.dropTarget = null
      const layerRect = layerRef.current?.getBoundingClientRect()
      if (!layerRect) return
      const raw = (e.clientY - layerRect.top) / rowH
      const idx = Math.max(0, Math.min(rows.length - 1, Math.floor(raw)))

      // A lane's extent is its heading down to the next heading, so the drop
      // lands between whole lanes rather than between two of their rows.
      let start = -1
      let laneId: string | null = null
      for (let i = idx; i >= 0; i--) {
        const r = rows[i]
        if (r.kind === 'group') {
          start = i
          laneId = r.id
          break
        }
      }
      if (laneId === null || laneId === '__none' || laneId === d.ids[0]) {
        showTip(e.clientX, e.clientY, 'Drag over another lane')
        return
      }
      // Stop at the next heading - or at the trailing "+ New lane" row, which
      // belongs to no lane. Without that, the last lane's block ran to the end
      // of the list and the drop line drew *below* "+ New lane", when the lane
      // actually lands above it.
      let end = rows.length
      for (let i = start + 1; i < rows.length; i++) {
        const r = rows[i]
        if (r.kind === 'group' || r.kind === 'new-lane') {
          end = i
          break
        }
      }
      const position = raw < (start + end) / 2 ? 'before' : 'after'
      d.dropTarget = { id: laneId, position }
      const line = document.createElement('div')
      line.className = 'drop-line'
      line.style.top = `${(position === 'before' ? start : end) * rowH - 1}px`
      layerRef.current?.appendChild(line)
      showTip(
        e.clientX,
        e.clientY,
        `${position === 'before' ? 'Above' : 'Below'} “${lanes[laneId]?.name || 'Untitled lane'}”`,
      )
      return
    }

    if (d.mode === 'reorder') {
      // Any row, not just one carrying an item: the "+ New" line below a
      // branch is a legitimate thing to aim at, since the gaps around it are
      // real drop points.
      const hovered = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
        ?.closest('[data-row-index]') as HTMLElement | null
      layerRef.current?.querySelectorAll('.drop-line, .drop-into').forEach((n) => n.remove())
      d.dropTarget = null
      if (!hovered || hovered.dataset.itemId === d.ids[0]) return

      showDropTarget(
        d,
        e.clientX,
        e.clientY,
        Number(hovered!.dataset.rowIndex),
        (e.clientY - hovered!.getBoundingClientRect().top) / rowH,
      )
      return
    }

    if (d.mode === 'move' && d.axis === 'y') {
      // Re-ordering: the dates are left exactly as they were, and the bar stays
      // on its own row. The drop line is the only thing that moves, so nothing
      // jumps around until the drop actually lands.
      layerRef.current?.querySelectorAll('.drop-line, .drop-into').forEach((n) => n.remove())
      d.dropTarget = null

      const layerRect = layerRef.current?.getBoundingClientRect()
      let over: string | null = null
      if (layerRect) {
        // Row geometry is uniform, so arithmetic beats hit-testing here.
        const raw = (e.clientY - layerRect.top) / rowH
        const idx = Math.max(0, Math.min(rows.length - 1, Math.floor(raw)))
        const row = rows[idx]
        const moving = new Set(d.ids)
        // Any row, not just item rows: a "+ New" line is still a valid place
        // to aim at, because the gap either side of it is a real drop point.
        if (row && !(row.kind === 'item' && moving.has(row.id))) {
          over = 'y'
          showDropTarget(d, e.clientX, e.clientY, idx, raw - Math.floor(raw))
        }
      }
      // showDropTarget owns the tip when it has something to say.
      if (!over) showTip(e.clientX, e.clientY, 'Drag over a row')
    } else {
      applyHorizontal(d, e.clientX, e.clientY, e.altKey)
    }
  }

  // -- pointer up ------------------------------------------------------------
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    hideTip()
    hideGuide()
    hideHeadRange()
    if (!d) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }

    d.ghost?.remove()
    d.copy?.remove()
    layerRef.current?.querySelectorAll('.drop-line, .drop-into').forEach((n) => n.remove())
    linkPathRef.current?.setAttribute('d', '')
    stopEdgeScroll()
    delete document.body.dataset.drag
    // Drop the easing first: the lines below restore the pre-drag inline
    // values, and those must snap back, not glide.
    for (const el of dragSmoothEls(d)) el.classList.remove('drag-smooth')

    if (d.mode === 'lane') {
      if (!d.moved) {
        if (d.menuAt) setMenu({ x: d.menuAt.x, y: d.menuAt.y, target: { kind: 'group', id: d.ids[0] } })
      } else if (d.dropTarget && d.dropTarget.position !== 'child') {
        reorderLane(d.ids[0], d.dropTarget.id, d.dropTarget.position)
      }
      return
    }

    if (d.mode === 'new-lane') {
      // Only a press that stayed put counts, the way a button does.
      if (!d.moved) setEditingLane(createLane('New lane'))
      return
    }

    if (d.mode === 'link') {
      setLinkingActive(false)
      if (d.linkTarget) {
        // Dragging from the left port means "this depends on that".
        if (d.linkDir === 'out') addDep(d.linkFrom!, d.linkTarget)
        else addDep(d.linkTarget, d.linkFrom!)
      }
      return
    }

    // Restore anything we mutated directly so React's DOM record stays truthful.
    for (const el of d.els) {
      el.style.transform = ''
      el.style.pointerEvents = ''
    }
    if (d.primary && (d.mode === 'start' || d.mode === 'end')) {
      d.primary.style.left = `${d.origLeft}px`
      d.primary.style.width = `${d.origWidth}px`
    }

    // A press that never moved is normally a click and nothing more - except
    // from a "+ New" row, where the whole gesture means "put a block here".
    const clickCreates = d.mode === 'create' && d.createCtx?.defaultDays != null
    if (!d.moved && !clickCreates) {
      // A plain click on empty canvas clears the selection; shift-click keeps it.
      if (d.mode === 'marquee') select(d.baseSelection)
      return
    }

    // The sweep already applied the selection live; nothing left to do.
    if (d.mode === 'marquee') return

    if (d.mode === 'reorder') {
      if (d.dropTarget) reorderItem(d.ids[0], d.dropTarget.id, d.dropTarget.position)
      return
    }

    if (d.mode === 'create') {
      let from = d.finalStart
      let to = d.finalEnd
      if (to <= from) {
        // Never moved. On bare canvas that's just a click and means nothing;
        // from a "+ New" row it's a request for a default-length block.
        if (d.createCtx?.defaultDays == null) return
        from = d.anchorDay
        to = from + d.createCtx.defaultDays - 1
      }
      const id = createItem({
        title: '',
        laneId: d.createCtx?.laneId ?? null,
        parentId: d.createCtx?.parentId ?? null,
        start: { date: dayToIso(from), precision: 'day' },
        end: { date: dayToIso(to), precision: 'day' },
      })
      setEditing(id)
      return
    }

    const delta = d.finalStart - d.origStart
    commit()
    if (d.mode === 'move' && delta !== 0) {
      updateItems(
        d.ids.map((id) => {
          const it = items[id]
          return {
            id,
            patch: {
              start: it.start ? { ...it.start, date: dayToIso(isoToDay(it.start.date) + delta) } : null,
              end: it.end ? { ...it.end, date: dayToIso(isoToDay(it.end.date) + delta) } : null,
            },
          }
        }),
        true,
      )
    } else {
      const id = d.ids[0]
      const it = items[id]
      updateItems(
        [
          {
            id,
            patch: {
              start: { date: dayToIso(d.finalStart), precision: it.start?.precision ?? 'day' },
              end: { date: dayToIso(d.finalEnd), precision: it.end?.precision ?? 'day' },
            },
          },
        ],
        true,
      )
    }
    if (d.mode === 'move' && d.dropTarget) {
      reorderItem(d.ids[0], d.dropTarget.id, d.dropTarget.position, true)
    }
    cascade()
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const target = e.target as HTMLElement
    const rowEl = target.closest('[data-row-index]') as HTMLElement | null
    if (!rowEl) {
      setMenu(null)
      return
    }
    const kind = rowEl.dataset.rowKind
    const itemId = rowEl.dataset.itemId

    // A bar or its sidebar row acts on the item; bare canvas offers to create.
    const onItem = !!itemId && (!!target.closest('[data-bar-id]') || !!target.closest('.side'))
    if (onItem) {
      if (!selectionSet.has(itemId!)) select([itemId!])
      setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'item', id: itemId! } })
      return
    }
    if (kind === 'group') {
      setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'group', id: rowEl.dataset.groupId! } })
      return
    }

    const rect = layerRef.current!.getBoundingClientRect()
    const day = snapDay(
      Math.round(xToDay(e.clientX - rect.left - sidebarRef.current, ppdRef.current)),
      tierFor(ppdRef.current).snap,
    )
    const row = rows[Number(rowEl.dataset.rowIndex)]
    const laneId =
      row?.kind === 'item'
        ? row.item.laneId
        : row?.kind === 'new'
          ? row.laneId
          : (rowEl.dataset.groupId ?? null)
    setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'empty', laneId, day } })
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const rowEl = target.closest('[data-row-index]') as HTMLElement | null
    if (!rowEl) return
    const id = rowEl.dataset.itemId
    // The twisty and the grip are controls in their own right: double-clicking
    // one should collapse twice or do nothing, never drop into rename.
    if (target.closest('.disclosure') || target.closest('[data-grip]')) return
    if (id && (target.closest('[data-bar-id]') || target.closest('.side'))) {
      setEditing(id)
      return
    }
    // Bare canvas: drag is a selection now, so double-click is how you create.
    const rect = layerRef.current!.getBoundingClientRect()
    const day = snapDay(
      Math.round(xToDay(e.clientX - rect.left - sidebarRef.current, ppdRef.current)),
      tierFor(ppdRef.current).snap,
    )
    const row = rows[Number(rowEl.dataset.rowIndex)]
    const laneId =
      row?.kind === 'item' ? row.item.laneId : row?.kind === 'new' ? row.laneId : null
    const newId = createItem({
      laneId,
      parentId: row?.kind === 'item' ? row.item.parentId : null,
      start: { date: dayToIso(day), precision: 'day' },
      end: { date: dayToIso(day + 6), precision: 'day' },
    })
    setEditing(newId)
  }

  // -- render ----------------------------------------------------------------
  const todayX = sidebarWidth + dayToX(today, ppd)
  // Shade today's column exactly when the grid is drawing individual days.
  // Tying this to the tier rather than a magic pixel width keeps the two from
  // disagreeing - a hand-picked threshold left a band of zoom where you could
  // see day cells but today wasn't shaded.
  const showTodayBand = tier.minor === 'day'

  return (
    <div className="timeline">
      <div className="scroller" id="timeline-canvas" ref={scrollerRef} onScroll={syncView}>
        <div
          className="content"
          style={{ width: contentWidth, height: HEADER_HEIGHT + bodyHeight }}
        >
          {/* ---- header ---- */}
          <div className="head" style={{ height: HEADER_HEIGHT }}>
            <div
              className={'head-corner' + (sidebarWidth ? '' : ' collapsed')}
              style={{ width: sidebarWidth }}
            >
              <span className="head-col name">Name</span>
              {(['status', 'dates', 'span'] as const).map((c) =>
                columns.includes(c) ? (
                  <span key={c} className="head-col" style={{ width: COLUMN_WIDTH[c] }}>
                    {COLUMN_LABELS[c]}
                  </span>
                ) : null,
              )}
            </div>
            {/* Notion calls out the hovered block's dates up in the header;
                positioned imperatively so hovering never re-renders the grid. */}
            <div
              className="head-range"
              ref={headRangeRef}
              style={{ top: TIER_HEIGHT, height: HEADER_HEIGHT - TIER_HEIGHT }}
            >
              <span className="head-range-label from" />
              <span className="head-range-label to" />
            </div>
            <div className="head-today" style={{ left: todayX }} />
            {majorTicks.map((t) => (
              <div
                key={'M' + t.day}
                className="tick major"
                style={{
                  left: sidebarWidth + dayToX(t.day, ppd),
                  width: (t.end - t.day) * ppd,
                  height: TIER_HEIGHT,
                }}
              >
                <span className="tick-label" style={{ left: sidebarWidth + 10 }}>
                  {t.label}
                </span>
              </div>
            ))}
            {minorTicks.map((t) => (
              <div
                key={'m' + t.day}
                className={
                  'tick minor' + (t.dim ? ' dim' : '') + (t.day === today ? ' is-today' : '')
                }
                style={{
                  left: sidebarWidth + dayToX(t.day, ppd),
                  width: (t.end - t.day) * ppd,
                  top: TIER_HEIGHT,
                  height: HEADER_HEIGHT - TIER_HEIGHT,
                }}
              >
                <span className="tick-label">{t.label}</span>
              </div>
            ))}
          </div>

          {/* ---- grid ---- */}
          <div className="grid" style={{ top: HEADER_HEIGHT, height: bodyHeight }}>
            {minorTicks.map((t) => (
              <div
                key={'g' + t.day}
                className={'gridline' + (t.dim ? ' dim' : '')}
                style={{ left: sidebarWidth + dayToX(t.day, ppd), width: (t.end - t.day) * ppd }}
              />
            ))}
            {showTodayBand && (
              <div className="today-band" style={{ left: todayX, width: ppd }} />
            )}
            <div className="today-line" style={{ left: todayX }} />
          </div>

          {/* The per-row sidebar cells stop at the last row, so this carries the
              column's background and rule down through the empty space below. */}
          <div
            className="side-backdrop"
            style={{ width: sidebarWidth, height: bodyHeight, display: sidebarWidth ? undefined : 'none' }}
          />

          {/* ---- rows ---- */}
          <div
            className={'layer' + (reveal ? ' revealing' : '')}
            ref={layerRef}
            style={{ top: HEADER_HEIGHT, height: bodyHeight }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onPointerLeave={() => {
              hideGuide()
              hideHeadRange()
              if (hoverNewRef.current) {
                resetNewPreview(hoverNewRef.current)
                hoverNewRef.current = null
              }
            }}
          >
            {/* Pinned by `position: sticky` rather than positioned from
                scrollLeft, so the markers can't drift when scroll state lags a
                frame - the same trick the header and table column already use. */}
            <div className="jump-layer">
            {offscreen.map((o) => (
              <button
                key={o.id}
                className={'jump ' + (o.left ? 'jump-left' : 'jump-right')}
                style={{
                  left: o.left ? sidebarWidth + 6 : view.w - 6,
                  top: o.index * rowH + (rowH - 20) / 2,
                }}
                title={`Jump to “${o.title || 'Untitled'}”`}
                // Scroll to it without selecting - jumping is navigation, and
                // hijacking the selection also swaps the detail panel.
                onClick={() => cmd.goToDay(o.day, 0.25)}
              >
                {/* An SVG rather than a ‹ glyph: text sits on its baseline and
                    reads low, where a block-level svg centres exactly. */}
                {o.left && (
                  <svg className="jump-chev" viewBox="0 0 12 12" aria-hidden>
                    <path d="M7.5 2.5 4 6l3.5 3.5" />
                  </svg>
                )}
                <span className="jump-title">{o.title || 'Untitled'}</span>
                {!o.left && (
                  <svg className="jump-chev" viewBox="0 0 12 12" aria-hidden>
                    <path d="M4.5 2.5 8 6l-3.5 3.5" />
                  </svg>
                )}
              </button>
            ))}
            </div>

            {/* Wells before rows, so row hover/selection paints above them. */}
            {wells.map((w) => (
              <div
                key={w.key}
                className={
                  'nest-well' +
                  (w.depth > 1 ? ' inner' : '') +
                  (reveal?.enterWells.has(w.key) ? ' in' : '')
                }
                style={{ top: w.start * rowH, height: (w.end + 1 - w.start) * rowH }}
              />
            ))}
            {reveal?.exitWells.map((w) => (
              <div
                key={'x:' + w.key}
                className={'nest-well out' + (w.depth > 1 ? ' inner' : '')}
                style={{ top: w.start * rowH, height: (w.end + 1 - w.start) * rowH }}
              />
            ))}

            <div className="edge-guide" ref={guideRef} />
            <div className="edge-label" ref={edgeLabelRef} />
            {visibleRows.map((row, i) => (
              <TimelineRow
                key={row.key}
                row={row}
                index={firstRow + i}
                top={(firstRow + i) * rowH}
                height={rowH}
                ppd={ppd}
                sidebarWidth={sidebarWidth}
                selected={row.kind === 'item' && selectionSet.has(row.id)}
                editing={
                  row.kind === 'item'
                    ? editingId === row.id
                    : row.kind === 'group' && editingLaneId === row.id
                }
                columns={columns}
                linking={linkingActive}
                anim={reveal?.enter.has(row.key) ? 'enter' : undefined}
              />
            ))}

            {/* ...and the rows that just left stay one beat longer, grouped
                into contiguous runs, each run clipped away bottom-up as the
                gap closes - the incoming rows glide up at exactly the rate
                the clip edge rises, so the collapse reads as the content
                being swallowed rather than lingering and fading in place.
                clip-path, deliberately: overflow or transform on this wrapper
                would break the sticky table cells inside the ghosts.
                Culled to the viewport so collapsing a huge subtree doesn't
                mount hundreds of throwaway rows. */}
            {(() => {
              if (!reveal?.exit.length) return null
              const visible = reveal.exit.filter(
                (x) =>
                  x.top + rowH > view.scrollTop - rowH * OVERSCAN_ROWS &&
                  x.top < view.scrollTop + view.h + rowH * OVERSCAN_BELOW,
              )
              const groups: { top: number; rows: typeof visible }[] = []
              for (const x of visible) {
                const g = groups[groups.length - 1]
                if (g && x.top === g.top + g.rows.length * rowH) g.rows.push(x)
                else groups.push({ top: x.top, rows: [x] })
              }
              return groups.map((g) => (
                <div
                  key={'exit:' + g.rows[0].row.key}
                  className="exit-clip"
                  style={{ top: g.top, height: g.rows.length * rowH }}
                >
                  {g.rows.map((x) => (
                    <TimelineRow
                      key={'exit:' + x.row.key}
                      row={x.row}
                      index={-1}
                      top={x.top - g.top}
                      height={rowH}
                      ppd={ppd}
                      sidebarWidth={sidebarWidth}
                      selected={false}
                      editing={false}
                      columns={columns}
                      linking={false}
                      ghost
                    />
                  ))}
                </div>
              ))
            })()}

              <svg className="deps" ref={depsSvgRef} width={contentWidth} height={rowsHeight}>
                {depPaths.map((p) => (
                  <g key={p.id} data-dep-id={p.id}>
                    <path className="dep-path" d={p.d} />
                    <path className="dep-head" d={p.head} />
                    <path className="dep-hit" d={p.d} data-dep-id={p.id} />
                    {/* Hidden until the line is hovered, and drawn last so it
                        sits above the line it removes. */}
                    {/* No data-dep-id of its own: it would make `g[data-dep-id]`
                        match this group as well as its parent, and the hover
                        rules key off exactly that selector. */}
                    <g className="dep-x" transform={`translate(${p.cx},${p.cy})`}>
                      <circle className="dep-x-bg" r="8" />
                      <path className="dep-x-mark" d="M-3.1,-3.1 L3.1,3.1 M3.1,-3.1 L-3.1,3.1" />
                      <title>Remove this dependency</title>
                    </g>
                  </g>
                ))}
                <path className="dep-path hot" ref={linkPathRef} d="" />
              </svg>
          </div>
        </div>
      </div>

      {menuPresence.mounted && lastMenu && (
        <ContextMenu
          menu={lastMenu}
          leaving={menuPresence.leaving}
          onClose={() => setMenu(null)}
        />
      )}
      <div className="drag-tip" ref={tipRef} />
      {sidebarOpen && <SidebarResizer />}
      <span className="sr-only" aria-live="polite">
        {indexById.size} items
      </span>
    </div>
  )
}

/** Draggable divider between the properties table and the canvas. */
function SidebarResizer() {
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const start = useRef({ x: 0, w: 0 })

  return (
    <div
      className="sidebar-resizer"
      style={{ left: sidebarWidth }}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, w: sidebarWidth }
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        setSidebarWidth(start.current.w + (e.clientX - start.current.x))
      }}
      onPointerUp={(e) => {
        try {
          ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
        } catch {
          /* already released */
        }
      }}
      onDoubleClick={() => setSidebarWidth(360)}
    />
  )
}
