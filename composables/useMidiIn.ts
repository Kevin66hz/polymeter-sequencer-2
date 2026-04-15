import { ref, reactive } from 'vue'

// ── MIDI Input: receive note/CC from external keyboard/controller ──
//
// Features:
// - Transpose: play a note to set global semitone offset (baseline C4=60)
// - Sync: follow external MIDI clock (24 PPQN, 0xF8), derive BPM
// - Mapping: learn CC/notes → control bindings, persist as JSON

export interface MidiMapping {
  controlId: string // e.g. "masterN", "masterD", "tempo", "track0_n", "track0_mute"
  type: 'cc' | 'note' // CC number or note number
  channel: number // 0-15
  number: number // CC# or note#
}

export interface MidiInState {
  supported: boolean
  inputs: MIDIInput[]
  selectedId: string | null
  transpose: number // semitones offset (C4=60 baseline)
  syncMode: 'internal' | 'external' // external = follow MIDI clock
  syncBpm: number | null // derived from clock if external
  mappings: MidiMapping[]
  learnMode: boolean
  learnControlId: string | null
}

export function useMidiIn() {
  const state = reactive<MidiInState>({
    supported: false,
    inputs: [],
    selectedId: null,
    transpose: 0,
    syncMode: 'internal',
    syncBpm: null,
    mappings: [],
    learnMode: false,
    learnControlId: null,
  })

  let midiAccess: WebMidi.MIDIAccess | null = null
  let selectedInput: WebMidi.MIDIInput | null = null

  // MIDI Clock tracking (24 PPQN)
  let clockCount = 0
  let lastClockTime = 0
  const CLOCKS_PER_16TH = 6

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
      console.error('MIDI init failed:', e)
      state.supported = false
    }
  }

  const updateInputList = () => {
    if (!midiAccess) return
    state.inputs = Array.from(midiAccess.inputs.values())
  }

  const selectInput = (inputId: string | null) => {
    // Unbind old
    if (selectedInput) {
      selectedInput.onmidimessage = null
    }
    state.selectedId = inputId
    selectedInput = inputId ? midiAccess?.inputs.get(inputId) ?? null : null

    if (selectedInput) {
      selectedInput.onmidimessage = onMidiMessage
      clockCount = 0
      lastClockTime = 0
    }
  }

  const onMidiMessage = (e: WebMidi.MIDIMessageEvent) => {
    const [status, data1, data2] = e.data
    const channel = (status & 0x0f) + 1 // 1-16
    const msgType = status & 0xf0

    // ── MIDI System Real-Time ──
    if (status === 0xf8) {
      // Clock pulse (24 per quarter)
      handleClock(e.timeStamp)
      return
    }
    if (status === 0xfa) {
      // Start
      if (state.syncMode === 'external') {
        clockCount = 0
        lastClockTime = e.timeStamp
      }
      return
    }
    if (status === 0xfc) {
      // Stop
      clockCount = 0
      return
    }

    // ── Control Change ──
    if (msgType === 0xb0) {
      const cc = data1
      const value = data2
      if (state.learnMode) {
        // Record this CC as the mapping for learnControlId
        if (state.learnControlId) {
          recordMapping(state.learnControlId, 'cc', channel, cc)
          state.learnMode = false
          state.learnControlId = null
        }
      } else {
        // Apply existing CC mapping
        applyCCMapping(channel, cc, value)
      }
      return
    }

    // ── Note On ──
    if (msgType === 0x90 && data2 > 0) {
      const note = data1
      if (state.learnMode) {
        // Record this note as the mapping
        if (state.learnControlId) {
          recordMapping(state.learnControlId, 'note', channel, note)
          state.learnMode = false
          state.learnControlId = null
        }
      } else {
        // Apply existing note mapping or transpose
        applyNoteOn(channel, note, data2)
      }
      return
    }

    // ── Note Off ──
    if (msgType === 0x80 || (msgType === 0x90 && data2 === 0)) {
      // Could track note-off for sustain, but typically we just ignore
      return
    }
  }

  const handleClock = (timestamp: number) => {
    if (state.syncMode !== 'external') return

    clockCount++
    if (clockCount === 1) {
      // Start of measurement
      lastClockTime = timestamp
    } else if (clockCount > CLOCKS_PER_16TH) {
      // Every CLOCKS_PER_16TH pulses, estimate BPM
      const elapsed = (timestamp - lastClockTime) / 1000 // seconds
      const sixteenths = (clockCount - 1) / CLOCKS_PER_16TH
      const bpm = Math.round((sixteenths / elapsed) * 60 * 4) // 60 sec/min, 4 sixteenths per beat
      state.syncBpm = bpm
      clockCount = 0
    }
  }

  const applyNoteOn = (channel: number, note: number, velocity: number) => {
    // Check if mapped to a control
    const mapping = state.mappings.find(
      m => m.type === 'note' && m.channel === channel && m.number === note
    )
    if (mapping) {
      applyMapping(mapping, velocity)
    } else {
      // No mapping — use for transpose
      // Baseline note C4 (60) = 0 offset
      const offset = note - 60
      state.transpose = offset
    }
  }

  const applyCCMapping = (channel: number, cc: number, value: number) => {
    const mapping = state.mappings.find(
      m => m.type === 'cc' && m.channel === channel && m.number === cc
    )
    if (mapping) {
      applyMapping(mapping, value)
    }
  }

  const applyMapping = (mapping: MidiMapping, value: number) => {
    // The actual application is done by the main component via a callback.
    // Here we just record that a mapping was triggered. The main component
    // will poll or subscribe to these events.
    // For now, return the control ID and normalized value (0-127 → 0-1).
    // This will be handled in pages/index.vue via a callback ref.
  }

  const recordMapping = (controlId: string, type: 'cc' | 'note', channel: number, number: number) => {
    // Remove any existing mapping for this control
    const idx = state.mappings.findIndex(m => m.controlId === controlId)
    if (idx >= 0) {
      state.mappings.splice(idx, 1)
    }
    state.mappings.push({ controlId, type, channel, number })
  }

  const startLearn = (controlId: string) => {
    state.learnMode = true
    state.learnControlId = controlId
  }

  const cancelLearn = () => {
    state.learnMode = false
    state.learnControlId = null
  }

  const saveMappings = (): string => {
    const data = {
      mappings: state.mappings,
      transpose: state.transpose,
      syncMode: state.syncMode,
    }
    return JSON.stringify(data, null, 2)
  }

  const loadMappings = (json: string) => {
    try {
      const data = JSON.parse(json)
      if (data.mappings && Array.isArray(data.mappings)) {
        state.mappings = data.mappings
      }
      if (typeof data.transpose === 'number') {
        state.transpose = data.transpose
      }
      if (data.syncMode) {
        state.syncMode = data.syncMode
      }
    } catch (e) {
      console.error('Failed to load mappings:', e)
    }
  }

  return {
    state,
    init,
    selectInput,
    startLearn,
    cancelLearn,
    saveMappings,
    loadMappings,
  }
}
