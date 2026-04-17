// Plugin API surface — re-exports and helpers. Expand with registry / compose
// helpers as Phase 6 progresses.

export type {
  SequencerPlugin,
  NoteEvent,
  PluginContext,
} from '#core/types'

// Compose multiple plugin transforms into one.
// Order-sensitive: plugins[0] runs first.
import type { NoteEvent, PluginContext, SequencerPlugin } from '#core/types'

export function composeTransforms(
  plugins: SequencerPlugin[],
): (events: NoteEvent[], ctx: PluginContext) => NoteEvent[] {
  const fns = plugins.map((p) => p.transform).filter(Boolean) as
    Array<(e: NoteEvent[], c: PluginContext) => NoteEvent[]>
  if (fns.length === 0) return (e) => e
  return (events, ctx) => {
    let cur = events
    for (const f of fns) cur = f(cur, ctx)
    return cur
  }
}
