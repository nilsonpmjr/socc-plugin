// Hono + SSE entrypoint.
//
// Wiring:
//   env → Mongo client → CredentialsStore (libsodium) →
//   WorkerPool → SessionManager → JwtVerifier → Hono app
//
// Auth: every route except /health requires `Authorization: Bearer <jwt>`.
// The JWT is minted by Vantage (scope=socc, TTL≤60s). `sub` is the
// Vantage user id — we use that as the tenant scope for everything.
//
// Streaming: turns use text/event-stream. The engine's AsyncIterable is
// projected through createStreamProjection() → encodeSseEvent(). We emit
// a `heartbeat` SSE frame every 15s to keep intermediaries from killing
// idle connections.
//
// Shutdown: SIGTERM/SIGINT drain in-flight turns, close Mongo, terminate
// every Worker. Callers see a clean end-of-stream, not a TCP reset.

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { MongoClient } from 'mongodb'
import { z } from 'zod'
import { extractBearer, JwtVerificationError, JwtVerifier, type SoccJwtClaims } from './auth.ts'
import { CredentialsStore, type Provider } from './credentials.ts'
import {
  CredentialNotFoundError,
  SessionManager,
  SessionNotFoundError,
  SessionQuotaError,
} from './sessionManager.ts'
import {
  closeProjection,
  createStreamProjection,
  encodeSseEvent,
  type SoccStreamEvent,
} from './streamAdapter.ts'
import { PoolCapacityError, TurnConflictError, WorkerPool } from './workerPool.ts'

const HEARTBEAT_INTERVAL_MS = 15_000

// ── env ──────────────────────────────────────────────────────────────

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().default('socc_plugin'),
  SOCC_JWT_SECRET: z.string().min(64), // 32 bytes = 64 hex chars
  SOCC_CREDENTIALS_MASTER_KEY: z.string().length(64), // 32 bytes hex
  SESSION_TTL_MS: z.coerce.number().int().positive().default(900_000),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(50),
})

type AppEnv = z.infer<typeof envSchema>

// ── app builder ───────────────────────────────────────────────────────

type AppDeps = {
  credentials: CredentialsStore
  sessions: SessionManager
  jwt: JwtVerifier
}

type AppVariables = {
  claims: SoccJwtClaims
}

