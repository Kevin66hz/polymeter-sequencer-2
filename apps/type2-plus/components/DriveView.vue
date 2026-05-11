<!--
  DriveView.vue — PC-98 lo-fi driving-game style polymetric visualization.

  Concept:
    - First-person POV in left lane of a perspective road.
    - Each MIDI trigger spawns a roadside object (lamp, sign, tree, etc.)
      that travels from the horizon toward the camera.
    - Rhythm-game timing: objects spawn early enough that they reach
      the playhead Z (1/2 way up the road area) exactly when the audio
      trigger fires. Lookahead ~22 sixteenth notes.
    - When 5+ unmuted tracks land on step 0 simultaneously (convergence),
      a structure appears: gantry (5-6) / wind turbine on roadside (7-12)
      / mega highway-overpass composite "政府は嘘をついている" (13+).
    - Mute → that track's in-flight objects shrink to 0 and disappear.
    - Unmute → missed ticks are spawned with grow-from-0 animation.

  Design rules (same as other Plus views):
    - Client-only.
    - RAF hot loop reads only raw mirrors (displayHeads / tracksRaw).
    - Local audio clock; synced to scheduler via watch on `playing`.
-->

<template>
  <div ref="containerRef" class="drive-view-root">
    <canvas ref="canvasRef" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { TRACK_COUNT, type Track } from '#core/types'

const props = defineProps<{
  tracks: Track[]
  displayHeads: { current: number[] }
  tracksRaw: { current: Track[] }
  bpm: number
  playing: boolean
  masterTarget: string | null  // "4/4" | null — set during global meter bridge
  masterNum: number
  masterDen: number
  repeatOn: boolean
  repeatRate: number  // beats subdivision: 2 (1/2), 4 (1/4), 8 (1/8), 16 (1/16)
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)

// ── Constants & dynamic canvas dimensions ────────────────
// Canvas size matches container size (set in onMounted via ResizeObserver).
// HORIZON_Y / FOCAL scale with canvas dims to keep aspect/FOV consistent.
let W = 480, H = 480
let HORIZON_Y = H * 0.30
let FOCAL = W * 0.4167  // half-FOV ≈ 50° → full FOV ≈ 100°, matches original 480×200
let DASH_Y = H * 0.78
let DASH_H = H * 0.22
const HORIZON_FRAC = 0.30
const FOCAL_FRAC = 0.4167
const DASH_H_FRAC = 0.22
// Worldspace constants — independent of canvas size
const CAM_HEIGHT = 1.2
const CAM_X = -2.25
const ROAD_HALF = 4.5
const FAR_Z = 70
const NEAR_Z = 0.4
const PLAYHEAD_Z = 7.0
const SCALE_SPEED = 5

// Track index 0..15 → object type. Each track gets a unique visual.
const TRACK_TYPES: string[] = [
  'lamp_l',    // 0 KICK
  'sign_l',    // 1 SNARE
  'pole_thin', // 2 HAT (frequent — simple)
  'signal',    // 3 CLAP
  'tree',      // 4 BASS
  'utility',   // 5 LEAD
  'wall',      // 6 PAD
  'cone',      // 7 PERC
  'vending',   // 8 K2
  'sign_tri',  // 9 S2
  'hydrant',   // 10 HH2
  'sign_circ', // 11 CL2
  'torii',     // 12 B2
  'bench',     // 13 LD2
  'reflector', // 14 PD2
  'guardrail', // 15 PC2
]

const PLACEMENT: Record<string, number> = {
  lamp_l: 5.0, sign_l: 7.5, signal: 5.5, cone: 5.2, reflector: 4.7,
  bench: 5.5, pole_thin: 4.8, hydrant: 4.6, tree: 10.0, utility: 11.0,
  wall: 6.5, sign_tri: 6.5, torii: 5.5, vending: 5.5, guardrail: 5.0, sign_circ: 6.8,
}

// ── State (component-local; not Vue reactive — used in RAF hot path) ──
let ctx: CanvasRenderingContext2D | null = null
let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
let audioStartMs = 0
let elapsedBeforePauseMs = 0
let lastFrameMs = 0
let lastTick = -1
let lastSpawnedTick = -1
const objects: any[] = []
const STARS: { x: number; y: number }[] = []
const lastEffMutes: boolean[] = new Array(TRACK_COUNT).fill(false)
const lastStepLen: number[] = new Array(TRACK_COUNT).fill(0)
// Curve state — bends the road during master meter transitions
let curveCurrent = 0
let curveTarget = 0
let curveDirection = 1  // alternates each transition for visual variety
// REP (beat repeat) state — anchor tick captured when REP turns on
let repAnchor: number | null = null

// ── Helpers ────────────────────────────────────────────────
function stepMs() { return 60000 / Math.max(1, props.bpm) / 4 }
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b) }
function lcmAll(arr: number[]) { return arr.reduce((a, b) => a * b / gcd(a, b), 1) }

function audioTimeMs() {
  if (props.playing) return elapsedBeforePauseMs + (performance.now() - audioStartMs)
  return elapsedBeforePauseMs
}

function project(wx: number, wy: number, wz: number) {
  if (wz <= 0.05) return null
  return {
    x: W / 2 + ((wx - CAM_X) / wz) * FOCAL,
    y: HORIZON_Y + ((CAM_HEIGHT - wy) / wz) * FOCAL,
    scale: FOCAL / wz,
  }
}
function projOnRoad(roadX: number, wy: number, wz: number) { return project(roadCenterAt(wz) + roadX, wy, wz) }
// Z² scaling: far points shift more, gives sweeping road bend during master transition
function roadCenterAt(z: number) { return curveCurrent * z * z * 0.005 }
function updateCurve(dt: number) {
  const diff = curveTarget - curveCurrent
  curveCurrent += diff * Math.min(1, dt * 2.5)
}

