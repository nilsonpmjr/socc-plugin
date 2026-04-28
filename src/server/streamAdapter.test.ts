import { describe, expect, test } from 'bun:test'
import {
  createStreamProjection,
  encodeSseEvent,
  type SoccStreamEvent,
} from './streamAdapter.ts'

describe('streamAdapter.createStreamProjection', () => {
  test('opens message, emits text delta, closes with content.done and message.end on next turn', () => {
    const { step } = createStreamProjection()
    const out1 = step({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'hello world' }],
      },
    })
    // first assistant message: start + delta + content.done
    expect(out1.map((e) => e.type)).toEqual(['message.start', 'content.delta', 'content.done'])
    expect(out1[0]).toMatchObject({ type: 'message.start', messageId: 'msg_1' })
    expect(out1[1]).toMatchObject({ type: 'content.delta', text: 'hello world' })
    expect(out1[2]).toMatchObject({
      type: 'content.done',
      messageId: 'msg_1',
      content: 'hello world',
      usage: null,
    })

    // a new assistant turn closes the previous one
    const out2 = step({
      type: 'assistant',
      message: {
        id: 'msg_2',
        content: [{ type: 'text', text: 'next' }],
      },
    })
    expect(out2.map((e) => e.type)).toEqual([
      'message.end',
      'message.start',
      'content.delta',
      'content.done',
    ])
    expect(out2[0]).toMatchObject({ type: 'message.end', messageId: 'msg_1', stopReason: null })
  })

  test('streaming deltas emit content.delta without reopening the turn', () => {
    const { step } = createStreamProjection()
    step({ type: 'assistant', message: { id: 'msg_1', content: [] } })

    const out = step({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tok' } },
    })
    expect(out).toEqual([{ type: 'content.delta', messageId: 'msg_1', text: 'tok' }])
  })

  test('message_delta stream_event captures stop_reason + usage for later content.done/message.end', () => {
    const { step, finalize } = createStreamProjection()
    step({ type: 'assistant', message: { id: 'msg_1', content: [] } })
    step({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 12, output_tokens: 34 },
      },
    })
    const finalEvents = finalize()
    expect(finalEvents).toEqual([
      { type: 'message.end', messageId: 'msg_1', stopReason: 'end_turn' },
    ])
  })

  test('tool_use opens tool.call.start; matching tool_result closes with ok=true', () => {
    const { step } = createStreamProjection()
    const open = step({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'grep' }],
      },
    })
    expect(open.some((e) => e.type === 'tool.call.start')).toBe(true)

    const close = step({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }],
      },
    })
    expect(close).toEqual([
      { type: 'tool.call.done', messageId: 'msg_1', toolUseId: 'toolu_1', ok: true, errorMessage: undefined },
    ])
  })

  test('tool_result with is_error emits ok=false and carries the error content', () => {
    const { step } = createStreamProjection()
    step({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'run' }] },
    })
    const out = step({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }],
      },
    })
    expect(out[0]).toMatchObject({ type: 'tool.call.done', ok: false, errorMessage: 'boom' })
  })

  test('unknown event types are silently ignored', () => {
    const { step } = createStreamProjection()
    expect(step({ type: 'tombstone' } as never)).toEqual([])
    expect(step({ type: 'request_start' } as never)).toEqual([])
    expect(step({} as never)).toEqual([])
  })

  test('assistant message without a resolvable id is dropped', () => {
    const { step } = createStreamProjection()
    expect(
      step({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
    ).toEqual([])
  })
})

describe('streamAdapter.finalize', () => {
  test('emits message.end when a turn is still open; override wins', () => {
    const { step, finalize } = createStreamProjection()
    step({ type: 'assistant', message: { id: 'msg_9', content: [] } })
    expect(finalize('aborted')).toEqual([
      { type: 'message.end', messageId: 'msg_9', stopReason: 'aborted' },
    ])
  })
  test('is a no-op when nothing is open', () => {
    const { finalize } = createStreamProjection()
    expect(finalize()).toEqual([])
  })
})

describe('streamAdapter.encodeSseEvent', () => {
  test('emits event/data lines terminated by a blank line', () => {
    const ev: SoccStreamEvent = { type: 'content.delta', messageId: 'm', text: 'hi' }
    const out = encodeSseEvent(ev)
    expect(out.startsWith('event: content.delta\n')).toBe(true)
    expect(out).toContain('data: {"type":"content.delta"')
    expect(out.endsWith('\n\n')).toBe(true)
  })
  test('includes id line when provided', () => {
    const out = encodeSseEvent({ type: 'heartbeat', ts: 1 }, 42)
    expect(out.startsWith('id: 42\n')).toBe(true)
  })
})
