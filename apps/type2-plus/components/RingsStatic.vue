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
      <!-- Ring guide circle. Phosphor-green stroke for the radar look —
           selected ring gets a brighter tint while non-selected rings
           sit far back as faint range-circle guidelines. -->
      <circle
        :cx="CX"
        :cy="CY"
        :r="ringR(ti)"
        fill="none"
        :stroke="selectedId === ti ? 'rgba(170, 255, 190, 0.65)' : 'rgba(140, 230, 150, 0.16)'"
        :stroke-width="selectedId === ti ? 1.2 : 0.7"
        :opacity="selectedId === ti ? 0.85 : 0.6"
        vector-effect="non-scaling-stroke"
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
        <!-- Step dot.
             - Active steps are always faintly visible at ~2/3 of the
               playhead-flash radius, in a muted phosphor tint, so the
               programmed pattern is readable even between hits.
             - Inactive steps stay as a tiny grid of "step could go
               here" markers. -->
        <circle
          :cx="trackCoords[ti].x[si]"
          :cy="trackCoords[ti].y[si]"
          :r="active ? (dotR(ti) + 3) * 0.33 : Math.max(0.6, dotR(ti) * 0.32)"
          :fill="active ? 'rgba(140, 220, 155, 1)' : 'rgba(150, 240, 170, 1)'"
          :opacity="active ? (trk.mute ? 0.10 : 0.38) : (trk.mute ? 0.05 : 0.10)"
          class="pointer-events-none"
        />
      </g>

    </g>

    <!-- CH-N labels with horizontal leader lines.
         Stacked outside the rings on the right side. The leader line
         runs horizontally from the ring's right-side intersection (at
         the label's y) out to the label position, so labels never
         overlap the polar grid or the data layers. -->
    <g class="pointer-events-none">
      <line
        v-for="lay in labelLayout"
        :key="`leader-${lay.ti}`"
        :x1="lay.lineX1" :y1="lay.lineY"
        :x2="lay.lineX2" :y2="lay.lineY"
        :stroke="selectedId === lay.ti ? 'rgba(180, 255, 200, 0.7)' : 'rgba(140, 220, 155, 0.28)'"
        :stroke-width="selectedId === lay.ti ? 1 : 0.6"
        vector-effect="non-scaling-stroke"
      />
      <text
        v-for="lay in labelLayout"
        :key="`lbl-${lay.ti}`"
        :x="lay.labelX" :y="lay.lineY"
        text-anchor="start"
        dominant-baseline="middle"
        :fill="selectedId === lay.ti ? 'rgba(220, 255, 230, 0.95)' : 'rgba(160, 235, 175, 0.6)'"
        :font-size="selectedId === lay.ti ? 9 : 8"
        font-family="monospace"
        font-weight="bold"
      >{{ tracks[lay.ti].midiChannel }}-{{ tracks[lay.ti].midiNote }}</text>
    </g>
  </g>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Track } from '#core/types'
import { CX, CY, OUTER_R, ringR, dotR, getDotCoords } from './rings-geom'

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

/**
 * Layout for the CH-N labels stacked OUTSIDE the rings.
 *
 * Each label sits to the right of the outer rim at a y proportional to
 * its ring radius (so inner rings get labels close to the horizontal
 * axis, outer rings get labels further from it — labels naturally fan
 * out without overlapping). The leader line is horizontal: it starts
 * at the ring's right-side intersection with that y and ends at the
 * label x. Because both endpoints share `lineY`, the line is always a
 * pure horizontal segment.
 */
const LABEL_GAP = 10 // distance from OUTER_R out to label start
const LABEL_Y_RATIO = 0.62 // how strongly inner-vs-outer rings stagger
                            // (higher = more vertical spread between labels)
const labelLayout = computed(() => {
  const lineX2 = CX + OUTER_R + LABEL_GAP
  const labelX = lineX2 + 4
  return props.tracks.map((trk, ti) => {
    const r = ringR(ti)
    // Stagger above the horizontal axis: ti=0 closest to CY, larger ti higher up.
    const lineY = CY - r * LABEL_Y_RATIO
    const dy = lineY - CY
    const dx = Math.sqrt(Math.max(0, r * r - dy * dy))
    return {
      ti,
      lineX1: CX + dx,
      lineX2,
      labelX,
      lineY,
    }
  })
})
</script>
