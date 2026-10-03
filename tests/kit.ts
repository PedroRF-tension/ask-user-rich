import { mock } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

// The world beneath the mod for its hook tests: a session S1 in /work/demo, the daemon stood in for
// by an `http.fetch` hook speaking its socket contract, the launcher by a `process.run` hook, and the
// engine's prompt, append and push calls recorded.

export const HOME = '/home/t'
export const CWD = '/work/demo'
export const SOCKET = `${HOME}/.cache/ask-user-rich/daemon.sock`
export const NOW = Date.UTC(2026, 9, 3, 12)
export const URLS = { internal: 'http://localhost:47800/c/TOKEN', public: 'http://100.1.2.3:47800/c/TOKEN' }

export type Request = { method: string; route: string; body: Record<string, unknown> | null; socketPath: string | undefined }

export type Daemon = {
  running: boolean
  version: string
  openRounds: number
  hosts: string
  publicHost: string
  port: number
  /** The answer to POST /mod/ask or /mod/append; default a fresh Round 1 or a follow-up. */
  ask: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }
  thread: Record<string, unknown> | null
  pending: Record<string, unknown>[]
}

export type World = {
  daemon: Daemon
  requests: Request[]
  launches: { argv: string[]; env: Record<string, string> | undefined }[]
  launchFails: boolean
  tools: { name: string; description: string; inputSchema: unknown }[]
  prompts: string[]
  pushes: string[]
  logs: string[]
  clock: ReturnType<typeof mock.clock>
}

export const thread = (over: Record<string, unknown> = {}) => ({ id: 'th1', token: 'TOKEN', state: 'open', openRound: 1, urls: URLS, ...over })

export function world(on: On, options: { env?: Record<string, string>; daemon?: Partial<Daemon> } = {}): World {
  const daemon: Daemon = {
    running: false,
    version: '0.9.0',
    openRounds: 0,
    hosts: '127.0.0.1',
    publicHost: 'localhost',
    port: 47800,
    thread: null,
    pending: [],
    ask: (body) => ({
      status: 200,
      body: {
        thread: thread(),
        round: String(body.route) === 'append' ? { n: 1, version: 2, total: 3, appended: 1 } : { n: 1, version: 1, total: 2, joined: false },
        urls: URLS,
      },
    }),
    ...options.daemon,
  }
  const w: World = {
    daemon,
    requests: [],
    launches: [],
    launchFails: false,
    tools: [],
    prompts: [],
    pushes: [],
    logs: [],
    clock: mock.clock(on, { now: NOW }),
  }
  mock.env(on, options.env ?? { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('ui.log', (_$, e) => (w.logs.push(e.text), { value: undefined }))
  on('tool.register', (_$, e) => (w.tools.push({ name: e.name, description: e.description, inputSchema: e.inputSchema }), { value: { tool: `mcp__ask-user-rich__${e.name}` } }))
  on('fs.read', (_$, e) => (e.path.endsWith('/package.json') ? { value: JSON.stringify({ version: '0.9.0' }) } : { deny: `ENOENT: ${e.path}` }))
  on('process.run', (_$, e) => {
    w.launches.push({ argv: [...e.argv], env: e.init?.env ? { ...e.init.env } : undefined })
    if (!w.launchFails) daemon.running = true
    const stdout = w.launchFails ? '{"ok":false,"error":"the daemon exited with code 3"}\n' : '{"ok":true,"already":false,"pid":1,"version":"0.9.0"}\n'
    return { value: { exitCode: w.launchFails ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_$, e) => {
    const route = new URL(e.url).pathname
    const body = e.init?.body ? (JSON.parse(e.init.body) as Record<string, unknown>) : null
    w.requests.push({ method: e.init?.method ?? 'GET', route, body, socketPath: e.init?.socketPath })
    if (!daemon.running) return { deny: `connect ENOENT ${e.init?.socketPath}` }
    const reply = (status: number, value: unknown) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(value) } })
    switch (route) {
      case '/mod/hello':
        return reply(200, { version: daemon.version, openRounds: daemon.openRounds, hosts: daemon.hosts.split(','), publicHost: daemon.publicHost, port: daemon.port })
      case '/mod/shutdown':
        daemon.running = false
        return reply(200, { ok: true })
      case '/mod/ask':
      case '/mod/append': {
        const out = daemon.ask({ ...body, route: route.slice(5) })
        if (out.status === 200) daemon.thread = out.body.thread as Record<string, unknown>
        return reply(out.status, out.body)
      }
      case '/mod/close':
        daemon.thread = { ...(daemon.thread ?? thread()), state: 'closed', openRound: null }
        return reply(200, { thread: daemon.thread })
      case '/mod/pending':
        return reply(200, { thread: daemon.thread, deliveries: daemon.pending })
      case '/mod/ack': {
        const ids = (body?.ids ?? []) as string[]
        daemon.pending = daemon.pending.filter((d) => !ids.includes(String(d.id)))
        return reply(200, { acked: ids.length })
      }
      default:
        return reply(200, { ok: true })
    }
  })
  on('prompt.submit', (_$, e) => (w.prompts.push(e.text), { text: e.text, origin: e.origin } as never))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  on('session.end', () => ({ sessionId: 'S1' }) as never)
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => (w.pushes.push(String((e as { message?: unknown }).message)), { result: 'sent' } as never))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: 'asked' } as never))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } } as never))
  return w
}

