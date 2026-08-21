import { useEffect, useState } from 'react'

/**
 * Keeps a component mounted long enough to play an exit animation.
 *
 * Entry is easy - a CSS animation runs on mount by itself. Leaving is the
 * problem: React unmounts the node the instant the flag flips, so there is
 * nothing left to animate. This holds the node for `ms` with `leaving` set,
 * then drops it.
 *
 * `ms` must match the exit animation in styles.css, or the node is pulled
 * out from under a half-finished animation.
 */
export function usePresence(open: boolean, ms: number) {
  const [mounted, setMounted] = useState(open)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (open) {
      setLeaving(false)
      setMounted(true)
      return
    }
    setLeaving(true)
    const t = window.setTimeout(() => {
      setMounted(false)
      setLeaving(false)
    }, ms)
    return () => window.clearTimeout(t)
  }, [open, ms])

  return { mounted, leaving }
}

/** Exit duration for popovers; matches `pop-out` in styles.css. */
export const POP_OUT_MS = 100
/** Class suffix for the animated element. */
export const presenceClass = (leaving: boolean) => (leaving ? ' leaving' : '')
