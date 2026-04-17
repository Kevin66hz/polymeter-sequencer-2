<!--
  RingsStatic.vue — Static layer of the concentric ring view.

  This component renders:
    - Ring guide circles
    - Step dots (active/inactive state)
    - CH/MIDI labels at 12 o'clock
    - Click handlers for selection and step toggle

  CRITICAL: This component does NOT depend on `heads` prop. All playhead-related
  visuals (needle, hit flash) are handled by RingsOverlay which updates via RAF,
  completely outside Vue's reactive system.
-->
<template>
  <g>
    <!-- One ring per track, innermost = track 0 -->
    <g v-for="(trk, ti) in tracks" :key="trk.id">
      <!-- Ring guide circle -->
      <circle
        :cx="CX"
        :cy="CY"
        :r="ringR(ti)"
        fill="none"
        :stroke="selectedId === ti ? trk.color : '#1e2030'"
        :stroke-width="selectedId === ti ? 1.5 : 0.8"
        opacity="0.6"
        class="cursor-pointer"
        @click.stop="$emit('select', ti)"
      />

      <!-- Step dots on this ring.
           trackCoords[ti] is a precomputed { x: number[], y: number[] } —
           template reads are plain array lookups, no trig on the hot path. -->
      <g v-for="(active, si) in trk.steps" :key="si">
        <!-- Invisible hit zone (larger click target) -->
        <circle
          :cx="trackCoords[ti].x[si]"
          :cy="trackCoords[ti].y[si]"
          :r="dotR(ti) + 3"
          fill="transparent"
          class="cursor-pointer"
          @click.stop="$emit('toggle', ti, si)"
        />
        <!-- Visible dot (static state only — no playhead highlight here) -->
        <circle
          :cx="trackCoords[ti].x[si]"
          :cy="trackCoords[ti].y[si]"
          :r="dotR(ti)"
          :fill="active ? trk.color : '#1c1e2e'"
          :opacity="trk.mute ? 0.25 : 1"
          class="pointer-events-none"
        />
      </g>

      <!-- CH label at the top of each ring -->
      <text
        :x="labelX(ti)"
        :y="labelY(ti)"
        text-anchor="middle"
        dominant-baseline="middle"
        class="pointer-events-none"
        :fill="selectedId === ti ? trk.color : '#3a3d50'"
        :font-size="selectedId === ti ? 8 : 7"
        font-family="monospace"
        font-weight="bold"
      >{{ audioOn ? trk.name : `${trk.midiChannel}-${trk.midiNote}` }}</text>
    </g>
  </g>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Track } from '#core/types'
import { CX, CY, ringR, dotR, getDotCoords, labelX, labelY } from './rings-geom'

const props = withDefaults(defineProps<{
  tracks: Track[]
  selectedId: number
  audioOn: boolean
}>(), {
  audioOn: true,
})

defineEmits<{
  select: [trackId: number]
  toggle: [trackId: number, stepIndex: number]
}>()

/**
 * Per-track dot coordinates. Re-evaluated when a track's step count
 * changes (pattern length = meter change). Each entry is a shared
 * reference into the module-level cache in rings-geom so the trig only
 * runs on the first encounter of a given (ti, total) combo.
 *
 * Template reads `trackCoords[ti].x[si]` / `.y[si]` — two array lookups.
 */
const trackCoords = computed(() =>
  props.tracks.map((trk, ti) => getDotCoords(ti, trk.steps.length)),
)
</script>
