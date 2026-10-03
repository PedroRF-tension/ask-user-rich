// What arms grilling (copied from house-rules, which owned it before this mod).
const GRILLING_SKILLS: ReadonlySet<string> = new Set(['grilling', 'grill-me', 'grill-with-docs', 'loop-me'])

// Imperative forms only: a prompt that merely mentions grilling arms nothing.
const GRILL_PROMPT = /\bgrill\s+(me|us)\b|\bgrill-me\b|^\s*\/grill/i

const USER_KINDS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

export function isGrillingSkill(skill: string): boolean {
  return GRILLING_SKILLS.has(skill.slice(skill.lastIndexOf(':') + 1))
}

export function isGrillPrompt(text: string): boolean {
  return GRILL_PROMPT.test(text)
}

export function isUserOrigin(origin: { kind: string } | undefined): boolean {
  return origin !== undefined && USER_KINDS.has(origin.kind)
}

/** AskUserQuestion is denied while grilling is armed or a Thread is open, unless ask-user-rich failed this turn. */
export function denyAsk(state: { grilling: boolean; threadOpen: boolean; askFailedTurnId: string | null; turnId: string | null }): boolean {
  if (!state.grilling && !state.threadOpen) return false
  return !(state.askFailedTurnId !== null && state.askFailedTurnId === state.turnId)
}
