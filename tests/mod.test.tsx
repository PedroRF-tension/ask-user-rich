// S2: the mod through the engine, the daemon stood in for by tests/kit.ts.
import { describe, expect, test } from 'claude-code/testing'

import { CWD, HOME, QUESTIONS, SOCKET, URLS, ask, folded, houseRules, notices, posts, reader, start, state, thread, world } from './kit'
import { APPEND_SCHEMA, ASK_SCHEMA } from '../hooks/lib/schemas.gen'
import * as T from '../hooks/lib/texts'

const NAMES = ['ask_user_rich', 'append_questions', 'close_thread']
const SURFACES = ['terminal', 'desktop'] as const

describe('the kill switch', () => {
  test('enabled: three tools with their schemas', async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    expect(w.tools.map((t) => t.name)).toEqual(NAMES)
    expect(w.tools[0]?.inputSchema).toEqual(ASK_SCHEMA)
    expect(w.tools[1]?.inputSchema).toEqual(APPEND_SCHEMA)
    expect(w.tools[2]?.inputSchema).toEqual(T.CLOSE_SCHEMA)
  })

  test('disabled by its config row: no tools, no daemon, the segment null', { options: { enabled: false }, plugins: [reader] }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.tools).toEqual([])
    expect(w.launches).toEqual([])
    expect((await state($)).segment).toBeNull()
  })

  test('PROMETHEUS_MODS=off: the same, and its tools pass down untouched', async ($, on) => {
    const w = world(on, { env: { HOME, PROMETHEUS_MODS: 'off' } })
    on('tool.call', { tool: 'mcp__ask-user-rich__ask_user_rich' }, () => ({ result: 'beneath' }))
    await start($)
    expect(w.tools).toEqual([])
    expect((await ask($)).result).toBe('beneath')
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).result).toBe('asked')
  })
})

describe('the daemon', () => {
  test('absent at start: launched with the configured addresses', { options: { hosts: '127.0.0.1,100.1.2.3', publicHost: '100.1.2.3', port: 47811 } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.launches).toHaveLength(1)
    expect(w.launches[0]?.argv[0]).toBe('bash')
    expect(w.launches[0]?.argv[1]).toMatch(/\/daemon\/launch\.sh$/)
    expect(w.launches[0]?.env).toEqual({
      ASK_USER_RICH_HOME: `${HOME}/.cache/ask-user-rich`,
      ASK_USER_RICH_HOSTS: '127.0.0.1,100.1.2.3',
      ASK_USER_RICH_PUBLIC_HOST: '100.1.2.3',
      ASK_USER_RICH_PORT: '47811',
    })
    expect(w.requests[0]?.socketPath).toBe(SOCKET)
  })

  test('running at the same version and addresses: left alone', async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    expect(w.launches).toEqual([])
    expect(posts(w, '/mod/shutdown')).toEqual([])
  })

  test('an older version with no Round open: shut down and launched again', async ($, on) => {
    const w = world(on, { daemon: { running: true, version: '0.8.0' } })
    await start($)
    expect(posts(w, '/mod/shutdown')).toHaveLength(1)
    expect(w.launches).toHaveLength(1)
  })

  test('another port with a Round open somewhere: left running', { options: { port: 47900 } }, async ($, on) => {
    const w = world(on, { daemon: { running: true, openRounds: 1 } })
    await start($)
    expect(posts(w, '/mod/shutdown')).toEqual([])
    expect(w.launches).toEqual([])
  })
})

