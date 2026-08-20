import { memo, useEffect, useRef } from 'react'
import type { Row } from '../lib/tree'
import { dayToX, formatDate, formatSpan } from '../lib/time'
import { statusLabel, useStore } from '../store'

interface Props {
  row: Row
  index: number
  top: number
  height: number
  ppd: number
  sidebarWidth: number
  selected: boolean
  editing: boolean
  columns: string[]
  linking: boolean
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={'chev' + (open ? ' open' : '')} viewBox="0 0 12 12" aria-hidden>
      <path
        d="M4.5 2.5 L8 6 L4.5 9.5"
        fill="none"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GripIcon() {
  return (
    <svg viewBox="0 0 10 12" aria-hidden>
      <circle cx="3" cy="2" r="1.1" />
      <circle cx="7" cy="2" r="1.1" />
      <circle cx="3" cy="6" r="1.1" />
      <circle cx="7" cy="6" r="1.1" />
      <circle cx="3" cy="10" r="1.1" />
      <circle cx="7" cy="10" r="1.1" />
    </svg>
  )
}

function TitleEditor({ id, initial }: { id: string; initial: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const updateItem = useStore((s) => s.updateItem)
  const setEditing = useStore((s) => s.setEditing)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const commit = () => {
    const v = ref.current?.value ?? ''
    if (v !== initial) updateItem(id, { title: v })
    setEditing(null)
  }

  return (
    <input
      ref={ref}
      className="title-input"
      defaultValue={initial}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setEditing(null)
      }}
    />
  )
}

function LaneEditor({ id, initial }: { id: string; initial: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const updateLane = useStore((s) => s.updateLane)
  const setEditingLane = useStore((s) => s.setEditingLane)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const commit = () => {
    const v = (ref.current?.value ?? '').trim()
    // Blank is treated as "leave it alone" - lanes are created pre-named, so
    // there's never a nameless one to clean up.
    if (v && v !== initial) updateLane(id, { name: v })
    setEditingLane(null)
  }

  return (
    <input
      ref={ref}
      className="title-input lane-input"
      defaultValue={initial}
      placeholder="Lane name"
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setEditingLane(null)
      }}
    />
  )
}

