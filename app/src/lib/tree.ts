import type { Item, ItemId, Lane } from '../types'
import { isoToDay, todayDay } from './time'

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
  /** Resolved color, falling back to the lane when the item has none. */
  colorId: string
  /** First / last row of a nested run, for drawing the recessed well. */
  nestTop: boolean
  nestBottom: boolean
  /**
   * One entry per *pass-through* guide cell, so `trail[i]` maps straight onto
   * indent cell `i`: true when the ancestor whose siblings live in that column
   * still has one to come, meaning its line runs through this row.
   *
   * Length is `depth - 1`, not `depth` — the final cell is the elbow, which
   * uses `isLast` instead.
   */
  trail: boolean[]
  /** Last child of its parent, so the elbow is a corner rather than a tee. */
  isLast: boolean
  /** Childless, but showing an empty "+ New sub-item" line below it. */
  draftChild: boolean
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

/**
 * The "+ New" affordance. One sits at the foot of every group, and one at the
 * foot of every expanded parent's children - so adding a sub-item doesn't mean
 * scrolling to the bottom of the lane, which is how Notion does it.
 */
export interface NewRow {
  kind: 'new'
  key: string
  laneId: string | null
  /** Set for the in-tree ones: the item the new row would nest under. */
  parentId: ItemId | null
  /** Indent level, matching the children it sits below. */
  depth: number
  /** Opens the nested run when this is the first row of one - which happens
      when a childless block opens a draft line, so nothing sits above it at
      the same depth. */
  nestTop: boolean
  /** Closes the nested run when this is the last row of one. */
  nestBottom: boolean
  /** Day the block it would create starts on, for the hover preview. */
  previewStart: number
}

/** The affordance for adding a lane, at the foot of the lane list. */
export interface NewLaneRow {
  kind: 'new-lane'
  key: string
}

export type Row = ItemRow | GroupRow | NewRow | NewLaneRow

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
  search: string
  /** Collapse state of the synthetic "No lane" group. */
  noLaneCollapsed: boolean
  /** Childless blocks showing an empty "+ New sub-item" line. */
  draftChildren?: Record<ItemId, true>
}

export interface FlattenResult {
  rows: Row[]
  /** Item id -> row index, for keyboard navigation and scroll-into-view. */
  indexById: Map<ItemId, number>
}

export function flatten({
  items,
  lanes,
  search,
  noLaneCollapsed,
  draftChildren,
}: FlattenArgs): FlattenResult {
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

  const emit = (
    item: Item,
    depth: number,
    inheritedColor: string,
    trail: boolean[],
    isLast: boolean,
  ) => {
    if (keep && !keep.has(item.id)) return
    const kids = (byParent.get(item.id) ?? []).filter((c) => !keep || keep.has(c.id))
    const collapsed = item.collapsed && !q
    const colorId = item.colorId ?? inheritedColor
    const span = computeSpan(item, byParent, spanCache)
    rows.push({
      kind: 'item',
      key: item.id,
      id: item.id,
      item,
      depth,
      hasChildren: kids.length > 0,
      collapsed,
      span,
      colorId,
      nestTop: false,
      nestBottom: false,
      trail,
      isLast,
      draftChild: !kids.length && !!draftChildren?.[item.id],
    })
    // A child's pass-through cells are this item's own, plus one new column for
    // this item's sibling line. Top-level items are the exception: their
    // children have a single cell, which is the elbow, so no pass-throughs.
    if (!collapsed) {
      const childTrail = depth === 0 ? [] : [...trail, !isLast]
      kids.forEach((c, i) => emit(c, depth + 1, colorId, childTrail, i === kids.length - 1))
      // Where there are children already - or where the twisty has been used
      // to open a draft line. An "add a sub-item" line under every leaf would
      // double the length of the list.
      if ((kids.length || draftChildren?.[item.id]) && !q) {
        rows.push({
          kind: 'new',
          key: 'new:' + item.id,
          laneId: item.laneId,
          parentId: item.id,
          depth: depth + 1,
          nestTop: false,
          nestBottom: false,
          previewStart: span ? span.startDay : todayDay(),
        })
      }
    }
  }

  const roots = byParent.get(ROOT) ?? []

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
      collapsed: noLaneCollapsed,
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
      visible.forEach((m, i) => emit(m, 0, g.colorId, [], i === visible.length - 1))
      if (!q) {
        rows.push({
          kind: 'new',
          key: 'new:' + g.id,
          laneId: g.id === '__none' ? null : g.id,
          parentId: null,
          depth: 0,
          nestTop: false,
          nestBottom: false,
          previewStart: todayDay(),
        })
      }
    }
  }
  if (!q) rows.push({ kind: 'new-lane', key: 'new-lane' })

  // Shade only the ends of each nested run: shading every child row would put
  // a divider between siblings instead of reading as one container.
  // An in-tree "+ New" counts as part of the run it sits in, so the run closes
  // below it rather than above.
  const runDepth = (r: Row | undefined) =>
    r?.kind === 'item' || r?.kind === 'new' ? r.depth : -1
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (runDepth(r) <= 0) continue
    const above = runDepth(rows[i - 1])
    const below = runDepth(rows[i + 1])
    if (r.kind === 'item') {
      r.nestTop = !(above >= r.depth)
      r.nestBottom = !(below >= r.depth)
    } else if (r.kind === 'new') {
      r.nestTop = !(above >= r.depth)
      r.nestBottom = !(below >= r.depth)
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
