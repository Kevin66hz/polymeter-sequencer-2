// Web Audio look-ahead scheduler.
//
// Design rule (critical): the scheduler (tick/sched) NEVER writes to Vue
// reactive state directly. Every reactive mutation is deferred via
// setTimeout(..., 0). The consumer (pages/index.vue) passes an `applyFnRef`
// that is refreshed on every render so the scheduler always calls the latest
// closure without re-subscribing.
//
// Step resolution: all tracks run on a fixed 16th-note grid. A bar of n/d
// therefore occupies `round(n * 16 / d)` steps. For standard meters (d ∈
// {4,8,16}) this is exact; for bridge meters with exotic denominators
// (e.g. 5/6, 7/12) we round to the nearest 16th so every step remains an
// integer on the same clock. This is intentional — "weird meters welcome"
// but they all ride the 16th-note tick.

export type Pending = { timeSig: string }

export type Track = {
  id: number
  name: string
  timeSig: string          // e.g. "4/4", "7/8", "5/6" (bridge)
  mode: 'instant' | 'transition'
  color: string
  // `steps` is what the scheduler plays and what the UI renders — length
  // always == stepCount(n,d) for the current timeSig.
  steps: boolean[]
  // `stepsSource` is the canonical, never-truncated master pattern.
  // Its length is max(everStepsLengthSeen). When the meter shrinks we slice
  // `steps` from the head of source but leave source intact, so expanding
  // back restores the original tail. When the meter grows past source, we
  // tile source to fill and the grown result becomes the new source.
  stepsSource: boolean[]
  mute: boolean
  solo: boolean
  midiChannel: number      // 1..16
  midiNote: number         // 0..127
}

// Always on the 16th-note grid.  n/d of bar → round(n*16/d) steps.
// Numerator 0 is the "drop" marker: a silent bar of standard 16-step length
// regardless of denominator. This gives `0/d` a predictable shape as a
// reservable silence in transition queues.
export const stepCount = (n: number, d: number) => {
  if (n === 0) return 16
  return Math.max(1, Math.round((n * 16) / d))
}

// Constant 16th-note duration — the whole app rides one clock.
export const stepDur = (bpm: number) => 60 / bpm / 4

export const autoPreset = (n: number, d: number) => {
  const cnt = stepCount(n, d)
  // Drop bar (n=0): full silence.
  if (n === 0) return Array(cnt).fill(false) as boolean[]
  const arr = Array(cnt).fill(false) as boolean[]
  // Beat length in 16ths — round so exotic denominators still get sensible
  // downbeats.  Never less than 1.
  const beat = Math.max(1, Math.round(16 / d))
  for (let i = 0; i < cnt; i += beat) arr[i] = true
  return arr
}

// Resize a step array to `newLen` via tiling. Shorter target → truncation;
// longer target → head of pattern loops back to fill the tail. Empty input
// falls back to autoPreset so new/cleared tracks still have a skeleton.
export const resizeSteps = (
  old: boolean[],
  newLen: number,
  n: number,
  d: number,
): boolean[] => {
  const anyOn = old.some(Boolean)
  if (!anyOn) return autoPreset(n, d)
  const out = Array<boolean>(newLen)
  const oldLen = old.length
  for (let i = 0; i < newLen; i++) out[i] = old[i % oldLen]
  return out
}

