<script setup lang="ts">
// Per-track "▾" button — loads a single-line score into this track only.
//
// Filters the line library by the track's role (matched against track.name,
// with fuzzy fallbacks so "K2" still picks up "KICK" lines, etc.). If no
// role match is found we show *all* lines so the user isn't stuck.
//
// Small by design: fits in the GRID cell header next to the track name.

import { computed, ref, onBeforeUnmount, onMounted } from 'vue'
import type { PresetIndex, PresetLineMeta } from '../composables/usePatternPresets'

const props = defineProps<{
  index: PresetIndex | null
  loading: boolean
  trackName: string
  trackColor: string
  lastAppliedLineId: string | null
}>()

const emit = defineEmits<{
  (e: 'apply-line', line: PresetLineMeta): void
  (e: 'open'): void
}>()

// ── Role resolution ─────────────────────────────────────────────────────
// Track name is like "KICK", "SNARE", "HAT", "CLAP", "BASS", "LEAD", "PAD",
// "PERC", then duplicates "K2", "S2", "HH2", "CL2", "B2", "LD2", "PD2",
// "PC2". Map all of them to the primary role keys in the line library.

const ROLE_MAP: Record<string, string> = {
  KICK: 'KICK', K2: 'KICK',
  SNARE: 'SNARE', S2: 'SNARE',
  HAT: 'HAT', HH2: 'HAT',
  CLAP: 'CLAP', CL2: 'CLAP',
  BASS: 'BASS', B2: 'BASS',
  LEAD: 'LEAD', LD2: 'LEAD',
  PAD: 'PAD', PD2: 'PAD',
  PERC: 'PERC', PC2: 'PERC',
}
const resolvedRole = computed(() => ROLE_MAP[props.trackName.toUpperCase()] ?? null)

const lines = computed<PresetLineMeta[]>(() => {
  if (!props.index) return []
  const role = resolvedRole.value
  const all = props.index.lines
  const matched = role ? all.filter((l: PresetLineMeta) => l.role === role) : []
  return matched.length > 0 ? matched : all
})

// Group by genre for readability.
const byGenre = computed<Record<string, PresetLineMeta[]>>(() => {
  const out: Record<string, PresetLineMeta[]> = {}
  for (const l of lines.value) {
    if (!out[l.genre]) out[l.genre] = []
    out[l.genre].push(l)
  }
  return out
})

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function toggle() {
  if (!open.value) emit('open')
  open.value = !open.value
}
function onLineClick(l: PresetLineMeta) {
  emit('apply-line', l)
  open.value = false
}
function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const el = root.value
  if (el && !el.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="root" class="relative inline-block">
    <!-- small ▾ trigger — quiet in the GRID cell header -->
    <button
      class="w-[14px] h-[14px] flex items-center justify-center rounded-sm border text-[9px] leading-none"
      :class="open
        ? 'bg-[#2a2a2a] text-[#ddd] border-[#555]'
        : 'bg-transparent text-[#555] border-[#2a2a2a] hover:text-[#ccc]'"
      :title="`Load ${resolvedRole ?? ''} pattern`"
      @click.stop="toggle">▾</button>

    <!-- Popup -->
    <div
      v-if="open"
      class="absolute top-full left-0 mt-1 z-[30] bg-[#0c0c0c] border border-[#333] rounded-sm shadow-2xl text-[10px] py-1"
      style="min-width: 200px; max-height: 320px; overflow-y: auto;"
      @click.stop>

      <div class="px-3 py-1 text-[9px] tracking-[2px] flex items-center justify-between"
        :style="{ color: trackColor + 'dd' }">
        <span>{{ resolvedRole ?? 'ALL' }} PATTERNS</span>
        <span v-if="lines.length" class="text-[#444]">{{ lines.length }}</span>
      </div>

      <div v-if="loading" class="px-3 py-2 text-[#555] italic">loading…</div>
      <div v-else-if="!index" class="px-3 py-2 text-[#a55] italic">no library</div>
      <div v-else-if="lines.length === 0" class="px-3 py-2 text-[#555] italic">— none —</div>

      <template v-else>
        <template v-for="g in Object.keys(byGenre)" :key="g">
          <div class="px-3 pt-2 pb-0.5 text-[8px] tracking-[2px] text-[#555] uppercase">{{ g }}</div>
          <button v-for="l in byGenre[g]" :key="l.id"
            class="w-full text-left px-3 py-1 tracking-[0.5px] flex items-center justify-between gap-2"
            :class="lastAppliedLineId === l.id
              ? 'bg-[#162218] text-[#8fd08f]'
              : 'text-[#aaa] hover:bg-[#151515] hover:text-[#ddd]'"
            @click="onLineClick(l)">
            <span class="truncate">{{ l.name }}</span>
          </button>
        </template>
      </template>
    </div>
  </div>
</template>
