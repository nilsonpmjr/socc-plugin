// Hono + SSE entrypoint.
//
// Wiring:
//   env → Mongo client → CredentialsStore (libsodium) →
//   WorkerPool → SessionManager → JwtVerifier → pino → Hono app
//
// Auth: every route under /v1 except /v1/health requires
// `Authorization: Bearer <jwt>`. The JWT is minted by Vantage
// (scope=socc, TTL≤60s). `sub` is the Vantage user id — we use that as
// the tenant scope for everything.
//
// Routing: all public routes live under `/v1/*` (PRD §Extensions
// Platform manifest expects `/v1/health`). `POST /v1/session/:id/message`
// and `POST /v1/session/:id/turns` are aliases for the same SSE handler;
// `message` matches the PRD wire naming, `turns` is the legacy alias
// kept for internal callers.
//
// Streaming: turns use text/event-stream. The engine's AsyncIterable is
// projected through createStreamProjection() → encodeSseEvent(). We emit
// a `heartbeat` SSE frame every 15s to keep intermediaries from killing
// idle connections. A 90s generation timeout aborts the worker and
// surfaces `error.retriable=true` per PRD §Security.
//
// Shutdown: SIGTERM/SIGINT drain in-flight turns, close Mongo, terminate
// every Worker. Callers see a clean end-of-stream, not a TCP reset.

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { MongoClient } from 'mongodb'
import { z } from 'zod'
import { extractBearer, JwtVerificationError, JwtVerifier, type SoccJwtClaims } from './auth.ts'
import {
  CredentialsStore,
  MAX_CREDENTIALS_PER_USER,
  type Provider,
  type ProviderCredential,
} from './credentials.ts'
import { ERR } from './errors.ts'
import { importClaudeCliAuth, importCodexCliAuth } from './localAuthImport.ts'
import { mkLogger, type Logger } from './logger.ts'
import { testProvider } from './providerTester.ts'
import {
  CredentialNotFoundError,
  SessionManager,
  SessionNotFoundError,
  SessionQuotaError,
} from './sessionManager.ts'
import {
  createStreamProjection,
  encodeSseEvent,
  type SoccStreamEvent,
} from './streamAdapter.ts'
import { PoolCapacityError, TurnConflictError, WorkerPool } from './workerPool.ts'
import { createToolsExecutor } from './toolsExecutor.ts'
import { MessageStore } from './messageStore.ts'
import {
  createPkcePair,
  OAuthStateStore,
  type OAuthStateStoreLike,
} from './oauthState.ts'

const HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_TURN_TIMEOUT_MS = 90_000

function classifyProviderTurnError(message: string): {
  code: typeof ERR[keyof typeof ERR]
  message: string
  retriable: boolean
} {
  const text = message.toLowerCase()
  if (
    text.includes(ERR.ProviderUnauthorized) ||
    /\b401\b/.test(text) ||
    text.includes('unauthorized') ||
    text.includes('unauthorised') ||
    text.includes('invalid api key') ||
    text.includes('authentication failed')
  ) {
    return { code: ERR.ProviderUnauthorized, message, retriable: false }
  }
  if (
    text.includes(ERR.ProviderRateLimited) ||
    /\b429\b/.test(text) ||
    text.includes('rate limit') ||
    text.includes('too many requests')
  ) {
    return { code: ERR.ProviderRateLimited, message, retriable: true }
  }
  if (
    text.includes(ERR.ProviderUnavailable) ||
    /\b50[234]\b/.test(text) ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('econn') ||
    text.includes('enotfound') ||
    text.includes('eai_again')
  ) {
    return { code: ERR.ProviderUnavailable, message, retriable: true }
  }
  return { code: ERR.InternalError, message, retriable: false }
}

// ── env ──────────────────────────────────────────────────────────────

