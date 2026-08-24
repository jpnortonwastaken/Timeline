/**
 * Firebase, initialised lazily and never required.
 *
 * The plan lives on this machine. Firebase is a mirror of it, so every export
 * here has to behave when there is no config, no network, and no account -
 * that is the normal state on first run, and it has to stay a working state
 * for anyone who never signs in. Nothing at module scope touches the network.
 */
import type { FirebaseApp } from 'firebase/app'
import type { Auth } from 'firebase/auth'
import type { Firestore } from 'firebase/firestore'

/**
 * These are public identifiers, not secrets - Firebase embeds them in every
 * web client it ships. What actually protects the data is the Firestore rules
 * in `firestore.rules`, which only ever let a signed-in user touch their own
 * document. Read the README before assuming any of this is sensitive.
 */
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

/** The OAuth client Google redirects back to. Desktop type - see the README. */
export const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
/**
 * Google issues this for desktop clients, and its own docs say it cannot be
 * treated as confidential in an app you hand to other people. PKCE is what
 * actually secures the exchange; this is only here because Google's token
 * endpoint still asks for it.
 */
export const googleClientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET as string | undefined

/** False until the project is configured, which is the whole first-run state. */
export const firebaseConfigured =
  !!config.apiKey && !!config.projectId && !!config.appId && !!googleClientId

let appPromise: Promise<{ app: FirebaseApp; auth: Auth; db: Firestore }> | null = null

/**
 * Load the SDK on first use. It is a big dependency and an app that is only
 * ever used locally should not pay for it at startup.
 */
export function firebase() {
  if (!firebaseConfigured) {
    return Promise.reject(new Error('Firebase is not configured in this build'))
  }
  appPromise ??= (async () => {
    const [{ initializeApp, getApps, getApp }, authMod, firestoreMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ])
    const app = getApps().length ? getApp() : initializeApp(config)
    /*
     * `browserLocalPersistence` keeps the session in this WebView's local
     * storage, so signing in survives a restart. That store is the one macOS
     * is free to reclaim - which costs a re-sign-in and nothing else, because
     * the plan itself never lives there alone.
     */
    const auth = authMod.initializeAuth(app, {
      persistence: authMod.browserLocalPersistence,
      popupRedirectResolver: undefined,
    })
    const db = firestoreMod.getFirestore(app)
    return { app, auth, db }
  })()
  return appPromise
}