/** house-rules as far as this mod reads it: autopilot, from the env HOUSE_RULES_AUTOPILOT. */
export const houseRules: Plugin = {
  name: 'house-rules',
  register: (on) => {
    on('session.start', async ($, e, next) => {
      if ((await $.env.get('HOUSE_RULES_AUTOPILOT')) === 'on') await $.state.set({ plugin: 'house-rules', key: 'autopilot' } as never, true as never)
      return next(e)
    })
  },
}

/** Reads the mod's state through a tool of its own, as any other plugin would. */
export const reader: Plugin = {
  name: 'reader',
  register: (on) => {
    on('tool.call', { tool: 'mcp__reader__state' }, async ($) => ({
      result: JSON.stringify({
        segment: (await $.state.get({ plugin: 'ask-user-rich', key: 'segment' })).value ?? null,
        thread: (await $.state.get({ plugin: 'ask-user-rich', key: 'thread' })).value ?? null,
        rows: (await $.state.get({ plugin: 'ask-user-rich', key: 'rows' })).value ?? {},
      }),
    }))
  },
}

export async function state($: Engine): Promise<{ segment: unknown; thread: Record<string, unknown> | null; rows: Record<string, Record<string, unknown>> }> {
  return JSON.parse(String((await $.tool.call({ tool: 'mcp__reader__state' } as never)).result))
}

export async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: CWD, surface: null, isInteractive: true } as never)
}

export const QUESTIONS = [{ id: 'db', header: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }], recommended: 'pg' }]

export async function ask($: Engine, input: Record<string, unknown> = {}, agentId?: string): Promise<ToolCallResult> {
  return $.tool.call({
    tool: 'mcp__ask-user-rich__ask_user_rich',
    tool_use_id: 'tu1',
    title: 'Storage',
    questions: QUESTIONS,
    ...input,
    ...(agentId !== undefined ? { agentId } : {}),
  } as never)
}

export const posts = (w: World, route: string) => w.requests.filter((r) => r.route === route)

/** What the mod appended, read from its log: the test engine has no session.append beneath plugins. */
export const notices = (w: World) => w.logs.filter((l) => l.startsWith('ask-user-rich: notice: ')).map((l) => l.slice('ask-user-rich: notice: '.length))
export const folded = (w: World) =>
  w.logs.filter((l) => l.startsWith('ask-user-rich: folded into the running turn: ')).map((l) => l.slice('ask-user-rich: folded into the running turn: '.length))
