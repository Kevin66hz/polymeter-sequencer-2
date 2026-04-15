<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  applyPending,
  createScheduler,
  deriveStepsFromSource,
  generateBridge,
  stepCount,
  TRACK_COUNT,
  type Pending,
  type Track,
} from '~/composables/useScheduler'
import { useMidi } from '~/composables/useMidi'
import { useMidiIn } from '~/composables/useMidiIn'
import MeterKnob from '~/components/MeterKnob.vue'
import CircularTrack from '~/components/CircularTrack.vue'
import ConcentricView from '~/components/ConcentricView.vue'
import StepSequencer from '~/components/StepSequencer.vue'

type ViewMode = 'grid' | 'concentric'
const viewMode = ref<ViewMode>('grid')

const NUM_OPTS = Array.from({ length: 17 }, (_, i) => i)
const DEN_OPTS = [4, 8, 16] as const

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
  // ch1  KICK  4/4
  [true,false,false,false,true,false,false,false,true,false,false,false,true,false,false,false],
  // ch2  SNARE 7/8
  [false,false,false,false,true,false,false,false,false,false,false,false,true,false,false,false],
  // ch3  HAT   9/8
  [true,false,true,false,true,false,true,false,true,false,true,false,true,false,true,false],
  // ch4  CLAP  5/4
  [false,false,false,false,false,false,false,true,false,false,false,false,false,false,false,false],
  // ch5  BASS  3/4
  [true,false,false,true,false,false,true,false,false,false,false,false,false,false,false,false],
  // ch6  LEAD  11/8
  [true,false,false,false,false,false,true,false,false,false,false,false,false,false,false,false],
  // ch7  PAD   6/8
  [true,false,false,false,true,false,false,false,false,false,false,false,false,false,false,false],
  // ch8  PERC  13/8
  [false,false,true,false,false,false,false,true,false,false,true,false,false,false,false,false],
  // ch9  K2    4/4
  [true,false,false,false,false,false,true,false,true,false,false,false,false,false,false,false],
  // ch10 S2    5/8
  [false,false,false,true,false,false,false,false,false,false,false,false,false,false,false,false],
  // ch11 HH2   7/4
  [true,false,false,true,false,false,true,false,false,true,false,false,true,false,false,false],
  // ch12 CL2   3/8
  [false,false,true,false,false,false,false,false,false,false,false,false,false,false,false,false],
  // ch13 B2    4/4
  [true,false,true,false,false,true,false,false,true,false,false,false,true,false,false,false],
  // ch14 LD2   7/8
  [false,false,false,true,false,false,false,false,false,false,false,false,false,false,false,false],
  // ch15 PD2   5/4
  [true,false,false,false,false,false,false,false,true,false,false,false,false,false,false,false],
  // ch16 PC2   6/4
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

const parseSig = (s: string): [number, number] => {
  const [nr, dr] = s.split('/').map(Number)
  return [Number.isFinite(nr) ? nr : 4, (Number.isFinite(dr) && dr > 0) ? dr : 4]
}

// ── state ──────────────────────────────────────────────
const bpm = ref(120)
const playing = ref(false)
const tracks = ref<Track[]>(Array.from({ length: TRACK_COUNT }, (_, i) => mkTrk(i)))
const heads = ref<number[]>(Array(TRACK_COUNT).fill(-1))
const pendQ = ref<Pending[][]>(Array.from({ length: TRACK_COUNT }, () => []))
const selectedId = ref(0)
const detailId = ref<number | null>(null)
const trackEnabled = ref<boolean[]>(Array(TRACK_COUNT).fill(true))
const trackEnabledRaw = { current: Array(TRACK_COUNT).fill(true) as boolean[] }

watch(trackEnabled, v => { trackEnabledRaw.current = v.slice() }, { deep: true })

function toggleTrackEnabled(id: number) {
  trackEnabled.value = trackEnabled.value.map((v, i) => i === id ? !v : v)
}
const detTrk = () => detailId.value !== null ? (tracks.value[detailId.value] ?? null) : null

const masterNum = ref(4)
const masterDen = ref<4|8|16>(4)
const masterMode = ref<'instant'|'transition'>('instant')
const masterBridgeBars = ref<1|2>(1)
const masterTarget = ref<string | null>(null)
const flash = ref(false)
let masterStepsSnapshot: boolean[][] | null = null

// ── パターンスナップショット ───────────────────────────────
type TrackSnapshot = { steps: boolean[], stepsSource: boolean[], timeSig: string }
const savedSnapshot = ref<TrackSnapshot[] | null>(null)

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
    // 即時リストア: 拍子・ステップすべてを戻す
    tracks.value = tracks.value.map((t, i) => {
      const s = snap[i]; if (!s) return t
      const [n, d] = parseSig(s.timeSig)
      const cnt = stepCount(n, d)
      const steps = Array(cnt).fill(false).map((_, j) => s.steps[j] ?? false)
      return { ...t, timeSig: s.timeSig, steps, stepsSource: s.stepsSource.slice() }
    })
    pendQ.value = pendQ.value.map(() => [])
  } else {
    // TRANSITION: stepsSource をスナップショットに差し替えてから拍子をブリッジ遷移
    // → applyPending が最終拍子で deriveStepsFromSource を呼ぶときスナップのステップが出る
    tracks.value = tracks.value.map((t, i) => {
      const s = snap[i]; if (!s) return t
      if (t.timeSig === s.timeSig) {
        // 拍子が同じ → ブリッジ不要、ステップだけ即時リストア
        const [n, d] = parseSig(s.timeSig)
        const cnt = stepCount(n, d)
        const steps = Array(cnt).fill(false).map((_, j) => s.steps[j] ?? false)
        return { ...t, steps, stepsSource: s.stepsSource.slice() }
      }
      // 拍子が違う → stepsSource だけ先に差し替え（ブリッジ遷移先で正しいステップになる）
      return { ...t, stepsSource: s.stepsSource.slice() }
    })
    pendQ.value = tracks.value.map((t, i) => {
      const s = snap[i]; if (!s || t.timeSig === s.timeSig) return []
      return generateBridge(t.timeSig, s.timeSig, masterBridgeBars.value)
    })
  }
}