// Derive both the visible `steps` and the updated canonical `stepsSource`
// from an existing source for a new length.
//
// Tail-extension policy (the "3-way compromise"): when newLen > source.length
// we have to fill indices [source.length, newLen). Three extremes all fail:
//   · Tile blindly           → 1-step sources become machine-gun 連打
//   · Silence-pad             → unexpected dropouts mid-phrase
//   · Pure beat-skeleton      → dense tracks get reduced to head-only feel
// So we switch based on source shape:
//   · short  (source.length < beat) OR dense (≥50% hits) → beat-skeleton:
//     the new-meter's downbeat grid (hit every `16/d` 16ths). Prevents
//     degenerate tiling while still keeping the groove alive.
//   · otherwise (sparse enough, long enough) → tile source cyclically into
//     the tail. This is the natural continuation — a 4-step pattern tiled
//     to 16 steps sounds like the same 4-step pattern played 4×.
// The grown array becomes the new canonical, so toggling in the tail is
// persisted across later shrinks/expansions.
export const deriveStepsFromSource = (
  source: boolean[],
  newLen: number,
  n: number,
  d: number,
): { steps: boolean[]; stepsSource: boolean[] } => {
  if (n === 0) {
    // Drop: silent bar, source untouched so we can return to the groove.
    return { steps: Array(newLen).fill(false) as boolean[], stepsSource: source }
  }
  const hits = source.reduce((a, b) => a + (b ? 1 : 0), 0)
  if (hits === 0) {
    const preset = autoPreset(n, d)
    return { steps: preset, stepsSource: preset.slice() }
  }
  if (newLen <= source.length) {
    return { steps: source.slice(0, newLen), stepsSource: source }
  }
  // Grow. Preserve existing groove in [0, source.length). Pick tail fill
  // based on source shape.
  const out = Array<boolean>(newLen).fill(false)
  for (let i = 0; i < source.length; i++) out[i] = source[i]

  const beat = Math.max(1, Math.round(16 / d))
  const density = hits / source.length
  const tooShort = source.length < beat
  const tooDense = density >= 0.5

  if (tooShort || tooDense) {
    // Beat-skeleton tail: downbeats only, aligned to absolute indices so
    // the extension continues the new meter's grid.
    for (let i = source.length; i < newLen; i++) {
      if (i % beat === 0) out[i] = true
    }
  } else {
    // Tile tail: cyclic continuation of the source groove. Feels like the
    // user's pattern "played twice" into the new length.
    for (let i = source.length; i < newLen; i++) {
      out[i] = source[i % source.length]
    }
  }
  return { steps: out, stepsSource: out.slice() }
}

export const applyPending = (trk: Track, p: Pending): Track => {
  const sig = p.timeSig
  const [n, d] = sig.split('/').map(Number)
  const newLen = stepCount(n, d)
  const { steps, stepsSource } = deriveStepsFromSource(trk.stepsSource, newLen, n, d)
  return { ...trk, timeSig: sig, steps, stepsSource }
}

// ── Bridge helpers ──────────────────────────────────────
// Allowed denominators for interpolated bridge bars. 4/6/8/12/16 covers
// common triplet/duplet halfway points without going wild.
const BRIDGE_DENOMS = [4, 6, 8, 12, 16] as const

// Pick a (n,d) that best approximates the linear interpolation between two
// meters at position t ∈ (0,1). We interpolate the *duration* (n/d) and then
// search for the (n,d) pair closest to that duration, preferring denominators
// in BRIDGE_DENOMS.  n is clamped to 1..16.
export const bridgeMeter = (
  fromN: number, fromD: number,
  toN: number, toD: number,
  t: number,
): { n: number; d: number } => {
  const target = (fromN / fromD) * (1 - t) + (toN / toD) * t
  let best = { n: toN, d: toD, err: Infinity }
  for (const d of BRIDGE_DENOMS) {
    const nIdeal = target * d
    const nRound = Math.max(1, Math.min(16, Math.round(nIdeal)))
    const err = Math.abs(nRound / d - target)
    if (err < best.err) best = { n: nRound, d, err }
  }
  return { n: best.n, d: best.d }
}

// Generate a transition queue: `bars` intermediate bars + the final target.
// bars=0 → [toSig] (instant-ish, single change).
// bars=1 → [bridge at t=0.5, toSig]
// bars=2 → [bridge at t≈.33, bridge at t≈.66, toSig]
export const generateBridge = (
  fromSig: string,
  toSig: string,
  bars: number,
): Pending[] => {
  const [fN, fD] = fromSig.split('/').map(Number)
  const [tN, tD] = toSig.split('/').map(Number)
  const out: Pending[] = []
  for (let i = 1; i <= bars; i++) {
    const t = i / (bars + 1)
    const m = bridgeMeter(fN, fD, tN, tD, t)
    out.push({ timeSig: `${m.n}/${m.d}` })
  }
  out.push({ timeSig: toSig })
  return out
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
  // Per-track PENDING QUEUE. Each loop-end shifts one Pending off the queue
  // and applies it. Empty queue = no change scheduled.
  pendingRaw: { current: Pending[][] }
  displayHeads: { current: number[] }
  // applyFnRef.current is replaced every render with the latest state setter.
  // Called after each pending shift so reactive state stays in sync with the
  // raw mirror.
  applyFnRef: { current: ((id: number, p: Pending) => void) | null }
  // midiFireRef.current is called alongside audio trigger for each firing step.
  // Also refreshed every render so the scheduler always sees the latest
  // MIDI device + per-track ch/note without re-subscribing.
  midiFireRef: { current: ((id: number) => void) | null }
  // audioEnabledRef.current === false silences the internal Web Audio engine.
  // MIDI out continues. Polled on each fire — toggling is immediate.
  audioEnabledRef: { current: boolean }
  // Master reset target: when non-null, the scheduler watches for all tracks
  // to have drained their pending queues AND matched this signature. Once
  // satisfied, a reset is armed, and fires on track 0's next loop boundary.
  // The consumer clears this by setting .current = null inside onMasterReset.
  masterTargetRef: { current: string | null }
  onHeadsTick: (heads: number[]) => void
  // Fires once when track 0 crosses a loop boundary AND the master target
  // condition has been met. Consumer should: autoPreset all tracks, panic
  // MIDI, trigger visual flash, and clear masterTargetRef.
  onMasterReset: () => void
}

