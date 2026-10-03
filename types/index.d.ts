// BandSegment: prometheus' mods seams, Contract 1 (copied whole, no comments inside).
export type BandSegment = {
  text: string
  tone: 'ok' | 'busy' | 'warn' | 'error' | 'info'
  order: number
  command?: string
}

export type AskUserRichUrls = { internal: string; public: string | null }

/** The conversation's Thread as the daemon last reported it. */
export type AskUserRichThread = {
  id: string
  token: string
  state: 'open' | 'closed'
  openRound: number | null
  urls: AskUserRichUrls
}

/** What one ask_user_rich / append_questions call opened, keyed by its tool_use_id: the row draws it. */
export type AskUserRichRow = {
  kind: 'ask' | 'append'
  round: number
  total: number
  joined: boolean
  appended: number
  title: string
  urls: AskUserRichUrls
}

declare module 'claude-code' {
  interface PluginState {
    'ask-user-rich': {
      segment: BandSegment | null
      thread: AskUserRichThread | null
      rows: Record<string, AskUserRichRow>
      busy: boolean
      turnId: string | null
      grilling: { since: string | null }
      askFailedTurnId: string | null
      chip: string | null
    }
  }
}
