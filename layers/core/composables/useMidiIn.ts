import { reactive, toRaw, watch } from 'vue'

// ── MIDI Input: external controller support ────────────────────────
//
// Multi-IN model: several inputs can be selected simultaneously. All of them
// feed the SAME shared mapping table (so e.g. "transport_play" can be bound
// to any pad on any device). Clock sync, however, has to come from exactly
// ONE source at a time — mixing 0xF8 pulses from multiple devices would
// produce garbage BPM — so a separate `clockSourceId` picks which selected
// input's clock stream drives the sync BPM.
//
// Three independent features:
//
// 1. Transport: 0xFA (Start) / 0xFC (Stop) / 0xFB (Continue)
//    trigger the sequencer's play() / stop() via callbacks, regardless of
//    which input sent them. A CC or Note can also be mapped to
//    "transport_play" / "transport_stop".
//
// 2. Clock Sync: 0xF8 pulses (24 PPQN) from `clockSourceId` only.
//    Averaged over a rolling window of 24 pulses to smooth jitter.
//    BPM = 60 / (avgInterval × 24). Pulses from other selected inputs are
//    ignored so multiple clock masters don't confuse the tracker.
//
// 3. Mapping: a SINGLE shared list — bindings apply regardless of which
//    selected input sent the message. Learn mode consumes whichever input
//    sends the next note/cc.
//
// Back-compat shim: `selectedId` / `selectInput(id | null)` are kept as
// computed / wrapper over `selectedIds` / `selectInputs`. Old call sites
// (templates doing `v-if="midiIn.state.selectedId"` etc.) keep working —
// reading `selectedId` returns the first selected id or null.
//
// Persistence: saveMappings writes `selectedIds` + `clockSourceId` alongside
// the mapping list. loadMappings accepts either the new array form or the
// legacy `selectedId: string` form, so old config files keep importing.

export interface MidiMapping {
  controlId: string
  type: 'cc' | 'note'
  channel: number   // 1-16
  number: number    // CC# or note#
}

