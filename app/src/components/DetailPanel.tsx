import { statusLabel, useStore } from '../store'
import { COLORS } from '../lib/colors'
import { formatLongDate, isoToDay, dayToIso, formatSpan } from '../lib/time'
import { depsOf } from '../lib/deps'
import type { Precision, Status } from '../types'

const PRECISIONS: Precision[] = ['day', 'week', 'month', 'quarter', 'year']
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

  const id = selection.length === 1 ? selection[0] : null
  const item = id ? items[id] : null

  if (!item) {
    return (
      <aside className="detail empty">
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
      <input
        className="detail-title"
        value={item.title}
        placeholder="Untitled"
        onChange={(e) => updateItem(item.id, { title: e.target.value }, true)}
      />

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
        <div className="field-row">
          <input
            type="date"
            value={item.start?.date ?? ''}
            onChange={(e) =>
              updateItem(item.id, {
                start: e.target.value
                  ? { date: e.target.value, precision: item.start?.precision ?? 'day' }
                  : null,
              })
            }
          />
          <select
            value={item.start?.precision ?? 'day'}
            disabled={!item.start}
            title="How certain is this date?"
            onChange={(e) =>
              item.start &&
              updateItem(item.id, { start: { ...item.start, precision: e.target.value as Precision } })
            }
          >
            {PRECISIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <span className="field-label">End</span>
        <div className="field-row">
          <input
            type="date"
            value={item.end?.date ?? ''}
            min={item.start?.date}
            onChange={(e) =>
              updateItem(item.id, {
                end: e.target.value
                  ? { date: e.target.value, precision: item.end?.precision ?? 'day' }
                  : null,
              })
            }
          />
          <button
            className="btn small"
            title="Clear the end date to make this a milestone"
            onClick={() =>
              updateItem(item.id, {
                end: item.end
                  ? null
                  : { date: dayToIso((startDay ?? 0) + 6), precision: 'day' },
              })
            }
          >
            {item.end ? 'Make milestone' : 'Give it a span'}
          </button>
        </div>
      </div>

      {startDay != null && endDay != null && (
        <p className="detail-span">
          {formatLongDate(item.start!.date)} → {formatLongDate(item.end!.date)}
          <span className="muted"> · {formatSpan(endDay + 1 - startDay)}</span>
        </p>
      )}

      <div className="field col">
        <span className="field-label">Colour</span>
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
          <span className="muted mono">
            {item.progress == null ? '—' : `${Math.round(item.progress * 100)}%`}
          </span>
          {item.progress != null && (
            <button className="btn small" onClick={() => updateItem(item.id, { progress: null })}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="field col">
        <span className="field-label">Notes</span>
        <textarea
          value={item.notes}
          rows={5}
          placeholder="Anything worth remembering…"
          onChange={(e) => updateItem(item.id, { notes: e.target.value }, true)}
        />
      </div>

      <DependencySection
        itemId={item.id}
        deps={allDeps}
        items={items}
        onRemove={removeDep}
        onGoTo={(id) => select([id])}
      />

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
  if (!incoming.length && !outgoing.length) {
    return (
      <div className="field col">
        <span className="field-label">Dependencies</span>
        <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
          Drag the ○ on either end of a bar onto another bar.
        </p>
      </div>
    )
  }
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