function fireCountAtTick(steps: boolean[], t: number) {
  const sc = steps.length
  if (sc === 0 || t < 0) return 0
  let firesPerCycle = 0
  for (let i = 0; i < sc; i++) if (steps[i]) firesPerCycle++
  if (firesPerCycle === 0) return 0
  const cycles = Math.floor((t + 1) / sc)
  const rem = (t + 1) % sc
  let partial = 0
  for (let i = 0; i < rem; i++) if (steps[i]) partial++
  return cycles * firesPerCycle + partial
}

// During REP, trigger position loops within (anchor, anchor+windowSize).
// Map any future absolute tick onto its effective looped position so pattern
// lookup yields the SAME step every loop iteration → object visually repeats.
function effectiveTick(t: number): number {
  if (props.repeatOn && repAnchor !== null) {
    const ws = Math.max(1, Math.round(16 / Math.max(1, props.repeatRate)))
    const rel = t - repAnchor
    const looped = ((rel % ws) + ws) % ws
    return repAnchor + looped
  }
  return t
}

function isEffMuted(trk: Track, anySolo: boolean): boolean {
  if (trk.mute) return true
  if (anySolo && !trk.solo) return true
  return false
}

function strokeLine(a: { x: number; y: number }, b: { x: number; y: number }, w: number) {
  if (!ctx) return
  ctx.lineWidth = Math.max(1, w)
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
}

// ── Spawn pipeline ────────────────────────────────────────
function processTicks() {
  if (!props.playing) return
  const audio_ms = audioTimeMs()
  const sm = stepMs()
  const speed = props.bpm * 0.2
  const current_tick = Math.floor(audio_ms / sm)
  lastTick = current_tick

  const lookahead_ms = (FAR_Z - PLAYHEAD_Z) / speed * 1000
  const target_tick = Math.floor((audio_ms + lookahead_ms) / sm)
  if (target_tick > lastSpawnedTick) {
    for (let t = Math.max(lastSpawnedTick + 1, current_tick); t <= target_tick; t++) {
      scheduleTickObjects(t, audio_ms, sm, speed)
    }
    lastSpawnedTick = target_tick
  }
}

function scheduleTickObjects(t: number, audio_ms: number, sm: number, speed: number) {
  if (t < 0) return
  const ms_until = t * sm - audio_ms
  const z_at_spawn = PLAYHEAD_Z + (ms_until / 1000) * speed

  const trks = props.tracksRaw.current
  const anySolo = trks.some((tr) => !!tr?.solo)
  const effT = effectiveTick(t)
  let convergeCount = 0
  let firedIdx = 0
  for (let i = 0; i < trks.length; i++) {
    const trk = trks[i]
    if (!trk || isEffMuted(trk, anySolo)) continue
    const sc = trk.steps.length
    if (sc <= 0) continue
    const localStep = ((effT % sc) + sc) % sc
    if (localStep === 0) convergeCount++
    if (trk.steps[localStep]) {
      // pass effT for fireCount → side stays consistent across REP loops
      spawnObject(trk, i, firedIdx, z_at_spawn, effT)
      firedIdx++
    }
  }
  if (convergeCount >= 5) spawnConvergence(convergeCount, z_at_spawn, effT)
}

function spawnObject(trk: Track, i: number, firedIdx: number, z_at_spawn: number, t: number) {
  const type = TRACK_TYPES[i] || 'lamp_l'
  const fireIdx = fireCountAtTick(trk.steps, t) - 1
  const side = (fireIdx % 2 === 0) ? -1 : 1
  const d = PLACEMENT[type] || 5.0
  const zJitter = firedIdx * 0.4 + (i * 0.07)
  objects.push({ type, roadX: side * d, z: z_at_spawn - zJitter, side, scale: 0, scaleState: 'growing', trackIdx: i })
}

function spawnConvergence(count: number, z_at_spawn: number, t: number) {
  if (count >= 13) {
    objects.push({ type: 'mega', roadX: 0, z: z_at_spawn, side: 0, count, scale: 0, scaleState: 'growing' }); return
  }
  if (count >= 7) {
    const side = (t % 2 === 0) ? -1 : 1
    const big = count >= 10
    objects.push({ type: 'wind_turbine', roadX: side * 15, z: z_at_spawn, side, count, big, scale: 0, scaleState: 'growing' }); return
  }
  objects.push({ type: 'gantry', roadX: 0, z: z_at_spawn, side: 0, count, scale: 0, scaleState: 'growing' })
}

function updateObjects(dt: number) {
  const speed = props.bpm * 0.2
  for (const obj of objects) {
    obj.z -= speed * dt
    if (obj.scaleState === 'growing') {
      obj.scale = Math.min(1, (obj.scale || 0) + dt * SCALE_SPEED)
      if (obj.scale >= 1) obj.scaleState = 'normal'
    } else if (obj.scaleState === 'shrinking') {
      obj.scale = Math.max(0, (obj.scale || 1) - dt * SCALE_SPEED)
    }
  }
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i]
    if ((o.scaleState === 'shrinking' && o.scale <= 0) || o.z <= NEAR_Z * 0.5) objects.splice(i, 1)
  }
}

// ── Drawing ───────────────────────────────────────────────
function render() {
  if (!ctx) return
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#fff'
  for (const s of STARS) ctx.fillRect(s.x, s.y, 1, 1)
  drawSun()
  drawHorizonGrid()
  drawRoad()
  objects.sort((a, b) => b.z - a.z)
  for (const obj of objects) drawObject(obj)
  drawDashboard()
}

