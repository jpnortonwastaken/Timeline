import { useCallback, useEffect, useMemo } from 'react'
import { Toolbar } from './components/Toolbar'
import { Timeline } from './components/Timeline'
import { DetailPanel } from './components/DetailPanel'
import { Minimap } from './components/Minimap'
import { hadStoredState, useStore } from './store'
import { isTauri, onMenuCommand, readBackup } from './lib/tauri'
import { downloadJSON, pickAndImport } from './lib/io'
import { flatten } from './lib/tree'
import { addUnits, dayToIso, isoToDay, tierFor, todayDay } from './lib/time'
import { cmd } from './lib/viewport'

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

export default function App() {
  const theme = useStore((s) => s.theme)
  const selection = useStore((s) => s.selection)
  const showMinimap = useStore((s) => s.showMinimap)

  const items = useStore((s) => s.items)
  const lanes = useStore((s) => s.lanes)
  const groupBy = useStore((s) => s.groupBy)
  const search = useStore((s) => s.search)

  const { rows, indexById } = useMemo(
    () => flatten({ items, lanes, groupBy, search }),
    [items, lanes, groupBy, search],
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    if (isTauri) document.documentElement.dataset.tauri = ''
  }, [])

  // In the Mac app the plan is mirrored to a real file. If the WebView store
  // came up empty (fresh profile, or the system reclaimed it), restore it.
  useEffect(() => {
    if (!isTauri || hadStoredState) return
    void readBackup().then((raw) => {
      if (raw) useStore.getState().hydrate(raw)
    })
  }, [])

  /** One place both the native menu and the keyboard route through. */
  const runCommand = useCallback((id: string) => {
    const s = useStore.getState()
    switch (id) {
      case 'new-item': {
        const t = todayDay()
        const sel = s.selection[0]
        const newId = s.createItem({
          start: { date: dayToIso(t), precision: 'day' },
          end: { date: dayToIso(t + 6), precision: 'day' },
          laneId: sel ? s.items[sel]?.laneId ?? null : null,
        })
        s.setEditing(newId)
        cmd.goToDay(t, 0.32)
        break
      }
      case 'export':
        downloadJSON()
        break
      case 'import':
        pickAndImport()
        break
      case 'undo':
        s.undo()
        break
      case 'redo':
        s.redo()
        break
      case 'today':
        cmd.goToDay(todayDay(), 0.32)
        break
      case 'zoom-in':
        cmd.zoom(s.ppd * 1.35)
        break
      case 'zoom-out':
        cmd.zoom(s.ppd / 1.35)
        break
      case 'expand-all':
        s.expandAll()
        break
      case 'collapse-all':
        s.collapseAll()
        break
      case 'toggle-minimap':
        s.toggleMinimap()
        break
      case 'toggle-theme':
        s.toggleTheme()
        break
      case 'find':
        document.querySelector<HTMLInputElement>('[data-search-input]')?.focus()
        break
    }
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void onMenuCommand(runCommand).then((u) => {
      if (cancelled) u()
      else unlisten = u
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [runCommand])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? s.redo() : s.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('[data-search-input]')?.focus()
        return
      }
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        cmd.zoom(s.ppd * 1.35)
        return
      }
      if (mod && e.key === '-') {
        e.preventDefault()
        cmd.zoom(s.ppd / 1.35)
        return
      }

      if (e.key === 'Escape') {
        if (s.editingId) s.setEditing(null)
        else if (s.search) s.setSearch('')
        else s.select([])
        ;(document.activeElement as HTMLElement | null)?.blur()
        return
      }

      if (isTyping(e.target)) return

      const sel = s.selection[0]

      switch (e.key) {
        case 't':
        case 'T':
          cmd.goToDay(todayDay(), 0.32)
          break

        case 'e':
        case 'E':
          e.shiftKey ? s.collapseAll() : s.expandAll()
          break

        case 'n':
        case 'N':
          runCommand('new-item')
          break

        case 'Enter':
          if (sel) {
            e.preventDefault()
            s.setEditing(sel)
          }
          break

        case 'Backspace':
        case 'Delete':
          if (s.selection.length) {
            e.preventDefault()
            s.deleteItems(s.selection)
          }
          break

        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault()
          const itemRows = rows.filter((r) => r.kind === 'item')
          if (!itemRows.length) break
          const cur = sel ? itemRows.findIndex((r) => r.kind === 'item' && r.id === sel) : -1
          const next =
            cur < 0
              ? 0
              : Math.min(itemRows.length - 1, Math.max(0, cur + (e.key === 'ArrowDown' ? 1 : -1)))
          const target = itemRows[next]
          if (target.kind === 'item') {
            s.select([target.id])
            const idx = indexById.get(target.id)
            if (idx != null) cmd.revealRow(idx)
          }
          break
        }

        case 'ArrowLeft':
        case 'ArrowRight': {
          if (!e.altKey || !s.selection.length) break
          e.preventDefault()
          const unit = tierFor(s.ppd).snap
          const dir = e.key === 'ArrowRight' ? 1 : -1
          s.commit()
          s.updateItems(
            s.selection.map((id) => {
              const it = s.items[id]
              const shift = (d: string) => dayToIso(addUnits(isoToDay(d), unit, dir))
              return {
                id,
                patch: {
                  start: it.start ? { ...it.start, date: shift(it.start.date) } : null,
                  end: it.end ? { ...it.end, date: shift(it.end.date) } : null,
                },
              }
            }),
            true,
          )
          s.cascade()
          break
        }

        case 'Tab':
          if (sel) {
            e.preventDefault()
            e.shiftKey ? s.outdent(sel) : s.indent(sel)
          }
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, indexById, runCommand])

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <Timeline />
        {selection.length > 0 && <DetailPanel />}
      </div>
      {showMinimap && <Minimap />}
      <footer className="statusbar">
        <span className="hint"><kbd>drag</kbd> canvas to create</span>
        <span className="hint"><kbd>⌘</kbd>+scroll to zoom</span>
        <span className="hint"><kbd>⌥</kbd>drag for free dates</span>
        <span className="hint"><kbd>⇧</kbd>drag to move children</span>
        <span className="hint"><kbd>⇧</kbd>drag canvas to select</span>
        <span className="hint">drag the ○ to link</span>
        <span className="hint"><kbd>T</kbd> today</span>
        <span className="hint"><kbd>E</kbd> expand all</span>
        <span className="hint"><kbd>N</kbd> new</span>
        <span className="hint"><kbd>Tab</kbd> indent</span>
      </footer>
    </div>
  )
}
