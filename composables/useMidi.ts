import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

// Minimal Web MIDI composable. Exposes available OUTPUTS only (this app doesn't
// receive MIDI, just sends note on/off).
//
// Usage:
//   const midi = useMidi()
//   midi.selectOutput(id)
//   midi.sendNoteOn(channel, note, velocity)
//   midi.sendNoteOff(channel, note)
//
// Implementation notes:
// - Client-only: requestMIDIAccess lives behind onMounted so SSR doesn't choke.
// - currentOutput is stored in a plain variable (not a ref). It's only read
//   from send*, which are called inside the scheduler's setTimeout path — we
//   deliberately keep that path off the reactive system for the same reason
//   the rest of the scheduler avoids reactive writes inside tick().

export type MidiOutputInfo = { id: string; name: string }

export function useMidi() {
  const supported = ref(false)
  const outputs = shallowRef<MidiOutputInfo[]>([])
  const selectedId = ref<string | null>(null)

  let access: any = null // MIDIAccess (avoid DOM lib dep)
  let currentOutput: any = null // MIDIOutput

  const refreshOutputs = () => {
    if (!access) return
    const list: MidiOutputInfo[] = []
    access.outputs.forEach((out: any) => list.push({ id: out.id, name: out.name || out.id }))
    outputs.value = list
    // If the currently selected device disappeared, drop the selection.
    if (selectedId.value && !list.find((o) => o.id === selectedId.value)) {
      selectedId.value = null
      currentOutput = null
    }
  }

  onMounted(async () => {
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) {
      return
    }
    try {
      // sysex: false — we only send short note messages
      access = await (navigator as any).requestMIDIAccess({ sysex: false })
      supported.value = true
      access.onstatechange = () => {
        refreshOutputs()
        // Re-resolve the selected output handle if it came back.
        if (selectedId.value) {
          currentOutput = access.outputs.get(selectedId.value) ?? null
        }
      }
      refreshOutputs()
    }
    catch (e) {
      // User denied access or browser doesn't support Web MIDI.
      console.warn('[midi] requestMIDIAccess failed', e)
    }
  })

  onBeforeUnmount(() => {
    if (access) access.onstatechange = null
    // Best-effort: turn off any lingering notes on all 16 channels.
    try {
      if (currentOutput) {
        for (let ch = 0; ch < 16; ch++) currentOutput.send([0xb0 | ch, 123, 0]) // All Notes Off
      }
    }
    catch {}
    currentOutput = null
  })

  const selectOutput = (id: string | null) => {
    selectedId.value = id
    if (!access || !id) {
      currentOutput = null
      return
    }
    currentOutput = access.outputs.get(id) ?? null
  }

  const clampCh = (ch: number) => Math.max(1, Math.min(16, ch | 0)) - 1
  const clamp7 = (n: number) => Math.max(0, Math.min(127, n | 0))

  const sendNoteOn = (ch: number, note: number, vel = 100) => {
    if (!currentOutput) return
    currentOutput.send([0x90 | clampCh(ch), clamp7(note), clamp7(vel)])
  }

  const sendNoteOff = (ch: number, note: number) => {
    if (!currentOutput) return
    currentOutput.send([0x80 | clampCh(ch), clamp7(note), 0])
  }

  const panic = () => {
    if (!currentOutput) return
    for (let ch = 0; ch < 16; ch++) currentOutput.send([0xb0 | ch, 123, 0])
  }

  return { supported, outputs, selectedId, selectOutput, sendNoteOn, sendNoteOff, panic }
}
