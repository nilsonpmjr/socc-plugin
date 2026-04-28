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
  authMode?: 'api_key' | 'oauth' | 'codex_cli' | 'claude_cli' | 'setup_token' | 'local_discovery'
  apiKey: string
  accountId?: string
  baseUrl?: string
  model: string
  maxOutputTokens: number
  systemPrompt?: string
  // Names of tools the user is allowed to invoke this session.
  // Empty/missing → tools fully disabled (Phase 0/MVP behavior). The
  // session manager fills this from the user's RBAC + the current
  // PRD §AI System Requirements catalog (Phase 5: read-only set).
  enabledTools?: string[]
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

// Tool gateway: the Worker asks the server to execute a Vantage-side
// tool (PRD §AI System Requirements). The server holds the JWT secret;
// the Worker doesn't, so it can't call the Vantage backend directly.
//
// Pattern: request/response correlated by `requestId` (a ulid string).
// Worker sends `tool_request` outbound; server replies inbound with
// `tool_response`. The Worker's canUseTool() awaits the matching reply.
export type WorkerToolResponseMessage = {
  type: 'tool_response'
  requestId: string
  ok: boolean
  // On ok=true: the JSON body the Vantage tool returned.
  // On ok=false: a short error code/message (PRD §Security reserved set).
  data?: unknown
  errorCode?: string
  errorMessage?: string
}

export type WorkerInboundMessage =
  | WorkerInitMessage
  | WorkerPromptMessage
  | WorkerAbortMessage
  | WorkerShutdownMessage
  | WorkerToolResponseMessage

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

export type WorkerToolRequestMessage = {
  type: 'tool_request'
  requestId: string
  turnId: string
  name: string
  // Already-validated tool args; the engine passes whatever the model
  // produced. Server-side router does its own pydantic validation.
  args: Record<string, unknown>
}

export type WorkerOutboundMessage =
  | WorkerReadyMessage
  | WorkerEventMessage
  | WorkerTurnEndMessage
  | WorkerErrorMessage
  | WorkerToolRequestMessage

// ── Worker body (only runs inside a Worker context) ────────────────────

declare const self: Worker & { close: () => void }

type ToolPending = {
  resolve: (value: { ok: boolean; data?: unknown; errorCode?: string; errorMessage?: string }) => void
}

type WorkerState = {
  init: WorkerInitMessage | null
  currentTurn: { id: string; abort: AbortController } | null
  // Tool round-trip state. Each tool_request carries a requestId; the
  // server replies with tool_response carrying the same id. We resolve
  // the matching promise so canUseTool can return synchronously to the
  // engine.
  toolPending: Map<string, ToolPending>
}

const state: WorkerState = {
  init: null,
  currentTurn: null,
  toolPending: new Map(),
}

function normalizeOllamaBaseUrl(baseUrl?: string): string {
  const base = (baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '')
  return base.endsWith('/v1') ? base : `${base}/v1`
}

function configureProviderEnvironment(init: WorkerInitMessage): Record<string, unknown> | undefined {
  const authMode = init.authMode ?? 'api_key'

  delete process.env.SOCC_USE_OPENAI
  delete process.env.SOCC_USE_GEMINI
  delete process.env.SOCC_USE_GITHUB
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL
  delete process.env.CODEX_API_KEY
  delete process.env.CODEX_ACCOUNT_ID
  delete process.env.CHATGPT_ACCOUNT_ID
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_MODEL
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_ORGANIZATION_UUID

  if (init.provider === 'anthropic') {
    if (authMode === 'claude_cli' || authMode === 'setup_token') {
      process.env.ANTHROPIC_AUTH_TOKEN = init.apiKey
      process.env.CLAUDE_CODE_OAUTH_TOKEN = init.apiKey
      if (init.accountId) process.env.CLAUDE_CODE_ORGANIZATION_UUID = init.accountId
    } else {
      process.env.ANTHROPIC_API_KEY = init.apiKey
    }
    if (init.baseUrl) process.env.ANTHROPIC_BASE_URL = init.baseUrl
    return undefined
  }

  if (init.provider === 'gemini') {
    process.env.SOCC_USE_GEMINI = '1'
    process.env.GEMINI_API_KEY = init.apiKey
    process.env.GEMINI_MODEL = init.model
    if (init.baseUrl) process.env.GEMINI_BASE_URL = init.baseUrl
    return {
      model: init.model,
      baseURL: init.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: init.apiKey,
    }
  }

  if (init.provider === 'ollama') {
    process.env.SOCC_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = init.apiKey || 'ollama-local'
    process.env.OPENAI_MODEL = init.model
    process.env.OPENAI_BASE_URL = normalizeOllamaBaseUrl(init.baseUrl)
    return {
      model: init.model,
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    }
  }

  process.env.SOCC_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = init.model

  if (authMode === 'codex_cli') {
    process.env.CODEX_API_KEY = init.apiKey
    if (init.accountId) {
      process.env.CODEX_ACCOUNT_ID = init.accountId
      process.env.CHATGPT_ACCOUNT_ID = init.accountId
    }
    const baseURL = init.baseUrl ?? 'https://chatgpt.com/backend-api/codex'
    process.env.OPENAI_BASE_URL = baseURL
    return { model: init.model, baseURL, apiKey: init.apiKey }
  }

  process.env.OPENAI_API_KEY = init.apiKey
  if (init.baseUrl) process.env.OPENAI_BASE_URL = init.baseUrl
  return {
    model: init.model,
    baseURL: init.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: init.apiKey,
  }
}