const optionalEnvString = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().optional(),
)
const optionalEnvUrl = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().url().optional(),
)

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(7070),
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().default('socc_plugin'),
  SOCC_INTERNAL_SECRET: z.string().min(64), // 32 bytes = 64 hex chars
  SOCC_MASTER_KEY: z.string().length(64), // 32 bytes hex
  SESSION_TTL_MS: z.coerce.number().int().positive().default(900_000),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(50),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_TURN_TIMEOUT_MS),
  SOCC_ALLOW_LOCAL_PROVIDERS: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  LOG_LEVEL: z.string().optional(),
  // Tools gateway (Fase 5 Iteração C). Optional — when absent, every
  // tool request from the Worker resolves to {ok:false} and canUseTool
  // returns deny. This means `bun run dev` without the Vantage backend
  // still works: tools are gracefully unavailable.
  VANTAGE_API_URL: optionalEnvUrl,
  // History TTL (PRD §LGPD). Default 30 days. Zero = disable persistence
  // (useful for privacy-first deployments). Requires VANTAGE_API_URL to
  // be absent OR be set — persistence works independently of tools.
  MESSAGE_TTL_DAYS: z.coerce.number().int().nonnegative().default(30),
  OPENAI_CODEX_OAUTH_CLIENT_ID: optionalEnvString,
  OPENAI_CODEX_OAUTH_REDIRECT_URI: optionalEnvUrl,
  OPENAI_CODEX_OAUTH_AUTHORIZE_URL: z.string().url().default('https://auth.openai.com/oauth/authorize'),
})

type AppEnv = z.infer<typeof envSchema>

// ── app builder ───────────────────────────────────────────────────────

// Injected handler that executes a Vantage-side tool on behalf of the
// Worker. The plugin doesn't know Vantage's URL or auth — the
// orchestrator wires a real HTTP call in production and a stub in tests.
// Called only when canUseTool already accepted the tool name (PRD
// §AI System Requirements), so this function never has to enforce
// allowlisting. It MUST resolve quickly enough to fit the per-turn
// timeout (default 90s).
export type ToolExecutor = (input: {
  userId: string
  sessionId: string
  name: string
  args: Record<string, unknown>
}) => Promise<{
  ok: boolean
  data?: unknown
  errorCode?: string
  errorMessage?: string
}>

type AppDeps = {
  credentials: CredentialsStore
  sessions: SessionManager
  jwt: JwtVerifier
  logger?: Logger
  allowLocalProviders?: boolean
  turnTimeoutMs?: number
  // Injected only in tests; defaults to global fetch in production.
  fetchImpl?: typeof fetch
  // Optional — when omitted, every tool_request from the Worker
  // resolves with an `internal_error` so the engine cleanly denies.
  executeTool?: ToolExecutor
  // Optional — when omitted, conversation history is not persisted.
  messages?: MessageStore
  oauthStates?: OAuthStateStoreLike
  openaiCodexOAuth?: {
    clientId?: string
    redirectUri?: string
    authorizeUrl?: string
    scope?: string
  }
}

type AppVariables = {
  claims: SoccJwtClaims
}

