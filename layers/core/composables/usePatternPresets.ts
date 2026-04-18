// Pattern-preset library.
//
// Loads `/patterns/index.json` (bundled under layers/core/public/patterns/)
// and offers two modes of application:
//
//   applyKit(kit)                 -> overwrites every track listed in the kit
//                                    (steps, stepsSource, timeSig, midiNote)
//   applyLineToTrack(idx, line)   -> overwrites a single track (per-track
//                                    "score" selection)
//
// Kept framework-neutral below the Vue layer: the `parseSteps` / compact
// "x...x..." encoding is pure, so JSON files can be authored by humans.
//
// The composable takes the caller's reactive refs (tracks, pendQ, bpm) so
// it can mutate them using the same "replace the array" idiom the store
// uses. That avoids adding new surface area to useSequencerStore.

import { ref, watch, type Ref } from 'vue'
import { parseSig, stepCount } from '#core/pure/meter'
import { generateBridge } from '#core/pure/bridge'
import type { Pending, Track } from '#core/types'

// ── Types ───────────────────────────────────────────────────────────────

export type PresetKitMeta = {
  id: string
  genre: string
  name: string
  bpm?: number
  file: string
}
export type PresetLineMeta = {
  id: string
  role: string
  genre: string
  name: string
  file: string
}
export type PresetIndex = {
  genres: string[]
  kits: PresetKitMeta[]
  lines: PresetLineMeta[]
}

export type KitTrackEntry = {
  index: number
  role?: string
  timeSig: string
  steps: string | boolean[]
  midiNote?: number
  midiChannel?: number
  midiVelocity?: number
  gateMs?: number
}
export type KitPreset = {
  id: string
  name: string
  genre: string
  bpm?: number
  description?: string
  tracks: KitTrackEntry[]
}
export type LinePreset = {
  id: string
  name: string
  role: string
  genre: string
  timeSig: string
  steps: string | boolean[]
  midiNote?: number
  midiChannel?: number
  midiVelocity?: number
  gateMs?: number
  description?: string
}

// ── Pure helpers ────────────────────────────────────────────────────────

// Accept boolean[] or a compact "x...x..." string. Any of `xX*1●■` is on,
// anything else (typically `.`, ` `, `-`, `0`) is off. We normalize length
// to `stepCount(n, d)` by truncating or padding with `false`.
export function parseSteps(raw: string | boolean[], n: number, d: number): boolean[] {
  const cnt = stepCount(n, d)
  const source = Array.isArray(raw)
    ? raw.map(Boolean)
    : Array.from(raw).map(c => /[xX*1●■]/.test(c))
  const out = Array(cnt).fill(false) as boolean[]
  for (let i = 0; i < cnt; i++) out[i] = !!source[i]
  return out
}

// Pattern presets carry ONLY pattern data (steps + timeSig). MIDI routing
// (channel/note/velocity/gate) is the user's independently-configured
// output mapping — save/restore that via MIDI SAVE/LOAD, not KIT.
// Even though older JSON files in the bundle may include midiNote, we
// intentionally ignore those fields here so loading a preset never stomps
// the user's MIDI setup.
function trackFromKitEntry(prev: Track, entry: KitTrackEntry): Track {
  const [n, d] = parseSig(entry.timeSig)
  const steps = parseSteps(entry.steps, n, d)
  return {
    ...prev,
    timeSig: entry.timeSig,
    steps,
    stepsSource: steps.slice(),
  }
}

function trackFromLine(prev: Track, line: LinePreset): Track {
  const [n, d] = parseSig(line.timeSig)
  const steps = parseSteps(line.steps, n, d)
  return {
    ...prev,
    timeSig: line.timeSig,
    steps,
    stepsSource: steps.slice(),
  }
}

// ── Composable ──────────────────────────────────────────────────────────

