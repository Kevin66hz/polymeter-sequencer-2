// Ring geometry constants + memoized coordinate lookup.
//
// Shared between RingsStatic, RingsOverlay, ConcentricViewPlus.
//
// Phase 5 Stage 2: dot coordinates are a pure function of (ti, total) plus
// module constants that never change at runtime. We cache them per
// (ti, total) and hand out { x: number[], y: number[] } arrays. Trig
// (Math.cos/sin) runs once per cache miss, never again for that combo —
// so the render path and the RAF overlay loop see only array indexing.

import { TRACK_COUNT } from '#core/types'

/** SVG canvas size (square) */
export const SIZE = 520
/** Center X */
export const CX = SIZE / 2
/** Center Y */
export const CY = SIZE / 2
/** Radius reserved for center info display */
export const CENTER_R = 28
/** Outermost ring radius (with margin from edge) */
export const OUTER_R = CX - 12
/** Total radial space available for rings */
export const RADIAL_SPACE = OUTER_R - CENTER_R
/** Per-ring spacing (depends on track count) */
export const RING_STEP = RADIAL_SPACE / TRACK_COUNT

// ── Per-track scalars (depend on ti only) ────────────────────────────

/** Radius of ring for track index ti (0 = innermost) */
export const ringR = (ti: number): number => CENTER_R + RING_STEP * (ti + 0.5)

/** Dot radius scales slightly with ring index (outer rings are larger) */
export const dotR = (ti: number): number => Math.max(2.5, 2.5 + ti * 0.18)

/** Angle for step index si out of total steps (0 = 12 o'clock) */
export const stepAngle = (si: number, total: number): number =>
  (si / total) * Math.PI * 2 - Math.PI / 2

// ── Memoized dot coordinates, keyed by (ti, total) ───────────────────

/** Precomputed per-step X/Y arrays for a single ring. */
export type DotCoords = { x: number[]; y: number[] }

const dotCoordsCache = new Map<string, DotCoords>()

/**
 * Returns precomputed x[] / y[] for every step on ring `ti` when the ring
 * has `total` steps. First call for a given (ti, total) does the trig;
 * subsequent calls return the cached arrays. The returned arrays are
 * treated as immutable — callers must not mutate them.
 *
 * Cache size is bounded: 16 tracks × a small set of realistic step counts.
 * No invalidation is needed because all inputs (module constants and
 * `total`) are stable.
 */
export function getDotCoords(ti: number, total: number): DotCoords {
  const key = `${ti}:${total}`
  let cached = dotCoordsCache.get(key)
  if (!cached) {
    const r = ringR(ti)
    const x = new Array<number>(total)
    const y = new Array<number>(total)
    for (let si = 0; si < total; si++) {
      const a = stepAngle(si, total)
      x[si] = CX + r * Math.cos(a)
      y[si] = CY + r * Math.sin(a)
    }
    cached = { x, y }
    dotCoordsCache.set(key, cached)
  }
  return cached
}

/**
 * X coordinate for dot at track ti, step si (total = ring step count).
 * Backward-compatible shim — delegates to the cache so existing callers
 * benefit without API change.
 */
export const dotX = (ti: number, si: number, total: number): number =>
  getDotCoords(ti, total).x[si]

/**
 * Y coordinate for dot at track ti, step si (total = ring step count).
 * Backward-compatible shim — delegates to the cache so existing callers
 * benefit without API change.
 */
export const dotY = (ti: number, si: number, total: number): number =>
  getDotCoords(ti, total).y[si]

/** X coordinate for label at top of ring (12 o'clock) */
export const labelX = (_ti: number): number => CX

/** Y coordinate for label at top of ring (12 o'clock) */
export const labelY = (ti: number): number => CY - ringR(ti) + 1
