// applyPending: re-shape a Track when a Pending time-sig change fires at
// the loop boundary.

import type { Track, Pending } from '#core/types'
import { stepCount, deriveStepsFromSource } from '#core/pure/meter'

export const applyPending = (trk: Track, p: Pending): Track => {
  const sig = p.timeSig
  const [n, d] = sig.split('/').map(Number)
  const newLen = stepCount(n, d)
  const { steps, stepsSource } = deriveStepsFromSource(trk.stepsSource, newLen, n, d)
  return { ...trk, timeSig: sig, steps, stepsSource }
}