// ── Dashboard (BPM / CONV / MASTER N/D / GEAR / 16 track needles) ──
function drawDashboard() {
  if (!ctx) return
  // Hood block
  ctx.fillStyle = '#000'
  ctx.fillRect(0, DASH_Y, W, DASH_H)
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, DASH_Y + 6)
  ctx.lineTo(W * 0.18, DASH_Y - 4)
  ctx.lineTo(W * 0.82, DASH_Y - 4)
  ctx.lineTo(W, DASH_Y + 6)
  ctx.stroke()

  const cy = DASH_Y + DASH_H * 0.50
  const bigR = Math.max(12, DASH_H * 0.30)
  const mnmdR = Math.max(7, DASH_H * 0.13)
  const needleR = Math.max(3, DASH_H * 0.08)

  drawNeedleGauge(W * 0.087, cy, bigR, props.bpm, 40, 240, 'BPM', String(Math.round(props.bpm)))
  drawConvGauge(W * 0.225, cy, bigR)
  const mnmdX = W * 0.337
  drawNeedleGauge(mnmdX, DASH_Y + DASH_H * 0.32, mnmdR, props.masterNum, 1, 16, 'N', String(props.masterNum))
  drawNeedleGauge(mnmdX, DASH_Y + DASH_H * 0.68, mnmdR, props.masterDen, 4, 16, 'D', String(props.masterDen))
  // GEAR = effective active count (mute + solo aware)
  const trks = props.tracksRaw.current
  const anySolo = trks.some((t) => !!t?.solo)
  let activeCount = 0
  for (const trk of trks) if (trk && !isEffMuted(trk, anySolo)) activeCount++
  drawNeedleGauge(W * 0.45, cy, bigR, activeCount, 0, 16, 'GEAR', String(activeCount))

  drawTrackGrid(W * 0.537, DASH_Y + DASH_H * 0.17, W * 0.45, DASH_H * 0.66, needleR)
}

function drawNeedleGauge(cx: number, cy: number, r: number, value: number, min: number, max: number, label: string, valueText: string) {
  if (!ctx) return
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
  const ticks = 10
  for (let i = 0; i <= ticks; i++) {
    const a = -Math.PI * 1.25 + (Math.PI * 1.5) * (i / ticks)
    const r1 = r - 1, r2 = r - (i % 5 === 0 ? 6 : 3)
    ctx.lineWidth = i % 5 === 0 ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
    ctx.stroke()
  }
  const v = Math.max(min, Math.min(max, value))
  const t = (max > min) ? (v - min) / (max - min) : 0
  const ang = -Math.PI * 1.25 + (Math.PI * 1.5) * t
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + Math.cos(ang) * (r - 5), cy + Math.sin(ang) * (r - 5))
  ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2); ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.font = `bold ${Math.max(7, r * 0.30)}px monospace`
  ctx.fillText(label, cx, cy + r - 3)
  ctx.font = `bold ${Math.max(8, r * 0.34)}px monospace`
  ctx.fillText(valueText, cx, cy + 4)
}

function drawConvGauge(cx: number, cy: number, r: number) {
  if (!ctx) return
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
  for (let i = 0; i <= 8; i++) {
    const a = -Math.PI * 1.25 + (Math.PI * 1.5) * (i / 8)
    const r1 = r - 1, r2 = r - (i % 4 === 0 ? 6 : 3)
    ctx.lineWidth = i % 4 === 0 ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
    ctx.stroke()
  }
  const lcm = computeLCM()
  const tickN = lastTick >= 0 ? lastTick : 0
  const progress = lcm > 0 ? ((tickN % lcm) + lcm) % lcm / lcm : 0
  const remaining = lcm > 0 ? lcm - (tickN % lcm) : 0
  const ang = -Math.PI * 1.25 + (Math.PI * 1.5) * progress
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + Math.cos(ang) * (r - 5), cy + Math.sin(ang) * (r - 5))
  ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2); ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.font = `bold ${Math.max(7, r * 0.30)}px monospace`
  ctx.fillText('CONV', cx, cy + r - 3)
  ctx.font = `bold ${Math.max(8, r * 0.34)}px monospace`
  ctx.fillText(String(remaining), cx, cy + 4)
}

function drawTrackGrid(x: number, y: number, w: number, h: number, needleR: number) {
  if (!ctx) return
  const cols = 8, rows = 2
  const cellW = w / cols, cellH = h / rows
  const trks = props.tracksRaw.current
  const heads = props.displayHeads.current
  const anySolo = trks.some((t) => !!t?.solo)
  for (let i = 0; i < TRACK_COUNT; i++) {
    const trk = trks[i]; if (!trk) continue
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = x + col * cellW + cellW / 2
    const cy = y + row * cellH + cellH / 2
    drawTrackNeedle(cx, cy, needleR, trk, heads[i] ?? -1, anySolo)
  }
}

function drawTrackNeedle(cx: number, cy: number, r: number, trk: Track, head: number, anySolo: boolean) {
  if (!ctx) return
  const sc = trk.steps.length
  const muted = isEffMuted(trk, anySolo)
  const color = muted ? '#444' : '#fff'
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - r + Math.max(1, r * 0.3))
  ctx.stroke()
  if (!muted && sc > 0 && head >= 0) {
    const safeHead = head % sc
    const ang = -Math.PI / 2 + (Math.PI * 2) * safeHead / sc
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(ang) * (r - 1), cy + Math.sin(ang) * (r - 1))
    ctx.stroke()
  }
}

function computeLCM(): number {
  const trks = props.tracksRaw.current
  const anySolo = trks.some((t) => !!t?.solo)
  const counts: number[] = []
  for (const trk of trks) {
    if (!trk) continue
    if (isEffMuted(trk, anySolo)) continue
    if (trk.steps.length > 0) counts.push(trk.steps.length)
  }
  if (counts.length === 0) return 0
  return counts.reduce((a, b) => a * b / gcd(a, b), 1)
}

