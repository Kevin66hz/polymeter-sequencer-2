<!--
  ConcentricView3D.vue — Three.js nested-sphere view for Type2Plus.

  Phase 5 Stage 3a-3c (combined) + "16-layer sphere" visual:

  Each track gets its own sphere shell at its own radius (innermost at
  r=1.5, outermost at r=8, same spread as the 2D RING view's track order).
  On every shell, each ON step is a meridian line (a full great circle
  through the +Y and -Y poles, at that step's longitude). OFF steps are
  drawn as very dim meridians of the same color so the sphere's shell
  silhouette is still legible but the ON pattern pops forward.

  Playhead: instead of an orbiting comet, the CURRENT step's meridian is
  boosted to maximum brightness each frame. As the head advances, the
  previous meridian fades back to its default opacity and the next one
  lights up. This gives the view a "rotating spotlight on a lantern"
  feel that matches the polymeter concept — 16 shells each pulsing at
  its own rate.

  Layout:
    - Sun: small white sphere at origin (inside all shells).
    - Track ti: sphere shell at radius orbitRadius(ti).
    - On track ti's shell: one meridian great circle per step, spaced
      evenly in longitude. Step 0 at longitude 0; step si at 2π*si/total.
    - A meridian is rendered as a THREE.Line tracing a unit great circle
      (shared BufferGeometry), then scaled to the track's radius and
      rotated around the Y axis to its step's longitude.

  Design rules preserved from Stage 1/2:
    - Client-only: three.js imports are dynamic inside onMounted so SSR
      doesn't try to load WebGL. Consumers should wrap this component in
      <ClientOnly> at the call site (defense in depth).
    - The RAF loop NEVER touches Vue reactivity. It reads displayHeads
      and tracksRaw raw mirrors directly, same pattern as RingsOverlay.
    - Per-track visuals are rebuilt inside a `watch` on `props.tracks`,
      which only fires on meaningful track changes (toggle, pattern
      length change, mute/solo, meter change). Not in the 60fps path.

  Remaining stages:
    - 3d: interaction (click-to-select track, click-to-toggle step via
      raycasting). With meridians as the click target this becomes a
      line-proximity raycast — different from a sphere-hit test.
    - 3e: decoration (starfield background, meridian glow via Bloom
      post-process, hit ripples along meridians).
    - 3f: delete ConcentricViewPlus once 3D view is feature-complete.
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

// Three.js handles, loaded lazily in onMounted. Typed as `any` so the
// top-level script has no three.js type dependency (keeps SSR clean,
// and @types/three doesn't have to resolve before `npm install` has run).
let THREE: any = null
let scene: any = null
let camera: any = null
let renderer: any = null
let controls: any = null
let sun: any = null
let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
let running = false

// Shared unit-sphere meridian geometry. One great circle in the XY plane
// (longitude = 0), radius 1. Each track-step meridian is a THREE.Line
// that references this BufferGeometry and is scaled + rotated per-track.
let unitMeridianGeo: any = null

// Shared unit-sphere equator geometry. Circle in the XZ plane (y = 0),
// radius 1. Each track's equator line scales this to its shell radius.
let unitEquatorGeo: any = null

// Per-track visual state. Rebuilt on `tracks` / `selectedId` changes.
type TrackVis = {
  meridians: any[]          // THREE.Line[] — one per step (static state)
  meridianMats: any[]       // LineBasicMaterial[] — per-step
  defaultOpacities: number[] // Baseline opacity (used for rebuildAll,
                            //   not per-frame since playhead is separate)
  trackColor: any           // THREE.Color — preserved for future reuse
  playheadLine: any         // THREE.Line — a single white meridian that
                            //   smoothly rotates around Y to follow the
                            //   track's playhead position
  playheadMat: any          // LineBasicMaterial for the playhead line
  equatorLine: any          // THREE.Line — latitude circle at y=0
  equatorMat: any           // LineBasicMaterial for the equator line
}
const trackVis: (TrackVis | null)[] = Array(TRACK_COUNT).fill(null)

// Currently displayed longitude per track's playhead line. Holds its
// value across RAF ticks for smooth interpolation toward the target
// (the current step's longitude). Survives rebuildAll so step toggles
// don't cause the playhead to visually snap back.
const playheadLon: number[] = Array(TRACK_COUNT).fill(0)

// ── Nested-sphere geometry ──────────────────────────────────────────
// Track ti sits on a sphere shell at radius orbitRadius(ti). Spread is
// linear from inner to outer; Stage 3e may switch to log / Bode's-law.
const INNER_R = 1.5
const OUTER_R = 8

function orbitRadius(ti: number): number {
  return INNER_R + ((OUTER_R - INNER_R) * ti) / (TRACK_COUNT - 1)
}

// Longitude (rotation around +Y axis) of step `si` on a track with
// `total` steps. Step 0 sits on the +X meridian; subsequent steps step
// around the sphere counterclockwise when viewed from +Y.
function stepLongitude(si: number, total: number): number {
  return (si / total) * Math.PI * 2
}

// Build the shared unit-sphere meridian: a full great circle at
// longitude 0 (in the XY plane), radius 1. The poles are at y = ±1.
function buildUnitMeridianGeometry(segments: number): any {
  const pts = new Float32Array((segments + 1) * 3)
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2
    pts[i * 3 + 0] = Math.sin(theta) // x
    pts[i * 3 + 1] = Math.cos(theta) // y (θ=0 → y=1, +Y pole)
    pts[i * 3 + 2] = 0               // z (lon = 0, meridian in XY plane)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return geo
}

// Build the shared unit-sphere equator: a circle in the XZ plane at
// y = 0, radius 1. Each track's equator line is this geometry scaled to
// the track's shell radius.
function buildUnitEquatorGeometry(segments: number): any {
  const pts = new Float32Array((segments + 1) * 3)
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * Math.PI * 2
    pts[i * 3 + 0] = Math.cos(phi) // x
    pts[i * 3 + 1] = 0             // y (equator plane)
    pts[i * 3 + 2] = Math.sin(phi) // z
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return geo
}

// ── Per-track visual build / dispose ────────────────────────────────

function disposeTrack(vis: TrackVis) {
  for (let i = 0; i < vis.meridians.length; i++) {
    scene.remove(vis.meridians[i])
    vis.meridianMats[i].dispose()
    // Don't dispose geometry — it's shared via unitMeridianGeo
  }
  scene.remove(vis.playheadLine)
  vis.playheadMat.dispose()
  scene.remove(vis.equatorLine)
  vis.equatorMat.dispose()
}

// Compute baseline opacity for one meridian based on step state +
// track-level state + selection. Boosted temporarily by the RAF loop
// when the playhead is on this step.
function baseOpacity(
  active: boolean,
  muted: boolean,
  isSelected: boolean,
): number {
  if (muted) {
    return active ? 0.18 : 0.04
  }
  if (active) {
    return isSelected ? 0.75 : 0.55
  }
  // Inactive step — kept just visible enough to show the sphere shell's
  // silhouette without drowning out the ON pattern.
  return isSelected ? 0.14 : 0.08
}

// The playhead (currently-playing step) is rendered in pure white so it
// reads as a bright "spotlight" against the shell, regardless of the
// track's own color. All other meridians — ON and OFF alike — stay in
// the track color at their baseOpacity.
const PLAYHEAD_COLOR_HEX = 0xffffff

function buildTrack(ti: number, trk: Track): TrackVis {
  const trackColor = new THREE.Color(trk.color)
  const r = orbitRadius(ti)
  const total = trk.steps.length
  const isSelected = props.selectedId === ti

  const meridians: any[] = []
  const meridianMats: any[] = []
  const defaultOpacities: number[] = []

  for (let si = 0; si < total; si++) {
    const active = trk.steps[si]
    const op = baseOpacity(active, trk.mute, isSelected)
    const mat = new THREE.LineBasicMaterial({
      color: trackColor.clone(),
      transparent: true,
      opacity: op,
    })
    const line = new THREE.Line(unitMeridianGeo, mat)
    line.scale.setScalar(r)
    line.rotation.y = stepLongitude(si, total)
    scene.add(line)

    meridians.push(line)
    meridianMats.push(mat)
    defaultOpacities.push(op)
  }

  // Dedicated playhead line — an extra meridian that overlays the
  // current step. rotation.y is interpolated in the RAF loop so the
  // playhead sweeps smoothly between step positions instead of
  // snapping from one discrete meridian to the next.
  //
  // Scaled out by a small factor (1.005) so it sits just outside the
  // track's shell and doesn't z-fight with the underlying step
  // meridian when they align.
  const playheadMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(PLAYHEAD_COLOR_HEX),
    transparent: true,
    opacity: 0.4,
  })
  const playheadLine = new THREE.Line(unitMeridianGeo, playheadMat)
  playheadLine.scale.setScalar(r * 1.005)
  playheadLine.rotation.y = playheadLon[ti]
  playheadLine.visible = false
  scene.add(playheadLine)

  // Equator — a latitude circle in the y=0 plane at the shell's radius.
  // Kept bright so the top-down view reads as a stack of nested rings
  // (reminiscent of the 2D RING view) while the sphere structure
  // emerges as the camera tilts.
  const equatorOpacity = trk.mute ? 0.1 : (isSelected ? 0.75 : 0.5)
  const equatorMat = new THREE.LineBasicMaterial({
    color: trackColor.clone(),
    transparent: true,
    opacity: equatorOpacity,
  })
  const equatorLine = new THREE.Line(unitEquatorGeo, equatorMat)
  equatorLine.scale.setScalar(r)
  scene.add(equatorLine)

  return {
    meridians, meridianMats, defaultOpacities, trackColor,
    playheadLine, playheadMat,
    equatorLine, equatorMat,
  }
}

