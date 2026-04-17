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
  let trackState: { step: number; nextTime: number }[] = []
  let running = false
  let masterResetArmed = false

  const sched = (id: number, si: number, time: number) => {
    const trk = tracksRaw.current[id]
    if (!trk) return
    const anySolo = tracksRaw.current.some((t) => t.solo)
    const ok = !trk.mute && (!anySolo || trk.solo) && trk.steps[si]
    const ms = Math.max(0, (time - (ctx?.currentTime ?? 0)) * 1000)
    setTimeout(() => {
      if (!running) return
      displayHeads.current[id] = si
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
    const ah = 0.1

    for (let i = 0; i < TRACK_COUNT; i++) {
      const trk = tracksRaw.current[i]
      if (!trk) continue
      const dur = stepDur(bpmRaw.current)
      const len = trk.steps.length

      if (trackState[i].step >= len) trackState[i].step = 0

      while (trackState[i].nextTime < now + ah) {
        const si = trackState[i].step
        sched(i, si, trackState[i].nextTime)
        trackState[i].nextTime += dur

        const nextStep = (si + 1) % len
        trackState[i].step = nextStep

        if (nextStep === 0) {
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
    trackState = tracksRaw.current.map(() => ({ step: 0, nextTime: now + 0.05 }))
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