export function buildApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>()
  const logger = deps.logger ?? mkLogger({ level: 'silent' })
  const allowLocal = deps.allowLocalProviders ?? false
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  // Tool executor: when missing, deny every tool_request with
  // internal_error so the Worker treats it as a deny in canUseTool.
  const executeTool: ToolExecutor =
    deps.executeTool ??
    (async () => ({
      ok: false,
      errorCode: 'internal_error',
      errorMessage: 'tool executor not configured',
    }))
  const oauthLoginLimiter = createWindowLimiter(5, 60_000)

  // /v1/health is the healthcheck URL declared by the PRD manifest; it
  // stays unauthenticated so docker healthcheck / extensions platform
  // probes don't need a JWT.
  app.get('/v1/health', (c) =>
    c.json({ status: 'ok', activeSessions: deps.sessions.activeCount() }),
  )

  // Auth middleware for everything under /v1 except /v1/health.
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/health') return next()
    const token = extractBearer(c.req.header('authorization'))
    if (!token) return c.json({ error: 'missing_bearer' }, 401)
    try {
      const claims = await deps.jwt.verify(token)
      c.set('claims', claims)
    } catch (err) {
      if (err instanceof JwtVerificationError) {
        return c.json({ error: err.code, message: err.message }, 401)
      }
      return c.json({ error: ERR.InternalError }, 401)
    }
    return next()
  })

  // ── credentials CRUD ─────────────────────────────────────────────

  const createCredSchema = z.object({
    provider: z.enum(['anthropic', 'openai', 'gemini', 'ollama']),
    label: z.string().min(1).max(80),
    apiKey: z.string().min(8),
    authMode: z
      .enum(['api_key', 'oauth', 'codex_cli', 'claude_cli', 'setup_token', 'local_discovery'])
      .optional(),
    baseUrl: z.string().url().optional(),
    defaultModel: z.string().min(1),
    maxOutputTokens: z.number().int().positive().optional(),
  })

  const importLocalAuthSchema = z.object({
    provider: z.enum(['openai', 'anthropic']),
    source: z.enum(['codex_cli', 'claude_cli']),
    label: z.string().min(1).max(80).optional(),
    defaultModel: z.string().min(1).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })

  const discoverLocalSchema = z.object({
    provider: z.literal('ollama').default('ollama'),
    label: z.string().min(1).max(80).optional(),
    baseUrl: z.string().url().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })

  const oauthCallbackSchema = z
    .object({
      callbackUrl: z.string().url().optional(),
      code: z.string().min(1).optional(),
      state: z.string().min(1).optional(),
    })
    .refine((input) => input.callbackUrl || (input.code && input.state), {
      message: 'callbackUrl or code+state is required',
    })

  app.post('/v1/credentials', async (c) => {
    const userId = c.get('claims').sub
    const parsed = createCredSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
    }
    if (parsed.data.provider === 'ollama' && !allowLocal) {
      return c.json(
        {
          error: ERR.LocalProviderDisabled,
          message: 'local provider (ollama) disabled by admin',
        },
        403,
      )
    }
    const active = await deps.credentials.countActive(userId)
    if (active >= MAX_CREDENTIALS_PER_USER) {
      return c.json(
        {
          error: ERR.QuotaExceeded,
          message: `max ${MAX_CREDENTIALS_PER_USER} credentials per user`,
        },
        429,
      )
    }
    const cred = await deps.credentials.create(userId, parsed.data as {
      provider: Provider
      label: string
      apiKey: string
      authMode?: 'api_key' | 'oauth' | 'codex_cli' | 'claude_cli' | 'setup_token' | 'local_discovery'
      baseUrl?: string
      defaultModel: string
      maxOutputTokens?: number
    })
    return c.json(cred, 201)
  })

  app.get('/v1/oauth/openai-codex/login', async (c) => {
    const userId = c.get('claims').sub
    const allowed = oauthLoginLimiter(userId)
    if (!allowed) {
      return c.json({ error: ERR.ProviderRateLimited, message: 'oauth login rate limited' }, 429)
    }
    if (!deps.oauthStates) {
      return c.json({ error: 'oauth_not_configured', message: 'OAuth state store is not configured' }, 501)
    }
    const oauth = deps.openaiCodexOAuth
    if (!oauth?.clientId || !oauth.redirectUri) {
      return c.json({
        error: 'oauth_not_configured',
        message: 'OPENAI_CODEX_OAUTH_CLIENT_ID and OPENAI_CODEX_OAUTH_REDIRECT_URI are required',
      }, 501)
    }

    const pkce = createPkcePair()
    const rec = await deps.oauthStates.create({
      userId,
      provider: 'openai-codex',
      codeVerifier: pkce.verifier,
      redirectUri: oauth.redirectUri,
    })
    const url = new URL(oauth.authorizeUrl ?? 'https://auth.openai.com/oauth/authorize')
    url.searchParams.set('client_id', oauth.clientId)
    url.searchParams.set('redirect_uri', oauth.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', rec.state)
    url.searchParams.set('code_challenge', pkce.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (oauth.scope) url.searchParams.set('scope', oauth.scope)
    return c.redirect(url.toString(), 302)
  })

  app.get('/v1/oauth/openai-codex/callback', async (c) => {
    if (!deps.oauthStates) {
      return c.json({ error: 'oauth_not_configured', message: 'OAuth state store is not configured' }, 501)
    }
    const userId = c.get('claims').sub
    const state = c.req.query('state')
    const code = c.req.query('code')
    if (!state || !code) {
      return c.json({ error: 'bad_request', message: 'missing code or state' }, 400)
    }
    const result = await validateOpenAiCodexCallback(deps.oauthStates, userId, code, state)
    return c.json(result.body, result.status)
  })

  app.post('/v1/oauth/openai-codex/callback', async (c) => {
    if (!deps.oauthStates) {
      return c.json({ error: 'oauth_not_configured', message: 'OAuth state store is not configured' }, 501)
    }
    const userId = c.get('claims').sub
    const parsed = oauthCallbackSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
    }

    let code = parsed.data.code
    let state = parsed.data.state
    if (parsed.data.callbackUrl) {
      const url = new URL(parsed.data.callbackUrl)
      code = url.searchParams.get('code') ?? undefined
      state = url.searchParams.get('state') ?? undefined
    }
    if (!code || !state) {
      return c.json({ error: 'bad_request', message: 'missing code or state' }, 400)
    }
    const result = await validateOpenAiCodexCallback(deps.oauthStates, userId, code, state)
    return c.json(result.body, result.status)
  })

  app.post('/v1/credentials/import-local-auth', async (c) => {
    const userId = c.get('claims').sub
    const parsed = importLocalAuthSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
    }
    const active = await deps.credentials.countActive(userId)
    if (active >= MAX_CREDENTIALS_PER_USER) {
      return c.json(
        {
          error: ERR.QuotaExceeded,
          message: `max ${MAX_CREDENTIALS_PER_USER} credentials per user`,
        },
        429,
      )
    }

    if (parsed.data.provider === 'openai' && parsed.data.source === 'codex_cli') {
      let imported: Awaited<ReturnType<typeof importCodexCliAuth>>
      try {
        imported = await importCodexCliAuth()
      } catch (err) {
        return c.json({
          error: 'local_auth_not_found',
          message: err instanceof Error ? err.message : String(err),
        }, 404)
      }
      const cred = await deps.credentials.create(userId, {
        provider: 'openai',
        authMode: 'codex_cli',
        label: parsed.data.label ?? 'OpenAI Codex',
        apiKey: imported.accessToken,
        authProfile: {
          accountId: imported.accountId,
          expiresAt: imported.expiresAt,
          provenance: 'codex_cli',
          sourcePath: imported.authPath,
        },
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        defaultModel: parsed.data.defaultModel ?? 'gpt-5.4',
        maxOutputTokens: parsed.data.maxOutputTokens,
      })
      return c.json(cred, 201)
    }

    if (parsed.data.provider === 'anthropic' && parsed.data.source === 'claude_cli') {
      let imported: Awaited<ReturnType<typeof importClaudeCliAuth>>
      try {
        imported = await importClaudeCliAuth()
      } catch (err) {
        return c.json({
          error: 'local_auth_not_found',
          message: err instanceof Error ? err.message : String(err),
        }, 404)
      }
      const cred = await deps.credentials.create(userId, {
        provider: 'anthropic',
        authMode: 'claude_cli',
        label: parsed.data.label ?? 'Anthropic Claude CLI',
        apiKey: 'claude-cli-local',
        authProfile: {
          organizationUuid: imported.organizationUuid,
          subscriptionType: imported.subscriptionType,
          rateLimitTier: imported.rateLimitTier,
          scopes: imported.scopes,
          expiresAt: imported.expiresAt,
          provenance: 'claude_cli',
          sourcePath: imported.authPath,
        },
        defaultModel: parsed.data.defaultModel ?? 'claude-sonnet-4-6',
        maxOutputTokens: parsed.data.maxOutputTokens,
      })
      return c.json(cred, 201)
    }

    return c.json({
      error: 'auth_source_not_supported',
      message: `${parsed.data.provider}/${parsed.data.source} import is not implemented yet`,
    }, 501)
  })

  app.post('/v1/credentials/discover-local', async (c) => {
    const userId = c.get('claims').sub
    const parsed = discoverLocalSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
    }
    if (!allowLocal) {
      return c.json(
        {
          error: ERR.LocalProviderDisabled,
          message: 'local provider discovery disabled by admin',
        },
        403,
      )
    }
    const active = await deps.credentials.countActive(userId)
    if (active >= MAX_CREDENTIALS_PER_USER) {
      return c.json(
        {
          error: ERR.QuotaExceeded,
          message: `max ${MAX_CREDENTIALS_PER_USER} credentials per user`,
        },
        429,
      )
    }

    const fetchImpl = deps.fetchImpl ?? fetch
    const baseUrl = parsed.data.baseUrl ?? 'http://localhost:11434'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_000)
    try {
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      })
      if (!res.ok) {
        return c.json({
          detected: false,
          hint: 'Run: ollama serve',
          status: res.status,
        })
      }
      const body = await res.json().catch(() => ({}))
      const models = Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : []
      const firstModel = models
        .map((model) =>
          model && typeof model === 'object'
            ? (model as Record<string, unknown>).name
            : undefined,
        )
        .find((name): name is string => typeof name === 'string' && name.trim().length > 0)
      if (!firstModel) {
        return c.json({
          detected: false,
          hint: 'Install a model first: ollama pull llama3.2',
        })
      }

      const cred = await deps.credentials.create(userId, {
        provider: 'ollama',
        authMode: 'local_discovery',
        label: parsed.data.label ?? 'Local Ollama',
        apiKey: 'ollama-local',
        authProfile: {
          provenance: 'local_discovery',
          detectedAt: new Date().toISOString(),
        },
        baseUrl,
        defaultModel: firstModel,
        maxOutputTokens: parsed.data.maxOutputTokens,
      })
      return c.json({ detected: true, credential: cred }, 201)
    } catch (err) {
      const aborted = (err as { name?: string }).name === 'AbortError'
      return c.json({
        detected: false,
        hint: 'Run: ollama serve',
        error: aborted ? 'timeout' : 'network',
      })
    } finally {
      clearTimeout(timer)
    }
  })

  app.get('/v1/credentials', async (c) => {
    const userId = c.get('claims').sub
    const creds = await deps.credentials.list(userId)
    return c.json({ credentials: creds })
  })

  app.delete('/v1/credentials/:id', async (c) => {
    const userId = c.get('claims').sub
    await deps.credentials.revoke(userId, c.req.param('id'))
    return c.body(null, 204)
  })

  // US-1 AC: the Vantage proxy calls this after saving a credential and
  // refuses to present it to the user if `ok: false`. We do one provider
  // round-trip with a near-empty prompt and record the outcome.
  app.post('/v1/credentials/:id/test', async (c) => {
    const userId = c.get('claims').sub
    const id = c.req.param('id')
    const cred: ProviderCredential | null = await deps.credentials.get(userId, id)
    if (!cred) {
      return c.json({ error: 'credential_not_found' }, 404)
    }
    let secret: Awaited<ReturnType<CredentialsStore['decryptAuthSecret']>>
    try {
      secret = await deps.credentials.decryptAuthSecret(userId, id)
    } catch {
      return c.json({ error: 'credential_not_found' }, 404)
    }
    const outcome = await testProvider(cred, secret.apiKey, { fetchImpl: deps.fetchImpl })
    await deps.credentials.recordTestResult(userId, id, outcome.result)
    return c.json({
      ok: outcome.ok,
      result: outcome.result,
      detail: outcome.detail,
      status: outcome.status,
    })
  })

  // ── sessions ─────────────────────────────────────────────────────

  const createSessionSchema = z.object({
    credentialId: z.string().min(1),
    systemPrompt: z.string().max(32_000).optional(),
    sessionName: z.string().min(1).max(100).optional(),
    enabledTools: z.array(z.string().min(1).max(80)).max(50).optional(),
  })

  app.post('/v1/session', async (c) => {
    const userId = c.get('claims').sub
    const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
    }
    try {
      const s = await deps.sessions.createSession({
        userId,
        credentialId: parsed.data.credentialId,
        systemPrompt: parsed.data.systemPrompt,
        sessionName: parsed.data.sessionName,
        enabledTools: parsed.data.enabledTools,
      })
      return c.json(s, 201)
    } catch (err) {
      if (err instanceof SessionQuotaError) {
        return c.json({ error: ERR.QuotaExceeded, message: err.message }, 429)
      }
      if (err instanceof CredentialNotFoundError) {
        return c.json({ error: 'credential_not_found', message: err.message }, 404)
      }
      if (err instanceof PoolCapacityError) {
        return c.json({ error: ERR.SoccUnavailable, message: err.message }, 503)
      }
      logger.error({ err }, 'unhandled error creating session')
      return c.json({ error: ERR.InternalError }, 500)
    }
  })

  app.get('/v1/session', (c) => {
    const userId = c.get('claims').sub
    return c.json({ sessions: deps.sessions.listSessions(userId) })
  })

  app.delete('/v1/session/:id', (c) => {
    const userId = c.get('claims').sub
    deps.sessions.closeSession(userId, c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/v1/session/:id/abort', async (c) => {
    const userId = c.get('claims').sub
    const body = (await c.req.json().catch(() => ({}))) as { turnId?: string }
    deps.sessions.abortTurn(userId, c.req.param('id'), body?.turnId)
    return c.body(null, 204)
  })

  // ── session metadata mutations (PRD §v1.1) ───────────────────────

  const patchSessionSchema = z.object({
    sessionName: z.string().min(1).max(100).optional(),
  })

  app.patch('/v1/session/:id', async (c) => {
    const userId = c.get('claims').sub
    const parsed = patchSessionSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
    try {
      const updated = deps.sessions.patchSession(userId, c.req.param('id'), parsed.data)
      return c.json(updated)
    } catch {
      return c.json({ error: ERR.SessionNotFound }, 404)
    }
  })

  app.post('/v1/session/:id/pin', (c) => {
    const userId = c.get('claims').sub
    try {
      return c.json(deps.sessions.pinSession(userId, c.req.param('id')))
    } catch {
      return c.json({ error: ERR.SessionNotFound }, 404)
    }
  })

  app.delete('/v1/session/:id/pin', (c) => {
    const userId = c.get('claims').sub
    try {
      return c.json(deps.sessions.unpinSession(userId, c.req.param('id')))
    } catch {
      return c.json({ error: ERR.SessionNotFound }, 404)
    }
  })

  // ── history & export (PRD §v1.1 + §LGPD) ────────────────────────

  app.get('/v1/session/:id/history', async (c) => {
    const userId = c.get('claims').sub
    const limit = Number(c.req.query('limit') ?? 50)
    const before = c.req.query('before')
    const messages = await deps.sessions.listHistory(userId, c.req.param('id'), {
      limit: isNaN(limit) ? 50 : limit,
      before,
    })
    return c.json({ messages })
  })

  app.get('/v1/session/:id/export', async (c) => {
    const userId = c.get('claims').sub
    const messages = await deps.sessions.exportHistory(userId, c.req.param('id'))
    return c.json({ sessionId: c.req.param('id'), userId, messages })
  })

  // ── LGPD data wipeout (PRD §LGPD) ────────────────────────────────
  //
  // Called by the Vantage backend's `users.py:delete_user` hook when an
  // admin deactivates a user. The JWT `sub` carries the Vantage user id;
  // the route deletes ALL sessions, credentials, and messages for that
  // user. No UI-accessible path — only backend-to-backend with scope=socc.
  app.delete('/v1/users/:userId/data', async (c) => {
    const claims = c.get('claims')
    const targetUserId = c.req.param('userId')
    // The plugin-to-Vantage JWT has sub=requesting_user_id (admin), but
    // this endpoint is a backend wipeout — scope=socc is enough here.
    // For extra safety: verify the path userId matches a non-empty string.
    if (!targetUserId || targetUserId.length > 200) {
      return c.json({ error: 'bad_request' }, 400)
    }
    // Close all live sessions (terminates Workers, frees quota).
    const sessions = deps.sessions.listSessions(targetUserId)
    for (const s of sessions) {
      deps.sessions.closeSession(targetUserId, s.sessionId)
    }
    // Revoke all credentials.
    const creds = await deps.credentials.list(targetUserId)
    for (const cred of creds) {
      await deps.credentials.revoke(targetUserId, cred.id)
    }
    // Wipe conversation history (PRD §LGPD: delete messages on user deactivation).
    const deletedMessages = await deps.sessions.deleteUserHistory(targetUserId)
    logger.info(
      { actor: claims.sub, targetUserId, deletedMessages, closedSessions: sessions.length },
      'lgpd user wipeout',
    )
    return c.json({
      ok: true,
      deletedMessages,
      closedSessions: sessions.length,
      revokedCredentials: creds.length,
    })
  })

  // ── turn streaming (SSE) ─────────────────────────────────────────

  const messageSchema = z.object({ text: z.string().min(1).max(32_000) })

  // Primary endpoint (PRD wire name: /message) + legacy alias (/turns).
  // Both share the exact same handler body.
  for (const path of ['/v1/session/:id/message', '/v1/session/:id/turns'] as const) {
    app.post(path, async (c) => {
      const userId = c.get('claims').sub
      const sessionId = c.req.param('id')
      const parsed = messageSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) {
        return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
      }

      const claims = c.get('claims')
      if (claims.sid && claims.sid !== sessionId) {
        // Token sid pins the session; mismatch = the JWT was minted for
        // a different session. Cross-user access returns 404 (see below);
        // sid mismatch inside the same user is 403 (session_forbidden).
        return c.json({ error: ERR.SessionForbidden }, 403)
      }
      // Cross-user = 404 (never 403) per PRD §US-4 AC3.
      if (!deps.sessions.getSession(userId, sessionId)) {
        return c.json({ error: ERR.SessionNotFound }, 404)
      }

      // PRD §Technical Risks mitigation: if the underlying Worker died
      // (crash / external terminate / failed init), surface a clean SSE
      // error frame and reap the slot so the user's quota frees up
      // immediately — frontend prompts a "restart session".
      const crashed = deps.sessions.consumeCrashed(userId, sessionId)
      if (crashed) {
        const body = makeCrashedSseStream(crashed.message)
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      }

      const body = streamTurnResponse(
        deps.sessions,
        userId,
        sessionId,
        parsed.data.text,
        turnTimeoutMs,
        logger,
        executeTool,
      )
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    })
  }

  return app
}

