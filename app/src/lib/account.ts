/**
 * The signed-in account, and the one place auth is joined to sync.
 *
 * Kept out of the zustand store deliberately: everything in there is persisted
 * and undoable, and neither is right for a session. Signing out is not
 * something Cmd-Z should offer to reverse.
 */
import { useSyncExternalStore } from 'react'
import { firebaseConfigured } from './firebase'
import { getSyncState, startSync, stopSync, subscribeSync, type SyncState } from './sync'

export interface Account {
  uid: string
  email: string | null
  name: string | null
  photo: string | null
}

export interface AccountState {
  /** `unknown` until the stored session has been checked - not the same as signed out. */
  phase: 'unknown' | 'in' | 'out'
  account: Account | null
  /** Set when a sign-in attempt failed, cleared when another begins. */
  error: string | null
  busy: boolean
}

let state: AccountState = {
  phase: firebaseConfigured ? 'unknown' : 'out',
  account: null,
  error: null,
  busy: false,
}
const listeners = new Set<() => void>()
function setState(next: Partial<AccountState>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useAccount(): AccountState {
  return useSyncExternalStore(subscribe, () => state)
}

export function useSyncStatus(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState)
}

let started = false

/**
 * Watch the session and mirror it into sync. Call once, at startup.
 *
 * An unconfigured build never gets here, which is what keeps the app usable
 * with no Firebase project at all.
 */
export function initAccount(): void {
  if (started || !firebaseConfigured) return
  started = true
  void (async () => {
    try {
      const { subscribeUser } = await import('./auth')
      await subscribeUser((user) => {
        if (!user) {
          stopSync()
          setState({ phase: 'out', account: null })
          return
        }
        setState({
          phase: 'in',
          account: {
            uid: user.uid,
            email: user.email,
            name: user.displayName,
            photo: user.photoURL,
          },
        })
        void startSync(user.uid)
      })
    } catch (err) {
      /* No session is recoverable from here; the app stays local-only, which
         is a working state rather than a broken one. */
      setState({ phase: 'out', error: err instanceof Error ? err.message : String(err) })
    }
  })()
}

export async function signIn(): Promise<void> {
  setState({ busy: true, error: null })
  try {
    const { signInWithGoogle } = await import('./auth')
    await signInWithGoogle()
    /* `subscribeUser` reports the new session and starts sync; nothing to do. */
  } catch (err) {
    const { SignInCancelled } = await import('./auth')
    /* Backing out is a decision, not a fault - it leaves no message behind. */
    if (err instanceof SignInCancelled) setState({ error: null })
    else setState({ error: err instanceof Error ? err.message : String(err) })
  } finally {
    setState({ busy: false })
  }
}

/** Abandon an attempt that is still waiting on the browser. */
export async function cancelSignIn(): Promise<void> {
  const { cancelSignIn: cancel } = await import('./auth')
  cancel()
}

export async function signOutAccount(): Promise<void> {
  setState({ busy: true })
  try {
    stopSync()
    const { signOut } = await import('./auth')
    await signOut()
  } catch (err) {
    setState({ error: err instanceof Error ? err.message : String(err) })
  } finally {
    setState({ busy: false })
  }
}
