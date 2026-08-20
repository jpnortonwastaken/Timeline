import type { GroupBy, Item, ItemId, Lane, Status } from '../types'
import { isoToDay } from './time'
import { statusLabel } from '../store'

const ROOT = '__root__'

export interface Span {
  startDay: number
  endDay: number
  /** True when the span was inferred from children rather than set on the item. */
  derived: boolean
  milestone: boolean
}

export interface ItemRow {
  kind: 'item'
  key: string
  id: ItemId
  item: Item
  depth: number
  hasChildren: boolean
  collapsed: boolean
  span: Span | null
  /** Resolved colour, falling back to the lane when the item has none. */
  colorId: string
}

export interface GroupRow {
  kind: 'group'
  key: string
  id: string
  label: string
  colorId: string
  collapsed: boolean
  count: number
}

/** The "+ New" affordance at the foot of every group, as in Notion. */
export interface NewRow {
  kind: 'new'
  key: string
  laneId: string | null
  status: Status | null
}

export type Row = ItemRow | GroupRow | NewRow

const STATUS_ORDER: Status[] = ['active', 'planned', 'idea', 'done', 'dropped']

/** Children indexed by parent, pre-sorted. Built once per flatten. */
function childIndex(items: Record<ItemId, Item>) {
  const byParent = new Map<string, Item[]>()
  for (const it of Object.values(items)) {
    const k = it.parentId ?? ROOT
    const arr = byParent.get(k)
    if (arr) arr.push(it)
    else byParent.set(k, [it])
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order)
  return byParent
}

/** An item's own span, or the union of its descendants' spans. */
function computeSpan(
  item: Item,
  byParent: Map<string, Item[]>,
  cache: Map<ItemId, Span | null>,
): Span | null {
  const hit = cache.get(item.id)
  if (hit !== undefined) return hit

  let result: Span | null = null

  if (item.start) {
    const startDay = isoToDay(item.start.date)
    if (item.end) {
      const endDay = isoToDay(item.end.date)
      result = { startDay, endDay: Math.max(endDay, startDay), derived: false, milestone: false }
    } else {
      result = { startDay, endDay: startDay, derived: false, milestone: true }
    }
  } else {
    // Roll up from children so a parent with no dates still draws a summary bar.
    let lo = Infinity
    let hi = -Infinity
    for (const child of byParent.get(item.id) ?? []) {
      const cs = computeSpan(child, byParent, cache)
      if (cs) {
        lo = Math.min(lo, cs.startDay)
        hi = Math.max(hi, cs.endDay)
      }
    }
    if (lo !== Infinity) result = { startDay: lo, endDay: hi, derived: true, milestone: false }
  }

  cache.set(item.id, result)
  return result
}

export interface FlattenArgs {
  items: Record<ItemId, Item>
  lanes: Record<string, Lane>
  groupBy: GroupBy
  search: string
}

export interface FlattenResult {
  rows: Row[]
  /** Item id -> row index, for keyboard navigation and scroll-into-view. */
  indexById: Map<ItemId, number>
}

export function flatten({ items, lanes, groupBy, search }: FlattenArgs): FlattenResult {
  const byParent = childIndex(items)
  const spanCache = new Map<ItemId, Span | null>()
  const q = search.trim().toLowerCase()

  // When searching, keep any item that matches or has a matching descendant,
  // and force every surviving branch open.
  let keep: Set<ItemId> | null = null
  if (q) {
    const kept = new Set<ItemId>()
    const matches = (it: Item) =>
      it.title.toLowerCase().includes(q) || it.notes.toLowerCase().includes(q)
    const visit = (it: Item): boolean => {
      let hit = matches(it)
      for (const c of byParent.get(it.id) ?? []) if (visit(c)) hit = true
      if (hit) kept.add(it.id)
      return hit
    }
    for (const it of byParent.get(ROOT) ?? []) visit(it)
    keep = kept
  }

  const rows: Row[] = []
  const laneColor = (laneId: string | null) => (laneId && lanes[laneId]?.colorId) || 'gray'

  const emit = (item: Item, depth: number, inheritedColor: string) => {
    if (keep && !keep.has(item.id)) return
    const kids = (byParent.get(item.id) ?? []).filter((c) => !keep || keep.has(c.id))
    const collapsed = item.collapsed && !q
    const colorId = item.colorId ?? inheritedColor
    rows.push({
      kind: 'item',
      key: item.id,
      id: item.id,
      item,
      depth,
      hasChildren: kids.length > 0,
      collapsed,
      span: computeSpan(item, byParent, spanCache),
      colorId,
    })
    if (!collapsed) for (const c of kids) emit(c, depth + 1, colorId)
  }

  const roots = byParent.get(ROOT) ?? []

  if (groupBy === 'none') {
    for (const it of roots) emit(it, 0, laneColor(it.laneId))
    if (!q) rows.push({ kind: 'new', key: 'new:root', laneId: null, status: null })
  } else if (groupBy === 'lane') {
    const groups = Object.values(lanes)
      .sort((a, b) => a.order - b.order)
      .map((l) => ({
        id: l.id,
        label: l.name,
        colorId: l.colorId,
        collapsed: l.collapsed,
        members: roots.filter((i) => i.laneId === l.id),
      }))
    const orphans = roots.filter((i) => !i.laneId || !lanes[i.laneId])
    if (orphans.length) {
      groups.push({
        id: '__none',
        label: 'No lane',
        colorId: 'gray',
        collapsed: false,
        members: orphans,
      })
    }
    for (const g of groups) {
      const visible = g.members.filter((m) => !keep || keep.has(m.id))
      if (q && !visible.length) continue
      const collapsed = g.collapsed && !q
      rows.push({
        kind: 'group',
        key: 'g:' + g.id,
        id: g.id,
        label: g.label,
        colorId: g.colorId,
        collapsed,
        count: visible.length,
      })
      if (!collapsed) {
        for (const m of visible) emit(m, 0, g.colorId)
        if (!q) {
          rows.push({
            kind: 'new',
            key: 'new:' + g.id,
            laneId: g.id === '__none' ? null : g.id,
            status: null,
          })
        }
      }
    }
  } else {
    for (const st of STATUS_ORDER) {
      const members = roots.filter((i) => i.status === st && (!keep || keep.has(i.id)))
      if (!members.length) continue
      rows.push({
        kind: 'group',
        key: 'g:' + st,
        id: st,
        label: statusLabel[st],
        colorId: 'gray',
        collapsed: false,
        count: members.length,
      })
      for (const m of members) emit(m, 0, laneColor(m.laneId))
      if (!q) rows.push({ kind: 'new', key: 'new:' + st, laneId: null, status: st })
    }
  }

  const indexById = new Map<ItemId, number>()
  rows.forEach((r, i) => {
    if (r.kind === 'item') indexById.set(r.id, i)
  })

  return { rows, indexById }
}

/** All descendant ids of an item, excluding itself. */
export function descendants(items: Record<ItemId, Item>, id: ItemId): ItemId[] {
  const out: ItemId[] = []
  const walk = (pid: ItemId) => {
    for (const it of Object.values(items)) {
      if (it.parentId === pid) {
        out.push(it.id)
        walk(it.id)
      }
    }
  }
  walk(id)
  return out
}
