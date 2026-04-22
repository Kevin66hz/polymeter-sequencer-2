// AudioAdapter — Web Audio synth for 16 tracks. Default implementation; can
// be swapped out (e.g. for a sampled engine) without touching the scheduler.
//
// The `triggerSound` function is intentionally stateless — one call per step
// hit. The scheduler invokes it with a single AudioContext instance, the
// track id, and the absolute AudioContext time at which the note should
// sound. All Web Audio start/ramp calls are anchored to that `time` so the
// sound is rendered on the audio thread's own clock, independent of main-
// thread jitter (GC pauses, Vue re-renders). Audio output is muted at the
// *call* site when audioEnabledRef is false; MIDI fires independently.
//
// Node lifecycle: every call creates fresh Web Audio nodes routed through a
// master GainNode → ctx.destination. SourceNodes (Oscillator, BufferSource)
// are self-cleaning: the browser removes them from the rendering graph after
// their `ended` event. GainNodes however are NOT automatically disconnected
// and accumulate in the AudioContext graph if left connected — over several
// minutes this causes the audio rendering thread to degrade. We schedule an
// explicit `master.disconnect()` after the longest source in each sound
// finishes, allowing the full subgraph to be GC'd.

export interface AudioAdapter {
  /**
   * Trigger the sound for `trackId` at absolute AudioContext `time`
   * (seconds). Callers should pass the scheduler's pre-computed time
   * for the step; adapters must NOT substitute `ctx.currentTime` as
   * that would re-introduce main-thread scheduling jitter.
   */
  trigger(ctx: AudioContext, trackId: number, time: number): void
}

export function triggerSound(ctx: AudioContext, id: number, time?: number) {
  // Back-compat: older callers invoked triggerSound(ctx, id) without an
  // explicit time. Fall back to `ctx.currentTime + 0.002` (the prior
  // default) so existing tests / tools keep working; the scheduler
  // always passes an explicit time now.
  const t = typeof time === 'number' ? time : ctx.currentTime + 0.002
  const master = ctx.createGain()
  master.connect(ctx.destination)

  // Longest note duration for this sound — used to schedule cleanup.
  let maxDur = 0
  const track = (dur: number) => { if (dur > maxDur) maxDur = dur }

  const noise = (dur: number) => {
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    const s = ctx.createBufferSource(); s.buffer = buf; return s
  }

  const cat = id % 8
  const pitch = id < 8 ? 1.0 : 0.85

  if (cat === 0) {
    const o = ctx.createOscillator(); o.connect(master)
    o.frequency.setValueAtTime(160 * pitch, t)
    o.frequency.exponentialRampToValueAtTime(0.01, t + 0.28)
    master.gain.setValueAtTime(1.0, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    o.start(t); o.stop(t + 0.28); track(0.28)
  } else if (cat === 1) {
    const s = noise(0.18)
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200
    const o = ctx.createOscillator(); o.frequency.value = 180 * pitch
    const og = ctx.createGain()
    s.connect(f); f.connect(master); o.connect(og); og.connect(master)
    master.gain.setValueAtTime(0.7, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
    og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    s.start(t); s.stop(t + 0.18); o.start(t); o.stop(t + 0.18); track(0.18)
  } else if (cat === 2) {
    const s = noise(0.06)
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 8000
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.45, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
    s.start(t); s.stop(t + 0.06); track(0.06)
  } else if (cat === 3) {
    const s = noise(0.12)
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 0.5
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.55, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    s.start(t); s.stop(t + 0.12); track(0.12)
  } else if (cat === 4) {
    const o = ctx.createOscillator(); o.frequency.value = 55 * pitch; o.connect(master)
    master.gain.setValueAtTime(0.5, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
    o.start(t); o.stop(t + 0.25); track(0.25)
  } else if (cat === 5) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 440 * pitch; o.connect(master)
    master.gain.setValueAtTime(0.35, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    o.start(t); o.stop(t + 0.12); track(0.12)
  } else if (cat === 6) {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 220 * pitch; o.connect(master)
    master.gain.setValueAtTime(0.3, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
    o.start(t); o.stop(t + 0.4); track(0.4)
  } else {
    const s = noise(0.08)
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 600; f.Q.value = 2
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.5, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    s.start(t); s.stop(t + 0.08); track(0.08)
  }

  // Disconnect the master gain after all sources finish so the entire
  // subgraph becomes eligible for GC. Without this, GainNodes stay
  // connected to ctx.destination indefinitely and the AudioContext graph
  // grows unboundedly over a long session.
  // +100ms slack covers the 2ms start offset and minor scheduling variance.
  const cleanupMs = Math.max(0, (t - ctx.currentTime + maxDur) * 1000 + 100)
  setTimeout(() => { try { master.disconnect() } catch { /* already gone */ } }, cleanupMs)
}

export const defaultAudioAdapter: AudioAdapter = {
  trigger(ctx, id, time) { triggerSound(ctx, id, time) },
}
