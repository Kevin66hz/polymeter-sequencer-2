<!--
  ConcentricViewPlus.vue — Rich concentric ring view for Type2Plus.

  This component combines:
    - RingsStatic: Ring guides, step dots, labels, click handlers (Vue reactive)
    - RingsOverlay: Playhead needles, hit flashes (RAF-driven, no Vue reactive)
    - Center info: Selected track name, time signature, MUTE indicator

  Props interface matches the original ConcentricView.vue for drop-in replacement.
  The key difference is that playhead updates bypass Vue's reactive system.

  Phase 5 Stage 1: Static/dynamic layer separation.
  Stage 2 will add geometry caching. Stage 3 will add Canvas overlay for effects.
-->
<template>
  <div class="w-full h-full relative" ref="containerRef">
    <!-- HUD telemetry overlay (left side, radar terminal style) -->
    <div
      class="absolute top-3 left-3 z-10 pointer-events-none font-mono select-none whitespace-pre"
      style="color: rgba(150, 230, 160, 0.72); font-size: 11px; line-height: 1.3; text-shadow: 0 0 4px rgba(20, 90, 40, 0.6);"
    >
      <div style="opacity: 0.9; font-size: 12px;">[POLYRHYTHM ◉ TLM]</div>
      <div>
        <span :style="{ color: telemetry.playing ? 'rgba(140, 255, 160, 0.95)' : 'rgba(180, 180, 180, 0.5)' }">{{ telemetry.transportLabel }}</span>
        <span> </span>
        <span :style="{ color: telemetry.recording ? 'rgba(255, 100, 100, 0.95)' : 'rgba(120, 120, 120, 0.4)' }">REC{{ telemetry.recording ? '●' : '○' }}</span>
        <span>  BPM {{ telemetry.bpm }}</span>
      </div>
      <div>
        <span :style="{ color: telemetry.repeatOn ? 'rgba(255, 200, 90, 0.85)' : 'rgba(120, 120, 120, 0.4)' }">RPT {{ telemetry.repeatOn ? 'ON ' : 'OFF' }}</span>
        <span> RT {{ telemetry.repeatLabel }}   MST {{ telemetry.masterModeLabel }}</span>
      </div>
      <div>LCM {{ telemetry.lcm }}  GCD {{ telemetry.gcd }}  CYC {{ telemetry.cycleProg }}/{{ telemetry.lcm }}</div>
      <div>SPR {{ telemetry.spread }}  SYNC {{ telemetry.sync }}  μPH {{ telemetry.phMean }}%</div>
      <div>UPT {{ telemetry.upt }}  TCK {{ telemetry.tck }}</div>
      <div style="opacity: 0.4;">────────────────────────────────────────────────</div>
      <div style="opacity: 0.6;"> IDX SIG   MD HD/T  PATTERN             Q   P:S</div>
      <div
        v-for="(t, ti) in telemetry.tracks"
        :key="ti"
        :style="{
          opacity: ti === selectedId ? 1 : (t.mute ? 0.32 : 0.7),
          color: ti === selectedId
            ? 'rgba(255, 220, 140, 0.92)'
            : (t.queueLen > 0 ? 'rgba(255, 200, 90, 0.78)' : undefined),
        }"
      ><span>{{ ti === selectedId ? '▶' : ' ' }}{{ t.id }} {{ t.sig }} {{ t.md }} {{ t.headSlash }} </span><span style="opacity: 0.45;">[</span><span
          v-for="(s, si) in t.pattern"
          :key="si"
          :style="{ opacity: s === true ? 0.95 : s === false ? 0.04 : 0 }"
        >●</span><span style="opacity: 0.45;">]</span><span> {{ t.queue }}  {{ t.poly }}</span></div>
      <div style="opacity: 0.4;">────────────────────────────────────────────────</div>
      <div>ACT {{ telemetry.totActive }}/{{ telemetry.totSteps }} ({{ telemetry.activeRatio }})  MUT {{ telemetry.muteCount }}/{{ telemetry.totalCount }}  SOL {{ telemetry.soloCount }}/{{ telemetry.totalCount }}</div>
      <div v-if="telemetry.hasPending" style="color: rgba(255, 180, 70, 0.85);">PENDING {{ telemetry.pendingTotal }} (TR-MODE BRIDGE QUEUED)</div>
      <div style="opacity: 0.6;">[ {{ telemetry.statusLabel }} ]</div>
    </div>

    <svg
      :viewBox="`0 0 ${vbW} ${vbH}`"
      width="100%"
      height="100%"
      class="block select-none"
      preserveAspectRatio="xMidYMid meet"
    >
      <!-- Solid black canvas -->
      <rect x="0" y="0" :width="vbW" :height="vbH" fill="#000" />

      <!-- Polar reference grid: faint range rings + radial spokes.
           Purely a spatial frame (no labels) so the eye can read polar
           position; minimal opacity so it never competes with the
           data layers above. -->
      <g :transform="ringTransform" class="pointer-events-none">
        <circle
          v-for="r in rangeRings"
          :key="`rg-${r}`"
          :cx="CX" :cy="CY" :r="r"
          fill="none"
          stroke="rgba(140, 230, 150, 0.08)"
          stroke-width="0.6"
          vector-effect="non-scaling-stroke"
        />
        <line
          v-for="spoke in spokes"
          :key="`sp-${spoke.deg}`"
          :x1="CX" :y1="CY"
          :x2="spoke.x" :y2="spoke.y"
          :stroke="spoke.major ? 'rgba(140, 230, 150, 0.16)' : 'rgba(140, 230, 150, 0.08)'"
          :stroke-width="spoke.major ? 0.9 : 0.5"
          stroke-dasharray="2 5"
          vector-effect="non-scaling-stroke"
        />
      </g>

      <!-- Cartesian beat-density heatmap. Cells light up where
           multiple active steps cluster spatially. The refresh cycle
           is BPM-synced (one cycle per 8 beats) so the scope refreshes
           in time with the music. The data snapshot is captured by a
           JS timer at the cycle boundary (not on every reactive tick),
           and `:key="heatmapCycleKey"` re-creates the <g> in lockstep
           so the CSS fade restarts together with the new snapshot —
           edits made mid-cycle appear only at the next "snap on". -->
      <g
        :key="heatmapCycleKey"
        :transform="ringTransform"
        class="pointer-events-none radar-heatmap-refresh"
        :style="{ '--refresh-ms': heatmapCycleMs + 'ms' }"
      >
        <rect
          v-for="c in heatCells"
          :key="`heat-${c.i}`"
          :x="c.x"
          :y="c.y"
          :width="HEAT_CELL"
          :height="HEAT_CELL"
          :fill="c.fill"
          :opacity="c.o"
        />
      </g>

      <!-- Outer rim — anchors the convergence arc visually. -->
      <g :transform="ringTransform" class="pointer-events-none">
        <circle
          :cx="CX" :cy="CY" :r="OUTER_R + 6"
          fill="none"
          stroke="rgba(140, 230, 150, 0.20)"
          stroke-width="0.8"
          vector-effect="non-scaling-stroke"
        />
      </g>

      <!-- Convergence progress arc: how far into the LCM polyrhythm
           cycle the sequencer is. Fills clockwise from 12 o'clock; one
           full revolution = all rings have realigned (LCM completed).
           This is the *actual* "where are we in the polyrhythm" data. -->
      <g :transform="ringTransform" class="pointer-events-none" v-if="convergenceArc.show">
        <circle
          :cx="CX" :cy="CY" :r="convergenceArc.r"
          fill="none"
          stroke="rgba(140, 230, 150, 0.10)"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
        <path
          v-if="convergenceArc.fg"
          :d="convergenceArc.fg"
          fill="none"
          stroke="rgba(180, 255, 200, 0.85)"
          stroke-width="2.4"
          vector-effect="non-scaling-stroke"
          stroke-linecap="round"
        />
      </g>

      <!-- Per-track downbeat (step 0) markers — show the absolute phase
           offset of each ring's "1" relative to the others. -->
      <g :transform="ringTransform" class="pointer-events-none">
        <circle
          v-for="db in downbeats"
          :key="`db-${db.ti}`"
          :cx="db.x" :cy="db.y" :r="db.r"
          fill="none"
          :stroke="db.selected ? 'rgba(220, 255, 230, 0.85)' : 'rgba(160, 240, 175, 0.45)'"
          :stroke-width="db.selected ? 1.4 : 0.8"
          vector-effect="non-scaling-stroke"
        />
      </g>

      <!-- Rings + needles + center info, scaled to fit the container -->
      <g :transform="ringTransform">
        <!-- Static layer: rings, dots, labels, click handlers -->
        <RingsStatic
          :tracks="tracks"
          :selected-id="selectedId"
          :audio-on="audioOn"
          @select="$emit('select', $event)"
          @toggle="(ti, si) => $emit('toggle', ti, si)"
        />

        <!-- Dynamic layer: needles and flashes (RAF-driven) -->
        <RingsOverlay
          ref="overlayRef"
          :display-heads="displayHeads"
          :tracks-raw="tracksRaw"
          :selected-id="selectedId"
        />

        <!-- Center info -->
        <circle :cx="CX" :cy="CY" :r="CENTER_R - 2" fill="#000" />
        <text
          :x="CX" :y="CY - 8"
          text-anchor="middle" dominant-baseline="middle"
          fill="#ffffff" font-size="11" font-family="monospace" font-weight="bold"
          class="pointer-events-none"
        >{{ audioOn ? (selectedTrack?.name ?? '') : (selectedTrack ? `${selectedTrack.midiChannel}-${selectedTrack.midiNote}` : '') }}</text>
        <text
          :x="CX" :y="CY + 6"
          text-anchor="middle" dominant-baseline="middle"
          :fill="selectedTrack?.color ?? '#555870'"
          font-size="9" font-family="monospace"
          class="pointer-events-none"
        >{{ selectedTrack?.timeSig ?? '' }}</text>
        <text
          v-if="selectedTrack?.mute"
          :x="CX" :y="CY + 18"
          text-anchor="middle" dominant-baseline="middle"
          fill="#e05050" font-size="8" font-family="monospace"
          class="pointer-events-none"
        >MUTE</text>
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Pending, Track } from '#core/types'
import { SIZE, CX, CY, CENTER_R, OUTER_R, ringR, dotR } from './rings-geom'
import RingsStatic from './RingsStatic.vue'
import RingsOverlay from './RingsOverlay.vue'

