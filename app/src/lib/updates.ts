/**
 * Checking for, downloading and installing updates.
 *
 * Nothing here happens without the user pressing something. Downloading in the
 * background is defensible; replacing the app someone is in the middle of
 * using, and restarting it under them, is not - so the install is always a
 * deliberate act and the restart is offered rather than taken.
 *
 * Every path is allowed to fail quietly. A planning app that cannot reach
 * GitHub is a planning app, not a broken one, and an update check failing is
 * never worth an error in front of somebody.
 */
import { useSyncExternalStore } from 'react'
import { isTauri } from './tauri'

export interface UpdateInfo {
  version: string
  notes?: string
  date?: string
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'none'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  info: UpdateInfo | null
  /** 0-1 while downloading, when the server sent a length to measure against. */
  progress: number
  message?: string
}

let state: UpdateState = { phase: 'idle', info: null, progress: 0 }
const listeners = new Set<() => void>()
function setState(next: Partial<UpdateState>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}
function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export const useUpdate = (): UpdateState => useSyncExternalStore(subscribe, () => state)

/** Held between check and install so the download does not re-resolve it. */
let pending: { downloadAndInstall: (cb?: (e: unknown) => void) => Promise<void> } | null = null

/** How long after launch to look. Long enough to be out of the way of startup. */
const FIRST_CHECK_DELAY = 8000

export async function checkForUpdate(manual = false): Promise<void> {
  if (!isTauri) return
  if (state.phase === 'checking' || state.phase === 'downloading') return
  setState({ phase: 'checking', message: undefined })
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const found = await check()
    if (!found) {
      setState({ phase: 'none', info: null })
      return
    }
    pending = found
    setState({
      phase: 'available',
      info: { version: found.version, notes: found.body, date: found.date },
    })
  } catch (err) {
    /* Offline, GitHub down, no release yet - none of it is the user's problem,
       and a manual check is the only time anyone is waiting on an answer. */
    setState({
      phase: manual ? 'error' : 'idle',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function installUpdate(): Promise<void> {
  if (!pending) return
  setState({ phase: 'downloading', progress: 0 })
  try {
    let total = 0
    let got = 0
    await pending.downloadAndInstall((event) => {
      const e = event as { event: string; data?: { contentLength?: number; chunkLength?: number } }
      if (e.event === 'Started') total = e.data?.contentLength ?? 0
      else if (e.event === 'Progress') {
        got += e.data?.chunkLength ?? 0
        if (total > 0) setState({ progress: Math.min(1, got / total) })
      }
    })
    setState({ phase: 'ready', progress: 1 })
  } catch (err) {
    setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Restart into the new version.
 *
 * Safe at any moment: the store writes to disk 400ms after every change, and
 * the plan is read back from exactly there on the way up.
 */
export async function restartIntoUpdate(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process')
  await relaunch()
}

export function dismissUpdate(): void {
  setState({ phase: 'idle', info: null, progress: 0, message: undefined })
}

let started = false
/** One quiet check a little after launch. Call once. */
export function startUpdateChecks(): void {
  if (started || !isTauri) return
  started = true
  setTimeout(() => void checkForUpdate(), FIRST_CHECK_DELAY)
}
