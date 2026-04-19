// Launch Control XL MK2 LED feedback composable.
//
// Encapsulates ALL controller-specific LED behaviour so useSequencerStore
// stays controller-agnostic. Only effectivePadViewMode (pure UI state) is
// kept in the store; everything that touches sendFeedback / sendFeedbackCC
// lives here.
//
// Design contract:
//   - Caller passes reactive refs / computed values; this composable
//     observes them via watchers and fires MIDI LED messages as side effects.
//   - All cleanup (timers, LED clear-on-unmount) is registered via
//     onBeforeUnmount inside this composable — the caller doesn't need to
//     do anything extra.
//   - No-op when the feedback output isn't connected (sendFeedback guards).

// Vue primitives are auto-imported by Nuxt — no explicit `from 'vue'` import
// needed (and it would fail at `nuxi typecheck` since vue lives in apps/type2
// rather than at the layer level).

type PadViewMode = 'mute' | 'solo' | 'rec'

export interface LCFeedbackDeps {
  tracks:               Ref<{ mute: boolean; solo: boolean; steps: boolean[] }[]>
  heads:                Ref<number[]>
  recording:            Ref<boolean>
  repeatOn:             Ref<boolean>
  savedSnapshot:        Ref<unknown>           // truthy = a snapshot exists
  effectivePadViewMode: ComputedRef<PadViewMode>
  midi: {
    sendFeedback:    (ch: number, note: number, vel: number) => void
    sendFeedbackCC:  (ch: number, cc:   number, val: number) => void
    clearFeedback:   () => void
    feedbackOutputName: Ref<string | null>
  }
  midiIn: {
    state: { mappings: Array<{ controlId: string; type: string; channel: number; number: number }> }
  }
  midiModifiers: {
    state: { d: boolean; m: boolean; s: boolean; r: boolean; padView: 'mute' | 'solo' }
  }
}

