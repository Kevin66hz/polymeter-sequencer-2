<script setup lang="ts">
// Top-bar "PRESET ▾" dropdown — applies a full 16-track kit preset.
//
// Two-level menu:
//   [PRESET ▾]
//     └ Genre 1    └ Kit 1
//       Genre 2     Kit 2 (92 BPM)
//       ...
//
// Hovering a genre reveals its kits in a secondary popup. Click to apply.
// The host page passes the composable's reactive state; this component is
// stateless beyond the "open" / "expandedGenre" local flags.

import { computed, ref, onBeforeUnmount, onMounted } from 'vue'
import type { PresetIndex, PresetKitMeta } from '../composables/usePatternPresets'

const props = defineProps<{
  index: PresetIndex | null
  loading: boolean
  lastAppliedKitId: string | null
  // Display the loaded kit's name on the button when present. Truncated
  // in JS to a fixed char budget so the button never grows enough to push
  // the top-bar row into a wrap. Full name still shown in `title`.
  lastAppliedKitName?: string | null
}>()

// Head-truncate to keep the top-bar row stable. 10 glyphs + `…` keeps
// "Boom Bap Classic" → "Boom Bap C…" and "House 4/4" fits whole.
const MAX_LABEL_CHARS = 10
const displayLabel = computed(() => {
  const n = props.lastAppliedKitName
  if (!n) return 'PRESET'
  return n.length > MAX_LABEL_CHARS ? n.slice(0, MAX_LABEL_CHARS) + '…' : n
})

const emit = defineEmits<{
  (e: 'apply-kit', kit: PresetKitMeta): void
  (e: 'open'): void
}>()

const open = ref(false)
const expandedGenre = ref<string | null>(null)
const root = ref<HTMLElement | null>(null)

const byGenre = computed<Record<string, PresetKitMeta[]>>(() => {
  const out: Record<string, PresetKitMeta[]> = {}
  if (!props.index) return out
  for (const g of props.index.genres) out[g] = []
  for (const k of props.index.kits) {
    if (!out[k.genre]) out[k.genre] = []
    out[k.genre].push(k)
  }
  return out
})

function toggle() {
  if (!open.value) emit('open')
  open.value = !open.value
  if (!open.value) expandedGenre.value = null
}
function onKitClick(k: PresetKitMeta) {
  emit('apply-kit', k)
  open.value = false
  expandedGenre.value = null
}
function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const el = root.value
  if (el && !el.contains(e.target as Node)) {
    open.value = false; expandedGenre.value = null
  }
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="root" class="relative z-[20] flex-shrink-0">
    <button
      class="text-[9px] border px-2 py-1 rounded-sm tracking-[1px] flex items-center gap-1 whitespace-nowrap"
      :class="open
        ? 'text-[#ddd] border-[#555] bg-[#1e1e1e]'
        : lastAppliedKitName
          ? 'text-[#8fd08f] border-[#336633] bg-[#0e1810] hover:text-[#bfefbf]'
          : 'text-[#888] border-[#222] bg-transparent hover:text-[#ccc]'"
      :title="lastAppliedKitName ?? 'Select a preset kit'"
      @click.stop="toggle">
      <span>{{ displayLabel }}</span>
      <span class="text-[#555] shrink-0">▾</span>
    </button>

    <!-- dropdown -->
    <div
      v-if="open"
      class="absolute top-full left-0 mt-1 bg-[#0c0c0c] border border-[#333] rounded-sm shadow-2xl flex text-[10px]"
      style="min-width: 180px"
      @click.stop>

      <!-- Genre column -->
      <div class="flex flex-col py-1 border-r border-[#1e1e1e]" style="min-width: 160px">
        <div class="px-3 py-1 text-[9px] tracking-[2px] text-[#555]">GENRE</div>
        <button v-for="g in (index?.genres ?? [])" :key="g"
          class="text-left px-3 py-1.5 tracking-[1px] flex items-center justify-between gap-3"
          :class="expandedGenre === g
            ? 'bg-[#1a1a1a] text-[#ddd]'
            : 'text-[#999] hover:bg-[#151515] hover:text-[#ddd]'"
          @mouseenter="expandedGenre = g"
          @click="expandedGenre = g">
          <span>{{ g }}</span>
          <span class="text-[#444]">▸</span>
        </button>

        <div v-if="loading" class="px-3 py-2 text-[#555] italic">loading…</div>
        <div v-else-if="!index" class="px-3 py-2 text-[#a55] italic">no presets</div>
      </div>

      <!-- Kit column -->
      <div v-if="expandedGenre" class="flex flex-col py-1" style="min-width: 220px">
        <div class="px-3 py-1 text-[9px] tracking-[2px] text-[#555]">KITS — {{ expandedGenre }}</div>
        <button v-for="k in (byGenre[expandedGenre] ?? [])" :key="k.id"
          class="text-left px-3 py-1.5 flex items-center justify-between gap-3 tracking-[1px]"
          :class="lastAppliedKitId === k.id
            ? 'bg-[#162218] text-[#8fd08f]'
            : 'text-[#999] hover:bg-[#151515] hover:text-[#ddd]'"
          @click="onKitClick(k)">
          <span class="truncate">{{ k.name }}</span>
          <span v-if="k.bpm" class="text-[#555] text-[9px] tabular-nums shrink-0">{{ k.bpm }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
