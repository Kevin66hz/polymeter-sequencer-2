// Bridge meter generator: interpolate from one time sig to another in `bars`
// intermediate bars, landing on the target at the end.

import type { Pending } from '#core/types'

// Denominators available to the bridge generator — richer than user-exposed
// {4, 8, 16} because we need smooth intermediate ratios like 5/6 or 7/12.
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
