import { useMemo, useRef } from 'react'
import { useStore } from '../store'
import { flatten } from '../lib/tree'
import { addUnits, dayToDate, floorToUnit, todayDay } from '../lib/time'
import { cmd } from '../lib/viewport'

const HEIGHT = 64
const PAD_DAYS = 120

/**
 * The whole plan at a glance, with the current canvas window drawn on top.
 * Its own scale is independent of the canvas zoom - it always spans everything
 * you have, so it stays useful at day zoom and at decade zoom alike.
 */
export function Minimap() {
  const items = useStore((s) => s.items)
  const lanes = useStore((s) => s.lanes)
  const noLaneCollapsed = useStore((s) => s.noLaneCollapsed)
  const viewFrom = useStore((s) => s.viewFrom)
  const viewTo = useStore((s) => s.viewTo)
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ grabOffsetDays: number } | null>(null)

  const { rows } = useMemo(
    () => flatten({ items, lanes, search: '', noLaneCollapsed }),
    [items, lanes, noLaneCollapsed],
  )

  const bars = useMemo(() => {
    const out: { key: string; from: number; to: number; colorId: string; slot: number }[] = []
    let slot = 0
    for (const r of rows) {
      if (r.kind !== 'item' || !r.span) continue
      out.push({
        key: r.id,
        from: r.span.startDay,
        to: r.span.endDay + 1,
        colorId: r.colorId,
        slot: slot++,
      })
    }
    return out
  }, [rows])

  const today = todayDay()
  const range = useMemo(() => {
    if (!bars.length) return { from: today - 365, to: today + 365 }
    let lo = Infinity
    let hi = -Infinity
    for (const b of bars) {
      lo = Math.min(lo, b.from)
      hi = Math.max(hi, b.to)
    }
    lo = Math.min(lo, today)
    hi = Math.max(hi, today)
    return { from: lo - PAD_DAYS, to: hi + PAD_DAYS }
  }, [bars, today])

  const totalDays = Math.max(1, range.to - range.from)
  const pct = (day: number) => ((day - range.from) / totalDays) * 100
  const slotCount = Math.max(1, bars.length)
  const step = Math.min(4, (HEIGHT - 14) / slotCount)

  const years = useMemo(() => {
    const out: { day: number; label: string }[] = []
    let cursor = floorToUnit(range.from, 'year')
    // Thin the labels out so they never collide on a narrow strip.
    const everyN = totalDays > 365 * 24 ? 5 : totalDays > 365 * 10 ? 2 : 1
    let i = 0
    while (cursor < range.to && out.length < 60) {
      if (i % everyN === 0) {
        out.push({ day: cursor, label: String(dayToDate(cursor).getUTCFullYear()) })
      }
      cursor = addUnits(cursor, 'year', 1)
      i++
    }
    return out
  }, [range.from, range.to, totalDays])

  const dayAtClientX = (clientX: number) => {
    const el = ref.current
    if (!el) return today
    const rect = el.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return range.from + frac * totalDays
  }

  const windowDays = Math.max(1, viewTo - viewFrom)

  const onDown = (e: React.PointerEvent) => {
    const day = dayAtClientX(e.clientX)
    const inWindow = day >= viewFrom && day <= viewTo
    drag.current = { grabOffsetDays: inWindow ? day - viewFrom : windowDays / 2 }
    cmd.goToDay(day - drag.current.grabOffsetDays, 0, !inWindow)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    cmd.goToDay(dayAtClientX(e.clientX) - drag.current.grabOffsetDays, 0, false)
  }

  const onUp = (e: React.PointerEvent) => {
    drag.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  return (
    <div
      className="minimap"
      ref={ref}
      style={{ height: HEIGHT }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      role="scrollbar"
      aria-label="Timeline overview"
      aria-controls="timeline-canvas"
    >
      {years.map((y) => (
        <div key={y.day} className="mini-year" style={{ left: `${pct(y.day)}%` }}>
          {y.label}
        </div>
      ))}
      {bars.map((b) => (
        <div
          key={b.key}
          className={'mini-row c-' + b.colorId}
          style={{
            left: `${pct(b.from)}%`,
            width: `max(2px, ${pct(b.to) - pct(b.from)}%)`,
            top: 7 + b.slot * step,
          }}
        />
      ))}
      <div className="mini-today" style={{ left: `${pct(today)}%` }} />
      <div
        className="mini-window"
        style={{ left: `${pct(viewFrom)}%`, width: `${(windowDays / totalDays) * 100}%` }}
      />
    </div>
  )
}
