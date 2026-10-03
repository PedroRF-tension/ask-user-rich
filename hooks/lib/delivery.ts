// How what the user sent from the page reaches the conversation.
export type Delivery =
  | { id: string; kind: 'answers'; round: number; summary: string; result: unknown }
  | { id: string; kind: 'message'; text: string }
  | { id: string; kind: 'end' }

export const ANSWERS_HEAD = 'Answers to Round'
export const MESSAGE_HEAD = 'Message from the user on the Thread page'
export const END_HEAD = 'The user closed the Thread from the page'

/** The text the model reads, under the engine's "Prompt from the ask-user-rich plugin" header. */
export function deliveryText(d: Delivery): string {
  if (d.kind === 'answers') {
    return `${ANSWERS_HEAD} ${d.round} (submitted on the Thread page)\n\n${d.summary}\n\nFull answers (JSON):\n${JSON.stringify(d.result)}`
  }
  if (d.kind === 'message') return `${MESSAGE_HEAD}:\n\n${d.text}`
  return `${END_HEAD}: the discussion is over. Do not open another Round unless the user asks for one; close_thread is not needed.`
}

/** One prompt carrying everything, in order; everything is acknowledged once it is queued. */
export function plan(deliveries: readonly Delivery[]): { prompt: string; ids: string[] } {
  return { prompt: deliveries.map(deliveryText).join('\n\n---\n\n'), ids: deliveries.map((d) => d.id) }
}
