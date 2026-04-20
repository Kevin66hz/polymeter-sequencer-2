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

export type SchedulerDeps = {
  bpmRaw: { current: number }
  tracksRaw: { current: Track[] }
  pendingRaw: { current: Pending[][] }
  displayHeads: { current: number[] }
  applyFnRef: { current: ((id: number, p: Pending) => void) | null }
  // midiFireRef: called with (id, audioTime, perfTime) — audioTime is the
  // scheduler's AudioContext-clock time for the step (seconds); perfTime
  // is the same instant translated to the performance.now() clock (ms)
  // so the MIDI path can hand it straight to MIDIOutput.send().
  midiFireRef: { current: ((id: number, audioTime: number, perfTime: number) => void) | null }
  audioEnabledRef: { current: boolean }
  masterTargetRef: { current: string | null }
  onHeadsTick: (heads: number[]) => void
  onMasterReset: () => void
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
    // Prime the clock offset before the first sched() call so the very
    // first MIDI note goes out with an accurate perfTime (rather than
    // offset=0 which would land hundreds of ms in the past and force
    // the OS queue to "fire immediately", defeating the look-ahead).
    refreshClockOffset()
    const now = ctx.currentTime
    trackState = tracksRaw.current.map(() => ({ step: 0, nextTime: now + 0.05, repeatLoopStart: null }))
    displayHeads.current = Array(TRACK_COUNT).fill(0)
    masterResetArmed = false
    running = true
    startTimer()
    rafId = requestAnimationFrame(rafLoop)
  }

  const stop = () => {
    running = false
    stopTimer()
    if (rafId) { cancelAnimationFrame(rafId); rafId = null }
    masterResetArmed = false
    displayHeads.current = Array(TRACK_COUNT).fill(-1)
    onHeadsTick(Array(TRACK_COUNT).fill(-1))
  }

  const dispose = () => {
    stop()
    if (ctx) { ctx.close().catch(() => {}); ctx = null }
  }

  return { play, stop, dispose, isRunning: () => running }
}