// All controls available for MIDI mapping.
//
// Grouping is purely organizational (used by any future mapping-list UI to
// collapse related targets). Every id here must have a dispatch branch in
// useSequencerStore.onCCMapped — keep the two in sync or a bound controller
// message will silently no-op. See ARCHITECTURE.md §MIDI mapping for
// momentary-vs-continuous conventions:
//
//   - Continuous (knob): receives raw 0-127, mapped to value range.
//     Examples: bpm, masterN/D, trackN_n/d, repeat_length (phase/rate).
//   - Momentary trigger: acts once when value > 63 (press threshold).
//     Examples: master_apply, snapshot_*, all_mute, trackN_clear,
//     trackN_mute/solo (toggles on press).
//   - Transport shortcuts: transport_play / transport_stop are intercepted
//     in triggerControl() (they route directly to onPlay/onStop callbacks);
//     everything else falls through to onCCMapped.
export const MAPPABLE_CONTROLS = [
  // ── Transport / BPM ────────────────────────────────
  { id: 'transport_play',   label: 'Play / Start',                 group: 'transport' },
  { id: 'transport_stop',   label: 'Stop',                         group: 'transport' },
  { id: 'transport_toggle', label: 'Play / Stop Toggle',           group: 'transport' },
  { id: 'bpm',              label: 'BPM',                          group: 'transport' },
  { id: 'rec_toggle',       label: 'REC Arm Toggle',               group: 'transport' },

  // ── Master meter ───────────────────────────────────
  { id: 'masterN',              label: 'Master N',                 group: 'master' },
  { id: 'masterD',              label: 'Master D',                 group: 'master' },
  { id: 'master_apply',         label: 'Master Apply',             group: 'master' },
  { id: 'master_mode_toggle',   label: 'Master INSTANT ⇔ TRANSITION', group: 'master' },
  { id: 'bridge_length',        label: 'Bridge Length (1 / 2)',    group: 'master' },

  // ── Global performance ────────────────────────────
  { id: 'repeat_trigger',   label: 'Beat Repeat ON/OFF',           group: 'perform' },
  { id: 'repeat_length',    label: 'Repeat Rate (1/2 → 1/16)',     group: 'perform' },
  { id: 'all_mute',         label: 'ALL MUTE',                     group: 'perform' },
  { id: 'snapshot_save',    label: 'Snapshot Save',                group: 'perform' },
  { id: 'snapshot_recall',  label: 'Snapshot Recall',              group: 'perform' },
  { id: 'snapshot_delete',  label: 'Snapshot Delete',              group: 'perform' },

  // ── Modifier keys (D / M / S / R) ──────────────────
  // These are *hold-sensitive*: press and release transitions both matter
  // so the store can interpret subsequent pad presses in context. They
  // participate in Learn like any other control — typically bound to
  // Note On messages on the controller's Device/Mute/Solo/Record Arm
  // buttons (Launch Control XL MK2 factory: A6 / A#6 / B6 / C7). The
  // onModifierChange callback fires for both the down and up edge.
  { id: 'mod_d', label: 'Modifier: Device (hold)',     group: 'modifier' },
  { id: 'mod_m', label: 'Modifier: Mute (hold/tap)',   group: 'modifier' },
  { id: 'mod_s', label: 'Modifier: Solo (hold/tap)',   group: 'modifier' },
  { id: 'mod_r', label: 'Modifier: Record Arm (tap)',  group: 'modifier' },

  // ── Per-track (16 tracks × 7 targets each) ─────────
  // N / D / GATE: continuous CC knobs / faders.
  // MUTE / SOLO: toggle on press (threshold).
  // CLEAR / REC: trigger on press (threshold). REC also tracks release
  // so that pad-hold can act as a momentary modifier for fader-gate
  // column routing (see useSequencerStore).
  ...Array.from({ length: 16 }, (_, i) => ([
    { id: `track${i}_n`,     label: `Track ${i + 1} N`,     group: `track${i}` },
    { id: `track${i}_d`,     label: `Track ${i + 1} D`,     group: `track${i}` },
    { id: `track${i}_gate`,  label: `Track ${i + 1} Gate`,  group: `track${i}` },
    { id: `track${i}_mute`,  label: `Track ${i + 1} Mute`,  group: `track${i}` },
    { id: `track${i}_solo`,  label: `Track ${i + 1} Solo`,  group: `track${i}` },
    { id: `track${i}_clear`, label: `Track ${i + 1} Clear`, group: `track${i}` },
    { id: `track${i}_rec`,   label: `Track ${i + 1} Step Rec`, group: `track${i}` },
  ])).flat(),

  // ── Fader column placeholders ──────────────────────
  // Dedicated "column" IDs used by the Launch Control XL MK2 preset to
  // bind the bottom-row faders (CC 77-84) to a pad-column modifier
  // scheme: when some pad in column `c` is held (and no M/S/D/R is
  // held and REC is off), `fader_col${c}` routes to that pad's track
  // gate. Without a pad hold these IDs emit no action — the fader is
  // effectively idle. Users can override either side (bind the fader
  // to `track${i}_gate` directly for a static mapping, or leave the
  // column IDs in place for the modifier behaviour).
  ...Array.from({ length: 8 }, (_, c) => (
    { id: `fader_col${c}`, label: `Fader Col ${c + 1} (pad-held → gate)`, group: 'perform' }
  )),
] as const

// Set of modifier controlIds, extracted so the hot path can decide
// quickly whether a mapped message needs the modifier-routing branch
// instead of the regular onCCMapped / note-off drop.
export const MODIFIER_CONTROL_IDS = new Set<string>([
  'mod_d', 'mod_m', 'mod_s', 'mod_r',
])