function drawSun() {
  if (!ctx) return
  const cx = W * 0.62, cy = HORIZON_Y - 28, r = 26
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
  for (let i = 1; i <= 6; i++) {
    const dy = i * 4
    if (dy > r) break
    const halfW = Math.sqrt(r * r - dy * dy)
    ctx.beginPath(); ctx.moveTo(cx - halfW, cy + dy); ctx.lineTo(cx + halfW, cy + dy); ctx.stroke()
  }
}

function drawHorizonGrid() {
  if (!ctx) return
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1
  // Vertical grid lines — converge to vanishing point at z=∞ (≈ HORIZON_Y)
  for (let i = -7; i <= 7; i++) {
    const a = projOnRoad(i * 2.8, 0, NEAR_Z); const b = projOnRoad(i * 2.8, 0, 500)
    if (!a || !b) continue
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
  }
  // Horizontal grid lines — extended to z=500 so they reach all the way up to
  // the vanishing point (was z<80 which left a visible gap above the floor).
  const t = audioTimeMs() / 1000
  const speed = props.bpm * 0.2
  const offset = (t * speed) % 5
  for (let z = -offset; z < 500; z += 5) {
    if (z < NEAR_Z) continue
    const left = projOnRoad(-100, 0, z); const right = projOnRoad(100, 0, z)
    if (!left || !right) continue
    ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(right.x, right.y); ctx.stroke()
  }
}

