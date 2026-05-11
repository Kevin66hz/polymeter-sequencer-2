// applyPending: re-shape a Track when a Pending time-sig change fires at
// the loop boundary.

import type { Track, Pending } from '#core/types'
import { stepCount, deriveStepsFromSource, resizeStepNotes } from '#core/pure/meter'

export const applyPending = (trk: Track, p: Pending): Track => {
  const sig = p.timeSig
  const [n, d] = sig.split('/').map(Number)
  const newLen = stepCount(n, d)
  const { steps, stepsSource } = deriveStepsFromSource(trk.stepsSource, newLen, n, d)
  // Keep stepNotes aligned with the new stepsSource length. If
  // deriveStepsFromSource replaced stepsSource outright (autoPreset
  // because the source had no hits) the new step positions have no
  // semantic link to the old ones, so we drop overrides entirely.
  const sourceWasReplaced = stepsSource !== trk.stepsSource
    && stepsSource.length !== trk.stepsSource.length
    && trk.stepsSource.every(b => !b)
  const stepNotes = sourceWasReplaced
    ? undefined
    : resizeStepNotes(trk.stepNotes, stepsSource.length)
  return { ...trk, timeSig: sig, steps, stepsSource, stepNotes }
}
