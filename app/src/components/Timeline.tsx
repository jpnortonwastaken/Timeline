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
import type { MenuState } from './ContextMenu'

const OVERSCAN_PX = 400
const OVERSCAN_ROWS = 6
/** Keep in step with --reveal in styles.css. */
const REVEAL_MS = 190

interface Reveal {
  /** Keys of rows that just appeared, so they fade in. */
  enter: Set<string>
  /** Rows that just left, held at their old y until the fade finishes. */
  exit: { row: TreeRow; top: number }[]
}

type Mode = 'move' | 'start' | 'end' | 'create' | 'link' | 'marquee' | 'reorder'

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
  createCtx: { laneId: string | null; parentId: string | null } | null
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

export function Timeline() {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
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
  const createLane = useStore((s) => s.createLane)
  const setEditingLane = useStore((s) => s.setEditingLane)
  const setViewRange = useStore((s) => s.setViewRange)

  const [view, setView] = useState({ scrollTop: 0, scrollLeft: 0, w: 1200, h: 800 })
  const [linkingActive, setLinkingActive] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)

  // Live values for listeners that must not be re-bound on every render.
  const ppdRef = useRef(ppd)
  const sidebarRef = useRef(sidebarWidth)
  ppdRef.current = ppd
  sidebarRef.current = sidebarWidth

  const { rows } = useMemo(
    () => flatten({ items, lanes, search, noLaneCollapsed }),
    [items, lanes, search, noLaneCollapsed],
  )

  const rowH = DENSITY_HEIGHT[density]
  const rowsHeight = rows.length * rowH
  const contentWidth = sidebarWidth + totalWidth(ppd)
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
     Driven off the collapse state alone, so the many other things that
     reshape the list - editing, searching, reordering, undo - stay instant
     and keep their direct-style-mutation fast paths. */
  const collapseSig = useMemo(() => {
    const parts: string[] = []
    for (const id in items) if (items[id].collapsed) parts.push(id)
    for (const id in lanes) if (lanes[id].collapsed) parts.push('g:' + id)
    if (noLaneCollapsed) parts.push('g:none')
    return parts.sort().join(',')
  }, [items, lanes, noLaneCollapsed])

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
    if (!enter.size && !exit.length) return

    setReveal({ enter, exit })
    // A ref rather than effect cleanup: `rows` can change again mid-flight,
    // and a cleanup would cancel the reset and strand ghosts on screen.
    window.clearTimeout(revealTimer.current)
    revealTimer.current = window.setTimeout(() => setReveal(null), REVEAL_MS)
  }, [collapseSig, rows, rowH])

  useEffect(() => () => window.clearTimeout(revealTimer.current), [])

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
      setViewRange(
        xToDay(el.scrollLeft, ppdRef.current),
        xToDay(el.scrollLeft + el.clientWidth - sw, ppdRef.current),
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
  const lastRow = Math.min(rows.length, Math.ceil((view.scrollTop + view.h) / rowH) + OVERSCAN_ROWS)
  const visibleRows = rows.slice(firstRow, lastRow)
  const selectionSet = useMemo(() => new Set(selection), [selection])

  // -- dependency arrows -----------------------------------------------------
  const depPaths = useMemo(() => {
    const xLo = view.scrollLeft - sidebarWidth - OVERSCAN_PX
    const xHi = view.scrollLeft + view.w - sidebarWidth + OVERSCAN_PX
    const out: { id: string; d: string; head: string }[] = []

    for (const dep of Object.values(deps)) {
      const a = geo.get(dep.fromId)
      const b = geo.get(dep.toId)
      if (!a || !b) continue
      if (a.index < firstRow - 40 && b.index < firstRow - 40) continue
      if (a.index > lastRow + 40 && b.index > lastRow + 40) continue

      const fromX = dayToX(dep.type === 'start-to-start' ? a.span.startDay : a.span.endDay + 1, ppd)
      const toX = dayToX(b.span.startDay, ppd)
      if (Math.max(fromX, toX) < xLo || Math.min(fromX, toX) > xHi) continue

      const x1 = sidebarWidth + fromX
      const x2 = sidebarWidth + toX
      const y1 = (a.index + 0.5) * rowH
      const y2 = (b.index + 0.5) * rowH

      // Standard Gantt elbow; route around when the successor starts too early.
      const tip = x2 - DEP_HEAD
      const pts: Pt[] =
        tip - x1 > DEP_STUB + 6
          ? [
              [x1, y1],
              [x1 + DEP_STUB, y1],
              [x1 + DEP_STUB, y2],
              [tip, y2],
            ]
          : (() => {
              const midY = y1 + (y2 > y1 ? rowH / 2 : -rowH / 2)
              return [
                [x1, y1],
                [x1 + DEP_STUB, y1],
                [x1 + DEP_STUB, midY],
                [x2 - DEP_BACK, midY],
                [x2 - DEP_BACK, y2],
                [tip, y2],
              ] as Pt[]
            })()

      out.push({
        id: dep.id,
        d: roundedPolyline(pts, DEP_RADIUS),
        head: `M${tip},${y2 - 4.5} L${x2 - 0.5},${y2} L${tip},${y2 + 4.5} Z`,
      })
    }
    return out
  }, [deps, geo, ppd, sidebarWidth, rowH, view.scrollLeft, view.w, firstRow, lastRow])

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

  const newItemIn = (laneId: string | null, status?: string) => {
    const t = todayDay()
    const id = createItem({
      laneId,
      start: { date: dayToIso(t), precision: 'day' },
      end: { date: dayToIso(t + 6), precision: 'day' },
      ...(status ? { status: status as never } : {}),
    })
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

    // Removing a dependency: click its line.
    const depHit = target.closest('[data-dep-id]') as HTMLElement | null
    if (depHit) {
      removeDep(depHit.dataset.depId!)
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
      newItemIn(rowEl.dataset.laneId || null, rowEl.dataset.status || undefined)
      return
    }
    if (kind === 'new-lane') {
      e.preventDefault()
      setEditingLane(createLane('New lane'))
      return
    }
    if (target.closest('[data-group-add]')) {
      e.preventDefault()
      const gid = rowEl.dataset.groupId
      newItemIn(gid && gid !== '__none' ? gid : null)
      return
    }

    const sw = sidebarRef.current
    const perDay = ppdRef.current
    const snapUnit = tierFor(perDay).snap
    const base: Drag = { ...blank(e), snapUnit }
    const capture = () => {
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* pointer already gone; the window-level move/up handlers still work */
      }
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

    // 3. Sidebar clicks are selection only.
    if (target.closest('.side')) {
      if (itemId) {
        if (e.shiftKey || e.metaKey) toggleSelect(itemId)
        else select([itemId])
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
    const anchor = snapDay(Math.round(xToDay(e.clientX - rect.left - sw, perDay)), snapUnit)
    const row = rows[Number(rowEl.dataset.rowIndex)]
    const createCtx =
      row?.kind === 'item'
        ? { laneId: row.item.laneId, parentId: row.item.parentId }
        : {
            laneId: rowEl.dataset.groupId === '__none' ? null : rowEl.dataset.groupId ?? null,
            parentId: null,
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
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) {
      const h = (e.target as HTMLElement).closest('[data-handle]') as HTMLElement | null
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
    }

    const perDay = ppdRef.current
    const sw = sidebarRef.current
    const free = e.altKey
    const toDay = (raw: number) => (free ? Math.round(raw) : snapDay(Math.round(raw), d.snapUnit))

    if (d.mode === 'link') {
      const from = geo.get(d.linkFrom!)
      if (!from) return
      const p = toLayer(e.clientX, e.clientY)
      const x1 = sw + dayToX(d.linkDir === 'out' ? from.span.endDay + 1 : from.span.startDay, perDay)
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

    if (d.mode === 'reorder') {
      const hovered = hitRowAt(e.clientX, e.clientY)
      const id = hovered?.dataset.itemId
      layerRef.current?.querySelectorAll('.drop-line, .drop-into').forEach((n) => n.remove())
      d.dropTarget = null
      if (!id || id === d.ids[0]) return

      const rowTop = Number(hovered!.style.top.replace('px', ''))
      const rel = (e.clientY - hovered!.getBoundingClientRect().top) / rowH
      const position = rel < 0.3 ? 'before' : rel > 0.7 ? 'after' : 'child'
      d.dropTarget = { id, position }

      const marker = document.createElement('div')
      if (position === 'child') {
        marker.className = 'drop-into'
        marker.style.top = `${rowTop}px`
        marker.style.height = `${rowH}px`
      } else {
        marker.className = 'drop-line'
        marker.style.top = `${rowTop + (position === 'after' ? rowH : 0) - 1}px`
      }
      layerRef.current?.appendChild(marker)
      showTip(
        e.clientX,
        e.clientY,
        position === 'child'
          ? `Nest under “${items[id]?.title || 'Untitled'}”`
          : `Move ${position} “${items[id]?.title || 'Untitled'}”`,
      )
      return
    }

    if (d.mode === 'move' && d.axis === 'y') {
      // Re-ordering: the dates are left exactly as they were, and the bar stays
      // on its own row. The drop line is the only thing that moves, so nothing
      // jumps around until the drop actually lands.
      layerRef.current?.querySelectorAll('.drop-line').forEach((n) => n.remove())
      d.dropTarget = null

      const layerRect = layerRef.current?.getBoundingClientRect()
      if (layerRect) {
        // Row geometry is uniform, so arithmetic beats hit-testing here.
        const raw = (e.clientY - layerRect.top) / rowH
        const idx = Math.max(0, Math.min(rows.length - 1, Math.floor(raw)))
        const over = rows[idx]
        const moving = new Set(d.ids)
        if (over?.kind === 'item' && !moving.has(over.id) && idx !== d.sourceIndex) {
          const position = raw - Math.floor(raw) < 0.5 ? 'before' : 'after'
          d.dropTarget = { id: over.id, position }
          const line = document.createElement('div')
          line.className = 'drop-line'
          line.style.top = `${(idx + (position === 'after' ? 1 : 0)) * rowH - 1}px`
          layerRef.current?.appendChild(line)
        }
      }

      showTip(
        e.clientX,
        e.clientY,
        d.dropTarget
          ? `${d.dropTarget.position === 'before' ? 'Above' : 'Below'} “${
              items[d.dropTarget.id]?.title || 'Untitled'
            }”`
          : 'Drag over a row',
      )
    } else if (d.mode === 'move') {
      const ns = toDay(d.origStart + dx / perDay)
      d.finalStart = ns
      d.finalEnd = ns + (d.origEnd - d.origStart)
      for (const el of d.els) el.style.transform = `translateX(${(ns - d.origStart) * perDay}px)`
      showTip(e.clientX, e.clientY, spanLabel(d.finalStart, d.finalEnd, d.origStart === d.origEnd))
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
      showTip(e.clientX, e.clientY, spanLabel(d.finalStart, d.finalEnd, false))
    } else if (d.mode === 'end') {
      const ne = Math.max(toDay(d.origEnd + dx / perDay), d.origStart)
      d.finalStart = d.origStart
      d.finalEnd = ne
      const width = Math.max(6, (ne + 1 - d.origStart) * perDay)
      if (d.primary) d.primary.style.width = `${width}px`
      showGuide(d.origLeft + width, d.sourceIndex, formatDate(dayToIso(ne)), false)
      showTip(e.clientX, e.clientY, spanLabel(d.finalStart, d.finalEnd, false))
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
      showTip(e.clientX, e.clientY, spanLabel(a, b, false))
    }
  }

  // -- pointer up ------------------------------------------------------------
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    hideTip()
    hideGuide()
    if (!d) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }

    d.ghost?.remove()
    layerRef.current?.querySelectorAll('.drop-line, .drop-into').forEach((n) => n.remove())
    linkPathRef.current?.setAttribute('d', '')

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

    if (!d.moved) {
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
      if (d.finalEnd <= d.finalStart) return
      const id = createItem({
        title: '',
        laneId: d.createCtx?.laneId ?? null,
        parentId: d.createCtx?.parentId ?? null,
        start: { date: dayToIso(d.finalStart), precision: 'day' },
        end: { date: dayToIso(d.finalEnd), precision: 'day' },
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
          style={{ width: contentWidth, height: HEADER_HEIGHT + rowsHeight + 120 }}
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
          <div className="grid" style={{ top: HEADER_HEIGHT, height: rowsHeight + 120 }}>
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
            style={{ width: sidebarWidth, height: rowsHeight + 120, display: sidebarWidth ? undefined : 'none' }}
          />

          {/* ---- rows ---- */}
          <div
            className={'layer' + (reveal ? ' revealing' : '')}
            ref={layerRef}
            style={{ top: HEADER_HEIGHT, height: rowsHeight + 120 }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onPointerLeave={hideGuide}
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

            {/* ...and the rows that just left stay one beat longer to fade out.
                Culled to the viewport so collapsing a huge subtree doesn't
                mount hundreds of throwaway rows. */}
            {reveal?.exit
              .filter(
                (x) =>
                  x.top + rowH > view.scrollTop - rowH * OVERSCAN_ROWS &&
                  x.top < view.scrollTop + view.h + rowH * OVERSCAN_ROWS,
              )
              .map((x) => (
                <TimelineRow
                  key={'exit:' + x.row.key}
                  row={x.row}
                  index={-1}
                  top={x.top}
                  height={rowH}
                  ppd={ppd}
                  sidebarWidth={sidebarWidth}
                  selected={false}
                  editing={false}
                  columns={columns}
                  linking={false}
                  anim="exit"
                  ghost
                />
              ))}

            <svg className="deps" width={contentWidth} height={rowsHeight}>
              {depPaths.map((p) => (
                <g key={p.id}>
                  <path className="dep-path" d={p.d} />
                  <path className="dep-head" d={p.head} />
                  <path className="dep-hit" d={p.d} data-dep-id={p.id}>
                    <title>Click to remove this dependency</title>
                  </path>
                </g>
              ))}
              <path className="dep-path hot" ref={linkPathRef} d="" />
            </svg>
          </div>
        </div>
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      <div className="drag-tip" ref={tipRef} />
      {sidebarOpen && <SidebarResizer />}
      {!rows.some((r) => r.kind === 'item') && (
        <div className="empty-state">
          <p>Nothing here yet.</p>
          <p className="muted">Drag anywhere on the canvas to block out time.</p>
        </div>
      )}
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
