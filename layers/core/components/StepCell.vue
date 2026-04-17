<script setup lang="ts">
// Memoized step dot. Because props are primitives, Vue only re-renders the
// individual cell whose props changed — not all 128+ cells every time the
// playhead moves.
const props = defineProps<{
  on: boolean
  isHead: boolean
  color: string
}>()

defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <!-- Perf: aspect-square + rounded-sm (not full circle) + no box-shadow
       keeps each step cell on the fast path. Head is shown by a bright
       2px border only; no glow. -->
  <div
    class="w-full h-full rounded-sm cursor-pointer min-w-0"
    :style="{
      background: props.on ? props.color : '#181818',
      border: props.isHead
        ? '2px solid #ffffff'
        : `1px solid ${props.on ? props.color : '#252525'}`,
    }"
    @click="$emit('toggle')"
  />
</template>
