/**
 * The two moments this app asks for an account.
 *
 * Neither is a wall, and that is deliberate. The plan lives on this Mac and
 * works with no account, no network and no Firebase project at all - gating the
 * app behind sign-in would throw that away, lock out anyone without a Google
 * account, and make one free-tier project a hard dependency for reading work
 * somebody already wrote.
 *
 * So: ask clearly, once at the start and once when there is finally something
 * worth losing, and take no for an answer both times.
 */
import { useEffect, useState } from 'react'
import { firebaseConfigured } from '../lib/firebase'
import { signIn, useAccount } from '../lib/account'
import { isPristine, launchCount, useStore } from '../store'
import markLight from '../assets/mark-light.png?inline'
import markDark from '../assets/mark-dark.png?inline'

const WELCOMED = 'timeline.welcomed'
const NUDGED = 'timeline.nudged'

/**
 * Openings before the second ask. Coming back means they kept it, which is the
 * point at which having no backup is worth mentioning.
 */
const NUDGE_AFTER_LAUNCHES = 2

function GoogleMark() {
  return (
    <svg className="gsi" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  )
}

function Mark() {
  return (
    <>
      <img className="prompt-mark light" src={markLight} alt="" aria-hidden />
      <img className="prompt-mark dark" src={markDark} alt="" aria-hidden />
    </>
  )
}

/** The first-run card. Sign-in is the loud option; carrying on is the quiet one. */
function Welcome({ onDone }: { onDone: () => void }) {
  const { busy } = useAccount()
  return (
    <div className="prompt-veil">
      <div className="prompt-card pop">
        <Mark />
        <h1>Timelime</h1>
        <p className="prompt-lead">
          Plan projects and a whole life on one canvas.
        </p>
        <button className="prompt-primary" onClick={() => void signIn()}>
          <GoogleMark />
          {busy ? 'Waiting for browser…' : 'Sign in with Google'}
        </button>
        <p className="prompt-why">
          Keeps your plan on every Mac you use, and safe if this one breaks.
        </p>
        <button className="prompt-secondary" onClick={onDone}>
          Start without an account
        </button>
      </div>
    </div>
  )
}

/** The second ask, once the plan is unmistakably theirs. Corner, not centre. */
function Nudge({ onDone }: { onDone: () => void }) {
  const { busy } = useAccount()
  /* Clear of the overview strip - covering a control the user might want to
     reach is a poor way to ask them for a favour. */
  const showMinimap = useStore((st) => st.showMinimap)
  return (
    <div className={'prompt-nudge pop' + (showMinimap ? ' above-minimap' : '')}>
      <Mark />
      <div className="prompt-nudge-text">
        <strong>Back up your plan</strong>
        <span>It only lives on this Mac right now.</span>
      </div>
      <div className="prompt-nudge-actions">
        <button className="prompt-primary small" onClick={() => void signIn()}>
          <GoogleMark />
          {busy ? 'Waiting…' : 'Sign in'}
        </button>
        <button className="prompt-secondary small" onClick={onDone}>
          Not now
        </button>
      </div>
    </div>
  )
}

export function SignInPrompt() {
  const { phase } = useAccount()
  const [welcomed, setWelcomed] = useState(() => !!localStorage.getItem(WELCOMED))
  const [nudged, setNudged] = useState(() => !!localStorage.getItem(NUDGED))

  /* Signing in settles both questions for good. */
  useEffect(() => {
    if (phase !== 'in') return
    localStorage.setItem(WELCOMED, '1')
    localStorage.setItem(NUDGED, '1')
    setWelcomed(true)
    setNudged(true)
  }, [phase])

  if (!firebaseConfigured || phase !== 'out') return null

  /* `unknown` phase is deliberately excluded above: flashing a sign-in card at
     someone who is already signed in, for the moment it takes to restore the
     session, is worse than showing nothing. */
  if (!welcomed && isPristine()) {
    return (
      <Welcome
        onDone={() => {
          localStorage.setItem(WELCOMED, '1')
          setWelcomed(true)
        }}
      />
    )
  }

  /* Never against the sample plan: there would be nothing of theirs to lose. */
  if (welcomed && !nudged && !isPristine() && launchCount() >= NUDGE_AFTER_LAUNCHES) {
    return (
      <Nudge
        onDone={() => {
          localStorage.setItem(NUDGED, '1')
          setNudged(true)
        }}
      />
    )
  }
  return null
}
