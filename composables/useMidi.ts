// Web MIDI composable — placeholder for future implementation.
// Planned API:
//   const { devices, selectedId, selectDevice, sendNoteOn, sendNoteOff } = useMidi()
//
// Implementation notes (for the future):
//  - Call navigator.requestMIDIAccess() inside onMounted (client-only)
//  - Track outputs in a shallowRef; update on statechange
//  - sendNoteOn(channel, note, velocity) → output.send([0x90 | (ch-1), note, vel])
//  - sendNoteOff(channel, note)          → output.send([0x80 | (ch-1), note, 0])
//  - The scheduler should call these via setTimeout to avoid reactive writes inside tick().

export function useMidi() {
  return {
    // stub; real implementation to come
    supported: false,
  }
}
