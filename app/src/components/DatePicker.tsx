import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DateSpec, Precision } from '../types'
import { addUnits, dayToDate, dayToIso, floorToUnit, isoToDay, todayDay } from '../lib/time'
import { POP_OUT_MS, presenceClass, usePresence } from '../lib/presence'

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const FULL = ['January','February','March','April','May','June','July','August','September','October','November','December']
const PRECISIONS: Precision[] = ['day', 'week', 'month', 'quarter', 'year']

/** Which grid to show. Week picks a day and snaps to its Monday. */
const gridFor = (p: Precision) => (p === 'day' || p === 'week' ? 'day' : p)

function label(spec: DateSpec): string {
  const d = dayToDate(isoToDay(spec.date))
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  switch (spec.precision) {
    case 'year': return String(y)
    case 'quarter': return `Q${Math.floor(m / 3) + 1} ${y}`
    case 'month': return `${MONTHS[m]} ${y}`
    case 'week': return `Week of ${MONTHS[m]} ${d.getUTCDate()}`
    default: return `${MONTHS[m]} ${d.getUTCDate()}, ${y}`
  }
}

interface Props {
  value: DateSpec | null
  onChange: (value: DateSpec | null) => void
  /** Earliest selectable day number, for an end date. */
  minDay?: number
  placeholder?: string
  clearable?: boolean
}

export function DatePicker({ value, onChange, minDay, placeholder = 'Empty', clearable }: Props) {
  const [open, setOpen] = useState(false)
  const presence = usePresence(open, POP_OUT_MS)
  const [anchor, setAnchor] = useState({ left: 0, top: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const today = todayDay()
  const selected = value ? isoToDay(value.date) : null
  const precision = value?.precision ?? 'day'
  const grid = gridFor(precision)

  // The month/year the grid is showing, independent of the selection.
  const [cursor, setCursor] = useState(() => floorToUnit(selected ?? today, 'month'))
  useEffect(() => {
    if (open) setCursor(floorToUnit(selected ?? today, 'month'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Fixed positioning keeps the popover out of the panel's overflow clipping.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const w = 246
    const h = 296
    setAnchor({
      left: Math.min(Math.max(8, r.left), window.innerWidth - w - 8),
      top: r.bottom + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const pick = (day: number, p: Precision = precision) => {
    const snapped = p === 'week' ? floorToUnit(day, 'week') : floorToUnit(day, p === 'day' ? 'day' : p)
    onChange({ date: dayToIso(minDay != null ? Math.max(snapped, minDay) : snapped), precision: p })
    if (p === 'day' || p === 'week') setOpen(false)
  }

  const cursorDate = dayToDate(cursor)
  const cYear = cursorDate.getUTCFullYear()
  const cMonth = cursorDate.getUTCMonth()

  const step = (dir: number) => {
    if (grid === 'day') setCursor(addUnits(cursor, 'month', dir))
    else if (grid === 'year') setCursor(addUnits(cursor, 'year', dir * 12))
    else setCursor(addUnits(cursor, 'year', dir))
  }

  const heading =
    grid === 'day'
      ? `${FULL[cMonth]} ${cYear}`
      : grid === 'year'
        ? `${Math.floor(cYear / 12) * 12} – ${Math.floor(cYear / 12) * 12 + 11}`
        : String(cYear)

  const sameCell = (day: number) =>
    selected != null && floorToUnit(selected, grid === 'day' ? 'day' : grid) === day

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={'date-field' + (open ? ' open' : '') + (value ? '' : ' empty')}
        onClick={() => setOpen((o) => !o)}
      >
        {value ? label(value) : placeholder}
      </button>

      {presence.mounted && (
        <div
          className={'datepicker pop' + presenceClass(presence.leaving)}
          ref={popRef}
          style={{ left: anchor.left, top: anchor.top }}
        >
          <div className="dp-head">
            <button className="dp-nav" onClick={() => step(-1)} aria-label="Previous">‹</button>
            <span className="dp-title">{heading}</span>
            <button className="dp-nav" onClick={() => step(1)} aria-label="Next">›</button>
          </div>

          {grid === 'day' && (
            <>
              <div className="dp-dow">
                {DOW.map((d, i) => (
                  <span key={i}>{d}</span>
                ))}
              </div>
              <div className="dp-grid dp-days">
                {Array.from({ length: 42 }, (_, i) => {
                  const day = floorToUnit(floorToUnit(cursor, 'month'), 'week') + i
                  const dt = dayToDate(day)
                  const outside = dt.getUTCMonth() !== cMonth
                  const disabled = minDay != null && day < minDay
                  return (
                    <button
                      key={i}
                      className={
                        'dp-cell' +
                        (outside ? ' outside' : '') +
                        (day === today ? ' today' : '') +
                        (sameCell(day) ? ' on' : '')
                      }
                      disabled={disabled}
                      onClick={() => pick(day)}
                    >
                      {dt.getUTCDate()}
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {grid === 'month' && (
            <div className="dp-grid dp-months">
              {MONTHS.map((m, i) => {
                const day = floorToUnit(Math.floor(Date.UTC(cYear, i, 1) / 86400000), 'month')
                return (
                  <button
                    key={m}
                    className={'dp-cell wide' + (sameCell(day) ? ' on' : '')}
                    disabled={minDay != null && day < floorToUnit(minDay, 'month')}
                    onClick={() => pick(day)}
                  >
                    {m}
                  </button>
                )
              })}
            </div>
          )}

          {grid === 'quarter' && (
            <div className="dp-grid dp-quarters">
              {[0, 1, 2, 3].map((q) => {
                const day = Math.floor(Date.UTC(cYear, q * 3, 1) / 86400000)
                return (
                  <button
                    key={q}
                    className={'dp-cell wide' + (sameCell(day) ? ' on' : '')}
                    disabled={minDay != null && day < floorToUnit(minDay, 'quarter')}
                    onClick={() => pick(day)}
                  >
                    Q{q + 1}
                  </button>
                )
              })}
            </div>
          )}

          {grid === 'year' && (
            <div className="dp-grid dp-years">
              {Array.from({ length: 12 }, (_, i) => {
                const y = Math.floor(cYear / 12) * 12 + i
                const day = Math.floor(Date.UTC(y, 0, 1) / 86400000)
                return (
                  <button
                    key={y}
                    className={'dp-cell wide' + (sameCell(day) ? ' on' : '')}
                    disabled={minDay != null && day < floorToUnit(minDay, 'year')}
                    onClick={() => pick(day)}
                  >
                    {y}
                  </button>
                )
              })}
            </div>
          )}

          <div className="dp-precision">
            {PRECISIONS.map((p) => (
              <button
                key={p}
                className={p === precision ? 'on' : ''}
                title={p === 'day' ? 'An exact date' : `Only certain to the ${p}`}
                onClick={() => pick(selected ?? today, p)}
              >
                {p[0].toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>

          <div className="dp-foot">
            <button onClick={() => pick(today)}>Today</button>
            {clearable && (
              <button
                className="dp-clear"
                onClick={() => {
                  onChange(null)
                  setOpen(false)
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