// Toggle to get verbose console output for note-on / modifier routing.
// Off by default — D/M/S/R dispatch is stable, and leaving logging on
// during long sessions with external controllers causes steady main-
// thread drift (Chrome retains console entries forever, and at 16ths
// on a drum controller we emit dozens of `console.info` per second).
// Flip via localStorage when debugging a new controller or mapping:
//
//   localStorage.setItem('poly-seq:midi-debug', '1')  // force ON
//   localStorage.setItem('poly-seq:midi-debug', '0')  // force OFF
//
// Any truthy value forces on; '0' / '' / 'false' forces off. Missing
// key falls back to MIDI_IN_DEBUG_DEFAULT below.
const MIDI_IN_DEBUG_DEFAULT = false
const MIDI_IN_DEBUG = (() => {
  try {
    if (typeof localStorage === 'undefined') return MIDI_IN_DEBUG_DEFAULT
    const raw = localStorage.getItem('poly-seq:midi-debug')
    if (raw === null) return MIDI_IN_DEBUG_DEFAULT
    return raw !== '0' && raw !== '' && raw !== 'false'
  } catch {
    return MIDI_IN_DEBUG_DEFAULT
  }
})()

export type MappableControlId = typeof MAPPABLE_CONTROLS[number]['id']

export interface MidiInState {
  supported: boolean
  inputs: MIDIInput[]
  selectedIds: string[]
  // Back-compat mirror of selectedIds[0] ?? null. Kept as a plain reactive
  // field (not a computed getter) because several templates reference
  // `state.selectedId` directly and we need it to be a regular property
  // on the reactive object. `syncAttachments` keeps it in sync.
  selectedId: string | null
  clockSourceId: string | null
  syncMode: 'internal' | 'external'
  syncBpm: number | null   // last BPM derived from clock
  // True while F8 pulses are arriving (updated at ~500ms granularity — we
  // don't write on every pulse to keep reactivity cheap). UI uses this to
  // blink the SYNC indicator; scheduler does NOT use it (the phase corrector
  // relies on `pulseCountSinceStart` / `lastPulsePerfTime` instead).
  clockAlive: boolean
  // Monotonically-increasing count of F8 pulses received since the last 0xFA
  // (Start). Reset to 0 on Start; NOT reset on Continue (by design — Continue
  // preserves song position, so the scheduler's phase reference is still valid).
  pulseCountSinceStart: number
  // performance.now()-domain timestamp of the most recent F8 pulse. Paired
  // with `pulseCountSinceStart` this lets the scheduler compute the master's
  // actual vs predicted phase.
  lastPulsePerfTime: number
  // performance.now()-domain timestamp of the most recent 0xFA (Start) message.
  // Used as the anchor for expected-phase calculation.
  startPerfTime: number
  mappings: MidiMapping[]
  learnMode: boolean
  learnControlId: string | null
}

