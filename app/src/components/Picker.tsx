import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { POP_OUT_MS, presenceClass, usePresence } from '../lib/presence'

export interface PickerOption {
  id: string
  /** Used for the trigger's accessible text and as the fallback visual. */
  label: string
  /** The coloured chip shown in the list and on the trigger. */
  node?: ReactNode
}

interface Props {
  value: string
  options: PickerOption[]
  onChange: (id: string) => void
  ariaLabel: string
}

function Tick() {
  return (
    <svg className="menu-tick" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M2.5 6.2 4.8 8.5 9.5 3.8"
        fill="none"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * A select replacement, so the options can carry their own colour instead of
 * being flattened into native menu text. Positioned `fixed` for the same
 * reason DatePicker is: the detail panel scrolls, and a popover laid out
 * inside it would be clipped by that overflow.
 */
export function Picker({ value, options, onChange, ariaLabel }: Props) {
  const [open, setOpen] = useState(false)
  const presence = usePresence(open, POP_OUT_MS)
  const [anchor, setAnchor] = useState({ left: 0, top: 0, width: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const current = options.find((o) => o.id === value) ?? options[0]

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const h = Math.min(options.length * 30 + 10, 280)
    setAnchor({
      left: Math.min(r.left, window.innerWidth - r.width - 8),
      top: r.bottom + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4,
      width: r.width,
    })
  }, [open, options.length])

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

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={'picker-field' + (open ? ' open' : '')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="picker-value">{current?.node ?? current?.label}</span>
        <svg className="picker-chev" viewBox="0 0 12 12" aria-hidden>
          <path
            d="M3.5 4.75 6 7.25l2.5-2.5"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {presence.mounted && (
        <div
          className={'picker-menu pop' + presenceClass(presence.leaving)}
          role="listbox"
          ref={popRef}
          style={{ left: anchor.left, top: anchor.top, minWidth: anchor.width }}
        >
          {options.map((o) => (
            <button
              key={o.id}
              role="option"
              aria-selected={o.id === value}
              className="menu-item"
              onClick={() => {
                onChange(o.id)
                setOpen(false)
              }}
            >
              <span className="menu-label">{o.node ?? o.label}</span>
              {o.id === value && <Tick />}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
