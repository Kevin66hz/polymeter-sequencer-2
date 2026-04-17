/** @type {import('tailwindcss').Config} */
export default {
  content: [
    // This config sits at apps/type2/. Paths below are relative to it.
    './components/**/*.{vue,js,ts}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './plugins/**/*.{js,ts}',
    './app.vue',
    './error.vue',
    // Layer-side Vue/TS must be scanned too, otherwise Tailwind purges
    // classes used only in shared primitives (MeterKnob / StepCell) or in
    // useSequencerStore.
    '../../layers/core/components/**/*.vue',
    '../../layers/core/composables/**/*.ts',
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
