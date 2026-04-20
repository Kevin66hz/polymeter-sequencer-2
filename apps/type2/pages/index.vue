<script setup lang="ts">
// Phase 2: this page is now a thin view. All sequencer state and control
// logic lives in `useSequencerStore()` (layers/core/composables). What stays
// here is strictly UI-local concerns: the view-mode toggle, the BPM slider
// overlay state, the MIDI-config file input DOM ref, the global space-bar
// keybinding, and the imperative file download/upload plumbing.
//
// The store is auto-imported via the core layer extended in nuxt.config.ts.

import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
// Components are auto-imported by Nuxt:
//   - MeterKnob / StepCell   — layers/core/components/ (shared primitives)
//   - CircularTrack / ConcentricView / StepSequencer — ./components/ (Type2)

// Build-time badge constants. Injected via Vite `define` in
// nuxt.config.ts — see layers/core/types/globals.d.ts for the ambient
// type declarations. Captured into locals here so the template can
// reference them as normal bindings.
const appVariant = __APP_VARIANT__
const gitBranch = __GIT_BRANCH__
const gitSha = __GIT_SHA__
const gitDirty = __GIT_DIRTY__

// ── Store: single reactive brain (state + scheduler lifecycle) ──────
// Destructuring is safe here: top-level <script setup> bindings preserve
// ref reactivity and enable template auto-unwrap.
const {
  NUM_OPTS, DEN_OPTS,
  bpm, playing, tracks, heads, pendQ, selectedId, detailId, audioOn,
  masterNum, masterDen, masterMode, masterBridgeBars, masterTarget,
  savedSnapshot, showMapping, recording, repeatOn, repeatRate,
  midi, midiIn, midiModifiers,
  hasMidiPresetForDevice, applyMidiPresetForDevice,
  play, stop,
  nudgeOffsetMs, startNudgeHold, stopNudgeHold,
  saveSnapshot, recallSnapshot,
  setTrackNum, setTrackDen, toggleTrackMode,
  onMasterKnobChange, commitMaster,
  toggleStep: tog, doMute, doSolo, doClr,
  // In-app step recording: each track row gets a small pad that appears
  // only when REC is armed (cowork-prompt.md Task B). Reuses the same
  // underlying toggle as the MIDI-IN note-record path so there's one
  // code path for "write a step at the playhead".
  recordStepAtHead,
  onCircleSelect, onBackgroundClick,
  selTrack, detTrk,
  updSel, updDet,
  trkNum, trkDen, pendingSig, displaySig,
  isLearning, toggleLearn, bindingLabel, hasBound,
  allMuted, toggleAllMute,
  effectivePadView, padViewMode, padViewIsTemporary,
} = useSequencerStore()

// ── Pattern presets (genre drum patterns) ───────────────────────────────
// Bundled under /patterns/index.json via the core layer's public/ dir.
//   • top-bar PresetMenu  -> whole-kit preset
//   • per-cell ▾ button   -> role-matched per-track score
const {
  index: presetIndex,
  loading: presetLoading,
  lastAppliedKitId,
  lastAppliedKitName,
  lastAppliedLineByTrack,
  stagedKit,
  loadIndex: loadPresetIndex,
  stageKit,
  applyLineToTrack,
  serializeCurrentAsKit,
  stageKitFromJson,
  applyStagedKit,
  clearStagedKit,
} = usePatternPresets({
  tracks, pendQ, bpm,
  // Respect external MIDI clock — don't let a preset stomp a slaved BPM.
  isBpmLocked: () => midiIn.state.syncMode === 'external',
  // Transition-aware apply: bridges into per-track target meters.
  masterMode, masterBridgeBars, playing,
})

// Beat-repeat rate cycle: 1/2 → 1/4 → 1/8 → 1/16 → loop.
const REPEAT_RATES = [2, 4, 8, 16] as const
function cycleRepeatRate() {
  const i = REPEAT_RATES.indexOf(repeatRate.value as any)
  ;(repeatRate as any).value = REPEAT_RATES[(i < 0 ? 0 : i + 1) % REPEAT_RATES.length]
}

// Head-truncate MIDI device names so long port strings don't blow the row.
function truncDeviceName(name: string | undefined | null, max = 12): string {
  if (!name) return ''
  return name.length > max ? name.slice(0, max) + '…' : name
}

// Unified APPLY click dispatcher. Priority:
//   1. masterTarget in flight → disabled (no-op; button shows ⟳)
//   2. staged kit → commit the kit (transition-aware internally)
//   3. else → commit master N/D (existing behavior)
function onApplyClick() {
  if (masterTarget.value) return
  if (stagedKit.value) { applyStagedKit(); return }
  commitMaster()
}

// ── UI-local state (not shared across UI variants) ──────────────────
type ViewMode = 'grid' | 'concentric'
const viewMode = ref<ViewMode>('grid')
const showBpmOverlay = ref(false)
const midiConfigInput = ref<HTMLInputElement | null>(null)
const kitFileInput = ref<HTMLInputElement | null>(null)
// Kit SAVE popover (non-blocking; window.prompt() stalls the scheduler tick).
const showKitSave = ref(false)
const kitSaveName = ref('My Kit')
const kitSaveInput = ref<HTMLInputElement | null>(null)

// MIDI SAVE / LOAD popovers — split into two independent categories:
//   - TRACKS  : per-track synth settings (channel / note / velocity / gate)
//   - MAPPING : learn bindings + device selection + clock source + syncMode
// Users often want one without the other: e.g. carry a pad-controller
// mapping across kits without stomping the kit's synth channels, or copy
// a kit's synth config without resetting their controller bindings.
// Each popover has two checkboxes driving a single action button.
const showMidiSave = ref(false)
const showMidiLoad = ref(false)
const midiSaveTracks = ref(true)
const midiSaveMapping = ref(true)
const midiLoadTracks = ref(true)
const midiLoadMapping = ref(true)

// ── Global keybind: Space = play/stop (skip when typing in fields) ──
function onGlobalKeyDown(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  const tag = t?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault()
    playing.value ? stop() : play()
  }
}
onMounted(() => { window.addEventListener('keydown', onGlobalKeyDown) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onGlobalKeyDown) })

// ── MIDI config download / upload ───────────────────────────────────
// Split into two independently-saveable categories:
//   TRACKS  : per-track MIDI OUT (ch / note / velocity / gate)
//   MAPPING : learn mappings + syncMode + device selections + clockSource
// Each file carries its own `kind` discriminator so load can refuse to
// apply a tracks-only file to the mapping slot or vice versa. When the
// user checks both on SAVE, a combined file ('midi-all') is written;
// LOAD tolerates both the combined form and either single-category form,
// and only applies categories that the user checked in the LOAD dialog.
// Steps / time signatures are untouched — use KIT SAVE/LOAD for those.
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

// Build the payload sections. Kept as separate builders so the combined
// file is just `{ ...trackSection, ...mappingSection }` — no duplication.
function buildTrackSection() {
  return {
    tracks: tracks.value.map((t, i) => ({
      index: i,
      name: t.name,
      midiChannel: t.midiChannel,
      midiNote: t.midiNote,
      midiVelocity: t.midiVelocity,
      gateMs: t.gateMs,
    })),
  }
}
function buildMappingSection() {
  return {
    mappings: midiIn.state.mappings.map(m => ({ ...m })),
    syncMode: midiIn.state.syncMode,
    selectedOutIds: [...midi.selectedIds.value],
    selectedInIds: [...midiIn.state.selectedIds],
    // `selectedIds` is the key midiIn.loadMappings natively recognizes,
    // so we duplicate alongside the self-documenting `selectedInIds`.
    selectedIds: [...midiIn.state.selectedIds],
    clockSourceId: midiIn.state.clockSourceId,
  }
}

