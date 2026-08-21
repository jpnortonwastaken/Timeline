import { statusLabel, useStore } from '../store'
import { COLORS } from '../lib/colors'
import { dayToIso, formatSpan, isoToDay } from '../lib/time'
import { depsOf } from '../lib/deps'
import { DatePicker } from './DatePicker'
import { Picker } from './Picker'
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
  const isMilestone = item.end == null

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
        <Picker
          ariaLabel="Lane"
          value={item.laneId ?? ''}
          onChange={(v) => updateItem(item.id, { laneId: v || null })}
          options={[
            { id: '', label: 'No lane', node: <span className="muted">No lane</span> },
            ...Object.values(lanes)
              .sort((a, b) => a.order - b.order)
              .map((l) => ({
                id: l.id,
                label: l.name,
                // Same chip the sidebar uses, so a lane looks the same wherever
                // it appears.
                node: <span className={'lane-chip c-' + l.colorId}>{l.name}</span>,
              })),
          ]}
        />
      </div>

      <div className="field">
        <span className="field-label">Status</span>
        <Picker
          ariaLabel="Status"
          value={item.status}
          onChange={(v) => updateItem(item.id, { status: v as Status })}
          options={STATUSES.map((st) => ({
            id: st,
            label: statusLabel[st],
            node: <span className={'pill s-' + st}>{statusLabel[st]}</span>,
          }))}
        />
      </div>

      <div className="field">
        <span className="field-label">Type</span>
        <div className="segmented" role="radiogroup" aria-label="Type">
          <button
            role="radio"
            aria-checked={!isMilestone}
            className={isMilestone ? '' : 'on'}
            onClick={() => {
              if (!isMilestone) return
              const from = startDay ?? 0
              updateItem(item.id, { end: { date: dayToIso(from + 6), precision: 'day' } })
            }}
          >
            Span
          </button>
          <button
            role="radio"
            aria-checked={isMilestone}
            className={isMilestone ? 'on' : ''}
            onClick={() => updateItem(item.id, { end: null })}
          >
            Milestone
          </button>
        </div>
      </div>

      <div className="field">
        <span className="field-label">Start</span>
        <DatePicker
          value={item.start}
          onChange={(v) => updateItem(item.id, { start: v })}
          placeholder="Pick a date"
        />
      </div>

      {/* Milestone-ness used to be implied by an empty End date, which is only
          discoverable once you've already found it. It's a choice now. */}
      {!isMilestone && (
        <div className="field">
          <span className="field-label">End</span>
          <DatePicker
            value={item.end}
            onChange={(v) => updateItem(item.id, { end: v })}
            minDay={startDay ?? undefined}
            placeholder="Pick a date"
          />
        </div>
      )}

      {startDay != null && endDay != null && (
        <p className="detail-span">{formatSpan(endDay + 1 - startDay)}</p>
      )}

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

      {/* Stacked, not inline: sharing the row with a 62px label leaves 231px
          for ten swatches, which is not enough to make them both bigger and
          better spaced. On their own line they get the full panel width. */}
      <div className="field stack">
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

      <DependencySection
        itemId={item.id}
        deps={allDeps}
        items={items}
        onRemove={removeDep}
        onGoTo={(gid) => select([gid])}
      />

      <div className="field stack notes">
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
    <div className="field stack">
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
