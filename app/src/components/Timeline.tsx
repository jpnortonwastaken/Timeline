import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { descendants, flatten } from '../lib/tree'
import type { Span } from '../lib/tree'
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
import { cmd, DENSITY_HEIGHT, HEADER_HEIGHT, TIER_HEIGHT } from '../lib/viewport'
import { TimelineRow } from './Row'

const OVERSCAN_PX = 400
const OVERSCAN_ROWS = 6

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
  /** reorder mode */
  dropTarget: { id: string; position: 'before' | 'after' | 'child' } | null
}

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
  const linkPathRef = useRef<SVGPathElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const pendingScrollLeft = useRef<number | null>(null)
  const rafRef = useRef(0)

  const items = useStore((s) => s.items)
  const lanes = useStore((s) => s.lanes)
  const deps = useStore((s) => s.deps)
  const groupBy = useStore((s) => s.groupBy)
  const search = useStore((s) => s.search)
  const ppd = useStore((s) => s.ppd)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const density = useStore((s) => s.density)
  const columns = useStore((s) => s.visibleColumns)
  const selection = useStore((s) => s.selection)
  const editingId = useStore((s) => s.editingId)

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
  const setViewRange = useStore((s) => s.setViewRange)

  const [view, setView] = useState({ scrollTop: 0, scrollLeft: 0, w: 1200, h: 800 })
  const [linkingActive, setLinkingActive] = useState(false)

  // Live values for listeners that must not be re-bound on every render.
  const ppdRef = useRef(ppd)
  const sidebarRef = useRef(sidebarWidth)
  ppdRef.current = ppd
  sidebarRef.current = sidebarWidth

  const { rows } = useMemo(
    () => flatten({ items, lanes, groupBy, search }),
    [items, lanes, groupBy, search],
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

  // -- scroll tracking -------------------------------------------------------
  const syncView = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
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
    })
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
  const goToDay = useCallback((day: number, align = 0.32, smooth = true) => {
    const el = scrollerRef.current
    if (!el) return
    const sw = sidebarRef.current
    const left = dayToX(day, ppdRef.current) - (el.clientWidth - sw) * align
    el.scrollTo({ left: Math.max(0, left), behavior: smooth ? 'smooth' : 'auto' })
  }, [])

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

  // -- pinch / cmd-scroll zoom ----------------------------------------------
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoom(ppdRef.current * Math.exp(-e.deltaY * 0.0125), e.clientX)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom])

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
      const d =
        x2 - x1 > 22
          ? `M${x1},${y1} H${x1 + 11} V${y2} H${x2 - 6}`
          : `M${x1},${y1} H${x1 + 11} V${y1 + (y2 > y1 ? rowH / 2 : -rowH / 2)} ` +
            `H${x2 - 17} V${y2} H${x2 - 6}`

      out.push({ id: dep.id, d, head: `M${x2 - 6},${y2 - 4} L${x2},${y2} L${x2 - 6},${y2 + 4} Z` })
    }
    return out
  }, [deps, geo, ppd, sidebarWidth, rowH, view.scrollLeft, view.w, firstRow, lastRow])

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
    const target = e.target as HTMLElement
    if (target.closest('.title-input') || target.closest('.disclosure')) return

    // Removing a dependency: click its line.
    const depHit = target.closest('[data-dep-id]') as HTMLElement | null
    if (depHit) {
      removeDep(depHit.dataset.depId!)
      return
    }

    const sw0 = sidebarRef.current
    const startMarquee = () => {
      const p = toLayer(e.clientX, e.clientY)
      const box = document.createElement('div')
      box.className = 'marquee'
      box.style.left = `${p.x}px`
      box.style.top = `${p.y}px`
      layerRef.current?.appendChild(box)
      dragRef.current = { ...blank(e), mode: 'marquee', ghost: box, anchorDay: p.x, origStart: p.y }
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* pointer already gone */
      }
    }

    const rowEl = target.closest('[data-row-index]') as HTMLElement | null
    if (!rowEl) {
      // Empty space below the last row: still a valid place to start a marquee.
      if ((e.shiftKey || e.metaKey) && e.clientX - (scrollerRef.current?.getBoundingClientRect().left ?? 0) > sw0) {
        startMarquee()
      } else {
        select([])
      }
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

      if (e.shiftKey || e.metaKey) toggleSelect(itemId)
      else if (!selectionSet.has(itemId)) select([itemId])

      const handle = (target.closest('[data-handle]') as HTMLElement | null)?.dataset.handle
      const mode = (handle as 'start' | 'end' | undefined) ?? 'move'

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
      }
      capture()
      return
    }

    // 5. Empty canvas: modifier drags a marquee, plain drag creates an item.
    if (e.shiftKey || e.metaKey) {
      startMarquee()
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
    if (!d) return
    const dx = e.clientX - d.startClientX
    const dy = e.clientY - d.startClientY
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    d.moved = true

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
      const box = d.ghost!
      box.style.left = `${Math.min(d.anchorDay, p.x)}px`
      box.style.top = `${Math.min(d.origStart, p.y)}px`
      box.style.width = `${Math.abs(p.x - d.anchorDay)}px`
      box.style.height = `${Math.abs(p.y - d.origStart)}px`
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

    if (d.mode === 'move') {
      const ns = toDay(d.origStart + dx / perDay)
      d.finalStart = ns
      d.finalEnd = ns + (d.origEnd - d.origStart)
      const px = (ns - d.origStart) * perDay
      for (const el of d.els) el.style.transform = `translateX(${px}px)`
      showTip(e.clientX, e.clientY, spanLabel(d.finalStart, d.finalEnd, d.origStart === d.origEnd))
    } else if (d.mode === 'start') {
      const ns = Math.min(toDay(d.origStart + dx / perDay), d.origEnd)
      d.finalStart = ns
      d.finalEnd = d.origEnd
      if (d.primary) {
        d.primary.style.left = `${d.origLeft + (ns - d.origStart) * perDay}px`
        d.primary.style.width = `${Math.max(6, (d.origEnd + 1 - ns) * perDay)}px`
      }
      showTip(e.clientX, e.clientY, spanLabel(d.finalStart, d.finalEnd, false))
    } else if (d.mode === 'end') {
      const ne = Math.max(toDay(d.origEnd + dx / perDay), d.origStart)
      d.finalStart = d.origStart
      d.finalEnd = ne
      if (d.primary) d.primary.style.width = `${Math.max(6, (ne + 1 - d.origStart) * perDay)}px`
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
    for (const el of d.els) el.style.transform = ''
    if (d.primary && (d.mode === 'start' || d.mode === 'end')) {
      d.primary.style.left = `${d.origLeft}px`
      d.primary.style.width = `${d.origWidth}px`
    }

    if (!d.moved) return

    if (d.mode === 'marquee') {
      const box = d.ghost!
      const x0 = parseFloat(box.style.left)
      const y0 = parseFloat(box.style.top)
      const x1 = x0 + parseFloat(box.style.width || '0')
      const y1 = y0 + parseFloat(box.style.height || '0')
      const hits: string[] = []
      for (const [id, g] of geo) {
        const bx0 = sidebarWidth + dayToX(g.span.startDay, ppd)
        const bx1 = sidebarWidth + dayToX(g.span.endDay + 1, ppd)
        const by0 = g.index * rowH
        const by1 = by0 + rowH
        if (bx1 >= x0 && bx0 <= x1 && by1 >= y0 && by0 <= y1) hits.push(id)
      }
      select(hits)
      return
    }

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
    if (d.mode === 'move') {
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
    cascade()
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const rowEl = (e.target as HTMLElement).closest('[data-row-index]') as HTMLElement | null
    const id = rowEl?.dataset.itemId
    if (id) setEditing(id)
  }

  // -- render ----------------------------------------------------------------
  const todayX = sidebarWidth + dayToX(today, ppd)
  const todayW = Math.max(2, ppd)

  return (
    <div className="timeline">
      <div className="scroller" id="timeline-canvas" ref={scrollerRef} onScroll={syncView}>
        <div
          className="content"
          style={{ width: contentWidth, height: HEADER_HEIGHT + rowsHeight + 120 }}
        >
          {/* ---- header ---- */}
          <div className="head" style={{ height: HEADER_HEIGHT }}>
            <div className="head-corner" style={{ width: sidebarWidth }}>
              <span className="head-col name">Name</span>
              {columns.includes('status') && <span className="head-col" style={{ width: 88 }}>Status</span>}
              {columns.includes('dates') && <span className="head-col" style={{ width: 88 }}>{COLUMN_LABELS.dates}</span>}
              {columns.includes('span') && <span className="head-col" style={{ width: 52 }}>{COLUMN_LABELS.span}</span>}
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
            {ppd >= 3 && <div className="today-band" style={{ left: todayX, width: todayW }} />}
            <div className="today-line" style={{ left: todayX }} />
          </div>

          {/* ---- rows ---- */}
          <div
            className="layer"
            ref={layerRef}
            style={{ top: HEADER_HEIGHT, height: rowsHeight + 120 }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
          >
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
                editing={row.kind === 'item' && editingId === row.id}
                columns={columns}
                linking={linkingActive}
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

      <div className="drag-tip" ref={tipRef} />
      <SidebarResizer />
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
