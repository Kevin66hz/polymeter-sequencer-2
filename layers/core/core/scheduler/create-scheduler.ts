// Web Audio look-ahead scheduler — framework-agnostic.
//
// Critical design rule: the scheduler NEVER touches Vue reactivity. Every
// outbound update uses setTimeout(..., 0) to hop out of the audio-adjacent
// hot path. The consumer passes ref-like objects ({ current: T }) so that
// state is read without triggering Vue dep tracking.
//
// Timer isolation: the 25ms interval that drives tick() runs inside a
// dedicated Web Worker (timer-worker.ts). Main-thread setInterval is
// susceptible to throttling when the browser is busy with Vue re-renders,
// GC pauses or layout — moving the timer off-thread means the tick message
// arrives as soon as the main thread is free, keeping the look-ahead
// window intact even under UI load.
//
// AudioContext stays on the main thread (Workers have no access to it).
// The Worker only sends a pulse; tick() still executes here.
//
// Plugin hook (minimal, not yet wired into sched() — see Phase 6):
//   plugins?: SequencerPlugin[]
// When present, the scheduler will run `transform(events, ctx)` on each
// active-step event. Until then, behaviour is identical to the pre-split
// version.

import { TRACK_COUNT, type Track, type Pending, type SequencerPlugin } from '#core/types'
import { stepDur } from '#core/pure/meter'
import { applyPending } from '#core/pure/pending'
import { defaultAudioAdapter, type AudioAdapter } from '#core/adapters/audio'

// External-clock phase reference. Mirrored from midiIn.state each time an
// F8 pulse / 0xFA start is received. The scheduler reads this in tick() to
// drive the phase corrector (see applyPhaseCorrection). Lives outside Vue
// reactivity on purpose — writes happen at ~48Hz and we don't want any
// render effects depending on it.
export type ClockSyncSnapshot = {
  syncMode: 'internal' | 'external'
  // F8 pulses since last 0xFA (Start). Continue (0xFB) doesn't reset it.
  pulseCount: number
  // perf.now() timestamp of most recent F8 pulse.
  lastPulsePerfTime: number
  // perf.now() timestamp of most recent 0xFA (Start).
  startPerfTime: number
}

export type SchedulerDeps = {
  bpmRaw: { current: number }
  tracksRaw: { current: Track[] }
  pendingRaw: { current: Pending[][] }
  displayHeads: { current: number[] }
  applyFnRef: { current: ((id: number, p: Pending) => void) | null }
  // External-clock phase tracker. When syncMode==='external' the scheduler
  // periodically compares the master's actual pulse phase against its own
  // predicted step boundary and corrects trackState[*].nextTime. In
  // internal mode this is just ignored.
  clockSyncRaw?: { current: ClockSyncSnapshot }
  // midiFireRef: called with (id, audioTime, perfTime) — audioTime is the
  // scheduler's AudioContext-clock time for the step (seconds); perfTime
  // is the same instant translated to the performance.now() clock (ms)
  // so the MIDI path can hand it straight to MIDIOutput.send().
  midiFireRef: { current: ((id: number, audioTime: number, perfTime: number) => void) | null }
  audioEnabledRef: { current: boolean }
  masterTargetRef: { current: string | null }
  onHeadsTick: (heads: number[]) => void
  onMasterReset: () => void
  // Optional: cumulative startup nudge (ms). Applied once on each play()
  // right after the initial nextTime anchor is set, so a user-tuned MIDI
  // output offset persists across play/stop cycles and survives page
  // reload (the store persists it to localStorage). Live nudges during
  // playback go through the returned `nudge()` method.
  startupNudgeMsRef?: { current: number }
  // Optional: beat-repeat. While `repeatOnRef.current` is true, the
  // trigger step loops inside a `repeatStepsRef.current`-long window
  // (aligned to that length) while the real playhead keeps advancing
  // silently underneath. Toggling off snaps the trigger back to the
  // real playhead — DJ-style beat roll.
  repeatOnRef?: { current: boolean }
  repeatStepsRef?: { current: number }
  // Optional: swap in a different audio engine (sampled, FM, whatever).
  audioAdapter?: AudioAdapter
  // Optional: plugin array (synchronous transform hook). Reserved for Phase 6.
  plugins?: SequencerPlugin[]
}