const props = withDefaults(defineProps<{
  tracks: Track[]
  /** @deprecated heads prop is kept for API compatibility but not used for rendering */
  heads: number[]
  selectedId: number
  audioOn: boolean
  /** Raw mirror for RAF overlay: { current: number[] } */
  displayHeads: { current: number[] }
  /** Raw mirror for RAF overlay: { current: Track[] } */
  tracksRaw: { current: Track[] }
  // ── Optional transport / state props for the HUD telemetry. The HUD
  // degrades gracefully if these aren't passed (Type2-plus passes them).
  bpm?: number
  playing?: boolean
  recording?: boolean
  repeatOn?: boolean
  repeatRate?: number
  pendQ?: Pending[][]
  masterMode?: 'instant' | 'transition'
}>(), {
  audioOn: true,
  bpm: 0,
  playing: false,
  recording: false,
  repeatOn: false,
  repeatRate: 0,
  pendQ: () => [],
  masterMode: 'instant',
})

defineEmits<{
  select: [trackId: number]
  toggle: [trackId: number, stepIndex: number]
}>()

const overlayRef = ref<InstanceType<typeof RingsOverlay> | null>(null)

const selectedTrack = computed(() =>
  props.tracks[props.selectedId] ?? null
)

// ── Container size tracking + ring scale ────────────────────────────
//
// The SVG fills the entire parent container so the radar grid extends
// to the edges of the RING VIEW area (no visible square boundary).
// viewBox is updated to match the container's pixel size 1:1.
//
// `ringScale` enlarges (or shrinks) the rings group to fill the
// available space, leaving a small margin. Both the rings group and
// the grid <pattern> use the same `ringTransform` matrix, so heatmap
// cell edges and grid lines remain perfectly aligned at any scale.
const containerRef = ref<HTMLDivElement | null>(null)
const vbW = ref(SIZE)
const vbH = ref(SIZE)

