// https://nuxt.com/docs/api/configuration/nuxt-config
//
// Phase 2: this app extends layers/core so that the shared layer (pure fns,
// scheduler, useSequencerStore, MIDI composables, primitives) is auto-imported
// alongside the app's own pages/components. Phase 3 will physically move this
// app under apps/type2/ at which point the `extends` path becomes
// ['../../layers/core'] — no other semantic change.
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },
  extends: ['./layers/core'],
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'Polymeter Sequencer',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  },
})
