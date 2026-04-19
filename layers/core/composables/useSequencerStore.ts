// Sequencer store — the single reactive brain shared between all UI variants.
//
// Extracted verbatim from pages/index.vue (pre-split). No behavior changes in
// this commit; this is purely a relocation. Callers (pages/index.vue for Type2,
// apps/type2-plus/pages/index.vue later) use the returned refs and methods
// directly and remain thin views.
//
// Design rule preserved from the original:
//   - The scheduler NEVER touches Vue reactivity. We keep `{ current: T }`
//     plain mirrors and sync them via `watch` on the reactive side.
//   - MIDI fire / applyPending callbacks are closures that read the mirrors,
//     so the hot loop never walks reactive deps.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { stepCount, parseSig, deriveStepsFromSource } from '#core/pure/meter'
import { applyPending } from '#core/pure/pending'
import { generateBridge } from '#core/pure/bridge'
import { createScheduler } from '#core/scheduler/create-scheduler'
import { TRACK_COUNT, type Pending, type Track } from '#core/types'
import { useMidi } from './useMidi'
import { useLaunchControlFeedback } from './useLaunchControlFeedback'
import { useMidiIn } from './useMidiIn'
import { useMidiModifiers } from './useMidiModifiers'
import { useMidiPresets } from './useMidiPresets'
// MPC-style note-repeat: deprecated in favor of scheduler-level beat-
// repeat (see scheduler/create-scheduler.ts). Kept commented so we can
// re-enable the timer-driven path if live overdub needs it back.
// import { useNoteRepeat, type NoteRepeatRate } from './useNoteRepeat'
type NoteRepeatRate = 2 | 4 | 6 | 8 | 12 | 16 | 24 | 32

// ── Factory defaults (Type2 lineage) ──────────────────────────────────
// These defaults carry the Type2 initial state. Plus reuses them as-is;
// future UI variants may pass custom seeds via `useSequencerStore({ seed })`
// once that overload is added.

export const NUM_OPTS = Array.from({ length: 17 }, (_, i) => i)
export const DEN_OPTS = [4, 8, 16] as const

const INIT_SIGS = [
  '4/4','7/8','9/8','5/4','3/4','11/8','6/8','13/8',
  '4/4','5/8','7/4','3/8','4/4','7/8','5/4','6/4',
]
const NAMES = [
  'KICK','SNARE','HAT','CLAP','BASS','LEAD','PAD','PERC',
  'K2','S2','HH2','CL2','B2','LD2','PD2','PC2',
]
const COLS = [
  '#e05050','#e09030','#40b0d0','#c060c0',
  '#50c080','#6080e0','#e06080','#80c040',
  '#e07060','#60d0b0','#b060e0','#d0a040',
  '#40c0c0','#e04080','#90e060','#8060d0',
]
const INIT: boolean[][] = [
  [true,false,false,false,true,false,false,false,true,false,false,false,true,false,false,false],
  [false,false,false,false,true,false,false,false,false,false,false,false,true,false,false,false],
  [true,false,true,false,true,false,true,false,true,false,true,false,true,false,true,false],
  [false,false,false,false,false,false,false,true,false,false,false,false,false,false,false,false],
  [true,false,false,true,false,false,true,false,false,false,false,false,false,false,false,false],
  [true,false,false,false,false,false,true,false,false,false,false,false,false,false,false,false],
  [true,false,false,false,true,false,false,false,false,false,false,false,false,false,false,false],
  [false,false,true,false,false,false,false,true,false,false,true,false,false,false,false,false],
  [true,false,false,false,false,false,true,false,true,false,false,false,false,false,false,false],
  [false,false,false,true,false,false,false,false,false,false,false,false,false,false,false,false],
  [true,false,false,true,false,false,true,false,false,true,false,false,true,false,false,false],
  [false,false,true,false,false,false,false,false,false,false,false,false,false,false,false,false],
  [true,false,true,false,false,true,false,false,true,false,false,false,true,false,false,false],
  [false,false,false,true,false,false,false,false,false,false,false,false,false,false,false,false],
  [true,false,false,false,false,false,false,false,true,false,false,false,false,false,false,false],
  [false,true,false,false,false,true,false,false,false,false,true,false,false,false,false,false],
]

function mkTrk(id: number): Track {
  const sig = INIT_SIGS[id] ?? '4/4'
  const [n, d] = sig.split('/').map(Number)
  const cnt = stepCount(n, d)
  const pat = INIT[id] ?? INIT[id % 4] ?? []
  const steps = Array(cnt).fill(false).map((_, i) => !!pat[i])
  return {
    id, name: NAMES[id] ?? `CH${id+1}`, timeSig: sig,
    mode: 'instant', color: COLS[id] ?? '#888',
    steps, stepsSource: steps.slice(),
    mute: false, solo: false,
    midiChannel: (id % 16) + 1, midiNote: 60,
    midiVelocity: 100, gateMs: 80,
  }
}

// ── Snapshot type (user-saved full pattern + meter per track) ─────────
export type TrackSnapshot = { steps: boolean[]; stepsSource: boolean[]; timeSig: string }

// ──────────────────────────────────────────────────────────────────────
// useSequencerStore — call once per page. Owns all sequencer state and
// the scheduler lifecycle tied to the calling component.
// ──────────────────────────────────────────────────────────────────────