// ── raw mirrors ────────────────────────────────────────
const bpmRaw = { current: bpm.value }
const tracksRaw = { current: tracks.value.map(t => ({ ...t, steps: [...t.steps] })) }
const pendingRaw = { current: Array.from({ length: TRACK_COUNT }, () => [] as Pending[]) }
const displayHeads = { current: Array(TRACK_COUNT).fill(-1) as number[] }
const masterTargetRef = { current: null as string | null }
const applyFnRef: { current: ((id: number, p: Pending) => void) | null } = { current: null }
applyFnRef.current = (id, p) => {
  tracks.value = tracks.value.map(t => t.id !== id ? t : applyPending(t, p))
  pendQ.value = pendQ.value.map((q, i) => i === id ? q.slice(1) : q)
}

// ── MIDI ───────────────────────────────────────────────
const midi = useMidi()
const midiFireRef: { current: ((id: number) => void) | null } = { current: null }

const midiIn = useMidiIn({
  onPlay: () => { if (!playing.value) play() },
  onStop: () => { if (playing.value) stop() },
  onCCMapped: (controlId, rawValue) => {
    if (controlId === 'bpm') { bpm.value = Math.round(rawValue * 2 + 40) }
    else if (controlId === 'masterN') { masterNum.value = Math.round((rawValue/127)*16); onMasterKnobChange() }
    else if (controlId === 'masterD') {
      const opts = [4,8,16] as const
      masterDen.value = opts[rawValue < 43 ? 0 : rawValue < 85 ? 1 : 2]
      onMasterKnobChange()
    }
    else if (controlId === 'master_apply' && rawValue > 63) { commitMaster() }
  },
})
watch(() => midiIn.state.syncBpm, v => {
  if (midiIn.state.syncMode === 'external' && v !== null) { bpmRaw.current = v; bpm.value = v }
})

const showMapping = ref(false)

midiFireRef.current = (id) => {
  if (!midi.selectedId.value) return
  if (!trackEnabledRaw.current[id]) return  // Audio/MIDI off
  const trk = tracksRaw.current[id]; if (!trk) return
  midi.sendNoteOn(trk.midiChannel, trk.midiNote, trk.midiVelocity ?? 100)
  setTimeout(() => midi.sendNoteOff(trk.midiChannel, trk.midiNote), trk.gateMs ?? 80)
}

watch(bpm, v => { bpmRaw.current = v })
watch(tracks, v => { tracksRaw.current = v.map(t => ({ ...t, steps: [...t.steps] })) }, { deep: true })
watch(pendQ, v => { pendingRaw.current = v.map(q => q.map(p => ({ ...p }))) }, { deep: true })
watch(masterTarget, v => { masterTargetRef.current = v })

// ── scheduler ──────────────────────────────────────────
let scheduler: ReturnType<typeof createScheduler> | null = null

function handleMasterReset() {
  flash.value = true; setTimeout(() => { flash.value = false }, 260)
  midi.panic()
  const snap = masterStepsSnapshot
  tracks.value = tracks.value.map((t, i) => {
    const [n, d] = parseSig(t.timeSig)
    const base = snap?.[i] ?? t.stepsSource
    const newLen = stepCount(n, d)
    const { steps, stepsSource } = deriveStepsFromSource(base, newLen, n, d)
    return { ...t, steps, stepsSource }
  })
  masterStepsSnapshot = null; masterTarget.value = null
}

onMounted(async () => {
  await midiIn.init()
  scheduler = createScheduler({
    bpmRaw, tracksRaw, pendingRaw, displayHeads,
    applyFnRef, midiFireRef, masterTargetRef,
    onHeadsTick: h => { heads.value = h },
    onMasterReset: () => handleMasterReset(),
  })
})
onBeforeUnmount(() => { scheduler?.dispose(); midi.panic() })

function play() { if (playing.value) return; playing.value = true; scheduler?.play() }
function stop() { playing.value = false; scheduler?.stop(); midi.panic() }

// ── track meter ────────────────────────────────────────
function commitTrackSig(id: number, n: number, d: number) {
  const target = `${n}/${d}`; const trk = tracks.value[id]; if (!trk) return
  if (trk.timeSig === target && pendQ.value[id].length === 0) return
  if (!playing.value) {
    tracks.value = tracks.value.map(t => t.id !== id ? t : applyPending(t, { timeSig: target }))
    pendQ.value = pendQ.value.map((q, i) => i === id ? [] : q); return
  }
  const queue = trk.mode === 'transition' ? generateBridge(trk.timeSig, target, 1) : [{ timeSig: target }]
  pendQ.value = pendQ.value.map((q, i) => i === id ? queue : q)
}
function setTrackNum(id: number, n: number) { const [,d] = parseSig(tracks.value[id].timeSig); commitTrackSig(id, n, d) }
function setTrackDen(id: number, d: number) { const [n] = parseSig(tracks.value[id].timeSig); commitTrackSig(id, n, d) }
function toggleTrackMode(id: number) {
  tracks.value = tracks.value.map(t => t.id !== id ? t : { ...t, mode: t.mode === 'instant' ? 'transition' : 'instant' })
}

// ── master meter ───────────────────────────────────────
function onMasterKnobChange() { if (masterMode.value === 'instant') commitMaster() }
function commitMaster() {
  const target = `${masterNum.value}/${masterDen.value}`
  masterStepsSnapshot = tracks.value.map(t => [...t.stepsSource])
  if (!playing.value) {
    tracks.value = tracks.value.map(t => applyPending(t, { timeSig: target }))
    pendQ.value = pendQ.value.map(() => []); masterTarget.value = null; masterStepsSnapshot = null; return
  }
  const bars = masterMode.value === 'transition' ? masterBridgeBars.value : 0
  pendQ.value = tracks.value.map(t => bars === 0 ? [{ timeSig: target }] : generateBridge(t.timeSig, target, bars))
  masterTarget.value = target
}

