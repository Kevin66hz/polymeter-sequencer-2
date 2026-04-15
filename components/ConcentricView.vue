<template>
  <div class="flex flex-col items-center gap-2 w-full">
    <svg
      :viewBox="`0 0 ${SIZE} ${SIZE}`"
      :width="SIZE"
      :height="SIZE"
      class="block select-none max-w-full"
      style="max-height: calc(100vh - 180px)"
    >
      <!-- Outer background -->
      <circle :cx="CX" :cy="CY" :r="CX - 4" fill="#0d0e17" />

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
          @click="$emit('select', ti)"
        />

        <!-- Step dots on this ring -->
        <g v-for="(active, si) in trk.steps" :key="si">
          <!-- Hit flash -->
          <circle
            v-if="heads[ti] === si && active"
            :cx="dotX(ti, si, trk.steps.length)"
            :cy="dotY(ti, si, trk.steps.length)"
            :r="dotR(ti) + 3"
            :fill="trk.color"
            opacity="0.35"
            class="pointer-events-none"
          />
          <!-- Invisible hit zone (larger click target) -->
          <circle
            :cx="dotX(ti, si, trk.steps.length)"
            :cy="dotY(ti, si, trk.steps.length)"
            :r="dotR(ti) + 3"
            fill="transparent"
            class="cursor-pointer"
            @click.stop="$emit('toggle', ti, si)"
          />
          <!-- Visible dot -->
          <circle
            :cx="dotX(ti, si, trk.steps.length)"
            :cy="dotY(ti, si, trk.steps.length)"
            :r="dotR(ti)"
            :fill="active ? trk.color : (heads[ti] === si ? '#3a3d50' : '#1c1e2e')"
            :stroke="heads[ti] === si ? trk.color : 'none'"
            stroke-width="1"
            :opacity="trk.mute ? 0.25 : 1"
            class="pointer-events-none"
          />
        </g>

        <!-- Playhead needle for this track -->
        <line
          v-if="heads[ti] >= 0"
          :x1="needleBaseX(ti)"
          :y1="needleBaseY(ti)"
          :x2="needleTipX(ti, heads[ti], trk.steps.length)"
          :y2="needleTipY(ti, heads[ti], trk.steps.length)"
          :stroke="trk.color"
          :stroke-width="selectedId === ti ? 1.5 : 0.8"
          stroke-linecap="round"
          :opacity="selectedId === ti ? 0.9 : 0.5"
          class="pointer-events-none"
        />

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
        >{{ trk.name }}</text>
      </g>

      <!-- Center info -->
      <circle :cx="CX" :cy="CY" :r="CENTER_R - 2" fill="#111220" />
      <text
        :x="CX" :y="CY - 8"
        text-anchor="middle" dominant-baseline="middle"
        fill="#ffffff" font-size="11" font-family="monospace" font-weight="bold"
        class="pointer-events-none"
      >{{ selectedTrack?.name ?? '' }}</text>
      <text
        :x="CX" :y="CY + 6"
        text-anchor="middle" dominant-baseline="middle"
        :fill="selectedTrack?.color ?? '#555870'"
        font-size="9" font-family="monospace"
        class="pointer-events-none"
      >{{ selectedTrack?.timeSig ?? '' }}</text>
      <text
        v-if="selectedTrack?.mute"
        :x="CX" :y="CY + 18"
        text-anchor="middle" dominant-baseline="middle"
        fill="#e05050" font-size="8" font-family="monospace"
        class="pointer-events-none"
      >MUTE</text>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Track } from '~/composables/useScheduler'

const props = defineProps<{
  tracks: Track[]
  heads: number[]
  selectedId: number
}>()

defineEmits<{
  select: [trackId: number]
  toggle: [trackId: number, stepIndex: number]
}>()

const SIZE = 520
const CX = SIZE / 2
const CY = SIZE / 2

// Reserve center circle for labels
const CENTER_R = 28
// Outermost ring radius
const OUTER_R = CX - 12
// Usable radial space
const RADIAL_SPACE = OUTER_R - CENTER_R
// Per-ring spacing
const RING_STEP = RADIAL_SPACE / props.tracks.length

const ringR = (ti: number) => CENTER_R + RING_STEP * (ti + 0.5)

// Dot radius scales slightly with ring index (outer rings are larger)
const dotR = (ti: number) => Math.max(2.5, 2.5 + ti * 0.18)

const stepAngle = (si: number, total: number) =>
  (si / total) * Math.PI * 2 - Math.PI / 2

const dotX = (ti: number, si: number, total: number) =>
  CX + ringR(ti) * Math.cos(stepAngle(si, total))

const dotY = (ti: number, si: number, total: number) =>
  CY + ringR(ti) * Math.sin(stepAngle(si, total))

// Needle base: just outside the previous ring (or center)
const needleBaseX = (ti: number) => {
  const r = ti === 0 ? CENTER_R : ringR(ti) - RING_STEP * 0.4
  // Base points up (12 o'clock direction) — the needle rotates toward current step
  return CX  // always centered; only tip moves
}
const needleBaseY = (ti: number) => CY

const needleTipX = (ti: number, si: number, total: number) => {
  const a = stepAngle(si, total)
  return CX + ringR(ti) * Math.cos(a)
}
const needleTipY = (ti: number, si: number, total: number) => {
  const a = stepAngle(si, total)
  return CY + ringR(ti) * Math.sin(a)
}

// Label positioned just outside the ring at 12 o'clock
const labelX = (ti: number) => CX
const labelY = (ti: number) => CY - ringR(ti) + 1

const selectedTrack = computed(() =>
  props.tracks[props.selectedId] ?? null
)
</script>