export function buildApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>()

  app.get('/health', (c) =>
    c.json({ status: 'ok', activeSessions: deps.sessions.activeCount() }),
  )

  // Auth middleware for everything below.
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next()
    const token = extractBearer(c.req.header('authorization'))
    if (!token) return c.json({ error: 'missing_bearer' }, 401)
    try {
      const claims = await deps.jwt.verify(token)
      c.set('claims', claims)
    } catch (err) {
      if (err instanceof JwtVerificationError) {
        return c.json({ error: err.code, message: err.message }, 401)
      }
      return c.json({ error: 'auth_failed' }, 401)
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

  app.post('/credentials', async (c) => {
    const userId = c.get('claims').sub
    const parsed = createCredSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
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

  app.get('/credentials', async (c) => {
    const userId = c.get('claims').sub
    const creds = await deps.credentials.list(userId)
    return c.json({ credentials: creds })
  })

  app.delete('/credentials/:id', async (c) => {
    const userId = c.get('claims').sub
    await deps.credentials.revoke(userId, c.req.param('id'))
    return c.body(null, 204)
  })

  // ── sessions ─────────────────────────────────────────────────────

  const createSessionSchema = z.object({
    credentialId: z.string().min(1),
    systemPrompt: z.string().max(32_000).optional(),
  })

  app.post('/sessions', async (c) => {
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
        return c.json({ error: err.code, message: err.message }, 429)
      }
      if (err instanceof CredentialNotFoundError) {
        return c.json({ error: err.code, message: err.message }, 404)
      }
      if (err instanceof PoolCapacityError) {
        return c.json({ error: err.code, message: err.message }, 503)
      }
      throw err
    }
  })

  app.get('/sessions', (c) => {
    const userId = c.get('claims').sub
    return c.json({ sessions: deps.sessions.listSessions(userId) })
  })

  app.delete('/sessions/:id', (c) => {
    const userId = c.get('claims').sub
    deps.sessions.closeSession(userId, c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/sessions/:id/abort', async (c) => {
    const userId = c.get('claims').sub
    const body = (await c.req.json().catch(() => ({}))) as { turnId?: string }
    deps.sessions.abortTurn(userId, c.req.param('id'), body?.turnId)
    return c.body(null, 204)
  })

  // ── turn streaming (SSE) ─────────────────────────────────────────

  const turnSchema = z.object({ text: z.string().min(1).max(32_000) })

  app.post('/sessions/:id/turns', async (c) => {
    const userId = c.get('claims').sub
    const sessionId = c.req.param('id')
    const parsed = turnSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
    }

    // Claim-bound session check: if the JWT carries sid, it must match.
    const claims = c.get('claims')
    if (claims.sid && claims.sid !== sessionId) {
      return c.json({ error: 'sid_mismatch' }, 403)
    }
    if (!deps.sessions.getSession(userId, sessionId)) {
      return c.json({ error: 'session_not_found' }, 404)
    }

    const body = streamTurnResponse(deps.sessions, userId, sessionId, parsed.data.text)
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

  return app
}

// Builds the SSE ReadableStream for a turn. Owns the projection state
// and heartbeat timer; shuts both down cleanly when the iterator ends
// or the client disconnects.
function streamTurnResponse(
  sessions: SessionManager,
  userId: string,
  sessionId: string,
  text: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const project = createStreamProjection()
  let currentMessageId: string | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let eventSeq = 0

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (ev: SoccStreamEvent) => {
        eventSeq++
        controller.enqueue(encoder.encode(encodeSseEvent(ev, eventSeq)))
        if (ev.type === 'message.start') currentMessageId = ev.messageId
        if (ev.type === 'message.end') currentMessageId = null
      }

      heartbeat = setInterval(() => {
        enqueue({ type: 'heartbeat' })
      }, HEARTBEAT_INTERVAL_MS)
      heartbeat.unref?.()

      try {
        for await (const ev of sessions.sendTurn({ userId, sessionId, text })) {
          if (ev.kind === 'engine') {
            for (const out of project(ev.event as never)) enqueue(out)
          } else if (ev.kind === 'end') {
            if (ev.reason === 'error') {
              enqueue({
                type: 'error',
                message: ev.errorMessage ?? 'turn failed',
                retriable: false,
              })
            }
            // close any still-open assistant turn
            for (const out of closeProjection(currentMessageId)) enqueue(out)
          }
        }
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          enqueue({ type: 'error', message: 'session not found', retriable: false })
        } else if (err instanceof TurnConflictError) {
          enqueue({ type: 'error', message: err.message, retriable: true })
        } else {
          enqueue({
            type: 'error',
            message: err instanceof Error ? err.message : 'stream failed',
            retriable: false,
          })
        }
        for (const out of closeProjection(currentMessageId)) enqueue(out)
      } finally {
        if (heartbeat) clearInterval(heartbeat)
        controller.close()
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat)
      // Best-effort: abort the in-flight turn on the pool side.
      sessions.abortTurn(userId, sessionId)
    },
  })
}

// ── bootstrap ─────────────────────────────────────────────────────────

export async function bootstrap(rawEnv: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(rawEnv) satisfies AppEnv

  const mongo = new MongoClient(env.MONGO_URI)
  await mongo.connect()
  const db = mongo.db(env.MONGO_DB)

  const credentials = await CredentialsStore.open(db, env.SOCC_CREDENTIALS_MASTER_KEY)
  const jwt = new JwtVerifier(env.SOCC_JWT_SECRET)
  const pool = new WorkerPool({ maxConcurrent: env.MAX_CONCURRENT_SESSIONS })
  const sessions = new SessionManager({ credentials, pool, ttlMs: env.SESSION_TTL_MS })
  sessions.start()

  const app = buildApp({ credentials, sessions, jwt })

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`socc-plugin listening on :${info.port}`)
  })

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, draining…`)
    await sessions.shutdown()
    await mongo.close()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  return { app, server, shutdown }
}

// Run when invoked directly (not imported for tests).
if (import.meta.main) {
  void bootstrap()
}