// ── track ops ──────────────────────────────────────────
function tog(id: number, si: number) {
  tracks.value = tracks.value.map(t => {
    if (t.id !== id) return t
    const newSteps = t.steps.map((s, i) => i === si ? !s : s)
    const newSource = t.stepsSource.slice(); newSource[si] = newSteps[si]
    return { ...t, steps: newSteps, stepsSource: newSource }
  })
}
function doMute(id: number) { tracks.value = tracks.value.map(t => t.id === id ? { ...t, mute: !t.mute } : t) }
function doSolo(id: number) { tracks.value = tracks.value.map(t => t.id === id ? { ...t, solo: !t.solo } : t) }
function doClr(id: number) {
  tracks.value = tracks.value.map(t => t.id !== id ? t : {
    ...t, steps: Array(t.steps.length).fill(false), stepsSource: Array(t.stepsSource.length).fill(false)
  })
}

// ── selected track detail ──────────────────────────────
const selTrack = () => tracks.value[selectedId.value]
function updSel(patch: Partial<Track>) {
  tracks.value = tracks.value.map((t, i) => i === selectedId.value ? { ...t, ...patch } : t)
}
function applySel(n: number, d: number, bars: number) {
  const sig = `${n}/${d}`
  const trk = selTrack(); if (!trk) return
  if (!playing.value) { tracks.value = tracks.value.map((t, i) => i === selectedId.value ? applyPending(t, { timeSig: sig }) : t); return }
  const queue = generateBridge(trk.timeSig, sig, bars)
  pendQ.value = pendQ.value.map((q, i) => i === selectedId.value ? [...q, ...queue] : q)
}

function trkNum(t: Track) { return parseSig(t.timeSig)[0] }
function trkDen(t: Track) { return parseSig(t.timeSig)[1] }
function pendingSig(i: number) { const q = pendQ.value[i]; return q.length > 0 ? q[q.length-1].timeSig : null }

function isLearning(id: string) { return midiIn.state.learnControlId === id }
function toggleLearn(id: string) { if (isLearning(id)) midiIn.cancelLearn(); else midiIn.startLearn(id) }
function bindingLabel(id: string) {
  const m = midiIn.getMappingFor(id); if (!m) return '+'; return `${m.type.toUpperCase()}${m.number} ch${m.channel}`
}
function hasBound(id: string) { return !!midiIn.getMappingFor(id) }

const showBpmOverlay = ref(false)
const midiConfigInput = ref<HTMLInputElement | null>(null)

