// Stream adapter: socc's query() AsyncGenerator → SSE event stream.
//
// The engine yields a tagged union (Message | StreamEvent | …) whose
// shapes live inside the socc package. We deliberately don't import the
// full types here — we pattern-match on runtime discriminants (`.type`)
// and project into a small stable contract the plugin can stream to
// clients. This keeps the plugin loosely coupled to socc's internals
// so a minor socc refactor doesn't break the wire protocol.
//
// Wire contract (agreed with Vantage frontend):
//   session.ready   — emitted once after the worker boots
//   message.start   — a new assistant turn begins
//   content.delta   — incremental text token(s)
//   content.done    — assistant turn text is complete
//   tool.call.start — a tool invocation begins
//   tool.call.end   — a tool invocation finishes (success or error)
//   message.end     — the whole assistant response is complete
//   error           — something broke; retriable flag included
//   heartbeat       — periodic no-op for proxy keepalive (emitted by
//                     the server loop, not here)

export type SoccUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export type SoccStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'error'
  | 'aborted'
  | null

export type SoccStreamEvent =
  | { type: 'session.ready'; sessionId: string }
  | { type: 'message.start'; messageId: string }
  | { type: 'content.delta'; messageId: string; text: string }
  | {
      type: 'content.done'
      messageId: string
      content: string
      usage: SoccUsage | null
    }
  | {
      type: 'tool.call.start'
      messageId: string
      toolUseId: string
      toolName: string
    }
  | {
      type: 'tool.call.end'
      messageId: string
      toolUseId: string
      ok: boolean
      errorMessage?: string
    }
  | { type: 'message.end'; messageId: string; stopReason: SoccStopReason }
  | { type: 'error'; code?: string; message: string; retriable: boolean }
  | { type: 'heartbeat'; ts: number }

// Minimal shapes we need to discriminate on. We treat these as
// structural contracts; anything extra on the real object is ignored.
type RawAssistantText = {
  type: 'text'
  text: string
}
type RawToolUse = {
  type: 'tool_use'
  id: string
  name: string
}
type RawContent = RawAssistantText | RawToolUse | { type: string }

type RawAssistantMessage = {
  type: 'assistant'
  uuid?: string
  id?: string
  message?: {
    id?: string
    content?: RawContent[] | string
  }
  content?: RawContent[] | string
}

type RawStreamTextDelta = {
  type: 'stream_event'
  event?:
    | {
        type: 'content_block_delta'
        index?: number
        delta?: { type: 'text_delta'; text: string } | { type: string }
      }
    | {
        type: 'message_delta'
        delta?: { stop_reason?: string | null }
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }
    | { type: 'message_stop' }
    | { type: string }
  messageId?: string
}

type RawToolResult = {
  type: 'tool_result' | 'user' | 'tool_use_summary'
  toolUseId?: string
  tool_use_id?: string
  message?: {
    content?: Array<{
      type?: string
      tool_use_id?: string
      is_error?: boolean
      content?: string
    }>
  }
  isError?: boolean
  is_error?: boolean
  errorMessage?: string
}

type RawEvent = RawAssistantMessage | RawStreamTextDelta | RawToolResult | { type?: string }

// Extracts a best-effort message id from whatever shape the engine sends.
// We never make this up: if we can't find one, callers should ignore the
// event rather than invent an id.
function extractMessageId(ev: RawAssistantMessage): string | null {
  return ev.message?.id ?? ev.uuid ?? ev.id ?? null
}

function extractStreamMessageId(ev: RawStreamTextDelta): string | null {
  return ev.messageId ?? null
}

type MessageState = {
  content: string
  usage: SoccUsage | null
  stopReason: SoccStopReason
}

function normalizeStopReason(raw: string | null | undefined): SoccStopReason {
  if (raw === null || raw === undefined) return null
  switch (raw) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
      return raw
    default:
      return null
  }
}

export type StreamProjection = {
  step: (ev: RawEvent) => SoccStreamEvent[]
  // Emits a trailing message.end if a turn is still open. Used when the
  // engine generator returns without a message_delta/stop event, or when
  // the worker is aborted mid-stream. Callers may pass `overrideStopReason`
  // to override (e.g. 'aborted' on client disconnect, 'error' on upstream
  // failure); otherwise the projection uses whatever it collected.
  finalize: (overrideStopReason?: SoccStopReason) => SoccStreamEvent[]
  getCurrentMessageId: () => string | null
}

