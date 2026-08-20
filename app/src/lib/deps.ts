import type { Dependency, Item, ItemId } from '../types'
import { isoToDay } from './time'

/** Children indexed by parent id. */
function childMap(items: Record<ItemId, Item>) {
  const m = new Map<ItemId, ItemId[]>()
  for (const it of Object.values(items)) {
    if (!it.parentId) continue
    const arr = m.get(it.parentId)
    if (arr) arr.push(it.id)
    else m.set(it.parentId, [it.id])
  }
  return m
}

/**
 * Push dependents forward until every dependency's gap is satisfied.
 *
 * Returns a map of item id -> days to shift. Only ever moves things *later* -
 * pulling work earlier because a predecessor moved back is rarely what anyone
 * means, and it makes the operation non-obvious to undo mentally.
 *
 * Relaxation rather than a topological sort, because the graph can contain
 * cycles the user built by hand; the pass cap keeps that bounded.
 */
export function relax(
  items: Record<ItemId, Item>,
  deps: Record<string, Dependency>,
): Map<ItemId, number> {
  const delta = new Map<ItemId, number>()
  const kids = childMap(items)
  const list = Object.values(deps)
  if (!list.length) return delta

  const shifted = (id: ItemId) => delta.get(id) ?? 0
  const startOf = (id: ItemId) => {
    const it = items[id]
    return it?.start ? isoToDay(it.start.date) + shifted(id) : null
  }
  const endOf = (id: ItemId) => {
    const it = items[id]
    if (!it?.start) return null
    return isoToDay((it.end ?? it.start).date) + shifted(id)
  }

  // Moving an item takes its whole subtree with it.
  const shiftSubtree = (id: ItemId, by: number) => {
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()!
      delta.set(cur, shifted(cur) + by)
      for (const k of kids.get(cur) ?? []) stack.push(k)
    }
  }

  const MAX_PASSES = 60
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false
    for (const d of list) {
      const from = items[d.fromId]
      const to = items[d.toId]
      if (!from?.start || !to?.start) continue

      const anchor = d.type === 'start-to-start' ? startOf(d.fromId) : (endOf(d.fromId) ?? 0) + 1
      if (anchor == null) continue
      const required = anchor + d.lagDays
      const cur = startOf(d.toId)
      if (cur == null || cur >= required) continue

      shiftSubtree(d.toId, required - cur)
      changed = true
    }
    if (!changed) break
  }

  for (const [id, by] of delta) if (by === 0) delta.delete(id)
  return delta
}

/** Would adding from -> to close a loop? */
export function wouldCycle(
  deps: Record<string, Dependency>,
  fromId: ItemId,
  toId: ItemId,
): boolean {
  if (fromId === toId) return true
  const out = new Map<ItemId, ItemId[]>()
  for (const d of Object.values(deps)) {
    const arr = out.get(d.fromId)
    if (arr) arr.push(d.toId)
    else out.set(d.fromId, [d.toId])
  }
  // Can we already get from `to` back to `from`?
  const seen = new Set<ItemId>()
  const stack = [toId]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === fromId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const n of out.get(cur) ?? []) stack.push(n)
  }
  return false
}

export function depsOf(deps: Record<string, Dependency>, id: ItemId) {
  const incoming: Dependency[] = []
  const outgoing: Dependency[] = []
  for (const d of Object.values(deps)) {
    if (d.toId === id) incoming.push(d)
    if (d.fromId === id) outgoing.push(d)
  }
  return { incoming, outgoing }
}
