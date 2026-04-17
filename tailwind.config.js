/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './components/**/*.{vue,js,ts}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './plugins/**/*.{js,ts}',
    './app.vue',
    './error.vue',
    // Phase 2: layer-side Vue/TS must be scanned too, otherwise Tailwind
    // purges classes used only in shared primitives (MeterKnob / StepCell)
    // or in useSequencerStore. Paths are relative to this config's location.
    './layers/core/components/**/*.vue',
    './layers/core/composables/**/*.ts',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
