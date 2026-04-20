// Type2 (lean) — config for the baseline app under apps/type2/.
//
// Extends layers/core so the shared layer (pure fns, scheduler,
// useSequencerStore, MIDI composables, shared primitives) is auto-imported
// alongside this app's own components / pages.
import { execSync } from 'node:child_process'

// Build-time git info for the in-UI version badge. Computed once at
// config-eval time — Nuxt re-runs the config for each dev/build, so a
// git checkout between runs picks up the new branch/sha. Failures fall
// back to 'unknown' so a clone without git history still builds.
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
  vite: {
    define: {
      __APP_VARIANT__: JSON.stringify('TYPE 2'),
      __GIT_BRANCH__: JSON.stringify(gitInfo.branch),
      __GIT_SHA__: JSON.stringify(gitInfo.sha),
      __GIT_DIRTY__: JSON.stringify(gitInfo.dirty),
    },
  },
  app: {
    head: {
      title: 'Polymeter Sequencer — Type2',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  },
})
