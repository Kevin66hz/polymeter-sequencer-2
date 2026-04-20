// Type2Plus (deluxe) — config for the graphical-upgrade app.
//
// Same layers/core as Type2 → same scheduler, store, MIDI, plugin API.
// Differences live strictly in apps/type2-plus/components/ (RING rich
// rendering, Canvas overlay, future plugin panels). Core logic must never
// diverge on this side — see ARCHITECTURE.md §2 Plus の責務境界.
//
// devServer port 3001 so both apps can run simultaneously during local dev
// (Type2 defaults to 3000).
import { execSync } from 'node:child_process'

// Build-time git info — mirrored from apps/type2/nuxt.config.ts so the
// version badge in the UI stays consistent between the two apps. See
// comments there for rationale.
const gitInfo = (() => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0
    return { branch, sha, dirty }
  } catch {
    return { branch: 'unknown', sha: '', dirty: false }
  }
})()

export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },
  extends: ['../../layers/core'],
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],
  devServer: { port: 3001 },
  vite: {
    define: {
      __APP_VARIANT__: JSON.stringify('TYPE 2+'),
      __GIT_BRANCH__: JSON.stringify(gitInfo.branch),
      __GIT_SHA__: JSON.stringify(gitInfo.sha),
      __GIT_DIRTY__: JSON.stringify(gitInfo.dirty),
    },
  },
  app: {
    head: {
      title: 'Polymeter Sequencer — Type2Plus',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  },
})
