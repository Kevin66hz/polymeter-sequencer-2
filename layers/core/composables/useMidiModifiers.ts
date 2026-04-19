import { reactive } from 'vue'

// ── MIDI Modifier Keys (D / M / S / R) ─────────────────────────────
//
// The Launch Control XL MK2 has four dedicated single-colour buttons on
// the right side — Device / Mute / Solo / Record Arm — that the default
// user-template maps to A6 / A#6 / B6 / C7 respectively. The polymeter
// sequencer treats these as *modifier* keys: holding one changes what a
// subsequent pad press means (e.g. M-hold + pad → track mute toggle), so
// one pad column can drive record / mute / solo / clear without burning
// four separate pads per track.
//
// This module is *controller-agnostic*: the actual note bindings live in
// the shared mapping table (`mod_d`, `mod_m`, `mod_s`, `mod_r` are
// regular MAPPABLE_CONTROLS entries), so the user can rebind them to any
// note/CC via Learn. `useMidiIn.handleNote` / note-off routing recognises
// those four controlIds and forwards press/release transitions here.
//
// Tap vs hold:
//   - Tap   — press + release within TAP_THRESHOLD_MS, with no pad press
//             consumed during the hold. Fires the modifier's tap handler
//             (e.g. M tap → switch pad LED view to MUTE).
//   - Hold  — pad press(es) occurred while the modifier was down.  On
//             release we fire `onRelease` only (no tap action).
//   - D + M — special case: if M is pressed while D is held, fire
//             "ALL MUTE" immediately and mark M as consumed so its own
//             tap action does NOT fire on release.
//
// Pad LED / view state (`padView = 'mute' | 'solo'`) is tracked here so a
// future LED feedback layer can read it, but the current UI does not yet
// visualise it — the tap actions for M / S just update this field.
//
// Keep this module free of Vue template concerns (no onMounted, no
// templates). It is consumed by `useSequencerStore`.

export type ModifierId = 'd' | 'm' | 's' | 'r'

const TAP_THRESHOLD_MS = 300

export interface ModifierState {
  // Live hold state. true while the hardware button is held down.
  d: boolean
  m: boolean
  s: boolean
  r: boolean
  // Pad LED view mode — driven by M/S tap. 'mute' is the default so the
  // sequencer starts showing mute state on the controller's pads.
  padView: 'mute' | 'solo'
  // Set of currently-held pad track indices (0..15). A pad hold only
  // engages the "pad modifier" semantics (fader-gate column routing)
  // when none of D/M/S/R is held and REC is off — that decision lives
  // in the store. This field just tracks the raw hold state so the
  // store can query "which track in column c is held?" without
  // threading extra refs. Reactive so future UI can visualise it.
  heldPads: Set<number>
}

export interface UseMidiModifiersCallbacks {
  // Tap handlers: fire when modifier is released within TAP_THRESHOLD_MS
  // and no pad / chord consumed it. Implementations typically toggle a
  // small piece of state (view mode, REC arm).
  onMTap?: () => void
  onSTap?: () => void
  onRTap?: () => void
  // Compound press: D is already held and M is now pressed. Typically
  // routed to ALL MUTE. If provided, M's own tap action is suppressed on
  // release.
  onDMChord?: () => void
}

