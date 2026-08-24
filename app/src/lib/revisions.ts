/**
 * Per-record change tracking, and the merge two devices meet in.
 *
 * No Firebase in here on purpose - this is the part that has to be right, and
 * it is all pure functions over plain objects so it can be reasoned about and
 * tested without a network.
 *
 * The unit of conflict is one record, not the whole plan. Syncing a plan as a
 * single blob means the last device to save wins outright: edit a title on the
 * laptop, edit a date on the desktop, and one of them silently disappears.
 * Tracking `items`, `lanes` and `deps` per id means those two edits both
 * survive, because they never actually touched the same record.
 */
import type { Snapshot } from '../types'

/** When this record last changed on some device, and whether it died there. */
export interface Rev {
  at: string
  deleted?: true
}
export type RevMap = Record<string, Rev>
export interface Revisions {
  items: RevMap
  lanes: RevMap
  deps: RevMap
}

export const COLLECTIONS = ['items', 'lanes', 'deps'] as const
export type Collection = (typeof COLLECTIONS)[number]

export const emptyRevisions = (): Revisions => ({ items: {}, lanes: {}, deps: {} })

/**
 * A tombstone has to outlive every device that might still be holding the
 * record it kills. Drop it too early and a laptop that was shut in a drawer
 * comes back, finds no record and no tombstone, and helpfully restores what
 * you deleted. Ninety days is the bet: longer than any plausible gap, short
 * enough that the graveyard does not grow without limit.
 */
const TOMBSTONE_DAYS = 90

/**
 * Work out what changed between two versions of the plan.
 *
 * Records are replaced rather than mutated everywhere in the store, so identity
 * is a reliable and very cheap signal - no deep comparison needed. An edit that
 * happens to produce an identical record only costs a redundant timestamp,
 * which merges to the same answer anyway.
 */
export function trackChanges(
  prev: Snapshot,
  next: Snapshot,
  revs: Revisions,
  now = new Date().toISOString(),
): Revisions {
  const out: Revisions = { items: { ...revs.items }, lanes: { ...revs.lanes }, deps: { ...revs.deps } }
  let touched = false

  for (const key of COLLECTIONS) {
    const before = prev[key] as Record<string, unknown>
    const after = next[key] as Record<string, unknown>
    if (before === after) continue

    for (const id of Object.keys(after)) {
      if (before[id] !== after[id]) {
        out[key][id] = { at: now }
        touched = true
      }
    }
    for (const id of Object.keys(before)) {
      if (!(id in after) && !out[key][id]?.deleted) {
        out[key][id] = { at: now, deleted: true }
        touched = true
      }
    }
  }
  return touched ? out : revs
}

/**
 * Timestamps are compared as plain strings, which only works while they really
 * are ISO. Anything else - a legacy value, a hand-edited file, a future date
 * from a device with a wrong clock - would sort above every genuine edit and
 * win every merge it ever took part in, permanently. Junk is refused here
 * rather than allowed to quietly outrank real work.
 */
function usableStamp(value: unknown, now: string): string | null {
  if (typeof value !== 'string') return null
  const t = Date.parse(value)
  if (Number.isNaN(t)) return null
  const iso = new Date(t).toISOString()
  return iso > now ? null : iso
}

/**
 * Give every existing record a revision. Only needed once, when a plan that
 * predates sync is first tracked: items carry their own `updatedAt`, and lanes
 * and deps have never recorded one, so they start from now.
 */
export function seedRevisions(data: Snapshot, now = new Date().toISOString()): Revisions {
  const revs = emptyRevisions()
  for (const [id, item] of Object.entries(data.items)) {
    revs.items[id] = { at: usableStamp(item?.updatedAt, now) ?? now }
  }
  for (const id of Object.keys(data.lanes)) revs.lanes[id] = { at: now }
  for (const id of Object.keys(data.deps)) revs.deps[id] = { at: now }
  return revs
}

/** Missing means "older than anything", so a tracked record always wins. */
const stamp = (r: Rev | undefined) => r?.at ?? ''

export interface Side {
  data: Snapshot
  revs: Revisions
}

export interface MergeResult extends Side {
  /** The merge differs from what this device had. */
  changedLocal: boolean
  /** The merge differs from what the server had, so it needs pushing back. */
  changedRemote: boolean
}

/**
 * Last write wins, per record, with deletes as first-class events.
 *
 * Ties go to local. Two devices cannot really write the same record in the same
 * millisecond, so a tie in practice means one device saw the other's clock -
 * and preferring local at least keeps the machine in front of the user stable.
 *
 * This does rely on device clocks being roughly honest. A laptop an hour behind
 * will lose edits it should have won. Firestore's server timestamps would fix
 * that but only for the moment of *upload*, which is not when the edit
 * happened, so it trades one wrong answer for another.
 */
export function mergePlans(local: Side, remote: Side, now = new Date().toISOString()): MergeResult {
  const data: Snapshot = { items: {}, lanes: {}, deps: {} }
  const revs = emptyRevisions()
  let changedLocal = false
  let changedRemote = false

  const cutoff = new Date(Date.parse(now) - TOMBSTONE_DAYS * 864e5).toISOString()

  for (const key of COLLECTIONS) {
    const lData = local.data[key] as Record<string, unknown>
    const rData = remote.data[key] as Record<string, unknown>
    const lRev = local.revs[key]
    const rRev = remote.revs[key]

    for (const id of new Set([...Object.keys(lData), ...Object.keys(rData), ...Object.keys(lRev), ...Object.keys(rRev)])) {
      const l = lRev[id]
      const r = rRev[id]
      const winner = stamp(r) > stamp(l) ? 'remote' : 'local'
      const rev = winner === 'remote' ? r : l
      const record = winner === 'remote' ? rData[id] : lData[id]

      if (rev?.deleted) {
        // Expired tombstones are dropped entirely rather than kept as a
        // resurrection risk - by now every device has long since seen them.
        if (rev.at > cutoff) revs[key][id] = rev
      } else if (record !== undefined) {
        ;(data[key] as Record<string, unknown>)[id] = record
        if (rev) revs[key][id] = rev
      } else {
        /* A revision with no record on the winning side. Fall back to whatever
           copy exists rather than dropping the record on a bookkeeping gap. */
        const fallback = lData[id] ?? rData[id]
        if (fallback !== undefined) {
          ;(data[key] as Record<string, unknown>)[id] = fallback
          revs[key][id] = rev ?? { at: now }
        }
      }

      const merged = (data[key] as Record<string, unknown>)[id]
      if (merged !== lData[id]) changedLocal = true
      if (merged !== rData[id]) changedRemote = true
    }

    if (Object.keys(revs[key]).length !== Object.keys(lRev).length) changedLocal = true
    if (Object.keys(revs[key]).length !== Object.keys(rRev).length) changedRemote = true
  }

  return { data, revs, changedLocal, changedRemote }
}
