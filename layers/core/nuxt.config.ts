// Shared Nuxt layer. Apps extend this via `extends: ['../../layers/core']`.
//
// It registers the `#core` alias so both layer-internal and app-side code can
// import from `#core/pure/meter`, `#core/scheduler/create-scheduler`, etc.
//
// Note: we intentionally do NOT register the tailwindcss module here. Each
// app owns its own Tailwind config (see ARCHITECTURE.md §8) so per-app
// overrides / custom `content` paths stay straightforward.

import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  alias: {
    '#core': fileURLToPath(new URL('./core', import.meta.url)),
  },
})
