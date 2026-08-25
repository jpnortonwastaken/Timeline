/**
 * The update prompt: a card in the corner, never a dialog.
 *
 * An update is good news and it is never urgent - the app someone is already
 * running works. Taking over the screen for it, or restarting under them, would
 * cost more than the update is worth. So it sits out of the way, and both the
 * install and the restart are things the user presses.
 */
import { checkForUpdate, dismissUpdate, installUpdate, restartIntoUpdate, useUpdate } from '../lib/updates'
import { useStore } from '../store'

export function UpdateBanner() {
  const { phase, info, progress, message } = useUpdate()
  /* Clear of the overview strip, like the sign-in nudge. */
  const showMinimap = useStore((s) => s.showMinimap)

  if (phase !== 'available' && phase !== 'downloading' && phase !== 'ready' && phase !== 'error') {
    return null
  }
  const cls = 'update-card pop' + (showMinimap ? ' above-minimap' : '')

  /*
   * A failure has to say so. Returning null here - which this did - made the
   * card vanish the instant an install failed, which reads as the button doing
   * nothing at all and leaves no way to find out otherwise.
   */
  if (phase === 'error') {
    return (
      <div className={cls}>
        <div className="update-text">
          <strong>Update failed</strong>
          {/* `title` keeps the whole message reachable on hover, since the
              visible text is deliberately clamped. */}
          <span className="update-detail" title={message}>
            {message ?? 'Something went wrong installing the update.'}
          </span>
        </div>
        <div className="update-actions">
          <button className="update-primary" onClick={() => void checkForUpdate(true)}>
            Try again
          </button>
          <button className="update-secondary" onClick={dismissUpdate}>
            Dismiss
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'ready') {
    return (
      <div className={cls}>
        <div className="update-text">
          <strong>Update ready</strong>
          <span>Version {info?.version} installs when you restart.</span>
        </div>
        <div className="update-actions">
          <button className="update-primary" onClick={() => void restartIntoUpdate()}>
            Restart now
          </button>
          {/* Not "cancel" - the update is already on disk and applies whenever
              the app is next opened, so saying otherwise would be a lie. */}
          <button className="update-secondary" onClick={dismissUpdate}>
            Later
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'downloading') {
    return (
      <div className={cls}>
        <div className="update-text">
          <strong>Downloading update</strong>
          <span>{progress > 0 ? `${Math.round(progress * 100)}%` : 'Starting…'}</span>
          <span className="update-bar" aria-hidden>
            <span style={{ transform: `scaleX(${progress || 0.02})` }} />
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={cls}>
      <div className="update-text">
        <strong>Timelime {info?.version} is available</strong>
        <span>{message ?? 'Download it now, and it applies when you restart.'}</span>
      </div>
      <div className="update-actions">
        <button className="update-primary" onClick={() => void installUpdate()}>
          Download
        </button>
        <button className="update-secondary" onClick={dismissUpdate}>
          Not now
        </button>
      </div>
    </div>
  )
}
