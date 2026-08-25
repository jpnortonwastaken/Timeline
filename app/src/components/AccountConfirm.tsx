/**
 * Confirming signing out and deleting an account.
 *
 * Dialogs rather than rows inside the settings menu. Both of these end a
 * session, one of them irreversibly, and a confirmation buried in a menu that
 * closes the moment you look away reads as a setting rather than a decision.
 *
 * They also have to outlive the menu, which unmounts on the very click that
 * opens them - so the state lives out here rather than in the menu component.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { deleteAccount, getAccountState, signOutAccount, useAccount } from '../lib/account'

type Kind = 'signout' | 'delete'

let openKind: Kind | null = null
const listeners = new Set<() => void>()
function set(next: Kind | null) {
  openKind = next
  for (const fn of listeners) fn()
}
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const confirmSignOut = () => set('signout')
export const confirmDeleteAccount = () => set('delete')

/**
 * What each one says.
 *
 * The reassurance is the important half of both. People hesitate here because
 * they cannot tell whether this takes their work with it - and it doesn't, in
 * either case, because the plan has never depended on the account.
 */
const COPY = {
  signout: {
    title: 'Sign out?',
    body: 'Timelime will stop syncing to the cloud until you sign in again.',
    keep: 'Your plan stays on this Mac and keeps working exactly as it does now.',
    action: 'Sign out',
    working: 'Signing out…',
    danger: false,
  },
  delete: {
    title: 'Delete your account?',
    body:
      'This removes your account and the copy of your plan stored in the cloud, ' +
      'permanently. It cannot be undone.',
    keep:
      'Your plan stays on this Mac. Timelime keeps working without an account — ' +
      "you just won't have it on your other Macs any more.",
    action: 'Delete account',
    working: 'Deleting…',
    danger: true,
  },
} as const

export function AccountConfirm() {
  const kind = useSyncExternalStore(subscribe, () => openKind)
  const { account, busy, error } = useAccount()

  /* Escape closes it, as on any dialog - but not mid-run, when there is nothing
     left to cancel and dismissing would only hide what is happening. */
  useEffect(() => {
    if (!kind) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation()
        set(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [kind, busy])

  if (!kind) return null
  const copy = COPY[kind]

  const run = async () => {
    if (kind === 'delete') await deleteAccount()
    else await signOutAccount()
    /* Read straight from the store rather than the closed-over `error`, which
       is a render old by now. Left open on failure so the reason is readable. */
    if (!getAccountState().error) set(null)
  }

  return (
    <div
      className="prompt-veil"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) set(null)
      }}
    >
      <div className="confirm-card pop" role="alertdialog" aria-modal="true">
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <p className="confirm-keep">{copy.keep}</p>
        {account?.email && <p className="confirm-who">{account.email}</p>}
        {error && <p className="confirm-error">{error}</p>}
        <div className="confirm-buttons">
          <button className="confirm-cancel" disabled={busy} onClick={() => set(null)}>
            Cancel
          </button>
          <button
            className={'confirm-go' + (copy.danger ? ' danger' : '')}
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? copy.working : copy.action}
          </button>
        </div>
        {busy && kind === 'delete' && (
          <p className="confirm-note">
            Your browser will open so Google can confirm it is you.
          </p>
        )}
      </div>
    </div>
  )
}
