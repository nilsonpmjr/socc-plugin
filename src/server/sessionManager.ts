// Session manager — the facade the HTTP layer actually talks to.
//
// Ties together:
//   - CredentialsStore (to fetch + decrypt a user's provider API key)
//   - WorkerPool       (to spawn/run/terminate Bun Workers)
//   - in-memory index  (per-user session bookkeeping, TTL, quotas)
//
// It does NOT know about HTTP, SSE, or JWT verification. The Hono
// handlers in src/server/index.ts do that and then call into here.
//
// Session model:
//   A session is a live conversational thread tied to a single
//   credential and a single Bun Worker. Sessions are ephemeral — we
//   don't persist them across process restarts (Phase 0 MVP). Chat
//   history will be persisted to Mongo in a later phase so sessions
//   can be rehydrated; for now a restart loses everything.
//
// Quotas (from PRD):
//   - MAX_SESSIONS_PER_USER = 3       (hard cap, creation rejects beyond)
//   - SESSION_TTL_MS                  (idle TTL, bumped on every turn)
//
// Cleanup:
//   A single setInterval sweeps idle sessions. Shutdown is idempotent
//   and drains all Workers via WorkerPool.shutdownAll().

import { ulid } from 'ulid'
import type { CredentialsStore, ProviderCredential } from './credentials.ts'
import {
  PoolCapacityError,
  SessionNotFoundError,
  type SessionInit,
  type TurnEvent,
  TurnConflictError,
  WorkerPool,
} from './workerPool.ts'

export const MAX_SESSIONS_PER_USER = 3
const SWEEP_INTERVAL_MS = 30_000

export type SessionSummary = {
  sessionId: string
  userId: string
  credentialId: string
  provider: ProviderCredential['provider']
  model: string
  createdAt: Date
  lastUsedAt: Date
}

export type CreateSessionRequest = {
  userId: string
  credentialId: string
  systemPrompt?: string
}

type SessionRecord = SessionSummary & {
  // No runtime handle to the Worker here — WorkerPool owns that.
  // We only track metadata for TTL + listing.
}

export class SessionQuotaError extends Error {
  readonly code = 'session_quota'
  constructor(public readonly userId: string, public readonly limit: number) {
    super(`user ${userId} reached session limit (${limit})`)
  }
}

export class CredentialNotFoundError extends Error {
  readonly code = 'credential_not_found'
  constructor(public readonly credentialId: string) {
    super(`credential ${credentialId} not found or revoked`)
  }
}

