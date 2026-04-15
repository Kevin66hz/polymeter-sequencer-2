<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  applyPending,
  createScheduler,
  deriveStepsFromSource,
  generateBridge,
  stepCount,
  type Pending,
  type Track,
} from '~/composables/useScheduler'
import { useMidi } from '~/composables/useMidi'
import { useMidiIn, MAPPABLE_CONTROLS } from '~/composables/useMidiIn'
import MeterKnob from '~/components/MeterKnob.vue'

// ── Meter vocabulary ───────────────────────────────────
// User-facing knobs stick to musically common values. The bridge generator
// is free to emit exotic denominators (e.g. 5/6) — those just ride the same
// 16th-note grid via rounding in useScheduler.
// 0 is included as a "drop" marker — picking 0/d produces a silent bar.
// Useful as a reservable break in transition queues. stepsSource is preserved
// under the hood so returning to a non-zero numerator restores the groove.
const NUM_OPTS = Array.from({ length: 17 }, (_, i) => i) // 0..16
const DEN_OPTS = [4, 8, 16] as const

const INIT_SIGS = ['4/4', '7/8', '9/8', '5/4', '3/4', '11/8', '6/8', '13/8']
const NAMES = ['KICK', 'SNARE', 'HAT', 'CLAP', 'BASS', 'LEAD', 'PAD', 'PERC']
const COLS = ['#e05050', '#e09030', '#40b0d0', '#c060c0', '#50c080', '#6080e0', '#e06080', '#80c040']