function post(msg: WorkerOutboundMessage): void {
  self.postMessage(msg)
}

// Generate a short unique id for tool requests. Bun has crypto.randomUUID
// available globally; we keep it inside the Worker realm.
function newRequestId(): string {
  return (globalThis as unknown as { crypto: { randomUUID(): string } })
    .crypto.randomUUID()
}

// Sends a tool_request to the server and awaits the matching tool_response.
// The server holds the JWT secret and is the only one allowed to talk to
// the Vantage backend (PRD §Architecture). Timeout matches the per-turn
// budget (default 90s); if it expires we surface an error to the engine.
function executeTool(turnId: string, name: string, args: Record<string, unknown>): Promise<{
  ok: boolean
  data?: unknown
  errorCode?: string
  errorMessage?: string
}> {
  return new Promise((resolve) => {
    const requestId = newRequestId()
    state.toolPending.set(requestId, { resolve })
    post({ type: 'tool_request', requestId, turnId, name, args })
    // Safety net: if the server never replies (e.g. crash during the
    // round-trip), reject after 60s so the engine doesn't hang forever.
    setTimeout(() => {
      const pending = state.toolPending.get(requestId)
      if (!pending) return
      state.toolPending.delete(requestId)
      pending.resolve({
        ok: false,
        errorCode: 'internal_error',
        errorMessage: 'tool request timed out (60s)',
      })
    }, 60_000)
  })
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
    const providerOverride = configureProviderEnvironment(init)

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
      // Tool policy: enabledTools (declared at init) acts as the
      // allowlist. Anything else is denied without a round-trip. When
      // allowed, we forward the call to the server via executeTool() and
      // return the JSON the Vantage backend produced as `updatedInput`.
      // PRD §AI System Requirements: read-only tools (query_feed,
      // analyze_ioc, search_watchlist, search_incidents, get_system_health)
      // arrive in v1.1; write tools + skills in v1.2.
      canUseTool: async (toolName: string, toolArgs: Record<string, unknown>) => {
        const allowed = init.enabledTools ?? []
        if (!allowed.includes(toolName)) {
          return {
            behavior: 'deny' as const,
            message: `tool '${toolName}' not enabled for this session`,
          }
        }
        const result = await executeTool(prompt.turnId, toolName, toolArgs)
        if (!result.ok) {
          return {
            behavior: 'deny' as const,
            message: result.errorMessage ?? result.errorCode ?? 'tool failed',
          }
        }
        // The engine wants the new input to feed back into the model;
        // we pass the whole JSON the backend returned.
        return {
          behavior: 'allow' as const,
          updatedInput: (result.data ?? {}) as Record<string, unknown>,
        }
      },
      toolUseContext: {
        abortController: abort,
        options: {
          model: init.model,
          maxOutputTokens: init.maxOutputTokens,
          ...(providerOverride ? { providerOverride } : {}),
        },
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
    case 'tool_response': {
      const pending = state.toolPending.get(msg.requestId)
      if (!pending) return // unknown id (timed out or replayed)
      state.toolPending.delete(msg.requestId)
      pending.resolve({
        ok: msg.ok,
        data: msg.data,
        errorCode: msg.errorCode,
        errorMessage: msg.errorMessage,
      })
      return
    }
  }
})