export { PoolCapacityError, SessionNotFoundError, TurnConflictError }

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly byUser = new Map<string, Set<string>>()
  private readonly pool: WorkerPool
  private readonly credentials: CredentialsStore
  private readonly ttlMs: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(options: {
    credentials: CredentialsStore
    pool: WorkerPool
    ttlMs: number
  }) {
    this.credentials = options.credentials
    this.pool = options.pool
    this.ttlMs = options.ttlMs
  }

  // Starts the idle-sweep timer. Idempotent.
  start(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS)
    // Don't block process exit on this timer.
    this.sweepTimer.unref?.()
  }

  async createSession(req: CreateSessionRequest): Promise<SessionSummary> {
    this.assertRunning()

    const active = this.byUser.get(req.userId)
    if (active && active.size >= MAX_SESSIONS_PER_USER) {
      throw new SessionQuotaError(req.userId, MAX_SESSIONS_PER_USER)
    }

    // credentials.get already filters revoked + scopes by userId.
    const cred = await this.credentials.get(req.userId, req.credentialId)
    if (!cred) throw new CredentialNotFoundError(req.credentialId)

    let apiKey: string
    try {
      apiKey = await this.credentials.decryptKey(req.userId, req.credentialId)
    } catch {
      throw new CredentialNotFoundError(req.credentialId)
    }

    const sessionId = ulid()
    const now = new Date()

    const init: SessionInit = {
      sessionId,
      userId: req.userId,
      provider: cred.provider,
      apiKey,
      baseUrl: cred.baseUrl,
      model: cred.defaultModel,
      maxOutputTokens: cred.maxOutputTokens,
      systemPrompt: req.systemPrompt,
    }

    await this.pool.spawn(init)

    const rec: SessionRecord = {
      sessionId,
      userId: req.userId,
      credentialId: req.credentialId,
      provider: cred.provider,
      model: cred.defaultModel,
      createdAt: now,
      lastUsedAt: now,
    }
    this.sessions.set(sessionId, rec)
    this.indexForUser(req.userId).add(sessionId)
    return { ...rec }
  }

  // Streams TurnEvents for a user turn. Touches lastUsedAt. Callers
  // must be an authenticated user and must own this session.
  async *sendTurn(args: {
    userId: string
    sessionId: string
    text: string
  }): AsyncGenerator<TurnEvent & { turnId: string }> {
    this.assertRunning()
    const rec = this.requireOwned(args.userId, args.sessionId)
    const turnId = ulid()
    rec.lastUsedAt = new Date()

    for await (const ev of this.pool.run(args.sessionId, turnId, args.text)) {
      // Bump on every event so long streams don't get reaped mid-flight.
      rec.lastUsedAt = new Date()
      yield { ...ev, turnId }
    }
  }

  abortTurn(userId: string, sessionId: string, turnId?: string): void {
    const rec = this.sessions.get(sessionId)
    if (!rec || rec.userId !== userId) return
    this.pool.abortTurn(sessionId, turnId)
  }

  closeSession(userId: string, sessionId: string): void {
    const rec = this.sessions.get(sessionId)
    if (!rec || rec.userId !== userId) return
    this.dropSession(sessionId)
  }

  getSession(userId: string, sessionId: string): SessionSummary | null {
    const rec = this.sessions.get(sessionId)
    if (!rec || rec.userId !== userId) return null
    return { ...rec }
  }

  listSessions(userId: string): SessionSummary[] {
    const ids = this.byUser.get(userId)
    if (!ids) return []
    const out: SessionSummary[] = []
    for (const id of ids) {
      const rec = this.sessions.get(id)
      if (rec) out.push({ ...rec })
    }
    return out
  }

  // Returns the number of sessions currently in the pool. Mostly for
  // /health and tests.
  activeCount(): number {
    return this.sessions.size
  }

  // Stops the sweep timer and terminates every Worker. Safe to call
  // more than once.
  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.pool.shutdownAll()
    this.sessions.clear()
    this.byUser.clear()
  }

  // ── internals ─────────────────────────────────────────────────────

  private assertRunning(): void {
    if (this.stopped) throw new Error('session manager is shut down')
  }

  private requireOwned(userId: string, sessionId: string): SessionRecord {
    const rec = this.sessions.get(sessionId)
    if (!rec || rec.userId !== userId) throw new SessionNotFoundError(sessionId)
    return rec
  }

  private indexForUser(userId: string): Set<string> {
    let ids = this.byUser.get(userId)
    if (!ids) {
      ids = new Set()
      this.byUser.set(userId, ids)
    }
    return ids
  }

  private dropSession(sessionId: string): void {
    const rec = this.sessions.get(sessionId)
    if (!rec) return
    this.sessions.delete(sessionId)
    const ids = this.byUser.get(rec.userId)
    if (ids) {
      ids.delete(sessionId)
      if (ids.size === 0) this.byUser.delete(rec.userId)
    }
    this.pool.shutdown(sessionId)
  }

  private sweepIdle(): void {
    if (this.stopped) return
    const cutoff = Date.now() - this.ttlMs
    for (const [sid, rec] of this.sessions) {
      if (rec.lastUsedAt.getTime() < cutoff) {
        this.dropSession(sid)
      }
    }
  }
}
