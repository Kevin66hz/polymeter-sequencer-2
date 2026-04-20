import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

// Minimal Web MIDI composable. Exposes available OUTPUTS only (this app doesn't
// receive MIDI, just sends note on/off).
//
// Multi-OUT model: every selected device receives the same note broadcast.
// Rationale (answered by the user): tracks aren't pinned to a specific piece
// of gear — you send the whole set to all connected devices and let the
// receivers filter by channel. Keeps the UI minimal (one chip list, no
// per-track device selector) and the data model flat.
//
// Back-compat shim: `selectedId` / `selectOutput(id | null)` are kept as
// computed / wrapper over `selectedIds` / `setOutputs`. Old call sites that
// assumed a single device keep working — reading `selectedId` returns the
// first selected id (or null). New code should use `selectedIds` + the
// multi methods directly.
//
// Usage (multi):
//   const midi = useMidi()
//   midi.setOutputs([id1, id2])                   // replace selection
//   midi.toggleOutput(id)                         // add / remove one
//   midi.sendNoteOn(channel, note, vel)           // broadcast (fire now)
//   midi.sendNoteOff(channel, note)
//   midi.sendNoteOn(channel, note, vel, perfMs)   // fire on OS queue at perfMs
//   midi.sendNoteOff(channel, note, perfMs)
//
// Timestamped variant: passing `timestamp` forwards to `output.send(msg,
// timestamp)`, which hands the message to the OS MIDI queue with sample-
// accurate delivery. This is how the scheduler avoids main-thread jitter
// on external hardware: it computes the perf-time at which the note
// should fire and hands the message off ~100ms early, leaving the OS to
// deliver it precisely. Omitting `timestamp` fires immediately (0), used
// by panic and unmount cleanup.
//
// Implementation notes:
// - Client-only: requestMIDIAccess lives behind onMounted so SSR doesn't choke.
// - `currentOutputs` is a plain array (not reactive). It's only read from
//   send*, which run inside the scheduler's setTimeout path — we deliberately
//   keep that path off the reactive system for the same reason the rest of
//   the scheduler avoids reactive writes inside tick().

export type MidiOutputInfo = { id: string; name: string }

