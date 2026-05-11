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

// Hit-flash state. Each track remembers the integer step index it last
// landed on (`lastIntStep`) — used to detect step-boundary crossings —
// plus the position and timestamp of the most recent ACTIVE-step hit
// (`hitStep`, `hitTime`). The flash element is positioned at that
// remembered hit step and fades out over FLASH_FADE_MS so the bright
// "blip" lingers briefly even after the playhead has moved on.
const FLASH_FADE_MS = 480
const lastIntStep: number[] = new Array(TRACK_COUNT).fill(-1)
const hitStep: number[] = new Array(TRACK_COUNT).fill(-1)
const hitTime: number[] = new Array(TRACK_COUNT).fill(0)

function updateOverlay() {
  if (!running) return

  const heads = props.displayHeads.current
  const tracks = props.tracksRaw.current
  const now = performance.now()

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
      lastIntStep[ti] = -1
      hitStep[ti] = -1
      continue
    }

    // Defensive: during a time-sig transition, the scheduler's head index
    // and tracksRaw.current[ti].steps.length are not updated atomically.
    // `head` may briefly outlive a shrinking pattern (e.g. head=12 while
    // steps just dropped to length 8). Wrap via modulo to stay in bounds.
    const safeHead = head >= stepsLen ? head % stepsLen : head
    const intStep = Math.floor(safeHead)

    // Detect a step-boundary crossing onto an ACTIVE step → fire flash.
    // We remember the step index and timestamp; the flash element keeps
    // showing/fading from that position even as the head moves on.
    if (intStep !== lastIntStep[ti]) {
      lastIntStep[ti] = intStep
      if (trk.steps[intStep] && !trk.mute) {
        hitStep[ti] = intStep
        hitTime[ti] = now
      }
    }

    const coords = getDotCoords(ti, stepsLen)
    const headX = coords.x[intStep]
    const headY = coords.y[intStep]

    // Update needle (always tracks current head position).
    // Phosphor-green colour matches the rest of the radar scope.
    if (needleEl) {
      needleEl.setAttribute('x2', String(headX))
      needleEl.setAttribute('y2', String(headY))
      needleEl.setAttribute('stroke', isSelected ? 'rgba(190, 255, 210, 0.95)' : 'rgba(150, 230, 165, 0.55)')
      needleEl.setAttribute('stroke-width', isSelected ? '1.4' : '0.8')
      needleEl.setAttribute('opacity', '1')
      needleEl.setAttribute('visibility', 'visible')
    }

    // Update flash — sticks at the last hit ACTIVE step, fades out.
    // Bright phosphor "contact return" appearance.
    if (flashEl) {
      const hs = hitStep[ti]
      if (hs < 0 || hs >= stepsLen) {
        flashEl.setAttribute('visibility', 'hidden')
      } else {
        const elapsed = now - hitTime[ti]
        const t = elapsed / FLASH_FADE_MS
        if (t >= 1) {
          flashEl.setAttribute('visibility', 'hidden')
        } else {
          // Ease-out fade: snap-bright then trail off.
          const opacity = Math.max(0, 1 - t)
          flashEl.setAttribute('cx', String(coords.x[hs]))
          flashEl.setAttribute('cy', String(coords.y[hs]))
          // Half the previous "+3" halo radius — a tighter, sharper blip.
          flashEl.setAttribute('r', String((dotR(ti) + 3) * 0.5))
          flashEl.setAttribute('fill', 'rgba(180, 255, 200, 1)')
          flashEl.setAttribute('stroke', 'none')
          flashEl.setAttribute('opacity', String(opacity))
          flashEl.setAttribute('visibility', 'visible')
        }
      }
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
  // Hide all overlays and clear hit state when stopped
  for (let ti = 0; ti < TRACK_COUNT; ti++) {
    flashRefs[ti]?.setAttribute('visibility', 'hidden')
    needleRefs[ti]?.setAttribute('visibility', 'hidden')
    lastIntStep[ti] = -1
    hitStep[ti] = -1
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
