// The mod's pure rules, read directly: what is mirrored, how deliveries are planned and drawn.
import { describe, expect, test } from 'claude-code/testing'

import { deliveryText, plan } from '../hooks/lib/delivery'
import { denyAsk, isGrillingSkill, isGrillPrompt } from '../hooks/lib/grilling'
import { chipOf, mirroredOf } from '../hooks/lib/mirror'
import { segmentOf } from '../hooks/lib/segment'

const model = { kind: 'model', model: 'm' }

describe('mirroring', () => {
  test("the model's text and its tool calls as chips; thinking and the mod's own tools never", () => {
    const out = mirroredOf({
      door: 'response',
      origin: model,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'hidden' },
          { type: 'text', text: 'I updated CONTEXT.md.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/work/demo/CONTEXT.md' } },
          { type: 'tool_use', name: 'mcp__ask-user-rich__ask_user_rich', input: {} },
          { type: 'text', text: '   ' },
        ],
      },
    })
    expect(out).toEqual([
      { kind: 'assistant', text: 'I updated CONTEXT.md.' },
      { kind: 'chip', text: 'Edit CONTEXT.md' },
    ])
  })

  test("the person's prompt, from any of their surfaces; never a plugin's or a meta row", () => {
    const prompt = (origin: { kind: string; name?: string }, isMeta?: true) =>
      mirroredOf({ door: 'prompt', origin, message: { role: 'user', ...(isMeta ? { isMeta } : {}), content: [{ type: 'text', text: 'looks good' }] } })
    expect(prompt({ kind: 'composer' })).toEqual([{ kind: 'user', text: 'looks good' }])
    expect(prompt({ kind: 'bridge' })).toEqual([{ kind: 'user', text: 'looks good' }])
    expect(prompt({ kind: 'plugin', name: 'ask-user-rich' })).toEqual([])
    expect(prompt({ kind: 'composer' }, true)).toEqual([])
    expect(mirroredOf({ door: 'tool-result', origin: { kind: 'tool' }, message: { role: 'user', content: [{ type: 'text', text: 'output' }] } })).toEqual([])
  })

  test('chips name the tool and a short target', () => {
    expect(chipOf('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Bash Run the tests')
    expect(chipOf('Read', { file_path: '/a/b/hub.js' })).toBe('Read hub.js')
    expect(chipOf('mcp__stack__ensure', {})).toBe('stack ensure')
    expect(chipOf('Grep', { pattern: 'x'.repeat(200) }).length).toBe(80)
  })
})

describe('delivery', () => {
  const answers = { id: 'a', kind: 'answers' as const, round: 2, summary: 'S\n1. [x] X? -> y', result: { ok: 1 } }
  const message = { id: 'm', kind: 'message' as const, text: 'hi' }

  test('one prompt with everything, in order', () => {
    expect(plan([answers, message])).toEqual({ prompt: `${deliveryText(answers)}\n\n---\n\n${deliveryText(message)}`, ids: ['a', 'm'] })
  })
})

describe('grilling and the guard', () => {
  test('what arms it', () => {
    expect(isGrillingSkill('mattpocock-skills:grill-with-docs')).toBe(true)
    expect(isGrillingSkill('mattpocock-skills:tdd')).toBe(false)
    expect(isGrillPrompt('grill me about X')).toBe(true)
    expect(isGrillPrompt('the grilling notes')).toBe(false)
  })

  test('denied while armed or open, unless ask-user-rich failed in this turn', () => {
    expect(denyAsk({ grilling: false, threadOpen: false, askFailedTurnId: null, turnId: 't' })).toBe(false)
    expect(denyAsk({ grilling: true, threadOpen: false, askFailedTurnId: null, turnId: 't' })).toBe(true)
    expect(denyAsk({ grilling: false, threadOpen: true, askFailedTurnId: 's', turnId: 't' })).toBe(true)
    expect(denyAsk({ grilling: false, threadOpen: true, askFailedTurnId: 't', turnId: 't' })).toBe(false)
  })
})

describe('the band segment', () => {
  test('only while a Round waits', () => {
    const t = { id: 'i', token: 'k', state: 'open' as const, openRound: 3, urls: { internal: 'a', public: null } }
    expect(segmentOf(true, t)).toEqual({ text: '◐ round 3', tone: 'info', order: 50 })
    expect(segmentOf(true, { ...t, openRound: null })).toBeNull()
    expect(segmentOf(false, t)).toBeNull()
    expect(segmentOf(true, null)).toBeNull()
  })
})