export function useMidiIn(callbacks: {
  onPlay: () => void
  onStop: () => void
  onCCMapped: (controlId: string, rawValue: number) => void // 0-127
  // Fires for note-on messages that did NOT consume the learn slot and are
  // not bound to a mapped control. Used by the step-recording path so that
  // mapped transport notes etc. never accidentally record into tracks.
  onNoteIn?: (channel: number, note: number, velocity: number) => void
  // Fires for note-off (0x80 or 0x90 vel=0) on unmapped notes. Symmetric
  // with onNoteIn so note-repeat can stop firing on pad release.
  onNoteOff?: (channel: number, note: number) => void
  // Modifier key edges. `id` is 'd' | 'm' | 's' | 'r'. Fires on BOTH the
  // down edge (on=true) and the up edge (on=false). Unlike onCCMapped,
  // mapped modifier controls bypass onCCMapped entirely so the store can
  // run tap/hold logic without racing the normal dispatch path.
  onModifierChange?: (id: 'd' | 'm' | 's' | 'r', on: boolean) => void
}) {
  const state = reactive<MidiInState>({
    supported: false,
    inputs: [],
    selectedIds: [],
    selectedId: null,
    clockSourceId: null,
    syncMode: 'internal',
    syncBpm: null,
    clockAlive: false,
    pulseCountSinceStart: 0,
    lastPulsePerfTime: 0,
    startPerfTime: 0,
    mappings: [],
    learnMode: false,
    learnControlId: null,
  })

  let midiAccess: WebMidi.MIDIAccess | null = null
  // Live MIDIInput handles keyed by id. Handlers attached to exactly the
  // inputs currently in state.selectedIds. Kept here (plain Map, not
  // reactive) because the hot message path shouldn't write to reactivity.
  const attachedInputs: Map<string, WebMidi.MIDIInput> = new Map()

  // ── Clock tracking ─────────────────────────────────
  // Rolling window of inter-clock intervals (seconds).
  // 24 clocks = 1 quarter note → BPM = 60 / (avgInterval × 24).
  // Only the input that matches state.clockSourceId contributes pulses —
  // accepting 0xF8 from every selected input would corrupt the rolling
  // average since two clock streams would be interleaved.
  //
  // Implementation: fixed-size ring buffer + running sum. At 24 PPQN ×
  // ~120 BPM we process ~48 pulses/sec on the main thread (same thread
  // that runs the scheduler tick), so the previous pattern of
  // `Array.shift()` (O(24) memmove) + `Array.reduce(+)` (24 adds) per
  // pulse added up. The ring updates in O(1): subtract the slot we're
  // about to overwrite, write the new value, add it to the sum. The
  // pre-filled zeroes mean the same arithmetic works during the initial
  // fill — the `count` guard below keeps the BPM calc correct.
  const CLOCK_WINDOW = 24
  const clockRing: number[] = new Array(CLOCK_WINDOW).fill(0)
  let clockRingIdx = 0     // next write slot
  let clockRingCount = 0   // filled slots, caps at CLOCK_WINDOW
  let clockRingSum = 0     // running sum of the filled slots
  let lastClockTimestamp = 0

  const resetClockTracking = () => {
    for (let i = 0; i < CLOCK_WINDOW; i++) clockRing[i] = 0
    clockRingIdx = 0
    clockRingCount = 0
    clockRingSum = 0
    lastClockTimestamp = 0
  }

  // ── clockAlive timeout ─────────────────────────────
  // `state.clockAlive` drives the UI SYNC-indicator blink. We set it true
  // on any F8 pulse and re-arm a 500ms timeout; if no pulse arrives within
  // that window the timeout flips it back to false. Re-arm is cheap even
  // at 48Hz (clearTimeout + setTimeout); the reactive write is guarded
  // with a !==-check so we only invalidate Vue's dep graph on state flips.
  let clockAliveTimerId: ReturnType<typeof setTimeout> | null = null
  const CLOCK_ALIVE_TIMEOUT_MS = 500
  const markClockAlive = () => {
    if (!state.clockAlive) state.clockAlive = true
    if (clockAliveTimerId) clearTimeout(clockAliveTimerId)
    clockAliveTimerId = setTimeout(() => {
      state.clockAlive = false
      clockAliveTimerId = null
    }, CLOCK_ALIVE_TIMEOUT_MS)
  }
  const killClockAlive = () => {
    if (clockAliveTimerId) { clearTimeout(clockAliveTimerId); clockAliveTimerId = null }
    if (state.clockAlive) state.clockAlive = false
  }

  // ── Mapping index ─────────────────────────────────
  // O(1) trigger lookup keyed by "type|channel|number". Rebuilt whenever
  // state.mappings changes (rare — Learn, removeMapping, loadMappings).
  // Callers inside the per-message hot path (handleNote, handleCC, the
  // note-off branch) use this instead of Array.find so heavy controller
  // traffic doesn't linear-scan 60+ mapping entries per message.
  //
  // First-match-wins: if two mappings somehow share the same trigger
  // tuple (possible if the user Learn-binds two controls from the same
  // pad), the older entry is kept — matching the previous Array.find
  // semantics. Same-controlId collisions can't happen because
  // recordMapping splices any prior entry with that controlId before
  // pushing the new one.
  const mappingIndex = new Map<string, MidiMapping>()
  const mappingKey = (type: 'cc' | 'note', ch: number, num: number) =>
    `${type}|${ch}|${num}`
  const rebuildMappingIndex = () => {
    mappingIndex.clear()
    for (const m of state.mappings) {
      const k = mappingKey(m.type, m.channel, m.number)
      if (!mappingIndex.has(k)) mappingIndex.set(k, m)
    }
  }
  // deep: true so in-place mutations (splice in recordMapping /
  // removeMapping) trigger rebuild, not just array-replacement writes.
  // immediate: true primes the index with whatever mappings loaded from
  // persistence before the first MIDI message arrives.
  watch(() => state.mappings, rebuildMappingIndex, { deep: true, immediate: true })

  const init = async () => {
    if (!navigator.requestMIDIAccess) {
      state.supported = false
      return
    }
    try {
      midiAccess = await navigator.requestMIDIAccess()
      state.supported = true
      updateInputList()
      midiAccess.onstatechange = () => {
        updateInputList()
        // Drop any selected id whose device disappeared; re-attach survivors.
        pruneMissingInputs()
        syncAttachments()
      }
    } catch (e) {
      console.error('MIDI IN init failed:', e)
      state.supported = false
    }
  }

  const updateInputList = () => {
    if (!midiAccess) return
    state.inputs = Array.from(midiAccess.inputs.values())
  }

  // Drop selectedIds whose device is no longer present. Also clear
  // clockSourceId if it points at a gone device.
  const pruneMissingInputs = () => {
    if (!midiAccess) return
    const present = new Set<string>()
    midiAccess.inputs.forEach((_, id) => present.add(id))
    const survivors = state.selectedIds.filter(id => present.has(id))
    if (survivors.length !== state.selectedIds.length) {
      state.selectedIds = survivors
    }
    if (state.clockSourceId && !present.has(state.clockSourceId)) {
      state.clockSourceId = state.selectedIds[0] ?? null
      resetClockTracking()
    }
  }

  // Ensure attachedInputs matches state.selectedIds exactly:
  // detach any input no longer selected, attach any newly selected one.
  // Callers invoke this after mutating selectedIds.
  const syncAttachments = () => {
    if (!midiAccess) {
      // Detach everything defensively.
      attachedInputs.forEach((inp) => { inp.onmidimessage = null })
      attachedInputs.clear()
      return
    }
    const wanted = new Set(state.selectedIds)
    // Detach removed.
    for (const [id, inp] of attachedInputs) {
      if (!wanted.has(id)) {
        inp.onmidimessage = null
        attachedInputs.delete(id)
      }
    }
    // Attach added.
    for (const id of state.selectedIds) {
      if (attachedInputs.has(id)) continue
      const inp = midiAccess.inputs.get(id)
      if (!inp) continue
      // Per-input closure captures `id` so the clock filter can tell which
      // stream the 0xF8 came from.
      inp.onmidimessage = (e) => onMidiMessage(id, e)
      attachedInputs.set(id, inp)
    }
    // If clock source isn't set but we have at least one selected input,
    // pick the first as a sensible default.
    if (!state.clockSourceId && state.selectedIds.length > 0) {
      state.clockSourceId = state.selectedIds[0]
      resetClockTracking()
    }
    // If clock source is no longer selected, move it.
    if (state.clockSourceId && !wanted.has(state.clockSourceId)) {
      state.clockSourceId = state.selectedIds[0] ?? null
      resetClockTracking()
    }
    // Keep back-compat `selectedId` mirror fresh.
    state.selectedId = state.selectedIds[0] ?? null
  }

  // ── Multi-select API ───────────────────────────────
  const selectInputs = (ids: string[]) => {
    // Dedupe while preserving insertion order.
    const seen = new Set<string>()
    const unique = ids.filter(id => (seen.has(id) ? false : (seen.add(id), true)))
    state.selectedIds = unique
    syncAttachments()
  }

  const toggleInput = (id: string) => {
    if (!id) return
    const cur = state.selectedIds
    const idx = cur.indexOf(id)
    if (idx >= 0) state.selectedIds = cur.filter(x => x !== id)
    else state.selectedIds = [...cur, id]
    syncAttachments()
  }

  // Back-compat single-select wrapper. Old call sites that passed a single
  // id (or null to clear) still work.
  const selectInput = (inputId: string | null) => {
    selectInputs(inputId ? [inputId] : [])
  }

  const setClockSource = (id: string | null) => {
    // Only allow ids that are currently selected; null clears the source
    // (external sync then has nothing to latch onto until re-set).
    if (id !== null && !state.selectedIds.includes(id)) return
    state.clockSourceId = id
    resetClockTracking()
  }

  const onMidiMessage = (sourceId: string, e: WebMidi.MIDIMessageEvent) => {
    const [status, data1, data2] = e.data
    const msgType = status & 0xf0
    const channel = (status & 0x0f) + 1  // 1-16

    // ── System Real-Time ───────────────────────────
    if (status === 0xf8) {
      // Only trust pulses from the designated clock source. Pulses from the
      // controller (which isn't emitting clock) would just be dropped here
      // anyway — this filter matters when two clock-capable devices are
      // both selected and we must pick one.
      if (sourceId === state.clockSourceId) handleClock(e.timeStamp)
      return
    }
    if (status === 0xfa) { handleTransport('start', e.timeStamp); return }   // Start
    if (status === 0xfb) { handleTransport('continue', e.timeStamp); return } // Continue
    if (status === 0xfc) { handleTransport('stop', e.timeStamp); return }    // Stop

    // ── Control Change ────────────────────────────
    if (msgType === 0xb0) {
      handleCC(channel, data1, data2)
      return
    }

    // ── Note On (velocity > 0) ────────────────────
    if (msgType === 0x90 && data2 > 0) {
      handleNote(channel, data1, data2)
      return
    }

    // ── Note Off (0x80 or 0x90 vel=0) ─────────────
    // Three cases:
    //  a) mapped to a modifier control → fire the up edge via
    //     onModifierChange so tap/hold detection works.
    //  b) mapped to any other control → forward to onCCMapped with
    //     rawValue=0 so the store gets a release edge. This is needed
    //     for pad-hold tracking (fader-gate column mode depends on
    //     knowing when a trackN_rec pad is released). Press-only
    //     controls are unaffected because their dispatch branches
    //     already gate on `rawValue > CC_PRESS_THRESHOLD`.
    //  c) unmapped → pass through as onNoteOff for beat-repeat etc.
    const isNoteOff = msgType === 0x80 || (msgType === 0x90 && data2 === 0)
    if (isNoteOff) {
      const mapped = mappingIndex.get(mappingKey('note', channel, data1))
      if (mapped && MODIFIER_CONTROL_IDS.has(mapped.controlId)) {
        const modId = mapped.controlId.slice(4) as 'd' | 'm' | 's' | 'r'
        callbacks.onModifierChange?.(modId, false)
      } else if (mapped) {
        callbacks.onCCMapped(mapped.controlId, 0)
      } else {
        callbacks.onNoteOff?.(channel, data1)
      }
      return
    }
  }

  // ── Clock ─────────────────────────────────────────
  const handleClock = (timestamp: number) => {
    // Phase-corrector inputs (updated unconditionally so the scheduler
    // can consume them whenever it wants — the reactive writes below are
    // cheap: Vue's Proxy setter short-circuits same-value writes, and
    // the numbers change every pulse anyway so there's no redundancy).
    state.pulseCountSinceStart++
    state.lastPulsePerfTime = timestamp
    markClockAlive()

    if (lastClockTimestamp > 0) {
      const intervalSec = (timestamp - lastClockTimestamp) / 1000
      // Sanity: ignore intervals outside reasonable BPM range (20–400)
      if (intervalSec > 0.001 && intervalSec < 0.3) {
        // O(1) ring update: swap out the oldest sample, patch the sum.
        const old = clockRing[clockRingIdx]
        clockRing[clockRingIdx] = intervalSec
        clockRingSum += intervalSec - old
        clockRingIdx = (clockRingIdx + 1) % CLOCK_WINDOW
        if (clockRingCount < CLOCK_WINDOW) clockRingCount++

        if (clockRingCount >= 4 && state.syncMode === 'external') {
          const avg = clockRingSum / clockRingCount
          // 24 PPQN → BPM = 60 / (avg × 24)
          const newBpm = Math.round(60 / (avg * 24))
          // Skip the reactive write when the rounded integer didn't
          // move. Vue's Proxy setter also short-circuits equal writes,
          // but the early-out spares the setter call + the downstream
          // `syncBpm` watcher's equality check too, which matters at
          // ~48 pulses/sec.
          if (newBpm !== state.syncBpm) state.syncBpm = newBpm
        }
      }
    }
    lastClockTimestamp = timestamp
  }

  // ── Transport ─────────────────────────────────────
  const handleTransport = (kind: 'start' | 'stop' | 'continue', timestamp: number) => {
    // Any selected input can trigger transport; the mapping table is
    // shared so the semantics are the same regardless of origin.
    if (kind === 'start') {
      // Start implies a new transport session — stale intervals from
      // before a long pause would bias the initial BPM estimate, so
      // clear the ring. The first handleClock after this skips the
      // interval math (lastClockTimestamp === 0 guard) and just
      // re-seeds lastClockTimestamp, so the ring fills cleanly from
      // the master's first pulse.
      resetClockTracking()
      // Phase-corrector anchors: record the Start timestamp and zero
      // the pulse counter. The scheduler will use these + the latest
      // F8 timestamp to compute startup phase error after ~2 bars.
      state.startPerfTime = timestamp
      state.pulseCountSinceStart = 0
      callbacks.onPlay()
    } else if (kind === 'continue') {
      // Continue preserves song-position phase. BPM ring is left alone
      // since tempo presumably hasn't changed — the accumulated
      // average stays valid and we skip a full re-fill window. Phase
      // corrector is also left alone: without a fresh Start anchor
      // we can't compute expected-phase reliably, so just let the
      // existing pulseCount/startPerfTime continue accumulating.
      callbacks.onPlay()
    } else {
      killClockAlive()
      state.pulseCountSinceStart = 0
      callbacks.onStop()
    }
  }

  // ── Note ──────────────────────────────────────────
  // Precedence: learn → mapped control → onNoteIn. Whichever consumes the
  // note first stops further handling, so a pad bound to transport_play
  // never also records a step.
  const handleNote = (channel: number, note: number, velocity: number) => {
    if (state.learnMode && state.learnControlId) {
      recordMapping(state.learnControlId, 'note', channel, note)
      state.learnMode = false
      state.learnControlId = null
      return
    }
    const mapping = mappingIndex.get(mappingKey('note', channel, note))
    if (mapping) {
      if (MIDI_IN_DEBUG) console.info(`[midi-in] note-on ch${channel} #${note} vel${velocity} → ${mapping.controlId}`)
      triggerControl(mapping.controlId, velocity)
      return
    }
    if (MIDI_IN_DEBUG) console.info(`[midi-in] note-on ch${channel} #${note} vel${velocity} → UNMAPPED (falling through to onNoteIn)`)
    callbacks.onNoteIn?.(channel, note, velocity)
  }

  // ── CC ────────────────────────────────────────────
  const handleCC = (channel: number, cc: number, value: number) => {
    if (state.learnMode && state.learnControlId) {
      recordMapping(state.learnControlId, 'cc', channel, cc)
      state.learnMode = false
      state.learnControlId = null
      return
    }
    const mapping = mappingIndex.get(mappingKey('cc', channel, cc))
    if (mapping) {
      triggerControl(mapping.controlId, value)
    }
  }

  // ── Control dispatch ─────────────────────────────
  const triggerControl = (controlId: string, rawValue: number) => {
    if (controlId === 'transport_play') {
      callbacks.onPlay()
    } else if (controlId === 'transport_stop') {
      callbacks.onStop()
    } else if (MODIFIER_CONTROL_IDS.has(controlId)) {
      // Down edge. Treat velocity > 0 as press. For CC-bound modifiers
      // (rare but allowed) use the same > 0 threshold so pots that
      // jitter around 0 don't flicker the modifier state.
      const modId = controlId.slice(4) as 'd' | 'm' | 's' | 'r'
      if (MIDI_IN_DEBUG) console.info(`[midi-in] modifier ${modId} ${rawValue > 0 ? 'DOWN' : 'UP'} (raw=${rawValue})`)
      callbacks.onModifierChange?.(modId, rawValue > 0)
    } else {
      // All other controls: delegate to caller (index.vue) with raw 0-127 value
      callbacks.onCCMapped(controlId, rawValue)
    }
  }

  // ── Mapping management ───────────────────────────
  const recordMapping = (controlId: string, type: 'cc' | 'note', channel: number, number: number) => {
    const idx = state.mappings.findIndex(m => m.controlId === controlId)
    if (idx >= 0) state.mappings.splice(idx, 1)
    state.mappings.push({ controlId, type, channel, number })
  }

  const removeMapping = (controlId: string) => {
    const idx = state.mappings.findIndex(m => m.controlId === controlId)
    if (idx >= 0) state.mappings.splice(idx, 1)
  }

  const startLearn = (controlId: string) => {
    state.learnMode = true
    state.learnControlId = controlId
  }

  const cancelLearn = () => {
    state.learnMode = false
    state.learnControlId = null
  }

  // ── Persistence ───────────────────────────────────
  // Unwrap the reactive proxy to plain objects before stringify. Vue 3's
  // Proxy-backed reactive arrays usually serialize correctly, but going
  // through toRaw + shallow spread eliminates any edge case where a getter
  // short-circuits or a subclass proxy trips JSON.stringify.
  const saveMappings = (): string => {
    const rawList = toRaw(state.mappings) ?? []
    const plain = rawList.map(m => ({
      controlId: m.controlId, type: m.type, channel: m.channel, number: m.number,
    }))
    return JSON.stringify({
      mappings: plain,
      syncMode: state.syncMode,
      // Multi-device v2 fields. Old loaders ignore unknown keys.
      selectedIds: [...state.selectedIds],
      clockSourceId: state.clockSourceId,
    }, null, 2)
  }

  const loadMappings = (json: string) => {
    try {
      const data = JSON.parse(json)
      if (Array.isArray(data.mappings)) state.mappings = data.mappings
      if (data.syncMode) state.syncMode = data.syncMode
      // Accept both the new `selectedIds: string[]` form and the legacy
      // `selectedId: string | null` form so old config exports keep working.
      if (Array.isArray(data.selectedIds)) {
        selectInputs(data.selectedIds.filter((x: unknown): x is string => typeof x === 'string'))
      } else if (typeof data.selectedId === 'string' && data.selectedId) {
        selectInputs([data.selectedId])
      }
      if (typeof data.clockSourceId === 'string' || data.clockSourceId === null) {
        setClockSource(data.clockSourceId)
      }
    } catch (e) {
      console.error('Failed to load MIDI config:', e)
    }
  }

  const getMappingFor = (controlId: string): MidiMapping | undefined =>
    state.mappings.find(m => m.controlId === controlId)

  return {
    state,
    init,
    // Multi-select API (preferred)
    selectInputs,
    toggleInput,
    setClockSource,
    // Back-compat single-select shim
    selectInput,
    // Mapping + learn
    startLearn,
    cancelLearn,
    removeMapping,
    saveMappings,
    loadMappings,
    getMappingFor,
    MAPPABLE_CONTROLS,
  }
}
