import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../store'
import { COLORS } from '../lib/colors'
import { dayToIso, isoToDay, todayDay } from '../lib/time'
import type { ItemId } from '../types'
import {
  IconCollapseAll,
  IconCollapseLane,
  IconDelete,
  IconDone,
  IconDuplicate,
  IconExpandAll,
  IconInProgress,
  IconLane,
  IconMilestone,
  IconPlus,
  IconRename,
  IconSpan,
  IconSubItem,
} from './icons'

export type MenuTarget =
  | { kind: 'item'; id: ItemId }
  | { kind: 'group'; id: string }
  | { kind: 'empty'; laneId: string | null; day: number }

export interface MenuState {
  x: number
  y: number
  target: MenuTarget
}

interface Row {
  label: string
  hint?: string
  danger?: boolean
  /** Every row carries one, so the menu reads as a column of actions. */
  icon: ReactNode
  run: () => void
}

export function ContextMenu({
  menu,
  onClose,
  leaving = false,
}: {
  menu: MenuState
  onClose: () => void
  leaving?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  /** Lane deletion asks first, in place, rather than firing a browser confirm. */
  const [confirmLane, setConfirmLane] = useState<string | null>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  const items = useStore((s) => s.items)
  const selection = useStore((s) => s.selection)
  const createItem = useStore((s) => s.createItem)
  const updateItem = useStore((s) => s.updateItem)
  const deleteItems = useStore((s) => s.deleteItems)
  const duplicateItems = useStore((s) => s.duplicateItems)
  const setEditing = useStore((s) => s.setEditing)
  const expandAll = useStore((s) => s.expandAll)
  const collapseAll = useStore((s) => s.collapseAll)
  const toggleLaneCollapse = useStore((s) => s.toggleLaneCollapse)
  const lanes = useStore((s) => s.lanes)
  const createLane = useStore((s) => s.createLane)
  const updateLane = useStore((s) => s.updateLane)
  const deleteLane = useStore((s) => s.deleteLane)
  const setEditingLane = useStore((s) => s.setEditingLane)

  // Flip the menu back inside the window if it would hang off an edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(6, Math.min(menu.x, window.innerWidth - width - 6)),
      top: Math.max(6, Math.min(menu.y, window.innerHeight - height - 6)),
    })
  }, [menu.x, menu.y, menu.target, confirmLane])

  useEffect(() => {
    // This listener is on document in the *capture* phase, so without the
    // containment check it fires before the menu button's own click handler,
    // unmounting the item mid-press and swallowing every action.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('wheel', close, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('wheel', close, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const run = (fn: () => void) => () => {
    fn()
    onClose()
  }

  let rows: Row[] = []
  let showColors = false
  let target: ItemId[] = []
  /** Set when the menu is on a real lane, so the swatches recolour the lane. */
  let laneTarget: string | null = null

  if (menu.target.kind === 'item') {
    const id = menu.target.id
    // Right-clicking inside a multi-selection acts on the whole selection.
    target = selection.includes(id) && selection.length > 1 ? selection : [id]
    const item = items[id]
    if (!item) return null
    const many = target.length > 1
    showColors = true

    rows = [
      ...(many
        ? []
        : [{ label: 'Rename', hint: '↵', icon: <IconRename />, run: run(() => setEditing(id)) }]),
      {
        label: many ? `Duplicate ${target.length} items` : 'Duplicate',
        hint: '⌘D',
        icon: <IconDuplicate />,
        run: run(() => duplicateItems(target)),
      },
      ...(many
        ? []
        : [
            {
              label: 'Add sub-item',
              icon: <IconSubItem />,
              run: run(() => {
                const start = item.start ? isoToDay(item.start.date) : todayDay()
                const kid = createItem({
                  parentId: id,
                  laneId: item.laneId,
                  start: { date: dayToIso(start), precision: 'day' },
                  end: { date: dayToIso(start + 6), precision: 'day' },
                })
                updateItem(id, { collapsed: false }, true)
                setEditing(kid)
              }),
            },
          ]),
      {
        label: item.status === 'done' ? 'Mark as in progress' : 'Mark as done',
        icon: item.status === 'done' ? <IconInProgress /> : <IconDone />,
        run: run(() =>
          target.forEach((t) =>
            updateItem(t, { status: item.status === 'done' ? 'active' : 'done' }, true),
          ),
        ),
      },
      ...(many
        ? []
        : [
            {
              label: item.end ? 'Turn into milestone' : 'Give it a span',
              icon: item.end ? <IconMilestone /> : <IconSpan />,
              run: run(() =>
                updateItem(id, {
                  end: item.end
                    ? null
                    : {
                        date: dayToIso((item.start ? isoToDay(item.start.date) : todayDay()) + 6),
                        precision: 'day',
                      },
                }),
              ),
            },
          ]),
      {
        label: many ? `Delete ${target.length} items` : 'Delete',
        hint: '⌫',
        danger: true,
        icon: <IconDelete />,
        run: run(() => deleteItems(target)),
      },
    ]
  } else if (menu.target.kind === 'group') {
    const gid = menu.target.id
    // "No lane" is synthetic: it can be collapsed, but not renamed or deleted.
    const real = gid !== '__none' && !!lanes[gid]
    if (real) {
      showColors = true
      laneTarget = gid
    }
    rows = [
      {
        label: 'New item in this lane',
        icon: <IconPlus />,
        run: run(() => {
          const t = todayDay()
          const nid = createItem({
            laneId: real ? gid : null,
            start: { date: dayToIso(t), precision: 'day' },
            end: { date: dayToIso(t + 6), precision: 'day' },
          })
          setEditing(nid)
        }),
      },
      ...(real
        ? [{ label: 'Rename lane', icon: <IconRename />, run: run(() => setEditingLane(gid)) }]
        : []),
      {
        label: 'New lane',
        icon: <IconLane />,
        run: run(() => setEditingLane(createLane('New lane'))),
      },
      { label: 'Collapse this lane', icon: <IconCollapseLane />, run: run(() => toggleLaneCollapse(gid)) },
      { label: 'Expand everything', hint: 'E', icon: <IconExpandAll />, run: run(expandAll) },
      { label: 'Collapse everything', hint: '⇧E', icon: <IconCollapseAll />, run: run(collapseAll) },
      ...(real
        ? [
            {
              label: 'Delete lane',
              danger: true,
              icon: <IconDelete />,
              // Two-step: what happens to the blocks inside is the real
              // question, and it isn't reversible by guessing.
              run: () => setConfirmLane(gid),
            },
          ]
        : []),
    ]
  } else {
    const { laneId, day } = menu.target
    rows = [
      {
        label: 'New item here',
        icon: <IconPlus />,
        run: run(() => {
          const nid = createItem({
            laneId,
            start: { date: dayToIso(day), precision: 'day' },
            end: { date: dayToIso(day + 6), precision: 'day' },
          })
          setEditing(nid)
        }),
      },
    ]
  }

  if (confirmLane) {
    const lane = lanes[confirmLane]
    const inside = Object.values(items).filter((i) => i.laneId === confirmLane).length
    return (
      <div className={'ctx-menu confirm pop' + (leaving ? ' leaving' : '')} ref={ref} style={pos}>
        <p className="ctx-head">
          Delete “{lane?.name || 'Untitled lane'}”?
        </p>
        <p className="ctx-note">
          {inside === 0
            ? 'This lane is empty.'
            : `${inside} block${inside === 1 ? '' : 's'} ${inside === 1 ? 'is' : 'are'} in it.`}
        </p>
        <button
          className="ctx-item"
          onClick={run(() => deleteLane(confirmLane, false))}
        >
          <IconLane />
          <span className="ctx-label">
            {inside === 0 ? 'Delete lane' : 'Delete lane, keep the blocks'}
          </span>
        </button>
        {inside > 0 && (
          <button
            className="ctx-item danger"
            onClick={run(() => deleteLane(confirmLane, true))}
          >
            <IconDelete />
            <span className="ctx-label">
              Delete lane and its {inside} block{inside === 1 ? '' : 's'}
            </span>
          </button>
        )}
        <div className="ctx-sep" />
        <button className="ctx-item" onClick={() => setConfirmLane(null)}>
          <span>Cancel</span>
          <kbd>esc</kbd>
        </button>
      </div>
    )
  }

  return (
    <div
      className={'ctx-menu pop' + (leaving ? ' leaving' : '')}
      ref={ref}
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((r, i) => (
        <button
          key={i}
          className={'ctx-item' + (r.danger ? ' danger' : '')}
          onClick={r.run}
        >
          {r.icon}
          <span className="ctx-label">{r.label}</span>
          {r.hint && <kbd>{r.hint}</kbd>}
        </button>
      ))}

      {showColors && (
        <>
          <div className="ctx-sep" />
          <div className="ctx-colors">
            {!laneTarget && (
              <button
                className="swatch inherit"
                title="Inherit from lane"
                onClick={run(() => target.forEach((t) => updateItem(t, { colorId: null }, true)))}
              />
            )}
            {COLORS.map((c) => (
              <button
                key={c.id}
                className={'swatch c-' + c.id}
                title={c.label}
                onClick={run(() =>
                  laneTarget
                    ? updateLane(laneTarget, { colorId: c.id })
                    : target.forEach((t) => updateItem(t, { colorId: c.id }, true)),
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