// Margin reserves a little breathing room for the convergence arc
// that sits just outside OUTER_R.
const RING_MARGIN = 24

const ringScale = computed(() => {
  const avail = Math.min(vbW.value, vbH.value) - RING_MARGIN * 2
  if (avail <= 0) return 1
  // Cap a bit lower than the bare ring fit to leave horizontal room
  // for the CH-N leader labels rendered just outside OUTER_R.
  return Math.max(0.4, Math.min(1.5, avail / SIZE))
})

const ringTransform = computed(() => {
  const cx = vbW.value / 2
  const cy = vbH.value / 2
  const s = ringScale.value
  // Order: translate ring-local origin (CX, CY) to viewBox center, scaled.
  // This keeps the ring's center at the SVG center for any scale `s`.
  return `translate(${cx} ${cy}) scale(${s}) translate(${-CX} ${-CY})`
})

let ro: ResizeObserver | null = null

// ── HUD live tick ───────────────────────────────────────────────────
//
// `props.displayHeads.current` is a non-reactive raw mirror that the
// scheduler updates from RAF. To get the HUD telemetry numbers to
// move with playback we need an explicit reactive trigger — `tick`
// increments at ~12.5 Hz and any computed that reads it will rerun
// (and pick up fresh `displayHeads.current` values on each pass).
const HUD_TICK_MS = 80
const tick = ref(0)
const elapsedMs = ref(0)
let tickTimer: ReturnType<typeof setInterval> | null = null
let mountTime = 0

