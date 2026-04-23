// Bun Worker entrypoint — runs one socc session in isolation.
//
// Why a Worker per session: socc's `src/bootstrap/state.ts` exports a
// module-level STATE singleton that mutates on sessionId/cwd/provider
// changes. Running multiple sessions in the same JS realm would race on
// that singleton. A Worker gives each session its own realm (and its
// own STATE), at the cost of ~10–30MB resident per idle session.
//
// Lifecycle:
//   1. Pool spawns the worker with postMessage({type:'init', …}).
//   2. Worker loads @vantagesec/socc/engine (lazy, async).
//   3. Pool sends {type:'prompt', …}; worker drives query() and streams
//      raw engine events back via postMessage({type:'event', …}).
//   4. On turn end the worker posts {type:'turn_end'}.
//   5. Pool can send {type:'abort'} to cancel an in-flight turn, or
//      {type:'shutdown'} to terminate. Both trigger AbortController.
//
// The worker never talks to Mongo or the outside world directly. Secrets
// (decrypted provider API key) arrive as part of the init payload and
// live only inside this realm.

/// <reference lib="webworker" />

import type {} from 'bun'

// ── Inbound messages (pool → worker) ───────────────────────────────────

export type WorkerInitMessage = {
  type: 'init'
  sessionId: string
  userId: string
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  apiKey: string
  baseUrl?: string
  model: string
  maxOutputTokens: number
  systemPrompt?: string
}

export type WorkerPromptMessage = {
  type: 'prompt'
  turnId: string
  text: string
}

export type WorkerAbortMessage = {
  type: 'abort'
  turnId?: string
}

export type WorkerShutdownMessage = {
  type: 'shutdown'
}

export type WorkerInboundMessage =
  | WorkerInitMessage
  | WorkerPromptMessage
  | WorkerAbortMessage
  | WorkerShutdownMessage

// ── Outbound messages (worker → pool) ─────────────────────────────────

export type WorkerReadyMessage = {
  type: 'ready'
  sessionId: string
}

export type WorkerEventMessage = {
  type: 'event'
  turnId: string
  event: unknown // opaque engine yield; streamAdapter projects it
}

export type WorkerTurnEndMessage = {
  type: 'turn_end'
  turnId: string
  reason: 'complete' | 'aborted' | 'error'
  errorMessage?: string
}

export type WorkerErrorMessage = {
  type: 'error'
  message: string
  fatal: boolean
}

export type WorkerOutboundMessage =
  | WorkerReadyMessage
  | WorkerEventMessage
  | WorkerTurnEndMessage
  | WorkerErrorMessage

// ── Worker body (only runs inside a Worker context) ────────────────────

declare const self: Worker & { close: () => void }

type WorkerState = {
  init: WorkerInitMessage | null
  currentTurn: { id: string; abort: AbortController } | null
}

const state: WorkerState = { init: null, currentTurn: null }

function post(msg: WorkerOutboundMessage): void {
  self.postMessage(msg)
}

async function runTurn(prompt: WorkerPromptMessage): Promise<void> {
  const init = state.init
  if (!init) {
    post({ type: 'error', message: 'prompt before init', fatal: true })
    return
  }
  if (state.currentTurn) {
    post({
      type: 'turn_end',
      turnId: prompt.turnId,
      reason: 'error',
      errorMessage: 'another turn is already in flight',
    })
    return
  }

  const abort = new AbortController()
  state.currentTurn = { id: prompt.turnId, abort }

  try {
    // Lazy import so the worker boots fast and the pool can send init
    // before the engine bundle finishes loading.
    const { query } = await import('@vantagesec/socc/engine')

    // Build the minimal QueryParams. We pass a narrow canUseTool that
    // denies everything for the MVP (chat-only, no tools yet); future
    // phases will plug in a real policy backed by user permissions.
    // The shape uses `as never` pin-holes because socc's types aren't
    // exported in the engine bundle — see PRD decision on fat engine.mjs.
    // biome-ignore lint: structural typing, tightened as socc exports stabilize
    const params: Record<string, unknown> = {
      messages: [
        {
          type: 'user',
          uuid: prompt.turnId,
          message: { role: 'user', content: prompt.text },
        },
      ],
      systemPrompt: init.systemPrompt ?? '',
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({ behavior: 'deny', message: 'tools disabled in MVP' }),
      toolUseContext: {
        abortController: abort,
        options: { model: init.model, maxOutputTokens: init.maxOutputTokens },
      },
      querySource: 'socc-plugin',
    }

    for await (const event of query(params as never) as AsyncIterable<unknown>) {
      if (abort.signal.aborted) break
      post({ type: 'event', turnId: prompt.turnId, event })
    }

    post({
      type: 'turn_end',
      turnId: prompt.turnId,
      reason: abort.signal.aborted ? 'aborted' : 'complete',
    })
  } catch (err) {
    post({
      type: 'turn_end',
      turnId: prompt.turnId,
      reason: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    })
  } finally {
    state.currentTurn = null
  }
}

self.addEventListener('message', (ev: MessageEvent<WorkerInboundMessage>) => {
  const msg = ev.data
  switch (msg.type) {
    case 'init':
      if (state.init) {
        post({ type: 'error', message: 'already initialized', fatal: true })
        return
      }
      state.init = msg
      post({ type: 'ready', sessionId: msg.sessionId })
      return
    case 'prompt':
      void runTurn(msg)
      return
    case 'abort':
      if (state.currentTurn && (!msg.turnId || msg.turnId === state.currentTurn.id)) {
        state.currentTurn.abort.abort()
      }
      return
    case 'shutdown':
      state.currentTurn?.abort.abort()
      // Give in-flight postMessages a tick to flush before close.
      setTimeout(() => self.close(), 10)
      return
  }
})
