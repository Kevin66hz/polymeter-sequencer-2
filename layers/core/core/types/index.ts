// Core domain types. Framework-agnostic — do not import Vue here.

export const TRACK_COUNT = 16

export type Pending = { timeSig: string }

// Per-step override of the default (trk.midiNote / midiVelocity / gateMs).
// `note` is the only required field — velocity and gate fall through to
// the track default when undefined so a simple "just change the pitch for
// this step" edit stays one keystroke. Kept optional on Track (undefined
// = all steps use the default) so the feature has zero cost for tracks
// that never touch it.
export type StepNote = {
  note: number             // 0..127
  velocity?: number        // 0..127 — undefined → fall through to trk.midiVelocity
  gateMs?: number          // undefined → fall through to trk.gateMs
}

export type Track = {
  id: number
  name: string
  timeSig: string          // e.g. "4/4", "7/8", "5/6" (bridge)
  mode: 'instant' | 'transition'
  color: string
  // `steps` is what the scheduler plays and what the UI renders
  steps: boolean[]
  // `stepsSource` is the canonical, never-truncated master pattern
  stepsSource: boolean[]
  // Per-step MIDI note/velocity/gate override. Parallel array to
  // `stepsSource` (same length). `null` entry = use track default.
  // Undefined (missing) = entire track uses defaults (no allocation).
  stepNotes?: (StepNote | null)[]
  mute: boolean
  solo: boolean
  midiChannel: number      // 1..16
  midiNote: number         // 0..127
  midiVelocity: number     // 0..127
  gateMs: number           // gate length in ms
  // Open bag for plugins to attach per-track config.
  // Keyed by plugin id, so multiple plugins can coexist.
  extras?: Record<string, unknown>
}

// A scheduled note. The output of per-step logic + plugin transforms.
// Adapters (audio / midi) consume these.
export type NoteEvent = {
  trackId: number
  timeSec: number          // AudioContext time
  channel: number          // 1..16
  note: number             // 0..127
  velocity: number         // 0..127
  gateMs: number
  // Debug / provenance. Free-form.
  tag?: string
}

// Per-step context passed to plugin `transform`.
export type PluginContext = {
  track: Track
  bpm: number
  stepIndex: number
  stepDurSec: number
  timeSig: string
}

// Plugin contract. Keep it narrow — the scheduler calls `transform` inside a
// hot loop so it MUST be pure and synchronous.
export interface SequencerPlugin {
  id: string
  version: string
  transform?: (events: NoteEvent[], ctx: PluginContext) => NoteEvent[]
  defaultTrackExtras?: () => Record<string, unknown>
  // UI slot id the variants may choose to render. Optional.
  ui?: { detailPanel?: string }
}
