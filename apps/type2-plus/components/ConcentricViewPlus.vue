<!--
  ConcentricViewPlus.vue — Rich concentric ring view for Type2Plus.

  This component combines:
    - RingsStatic: Ring guides, step dots, labels, click handlers (Vue reactive)
    - RingsOverlay: Playhead needles, hit flashes (RAF-driven, no Vue reactive)
    - Center info: Selected track name, time signature, MUTE indicator

  Props interface matches the original ConcentricView.vue for drop-in replacement.
  The key difference is that playhead updates bypass Vue's reactive system.

  Phase 5 Stage 1: Static/dynamic layer separation.
  Stage 2 will add geometry caching. Stage 3 will add Canvas overlay for effects.
-->
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

      <!-- Static layer: rings, dots, labels, click handlers -->
      <RingsStatic
        :tracks="tracks"
        :selected-id="selectedId"
        :audio-on="audioOn"
        @select="$emit('select', $event)"
        @toggle="(ti, si) => $emit('toggle', ti, si)"
      />

      <!-- Dynamic layer: needles and flashes (RAF-driven) -->
      <RingsOverlay
        ref="overlayRef"
        :display-heads="displayHeads"
        :tracks-raw="tracksRaw"
        :selected-id="selectedId"
      />

      <!-- 開発中 全面オーバーレイ -->
      <rect x="0" y="0" :width="SIZE" :height="SIZE" fill="rgba(60,40,0,0.18)" class="pointer-events-none" />
      <text
        :x="CX" :y="CY + 80"
        text-anchor="middle" dominant-baseline="middle"
        fill="#886622" font-size="13" font-family="monospace" letter-spacing="4"
        opacity="0.35" class="pointer-events-none"
      >[ 開発中 / WORK IN PROGRESS ]</text>
      <text
        :x="CX" :y="16"
        text-anchor="middle" dominant-baseline="hanging"
        fill="#886622" font-size="8" font-family="monospace"
        opacity="0.6" class="pointer-events-none"
      >[ 開発中 ]</text>

      <!-- Center info -->
      <circle :cx="CX" :cy="CY" :r="CENTER_R - 2" fill="#111220" />
      <text
        :x="CX" :y="CY - 8"
        text-anchor="middle" dominant-baseline="middle"
        fill="#ffffff" font-size="11" font-family="monospace" font-weight="bold"
        class="pointer-events-none"
      >{{ audioOn ? (selectedTrack?.name ?? '') : (selectedTrack ? `${selectedTrack.midiChannel}-${selectedTrack.midiNote}` : '') }}</text>
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
import { computed, ref } from 'vue'
import type { Track } from '#core/types'
import { SIZE, CX, CY, CENTER_R } from './rings-geom'
import RingsStatic from './RingsStatic.vue'
import RingsOverlay from './RingsOverlay.vue'

const props = withDefaults(defineProps<{
  tracks: Track[]
  /** @deprecated heads prop is kept for API compatibility but not used for rendering */
  heads: number[]
  selectedId: number
  audioOn: boolean
  /** Raw mirror for RAF overlay: { current: number[] } */
  displayHeads: { current: number[] }
  /** Raw mirror for RAF overlay: { current: Track[] } */
  tracksRaw: { current: Track[] }
}>(), {
  audioOn: true,
})

defineEmits<{
  select: [trackId: number]
  toggle: [trackId: number, stepIndex: number]
}>()

const overlayRef = ref<InstanceType<typeof RingsOverlay> | null>(null)

const selectedTrack = computed(() =>
  props.tracks[props.selectedId] ?? null
)
</script>