export function useMidi() {
  const supported = ref(false)
  const outputs = shallowRef<MidiOutputInfo[]>([])
  const selectedIds = ref<string[]>([])
  // Back-compat: first selected id, or null. Old call sites that said
  // `midi.selectedId.value` still work.
  const selectedId = computed<string | null>(() => selectedIds.value[0] ?? null)

  let access: any = null // MIDIAccess (avoid DOM lib dep)
  // Live MIDIOutput handles for every id in selectedIds. Kept in sync with
  // selectedIds and the live outputs list from the MIDIAccess. Used by the
  // hot send path.
  let currentOutputs: any[] = []

  // Best-effort "controller feedback" output. Used only for sending LED
  // updates back to the controller (pad colors on the Launch Control XL
  // MK2's user template). Kept separate from `currentOutputs` so LED
  // feedback doesn't leak into the user's synth outputs as phantom
  // notes. Auto-detected by name match on every output-list refresh.
  let feedbackOutput: any = null
  const feedbackOutputName = ref<string | null>(null)

  // Name heuristics for the feedback output. Keep this list small and
  // specific — we only want to match the controllers whose user
  // templates we actually support. Matches are case-insensitive and
  // substring-based so different OSes' name decorations (e.g. port
  // numbers, "IAC" prefixes) don't break detection.
  const FEEDBACK_NAME_MATCHES = ['launch control']

  const resyncFeedbackOutput = () => {
    feedbackOutput = null
    feedbackOutputName.value = null
    if (!access) return
    access.outputs.forEach((out: any) => {
      if (feedbackOutput) return
      const name = (out.name || '').toLowerCase()
      if (FEEDBACK_NAME_MATCHES.some(m => name.includes(m))) {
        feedbackOutput = out
        feedbackOutputName.value = out.name || out.id
      }
    })
  }

  // Resync the hot-path broadcast list. The feedback output (e.g. the
  // LC XL MK2 controller) is explicitly excluded from this list even
  // if the user has it selected — sending step notes to a controller
  // pollutes its pad LEDs (a track defaulting to ch1 note 60 would
  // light P[1,8] every tick, in sync with tempo). LED updates go
  // through the separate `feedbackOutput` pointer, so we never lose
  // the ability to drive the controller, we just stop double-sending.
  const resyncCurrentOutputs = () => {
    if (!access) { currentOutputs = []; return }
    const feedbackId = feedbackOutput ? feedbackOutput.id : null
    currentOutputs = selectedIds.value
      .map(id => access.outputs.get(id))
      .filter(Boolean)
      .filter((out: any) => out.id !== feedbackId)
  }

  const refreshOutputs = () => {
    if (!access) return
    const list: MidiOutputInfo[] = []
    access.outputs.forEach((out: any) => list.push({ id: out.id, name: out.name || out.id }))
    outputs.value = list
    // Drop any id whose device unplugged. Preserve order of the survivors.
    const surviving = selectedIds.value.filter(id => list.some(o => o.id === id))
    if (surviving.length !== selectedIds.value.length) selectedIds.value = surviving
    // Detect feedback output FIRST so currentOutputs can filter it.
    resyncFeedbackOutput()
    resyncCurrentOutputs()
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
        resyncCurrentOutputs()
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
    // Best-effort: turn off any lingering notes on all 16 channels of every
    // selected output.
    try {
      for (const out of currentOutputs) {
        for (let ch = 0; ch < 16; ch++) out.send([0xb0 | ch, 123, 0]) // All Notes Off
      }
    }
    catch {}
    currentOutputs = []
  })

  // ── Multi-select API ───────────────────────────────
  const setOutputs = (ids: string[]) => {
    // Dedupe while preserving insertion order (first-click = first-in-list).
    const seen = new Set<string>()
    selectedIds.value = ids.filter(id => (seen.has(id) ? false : (seen.add(id), true)))
    resyncCurrentOutputs()
  }

  const toggleOutput = (id: string) => {
    if (!id) return
    const cur = selectedIds.value
    const idx = cur.indexOf(id)
    if (idx >= 0) selectedIds.value = cur.filter(x => x !== id)
    else selectedIds.value = [...cur, id]
    resyncCurrentOutputs()
  }

  // Back-compat single-select wrapper. Kept so older call sites that pass
  // (id | null) still work — but new call sites should use setOutputs().
  const selectOutput = (id: string | null) => {
    setOutputs(id ? [id] : [])
  }

  const clampCh = (ch: number) => Math.max(1, Math.min(16, ch | 0)) - 1
  const clamp7 = (n: number) => Math.max(0, Math.min(127, n | 0))

  // Broadcast sends: every selected output receives the same message. Loop
  // is inside a try-swallow per device so a single bad handle can't kill
  // the other devices mid-tick.
  //
  // Optional `timestamp` (performance.now()-clock milliseconds) forwards
  // to the Web MIDI API's `output.send(msg, timestamp)` overload so the
  // OS MIDI queue fires the message precisely at that instant rather
  // than "as soon as the main thread notices". Pass it for scheduled
  // notes; omit for immediate fires (panic, cleanup).
  const sendNoteOn = (ch: number, note: number, vel = 100, timestamp?: number) => {
    if (currentOutputs.length === 0) return
    const msg = [0x90 | clampCh(ch), clamp7(note), clamp7(vel)]
    for (const out of currentOutputs) {
      try { timestamp !== undefined ? out.send(msg, timestamp) : out.send(msg) } catch {}
    }
  }

  const sendNoteOff = (ch: number, note: number, timestamp?: number) => {
    if (currentOutputs.length === 0) return
    const msg = [0x80 | clampCh(ch), clamp7(note), 0]
    for (const out of currentOutputs) {
      try { timestamp !== undefined ? out.send(msg, timestamp) : out.send(msg) } catch {}
    }
  }

  // Panic: cancel anything the OS queue hasn't yet delivered (Chrome/
  // Firefox support MIDIOutput.clear()) and then force All Notes Off
  // on every channel. clear() is best-effort — a fallback path is fine
  // because the subsequent All Notes Off will silence whatever leaks.
  const panic = () => {
    if (currentOutputs.length === 0) return
    for (const out of currentOutputs) {
      try { typeof out.clear === 'function' && out.clear() } catch {}
      for (let ch = 0; ch < 16; ch++) { try { out.send([0xb0 | ch, 123, 0]) } catch {} }
    }
  }

  // ── Controller feedback (LED) ─────────────────────
  // Send a note-on message to the feedback output ONLY. Used for pad
  // LED colours on the LC XL MK2 user template. Velocity encodes the
  // colour (see LC XL MK2 programmer ref; this composable doesn't
  // interpret it). No-op when no feedback output has been detected,
  // so callers can fire-and-forget.
  const sendFeedback = (ch: number, note: number, vel: number) => {
    if (!feedbackOutput) return
    const msg = [0x90 | clampCh(ch), clamp7(note), clamp7(vel)]
    try { feedbackOutput.send(msg) } catch {}
  }

  // CC-based LED feedback. The LC XL MK2 user-template lights LEDs for
  // CC-bound buttons by receiving a CC message back on the same number.
  // Value encoding is the same colour palette as pad LEDs (12=off,
  // 15=red, 60=green, 63=amber) on the MK2 firmware we support.
  const sendFeedbackCC = (ch: number, cc: number, val: number) => {
    if (!feedbackOutput) return
    const msg = [0xb0 | clampCh(ch), clamp7(cc), clamp7(val)]
    try { feedbackOutput.send(msg) } catch {}
  }

  // Clear every LED on the feedback output by sending All Notes Off on
  // all 16 channels. Used on unmount and when the controller is
  // disconnected so stale lights don't linger.
  const clearFeedback = () => {
    if (!feedbackOutput) return
    for (let ch = 0; ch < 16; ch++) {
      try { feedbackOutput.send([0xb0 | ch, 123, 0]) } catch {}
    }
  }

  return {
    supported, outputs,
    // Multi-select state & API (preferred)
    selectedIds, setOutputs, toggleOutput,
    // Back-compat single-select shim
    selectedId, selectOutput,
    // Hot path
    sendNoteOn, sendNoteOff, panic,
    // Controller LED feedback
    sendFeedback, sendFeedbackCC, clearFeedback, feedbackOutputName,
  }
}
