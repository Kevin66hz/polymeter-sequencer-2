import { ref } from 'vue'
import type { MidiMapping } from '#core/composables/useMidiIn'

// ── MIDI controller template registry ──────────────────────────────
//
// Mirrors the pattern-preset system (usePatternPresets + /patterns/
// index.json) for MIDI controller templates. Ships shippable factory
// mappings under `/midi-presets/` and lets the app auto-apply them
// when a matching controller is connected.
//
// Why this exists: the user always drives this app from a Launch
// Control XL MK2 running a specific user-template. Re-running Learn
// every session is tedious, and importing a JSON file from disk each
// time defeats the purpose of having a dedicated controller. The
// registry lets us ship the factory mapping as a bundled asset and
// auto-apply it on device connection — no manual step required.
//
// Compared to the pattern-preset code this is intentionally simpler:
//
//   • Templates are matched against the input device NAME (substring,
//     case-insensitive). A given connected device yields AT MOST ONE
//     template — the first match in the registry wins. This keeps the
//     UI contract dead simple: "○ means we'll auto-apply a mapping".
//
//   • Auto-apply only loads the MAPPINGS (not selectedIds / not
//     clockSourceId / not syncMode). The user's current device
//     selection and clock routing are preserved across the template
//     load — an auto-load triggered by plugging a controller must
//     never silently deselect other MIDI inputs or hijack the clock
//     source.
//
//   • We track which device ids have already been auto-applied in
//     this session (`autoAppliedIds`) so unplugging and re-plugging
//     the same controller doesn't wipe out the user's manual
//     overrides every time. The user can still force-reapply from
//     the UI by explicitly selecting the template.

export interface MidiPresetMeta {
  id: string
  name: string
  file: string
  controller?: string
  match?: {
    // Case-insensitive substring match against the MIDIInput.name.
    // Any match in the list counts (OR semantics).
    inputNameIncludes?: string[]
  }
}

export interface MidiPresetIndex {
  version: number
  _description?: string
  presets: MidiPresetMeta[]
}

// Shape of a bundled preset file. The `mappings` array is the only
// field we consume during auto-apply — the rest are for human
// readability or for the user-driven "Load template" path (future
// work) that also pulls device routing.
export interface MidiPresetFile {
  _meta?: Record<string, unknown>
  _notes?: Record<string, unknown>
  mappings: MidiMapping[]
  syncMode?: 'internal' | 'external'
  selectedIds?: string[]
  clockSourceId?: string | null
}

// Thin shape of the midiIn composable surface we touch. Typed
// explicitly rather than importing the return type of useMidiIn so
// this module stays easy to unit-test against a stub.
export interface MidiInLike {
  state: {
    inputs: { id: string; name?: string }[]
    mappings: MidiMapping[]
  }
}

