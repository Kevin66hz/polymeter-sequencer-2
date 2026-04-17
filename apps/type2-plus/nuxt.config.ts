// Type2Plus (deluxe) — config for the graphical-upgrade app.
//
// Same layers/core as Type2 → same scheduler, store, MIDI, plugin API.
// Differences live strictly in apps/type2-plus/components/ (RING rich
// rendering, Canvas overlay, future plugin panels). Core logic must never
// diverge on this side — see ARCHITECTURE.md §2 Plus の責務境界.
//
// devServer port 3001 so both apps can run simultaneously during local dev
// (Type2 defaults to 3000).
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },
  extends: ['../../layers/core'],
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],
  devServer: { port: 3001 },
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
