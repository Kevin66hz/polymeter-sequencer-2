<!--
  SolarView.vue — Per-track "one star, weird orbits" view for Type2Plus.

  Concept (revised):
    - Each track has ONE moving star. Not one per step — one per track.
    - The star orbits around a closed curve that's anchored at the
      track's fixed trigger point (+x apex of the orbit).
    - The orbit's SIZE depends on how many active beats the pattern has.
        Fewer beats  → bigger orbit (wraps around the sun).
        More beats   → smaller orbit (loops near the trigger, doesn't
                        go near the sun).
        Formula: orbitR = a / K, where a is the track's distance-from-
        sun slot and K is the active-beat count. K=1 puts the orbit
        centered on the sun; K=4 makes it tiny and stays on the trigger
        side.
    - The orbit's SHAPE depends on the time signature. Straight meters
      (4/4) → circle. Odd meters (7/8, 5/4, 13/16...) → ellipse with
      proportional eccentricity.
    - The star completes one revolution for each beat — so for a 4-beat
      pattern, the star orbits 4 times per pattern loop. Within each
      revolution, the star arrives at the trigger exactly when the
      scheduler fires that beat.
    - Uneven gaps between active beats mean the star's angular speed
      varies between revolutions — fast when beats are close, slow
      when spaced apart.
    - When the pattern is empty (K=0), the orbit and star are hidden.
      The trigger marker stays as a positional anchor.

  Conceptually this is an epicycle / rhythm-as-orbit visualization:
    "the weirder the rhythm, the weirder the orbit."

  Design rules (unchanged from other 3D views):
    - Client-only; dynamic imports in onMounted.
    - RAF hot loop reads only raw mirrors (displayHeads / tracksRaw).
    - Per-track rebuilds are triggered via a `watch` on props.tracks.
-->

<template>
  <div ref="containerRef" class="relative w-full h-full overflow-hidden bg-[#050510]" />
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { TRACK_COUNT, type Track } from '#core/types'

const props = defineProps<{
  tracks: Track[]
  displayHeads: { current: number[] }
  tracksRaw: { current: Track[] }
  selectedId: number
}>()

const containerRef = ref<HTMLDivElement | null>(null)

let THREE: any = null
let scene: any = null
let camera: any = null
let renderer: any = null
let controls: any = null
let sun: any = null
let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
let running = false

// Shared geometries
let starGeo: any = null       // the moving star per track
let triggerGeo: any = null    // the fixed trigger marker per track

type TrackVis = {
  orbitLine: any | null        // null when K == 0
  orbitMat: any | null
  trigger: any                 // fixed marker at orbit's +x apex
  triggerMat: any
  star: any                    // single moving star
  starMat: any
  // Pattern data for angle computation
  activeSteps: number[]        // sorted step indices where trk.steps[si] === true
  gaps: number[]               // cyclic gap (in steps) after each active beat
  K: number                    // activeSteps.length
  // Orbit geometry cached for the hot loop
  a: number                    // trigger's distance from sun (track slot)
  orbitR: number               // orbit semi-major (= a / K when K > 0)
  centerLocalX: number         // orbit center in track-local +x: a - orbitR
  semiMinor: number            // orbitR * sqrt(1 - e²), for time-sig ellipse
  cosO: number                 // track orientation cached for world-space mapping
  sinO: number
}
const trackVis: (TrackVis | null)[] = Array(TRACK_COUNT).fill(null)

// Per-track displayed orbit angle (radians). 0 = star at trigger.
// Preserved across rebuilds so step toggles don't snap the star back.
const displayedAngle: number[] = Array(TRACK_COUNT).fill(0)
// Per-track last-seen head. -1 marks "next tick should snap the star".
const lastHead: number[] = Array(TRACK_COUNT).fill(-1)

// ── Orbit slot / orientation / shape helpers ───────────────────────
// Every track shares the same orbit size — what differentiates tracks
// is the *orientation* of the orbit around the Y axis and the
// *eccentricity* from the time signature. Same-sized ellipses pointing
// different directions with different amounts of stretch weave into a
// tangled "orrery" look. (Circular 4/4 orbits overlap each other, but
// the non-4/4 tracks provide all the variation.)
const SHARED_A = 5

function trackSlotA(_ti: number): number {
  return SHARED_A
}

function trackOrientation(ti: number): number {
  return (ti / TRACK_COUNT) * Math.PI * 2
}

// Eccentricity from the track's time signature. 4/4 → 0 (circle);
// odd meters bend it into an ellipse proportional to how far the
// ratio sits from a whole quarter.
function eccentricityFromSig(timeSig: string): number {
  const parts = timeSig.split('/')
  const n = Number(parts[0])
  const d = Number(parts[1])
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0 || n === 0) return 0
  const ratio = n / d
  const deviation = Math.abs(ratio - 1)
  return Math.min(0.8, deviation * 1.2)
}

