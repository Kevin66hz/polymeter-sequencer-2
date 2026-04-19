// Web Audio look-ahead scheduler — framework-agnostic.
//
// Critical design rule: the scheduler NEVER touches Vue reactivity. Every
// outbound update uses setTimeout(..., 0) to hop out of the audio-adjacent
// hot path. The consumer passes ref-like objects ({ current: T }) so that
// state is read without triggering Vue dep tracking.
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
  midiFireRef: { current: ((id: number) => void) | null }
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
  let intervalId: ReturnType<typeof setInterval> | null = null
  let rafId: number | null = null
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
    if (!tracksRaw.current[id]) return
    const ms = Math.max(0, (time - (ctx?.currentTime ?? 0)) * 1000)
    setTimeout(() => {
      if (!running) return
      displayHeads.current[id] = si
      // ミュート / ソロ / ステップ有効チェックを発火時点で再評価する。
      // スケジュール時に ok を確定すると最大ルックアヘッド (150ms) 遅れで
      // ミュートが反映されるため、ここで tracksRaw.current を再読みする。
      // tracksRaw はプレーン JS オブジェクトなので Vue リアクティビティは
      // 踏まない — hot path への影響はない。
      const trk = tracksRaw.current[id]
      if (!trk) return
      const anySolo = tracksRaw.current.some((t) => t.solo)
      const ok = !trk.mute && (!anySolo || trk.solo) && trk.steps[si]
      if (ok) {
        if (audioEnabledRef.current && ctx) audio.trigger(ctx, id)
        midiFireRef.current?.(id)
      }
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
    const ah = 0.15

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

  const play = () => {
    if (running) return
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') ctx.resume()
    const now = ctx.currentTime
    trackState = tracksRaw.current.map(() => ({ step: 0, nextTime: now + 0.05, repeatLoopStart: null }))
    displayHeads.current = Array(TRACK_COUNT).fill(0)
    masterResetArmed = false
    running = true
    intervalId = setInterval(tick, 25)
    rafId = requestAnimationFrame(rafLoop)
  }

  const stop = () => {
    running = false
    if (intervalId) clearInterval(intervalId)
    if (rafId) cancelAnimationFrame(rafId)
    intervalId = null
    rafId = null
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
