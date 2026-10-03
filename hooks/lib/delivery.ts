// How what the user sent from the page reaches the conversation.
export type Delivery =
  | { id: string; kind: 'answers'; round: number; summary: string; result: unknown }
  | { id: string; kind: 'message'; text: string }
  | { id: string; kind: 'end' }

export const ANSWERS_HEAD = 'Answers to Round'
export const MESSAGE_HEAD = 'Message from the user on the Thread page'
export const END_HEAD = 'The user closed the Thread from the page'

/** The text the model reads. Its first line is what the compact transcript row shows. */
export function deliveryText(d: Delivery): string {
  if (d.kind === 'answers') {
    return `${ANSWERS_HEAD} ${d.round} (submitted on the Thread page)\n\n${d.summary}\n\nFull answers (JSON):\n${JSON.stringify(d.result)}`
  }
  if (d.kind === 'message') return `${MESSAGE_HEAD}:\n\n${d.text}`
  return `${END_HEAD}: the discussion is over. Do not open another Round unless the user asks for one; close_thread is not needed.`
}

/**
 * Idle: one prompt carrying everything, in order. Busy: one appended user row each, read at the
 * model's next step. Either way, everything is acknowledged once stored.
 */
export function plan(deliveries: readonly Delivery[], busy: boolean): { prompt: string | null; rows: string[]; ids: string[] } {
  const texts = deliveries.map(deliveryText)
  const ids = deliveries.map((d) => d.id)
  if (texts.length === 0) return { prompt: null, rows: [], ids }
  if (busy) return { prompt: null, rows: texts, ids }
  return { prompt: texts.join('\n\n---\n\n'), rows: [], ids }
}

/** The compact line a delivered prompt draws as in the transcript: its first line. */
export function compactLine(text: string): string | null {
  const plugin = /^The ask-user-rich plugin sent a message:\s*/
  const body = text.replace(plugin, '')
  const first = body.split('\n')[0] ?? ''
  if (first.startsWith(ANSWERS_HEAD) || first.startsWith(MESSAGE_HEAD) || first.startsWith(END_HEAD)) {
    const counted = /^\d+\. \[/m.test(body) ? ` · ${(body.match(/^\d+\. \[/gm) ?? []).length} answer(s)` : ''
    return `${first.replace(/:$/, '')}${counted}`
  }
  return null
}
