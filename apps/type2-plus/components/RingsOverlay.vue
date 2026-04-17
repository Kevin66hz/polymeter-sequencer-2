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
import { CX, CY, ringR, dotR, getDotCoords } from './rings-geom'

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

    // Hide both overlays if there's nothing to show (no head, or empty ring).
    // Early-out avoids the cache lookup entirely for stopped tracks.
    if (head < 0 || stepsLen <= 0) {
      needleEl?.setAttribute('visibility', 'hidden')
      flashEl?.setAttribute('visibility', 'hidden')
      continue
    }

    // One cache lookup per track per frame. Both needle tip and flash
    // position share the same (headX, headY).
    const coords = getDotCoords(ti, stepsLen)
    const headX = coords.x[head]
    const headY = coords.y[head]

    // Update needle
    if (needleEl) {
      needleEl.setAttribute('x2', String(headX))
      needleEl.setAttribute('y2', String(headY))
      needleEl.setAttribute('stroke', trk.color)
      needleEl.setAttribute('stroke-width', isSelected ? '1.5' : '0.8')
      needleEl.setAttribute('opacity', isSelected ? '0.9' : '0.5')
      needleEl.setAttribute('visibility', 'visible')
    }

    // Update flash (playhead indicator)
    if (flashEl) {
      flashEl.setAttribute('cx', String(headX))
      flashEl.setAttribute('cy', String(headY))

      if (trk.steps[head]) {
        // active step at playhead: colored halo
        flashEl.setAttribute('r', String(dotR(ti) + 3))
        flashEl.setAttribute('fill', trk.color)
        flashEl.setAttribute('stroke', 'none')
        flashEl.setAttribute('opacity', '0.35')
      } else {
        // inactive step at playhead: dim gray dot + colored ring
        // (restores original ConcentricView behavior)
        flashEl.setAttribute('r', String(dotR(ti)))
        flashEl.setAttribute('fill', '#3a3d50')
        flashEl.setAttribute('stroke', trk.color)
        flashEl.setAttribute('stroke-width', '1')
        flashEl.setAttribute('opacity', trk.mute ? '0.25' : '1')
      }
      flashEl.setAttribute('visibility', 'visible')
    }
  }

  rafId = requestAnimationFrame(updateOverlay)
}

function startLoop() {
  if (running) return
  running = true
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