// Given the scheduler's current head, compute the star's target orbit
// angle (0 = trigger, 2π = back at trigger at next beat).
//
// We find which gap head belongs to and linearly advance from 0 at the
// gap's active beat to 2π at the next active beat. With K beats, this
// gives the star K revolutions per pattern loop, hitting the trigger
// exactly at each active step.
function computeTargetAngle(head: number, total: number, vis: TrackVis): number {
  const { K, activeSteps, gaps } = vis
  if (K === 0) return 0
  for (let i = 0; i < K; i++) {
    const start = activeSteps[i]
    const g = gaps[i]
    const diff = ((head - start) % total + total) % total
    if (diff < g) {
      return 2 * Math.PI * diff / g
    }
  }
  return 0
}

// Map a track-local (x, z) coordinate into world space using the
// track's cached orientation.
function worldXZ(xLocal: number, zLocal: number, cosO: number, sinO: number): [number, number] {
  return [
    xLocal * cosO - zLocal * sinO,
    xLocal * sinO + zLocal * cosO,
  ]
}

// ── Per-track build / dispose ──────────────────────────────────────

function disposeTrack(vis: TrackVis) {
  if (vis.orbitLine) {
    scene.remove(vis.orbitLine)
    vis.orbitLine.geometry.dispose()
    vis.orbitMat.dispose()
  }
  scene.remove(vis.trigger)
  vis.triggerMat.dispose()
  scene.remove(vis.star)
  vis.starMat.dispose()
}

function buildTrack(ti: number, trk: Track): TrackVis {
  const color = new THREE.Color(trk.color)
  const a = trackSlotA(ti)
  const orientation = trackOrientation(ti)
  const cosO = Math.cos(orientation)
  const sinO = Math.sin(orientation)
  const e = eccentricityFromSig(trk.timeSig)
  const total = trk.steps.length
  const isSelected = props.selectedId === ti

  // ── Collect active beats and gaps ──
  const activeSteps: number[] = []
  for (let si = 0; si < total; si++) {
    if (trk.steps[si]) activeSteps.push(si)
  }
  const K = activeSteps.length

  const gaps: number[] = []
  for (let i = 0; i < K; i++) {
    const next = (i + 1) % K
    let g = activeSteps[next] - activeSteps[i]
    if (g <= 0) g += total // handles K=1 (self-gap) and the cyclic wrap
    gaps.push(g)
  }

  // ── Orbit parameters ──
  // Default behavior: orbit encompasses the sun (classic planet-round-
  // sun look). Only when the pattern gets dense does the orbit shrink
  // toward the trigger, so dense tracks spin "in place" instead of
  // crossing the whole system.
  //
  //   orbitR = a * min(1, SHRINK_THRESHOLD / K)
  //   centerLocalX = a - orbitR   (shifts from sun to trigger as it shrinks)
  //
  // K ≤ SHRINK_THRESHOLD: orbitR = a, center at sun → orbit wraps sun.
  // K > SHRINK_THRESHOLD: orbitR shrinks like SHRINK_THRESHOLD / K, and
  //                       the center slides toward the trigger, so the
  //                       star loops "in place" near its anchor.
  //
  // Polymeter + per-track Y-rotation gives each sparse track its own
  // direction around the sun; their big ellipses tangle into each
  // other while dense tracks chatter near their own triggers.
  const SHRINK_THRESHOLD = 3
  const orbitR = K > 0 ? a * Math.min(1, SHRINK_THRESHOLD / K) : 0
  const semiMinor = orbitR * Math.sqrt(Math.max(0, 1 - e * e))
  const centerLocalX = a - orbitR

  // ── Orbit line (only when there's something to orbit) ──
  let orbitLine: any = null
  let orbitMat: any = null
  if (K > 0) {
    const segments = 128
    const pts = new Float32Array((segments + 1) * 3)
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2
      const xL = centerLocalX + orbitR * Math.cos(t)
      const zL = semiMinor * Math.sin(t)
      const [x, z] = worldXZ(xL, zL, cosO, sinO)
      pts[i * 3 + 0] = x
      pts[i * 3 + 1] = 0
      pts[i * 3 + 2] = z
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    orbitMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: isSelected ? 0.55 : 0.25,
    })
    orbitLine = new THREE.Line(geo, orbitMat)
    scene.add(orbitLine)
  }

  // ── Fixed trigger marker at track local (a, 0, 0) ──
  const triggerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: isSelected ? 0.85 : 0.55,
  })
  const trigger = new THREE.Mesh(triggerGeo, triggerMat)
  const [tx, tz] = worldXZ(a, 0, cosO, sinO)
  trigger.position.set(tx, 0, tz)
  scene.add(trigger)

  // ── Single moving star ──
  let starOpacity: number
  if (K === 0) starOpacity = 0 // hidden anyway
  else if (trk.mute) starOpacity = 0.3
  else starOpacity = isSelected ? 1.0 : 0.85

  const starMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: starOpacity,
  })
  const star = new THREE.Mesh(starGeo, starMat)
  star.visible = false
  // Seed position at the current displayedAngle so a mid-playback
  // rebuild doesn't pop the star.
  if (K > 0) {
    const angle = displayedAngle[ti]
    const xL = centerLocalX + orbitR * Math.cos(angle)
    const zL = semiMinor * Math.sin(angle)
    const [x, z] = worldXZ(xL, zL, cosO, sinO)
    star.position.set(x, 0, z)
  }
  scene.add(star)

  return {
    orbitLine, orbitMat, trigger, triggerMat, star, starMat,
    activeSteps, gaps, K,
    a, orbitR, centerLocalX, semiMinor, cosO, sinO,
  }
}

