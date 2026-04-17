// Sequencer store — the single reactive brain shared between all UI variants.
//
// Extracted verbatim from pages/index.vue (pre-split). No behavior changes in
// this commit; this is purely a relocation. Callers (pages/index.vue for Type2,
// apps/type2-plus/pages/index.vue later) use the returned refs and methods
// directly and remain thin views.
//
// Design rule preserved from the original:
//   - The scheduler NEVER touches Vue reactivity. We keep `{ current: T }`
//     plain mirrors and sync them via `watch` on the reactive side.
//   - MIDI fire / applyPending callbacks are closures that read the mirrors,
//     so the hot loop never walks reactive deps.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { stepCount, parseSig, deriveStepsFromSource } from '#core/pure/meter'
import { applyPending } from '#core/pure/pending'
import { generateBridge } from '#core/pure/bridge'
import { createScheduler } from '#core/scheduler/create-scheduler'
import { TRACK_COUNT, type Pending, type Track } from '#core/types'
import { useMidi } from './useMidi'
import { useMidiIn } from './useMidiIn'

// ── Factory defaults (Type2 lineage) ──────────────────────────────────
// These defaults carry the Type2 initial state. Plus reuses them as-is;
// future UI variants may pass custom seeds via `useSequencerStore({ seed })`
// once that overload is added.

export const NUM_OPTS = Array.from({ length: 17 }, (_, i) => i)
export const DEN_OPTS = [4, 8, 16] as const

const INIT_SIGS = [
  '4/4','7/8','9/8','5/4','3/4','11/8','6/8','13/8',
  '4/4','5/8','7/4','3/8','4/4','7/8','5/4','6/4',
]
const NAMES = [
  'KICK','SNARE','HAT','CLAP','BASS','LEAD','PAD','PERC',
  'K2','S2','HH2','CL2','B2','LD2','PD2','PC2',
]
const COLS = [
  '#e05050','#e09030','#40b0d0','#c060c0',
  '#50c080','#6080e0','#e06080','#80c040',
  '#e07060','#60d0b0','#b060e0','#d0a040',
  '#40c0c0','#e04080','#90e060','#8060d0',
]
const INIT: boolean[][] = [
  [true,false,false,false,true,false,false,false,true,false,false,false,true,false,false,false],
  [false,false,false,false,true,false,false,false,false,false,false,false,true,false,false,false],
  [true,false,true,false,true,false,true,false,true,false,true,false,true,false,true,false],
  [false,false,false,false,false,false,false,true,false,false,false,false,false,false,false,false],
  [true,false,false,true,false,false,true,false,false,false,false,false,false,false,false,false],
  [true,false,false,false,false,false,true,false,false,false,false,false,false,false,false,false],
  [true,false,false,false,true,false,false,false,false,false,false,false,false,false,false,false],
  [false,false,true,false,false,false,false,true,false,false,true,false,false,false,false,false],
  [true,false,false,false,false,false,true,false,true,false,false,false,false,false,false,false],
  [false,false,false,true,false,false,false,false,false,false,false,false,false,false,false,false],
  [true,false,false,true,false,false,true,false,false,true,false,false,true,false,false,false],
  [false,false,true,false,false,false,false,false,false,false,false,false,false,false,false,false],
  [true,false,true,false,false,true,false,false,true,false,false,false,true,false,false,false],
  [false,false,false,true,false,false,false,false,false,false,false,false,false,false,false,false],
  [true,false,false,false,false,false,false,false,true,false,false,false,false,false,false,false],
  [false,true,false,false,false,true,false,false,false,false,true,false,false,false,false,false],
]

function mkTrk(id: number): Track {
  const sig = INIT_SIGS[id] ?? '4/4'
  const [n, d] = sig.split('/').map(Number)
  const cnt = stepCount(n, d)
  const pat = INIT[id] ?? INIT[id % 4] ?? []
  const steps = Array(cnt).fill(false).map((_, i) => !!pat[i])
  return {
    id, name: NAMES[id] ?? `CH${id+1}`, timeSig: sig,
    mode: 'instant', color: COLS[id] ?? '#888',
    steps, stepsSource: steps.slice(),
    mute: false, solo: false,
    midiChannel: (id % 16) + 1, midiNote: 60,
    midiVelocity: 100, gateMs: 80,
  }
}

// ── Snapshot type (user-saved full pattern + meter per track) ─────────
export type TrackSnapshot = { steps: boolean[]; stepsSource: boolean[]; timeSig: string }

// ──────────────────────────────────────────────────────────────────────
// useSequencerStore — call once per page. Owns all sequencer state and
// the scheduler lifecycle tied to the calling component.
// ──────────────────────────────────────────────────────────────────────

