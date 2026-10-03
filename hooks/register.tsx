// Wiring and I/O only. The engine follows `$` only into functions of the file that holds the call,
// so every `$` call lives here; every rule lives in lib/, pure and tested there.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { AskUserRichRow, AskUserRichThread, AskUserRichUrls, BandSegment } from '../types'
import { plan } from './lib/delivery'
import type { Delivery } from './lib/delivery'
import { denyAsk, isGrillingSkill, isGrillPrompt, isUserOrigin } from './lib/grilling'
import { chipOf, mirroredOf } from './lib/mirror'
import type { Mirrored } from './lib/mirror'
import { APPEND_SCHEMA, ASK_SCHEMA } from './lib/schemas.gen'
import { segmentOf } from './lib/segment'
import * as T from './lib/texts'

const segment = atom({ plugin: 'ask-user-rich', key: 'segment' } as const, null as BandSegment | null)
const thread = atom({ plugin: 'ask-user-rich', key: 'thread' } as const, null as AskUserRichThread | null)
const rows = atom({ plugin: 'ask-user-rich', key: 'rows' } as const, {} as Record<string, AskUserRichRow>)
const busy = atom({ plugin: 'ask-user-rich', key: 'busy' } as const, false)
const turnId = atom({ plugin: 'ask-user-rich', key: 'turnId' } as const, null as string | null)
const grilling = atom({ plugin: 'ask-user-rich', key: 'grilling' } as const, { since: null } as { since: string | null })
const askFailedTurnId = atom({ plugin: 'ask-user-rich', key: 'askFailedTurnId' } as const, null as string | null)
const chip = atom({ plugin: 'ask-user-rich', key: 'chip' } as const, null as string | null)

const POLL_MS = 1000
const LAUNCH_TIMEOUT_MS = 15_000

// A hot reload drops the module's timers with it; session.start arms a fresh one.
let pollTimer: Timer | null = null
let polling = false
// A daemon that stopped answering is asked again less and less often, up to every 30 s.
let failures = 0
let nextPollAt = 0

type Reply = { status: number; body: Record<string, unknown> }

async function isEnabled($: EngineInterface, options: PluginOptions): Promise<boolean> {
  return options.enabled !== false && (await $.env.get('PROMETHEUS_MODS')) !== 'off'
}

