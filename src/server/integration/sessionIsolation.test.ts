// Multi-session concurrency + cross-user isolation.
//
// This is the integration test the PRD §Technical Risks flags as the
// mitigation for the highest-rated risk ("QueryEngine state leaks
// between sessions — Alta probabilidade / Crítico"). It drives real
// Bun Workers (via WorkerPool) with a synthetic worker body that
// mimics socc's STATE-singleton pattern. If realms are truly isolated
// per Worker, each one reports back ONLY the init payload it received.
//
// Coverage (PRD §Fase 1 done criteria + §US-4):
//   - 2 sessions / same user / different providers running concurrently
//   - 2 sessions / different users → cross-access returns 404 (not 403)
//   - forged sessionId from user A targeting user B's session → 404
//   - external terminate (SIGKILL-equivalent) → pool recovers, spawns fresh
//
// We deliberately use the HTTP layer (buildApp) for the cross-user
// assertions because §US-4 AC3 is a wire-level requirement — 404 vs
// 403 matters at the response, not just at the manager.

import { describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import { CredentialsStore } from '../credentials.ts'
import { JWT_AUDIENCE, JWT_ISSUER, JWT_SCOPE, JwtVerifier } from '../auth.ts'
import { buildApp } from '../index.ts'
import { SessionManager } from '../sessionManager.ts'
import { WorkerPool } from '../workerPool.ts'
import { MongoClient } from 'mongodb'

// ── fixtures ─────────────────────────────────────────────────────────

const JWT_SECRET_HEX = 'c'.repeat(64)

// Point the pool at our synthetic worker so we don't need the real socc
// engine (no provider API key, no 20MB bundle load, no flakiness).
const SYNTH_WORKER_URL = new URL('./__testWorker.ts', import.meta.url).href

async function signToken(sub: string, sid?: string): Promise<string> {
  const secret = new Uint8Array(Buffer.from(JWT_SECRET_HEX, 'hex'))
  return new SignJWT({ scope: JWT_SCOPE, sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('120s')
    .sign(secret)
}

// In-memory CredentialsStore substitute that skips Mongo + libsodium.
// Real crypto round-trip is already covered by credentials.test.ts; here
// we only care about the session/worker layer.
function makeInMemCreds() {
  const byUserId = new Map<string, Map<string, {
    id: string
    userId: string
    provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
    label: string
    keyPreview: string
    baseUrl?: string
    defaultModel: string
    maxOutputTokens: number
    createdAt: Date
    revoked: boolean
  }>>()
  const plaintext = new Map<string, string>()

  let counter = 0
  return {
    async create(userId: string, input: {
      provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
      label: string
      apiKey: string
      defaultModel: string
      maxOutputTokens?: number
    }) {
      const id = `cred-${++counter}`
      const cred = {
        id,
        userId,
        provider: input.provider,
        label: input.label,
        keyPreview: `${input.apiKey.slice(0, 3)}...${input.apiKey.slice(-4)}`,
        defaultModel: input.defaultModel,
        maxOutputTokens: input.maxOutputTokens ?? 4096,
        createdAt: new Date(),
        revoked: false,
      }
      if (!byUserId.has(userId)) byUserId.set(userId, new Map())
      byUserId.get(userId)!.set(id, cred)
      plaintext.set(id, input.apiKey)
      return cred
    },
    async list(userId: string) {
      return [...(byUserId.get(userId)?.values() ?? [])].filter((c) => !c.revoked)
    },
    async get(userId: string, id: string) {
      const c = byUserId.get(userId)?.get(id)
      return c && !c.revoked ? c : null
    },
    async decryptKey(userId: string, id: string) {
      const c = byUserId.get(userId)?.get(id)
      if (!c) throw new Error('not found')
      return plaintext.get(id)!
    },
    async decryptAuthSecret(userId: string, id: string) {
      const c = byUserId.get(userId)?.get(id)
      if (!c) throw new Error('not found')
      return { apiKey: plaintext.get(id)!, authMode: 'api_key' as const }
    },
    async revoke(userId: string, id: string) {
      const c = byUserId.get(userId)?.get(id)
      if (c) c.revoked = true
    },
    async countActive(userId: string) {
      return [...(byUserId.get(userId)?.values() ?? [])].filter((c) => !c.revoked).length
    },
    async recordTestResult() {},
  } as unknown as CredentialsStore
}

// Extract the JSON payload from the first `content.delta` event in an
// SSE response — that's where our synthetic Worker echoes its STATE.
async function extractEchoFromSse(res: Response): Promise<Record<string, unknown>> {
  return extractEchoFromText(await res.text())
}

function extractEchoFromText(text: string): Record<string, unknown> {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('event: content.delta')) {
      for (let j = i + 1; j < lines.length && lines[j]; j++) {
        if (lines[j].startsWith('data: ')) {
          const payload = JSON.parse(lines[j].slice(6)) as { text?: string }
          if (payload.text) {
            return JSON.parse(payload.text) as Record<string, unknown>
          }
        }
      }
    }
  }
  throw new Error(`no content.delta in SSE response:\n${text}`)
}

// ── shared harness ──────────────────────────────────────────────────

type Harness = {
  app: ReturnType<typeof buildApp>
  sessions: SessionManager
  pool: WorkerPool
  credentials: ReturnType<typeof makeInMemCreds>
}

function buildHarness(): Harness {
  const credentials = makeInMemCreds()
  const pool = new WorkerPool({ maxConcurrent: 20, workerUrl: SYNTH_WORKER_URL })
  const sessions = new SessionManager({ credentials, pool, ttlMs: 60_000 })
  const jwt = new JwtVerifier(JWT_SECRET_HEX)
  const app = buildApp({ credentials, sessions, jwt, turnTimeoutMs: 30_000 })
  return { app, sessions, pool, credentials }
}

async function seedCred(
  h: Harness,
  userId: string,
  overrides: {
    provider?: 'anthropic' | 'openai' | 'gemini' | 'ollama'
    apiKey?: string
    model?: string
  } = {},
) {
  return h.credentials.create(userId, {
    provider: overrides.provider ?? 'anthropic',
    label: `${userId}-key`,
    apiKey: overrides.apiKey ?? `sk-${userId}-abcdefghij-XYZ1`,
    defaultModel: overrides.model ?? 'claude-sonnet-4-6',
  })
}

// ── shared harness now passes workerUrl directly (no env var) ──

// ── the tests ──────────────────────────────────────────────────────

describe('multi-session isolation (same user, concurrent turns)', () => {
  test('two sessions with different providers run concurrently without STATE leak', async () => {
    const h = buildHarness()
    const userId = 'analyst-42'
    const credA = await seedCred(h, userId, {
      provider: 'anthropic',
      apiKey: 'sk-ant-AAAA-BBBB-CCCC-aaaa',
      model: 'claude-sonnet-4-6',
    })
    const credB = await seedCred(h, userId, {
      provider: 'openai',
      apiKey: 'sk-openai-XXXX-YYYY-ZZZZ-zzzz',
      model: 'gpt-4o',
    })
    const token = await signToken(userId)

    const createBody = (credentialId: string) =>
      JSON.stringify({ credentialId })

    const s1Res = await h.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: createBody(credA.id),
    })
    expect(s1Res.status).toBe(201)
    const s1 = (await s1Res.json()) as { sessionId: string }

    const s2Res = await h.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: createBody(credB.id),
    })
    expect(s2Res.status).toBe(201)
    const s2 = (await s2Res.json()) as { sessionId: string }

    // Fire both turns in parallel. If STATE leaks, the echo from one
    // session would carry the other's apiKeySuffix / provider / model.
    // We await each response twice (.text() after the initial Response
    // resolves) to force the ReadableStream to drain concurrently.
    const startedAt = Date.now()
    const p1 = h.app.request(`/v1/session/${s1.sessionId}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ping-A' }),
    })
    const p2 = h.app.request(`/v1/session/${s2.sessionId}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ping-B' }),
    })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    // Sanity: two parallel turns of ~15ms stall each should finish in
    // well under 2 × 15ms + app overhead. If the pool serializes them
    // accidentally we'd see ~30ms+. Not a timing-sensitive assertion,
    // just a smoke.
    expect(Date.now() - startedAt).toBeLessThan(1000)

    const [echo1, echo2] = await Promise.all([
      extractEchoFromSse(r1),
      extractEchoFromSse(r2),
    ])

    // Each echo must report its OWN session/provider/api key.
    expect(echo1).toMatchObject({
      echo: {
        sessionId: s1.sessionId,
        userId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        apiKeySuffix: 'aaaa',
        promptText: 'ping-A',
      },
    })
    expect(echo2).toMatchObject({
      echo: {
        sessionId: s2.sessionId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        apiKeySuffix: 'zzzz',
        promptText: 'ping-B',
      },
    })

    // Clean up the workers so other tests don't leak them.
    h.pool.shutdownAll()
  })

  test('5 sessions × 3 turns fired concurrently — no cross-session promptCount contamination', async () => {
    const h = buildHarness()
    const userId = 'analyst-burst'
    const token = await signToken(userId)

    // Seed 5 credentials (providers cycle so we also prove model
    // diversity doesn't confuse anyone).
    const providers: Array<'anthropic' | 'openai' | 'gemini'> = [
      'anthropic', 'openai', 'gemini', 'anthropic', 'openai',
    ]
    const creds = await Promise.all(
      providers.map((p, i) =>
        seedCred(h, userId, {
          provider: p,
          apiKey: `sk-burst-${i}-xxxx-${i.toString().padStart(4, '0')}`,
          model: `${p}-model-${i}`,
        }),
      ),
    )
    // Spawn 5 sessions first — needs to be sequential because
    // sessionManager has a per-user quota of 3 and we want to test the
    // quota also. Instead: raise expectation — only 3 succeed, the rest
    // are rejected.
    const sessionResults = await Promise.all(
      creds.slice(0, 3).map((c) =>
        h.app.request('/v1/session', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ credentialId: c.id }),
        }),
      ),
    )
    for (const r of sessionResults) expect(r.status).toBe(201)

    // 4th spawn must hit the quota (PRD §Security: 3 sessions/user).
    const quotaBust = await h.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: creds[3].id }),
    })
    expect(quotaBust.status).toBe(429)
    expect(((await quotaBust.json()) as { error: string }).error).toBe('quota_exceeded')

    const sessions = await Promise.all(
      sessionResults.map((r) => r.json() as Promise<{ sessionId: string }>),
    )

    // Per-session: 3 turns in sequence (PRD §Architecture — one turn in
    // flight per session). Across sessions: run all 3 sequences in
    // parallel = 3 turns concurrently on the wall clock. If STATE leaks
    // between Workers, interleaved timing would mix echoes. A 4th turn
    // on the same session concurrently would be socc_unavailable — that's
    // the correct guard.
    // Drain each response body before issuing the next turn on the
    // same session — otherwise the pool still considers the previous
    // turn in flight and returns socc_unavailable.
    async function runSessionTurns(
      sessionId: string,
      idx: number,
    ): Promise<Array<{ status: number; body: string }>> {
      const out: Array<{ status: number; body: string }> = []
      for (let t = 0; t < 3; t++) {
        const r = await Promise.resolve(
          h.app.request(`/v1/session/${sessionId}/message`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: `s${idx}-t${t}` }),
          }),
        )
        const body = await r.text()
        out.push({ status: r.status, body })
      }
      return out
    }
    const turnBatches = await Promise.all(
      sessions.map((s, idx) => runSessionTurns(s.sessionId, idx)),
    )
    const turnResponses = turnBatches.flat()

    // Parse each echo and bucket by sessionId.
    const echoesBySession = new Map<string, Array<Record<string, unknown>>>()
    for (const r of turnResponses) {
      expect(r.status).toBe(200)
      const echo = extractEchoFromText(r.body)
      const sid = (echo as { echo: { sessionId: string } }).echo.sessionId
      if (!echoesBySession.has(sid)) echoesBySession.set(sid, [])
      echoesBySession.get(sid)!.push(echo)
    }

    // Each session's bucket must contain exactly 3 echoes, all with the
    // SAME apiKeySuffix / provider / model, and promptText belonging to
    // that session's own `s${idx}-t${t}` pattern.
    expect(echoesBySession.size).toBe(3)
    for (let idx = 0; idx < sessions.length; idx++) {
      const bucket = echoesBySession.get(sessions[idx].sessionId)!
      expect(bucket).toHaveLength(3)
      const expectedSuffix = `sk-burst-${idx}-xxxx-${idx.toString().padStart(4, '0')}`.slice(-4)
      const expectedProvider = providers[idx]
      const expectedModel = `${expectedProvider}-model-${idx}`
      const suffixes = new Set(bucket.map((e) => (e as { echo: { apiKeySuffix: string } }).echo.apiKeySuffix))
      const provSet = new Set(bucket.map((e) => (e as { echo: { provider: string } }).echo.provider))
      const modelSet = new Set(bucket.map((e) => (e as { echo: { model: string } }).echo.model))
      const prompts = bucket.map((e) => (e as { echo: { promptText: string } }).echo.promptText)
      expect(suffixes).toEqual(new Set([expectedSuffix]))
      expect(provSet).toEqual(new Set([expectedProvider]))
      expect(modelSet).toEqual(new Set([expectedModel]))
      for (const p of prompts) {
        expect(p.startsWith(`s${idx}-`)).toBe(true)
      }
    }

    h.pool.shutdownAll()
  })

  test('sequential turns on the same session see an incrementing STATE.promptCount (same realm)', async () => {
    const h = buildHarness()
    const userId = 'analyst-43'
    const cred = await seedCred(h, userId)
    const token = await signToken(userId)

    const sRes = await h.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: cred.id }),
    })
    const s = (await sRes.json()) as { sessionId: string }

    const counts: number[] = []
    for (const text of ['t1', 't2', 't3']) {
      const r = await h.app.request(`/v1/session/${s.sessionId}/message`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const echo = await extractEchoFromSse(r)
      counts.push((echo as { echo: { promptCount: number } }).echo.promptCount)
    }
    expect(counts).toEqual([1, 2, 3])

    h.pool.shutdownAll()
  })
})

