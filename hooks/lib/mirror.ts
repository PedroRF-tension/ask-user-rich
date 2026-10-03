// What of a conversation row the Thread page mirrors: the model's text, the person's prompts, and a
// one-line chip per tool call. Never thinking, never tool output.
import { OWN_TOOLS, PLUGIN } from './texts'
import { isUserOrigin } from './grilling'

export type Mirrored = { kind: 'assistant' | 'user' | 'chip'; text: string }

type Block = { type: string; text?: string; name?: string; input?: unknown }
type Row = { door: string; origin: { kind: string; name?: string }; message: { role?: string; isMeta?: true; content: readonly Block[] } }

const CHIP_MAX = 80

function short(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > CHIP_MAX ? `${line.slice(0, CHIP_MAX - 1)}…` : line
}

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

/** `Edit CONTEXT.md`, `Bash npm test`, `Agent: explore the mods API`. */
export function chipOf(tool: string, input: unknown): string {
  const a = (input ?? {}) as Record<string, unknown>
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool
  const str = (key: string) => (typeof a[key] === 'string' ? (a[key] as string) : null)
  const target =
    (str('file_path') && base(str('file_path')!)) ??
    (str('notebook_path') && base(str('notebook_path')!)) ??
    str('description') ??
    str('command') ??
    str('pattern') ??
    str('query') ??
    str('url') ??
    str('skill') ??
    str('prompt')
  return short(target ? `${name} ${target}` : name)
}

export function mirroredOf(row: Row): Mirrored[] {
  const out: Mirrored[] = []
  if (row.door === 'response' && row.message.role === 'assistant') {
    for (const block of row.message.content) {
      if (block.type === 'text' && block.text && block.text.trim()) out.push({ kind: 'assistant', text: block.text })
      else if (block.type === 'tool_use' && block.name && !OWN_TOOLS.has(block.name)) out.push({ kind: 'chip', text: chipOf(block.name, block.input) })
    }
    return out
  }
  if (row.door === 'prompt' && row.message.isMeta !== true && isUserOrigin(row.origin) && row.origin.name !== PLUGIN) {
    const text = row.message.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (text) out.push({ kind: 'user', text })
  }
  return out
}
