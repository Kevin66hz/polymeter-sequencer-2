<script setup lang="ts">
// Phase 2: this page is now a thin view. All sequencer state and control
// logic lives in `useSequencerStore()` (layers/core/composables). What stays
// here is strictly UI-local concerns: the view-mode toggle, the BPM slider
// overlay state, the MIDI-config file input DOM ref, the global space-bar
// keybinding, and the imperative file download/upload plumbing.
//
// The store is auto-imported via the core layer extended in nuxt.config.ts.

import { onBeforeUnmount, onMounted, ref } from 'vue'
// Components are auto-imported by Nuxt:
//   - MeterKnob / StepCell   — layers/core/components/ (shared primitives)
//   - CircularTrack / ConcentricView / StepSequencer — ./components/ (Type2)

// ── Store: single reactive brain (state + scheduler lifecycle) ──────
// Destructuring is safe here: top-level <script setup> bindings preserve
// ref reactivity and enable template auto-unwrap.
const {
  NUM_OPTS, DEN_OPTS,
  bpm, playing, tracks, heads, pendQ, selectedId, detailId, audioOn,
  masterNum, masterDen, masterMode, masterBridgeBars, masterTarget,
  savedSnapshot, showMapping,
  midi, midiIn,
  play, stop,
  saveSnapshot, recallSnapshot,
  setTrackNum, setTrackDen, toggleTrackMode,
  onMasterKnobChange, commitMaster,
  toggleStep: tog, doMute, doSolo, doClr,
  onCircleSelect, onBackgroundClick,
  selTrack, detTrk,
  updSel, updDet,
  trkNum, trkDen, pendingSig,
  isLearning, toggleLearn, bindingLabel, hasBound,
  allMuted, toggleAllMute,
} = useSequencerStore()

// ── UI-local state (not shared across UI variants) ──────────────────
type ViewMode = 'grid' | 'concentric'
const viewMode = ref<ViewMode>('grid')
const showBpmOverlay = ref(false)
const midiConfigInput = ref<HTMLInputElement | null>(null)

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

// ── MIDI config download / upload (needs DOM refs, so stays in page) ─
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
          <img src="/ibk.svg" alt="IBK" class="h-[14px] w-auto block opacity-40 pointer-events-none select-none" />
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
          <div class="flex items-center gap-1 flex-shrink-0">
            <span class="text-[9px] text-[#444] tracking-[1px]">MUTE</span>
            <button
              class="text-[10px] px-2 py-[4px] border rounded-sm tracking-[1px]"
              :class="allMuted ? 'bg-[#2a1a1a] text-[#dd8888] border-[#664444]' : 'bg-transparent text-[#555] border-[#222] hover:text-[#aaa]'"
              @click="toggleAllMute">⊘ ALL M</button>
          </div>

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

            <!-- AUDIO ON/OFF (グローバル) -->
            <button
              class="border px-[8px] py-[4px] text-[11px] tracking-[1px] rounded-sm flex-shrink-0"
              :class="audioOn
                ? 'bg-[#1a2a1a] text-[#8fd08f] border-[#2f5f2f]'
                : 'bg-[#222] text-[#666] border-[#333]'"
              :title="audioOn ? 'MIDI ON — click to silence' : 'MIDI OFF — click to send'"
              @click="audioOn = !audioOn">
              {{ audioOn ? '♪ AUDIO' : '✕ AUDIO' }}
            </button>

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
              <span class="text-[8px] tracking-[1px] font-semibold truncate"
                :style="{ color: trk.color }">
                {{ audioOn ? trk.name : `${trk.midiChannel}-${trk.midiNote}` }}</span>
              <div class="flex items-center gap-0.5 relative" @click.stop>
                <MeterKnob :model-value="trkNum(trk)" :options="NUM_OPTS" :size="28" :color="trk.color" @change="(v) => setTrackNum(trk.id, v)" />
                <span class="text-[9px] text-[#333]">/</span>
                <MeterKnob :model-value="trkDen(trk)" :options="DEN_OPTS" :size="28" :color="trk.color" @change="(v) => setTrackDen(trk.id, v)" />
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

            <!-- Bottom row: M/S/CLR (詳細ボタンは円の中に移設) -->
            <div class="flex items-center justify-start flex-shrink-0">
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
          <span class="text-[10px] text-[#555]">{{ detTrk()!.timeSig }}</span>
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