export function useMidiPresets() {
  const index = ref<MidiPresetIndex | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Parsed preset files, keyed by preset id so repeat applications
  // don't re-hit the network.
  const presetCache = new Map<string, MidiPresetFile>()

  // Input device ids we've already auto-applied for this session.
  // Session-scoped (plain Set, not persisted) — refreshing the app
  // resets it so the user always gets the template on first connect.
  const autoAppliedIds = new Set<string>()

  // In-flight fetch promise. Stored so concurrent callers (e.g. the
  // inputs-watcher firing for multiple devices at once) all await the
  // same request rather than each returning null while loading=true.
  // Previous implementation returned `index.value` (null) when
  // loading=true, causing autoApplyForDevice to see no index and skip
  // the template — this was the root cause of Bug 3 on deployed builds
  // where the device-connect watcher raced the initial loadIndex call.
  let loadingPromise: Promise<MidiPresetIndex | null> | null = null

  async function loadIndex(): Promise<MidiPresetIndex | null> {
    if (index.value) return index.value
    if (loadingPromise) return loadingPromise
    loading.value = true; error.value = null
    const p = (async () => {
      try {
        const res = await fetch('/midi-presets/index.json', { cache: 'no-cache' })
        if (!res.ok) throw new Error(`midi-presets index ${res.status}`)
        index.value = await res.json() as MidiPresetIndex
      } catch (e: any) {
        error.value = String(e?.message ?? e)
        console.warn('[midi-presets] failed to load index', e)
      } finally {
        loading.value = false
        loadingPromise = null
      }
      return index.value
    })()
    loadingPromise = p
    return p
  }

  // Return the first preset whose match rules fire for this device
  // name, or null. Case-insensitive substring match — works across
  // "Launch Control XL", "Launch Control XL MK2 LCXL", OS-added port
  // decorations etc.
  function findPresetForDevice(deviceName: string | undefined | null): MidiPresetMeta | null {
    const nm = (deviceName ?? '').toLowerCase()
    if (!nm || !index.value) return null
    for (const preset of index.value.presets) {
      const needles = preset.match?.inputNameIncludes
      if (!needles || needles.length === 0) continue
      if (needles.some(n => nm.includes(n.toLowerCase()))) return preset
    }
    return null
  }

  // Convenience for the UI — "should this device row get a ○
  // indicator?". Safe to call before loadIndex() resolves; just
  // returns false until the registry is populated.
  function hasPresetForDevice(deviceName: string | undefined | null): boolean {
    return findPresetForDevice(deviceName) !== null
  }

  async function fetchPreset(meta: MidiPresetMeta): Promise<MidiPresetFile | null> {
    const hit = presetCache.get(meta.id); if (hit) return hit
    try {
      const res = await fetch(`/midi-presets/${meta.file}`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`midi-preset ${meta.id} ${res.status}`)
      const data = await res.json() as MidiPresetFile
      if (!data || !Array.isArray(data.mappings)) {
        throw new Error(`midi-preset ${meta.id}: missing mappings[]`)
      }
      presetCache.set(meta.id, data)
      return data
    } catch (e) {
      console.warn('[midi-presets] fetchPreset failed', meta, e)
      return null
    }
  }

  // Mapping-only apply. We deliberately mutate `state.mappings` in
  // place instead of going through useMidiIn.loadMappings so the
  // user's `selectedIds` / `clockSourceId` / `syncMode` stay intact.
  // Auto-apply firing must never feel like the app "took over" the
  // MIDI IN panel.
  //
  // Drops any pre-existing mappings for the same controlId so
  // re-applying a preset is idempotent.
  function applyPresetMappings(midiIn: MidiInLike, preset: MidiPresetFile) {
    const incoming = preset.mappings ?? []
    if (incoming.length === 0) return
    const incomingIds = new Set(incoming.map(m => m.controlId))
    const surviving = midiIn.state.mappings.filter(m => !incomingIds.has(m.controlId))
    // Preserve insertion order of the incoming list — templates are
    // often hand-authored in a logical order and it's nicer to show
    // them that way in a future mapping-list UI.
    midiIn.state.mappings = [...surviving, ...incoming.map(m => ({
      controlId: m.controlId,
      type: m.type,
      channel: m.channel,
      number: m.number,
    }))]
  }

  // High-level "plug and play" entry point. Looks up the preset for
  // `deviceName`, fetches + applies it (mappings only), and marks
  // `deviceId` as auto-applied so we don't loop on reconnects.
  // Returns the applied preset meta (or null).
  //
  // Diagnostic logging (console.info prefixed with [midi-presets]) is
  // intentionally verbose: the user-facing UI has no visible signal for
  // "auto-apply succeeded", so when pad / modifier bindings don't behave
  // the only way to tell whether auto-apply actually ran is to open the
  // DevTools console. Noise tradeoff is acceptable — these messages fire
  // at most once per (session, device id).
  async function autoApplyForDevice(
    deviceId: string,
    deviceName: string | undefined | null,
    midiIn: MidiInLike,
  ): Promise<MidiPresetMeta | null> {
    if (autoAppliedIds.has(deviceId)) {
      return null
    }
    await loadIndex()
    const meta = findPresetForDevice(deviceName)
    if (!meta) {
      // Not an error — just means this device has no bundled template.
      // Only log once per device so reconnects stay quiet.
      if (deviceName) {
        console.info(`[midi-presets] no template matches device "${deviceName}"`)
      }
      autoAppliedIds.add(deviceId)
      return null
    }
    const preset = await fetchPreset(meta)
    if (!preset) {
      console.warn(`[midi-presets] template "${meta.id}" failed to load`)
      return null
    }
    applyPresetMappings(midiIn, preset)
    autoAppliedIds.add(deviceId)
    console.info(
      `[midi-presets] auto-applied "${meta.name}" → ${preset.mappings.length} mappings (device "${deviceName}")`,
    )
    return meta
  }

  // Manual "apply template" entry point for the UI button. Unlike
  // autoApplyForDevice this always runs — the user explicitly asked for
  // it — and targets a device NAME (no id dedup). Useful when auto-apply
  // didn't fire because the device was already in the input list before
  // the store watcher wired up, or when the user has reset mappings and
  // wants the factory template back.
  async function applyForDeviceName(
    deviceName: string | undefined | null,
    midiIn: MidiInLike,
  ): Promise<MidiPresetMeta | null> {
    await loadIndex()
    const meta = findPresetForDevice(deviceName)
    if (!meta) {
      console.info(`[midi-presets] no template matches device "${deviceName ?? ''}"`)
      return null
    }
    const preset = await fetchPreset(meta)
    if (!preset) return null
    applyPresetMappings(midiIn, preset)
    console.info(
      `[midi-presets] manually applied "${meta.name}" → ${preset.mappings.length} mappings`,
    )
    return meta
  }

  // Reset the "already auto-applied" memory. Useful for explicit
  // user actions like "reset mappings" — after calling this the
  // next time the device's id reappears the preset will re-apply.
  function forgetAutoApplied(deviceId?: string) {
    if (deviceId) autoAppliedIds.delete(deviceId)
    else autoAppliedIds.clear()
  }

  return {
    // State
    index, loading, error,
    // Query
    loadIndex, findPresetForDevice, hasPresetForDevice, fetchPreset,
    // Apply
    applyPresetMappings, autoApplyForDevice, applyForDeviceName, forgetAutoApplied,
  }
}
