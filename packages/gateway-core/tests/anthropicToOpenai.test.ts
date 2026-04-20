import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { translateAnthropicToOpenAI } from '../src/translate/anthropicToOpenai.js'
import type { AnthropicMessagesResponse, OpenAIChatCompletionResponse } from '../src/translate/types.js'

const FIXTURES_DIR = join(import.meta.dirname, '../test/fixtures/anthropic-responses')

// Fixed timestamp for deterministic fixture comparisons
const FIXED_NOW = () => 1000000000

function loadFixture<T>(name: string, suffix: string): T {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.${suffix}.json`), 'utf-8')
  return JSON.parse(raw) as T
}

const FIXTURE_NAMES = [
  'plain-text',
  'max-tokens-truncated',
  'single-tool-use',
  'text-plus-tool-use',
] as const

describe('translateAnthropicToOpenAI', () => {
  for (const name of FIXTURE_NAMES) {
    it(`fixture: ${name}`, () => {
      const anthropic = loadFixture<AnthropicMessagesResponse>(name, 'anthropic')
      const expected = loadFixture<OpenAIChatCompletionResponse>(name, 'openai')
      const actual = translateAnthropicToOpenAI(anthropic, { now: FIXED_NOW })
      expect(actual).toEqual(expected)
    })
  }

  it('stop_reason end_turn → finish_reason stop', () => {
    const result = translateAnthropicToOpenAI(
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      { now: FIXED_NOW },
    )
    expect(result.choices[0]?.finish_reason).toBe('stop')
  })

  it('stop_reason stop_sequence → finish_reason stop', () => {
    const result = translateAnthropicToOpenAI(
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-3-haiku-20240307',
        stop_reason: 'stop_sequence',
        stop_sequence: '\n\nHuman:',
        usage: { input_tokens: 10, output_tokens: 3 },
      },
      { now: FIXED_NOW },
    )
    expect(result.choices[0]?.finish_reason).toBe('stop')
  })

  it('stop_reason max_tokens → finish_reason length', () => {
    const result = translateAnthropicToOpenAI(
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Truncated' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'max_tokens',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 100 },
      },
      { now: FIXED_NOW },
    )
    expect(result.choices[0]?.finish_reason).toBe('length')
  })

  it('stop_reason tool_use → finish_reason tool_calls', () => {
    const result = translateAnthropicToOpenAI(
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'fn', input: {} }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      },
      { now: FIXED_NOW },
    )
    expect(result.choices[0]?.finish_reason).toBe('tool_calls')
  })

  it('usage: includes cache tokens in prompt_tokens', () => {
    const result = translateAnthropicToOpenAI(
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 80,
          output_tokens: 22,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
      },
      { now: FIXED_NOW },
    )
    expect(result.usage.prompt_tokens).toBe(95) // 80 + 10 + 5
    expect(result.usage.completion_tokens).toBe(22)
    expect(result.usage.total_tokens).toBe(117)
  })

  it('only tool_use blocks → content is null', () => {
    const result = translateAnthropicToOpenAI(
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'fn', input: { x: 1 } }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 10 },
      },
      { now: FIXED_NOW },
    )
    expect(result.choices[0]?.message.content).toBeNull()
    expect(result.choices[0]?.message.tool_calls).toHaveLength(1)
  })

  it('mixed text + tool_use → content string + tool_calls array', () => {
    const result = translateAnthropicToOpenAI(
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure, ' },
          { type: 'text', text: 'let me call that.' },
          { type: 'tool_use', id: 'tu_2', name: 'do_thing', input: { a: 'b' } },
        ],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 20 },
      },
      { now: FIXED_NOW },
    )
    expect(result.choices[0]?.message.content).toBe('Sure, let me call that.')
    expect(result.choices[0]?.message.tool_calls).toHaveLength(1)
    expect(result.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe(
      JSON.stringify({ a: 'b' }),
    )
  })

  it('id and model passthrough; object is chat.completion', () => {
    const result = translateAnthropicToOpenAI(
      {
        id: 'msg_unique_id_xyz',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        model: 'claude-opus-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 2 },
      },
      { now: FIXED_NOW },
    )
    expect(result.id).toBe('msg_unique_id_xyz')
    expect(result.model).toBe('claude-opus-4-5')
    expect(result.object).toBe('chat.completion')
  })

  it('created uses injected now()', () => {
    const result = translateAnthropicToOpenAI(
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 2 },
      },
      { now: () => 9999999000 },
    )
    expect(result.created).toBe(9999999)
  })
})
