// Test-only Worker body — simulates socc's STATE singleton pattern.
//
// Purpose: this file is loaded via SOCC_WORKER_URL in integration tests
// that need a fast, deterministic Worker without pulling the real socc
// engine. It speaks the same message protocol as src/sessionWorker.ts
// (init → ready, prompt → event... + turn_end, abort, shutdown) so
// WorkerPool treats it identically to the production Worker.
//
// The key experiment: STATE is a module-level singleton that mutates on
// init and prompt. If Bun Workers truly isolate realms, each Worker
// instance sees ONLY its own STATE. The multi-session concurrency test
// (sessionIsolation.test.ts) drives two Workers with different
// sessionId/userId/provider combos simultaneously, then asserts each
// Worker reports back its OWN init payload — never the other's.

/// <reference lib="webworker" />

type WorkerInitMessage = {
  type: 'init'
  sessionId: string
  userId: string
  provider: string
  apiKey: string
  baseUrl?: string
  model: string
  maxOutputTokens: number
  systemPrompt?: string
}

type WorkerPromptMessage = {
  type: 'prompt'
  turnId: string
  text: string
}

type WorkerAbortMessage = { type: 'abort'; turnId?: string }
type WorkerShutdownMessage = { type: 'shutdown' }

type Inbound =
  | WorkerInitMessage
  | WorkerPromptMessage
  | WorkerAbortMessage
  | WorkerShutdownMessage

declare const self: Worker & { close: () => void }

// The dangerous pattern we're guarding against: module-level singleton.
// socc's bootstrap/state.ts does this for real (sessionId, provider,
// modelUsage, lastAPIRequest, ...). If this leaks between Workers,
// multi-tenant is broken.
const STATE: {
  init: WorkerInitMessage | null
  promptCount: number
  abortSignaled: boolean
} = {
  init: null,
  promptCount: 0,
  abortSignaled: false,
}

function post(msg: unknown): void {
  self.postMessage(msg)
}

self.addEventListener('message', (ev: MessageEvent<Inbound>) => {
  const msg = ev.data
  switch (msg.type) {
    case 'init':
      STATE.init = msg
      post({ type: 'ready', sessionId: msg.sessionId })
      return

    case 'prompt': {
      if (!STATE.init) {
        post({
          type: 'turn_end',
          turnId: msg.turnId,
          reason: 'error',
          errorMessage: 'prompt before init',
        })
        return
      }
      STATE.promptCount++
      STATE.abortSignaled = false

      // Emit an assistant event that echoes STATE back so the test can
      // verify each Worker saw its OWN init, not another's.
      post({
        type: 'event',
        turnId: msg.turnId,
        event: {
          type: 'assistant',
          message: {
            id: `msg_${STATE.init.sessionId}_${STATE.promptCount}`,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  echo: {
                    sessionId: STATE.init.sessionId,
                    userId: STATE.init.userId,
                    provider: STATE.init.provider,
                    model: STATE.init.model,
                    promptCount: STATE.promptCount,
                    // Echoing the API key confirms nothing crossed
                    // between realms (each Worker has its own init).
                    apiKeySuffix: STATE.init.apiKey.slice(-4),
                    promptText: msg.text,
                  },
                }),
              },
            ],
          },
        },
      })

      // Simulate a small stall so concurrent turns actually interleave.
      setTimeout(() => {
        if (STATE.abortSignaled) {
          post({ type: 'turn_end', turnId: msg.turnId, reason: 'aborted' })
          STATE.abortSignaled = false
          return
        }
        post({ type: 'turn_end', turnId: msg.turnId, reason: 'complete' })
      }, 15)
      return
    }

    case 'abort':
      STATE.abortSignaled = true
      return

    case 'shutdown':
      setTimeout(() => self.close(), 5)
      return
  }
})