function rebuildAll() {
  if (!scene || !THREE || !starGeo || !triggerGeo) return
  for (let ti = 0; ti < TRACK_COUNT; ti++) {
    if (trackVis[ti]) {
      disposeTrack(trackVis[ti]!)
      trackVis[ti] = null
    }
    const trk = props.tracks[ti]
    if (!trk) continue
    trackVis[ti] = buildTrack(ti, trk)
    // Force the next RAF tick to snap so the star appears at the
    // correct angle for the new pattern.
    lastHead[ti] = -1
  }
}

// ── RAF hot loop ───────────────────────────────────────────────────
const ANGLE_LERP_FRAC = 0.3

function tickOrbits() {
  const heads = props.displayHeads.current
  const tracksR = props.tracksRaw.current

  for (let ti = 0; ti < TRACK_COUNT; ti++) {
    const vis = trackVis[ti]
    if (!vis) continue
    const trk = tracksR[ti]
    if (!trk) continue

    // No beats → no orbit → hide star.
    if (vis.K === 0) {
      vis.star.visible = false
      lastHead[ti] = -1
      continue
    }

    const total = trk.steps.length
    const head = heads[ti]

    // Stopped / empty — hide star but keep displayedAngle so the next
    // play start can resume smoothly.
    if (head < 0 || total === 0) {
      vis.star.visible = false
      lastHead[ti] = -1
      continue
    }

    const safeHead = head >= total ? head % total : head
    const targetAngle = computeTargetAngle(safeHead, total, vis)

    if (lastHead[ti] < 0) {
      // (Re)starting playback for this track — snap to target so the
      // star doesn't drift from a stale angle.
      displayedAngle[ti] = targetAngle
    } else {
      // Shortest-arc interpolation — naturally advances forward across
      // the 2π boundary at each beat.
      let diff = targetAngle - displayedAngle[ti]
      while (diff > Math.PI) diff -= 2 * Math.PI
      while (diff < -Math.PI) diff += 2 * Math.PI
      displayedAngle[ti] += diff * ANGLE_LERP_FRAC
    }
    lastHead[ti] = safeHead

    // Position star on orbit (ellipse in track-local XZ, rotated)
    const angle = displayedAngle[ti]
    const xL = vis.centerLocalX + vis.orbitR * Math.cos(angle)
    const zL = vis.semiMinor * Math.sin(angle)
    const [x, z] = worldXZ(xL, zL, vis.cosO, vis.sinO)
    vis.star.position.set(x, 0, z)
    vis.star.visible = true
  }
}

function animate() {
  if (!running) return
  tickOrbits()
  controls?.update()
  renderer.render(scene, camera)
  rafId = requestAnimationFrame(animate)
}

// ── Lifecycle ──────────────────────────────────────────────────────

onMounted(async () => {
  if (!containerRef.value) return
  THREE = await import('three')
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js')

  const container = containerRef.value
  const width = container.clientWidth || 1
  const height = container.clientHeight || 1

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x050510)

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200)
  camera.position.set(0, 10, 18)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(width, height)
  renderer.setPixelRatio(window.devicePixelRatio)
  container.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.rotateSpeed = 0.75
  controls.zoomSpeed = 0.8
  controls.enablePan = false
  controls.minDistance = 5
  controls.maxDistance = 60
  controls.target.set(0, 0, 0)

  starGeo = new THREE.SphereGeometry(0.14, 16, 16)
  triggerGeo = new THREE.SphereGeometry(0.18, 20, 20)

  // Soft central sun.
  const sunGeo = new THREE.SphereGeometry(0.35, 32, 32)
  const sunMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.35,
  })
  sun = new THREE.Mesh(sunGeo, sunMat)
  scene.add(sun)

  rebuildAll()

  resizeObserver = new ResizeObserver(() => {
    if (!containerRef.value) return
    const w = containerRef.value.clientWidth
    const h = containerRef.value.clientHeight
    if (w === 0 || h === 0) return
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  })
  resizeObserver.observe(container)

  running = true
  rafId = requestAnimationFrame(animate)
})

watch(
  () => props.tracks,
  () => rebuildAll(),
  { deep: true },
)

watch(
  () => props.selectedId,
  () => rebuildAll(),
)

onBeforeUnmount(() => {
  running = false
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  if (scene) {
    for (const vis of trackVis) {
      if (vis) disposeTrack(vis)
    }
    if (sun) {
      scene.remove(sun)
      sun.geometry.dispose()
      sun.material.dispose()
      sun = null
    }
  }
  starGeo?.dispose()
  starGeo = null
  triggerGeo?.dispose()
  triggerGeo = null
  if (controls) {
    controls.dispose()
    controls = null
  }
  if (renderer) {
    renderer.dispose()
    renderer.domElement.remove()
    renderer = null
  }
  scene = null
  camera = null
})
</script>
