// Web Audio look-ahead scheduler.
//
// Design rule (critical): the scheduler (tick/sched) NEVER writes to Vue
// reactive state directly. Every reactive mutation is deferred via
// setTimeout(..., 0). The consumer (pages/index.vue) passes an `applyFnRef`
// that is refreshed on every render so the scheduler always calls the latest
// closure without re-subscribing.
//
// Raw (non-reactive) data is held in plain refs:
//   tracksRaw: Track[]          — snapshot mirror of reactive tracks
//   pendingRaw: (Pending|null)[] — per-track pending sig/subdiv change
//   displayHeads: number[]      — current step per track, read by RAF loop
//
// The consumer writes into these on every tracks/pending change.

export type Pending = { timeSig?: string; subdiv?: number }

export type Track = {
  id: number
  name: string
  timeSig: string
  subdiv: number
  color: string
  steps: boolean[]
  mute: boolean
  solo: boolean
}

export const stepCount = (n: number, d: number, sub: number) => {
  if (d === 4) return n * (sub === 8 ? 2 : 4)
  if (d === 8) return n * (sub === 8 ? 1 : 2)
  return n
}

export const stepDur = (bpm: number, sub: number) =>
  60 / bpm / (sub === 8 ? 2 : 4)

export const autoPreset = (n: number, d: number, sub: number) => {
  const cnt = stepCount(n, d, sub)
  const arr = Array(cnt).fill(false) as boolean[]
  const beat = d === 4 ? (sub === 8 ? 2 : 4) : (sub === 8 ? 1 : 2)
  for (let i = 0; i < cnt; i += beat) arr[i] = true
  return arr
}

// Resize a step array to `newLen` while preserving the existing pattern:
//   - If the old pattern is entirely empty, fall back to autoPreset so new
//     tracks still get a sensible beat skeleton.
//   - Otherwise tile the old pattern via modulo. Shorter target → truncation;
//     longer target → the head of the pattern loops back to fill the tail.
// This makes a time-sig change feel like a re-phrasing of the existing groove
// rather than a reset.
export const resizeSteps = (
  old: boolean[],
  newLen: number,
  n: number,
  d: number,
  sub: number,
): boolean[] => {
  const anyOn = old.some(Boolean)
  if (!anyOn) return autoPreset(n, d, sub)
  const out = Array<boolean>(newLen)
  const oldLen = old.length
  for (let i = 0; i < newLen; i++) out[i] = old[i % oldLen]
  return out
}

export const applyPending = (trk: Track, p: Pending): Track => {
  const sig = p.timeSig ?? trk.timeSig
  const sub = p.subdiv ?? trk.subdiv
  const [n, d] = sig.split('/').map(Number)
  const newLen = stepCount(n, d, sub)
  const steps = resizeSteps(trk.steps, newLen, n, d, sub)
  return { ...trk, timeSig: sig, subdiv: sub, steps }
}

// ── サウンドエンジン ─────────────────────────────────────
export function triggerSound(ctx: AudioContext, id: number) {
  const t = ctx.currentTime + 0.002
  const master = ctx.createGain()
  master.connect(ctx.destination)

  if (id === 0) {
    const o = ctx.createOscillator(); o.connect(master)
    o.frequency.setValueAtTime(160, t)
    o.frequency.exponentialRampToValueAtTime(0.01, t + 0.28)
    master.gain.setValueAtTime(1.0, t)
    master.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    o.start(t); o.stop(t + 0.28)
  } else if (id === 1) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    const s = ctx.createBufferSource(); s.buffer = buf
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200
    const o = ctx.createOscillator(); o.frequency.value = 180
    const og = ctx.createGain()
    s.connect(f); f.connect(master)
    o.connect(og); og.connect(master)
    master.gain.setValueAtTime(0.7, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
    og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    s.start(t); s.stop(t + 0.2)
    o.start(t); o.stop(t + 0.08)
  } else if (id === 2) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    const s = ctx.createBufferSource(); s.buffer = buf
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 8000
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.5, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
    s.start(t); s.stop(t + 0.1)
  } else if (id === 3) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length)
    const s = ctx.createBufferSource(); s.buffer = buf
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 0.5
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.6, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
    s.start(t); s.stop(t + 0.15)
  } else {
    const freqs = [55, 220, 110, 330]
    const o = ctx.createOscillator()
    o.type = id === 5 ? 'sawtooth' : id === 6 ? 'triangle' : 'square'
    o.frequency.value = freqs[id - 4] ?? 110
    o.connect(master)
    const dur = id === 6 ? 0.4 : 0.15
    master.gain.setValueAtTime(0.4, t)
    master.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.start(t); o.stop(t + dur)
  }
}