describe('ask_user_rich', () => {
  test('opens a Round: the daemon gets the conversation, the model is told to end its turn', { plugins: [reader] }, async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    const res = await ask($, { intro: 'Context.' })
    expect(res.deny).toBeUndefined()
    expect(String(res.result)).toContain('Round 1 is open on the Thread (2 question(s))')
    expect(String(res.result)).toContain('End your turn now')
    expect(String(res.result)).toContain(URLS.public)
    const [sent] = posts(w, '/mod/ask')
    expect(sent?.body).toEqual({ session: 'S1', project: 'demo', cwd: CWD, input: { title: 'Storage', intro: 'Context.', questions: QUESTIONS } })
    const s = await state($)
    expect(s.segment).toEqual({ text: '◐ round 1', tone: 'info', order: 50 })
    expect(s.thread?.openRound).toBe(1)
    expect(Object.values(s.rows)[0]).toMatchObject({ kind: 'ask', round: 1, total: 2, joined: false, urls: URLS })
  })

  test('a notice with both links lands in the transcript, on every Round and follow-up', async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    await ask($)
    await $.tool.call({ tool: 'mcp__ask-user-rich__append_questions', questions: [{ id: 'x', header: 'X?' }] } as never)
    expect(notices(w)).toEqual([
      `Round 1 is open · Internal: ${URLS.internal} · Public: ${URLS.public}`,
      `1 follow-up(s) added to Round 1 · Internal: ${URLS.internal} · Public: ${URLS.public}`,
    ])
  })

  test('without a public host, links name the internal URL alone', async ($, on) => {
    const w = world(on, {
      daemon: { running: true, ask: () => ({ status: 200, body: { thread: thread({ urls: { internal: URLS.internal, public: null } }), round: { n: 1, total: 1, joined: false }, urls: { internal: URLS.internal, public: null } } }) },
    })
    await start($)
    const res = await ask($)
    expect(String(res.result)).not.toContain('Public')
    expect(notices(w)).toEqual([`Round 1 is open · ${URLS.internal}`])
  })

  test('a joined Round says so', async ($, on) => {
    world(on, { daemon: { running: true, ask: () => ({ status: 200, body: { thread: thread(), round: { n: 1, version: 2, total: 3, joined: true }, urls: URLS } }) } })
    await start($)
    const res = await ask($, { title: 'Caching' })
    expect(String(res.result)).toContain('joined the open Round 1 under the heading "Caching" (now 3)')
  })

  test("the daemon's refusal reaches the model as is", async ($, on) => {
    world(on, { daemon: { running: true, ask: () => ({ status: 400, body: { error: 'Invalid interview:\n- questions.0.id: use "secao" instead' } }) } })
    await start($)
    expect((await ask($)).deny).toBe('Invalid interview:\n- questions.0.id: use "secao" instead')
  })

  test('a subagent is refused without reaching the daemon', async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    expect((await ask($, {}, 'agent-1')).deny).toBe(T.SUBAGENT_DENY)
    expect(posts(w, '/mod/ask')).toEqual([])
  })

  test('a daemon that cannot start: refused, and AskUserQuestion allowed for the rest of the turn', async ($, on) => {
    const w = world(on)
    w.launchFails = true
    await start($)
    await $.prompt.submit({ text: 'grill me on storage', origin: { kind: 'composer' }, turnId: 't1' } as never)
    await $.turn.start({ turnId: 't1', text: 'grill me' } as never)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toBe(T.ASK_DENY)
    const res = await ask($)
    expect(String(res.deny)).toContain('the Thread daemon is unavailable (the daemon exited with code 3)')
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).result).toBe('asked')
    await $.turn.start({ turnId: 't2', text: 'next' } as never)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toBe(T.ASK_DENY)
  })

  test('a new Round pushes to the phone only under autopilot', { plugins: [houseRules] }, async ($, on) => {
    const w = world(on, { env: { HOME, HOUSE_RULES_AUTOPILOT: 'on' }, daemon: { running: true } })
    await start($)
    await ask($)
    expect(w.pushes).toEqual([`Round 1 is waiting: Storage ${URLS.public}`])
  })

  test('no autopilot, no push', { plugins: [houseRules] }, async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    await ask($)
    expect(w.pushes).toEqual([])
  })
})

describe('the answers come back by themselves', () => {
  const answers = { id: 'd1', kind: 'answers', round: 1, summary: '"Storage" submitted: 1 answered\n1. [db] Which database? -> Postgres (recommended)', result: { counts: { answered: 1 } } }

  test('idle: the next poll submits them as a prompt, then acknowledges', async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    await ask($)
    w.daemon.pending = [answers]
    await w.clock.advance(1000)
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toMatch(/^Answers to Round 1 \(submitted on the Thread page\)\n\n"Storage" submitted/)
    expect(w.prompts[0]).toContain('Full answers (JSON):\n{"counts":{"answered":1}}')
    expect(posts(w, '/mod/ack').at(-1)?.body).toEqual({ session: 'S1', ids: ['d1'] })
    await w.clock.advance(1000)
    expect(w.prompts).toHaveLength(1)
  })

  test('busy: each is folded into the running turn as a user row', async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    await ask($)
    await $.turn.start({ turnId: 't1', text: 'work' } as never)
    w.daemon.pending = [answers, { id: 'd2', kind: 'message', text: 'Q1: actually SQLite' }]
    await w.clock.advance(1000)
    expect(w.prompts).toEqual([])
    expect(folded(w)).toEqual(['Answers to Round 1 (submitted on the Thread page)', 'Message from the user on the Thread page:'])
    expect(posts(w, '/mod/ack').at(-1)?.body).toEqual({ session: 'S1', ids: ['d1', 'd2'] })
  })

  test('End from the page: the model gets a short note', async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    await ask($)
    w.daemon.pending = [{ id: 'd3', kind: 'end' }]
    await w.clock.advance(1000)
    expect(w.prompts[0]).toMatch(/^The user closed the Thread from the page: the discussion is over/)
  })

  test('a resumed conversation gets what waited for it, with no ask of its own', async ($, on) => {
    const w = world(on, { daemon: { running: true, thread: thread({ openRound: null }), pending: [{ id: 'd4', kind: 'message', text: 'sent while you were gone' }] } })
    await start($)
    await w.clock.advance(1000)
    expect(w.prompts).toEqual(['Message from the user on the Thread page:\n\nsent while you were gone'])
  })
})