function drawRoad() {
  if (!ctx) return
  // Edges extend to z=500 (same as grid vanishing point) for smooth horizon
  // contact. Log-spaced sampling so the curve stays smooth where it's visible
  // (close z) without wasting samples at far z which all squash near horizon.
  const N = 32
  const Z_END = 500
  const RATIO = Z_END / NEAR_Z
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
  // Left edge
  ctx.beginPath()
  for (let i = 0; i <= N; i++) {
    const z = NEAR_Z * Math.pow(RATIO, i / N)
    const p = projOnRoad(-ROAD_HALF, 0, z); if (!p) continue
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
  // Right edge
  ctx.beginPath()
  for (let i = 0; i <= N; i++) {
    const z = NEAR_Z * Math.pow(RATIO, i / N)
    const p = projOnRoad(ROAD_HALF, 0, z); if (!p) continue
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
  // Center dashes — stay within FAR_Z (further would be sub-pixel)
  const t = audioTimeMs() / 1000
  const speed = props.bpm * 0.2
  const offset = (t * speed) % 6
  ctx.lineWidth = 1.5
  for (let z = -offset + NEAR_Z; z < FAR_Z; z += 6) {
    if (z < NEAR_Z) continue
    const a = projOnRoad(0, 0, z); const b = projOnRoad(0, 0, z + 3); if (!a || !b) continue
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
  }
}

function drawObject(obj: any) {
  if (!ctx) return
  const wz = obj.z, x = obj.roadX
  const sc = obj.scale !== undefined ? obj.scale : 1
  if (sc <= 0) return
  const baseProj = projOnRoad(x, 0, wz)
  if (!baseProj) return
  ctx.save()
  if (sc !== 1) {
    ctx.translate(baseProj.x, baseProj.y); ctx.scale(sc, sc); ctx.translate(-baseProj.x, -baseProj.y)
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1
  switch (obj.type) {
    case 'lamp_l': { const b = projOnRoad(x, 0, wz), t = projOnRoad(x, 4.5, wz), a = projOnRoad(x - obj.side * 1.2, 4.5, wz); if (b && t) { strokeLine(b, t, 1); if (a) { strokeLine(t, a, 1); ctx.beginPath(); ctx.arc(a.x, a.y, Math.max(2, b.scale * 0.13), 0, Math.PI * 2); ctx.stroke() } } break }
    case 'sign_l': { const b = projOnRoad(x, 0, wz), s = projOnRoad(x, 2.5, wz), c1 = projOnRoad(x - 1.6, 2.5, wz), c2 = projOnRoad(x + 1.6, 2.5, wz), c3 = projOnRoad(x + 1.6, 4.6, wz), c4 = projOnRoad(x - 1.6, 4.6, wz); if (b && s && c1 && c2 && c3 && c4) { strokeLine(b, s, 1); ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y); ctx.lineTo(c4.x, c4.y); ctx.closePath(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c3.x, c3.y); ctx.moveTo(c2.x, c2.y); ctx.lineTo(c4.x, c4.y); ctx.stroke() } break }
    case 'sign_tri': { const b = projOnRoad(x, 0, wz), s = projOnRoad(x, 2.6, wz), a = projOnRoad(x, 4.4, wz), l = projOnRoad(x - 1.3, 2.6, wz), r = projOnRoad(x + 1.3, 2.6, wz); if (b && s && a && l && r) { strokeLine(b, s, 1); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.closePath(); ctx.stroke(); const cx = (l.x + r.x) / 2, cy = a.y + (l.y - a.y) * 0.55, ds = Math.max(1, b.scale * 0.04); ctx.fillStyle = '#fff'; ctx.fillRect(cx - ds / 2, cy - ds * 1.5, ds, ds * 2); ctx.fillRect(cx - ds / 2, cy + ds * 0.8, ds, ds * 0.6) } break }
    case 'sign_circ': { const b = projOnRoad(x, 0, wz), s = projOnRoad(x, 3.0, wz), top = projOnRoad(x, 4.0, wz); if (b && top) { if (s) strokeLine(b, s, 1); const cx = top.x, cy = top.y, r = Math.max(3, b.scale * 0.45); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx - r * 0.7, cy + r * 0.7); ctx.lineTo(cx + r * 0.7, cy - r * 0.7); ctx.stroke() } break }
    case 'signal': { const b = projOnRoad(x, 0, wz), s = projOnRoad(x, 3.2, wz), c1 = projOnRoad(x - 0.55, 3.2, wz), c2 = projOnRoad(x + 0.55, 3.2, wz), c3 = projOnRoad(x + 0.55, 5.0, wz), c4 = projOnRoad(x - 0.55, 5.0, wz); if (b && s && c1 && c2 && c3 && c4) { strokeLine(b, s, 1); ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y); ctx.lineTo(c4.x, c4.y); ctx.closePath(); ctx.stroke(); const dotR = Math.max(1, b.scale * 0.06), cx = (c1.x + c2.x) / 2; for (let i = 0; i < 3; i++) { const ratio = (i + 0.5) / 3, dy = c1.y + (c4.y - c1.y) * ratio; ctx.beginPath(); ctx.arc(cx, dy, dotR, 0, Math.PI * 2); ctx.stroke() } } break }
    case 'cone': { const b1 = projOnRoad(x - 0.4, 0, wz), b2 = projOnRoad(x + 0.4, 0, wz), t = projOnRoad(x, 0.7, wz); if (b1 && b2 && t) { ctx.beginPath(); ctx.moveTo(b1.x, b1.y); ctx.lineTo(t.x, t.y); ctx.lineTo(b2.x, b2.y); ctx.closePath(); ctx.stroke(); const my = (b1.y + t.y) / 2, mxL = b1.x + (t.x - b1.x) * 0.45, mxR = b2.x + (t.x - b2.x) * 0.45; strokeLine({ x: mxL, y: my }, { x: mxR, y: my }, 1) } break }
    case 'reflector': { const c = projOnRoad(x, 0.3, wz); if (c) { const sz = Math.max(1, c.scale * 0.07); ctx.strokeRect(c.x - sz / 2, c.y - sz / 2, sz, sz) } break }
    case 'bench': { const b1 = projOnRoad(x - 0.8, 0, wz), b2 = projOnRoad(x + 0.8, 0, wz), t1 = projOnRoad(x - 0.8, 0.5, wz), t2 = projOnRoad(x + 0.8, 0.5, wz); if (b1 && b2 && t1 && t2) { strokeLine(b1, t1, 1); strokeLine(b2, t2, 1); strokeLine(t1, t2, 1); const t1b = projOnRoad(x - 0.8, 1.1, wz), t2b = projOnRoad(x + 0.8, 1.1, wz); if (t1b && t2b) { strokeLine(t1, t1b, 1); strokeLine(t2, t2b, 1); strokeLine(t1b, t2b, 1) } } break }
    case 'pole_thin': { const b = projOnRoad(x, 0, wz), t = projOnRoad(x, 1.4, wz); if (b && t) strokeLine(b, t, 1); break }
    case 'hydrant': { const b1 = projOnRoad(x - 0.3, 0, wz), b2 = projOnRoad(x + 0.3, 0, wz), t1 = projOnRoad(x - 0.3, 0.6, wz), t2 = projOnRoad(x + 0.3, 0.6, wz); if (b1 && b2 && t1 && t2) { ctx.beginPath(); ctx.moveTo(b1.x, b1.y); ctx.lineTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y); ctx.lineTo(b2.x, b2.y); ctx.closePath(); ctx.stroke(); const cx = (t1.x + t2.x) / 2, r = Math.max(1, b1.scale * 0.06); ctx.beginPath(); ctx.arc(cx, t1.y, r, Math.PI, 0); ctx.stroke(); strokeLine({ x: t1.x - 2, y: (t1.y + b1.y) / 2 }, { x: t1.x, y: (t1.y + b1.y) / 2 }, 1); strokeLine({ x: t2.x, y: (t2.y + b2.y) / 2 }, { x: t2.x + 2, y: (t2.y + b2.y) / 2 }, 1) } break }
    case 'tree': { const b = projOnRoad(x, 0, wz), trunk = projOnRoad(x, 1.4, wz), apex = projOnRoad(x, 4.8, wz), l = projOnRoad(x - 1.4, 1.4, wz), r = projOnRoad(x + 1.4, 1.4, wz); if (b && apex && l && r) { if (trunk) strokeLine(b, trunk, 1); ctx.beginPath(); ctx.moveTo(apex.x, apex.y); ctx.lineTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.closePath(); ctx.stroke(); const my = (l.y + apex.y) / 2; strokeLine({ x: l.x * 0.6 + r.x * 0.4, y: my }, { x: l.x * 0.4 + r.x * 0.6, y: my }, 1) } break }
    case 'utility': { const b = projOnRoad(x, 0, wz), t = projOnRoad(x, 5.2, wz), al = projOnRoad(x - 1.5, 4.8, wz), ar = projOnRoad(x + 1.5, 4.8, wz), al2 = projOnRoad(x - 1.5, 4.3, wz), ar2 = projOnRoad(x + 1.5, 4.3, wz); if (b && t && al && ar) { strokeLine(b, t, 1); strokeLine(al, ar, 1); if (al2 && ar2) strokeLine(al2, ar2, 1); const al_n = projOnRoad(x - 1.5, 4.6, wz + 2), ar_n = projOnRoad(x + 1.5, 4.6, wz + 2); if (al_n) strokeLine(al, al_n, 1); if (ar_n) strokeLine(ar, ar_n, 1) } break }
    case 'wall': { const len = 1.8, b1 = projOnRoad(x, 0, wz), b2 = projOnRoad(x, 0, wz + len), t1 = projOnRoad(x, 1.4, wz), t2 = projOnRoad(x, 1.4, wz + len); if (b1 && b2 && t1 && t2) { ctx.beginPath(); ctx.moveTo(b1.x, b1.y); ctx.lineTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y); ctx.lineTo(b2.x, b2.y); ctx.closePath(); ctx.stroke(); const t1m = projOnRoad(x, 1.4, wz + len * 0.5); if (t1m) strokeLine(b1, t1m, 1) } break }
    case 'torii': { const HALF = 1.0, HEIGHT = 3.5, lb = projOnRoad(x - HALF, 0, wz), lt = projOnRoad(x - HALF, HEIGHT, wz), rb = projOnRoad(x + HALF, 0, wz), rt = projOnRoad(x + HALF, HEIGHT, wz), ltop = projOnRoad(x - HALF - 0.5, HEIGHT + 0.4, wz), rtop = projOnRoad(x + HALF + 0.5, HEIGHT + 0.4, wz), lbeam = projOnRoad(x - HALF - 0.1, HEIGHT - 0.7, wz), rbeam = projOnRoad(x + HALF + 0.1, HEIGHT - 0.7, wz); if (lb && lt && rb && rt && ltop && rtop && lbeam && rbeam) { strokeLine(lb, lt, 1.2); strokeLine(rb, rt, 1.2); const mid = projOnRoad(x, HEIGHT + 0.6, wz); if (mid) { ctx.beginPath(); ctx.moveTo(ltop.x, ltop.y); ctx.quadraticCurveTo(mid.x, mid.y - 2, rtop.x, rtop.y); ctx.stroke() } else strokeLine(ltop, rtop, 1.2); strokeLine(lbeam, rbeam, 1) } break }
    case 'vending': { const b1 = projOnRoad(x - 0.6, 0, wz), b2 = projOnRoad(x + 0.6, 0, wz), t1 = projOnRoad(x - 0.6, 1.8, wz), t2 = projOnRoad(x + 0.6, 1.8, wz); if (b1 && b2 && t1 && t2) { ctx.beginPath(); ctx.moveTo(b1.x, b1.y); ctx.lineTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y); ctx.lineTo(b2.x, b2.y); ctx.closePath(); ctx.stroke(); for (let i = 1; i < 3; i++) { const ty = t1.y + (b1.y - t1.y) * i / 3; strokeLine({ x: t1.x, y: ty }, { x: t2.x, y: ty }, 1) } const cxv = (t1.x + t2.x) / 2; strokeLine({ x: cxv, y: t1.y }, { x: cxv, y: b1.y }, 1) } break }
    case 'guardrail': { const b = projOnRoad(x, 0, wz), t = projOnRoad(x, 0.9, wz), tNext = projOnRoad(x, 0.9, wz + 2.0), bNext = projOnRoad(x, 0.4, wz + 2.0), bMid = projOnRoad(x, 0.4, wz); if (b && t) { strokeLine(b, t, 1); if (tNext) strokeLine(t, tNext, 1); if (bMid && bNext) strokeLine(bMid, bNext, 1) } break }
    case 'wind_turbine': { const HEIGHT = obj.big ? 9.0 : 7.0, BLADE_LEN_W = obj.big ? 3.5 : 2.5, proj_b = projOnRoad(x, 0, wz), proj_t = projOnRoad(x, HEIGHT, wz); if (proj_b && proj_t) { ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1, proj_b.scale * 0.04); ctx.beginPath(); ctx.moveTo(proj_b.x, proj_b.y); ctx.lineTo(proj_t.x, proj_t.y); ctx.stroke(); const hubR = Math.max(2, proj_b.scale * 0.08); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(proj_t.x, proj_t.y, hubR, 0, Math.PI * 2); ctx.fill(); ctx.lineWidth = 1.2; ctx.stroke(); const bladeLen = Math.max(10, BLADE_LEN_W * proj_b.scale * 0.5), rot = audioTimeMs() / 1000 * 0.9; ctx.lineWidth = Math.max(1, proj_b.scale * 0.035); for (let i = 0; i < 3; i++) { const a = rot + i * (Math.PI * 2 / 3), ex = proj_t.x + Math.cos(a) * bladeLen, ey = proj_t.y + Math.sin(a) * bladeLen; ctx.beginPath(); ctx.moveTo(proj_t.x, proj_t.y); ctx.lineTo(ex, ey); ctx.stroke() } } break }
    case 'gantry': drawGantry(obj, wz); break
    case 'mega': drawMegaComposite(obj, wz); break
  }
  ctx.restore()
}

