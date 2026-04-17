// Type2 (lean) — config for the baseline app under apps/type2/.
//
// Extends layers/core so the shared layer (pure fns, scheduler,
// useSequencerStore, MIDI composables, shared primitives) is auto-imported
// alongside this app's own components / pages.
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },
  extends: ['../../layers/core'],
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],
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