function RowImpl({
  row,
  index,
  top,
  height,
  ppd,
  sidebarWidth,
  selected,
  editing,
  columns,
  linking,
}: Props) {
  const toggleCollapse = useStore((s) => s.toggleCollapse)
  const toggleLaneCollapse = useStore((s) => s.toggleLaneCollapse)

  if (row.kind === 'new') {
    return (
      <div
        className="row new-row"
        data-row-index={index}
        data-row-kind="new"
        data-lane-id={row.laneId ?? ''}
        style={{ top, height }}
      >
        <div className={'side' + (sidebarWidth ? '' : ' collapsed')} style={{ width: sidebarWidth }}>
          <span className="new-label">
            <span aria-hidden>+</span> New
          </span>
        </div>
      </div>
    )
  }

  if (row.kind === 'new-lane') {
    return (
      <div
        className="row new-row"
        data-row-index={index}
        data-row-kind="new-lane"
        style={{ top, height }}
      >
        <div className={'side' + (sidebarWidth ? '' : ' collapsed')} style={{ width: sidebarWidth }}>
          <span className="new-label">
            <span aria-hidden>+</span> New lane
          </span>
        </div>
      </div>
    )
  }

  if (row.kind === 'group') {
    return (
      <div
        className="row group-row"
        data-row-index={index}
        data-row-kind="group"
        data-group-id={row.id}
        style={{ top, height }}
      >
        <div
          className={'side group-side c-' + row.colorId + (sidebarWidth ? '' : ' collapsed')}
          style={{ width: sidebarWidth }}
        >
          <button
            className="disclosure"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => toggleLaneCollapse(row.id)}
            aria-label={row.collapsed ? 'Expand group' : 'Collapse group'}
          >
            <Chevron open={!row.collapsed} />
          </button>
          {editing ? (
            <LaneEditor id={row.id} initial={row.label} />
          ) : (
            <>
              <span className="group-label">{row.label || 'Untitled lane'}</span>
              <span className="group-count">{row.count}</span>
            </>
          )}
          <button className="group-add" data-group-add aria-label="Add to this group">
            +
          </button>
        </div>
      </div>
    )
  }

  const { item, span } = row
  const barLeft = span ? sidebarWidth + dayToX(span.startDay, ppd) : 0
  const barWidth = span ? Math.max(6, (span.endDay + 1 - span.startDay) * ppd) : 0
  // Below this the label can't live inside the bar, so it sits alongside it.
  const labelOutside = barWidth < 46
  const soft = item.start?.precision && item.start.precision !== 'day'
  // Only an explicitly chosen color tints the card; lane-inherited color stays
  // in the sidebar dot, so the default canvas reads as clean white cards.
  const tinted = item.colorId !== null
  const barTop = Math.round(height * 0.13)
  const barHeight = height - barTop * 2

  return (
    <div
      className={
        'row item-row' +
        (selected ? ' selected' : '') +
        (linking ? ' linking' : '') +
        (row.depth ? ' nested' : '') +
        (row.nestTop ? ' nest-top' : '') +
        (row.nestBottom ? ' nest-bottom' : '')
      }
      data-row-index={index}
      data-row-kind="item"
      data-item-id={item.id}
      style={{ top, height }}
    >
      <div className={'side' + (sidebarWidth ? '' : ' collapsed')} style={{ width: sidebarWidth }}>
        {/* The grip stays hard left at every depth, ahead of the tree guides,
            so the drag handles line up in a single column. */}
        <button className="grip" data-grip aria-label="Drag to reorder">
          <GripIcon />
        </button>
        {Array.from({ length: row.depth }, (_, i) =>
          i === row.depth - 1 ? (
            <span key={i} className={'twig elbow' + (row.isLast ? ' last' : '')} />
          ) : (
            <span key={i} className={'twig' + (row.trail[i] ? ' line' : '')} />
          ),
        )}
        {row.hasChildren ? (
          <button
            className="disclosure"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => toggleCollapse(item.id)}
            aria-label={row.collapsed ? 'Expand' : 'Collapse'}
          >
            <Chevron open={!row.collapsed} />
          </button>
        ) : (
          <span className="disclosure-spacer" />
        )}
        <span className={'dot c-' + row.colorId} />
        {editing ? (
          <TitleEditor id={item.id} initial={item.title} />
        ) : (
          <span className={'title' + (item.status === 'done' ? ' done' : '')}>
            {item.title || <span className="untitled">Untitled</span>}
          </span>
        )}
        {columns.includes('status') && (
          <span className="col col-status">
            <span className={'pill s-' + item.status}>{statusLabel[item.status]}</span>
          </span>
        )}
        {columns.includes('dates') && (
          <span className="col col-dates">
            {span ? formatDate(item.start?.date ?? '', item.start?.precision) : ''}
          </span>
        )}
        {columns.includes('span') && (
          <span className="col col-span">
            {span && !span.milestone ? formatSpan(span.endDay + 1 - span.startDay) : ''}
          </span>
        )}
      </div>

      {span && span.milestone && (
        <div
          className={
            'milestone c-' +
            row.colorId +
            (tinted ? ' tinted' : '') +
            (soft ? ' soft' : '') +
            (item.status === 'done' ? ' is-done' : '') +
            (item.status === 'dropped' ? ' is-dropped' : '')
          }
          data-bar-id={item.id}
          style={{
            left: barLeft,
            top: barTop,
            width: barHeight,
            height: barHeight,
            marginLeft: -barHeight / 2,
          }}
          title={item.title}
        >
          <span className="link-port link-port-start" data-port="in" />
          <span className="milestone-label">{item.title}</span>
          <span className="link-port link-port-end" data-port="out" />
        </div>
      )}

      {span && !span.milestone && (
        <div
          className={
            'bar c-' +
            row.colorId +
            (span.derived ? ' derived' : '') +
            (tinted ? ' tinted' : '') +
            (soft ? ' soft' : '') +
            (item.status === 'done' ? ' is-done' : '') +
            (item.status === 'dropped' ? ' is-dropped' : '')
          }
          data-bar-id={item.id}
          style={{ left: barLeft, width: barWidth, top: barTop, height: barHeight }}
        >
          {!span.derived && <span className="handle handle-start" data-handle="start" />}
          {item.progress != null && (
            <span className="progress" style={{ width: `${Math.round(item.progress * 100)}%` }} />
          )}
          {/* `position: sticky` keeps the label and its twisty visible when the
              bar runs off the left edge - no scroll listener needed. */}
          <span
            className={'bar-inner' + (labelOutside ? ' outside' : '')}
            style={labelOutside ? undefined : { left: sidebarWidth + 6 }}
          >
            {row.hasChildren && (
              <button
                className="disclosure bar-chev"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => toggleCollapse(item.id)}
                aria-label={row.collapsed ? 'Expand' : 'Collapse'}
              >
                <Chevron open={!row.collapsed} />
              </button>
            )}
            <span className="bar-label">{item.title || 'Untitled'}</span>
          </span>
          {!span.derived && <span className="handle handle-end" data-handle="end" />}
          <span className="link-port link-port-start" data-port="in" />
          <span className="link-port link-port-end" data-port="out" />
        </div>
      )}
    </div>
  )
}

export const TimelineRow = memo(RowImpl, (a, b) => {
  if (
    a.top !== b.top ||
    a.height !== b.height ||
    a.ppd !== b.ppd ||
    a.sidebarWidth !== b.sidebarWidth ||
    a.selected !== b.selected ||
    a.editing !== b.editing ||
    a.linking !== b.linking ||
    a.index !== b.index ||
    a.columns !== b.columns
  ) {
    return false
  }
  const x = a.row
  const y = b.row
  if (x.kind !== y.kind) return false
  if (x.kind === 'new' || y.kind === 'new') return x.key === y.key
  if (x.kind === 'new-lane' || y.kind === 'new-lane') return x.key === y.key
  if (x.kind === 'group' && y.kind === 'group') {
    return (
      x.label === y.label &&
      x.collapsed === y.collapsed &&
      x.count === y.count &&
      x.colorId === y.colorId
    )
  }
  const xi = x as Extract<Row, { kind: 'item' }>
  const yi = y as Extract<Row, { kind: 'item' }>
  return (
    xi.item === yi.item &&
    xi.depth === yi.depth &&
    xi.collapsed === yi.collapsed &&
    xi.hasChildren === yi.hasChildren &&
    xi.colorId === yi.colorId &&
    xi.nestTop === yi.nestTop &&
    xi.nestBottom === yi.nestBottom &&
    xi.isLast === yi.isLast &&
    xi.trail.length === yi.trail.length &&
    xi.trail.every((v, i) => v === yi.trail[i]) &&
    xi.span?.startDay === yi.span?.startDay &&
    xi.span?.endDay === yi.span?.endDay
  )
})
