<script setup lang="ts">
// Discrete rotary knob for meter values (numerator / denominator).
//
// Interaction model:
//   - Vertical drag (up = increase). 8px per step, tunable via DRAG_PX.
//   - Mouse wheel: up = increase.
//   - Keyboard: ArrowUp/Down when focused.
//
// State model (important — this was the bug before):
//   We keep an INTERNAL `localIdx` that drives the visual. The component
//   does NOT require v-model — consumers may bind only `@change`. During
//   interaction we update localIdx immediately so the knob moves visibly;
//   we only emit `update:modelValue` + `change` on commit (pointerup /
//   wheel settle / key). When the parent sends a new modelValue from
//   outside (e.g. master commit), we resync localIdx via watch.
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: number
  options: readonly number[]
  label?: string
  size?: number
  color?: string
}>(), {
  size: 44,
  color: '#e5e5e5',
})

const emit = defineEmits<{
  (e: 'update:modelValue', v: number): void
  (e: 'input', v: number): void
  (e: 'change', v: number): void
}>()

const initialIdx = () => {
  const i = props.options.indexOf(props.modelValue)
  return i < 0 ? 0 : i
}

const localIdx = ref(initialIdx())
// Sync inward: parent changed modelValue externally (e.g. master knob
// pushed a sig, or reset). Only update when not mid-drag to avoid fighting
// the user's gesture.
watch(() => props.modelValue, () => {
  if (!dragging) localIdx.value = initialIdx()
})
watch(() => props.options, () => {
  if (!dragging) localIdx.value = initialIdx()
})

const currentValue = computed(() => props.options[localIdx.value])

// Rotation: -135deg (min) → +135deg (max)
const rotation = computed(() => {
  const len = Math.max(1, props.options.length - 1)
  const t = localIdx.value / len
  return -135 + t * 270
})

const setIdx = (newIdx: number, commit: boolean) => {
  const clamped = Math.max(0, Math.min(props.options.length - 1, newIdx))
  if (clamped !== localIdx.value) {
    localIdx.value = clamped
    emit('input', props.options[clamped])
  }
  if (commit) {
    const v = props.options[localIdx.value]
    if (v !== props.modelValue) {
      emit('update:modelValue', v)
      emit('change', v)
    }
  }
}

// ── Pointer drag ────────────────────────────────────
const DRAG_PX = 8 // pixels per step
let dragStartY = 0
let dragStartIdx = 0
let dragging = false

const onPointerDown = (e: PointerEvent) => {
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  dragging = true
  dragStartY = e.clientY
  dragStartIdx = localIdx.value
  e.preventDefault()
}
const onPointerMove = (e: PointerEvent) => {
  if (!dragging) return
  const dy = dragStartY - e.clientY // up = positive
  const delta = Math.round(dy / DRAG_PX)
  setIdx(dragStartIdx + delta, false)
}
const onPointerUp = (e: PointerEvent) => {
  if (!dragging) return
  dragging = false
  ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  setIdx(localIdx.value, true)
}

// ── Wheel ───────────────────────────────────────────
let wheelTimer: ReturnType<typeof setTimeout> | null = null
const onWheel = (e: WheelEvent) => {
  e.preventDefault()
  const dir = e.deltaY < 0 ? 1 : -1
  setIdx(localIdx.value + dir, false)
  if (wheelTimer) clearTimeout(wheelTimer)
  wheelTimer = setTimeout(() => { setIdx(localIdx.value, true) }, 180)
}

// ── Keyboard ────────────────────────────────────────
const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
    setIdx(localIdx.value + 1, true)
    e.preventDefault()
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
    setIdx(localIdx.value - 1, true)
    e.preventDefault()
  }
}
</script>

<template>
  <div class="flex flex-col items-center select-none" :style="{ width: size + 'px' }">
    <div
      class="relative rounded-full bg-neutral-900 border border-neutral-700 cursor-ns-resize touch-none outline-none focus:border-neutral-400"
      :style="{ width: size + 'px', height: size + 'px' }"
      tabindex="0"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel.prevent="onWheel"
      @keydown="onKeyDown"
    >
      <!-- Indicator line -->
      <div
        class="absolute top-1/2 left-1/2 origin-bottom"
        :style="{
          width: '2px',
          height: (size / 2 - 4) + 'px',
          background: color,
          transform: `translate(-50%, -100%) rotate(${rotation}deg)`,
        }"
      />
      <!-- Center dot -->
      <div
        class="absolute top-1/2 left-1/2 rounded-full"
        :style="{
          width: '4px', height: '4px',
          background: color,
          transform: 'translate(-50%, -50%)',
        }"
      />
    </div>
    <div class="text-[10px] text-neutral-400 mt-1 leading-none">
      <span v-if="label" class="mr-1 opacity-70">{{ label }}</span>
      <span class="tabular-nums text-neutral-100">{{ currentValue }}</span>
    </div>
  </div>
</template>