function doMidiSave() {
  const wantTracks = midiSaveTracks.value
  const wantMapping = midiSaveMapping.value
  if (!wantTracks && !wantMapping) { showMidiSave.value = false; return }

  let payload: any
  let filename: string
  if (wantTracks && wantMapping) {
    // Combined — back-compat with older saves.
    payload = { type: 'midi-config', version: 2, ...buildTrackSection(), ...buildMappingSection() }
    filename = 'midi-config.json'
  } else if (wantTracks) {
    payload = { type: 'midi-tracks', version: 2, ...buildTrackSection() }
    filename = 'midi-tracks.json'
  } else {
    payload = { type: 'midi-mapping', version: 2, ...buildMappingSection() }
    filename = 'midi-mapping.json'
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const a = document.createElement('a')
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url)
  showMidiSave.value = false
}

// Apply JUST the track settings half of a config file. Tolerates files
// that don't carry tracks (no-op in that case).
function applyTrackSection(data: any) {
  if (!Array.isArray(data?.tracks)) return
  const byIndex = new Map<number, any>()
  for (const e of data.tracks) {
    if (typeof e?.index === 'number') byIndex.set(e.index, e)
  }
  tracks.value = tracks.value.map((t, i) => {
    const src = byIndex.get(i); if (!src) return t
    return {
      ...t,
      ...(typeof src.midiChannel  === 'number' ? { midiChannel:  clamp(src.midiChannel | 0, 1, 16) }   : {}),
      ...(typeof src.midiNote     === 'number' ? { midiNote:     clamp(src.midiNote    | 0, 0, 127) } : {}),
      ...(typeof src.midiVelocity === 'number' ? { midiVelocity: clamp(src.midiVelocity| 0, 1, 127) } : {}),
      ...(typeof src.gateMs       === 'number' ? { gateMs:       clamp(src.gateMs      | 0, 10, 500) } : {}),
    }
  })
}
// Apply JUST the mapping half. Delegates to midiIn.loadMappings (which
// tolerates extra keys) plus the OUT-selection restore.
function applyMappingSection(text: string, data: any) {
  midiIn.loadMappings(text)
  if (Array.isArray(data?.selectedOutIds)) {
    midi.setOutputs(data.selectedOutIds.filter((x: unknown): x is string => typeof x === 'string'))
  } else if (typeof data?.selectedOutId === 'string' && data.selectedOutId) {
    // Legacy single-OUT fallback.
    midi.setOutputs([data.selectedOutId])
  }
}

function triggerLoadMidiConfig() { midiConfigInput.value?.click() }
function onMidiConfigLoaded(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return
  const reader = new FileReader()
  reader.onload = evt => {
    const text = evt.target?.result as string
    let data: any = null
    try { data = JSON.parse(text) } catch { console.error('Invalid JSON'); return }
    // Apply only the categories the user ticked in the LOAD dialog. The
    // file itself may contain both halves (combined form), tracks only,
    // or mapping only — unchecked categories are silently skipped.
    if (midiLoadMapping.value) applyMappingSection(text, data)
    if (midiLoadTracks.value)  applyTrackSection(data)
    showMidiLoad.value = false
  }
  reader.readAsText(file); (e.target as HTMLInputElement).value = ''
}