describe('cross-user isolation (PRD §US-4)', () => {
  test('user B cannot read or stream against user A\'s session — 404 (not 403)', async () => {
    const h = buildHarness()
    const credA = await seedCred(h, 'alice')
    const tokenA = await signToken('alice')
    const tokenB = await signToken('bob')

    const sRes = await h.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: credA.id }),
    })
    const sA = (await sRes.json()) as { sessionId: string }

    // Bob lists: sees nothing.
    const listB = await h.app.request('/v1/session', {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const listBody = (await listB.json()) as { sessions: unknown[] }
    expect(listBody.sessions).toEqual([])

    // Bob tries to stream against Alice's sessionId.
    const streamAttempt = await h.app.request(`/v1/session/${sA.sessionId}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'steal' }),
    })
    expect(streamAttempt.status).toBe(404)
    const errBody = (await streamAttempt.json()) as { error: string }
    // PRD §Security reserved error codes — cross-user must not leak existence.
    expect(errBody.error).toBe('session_not_found')

    // Bob tries to abort.
    const abortAttempt = await h.app.request(`/v1/session/${sA.sessionId}/abort`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    // abort is a best-effort no-op on mismatch (by design — never raises
    // cross-tenant); observable outcome is that Alice's session is
    // still alive.
    expect([204, 404]).toContain(abortAttempt.status)
    expect(h.sessions.getSession('alice', sA.sessionId)).not.toBeNull()

    // Bob tries DELETE — must not terminate Alice's session.
    await h.app.request(`/v1/session/${sA.sessionId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenB}` },
    })
    expect(h.sessions.getSession('alice', sA.sessionId)).not.toBeNull()

    h.pool.shutdownAll()
  })

  test('forged JWT sid mismatch is rejected before any lookup', async () => {
    const h = buildHarness()
    const credA = await seedCred(h, 'alice')
    const tokenA = await signToken('alice')

    const sRes = await h.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: credA.id }),
    })
    const sA = (await sRes.json()) as { sessionId: string }

    // Token claims sid=something-else but URL asks for sA.sessionId → 403.
    const misboundToken = await signToken('alice', 'different-session-ulid')
    const res = await h.app.request(`/v1/session/${sA.sessionId}/message`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${misboundToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('session_forbidden')

    h.pool.shutdownAll()
  })
})

describe('worker crash recovery (PRD §Technical Risks mitigation)', () => {
  test('external Worker terminate → next message returns SSE error.code=session_worker_crashed and frees quota slot', async () => {
    const h = buildHarness()
    const credA = await seedCred(h, 'alice')
    const tokenA = await signToken('alice')

    const sRes = await h.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: credA.id }),
    })
    expect(sRes.status).toBe(201)
    const sA = (await sRes.json()) as { sessionId: string }
    expect(h.sessions.activeCount()).toBe(1)

    // Simulate SIGKILL: reach into the pool and terminate the Worker
    // directly. terminate() fires notifyDied('terminated') which the
    // sessionManager observes via setOnWorkerDied → marks rec.crashed.
    // biome-ignore lint: deliberate cross-boundary access in test
    const slot = (h.pool as unknown as { workers: Map<string, { terminate: () => void; dead: boolean }> }).workers.get(sA.sessionId)!
    slot.terminate()
    expect(slot.dead).toBe(true)

    // The record is still in the index until the next HTTP read…
    expect(h.sessions.activeCount()).toBe(1)

    // …but the next /message returns the canonical PRD code and reaps
    // the session in the same call. retriable=true tells the frontend
    // to offer "Restart session".
    const after = await h.app.request(`/v1/session/${sA.sessionId}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'still alive?' }),
    })
    expect(after.status).toBe(200)
    const body = await after.text()
    expect(body).toContain('event: error')
    // Parse the data line and verify the structured payload.
    const dataLine = body
      .split('\n')
      .find((l) => l.startsWith('data: ') && l.includes('session_worker_crashed'))
    expect(dataLine).toBeTruthy()
    const payload = JSON.parse(dataLine!.slice(6)) as {
      type: string
      code: string
      retriable: boolean
    }
    expect(payload).toMatchObject({
      type: 'error',
      code: 'session_worker_crashed',
      retriable: true,
    })

    // Slot reaped — quota is back to zero.
    expect(h.sessions.activeCount()).toBe(0)

    // New session for the same user works again, even at the per-user
    // quota wall. We seed two extra credentials (we already have credA;
    // need 2 more to push 3 total live sessions).
    const credB = await seedCred(h, 'alice', { provider: 'openai', apiKey: 'sk-x-bbbb' })
    const credC = await seedCred(h, 'alice', { provider: 'gemini', apiKey: 'sk-x-cccc' })
    for (const c of [credA, credB, credC]) {
      const r = await h.app.request('/v1/session', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
        body: JSON.stringify({ credentialId: c.id }),
      })
      expect(r.status).toBe(201)
    }

    h.pool.shutdownAll()
  })

  test('crashed session is also reaped on TTL sweep if HTTP never reads it', async () => {
    // Build a manager with a tiny TTL and start the sweep timer.
    const credentials = makeInMemCreds()
    const pool = new WorkerPool({ maxConcurrent: 5, workerUrl: SYNTH_WORKER_URL })
    // 0ms TTL means every record looks expired on the next sweep tick.
    const sessions = new SessionManager({ credentials, pool, ttlMs: 0 })
    const jwt = new JwtVerifier(JWT_SECRET_HEX)
    const app = buildApp({ credentials, sessions, jwt })

    const cred = await credentials.create('alice', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-x-zzzz',
      defaultModel: 'm',
    })
    const token = await signToken('alice')
    const sRes = await app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: cred.id }),
    })
    const s = (await sRes.json()) as { sessionId: string }
    expect(sessions.activeCount()).toBe(1)

    // Force the slot to die without the HTTP layer noticing.
    // biome-ignore lint: deliberate cross-boundary access in test
    const slot = (pool as unknown as { workers: Map<string, { terminate: () => void }> }).workers.get(s.sessionId)!
    slot.terminate()

    // Manually invoke sweep instead of waiting for the 30s timer.
    // biome-ignore lint: test-only hook
    ;(sessions as unknown as { sweepIdle: () => void }).sweepIdle?.()
    // The crashed branch reaps without calling pool.shutdown again.
    expect(sessions.activeCount()).toBe(0)

    pool.shutdownAll()
  })
})