export function createScheduler(deps: SchedulerDeps) {
  const {
    bpmRaw, tracksRaw, pendingRaw, displayHeads,
    applyFnRef, midiFireRef, audioEnabledRef,
    masterTargetRef, onHeadsTick, onMasterReset,
  } = deps
  const audio = deps.audioAdapter ?? defaultAudioAdapter

  let ctx: AudioContext | null = null
  // Timer Worker — runs setInterval off the main thread so Vue reactive
  // updates / GC pauses don't coalesce ticks. Falls back to plain
  // setInterval when Workers are unavailable (SSR, test env, old browser).
  let timerWorker: Worker | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null
  let rafId: number | null = null

  // ── Clock bridging (AudioContext time ↔ performance.now() time) ─────
  // AudioContext.currentTime is seconds on the audio clock; MIDIOutput.send
  // expects a DOMHighResTimeStamp in milliseconds on the performance.now()
  // clock. We bridge the two once, then cache the offset:
  //
  //   offsetMs = performanceTime - contextTime * 1000
  //   perfMs(audioSec) = audioSec * 1000 + offsetMs
  //
  // getOutputTimestamp() is the only API that samples both clocks
  // atomically. We refresh the offset every OFFSET_RESAMPLE_MS to catch
  // drift between the audio and perf clocks on long sessions.
  let ctxPerfOffsetMs = 0
  let lastOffsetSampleAt = 0
  const OFFSET_RESAMPLE_MS = 1000

  const refreshClockOffset = () => {
    if (!ctx || typeof (ctx as any).getOutputTimestamp !== 'function') return
    try {
      const ts = (ctx as any).getOutputTimestamp()
      if (typeof ts?.contextTime === 'number' && typeof ts?.performanceTime === 'number') {
        // Guard against stale samples taken before the audio context has
        // actually started rendering. `ctx.resume()` is async, so a
        // sample immediately after play() would return contextTime = 0
        // and yield offsetMs = performanceTime (huge, bogus). Skip those
        // — the caller will retry on the next tick once ctx is warm.
        if (ts.contextTime <= 0) return
        ctxPerfOffsetMs = ts.performanceTime - ts.contextTime * 1000
        lastOffsetSampleAt = performance.now()
      }
    } catch { /* ignore — fall back to stale offset */ }
  }

  const ctxTimeToPerfMs = (audioSec: number): number => {
    const now = performance.now()
    if (now - lastOffsetSampleAt > OFFSET_RESAMPLE_MS) refreshClockOffset()
    return audioSec * 1000 + ctxPerfOffsetMs
  }
  // `step` is the REAL playhead — it always advances one step per tick
  // regardless of beat-repeat. `repeatLoopStart` is the origin of the
  // trigger-side loop while REP is on; null means "mirror the real
  // playhead" (REP off or not yet engaged).
  let trackState: {
    step: number
    nextTime: number
    repeatLoopStart: number | null
  }[] = []
  let running = false
  let masterResetArmed = false
  // `play()` is synchronous but `ctx.resume()` isn't. Deferring nextTime
  // init and the first getOutputTimestamp() sample to the first tick
  // where `ctx.state === 'running'` avoids two startup bugs:
  //   1. Bogus offsetMs (sampled while contextTime = 0) would fire MIDI
  //      notes ~performanceTime ms in the future, i.e. ~now, while audio
  //      still has to wait for ctx.resume() → MIDI ahead, audio late.
  //   2. nextTime = ctx.currentTime + 0.05 computed pre-resume is anchored
  //      to a clock that hasn't advanced; by the time it does, nextTime
  //      is already in the past and we fire-immediately on the first tick.
  let ticksInitialized = false

  // ── Phase corrector (external clock) ─────────────────
  // Closes the ctx.resume()-induced startup offset AND any slow drift.
  //   - HARD snap: one-shot, ~2 bars after Start. Clamp ±500ms — enough
  //     for any plausible ctx.resume() latency.
  //   - SOFT nudge: periodic every 1 bar, 20% of error, clamp ±10ms.
  //
  // Correction is FULL PHASE, not modulo-wrapped. The prior version
  // wrapped into [-dur/2, +dur/2) which aligned the seq to the NEAREST
  // step boundary — fine when startup offset < dur/2, but for offsets
  // larger than half a step (common on ctx.resume()) it locked onto
  // the WRONG step, producing a 1-step pattern shift that sounded OK
  // at ~110 BPM (where a step lag is inaudible on symmetric patterns)
  // and increasingly wrong at other tempi.
  //
  // Full-phase formula, robust across BPM changes:
  //
  //     seqStepAtMasterIdx = nextTime_perf + (masterStepIdx − stepsAdvanced)·durMs
  //     correction         = masterPerfMs − seqStepAtMasterIdx
  //
  // The formula references the CURRENT nextTime and the current durMs,
  // so a BPM change mid-song doesn't break the calculation — we're
  // just asking "given where seq is now and the current tempo, where
  // does it predict pulse P's step to be, and where did master actually
  // put it?". No accumulated-history term to drift.
  const INITIAL_SNAP_PULSES = 192   // 2 bars at 24 PPQN × 4 beats
  const SOFT_NUDGE_PULSES = 96      // 1 bar
  const HARD_CLAMP_MS = 500
  const SOFT_CLAMP_MS = 10
  const SOFT_STRENGTH = 0.2
  let initialPhaseDone = false
  let lastCorrectionPulse = 0
  // Track 0's total step fires since play(). NOT reduced mod track.length
  // — logical step counter for the phase corrector. Bumped in tick()'s
  // inner loop right after `trackState[0].nextTime += dur`, so at any
  // moment `nextTime` points to the (stepsAdvanced)-th step (0-indexed).
  let stepsAdvanced = 0

  const applyPhaseCorrection = (
    masterPerfMs: number,
    pulseCount: number,
    mode: 'hard' | 'soft',
  ) => {
    if (!ticksInitialized || !ctx || ctx.state !== 'running') return
    if (trackState.length === 0) return
    const durMs = stepDur(bpmRaw.current) * 1000
    if (durMs <= 0) return
    // Step index that master's current pulse corresponds to. Pulse P is
    // at master's (P/6)-th 16th-note boundary; exact ratio preserves
    // sub-step phase info if tick() catches pulseCount mid-step.
    const masterStepIdx = pulseCount / 6
    // Seq's nextTime refers to the (stepsAdvanced)-th step. Project
    // backwards/forwards by (masterStepIdx - stepsAdvanced) steps to
    // find where seq predicts master's current step to fire.
    const nextTimePerfMs = trackState[0].nextTime * 1000 + ctxPerfOffsetMs
    const seqStepAtMasterIdxPerfMs =
      nextTimePerfMs + (masterStepIdx - stepsAdvanced) * durMs
    // Full phase error. Sign: error > 0 means master's pulse is LATER
    // than seq's predicted step for that index → seq is EARLY → delay.
    let corrMs = masterPerfMs - seqStepAtMasterIdxPerfMs
    const strength = mode === 'hard' ? 1.0 : SOFT_STRENGTH
    const clampMs = mode === 'hard' ? HARD_CLAMP_MS : SOFT_CLAMP_MS
    corrMs = corrMs * strength
    if (corrMs > clampMs) corrMs = clampMs
    if (corrMs < -clampMs) corrMs = -clampMs
    const corrSec = corrMs / 1000
    for (let i = 0; i < trackState.length; i++) {
      trackState[i].nextTime += corrSec
    }
  }

  // Manual nudge. Shifts all tracks' nextTime by `ms` (±). Used by the
  // UI NUDGE buttons to let the user hand-dial any residual MIDI-output
  // latency vs Digitakt's internal trigger path. Additive — successive
  // nudges stack. Safe to call before ticksInitialized (it simply shifts
  // the placeholder 0s — first real anchor in tick() will reset them).
  const nudge = (ms: number) => {
    if (!Number.isFinite(ms) || ms === 0) return
    const sec = ms / 1000
    for (let i = 0; i < trackState.length; i++) {
      trackState[i].nextTime += sec
    }
  }

  // Given the real step, the loop origin, the requested loop length and
  // the track length, return which step should actually TRIGGER. When
  // REP is off this function is not called — we trigger the real step
  // directly. When REP is on, the formula maps the monotonically-
  // advancing real step into a cyclic window [loopStart, loopStart +
  // effLen) where effLen clamps to the track length. That way polymeter
  // tracks shorter than the requested loop still produce a sane loop.
  const computeTriggerStep = (
    realStep: number,
    loopStart: number,
    loopLen: number,
    trackLen: number,
  ): number => {
    const effLen = Math.max(1, Math.min(loopLen, trackLen - loopStart))
    let offset = realStep - loopStart
    if (offset < 0) offset += trackLen
    return loopStart + (offset % effLen)
  }

  const sched = (id: number, si: number, time: number) => {
    const trk = tracksRaw.current[id]
    if (!trk) return
    const anySolo = tracksRaw.current.some((t) => t.solo)
    const ok = !trk.mute && (!anySolo || trk.solo) && trk.steps[si]

    // Audio + MIDI paths are scheduled on their NATIVE clocks, not via
    // setTimeout. Main-thread jitter (GC, Vue re-renders, layout) is
    // therefore out of the note-timing loop entirely — that is the core
    // win of this refactor for external hardware (Digitakt, etc.) over
    // long sessions.
    //
    //   audio.trigger(ctx, id, time)     — Web Audio renders at `time`.
    //   midiFireRef(id, time, perfMs)    — OS MIDI queue fires at perfMs.
    //
    // displayHeads is the only surviving setTimeout hop: the visual
    // playhead doesn't need ±1ms precision, and the setTimeout lets the
    // UI RAF loop observe a consistent per-tick snapshot instead of a
    // mid-tick race.
    if (ok) {
      if (audioEnabledRef.current && ctx) audio.trigger(ctx, id, time)
      const perfMs = ctxTimeToPerfMs(time)
      midiFireRef.current?.(id, time, perfMs)
    }

    const nowCtx = ctx?.currentTime ?? 0
    const ms = Math.max(0, (time - nowCtx) * 1000)
    setTimeout(() => {
      if (!running) return
      displayHeads.current[id] = si
    }, ms)
  }

  const checkMasterTarget = () => {
    const target = masterTargetRef.current
    if (!target) return false
    for (let i = 0; i < TRACK_COUNT; i++) {
      const q = pendingRaw.current[i]
      if (q && q.length > 0) return false
      const trk = tracksRaw.current[i]
      if (!trk || trk.timeSig !== target) return false
    }
    return true
  }

  const tick = () => {
    if (!running || !ctx) return
    // Wait until the context has actually resumed. Chrome on macOS can
    // take 100-300ms between `ctx.resume()` returning (it's async) and
    // the audio thread actually starting to render. During that window
    // `ctx.currentTime` stays at 0 and `getOutputTimestamp()` returns
    // zeroes — useless for scheduling. Ticks that arrive in that window
    // just no-op; the Worker's 25ms interval keeps polling.
    if (ctx.state !== 'running') return
    // First running tick: anchor nextTime to the freshly-rendered clock
    // and take the initial offset sample. Doing this here (not in play())
    // guarantees contextTime > 0 and that the offset reflects the real
    // audio clock, so the very first MIDI note lines up with the very
    // first audio note.
    if (!ticksInitialized) {
      refreshClockOffset()
      const start = ctx.currentTime + 0.05
      for (let i = 0; i < trackState.length; i++) {
        trackState[i].nextTime = start
      }
      // Apply persisted startup nudge (user's saved MIDI-output offset).
      // Reading at this point — AFTER the anchor — means the next tick
      // sees the offset baked into nextTime and fires accordingly.
      const startupNudgeMs = deps.startupNudgeMsRef?.current ?? 0
      if (startupNudgeMs !== 0) {
        const startupNudgeSec = startupNudgeMs / 1000
        for (let i = 0; i < trackState.length; i++) {
          trackState[i].nextTime += startupNudgeSec
        }
      }
      ticksInitialized = true
    }
    // Phase corrector — only meaningful under external sync. We read the
    // snapshot directly (no Vue reactivity) and apply a correction to all
    // tracks' nextTime so the master's step-boundary pulse coincides with
    // our step fire. See applyPhaseCorrection for the sign convention.
    const cs = deps.clockSyncRaw?.current
    if (cs && cs.syncMode === 'external' && cs.pulseCount > 0 && cs.lastPulsePerfTime > 0) {
      if (!initialPhaseDone) {
        if (cs.pulseCount >= INITIAL_SNAP_PULSES) {
          applyPhaseCorrection(cs.lastPulsePerfTime, cs.pulseCount, 'hard')
          initialPhaseDone = true
          lastCorrectionPulse = cs.pulseCount
        }
      } else if (cs.pulseCount - lastCorrectionPulse >= SOFT_NUDGE_PULSES) {
        applyPhaseCorrection(cs.lastPulsePerfTime, cs.pulseCount, 'soft')
        lastCorrectionPulse = cs.pulseCount
      }
    }
    const now = ctx.currentTime
    // Look-ahead window: Worker timer reduces tick jitter to ~5-10ms so
    // 100ms provides ample buffer while keeping mute/step-edit latency
    // tighter than the previous 150ms value.
    const ah = 0.10

    // Snapshot REP state at tick start. Reading `.current` directly on
    // every iteration would be fine too; tick boundary is convenient and
    // lets the loop observe the same state for all 16 tracks in one pass.
    const repeatOn = !!deps.repeatOnRef?.current
    const repeatLen = Math.max(1, deps.repeatStepsRef?.current ?? 1)

    for (let i = 0; i < TRACK_COUNT; i++) {
      const trk = tracksRaw.current[i]
      if (!trk) continue
      const dur = stepDur(bpmRaw.current)
      const len = trk.steps.length

      if (trackState[i].step >= len) trackState[i].step = 0

      // REP lifecycle per track: engage by aligning to the rate grid,
      // disengage by clearing so the next sched() fires the real step.
      if (repeatOn && trackState[i].repeatLoopStart == null) {
        const s = trackState[i].step
        trackState[i].repeatLoopStart = s - (s % repeatLen)
      } else if (!repeatOn && trackState[i].repeatLoopStart != null) {
        trackState[i].repeatLoopStart = null
      }

      while (trackState[i].nextTime < now + ah) {
        const realSi = trackState[i].step
        const triggerSi = repeatOn && trackState[i].repeatLoopStart != null
          ? computeTriggerStep(realSi, trackState[i].repeatLoopStart!, repeatLen, len)
          : realSi

        // Fire using the trigger step — that's what the user hears and
        // what the UI highlights. The real step keeps marching below.
        sched(i, triggerSi, trackState[i].nextTime)
        trackState[i].nextTime += dur
        // Track 0 drives the phase corrector's reference frame. After
        // bumping its nextTime, log that we've advanced one more step so
        // the formula "nextTime + (masterStepIdx − stepsAdvanced)·dur"
        // stays coherent with the just-advanced nextTime.
        if (i === 0) stepsAdvanced++

        const nextReal = (realSi + 1) % len
        trackState[i].step = nextReal

        // Bar boundaries / meter-pending / master convergence all key off
        // the REAL playhead — REP is a trigger-only effect and should
        // never block meter transitions from advancing. If we hid these
        // behind triggerSi, a held REP would stall the whole transition
        // machinery, which is exactly not what we want.
        if (nextReal === 0) {
          const q = pendingRaw.current[i]
          if (q && q.length > 0) {
            const p = q.shift()!
            tracksRaw.current[i] = applyPending(tracksRaw.current[i], p)
            const id_ = i, p_ = p
            setTimeout(() => { applyFnRef.current?.(id_, p_) }, 0)
          }

          if (!masterResetArmed && checkMasterTarget()) {
            masterResetArmed = true
          }

          if (i === 0 && masterResetArmed) {
            masterResetArmed = false
            const downbeat = trackState[0].nextTime
            for (let j = 0; j < TRACK_COUNT; j++) {
              trackState[j].step = 0
              trackState[j].nextTime = downbeat
              // Master reset also clears any REP loop origin — the new
              // downbeat starts a fresh alignment on next tick.
              trackState[j].repeatLoopStart = null
            }
            setTimeout(() => { onMasterReset() }, 0)
          }
        }
      }
    }
  }

  let lastSent: number[] = Array(TRACK_COUNT).fill(-1)
  const rafLoop = () => {
    if (!running) return
    const cur = displayHeads.current
    let changed = false
    for (let i = 0; i < TRACK_COUNT; i++) {
      if (cur[i] !== lastSent[i]) { changed = true; break }
    }
    if (changed) {
      lastSent = cur.slice()
      onHeadsTick(lastSent)
    }
    rafId = requestAnimationFrame(rafLoop)
  }

  // Start the off-thread interval timer. Falls back to main-thread
  // setInterval when Workers aren't available (SSR / old browsers).
  const startTimer = () => {
    if (typeof Worker !== 'undefined') {
      try {
        timerWorker = new Worker(
          new URL('./timer-worker.ts', import.meta.url),
          { type: 'module' },
        )
        // Burst deduplication: if the main thread was busy and multiple
        // Worker messages queued up, process only the first one — tick()'s
        // while-loop already catches up to `now + ah` in a single call, so
        // extra back-to-back ticks just add GC pressure without scheduling
        // any additional events.
        let lastTickAt = 0
        timerWorker.onmessage = () => {
          if (!running) return
          const now = performance.now()
          if (now - lastTickAt < 15) return   // skip burst duplicates
          lastTickAt = now
          tick()
        }
        timerWorker.postMessage(25)
        return
      } catch {
        // Worker construction failed — fall through to setInterval.
        timerWorker = null
      }
    }
    intervalId = setInterval(tick, 25)
  }

  const stopTimer = () => {
    if (timerWorker) {
      timerWorker.postMessage(0)   // tell worker to stop
      timerWorker.terminate()
      timerWorker = null
    }
    if (intervalId) { clearInterval(intervalId); intervalId = null }
  }

  const play = () => {
    if (running) return
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') ctx.resume()
    // NOTE: we do NOT sample the clock offset here nor compute nextTime.
    // `ctx.resume()` is async on Chrome/macOS (100-300ms until the audio
    // thread actually renders), so any timing derived from the current
    // ctx here is bogus. The first tick() with `ctx.state === 'running'`
    // does the real init — see `ticksInitialized` above. `nextTime: 0`
    // is a placeholder and never reaches sched() because tick() short-
    // circuits until ctx is warm.
    trackState = tracksRaw.current.map(() => ({ step: 0, nextTime: 0, repeatLoopStart: null }))
    displayHeads.current = Array(TRACK_COUNT).fill(0)
    masterResetArmed = false
    ticksInitialized = false
    initialPhaseDone = false
    lastCorrectionPulse = 0
    stepsAdvanced = 0
    running = true
    startTimer()
    rafId = requestAnimationFrame(rafLoop)
  }

  const stop = () => {
    running = false
    stopTimer()
    if (rafId) { cancelAnimationFrame(rafId); rafId = null }
    masterResetArmed = false
    ticksInitialized = false
    initialPhaseDone = false
    lastCorrectionPulse = 0
    stepsAdvanced = 0
    displayHeads.current = Array(TRACK_COUNT).fill(-1)
    onHeadsTick(Array(TRACK_COUNT).fill(-1))
  }

  const dispose = () => {
    stop()
    if (ctx) { ctx.close().catch(() => {}); ctx = null }
  }

  // External-clock sync, recap:
  //
  // In external mode the scheduler still runs its own internal look-ahead
  // loop — step firing is NOT driven by incoming F8 pulses. Instead:
  //
  //   1. TEMPO: host reflects `midiIn.state.syncBpm` (rolling 24-pulse
  //      average) into `bpmRaw`. tick() consumes it via `stepDur()`.
  //   2. PHASE: host reflects pulse/start timestamps into `clockSyncRaw`.
  //      tick() runs a two-stage PLL against them:
  //        - 1 hard snap at 2 bars (closes ctx.resume() startup gap,
  //          typically ~1 step at 110 BPM)
  //        - Periodic 20% soft nudges every bar thereafter (clamp ±10ms;
  //          remaining error low-passes in over the next ~5 bars)
  //
  // Rationale for not firing per-pulse: Web MIDI input delivers jittery
  // timestamps (the spec does not guarantee an upper delivery latency;
  // see https://github.com/WebAudio/web-midi-api/issues/187). Every known
  // software clock slave (Ableton, Renoise, Max) filters this with a PLL.
  // The filtered syncBpm + softly-corrected free-running scheduler is
  // the same pattern in its simplest form.

  return { play, stop, dispose, nudge, isRunning: () => running }
}