// Single-frame SSE stream emitted when the user hits an already-dead
// session (PRD §Technical Risks: "session_worker_crashed"). The client
// is expected to recreate the session — we mark `retriable: true` so
// the frontend can show a "Restart session" CTA instead of a hard
// failure.
function makeCrashedSseStream(message: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const ev: SoccStreamEvent = {
        type: 'error',
        // session_worker_crashed isn't in the original PRD reserved set
        // but the PRD §Technical Risks row that defines this mitigation
        // explicitly names this code. Kept narrow on purpose.
        code: 'session_worker_crashed',
        message,
        retriable: true,
      }
      controller.enqueue(encoder.encode(encodeSseEvent(ev, 1)))
      controller.close()
    },
  })
}

function createWindowLimiter(maxHits: number, windowMs: number): (key: string) => boolean {
  const hitsByKey = new Map<string, number[]>()
  return (key: string) => {
    const now = Date.now()
    const cutoff = now - windowMs
    const hits = (hitsByKey.get(key) ?? []).filter((ts) => ts > cutoff)
    if (hits.length >= maxHits) {
      hitsByKey.set(key, hits)
      return false
    }
    hits.push(now)
    hitsByKey.set(key, hits)
    return true
  }
}

async function validateOpenAiCodexCallback(
  oauthStates: OAuthStateStoreLike,
  userId: string,
  _code: string,
  state: string,
): Promise<{
  status: 400 | 501
  body: { error: string; message: string }
}> {
  const rec = await oauthStates.consume(userId, state)
  if (!rec) {
    return {
      status: 400,
      body: {
        error: 'bad_oauth_state',
        message: 'state expired, unknown, or owned by another user',
      },
    }
  }
  return {
    status: 501,
    body: {
      error: 'oauth_exchange_not_configured',
      message: 'OpenAI Codex OAuth callback state was validated, but token exchange is not enabled yet',
    },
  }
}

