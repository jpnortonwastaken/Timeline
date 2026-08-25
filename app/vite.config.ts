import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
const appVersion = JSON.parse(readFileSync('./src-tauri/tauri.conf.json', 'utf8')).version

export default defineConfig({
  /* One source of truth for the version: tauri.conf.json. */
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react()],
})