// ── Pattern kit SAVE / LOAD (current 16-track state ↔ JSON file) ───────
// SAVE opens a non-blocking popover so playback keeps ticking. A
// `window.prompt()` here would stall the look-ahead scheduler and cause
// audible gaps or a full stop — see README "implementation rules".
async function openKitSave() {
  showKitSave.value = true
  await nextTick()
  kitSaveInput.value?.focus()
  kitSaveInput.value?.select()
}
function doKitSave() {
  const name = (kitSaveName.value || 'My Kit').trim()
  const json = serializeCurrentAsKit(name, 'Custom')
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const a = document.createElement('a')
  const safe = name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'kit'
  a.href = url; a.download = `${safe}.json`; a.click(); URL.revokeObjectURL(url)
  showKitSave.value = false
}
function triggerLoadKit() { kitFileInput.value?.click() }
function onKitFileLoaded(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return
  const reader = new FileReader()
  reader.onload = evt => {
    // LOAD stages the kit — user confirms with APPLY next to the LOAD
    // button. This lets transition mode fire correctly and gives the user
    // a chance to see what kit will be applied before committing.
    const ok = stageKitFromJson(evt.target?.result as string)
    if (!ok) window.alert('Failed to load kit — invalid JSON or missing tracks[].')
  }
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
          <img src="/ibk.svg" alt="IBK" class="h-[14px] w-auto block opacity-40 pointer-events-none select-none" />
          <span class="text-[7px] tracking-[1px] text-[#333] leading-none mt-[3px]">POLY SEQ</span>
          <!-- Build badge: app variant + short git sha. Lets the user
               tell at a glance which branch is running. Dirty repo
               gets a trailing asterisk. Title hover shows the branch
               name in full. -->
          <span
            class="text-[6px] tracking-[0.5px] text-[#2a2a2a] leading-none mt-[2px] font-mono select-none"
            :title="`${appVariant} · ${gitBranch}@${gitSha}${gitDirty ? ' (dirty)' : ''}`"
          >{{ appVariant }} · {{ gitSha }}{{ gitDirty ? '*' : '' }}</span>
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

          <!-- KIT group: PRESET ▾ / SAVE / LOAD.
               Clicking PRESET or LOAD stages a kit; commit via the shared
               APPLY button in the MASTER group to the right (which is
               transition-aware when masterMode='transition'). -->
          <div class="flex items-center gap-1 flex-shrink-0">
            <span class="text-[9px] text-[#444] tracking-[1px]">KIT</span>
            <PresetMenu
              :index="presetIndex"
              :loading="presetLoading"
              :last-applied-kit-id="lastAppliedKitId"
              :last-applied-kit-name="lastAppliedKitName"
              @open="loadPresetIndex"
              @apply-kit="(k) => stageKit(k)" />
            <!-- SAVE current tracks as a kit JSON (non-blocking popover) -->
            <div class="relative z-[15] flex-shrink-0">
              <button
                class="text-[9px] px-2 py-1 border rounded-sm hover:text-[#ccc] tracking-[1px]"
                :class="showKitSave
                  ? 'border-[#555] bg-[#1e1e1e] text-[#ddd]'
                  : 'border-[#333] bg-transparent text-[#666]'"
                title="Download current 16 tracks as a kit JSON"
                @click.stop="showKitSave ? (showKitSave = false) : openKitSave()">SAVE</button>
              <div v-if="showKitSave" class="fixed inset-0 z-[98]" @click="showKitSave=false" />
              <div v-if="showKitSave"
                class="absolute top-full left-0 mt-1 z-[99] bg-[#111] border border-[#333] rounded-sm px-2 py-1.5 flex items-center gap-1.5 shadow-xl"
                @click.stop>
                <span class="text-[8px] tracking-[2px] text-[#555]">NAME</span>
                <input
                  ref="kitSaveInput"
                  v-model="kitSaveName"
                  type="text"
                  class="bg-[#0a0a0a] text-[#ddd] text-[10px] px-1.5 py-[2px] border border-[#2a2a2a] rounded-sm w-[140px]"
                  @keydown.enter.prevent="doKitSave"
                  @keydown.esc.prevent="showKitSave=false" />
                <button
                  class="text-[9px] px-2 py-[3px] border border-[#336633] bg-[#182818] text-[#88cc88] rounded-sm tracking-[1px]"
                  @click="doKitSave">↓ SAVE</button>
                <button
                  class="text-[9px] text-[#555] hover:text-[#ccc] leading-none px-1"
                  @click="showKitSave=false">✕</button>
              </div>
            </div>
            <!-- LOAD a kit JSON — stages it for the shared APPLY button -->
            <button
              class="text-[9px] px-2 py-1 border border-[#333] bg-transparent text-[#666] rounded-sm hover:text-[#ccc] tracking-[1px]"
              title="Load a kit JSON (commit via APPLY)"
              @click="triggerLoadKit">LOAD</button>
            <input ref="kitFileInput" type="file" accept=".json,application/json" style="display:none" @change="onKitFileLoaded" />
          </div>

          <!-- 縦区切り -->
          <div class="w-px self-stretch bg-[#222] my-0.5 flex-shrink-0" />

          <!-- INST / TRANS — single binding (press toggles between modes). -->
          <div class="relative flex-shrink-0">
            <div class="flex gap-0.5 rounded-sm overflow-hidden border border-[#222]">
              <button class="text-[10px] px-2 py-1"
                :class="masterMode==='instant' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555]'"
                @click="masterMode='instant'">INSTANT</button>
              <button class="text-[10px] px-2 py-1"
                :class="masterMode==='transition' ? 'bg-[#2a2a2a] text-[#ff9944]' : 'bg-transparent text-[#555]'"
                @click="masterMode='transition'">TRANSITION</button>
            </div>
            <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
              :class="isLearning('master_mode_toggle') ? 'bg-orange-500/70 animate-pulse' : hasBound('master_mode_toggle') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
              @click="toggleLearn('master_mode_toggle')" @click.right.prevent="midiIn.removeMapping('master_mode_toggle')">
              <span class="text-[7px] text-white leading-none">{{ isLearning('master_mode_toggle') ? '●' : bindingLabel('master_mode_toggle') || 'MODE' }}</span>
            </div>
          </div>

          <!-- BRIDGE — continuous/toggle over 1 or 2 bars. -->
          <div class="relative flex items-center gap-1 flex-shrink-0"
            :style="{ opacity: masterMode==='transition' ? 1 : 0.3, pointerEvents: masterMode==='transition' ? 'auto' : 'none' }">
            <span class="text-[9px] text-[#555] tracking-[1px]">BRIDGE</span>
            <div class="relative flex items-center gap-1">
              <button v-for="b in ([1,2] as const)" :key="b"
                class="text-[10px] px-2 py-1 border rounded-sm"
                :class="masterBridgeBars===b ? 'bg-[#2a2a2a] text-[#ff9944] border-[#ff660066]' : 'bg-transparent text-[#555] border-[#222]'"
                @click="masterBridgeBars=b">{{ b }}</button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('bridge_length') ? 'bg-orange-500/70 animate-pulse' : hasBound('bridge_length') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('bridge_length')" @click.right.prevent="midiIn.removeMapping('bridge_length')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('bridge_length') ? '●' : bindingLabel('bridge_length') || 'BR' }}</span>
              </div>
            </div>
          </div>

          <!-- APPLY (unified: in-flight master transition > staged kit >
               plain master commit). Visible when any of those states hold.
               Adjacent ✕ cancels staged kit without running APPLY. -->
          <div class="flex items-center gap-1 flex-shrink-0"
            :style="{ visibility: (masterMode==='transition' || masterTarget || stagedKit) ? 'visible' : 'hidden' }">
            <div class="relative z-[6]">
              <button
                class="py-[5px] px-2 text-[10px] border rounded-sm tracking-[1px] flex items-center gap-1 min-w-[76px] justify-center"
                :class="
                  masterTarget
                    ? 'bg-[#2a1a0a] text-[#ff9944] border-[#ff660066] cursor-not-allowed'
                    : stagedKit
                      ? (masterMode === 'transition'
                          ? 'bg-[#2a1a0a] text-[#ff9944] border-[#ff660066] hover:text-[#ffb066]'
                          : 'bg-[#182818] text-[#88cc88] border-[#336633] hover:text-[#bfefbf]')
                      : 'bg-[#1a2230] text-[#8faacc] border-[#2a4060] hover:text-[#bcd]'"
                :disabled="!!masterTarget"
                :title="masterTarget
                  ? `Master transition in flight → ${masterTarget}`
                  : stagedKit
                    ? `Apply staged kit: ${stagedKit.name}${masterMode === 'transition' ? ' (transition)' : ''}`
                    : 'Commit master N/D'"
                @click="onApplyClick">
                <template v-if="masterTarget">⟳ {{ masterTarget }}</template>
                <template v-else-if="stagedKit">
                  <span>{{ masterMode === 'transition' ? '∿' : '⏎' }} APPLY</span>
                  <span class="text-[#aaa] text-[9px]">
                    {{ stagedKit.name.length > 4 ? stagedKit.name.slice(0, 4) + '…' : stagedKit.name }}
                  </span>
                </template>
                <template v-else>APPLY</template>
              </button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('master_apply') ? 'bg-orange-500/70 animate-pulse' : hasBound('master_apply') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('master_apply')" @click.right.prevent="midiIn.removeMapping('master_apply')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('master_apply') ? '●' : bindingLabel('master_apply') }}</span>
              </div>
            </div>
            <!-- Cancel staged kit — only meaningful while a kit is staged -->
            <button v-if="stagedKit"
              class="text-[10px] px-1.5 py-[4px] border border-[#333] bg-transparent text-[#555] rounded-sm hover:text-[#ccc] leading-none"
              title="Cancel staged kit"
              @click="clearStagedKit">✕</button>
          </div>

          <!-- 縦区切り -->
          <div class="w-px self-stretch bg-[#222] my-0.5 flex-shrink-0" />

          <!-- SNAP / SHOT — each of SAVE / RECALL / DELETE can be bound to
               a MIDI button. Learn overlays sit on top in MAP mode. -->
          <div class="flex items-center gap-1 flex-shrink-0">
            <span class="text-[9px] text-[#444] tracking-[1px]">SNAP</span>
            <div class="relative">
              <button
                class="text-[10px] px-2 py-[4px] border rounded-sm tracking-[1px]"
                :class="savedSnapshot ? 'bg-[#182818] text-[#88cc88] border-[#336633]' : 'bg-transparent text-[#555] border-[#222] hover:text-[#aaa]'"
                @click="saveSnapshot">{{ savedSnapshot ? '● SHOT' : '○ SHOT' }}</button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('snapshot_save') ? 'bg-orange-500/70 animate-pulse' : hasBound('snapshot_save') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('snapshot_save')" @click.right.prevent="midiIn.removeMapping('snapshot_save')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('snapshot_save') ? '●' : bindingLabel('snapshot_save') }}</span>
              </div>
            </div>
            <div v-if="savedSnapshot" class="relative">
              <button
                class="text-[10px] px-2 py-[4px] border rounded-sm tracking-[1px]"
                :class="masterMode==='transition' ? 'bg-[#1a1a0a] text-[#ffcc44] border-[#554400]' : 'bg-[#1a1a2a] text-[#88aaff] border-[#334488]'"
                @click="recallSnapshot">↩ {{ masterMode==='transition' ? 'TRANS' : 'INST' }}</button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('snapshot_recall') ? 'bg-orange-500/70 animate-pulse' : hasBound('snapshot_recall') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('snapshot_recall')" @click.right.prevent="midiIn.removeMapping('snapshot_recall')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('snapshot_recall') ? '●' : bindingLabel('snapshot_recall') }}</span>
              </div>
            </div>
            <div v-if="savedSnapshot" class="relative">
              <button
                class="text-[10px] px-1.5 py-[4px] border border-[#222] bg-transparent text-[#444] rounded-sm hover:text-[#888]"
                @click="savedSnapshot = null">✕</button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('snapshot_delete') ? 'bg-orange-500/70 animate-pulse' : hasBound('snapshot_delete') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('snapshot_delete')" @click.right.prevent="midiIn.removeMapping('snapshot_delete')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('snapshot_delete') ? '●' : bindingLabel('snapshot_delete') }}</span>
              </div>
            </div>
          </div>

          <!-- ml-auto: 右寄せ -->
          <div class="ml-auto flex items-center gap-2 flex-shrink-0">

            <!-- INT / SYNC toggle — moved from row 2, left of BPM. Only
                 visible when MIDI IN is selected (clock needs a source). -->
            <div v-if="midiIn.state.selectedId"
              class="flex gap-0.5 rounded-sm overflow-hidden border border-[#222] flex-shrink-0">
              <button class="text-[9px] px-1.5 py-1"
                :class="midiIn.state.syncMode==='internal' ? 'bg-[#2a2a2a] text-[#ddd]' : 'bg-transparent text-[#555] hover:text-[#aaa]'"
                @click="midiIn.state.syncMode='internal'">INT</button>
              <button class="text-[9px] px-1.5 py-1"
                :class="[
                  midiIn.state.syncMode==='external' ? 'bg-[#2a2a2a] text-[#8fccaa]' : 'bg-transparent text-[#555] hover:text-[#aaa]',
                  midiIn.state.syncMode==='external' && midiIn.state.clockAlive ? 'animate-pulse' : '',
                ]"
                @click="midiIn.state.syncMode='external'">SYNC</button>
            </div>

            <!-- NUDGE ± — manual phase offset for external-sync fine-tune.
                 Persists to localStorage via the store. Press+hold for
                 slow auto-repeat (400ms delay, 200ms interval); shift
                 multiplies the step to ±5ms. Only visible in external
                 sync mode. -->
            <div v-if="midiIn.state.selectedId && midiIn.state.syncMode==='external'"
              class="flex items-center gap-0.5 rounded-sm overflow-hidden border border-[#222] flex-shrink-0 select-none">
              <button class="text-[9px] px-1.5 py-1 bg-transparent text-[#8fccaa] hover:bg-[#2a2a2a]"
                title="Nudge earlier — press & hold to repeat (−1ms · shift: −5ms)"
                @pointerdown.exact="startNudgeHold(-1)"
                @pointerdown.shift.exact="startNudgeHold(-5)"
                @pointerup="stopNudgeHold"
                @pointerleave="stopNudgeHold"
                @pointercancel="stopNudgeHold">−</button>
              <span class="text-[9px] px-1 py-1 text-[#8fccaa] tabular-nums min-w-[3.4em] text-center"
                :title="`NUDGE offset ${nudgeOffsetMs}ms — applied on next play; persisted.`"
              >{{ nudgeOffsetMs > 0 ? '+' : '' }}{{ nudgeOffsetMs }}ms</span>
              <button class="text-[9px] px-1.5 py-1 bg-transparent text-[#8fccaa] hover:bg-[#2a2a2a]"
                title="Nudge later — press & hold to repeat (+1ms · shift: +5ms)"
                @pointerdown.exact="startNudgeHold(1)"
                @pointerdown.shift.exact="startNudgeHold(5)"
                @pointerup="stopNudgeHold"
                @pointerleave="stopNudgeHold"
                @pointercancel="stopNudgeHold">+</button>
            </div>

            <!-- BPM ボタン + オーバーレイ. When SYNC is engaged, the value
                 shown is the externally-clocked BPM (synced via the store
                 watcher); coloring it green communicates the override. -->
            <div class="relative z-[10] flex-shrink-0">
              <button
                class="text-[11px] border px-2 py-[4px] rounded-sm tabular-nums"
                :class="showBpmOverlay
                  ? 'text-[#ddd] border-[#555] bg-[#1e1e1e]'
                  : midiIn.state.syncMode === 'external' && midiIn.state.selectedId
                    ? 'text-[#8fccaa] border-[#2f5f3f] bg-[#0e1812] hover:text-[#bfefcf]'
                    : 'text-[#888] border-[#222] bg-transparent hover:text-[#ccc]'"
                :title="midiIn.state.syncMode === 'external' && midiIn.state.selectedId
                  ? `SYNC — BPM driven by external clock (${midiIn.state.syncBpm ?? '…'})`
                  : 'BPM'"
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

            <!-- AUDIO ON/OFF — icon only -->
            <button
              class="border w-[26px] h-[24px] flex items-center justify-center text-[13px] rounded-sm flex-shrink-0 leading-none"
              :class="audioOn
                ? 'bg-[#1a2a1a] text-[#8fd08f] border-[#2f5f2f]'
                : 'bg-[#222] text-[#666] border-[#333]'"
              :title="audioOn ? 'AUDIO ON — click to silence' : 'AUDIO OFF — click to send'"
              @click="audioOn = !audioOn">{{ audioOn ? '♪' : '✕' }}</button>

            <!-- REC — transport modifier, sits left of PLAY -->
            <div class="relative flex-shrink-0">
              <button
                class="border w-[26px] h-[24px] flex items-center justify-center text-[13px] rounded-sm leading-none"
                :class="recording
                  ? 'bg-[#2a1010] text-[#ff4040] border-[#aa2020] animate-pulse'
                  : 'bg-transparent text-[#555] border-[#333] hover:text-[#aaa]'"
                :title="recording
                  ? 'REC armed — click to disarm. Incoming notes write steps at playhead.'
                  : 'REC disarmed — click to arm. Requires MIDI IN + PLAY.'"
                @click="recording = !recording">●</button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('rec_toggle') ? 'bg-orange-500/70 animate-pulse' : hasBound('rec_toggle') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('rec_toggle')" @click.right.prevent="midiIn.removeMapping('rec_toggle')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('rec_toggle') ? '●' : bindingLabel('rec_toggle') || '●' }}</span>
              </div>
            </div>

            <!-- PLAY / STOP — icon only -->
            <div class="relative z-[6] flex-shrink-0">
              <button class="border-0 w-[32px] h-[24px] flex items-center justify-center text-[13px] leading-none"
                :class="playing ? 'bg-[#c03030] text-[#ffaaaa]' : 'bg-[#206020] text-[#aaffaa]'"
                :title="playing ? 'STOP (Space)' : 'PLAY (Space)'"
                @click="playing ? stop() : play()">{{ playing ? '■' : '▶' }}</button>
              <div v-if="showMapping" class="absolute inset-0 flex gap-px">
                <div class="flex-1 cursor-pointer flex items-center justify-center text-[7px] text-white"
                  :class="isLearning('transport_play') ? 'bg-orange-500/80 animate-pulse' : hasBound('transport_play') ? 'bg-blue-500/50' : 'bg-white/10 hover:bg-white/25'"
                  @click="toggleLearn('transport_play')"
                  @click.right.prevent="midiIn.removeMapping('transport_play')">{{ isLearning('transport_play') ? '●' : bindingLabel('transport_play') || '▶' }}</div>
                <div class="flex-1 cursor-pointer flex items-center justify-center text-[7px] text-white"
                  :class="isLearning('transport_toggle') ? 'bg-orange-500/80 animate-pulse' : hasBound('transport_toggle') ? 'bg-blue-500/50' : 'bg-white/10 hover:bg-white/25'"
                  @click="toggleLearn('transport_toggle')"
                  @click.right.prevent="midiIn.removeMapping('transport_toggle')">{{ isLearning('transport_toggle') ? '●' : bindingLabel('transport_toggle') || '⇄' }}</div>
                <div class="flex-1 cursor-pointer flex items-center justify-center text-[7px] text-white"
                  :class="isLearning('transport_stop') ? 'bg-orange-500/80 animate-pulse' : hasBound('transport_stop') ? 'bg-blue-500/50' : 'bg-white/10 hover:bg-white/25'"
                  @click="toggleLearn('transport_stop')"
                  @click.right.prevent="midiIn.removeMapping('transport_stop')">{{ isLearning('transport_stop') ? '●' : bindingLabel('transport_stop') || '■' }}</div>
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

          <!-- MIDI OUT — multi-device broadcast. All selected outs receive
               the same note; receivers filter by channel. -->
          <MidiDeviceMultiSelect
            label="MIDI OUT"
            :devices="midi.outputs.value"
            :selected-ids="midi.selectedIds.value"
            :disabled="!midi.supported.value"
            @toggle="(id: string) => midi.toggleOutput(id)" />

          <!-- MIDI IN — multi-device. Shared mapping table applies regardless
               of origin; the ◷-marked chip is the clock source. -->
          <MidiDeviceMultiSelect
            label="MIDI IN"
            :devices="midiIn.state.inputs.map((i: any) => ({ id: i.id, name: i.name || i.id }))"
            :selected-ids="midiIn.state.selectedIds"
            :clock-source="midiIn.state.clockSourceId"
            :has-preset="hasMidiPresetForDevice"
            :disabled="!midiIn.state.supported"
            @toggle="(id: string) => midiIn.toggleInput(id)"
            @set-clock-source="(id: string | null) => midiIn.setClockSource(id)"
            @apply-preset="(id: string, name: string) => applyMidiPresetForDevice(id, name)" />

          <!-- Clock sync moved to row 1 (left of BPM). -->

          <!-- MAPPING toggle — only visible with MIDI IN selected -->
          <div v-if="midiIn.state.selectedId" class="flex items-center gap-1">
            <button class="text-[9px] px-2 py-1 border rounded-sm flex items-center gap-1"
              :class="showMapping ? 'bg-[#2a2a2a] text-[#ddd] border-[#555]' : 'bg-transparent text-[#666] border-[#333]'"
              @click="showMapping=!showMapping">
              <span>MAP</span>
              <span class="text-[8px] px-1 rounded-sm tabular-nums"
                :class="midiIn.state.mappings.length > 0 ? 'bg-[#182818] text-[#88cc88]' : 'bg-[#1a1a1a] text-[#555]'">
                {{ midiIn.state.mappings.length }}
              </span>
            </button>
          </div>

          <!-- Modifier keys (D / M / S / R) — Learn chips that light up
               when the hardware button is held. Only visible in MAP mode,
               per LC XL MK2 preset spec §パッド挙動. -->
          <div v-if="showMapping" class="flex items-center gap-1 flex-shrink-0">
            <span class="text-[9px] text-[#444] tracking-[1px]">MOD</span>
            <button v-for="m in ([
              { id: 'mod_d', key: 'd' as const, label: 'D' },
              { id: 'mod_m', key: 'm' as const, label: 'M' },
              { id: 'mod_s', key: 's' as const, label: 'S' },
              { id: 'mod_r', key: 'r' as const, label: 'R' },
            ])" :key="m.id"
              class="relative w-[22px] h-[22px] text-[9px] border rounded-sm flex items-center justify-center leading-none"
              :class="[
                midiModifiers.state[m.key]
                  ? 'bg-[#2a1a0a] text-[#ffaa44] border-[#aa6622]'
                  : isLearning(m.id)
                    ? 'bg-orange-500/70 text-white border-orange-400 animate-pulse'
                    : hasBound(m.id)
                      ? 'bg-[#1a2a3a] text-[#8faacc] border-[#2a4060]'
                      : 'bg-transparent text-[#555] border-[#333] hover:text-[#aaa]',
              ]"
              :title="`${m.label} modifier — click to Learn, right-click to clear. ${bindingLabel(m.id)}`"
              @click="toggleLearn(m.id)"
              @click.right.prevent="midiIn.removeMapping(m.id)">
              {{ isLearning(m.id) ? '●' : m.label }}
            </button>
          </div>

          <!-- MIDI SAVE / LOAD — popover modals with per-category checkboxes
               so track config and controller mappings can move independently. -->
          <div class="flex items-center gap-1">
            <span class="text-[10px] text-[#444]">MIDI</span>

            <!-- SAVE popover -->
            <div class="relative">
              <button
                class="text-[9px] px-2 py-1 border rounded-sm tracking-[1px]"
                :class="showMidiSave
                  ? 'border-[#555] bg-[#1e1e1e] text-[#ddd]'
                  : 'border-[#333] bg-transparent text-[#666] hover:text-[#ccc]'"
                title="Save MIDI config — choose tracks / mappings / both"
                @click.stop="showMidiSave = !showMidiSave; showMidiLoad = false">SAVE</button>
              <div v-if="showMidiSave" class="fixed inset-0 z-[98]" @click="showMidiSave=false" />
              <div v-if="showMidiSave"
                class="absolute top-full left-0 mt-1 z-[99] bg-[#111] border border-[#333] rounded-sm px-3 py-2 shadow-xl min-w-[240px]"
                @click.stop>
                <div class="flex items-center justify-between mb-2">
                  <span class="text-[9px] tracking-[2px] text-[#777]">MIDI SAVE</span>
                  <button class="text-[10px] text-[#555] hover:text-[#ccc] leading-none px-1"
                    @click="showMidiSave=false">✕</button>
                </div>
                <label class="flex items-center gap-2 text-[10px] text-[#ccc] py-0.5 cursor-pointer select-none">
                  <input type="checkbox" class="accent-[#88aaee]" v-model="midiSaveTracks" />
                  <span class="flex-1">TRACKS</span>
                  <span class="text-[9px] text-[#555]">ch / note / vel / gate</span>
                </label>
                <label class="flex items-center gap-2 text-[10px] text-[#ccc] py-0.5 cursor-pointer select-none">
                  <input type="checkbox" class="accent-[#88aaee]" v-model="midiSaveMapping" />
                  <span class="flex-1">MAPPING</span>
                  <span class="text-[9px] text-[#555]">learn / devices / clock</span>
                </label>
                <div class="mt-2 flex justify-end">
                  <button
                    class="text-[9px] px-2 py-[3px] border rounded-sm tracking-[1px]"
                    :class="(midiSaveTracks || midiSaveMapping)
                      ? 'border-[#336633] bg-[#182818] text-[#88cc88]'
                      : 'border-[#333] bg-[#1a1a1a] text-[#555] cursor-not-allowed'"
                    :disabled="!midiSaveTracks && !midiSaveMapping"
                    @click="doMidiSave">↓ DOWNLOAD</button>
                </div>
              </div>
            </div>

            <!-- LOAD popover -->
            <div class="relative">
              <button
                class="text-[9px] px-2 py-1 border rounded-sm tracking-[1px]"
                :class="showMidiLoad
                  ? 'border-[#555] bg-[#1e1e1e] text-[#ddd]'
                  : 'border-[#333] bg-transparent text-[#666] hover:text-[#ccc]'"
                title="Load MIDI config — choose which categories to apply"
                @click.stop="showMidiLoad = !showMidiLoad; showMidiSave = false">LOAD</button>
              <div v-if="showMidiLoad" class="fixed inset-0 z-[98]" @click="showMidiLoad=false" />
              <div v-if="showMidiLoad"
                class="absolute top-full left-0 mt-1 z-[99] bg-[#111] border border-[#333] rounded-sm px-3 py-2 shadow-xl min-w-[240px]"
                @click.stop>
                <div class="flex items-center justify-between mb-2">
                  <span class="text-[9px] tracking-[2px] text-[#777]">MIDI LOAD</span>
                  <button class="text-[10px] text-[#555] hover:text-[#ccc] leading-none px-1"
                    @click="showMidiLoad=false">✕</button>
                </div>
                <label class="flex items-center gap-2 text-[10px] text-[#ccc] py-0.5 cursor-pointer select-none">
                  <input type="checkbox" class="accent-[#88aaee]" v-model="midiLoadTracks" />
                  <span class="flex-1">TRACKS</span>
                  <span class="text-[9px] text-[#555]">apply per-track MIDI</span>
                </label>
                <label class="flex items-center gap-2 text-[10px] text-[#ccc] py-0.5 cursor-pointer select-none">
                  <input type="checkbox" class="accent-[#88aaee]" v-model="midiLoadMapping" />
                  <span class="flex-1">MAPPING</span>
                  <span class="text-[9px] text-[#555]">apply learn / devices / clock</span>
                </label>
                <div class="mt-2 flex justify-end">
                  <button
                    class="text-[9px] px-2 py-[3px] border rounded-sm tracking-[1px]"
                    :class="(midiLoadTracks || midiLoadMapping)
                      ? 'border-[#556677] bg-[#1a2a3a] text-[#aac]'
                      : 'border-[#333] bg-[#1a1a1a] text-[#555] cursor-not-allowed'"
                    :disabled="!midiLoadTracks && !midiLoadMapping"
                    @click="triggerLoadMidiConfig">📁 SELECT FILE…</button>
                </div>
              </div>
            </div>

            <input ref="midiConfigInput" type="file" accept=".json" style="display:none" @change="onMidiConfigLoaded" />
          </div>

          <!-- REP + rate — note repeat just left of ALL MUTE -->
          <div class="ml-auto flex items-center gap-1 flex-shrink-0">
            <span class="text-[9px] text-[#444] tracking-[1px]">REP</span>
            <div class="relative">
              <button
                class="border w-[26px] h-[24px] flex items-center justify-center text-[13px] rounded-sm leading-none"
                :class="repeatOn
                  ? 'bg-[#0e1a2a] text-[#4aa0ff] border-[#2060aa]'
                  : 'bg-transparent text-[#555] border-[#333] hover:text-[#aaa]'"
                :title="repeatOn
                  ? 'Note Repeat ON — hold a pad to auto-fire at 1/' + repeatRate
                  : 'Note Repeat OFF'"
                @click="repeatOn = !repeatOn">⟳</button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('repeat_trigger') ? 'bg-orange-500/70 animate-pulse' : hasBound('repeat_trigger') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('repeat_trigger')" @click.right.prevent="midiIn.removeMapping('repeat_trigger')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('repeat_trigger') ? '●' : bindingLabel('repeat_trigger') || '⟳' }}</span>
              </div>
            </div>
            <div class="relative">
              <button
                class="border h-[24px] px-1.5 flex items-center justify-center text-[9px] rounded-sm leading-none tabular-nums"
                :class="repeatOn
                  ? 'bg-[#0e1a2a] text-[#88bbff] border-[#2060aa]'
                  : 'bg-transparent text-[#555] border-[#333] hover:text-[#aaa]'"
                title="Click to cycle rate (1/2 → 1/4 → 1/8 → 1/16)"
                @click="cycleRepeatRate">1/{{ repeatRate }}</button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('repeat_length') ? 'bg-orange-500/70 animate-pulse' : hasBound('repeat_length') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('repeat_length')" @click.right.prevent="midiIn.removeMapping('repeat_length')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('repeat_length') ? '●' : bindingLabel('repeat_length') || 'RT' }}</span>
              </div>
            </div>
          </div>

          <!-- PAD VIEW — current effective view (MUTE / SOLO / REC).
               Dimmer while idle; lights up + italicises while M or S is
               held on the LC XL MK2 (temporary override). During
               recording, the badge turns amber and the pads pulse in
               sync with each track's playhead. -->
          <div class="flex items-center gap-1 flex-shrink-0" title="Pad LED view (MUTE / SOLO / REC). Hold M or S on LC XL MK2 to temporarily switch. REC mode pulses amber on each step.">
            <span class="text-[9px] text-[#444] tracking-[1px]">VIEW</span>
            <span
              class="text-[10px] px-2 py-[4px] border rounded-sm tracking-[1px] tabular-nums select-none"
              :class="[
                padViewIsTemporary ? 'italic' : '',
                padViewMode === 'rec'
                  ? 'bg-[#2a2010] text-[#ffcc66] border-[#aa7733] animate-pulse'
                  : padViewMode === 'mute'
                    ? (padViewIsTemporary
                      ? 'bg-[#2a1a1a] text-[#ffbbbb] border-[#aa5555]'
                      : 'bg-[#1a1010] text-[#cc8888] border-[#442222]')
                    : (padViewIsTemporary
                      ? 'bg-[#1a2a10] text-[#ddffaa] border-[#66aa44]'
                      : 'bg-[#101a10] text-[#88cc88] border-[#224422]')
              ]">{{ padViewMode === 'rec' ? 'REC' : padViewMode === 'mute' ? 'MUTE' : 'SOLO' }}</span>
          </div>

          <!-- ALL MUTE — right edge; solo-aware in the store -->
          <div class="flex items-center gap-1 flex-shrink-0">
            <span class="text-[9px] text-[#444] tracking-[1px]">MUTE</span>
            <div class="relative">
              <button
                class="text-[10px] px-2 py-[4px] border rounded-sm tracking-[1px]"
                :class="allMuted ? 'bg-[#2a1a1a] text-[#dd8888] border-[#664444]' : 'bg-transparent text-[#555] border-[#222] hover:text-[#aaa]'"
                @click="toggleAllMute">⊘ ALL M</button>
              <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                :class="isLearning('all_mute') ? 'bg-orange-500/70 animate-pulse' : hasBound('all_mute') ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                @click="toggleLearn('all_mute')" @click.right.prevent="midiIn.removeMapping('all_mute')">
                <span class="text-[7px] text-white leading-none">{{ isLearning('all_mute') ? '●' : bindingLabel('all_mute') || 'ALL' }}</span>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- Mapping dim layer -->
    <div v-if="showMapping" class="fixed inset-0 z-[5] pointer-events-none" style="background:rgba(0,0,0,0.55)" />

    <!-- ── BODY ── -->
    <div class="flex-1 flex min-h-0 overflow-hidden">

      <!-- ── GRID VIEW: 8×2、スクロールなし ── -->
      <div v-if="viewMode==='grid'" class="flex-1 min-h-0 p-2" @click="onBackgroundClick">
        <div class="grid grid-cols-8 grid-rows-2 gap-2 h-full">
          <div v-for="trk in tracks" :key="trk.id"
            class="border flex flex-col min-h-0 px-1.5 py-1 gap-1 transition-all"
            :style="{
              borderColor: trk.solo ? trk.color+'99' : pendQ[trk.id].length ? trk.color+'44' : '#161616',
              background: trk.solo ? '#1c1a10' : '#0e0e0e',
              boxShadow: trk.solo ? ('0 0 8px 2px ' + trk.color + '44') : 'none',
            }"
            :class="{
              'opacity-30': trk.mute || (tracks.some(t=>t.solo) && !trk.solo),
            }">

            <!-- Top row: name + knobs (size 28) -->
            <div class="flex items-center justify-between flex-shrink-0">
              <div class="flex items-center gap-1 min-w-0" @click.stop>
                <span class="text-[8px] tracking-[1px] font-semibold truncate"
                  :style="{ color: trk.color }">
                  {{ audioOn ? trk.name : `${trk.midiChannel}-${trk.midiNote}` }}</span>
                <PatternPicker
                  :index="presetIndex"
                  :loading="presetLoading"
                  :track-name="trk.name"
                  :track-color="trk.color"
                  :last-applied-line-id="lastAppliedLineByTrack[trk.id] ?? null"
                  @open="loadPresetIndex"
                  @apply-line="(l) => applyLineToTrack(trk.id, l)" />
              </div>
              <div class="flex items-center gap-0.5 relative" @click.stop>
                <div class="relative">
                  <MeterKnob :model-value="trkNum(trk)" :options="NUM_OPTS" :size="28" :color="trk.color" @change="(v) => setTrackNum(trk.id, v)" />
                  <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-full"
                    :class="isLearning(`track${trk.id}_n`) ? 'bg-orange-500/70 animate-pulse' : hasBound(`track${trk.id}_n`) ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                    @click="toggleLearn(`track${trk.id}_n`)" @click.right.prevent="midiIn.removeMapping(`track${trk.id}_n`)">
                    <span class="text-[7px] text-white leading-none">{{ isLearning(`track${trk.id}_n`) ? '●' : bindingLabel(`track${trk.id}_n`) || 'N' }}</span>
                  </div>
                </div>
                <span class="text-[9px] text-[#333]">/</span>
                <div class="relative">
                  <MeterKnob :model-value="trkDen(trk)" :options="DEN_OPTS" :size="28" :color="trk.color" @change="(v) => setTrackDen(trk.id, v)" />
                  <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-full"
                    :class="isLearning(`track${trk.id}_d`) ? 'bg-orange-500/70 animate-pulse' : hasBound(`track${trk.id}_d`) ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                    @click="toggleLearn(`track${trk.id}_d`)" @click.right.prevent="midiIn.removeMapping(`track${trk.id}_d`)">
                    <span class="text-[7px] text-white leading-none">{{ isLearning(`track${trk.id}_d`) ? '●' : bindingLabel(`track${trk.id}_d`) || 'D' }}</span>
                  </div>
                </div>
                <span v-if="pendingSig(trk.id)" class="absolute -top-0.5 -right-0.5 w-[5px] h-[5px] rounded-full bg-[#ff6600]" />
              </div>
            </div>

            <!-- Circle -->
            <div class="flex-1 min-h-0 min-w-0 flex justify-center items-center overflow-visible">
              <CircularTrack
                :track="trk" :head="heads[trk.id]" :selected="selectedId === trk.id"
                :audio-on="audioOn"
                :detail-active="detailId === trk.id"
                @select="onCircleSelect(trk.id)"
                @toggle="(si) => tog(trk.id, si)"
                @open-detail="detailId = detailId === trk.id ? null : trk.id" />
            </div>

            <!-- Bottom row: M/S/CLR + REC pad (REC pad only while armed).
                 In MAP mode, the REC-pad slot shows a Learn overlay so
                 `trackN_rec` can be bound even when REC is disarmed. -->
            <div class="flex items-center justify-start flex-shrink-0">
              <div class="flex gap-[3px]">
                <div class="relative">
                  <button class="py-[2px] px-[6px] text-[9px] border rounded-sm"
                    :style="{ background: trk.mute?'#88888833':'transparent', color: trk.mute?'#ddd':'#555', borderColor: trk.mute?'#888':'#2a2a2a' }"
                    @click.stop="doMute(trk.id)">M</button>
                  <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                    :class="isLearning(`track${trk.id}_mute`) ? 'bg-orange-500/70 animate-pulse' : hasBound(`track${trk.id}_mute`) ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                    @click.stop="toggleLearn(`track${trk.id}_mute`)" @click.right.prevent="midiIn.removeMapping(`track${trk.id}_mute`)">
                    <span class="text-[7px] text-white leading-none">{{ isLearning(`track${trk.id}_mute`) ? '●' : bindingLabel(`track${trk.id}_mute`) || 'M' }}</span>
                  </div>
                </div>
                <div class="relative">
                  <button class="py-[2px] px-[6px] text-[9px] border rounded-sm"
                    :style="{ background: trk.solo?'#cc990033':'transparent', color: trk.solo?'#ffcc55':'#555', borderColor: trk.solo?'#cc9900':'#2a2a2a' }"
                    @click.stop="doSolo(trk.id)">S</button>
                  <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                    :class="isLearning(`track${trk.id}_solo`) ? 'bg-orange-500/70 animate-pulse' : hasBound(`track${trk.id}_solo`) ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                    @click.stop="toggleLearn(`track${trk.id}_solo`)" @click.right.prevent="midiIn.removeMapping(`track${trk.id}_solo`)">
                    <span class="text-[7px] text-white leading-none">{{ isLearning(`track${trk.id}_solo`) ? '●' : bindingLabel(`track${trk.id}_solo`) || 'S' }}</span>
                  </div>
                </div>
                <div class="relative">
                  <button class="py-[2px] px-[6px] text-[9px] border border-[#2a2a2a] bg-transparent text-[#555] rounded-sm hover:text-[#ccc]"
                    @click.stop="doClr(trk.id)">✕</button>
                  <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                    :class="isLearning(`track${trk.id}_clear`) ? 'bg-orange-500/70 animate-pulse' : hasBound(`track${trk.id}_clear`) ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20'"
                    @click.stop="toggleLearn(`track${trk.id}_clear`)" @click.right.prevent="midiIn.removeMapping(`track${trk.id}_clear`)">
                    <span class="text-[7px] text-white leading-none">{{ isLearning(`track${trk.id}_clear`) ? '●' : bindingLabel(`track${trk.id}_clear`) || '✕' }}</span>
                  </div>
                </div>
                <!-- REC pad slot. The pad itself is only rendered while REC is
                     armed (keeps the row compact), but the Learn overlay must
                     stay bindable regardless — placed in a fixed-width slot so
                     the surface exists even when the pad is hidden. -->
                <div v-if="recording || showMapping" class="relative w-[22px] h-[17px]">
                  <button v-if="recording"
                    class="absolute inset-0 text-[9px] border rounded-sm leading-none"
                    :class="playing
                      ? 'border-[#aa2a2a] bg-[#2a0d0d] text-[#ff6666] hover:bg-[#3a1414]'
                      : 'border-[#2a2a2a] bg-transparent text-[#555] cursor-not-allowed'"
                    :title="playing
                      ? 'Toggle step at current playhead for this track'
                      : 'Start playback to place steps'"
                    :disabled="!playing"
                    @click.stop="recordStepAtHead(trk.id)">●</button>
                  <div v-if="showMapping" class="absolute inset-0 cursor-pointer flex items-center justify-center rounded-sm"
                    :class="isLearning(`track${trk.id}_rec`) ? 'bg-orange-500/70 animate-pulse' : hasBound(`track${trk.id}_rec`) ? 'bg-blue-500/40' : 'bg-white/10 hover:bg-white/20 border border-[#2a2a2a]'"
                    @click.stop="toggleLearn(`track${trk.id}_rec`)" @click.right.prevent="midiIn.removeMapping(`track${trk.id}_rec`)">
                    <span class="text-[7px] text-white leading-none">{{ isLearning(`track${trk.id}_rec`) ? '●' : bindingLabel(`track${trk.id}_rec`) || '●' }}</span>
                  </div>
                </div>
              </div>
            </div>


          </div>
        </div>
      </div>

      <!-- ── CONCENTRIC VIEW ── -->
      <template v-else>
        <div class="flex-1 overflow-y-auto flex justify-center items-start p-3" @click="onBackgroundClick">
          <ConcentricView
            :tracks="tracks" :heads="heads" :selected-id="selectedId"
            :audio-on="audioOn"
            @select="onCircleSelect($event)"
            @toggle="(ti, si) => tog(ti, si)" />
        </div>

        <!-- Right panel: selected track detail -->
        <div class="w-[180px] bg-[#0c0c0c] border-l border-[#1e1e1e] p-3 flex flex-col gap-3 overflow-y-auto flex-shrink-0 text-[11px]"
          @click.stop>
          <template v-if="selTrack()">
            <div class="font-semibold tracking-[1px] pb-1 border-b"
              :style="{ color: selTrack()!.color, borderColor: selTrack()!.color+'44' }">
              {{ selTrack()!.name }} <span class="text-[#555] text-[9px]">{{ displaySig(selTrack()!) }}</span>
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

            <!-- M/S/CLR + REC pad (REC pad only while armed) -->
            <div class="flex gap-[2px]">
              <button class="flex-1 py-[2px] text-[9px] border rounded-sm"
                :style="{ background: selTrack()!.mute ? '#88888833':'transparent', color: selTrack()!.mute ? '#ddd':'#666', borderColor: selTrack()!.mute ? '#888':'#2a2a2a' }"
                @click="doMute(selectedId)">MUTE</button>
              <button class="flex-1 py-[2px] text-[9px] border rounded-sm"
                :style="{ background: selTrack()!.solo ? '#cc990033':'transparent', color: selTrack()!.solo ? '#ffcc55':'#666', borderColor: selTrack()!.solo ? '#cc9900':'#2a2a2a' }"
                @click="doSolo(selectedId)">SOLO</button>
              <button class="py-[2px] px-[6px] text-[9px] border border-[#2a2a2a] bg-transparent text-[#666] rounded-sm hover:text-[#ccc]"
                @click="doClr(selectedId)">CLR</button>
              <button v-if="recording"
                class="py-[2px] px-[6px] text-[9px] border rounded-sm leading-none"
                :class="playing
                  ? 'border-[#aa2a2a] bg-[#2a0d0d] text-[#ff6666] hover:bg-[#3a1414]'
                  : 'border-[#2a2a2a] bg-transparent text-[#555] cursor-not-allowed'"
                :title="playing
                  ? 'Toggle step at current playhead for this track'
                  : 'Start playback to place steps'"
                :disabled="!playing"
                @click="recordStepAtHead(selectedId)">●</button>
            </div>

            <!-- CH / Note -->
            <div>
              <div class="text-[9px] text-[#555] mb-1 tracking-[1px]">MIDI</div>
              <div class="flex flex-col gap-1">
                <div class="flex items-center gap-1">
                  <span class="text-[9px] text-[#555] w-6">CH</span>
                  <input type="number" min="1" max="16" :value="selTrack()!.midiChannel"
                    class="flex-1 bg-[#111] text-[10px] py-[1px] px-[3px] border border-[#2a2a2a] rounded-sm tabular-nums"
                    @input="(e) => updSel({ midiChannel: Math.max(1,Math.min(16,Number((e.target as HTMLInputElement).value)|0)) })" />
                </div>
                <div class="flex items-center gap-1">
                  <span class="text-[9px] text-[#555] w-6">N</span>
                  <input type="number" min="0" max="127" :value="selTrack()!.midiNote"
                    class="flex-1 bg-[#111] text-[10px] py-[1px] px-[3px] border border-[#2a2a2a] rounded-sm tabular-nums"
                    @input="(e) => updSel({ midiNote: Math.max(0,Math.min(127,Number((e.target as HTMLInputElement).value)|0)) })" />
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
        :style="{ borderColor: detTrk()!.color + '99' }"
        @click.stop>

        <!-- ヘッダー行 -->
        <div class="flex items-center gap-2 px-3 border-b border-[#1e1e1e]"
          style="height:32px">
          <!-- カラードット -->
          <div class="w-2 h-2 rounded-full flex-shrink-0" :style="{ background: detTrk()!.color }"></div>
          <!-- トラック名 -->
          <span class="text-[12px] font-semibold tracking-[1px] min-w-[40px]"
            :style="{ color: detTrk()!.color }">
            {{ detTrk()!.name }}
          </span>
          <span class="text-[10px] text-[#555]">{{ displaySig(detTrk()!) }}</span>
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

          <!-- M / S / CLR + REC pad (REC pad only while armed) -->
          <div class="flex gap-1 flex-shrink-0">
            <button class="py-1 px-3 text-[9px] border rounded-sm"
              :style="{ background: detTrk()!.mute?'#88888833':'transparent', color: detTrk()!.mute?'#ddd':'#555', borderColor: detTrk()!.mute?'#888':'#2a2a2a' }"
              @click="doMute(detailId!)">M</button>
            <button class="py-1 px-3 text-[9px] border rounded-sm"
              :style="{ background: detTrk()!.solo?'#cc990033':'transparent', color: detTrk()!.solo?'#ffcc55':'#555', borderColor: detTrk()!.solo?'#cc9900':'#2a2a2a' }"
              @click="doSolo(detailId!)">S</button>
            <button class="py-1 px-3 text-[9px] border border-[#2a2a2a] bg-transparent text-[#555] rounded-sm hover:text-[#ccc]"
              @click="doClr(detailId!)">CLR</button>
            <button v-if="recording"
              class="py-1 px-3 text-[9px] border rounded-sm leading-none"
              :class="playing
                ? 'border-[#aa2a2a] bg-[#2a0d0d] text-[#ff6666] hover:bg-[#3a1414]'
                : 'border-[#2a2a2a] bg-transparent text-[#555] cursor-not-allowed'"
              :title="playing
                ? 'Toggle step at current playhead for this track'
                : 'Start playback to place steps'"
              :disabled="!playing"
              @click="recordStepAtHead(detailId!)">●</button>
          </div>

          <!-- 縦区切り -->
          <div class="w-px self-stretch bg-[#222] flex-shrink-0 my-3"></div>

          <!-- MIDI コントロール -->
          <div class="flex flex-col gap-1.5 text-[9px] flex-shrink-0">
            <div class="flex items-center gap-2">
              <span class="text-[#555] w-8">CH</span>
              <input type="number" min="1" max="16" :value="detTrk()!.midiChannel"
                class="bg-[#111] text-[#ccc] border border-[#2a2a2a] rounded-sm px-1 py-0 w-[40px] tabular-nums text-[9px]"
                @input="(e) => updDet({ midiChannel: Math.max(1,Math.min(16,Number((e.target as HTMLInputElement).value)|0)) })" />
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[#555] w-8">NOTE</span>
              <input type="number" min="0" max="127" :value="detTrk()!.midiNote"
                class="bg-[#111] text-[#ccc] border border-[#2a2a2a] rounded-sm px-1 py-0 w-[40px] tabular-nums text-[9px]"
                @input="(e) => updDet({ midiNote: Math.max(0,Math.min(127,Number((e.target as HTMLInputElement).value)|0)) })" />
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[#555] w-8">VEL</span>
              <input type="range" min="1" max="127" :value="detTrk()!.midiVelocity" class="w-[80px]"
                @input="(e) => updDet({ midiVelocity: Number((e.target as HTMLInputElement).value) })" />
              <span class="text-[#888] w-5 tabular-nums">{{ detTrk()!.midiVelocity }}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[#555] w-8">GT</span>
              <input type="range" min="10" max="500" step="10" :value="detTrk()!.gateMs" class="w-[80px]"
                @input="(e) => updDet({ gateMs: Number((e.target as HTMLInputElement).value) })" />
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
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  accent-color: #666;
  cursor: pointer;
}
input[type=range]::-webkit-slider-runnable-track {
  background: #2a2a2a;
  height: 3px;
  border-radius: 2px;
}
input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  background: #888;
  border: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: -3.5px;
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