function rebuildAll() {
  if (!scene || !THREE || !unitMeridianGeo || !unitEquatorGeo) return

  for (let ti = 0; ti < TRACK_COUNT; ti++) {
    if (trackVis[ti]) {
      disposeTrack(trackVis[ti]!)
      trackVis[ti] = null
    }
    const trk = props.tracks[ti]
    if (!trk) continue
    trackVis[ti] = buildTrack(ti, trk)
    // playheadLon[ti] is intentionally preserved across rebuilds so
    // that step toggles, mute, etc. don't cause the playhead to jump
    // back. buildTrack reads it for the new playhead line's initial
    // rotation.
  }
}

// ── Hot loop ────────────────────────────────────────────────────────
// Reads raw mirrors only — never traverses Vue reactivity. Every frame
// nudges each track's playheadLine rotation toward the current step's
// longitude by a fixed fraction, producing a smooth sweep rather than
// discrete snaps between meridians.

// Per-frame catch-up fraction. 0.3 gives the playhead roughly 92%
// coverage of one step's arc within 7-8 frames (~125ms at 120 BPM),
// so the sweep visibly trails the beat without feeling sluggish.
const PLAYHEAD_LERP_FRAC = 0.3

function tickPlayheads() {
  const heads = props.displayHeads.current
  const tracksR = props.tracksRaw.current

  for (let ti = 0; ti < TRACK_COUNT; ti++) {
    const vis = trackVis[ti]
    if (!vis) continue
    const trk = tracksR[ti]
    if (!trk) {
      vis.playheadLine.visible = false
      continue
    }

    const total = trk.steps.length
    const head = heads[ti]

    // Stopped / empty pattern — hide and skip. playheadLon[ti] is
    // preserved so that resuming playback starts from the last drawn
    // position (avoids a snap-back to step 0 visible).
    if (head < 0 || total === 0) {
      vis.playheadLine.visible = false
      continue
    }

    // Defensive wrap — same rationale as RingsOverlay safeHead.
    const safeHead = head >= total ? head % total : head
    const targetLon = stepLongitude(safeHead, total)

    // Snap on first frame after becoming visible (playback just
    // started, or the component was just remounted). Otherwise lerp.
    if (!vis.playheadLine.visible) {
      playheadLon[ti] = targetLon
      vis.playheadLine.visible = true
    } else {
      // Shortest-arc interpolation so the playhead takes the near way
      // around the sphere when target wraps across 2π.
      let diff = targetLon - playheadLon[ti]
      while (diff > Math.PI) diff -= 2 * Math.PI
      while (diff < -Math.PI) diff += 2 * Math.PI
      playheadLon[ti] += diff * PLAYHEAD_LERP_FRAC
    }

    vis.playheadLine.rotation.y = playheadLon[ti]
  }
}

