// Shared Tailwind preset. Apps reference this via `presets: [...]` in their
// own tailwind.config.js, then add per-app `content` entries for their own
// pages / components plus the layer's shared components.

/** @type {Partial<import('tailwindcss').Config>} */
export default {
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
