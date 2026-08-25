/**
 * Merge behaviour, run with `npm test`.
 *
 * These are the cases where a sync bug costs someone real work, so they are
 * written as scenarios rather than unit assertions: two devices edit different
 * things, two devices edit the same thing, one device deletes what the other
 * still has.
 *
 * Fixtures must preserve object identity for records they did not touch -
 * `trackChanges` reads identity to decide what changed, exactly as the store
 * produces it. Rebuilding a whole map marks every record as edited and the
 * test stops measuring anything real.
 */
import { mergePlans, resolvePlan, trackChanges, emptyRevisions, seedRevisions } from './revisions'
import type { Snapshot, Item } from '../types'

const it = (id: string, title: string): Item => ({
  id, title, parentId: null, laneId: null, order: 0,
  start: { date: '2026-01-01', precision: 'day' },
  end: { date: '2026-01-07', precision: 'day' },
  status: 'planned', progress: null, colorId: null, notes: '',
  collapsed: false, createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z',
})
const snap = (items: Item[]): Snapshot =>
  ({ items: Object.fromEntries(items.map((i) => [i.id, i])), lanes: {}, deps: {} })

/* Edit one record and leave every other object identity intact - which is what
   the store actually does, and what trackChanges reads to decide what changed.
   Rebuilding the whole map instead would mark untouched records as edited. */
const edit = (base: Snapshot, id: string, title: string): Snapshot =>
  ({ ...base, items: { ...base.items, [id]: { ...base.items[id], title } } })
const drop = (base: Snapshot, id: string): Snapshot => {
  const items = { ...base.items }
  delete items[id]
  return { ...base, items }
}