const INIT: boolean[][] = [
  [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
  [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false],
  [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false],
  [false, false, false, false, false, false, false, true, false, false, false, false, false, false, false, false],
  [], [], [], [],
]

// Defaults: one channel per track (1..8), middle C (60) for every track.
const MIDI_CH: number[] = [1, 2, 3, 4, 5, 6, 7, 8]
const MIDI_NOTE: number[] = [60, 60, 60, 60, 60, 60, 60, 60]

function mkTrk(id: number): Track {
  const [n, d] = INIT_SIGS[id].split('/').map(Number)
  const cnt = stepCount(n, d)
  const steps = Array(cnt).fill(false).map((_, i) => !!INIT[id]?.[i])
  return {
    id,
    name: NAMES[id],
    timeSig: INIT_SIGS[id],
    mode: 'instant',
    color: COLS[id],
    steps,
    // Canonical pattern starts equal to the initial visible steps.
    stepsSource: steps.slice(),
    mute: false,
    solo: false,
    midiChannel: MIDI_CH[id],
    midiNote: MIDI_NOTE[id],
  }
}

// Split "n/d" string into numbers, safely. n may legitimately be 0 (drop),
// so we use NaN-checks rather than || defaults.
const parseSig = (s: string): [number, number] => {
  const [nr, dr] = s.split('/').map(Number)
  const n = Number.isFinite(nr) ? nr : 4
  const d = Number.isFinite(dr) && dr > 0 ? dr : 4
  return [n, d]
}

// ── Reactive state ─────────────────────────────────────
const bpm = ref(120)
const playing = ref(false)
const tracks = ref<Track[]>(Array.from({ length: 8 }, (_, i) => mkTrk(i)))
const heads = ref<number[]>(Array(8).fill(-1))
// Per-track PENDING QUEUE (reactive mirror of pendingRaw). Drives UI badges.
const pendQ = ref<Pending[][]>(Array.from({ length: 8 }, () => []))

// Master controls
const masterNum = ref(4)
const masterDen = ref<4 | 8 | 16>(4)
const masterMode = ref<'instant' | 'transition'>('instant')
const masterBridgeBars = ref<1 | 2>(1)
const masterTarget = ref<string | null>(null) // e.g. "7/8" while awaiting sync
const flash = ref(false)
// Snapshot of each track's steps at the moment commitMaster was called.
// On master-reset rendezvous we re-tile this snapshot into the final meter
// instead of clobbering patterns with autoPreset — the user keeps their
// groove, just re-phrased.
let masterStepsSnapshot: boolean[][] | null = null

// ── Raw (non-reactive) mirrors for the scheduler ────────
const bpmRaw = { current: bpm.value }
const tracksRaw = { current: tracks.value.map((t) => ({ ...t, steps: [...t.steps] })) }
const pendingRaw = { current: Array.from({ length: 8 }, () => [] as Pending[]) }
const displayHeads = { current: Array(8).fill(-1) as number[] }
const masterTargetRef = { current: null as string | null }

// applyFnRef: refreshed on every setup run & every reactive change so
// scheduler always sees the latest closure.
const applyFnRef: { current: ((id: number, p: Pending) => void) | null } = { current: null }
applyFnRef.current = (id, p) => {
  tracks.value = tracks.value.map((t) => (t.id !== id ? t : applyPending(t, p)))
  // Pop the first queue entry on the reactive mirror too.
  pendQ.value = pendQ.value.map((q, i) => (i === id ? q.slice(1) : q))
}

// ── Audio toggle ───────────────────────────────────────
// When false, internal Web Audio is silent; MIDI out still fires.
const audioOn = ref(true)
const audioEnabledRef = { current: audioOn.value }
watch(audioOn, (v) => { audioEnabledRef.current = v })

// ── MIDI OUT ───────────────────────────────────────────
const midi = useMidi()
const MIDI_GATE_MS = 120

const midiFireRef: { current: ((id: number) => void) | null } = { current: null }
midiFireRef.current = (id) => {
  if (!midi.selectedId.value) return
  const trk = tracksRaw.current[id]
  if (!trk) return
  const ch = trk.midiChannel
  let note = trk.midiNote
  // Apply transpose from MIDI IN
  if (midiIn.state.transpose !== 0) {
    note = Math.max(0, Math.min(127, note + midiIn.state.transpose))
  }
  midi.sendNoteOn(ch, note, 100)
  setTimeout(() => midi.sendNoteOff(ch, note), MIDI_GATE_MS)
}

// ── MIDI IN ────────────────────────────────────────────
const midiIn = useMidiIn({
  onPlay: () => { if (!playing.value) play() },
  onStop: () => { if (playing.value) stop() },
  onCCMapped: (controlId, rawValue) => {
    if (controlId === 'bpm') {
      bpm.value = Math.round(rawValue * 2 + 40)
    } else if (controlId === 'masterN') {
      masterNum.value = Math.round((rawValue / 127) * 16)
      onMasterKnobChange()
    } else if (controlId === 'masterD' && rawValue > 63) {
      const opts = [4, 8, 16] as const
      masterDen.value = opts[(opts.indexOf(masterDen.value as 4|8|16) + 1) % 3]
      onMasterKnobChange()
    } else if (controlId === 'master_apply' && rawValue > 63) {
      commitMaster()
    } else if (controlId.startsWith('track') && controlId.endsWith('_mute') && rawValue > 63) {
      const idx = parseInt(controlId.replace('track', '').replace('_mute', ''))
      if (!isNaN(idx)) doMute(idx)
    }
  },
})

// External clock sync: when syncBpm changes, update bpmRaw and display
watch(() => midiIn.state.syncBpm, (v) => {
  if (midiIn.state.syncMode === 'external' && v !== null) {
    bpmRaw.current = v
    bpm.value = v
  }
})

// Mapping panel visibility toggle
const showMapping = ref(false)

// Sync reactive → raw mirrors for the scheduler.
watch(bpm, (v) => { bpmRaw.current = v })
watch(
  tracks,
  (v) => { tracksRaw.current = v.map((t) => ({ ...t, steps: [...t.steps] })) },
  { deep: true },
)
watch(
  pendQ,
  (v) => { pendingRaw.current = v.map((q) => q.map((p) => ({ ...p }))) },
  { deep: true },
)
watch(masterTarget, (v) => { masterTargetRef.current = v })

// ── Scheduler ──────────────────────────────────────────
let scheduler: ReturnType<typeof createScheduler> | null = null

function handleMasterReset() {
  // 1) Visual flash (short — 160ms feels like a downbeat accent).
  flash.value = true
  setTimeout(() => { flash.value = false }, 160)
  // 2) MIDI panic so any held external notes are cut cleanly.
  midi.panic()
  // 3) Re-derive each track's steps from its canonical source (pre-master
  //    snapshot takes priority if present). Using source preserves any
  //    tail that had been temporarily hidden by a shorter meter.
  const snap = masterStepsSnapshot
  tracks.value = tracks.value.map((t, i) => {
    const [n, d] = parseSig(t.timeSig)
    const base = snap?.[i] ?? t.stepsSource
    const newLen = stepCount(n, d)
    const { steps, stepsSource } = deriveStepsFromSource(base, newLen, n, d)
    return { ...t, steps, stepsSource }
  })
  masterStepsSnapshot = null
  // 4) Clear the master target — the rendezvous is complete.
  masterTarget.value = null
}

onMounted(async () => {
  // Init MIDI IN (transport control, clock sync, mapping)
  await midiIn.init()

  scheduler = createScheduler({
    bpmRaw,
    tracksRaw,
    pendingRaw,
    displayHeads,
    applyFnRef,
    midiFireRef,
    audioEnabledRef,
    masterTargetRef,
    onHeadsTick: (h) => { heads.value = h },
    onMasterReset: () => handleMasterReset(),
  })
})

onBeforeUnmount(() => {
  scheduler?.dispose()
  midi.panic()
})

function play() {
  if (playing.value) return
  playing.value = true
  scheduler?.play()
}
function stop() {
  playing.value = false
  scheduler?.stop()
  midi.panic()
}

// ── Per-track meter change ─────────────────────────────
// Called when either knob (numerator / denominator) commits. Respects the
// track's own mode — instant changes swap immediately (when stopped) or at
// the next loop boundary (when playing). Transition mode generates a 1-bar
// bridge queue.
function commitTrackSig(id: number, n: number, d: number) {
  const target = `${n}/${d}`
  const trk = tracks.value[id]
  if (!trk) return
  if (trk.timeSig === target && pendQ.value[id].length === 0) return

  if (!playing.value) {
    // Stopped: apply immediately, no queue.
    tracks.value = tracks.value.map((t) => (t.id !== id ? t : applyPending(t, { timeSig: target })))
    pendQ.value = pendQ.value.map((q, i) => (i === id ? [] : q))
    return
  }

  // Playing: build a queue. Transition = 1 bridge bar then target.
  const from = trk.timeSig
  const queue = trk.mode === 'transition'
    ? generateBridge(from, target, 1)
    : [{ timeSig: target }]
  pendQ.value = pendQ.value.map((q, i) => (i === id ? queue : q))
}

function setTrackNum(id: number, n: number) {
  const [, d] = parseSig(tracks.value[id].timeSig)
  commitTrackSig(id, n, d)
}
function setTrackDen(id: number, d: number) {
  const [n] = parseSig(tracks.value[id].timeSig)
  commitTrackSig(id, n, d)
}

function toggleTrackMode(id: number) {
  tracks.value = tracks.value.map((t) =>
    t.id !== id
      ? t
      : { ...t, mode: t.mode === 'instant' ? 'transition' : 'instant' },
  )
}

// ── Master meter change ────────────────────────────────
// Applies to ALL tracks simultaneously. In transition mode each track gets
// a bridge queue of `masterBridgeBars` bars, converging to the same target.
// Once every track has drained its queue and matches the target, the
// scheduler fires onMasterReset at track 0's next loop boundary.
// Knob @change handler: commit immediately when in instant mode, otherwise
// do nothing and wait for APPLY. This makes instant feel direct and keeps
// transition from firing a new bridge on every incremental knob tick.
function onMasterKnobChange() {
  if (masterMode.value === 'instant') commitMaster()
}

function commitMaster() {
  const target = `${masterNum.value}/${masterDen.value}`
  // Snapshot the CANONICAL source BEFORE any mutation so handleMasterReset
  // can re-derive the pre-master groove into the final meter without losing
  // any tail that's currently hidden by a shorter meter.
  masterStepsSnapshot = tracks.value.map((t) => [...t.stepsSource])
  if (!playing.value) {
    // Stopped: apply immediately. applyPending already preserves the
    // existing pattern via resizeSteps, so the snapshot isn't needed here.
    tracks.value = tracks.value.map((t) => applyPending(t, { timeSig: target }))
    pendQ.value = pendQ.value.map(() => [])
    masterTarget.value = null
    masterStepsSnapshot = null
    return
  }
  const bars = masterMode.value === 'transition' ? masterBridgeBars.value : 0
  pendQ.value = tracks.value.map((t) =>
    bars === 0
      ? [{ timeSig: target }]
      : generateBridge(t.timeSig, target, bars),
  )
  masterTarget.value = target
}

// ── Simple reactive ops ────────────────────────────────
function tog(id: number, si: number) {
  tracks.value = tracks.value.map((t) => {
    if (t.id !== id) return t
    const newSteps = t.steps.map((s, i) => (i === si ? !s : s))
    // Mirror into canonical source at the same index. Since si < steps.length
    // and stepsSource.length >= steps.length, this is always in range.
    const newSource = t.stepsSource.slice()
    newSource[si] = newSteps[si]
    return { ...t, steps: newSteps, stepsSource: newSource }
  })
}
function doMute(id: number) {
  tracks.value = tracks.value.map((t) => (t.id === id ? { ...t, mute: !t.mute } : t))
}
function doSolo(id: number) {
  tracks.value = tracks.value.map((t) => (t.id === id ? { ...t, solo: !t.solo } : t))
}
function doClr(id: number) {
  // Clear wipes both the visible pattern AND the canonical source —
  // otherwise re-expanding would resurrect the old tail, which is
  // surprising when the user explicitly asked to clear.
  tracks.value = tracks.value.map((t) =>
    t.id !== id
      ? t
      : {
          ...t,
          steps: Array(t.steps.length).fill(false),
          stepsSource: Array(t.stepsSource.length).fill(false),
        },
  )
}
function chMidiCh(id: number, v: string) {
  const ch = Math.max(1, Math.min(16, Number(v) | 0))
  tracks.value = tracks.value.map((t) => (t.id === id ? { ...t, midiChannel: ch } : t))
}
function chMidiNote(id: number, v: string) {
  const note = Math.max(0, Math.min(127, Number(v) | 0))
  tracks.value = tracks.value.map((t) => (t.id === id ? { ...t, midiNote: note } : t))
}
function onMidiSelect(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  midi.selectOutput(v || null)
}

// ── MIDI Config (Save / Load) ──────────────────────────
const midiConfigInput = ref<HTMLInputElement | null>(null)

function downloadMidiConfig() {
  const json = midiIn.saveMappings()
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'midi-config.json'
  a.click()
  URL.revokeObjectURL(url)
}

function triggerLoadMidiConfig() {
  midiConfigInput.value?.click()
}

function onMidiConfigLoaded(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = (evt) => {
    const text = evt.target?.result as string
    midiIn.loadMappings(text)
  }
  reader.readAsText(file)
  input.value = '' // reset for next load
}

// Helpers for template readability
function trkNum(t: Track) { return parseSig(t.timeSig)[0] }
function trkDen(t: Track) { return parseSig(t.timeSig)[1] }
function pendingSig(i: number): string | null {
  const q = pendQ.value[i]
  return q.length > 0 ? q[q.length - 1].timeSig : null
}

// The tracks region fills the viewport (8 rows × flex-1), so each track
// row gets a predictable share of screen height regardless of step count.
// Inside the grid we cap each cell at ROW_MAX so the normal 1-row case
// stays compact (matches the previous 18–22px feel) and leaves breathing
// room around the cells. The grid's max-height scales with the number of
// wrapped rows, so when the grid genuinely needs more vertical space it
// takes more — but if that still exceeds the track share, grid-auto-rows'
// 1fr divides the available height evenly instead of overflowing.
const ROW_MAX = 22
function gridMaxHeightPx(len: number): number {
  return Math.max(1, Math.ceil(len / 16)) * ROW_MAX
}
</script>

<template>
  <div class="h-screen bg-[#0a0a0a] text-[#ccc] font-mono p-4 relative flex flex-col overflow-hidden">
    <!-- Flash overlay — renders only during master-reset downbeat -->
    <div
      v-if="flash"
      class="pointer-events-none fixed inset-0 z-50"
      style="background: rgba(255,255,255,0.18); mix-blend-mode: screen;"
    />

    <!-- Global transport + Master meter — MASTER controls sit on the LEFT
         so they column-align with the per-track control block below, giving
         the page a single "controls-left / content-right" visual rhythm.
         Transport bits ride to the right via ml-auto. Helper caption was
         removed — it forced the row to wrap and doubled the height. -->
    <div
      class="mb-3 p-2 border border-[#1e1e1e] bg-[#0c0c0c] flex items-center gap-3 flex-wrap"
      :style="{ borderColor: masterTarget ? '#ff660066' : '#1e1e1e' }"
    >
      <!-- ── LEFT: MASTER meter controls (aligns with per-track knobs) ── -->
      <span class="text-[10px] tracking-[2px] text-[#555] w-[40px]">MASTER</span>

      <!-- INSTANT: knob @change commits immediately (feels like a direct
           control). TRANSITION: knobs just stage — user must press APPLY
           to kick off the bridge, so sweeping through values doesn't fire
           a cascade of transitions. -->
      <MeterKnob
        v-model="masterNum"
        :options="NUM_OPTS"
        label="N"
        :size="40"
        color="#e5e5e5"
        @change="onMasterKnobChange"
      />
      <span class="text-[18px] text-[#333] -mx-1">/</span>
      <MeterKnob
        v-model="masterDen"
        :options="DEN_OPTS"
        label="D"
        :size="40"
        color="#e5e5e5"
        @change="onMasterKnobChange"
      />

      <!-- Master mode -->
      <div class="flex gap-0.5 rounded-sm overflow-hidden border border-[#222]">
        <button
          class="text-[10px] px-2 py-1 font-mono"
          :class="masterMode === 'instant' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555]'"
          @click="masterMode = 'instant'"
        >INSTANT</button>
        <button
          class="text-[10px] px-2 py-1 font-mono"
          :class="masterMode === 'transition' ? 'bg-[#2a2a2a] text-[#ff9944]' : 'bg-transparent text-[#555]'"
          @click="masterMode = 'transition'"
        >TRANSITION</button>
      </div>

      <!-- Bridge bars (only meaningful in transition mode) -->
      <div
        class="flex items-center gap-1"
        :style="{ opacity: masterMode === 'transition' ? 1 : 0.35 }"
      >
        <span class="text-[9px] text-[#555] tracking-[1px]">BRIDGE</span>
        <button
          v-for="b in ([1, 2] as const)"
          :key="b"
          class="text-[10px] px-2 py-1 font-mono border rounded-sm"
          :class="masterBridgeBars === b
            ? 'bg-[#2a2a2a] text-[#ff9944] border-[#ff660066]'
            : 'bg-transparent text-[#555] border-[#222]'"
          @click="masterBridgeBars = b"
        >{{ b }}</button>
      </div>

      <!-- APPLY: visible only in transition mode (instant commits straight
           from the knob). Also shows the converging state on rendezvous. -->
      <button
        v-if="masterMode === 'transition' || masterTarget"
        class="px-[12px] py-[5px] text-[11px] cursor-pointer font-mono tracking-[2px] border rounded-sm"
        :class="masterTarget
          ? 'bg-[#2a1a0a] text-[#ff9944] border-[#ff660066]'
          : 'bg-[#1a2230] text-[#8faacc] border-[#2a4060] hover:text-[#bcd]'"
        :disabled="!!masterTarget"
        @click="commitMaster"
      >
        {{ masterTarget ? '⟳ CONVERGING → ' + masterTarget : 'APPLY →' }}
      </button>

      <!-- ── RIGHT: Transport / audio / MIDI (pushed via ml-auto) ── -->
      <div class="ml-auto flex items-center gap-3 flex-wrap">
        <button
          class="border-0 px-[14px] py-[5px] text-[11px] cursor-pointer font-mono tracking-[2px]"
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
            class="w-[90px]"
            @input="(e) => (bpm = Number((e.target as HTMLInputElement).value))"
          />
          <span class="text-[11px] min-w-[28px]">{{ bpm }}</span>
        </div>

        <button
          class="border px-[8px] py-[3px] text-[11px] cursor-pointer font-mono tracking-[1px] rounded-sm"
          :class="audioOn
            ? 'bg-[#1a2a1a] text-[#8fd08f] border-[#2f5f2f]'
            : 'bg-[#222] text-[#666] border-[#333]'"
          :title="audioOn ? 'Internal audio ON — click to mute (MIDI out unaffected)' : 'Internal audio OFF — MIDI out only'"
          @click="audioOn = !audioOn"
        >
          {{ audioOn ? '♪ AUDIO' : '✕ AUDIO' }}
        </button>

        <div class="flex items-center gap-1.5">
          <span class="text-[10px] text-[#444]">MIDI OUT</span>
          <select
            :value="midi.selectedId.value ?? ''"
            class="bg-[#111] text-[#ccc] border border-[#222] text-[11px] py-[2px] px-[5px] min-w-[140px]"
            :disabled="!midi.supported.value"
            @change="onMidiSelect"
          >
            <option value="">
              {{ midi.supported.value ? (midi.outputs.value.length ? '— none —' : '— no device —') : 'unsupported' }}
            </option>
            <option v-for="o in midi.outputs.value" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
        </div>

        <!-- MIDI IN device select -->
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] text-[#444]">MIDI IN</span>
          <select
            v-if="midiIn.state.supported"
            :value="midiIn.state.selectedId ?? ''"
            class="bg-[#111] text-[#ccc] border border-[#222] text-[11px] py-[2px] px-[5px] min-w-[140px]"
            @change="(e) => midiIn.selectInput((e.target as HTMLSelectElement).value || null)"
          >
            <option value="">— none —</option>
            <option v-for="o in midiIn.state.inputs" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
          <span v-else class="text-[10px] text-[#666]">unsupported</span>
        </div>

        <!-- Sync: clock from external device -->
        <div v-if="midiIn.state.selectedId" class="flex items-center gap-0.5 rounded-sm overflow-hidden border border-[#222]">
          <button
            class="text-[9px] px-1.5 py-1 font-mono"
            :class="midiIn.state.syncMode === 'internal' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555]'"
            @click="midiIn.state.syncMode = 'internal'"
          >INT</button>
          <button
            class="text-[9px] px-1.5 py-1 font-mono"
            :class="midiIn.state.syncMode === 'external' ? 'bg-[#2a2a2a] text-[#8fccaa]' : 'bg-transparent text-[#555]'"
            @click="midiIn.state.syncMode = 'external'"
          >SYNC</button>
          <span
            v-if="midiIn.state.syncMode === 'external' && midiIn.state.syncBpm"
            class="text-[9px] px-1.5 text-[#8fccaa]"
          >{{ midiIn.state.syncBpm }}</span>
        </div>

        <!-- Mapping panel toggle + save/load -->
        <div v-if="midiIn.state.selectedId" class="flex items-center gap-1">
          <button
            class="text-[9px] px-2 py-1 font-mono border rounded-sm"
            :class="showMapping ? 'bg-[#2a2a2a] text-[#ddd] border-[#555]' : 'bg-transparent text-[#666] border-[#333]'"
            @click="showMapping = !showMapping"
          >MAPPING</button>
          <button
            class="text-[9px] px-2 py-1 font-mono border border-[#333] bg-transparent text-[#666] rounded-sm hover:text-[#ccc]"
            @click="downloadMidiConfig"
          >SAVE</button>
          <button
            class="text-[9px] px-2 py-1 font-mono border border-[#333] bg-transparent text-[#666] rounded-sm hover:text-[#ccc]"
            @click="triggerLoadMidiConfig"
          >LOAD</button>
          <input ref="midiConfigInput" type="file" accept=".json" style="display:none" @change="onMidiConfigLoaded" />
        </div>
      </div>
    </div>

    <!-- MIDI Mapping panel — collapsible, shown when MAPPING button active -->
    <div
      v-if="showMapping && midiIn.state.selectedId"
      class="mb-2 p-2 border border-[#1e1e1e] bg-[#0c0c0c] flex flex-wrap gap-2"
    >
      <div
        v-for="ctrl in MAPPABLE_CONTROLS"
        :key="ctrl.id"
        class="flex items-center gap-1.5 border border-[#1a1a1a] px-2 py-1 rounded-sm min-w-0"
      >
        <span class="text-[9px] text-[#555] w-[120px] truncate">{{ ctrl.label }}</span>
        <!-- Current binding display -->
        <span class="text-[9px] font-mono min-w-[70px]">
          <template v-if="midiIn.getMappingFor(ctrl.id)">
            <span class="text-[#8faacc]">
              {{ midiIn.getMappingFor(ctrl.id)!.type.toUpperCase() }}
              {{ midiIn.getMappingFor(ctrl.id)!.number }}
              <span class="text-[#444]">ch{{ midiIn.getMappingFor(ctrl.id)!.channel }}</span>
            </span>
          </template>
          <span v-else class="text-[#333]">—</span>
        </span>
        <!-- Learn button -->
        <button
          class="text-[9px] px-1.5 py-0.5 font-mono border rounded-sm"
          :class="midiIn.state.learnControlId === ctrl.id
            ? 'bg-[#ff6600] text-white border-[#ff6600] animate-pulse'
            : 'bg-transparent text-[#555] border-[#222] hover:text-[#ccc]'"
          @click="midiIn.state.learnControlId === ctrl.id
            ? midiIn.cancelLearn()
            : midiIn.startLearn(ctrl.id)"
        >{{ midiIn.state.learnControlId === ctrl.id ? '● WAIT' : 'LEARN' }}</button>
        <!-- Clear binding -->
        <button
          v-if="midiIn.getMappingFor(ctrl.id)"
          class="text-[9px] px-1 py-0.5 font-mono border border-[#222] bg-transparent text-[#555] rounded-sm hover:text-[#c66]"
          @click="midiIn.removeMapping(ctrl.id)"
        >✕</button>
      </div>
    </div>

    <!-- Tracks: fill the remaining viewport height. The 8 rows share the
         vertical space via flex-1, so each track row is ~(screenH - header)/8
         regardless of how many steps it has. Controls sit on the LEFT in
         a fixed-width column; the step grid lives on the RIGHT and stays
         visually compact inside this taller row via ROW_MAX + centered
         alignment. When the grid DOES wrap to many rows and runs out of
         room, grid-auto-rows' 1fr divides the available height evenly. -->
    <div class="flex-1 flex flex-col min-h-0 gap-1.5">
    <div
      v-for="(trk, i) in tracks"
      :key="trk.id"
      class="bg-[#0e0e0e] px-2 py-1 border flex items-center gap-3 flex-1 min-h-0"
      :style="{
        borderColor: pendQ[i].length ? trk.color + '44' : '#161616',
        opacity: trk.mute ? 0.35 : 1,
      }"
    >
      <!-- LEFT: all track controls, compact single row (flex-shrink-0 so
           the grid is the one that absorbs narrow viewports). -->
      <div class="flex items-center gap-1.5 flex-shrink-0">
        <span
          class="text-[10px] w-[40px] tracking-[1px] font-semibold"
          :style="{ color: trk.color }"
        >{{ trk.name }}</span>

        <!-- Numerator / Denominator knobs (smaller to save height) -->
        <div class="relative flex items-end gap-0">
          <MeterKnob
            :model-value="trkNum(trk)"
            :options="NUM_OPTS"
            :size="36"
            :color="trk.color"
            @change="(v) => setTrackNum(trk.id, v)"
          />
          <span class="text-[12px] text-[#333] pb-3">/</span>
          <MeterKnob
            :model-value="trkDen(trk)"
            :options="DEN_OPTS"
            :size="36"
            :color="trk.color"
            @change="(v) => setTrackDen(trk.id, v)"
          />
          <span
            v-if="pendingSig(i)"
            class="absolute -top-[1px] -right-[4px] w-[6px] h-[6px] rounded-full bg-[#ff6600] pointer-events-none"
            :title="`pending → ${pendingSig(i)}`"
          />
        </div>

        <!-- Per-track mode -->
        <button
          class="text-[9px] px-[5px] py-[2px] font-mono border rounded-sm tracking-[1px] w-[46px]"
          :class="trk.mode === 'transition'
            ? 'bg-[#2a1a0a] text-[#ff9944] border-[#ff660066]'
            : 'bg-transparent text-[#555] border-[#222]'"
          :title="trk.mode === 'transition' ? 'Transition: bridge bar before target' : 'Instant: swap at next loop boundary'"
          @click="toggleTrackMode(trk.id)"
        >{{ trk.mode === 'transition' ? '∿TRANS' : '▪INST' }}</button>

        <!-- M / S / ✕ -->
        <div class="flex gap-[2px]">
          <button
            class="py-[2px] px-[6px] text-[10px] cursor-pointer font-mono border rounded-sm"
            :style="{
              background: trk.mute ? '#88888833' : 'transparent',
              color: trk.mute ? '#ddd' : '#666',
              borderColor: trk.mute ? '#888888aa' : '#2a2a2a',
            }"
            @click="doMute(trk.id)"
          >M</button>
          <button
            class="py-[2px] px-[6px] text-[10px] cursor-pointer font-mono border rounded-sm"
            :style="{
              background: trk.solo ? '#cc990033' : 'transparent',
              color: trk.solo ? '#ffcc55' : '#666',
              borderColor: trk.solo ? '#cc9900aa' : '#2a2a2a',
            }"
            @click="doSolo(trk.id)"
          >S</button>
          <button
            class="py-[2px] px-[6px] text-[10px] cursor-pointer font-mono border rounded-sm bg-transparent text-[#666] border-[#2a2a2a] hover:text-[#ccc]"
            @click="doClr(trk.id)"
          >✕</button>
        </div>

        <!-- MIDI channel / note -->
        <div class="flex items-center gap-[3px]">
          <label class="text-[8px] text-[#555]">CH</label>
          <input
            type="number"
            min="1"
            max="16"
            :value="trk.midiChannel"
            class="bg-[#111] text-[10px] py-[1px] px-[3px] border border-[#2a2a2a] rounded-sm w-[36px] tabular-nums"
            @change="(e) => chMidiCh(trk.id, (e.target as HTMLInputElement).value)"
          />
          <label class="text-[8px] text-[#555]">N</label>
          <input
            type="number"
            min="0"
            max="127"
            :value="trk.midiNote"
            class="bg-[#111] text-[10px] py-[1px] px-[3px] border border-[#2a2a2a] rounded-sm w-[40px] tabular-nums"
            @change="(e) => chMidiNote(trk.id, (e.target as HTMLInputElement).value)"
          />
        </div>

        <span class="text-[8px] text-[#444] w-[24px] tabular-nums">{{ trk.steps.length }}st</span>
      </div>

      <!-- RIGHT: step grid with FIXED cell size so cells stay compact
           regardless of viewport width. aspect-square on StepCell means
           column width dictates cell height; fixing col width at 20px
           caps both dimensions. If a track has >16 steps the grid wraps
           to a second row of 20px cells, which is still shorter than the
           old stacked layout. -->
      <div class="flex-1 min-w-0 h-full flex items-center overflow-hidden">
        <div
          class="grid gap-[2px] w-full"
          :style="{
            gridTemplateColumns: 'repeat(16, minmax(0, 1fr))',
            gridAutoRows: 'minmax(0, 1fr)',
            maxHeight: gridMaxHeightPx(trk.steps.length) + 'px',
            height: '100%',
          }"
        >
          <StepCell
            v-for="(on, si) in trk.steps"
            :key="si"
            :on="on"
            :is-head="playing && si === heads[i]"
            :color="trk.color"
            @toggle="tog(trk.id, si)"
          />
        </div>
      </div>
    </div>
    <!-- /tracks wrapper -->
    </div>
  </div>
</template>
