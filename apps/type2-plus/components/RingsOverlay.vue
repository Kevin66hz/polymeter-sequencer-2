<!--
  RingsOverlay.vue — Dynamic layer of the concentric ring view.

  This component renders:
    - Playhead needles (one per track)
    - Hit flash circles (one per track)

  CRITICAL: This component updates via requestAnimationFrame, completely
  bypassing Vue's reactive system. It reads displayHeads.current and
  tracksRaw.current directly from the store's raw mirrors and uses
  setAttribute() to update SVG elements imperatively.

  This design ensures the hot loop never triggers Vue's dep tracking,
  eliminating unnecessary re-renders during playback.
-->
<template>
  <g ref="rootRef">
    <!-- Pre-placed flash circles (one per track, initially hidden) -->
    <circle
      v-for="ti in trackCount"
      :key="`flash-${ti - 1}`"
      :ref="(el) => { if (el) flashRefs[ti - 1] = el as SVGCircleElement }"
      :r="dotR(ti - 1) + 3"
      fill="transparent"
      opacity="0.35"
      visibility="hidden"
      class="pointer-events-none"
    />

    <!-- Pre-placed needles (one per track, initially hidden) -->
    <line
      v-for="ti in trackCount"
      :key="`needle-${ti - 1}`"
      :ref="(el) => { if (el) needleRefs[ti - 1] = el as SVGLineElement }"
      :x1="CX"
      :y1="CY"
      x2="0"
      y2="0"
      stroke="transparent"
      stroke-width="1"
      stroke-linecap="round"
      visibility="hidden"
      class="pointer-events-none"
    />
  </g>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { TRACK_COUNT, type Track } from '#core/types'
import { CX, CY, ringR, dotR, dotX, dotY } from './rings-geom'

const props = defineProps<{
  /** Raw mirror: { current: number[] } — read directly in RAF loop */
  displayHeads: { current: number[] }
  /** Raw mirror: { current: Track[] } — read directly in RAF loop */
  tracksRaw: { current: Track[] }
  /** ID of currently selected track (for needle styling) */
  selectedId: number
}>()

const trackCount = TRACK_COUNT
const rootRef = ref<SVGGElement | null>(null)

// Element refs for imperative updates
const flashRefs: SVGCircleElement[] = []
const needleRefs: SVGLineElement[] = []

// Track previous heads to detect changes
let prevHeads: number[] = Array(TRACK_COUNT).fill(-1)

// RAF loop state
let rafId: number | null = null
let running = false

function updateOverlay() {
  if (!running) return

  const heads = props.displayHeads.current
  const tracks = props.tracksRaw.current

  for (let ti = 0; ti < TRACK_COUNT; ti++) {
    const head = heads[ti]
    const trk = tracks[ti]
    if (!trk) continue

    const flashEl = flashRefs[ti]
    const needleEl = needleRefs[ti]
    const stepsLen = trk.steps.length
    const isSelected = props.selectedId === ti

    // Update needle
    if (needleEl) {
      if (head >= 0 && stepsLen > 0) {
        const tipX = dotX(ti, head, stepsLen)
        const tipY = dotY(ti, head, stepsLen)
        needleEl.setAttribute('x2', String(tipX))
        needleEl.setAttribute('y2', String(tipY))
        needleEl.setAttribute('stroke', trk.color)
        needleEl.setAttribute('stroke-width', isSelected ? '1.5' : '0.8')
        needleEl.setAttribute('opacity', isSelected ? '0.9' : '0.5')
        needleEl.setAttribute('visibility', 'visible')
      } else {
        needleEl.setAttribute('visibility', 'hidden')
      }
    }

    // Update flash
    if (flashEl) {
      const active = trk.steps[head]
      if (head >= 0 && active && stepsLen > 0) {
        const fx = dotX(ti, head, stepsLen)
        const fy = dotY(ti, head, stepsLen)
        flashEl.setAttribute('cx', String(fx))
        flashEl.setAttribute('cy', String(fy))
        flashEl.setAttribute('fill', trk.color)
        flashEl.setAttribute('visibility', 'visible')
      } else {
        flashEl.setAttribute('visibility', 'hidden')
      }
    }
  }

  prevHeads = heads.slice()
  rafId = requestAnimationFrame(updateOverlay)
}

function startLoop() {
  if (running) return
  running = true
  prevHeads = Array(TRACK_COUNT).fill(-1)
  rafId = requestAnimationFrame(updateOverlay)
}

function stopLoop() {
  running = false
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  // Hide all overlays when stopped
  for (let ti = 0; ti < TRACK_COUNT; ti++) {
    flashRefs[ti]?.setAttribute('visibility', 'hidden')
    needleRefs[ti]?.setAttribute('visibility', 'hidden')
  }
}

// Expose start/stop for parent to control
defineExpose({ startLoop, stopLoop })

onMounted(() => {
  // Start the loop immediately — it will show/hide based on head values
  startLoop()
})

onBeforeUnmount(() => {
  stopLoop()
})
</script>
