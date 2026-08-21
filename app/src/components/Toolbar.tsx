import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { POP_OUT_MS, presenceClass, usePresence } from '../lib/presence'
import { ALL_COLUMNS, useStore } from '../store'
import { MAX_PPD, MIN_PPD, todayDay, ZOOM_PRESETS } from '../lib/time'
import { cmd } from '../lib/viewport'
import type { Density, ThemeMode } from '../types'
import { downloadJSON, pickAndImport } from '../lib/io'

/** Drawn on a 12-unit box, spanning most of it so the tick actually reads at
 *  checkbox size rather than looking like a plain filled square. */
function TickIcon() {
  return (
    <svg className="menu-tick" viewBox="0 0 12 12" aria-hidden>
      <path d="M1.8 6.4 4.7 9.4 10.2 3.1" />
    </svg>
  )
}

/** Single choice: a radio circle, so it can't be mistaken for a toggle. */
function RadioItem({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button className="menu-item" role="menuitemradio" aria-checked={on} onClick={onClick}>
      <span className={'menu-radio' + (on ? ' on' : '')} />
      <span className="menu-label">{label}</span>
    </button>
  )
}

/** Multiple choice: a square box with a real tick. */
function CheckItem({
  label,
  on,
  onClick,
  title,
  hint,
}: {
  label: string
  on: boolean
  onClick: () => void
  title?: string
  /** Shortcut shown on the right. Native `title` tooltips are slow and don't
      render reliably in WKWebView, so bindings are spelled out in the menu. */
  hint?: string
}) {
  return (
    <button
      className="menu-item"
      role="menuitemcheckbox"
      aria-checked={on}
      title={title}
      onClick={onClick}
    >
      <span className={'menu-box' + (on ? ' on' : '')}>{on && <TickIcon />}</span>
      <span className="menu-label">{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  )
}

function GearIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

/** Chevrons pointing apart - unfold. */
function ExpandIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden>
      <path d="m7 9 5-5 5 5" />
      <path d="m7 15 5 5 5-5" />
    </svg>
  )
}

/** Chevrons pointing together - fold. */
function CollapseIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden>
      <path d="m7 4 5 5 5-5" />
      <path d="m7 20 5-5 5 5" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function SidebarIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M10 4v16" />
    </svg>
  )
}

function UndoIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  )
}

function RedoIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
  )
}

/** Map ppd onto a 0..1 slider position logarithmically, so the slider feels even. */
const toSlider = (ppd: number) =>
  (Math.log(ppd) - Math.log(MIN_PPD)) / (Math.log(MAX_PPD) - Math.log(MIN_PPD))
const fromSlider = (v: number) =>
  Math.exp(Math.log(MIN_PPD) + v * (Math.log(MAX_PPD) - Math.log(MIN_PPD)))

