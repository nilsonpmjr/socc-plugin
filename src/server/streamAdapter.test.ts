import { describe, expect, test } from 'bun:test'
import {
  closeProjection,
  createStreamProjection,
  encodeSseEvent,
  type SoccStreamEvent,
} from './streamAdapter.ts'

describe('streamAdapter.createStreamProjection', () => {
  test('opens message, emits text delta, closes with content.done and message.end on next turn', () => {
    const project = createStreamProjection()
    const out1 = project({
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

    // a new assistant turn closes the previous one
    const out2 = project({
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
    expect(out2[0]).toMatchObject({ type: 'message.end', messageId: 'msg_1' })
  })

  test('streaming deltas emit content.delta without reopening the turn', () => {
    const project = createStreamProjection()
    project({ type: 'assistant', message: { id: 'msg_1', content: [] } })

    const out = project({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tok' } },
    })
    expect(out).toEqual([{ type: 'content.delta', messageId: 'msg_1', text: 'tok' }])
  })

  test('tool_use opens tool.call.start; matching tool_result closes with ok=true', () => {
    const project = createStreamProjection()
    const open = project({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'grep' }],
      },
    })
    expect(open.some((e) => e.type === 'tool.call.start')).toBe(true)

    const close = project({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }],
      },
    })
    expect(close).toEqual([
      { type: 'tool.call.end', messageId: 'msg_1', toolUseId: 'toolu_1', ok: true, errorMessage: undefined },
    ])
  })

  test('tool_result with is_error emits ok=false and carries the error content', () => {
    const project = createStreamProjection()
    project({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'run' }] },
    })
    const out = project({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }],
      },
    })
    expect(out[0]).toMatchObject({ type: 'tool.call.end', ok: false, errorMessage: 'boom' })
  })

  test('unknown event types are silently ignored', () => {
    const project = createStreamProjection()
    expect(project({ type: 'tombstone' } as never)).toEqual([])
    expect(project({ type: 'request_start' } as never)).toEqual([])
    expect(project({} as never)).toEqual([])
  })

  test('assistant message without a resolvable id is dropped', () => {
    const project = createStreamProjection()
    expect(
      project({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
    ).toEqual([])
  })
})

describe('streamAdapter.closeProjection', () => {
  test('emits message.end when a turn is still open', () => {
    expect(closeProjection('msg_9')).toEqual([{ type: 'message.end', messageId: 'msg_9' }])
  })
  test('is a no-op when nothing is open', () => {
    expect(closeProjection(null)).toEqual([])
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
    const out = encodeSseEvent({ type: 'heartbeat' }, 42)
    expect(out.startsWith('id: 42\n')).toBe(true)
  })
})