onMounted(() => {
  if (typeof window === 'undefined') return
  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (!e) return
      const w = Math.floor(e.contentRect.width)
      const h = Math.floor(e.contentRect.height)
      if (w > 0) vbW.value = w
      if (h > 0) vbH.value = h
    })
    ro.observe(containerRef.value)
  }
  mountTime = performance.now()
  tickTimer = setInterval(() => {
    tick.value = (tick.value + 1) | 0
    elapsedMs.value = performance.now() - mountTime
  }, HUD_TICK_MS)

  // Heatmap snapshot timer — fires at BPM-synced cycle boundaries so
  // the snapshot and the CSS fade restart together.
  startHeatmapTimer()

  // Metrics RAF: tracks the global step counter G by watching track 0's
  // head and detecting wraps. G is what drives the convergence arc and
  // any other "where are we in the polyrhythm cycle" indicators.
  const metricsLoop = () => {
    const heads = props.displayHeads.current
    const t0 = props.tracks[0]
    if (t0 && t0.steps.length > 0) {
      const total0 = t0.steps.length
      const headInt = Math.max(0, Math.floor(heads[0] ?? 0)) % total0
      if (lastHead0Int < 0) {
        lastHead0Int = headInt
        gStep.value = headInt
      } else if (headInt !== lastHead0Int) {
        let delta = headInt - lastHead0Int
        if (delta < 0) delta += total0
        gStep.value += delta
        lastHead0Int = headInt
      }
    }
    metricsRafId = requestAnimationFrame(metricsLoop)
  }
  metricsRafId = requestAnimationFrame(metricsLoop)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  if (tickTimer != null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  if (metricsRafId != null) {
    cancelAnimationFrame(metricsRafId)
    metricsRafId = null
  }
  if (heatmapTimer != null) {
    clearInterval(heatmapTimer)
    heatmapTimer = null
  }
})

// ── Polar reference grid (radial spokes + range rings) ─────────────
//
// Lightweight grid: 8 spokes every 45° (cardinals are "major" — slightly
// stronger), plus two faint atmospheric range rings between the inner
// hub and the outer rim. No degree/cardinal text — just a spatial
// frame to read polar positions against.
const SPOKE_INTERVAL_DEG = 45

const spokes = computed(() => {
  const out: Array<{ deg: number; x: number; y: number; major: boolean }> = []
  for (let d = 0; d < 360; d += SPOKE_INTERVAL_DEG) {
    const a = (d - 90) * Math.PI / 180
    out.push({
      deg: d,
      x: CX + OUTER_R * Math.cos(a),
      y: CY + OUTER_R * Math.sin(a),
      major: d % 90 === 0,
    })
  }
  return out
})

const rangeRings = computed(() => {
  const a = CENTER_R + (OUTER_R - CENTER_R) * 0.33
  const b = CENTER_R + (OUTER_R - CENTER_R) * 0.66
  return [a, b]
})

// ── Heatmap refresh cycle (BPM-synced) ──────────────────────────────
//
// One refresh cycle = 8 beats (2 bars in 4/4). At 120 BPM that's
// ~4 s; at slower/faster tempos the scope refresh stretches/shrinks
// musically. Falls back to 120 BPM if the prop hasn't been wired up.
const HEATMAP_BEATS_PER_CYCLE = 8
const heatmapCycleMs = computed(() => {
  const bpm = props.bpm > 0 ? props.bpm : 120
  return Math.round((60000 / bpm) * HEATMAP_BEATS_PER_CYCLE)
})

// ── Cartesian beat-density heatmap (radar contact field) ────────────
//
// 20px-cell grid spanning the rings area. Each non-muted active step
// drops weight into its (x, y) cell with an 8-neighbour seed spread,
// then a 5×5 weighted blur smooths the result so the field reads as
// a coherent radar return rather than isolated pixels. Phosphor-only
// palette keeps the scope reading as one surface.
const HEAT_CELL = 20
const HEAT_COLS = Math.ceil(SIZE / HEAT_CELL)
const HEAT_ROWS = HEAT_COLS

// 雨雲レーダー (JMA precipitation radar) palette. Light cyan → blue
// → yellow → orange → red, mirroring how rain intensity is colored on
// Japanese weather maps. Reads instantly as a precipitation field.
function radarFill(t: number): string {
  if (t < 0.18) return '#a0d8ef' // 弱い (light rain)
  if (t < 0.40) return '#3d7fd1' // やや強い
  if (t < 0.65) return '#fae629' // 強い
  if (t < 0.85) return '#ff8c1a' // 非常に強い
  return '#ff2d2d'               // 猛烈
}