function drawGantry(_obj: any, wz: number) {
  if (!ctx) return
  const HALF = 5.5, HEIGHT = 4.5
  const lb = projOnRoad(-HALF, 0, wz), lt = projOnRoad(-HALF, HEIGHT, wz)
  const rb = projOnRoad(HALF, 0, wz), rt = projOnRoad(HALF, HEIGHT, wz)
  if (!lb || !lt || !rb || !rt) return
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.moveTo(lb.x, lb.y); ctx.lineTo(lt.x, lt.y); ctx.moveTo(rb.x, rb.y); ctx.lineTo(rt.x, rt.y); ctx.moveTo(lt.x, lt.y); ctx.lineTo(rt.x, rt.y); ctx.stroke()
  const cx = (lt.x + rt.x) / 2, sw = Math.max(8, lb.scale * 1.0), sh = Math.max(4, lb.scale * 0.5)
  ctx.fillStyle = '#000'; ctx.fillRect(cx - sw / 2, lt.y + 2, sw, sh); ctx.strokeRect(cx - sw / 2, lt.y + 2, sw, sh)
}

function drawOverpassSolid(_obj: any, wz: number, HALF: number, HEIGHT: number, DECK_H: number, depth: number, label: string | null) {
  if (!ctx) return
  const flb = projOnRoad(-HALF, 0, wz), flt = projOnRoad(-HALF, HEIGHT, wz), frb = projOnRoad(HALF, 0, wz), frt = projOnRoad(HALF, HEIGHT, wz)
  const fdl = projOnRoad(-HALF, HEIGHT + DECK_H, wz), fdr = projOnRoad(HALF, HEIGHT + DECK_H, wz)
  const blb = projOnRoad(-HALF, 0, wz + depth), blt = projOnRoad(-HALF, HEIGHT, wz + depth)
  const brb = projOnRoad(HALF, 0, wz + depth), brt = projOnRoad(HALF, HEIGHT, wz + depth)
  const bdl = projOnRoad(-HALF, HEIGHT + DECK_H, wz + depth), bdr = projOnRoad(HALF, HEIGHT + DECK_H, wz + depth)
  if (!flb || !flt || !frb || !frt || !fdl || !fdr) return
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#fff'
  if (blb && blt) { ctx.beginPath(); ctx.moveTo(flb.x, flb.y); ctx.lineTo(flt.x, flt.y); ctx.lineTo(blt.x, blt.y); ctx.lineTo(blb.x, blb.y); ctx.closePath(); ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke() }
  if (brb && brt) { ctx.beginPath(); ctx.moveTo(frb.x, frb.y); ctx.lineTo(frt.x, frt.y); ctx.lineTo(brt.x, brt.y); ctx.lineTo(brb.x, brb.y); ctx.closePath(); ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke() }
  if (blt && brt) { ctx.beginPath(); ctx.moveTo(flt.x, flt.y); ctx.lineTo(frt.x, frt.y); ctx.lineTo(brt.x, brt.y); ctx.lineTo(blt.x, blt.y); ctx.closePath(); ctx.fill(); ctx.lineWidth = 1; ctx.stroke() }
  ctx.beginPath(); ctx.moveTo(flt.x, flt.y); ctx.lineTo(frt.x, frt.y); ctx.lineTo(fdr.x, fdr.y); ctx.lineTo(fdl.x, fdl.y); ctx.closePath(); ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke()
  if (bdl && bdr) { ctx.beginPath(); ctx.moveTo(fdl.x, fdl.y); ctx.lineTo(fdr.x, fdr.y); ctx.lineTo(bdr.x, bdr.y); ctx.lineTo(bdl.x, bdl.y); ctx.closePath(); ctx.fill(); ctx.lineWidth = 1; ctx.stroke() }
  if (label) {
    const labelW = frt.x - flt.x
    if (labelW > 50) {
      const fontSize = Math.max(8, Math.min(20, flb.scale * 0.4))
      ctx.fillStyle = '#fff'; ctx.font = `bold ${fontSize}px monospace`; ctx.textAlign = 'center'
      const cx = (flt.x + frt.x) / 2, cy = (flt.y + fdl.y) / 2 + fontSize / 3
      ctx.fillText(label, cx, cy)
    }
  }
}

