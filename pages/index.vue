<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  applyPending,
  createScheduler,
  stepCount,
  type Pending,
  type Track,
} from '~/composables/useScheduler'

const SIGS = ['4/4', '7/8', '9/8', '5/4', '3/4', '11/8', '6/8', '13/8']
const SUBS = [8, 8, 8, 8, 8, 8, 8, 8]
const NAMES = ['KICK', 'SNARE', 'HAT', 'CLAP', 'BASS', 'LEAD', 'PAD', 'PERC']
const COLS = ['#e05050', '#e09030', '#40b0d0', '#c060c0', '#50c080', '#6080e0', '#e06080', '#80c040']
const SIG_OPTIONS = ['4/4', '3/4', '5/4', '7/8', '9/8', '11/8', '13/8']
const GLOBAL_OPTIONS = ['─', ...SIG_OPTIONS]

const INIT: boolean[][] = [
  [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
  [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false],
  [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false],
  [false, false, false, false, false, false, false, true, false, false, false, false, false, false, false, false],
  [], [], [], [],
]

function mkTrk(id: number): Track {
  const [n, d] = SIGS[id].split('/').map(Number)
  const s = SUBS[id]
  const cnt = stepCount(n, d, s)
  return {
    id,
    name: NAMES[id],
    timeSig: SIGS[id],
    subdiv: s,
    color: COLS[id],
    steps: Array(cnt).fill(false).map((_, i) => !!INIT[id]?.[i]),
    mute: false,
    solo: false,
  }
}

// ── Reactive state ─────────────────────────────────────
const bpm = ref(120)
const playing = ref(false)
const tracks = ref<Track[]>(Array.from({ length: 8 }, (_, i) => mkTrk(i)))
const heads = ref<number[]>(Array(8).fill(-1))
const pendUI = ref<(Pending | null)[]>(Array(8).fill(null))
const globalSig = ref('─')

// ── Raw (non-reactive) mirrors for the scheduler ────────
const bpmRaw = { current: bpm.value }
const tracksRaw = { current: tracks.value.map((t) => ({ ...t, steps: [...t.steps] })) }
const pendingRaw = { current: Array(8).fill(null) as (Pending | null)[] }
const displayHeads = { current: Array(8).fill(-1) as number[] }

// applyFnRef: refreshed on every setup run & every reactive change so
// scheduler always sees the latest closure.
const applyFnRef: { current: ((id: number, p: Pending) => void) | null } = { current: null }
applyFnRef.current = (id, p) => {
  tracks.value = tracks.value.map((t) => (t.id !== id ? t : applyPending(t, p)))
  pendUI.value = pendUI.value.map((x, i) => (i === id ? null : x))
}

// Sync reactive → raw mirrors for the scheduler.
watch(bpm, (v) => { bpmRaw.current = v })
watch(
  tracks,
  (v) => { tracksRaw.current = v.map((t) => ({ ...t, steps: [...t.steps] })) },
  { deep: true },
)
watch(
  pendUI,
  (v) => { pendingRaw.current = v.map((p) => (p ? { ...p } : null)) },
  { deep: true },
)

// ── Scheduler ──────────────────────────────────────────
let scheduler: ReturnType<typeof createScheduler> | null = null

onMounted(() => {
  scheduler = createScheduler({
    bpmRaw,
    tracksRaw,
    pendingRaw,
    displayHeads,
    applyFnRef,
    onHeadsTick: (h) => { heads.value = h },
  })
})

onBeforeUnmount(() => {
  scheduler?.dispose()
})

function play() {
  if (playing.value) return
  playing.value = true
  scheduler?.play()
}
function stop() {
  playing.value = false
  scheduler?.stop()
}

// ── UI handlers ────────────────────────────────────────
function chSig(id: number, sig: string) {
  if (!playing.value) {
    tracks.value = tracks.value.map((t) => (t.id !== id ? t : applyPending(t, { timeSig: sig })))
  } else {
    const cur = pendUI.value[id] || {}
    const next: Pending = { ...cur, timeSig: sig }
    pendUI.value = pendUI.value.map((x, i) => (i === id ? next : x))
  }
}
function chSub(id: number, subRaw: string) {
  const sub = Number(subRaw)
  if (!playing.value) {
    tracks.value = tracks.value.map((t) => (t.id !== id ? t : applyPending(t, { subdiv: sub })))
  } else {
    const cur = pendUI.value[id] || {}
    const next: Pending = { ...cur, subdiv: sub }
    pendUI.value = pendUI.value.map((x, i) => (i === id ? next : x))
  }
}
function chGlobal(sig: string) {
  globalSig.value = sig
  if (sig === '─') return
  if (!playing.value) {
    tracks.value = tracks.value.map((t) => applyPending(t, { timeSig: sig }))
  } else {
    pendUI.value = pendUI.value.map((p) => ({ ...(p || {}), timeSig: sig }))
  }
}
function tog(id: number, si: number) {
  tracks.value = tracks.value.map((t) =>
    t.id !== id ? t : { ...t, steps: t.steps.map((s, i) => (i === si ? !s : s)) },
  )
}
function doMute(id: number) {
  tracks.value = tracks.value.map((t) => (t.id === id ? { ...t, mute: !t.mute } : t))
}
function doSolo(id: number) {
  tracks.value = tracks.value.map((t) => (t.id === id ? { ...t, solo: !t.solo } : t))
}
function doClr(id: number) {
  tracks.value = tracks.value.map((t) =>
    t.id !== id ? t : { ...t, steps: Array(t.steps.length).fill(false) },
  )
}
</script>

<template>
  <div class="min-h-screen bg-[#0a0a0a] text-[#ccc] font-mono p-4">
    <!-- Global controls -->
    <div class="flex items-center gap-3 mb-4 flex-wrap">
      <span class="text-[11px] tracking-[3px] text-[#333]">POLYMETER</span>

      <button
        class="border-0 px-[18px] py-[6px] text-[11px] cursor-pointer font-mono tracking-[2px]"
        :class="playing ? 'bg-[#c03030] text-[#ffaaaa]' : 'bg-[#206020] text-[#aaffaa]'"
        @click="playing ? stop() : play()"
      >
        {{ playing ? '■ STOP' : '▶ PLAY' }}
      </button>

      <div class="flex items-center gap-1.5">
        <span class="text-[10px] text-[#444]">BPM</span>
        <input
          type="range"
          min="40"
          max="240"
          :value="bpm"
          class="w-[100px]"
          @input="(e) => (bpm = Number((e.target as HTMLInputElement).value))"
        />
        <span class="text-[11px] min-w-[32px]">{{ bpm }}</span>
      </div>

      <div class="flex items-center gap-1.5">
        <span class="text-[10px] text-[#444]">ALL</span>
        <select
          :value="globalSig"
          class="bg-[#111] text-[#888] border border-[#222] text-[10px] p-0.5"
          @change="(e) => chGlobal((e.target as HTMLSelectElement).value)"
        >
          <option v-for="s in GLOBAL_OPTIONS" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>
    </div>

    <!-- Tracks -->
    <div
      v-for="(trk, i) in tracks"
      :key="trk.id"
      class="mb-2.5 bg-[#0e0e0e] p-2 border"
      :style="{
        borderColor: pendUI[i] ? trk.color + '44' : '#161616',
        opacity: trk.mute ? 0.35 : 1,
      }"
    >
      <div class="flex items-center gap-2 mb-1.5 flex-wrap">
        <span
          class="text-[11px] min-w-[44px] tracking-[1px] font-semibold"
          :style="{ color: trk.color }"
        >{{ trk.name }}</span>

        <!-- 拍子 -->
        <div class="relative">
          <select
            :value="pendUI[i]?.timeSig ?? trk.timeSig"
            class="bg-[#111] text-[12px] py-[3px] px-[8px] border rounded-sm"
            :style="{
              color: pendUI[i]?.timeSig ? '#ff9944' : '#aaa',
              borderColor: pendUI[i]?.timeSig ? '#ff6600aa' : '#2a2a2a',
            }"
            @change="(e) => chSig(trk.id, (e.target as HTMLSelectElement).value)"
          >
            <option v-for="s in SIG_OPTIONS" :key="s" :value="s">{{ s }}</option>
          </select>
          <span
            v-if="pendUI[i]?.timeSig"
            class="absolute -top-[4px] -right-[4px] w-[7px] h-[7px] rounded-full bg-[#ff6600] pointer-events-none"
          />
        </div>

        <!-- サブディビジョン -->
        <div class="relative">
          <select
            :value="pendUI[i]?.subdiv ?? trk.subdiv"
            class="bg-[#111] text-[12px] py-[3px] px-[8px] border rounded-sm"
            :style="{
              color: pendUI[i]?.subdiv ? '#ff9944' : '#aaa',
              borderColor: pendUI[i]?.subdiv ? '#ff6600aa' : '#2a2a2a',
            }"
            @change="(e) => chSub(trk.id, (e.target as HTMLSelectElement).value)"
          >
            <option value="8">♪</option>
            <option value="16">♬</option>
          </select>
          <span
            v-if="pendUI[i]?.subdiv"
            class="absolute -top-[4px] -right-[4px] w-[7px] h-[7px] rounded-full bg-[#ff6600] pointer-events-none"
          />
        </div>

        <!-- M / S / ✕ -->
        <div class="flex gap-[3px]">
          <button
            class="py-[3px] px-[9px] text-[11px] cursor-pointer font-mono border rounded-sm"
            :style="{
              background: trk.mute ? '#88888833' : 'transparent',
              color: trk.mute ? '#ddd' : '#666',
              borderColor: trk.mute ? '#888888aa' : '#2a2a2a',
            }"
            @click="doMute(trk.id)"
          >M</button>
          <button
            class="py-[3px] px-[9px] text-[11px] cursor-pointer font-mono border rounded-sm"
            :style="{
              background: trk.solo ? '#cc990033' : 'transparent',
              color: trk.solo ? '#ffcc55' : '#666',
              borderColor: trk.solo ? '#cc9900aa' : '#2a2a2a',
            }"
            @click="doSolo(trk.id)"
          >S</button>
          <button
            class="py-[3px] px-[9px] text-[11px] cursor-pointer font-mono border rounded-sm bg-transparent text-[#666] border-[#2a2a2a] hover:text-[#ccc]"
            @click="doClr(trk.id)"
          >✕</button>
        </div>

        <span class="text-[9px] text-[#444]">{{ trk.steps.length }}st</span>
        <span
          v-if="pendUI[i] && playing"
          class="text-[9px] text-[#ff6600] opacity-80"
        >⟳{{ pendUI[i]?.timeSig ?? '' }}</span>

        <span class="ml-auto text-[10px] text-[#444] tabular-nums">
          {{ playing && heads[i] >= 0 ? String(heads[i] + 1).padStart(2, '0') : '' }}
        </span>
      </div>

      <!-- 16列グリッド（16超えたら折り返し） -->
      <div class="grid grid-cols-16 gap-1" :style="{ gridTemplateColumns: 'repeat(16, minmax(0, 1fr))' }">
        <div
          v-for="(on, si) in trk.steps"
          :key="si"
          class="aspect-square rounded-full cursor-pointer min-w-0"
          :style="{
            // Fill reflects ONLY on/off — playhead never repaints the fill,
            // so active vs. inactive stays legible as the head passes.
            background: on ? trk.color : '#181818',
            // Outline: playhead = thick bright ring; otherwise track-color
            // tint for on, dim grey for off.
            border: si === heads[i] && playing
              ? '2px solid #ffffff'
              : `1.5px solid ${on ? trk.color + '88' : '#252525'}`,
            boxShadow: si === heads[i] && playing
              ? `0 0 8px ${on ? trk.color + 'cc' : '#ffffff66'}`
              : (on ? `0 0 4px ${trk.color}55` : 'none'),
            transition: 'border-color .04s, box-shadow .04s',
          }"
          @click="tog(trk.id, si)"
        />
      </div>
    </div>

    <div class="mt-2 text-[6px] text-[#1a1a1a] tracking-[3px] text-center">
      POLYMETER · TIME SIG CHANGES AT END OF LOOP
    </div>
  </div>
</template>