const SEED_SPREAD: Array<[number, number, number]> = [
  [0, 0, 1.0],
  [-1, 0, 0.55], [1, 0, 0.55], [0, -1, 0.55], [0, 1, 0.55],
  [-1, -1, 0.30], [-1, 1, 0.30], [1, -1, 0.30], [1, 1, 0.30],
]

type HeatCell = { i: number; x: number; y: number; fill: string; o: number }

function computeHeatCellsNow(): HeatCell[] {
  const cells = HEAT_COLS * HEAT_ROWS
  const density = new Float32Array(cells)
  for (let ti = 0; ti < props.tracks.length; ti++) {
    const trk = props.tracks[ti]
    if (trk.mute) continue
    const total = trk.steps.length
    if (!total) continue
    const r = ringR(ti)
    for (let si = 0; si < total; si++) {
      if (!trk.steps[si]) continue
      const a = (si / total) * Math.PI * 2 - Math.PI / 2
      const px = CX + r * Math.cos(a)
      const py = CY + r * Math.sin(a)
      const col = Math.floor(px / HEAT_CELL)
      const row = Math.floor(py / HEAT_CELL)
      for (const [dc, dr, w] of SEED_SPREAD) {
        const c2 = col + dc
        const r2 = row + dr
        if (c2 < 0 || c2 >= HEAT_COLS || r2 < 0 || r2 >= HEAT_ROWS) continue
        density[r2 * HEAT_COLS + c2] += w
      }
    }
  }
  // 5×5 weighted blur for smoother gradients.
  const blurred = new Float32Array(cells)
  for (let r = 0; r < HEAT_ROWS; r++) {
    for (let c = 0; c < HEAT_COLS; c++) {
      let sum = 0
      let wsum = 0
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const r2 = r + dr
          const c2 = c + dc
          if (r2 < 0 || r2 >= HEAT_ROWS || c2 < 0 || c2 >= HEAT_COLS) continue
          const m = Math.max(Math.abs(dr), Math.abs(dc))
          const w = m === 0 ? 6 : m === 1 ? 3 : 1
          sum += density[r2 * HEAT_COLS + c2] * w
          wsum += w
        }
      }
      blurred[r * HEAT_COLS + c] = wsum > 0 ? sum / wsum : 0
    }
  }
  let max = 0
  for (let i = 0; i < cells; i++) if (blurred[i] > max) max = blurred[i]
  if (max <= 0) return []
  const out: HeatCell[] = []
  for (let r = 0; r < HEAT_ROWS; r++) {
    for (let c = 0; c < HEAT_COLS; c++) {
      const v = blurred[r * HEAT_COLS + c]
      if (v <= 0) continue
      const norm = v / max
      if (norm < 0.02) continue
      out.push({
        i: r * HEAT_COLS + c,
        x: c * HEAT_CELL,
        y: r * HEAT_CELL,
        fill: radarFill(norm),
        o: 0.16 + Math.pow(norm, 0.65) * 0.45,
      })
    }
  }
  return out
}

// Snapshot ref: only updates at cycle boundaries (driven by the
// heatmap timer below). This decouples the heatmap from immediate
// reactivity — toggling a step/mute/etc. won't repaint the heatmap
// instantly; the change appears at the next "snap on" of the cycle,
// keeping the visual sweep coherent with the BPM-synced fade.
const heatCells = ref<HeatCell[]>([])

// Cycle key: bumped whenever the snapshot refreshes. Used as :key on
// the heatmap <g> so the CSS keyframe animation restarts in lockstep
// with the data swap (otherwise CSS and JS timers would drift).
const heatmapCycleKey = ref(0)

let heatmapTimer: ReturnType<typeof setInterval> | null = null

function refreshHeatSnapshot(): void {
  heatCells.value = computeHeatCellsNow()
  heatmapCycleKey.value = (heatmapCycleKey.value + 1) | 0
}

function startHeatmapTimer(): void {
  if (heatmapTimer != null) {
    clearInterval(heatmapTimer)
    heatmapTimer = null
  }
  refreshHeatSnapshot()
  heatmapTimer = setInterval(refreshHeatSnapshot, heatmapCycleMs.value)
}

