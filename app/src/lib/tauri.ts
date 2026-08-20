/**
 * Everything that only exists when running inside the Mac app.
 *
 * The plugin modules are imported dynamically so the browser build never
 * pulls them in, and so nothing touches `__TAURI_INTERNALS__` at module load.
 */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const FILE = 'timeline.json'

/**
 * A durable copy of the plan next to the app's own data, so a cleared WebView
 * store doesn't take a decade of planning with it.
 */
export async function writeBackup(json: string): Promise<void> {
  if (!isTauri) return
  try {
    const { BaseDirectory, mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs')
    await mkdir('', { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {})
    await writeTextFile(FILE, json, { baseDir: BaseDirectory.AppData })
  } catch (err) {
    console.warn('Could not write the backup file:', err)
  }
}

export async function readBackup(): Promise<string | null> {
  if (!isTauri) return null
  try {
    const { BaseDirectory, exists, readTextFile } = await import('@tauri-apps/plugin-fs')
    if (!(await exists(FILE, { baseDir: BaseDirectory.AppData }))) return null
    return await readTextFile(FILE, { baseDir: BaseDirectory.AppData })
  } catch (err) {
    console.warn('Could not read the backup file:', err)
    return null
  }
}

/** Subscribe to native menu clicks. Returns an unsubscribe function. */
export async function onMenuCommand(handler: (id: string) => void): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<string>('menu', (e) => handler(e.payload))
}