type Bindings = {
  tracks: Ref<Track[]>
  pendQ: Ref<Pending[][]>
  bpm?: Ref<number>
  // Optional predicate: when it returns true we skip BPM overwrite on
  // applyKit / loadKitFromJson. Used to respect external MIDI clock sync,
  // where local BPM is driven by the incoming clock and MUST NOT be stomped
  // on by preset metadata.
  isBpmLocked?: () => boolean
  // Transition support — mirrors the store's master-mode machinery. When
  // `masterMode === 'transition'` AND `playing`, applyKitObject queues per-
  // track meter bridges and defers the step/MIDI swap until each bridge
  // drains. Not provided -> always instant.
  masterMode?: Ref<'instant' | 'transition'>
  masterBridgeBars?: Ref<1 | 2>
  playing?: Ref<boolean>
}

// A track's final pattern state staged during a transition. Applied when
// the track's pendQ queue drains to empty (detected by watch). Pattern-
// only by design — MIDI routing stays untouched (see trackFromKitEntry).
type StagedPayload = {
  steps: boolean[]
  stepsSource: boolean[]
  timeSig: string
}

export function usePatternPresets({
  tracks, pendQ, bpm, isBpmLocked,
  masterMode, masterBridgeBars, playing,
}: Bindings) {
  const index = ref<PresetIndex | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const kitCache = new Map<string, KitPreset>()
  const lineCache = new Map<string, LinePreset>()
  // Track which kit/line was most recently applied (for UI highlight).
  const lastAppliedKitId = ref<string | null>(null)
  const lastAppliedKitName = ref<string | null>(null)
  const lastAppliedLineByTrack = ref<Record<number, string>>({})

  // Staged kit from LOAD (file-picker). User must hit APPLY to commit.
  const stagedKit = ref<KitPreset | null>(null)

  // Per-track transition payloads: track index → final state that lands
  // when its pendQ queue drains. Non-reactive by design — this is
  // scheduler-adjacent side state, not UI state.
  const transitionStaged = new Map<number, StagedPayload>()

  async function loadIndex() {
    if (index.value || loading.value) return index.value
    loading.value = true; error.value = null
    try {
      const res = await fetch('/patterns/index.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(`index ${res.status}`)
      index.value = await res.json()
    } catch (e: any) {
      error.value = String(e?.message ?? e)
      console.error('[patterns] failed to load index', e)
    } finally {
      loading.value = false
    }
    return index.value
  }

  async function fetchKit(meta: PresetKitMeta): Promise<KitPreset | null> {
    const hit = kitCache.get(meta.id); if (hit) return hit
    try {
      const res = await fetch(`/patterns/${meta.file}`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`kit ${meta.id} ${res.status}`)
      const data = (await res.json()) as KitPreset
      kitCache.set(meta.id, data)
      return data
    } catch (e) {
      console.error('[patterns] fetchKit failed', meta, e); return null
    }
  }

  async function fetchLine(meta: PresetLineMeta): Promise<LinePreset | null> {
    const hit = lineCache.get(meta.id); if (hit) return hit
    try {
      const res = await fetch(`/patterns/${meta.file}`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`line ${meta.id} ${res.status}`)
      const data = (await res.json()) as LinePreset
      lineCache.set(meta.id, data)
      return data
    } catch (e) {
      console.error('[patterns] fetchLine failed', meta, e); return null
    }
  }

  // Build a StagedPayload from a kit track entry (pattern-only; MIDI
  // routing is intentionally ignored — see trackFromKitEntry).
  function payloadFromKitEntry(entry: KitTrackEntry): StagedPayload {
    const [n, d] = parseSig(entry.timeSig)
    const steps = parseSteps(entry.steps, n, d)
    return { steps, stepsSource: steps.slice(), timeSig: entry.timeSig }
  }

  function applyPayloadToTrack(prev: Track, p: StagedPayload): Track {
    return {
      ...prev,
      timeSig: p.timeSig,
      steps: p.steps.slice(),
      stepsSource: p.stepsSource.slice(),
    }
  }

  // Apply a fully-materialized kit object. Respects transition mode when
  // playing: instead of overwriting tracks immediately, push per-track
  // meter bridges into pendQ and stash the final state in `transitionStaged`.
  // The drain-watcher below swaps each track in when its queue empties.
  function applyKitObject(kit: KitPreset) {
    const byIndex = new Map<number, KitTrackEntry>()
    for (const e of kit.tracks) {
      if (e.index >= 0 && e.index < tracks.value.length) byIndex.set(e.index, e)
    }
    const bars = masterBridgeBars?.value ?? 1
    const useTransition = !!playing?.value
      && masterMode?.value === 'transition'
      && bars > 0

    if (!useTransition) {
      // Instant path — swap all tracks now, drop any pending bridges.
      tracks.value = tracks.value.map((t: Track, i: number) => {
        const e = byIndex.get(i)
        return e ? applyPayloadToTrack(t, payloadFromKitEntry(e)) : t
      })
      pendQ.value = pendQ.value.map((): Pending[] => [])
      transitionStaged.clear()
    } else {
      // Transition path — keep current tracks visible/playing, queue
      // bridges into target meters, stash final payload per track.
      transitionStaged.clear()
      const nextPendQ = pendQ.value.map(q => q.slice()) // shallow copy
      tracks.value.forEach((t: Track, i: number) => {
        const e = byIndex.get(i); if (!e) { nextPendQ[i] = []; return }
        const payload = payloadFromKitEntry(e)
        transitionStaged.set(i, payload)
        // If the time sig is identical, we still need to schedule a swap
        // at the next loop boundary — a single trailing Pending does that
        // via applyFnRef / applyPending without visible meter change.
        nextPendQ[i] = t.timeSig === payload.timeSig
          ? [{ timeSig: payload.timeSig }]
          : generateBridge(t.timeSig, payload.timeSig, bars)
      })
      // Tracks not touched by this kit: leave their pendQ alone.
      pendQ.value = nextPendQ
    }

    // Respect external clock sync: don't overwrite BPM if the caller said
    // so. Everything else (steps, meter, MIDI mapping) is still applied.
    if (kit.bpm && bpm && !isBpmLocked?.()) bpm.value = kit.bpm
    lastAppliedKitId.value = kit.id
    lastAppliedKitName.value = kit.name ?? null
    // Per-track "last line" state is no longer accurate after a full kit swap.
    lastAppliedLineByTrack.value = {}
  }

  // Drain-watcher: when a track's pendQ transitions from non-empty to empty
  // AND we have a staged payload for it, swap the payload in. This defers
  // the visible step/MIDI change until after the meter bridge has played.
  //
  // Implemented as a diff on the reactive pendQ so we don't need to touch
  // useSequencerStore's applyFnRef.
  if (playing || masterMode) {
    let prevLens: number[] = pendQ.value.map(q => q.length)
    watch(pendQ, (nowQ) => {
      if (!transitionStaged.size) { prevLens = nowQ.map(q => q.length); return }
      const drained: number[] = []
      for (let i = 0; i < nowQ.length; i++) {
        const wasPending = (prevLens[i] ?? 0) > 0
        const nowEmpty = (nowQ[i]?.length ?? 0) === 0
        if (wasPending && nowEmpty && transitionStaged.has(i)) drained.push(i)
      }
      prevLens = nowQ.map(q => q.length)
      if (!drained.length) return
      const payloads = drained.map(i => ({ i, p: transitionStaged.get(i)! }))
      for (const { i } of payloads) transitionStaged.delete(i)
      tracks.value = tracks.value.map((t: Track, i: number) => {
        const hit = payloads.find(x => x.i === i)
        return hit ? applyPayloadToTrack(t, hit.p) : t
      })
    }, { deep: true })
  }

  async function applyKit(meta: PresetKitMeta) {
    const kit = await fetchKit(meta); if (!kit) return
    applyKitObject(kit)
  }

  // Fetch a preset and stage it for the user to commit via APPLY. This is
  // the LOAD→APPLY flow extended to the built-in PRESET dropdown so the
  // user gets a single, consistent commit path (and transition mode can
  // take effect when they click APPLY).
  async function stageKit(meta: PresetKitMeta) {
    const kit = await fetchKit(meta); if (!kit) return
    stagedKit.value = kit
  }

  async function applyLineToTrack(trackIndex: number, meta: PresetLineMeta) {
    if (trackIndex < 0 || trackIndex >= tracks.value.length) return
    const line = await fetchLine(meta); if (!line) return
    tracks.value = tracks.value.map((t: Track, i: number) =>
      i === trackIndex ? trackFromLine(t, line) : t,
    )
    pendQ.value = pendQ.value.map((q: Pending[], i: number) => (i === trackIndex ? [] : q))
    lastAppliedLineByTrack.value = { ...lastAppliedLineByTrack.value, [trackIndex]: line.id }
  }

  // ── Export / import user-authored kits ───────────────────────────────
  // The export matches the on-disk kit schema, so a downloaded file can be
  // dropped straight into `public/patterns/kits/` and listed in index.json
  // later. stepsSource is the canonical pattern (not the currently-truncated
  // `steps`), so tight-meter views round-trip losslessly.

  function encodeSteps(steps: boolean[]): string {
    return steps.map(s => (s ? 'x' : '.')).join('')
  }

  // KIT SAVE exports pattern data only. MIDI routing is NOT included
  // here — that's the province of MIDI SAVE/LOAD. Keeps the two
  // configuration axes (pattern vs routing) independent on disk, so
  // loading a shared kit from a teammate never stomps your local MIDI
  // channel/note assignments.
  function exportCurrentAsKit(name = 'Custom Kit', genre = 'Custom'): KitPreset {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return {
      id: `custom-${ts}`,
      name,
      genre,
      bpm: bpm?.value,
      description: 'Exported from sequencer',
      tracks: tracks.value.map((t: Track, i: number) => ({
        index: i,
        role: t.name,
        timeSig: t.timeSig,
        steps: encodeSteps(t.stepsSource),
      })),
    }
  }

  function serializeCurrentAsKit(name?: string, genre?: string): string {
    return JSON.stringify(exportCurrentAsKit(name, genre), null, 2)
  }

  // Parse a kit JSON string and stage it for deferred apply. Returns the
  // kit name on success (for UI feedback), or null on failure. User then
  // commits via applyStagedKit() — this two-step flow lets the user
  // preview the name and, more importantly, lets applyStagedKit() pick up
  // the current masterMode so transitions fire correctly.
  //
  // Schema is permissive — only `tracks[]` is required.
  function stageKitFromJson(text: string): string | null {
    let kit: KitPreset
    try {
      kit = JSON.parse(text)
    } catch (e) {
      console.error('[patterns] stageKitFromJson: invalid JSON', e)
      error.value = 'invalid JSON'
      return null
    }
    if (!kit || !Array.isArray(kit.tracks)) {
      console.error('[patterns] stageKitFromJson: missing tracks[]')
      error.value = 'missing tracks[]'
      return null
    }
    if (!kit.id) kit.id = `loaded-${Date.now()}`
    if (!kit.name) kit.name = 'Loaded Kit'
    error.value = null
    stagedKit.value = kit
    return kit.name
  }

  // Commit the staged kit. Safe to call with nothing staged (no-op).
  function applyStagedKit() {
    const kit = stagedKit.value; if (!kit) return
    applyKitObject(kit)
    stagedKit.value = null
  }

  function clearStagedKit() { stagedKit.value = null }

  // Back-compat: old callers of loadKitFromJson expected "stage + apply
  // immediately". Now it stages first, then applies — same observable
  // result for callers that want the instant flow, but respects transition
  // mode when enabled.
  function loadKitFromJson(text: string): string | null {
    const name = stageKitFromJson(text); if (!name) return null
    applyStagedKit()
    return name
  }

  return {
    // state
    index, loading, error,
    lastAppliedKitId, lastAppliedKitName, lastAppliedLineByTrack,
    stagedKit,
    // actions
    loadIndex, applyKit, stageKit, applyLineToTrack,
    // import / export
    exportCurrentAsKit, serializeCurrentAsKit,
    stageKitFromJson, applyStagedKit, clearStagedKit,
    loadKitFromJson, // back-compat alias — stages + applies in one call
  }
}
