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

/** The current value, for callers outside React that need it right now. */
export const getAccountState = (): AccountState => state

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

/**
 * Which attempt is current.
 *
 * Starting a sign-in aborts any previous one, and the aborted attempt then
 * runs its own cleanup - which would clear `busy` belonging to the attempt
 * that just replaced it, leaving the button reading "Sign in" while a browser
 * tab sits open waiting. Only the newest attempt is allowed to report state.
 */
let attempt = 0

/** Pressing again restarts: the usual reason to press twice is a closed tab. */
export async function signIn(): Promise<void> {
  const mine = ++attempt
  setState({ busy: true, error: null })
  try {
    const { signInWithGoogle } = await import('./auth')
    await signInWithGoogle()
    /* `subscribeUser` reports the new session and starts sync; nothing to do. */
  } catch (err) {
    if (mine !== attempt) return
    const { SignInCancelled } = await import('./auth')
    /* Backing out is a decision, not a fault - it leaves no message behind. */
    if (err instanceof SignInCancelled) setState({ error: null })
    else setState({ error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (mine === attempt) setState({ busy: false })
  }
}

/** Abandon an attempt that is still waiting on the browser. */
export async function cancelSignIn(): Promise<void> {
  attempt++
  setState({ busy: false, error: null })
  const { cancelSignIn: cancel } = await import('./auth')
  cancel()
}

/**
 * Remove the cloud copy and the account, leaving this Mac's plan alone.
 *
 * Exists so nobody has to email a stranger and wait to have their own data
 * deleted - a privacy policy that promises deletion by correspondence is a
 * promise the user cannot verify and the developer has to keep by hand forever.
 */
export async function deleteAccount(): Promise<void> {
  setState({ busy: true, error: null })
  try {
    /* Stop first, or an in-flight merge would happily write the plan straight
       back into the document that was just deleted. */
    stopSync()
    const { deleteAccountAndData } = await import('./auth')
    await deleteAccountAndData()
    setState({ phase: 'out', account: null })
  } catch (err) {
    const { SignInCancelled } = await import('./auth')
    if (err instanceof SignInCancelled) {
      setState({ error: 'Deletion needs you to sign in again to confirm it is you.' })
    } else {
      setState({ error: err instanceof Error ? err.message : String(err) })
    }
    /* Nothing was necessarily removed, so put syncing back the way it was. */
    const uid = state.account?.uid
    if (uid) void startSync(uid)
  } finally {
    setState({ busy: false })
  }
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
