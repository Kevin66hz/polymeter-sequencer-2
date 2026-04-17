# layers/core

Shared Nuxt layer consumed by every app under `apps/*`. This is the **only**
place where:

- Core pure TS lives (`core/`)
- Shared composables live (`composables/useMidi.ts`, `composables/useMidiIn.ts`,
  eventually `useSequencerStore.ts`)
- Shared UI primitives live (`components/MeterKnob.vue`, `components/StepCell.vue`)

## Contract

- **No Vue inside `core/`** — pure TS only. Apps that want to consume `core/`
  must wrap it themselves (see `composables/useSequencerStore.ts` once Phase 2
  lands).
- **No app-specific UI here.** Anything that knows about RING / GRID / RING-Plus
  belongs under `apps/<name>/components/`.
- **All `core/*` imports use the `#core` alias** (configured in this layer's
  `nuxt.config.ts`). Example:

  ```ts
  import { stepCount } from '#core/pure/meter'
  import { createScheduler } from '#core/scheduler/create-scheduler'
  import type { Track, NoteEvent } from '#core/types'
  ```

## Directory map

```
layers/core/
├── nuxt.config.ts              alias: #core -> ./core
├── tailwind.preset.js          shared Tailwind theme
├── core/                       pure TS
│   ├── pure/                   meter.ts, bridge.ts, pending.ts
│   ├── scheduler/              create-scheduler.ts
│   ├── adapters/               audio.ts  (swappable AudioAdapter interface)
│   ├── plugins/                api.ts + builtins/note-repeat.ts
│   └── types/                  Track, Pending, NoteEvent, SequencerPlugin
├── composables/
│   ├── useMidi.ts              Web MIDI OUT
│   └── useMidiIn.ts            MIDI IN: clock sync, mapping, learn
└── components/
    ├── MeterKnob.vue
    └── StepCell.vue
```

## How apps consume this layer

```ts
// apps/type2/nuxt.config.ts
export default defineNuxtConfig({
  extends: ['../../layers/core'],
  // ... app-specific config
})
```

```js
// apps/type2/tailwind.config.js
import preset from '../../layers/core/tailwind.preset.js'

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  content: [
    './components/**/*.vue',
    './pages/**/*.vue',
    './app.vue',
    // IMPORTANT: layer-side paths must be listed here too, otherwise
    // Tailwind will purge classes used only in shared components.
    '../../layers/core/components/**/*.vue',
    '../../layers/core/composables/**/*.ts',
  ],
}
```

See `ARCHITECTURE.md` at the repo root for the full design.