// Drives the full lifecycle: translates each engine yield into zero or
// more SoccStreamEvents. State is kept in a closure so we can emit
// message.start/message.end once per logical assistant turn.
export function createStreamProjection(): StreamProjection {
  let currentMessageId: string | null = null
  const openToolCalls = new Set<string>()
  const messageState = new Map<string, MessageState>()

  function stateFor(mid: string): MessageState {
    let st = messageState.get(mid)
    if (!st) {
      st = { content: '', usage: null, stopReason: null }
      messageState.set(mid, st)
    }
    return st
  }

  const step = (ev: RawEvent): SoccStreamEvent[] => {
    const kind = (ev as { type?: string }).type

    // Assistant message (final or in-progress). The engine emits one of
    // these per turn; content is an array of text/tool_use blocks.
    if (kind === 'assistant') {
      const am = ev as RawAssistantMessage
      const mid = extractMessageId(am)
      if (!mid) return []

      const out: SoccStreamEvent[] = []
      // If a previous turn never closed, close it before opening a new one.
      if (currentMessageId && currentMessageId !== mid) {
        const prev = stateFor(currentMessageId)
        out.push({
          type: 'message.end',
          messageId: currentMessageId,
          stopReason: prev.stopReason,
        })
        openToolCalls.clear()
      }
      if (currentMessageId !== mid) {
        out.push({ type: 'message.start', messageId: mid })
        currentMessageId = mid
      }

      const st = stateFor(mid)
      const content = am.message?.content ?? am.content ?? []
      if (typeof content === 'string') {
        if (content.length > 0) {
          st.content += content
          out.push({ type: 'content.delta', messageId: mid, text: content })
        }
      } else {
        for (const block of content) {
          if (block.type === 'text') {
            const t = (block as RawAssistantText).text
            if (t && t.length > 0) {
              st.content += t
              out.push({ type: 'content.delta', messageId: mid, text: t })
            }
          } else if (block.type === 'tool_use') {
            const tu = block as RawToolUse
            openToolCalls.add(tu.id)
            out.push({
              type: 'tool.call.start',
              messageId: mid,
              toolUseId: tu.id,
              toolName: tu.name,
            })
          }
        }
      }
      // Completed text block in a final assistant message; emit content.done
      // with the aggregated text and any usage we've already picked up.
      out.push({
        type: 'content.done',
        messageId: mid,
        content: st.content,
        usage: st.usage,
      })
      return out
    }

    // Streaming token delta from the provider SDK (Anthropic SSE shape).
    // Fires many times per turn; message.start must have been emitted
    // earlier, otherwise we silently drop (the engine flushes a full
    // assistant message on turn close anyway).
    if (kind === 'stream_event') {
      const se = ev as RawStreamTextDelta
      const mid = extractStreamMessageId(se) ?? currentMessageId
      if (!mid) return []
      const evType = se.event?.type
      if (evType === 'content_block_delta') {
        const delta = (se.event as { delta?: unknown }).delta as
          | { type: string; text?: string }
          | undefined
        if (delta?.type === 'text_delta') {
          const text = delta.text ?? ''
          if (text.length > 0) {
            stateFor(mid).content += text
            return [{ type: 'content.delta', messageId: mid, text }]
          }
        }
        return []
      }
      // Anthropic-style terminal metadata: carries stop_reason + usage.
      if (evType === 'message_delta') {
        const md = se.event as {
          delta?: { stop_reason?: string | null }
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        }
        const st = stateFor(mid)
        const sr = normalizeStopReason(md.delta?.stop_reason)
        if (sr) st.stopReason = sr
        if (md.usage) {
          st.usage = {
            inputTokens: md.usage.input_tokens,
            outputTokens: md.usage.output_tokens,
            cacheReadInputTokens: md.usage.cache_read_input_tokens,
            cacheCreationInputTokens: md.usage.cache_creation_input_tokens,
          }
        }
        return []
      }
      return []
    }

    // Tool result landed as a user-role message with tool_result blocks,
    // or as a tool_use_summary. Close any open tool calls referenced.
    if (kind === 'user' || kind === 'tool_use_summary' || kind === 'tool_result') {
      const tr = ev as RawToolResult
      const mid = currentMessageId
      if (!mid) return []
      const out: SoccStreamEvent[] = []

      const directId = tr.toolUseId ?? tr.tool_use_id
      if (directId && openToolCalls.has(directId)) {
        out.push({
          type: 'tool.call.end',
          messageId: mid,
          toolUseId: directId,
          ok: !(tr.isError ?? tr.is_error ?? false),
          errorMessage: tr.errorMessage,
        })
        openToolCalls.delete(directId)
      } else {
        const blocks = tr.message?.content ?? []
        for (const b of blocks) {
          if (b.type === 'tool_result' && b.tool_use_id && openToolCalls.has(b.tool_use_id)) {
            out.push({
              type: 'tool.call.end',
              messageId: mid,
              toolUseId: b.tool_use_id,
              ok: !(b.is_error ?? false),
              errorMessage: b.is_error ? b.content : undefined,
            })
            openToolCalls.delete(b.tool_use_id)
          }
        }
      }
      return out
    }

    // Unknown / unhandled (tombstone, request_start, attachment, etc.).
    // Explicitly ignored — we don't forward internals to clients.
    return []
  }

  const finalize = (overrideStopReason?: SoccStopReason): SoccStreamEvent[] => {
    if (!currentMessageId) return []
    const mid = currentMessageId
    const st = stateFor(mid)
    const out: SoccStreamEvent[] = [
      {
        type: 'message.end',
        messageId: mid,
        stopReason: overrideStopReason ?? st.stopReason,
      },
    ]
    currentMessageId = null
    openToolCalls.clear()
    return out
  }

  return {
    step,
    finalize,
    getCurrentMessageId: () => currentMessageId,
  }
}

// SSE wire encoding. Single event per call; `id` is optional but useful
// for Last-Event-ID reconnection semantics. The Content-Type header is
// `text/event-stream; charset=utf-8` (set by the server, not here).
export function encodeSseEvent(ev: SoccStreamEvent, eventId?: string | number): string {
  const data = JSON.stringify(ev)
  const lines: string[] = []
  if (eventId !== undefined) lines.push(`id: ${eventId}`)
  lines.push(`event: ${ev.type}`)
  lines.push(`data: ${data}`)
  lines.push('') // trailing empty line terminates the event
  return lines.join('\n') + '\n'
}
