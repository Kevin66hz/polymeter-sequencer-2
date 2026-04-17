// Pure meter / grid math. Zero side effects.

// Parse "n/d" into [n, d] with sane fallbacks (both default to 4 if NaN).
// Shared helper — used by store, pending application, and UI meter helpers.
export const parseSig = (s: string): [number, number] => {
  const [nr, dr] = s.split('/').map(Number)
  return [Number.isFinite(nr) ? nr : 4, (Number.isFinite(dr) && dr > 0) ? dr : 4]
}

// 16th-note grid: a bar of n/d = round(n * 16 / d) steps.
// Numerator 0 is the "drop" marker: a silent bar of standard 16-step length.
export const stepCount = (n: number, d: number) => {
  if (n === 0) return 16
  return Math.max(1, Math.round((n * 16) / d))
}

// Constant 16th-note duration in seconds.
export const stepDur = (bpm: number) => 60 / bpm / 4

export const autoPreset = (n: number, d: number): boolean[] => {
  const cnt = stepCount(n, d)
  if (n === 0) return Array(cnt).fill(false)
  const arr: boolean[] = Array(cnt).fill(false)
  const beat = Math.max(1, Math.round(16 / d))
  for (let i = 0; i < cnt; i += beat) arr[i] = true
  return arr
}

// Simple tiling resize. Used when we don't have a canonical source to re-derive from.
export const resizeSteps = (
  old: boolean[],
  newLen: number,
  n: number,
  d: number,
): boolean[] => {
  const anyOn = old.some(Boolean)
  if (!anyOn) return autoPreset(n, d)
  const out: boolean[] = Array(newLen)
  const oldLen = old.length
  for (let i = 0; i < newLen; i++) out[i] = old[i % oldLen]
  return out
}

// Density-aware resize: when we have a canonical `source`, derive the playable
// `steps` of length `newLen` in a way that preserves groove.
//   - n === 0 -> silent bar, keep source intact
//   - newLen <= source.length -> slice; source unchanged so tail survives
//   - newLen >  source.length ->
//       if too-short or too-dense: fill with beat skeleton (i % beat === 0)
//       else: tile (source[i % source.length])
// When expanding, the expanded output is promoted to the new source.
export const deriveStepsFromSource = (
  source: boolean[],
  newLen: number,
  n: number,
  d: number,
): { steps: boolean[]; stepsSource: boolean[] } => {
  if (n === 0) {
    return { steps: Array(newLen).fill(false), stepsSource: source }
  }
  const hits = source.reduce((a, b) => a + (b ? 1 : 0), 0)
  if (hits === 0) {
    const preset = autoPreset(n, d)
    return { steps: preset, stepsSource: preset.slice() }
  }
  if (newLen <= source.length) {
    return { steps: source.slice(0, newLen), stepsSource: source }
  }
  const out: boolean[] = Array(newLen).fill(false)
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