let pass = 0, fail = 0
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log('  ok   ', name) }
  else { fail++; console.log('  FAIL ', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

// 1. Concurrent edits to DIFFERENT records both survive (the whole point).
{
  const base = snap([it('a', 'A'), it('b', 'B')])
  const revs = seedRevisions(base, '2026-01-01T00:00:00Z')
  const lData = edit(base, 'a', 'A2')
  const rData = edit(base, 'b', 'B2')
  const local = { data: lData, revs: trackChanges(base, lData, revs, '2026-01-02T00:00:00Z') }
  const remote = { data: rData, revs: trackChanges(base, rData, revs, '2026-01-03T00:00:00Z') }
  const m = mergePlans(local, remote, '2026-02-01T00:00:00Z')
  check('laptop edit to A survives', m.data.items.a.title === 'A2', m.data.items.a.title)
  check('desktop edit to B survives', m.data.items.b.title === 'B2', m.data.items.b.title)
}

// 2. Same record edited on both -> newer timestamp wins.
{
  const base = snap([it('a', 'A')])
  const r0 = seedRevisions(base, '2026-01-01T00:00:00Z')
  const local = { data: snap([it('a', 'older')]), revs: trackChanges(base, snap([it('a','older')]), r0, '2026-01-02T00:00:00Z') }
  const remote = { data: snap([it('a', 'newer')]), revs: trackChanges(base, snap([it('a','newer')]), r0, '2026-01-05T00:00:00Z') }
  check('newer edit wins', mergePlans(local, remote, '2026-02-01T00:00:00Z').data.items.a.title === 'newer')
}

// 3. THE BIG ONE: a delete must not be resurrected by the other device's copy.
{
  const base = snap([it('a', 'A'), it('b', 'B')])
  const r0 = seedRevisions(base, '2026-01-01T00:00:00Z')
  const afterDelete = drop(base, 'a')
  const local = { data: afterDelete, revs: trackChanges(base, afterDelete, r0, '2026-01-10T00:00:00Z') }
  const remote = { data: base, revs: r0 }            // still has 'a', never heard about the delete
  const m = mergePlans(local, remote, '2026-02-01T00:00:00Z')
  check('deleted item stays deleted', !('a' in m.data.items), Object.keys(m.data.items))
  check('delete needs pushing to server', m.changedRemote)
  check('tombstone retained', m.revs.items.a?.deleted === true)
}

// 4. ...but an edit made AFTER the delete wins (undelete by editing elsewhere).
{
  const base = snap([it('a', 'A')])
  const r0 = seedRevisions(base, '2026-01-01T00:00:00Z')
  const local = { data: snap([]), revs: trackChanges(base, snap([]), r0, '2026-01-10T00:00:00Z') }
  const revived = snap([it('a', 'revived')])
  const remote = { data: revived, revs: trackChanges(base, revived, r0, '2026-01-20T00:00:00Z') }
  const m = mergePlans(local, remote, '2026-02-01T00:00:00Z')
  check('later edit beats earlier delete', m.data.items.a?.title === 'revived')
}

// 5. Expired tombstones are dropped, not kept forever.
{
  const local = { data: snap([]), revs: { items: { a: { at: '2020-01-01T00:00:00Z', deleted: true as const } }, lanes: {}, deps: {} } }
  const remote = { data: snap([]), revs: emptyRevisions() }
  const m = mergePlans(local, remote, '2026-02-01T00:00:00Z')
  check('ancient tombstone pruned', !('a' in m.revs.items), m.revs.items)
}

// 6. First sync: empty server, everything local pushes up, nothing changes locally.
{
  const base = snap([it('a', 'A'), it('b', 'B')])
  const local = { data: base, revs: seedRevisions(base, '2026-01-01T00:00:00Z') }
  const remote = { data: snap([]), revs: emptyRevisions() }
  const m = mergePlans(local, remote, '2026-02-01T00:00:00Z')
  check('first sync keeps all local items', Object.keys(m.data.items).length === 2)
  check('first sync does not disturb local', !m.changedLocal)
  check('first sync pushes to server', m.changedRemote)
}

// 7. Idempotent: merging an already-merged state changes nothing.
{
  const base = snap([it('a', 'A')])
  const side = { data: base, revs: seedRevisions(base, '2026-01-01T00:00:00Z') }
  const m = mergePlans(side, side, '2026-02-01T00:00:00Z')
  check('no phantom local change', !m.changedLocal)
  check('no phantom remote change', !m.changedRemote)
}

// 8. Order of arguments must not change the outcome.
{
  const base = snap([it('a', 'A'), it('b', 'B')])
  const r0 = seedRevisions(base, '2026-01-01T00:00:00Z')
  const aData = edit(base, 'a', 'A2')
  const bData = edit(base, 'b', 'B2')
  const A = { data: aData, revs: trackChanges(base, aData, r0, '2026-01-02T00:00:00Z') }
  const B = { data: bData, revs: trackChanges(base, bData, r0, '2026-01-03T00:00:00Z') }
  const ab = mergePlans(A, B, '2026-02-01T00:00:00Z').data
  const ba = mergePlans(B, A, '2026-02-01T00:00:00Z').data
  check('converges regardless of side', JSON.stringify(ab) === JSON.stringify(ba))
}

// 9. THE LOOP: remote data always arrives freshly parsed, so every record is a
//    new object. Reference equality calls that a change, writes, gets its own
//    write echoed back, and does it again - forever.
{
  const base = snap([it('a', 'A'), it('b', 'B')])
  const revs = seedRevisions(base, '2026-01-01T00:00:00Z')
  const local = { data: base, revs }
  const remote = {
    data: JSON.parse(JSON.stringify(base)) as Snapshot,
    revs: JSON.parse(JSON.stringify(revs)) as typeof revs,
  }
  const m = mergePlans(local, remote, '2026-02-01T00:00:00Z')
  check('settled plan needs no local update', !m.changedLocal)
  check('settled plan needs no remote write', !m.changedRemote)
}

// 10. Second Mac: a fresh install's sample plan must not contaminate the real
//     one. Its 22 blocks carry ids no other device has seen, so a plain merge
//     would treat every one of them as new work and sync them everywhere.
{
  const sample = snap([it('s1', 'Current role'), it('s2', 'Build Timeline')])
  const real = snap([it('r1', 'My actual plan'), it('r2', 'Another real block')])
  const local = { data: sample, revs: seedRevisions(sample, '2026-02-01T00:00:00Z') }
  const remote = { data: real, revs: seedRevisions(real, '2026-01-01T00:00:00Z') }

  const m = resolvePlan(local, remote, true)
  const ids = Object.keys(m.data.items).sort()
  check('adopts the real plan', ids.join() === 'r1,r2', ids)
  check('no sample blocks leak in', !ids.some((i) => i.startsWith('s')), ids)
  check('local is replaced', m.changedLocal)
  check('nothing is pushed back', !m.changedRemote)
}

// 11. ...but a sample plan with an empty server still uploads: a brand-new
//     account has to start from something, and that something is the sample.
{
  const sample = snap([it('s1', 'Current role')])
  const local = { data: sample, revs: seedRevisions(sample, '2026-02-01T00:00:00Z') }
  const remote = { data: snap([]), revs: emptyRevisions() }
  const m = resolvePlan(local, remote, true)
  check('first ever sign-in keeps its plan', Object.keys(m.data.items).length === 1)
  check('first ever sign-in uploads it', m.changedRemote)
}

// 12. A plan that has been used is never discarded, however old it looks.
{
  const mine = snap([it('a', 'mine')])
  const theirs = snap([it('b', 'theirs')])
  const local = { data: mine, revs: seedRevisions(mine, '2026-01-01T00:00:00Z') }
  const remote = { data: theirs, revs: seedRevisions(theirs, '2026-02-01T00:00:00Z') }
  const m = resolvePlan(local, remote, false)
  const ids = Object.keys(m.data.items).sort()
  check('used plan merges rather than being replaced', ids.join() === 'a,b', ids)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