export function useSequencerStore() {
  // ── Reactive state ──────────────────────────────────────────────────
  const bpm = ref(120)
  const playing = ref(false)
  const tracks = ref<Track[]>(Array.from({ length: TRACK_COUNT }, (_, i) => mkTrk(i)))
  const heads = ref<number[]>(Array(TRACK_COUNT).fill(-1))
  const pendQ = ref<Pending[][]>(Array.from({ length: TRACK_COUNT }, () => []))
  const selectedId = ref<number>(-1)
  const detailId = ref<number | null>(null)
  const audioOn = ref(true)

  const masterNum = ref(4)
  const masterDen = ref<4 | 8 | 16>(4)
  const masterMode = ref<'instant' | 'transition'>('instant')
  const masterBridgeBars = ref<1 | 2>(1)
  const masterTarget = ref<string | null>(null)
  const flash = ref(false)

  // Per-track staged time-sig targets. Populated when a track knob moves
  // during playback in 'transition' mode — the target is held here
  // (NOT queued to pendQ) so nothing audibly changes until the user
  // presses master_apply. This mirrors how masterNum/masterDen work in
  // master 'transition' mode: they update live but only commit on the
  // explicit apply trigger. See `commitTrackSig` and `commitMaster`.
  const trackTargets = ref<(string | null)[]>(Array(TRACK_COUNT).fill(null))

  const savedSnapshot = ref<TrackSnapshot[] | null>(null)
  const showMapping = ref(false)
  // REC mode — when on AND playing, incoming unmapped MIDI notes matching
  // a track's (midiChannel, midiNote) write at that track's currently-
  // playing step. Off by default so MIDI IN never silently mutates
  // patterns.
  const recording = ref(false)
  // Beat-repeat — while enabled, the scheduler loops the trigger step
  // within a `round(16/repeatRate)`-step window while the real playhead
  // continues to advance silently. Toggling off snaps trigger back to
  // real. repeatRate = note-denominator: 4 → 1/4-note loop, 16 → 1/16,
  // etc.
  const repeatOn = ref(false)
  const repeatRate = ref<NoteRepeatRate>(16)

  // Closure-local (not reactive): pattern snapshot used by master reset.
  let masterStepsSnapshot: boolean[][] | null = null

  // ── Raw mirrors (scheduler reads these, never the refs directly) ────
  const bpmRaw = { current: bpm.value }
  const tracksRaw = { current: tracks.value.map(t => ({ ...t, steps: [...t.steps] })) }
  const pendingRaw = { current: Array.from({ length: TRACK_COUNT }, () => [] as Pending[]) }
  const displayHeads = { current: Array(TRACK_COUNT).fill(-1) as number[] }
  const masterTargetRef = { current: null as string | null }
  const audioEnabledRef = { current: true }
  // Beat-repeat mirrors (scheduler reads these each tick; no dep tracking).
  const repeatOnRaw = { current: false }
  const repeatStepsRaw = { current: 1 }  // loop length in 16th-note steps
  const computeRepeatSteps = (rate: number) => Math.max(1, Math.round(16 / rate))
  repeatStepsRaw.current = computeRepeatSteps(repeatRate.value)

  const applyFnRef: { current: ((id: number, p: Pending) => void) | null } = { current: null }
  applyFnRef.current = (id, p) => {
    tracks.value = tracks.value.map(t => t.id !== id ? t : applyPending(t, p))
    pendQ.value = pendQ.value.map((q, i) => i === id ? q.slice(1) : q)
  }

  // ── MIDI (out) ──────────────────────────────────────────────────────
  const midi = useMidi()
  const midiFireRef: { current: ((id: number) => void) | null } = { current: null }
  midiFireRef.current = (id) => {
    // Multi-OUT: gate on the array length — send* internally broadcasts to
    // every selected device, so we only need to ensure at least one is up.
    if (!midi.selectedIds.value.length) return
    const trk = tracksRaw.current[id]; if (!trk) return
    midi.sendNoteOn(trk.midiChannel, trk.midiNote, trk.midiVelocity ?? 100)
    setTimeout(() => midi.sendNoteOff(trk.midiChannel, trk.midiNote), trk.gateMs ?? 80)
  }

  // ── MIDI (in) ───────────────────────────────────────────────────────
  // Core REC writer. Toggle semantics: second hit at the same head
  // clears the step (self-correcting overdub).
  //
  // `toggleTrackStepAtHead` is the shared primitive — given a track
  // index, it writes (or clears) the step under the current playhead.
  // Both the MIDI IN path (`recordNote`, matched by ch/note) and the
  // in-UI pad button (`recordStepAtHead`, matched by track id directly)
  // delegate to it so we have a single source of truth for toggle
  // semantics. See cowork-prompt.md Task B.
  function toggleTrackStepAtHead(trackIndex: number): boolean {
    if (!recording.value || !playing.value) return false
    if (trackIndex < 0 || trackIndex >= tracks.value.length) return false
    const t = tracks.value[trackIndex]
    if (!t) return false
    const head = heads.value[trackIndex]
    if (head < 0 || head >= t.steps.length) return false
    const wasOn = !!(t.steps[head] && t.stepsSource[head])
    const on = !wasOn
    if (wasOn === on) return false
    const newSteps = t.steps.slice(); newSteps[head] = on
    const newSource = t.stepsSource.slice(); newSource[head] = on
    tracks.value = tracks.value.map((tr, i) => i === trackIndex
      ? { ...tr, steps: newSteps, stepsSource: newSource }
      : tr)
    return true
  }

  function recordNote(channel: number, note: number) {
    if (!recording.value || !playing.value) return
    // Preserve the original multi-match behavior: if several tracks
    // share the same (ch, note) tuple (rare, but possible when the
    // user manually aligns them), a single incoming note toggles the
    // step on every matching track.
    for (let i = 0; i < tracks.value.length; i++) {
      const t = tracks.value[i]
      if (t.midiChannel === channel && t.midiNote === note) {
        toggleTrackStepAtHead(i)
      }
    }
  }

  // Public per-track trigger — used by the in-app record pads that
  // appear in each track row when REC is armed. Track id == array
  // index by construction (see mkTrk), so we can pass straight through.
  function recordStepAtHead(trackId: number) {
    toggleTrackStepAtHead(trackId)
  }

  // (Previous MPC-style note-repeat engine was wired here — preserved in
  // useNoteRepeat.ts. Replaced by scheduler-level beat-repeat below.)
  // const repeat = useNoteRepeat({ ... })

  // ── MIDI mapping dispatch helpers ──────────────────────────────────
  // Kept close to the useMidiIn() hook so the dispatch rules live next to
  // the MAPPABLE_CONTROLS definition they mirror.
  //
  // Continuous knobs (N / D / BPM) map raw 0-127 → an option-list index
  // quantized to the same step resolution the knob would produce if
  // turned by hand. Momentary buttons (MUTE, SOLO, CLEAR, APPLY, etc.)
  // fire when raw > 63 so the same binding works for any reasonable
  // controller pad behavior (press=127 / release=0). Toggle semantics
  // (MUTE / SOLO / transport_toggle / …) flip state on press; the
  // controller's own release message at value 0 is ignored because it
  // fails the > 63 gate.
  const CC_PRESS_THRESHOLD = 63
  const DEN_RANGE = [4, 8, 16] as const
  // Numeric denominators (NOT strings). The pages render `1/{{ repeatRate }}`
  // so the template prepends the "1/" — if we stored strings like '1/4'
  // here, MIDI-driven updates would render as "1/1/4". Keep this aligned
  // with REPEAT_RATES defined in apps/type2/pages/index.vue.
  const REPEAT_RATES = [2, 4, 8, 16] as const
  // Given `controlId` and a suffix like `_mute`, if the id is of the form
  // `track<N><suffix>` with N in 0..15, return the track index; else null.
  const parseTrackControl = (controlId: string, suffix: string): number | null => {
    const prefix = 'track'
    if (!controlId.startsWith(prefix) || !controlId.endsWith(suffix)) return null
    const mid = controlId.slice(prefix.length, controlId.length - suffix.length)
    const n = Number.parseInt(mid, 10)
    if (!Number.isInteger(n) || n < 0 || n >= TRACK_COUNT || String(n) !== mid) return null
    return n
  }
  // Continuous 0-127 → N index. N is 1..16 (zero-N would yield zero-step
  // tracks which the scheduler can't animate). Mirror of the Master knob
  // handler, except clamped away from 0.
  const rawToN = (raw: number) => Math.max(1, Math.min(16, Math.round((raw / 127) * 16)))
  // 0-127 → D option. Tri-split matches the 3-position Master D knob.
  const rawToD = (raw: number) => DEN_RANGE[raw < 43 ? 0 : raw < 85 ? 1 : 2]

  // ── Modifier keys (D / M / S / R) ──────────────────
  // Instantiated before useMidiIn so the midiIn callback can call into
  // `midiModifiers.setModifier` without a forward-reference dance. The
  // tap handlers run here (not inside useMidiModifiers) so the store is
  // the single source of truth for what each modifier *does*.
  const midiModifiers = useMidiModifiers({
    // M tap / S tap just switch the pad LED view mode for future LED
    // feedback. The composable already writes `padView` before calling
    // these hooks so there's nothing else to do here — they're kept as
    // no-ops to document the tap/release path.
    onMTap: () => { /* padView = 'mute' (set inside composable) */ },
    onSTap: () => { /* padView = 'solo' (set inside composable) */ },
    onRTap: () => { recording.value = !recording.value },
    // D + M chord → ALL MUTE. Fires exactly once on the down edge of M
    // while D is already held, and the composable suppresses both M's
    // own tap action and D's tap interpretation on release.
    onDMChord: () => { toggleAllMute() },
  })

  const midiIn = useMidiIn({
    onPlay: () => { if (!playing.value) play() },
    onStop: () => { if (playing.value) stop() },
    onModifierChange: (id, on) => { midiModifiers.setModifier(id, on) },
    onCCMapped: (controlId, rawValue) => {
      // ── Transport / BPM ─────────────────────────────
      if (controlId === 'bpm') { bpm.value = Math.round(rawValue * 2 + 40); return }
      if (controlId === 'transport_toggle' && rawValue > CC_PRESS_THRESHOLD) {
        playing.value ? stop() : play()
        return
      }
      if (controlId === 'rec_toggle' && rawValue > CC_PRESS_THRESHOLD) {
        recording.value = !recording.value
        return
      }

      // ── Master meter ────────────────────────────────
      if (controlId === 'masterN') { masterNum.value = Math.round((rawValue / 127) * 16); onMasterKnobChange(); return }
      if (controlId === 'masterD') { masterDen.value = rawToD(rawValue); onMasterKnobChange(); return }
      if (controlId === 'master_apply' && rawValue > CC_PRESS_THRESHOLD) { commitMaster(); return }
      if (controlId === 'master_mode_toggle') {
        // Continuous 2-way split. 0-63 → instant, 64-127 → transition.
        // Was previously a press-threshold toggle, but that meant a
        // knob-bound controller (K[1,3] on LC XL MK2) would flip state
        // on every small motion past the threshold. The continuous
        // form mirrors how masterD / bpm behave — the knob position
        // *is* the setting, not an edge trigger.
        masterMode.value = rawValue < 64 ? 'instant' : 'transition'
        return
      }
      if (controlId === 'bridge_length') {
        // Continuous 2-way split. 0-63 → 1 bar, 64-127 → 2 bars.
        // Same reasoning as master_mode_toggle: knob position drives
        // the value directly.
        masterBridgeBars.value = rawValue < 64 ? 1 : 2
        return
      }

      // ── Global performance ──────────────────────────
      if (controlId === 'repeat_trigger') {
        // Momentary: press = ON, release = OFF. The LC XL MK2 SS2 button
        // at CC 105 sends 127 on press and 0 on release, giving classic
        // push-to-glitch behaviour. Any Learn-bound controller that emits
        // a 0/non-zero pulse (sustain pedal, rewritten pad note, etc.)
        // works the same way. Latching toggles that only send one message
        // per flip still function — non-zero flips ON, zero flips OFF —
        // they just won't auto-release without a second message.
        repeatOn.value = rawValue > 0
        return
      }
      if (controlId === 'repeat_length') {
        // Continuous 0-127 → one of four rates (K[1,8] knob on LC XL MK2).
        // Quarter-split so the knob feels like a 4-position switch.
        const q = rawValue < 32 ? 0 : rawValue < 64 ? 1 : rawValue < 96 ? 2 : 3
        repeatRate.value = REPEAT_RATES[q]
        return
      }
      if (controlId === 'all_mute' && rawValue > CC_PRESS_THRESHOLD) { toggleAllMute(); return }
      if (controlId === 'snapshot_save' && rawValue > CC_PRESS_THRESHOLD) {
        // D + snapshot_save → Snapshot Delete. On the LC XL MK2 the
        // snapshot_save binding currently lives on SS1 (CC 104) — the
        // top-left right-nav button. Holding D rewrites the action to
        // clearSnapshot so the same button double-duties. Recall lives
        // on a separate binding (snapshot_recall → TS2 / CC 107).
        if (midiModifiers.state.d) {
          midiModifiers.markConsumed('d')
          clearSnapshot()
        } else {
          saveSnapshot()
        }
        return
      }
      if (controlId === 'snapshot_recall' && rawValue > CC_PRESS_THRESHOLD) { recallSnapshot(); return }
      if (controlId === 'snapshot_delete' && rawValue > CC_PRESS_THRESHOLD) { clearSnapshot(); return }

      // ── Per-track ───────────────────────────────────
      // Continuous knobs: when D is held, a bound `trackN_n` CC is
      // redirected to that track's D knob instead. Mirrors the LC XL
      // MK2 preset spec where K[2,*]/K[3,*] double as N (default) or
      // D (D held). Unidirectional: `trackN_d` bindings are always D.
      {
        const i = parseTrackControl(controlId, '_n')
        if (i !== null) {
          if (midiModifiers.state.d) {
            midiModifiers.markConsumed('d')
            setTrackDen(i, rawToD(rawValue))
          } else {
            setTrackNum(i, rawToN(rawValue))
          }
          return
        }
      }
      {
        const i = parseTrackControl(controlId, '_d')
        if (i !== null) { setTrackDen(i, rawToD(rawValue)); return }
      }
      // Continuous per-track gate (direct bind). `trackN_gate` is what
      // Learn / preset JSON targets when the user wants a fader pinned
      // to one track's gate. Linear 0..127 → 10..500ms. The column-
      // modal variant (F[4,c] follows whichever pad in column c is
      // held) is handled further down via `fader_col${c}`.
      {
        const i = parseTrackControl(controlId, '_gate')
        if (i !== null) { setTrackGate(i, Math.round(10 + (rawValue / 127) * 490)); return }
      }
      // Per-track pad release (rawValue=0 arrives via useMidiIn's note-
      // off forwarding). Always clears the pad-hold flag so the fader-
      // gate column routing reflects live hardware state. Must run
      // before the press-gated block so pad release doesn't fall through.
      //
      // Also: fires the deferred padView tap action here. In MUTE/SOLO
      // view a pad press no longer toggles mute/solo on press — we wait
      // until release and only fire if the press was a short tap that
      // wasn't "consumed" by a fader-column gate edit in the same hold.
      // This lets the user hold a pad + move its column fader without
      // the pad spuriously toggling mute/solo on press.
      {
        const rec = parseTrackControl(controlId, '_rec')
        if (rec !== null && rawValue === 0) {
          const wasTap = midiModifiers.isPadTap(rec)
          const mod = midiModifiers.activePadModifier()
          // Only the padView-driven action is deferred — modifier-held
          // actions (D/M/S holds) and REC step-record still fire on
          // press. So release fires mute/solo only when no modifier is
          // held AND REC is off AND the press qualified as a tap.
          if (wasTap && mod === null && !recording.value) {
            if (midiModifiers.state.padView === 'mute') doMute(rec)
            else if (midiModifiers.state.padView === 'solo') doSolo(rec)
          }
          midiModifiers.setPadHold(rec, false)
          return
        }
      }
      // ── Fader-column → held pad's gate ──────────────
      // `fader_col${c}` (c=0..7) is the LC XL MK2 preset's binding for
      // F[4,c] (CC 77..84). It acts ONLY when:
      //   1. No M/S/D/R modifier is held (those take the pad into
      //      mute/solo/clear territory per the priority table).
      //   2. REC is off (when REC is on, the pad is a step-record
      //      button — existing Task B behaviour).
      //   3. Some pad in column `c` is currently held (row 2 wins over
      //      row 1 if both are held — see heldPadInColumn).
      // When any condition fails the fader message is silently
      // ignored, which matches the spec's "通常時はフェーダー操作は
      // 無視" wording. 0..127 → 10..500ms linear, same as the direct
      // trackN_gate bind so behaviour is consistent.
      if (controlId.startsWith('fader_col')) {
        const col = Number.parseInt(controlId.slice('fader_col'.length), 10)
        if (!Number.isInteger(col) || col < 0 || col > 7) return
        if (midiModifiers.activePadModifier() !== null) return
        if (recording.value) return
        const trk = midiModifiers.heldPadInColumn(col)
        if (trk === null) return
        // Mark the pad as consumed so the release-side padView action
        // (mute/solo toggle) does NOT fire. Touching a fader during a
        // pad hold is a clear "I'm adjusting gate, don't flip mute"
        // signal.
        midiModifiers.markPadConsumed(trk)
        setTrackGate(trk, Math.round(10 + (rawValue / 127) * 490))
        return
      }
      if (rawValue > CC_PRESS_THRESHOLD) {
        // Press-gated per-track triggers.
        const mute  = parseTrackControl(controlId, '_mute')
        if (mute  !== null) { doMute(mute);   return }
        const solo  = parseTrackControl(controlId, '_solo')
        if (solo  !== null) { doSolo(solo);   return }
        const clr   = parseTrackControl(controlId, '_clear')
        if (clr   !== null) { doClr(clr);     return }
        const rec   = parseTrackControl(controlId, '_rec')
        if (rec   !== null) {
          // Modifier-aware pad routing (LC XL MK2 preset §パッド挙動):
          //   D held    → sequence CLEAR that track
          //   M held    → MUTE toggle
          //   S held    → SOLO toggle
          //   REC on    → step record at playhead
          //   padView=mute → MUTE toggle (pad acts as the matching row's
          //                  MUTE button while MUTE view is active)
          //   padView=solo → SOLO toggle (same, in SOLO view)
          //
          // Priority mirrors the spec (modifier > REC > view). The view
          // mode is driven by taps on M / S (see useMidiModifiers), so a
          // quick tap on M switches every pad into "press = mute" — this
          // matches how Novation / Ableton hardware row-select works and
          // is what the user expects when they "enter MUTE view".
          //
          // pad-hold tracking is registered unconditionally so the
          // fader-gate column routing still works during a pad hold
          // regardless of which action fired on press. That is: in
          // MUTE view the press toggles mute and, while the finger
          // stays on the pad, the same-column fader still edits gate.
          const mod = midiModifiers.activePadModifier()
          midiModifiers.setPadHold(rec, true)
          if (mod === 'd')      { midiModifiers.markConsumed('d'); midiModifiers.markPadConsumed(rec); doClr(rec) }
          else if (mod === 'm') { midiModifiers.markConsumed('m'); midiModifiers.markPadConsumed(rec); doMute(rec) }
          else if (mod === 's') { midiModifiers.markConsumed('s'); midiModifiers.markPadConsumed(rec); doSolo(rec) }
          else if (recording.value) { midiModifiers.markPadConsumed(rec); recordStepAtHead(rec) }
          // padView-driven mute/solo is DEFERRED to release (see pad-
          // release handler above). Firing on release lets the same
          // pad press double as "start a pad+fader gate-adjust" — the
          // fader marks the hold consumed so mute/solo is skipped.
          return
        }
      }
    },
    // Manual pad press: toggle-record the corresponding step.
    onNoteIn: (channel, note, _velocity) => {
      recordNote(channel, note)
    },
    // onNoteOff is available but not wired; beat-repeat is scheduler-
    // driven and doesn't care about pad release.
  })

  // External clock → BPM sync.
  // syncMode ガードは不要 — handleClock が既に syncMode==='external' のときのみ
  // syncBpm を更新するため、ウォッチャー側で再チェックすると競合状態になる
  // (syncBpm 変更後 / ウォッチャー実行前に syncMode が切り替わると更新が抜ける)。
  watch(() => midiIn.state.syncBpm, v => {
    if (v !== null) { bpmRaw.current = v; bpm.value = v }
  })

  // ── Reactive → raw mirror sync ──────────────────────────────────────
  // 全ミューテーションが .map() による参照差し替えパターンなので shallow watch で
  // 確実に検知できる。deep: true を使うと Vue が全オブジェクトをトラバースして
  // メインスレッドをブロックし setInterval(tick, 25) が遅延する。
  //
  // さらに「変更されたトラック / キューだけ」差し替える per-entry diff を行う。
  // doMute / doSolo などは .map() で変更トラック以外の参照を保持するので、
  // curr[i] !== prev[i] のエントリのみ新オブジェクトを生成することで
  // MUTE/SOLO 連打や N 連続変更時のオブジェクト生成コストを 1/16 に削減する。
  watch(audioOn, v => { audioEnabledRef.current = v })
  watch(bpm, v => { bpmRaw.current = v })
  watch(tracks, (curr, prev) => {
    const next = tracksRaw.current.slice()
    for (let i = 0; i < curr.length; i++) {
      if (!prev || curr[i] !== prev[i]) {
        next[i] = { ...curr[i], steps: [...curr[i].steps] }
      }
    }
    tracksRaw.current = next
  })
  watch(pendQ, (curr, prev) => {
    const next = pendingRaw.current.slice()
    for (let i = 0; i < curr.length; i++) {
      if (!prev || curr[i] !== prev[i]) {
        next[i] = curr[i].map(p => ({ ...p }))
      }
    }
    pendingRaw.current = next
  })
  watch(masterTarget, v => { masterTargetRef.current = v })
  watch(repeatOn, v => { repeatOnRaw.current = v })
  watch(repeatRate, v => { repeatStepsRaw.current = computeRepeatSteps(v) })

  // Effective pad-view MODE including the special 'rec' case. Recording
  // mode turns the pads into a playhead visualiser: each pad pulses
  // amber when its track's head advances to a new step. M/S hold still
  // wins (momentary override) so the user can mute/solo-check without
  // leaving recording mode. Precedence: M/S hold > recording > padView.
  // Kept here (not in useLaunchControlFeedback) because the UI also
  // reads this value independently of LED state.
  const effectivePadViewMode = computed<'rec' | 'mute' | 'solo'>(() => {
    if (midiModifiers.state.m) return 'mute'
    if (midiModifiers.state.s) return 'solo'
    if (recording.value) return 'rec'
    return midiModifiers.state.padView
  })

  // ── Launch Control XL MK2 LED feedback ──────────────────────────────
  // All controller-specific LED logic (pad colours, modifier button LEDs,
  // REC blink timer) is encapsulated in this composable. Cleanup on
  // unmount (timer cancel + LED clear) is handled internally.
  useLaunchControlFeedback({
    tracks, heads, recording, repeatOn, savedSnapshot,
    effectivePadViewMode, midi, midiIn, midiModifiers,
  })


  // ── Scheduler lifecycle ─────────────────────────────────────────────
  let scheduler: ReturnType<typeof createScheduler> | null = null

  function handleMasterReset() {
    flash.value = true
    setTimeout(() => { flash.value = false }, 260)
    midi.panic()
    const snap = masterStepsSnapshot
    tracks.value = tracks.value.map((t, i) => {
      const [n, d] = parseSig(t.timeSig)
      const base = snap?.[i] ?? t.stepsSource
      const newLen = stepCount(n, d)
      const { steps, stepsSource } = deriveStepsFromSource(base, newLen, n, d)
      return { ...t, steps, stepsSource }
    })
    masterStepsSnapshot = null
    masterTarget.value = null
  }

  // ── MIDI controller templates ──────────────────────
  // Shippable factory mappings under /midi-presets/. The composable
  // auto-detects connected controllers by name and loads the matching
  // template's mapping table — without clobbering the user's current
  // device selection or clock-source routing.
  const midiPresets = useMidiPresets()

  // Small wrapper the UI passes to MidiDeviceMultiSelect so each
  // device row can render a ○ indicator for "has a bundled template".
  const hasMidiPresetForDevice = (deviceName: string | undefined | null) =>
    midiPresets.hasPresetForDevice(deviceName)

  // Manual re-apply hook used by the ○ button in MidiDeviceMultiSelect.
  // Unlike the watcher-driven auto-apply this is idempotent-by-action
  // (runs every time the user clicks) and also clears the "already
  // auto-applied" memo for the device so subsequent reconnects reapply
  // cleanly. Returns true if a template was applied (for a future
  // toast / highlight).
  async function applyMidiPresetForDevice(deviceId: string, deviceName: string | undefined | null): Promise<boolean> {
    const meta = await midiPresets.applyForDeviceName(deviceName, midiIn)
    if (meta) {
      // So auto-apply will re-fire if the user unplugs + replugs.
      midiPresets.forgetAutoApplied(deviceId)
    }
    return meta !== null
  }

  // Drive auto-apply from the reactive input list. We fire for every
  // device we've seen in this session — autoApplyForDevice is
  // idempotent (Set-guarded) so additional watcher fires for the same
  // device id are free. Running on inputs rather than selectedIds is
  // intentional: the template should be in place by the time the user
  // first ticks the device's checkbox, so no pad press is unbound
  // during the race between "MIDI port appeared" and "user picked it".
  watch(
    () => midiIn.state.inputs,
    (inputs) => {
      for (const inp of inputs) {
        // Fire-and-forget. Errors are swallowed inside the composable
        // so a bad preset file can't block other devices.
        midiPresets.autoApplyForDevice(inp.id, inp.name, midiIn).catch(() => {})
      }
    },
    { immediate: true, deep: false },
  )

  onMounted(async () => {
    // Kick off the registry fetch early so the auto-apply watcher has
    // an index by the time the first MIDI port callback lands. Await
    // is cheap (single small JSON) and keeps the first-connect path
    // deterministic.
    midiPresets.loadIndex().catch(() => {})
    await midiIn.init()
    scheduler = createScheduler({
      bpmRaw, tracksRaw, pendingRaw, displayHeads,
      applyFnRef, midiFireRef, audioEnabledRef, masterTargetRef,
      repeatOnRef: repeatOnRaw,
      repeatStepsRef: repeatStepsRaw,
      onHeadsTick: h => { heads.value = h },
      onMasterReset: () => handleMasterReset(),
    })
  })

  onBeforeUnmount(() => {
    scheduler?.dispose()
    midi.panic()
    // Cancel any pending per-track knob-debounce commits so a late
    // setTimeout can't write to store refs after the view is gone.
    clearAllTrackCommitTimers()
    // LED timer cancellation and clearFeedback() are handled by
    // useLaunchControlFeedback's own onBeforeUnmount hook.
  })

  // ── Transport ───────────────────────────────────────────────────────
  function play() { if (playing.value) return; playing.value = true; scheduler?.play() }
  function stop() {
    playing.value = false
    scheduler?.stop()
    midi.panic()
    // If the user stopped transport while a knob-debounce was still
    // armed, the staged target would otherwise fire after the fact
    // (harmlessly — the !playing branch in flushTrackCommit applies
    // it offline — but visually confusing). Flush immediately so the
    // UI matches what the user just dialled in.
    for (let i = 0; i < TRACK_COUNT; i++) {
      if (trackCommitTimers[i]) {
        clearTrackCommitTimer(i)
        flushTrackCommit(i)
      }
    }
  }

  // ── Snapshot ────────────────────────────────────────────────────────
  function saveSnapshot() {
    savedSnapshot.value = tracks.value.map(t => ({
      steps: t.steps.slice(),
      stepsSource: t.stepsSource.slice(),
      timeSig: t.timeSig,
    }))
  }

  function recallSnapshot() {
    const snap = savedSnapshot.value; if (!snap) return
    midi.panic()
    // A recall overwrites track time sigs — any debounced knob commit
    // still pending would fire moments later and clobber the recalled
    // state. Drop those before doing the recall.
    clearAllTrackCommitTimers()
    const instant = masterMode.value === 'instant' || !playing.value

    if (instant) {
      tracks.value = tracks.value.map((t, i) => {
        const s = snap[i]; if (!s) return t
        const [n, d] = parseSig(s.timeSig)
        const cnt = stepCount(n, d)
        const steps = Array(cnt).fill(false).map((_, j) => s.steps[j] ?? false)
        return { ...t, timeSig: s.timeSig, steps, stepsSource: s.stepsSource.slice() }
      })
      pendQ.value = pendQ.value.map(() => [])
      // A recall is a hard reset to the stored state — any per-track
      // knob moves the user made after saving shouldn't survive it.
      trackTargets.value = Array(TRACK_COUNT).fill(null)
    } else {
      tracks.value = tracks.value.map((t, i) => {
        const s = snap[i]; if (!s) return t
        if (t.timeSig === s.timeSig) {
          const [n, d] = parseSig(s.timeSig)
          const cnt = stepCount(n, d)
          const steps = Array(cnt).fill(false).map((_, j) => s.steps[j] ?? false)
          return { ...t, steps, stepsSource: s.stepsSource.slice() }
        }
        return { ...t, stepsSource: s.stepsSource.slice() }
      })
      pendQ.value = tracks.value.map((t, i) => {
        const s = snap[i]; if (!s || t.timeSig === s.timeSig) return []
        return generateBridge(t.timeSig, s.timeSig, masterBridgeBars.value)
      })
      // Same rationale as the 'instant' branch above: clear staged
      // targets so a mid-recall knob move doesn't leak across.
      trackTargets.value = Array(TRACK_COUNT).fill(null)
    }
  }

  function clearSnapshot() { savedSnapshot.value = null }

  // ── Per-track meter ─────────────────────────────────────────────────
  // Knob-move semantics during playback: stage while turning, commit on
  // settle. While the user is actively dialling the N/D knobs nothing
  // audibly changes — every fresh message resets a short debounce
  // timer. When the knob goes quiet for TRACK_KNOB_DEBOUNCE_MS the
  // staged target is committed via the normal per-mode path:
  //
  //   mode        action on debounce fire
  //   ----------  -------------------------------------------
  //   instant     single pending queued (applies at next bar)
  //   transition  bridge generated and queued
  //
  // Rationale: the previous immediate-commit behaviour was jarring
  // during live performance because the bridge / pending would start
  // mid-sweep, then get overwritten multiple times as the user kept
  // turning. Debouncing means a single clean commit per gesture.
  // Non-playing moves still apply instantly (destructive / offline
  // edit) so pattern setup remains snappy.
  const TRACK_KNOB_DEBOUNCE_MS = 300
  const trackCommitTimers: (ReturnType<typeof setTimeout> | null)[] =
    Array(TRACK_COUNT).fill(null)

  function clearTrackCommitTimer(id: number) {
    const t = trackCommitTimers[id]
    if (t) { clearTimeout(t); trackCommitTimers[id] = null }
  }
  function clearAllTrackCommitTimers() {
    for (let i = 0; i < trackCommitTimers.length; i++) clearTrackCommitTimer(i)
  }

  function flushTrackCommit(id: number) {
    const target = trackTargets.value[id]
    if (!target) return
    const trk = tracks.value[id]
    if (!trk) {
      trackTargets.value = trackTargets.value.map((x, i) => i === id ? null : x)
      return
    }
    if (!playing.value) {
      // Unlikely (we only schedule while playing), but cover the race
      // where stop() fires between the knob move and the debounce.
      tracks.value = tracks.value.map(t => t.id !== id ? t : applyPending(t, { timeSig: target }))
      pendQ.value = pendQ.value.map((q, i) => i === id ? [] : q)
      trackTargets.value = trackTargets.value.map((x, i) => i === id ? null : x)
      return
    }
    const queue = trk.mode === 'transition'
      ? generateBridge(trk.timeSig, target, 1)
      : [{ timeSig: target }]
    pendQ.value = pendQ.value.map((q, i) => i === id ? queue : q)
    trackTargets.value = trackTargets.value.map((x, i) => i === id ? null : x)
  }

  function scheduleTrackCommit(id: number) {
    clearTrackCommitTimer(id)
    trackCommitTimers[id] = setTimeout(() => {
      trackCommitTimers[id] = null
      flushTrackCommit(id)
    }, TRACK_KNOB_DEBOUNCE_MS)
  }

  function commitTrackSig(id: number, n: number, d: number) {
    const target = `${n}/${d}`
    const trk = tracks.value[id]; if (!trk) return
    if (
      trk.timeSig === target &&
      pendQ.value[id].length === 0 &&
      !trackTargets.value[id]
    ) {
      clearTrackCommitTimer(id)
      return
    }
    if (!playing.value) {
      // Offline edits apply immediately (current behaviour preserved).
      clearTrackCommitTimer(id)
      tracks.value = tracks.value.map(t => t.id !== id ? t : applyPending(t, { timeSig: target }))
      pendQ.value = pendQ.value.map((q, i) => i === id ? [] : q)
      trackTargets.value = trackTargets.value.map((x, i) => i === id ? null : x)
      return
    }
    // Playing: stage and (re)arm debounce. If the user dialled back to
    // the current sig, clear the stage + timer — there's nothing to
    // commit, and any in-flight pending from an earlier commit is also
    // dropped so the UI reflects "no pending change".
    if (trk.timeSig === target) {
      clearTrackCommitTimer(id)
      trackTargets.value = trackTargets.value.map((x, i) => i === id ? null : x)
      pendQ.value = pendQ.value.map((q, i) => i === id ? [] : q)
      return
    }
    trackTargets.value = trackTargets.value.map((x, i) => i === id ? target : x)
    // Drop any stale queue from a previous commit so a racing bridge
    // can't play through the new target window.
    pendQ.value = pendQ.value.map((q, i) => i === id ? [] : q)
    scheduleTrackCommit(id)
  }

  function setTrackNum(id: number, n: number) {
    const [, d] = parseSig(tracks.value[id].timeSig)
    commitTrackSig(id, n, d)
  }
  function setTrackDen(id: number, d: number) {
    const [n] = parseSig(tracks.value[id].timeSig)
    commitTrackSig(id, n, d)
  }
  // Set a track's gate (note length) in milliseconds. Clamped to the
  // usable 10..500ms range the fader mapping produces; values outside
  // that range are valid programmatically but the mapping will never
  // generate them.
  function setTrackGate(id: number, ms: number) {
    const clamped = Math.max(1, Math.round(ms))
    tracks.value = tracks.value.map(t => t.id === id ? { ...t, gateMs: clamped } : t)
  }
  function toggleTrackMode(id: number) {
    tracks.value = tracks.value.map(t =>
      t.id !== id ? t : { ...t, mode: t.mode === 'instant' ? 'transition' : 'instant' },
    )
  }

  // ── Master meter ────────────────────────────────────────────────────
  function onMasterKnobChange() {
    if (masterMode.value === 'instant') commitMaster()
  }

  function commitMaster() {
    const target = `${masterNum.value}/${masterDen.value}`
    masterStepsSnapshot = tracks.value.map(t => [...t.stepsSource])
    // Master override supersedes any per-track knob still mid-debounce:
    // cancel pending timers and clear staged targets so the unified
    // master commit below isn't clobbered moments later by a late-firing
    // per-track debounce.
    clearAllTrackCommitTimers()
    trackTargets.value = Array(TRACK_COUNT).fill(null)
    if (!playing.value) {
      tracks.value = tracks.value.map(t => applyPending(t, { timeSig: target }))
      pendQ.value = pendQ.value.map(() => [])
      masterTarget.value = null
      masterStepsSnapshot = null
      return
    }
    const bars = masterMode.value === 'transition' ? masterBridgeBars.value : 0
    pendQ.value = tracks.value.map(t =>
      bars === 0 ? [{ timeSig: target }] : generateBridge(t.timeSig, target, bars),
    )
    masterTarget.value = target
  }

  // ── Step toggle / mute / solo / clear ───────────────────────────────
  function toggleStep(id: number, si: number) {
    tracks.value = tracks.value.map(t => {
      if (t.id !== id) return t
      const newSteps = t.steps.map((s, i) => i === si ? !s : s)
      const newSource = t.stepsSource.slice(); newSource[si] = newSteps[si]
      return { ...t, steps: newSteps, stepsSource: newSource }
    })
  }
  function doMute(id: number) {
    tracks.value = tracks.value.map(t => t.id === id ? { ...t, mute: !t.mute } : t)
  }
  function doSolo(id: number) {
    tracks.value = tracks.value.map(t => t.id === id ? { ...t, solo: !t.solo } : t)
  }
  function doClr(id: number) {
    tracks.value = tracks.value.map(t => t.id !== id ? t : {
      ...t,
      steps: Array(t.steps.length).fill(false),
      stepsSource: Array(t.stepsSource.length).fill(false),
    })
  }

  // ── Selection / detail panel ────────────────────────────────────────
  function onCircleSelect(id: number) {
    selectedId.value = id
    if (detailId.value !== null) detailId.value = id
  }
  function onBackgroundClick() {
    selectedId.value = -1
    detailId.value = null
  }

  const selTrack = () => tracks.value[selectedId.value]
  const detTrk = () => detailId.value !== null ? (tracks.value[detailId.value] ?? null) : null

  function updSel(patch: Partial<Track>) {
    tracks.value = tracks.value.map((t, i) => i === selectedId.value ? { ...t, ...patch } : t)
  }
  function updDet(patch: Partial<Track>) {
    if (detailId.value === null) return
    const id = detailId.value
    tracks.value = tracks.value.map(t => t.id === id ? { ...t, ...patch } : t)
  }

  function applySel(n: number, d: number, bars: number) {
    const sig = `${n}/${d}`
    const trk = selTrack(); if (!trk) return
    if (!playing.value) {
      tracks.value = tracks.value.map((t, i) => i === selectedId.value ? applyPending(t, { timeSig: sig }) : t)
      return
    }
    const queue = generateBridge(trk.timeSig, sig, bars)
    pendQ.value = pendQ.value.map((q, i) => i === selectedId.value ? [...q, ...queue] : q)
  }

  // ── Track meter helpers (for UI) ────────────────────────────────────
  // `pendingSig(i)` is the single source of truth for "where is track i
  // *heading*": it inspects the queue (if any), then the staged target
  // (if mid-debounce), returning null only when the track is fully at
  // rest. `displaySig` layers a fallback to the committed timeSig so
  // callers that want "what should the UI show right now" get a
  // non-null string. Defining it this way avoids a visual snap-back:
  //
  //   knob move   → trackTargets[i] set, pendQ empty
  //   debounce    → trackTargets[i] cleared, pendQ populated (bridge
  //                 for 'transition', single pending for 'instant')
  //   bar apply   → pendQ drains, tracks[i].timeSig updated
  //
  // Reading only trackTargets would make the number flicker back to
  // the old value the moment the debounce fired, which was the
  // user's complaint ("ステージではなく、今の値になる"). Reading
  // pendingSig keeps the displayed target stable across the entire
  // stage→queue→applied transition.
  function pendingSig(i: number): string | null {
    const q = pendQ.value[i]
    if (q.length > 0) return q[q.length - 1].timeSig
    return trackTargets.value[i] ?? null
  }
  function displaySig(t: Track): string {
    return pendingSig(t.id) ?? t.timeSig
  }
  function trkNum(t: Track) { return parseSig(displaySig(t))[0] }
  function trkDen(t: Track) { return parseSig(displaySig(t))[1] }

  // ── MIDI mapping UI helpers ─────────────────────────────────────────
  function isLearning(id: string) { return midiIn.state.learnControlId === id }
  function toggleLearn(id: string) {
    if (isLearning(id)) midiIn.cancelLearn()
    else midiIn.startLearn(id)
  }
  function bindingLabel(id: string) {
    const m = midiIn.getMappingFor(id)
    if (!m) return '+'
    return `${m.type.toUpperCase()}${m.number} ch${m.channel}`
  }
  function hasBound(id: string) { return !!midiIn.getMappingFor(id) }

  // ── All mute ────────────────────────────────────────────────────────
  // Solo-aware: when any track is soloed, ALL MUTE never touches those
  // tracks. Rationale: SOLO is an explicit "keep audible" flag, so a
  // subsequent ALL MUTE shouldn't silence it. Toggle state reflects
  // "every non-solo track is muted" so the button highlight tracks the
  // user's intent even with solos mixed in.
  const allMuted = computed(() => {
    const pool = tracks.value.filter(t => !t.solo)
    return pool.length > 0 && pool.every(t => t.mute)
  })

  // The pad view label the UI should display right now. Tracks the
  // effective view, so holding M or S on the controller briefly flips
  // this to the corresponding view even when the persisted padView is
  // the other one (release reverts). Unwraps as 'mute' | 'solo'.
  const effectivePadView = computed(() => midiModifiers.effectivePadView())

  // Full three-valued mode, including the 'rec' state when recording
  // is on and no M/S hold is overriding. UI uses this to colour the
  // pad-view badge amber during recording. LED code uses the same
  // signal to decide whether to draw pulses or MUTE/SOLO fill.
  const padViewMode = effectivePadViewMode

  // True while the pads are showing a *temporary* view driven by a
  // modifier hold rather than the persisted padView — i.e. M or S is
  // held. The UI uses this to style the pad-view badge differently
  // (e.g. dimmer border, italic) so the user can tell at a glance that
  // the view will snap back on release.
  const padViewIsTemporary = computed(() =>
    midiModifiers.state.m || midiModifiers.state.s,
  )
  function toggleAllMute() {
    const mute = !allMuted.value
    tracks.value = tracks.value.map(t => ({
      ...t,
      // Soloed tracks are force-audible when engaging ALL MUTE. When
      // disengaging (mute=false), everyone unmutes uniformly.
      mute: t.solo ? (mute ? false : t.mute) : mute,
    }))
  }

  return {
    // constants (factory defaults exposed for template use)
    NUM_OPTS, DEN_OPTS,

    // reactive state
    bpm, playing, tracks, heads, pendQ, selectedId, detailId, audioOn,
    masterNum, masterDen, masterMode, masterBridgeBars, masterTarget, flash,
    trackTargets,
    savedSnapshot, showMapping, recording, repeatOn, repeatRate,

    // composables passed through
    midi, midiIn, midiModifiers,

    // MIDI template registry (auto-apply on device connect, ○ indicator in UI,
    // and manual re-apply button for when the auto-apply window was missed).
    midiPresets, hasMidiPresetForDevice, applyMidiPresetForDevice,

    // transport
    play, stop,

    // snapshot
    saveSnapshot, recallSnapshot, clearSnapshot,

    // per-track meter
    commitTrackSig, setTrackNum, setTrackDen, setTrackGate, toggleTrackMode,

    // master meter
    onMasterKnobChange, commitMaster,

    // step / mute / solo / clear
    toggleStep, doMute, doSolo, doClr,

    // in-app step recording (per-track pad, REC-mode gated)
    recordStepAtHead,

    // selection / detail
    onCircleSelect, onBackgroundClick, selTrack, detTrk, updSel, updDet, applySel,

    // ui helpers
    trkNum, trkDen, pendingSig, displaySig,

    // midi mapping helpers
    isLearning, toggleLearn, bindingLabel, hasBound,

    // all mute
    allMuted, toggleAllMute,

    // pad-view indicator (MUTE / SOLO / REC — shows temporary view during
    // M/S hold, or 'rec' while recording with amber playhead pulses).
    effectivePadView, padViewMode, padViewIsTemporary,

    // raw mirror for RAF loop (Plus variant overlay)
    displayHeads,

    // tracksRaw mirror for RAF loop (Plus variant overlay - geometry access)
    tracksRaw,
  }
}
