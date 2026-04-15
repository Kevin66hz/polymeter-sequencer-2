// Web Audio look-ahead scheduler — Type2 (16-track, MIDI-only)
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
// (e.g. 5/6, 7/12) we round to the nearest 16th.

export const TRACK_COUNT = 16

export type Pending = { timeSig: string }

export type Track = {
  id: number
  name: string
  timeSig: string          // e.g. "4/4", "7/8", "5/6" (bridge)
  mode: 'instant' | 'transition'
  color: string
  // `steps` is what the scheduler plays and what the UI renders
  steps: boolean[]
  // `stepsSource` is the canonical, never-truncated master pattern.
  stepsSource: boolean[]
  mute: boolean
  solo: boolean
  midiChannel: number      // 1..16
  midiNote: number         // 0..127
  midiVelocity: number     // 0..127
  gateMs: number           // gate length in ms
}

// Always on the 16th-note grid.  n/d of bar → round(n*16/d) steps.
// Numerator 0 is the "drop" marker: a silent bar of standard 16-step length.
export const stepCount = (n: number, d: number) => {
  if (n === 0) return 16
  return Math.max(1, Math.round((n * 16) / d))
}

// Constant 16th-note duration — the whole app rides one clock.
export const stepDur = (bpm: number) => 60 / bpm / 4

export const autoPreset = (n: number, d: number) => {
  const cnt = stepCount(n, d)
  if (n === 0) return Array(cnt).fill(false) as boolean[]
  const arr = Array(cnt).fill(false) as boolean[]
  const beat = Math.max(1, Math.round(16 / d))
  for (let i = 0; i < cnt; i += beat) arr[i] = true
  return arr
}

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

export const deriveStepsFromSource = (
  source: boolean[],
  newLen: number,
  n: number,
  d: number,
): { steps: boolean[]; stepsSource: boolean[] } => {
  if (n === 0) {
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
  const out = Array<boolean>(newLen).fill(false)
  for (let i = 0; i < source.length; i++) out[i] = source[i]

  const beat = Math.max(1, Math.round(16 / d))
  const density = hits / source.length
  const tooShort = source.length < beat
  const tooDense = density >= 0.5

  if (tooShort || tooDense) {
    for (let i = source.length; i < newLen; i++) {
      if (i % beat === 0) out[i] = true
    }
  } else {
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
const BRIDGE_DENOMS = [4, 6, 8, 12, 16] as const

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

// ── Web Audio 合成音 ─────────────────────────────────────
// 16トラック分の音色。audioEnabledRef.current が false のときは呼ばれない。
// MIDI 送信とは独立して動作する。
export function triggerSound(ctx: AudioContext, id: number) {
  const t = ctx.currentTime + 0.002
  const master = ctx.createGain()
  master.connect(ctx.destination)

  const noise = (dur: number) => {
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    const s = ctx.createBufferSource(); s.buffer = buf; return s
  }

  // トラックを大まかなカテゴリに分類してそれぞれ合成
  const cat = id % 8  // 0–7 の音色カテゴリを 8 トラックごとに繰り返す
  const pitch = id < 8 ? 1.0 : 0.85  // ch9–16 は少し低め

  if (cat === 0) {
    // KICK: サイン波スイープ
    const o = ctx.createOscillator(); o.connect(master)
    o.frequency.setValueAtTime(160 * pitch, t)
    o.frequency.exponentialRampToValueAtTime(0.01, t + 0.28)
    master.gain.setValueAtTime(1.0, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    o.start(t); o.stop(t + 0.28)
  } else if (cat === 1) {
    // SNARE: ノイズ + トーン
    const s = noise(0.18)
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200
    const o = ctx.createOscillator(); o.frequency.value = 180 * pitch
    const og = ctx.createGain()
    s.connect(f); f.connect(master); o.connect(og); og.connect(master)
    master.gain.setValueAtTime(0.7, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
    og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    s.start(t); s.stop(t + 0.18); o.start(t); o.stop(t + 0.08)
  } else if (cat === 2) {
    // HAT: ハイパスノイズ（短）
    const s = noise(0.06)
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 8000
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.45, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
    s.start(t); s.stop(t + 0.06)
  } else if (cat === 3) {
    // CLAP: バンドパスノイズ
    const s = noise(0.12)
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 0.5
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.55, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    s.start(t); s.stop(t + 0.12)
  } else if (cat === 4) {
    // BASS: 低サイン波
    const o = ctx.createOscillator(); o.frequency.value = 55 * pitch; o.connect(master)
    master.gain.setValueAtTime(0.5, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
    o.start(t); o.stop(t + 0.25)
  } else if (cat === 5) {
    // LEAD: ノコギリ波
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 440 * pitch; o.connect(master)
    master.gain.setValueAtTime(0.35, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    o.start(t); o.stop(t + 0.12)
  } else if (cat === 6) {
    // PAD: 三角波（柔らか）
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 220 * pitch; o.connect(master)
    master.gain.setValueAtTime(0.3, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
    o.start(t); o.stop(t + 0.4)
  } else {
    // PERC: ミッドノイズ（短）
    const s = noise(0.08)
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 600; f.Q.value = 2
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.5, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    s.start(t); s.stop(t + 0.08)
  }
}

// ── スケジューラ本体 ─────────────────────────────────────
export type SchedulerDeps = {
  bpmRaw: { current: number }
  tracksRaw: { current: Track[] }
  pendingRaw: { current: Pending[][] }
  displayHeads: { current: number[] }
  applyFnRef: { current: ((id: number, p: Pending) => void) | null }
  midiFireRef: { current: ((id: number) => void) | null }
  // audioEnabledRef.current === false でWeb Audio 合成音を消音。MIDIは継続。
  audioEnabledRef: { current: boolean }
  masterTargetRef: { current: string | null }
  onHeadsTick: (heads: number[]) => void
  onMasterReset: () => void
}

export function createScheduler(deps: SchedulerDeps) {
  const {
    bpmRaw, tracksRaw, pendingRaw, displayHeads,
    applyFnRef, midiFireRef, audioEnabledRef,
    masterTargetRef, onHeadsTick, onMasterReset,
  } = deps

  // AudioContext: タイミング基準 + Web Audio 合成音の両方に使用
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
        if (audioEnabledRef.current && ctx) triggerSound(ctx, id)
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