function animate() {
  if (!running) return
  tickPlayheads()
  // OrbitControls damping: interpolates camera motion toward the target
  // each frame. Cheap and gives noticeable polish on drag release.
  controls?.update()
  renderer.render(scene, camera)
  rafId = requestAnimationFrame(animate)
}

// ── Lifecycle ───────────────────────────────────────────────────────

onMounted(async () => {
  if (!containerRef.value) return
  THREE = await import('three')
  // OrbitControls lives in three's addons bundle. Lazy-import keeps the
  // dependency out of SSR and avoids pulling it in if we later decide to
  // gate controls behind a feature flag.
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js')

  const container = containerRef.value
  const width = container.clientWidth || 1
  const height = container.clientHeight || 1

  // Scene + camera + renderer
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x050510)

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200)
  camera.position.set(0, 12, 20)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(width, height)
  renderer.setPixelRatio(window.devicePixelRatio)
  container.appendChild(renderer.domElement)

  // ── OrbitControls ──────────────────────────────────────────────────
  // Drag to rotate, wheel to zoom. Pan disabled (sphere is centered on
  // origin and the visualization only reads from that anchor). Polar
  // clamp kept but relaxed — with nested SHELLS (not a flat plane) there
  // is no "below the ecliptic" concern anymore, so we allow full range.
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.rotateSpeed = 0.75
  controls.zoomSpeed = 0.8
  controls.enablePan = false
  controls.minDistance = 5
  controls.maxDistance = 60
  controls.target.set(0, 0, 0)

  // Shared unit meridian + equator — 96 segments is enough for smooth
  // circles at all reasonable radii.
  unitMeridianGeo = buildUnitMeridianGeometry(96)
  unitEquatorGeo = buildUnitEquatorGeometry(96)

  // Central sun (white, small, soft). Sits inside every shell.
  const sunGeo = new THREE.SphereGeometry(0.35, 32, 32)
  const sunMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.35,
  })
  sun = new THREE.Mesh(sunGeo, sunMat)
  scene.add(sun)

  // Build all track visuals from the initial tracks prop.
  rebuildAll()

  // Resize handling
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

// Rebuild meridians when the track structure changes (step toggle,
// time-sig change, mute/solo, meter change). Fires on every
// `tracks.value = ...` replacement from the store — not inside the 60fps
// hot path, so a full rebuild per event is OK.
watch(
  () => props.tracks,
  () => rebuildAll(),
  { deep: true },
)

// Selection change only affects opacity tiers; rebuildAll is
// coarse-grained but simple (16 × ~16 line meshes = fast enough).
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

  unitMeridianGeo?.dispose()
  unitMeridianGeo = null
  unitEquatorGeo?.dispose()
  unitEquatorGeo = null

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
