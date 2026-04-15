<template>
  <div
    class="circular-track"
    :class="{ selected, muted: track.mute }"
    @click="$emit('select')"
  >
    <!-- viewBox fixed at 110×110; SVG fills parent via width/height 100% -->
    <svg
      viewBox="0 0 110 110"
      width="100%"
      height="100%"
      class="block select-none"
      style="aspect-ratio:1"
    >
      <circle :cx="CX" :cy="CY" :r="OUTER_R"
        fill="#0e0e0e"
        :stroke="selected ? track.color : '#1e1e1e'"
        :stroke-width="selected ? 2 : 1"
        class="cursor-pointer" />

      <!--
        Each dot is placed at 12 o'clock (cx=CX, cy=CY-RING_R) and rotated
        by (si/total)*360° around the SVG center.
        The -90° offset is already baked into the starting position (top of ring),
        so the rotation amount is just (si/total)*360.
        CSS transition on `transform` creates the clock-sweep animation.
      -->
      <g v-for="(active, si) in track.steps" :key="si">
        <!-- Hit flash -->
        <circle v-if="head === si && active"
          :cx="CX" :cy="CY - RING_R"
          :r="DOT_R + 4" :fill="track.color" opacity="0.3"
          class="pointer-events-none ring-dot"
          :style="{ transform: `rotate(${stepDeg(si, track.steps.length)}deg)` }" />
        <!-- Invisible hit zone -->
        <circle
          :cx="CX" :cy="CY - RING_R"
          :r="DOT_R + 3" fill="transparent" class="cursor-pointer ring-dot"
          :style="{ transform: `rotate(${stepDeg(si, track.steps.length)}deg)` }"
          @click.stop="$emit('toggle', si)" />
        <!-- Visible dot — transition creates clock-sweep on step-count change -->
        <circle
          :cx="CX" :cy="CY - RING_R"
          :r="DOT_R"
          :fill="active ? track.color : (head === si ? '#3a3a3a' : '#2a2a2a')"
          :stroke="head === si ? track.color : 'none'"
          stroke-width="1.5"
          :opacity="track.mute ? 0.3 : 1"
          class="pointer-events-none step-dot"
          :style="{
            transform: `rotate(${stepDeg(si, track.steps.length)}deg)`,
            transitionDelay: `${si * 18}ms`,
          }" />
      </g>

      <!-- Needle -->
      <line v-if="head >= 0"
        :x1="CX" :y1="CY" :x2="needleX" :y2="needleY"
        :stroke="track.color" stroke-width="1.5" stroke-linecap="round" opacity="0.85"
        class="pointer-events-none" />

      <!-- Labels -->
      <text :x="CX" :y="CY - 5" text-anchor="middle" dominant-baseline="middle"
        class="pointer-events-none"
        :fill="selected ? '#fff' : '#888'"
        font-size="9" font-family="monospace" font-weight="bold">{{ track.name }}</text>
      <text :x="CX" :y="CY + 7" text-anchor="middle" dominant-baseline="middle"
        class="pointer-events-none"
        :fill="selected ? track.color : '#444'"
        font-size="8" font-family="monospace">{{ track.timeSig }}</text>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Track } from '~/composables/useScheduler'

const props = defineProps<{
  track: Track
  head: number
  selected: boolean
}>()

defineEmits<{
  select: []
  toggle: [stepIndex: number]
}>()

const CX = 55
const CY = 55
const OUTER_R = 50
const RING_R = 39
const DOT_R = 4

// Rotation amount for step si.
// The circle already starts at 12 o'clock (cy = CY - RING_R = -90°),
// so we only need to rotate by (si/total)*360° — no -90 offset.
const stepDeg = (si: number, total: number) => (si / total) * 360

// Needle uses the same angular formula expressed in radians
const stepAngle = (si: number, total: number) =>
  (si / total) * Math.PI * 2 - Math.PI / 2

const needleX = computed(() => {
  if (props.head < 0) return CX
  return CX + (RING_R - 5) * Math.cos(stepAngle(props.head, props.track.steps.length))
})
const needleY = computed(() => {
  if (props.head < 0) return CY
  return CY + (RING_R - 5) * Math.sin(stepAngle(props.head, props.track.steps.length))
})
</script>

<style scoped>
.circular-track {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: auto;
  cursor: pointer;
  transition: transform 0.1s;
}
.circular-track.selected { transform: scale(1.04); }
.circular-track.muted { opacity: 0.4; }

/*
  transform-box:view-box  → transform-origin uses the SVG viewport as reference
  transform-origin:50% 50% → pivot = 50% of viewBox = (55,55) = SVG center
  This is scale-independent and matches the needle's trig calculation.
*/
.ring-dot,
.step-dot {
  transform-box: view-box;
  transform-origin: 50% 50%;
}

/* Clock-sweep: easeOutExpo で弧を描いて収まる、各ドットをずらしてカスケード */
.step-dot {
  transition: transform 0.7s cubic-bezier(0.16, 1, 0.3, 1);
}
</style>
