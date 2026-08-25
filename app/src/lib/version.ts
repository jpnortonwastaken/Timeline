/**
 * The running app's version.
 *
 * Asked of the app itself rather than baked in at build time. A constant
 * compiled into the frontend comes from whichever config the *web* build read,
 * which is not necessarily the one that stamped the bundle - so the two can
 * disagree, and an app that has just updated can sit there reporting the
 * version it used to be. `getVersion()` reads Info.plist at runtime and cannot.
 */
import { useEffect, useState } from 'react'
import { isTauri } from './tauri'

/** What the web build was compiled from. The fallback outside the Mac app. */
export const BUILD_VERSION = __APP_VERSION__

let cached: string | null = null

export function useAppVersion(): string {
  const [version, setVersion] = useState(cached ?? BUILD_VERSION)
  useEffect(() => {
    if (cached || !isTauri) return
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => {
        cached = v
        setVersion(v)
      })
      .catch(() => {
        /* Falls back to the build constant, which is right often enough. */
      })
  }, [])
  return version
}