export function createScheduler(deps: SchedulerDeps) {
  const {
    bpmRaw, tracksRaw, pendingRaw, displayHeads,
    applyFnRef, midiFireRef, audioEnabledRef,
    masterTargetRef, onHeadsTick, onMasterReset,
  } = deps

  let ctx: AudioContext | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null
  let rafId: number | null = null
  let trackState: { step: number; nextTime: number }[] = []
  let running = false
  // Armed when the master target has been reached. The actual reset fires
  // at track 0's next loop boundary so the flash lands on a musical downbeat.
  let masterResetArmed = false

  const sched = (id: number, si: number, time: number) => {
    const trk = tracksRaw.current[id]
    if (!trk) return
    const anySolo = tracksRaw.current.some((t) => t.solo)
    const ok = !trk.mute && (!anySolo || trk.solo) && trk.steps[si]
    const ms = Math.max(0, (time - (ctx?.currentTime ?? 0)) * 1000)
    setTimeout(() => {
      if (!running || !ctx) return
      displayHeads.current[id] = si
      if (ok) {
        // Internal audio can be muted independently of MIDI (e.g. when the
        // user is driving external gear and doesn't want the browser to
        // double-trigger, or to save CPU).
        if (audioEnabledRef.current) triggerSound(ctx, id)
        // Fire MIDI note — the consumer callback handles ch/note lookup and
        // schedules the matching note-off. Kept inside this setTimeout so it
        // stays OFF the reactive path.
        midiFireRef.current?.(id)
      }
    }, ms)
  }

  // Check whether the master-target condition is satisfied: all tracks'
  // pending queues are empty AND every track's timeSig matches the target.
  const checkMasterTarget = () => {
    const target = masterTargetRef.current
    if (!target) return false
    for (let i = 0; i < 8; i++) {
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

    for (let i = 0; i < 8; i++) {
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

        // ループ末尾
        if (nextStep === 0) {
          // 1) apply next pending from this track's queue, if any
          const q = pendingRaw.current[i]
          if (q && q.length > 0) {
            const p = q.shift()!
            tracksRaw.current[i] = applyPending(tracksRaw.current[i], p)
            const id_ = i, p_ = p
            // NEVER mutate reactive state inside tick — defer.
            setTimeout(() => { applyFnRef.current?.(id_, p_) }, 0)
          }

          // 2) if master target condition is now met, arm the reset
          if (!masterResetArmed && checkMasterTarget()) {
            masterResetArmed = true
          }

          // 3) track 0's loop boundary is the sync point for master reset
          if (i === 0 && masterResetArmed) {
            masterResetArmed = false
            // Align all tracks to step 0 on this boundary time so the reset
            // is audibly tight. nextTime for track 0 was just advanced, so
            // use that as the shared downbeat.
            const downbeat = trackState[0].nextTime
            for (let j = 0; j < 8; j++) {
              trackState[j].step = 0
              trackState[j].nextTime = downbeat
            }
            setTimeout(() => { onMasterReset() }, 0)
          }
        }
      }
    }
  }

  // RAF runs at ~60fps but heads only change at step boundaries (a handful of
  // Hz at typical BPM). Skip the reactive write on unchanged frames to avoid
  // re-rendering all step cells 60 times per second.
  let lastSent: number[] = Array(8).fill(-1)
  const rafLoop = () => {
    if (!running) return
    const cur = displayHeads.current
    let changed = false
    for (let i = 0; i < 8; i++) {
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
    displayHeads.current = Array(8).fill(0)
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
    displayHeads.current = Array(8).fill(-1)
    onHeadsTick(Array(8).fill(-1))
  }

  const dispose = () => {
    stop()
    if (ctx) { ctx.close().catch(() => {}); ctx = null }
  }

  return { play, stop, dispose, isRunning: () => running }
}