// ── ALL MUTE ─────────────────────────────────────────────
const allMuted = computed(() => tracks.value.every(t => t.mute))
function toggleAllMute() {
  const mute = !allMuted.value
  tracks.value = tracks.value.map(t => ({ ...t, mute }))
}
function downloadMidiConfig() {
  const blob = new Blob([midiIn.saveMappings()], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const a = document.createElement('a')
  a.href = url; a.download = 'midi-config.json'; a.click(); URL.revokeObjectURL(url)
}
function triggerLoadMidiConfig() { midiConfigInput.value?.click() }
function onMidiConfigLoaded(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return
  const reader = new FileReader()
  reader.onload = evt => midiIn.loadMappings(evt.target?.result as string)
  reader.readAsText(file); (e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div class="h-screen bg-[#0a0a0a] text-[#ccc] font-mono flex flex-col overflow-hidden">


    <!-- ── TOP BAR: 2行レイアウト ── -->
    <div class="bg-[#0c0c0c] flex items-stretch flex-shrink-0 border-b"
      :style="{ borderColor: masterTarget ? '#ff660044' : '#1a1a1a' }">

      <!-- ═══ 左: 機種名 + 変拍子ツマミ (全高スパン・メイン強調) ═══ -->
      <div class="flex items-center gap-1.5 px-4 border-r border-[#1e1e1e] flex-shrink-0">
        <div class="flex flex-col items-start mr-2 flex-shrink-0">
          <span class="text-[11px] tracking-[3px] text-[#666] font-bold leading-none">IBK-1</span>
          <span class="text-[7px] tracking-[1px] text-[#333] leading-none mt-[3px]">POLY SEQ</span>
        </div>
        <span class="text-[9px] tracking-[2px] text-[#444] mr-1">MASTER</span>
        <div class="relative z-[6]">
          <MeterKnob v-model="masterNum" :options="NUM_OPTS" label="N" :size="54" color="#e5e5e5" @change="onMasterKnobChange" />
          <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-full"
            :class="isLearning('masterN') ? 'bg-orange-500/70 animate-pulse' : hasBound('masterN') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
            @click="toggleLearn('masterN')" @click.right.prevent="midiIn.removeMapping('masterN')">
            <span class="text-[7px] text-white leading-none px-0.5">{{ isLearning('masterN') ? '●' : bindingLabel('masterN') }}</span>
          </div>
        </div>
        <span class="text-[22px] text-[#222] leading-none select-none">/</span>
        <div class="relative z-[6]">
          <MeterKnob v-model="masterDen" :options="DEN_OPTS" label="D" :size="54" color="#e5e5e5" @change="onMasterKnobChange" />
          <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-full"
            :class="isLearning('masterD') ? 'bg-orange-500/70 animate-pulse' : hasBound('masterD') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
            @click="toggleLearn('masterD')" @click.right.prevent="midiIn.removeMapping('masterD')">
            <span class="text-[7px] text-white leading-none px-0.5">{{ isLearning('masterD') ? '●' : bindingLabel('masterD') }}</span>
          </div>
        </div>
      </div>

      <!-- ═══ 右: 2行スタック ═══ -->
      <div class="flex-1 flex flex-col min-w-0">

        <!-- ── 行1: リズム・再生系 ── -->
        <div class="flex items-center gap-2 px-3 py-[6px] border-b border-[#161616] flex-shrink-0 flex-wrap">

          <!-- INST / TRANS -->
          <div class="flex gap-0.5 rounded-sm overflow-hidden border border-[#222] flex-shrink-0">
            <button class="text-[10px] px-2 py-1"
              :class="masterMode==='instant' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555]'"
              @click="masterMode='instant'">INSTANT</button>
            <button class="text-[10px] px-2 py-1"
              :class="masterMode==='transition' ? 'bg-[#2a2a2a] text-[#ff9944]' : 'bg-transparent text-[#555]'"
              @click="masterMode='transition'">TRANSITION</button>
          </div>

          <!-- BRIDGE -->
          <div class="flex items-center gap-1 flex-shrink-0"
            :style="{ opacity: masterMode==='transition' ? 1 : 0.3, pointerEvents: masterMode==='transition' ? 'auto' : 'none' }">
            <span class="text-[9px] text-[#555] tracking-[1px]">BRIDGE</span>
            <button v-for="b in ([1,2] as const)" :key="b"
              class="text-[10px] px-2 py-1 border rounded-sm"
              :class="masterBridgeBars===b ? 'bg-[#2a2a2a] text-[#ff9944] border-[#ff660066]' : 'bg-transparent text-[#555] border-[#222]'"
              @click="masterBridgeBars=b">{{ b }}</button>
          </div>

          <!-- APPLY -->
          <div class="w-[76px] flex-shrink-0"
            :style="{ visibility: (masterMode==='transition' || masterTarget) ? 'visible' : 'hidden' }">
            <div class="relative z-[6]">
              <button
                class="w-full py-[5px] text-[10px] border rounded-sm tracking-[1px] text-center"
                :class="masterTarget ? 'bg-[#2a1a0a] text-[#ff9944] border-[#ff660066]' : 'bg-[#1a2230] text-[#8faacc] border-[#2a4060] hover:text-[#bcd]'"
                :disabled="!!masterTarget" @click="commitMaster">
                {{ masterTarget ? `⟳ ${masterTarget}` : 'APPLY' }}
              </button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('master_apply') ? 'bg-orange-500/70 animate-pulse' : hasBound('master_apply') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('master_apply')" @click.right.prevent="midiIn.removeMapping('master_apply')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('master_apply') ? '●' : bindingLabel('master_apply') }}</span>
              </div>
            </div>
          </div>

          <!-- 縦区切り -->
          <div class="w-px self-stretch bg-[#222] my-0.5 flex-shrink-0" />

          <!-- SNAP / SHOT -->
          <div class="flex items-center gap-1 flex-shrink-0">
            <span class="text-[9px] text-[#444] tracking-[1px]">SNAP</span>
            <button
              class="text-[10px] px-2 py-[4px] border rounded-sm tracking-[1px]"
              :class="savedSnapshot ? 'bg-[#182818] text-[#88cc88] border-[#336633]' : 'bg-transparent text-[#555] border-[#222] hover:text-[#aaa]'"
              @click="saveSnapshot">{{ savedSnapshot ? '● SHOT' : '○ SHOT' }}</button>
            <button v-if="savedSnapshot"
              class="text-[10px] px-2 py-[4px] border rounded-sm tracking-[1px]"
              :class="masterMode==='transition' ? 'bg-[#1a1a0a] text-[#ffcc44] border-[#554400]' : 'bg-[#1a1a2a] text-[#88aaff] border-[#334488]'"
              @click="recallSnapshot">↩ {{ masterMode==='transition' ? 'TRANS' : 'INST' }}</button>
            <button v-if="savedSnapshot"
              class="text-[10px] px-1.5 py-[4px] border border-[#222] bg-transparent text-[#444] rounded-sm hover:text-[#888]"
              @click="savedSnapshot = null">✕</button>
          </div>

          <!-- 縦区切り -->
          <div class="w-px self-stretch bg-[#222] my-0.5 flex-shrink-0" />

          <!-- ALL MUTE -->
          <button
            class="text-[10px] px-2 py-[4px] border rounded-sm tracking-[1px] flex-shrink-0"
            :class="allMuted ? 'bg-[#2a1a1a] text-[#dd8888] border-[#664444]' : 'bg-transparent text-[#555] border-[#222] hover:text-[#aaa]'"
            @click="toggleAllMute">⊘ ALL M</button>

          <!-- ml-auto: 右寄せ -->
          <div class="ml-auto flex items-center gap-2 flex-shrink-0">

            <!-- BPM ボタン + オーバーレイ -->
            <div class="relative z-[10] flex-shrink-0">
              <button
                class="text-[11px] border px-2 py-[4px] rounded-sm tabular-nums"
                :class="showBpmOverlay ? 'text-[#ddd] border-[#555] bg-[#1e1e1e]' : 'text-[#888] border-[#222] bg-transparent hover:text-[#ccc]'"
                @click.stop="showBpmOverlay = !showBpmOverlay">
                BPM <span class="font-bold">{{ bpm }}</span> ▾
              </button>
              <!-- 背景キャッチャー -->
              <div v-if="showBpmOverlay" class="fixed inset-0 z-[98]" @click="showBpmOverlay=false" />
              <!-- スライダーオーバーレイ -->
              <div v-if="showBpmOverlay"
                class="absolute top-full left-0 mt-1 z-[99] bg-[#111] border border-[#333] rounded-sm px-3 py-2 flex items-center gap-2 shadow-xl"
                @click.stop>
                <!-- MIDI mapping overlay on slider -->
                <div class="relative">
                  <input type="range" min="40" max="240" :value="bpm" class="w-[130px]"
                    @input="(e) => (bpm = Number((e.target as HTMLInputElement).value))" />
                  <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center"
                    :class="isLearning('bpm') ? 'bg-orange-500/70 animate-pulse' : hasBound('bpm') ? 'bg-blue-500/30' : 'bg-white/10 hover:bg-white/20'"
                    @click="toggleLearn('bpm')">
                    <span class="text-[7px] text-white">{{ isLearning('bpm') ? '●' : bindingLabel('bpm') || 'BPM' }}</span>
                  </div>
                </div>
                <span class="text-[11px] text-[#aaa] w-[28px] tabular-nums">{{ bpm }}</span>
                <button class="text-[11px] text-[#555] hover:text-[#ccc] leading-none" @click="showBpmOverlay=false">✕</button>
              </div>
            </div>

            <!-- PLAY / STOP -->
            <div class="relative z-[6] flex-shrink-0">
              <button class="border-0 px-[14px] py-[5px] text-[11px] tracking-[2px]"
                :class="playing ? 'bg-[#c03030] text-[#ffaaaa]' : 'bg-[#206020] text-[#aaffaa]'"
                @click="playing ? stop() : play()">{{ playing ? '■ STOP' : '▶ PLAY' }}</button>
              <div v-if="showMapping" class="absolute inset-0 flex gap-px">
                <div class="flex-1 cursor-pointer flex items-center justify-center text-[7px] text-white"
                  :class="isLearning('transport_play') ? 'bg-orange-500/80 animate-pulse' : hasBound('transport_play') ? 'bg-blue-500/50' : 'bg-white/10 hover:bg-white/25'"
                  @click="toggleLearn('transport_play')">{{ isLearning('transport_play') ? '●' : bindingLabel('transport_play') || '▶' }}</div>
                <div class="flex-1 cursor-pointer flex items-center justify-center text-[7px] text-white"
                  :class="isLearning('transport_stop') ? 'bg-orange-500/80 animate-pulse' : hasBound('transport_stop') ? 'bg-blue-500/50' : 'bg-white/10 hover:bg-white/25'"
                  @click="toggleLearn('transport_stop')">{{ isLearning('transport_stop') ? '●' : bindingLabel('transport_stop') || '■' }}</div>
              </div>
            </div>

          </div>
        </div>

        <!-- ── 行2: ビュー・設定系 ── -->
        <div class="flex items-center gap-3 px-3 py-[5px] flex-wrap flex-shrink-0">

          <!-- View toggle -->
          <div class="flex gap-0.5 rounded-sm overflow-hidden border border-[#222]">
            <button class="text-[9px] px-2 py-1"
              :class="viewMode==='grid' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555] hover:text-[#999]'"
              @click="viewMode='grid'">⊞ GRID</button>
            <button class="text-[9px] px-2 py-1"
              :class="viewMode==='concentric' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555] hover:text-[#999]'"
              @click="viewMode='concentric'">◎ RING</button>
          </div>

          <!-- 縦区切り -->
          <div class="w-px self-stretch bg-[#1e1e1e] my-0.5" />

          <!-- MIDI OUT -->
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] text-[#444]">MIDI OUT</span>
            <select :value="midi.selectedId.value ?? ''"
              class="bg-[#111] text-[#ccc] border border-[#222] text-[10px] py-[2px] px-[4px] min-w-[120px]"
              :disabled="!midi.supported.value"
              @change="midi.selectOutput(($event.target as HTMLSelectElement).value || null)">
              <option value="">{{ midi.supported.value ? (midi.outputs.value.length ? '— none —' : '— no device —') : 'unsupported' }}</option>
              <option v-for="o in midi.outputs.value" :key="o.id" :value="o.id">{{ o.name }}</option>
            </select>
          </div>

          <!-- MIDI IN -->
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] text-[#444]">MIDI IN</span>
            <select v-if="midiIn.state.supported" :value="midiIn.state.selectedId ?? ''"
              class="bg-[#111] text-[#ccc] border border-[#222] text-[10px] py-[2px] px-[4px] min-w-[120px]"
              @change="(e) => midiIn.selectInput((e.target as HTMLSelectElement).value || null)">
              <option value="">— none —</option>
              <option v-for="o in midiIn.state.inputs" :key="o.id" :value="o.id">{{ o.name }}</option>
            </select>
            <span v-else class="text-[10px] text-[#555]">unsupported</span>
          </div>

          <!-- Clock sync -->
          <div v-if="midiIn.state.selectedId" class="flex gap-0.5 rounded-sm overflow-hidden border border-[#222]">
            <button class="text-[9px] px-1.5 py-1"
              :class="midiIn.state.syncMode==='internal' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555]'"
              @click="midiIn.state.syncMode='internal'">INT</button>
            <button class="text-[9px] px-1.5 py-1"
              :class="midiIn.state.syncMode==='external' ? 'bg-[#2a2a2a] text-[#8fccaa]' : 'bg-transparent text-[#555]'"
              @click="midiIn.state.syncMode='external'">SYNC</button>
            <span v-if="midiIn.state.syncMode==='external' && midiIn.state.syncBpm"
              class="text-[9px] px-1.5 text-[#8fccaa]">{{ midiIn.state.syncBpm }}</span>
          </div>

          <!-- Mapping -->
          <div v-if="midiIn.state.selectedId" class="flex items-center gap-1">
            <button class="text-[9px] px-2 py-1 border rounded-sm"
              :class="showMapping ? 'bg-[#2a2a2a] text-[#ddd] border-[#555]' : 'bg-transparent text-[#666] border-[#333]'"
              @click="showMapping=!showMapping">MAPPING</button>
            <button class="text-[9px] px-2 py-1 border border-[#333] bg-transparent text-[#666] rounded-sm hover:text-[#ccc]" @click="downloadMidiConfig">SAVE</button>
            <button class="text-[9px] px-2 py-1 border border-[#333] bg-transparent text-[#666] rounded-sm hover:text-[#ccc]" @click="triggerLoadMidiConfig">LOAD</button>
            <input ref="midiConfigInput" type="file" accept=".json" style="display:none" @change="onMidiConfigLoaded" />
          </div>

        </div>
      </div>
    </div>

    <!-- Mapping dim layer -->
    <div v-if="showMapping" class="fixed inset-0 z-[5] pointer-events-none" style="background:rgba(0,0,0,0.55)" />

    <!-- ── BODY ── -->
    <div class="flex-1 flex min-h-0 overflow-hidden">

      <!-- ── GRID VIEW: 8×2、スクロールなし ── -->
      <div v-if="viewMode==='grid'" class="flex-1 min-h-0 p-2">
        <div class="grid grid-cols-8 grid-rows-2 gap-2 h-full">
          <div v-for="trk in tracks" :key="trk.id"
            class="bg-[#0e0e0e] border flex flex-col min-h-0 px-1.5 py-1 gap-1"
            :style="{ borderColor: pendQ[trk.id].length ? trk.color+'44' : '#161616' }"
            :class="{ 'opacity-40': trk.mute }">

            <!-- Top row: name + knobs (size 28) -->
            <div class="flex items-center justify-between flex-shrink-0">
              <!-- OFF時はMIDIチャンネル番号を表示 -->
              <span class="text-[8px] tracking-[1px] font-semibold truncate"
                :style="{ color: trk.color, opacity: trackEnabled[trk.id] ? 1 : 0.45 }">
                {{ trackEnabled[trk.id] ? trk.name : trk.midiChannel }}</span>
              <div class="flex items-center gap-0.5 relative">
                <MeterKnob :model-value="trkNum(trk)" :options="NUM_OPTS" :size="28" :color="trk.color" @change="(v) => setTrackNum(trk.id, v)" />
                <span class="text-[9px] text-[#333]">/</span>
                <MeterKnob :model-value="trkDen(trk)" :options="DEN_OPTS" :size="28" :color="trk.color" @change="(v) => setTrackDen(trk.id, v)" />
                <span v-if="pendingSig(trk.id)" class="absolute -top-0.5 -right-0.5 w-[5px] h-[5px] rounded-full bg-[#ff6600]" />
              </div>
            </div>

            <!-- Circle -->
            <div class="flex-1 min-h-0 min-w-0 flex justify-center items-center overflow-hidden">
              <CircularTrack
                :track="trk" :head="heads[trk.id]" :selected="selectedId === trk.id"
                @select="selectedId = trk.id"
                @toggle="(si) => tog(trk.id, si)" />
            </div>

            <!-- Bottom row: M/S/CLR + 詳細ボタン -->
            <div class="flex items-center justify-between flex-shrink-0">
              <div class="flex gap-[3px]">
                <button class="py-[2px] px-[6px] text-[9px] border rounded-sm"
                  :style="{ background: trk.mute?'#88888833':'transparent', color: trk.mute?'#ddd':'#555', borderColor: trk.mute?'#888':'#2a2a2a' }"
                  @click.stop="doMute(trk.id)">M</button>
                <button class="py-[2px] px-[6px] text-[9px] border rounded-sm"
                  :style="{ background: trk.solo?'#cc990033':'transparent', color: trk.solo?'#ffcc55':'#555', borderColor: trk.solo?'#cc9900':'#2a2a2a' }"
                  @click.stop="doSolo(trk.id)">S</button>
                <button class="py-[2px] px-[6px] text-[9px] border border-[#2a2a2a] bg-transparent text-[#555] rounded-sm hover:text-[#ccc]"
                  @click.stop="doClr(trk.id)">✕</button>
              </div>
              <!-- 詳細設定ボタン -->
              <button
                class="py-[2px] px-[6px] text-[11px] border rounded-sm leading-none"
                :style="{ color: detailId===trk.id ? trk.color : '#444', borderColor: detailId===trk.id ? trk.color+'66' : '#2a2a2a', background: detailId===trk.id ? trk.color+'11' : 'transparent' }"
                @click.stop="detailId = detailId === trk.id ? null : trk.id">⚙</button>
            </div>


          </div>
        </div>
      </div>

      <!-- ── CONCENTRIC VIEW ── -->
      <template v-else>
        <div class="flex-1 overflow-y-auto flex justify-center items-start p-3">
          <ConcentricView
            :tracks="tracks" :heads="heads" :selected-id="selectedId"
            @select="selectedId = $event"
            @toggle="(ti, si) => tog(ti, si)" />
        </div>

        <!-- Right panel: selected track detail -->
        <div class="w-[180px] bg-[#0c0c0c] border-l border-[#1e1e1e] p-3 flex flex-col gap-3 overflow-y-auto flex-shrink-0 text-[11px]">
          <template v-if="selTrack()">
            <div class="font-semibold tracking-[1px] pb-1 border-b"
              :style="{ color: selTrack()!.color, borderColor: selTrack()!.color+'44' }">
              {{ selTrack()!.name }} <span class="text-[#555] text-[9px]">{{ selTrack()!.timeSig }}</span>
            </div>

            <!-- Meter knobs -->
            <div>
              <div class="text-[9px] text-[#555] mb-1 tracking-[1px]">METER</div>
              <div class="flex items-end gap-1">
                <MeterKnob :model-value="trkNum(selTrack()!)" :options="NUM_OPTS" :size="36" :color="selTrack()!.color"
                  @change="(v) => setTrackNum(selectedId, v)" />
                <span class="text-[14px] text-[#333] pb-2">/</span>
                <MeterKnob :model-value="trkDen(selTrack()!)" :options="DEN_OPTS" :size="36" :color="selTrack()!.color"
                  @change="(v) => setTrackDen(selectedId, v)" />
              </div>
            </div>

            <!-- Mode -->
            <div class="flex gap-0.5 rounded-sm overflow-hidden border border-[#222]">
              <button class="text-[8px] px-1.5 py-1 flex-1"
                :class="selTrack()!.mode==='instant' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555]'"
                @click="toggleTrackMode(selectedId)">▪INST</button>
              <button class="text-[8px] px-1.5 py-1 flex-1"
                :class="selTrack()!.mode==='transition' ? 'bg-[#2a1a0a] text-[#ff9944]' : 'bg-transparent text-[#555]'"
                @click="toggleTrackMode(selectedId)">∿TRANS</button>
            </div>

            <!-- M/S/CLR -->
            <div class="flex gap-[2px]">
              <button class="flex-1 py-[2px] text-[9px] border rounded-sm"
                :style="{ background: selTrack()!.mute ? '#88888833':'transparent', color: selTrack()!.mute ? '#ddd':'#666', borderColor: selTrack()!.mute ? '#888':'#2a2a2a' }"
                @click="doMute(selectedId)">MUTE</button>
              <button class="flex-1 py-[2px] text-[9px] border rounded-sm"
                :style="{ background: selTrack()!.solo ? '#cc990033':'transparent', color: selTrack()!.solo ? '#ffcc55':'#666', borderColor: selTrack()!.solo ? '#cc9900':'#2a2a2a' }"
                @click="doSolo(selectedId)">SOLO</button>
              <button class="py-[2px] px-[6px] text-[9px] border border-[#2a2a2a] bg-transparent text-[#666] rounded-sm hover:text-[#ccc]"
                @click="doClr(selectedId)">CLR</button>
            </div>

            <!-- CH / Note -->
            <div>
              <div class="text-[9px] text-[#555] mb-1 tracking-[1px]">MIDI</div>
              <div class="flex flex-col gap-1">
                <div class="flex items-center gap-1">
                  <span class="text-[9px] text-[#555] w-6">CH</span>
                  <input type="number" min="1" max="16" :value="selTrack()!.midiChannel"
                    class="flex-1 bg-[#111] text-[10px] py-[1px] px-[3px] border border-[#2a2a2a] rounded-sm tabular-nums"
                    @change="(e) => updSel({ midiChannel: Math.max(1,Math.min(16,Number((e.target as HTMLInputElement).value)|0)) })" />
                </div>
                <div class="flex items-center gap-1">
                  <span class="text-[9px] text-[#555] w-6">N</span>
                  <input type="number" min="0" max="127" :value="selTrack()!.midiNote"
                    class="flex-1 bg-[#111] text-[10px] py-[1px] px-[3px] border border-[#2a2a2a] rounded-sm tabular-nums"
                    @change="(e) => updSel({ midiNote: Math.max(0,Math.min(127,Number((e.target as HTMLInputElement).value)|0)) })" />
                </div>
                <div class="flex items-center gap-1">
                  <span class="text-[9px] text-[#555] w-6">VEL</span>
                  <input type="range" min="1" max="127" :value="selTrack()!.midiVelocity"
                    class="flex-1"
                    @input="(e) => updSel({ midiVelocity: Number((e.target as HTMLInputElement).value) })" />
                  <span class="text-[9px] text-[#888] w-6 tabular-nums">{{ selTrack()!.midiVelocity }}</span>
                </div>
                <div class="flex items-center gap-1">
                  <span class="text-[9px] text-[#555] w-6">GT</span>
                  <input type="range" min="10" max="500" step="10" :value="selTrack()!.gateMs"
                    class="flex-1"
                    @input="(e) => updSel({ gateMs: Number((e.target as HTMLInputElement).value) })" />
                  <span class="text-[9px] text-[#888] w-8 tabular-nums">{{ selTrack()!.gateMs }}ms</span>
                </div>
              </div>
            </div>

            <div v-if="pendQ[selectedId]?.length" class="text-[9px] text-[#ff9944]">
              {{ pendQ[selectedId].length }} queued →
            </div>
          </template>
        </div>
      </template>

    </div>

    <!-- ── 画面下端 固定詳細パネル ── -->
    <Transition name="detail-panel">
      <div v-if="detTrk()"
        class="fixed bottom-0 left-0 right-0 z-50 bg-[#0c0c0c] font-mono"
        style="height:168px; border-top: 2px solid"
        :style="{ borderColor: detTrk()!.color + '99' }">

        <!-- ヘッダー行 -->
        <div class="flex items-center gap-2 px-3 border-b border-[#1e1e1e]"
          style="height:32px">
          <!-- カラードット -->
          <div class="w-2 h-2 rounded-full flex-shrink-0" :style="{ background: detTrk()!.color }"></div>
          <!-- トラック名（OFF時はMIDIチャンネル番号） -->
          <span class="text-[12px] font-semibold tracking-[1px] min-w-[40px]"
            :style="{ color: detTrk()!.color }">
            {{ trackEnabled[detailId!] ? detTrk()!.name : detTrk()!.midiChannel }}
          </span>
          <span class="text-[10px] text-[#555]">{{ detTrk()!.timeSig }}</span>
          <!-- Audio On/Off -->
          <button
            class="text-[9px] px-2 py-[2px] border rounded-sm tracking-[1px]"
            :class="trackEnabled[detailId!]
              ? 'bg-[#182818] text-[#88cc88] border-[#336633]'
              : 'bg-transparent text-[#555] border-[#333]'"
            @click="toggleTrackEnabled(detailId!)">
            {{ trackEnabled[detailId!] ? 'ON' : 'OFF' }}
          </button>
          <!-- pending indicator -->
          <span v-if="pendQ[detailId!]?.length" class="text-[9px] text-[#ff9944]">
            {{ pendQ[detailId!].length }} queued →
          </span>
          <button class="ml-auto text-[#555] hover:text-[#ccc] text-[12px] leading-none px-1"
            @click="detailId = null">✕</button>
        </div>

        <!-- コントロール行 -->
        <div class="flex items-center gap-4 px-4 h-[136px]">

          <!-- MeterKnobs -->
          <div class="flex items-end gap-1 flex-shrink-0">
            <MeterKnob :model-value="trkNum(detTrk()!)" :options="NUM_OPTS" :size="36"
              :color="detTrk()!.color" @change="(v) => setTrackNum(detailId!, v)" />
            <span class="text-[14px] text-[#333] pb-2">/</span>
            <MeterKnob :model-value="trkDen(detTrk()!)" :options="DEN_OPTS" :size="36"
              :color="detTrk()!.color" @change="(v) => setTrackDen(detailId!, v)" />
          </div>

          <!-- Mode -->
          <div class="flex gap-0.5 rounded-sm overflow-hidden border border-[#222] flex-shrink-0">
            <button class="text-[9px] px-2 py-1"
              :class="detTrk()!.mode==='instant' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555]'"
              @click="toggleTrackMode(detailId!)">INST</button>
            <button class="text-[9px] px-2 py-1"
              :class="detTrk()!.mode==='transition' ? 'bg-[#2a1a0a] text-[#ff9944]' : 'bg-transparent text-[#555]'"
              @click="toggleTrackMode(detailId!)">TRANS</button>
          </div>

          <!-- M / S / CLR -->
          <div class="flex gap-1 flex-shrink-0">
            <button class="py-1 px-3 text-[9px] border rounded-sm"
              :style="{ background: detTrk()!.mute?'#88888833':'transparent', color: detTrk()!.mute?'#ddd':'#555', borderColor: detTrk()!.mute?'#888':'#2a2a2a' }"
              @click="doMute(detailId!)">M</button>
            <button class="py-1 px-3 text-[9px] border rounded-sm"
              :style="{ background: detTrk()!.solo?'#cc990033':'transparent', color: detTrk()!.solo?'#ffcc55':'#555', borderColor: detTrk()!.solo?'#cc9900':'#2a2a2a' }"
              @click="doSolo(detailId!)">S</button>
            <button class="py-1 px-3 text-[9px] border border-[#2a2a2a] bg-transparent text-[#555] rounded-sm hover:text-[#ccc]"
              @click="doClr(detailId!)">CLR</button>
          </div>

          <!-- 縦区切り -->
          <div class="w-px self-stretch bg-[#222] flex-shrink-0 my-3"></div>

          <!-- MIDI コントロール -->
          <div class="flex flex-col gap-1.5 text-[9px] flex-shrink-0">
            <div class="flex items-center gap-2">
              <span class="text-[#555] w-8">CH</span>
              <input type="number" min="1" max="16" :value="detTrk()!.midiChannel"
                class="bg-[#111] text-[#ccc] border border-[#2a2a2a] rounded-sm px-1 py-0 w-[40px] tabular-nums text-[9px]"
                @change="(e) => { const id=detailId!; const v=Math.max(1,Math.min(16,Number((e.target as HTMLInputElement).value)|0)); tracks.value=tracks.value.map(t=>t.id===id?{...t,midiChannel:v}:t) }" />
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[#555] w-8">NOTE</span>
              <input type="number" min="0" max="127" :value="detTrk()!.midiNote"
                class="bg-[#111] text-[#ccc] border border-[#2a2a2a] rounded-sm px-1 py-0 w-[40px] tabular-nums text-[9px]"
                @change="(e) => { const id=detailId!; const v=Math.max(0,Math.min(127,Number((e.target as HTMLInputElement).value)|0)); tracks.value=tracks.value.map(t=>t.id===id?{...t,midiNote:v}:t) }" />
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[#555] w-8">VEL</span>
              <input type="range" min="1" max="127" :value="detTrk()!.midiVelocity" class="w-[80px]"
                @input="(e) => { const id=detailId!; tracks.value=tracks.value.map(t=>t.id===id?{...t,midiVelocity:Number((e.target as HTMLInputElement).value)}:t) }" />
              <span class="text-[#888] w-5 tabular-nums">{{ detTrk()!.midiVelocity }}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[#555] w-8">GT</span>
              <input type="range" min="10" max="500" step="10" :value="detTrk()!.gateMs" class="w-[80px]"
                @input="(e) => { const id=detailId!; tracks.value=tracks.value.map(t=>t.id===id?{...t,gateMs:Number((e.target as HTMLInputElement).value)}:t) }" />
              <span class="text-[#888] w-10 tabular-nums">{{ detTrk()!.gateMs }}ms</span>
            </div>
          </div>

          <!-- ステップシーケンサー -->
          <div class="flex-1 min-w-0 flex flex-col justify-center gap-1 pl-2 pr-2">
            <div class="text-[8px] text-[#444] tracking-[1px] leading-none">STEPS</div>
            <StepSequencer
              :track="detTrk()!"
              :head="heads[detailId!]"
              :cell-h="60"
              :max-cell-w="40"
              @toggle="(si) => tog(detailId!, si)"
            />
          </div>

        </div>
      </div>
    </Transition>

  </div>
</template>

<style scoped>
/* 詳細パネル スライドアップ */
.detail-panel-enter-active,
.detail-panel-leave-active {
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease;
}
.detail-panel-enter-from,
.detail-panel-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

/* Range sliders: グレー系 */
input[type=range] {
  accent-color: #666;
  cursor: pointer;
}
input[type=range]::-webkit-slider-runnable-track {
  background: #2a2a2a;
  height: 3px;
  border-radius: 2px;
}
input[type=range]::-webkit-slider-thumb {
  background: #888;
  border: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: -3.5px;
  -webkit-appearance: none;
}
input[type=range]::-moz-range-track {
  background: #2a2a2a;
  height: 3px;
  border-radius: 2px;
}
input[type=range]::-moz-range-thumb {
  background: #888;
  border: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
</style>