// BPM (or any cycle-length input) changed → restart the snapshot
// interval at the new cadence so it stays musically aligned.
// (Declared here, AFTER `heatmapCycleMs` and `startHeatmapTimer`, to
// avoid the TDZ — `<script setup>` runs as a single function body, so
// referencing a `const` before its declaration line throws and breaks
// the component on mount.)
watch(heatmapCycleMs, () => {
  startHeatmapTimer()
})

// ── Per-track downbeat (step 0) markers ─────────────────────────────
//
// Small ring marker at each track's "1" position. Reveals the absolute
// phase relationships between tracks — i.e. how the rings' downbeats
// line up (or don't) at the moment of LCM convergence.
const downbeats = computed(() => {
  const out: Array<{ ti: number; x: number; y: number; r: number; selected: boolean }> = []
  for (let ti = 0; ti < props.tracks.length; ti++) {
    const trk = props.tracks[ti]
    if (!trk || trk.steps.length === 0) continue
    const r = ringR(ti)
    const a = -Math.PI / 2 // step 0 is at 12 o'clock
    out.push({
      ti,
      x: CX + r * Math.cos(a),
      y: CY + r * Math.sin(a),
      r: dotR(ti) + 2,
      selected: ti === props.selectedId,
    })
  }
  return out
})

// ── Global step counter (RAF-tracked) ───────────────────────────────
//
// The convergence arc needs a meaningful "where in the polyrhythm" value.
// We derive a global step count G by watching track 0's head and
// counting wraps; G modulo LCM gives us the cycle phase. Updated in
// the metrics RAF loop in onMounted.
const gStep = ref(0)
let lastHead0Int = -1
let metricsRafId: number | null = null

// ── Convergence progress arc ────────────────────────────────────────
//
// LCM of every track's step count = how many global steps until all
// rings realign. The arc fills clockwise from 12 o'clock as the
// sequence progresses through that cycle and resets at convergence.
const convergenceArc = computed(() => {
  const stepCounts = props.tracks.map((t) => t.steps.length).filter((n) => n > 0)
  if (stepCounts.length === 0) return { show: false, r: 0, fg: '' }
  const cycleLen = stepCounts.reduce<number>((acc, n) => lcm(acc, n), 1)
  const phase = cycleLen > 0 ? (gStep.value % cycleLen) / cycleLen : 0
  const r = OUTER_R + 6
  if (phase < 0.001) return { show: true, r, fg: '' }
  const angDeg = Math.min(359.99, phase * 360)
  const angRad = (angDeg - 90) * Math.PI / 180
  const startX = CX
  const startY = CY - r
  const endX = CX + r * Math.cos(angRad)
  const endY = CY + r * Math.sin(angRad)
  const largeArc = angDeg > 180 ? 1 : 0
  return {
    show: true,
    r,
    fg: `M ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY}`,
  }
})

// ── HUD telemetry overlay (left-side radar terminal) ────────────────
//
// Musical metrics about the current ring state — polyrhythm convergence
// (LCM of step counts), common pulse (GCD), per-track time signatures,
// MIDI note/velocity/gate readouts, and the polyrhythm ratio of every
// track against the currently-selected one. All values are derived
// purely from `props.tracks` and update reactively on any edit.

function pad(n: number | string, w: number, c = '0'): string {
  return String(n).padStart(w, c)
}

function gcd(a: number, b: number): number {
  a = Math.abs(a | 0)
  b = Math.abs(b | 0)
  while (b > 0) {
    const t = b
    b = a % b
    a = t
  }
  return a || 1
}

function lcm(a: number, b: number): number {
  if (a <= 0 || b <= 0) return Math.max(a, b, 1)
  return (a * b) / gcd(a, b)
}

/** Format a polyrhythm ratio as "N:M" reduced by GCD. */
function polyRatio(a: number, b: number): string {
  if (a <= 0 || b <= 0) return '?:?'
  const g = gcd(a, b)
  return `${a / g}:${b / g}`
}

const NOTE_NAMES = ['C ', 'C#', 'D ', 'D#', 'E ', 'F ', 'F#', 'G ', 'G#', 'A ', 'A#', 'B ']

/** MIDI 60 → "C  4". Always 4 chars wide, octave right-aligned. */
function noteName(midi: number): string {
  const n = ((midi % 12) + 12) % 12
  const oct = Math.floor(midi / 12) - 1
  return NOTE_NAMES[n] + String(oct).padStart(2, ' ')
}

/** Format "4/4" → "04/04" (5 chars). Falls back to "?/?  " on bad input. */
function fmtSig(sig: string | undefined, fallback: string): string {
  const raw = sig ?? fallback
  const [n, d] = raw.split('/')
  if (!n || !d) return '??/?? '
  return `${pad(n, 2)}/${pad(d, 2)}`
}

