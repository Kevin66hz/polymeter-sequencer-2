// AudioAdapter — Web Audio synth for 16 tracks. Default implementation; can
// be swapped out (e.g. for a sampled engine) without touching the scheduler.
//
// The `triggerSound` function is intentionally stateless — one call per step
// hit. The scheduler invokes it with a single AudioContext instance and the
// track id. Audio output is muted at the *call* site when audioEnabledRef is
// false; MIDI fires independently.

export interface AudioAdapter {
  trigger(ctx: AudioContext, trackId: number): void
}

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

  const cat = id % 8
  const pitch = id < 8 ? 1.0 : 0.85

  if (cat === 0) {
    const o = ctx.createOscillator(); o.connect(master)
    o.frequency.setValueAtTime(160 * pitch, t)
    o.frequency.exponentialRampToValueAtTime(0.01, t + 0.28)
    master.gain.setValueAtTime(1.0, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    o.start(t); o.stop(t + 0.28)
  } else if (cat === 1) {
    const s = noise(0.18)
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200
    const o = ctx.createOscillator(); o.frequency.value = 180 * pitch
    const og = ctx.createGain()
    s.connect(f); f.connect(master); o.connect(og); og.connect(master)
    master.gain.setValueAtTime(0.7, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
    og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    s.start(t); s.stop(t + 0.18); o.start(t); o.stop(t + 0.08)
  } else if (cat === 2) {
    const s = noise(0.06)
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 8000
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.45, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
    s.start(t); s.stop(t + 0.06)
  } else if (cat === 3) {
    const s = noise(0.12)
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 0.5
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.55, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    s.start(t); s.stop(t + 0.12)
  } else if (cat === 4) {
    const o = ctx.createOscillator(); o.frequency.value = 55 * pitch; o.connect(master)
    master.gain.setValueAtTime(0.5, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
    o.start(t); o.stop(t + 0.25)
  } else if (cat === 5) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 440 * pitch; o.connect(master)
    master.gain.setValueAtTime(0.35, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    o.start(t); o.stop(t + 0.12)
  } else if (cat === 6) {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 220 * pitch; o.connect(master)
    master.gain.setValueAtTime(0.3, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
    o.start(t); o.stop(t + 0.4)
  } else {
    const s = noise(0.08)
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 600; f.Q.value = 2
    s.connect(f); f.connect(master)
    master.gain.setValueAtTime(0.5, t); master.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    s.start(t); s.stop(t + 0.08)
  }
}

export const defaultAudioAdapter: AudioAdapter = {
  trigger(ctx, id) { triggerSound(ctx, id) },
}