export function useMidiModifiers(cb: UseMidiModifiersCallbacks = {}) {
  const state = reactive<ModifierState>({
    d: false,
    m: false,
    s: false,
    r: false,
    padView: 'mute',
    heldPads: new Set<number>(),
  })

  // Per-modifier bookkeeping for tap detection. Stored outside the
  // reactive `state` so writes don't thrash downstream watchers.
  const pressTime: Record<ModifierId, number> = { d: 0, m: 0, s: 0, r: 0 }
  // `consumed` flips true as soon as something downstream treats the
  // modifier as an active hold (e.g. a pad press while M is held). That
  // cancels the tap interpretation on release.
  const consumed: Record<ModifierId, boolean> = { d: false, m: false, s: false, r: false }

  const setModifier = (id: ModifierId, on: boolean) => {
    if (on) {
      // Down edge. Special compound: pressing M while D is already held
      // triggers ALL MUTE and suppresses M's own tap.
      if (id === 'm' && state.d) {
        cb.onDMChord?.()
        state.m = true
        pressTime.m = performance.now()
        consumed.m = true   // so release-as-tap doesn't fire
        consumed.d = true   // D was used as a modifier, not tap'd
        return
      }
      state[id] = true
      pressTime[id] = performance.now()
      consumed[id] = false
      return
    }
    // Up edge. Decide tap vs plain release.
    const held = performance.now() - pressTime[id]
    state[id] = false
    if (consumed[id] || held > TAP_THRESHOLD_MS) {
      // It was a hold (or used as a chord base) — no tap.
      consumed[id] = false
      return
    }
    // Tap.
    consumed[id] = false
    if (id === 'm') {
      state.padView = 'mute'
      cb.onMTap?.()
    } else if (id === 's') {
      state.padView = 'solo'
      cb.onSTap?.()
    } else if (id === 'r') {
      cb.onRTap?.()
    }
    // D has no tap action on its own — it's always a modifier.
  }

  // Called by downstream code (e.g. the pad-press dispatch in the store)
  // to note that the current modifier hold has been "used" and therefore
  // its release should NOT fire the tap action. Safe to call even when
  // no modifier is held — it's a no-op in that case.
  const markConsumed = (id: ModifierId) => { consumed[id] = true }

  // Convenience: returns the "active" modifier for pad-press routing in
  // priority order D > M > S. R is not a per-pad modifier (it only arms
  // REC), so it's excluded. Returns null when no relevant modifier is
  // down so callers can fall through to the default pad behaviour.
  const activePadModifier = (): 'd' | 'm' | 's' | null => {
    if (state.d) return 'd'
    if (state.m) return 'm'
    if (state.s) return 's'
    return null
  }

  // ── Pad hold tracking ──────────────────────────────
  // Called by the store's trackN_rec dispatch on press (on=true) and
  // release (on=false). When no M/S/D/R modifier is active and REC is
  // off, a plain pad hold becomes the anchor for fader-gate column
  // routing: holding P[row,col] + moving F[4,col] edits that track's
  // gate (see useSequencerStore).
  //
  // We deliberately track ALL pad holds, regardless of whether a
  // modifier is active at press time. The store only *consults* this
  // set when dispatching a fader CC, and guards the consultation with
  // its own modifier / REC checks. This keeps the book-keeping simple
  // and robust to release-ordering quirks.
  // Tap-vs-hold bookkeeping for pads. A pad "tap" is a short press with
  // nothing consuming it — used by padView-based mute/solo which only
  // fires on release. "Consumed" means the fader moved while the pad was
  // held (= the user was adjusting gate, not toggling mute/solo), or
  // some other action already fired. `padPressTime` tracks when the pad
  // went down so callers can gate on a threshold.
  const PAD_TAP_THRESHOLD_MS = 400
  const padPressTime: Record<number, number> = Object.create(null)
  const padConsumed: Record<number, boolean> = Object.create(null)

  const setPadHold = (trackIdx: number, on: boolean) => {
    if (on) {
      state.heldPads.add(trackIdx)
      padPressTime[trackIdx] = performance.now()
      padConsumed[trackIdx] = false
    } else {
      state.heldPads.delete(trackIdx)
      // Leave padPressTime / padConsumed intact so the release handler
      // in the store can inspect them. They get reset on the next press.
    }
  }

  // Mark a specific pad's hold as "consumed" — a fader touched its
  // column, so on release we should skip any deferred tap action.
  const markPadConsumed = (trackIdx: number) => {
    padConsumed[trackIdx] = true
  }

  // Mark ALL currently-held pads consumed. Useful when a column-level
  // action (fader-col) fires — we don't always know which exact pad the
  // user intended, and row-2-wins-over-row-1 might have picked one that
  // isn't the "most recent".
  const markAllHeldPadsConsumed = () => {
    state.heldPads.forEach(i => { padConsumed[i] = true })
  }

  // Was this pad's press short enough and unconsumed — i.e. a genuine
  // tap, not a hold-for-gate? Used by the store on pad release to
  // decide whether to fire the deferred padView action.
  const isPadTap = (trackIdx: number): boolean => {
    if (padConsumed[trackIdx]) return false
    const t = padPressTime[trackIdx]
    if (!t) return false
    return performance.now() - t <= PAD_TAP_THRESHOLD_MS
  }

  // "Effective" pad view — what the pads should be rendering *right now*.
  // While M is held the pads temporarily show MUTE view (regardless of the
  // persisted padView), while S is held they show SOLO view. On release
  // (without a tap consuming the modifier) the view reverts to the
  // persisted `state.padView`. When M is held while SOLO is persisted we
  // briefly show MUTE; likewise S over MUTE. When both are somehow held
  // we prefer M (matches the D > M > S priority in `activePadModifier`).
  //
  // Used by the store to drive pad LED colours on the controller and by
  // the UI to show a "(temporary)" badge. Kept as a method (not a
  // computed) so callers that already have `state` in a reactive scope
  // can just call it — Vue's reactivity picks up state.m/state.s/
  // state.padView reads inside the function body.
  const effectivePadView = (): 'mute' | 'solo' => {
    if (state.m) return 'mute'
    if (state.s) return 'solo'
    return state.padView
  }

  // Returns the trackIdx of a pad currently held in column `col` (0..7),
  // or null if nothing in that column is held. When both rows have a
  // pad held in the same column, row 2 (tracks 8..15) wins — that
  // matches the user's example "P[2,3] hold → ch11" and also gives the
  // right fallback for the common case of the user rolling their
  // thumb from a row-1 pad up to a row-2 pad without fully releasing.
  const heldPadInColumn = (col: number): number | null => {
    const row2 = col + 8
    if (state.heldPads.has(row2)) return row2
    if (state.heldPads.has(col)) return col
    return null
  }

  return {
    state,
    setModifier,
    markConsumed,
    activePadModifier,
    setPadHold,
    heldPadInColumn,
    markPadConsumed,
    markAllHeldPadsConsumed,
    isPadTap,
    effectivePadView,
  }
}
