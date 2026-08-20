import { ALL_COLUMNS, useStore } from '../store'
import { MAX_PPD, MIN_PPD, todayDay, ZOOM_PRESETS } from '../lib/time'
import { cmd } from '../lib/viewport'
import type { Density, GroupBy } from '../types'
import { downloadJSON, pickAndImport } from '../lib/io'

/** Map ppd onto a 0..1 slider position logarithmically, so the slider feels even. */
const toSlider = (ppd: number) =>
  (Math.log(ppd) - Math.log(MIN_PPD)) / (Math.log(MAX_PPD) - Math.log(MIN_PPD))
const fromSlider = (v: number) =>
  Math.exp(Math.log(MIN_PPD) + v * (Math.log(MAX_PPD) - Math.log(MIN_PPD)))

export function Toolbar() {
  const ppd = useStore((s) => s.ppd)
  const groupBy = useStore((s) => s.groupBy)
  const density = useStore((s) => s.density)
  const columns = useStore((s) => s.visibleColumns)
  const search = useStore((s) => s.search)
  const theme = useStore((s) => s.theme)
  const past = useStore((s) => s.past.length)
  const future = useStore((s) => s.future.length)

  const setGroupBy = useStore((s) => s.setGroupBy)
  const setDensity = useStore((s) => s.setDensity)
  const toggleColumn = useStore((s) => s.toggleColumn)
  const setSearch = useStore((s) => s.setSearch)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const expandAll = useStore((s) => s.expandAll)
  const collapseAll = useStore((s) => s.collapseAll)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const resetToSeed = useStore((s) => s.resetToSeed)
  const autoShift = useStore((s) => s.autoShift)
  const showMinimap = useStore((s) => s.showMinimap)
  const toggleAutoShift = useStore((s) => s.toggleAutoShift)
  const toggleMinimap = useStore((s) => s.toggleMinimap)

  // The preset whose zoom is closest to the current continuous value.
  const activePreset = ZOOM_PRESETS.reduce((best, p) =>
    Math.abs(Math.log(p.ppd) - Math.log(ppd)) < Math.abs(Math.log(best.ppd) - Math.log(ppd)) ? p : best,
  )

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <span className="brand-name">Timeline</span>
      </div>

      <div className="tb-group">
        <label className="select-wrap">
          <span className="tb-label">Group</span>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="lane">Lane</option>
            <option value="status">Status</option>
            <option value="none">None</option>
          </select>
        </label>

        <div className="seg">
          <button onClick={expandAll} title="Expand everything (E)">
            Expand all
          </button>
          <button onClick={collapseAll} title="Collapse everything (⇧E)">
            Collapse
          </button>
        </div>
      </div>

      <div className="tb-group tb-zoom">
        <div className="seg">
          {ZOOM_PRESETS.map((p) => (
            <button
              key={p.label}
              className={p.label === activePreset.label ? 'active' : ''}
              onClick={() => cmd.zoom(p.ppd)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          className="zoom-slider"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={toSlider(ppd)}
          onChange={(e) => cmd.zoom(fromSlider(+e.target.value))}
          title="Zoom (⌘scroll or pinch on the canvas)"
          aria-label="Zoom"
        />
      </div>

      <button className="btn today-btn" onClick={() => cmd.goToDay(todayDay(), 0.32)} title="Jump to today (T)">
        Today
      </button>

      <div className="spacer" />

      <input
        className="search"
        type="search"
        placeholder="Search…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-search-input
      />

      <div className="tb-group">
        <div className="seg">
          <button onClick={undo} disabled={!past} title="Undo (⌘Z)" aria-label="Undo">
            ↶
          </button>
          <button onClick={redo} disabled={!future} title="Redo (⇧⌘Z)" aria-label="Redo">
            ↷
          </button>
        </div>

        <details className="menu">
          <summary className="btn" title="View options">
            View
          </summary>
          <div className="menu-body">
            <p className="menu-head">Row height</p>
            {(['compact', 'normal', 'roomy'] as Density[]).map((d) => (
              <button key={d} className={density === d ? 'on' : ''} onClick={() => setDensity(d)}>
                {d[0].toUpperCase() + d.slice(1)}
              </button>
            ))}
            <p className="menu-head">Columns</p>
            {ALL_COLUMNS.map((c) => (
              <button key={c} className={columns.includes(c) ? 'on' : ''} onClick={() => toggleColumn(c)}>
                {c[0].toUpperCase() + c.slice(1)}
              </button>
            ))}
            <p className="menu-head">Behaviour</p>
            <button
              className={autoShift ? 'on' : ''}
              onClick={toggleAutoShift}
              title="Move dependent items forward when a predecessor moves"
            >
              Auto-shift dependents
            </button>
            <button className={showMinimap ? 'on' : ''} onClick={toggleMinimap}>
              Overview strip
            </button>
            <p className="menu-head">Data</p>
            <button onClick={downloadJSON}>Export JSON…</button>
            <button onClick={pickAndImport}>Import JSON…</button>
            <button
              onClick={() =>
                confirm('Replace everything with the sample plan? This can be undone with ⌘Z.') &&
                resetToSeed()
              }
            >
              Reset to sample data
            </button>
          </div>
        </details>

        <button className="btn icon" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>

    </header>
  )
}
