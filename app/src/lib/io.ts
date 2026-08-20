import { useStore } from '../store'

export function downloadJSON() {
  const blob = new Blob([useStore.getState().exportJSON()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `timeline-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function pickAndImport() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      useStore.getState().importJSON(await file.text())
    } catch (err) {
      alert(`Could not import that file: ${(err as Error).message}`)
    }
  }
  input.click()
}