export function useLaunchControlFeedback(deps: LCFeedbackDeps) {
  const {
    tracks, heads, recording, repeatOn, savedSnapshot,
    effectivePadViewMode, midi, midiIn, midiModifiers,
  } = deps

  // ── LED colour palette ─────────────────────────────────────────────
  // LC XL MK2 pad LEDs: velocity = red(bits 0-1) × green(bits 4-5)
  // + clear/copy behaviour bits (0b1100). Pads only.
  const LED_OFF       = 12
  const LED_RED       = 15
  const LED_GREEN     = 60
  const LED_AMBER     = 63
  // 1/3 brightness amber — ambient fill in REC view so every pad stays
  // faintly lit; active-step flashes overwrite with LED_AMBER then revert.
  const LED_AMBER_DIM = 29

  // Right-column modifier / nav buttons: single-colour, plain 0/127.
  const BTN_OFF = 0
  const BTN_ON  = 127

  // ── Pad mapping resolver ───────────────────────────────────────────
  // track${i}_rec → (channel, note) from live mapping table.
  const padMappings = computed(() => {
    const out: ({ channel: number; note: number } | null)[] = Array(16).fill(null)
    for (let i = 0; i < 16; i++) {
      const m = midiIn.state.mappings.find(
        x => x.controlId === `track${i}_rec` && x.type === 'note',
      )
      out[i] = m ? { channel: m.channel, note: m.number } : null
    }
    return out
  })

  // LED velocity for one pad in MUTE or SOLO view.
  const ledVelForTrack = (trk: { mute: boolean; solo: boolean }, view: 'mute' | 'solo') => {
    if (view === 'mute') return trk.mute ? LED_OFF : LED_RED
    return trk.solo ? LED_GREEN : LED_OFF
  }

  // ── Pad LED helpers ────────────────────────────────────────────────
  const fillAllPadsDimAmber = () => {
    for (let i = 0; i < 16; i++) {
      const map = padMappings.value[i]
      if (map) midi.sendFeedback(map.channel, map.note, LED_AMBER_DIM)
    }
  }

  const refreshAllPadLeds = () => {
    const mode = effectivePadViewMode.value
    if (mode === 'rec') {
      fillAllPadsDimAmber()
      return
    }
    for (let i = 0; i < 16; i++) {
      const map = padMappings.value[i]
      if (!map) continue
      const trk = tracks.value[i]
      if (!trk) continue
      midi.sendFeedback(map.channel, map.note, ledVelForTrack(trk, mode))
    }
  }

  // ── REC-view pulse timers ──────────────────────────────────────────
  // Each track has its own timer so fast tracks pulse independently.
  const REC_PULSE_MS = 90
  const recPulseTimers: (ReturnType<typeof setTimeout> | null)[] = Array(16).fill(null)

  const clearRecPulseTimers = () => {
    for (let i = 0; i < 16; i++) {
      const t = recPulseTimers[i]
      if (t) { clearTimeout(t); recPulseTimers[i] = null }
    }
  }

  // ── Modifier / nav button LEDs ─────────────────────────────────────
  const ctrlMapping = (controlId: string) => {
    const m = midiIn.state.mappings.find(x => x.controlId === controlId)
    if (!m) return null
    return { type: m.type, channel: m.channel, number: m.number }
  }

  const sendModLed = (controlId: string, on: boolean) => {
    const m = ctrlMapping(controlId)
    if (!m) return
    const val = on ? BTN_ON : BTN_OFF
    if (m.type === 'note') midi.sendFeedback(m.channel, m.number, val)
    else midi.sendFeedbackCC(m.channel, m.number, val)
  }

  // rBlinkPhase is kept outside Vue reactivity so the interval tick
  // doesn't re-trigger any watchers.
  let rBlinkPhase = false
  let rBlinkTimer: ReturnType<typeof setInterval> | null = null
  const R_BLINK_MS = 400

  const refreshModLeds = () => {
    const st = midiModifiers.state
    sendModLed('mod_d', st.d)
    sendModLed('mod_m', st.m || st.padView === 'mute')
    sendModLed('mod_s', st.s || st.padView === 'solo')
    sendModLed('mod_r', recording.value ? rBlinkPhase : st.r)
    const snapLit = !!savedSnapshot.value
    sendModLed('snapshot_save',   snapLit)
    sendModLed('repeat_trigger',  true)
    sendModLed('snapshot_recall', snapLit)
    sendModLed('master_apply',    true)
  }

  // ── Watchers ───────────────────────────────────────────────────────

  // REC blink timer — starts/stops with recording flag.
  watch(recording, (on) => {
    if (on) {
      if (!rBlinkTimer) {
        rBlinkPhase = true
        rBlinkTimer = setInterval(() => {
          rBlinkPhase = !rBlinkPhase
          sendModLed('mod_r', recording.value ? rBlinkPhase : midiModifiers.state.r)
        }, R_BLINK_MS)
      }
    } else {
      if (rBlinkTimer) { clearInterval(rBlinkTimer); rBlinkTimer = null }
      rBlinkPhase = false
    }
    refreshModLeds()
  }, { immediate: true })

  // Bulk pad refresh on view-mode change, mapping change, or output reconnect.
  watch(
    [effectivePadViewMode, padMappings, () => midi.feedbackOutputName.value],
    () => { clearRecPulseTimers(); refreshAllPadLeds() },
    { immediate: true },
  )

  // Per-track mute/solo LED: single message per changed track.
  // Joined-string source avoids a deep watch on the whole tracks array.
  watch(
    () => tracks.value.map(t => `${t.mute ? 1 : 0}${t.solo ? 1 : 0}`),
    (curr, prev) => {
      const mode = effectivePadViewMode.value
      if (mode === 'rec') return
      for (let i = 0; i < 16; i++) {
        if (prev && curr[i] === prev[i]) continue
        const map = padMappings.value[i]
        if (!map) continue
        const trk = tracks.value[i]
        if (!trk) continue
        midi.sendFeedback(map.channel, map.note, ledVelForTrack(trk, mode))
      }
    },
  )

  // REC-view playhead pulse: flash amber when a track's head lands on an
  // active step. heads.value is always replaced (never mutated in place)
  // so shallow watch is sufficient — no deep: true needed.
  watch(heads, (curr, prev) => {
    if (effectivePadViewMode.value !== 'rec') return
    for (let i = 0; i < 16; i++) {
      const h = curr[i]
      if (prev && prev[i] === h) continue
      if (h < 0) continue
      const trk = tracks.value[i]
      if (!trk || !trk.steps[h]) continue
      const map = padMappings.value[i]
      if (!map) continue
      midi.sendFeedback(map.channel, map.note, LED_AMBER)
      const prevTimer = recPulseTimers[i]
      if (prevTimer) clearTimeout(prevTimer)
      recPulseTimers[i] = setTimeout(() => {
        recPulseTimers[i] = null
        if (effectivePadViewMode.value !== 'rec') return
        const m2 = padMappings.value[i]
        if (m2) midi.sendFeedback(m2.channel, m2.note, LED_AMBER_DIM)
      }, REC_PULSE_MS)
    }
  })

  // Modifier / nav button LED bulk refresh.
  watch(
    () => [
      midiModifiers.state.d, midiModifiers.state.m,
      midiModifiers.state.s, midiModifiers.state.r,
      midiModifiers.state.padView,
      repeatOn.value,
      !!savedSnapshot.value,
      midi.feedbackOutputName.value,
      midiIn.state.mappings,
    ],
    () => refreshModLeds(),
    { immediate: true, deep: true },
  )

  // ── Cleanup ────────────────────────────────────────────────────────
  onBeforeUnmount(() => {
    if (rBlinkTimer) { clearInterval(rBlinkTimer); rBlinkTimer = null }
    clearRecPulseTimers()
    midi.clearFeedback()
  })
}
