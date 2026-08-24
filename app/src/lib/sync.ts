/**
 * Firestore sync. Local-first: this machine's copy is the source of truth and
 * the cloud is a mirror, never the other way round.
 *
 * That is a deliberate constraint rather than an implementation detail. The app
 * opens instantly and works on a plane because reads never touch the network,
 * and nobody's plan becomes unreachable because a billing card expired or
 * Google had a bad afternoon. Everything here is allowed to fail; none of it is
 * allowed to block an edit.
 *
 * The whole plan is one document per account. At ~40KB against Firestore's 1MB
 * ceiling that is comfortable for a long time, and it buys atomic merges - a
 * transaction reads, merges and writes as one step, so two devices saving at
 * the same moment cannot lose each other's work. `SIZE_WARN` is the tripwire
 * for when this stops being true and records need their own documents.
 */
import type { Snapshot } from '../types'
import { firebase } from './firebase'
import { emptyRevisions, mergePlans, seedRevisions, type Revisions, type Side } from './revisions'

/** Bump only for a change to the document's shape, not to the plan's. */
const SCHEMA = 1
/** Firestore's hard limit is 1MB per document. Shout well before that. */
const SIZE_WARN = 700_000
/** Long enough to coalesce a drag; short enough to feel immediate. */
const PUSH_DEBOUNCE = 1500

export type SyncStatus =
  | 'off'
  | 'connecting'
  | 'synced'
  | 'syncing'
  | 'offline'
  | 'error'

export interface SyncState {
  status: SyncStatus
  /** When the last successful merge landed. */
  at: number | null
  message?: string
}

let state: SyncState = { status: 'off', at: null }
const listeners = new Set<() => void>()

export const getSyncState = () => state
export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function setState(next: Partial<SyncState>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}

interface Doc {
  data: Snapshot
  revs: Revisions
}

const emptyDoc = (): Doc => ({ data: { items: {}, lanes: {}, deps: {} }, revs: emptyRevisions() })

/**
 * The plan travels as two JSON strings rather than as nested Firestore maps.
 *
 * Maps would mean record ids become document field paths, which forbids `.`,
 * `[`, `]`, `*` and `` ` `` in an id; Firestore also rejects `undefined`
 * outright, so one optional field left unset anywhere would fail the whole
 * write. Since every merge happens on the client and always rewrites the whole
 * document anyway, none of that structure buys anything.
 */
function encode(doc: Doc) {
  return {
    schema: SCHEMA,
    payload: JSON.stringify(doc.data),
    revs: JSON.stringify(doc.revs),
    updatedAt: new Date().toISOString(),
  }
}

function decode(raw: unknown): Doc {
  const d = raw as { payload?: string; revs?: string } | undefined
  if (!d?.payload) return emptyDoc()
  try {
    const data = JSON.parse(d.payload) as Snapshot
    const revs = d.revs ? (JSON.parse(d.revs) as Revisions) : seedRevisions(data)
    return {
      data: { items: data.items ?? {}, lanes: data.lanes ?? {}, deps: data.deps ?? {} },
      revs: { items: revs.items ?? {}, lanes: revs.lanes ?? {}, deps: revs.deps ?? {} },
    }
  } catch {
    /* A corrupt remote document must not take the local plan down with it.
       Treating it as empty means the next push simply overwrites it. */
    return emptyDoc()
  }
}

/** Wired up by store.ts, which owns the plan this module mirrors. */
export interface PlanBridge {
  read: () => Side
  write: (data: Snapshot, revs: Revisions) => void
  subscribe: (fn: () => void) => () => void
}
let bridge: PlanBridge | null = null
export function connectPlan(b: PlanBridge) {
  bridge = b
}

let stop: (() => void) | null = null
let pushTimer: number | undefined
let pushing = false
let pushAgain = false

/**
 * Begin mirroring this account's plan. Safe to call repeatedly; the previous
 * subscription is torn down first.
 */
export async function startSync(uid: string): Promise<void> {
  stopSync()
  if (!bridge) throw new Error('sync started before the plan was connected')
  setState({ status: 'connecting', message: undefined })

  const { db } = await firebase()
  const { doc, onSnapshot, runTransaction } = await import('firebase/firestore')
  const ref = doc(db, 'plans', uid)

  /** Read, merge, write - as one atomic step, so a concurrent save can't win. */
  const sync = async () => {
    if (!bridge) return
    if (pushing) {
      pushAgain = true
      return
    }
    pushing = true
    setState({ status: 'syncing' })
    try {
      const merged = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref)
        const remote = decode(snap.data())
        const local = bridge!.read()
        const m = mergePlans(local, remote)
        if (m.changedRemote) {
          const body = encode({ data: m.data, revs: m.revs })
          if (body.payload.length > SIZE_WARN) {
            console.warn(
              `Plan is ${Math.round(body.payload.length / 1024)}KB, nearing Firestore's 1MB ` +
                `document limit. Records need splitting into their own documents.`,
            )
          }
          tx.set(ref, body)
        }
        return m
      })
      if (merged.changedLocal) bridge.write(merged.data, merged.revs)
      setState({ status: 'synced', at: Date.now(), message: undefined })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      /* Offline is the ordinary case, not a fault: the local plan is intact and
         the next successful pass will carry everything up. */
      const offline = /offline|unavailable|network/i.test(msg)
      setState({ status: offline ? 'offline' : 'error', message: offline ? undefined : msg })
    } finally {
      pushing = false
      if (pushAgain) {
        pushAgain = false
        void sync()
      }
    }
  }

  const schedule = () => {
    clearTimeout(pushTimer)
    pushTimer = setTimeout(() => void sync(), PUSH_DEBOUNCE) as unknown as number
  }

  /*
   * `includeMetadataChanges` is off, so this fires for real remote writes and
   * for the local echo of our own. The echo is harmless - merging our own
   * document against itself reports no change and does nothing.
   */
  const unsubRemote = onSnapshot(
    ref,
    () => void sync(),
    (err) => setState({ status: 'error', message: err.message }),
  )
  const unsubLocal = bridge.subscribe(schedule)

  stop = () => {
    clearTimeout(pushTimer)
    unsubRemote()
    unsubLocal()
  }

  await sync()
}

export function stopSync(): void {
  stop?.()
  stop = null
  clearTimeout(pushTimer)
  pushing = false
  pushAgain = false
  setState({ status: 'off', at: null, message: undefined })
}