// Builds the SSE ReadableStream for a turn. Owns the projection state
// and heartbeat timer; shuts both down cleanly when the iterator ends
// or the client disconnects. Applies the per-turn generation timeout
// and emits `error.retriable=true` if it fires.
function streamTurnResponse(
  sessions: SessionManager,
  userId: string,
  sessionId: string,
  text: string,
  timeoutMs: number,
  logger: Logger,
  executeTool: ToolExecutor,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const projection = createStreamProjection()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let eventSeq = 0
  let capturedTurnId: string | null = null
  // Accumulate assistant content for persistence (mirrors content.done.content
  // but we build it here so we don't need to re-parse the SSE frames).
  let assistantContent = ''

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (ev: SoccStreamEvent) => {
        eventSeq++
        // Collect assistant text deltas for history persistence.
        if (ev.type === 'content.delta') assistantContent += ev.text
        controller.enqueue(encoder.encode(encodeSseEvent(ev, eventSeq)))
      }

      heartbeat = setInterval(() => {
        enqueue({ type: 'heartbeat', ts: Date.now() })
      }, HEARTBEAT_INTERVAL_MS)
      heartbeat.unref?.()

      let timedOut = false
      timeout = setTimeout(() => {
        timedOut = true
        // Ask the session manager to abort the worker; the generator
        // below will see the `end` event and drain out.
        sessions.abortTurn(userId, sessionId)
      }, timeoutMs)
      timeout.unref?.()

      try {
        // Persist the user turn before streaming — best-effort (errors swallowed).
        const firstTurnId = await (async () => {
          // We need the turnId that sendTurn will generate. We can't know it
          // yet, so we start the generator and capture it from the first event.
          // The user message is recorded after we see the first event.
          return null // placeholder; actual capture happens below
        })()
        void firstTurnId // suppress unused warning

        let userPersisted = false
        for await (const ev of sessions.sendTurn({ userId, sessionId, text })) {
          // Capture turnId from the first event and persist the user message once.
          if (!userPersisted && 'turnId' in ev && ev.turnId) {
            capturedTurnId = ev.turnId
            userPersisted = true
            void sessions.recordTurn(userId, sessionId, capturedTurnId, 'user', text)
          }
          if (ev.kind === 'engine') {
            for (const out of projection.step(ev.event as never)) enqueue(out)
          } else if (ev.kind === 'tool_request') {
            // Dispatch the tool execution OUT-OF-BAND so we don't block
            // the generator that's still draining. When it resolves we
            // forward the response back to the Worker via the pool.
            void (async () => {
              try {
                const result = await executeTool({
                  userId,
                  sessionId,
                  name: ev.name,
                  args: ev.args,
                })
                sessions.forwardToolResponse(userId, sessionId, {
                  requestId: ev.requestId,
                  ok: result.ok,
                  data: result.data,
                  errorCode: result.errorCode,
                  errorMessage: result.errorMessage,
                })
              } catch (err) {
                logger.error(
                  { err, tool: ev.name, sessionId },
                  'tool executor threw',
                )
                sessions.forwardToolResponse(userId, sessionId, {
                  requestId: ev.requestId,
                  ok: false,
                  errorCode: ERR.InternalError,
                  errorMessage:
                    err instanceof Error ? err.message : 'tool failed',
                })
              }
            })()
          } else if (ev.kind === 'end') {
            if (timedOut) {
              enqueue({
                type: 'error',
                code: ERR.ProviderUnavailable,
                message: `turn exceeded ${timeoutMs}ms timeout`,
                retriable: true,
              })
              for (const out of projection.finalize('aborted')) enqueue(out)
            } else if (ev.reason === 'error') {
              const classified = classifyProviderTurnError(ev.errorMessage ?? 'turn failed')
              enqueue({
                type: 'error',
                code: classified.code,
                message: classified.message,
                retriable: classified.retriable,
              })
              for (const out of projection.finalize('error')) enqueue(out)
            } else if (ev.reason === 'aborted') {
              for (const out of projection.finalize('aborted')) enqueue(out)
            } else {
              for (const out of projection.finalize()) enqueue(out)
            }
            // Persist assistant turn if we have content (best-effort).
            if (capturedTurnId && assistantContent) {
              void sessions.recordTurn(
                userId, sessionId, capturedTurnId, 'assistant', assistantContent,
              )
            }
          }
        }
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          enqueue({
            type: 'error',
            code: ERR.SessionNotFound,
            message: 'session not found',
            retriable: false,
          })
        } else if (err instanceof TurnConflictError) {
          enqueue({
            type: 'error',
            code: ERR.SoccUnavailable,
            message: err.message,
            retriable: true,
          })
        } else {
          logger.error({ err, sessionId }, 'stream pipeline failed')
          enqueue({
            type: 'error',
            code: ERR.InternalError,
            message: err instanceof Error ? err.message : 'stream failed',
            retriable: false,
          })
        }
        for (const out of projection.finalize('error')) enqueue(out)
      } finally {
        if (heartbeat) clearInterval(heartbeat)
        if (timeout) clearTimeout(timeout)
        controller.close()
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat)
      if (timeout) clearTimeout(timeout)
      // Best-effort: abort the in-flight turn on the pool side.
      sessions.abortTurn(userId, sessionId)
    },
  })
}