function ViewMenu() {
  const [open, setOpen] = useState(false)
  const menuPresence = usePresence(open, POP_OUT_MS)
  const ref = useRef<HTMLDivElement>(null)

  const density = useStore((s) => s.density)
  const columns = useStore((s) => s.visibleColumns)
  const autoShift = useStore((s) => s.autoShift)
  const showMinimap = useStore((s) => s.showMinimap)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const setDensity = useStore((s) => s.setDensity)
  const toggleColumn = useStore((s) => s.toggleColumn)
  const toggleAutoShift = useStore((s) => s.toggleAutoShift)
  const toggleMinimap = useStore((s) => s.toggleMinimap)
  const resetToSeed = useStore((s) => s.resetToSeed)
  const themeMode = useStore((s) => s.themeMode)
  const setThemeMode = useStore((s) => s.setThemeMode)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
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

  const close = (fn: () => void) => () => {
    fn()
    setOpen(false)
  }

  return (
    <div className="menu" ref={ref}>
      <button
        className={'btn icon' + (open ? ' on' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        title="Settings (⌘,)"
        data-settings-toggle
      >
        <GearIcon />
      </button>
      {menuPresence.mounted && (
        <div className={'menu-body pop' + presenceClass(menuPresence.leaving)} role="menu">
          <p className="menu-head">Appearance</p>
          {(['light', 'dark', 'auto'] as ThemeMode[]).map((m) => (
            <RadioItem
              key={m}
              label={m === 'auto' ? 'Match system' : m[0].toUpperCase() + m.slice(1)}
              on={themeMode === m}
              onClick={() => setThemeMode(m)}
            />
          ))}

          <div className="menu-sep" />
          <p className="menu-head">Row height</p>
          {(['compact', 'normal', 'roomy'] as Density[]).map((d) => (
            <RadioItem
              key={d}
              label={d[0].toUpperCase() + d.slice(1)}
              on={density === d}
              onClick={() => setDensity(d)}
            />
          ))}

          <div className="menu-sep" />
          <p className="menu-head">Table</p>
          <CheckItem
            label="Show the table"
            hint="⌘\"
            on={sidebarOpen}
            onClick={toggleSidebar}
          />

          <div className="menu-sep" />
          <p className="menu-head">Columns</p>
          {ALL_COLUMNS.map((c) => (
            <CheckItem
              key={c}
              label={c[0].toUpperCase() + c.slice(1)}
              on={columns.includes(c)}
              onClick={() => toggleColumn(c)}
            />
          ))}

          <div className="menu-sep" />
          <p className="menu-head">Behavior</p>
          <CheckItem
            label="Auto-shift dependents"
            title="Move dependent items forward when a predecessor moves"
            on={autoShift}
            onClick={toggleAutoShift}
          />
          <CheckItem label="Overview strip" on={showMinimap} onClick={toggleMinimap} />

          <div className="menu-sep" />
          <p className="menu-head">Data</p>
          <button className="menu-item plain" onClick={close(downloadJSON)}>
            <span className="menu-label">Export JSON…</span>
          </button>
          <button className="menu-item plain" onClick={close(pickAndImport)}>
            <span className="menu-label">Import JSON…</span>
          </button>
          <button
            className="menu-item plain"
            onClick={close(() => {
              if (confirm('Replace everything with the sample plan? This can be undone with ⌘Z.'))
                resetToSeed()
            })}
          >
            <span className="menu-label">Reset to sample data</span>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * How much the bar sheds as it narrows. Measured against the toolbar's own
 * *content box*, so the Mac app's 92px of traffic-light padding is accounted
 * for automatically rather than needing a second set of breakpoints.
 *
 * The last step swaps the 324px preset row for the 92px slider: zoom is the one
 * control that can't be dropped, so at the very smallest sizes it changes shape
 * instead of disappearing.
 */
interface ToolbarFit {
  slider: boolean
  expand: boolean
  history: boolean
  search: 'full' | 'mini'
  presets: boolean
}

/**
 * What the bar sheds as it narrows, richest first. Ordered by how much room
 * each step actually frees: because the centre group is truly centred, the
 * layout needs `centre + 2 x widestSide`, so trimming the *right* side buys
 * twice what trimming the centre does — and trimming the left buys nothing
 * while the right side is the wider one.
 *
 * The last step swaps the 324px preset row for the 92px slider: zoom is the one
 * control that can't be dropped, so it changes shape instead of disappearing.
 */
const TIERS: ToolbarFit[] = [
  { slider: true, expand: true, history: true, search: 'full', presets: true },
  { slider: false, expand: true, history: true, search: 'full', presets: true },
  { slider: false, expand: true, history: false, search: 'full', presets: true },
  { slider: false, expand: true, history: false, search: 'mini', presets: true },
  { slider: false, expand: false, history: false, search: 'mini', presets: true },
  // Zoom can't vanish entirely, so the preset row gives way to the slider.
  { slider: true, expand: false, history: false, search: 'mini', presets: false },
]

const EDGE_GAP = 10

/**
 * Step down a tier at a time until the centre group clears both sides.
 *
 * Measured rather than driven by width breakpoints: the numbers would have to
 * be recomputed by hand every time anything in the bar changes, and they'd also
 * need a second set for the Mac app, whose traffic-light padding eats 92px.
 */
function useToolbarFit(ref: React.RefObject<HTMLElement | null>) {
  const [tier, setTier] = useState(0)
  // `setTier(0)` when the tier is already 0 is a no-op, so React skips the
  // render and the measuring effect below never runs. This forces a render on
  // every width change so the bar always re-measures.
  const [, remeasure] = useReducer((n: number) => n + 1, 0)

  // Any width change starts again from the richest layout, so the bar fills
  // back out when the window grows rather than only ever shedding.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const reset = () => {
      setTier(0)
      remeasure()
    }
    const ro = new ResizeObserver(reset)
    ro.observe(el)
    window.addEventListener('resize', reset)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', reset)
    }
  }, [ref])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || tier >= TIERS.length - 1) return
    const centre = el.querySelector('.tb-center')?.getBoundingClientRect()
    // The sides are flex boxes that shrink to equal widths, so their contents
    // overflow them - measure the content edges, not the boxes.
    const leftEdge = el.querySelector('.tb-side > *:last-child')?.getBoundingClientRect().right
    const rightEdge = el.querySelector('.tb-right > *:first-child')?.getBoundingClientRect().left
    if (!centre) return
    const collides =
      (leftEdge != null && centre.left < leftEdge + EDGE_GAP) ||
      (rightEdge != null && centre.right > rightEdge - EDGE_GAP)
    if (collides) setTier((t) => t + 1)
  })

  return TIERS[tier]
}

