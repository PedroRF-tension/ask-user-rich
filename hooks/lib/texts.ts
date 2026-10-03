// Every string the model or the person reads from the mod.
import type { AskUserRichRow, AskUserRichUrls } from '../../types'

export const PLUGIN = 'ask-user-rich'
export const ASK_TOOL = 'mcp__ask-user-rich__ask_user_rich'
export const APPEND_TOOL = 'mcp__ask-user-rich__append_questions'
export const CLOSE_TOOL = 'mcp__ask-user-rich__close_thread'
export const OWN_TOOLS: ReadonlySet<string> = new Set([ASK_TOOL, APPEND_TOOL, CLOSE_TOOL])
export const SECTION_ID = 'ask-user-rich'

export const ASK_DESCRIPTION =
  "Ask the user a Round of questions on this conversation's Thread: one stable page where every Round, " +
  'follow-up and message of the conversation lands. Use it instead of AskUserQuestion for grilling rounds, ' +
  'design reviews and any decision set (more than 4 questions or options, long headers, markdown context, ' +
  'code/layout previews, or recommendations you want to argue for).\n\n' +
  'Each question has an id, a header, a markdown body, options (id, label, markdown description, optional ' +
  'markdown/code preview), an optional recommended option id plus rationale, multiSelect, allowOther (free ' +
  'text, default true) and dependsOn (earlier question ids, display only). Set kind: "rank" to have the user ' +
  'order every option instead of picking (`recommended` is then the full recommended order). The user can ' +
  'also defer a question, mark it as needing more info, and leave notes.\n\n' +
  'Returns at once: the Round opens on the Thread and the links are drawn for the user. END YOUR TURN right ' +
  "after it. The answers arrive by themselves as the user's next message once they submit (summary line per " +
  'question plus the full JSON). Do not repeat the questions in chat and do not wait in a loop. Asking while a ' +
  'Round is still open adds your questions to that Round under your title.\n\n' +
  'Ids (question and option) are ASCII only, [A-Za-z0-9_.:-]: `secao-tabs`, never `seção-tabs`. `recommended` ' +
  'takes option ids, not labels. `dependsOn` may only name earlier questions.'

export const APPEND_DESCRIPTION =
  'Add follow-up questions to the Round still open on this conversation\'s Thread; the open page updates live ' +
  'and shows the optional `note` as a banner, and the user answers everything in one submit. Same question ' +
  'shape and rules as ask_user_rich; ids unique across the whole Round; dependsOn may name any existing ' +
  'question or an earlier one in this call. Returns at once; the answers still arrive as the user\'s next ' +
  'message. Fails once the Round was submitted: then ask a new Round.'

export const CLOSE_DESCRIPTION =
  "Close this conversation's Thread when the discussion is over: the page stops mirroring the conversation " +
  'and shows your one- or two-line summary. A later ask_user_rich, or a message the user sends from the page, ' +
  'reopens it.'

export const CLOSE_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string', description: 'One or two lines: what was decided.' } },
  required: ['summary'],
}

export const INSTRUCTIONS = [
  '## Asking the user (ask-user-rich)',
  'Questions for the user go through `mcp__ask-user-rich__ask_user_rich`, which opens a Round on this ' +
    "conversation's Thread, one stable page the user keeps open (also on their phone).",
  '- Put the whole round in one call, each question with a recommended option and its rationale.',
  '- The links are drawn for the user by the mod, under the call and as a notice. You need not print them.',
  "- End your turn right after asking. The answers arrive as the user's next message, sent by the " +
    'ask-user-rich plugin. Messages the user types on the page arrive the same way.',
  '- Follow-ups while the Round is open: `append_questions`. When the discussion is over: `close_thread`.',
  '- Treat deferred and needs-info answers as open, not as consent; read the notes, they often hold the real constraint.',
  '- Common mistakes (each rejects the whole call): non-ASCII ids; `recommended` holding a label instead of an ' +
    'option id, or several ids without multiSelect; `dependsOn` naming a later question; a question with no ' +
    'options and allowOther false; duplicate ids; a rank question with fewer than 2 options, with multiSelect, ' +
    'or whose `recommended` is not every option id exactly once.',
].join('\n')

export const GRILLING_ADDENDUM =
  'ask-user-rich (overrides the round format above): ask every round through `mcp__ask-user-rich__ask_user_rich` ' +
  '(load it with ToolSearch `select:mcp__ask-user-rich__ask_user_rich` if it is deferred). Send the whole frontier ' +
  'as one Round, each question with a recommended option and its rationale. The mod draws the links; end your ' +
  'turn after asking, and the answers arrive as the next message. Use `append_questions` for follow-ups while ' +
  'the Round is open and `close_thread` when the frontier is empty. Never print a round as chat markdown; never ' +
  'use AskUserQuestion.'

export const ASK_DENY =
  "ask-user-rich: while this conversation's Thread is open (or grilling is on), questions go through " +
  'mcp__ask-user-rich__ask_user_rich, not AskUserQuestion: one Round with a recommended option and rationale ' +
  'per question, then end your turn.'

export const SUBAGENT_DENY =
  'ask-user-rich: only the main conversation asks the user. Report the decision you need back to the agent ' +
  'that started you, with your recommendation, and it will ask.'

export const DISABLED_DENY = 'ask-user-rich is switched off (its Enabled row in /config, or PROMETHEUS_MODS=off).'

export function linksLine(urls: AskUserRichUrls): string {
  return urls.public ? `Internal: ${urls.internal} · Public: ${urls.public}` : urls.internal
}

export function askResult(row: AskUserRichRow): string {
  const what = row.joined
    ? `Your ${row.appended} question(s) joined the open Round ${row.round} under the heading "${row.title}" (now ${row.total}).`
    : `Round ${row.round} is open on the Thread (${row.total} question(s)).`
  return (
    `${what} The links are drawn for the user (${linksLine(row.urls)}).\n` +
    "End your turn now: the answers arrive as the user's next message when they submit. Do not ask the questions " +
    'in chat. Use append_questions for follow-ups while the Round is open.'
  )
}

export function appendResult(row: AskUserRichRow): string {
  return (
    `Appended ${row.appended} question(s) to Round ${row.round} (now ${row.total}). The open page updates live ` +
    `(${linksLine(row.urls)}). The answers still arrive as the user's next message; end your turn if you have ` +
    'nothing else to do.'
  )
}

export function noticeText(row: AskUserRichRow): string {
  const head = row.kind === 'append' || row.joined ? `${row.appended} follow-up(s) added to Round ${row.round}` : `Round ${row.round} is open`
  return `${head} · ${linksLine(row.urls)}`
}

export function pushText(row: AskUserRichRow): string {
  return `Round ${row.round} is waiting: ${row.title}${row.urls.public ? ` ${row.urls.public}` : ''}`
}

export const CLOSED_RESULT = 'The Thread is closed: the page stopped mirroring and shows your summary.'
