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

const HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_TURN_TIMEOUT_MS = 90_000

// ── env ──────────────────────────────────────────────────────────────

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
})

type AppEnv = z.infer<typeof envSchema>

// ── app builder ───────────────────────────────────────────────────────

type AppDeps = {
  credentials: CredentialsStore
  sessions: SessionManager
  jwt: JwtVerifier
  logger?: Logger
  allowLocalProviders?: boolean
  turnTimeoutMs?: number
  // Injected only in tests; defaults to global fetch in production.
  fetchImpl?: typeof fetch
}

type AppVariables = {
  claims: SoccJwtClaims
}

export function buildApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>()
  const logger = deps.logger ?? mkLogger({ level: 'silent' })
  const allowLocal = deps.allowLocalProviders ?? false
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS

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
    baseUrl: z.string().url().optional(),
    defaultModel: z.string().min(1),
    maxOutputTokens: z.number().int().positive().optional(),
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
      baseUrl?: string
      defaultModel: string
      maxOutputTokens?: number
    })
    return c.json(cred, 201)
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
    let apiKey: string
    try {
      apiKey = await deps.credentials.decryptKey(userId, id)
    } catch {
      return c.json({ error: 'credential_not_found' }, 404)
    }
    const outcome = await testProvider(cred, apiKey, { fetchImpl: deps.fetchImpl })
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

      const body = streamTurnResponse(
        deps.sessions,
        userId,
        sessionId,
        parsed.data.text,
        turnTimeoutMs,
        logger,
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
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const projection = createStreamProjection()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let eventSeq = 0

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (ev: SoccStreamEvent) => {
        eventSeq++
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
        for await (const ev of sessions.sendTurn({ userId, sessionId, text })) {
          if (ev.kind === 'engine') {
            for (const out of projection.step(ev.event as never)) enqueue(out)
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
              enqueue({
                type: 'error',
                code: ERR.InternalError,
                message: ev.errorMessage ?? 'turn failed',
                retriable: false,
              })
              for (const out of projection.finalize('error')) enqueue(out)
            } else if (ev.reason === 'aborted') {
              for (const out of projection.finalize('aborted')) enqueue(out)
            } else {
              // normal completion — use whatever stopReason the projection
              // collected from the engine (or null).
              for (const out of projection.finalize()) enqueue(out)
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
  const sessions = new SessionManager({ credentials, pool, ttlMs: env.SESSION_TTL_MS })
  sessions.start()

  const app = buildApp({
    credentials,
    sessions,
    jwt,
    logger,
    allowLocalProviders: env.SOCC_ALLOW_LOCAL_PROVIDERS,
    turnTimeoutMs: env.TURN_TIMEOUT_MS,
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