export function Toolbar() {
  const barRef = useRef<HTMLElement>(null)
  const fit = useToolbarFit(barRef)
  // When there's no room for a usable field, search collapses to an icon and
  // opens into a proper one - a 34px stub was worse than either.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const compactSearch = fit.search === 'mini'
  const searchAsField = !compactSearch || searchOpen

  // Close on an outside press rather than on blur. Blur is unreliable here -
  // focus events don't fire while the window itself is unfocused - and this is
  // the same pattern the menus and the date picker already use.
  useEffect(() => {
    if (!(compactSearch && searchOpen)) return
    const onDown = (e: MouseEvent) => {
      if (searchRef.current?.contains(e.target as Node)) return
      if (!useStore.getState().search) setSearchOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [compactSearch, searchOpen])
  const ppd = useStore((s) => s.ppd)
  const search = useStore((s) => s.search)
  const past = useStore((s) => s.past.length)
  const future = useStore((s) => s.future.length)

  const setSearch = useStore((s) => s.setSearch)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const expandAll = useStore((s) => s.expandAll)
  const collapseAll = useStore((s) => s.collapseAll)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)

  // The preset whose zoom is closest to the current continuous value.
  const activePreset = ZOOM_PRESETS.reduce((best, p) =>
    Math.abs(Math.log(p.ppd) - Math.log(ppd)) < Math.abs(Math.log(best.ppd) - Math.log(ppd)) ? p : best,
  )

  return (
    // "deep" makes the whole bar a drag region; Tauri's own handler exempts
    // buttons, inputs, selects and anything with an interactive role, so every
    // control still works. -webkit-app-region does nothing here: it's a
    // Chromium property and the Mac app runs on WKWebView.
    <header className="toolbar" data-tauri-drag-region="deep" ref={barRef}>
      {/* Three tracks: the two sides flex equally from a zero basis, so the
          middle group lands dead-centre in the window regardless of how wide
          the brand or the right-hand controls happen to be - and the sides
          shrink rather than overlap when the window gets narrow. */}
      <div className="tb-side">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">Timeline</span>
        </div>

        {/* Sits beside the table it toggles, rather than across the bar from it. */}
        <button
          className="btn icon"
          onClick={toggleSidebar}
          title={(sidebarOpen ? 'Hide the table' : 'Show the table') + ' (⌘\\)'}
          aria-label={sidebarOpen ? 'Hide the table' : 'Show the table'}
        >
          <SidebarIcon />
        </button>
      </div>

      {!(compactSearch && searchOpen) && (
      <div className="tb-center">
        {fit.expand && (
          <div className="btn-group">
            <button
              className="btn icon"
              onClick={expandAll}
              title="Expand everything (E)"
              aria-label="Expand everything"
            >
              <ExpandIcon />
            </button>
            <button
              className="btn icon"
              onClick={collapseAll}
              title="Collapse everything (⇧E)"
              aria-label="Collapse everything"
            >
              <CollapseIcon />
            </button>
          </div>
        )}

        {fit.presets && (
        <div className="seg">
          {ZOOM_PRESETS.map((p, i) => (
            <button
              key={p.label}
              className={p.label === activePreset.label ? 'active' : ''}
              title={`${p.label} (${i + 1})`}
              onClick={() => cmd.zoom(p.ppd)}
            >
              {p.label}
            </button>
          ))}
        </div>
        )}

        {fit.slider && (
        <input
          className="zoom-slider"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={toSlider(ppd)}
          onChange={(e) => cmd.zoom(fromSlider(+e.target.value))}
          title="Zoom (⌘scroll or pinch, or 1-6)"
          aria-label="Zoom"
        />
        )}

        <button
          className="btn today-btn"
          onClick={() => cmd.goToDay(todayDay(), 0.32)}
          title="Jump to today (T)"
        >
          Today
        </button>
      </div>
      )}

      <div className="tb-side tb-right">
        {searchAsField ? (
          <input
            ref={searchRef}
            className={'search' + (compactSearch ? ' expanded' : '')}
            type="search"
            placeholder="Search…"
            value={search}
            autoFocus={compactSearch}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => {
              if (!useStore.getState().search) setSearchOpen(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && compactSearch) {
                setSearch('')
                setSearchOpen(false)
              }
            }}
            data-search-input
          />
        ) : (
          <button
            className={'btn icon' + (search ? ' on' : '')}
            onClick={() => setSearchOpen(true)}
            title="Search (⌘F)"
            aria-label="Search"
            data-search-toggle
          >
            <SearchIcon />
          </button>
        )}

        {fit.history && (
        <div className="btn-group">
          <button className="btn icon" onClick={undo} disabled={!past} title="Undo (⌘Z)" aria-label="Undo">
            <UndoIcon />
          </button>
          <button
            className="btn icon"
            onClick={redo}
            disabled={!future}
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
          >
            <RedoIcon />
          </button>
        </div>
        )}

        <ViewMenu />

      </div>
    </header>
  )
}