// ── スケジューラ本体 ────────────────────────────────────
// Caller provides raw (non-reactive) data refs + an applyFnRef. The applyFnRef
// MUST be reassigned on every parent render — the scheduler always reads
// .current, so the latest closure wins without re-subscribing.
export type SchedulerDeps = {
  bpmRaw: { current: number }
  tracksRaw: { current: Track[] }
  pendingRaw: { current: (Pending | null)[] }
  displayHeads: { current: number[] }
  // applyFnRef.current is replaced every render with the latest state setter.
  applyFnRef: { current: ((id: number, p: Pending) => void) | null }
  onHeadsTick: (heads: number[]) => void
}

export function createScheduler(deps: SchedulerDeps) {
  const { bpmRaw, tracksRaw, pendingRaw, displayHeads, applyFnRef, onHeadsTick } = deps

  let ctx: AudioContext | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null
  let rafId: number | null = null
  let trackState: { step: number; nextTime: number }[] = []
  let running = false

  const sched = (id: number, si: number, time: number) => {
    const trk = tracksRaw.current[id]
    if (!trk) return
    const anySolo = tracksRaw.current.some((t) => t.solo)
    const ok = !trk.mute && (!anySolo || trk.solo) && trk.steps[si]
    const ms = Math.max(0, (time - (ctx?.currentTime ?? 0)) * 1000)
    setTimeout(() => {
      if (!running || !ctx) return
      displayHeads.current[id] = si
      if (ok) triggerSound(ctx, id)
    }, ms)
  }

  const tick = () => {
    if (!running || !ctx) return
    const now = ctx.currentTime
    const ah = 0.1

    for (let i = 0; i < 8; i++) {
      const trk = tracksRaw.current[i]
      if (!trk) continue
      const dur = stepDur(bpmRaw.current, trk.subdiv)
      const len = trk.steps.length

      if (trackState[i].step >= len) trackState[i].step = 0

      while (trackState[i].nextTime < now + ah) {
        const si = trackState[i].step
        sched(i, si, trackState[i].nextTime)
        trackState[i].nextTime += dur

        const nextStep = (si + 1) % len
        trackState[i].step = nextStep

        // ループ末尾で pending を反映
        if (nextStep === 0 && pendingRaw.current[i]) {
          const p = pendingRaw.current[i]!
          pendingRaw.current[i] = null
          tracksRaw.current[i] = applyPending(tracksRaw.current[i], p)
          const id_ = i, p_ = p
          // NEVER mutate reactive state inside tick — defer.
          setTimeout(() => { applyFnRef.current?.(id_, p_) }, 0)
        }
      }
    }
  }

  const rafLoop = () => {
    if (!running) return
    onHeadsTick([...displayHeads.current])
    rafId = requestAnimationFrame(rafLoop)
  }

  const play = () => {
    if (running) return
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') ctx.resume()
    const now = ctx.currentTime
    trackState = tracksRaw.current.map(() => ({ step: 0, nextTime: now + 0.05 }))
    displayHeads.current = Array(8).fill(0)
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
    displayHeads.current = Array(8).fill(-1)
    onHeadsTick(Array(8).fill(-1))
  }

  const dispose = () => {
    stop()
    if (ctx) { ctx.close().catch(() => {}); ctx = null }
  }

  return { play, stop, dispose, isRunning: () => running }
}
