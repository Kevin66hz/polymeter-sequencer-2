// Note-repeat engine (MPC/Maschine-style).
//
// While `enabled` is true AND a pad is held, the engine fires
// `onRepeatFire(ch, note, vel)` at a BPM-synced interval derived from
// `rate` (denominator of a whole note: 4, 8, 16, 32).
//
// Design notes:
//   - Recursive setTimeout, not setInterval, so BPM / rate changes take
//     effect on the NEXT tick instead of being baked in at press time.
//   - The FIRST note is NOT emitted here — the caller's onNoteIn pathway
//     already handles the initial hit. We only schedule repeats.
//   - Keyed by `${ch}:${note}` so the same pad pressed twice quickly
//     cancels any lingering timer before arming a fresh one.
//   - Pure composable; no Vue reactive writes. Only reads `bpm.value`,
//     `enabled.value`, `rate.value` inside the tick. This keeps the
//     scheduler-style separation (no dep tracking in hot paths).

import type { Ref } from 'vue'

export type NoteRepeatRate = 4 | 6 | 8 | 12 | 16 | 24 | 32

export type UseNoteRepeatOptions = {
  bpm: Ref<number>
  enabled: Ref<boolean>
  rate: Ref<NoteRepeatRate>
  onRepeatFire: (channel: number, note: number, velocity: number) => void
}

type Held = {
  channel: number
  note: number
  velocity: number
  timerId: ReturnType<typeof setTimeout> | null
}

export function useNoteRepeat(opts: UseNoteRepeatOptions) {
  const held = new Map<string, Held>()
  const keyOf = (ch: number, n: number) => `${ch}:${n}`

  // Whole-note interval at current BPM = (60/bpm) * 4 seconds.
  // For rate R (= note denominator), one 1/R lasts (4/R) beats.
  // Clamp to 10ms floor so the UI can't starve the event loop if the
  // user cranks BPM up or picks an absurd rate.
  function computeIntervalMs(): number {
    const bpm = Math.max(1, opts.bpm.value || 120)
    const denom = opts.rate.value || 16
    const ms = (4 / denom) * (60 / bpm) * 1000
    return Math.max(10, ms)
  }

  function scheduleNext(entry: Held) {
    entry.timerId = setTimeout(() => {
      // Re-check held & enabled each tick — lets the user release mid-tick
      // or disable repeat while holding, without ghosts firing.
      const k = keyOf(entry.channel, entry.note)
      if (!held.has(k)) return
      opts.onRepeatFire(entry.channel, entry.note, entry.velocity)
      if (!opts.enabled.value || !held.has(k)) return
      scheduleNext(entry)
    }, computeIntervalMs())
  }

  function pressNote(channel: number, note: number, velocity: number) {
    if (!opts.enabled.value) return
    const k = keyOf(channel, note)
    // If we already had a timer for this pad, clear before re-arming.
    const prev = held.get(k)
    if (prev?.timerId) clearTimeout(prev.timerId)
    const entry: Held = { channel, note, velocity, timerId: null }
    held.set(k, entry)
    scheduleNext(entry)
  }

  function releaseNote(channel: number, note: number) {
    const k = keyOf(channel, note)
    const entry = held.get(k)
    if (entry?.timerId) clearTimeout(entry.timerId)
    held.delete(k)
  }

  function releaseAll() {
    for (const e of held.values()) if (e.timerId) clearTimeout(e.timerId)
    held.clear()
  }

  return { pressNote, releaseNote, releaseAll }
}