function drawLongHorizontalBar(wz: number, HEIGHT: number, DECK_H: number, depth: number) {
  if (!ctx) return
  const halfW = W / 2
  const flx = -halfW * wz / FOCAL + CAM_X, frx = halfW * wz / FOCAL + CAM_X
  const blx = -halfW * (wz + depth) / FOCAL + CAM_X, brx = halfW * (wz + depth) / FOCAL + CAM_X
  const flt = project(flx, HEIGHT, wz), frt = project(frx, HEIGHT, wz)
  const fdl = project(flx, HEIGHT + DECK_H, wz), fdr = project(frx, HEIGHT + DECK_H, wz)
  const blt = project(blx, HEIGHT, wz + depth), brt = project(brx, HEIGHT, wz + depth)
  const bdl = project(blx, HEIGHT + DECK_H, wz + depth), bdr = project(brx, HEIGHT + DECK_H, wz + depth)
  if (!flt || !frt || !fdl || !fdr) return
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#fff'
  if (bdl && bdr) { ctx.beginPath(); ctx.moveTo(fdl.x, fdl.y); ctx.lineTo(fdr.x, fdr.y); ctx.lineTo(bdr.x, bdr.y); ctx.lineTo(bdl.x, bdl.y); ctx.closePath(); ctx.fill(); ctx.lineWidth = 1; ctx.stroke() }
  if (blt && brt) { ctx.beginPath(); ctx.moveTo(flt.x, flt.y); ctx.lineTo(frt.x, frt.y); ctx.lineTo(brt.x, brt.y); ctx.lineTo(blt.x, blt.y); ctx.closePath(); ctx.fill() }
  ctx.beginPath(); ctx.moveTo(flt.x, flt.y); ctx.lineTo(frt.x, frt.y); ctx.lineTo(fdr.x, fdr.y); ctx.lineTo(fdl.x, fdl.y); ctx.closePath(); ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke()
}

function drawMegaComposite(obj: any, wz: number) {
  const HALF = 8.5, HEIGHT = 4.5, DECK_H = 1.4, depth = 1.0
  drawLongHorizontalBar(wz, HEIGHT, DECK_H, depth)
  drawOverpassSolid({ ...obj, roadX: 0 }, wz, HALF, HEIGHT, DECK_H, depth, null)
  drawOverpassSolid({ ...obj, roadX: 0 }, wz, HALF, HEIGHT, DECK_H, depth, null)
  drawOverpassSolid({ ...obj, roadX: 0 }, wz, HALF, HEIGHT, DECK_H, depth, '政府は嘘をついている')
}

// ── Mute / pattern change handling (surgical) ─────────────
function shrinkTrackInFlight(trkIdx: number) {
  for (const obj of objects) if (obj.trackIdx === trkIdx) obj.scaleState = 'shrinking'
}

