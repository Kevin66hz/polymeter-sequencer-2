// Ring geometry constants — shared between RingsStatic, RingsOverlay, ConcentricViewPlus.
//
// Phase 5 Stage 1: Constants only. Stage 2 will add cached coordinate helpers
// (ringR, dotX/Y, stepAngle) and precomputed lookup tables here.

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

// ── Inline geometry helpers (will be memoized/cached in Stage 2) ─────

/** Radius of ring for track index ti (0 = innermost) */
export const ringR = (ti: number): number => CENTER_R + RING_STEP * (ti + 0.5)

/** Dot radius scales slightly with ring index (outer rings are larger) */
export const dotR = (ti: number): number => Math.max(2.5, 2.5 + ti * 0.18)

/** Angle for step index si out of total steps (0 = 12 o'clock) */
export const stepAngle = (si: number, total: number): number =>
  (si / total) * Math.PI * 2 - Math.PI / 2

/** X coordinate for dot at track ti, step si */
export const dotX = (ti: number, si: number, total: number): number =>
  CX + ringR(ti) * Math.cos(stepAngle(si, total))

/** Y coordinate for dot at track ti, step si */
export const dotY = (ti: number, si: number, total: number): number =>
  CY + ringR(ti) * Math.sin(stepAngle(si, total))

/** X coordinate for label at top of ring (12 o'clock) */
export const labelX = (_ti: number): number => CX

/** Y coordinate for label at top of ring (12 o'clock) */
export const labelY = (ti: number): number => CY - ringR(ti) + 1