function debug($: EngineInterface, text: string): void {
  $.ui.log(`ask-user-rich: ${text}`, { to: 'debug' })
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- the daemon ------------------------------------------------------------------------

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('ASK_USER_RICH_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.cache/ask-user-rich`
}

async function daemonEnv($: EngineInterface, options: PluginOptions): Promise<Record<string, string>> {
  return {
    ASK_USER_RICH_HOME: await home($),
    ASK_USER_RICH_HOSTS: String(options.hosts ?? '127.0.0.1'),
    ASK_USER_RICH_PUBLIC_HOST: String(options.publicHost ?? 'localhost'),
    ASK_USER_RICH_PORT: String(options.port ?? 47810),
  }
}

/** One request to the daemon over its socket; rejects when the daemon does not answer. */
async function call($: EngineInterface, method: 'GET' | 'POST', route: string, body?: unknown): Promise<Reply> {
  const socketPath = `${await home($)}/daemon.sock`
  const res = await $.http.fetch(`http://ask-user-rich${route}`, {
    method,
    socketPath,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  let parsed: Record<string, unknown> = {}
  try {
    parsed = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {}
  } catch {
    parsed = { error: res.text }
  }
  return { status: res.status, body: parsed }
}

async function hello($: EngineInterface): Promise<Record<string, unknown> | null> {
  try {
    const reply = await call($, 'GET', '/mod/hello')
    return reply.status === 200 ? reply.body : null
  } catch {
    return null
  }
}

async function ownVersion($: EngineInterface): Promise<string | null> {
  try {
    return (JSON.parse(String(await $.fs.read(`${$.plugin.root}/package.json`))) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

async function launch($: EngineInterface, options: PluginOptions): Promise<string | null> {
  try {
    const run = await $.process.run(['bash', `${$.plugin.root}/daemon/launch.sh`], { env: await daemonEnv($, options), timeoutMs: LAUNCH_TIMEOUT_MS })
    const line = run.stdout.trim().split('\n').pop() ?? ''
    const out = JSON.parse(line || '{}') as { ok?: boolean; error?: string; log?: string }
    if (out.ok) return null
    return `${out.error ?? `launch exited ${run.exitCode}`}${out.log ? ` (${out.log})` : ''}`
  } catch (err) {
    return reason(err)
  }
}

/**
 * The daemon this mod needs: started when absent, restarted when its version or its addresses
 * differ from this mod's and no Round is open anywhere. Returns null, or why it is unavailable.
 */
async function ensureDaemon($: EngineInterface, options: PluginOptions): Promise<string | null> {
  const running = await hello($)
  if (running === null) return launch($, options)
  const want = await daemonEnv($, options)
  const version = await ownVersion($)
  const hosts = (running.hosts as string[] | undefined)?.join(',')
  const differs =
    (version !== null && running.version !== version) ||
    hosts !== want.ASK_USER_RICH_HOSTS ||
    String(running.publicHost) !== want.ASK_USER_RICH_PUBLIC_HOST ||
    String(running.port) !== want.ASK_USER_RICH_PORT
  if (!differs || Number(running.openRounds ?? 0) > 0) return null
  debug($, `restarting the daemon (version ${String(running.version)} → ${version}, or its addresses changed)`)
  try {
    await call($, 'POST', '/mod/shutdown', { reason: 'upgrade or config change' })
  } catch {
    // Gone already.
  }
  for (let i = 0; i < 20 && (await hello($)) !== null; i++) await $.clock.sleep(100)
  return launch($, options)
}

// ---- the conversation's Thread -----------------------------------------------------------

async function setThread($: EngineInterface, options: PluginOptions, value: AskUserRichThread | null): Promise<void> {
  await update($, thread, () => value)
  const enabled = await isEnabled($, options)
  await update($, segment, () => segmentOf(enabled, value))
}

async function session($: EngineInterface): Promise<string> {
  return $.session.id()
}

async function project($: EngineInterface): Promise<{ project: string; cwd: string }> {
  const cwd = await $.session.cwd()
  return { project: cwd.slice(cwd.lastIndexOf('/') + 1) || cwd, cwd }
}

async function mirror($: EngineInterface, messages: Mirrored[]): Promise<void> {
  if (messages.length === 0) return
  const current = await read($, thread)
  if (current === null || current.state !== 'open') return
  try {
    await call($, 'POST', '/mod/mirror', { session: await session($), messages })
  } catch (err) {
    debug($, `mirror failed: ${reason(err)}`)
  }
}

async function presence($: EngineInterface, state: 'working' | 'idle', toolChip: string | null): Promise<void> {
  if ((await read($, thread)) === null) return
  try {
    await call($, 'POST', '/mod/presence', { session: await session($), state, chip: toolChip })
  } catch (err) {
    debug($, `presence failed: ${reason(err)}`)
  }
}

/** One poll: the Thread's state, and whatever the user sent from the page, stored then acknowledged. */
async function poll($: EngineInterface, options: PluginOptions): Promise<void> {
  if (polling) return
  const now = await $.clock.now()
  if (now < nextPollAt) return
  polling = true
  try {
    let reply: Reply
    try {
      reply = await call($, 'POST', '/mod/pending', { session: await session($) })
      failures = 0
      nextPollAt = 0
    } catch (err) {
      failures += 1
      nextPollAt = now + Math.min(30_000, POLL_MS * 2 ** failures)
      if (failures === 1) debug($, `the daemon stopped answering: ${reason(err)}`)
      return
    }
    if (reply.status !== 200) return
    const next = (reply.body.thread ?? null) as AskUserRichThread | null
    const current = await read($, thread)
    if (JSON.stringify(current) !== JSON.stringify(next)) await setThread($, options, next)
    const deliveries = (reply.body.deliveries ?? []) as Delivery[]
    if (deliveries.length === 0) return
    const planned = plan(deliveries, await read($, busy))
    for (const text of planned.rows) {
      debug($, `folded into the running turn: ${text.split('\n')[0]}`)
      try {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      } catch (err) {
        debug($, `folding failed: ${reason(err)}`)
      }
    }
    if (planned.prompt !== null) await $.prompt.submit({ text: planned.prompt })
    await call($, 'POST', '/mod/ack', { session: await session($), ids: planned.ids })
  } catch (err) {
    debug($, `poll failed: ${reason(err)}`)
  } finally {
    polling = false
  }
}

function armPoll($: EngineInterface, options: PluginOptions): void {
  failures = 0
  nextPollAt = 0
  pollTimer?.cancel()
  pollTimer = $.clock.every(POLL_MS, () => {
    void poll($, options)
  })
}

async function phone($: EngineInterface, text: string): Promise<void> {
  let autopilot = false
  try {
    autopilot = (await $.state.get({ plugin: 'house-rules', key: 'autopilot' } as never)).value === true
  } catch {
    autopilot = false
  }
  if (!autopilot) return
  try {
    await $.tool.call({ tool: 'PushNotification', message: text, status: 'proactive' })
  } catch (err) {
    debug($, `push failed: ${reason(err)}`)
  }
}

// Logged as well: the test engine has no session.append beneath the plugins, so the log is what a
// test reads.
async function notice($: EngineInterface, text: string): Promise<void> {
  debug($, `notice: ${text}`)
  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
  } catch (err) {
    debug($, `notice failed: ${reason(err)}`)
  }
}

async function failed($: EngineInterface): Promise<void> {
  const current = await read($, turnId)
  await update($, askFailedTurnId, () => current ?? 'unknown')
}

async function armGrilling($: EngineInterface, id: string | undefined): Promise<void> {
  const current = await read($, grilling)
  if (current.since !== null) return
  await update($, grilling, () => ({ since: id ?? 'unknown' }))
}

/** ask_user_rich and append_questions: the daemon decides, the mod records the row and tells the user. */
async function openRound(
  $: EngineInterface,
  options: PluginOptions,
  e: { tool_use_id: string; agentId?: string } & Record<string, unknown>,
  kind: 'ask' | 'append',
): Promise<{ deny: string } | { result: string }> {
  if (e.agentId !== undefined) return { deny: T.SUBAGENT_DENY }
  const unavailable = await ensureDaemon($, options)
  if (unavailable !== null) {
    await failed($)
    return { deny: `ask-user-rich: the Thread daemon is unavailable (${unavailable}). Ask in chat this time; AskUserQuestion is allowed for the rest of this turn.` }
  }
  const input =
    kind === 'ask'
      ? { title: e.title, intro: e.intro, questions: e.questions }
      : { questions: e.questions, note: e.note }
  let reply: Reply
  try {
    reply = await call($, 'POST', kind === 'ask' ? '/mod/ask' : '/mod/append', { session: await session($), ...(await project($)), input })
  } catch (err) {
    await failed($)
    return { deny: `ask-user-rich: the Thread daemon did not answer (${reason(err)}). AskUserQuestion is allowed for the rest of this turn.` }
  }
  if (reply.status !== 200) return { deny: String(reply.body.error ?? `HTTP ${reply.status}`) }
  const round = reply.body.round as { n: number; total: number; joined?: boolean; appended?: number }
  const urls = reply.body.urls as AskUserRichUrls
  const questions = Array.isArray(e.questions) ? e.questions.length : 0
  const row: AskUserRichRow = {
    kind,
    round: round.n,
    total: round.total,
    joined: round.joined === true,
    appended: round.appended ?? questions,
    title: typeof e.title === 'string' ? e.title : '',
    urls,
  }
  await update($, rows, (value) => ({ ...(value ?? {}), [e.tool_use_id]: row }))
  await setThread($, options, reply.body.thread as AskUserRichThread)
  armPoll($, options)
  await notice($, T.noticeText(row))
  if (kind === 'ask' && !row.joined) await phone($, T.pushText(row))
  return { result: kind === 'ask' ? T.askResult(row) : T.appendResult(row) }
}

// ---- the hooks -------------------------------------------------------------------------

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    try {
      const enabled = await isEnabled($, options)
      const known = enabled ? await read($, thread) : null
      await update($, segment, () => segmentOf(enabled, known))
      if (!enabled) return next(e)
      await $.tool.register({ name: 'ask_user_rich', description: T.ASK_DESCRIPTION, inputSchema: ASK_SCHEMA })
      await $.tool.register({ name: 'append_questions', description: T.APPEND_DESCRIPTION, inputSchema: APPEND_SCHEMA })
      await $.tool.register({ name: 'close_thread', description: T.CLOSE_DESCRIPTION, inputSchema: T.CLOSE_SCHEMA })
      const unavailable = await ensureDaemon($, options)
      if (unavailable !== null) debug($, `daemon unavailable at start: ${unavailable}`)
      // A resumed conversation may have a Thread, and answers waiting; a fresh one polls nothing until it asks.
      failures = 0
      nextPollAt = 0
      if (unavailable === null) {
        await poll($, options)
        if ((await read($, thread)) !== null) armPoll($, options)
      }
    } catch (err) {
      debug($, `session.start failed: ${reason(err)}`)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      pollTimer?.cancel()
      pollTimer = null
      await update($, thread, () => null)
      await update($, rows, () => ({}))
      await update($, segment, () => null)
      await update($, grilling, () => ({ since: null }))
      await update($, askFailedTurnId, () => null)
      await update($, busy, () => false)
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__ask-user-rich__ask_user_rich' }, async ($, e, next) => {
    if (!(await isEnabled($, options))) return next(e)
    return openRound($, options, e as never, 'ask')
  })

  on('tool.call', { tool: 'mcp__ask-user-rich__append_questions' }, async ($, e, next) => {
    if (!(await isEnabled($, options))) return next(e)
    return openRound($, options, e as never, 'append')
  })

  on('tool.call', { tool: 'mcp__ask-user-rich__close_thread' }, async ($, e, next) => {
    if (!(await isEnabled($, options))) return next(e)
    if (e.agentId !== undefined) return { deny: T.SUBAGENT_DENY }
    try {
      const reply = await call($, 'POST', '/mod/close', { session: await session($), summary: (e as { summary?: unknown }).summary ?? null })
      if (reply.status !== 200) return { deny: String(reply.body.error ?? `HTTP ${reply.status}`) }
      await setThread($, options, reply.body.thread as AskUserRichThread)
      return { result: T.CLOSED_RESULT }
    } catch (err) {
      return { deny: `ask-user-rich: the Thread daemon did not answer (${reason(err)}).` }
    }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!(await isEnabled($, options))) return next(e)
    try {
      const current = await read($, thread)
      const deny = denyAsk({
        grilling: (await read($, grilling)).since !== null,
        threadOpen: current !== null && current.state === 'open',
        askFailedTurnId: await read($, askFailedTurnId),
        turnId: await read($, turnId),
      })
      if (deny) return { deny: T.ASK_DENY }
    } catch (err) {
      debug($, `AskUserQuestion guard failed, let it through: ${reason(err)}`)
    }
    return next(e)
  })

  // Every other main-loop tool call: the page's status line names it.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && !T.OWN_TOOLS.has(e.tool) && e.tool !== 'AskUserQuestion' && (await isEnabled($, options))) {
      const text = chipOf(e.tool, e)
      if ((await read($, chip)) !== text) {
        await update($, chip, () => text)
        await presence($, 'working', text)
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (await isEnabled($, options)) {
      await update($, turnId, () => e.turnId)
      await update($, busy, () => true)
      await update($, chip, () => null)
      await presence($, 'working', null)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await isEnabled($, options))) {
      await update($, busy, () => false)
      await update($, chip, () => null)
      await presence($, 'idle', null)
    }
    return result
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && (await isEnabled($, options))) {
      try {
        await mirror($, mirroredOf(e as never))
      } catch (err) {
        debug($, `mirroring failed: ${reason(err)}`)
      }
    }
    return stored
  })

  on('prompt.submit', async ($, e, next) => {
    if (isUserOrigin(e.origin) && isGrillPrompt(e.text) && (await isEnabled($, options))) await armGrilling($, e.turnId)
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    if (!isGrillingSkill(e.skill) || !(await isEnabled($, options))) return next(e)
    await armGrilling($, undefined)
    const result = await next(e)
    return { text: `${result.text}\n\n${T.GRILLING_ADDENDUM}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (e.traits.includes('bare') || !(await isEnabled($, options))) return result
    if (result.sections.some((section) => section.id === T.SECTION_ID)) return result
    return { sections: [...result.sections, { id: T.SECTION_ID, text: T.INSTRUCTIONS, scope: 'session' }] }
  })

  // The ask and append rows draw their Round and both links, whatever the model wrote.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const props = e.props as { tool: string; tool_use_id: string; isRunning: boolean }
    if (props.tool !== T.ASK_TOOL && props.tool !== T.APPEND_TOOL) return next(e)
    const row = (await read($, rows))[props.tool_use_id]
    if (!row) return next(e)
    const { Box, Markdown } = $.ui.resolve(e)
    const head = row.kind === 'append' || row.joined ? `**${row.appended} follow-up(s) → Round ${row.round}** · ${row.total} question(s)` : `**Round ${row.round} open** · ${row.total} question(s) · ${row.title}`
    const lines = [head, `- Internal (this machine): ${row.urls.internal}`, ...(row.urls.public ? [`- Public (other devices): ${row.urls.public}`] : [])]
    return (
      <Box flexDirection="column">
        <Markdown text={lines.join('\n')} />
      </Box>
    )
  })
}
