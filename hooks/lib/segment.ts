import type { AskUserRichThread, BandSegment } from '../../types'

/** The band segment: shown only while a Round waits on the user. */
export function segmentOf(enabled: boolean, thread: AskUserRichThread | null): BandSegment | null {
  if (!enabled || thread === null || thread.openRound === null) return null
  return { text: `◐ round ${thread.openRound}`, tone: 'info', order: 50 }
}
