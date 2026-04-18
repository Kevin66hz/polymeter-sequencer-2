import { reactive, toRaw } from 'vue'

// ── MIDI Input: external controller support ────────────────────────
//
// Three independent features:
//
// 1. Transport: 0xFA (Start) / 0xFC (Stop) / 0xFB (Continue)
//    trigger the sequencer's play() / stop() via callbacks.
//    A CC or Note can also be mapped to "transport_play" / "transport_stop".
//
// 2. Clock Sync: 0xF8 pulses (24 PPQN).
//    Averaged over a rolling window of 24 pulses to smooth jitter.
//    BPM = 60 / (avgInterval × 24).
//
// 3. Mapping: bind any CC or note to a named controlId.
//    Learn mode: activate, then move a knob / press a pad on the controller.
//    Saved as JSON for persistence.

export interface MidiMapping {
  controlId: string
  type: 'cc' | 'note'
  channel: number   // 1-16
  number: number    // CC# or note#
}

// All controls available for MIDI mapping
export const MAPPABLE_CONTROLS = [
  { id: 'transport_play', label: 'Play / Start',           group: 'transport' },
  { id: 'transport_stop', label: 'Stop',                   group: 'transport' },
  { id: 'bpm',            label: 'BPM',                    group: 'transport' },
  { id: 'masterN',        label: 'Master N',               group: 'master' },
  { id: 'masterD',        label: 'Master D',               group: 'master' },
  { id: 'master_apply',   label: 'Master Apply',           group: 'master' },
  // Per-track N and D knobs (tracks 0-7)
  ...Array.from({ length: 8 }, (_, i) => ([
    { id: `track${i}_n`, label: `Track ${i + 1} N`, group: `track${i}` },
    { id: `track${i}_d`, label: `Track ${i + 1} D`, group: `track${i}` },
  ])).flat(),
] as const

export type MappableControlId = typeof MAPPABLE_CONTROLS[number]['id']

export interface MidiInState {
  supported: boolean
  inputs: MIDIInput[]
  selectedId: string | null
  syncMode: 'internal' | 'external'
  syncBpm: number | null   // last BPM derived from clock
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
}) {
  const state = reactive<MidiInState>({
    supported: false,
    inputs: [],
    selectedId: null,
    syncMode: 'internal',
    syncBpm: null,
    mappings: [],
    learnMode: false,
    learnControlId: null,
  })

  let midiAccess: WebMidi.MIDIAccess | null = null
  let selectedInput: WebMidi.MIDIInput | null = null

  // ── Clock tracking ─────────────────────────────────
  // Rolling window of inter-clock intervals (seconds).
  // 24 clocks = 1 quarter note → BPM = 60 / (avgInterval × 24).
  const CLOCK_WINDOW = 24
  const clockIntervals: number[] = []
  let lastClockTimestamp = 0

  const init = async () => {
    if (!navigator.requestMIDIAccess) {
      state.supported = false
      return
    }
    try {
      midiAccess = await navigator.requestMIDIAccess()
      state.supported = true
      updateInputList()
      midiAccess.onstatechange = updateInputList
    } catch (e) {
      console.error('MIDI IN init failed:', e)
      state.supported = false
    }
  }

  const updateInputList = () => {
    if (!midiAccess) return
    state.inputs = Array.from(midiAccess.inputs.values())
  }

  const selectInput = (inputId: string | null) => {
    if (selectedInput) selectedInput.onmidimessage = null
    state.selectedId = inputId
    selectedInput = inputId ? midiAccess?.inputs.get(inputId) ?? null : null
    if (selectedInput) {
      selectedInput.onmidimessage = onMidiMessage
      // Reset clock state when switching device
      clockIntervals.length = 0
      lastClockTimestamp = 0
    }
  }

  const onMidiMessage = (e: WebMidi.MIDIMessageEvent) => {
    const [status, data1, data2] = e.data
    const msgType = status & 0xf0
    const channel = (status & 0x0f) + 1  // 1-16

    // ── System Real-Time ───────────────────────────
    if (status === 0xf8) { handleClock(e.timeStamp); return }
    if (status === 0xfa) { handleTransport('start'); return }   // Start
    if (status === 0xfb) { handleTransport('continue'); return } // Continue
    if (status === 0xfc) { handleTransport('stop'); return }    // Stop

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
    // Skip when the note was consumed by learn or mapping — those bindings
    // don't care about release and we don't want to emit phantom offs.
    const isNoteOff = msgType === 0x80 || (msgType === 0x90 && data2 === 0)
    if (isNoteOff) {
      const mapped = state.mappings.find(
        m => m.type === 'note' && m.channel === channel && m.number === data1
      )
      if (!mapped) callbacks.onNoteOff?.(channel, data1)
      return
    }
  }

  // ── Clock ─────────────────────────────────────────
  const handleClock = (timestamp: number) => {
    if (lastClockTimestamp > 0) {
      const intervalSec = (timestamp - lastClockTimestamp) / 1000
      // Sanity: ignore intervals outside reasonable BPM range (20–400)
      if (intervalSec > 0.001 && intervalSec < 0.3) {
        clockIntervals.push(intervalSec)
        if (clockIntervals.length > CLOCK_WINDOW) clockIntervals.shift()

        if (clockIntervals.length >= 4 && state.syncMode === 'external') {
          const avg = clockIntervals.reduce((a, b) => a + b) / clockIntervals.length
          // 24 PPQN → BPM = 60 / (avg × 24)
          state.syncBpm = Math.round(60 / (avg * 24))
        }
      }
    }
    lastClockTimestamp = timestamp
  }

  // ── Transport ─────────────────────────────────────
  const handleTransport = (kind: 'start' | 'stop' | 'continue') => {
    // Check if "transport_play" / "transport_stop" is mapped to a CC/note;
    // if not, System RT messages trigger directly.
    if (kind === 'start' || kind === 'continue') {
      callbacks.onPlay()
    } else {
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
    const mapping = state.mappings.find(
      m => m.type === 'note' && m.channel === channel && m.number === note
    )
    if (mapping) {
      triggerControl(mapping.controlId, velocity)
      return
    }
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
    const mapping = state.mappings.find(
      m => m.type === 'cc' && m.channel === channel && m.number === cc
    )
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
    }, null, 2)
  }

  const loadMappings = (json: string) => {
    try {
      const data = JSON.parse(json)
      if (Array.isArray(data.mappings)) state.mappings = data.mappings
      if (data.syncMode) state.syncMode = data.syncMode
    } catch (e) {
      console.error('Failed to load MIDI config:', e)
    }
  }

  const getMappingFor = (controlId: string): MidiMapping | undefined =>
    state.mappings.find(m => m.controlId === controlId)

  return {
    state,
    init,
    selectInput,
    startLearn,
    cancelLearn,
    removeMapping,
    saveMappings,
    loadMappings,
    getMappingFor,
    MAPPABLE_CONTROLS,
  }
}
