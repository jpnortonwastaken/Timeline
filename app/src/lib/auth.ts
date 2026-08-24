/**
 * Google sign-in, done the way a desktop app is supposed to do it (RFC 8252).
 *
 * Firebase's own `signInWithPopup` is not an option here. Google refuses OAuth
 * from an embedded web view - it answers `disallowed_useragent` - and this app
 * *is* an embedded web view. So the consent screen opens in the user's real
 * browser, and Google redirects back to a listener this app runs on loopback
 * for the few seconds the flow is in progress.
 *
 * The code that comes back is exchanged for an ID token, which Firebase then
 * accepts as a credential. The exchange goes through the Rust HTTP plugin
 * rather than `fetch`: the request carries a client secret, and routing it
 * through the WebView would put it in front of any page script and hand it an
 * Origin header Google has no reason to trust.
 */
import type { User } from 'firebase/auth'
import { firebase, googleClientId, googleClientSecret } from './firebase'
import { isTauri } from './tauri'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** openid gets us the ID token Firebase wants; the rest fill in the profile. */
const SCOPES = 'openid email profile'

/** What the browser tab shows once Google has handed the code back. */
const DONE_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Signed in</title><style>
body{font:15px -apple-system,system-ui,sans-serif;color:#37352f;background:#fff;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{text-align:center}h1{font-size:17px;font-weight:600;margin:0 0 6px}
p{margin:0;color:#787774}@media(prefers-color-scheme:dark){
body{background:#191919;color:#e9e9e7}p{color:#9b9a97}}
</style></head><body><div><h1>You're signed in to Timelime</h1>
<p>You can close this tab and go back to the app.</p></div></body></html>`

function randomUrlSafe(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return base64Url(buf)
}

function base64Url(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomUrlSafe(32)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(digest) }
}

export class AuthError extends Error {}

/**
 * Run the whole flow. Resolves with the signed-in user, or throws - including
 * when the user simply closes the browser tab without deciding, which is a
 * normal thing to do and not worth an alarming message.
 */
export async function signInWithGoogle(): Promise<User> {
  if (!isTauri) throw new AuthError('Sign-in is only available in the desktop app')
  if (!googleClientId || !googleClientSecret) {
    throw new AuthError('This build has no Google client configured')
  }
  /* Bound locally so the narrowing above survives into the callbacks below. */
  const clientId = googleClientId
  const clientSecret = googleClientSecret

  const [{ start, cancel, onUrl }, { openUrl }, { fetch: tauriFetch }, fb] = await Promise.all([
    import('@fabianlars/tauri-plugin-oauth'),
    import('@tauri-apps/plugin-opener'),
    import('@tauri-apps/plugin-http'),
    firebase(),
  ])
  const { verifier, challenge } = await pkce()
  /* Tying the response back to this request is the whole point of `state` -
     without it a stray redirect from another tab would be indistinguishable. */
  const state = randomUrlSafe(16)

  const port = await start({ response: DONE_PAGE })
  let unlisten: (() => void) | undefined

  try {
    const redirectUri = `http://127.0.0.1:${port}`
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AuthError('Sign-in timed out')),
        5 * 60 * 1000,
      )
      void onUrl((url) => {
        clearTimeout(timer)
        const params = new URL(url).searchParams
        if (params.get('state') !== state) {
          reject(new AuthError('Sign-in response did not match this request'))
          return
        }
        const err = params.get('error')
        if (err) {
          reject(new AuthError(err === 'access_denied' ? 'Sign-in was cancelled' : err))
          return
        }
        const c = params.get('code')
        if (c) resolve(c)
        else reject(new AuthError('Google did not return an authorization code'))
      }).then((un) => {
        unlisten = un
      })

      const authUrl =
        `${AUTH_ENDPOINT}?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          /* Without this Google silently reuses the last account on a machine
             with several signed in, which looks like the app picking for you. */
          prompt: 'select_account',
        })
      void openUrl(authUrl).catch(() => reject(new AuthError('Could not open your browser')))
    })

    const res = await tauriFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }).toString(),
    })
    const token = (await res.json()) as { id_token?: string; error_description?: string }
    if (!res.ok || !token.id_token) {
      throw new AuthError(token.error_description ?? 'Google rejected the sign-in')
    }

    const { GoogleAuthProvider, signInWithCredential } = await import('firebase/auth')
    const cred = await signInWithCredential(
      fb.auth,
      GoogleAuthProvider.credential(token.id_token),
    )
    return cred.user
  } finally {
    unlisten?.()
    await cancel(port).catch(() => {})
  }
}

export async function signOut(): Promise<void> {
  const { auth } = await firebase()
  const { signOut: fbSignOut } = await import('firebase/auth')
  await fbSignOut(auth)
}

/**
 * Subscribe to the signed-in user. Fires immediately with the restored session
 * (or null), so callers do not need a separate "still checking" state beyond
 * the first tick.
 */
export async function subscribeUser(cb: (user: User | null) => void): Promise<() => void> {
  const { auth } = await firebase()
  const { onAuthStateChanged } = await import('firebase/auth')
  return onAuthStateChanged(auth, cb)
}
