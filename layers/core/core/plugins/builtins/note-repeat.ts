// NOTE-REPEAT plugin (stub). Splits one step event into N evenly-spaced
// repeats, all within the step's own duration.
//
// Per-track config lives in track.extras['note-repeat'].

import type { SequencerPlugin, NoteEvent, PluginContext } from '#core/types'

export type NoteRepeatExtras = {
  count: number                  // 1 = passthrough
  subdiv: 2 | 3 | 4 | 6 | 8      // subdivision of one 16th
}

export const noteRepeat: SequencerPlugin = {
  id: 'note-repeat',
  version: '0.1',
  defaultTrackExtras: () => ({ count: 1, subdiv: 2 } satisfies NoteRepeatExtras),
  transform(events: NoteEvent[], ctx: PluginContext): NoteEvent[] {
    const cfg = ctx.track.extras?.['note-repeat'] as NoteRepeatExtras | undefined
    if (!cfg || cfg.count <= 1) return events
    const spacing = ctx.stepDurSec / cfg.subdiv
    const out: NoteEvent[] = []
    for (const ev of events) {
      for (let i = 0; i < cfg.count; i++) {
        out.push({
          ...ev,
          timeSec: ev.timeSec + i * spacing,
          gateMs: Math.min(ev.gateMs, spacing * 1000 * 0.9),
          tag: `repeat[${i}]`,
        })
      }
    }
    return out
  },
  ui: { detailPanel: 'NoteRepeatPanel' },
}