function spawnTrackBacklog(trk: Track, trkIdx: number) {
  if (lastSpawnedTick <= lastTick) return
  const audio_ms = audioTimeMs(); const sm = stepMs(); const speed = props.bpm * 0.2
  const sc = trk.steps.length; if (sc <= 0) return
  for (let t = lastTick + 1; t <= lastSpawnedTick; t++) {
    const effT = effectiveTick(t)
    const localStep = ((effT % sc) + sc) % sc
    if (trk.steps[localStep]) {
      const z_at_spawn = PLAYHEAD_Z + ((t * sm - audio_ms) / 1000) * speed
      spawnObject(trk, trkIdx, 0, z_at_spawn, effT)
    }
  }
}

function resetSpawnPipeline() {
  // Hard reset on BPM/structural change
  objects.length = 0
  lastSpawnedTick = lastTick
}

// ── Animation loop ────────────────────────────────────────
function animate() {
  const now = performance.now()
  const dt = lastFrameMs ? Math.min(0.1, (now - lastFrameMs) / 1000) : 0
  lastFrameMs = now
  updateCurve(dt)
  processTicks()
  updateObjects(dt)
  render()
  rafId = requestAnimationFrame(animate)
}

// ── Lifecycle ─────────────────────────────────────────────
function regenStars() {
  STARS.length = 0
  const skyH = HORIZON_Y * 0.7
  for (let i = 0; i < 40; i++) {
    STARS.push({ x: Math.floor(Math.random() * W), y: Math.floor(Math.random() * skyH) })
  }
}

function syncCanvasSize() {
  const c = canvasRef.value
  const container = containerRef.value
  if (!c || !container) return
  const w = Math.max(2, container.clientWidth)
  const h = Math.max(2, container.clientHeight)
  if (c.width !== w) c.width = w
  if (c.height !== h) c.height = h
  W = w; H = h
  HORIZON_Y = H * HORIZON_FRAC
  FOCAL = W * FOCAL_FRAC
  DASH_H = H * DASH_H_FRAC
  DASH_Y = H - DASH_H
  if (ctx) ctx.imageSmoothingEnabled = false
  regenStars()
}

onMounted(() => {
  const c = canvasRef.value; const container = containerRef.value
  if (!c || !container) return
  ctx = c.getContext('2d')
  if (!ctx) return
  syncCanvasSize()
  resizeObserver = new ResizeObserver(() => syncCanvasSize())
  resizeObserver.observe(container)
  // initialize last effective-mute snapshot (combines mute + solo)
  const anySolo0 = props.tracks.some((t) => !!t?.solo)
  for (let i = 0; i < TRACK_COUNT; i++) {
    const trk = props.tracks[i]
    lastEffMutes[i] = !!trk && (trk.mute || (anySolo0 && !trk.solo))
    lastStepLen[i] = trk?.steps.length || 0
  }
  rafId = requestAnimationFrame(animate)
})

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId)
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null }
})

// Watch playing → sync local audio clock
watch(() => props.playing, (newVal, oldVal) => {
  if (newVal && !oldVal) {
    audioStartMs = performance.now()
  } else if (!newVal && oldVal) {
    elapsedBeforePauseMs += performance.now() - audioStartMs
  } else if (!newVal) {
    // initial mount with playing=false; keep elapsed at 0
  }
  if (!newVal) {
    // on stop, reset everything
    elapsedBeforePauseMs = 0
    objects.length = 0
    lastTick = -1
    lastSpawnedTick = -1
  }
})

// Watch BPM → reset pipeline
watch(() => props.bpm, () => { resetSpawnPipeline() })

// Watch masterTarget → enable/disable road curve during meter transitions
watch(() => props.masterTarget, (nv, ov) => {
  if (nv && !ov) {
    // transition started → swing road in alternating direction
    curveDirection *= -1
    curveTarget = curveDirection
  } else if (!nv && ov) {
    // transition ended → straighten back
    curveTarget = 0
  }
})

// Watch tracks for mute / solo / pattern changes — uses effective mute
// (combining mute + solo) so toggling solo on one track properly shrinks
// the others in flight.
watch(() => props.tracks, (nt) => {
  if (!nt) return
  const anySolo = nt.some((t) => !!t?.solo)
  for (let i = 0; i < TRACK_COUNT; i++) {
    const trk = nt[i]; if (!trk) continue
    const wasEff = lastEffMutes[i]
    const isEff = trk.mute || (anySolo && !trk.solo)
    const lenChanged = trk.steps.length !== lastStepLen[i]
    if (!wasEff && isEff) shrinkTrackInFlight(i)
    else if (wasEff && !isEff) spawnTrackBacklog(trk, i)
    if (lenChanged) {
      for (const obj of objects) if (obj.trackIdx === i) obj.scaleState = 'shrinking'
      lastStepLen[i] = trk.steps.length
    }
    lastEffMutes[i] = isEff
  }
}, { deep: true })

// Watch REP toggle → set/clear loop anchor and reset spawn pipeline.
// (Lookahead window when looping a 4-tick repeat is meaningfully different
// from regular forward play, so a clean re-schedule is simpler.)
watch(() => props.repeatOn, (nv) => {
  if (nv) repAnchor = Math.max(0, lastTick + 1)
  else repAnchor = null
  resetSpawnPipeline()
})
// Rate change while REP is on — same window invalidation
watch(() => props.repeatRate, () => {
  if (props.repeatOn) {
    repAnchor = Math.max(0, lastTick + 1)
    resetSpawnPipeline()
  }
})
</script>

<style scoped>
.drive-view-root {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  overflow: hidden;
}
canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