/** ms → "MM:SS.s" (7 chars). */
function fmtUptime(ms: number): string {
  const totalSec = Math.max(0, ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec - min * 60
  const secStr = sec.toFixed(1).padStart(4, '0')
  return `${pad(min, 2)}:${secStr}`
}

/**
 * Step pattern as a tri-state per-cell array of fixed length PAT_LEN:
 *   true  → active step
 *   false → inactive step
 *   null  → no step (track is shorter than PAT_LEN, cell is just empty)
 *
 * Rendered in the template as a row of `●` glyphs differing only in
 * opacity, so active and inactive cells share the same shape (smooth
 * dots) and the inactive ones can be made very faint without losing
 * the column alignment that the bracket relies on.
 */
const PAT_LEN = 16
function patternBits(steps: boolean[]): Array<boolean | null> {
  const out = new Array<boolean | null>(PAT_LEN)
  for (let i = 0; i < PAT_LEN; i++) {
    out[i] = i < steps.length ? !!steps[i] : null
  }
  return out
}

const telemetry = computed(() => {
  // Touch the live tick ref so this computed reruns on every HUD tick
  // and picks up fresh values from the non-reactive head mirror.
  void tick.value

  const tracks = props.tracks
  const heads = props.displayHeads.current
  const selId = props.selectedId
  const sel = tracks[selId]
  const selSteps = sel?.steps.length ?? 0
  const selHead = heads[selId] ?? 0
  const selPhase = selSteps > 0 ? selHead / selSteps : 0

  // Per-track rows
  const phases: number[] = []
  let pendingTotal = 0
  const pendQ = props.pendQ ?? []
  const trks = tracks.map((trk, ti) => {
    const total = trk.steps.length
    const headRaw = heads[ti] ?? 0
    const headStep = total > 0 ? Math.floor(headRaw) % total : 0
    const phase01 = total > 0 ? headRaw / total : 0
    phases.push(phase01)
    const queueLen = pendQ[ti]?.length ?? 0
    pendingTotal += queueLen
    return {
      id: 'T' + pad(ti + 1, 2),
      sig: fmtSig(trk.timeSig, `${total}/${total}`),
      md: trk.mode === 'transition' ? 'TR' : 'IN',
      headSlash: pad(headStep, 2) + '/' + pad(total, 2),
      pattern: patternBits(trk.stepsSource ?? trk.steps),
      queue: queueLen > 0 ? `Q${pad(queueLen, 1)}*` : 'Q0 ',
      queueLen,
      poly: ti === selId ? '---- ' : polyRatio(total, selSteps || 1).padEnd(5, ' '),
      mute: trk.mute,
    }
  })

  // Aggregate musical metrics
  let muteCount = 0
  let soloCount = 0
  let totActive = 0
  let totSteps = 0
  let velSum = 0
  let gateSum = 0
  let lowNote = 127
  let highNote = 0
  let convergence = 1
  for (const trk of tracks) {
    if (trk.mute) muteCount++
    if (trk.solo) soloCount++
    totSteps += trk.steps.length
    for (const s of trk.steps) if (s) totActive++
    velSum += trk.midiVelocity
    gateSum += trk.gateMs
    if (trk.midiNote < lowNote) lowNote = trk.midiNote
    if (trk.midiNote > highNote) highNote = trk.midiNote
    if (trk.steps.length > 0) convergence = lcm(convergence, trk.steps.length)
  }
  const tCount = tracks.length || 1
  const ratio = totSteps > 0 ? (totActive / totSteps) * 100 : 0
  const allStepCounts = tracks.map((t) => t.steps.length).filter((n) => n > 0)
  const overallGcd = allStepCounts.length > 0 ? allStepCounts.reduce((a, b) => gcd(a, b)) : 0

  // Time-signature diversity
  const sigSet = new Set(tracks.map((t) => t.timeSig ?? '').filter(Boolean))
  const sigSorted = [...sigSet].sort()
  const sigRange = sigSorted.length === 0
    ? '----'
    : sigSorted.length === 1
      ? sigSorted[0]
      : `${sigSorted[0]}…${sigSorted[sigSorted.length - 1]}`

  // Polyrhythm "tag" for selected — most prominent ratio in the kit
  let selPolyTag = '1:1'
  if (sel) {
    const others = tracks.filter((t, i) => i !== selId && t.steps.length > 0)
    if (others.length > 0) {
      // pick the track whose ratio against selected is least 1:1
      let best = others[0]
      let bestDist = 0
      for (const o of others) {
        const r = polyRatio(o.steps.length, selSteps || 1)
        const [a, b] = r.split(':').map(Number)
        const d = Math.abs(Math.log2(a / b))
        if (d > bestDist) {
          bestDist = d
          best = o
        }
      }
      selPolyTag = polyRatio(best.steps.length, selSteps || 1)
    }
  }

  // Phase spread across all tracks: 0 = all in sync, ~0.5 = max scatter.
  let minPh = 1
  let maxPh = 0
  let phSum = 0
  for (const ph of phases) {
    if (ph < minPh) minPh = ph
    if (ph > maxPh) maxPh = ph
    phSum += ph
  }
  const phMean = phases.length > 0 ? phSum / phases.length : 0
  const spread = phases.length > 0 ? Math.max(0, maxPh - minPh) : 0
  // sync score: 1 when all aligned, 0 at maximum spread (0.5 ≈ antiphase)
  const sync = Math.max(0, 1 - spread * 2)

  // "Convergence countdown" — uses the RAF-tracked global step counter
  // (track 0 head with wrap detection) so the HUD value moves in
  // lockstep with the convergence-arc on the radar.
  const cycleLen = convergence
  const cycleProg = cycleLen > 0 ? (gStep.value % cycleLen) : 0
  const cycleLeft = cycleLen > 0 ? cycleLen - cycleProg : 0

  // Transport / state labels for the header block.
  const playing = !!props.playing
  const recording = !!props.recording
  const repeatOn = !!props.repeatOn
  const transportLabel = playing ? '▶PLAY' : '■STOP'
  const masterModeLabel = props.masterMode === 'transition' ? 'TR' : 'IN'
  const repeatLabel = props.repeatRate > 0 ? `1/${props.repeatRate}` : '----'
  const bpmLabel = props.bpm > 0 ? props.bpm.toFixed(1).padStart(5, '0') : '---.-'

  return {
    tracks: trks,
    // transport / system state
    playing,
    recording,
    repeatOn,
    transportLabel,
    masterModeLabel,
    repeatLabel,
    bpm: bpmLabel,
    pendingTotal: pad(pendingTotal, 2),
    hasPending: pendingTotal > 0,
    // polyrhythm
    lcm: pad(convergence, 4),
    gcd: pad(overallGcd, 2),
    uniqueSigs: pad(sigSet.size, 2),
    sigRange,
    selId: pad(selId + 1, 2),
    selSig: sel ? fmtSig(sel.timeSig, `${selSteps}/${selSteps}`) : '--/--',
    selSteps: pad(selSteps, 3),
    selHead: pad(Math.floor(selHead) % Math.max(1, selSteps), 3),
    selPhase: (selPhase * 100).toFixed(1).padStart(5, '0'),
    selPolyTag: selPolyTag.padEnd(5, ' '),
    // aggregates
    totActive: pad(totActive, 3),
    totSteps: pad(totSteps, 3),
    activeRatio: `${ratio.toFixed(1).padStart(5, '0')}%`,
    noteRange: `${noteName(lowNote)}…${noteName(highNote)}`,
    noteSpan: pad(Math.max(0, highNote - lowNote), 3),
    avgVel: pad(Math.round(velSum / tCount), 3),
    avgGate: pad(Math.round(gateSum / tCount), 4),
    muteCount: pad(muteCount, 2),
    soloCount: pad(soloCount, 2),
    totalCount: pad(tCount, 2),
    // dynamic
    spread: spread.toFixed(3),
    sync: sync.toFixed(3),
    phMean: (phMean * 100).toFixed(1).padStart(5, '0'),
    cycleLeft: pad(cycleLeft, 4),
    cycleProg: pad(cycleProg, 4),
    upt: fmtUptime(elapsedMs.value),
    tck: pad(tick.value % 100000, 5),
    statusLabel: !playing
      ? 'STOPPED'
      : recording
        ? 'REC ARMED'
        : muteCount === tCount
          ? 'IDLE'
          : soloCount > 0
            ? 'SOLO'
            : 'RUN',
  }
})

</script>

<style scoped>
/* Heatmap refresh cycle. Cycle duration is BPM-synced via the
   `--refresh-ms` CSS variable set on the heatmap group; default 4 s
   if the variable isn't provided. Snaps on at the start of each
   cycle, then fades out across the whole cycle (ease-out — fast
   initial drop, long tail), then snaps back on for the next sweep. */
@keyframes radar-heatmap-refresh {
  0%   { opacity: 1; }
  100% { opacity: 0; }
}
.radar-heatmap-refresh {
  animation: radar-heatmap-refresh var(--refresh-ms, 4000ms) ease-out infinite;
}
</style>