export function useSequencerStore() {
  // ── Reactive state ──────────────────────────────────────────────────
  const bpm = ref(120)
  const playing = ref(false)
  const tracks = ref<Track[]>(Array.from({ length: TRACK_COUNT }, (_, i) => mkTrk(i)))
  const heads = ref<number[]>(Array(TRACK_COUNT).fill(-1))
  const pendQ = ref<Pending[][]>(Array.from({ length: TRACK_COUNT }, () => []))
  const selectedId = ref<number>(-1)
  const detailId = ref<number | null>(null)
  const audioOn = ref(true)

  const masterNum = ref(4)
  const masterDen = ref<4 | 8 | 16>(4)
  const masterMode = ref<'instant' | 'transition'>('instant')
  const masterBridgeBars = ref<1 | 2>(1)
  const masterTarget = ref<string | null>(null)
  const flash = ref(false)

  const savedSnapshot = ref<TrackSnapshot[] | null>(null)
  const showMapping = ref(false)

  // Closure-local (not reactive): pattern snapshot used by master reset.
  let masterStepsSnapshot: boolean[][] | null = null

  // ── Raw mirrors (scheduler reads these, never the refs directly) ────
  const bpmRaw = { current: bpm.value }
  const tracksRaw = { current: tracks.value.map(t => ({ ...t, steps: [...t.steps] })) }
  const pendingRaw = { current: Array.from({ length: TRACK_COUNT }, () => [] as Pending[]) }
  const displayHeads = { current: Array(TRACK_COUNT).fill(-1) as number[] }
  const masterTargetRef = { current: null as string | null }
  const audioEnabledRef = { current: true }

  const applyFnRef: { current: ((id: number, p: Pending) => void) | null } = { current: null }
  applyFnRef.current = (id, p) => {
    tracks.value = tracks.value.map(t => t.id !== id ? t : applyPending(t, p))
    pendQ.value = pendQ.value.map((q, i) => i === id ? q.slice(1) : q)
  }

  // ── MIDI (out) ──────────────────────────────────────────────────────
  const midi = useMidi()
  const midiFireRef: { current: ((id: number) => void) | null } = { current: null }
  midiFireRef.current = (id) => {
    if (!midi.selectedId.value) return
    const trk = tracksRaw.current[id]; if (!trk) return
    midi.sendNoteOn(trk.midiChannel, trk.midiNote, trk.midiVelocity ?? 100)
    setTimeout(() => midi.sendNoteOff(trk.midiChannel, trk.midiNote), trk.gateMs ?? 80)
  }

  // ── MIDI (in) ───────────────────────────────────────────────────────
  const midiIn = useMidiIn({
    onPlay: () => { if (!playing.value) play() },
    onStop: () => { if (playing.value) stop() },
    onCCMapped: (controlId, rawValue) => {
      if (controlId === 'bpm') { bpm.value = Math.round(rawValue * 2 + 40) }
      else if (controlId === 'masterN') { masterNum.value = Math.round((rawValue / 127) * 16); onMasterKnobChange() }
      else if (controlId === 'masterD') {
        const opts = [4, 8, 16] as const
        masterDen.value = opts[rawValue < 43 ? 0 : rawValue < 85 ? 1 : 2]
        onMasterKnobChange()
      }
      else if (controlId === 'master_apply' && rawValue > 63) { commitMaster() }
    },
  })

  // External clock → BPM sync
  watch(() => midiIn.state.syncBpm, v => {
    if (midiIn.state.syncMode === 'external' && v !== null) { bpmRaw.current = v; bpm.value = v }
  })

  // ── Reactive → raw mirror sync ──────────────────────────────────────
  watch(audioOn, v => { audioEnabledRef.current = v })
  watch(bpm, v => { bpmRaw.current = v })
  watch(tracks, v => { tracksRaw.current = v.map(t => ({ ...t, steps: [...t.steps] })) }, { deep: true })
  watch(pendQ, v => { pendingRaw.current = v.map(q => q.map(p => ({ ...p }))) }, { deep: true })
  watch(masterTarget, v => { masterTargetRef.current = v })

  // ── Scheduler lifecycle ─────────────────────────────────────────────
  let scheduler: ReturnType<typeof createScheduler> | null = null

  function handleMasterReset() {
    flash.value = true
    setTimeout(() => { flash.value = false }, 260)
    midi.panic()
    const snap = masterStepsSnapshot
    tracks.value = tracks.value.map((t, i) => {
      const [n, d] = parseSig(t.timeSig)
      const base = snap?.[i] ?? t.stepsSource
      const newLen = stepCount(n, d)
      const { steps, stepsSource } = deriveStepsFromSource(base, newLen, n, d)
      return { ...t, steps, stepsSource }
    })
    masterStepsSnapshot = null
    masterTarget.value = null
  }

  onMounted(async () => {
    await midiIn.init()
    scheduler = createScheduler({
      bpmRaw, tracksRaw, pendingRaw, displayHeads,
      applyFnRef, midiFireRef, audioEnabledRef, masterTargetRef,
      onHeadsTick: h => { heads.value = h },
      onMasterReset: () => handleMasterReset(),
    })
  })

  onBeforeUnmount(() => {
    scheduler?.dispose()
    midi.panic()
  })

  // ── Transport ───────────────────────────────────────────────────────
  function play() { if (playing.value) return; playing.value = true; scheduler?.play() }
  function stop() { playing.value = false; scheduler?.stop(); midi.panic() }

  // ── Snapshot ────────────────────────────────────────────────────────
  function saveSnapshot() {
    savedSnapshot.value = tracks.value.map(t => ({
      steps: t.steps.slice(),
      stepsSource: t.stepsSource.slice(),
      timeSig: t.timeSig,
    }))
  }

  function recallSnapshot() {
    const snap = savedSnapshot.value; if (!snap) return
    midi.panic()
    const instant = masterMode.value === 'instant' || !playing.value

    if (instant) {
      tracks.value = tracks.value.map((t, i) => {
        const s = snap[i]; if (!s) return t
        const [n, d] = parseSig(s.timeSig)
        const cnt = stepCount(n, d)
        const steps = Array(cnt).fill(false).map((_, j) => s.steps[j] ?? false)
        return { ...t, timeSig: s.timeSig, steps, stepsSource: s.stepsSource.slice() }
      })
      pendQ.value = pendQ.value.map(() => [])
    } else {
      tracks.value = tracks.value.map((t, i) => {
        const s = snap[i]; if (!s) return t
        if (t.timeSig === s.timeSig) {
          const [n, d] = parseSig(s.timeSig)
          const cnt = stepCount(n, d)
          const steps = Array(cnt).fill(false).map((_, j) => s.steps[j] ?? false)
          return { ...t, steps, stepsSource: s.stepsSource.slice() }
        }
        return { ...t, stepsSource: s.stepsSource.slice() }
      })
      pendQ.value = tracks.value.map((t, i) => {
        const s = snap[i]; if (!s || t.timeSig === s.timeSig) return []
        return generateBridge(t.timeSig, s.timeSig, masterBridgeBars.value)
      })
    }
  }

  function clearSnapshot() { savedSnapshot.value = null }

  // ── Per-track meter ─────────────────────────────────────────────────
  function commitTrackSig(id: number, n: number, d: number) {
    const target = `${n}/${d}`
    const trk = tracks.value[id]; if (!trk) return
    if (trk.timeSig === target && pendQ.value[id].length === 0) return
    if (!playing.value) {
      tracks.value = tracks.value.map(t => t.id !== id ? t : applyPending(t, { timeSig: target }))
      pendQ.value = pendQ.value.map((q, i) => i === id ? [] : q)
      return
    }
    const queue = trk.mode === 'transition'
      ? generateBridge(trk.timeSig, target, 1)
      : [{ timeSig: target }]
    pendQ.value = pendQ.value.map((q, i) => i === id ? queue : q)
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
    tracks.value = tracks.value.map(t =>
      t.id !== id ? t : { ...t, mode: t.mode === 'instant' ? 'transition' : 'instant' },
    )
  }

  // ── Master meter ────────────────────────────────────────────────────
  function onMasterKnobChange() {
    if (masterMode.value === 'instant') commitMaster()
  }

  function commitMaster() {
    const target = `${masterNum.value}/${masterDen.value}`
    masterStepsSnapshot = tracks.value.map(t => [...t.stepsSource])
    if (!playing.value) {
      tracks.value = tracks.value.map(t => applyPending(t, { timeSig: target }))
      pendQ.value = pendQ.value.map(() => [])
      masterTarget.value = null
      masterStepsSnapshot = null
      return
    }
    const bars = masterMode.value === 'transition' ? masterBridgeBars.value : 0
    pendQ.value = tracks.value.map(t =>
      bars === 0 ? [{ timeSig: target }] : generateBridge(t.timeSig, target, bars),
    )
    masterTarget.value = target
  }

  // ── Step toggle / mute / solo / clear ───────────────────────────────
  function toggleStep(id: number, si: number) {
    tracks.value = tracks.value.map(t => {
      if (t.id !== id) return t
      const newSteps = t.steps.map((s, i) => i === si ? !s : s)
      const newSource = t.stepsSource.slice(); newSource[si] = newSteps[si]
      return { ...t, steps: newSteps, stepsSource: newSource }
    })
  }
  function doMute(id: number) {
    tracks.value = tracks.value.map(t => t.id === id ? { ...t, mute: !t.mute } : t)
  }
  function doSolo(id: number) {
    tracks.value = tracks.value.map(t => t.id === id ? { ...t, solo: !t.solo } : t)
  }
  function doClr(id: number) {
    tracks.value = tracks.value.map(t => t.id !== id ? t : {
      ...t,
      steps: Array(t.steps.length).fill(false),
      stepsSource: Array(t.stepsSource.length).fill(false),
    })
  }

  // ── Selection / detail panel ────────────────────────────────────────
  function onCircleSelect(id: number) {
    selectedId.value = id
    if (detailId.value !== null) detailId.value = id
  }
  function onBackgroundClick() {
    selectedId.value = -1
    detailId.value = null
  }

  const selTrack = () => tracks.value[selectedId.value]
  const detTrk = () => detailId.value !== null ? (tracks.value[detailId.value] ?? null) : null

  function updSel(patch: Partial<Track>) {
    tracks.value = tracks.value.map((t, i) => i === selectedId.value ? { ...t, ...patch } : t)
  }
  function updDet(patch: Partial<Track>) {
    if (detailId.value === null) return
    const id = detailId.value
    tracks.value = tracks.value.map(t => t.id === id ? { ...t, ...patch } : t)
  }

  function applySel(n: number, d: number, bars: number) {
    const sig = `${n}/${d}`
    const trk = selTrack(); if (!trk) return
    if (!playing.value) {
      tracks.value = tracks.value.map((t, i) => i === selectedId.value ? applyPending(t, { timeSig: sig }) : t)
      return
    }
    const queue = generateBridge(trk.timeSig, sig, bars)
    pendQ.value = pendQ.value.map((q, i) => i === selectedId.value ? [...q, ...queue] : q)
  }

  // ── Track meter helpers (for UI) ────────────────────────────────────
  function trkNum(t: Track) { return parseSig(t.timeSig)[0] }
  function trkDen(t: Track) { return parseSig(t.timeSig)[1] }
  function pendingSig(i: number) {
    const q = pendQ.value[i]
    return q.length > 0 ? q[q.length - 1].timeSig : null
  }

  // ── MIDI mapping UI helpers ─────────────────────────────────────────
  function isLearning(id: string) { return midiIn.state.learnControlId === id }
  function toggleLearn(id: string) {
    if (isLearning(id)) midiIn.cancelLearn()
    else midiIn.startLearn(id)
  }
  function bindingLabel(id: string) {
    const m = midiIn.getMappingFor(id)
    if (!m) return '+'
    return `${m.type.toUpperCase()}${m.number} ch${m.channel}`
  }
  function hasBound(id: string) { return !!midiIn.getMappingFor(id) }

  // ── All mute ────────────────────────────────────────────────────────
  const allMuted = computed(() => tracks.value.every(t => t.mute))
  function toggleAllMute() {
    const mute = !allMuted.value
    tracks.value = tracks.value.map(t => ({ ...t, mute }))
  }

  return {
    // constants (factory defaults exposed for template use)
    NUM_OPTS, DEN_OPTS,

    // reactive state
    bpm, playing, tracks, heads, pendQ, selectedId, detailId, audioOn,
    masterNum, masterDen, masterMode, masterBridgeBars, masterTarget, flash,
    savedSnapshot, showMapping,

    // composables passed through
    midi, midiIn,

    // transport
    play, stop,

    // snapshot
    saveSnapshot, recallSnapshot, clearSnapshot,

    // per-track meter
    commitTrackSig, setTrackNum, setTrackDen, toggleTrackMode,

    // master meter
    onMasterKnobChange, commitMaster,

    // step / mute / solo / clear
    toggleStep, doMute, doSolo, doClr,

    // selection / detail
    onCircleSelect, onBackgroundClick, selTrack, detTrk, updSel, updDet, applySel,

    // ui helpers
    trkNum, trkDen, pendingSig,

    // midi mapping helpers
    isLearning, toggleLearn, bindingLabel, hasBound,

    // all mute
    allMuted, toggleAllMute,

    // raw mirror for RAF loop (Plus variant overlay)
    displayHeads,

    // tracksRaw mirror for RAF loop (Plus variant overlay - geometry access)
    tracksRaw,
  }
}