// ── bootstrap ─────────────────────────────────────────────────────────

export async function bootstrap(rawEnv: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(rawEnv) satisfies AppEnv
  const logger = mkLogger()

  const mongo = new MongoClient(env.MONGO_URI)
  await mongo.connect()
  const db = mongo.db(env.MONGO_DB)

  const credentials = await CredentialsStore.open(db, env.SOCC_MASTER_KEY)
  const jwt = new JwtVerifier(env.SOCC_INTERNAL_SECRET)
  const pool = new WorkerPool({ maxConcurrent: env.MAX_CONCURRENT_SESSIONS })

  // Message history (PRD §v1.1 + §LGPD). Skipped when TTL=0.
  const messages = env.MESSAGE_TTL_DAYS > 0
    ? await MessageStore.open(db, env.MESSAGE_TTL_DAYS)
    : undefined
  const oauthStates = await OAuthStateStore.open(db)

  const sessions = new SessionManager({
    credentials,
    pool,
    ttlMs: env.SESSION_TTL_MS,
    messages,
  })
  sessions.start()

  // Wire the tool executor only when the Vantage backend URL is known.
  const executeTool = env.VANTAGE_API_URL
    ? createToolsExecutor({
        vantageApiUrl: env.VANTAGE_API_URL,
        internalSecretHex: env.SOCC_INTERNAL_SECRET,
      })
    : undefined

  const app = buildApp({
    credentials,
    sessions,
    jwt,
    logger,
    allowLocalProviders: env.SOCC_ALLOW_LOCAL_PROVIDERS,
    turnTimeoutMs: env.TURN_TIMEOUT_MS,
    executeTool,
    messages,
    oauthStates,
    openaiCodexOAuth: {
      clientId: env.OPENAI_CODEX_OAUTH_CLIENT_ID,
      redirectUri: env.OPENAI_CODEX_OAUTH_REDIRECT_URI,
      authorizeUrl: env.OPENAI_CODEX_OAUTH_AUTHORIZE_URL,
    },
  })

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port }, 'socc-plugin listening')
  })

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'draining')
    await sessions.shutdown()
    await mongo.close()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  return { app, server, shutdown, logger }
}

// Run when invoked directly (not imported for tests).
if (import.meta.main) {
  void bootstrap()
}