describe('the AskUserQuestion guard', () => {
  test('passes with no Thread and no grilling', async ($, on) => {
    world(on, { daemon: { running: true } })
    await start($)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).result).toBe('asked')
  })

  test('denied while a Thread is open, allowed again once it is closed', async ($, on) => {
    world(on, { daemon: { running: true } })
    await start($)
    await ask($)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toBe(T.ASK_DENY)
    const closed = await $.tool.call({ tool: 'mcp__ask-user-rich__close_thread', summary: 'Decided.' } as never)
    expect(closed.result).toBe(T.CLOSED_RESULT)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).result).toBe('asked')
  })

  test('denied once a grilling skill loads, which also gets the addendum', async ($, on) => {
    world(on, { daemon: { running: true } })
    on('skill.prompt', (_$, e) => ({ text: `skill ${e.skill}` }))
    await start($)
    const out = await $.skill.prompt({ skill: 'mattpocock-skills:grilling', text: '' } as never)
    expect(out.text).toBe(`skill mattpocock-skills:grilling\n\n${T.GRILLING_ADDENDUM}`)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toBe(T.ASK_DENY)
  })

  test('a prompt that merely mentions grilling arms nothing; "grill me" does', async ($, on) => {
    world(on, { daemon: { running: true } })
    await start($)
    await $.prompt.submit({ text: 'the grilling notes are in the memory file', origin: { kind: 'composer' }, turnId: 't1' } as never)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).result).toBe('asked')
    await $.prompt.submit({ text: 'grill me about the cache', origin: { kind: 'composer' }, turnId: 't2' } as never)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toBe(T.ASK_DENY)
  })

  test('/clear disarms it and forgets the Thread', { plugins: [reader] }, async ($, on) => {
    world(on, { daemon: { running: true } })
    await start($)
    await ask($)
    await $.session.end({ reason: 'clear' } as never)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).result).toBe('asked')
    expect((await state($)).segment).toBeNull()
  })
})

describe('the page follows the conversation', () => {
  test('presence: working at a turn, the tool it runs, idle at its end', async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    await ask($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    expect(posts(w, '/mod/presence').map((r) => [r.body?.state, r.body?.chip])).toEqual([
      ['working', null],
      ['working', 'Bash npm test'],
      ['idle', null],
    ])
  })

  test('no Thread, no presence', async ($, on) => {
    const w = world(on, { daemon: { running: true } })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    expect(posts(w, '/mod/presence')).toEqual([])
  })

  test('the usage instructions join the system prompt while enabled', async ($, on) => {
    world(on, { daemon: { running: true } })
    on('prompt.compose', () => ({ sections: [] }))
    await start($)
    const out = await $.prompt.compose({ model: 'claude-test', promptModel: 'claude-test', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(out.sections.find((s) => s.id === T.SECTION_ID)?.text).toBe(T.INSTRUCTIONS)
  })
})

describe('drawing', () => {
  test('the ask row draws its Round and both links, on every surface', { plugins: [reader] }, async ($, on) => {
    world(on, { daemon: { running: true } })
    await start($)
    await ask($)
    const id = Object.keys((await state($)).rows)[0] ?? ''
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'ask-user-rich',
        surface,
        component: 'ToolUse',
        requestId: id,
        props: { tool_use_id: id, tool: T.ASK_TOOL, input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: 'x' },
      })
      const md = await ui.find({ type: 'Markdown' })
      expect(String(md?.props.text)).toContain('**Round 1 open** · 2 question(s) · Storage')
      expect(String(md?.props.text)).toContain(`- Internal (this machine): ${URLS.internal}`)
      expect(String(md?.props.text)).toContain(`- Public (other devices): ${URLS.public}`)
      await ui.unmount()
    }
  })

  test('a delivered prompt draws as one compact line unless expanded', async ($, on) => {
    world(on, { daemon: { running: true } })
    await start($)
    const text = 'The ask-user-rich plugin sent a message:\nAnswers to Round 2 (submitted on the Thread page)\n\n"S" submitted\n1. [a] A? -> x\n2. [b] B? -> y'
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'ask-user-rich',
        surface,
        component: 'UserMessage',
        props: { text, origin: { kind: 'plugin', name: 'ask-user-rich' }, isExpanded: false } as never,
      })
      expect((await ui.find({ type: 'Text' }))?.text).toBe('◆ Answers to Round 2 (submitted on the Thread page) · 2 answer(s) (ctrl+o to expand)')
      await ui.unmount()
    }
  })
})
