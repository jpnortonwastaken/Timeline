import { statusLabel, useStore } from '../store'
import { COLORS } from '../lib/colors'
import { dayToIso, formatSpan, isoToDay } from '../lib/time'
import { depsOf } from '../lib/deps'
import { DatePicker } from './DatePicker'
import type { Status } from '../types'

const STATUSES: Status[] = ['idea', 'planned', 'active', 'done', 'dropped']

export function DetailPanel() {
  const selection = useStore((s) => s.selection)
  const items = useStore((s) => s.items)
  const lanes = useStore((s) => s.lanes)
  const allDeps = useStore((s) => s.deps)
  const updateItem = useStore((s) => s.updateItem)
  const deleteItems = useStore((s) => s.deleteItems)
  const removeDep = useStore((s) => s.removeDep)
  const select = useStore((s) => s.select)
  const setDetailOpen = useStore((s) => s.setDetailOpen)

  const id = selection.length === 1 ? selection[0] : null
  const item = id ? items[id] : null

  const collapse = (
    <button
      className="panel-collapse"
      onClick={() => setDetailOpen(false)}
      title="Close"
      aria-label="Close panel"
    >
      ×
    </button>
  )

  if (!item) {
    return (
      <aside className="detail empty">
        {collapse}
        <p className="muted">
          {selection.length > 1 ? `${selection.length} items selected` : 'Select an item'}
        </p>
      </aside>
    )
  }

  const startDay = item.start ? isoToDay(item.start.date) : null
  const endDay = item.end ? isoToDay(item.end.date) : null

  return (
    <aside className="detail">
      <div className="panel-head">
        <input
          className="detail-title"
          value={item.title}
          placeholder="Untitled"
          onChange={(e) => updateItem(item.id, { title: e.target.value }, true)}
        />
        {collapse}
      </div>

      <div className="field">
        <span className="field-label">Lane</span>
        <select
          value={item.laneId ?? ''}
          onChange={(e) => updateItem(item.id, { laneId: e.target.value || null })}
        >
          <option value="">No lane</option>
          {Object.values(lanes)
            .sort((a, b) => a.order - b.order)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </select>
      </div>

      <div className="field">
        <span className="field-label">Status</span>
        <select
          value={item.status}
          onChange={(e) => updateItem(item.id, { status: e.target.value as Status })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <span className="field-label">Start</span>
        <DatePicker
          value={item.start}
          onChange={(v) => updateItem(item.id, { start: v })}
          placeholder="Pick a date"
        />
      </div>

      <div className="field">
        <span className="field-label">End</span>
        <DatePicker
          value={item.end}
          onChange={(v) => updateItem(item.id, { end: v })}
          minDay={startDay ?? undefined}
          placeholder="Milestone"
          clearable
        />
      </div>

      {startDay != null && endDay != null && (
        <p className="detail-span">{formatSpan(endDay + 1 - startDay)}</p>
      )}
      {startDay != null && endDay == null && (
        <p className="detail-span">
          Milestone ·{' '}
          <button
            className="link"
            onClick={() =>
              updateItem(item.id, { end: { date: dayToIso(startDay + 6), precision: 'day' } })
            }
          >
            give it a span
          </button>
        </p>
      )}

      <div className="field">
        <span className="field-label">Color</span>
        <div className="swatches">
          <button
            className={'swatch inherit' + (item.colorId === null ? ' on' : '')}
            title="Inherit from lane"
            onClick={() => updateItem(item.id, { colorId: null })}
          />
          {COLORS.map((c) => (
            <button
              key={c.id}
              className={'swatch c-' + c.id + (item.colorId === c.id ? ' on' : '')}
              title={c.label}
              onClick={() => updateItem(item.id, { colorId: c.id })}
            />
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">Progress</span>
        <div className="field-row">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={item.progress ?? 0}
            onChange={(e) => updateItem(item.id, { progress: +e.target.value }, true)}
          />
          <span className="muted mono progress-value">
            {item.progress == null ? '—' : `${Math.round(item.progress * 100)}%`}
          </span>
          {item.progress != null && (
            <button className="link" onClick={() => updateItem(item.id, { progress: null })}>
              clear
            </button>
          )}
        </div>
      </div>

      <DependencySection
        itemId={item.id}
        deps={allDeps}
        items={items}
        onRemove={removeDep}
        onGoTo={(gid) => select([gid])}
      />

      <div className="field col notes">
        <span className="field-label">Notes</span>
        <textarea
          value={item.notes}
          rows={4}
          placeholder="Anything worth remembering…"
          onChange={(e) => updateItem(item.id, { notes: e.target.value }, true)}
        />
      </div>

      <button
        className="btn danger"
        onClick={() => {
          deleteItems([item.id])
          select([])
        }}
      >
        Delete item
      </button>
    </aside>
  )
}

function DependencySection({
  itemId,
  deps,
  items,
  onRemove,
  onGoTo,
}: {
  itemId: string
  deps: ReturnType<typeof useStore.getState>['deps']
  items: ReturnType<typeof useStore.getState>['items']
  onRemove: (id: string) => void
  onGoTo: (id: string) => void
}) {
  const { incoming, outgoing } = depsOf(deps, itemId)
  if (!incoming.length && !outgoing.length) return null

  return (
    <div className="field col">
      <span className="field-label">Dependencies</span>
      <div className="dep-list">
        {incoming.map((d) => (
          <div className="dep-item" key={d.id}>
            <span title="This item waits for that one">
              after <b onClick={() => onGoTo(d.fromId)}>{items[d.fromId]?.title || 'Untitled'}</b>
            </span>
            <button onClick={() => onRemove(d.id)} aria-label="Remove dependency">
              ×
            </button>
          </div>
        ))}
        {outgoing.map((d) => (
          <div className="dep-item" key={d.id}>
            <span title="That item waits for this one">
              blocks <b onClick={() => onGoTo(d.toId)}>{items[d.toId]?.title || 'Untitled'}</b>
            </span>
            <button onClick={() => onRemove(d.id)} aria-label="Remove dependency">
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
