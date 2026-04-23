import { beforeAll, describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import { JWT_AUDIENCE, JWT_ISSUER, JWT_SCOPE, JwtVerifier } from './auth.ts'
import type { CredentialsStore, Provider, ProviderCredential } from './credentials.ts'
import { buildApp } from './index.ts'
import {
  CredentialNotFoundError,
  SessionManager,
  SessionQuotaError,
  type SessionSummary,
} from './sessionManager.ts'
import type { SessionInit, TurnEvent, WorkerPool } from './workerPool.ts'

// Fixed 32-byte hex secret for JWT signing across the test suite.
const JWT_SECRET_HEX = 'a'.repeat(64)

async function signToken(
  opts: { sub: string; sid?: string; ttlSeconds?: number } & { scope?: string },
): Promise<string> {
  const secret = new Uint8Array(Buffer.from(JWT_SECRET_HEX, 'hex'))
  return new SignJWT({ scope: opts.scope ?? JWT_SCOPE, sid: opts.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${opts.ttlSeconds ?? 60}s`)
    .sign(secret)
}

// ── stubs ────────────────────────────────────────────────────────────

type StubCredsState = {
  byUser: Map<string, Map<string, ProviderCredential>>
  plaintext: Map<string, string>
}

function makeCreds(): { store: CredentialsStore; state: StubCredsState } {
  const state: StubCredsState = { byUser: new Map(), plaintext: new Map() }
  const store = {
    async create(userId: string, input: {
      provider: Provider
      label: string
      apiKey: string
      baseUrl?: string
      defaultModel: string
      maxOutputTokens?: number
    }) {
      const id = `cred-${state.plaintext.size + 1}`
      const cred: ProviderCredential = {
        id,
        userId,
        provider: input.provider,
        label: input.label,
        keyPreview: `${input.apiKey.slice(0, 3)}...${input.apiKey.slice(-4)}`,
        baseUrl: input.baseUrl,
        defaultModel: input.defaultModel,
        maxOutputTokens: input.maxOutputTokens ?? 4096,
        createdAt: new Date(),
        revoked: false,
      }
      if (!state.byUser.has(userId)) state.byUser.set(userId, new Map())
      state.byUser.get(userId)!.set(id, cred)
      state.plaintext.set(id, input.apiKey)
      return cred
    },
    async list(userId: string) {
      return [...(state.byUser.get(userId)?.values() ?? [])].filter((c) => !c.revoked)
    },
    async get(userId: string, id: string) {
      const c = state.byUser.get(userId)?.get(id)
      return c && !c.revoked ? c : null
    },
    async decryptKey(userId: string, id: string) {
      const c = state.byUser.get(userId)?.get(id)
      if (!c) throw new Error('not found')
      return state.plaintext.get(id)!
    },
    async revoke(userId: string, id: string) {
      const c = state.byUser.get(userId)?.get(id)
      if (c) c.revoked = true
    },
    async countActive(userId: string) {
      return [...(state.byUser.get(userId)?.values() ?? [])].filter((c) => !c.revoked).length
    },
    async recordTestResult(userId: string, id: string, result: 'ok' | 'unauthorized' | 'network' | 'invalid_model') {
      const c = state.byUser.get(userId)?.get(id)
      if (c) {
        c.lastTestResult = result
        c.lastTestedAt = new Date()
      }
    },
  } as unknown as CredentialsStore
  return { store, state }
}

type PoolCalls = {
  spawn: SessionInit[]
  run: Array<{ sessionId: string; turnId: string; text: string }>
  abort: Array<{ sessionId: string; turnId?: string }>
  shutdown: string[]
}

function makePool(yielder?: (init: { sessionId: string; turnId: string; text: string }) => TurnEvent[]): {
  pool: WorkerPool
  calls: PoolCalls
} {
  const calls: PoolCalls = { spawn: [], run: [], abort: [], shutdown: [] }
  const produce =
    yielder ?? (() => [{ kind: 'end', reason: 'complete' }] as TurnEvent[])
  const pool = {
    spawn: async (init: SessionInit) => void calls.spawn.push(init),
    run: async function* (sessionId: string, turnId: string, text: string) {
      calls.run.push({ sessionId, turnId, text })
      for (const ev of produce({ sessionId, turnId, text })) yield ev
    },
    abortTurn: (sessionId: string, turnId?: string) => {
      calls.abort.push({ sessionId, turnId })
    },
    shutdown: (sessionId: string) => void calls.shutdown.push(sessionId),
    shutdownAll: () => {},
    has: () => false,
    size: () => 0,
  } as unknown as WorkerPool
  return { pool, calls }
}

function buildTestApp(
  poolYield?: Parameters<typeof makePool>[0],
  opts: { allowLocalProviders?: boolean; fetchImpl?: typeof fetch; turnTimeoutMs?: number } = {},
) {
  const { store, state } = makeCreds()
  const { pool, calls } = makePool(poolYield)
  const sessions = new SessionManager({ credentials: store, pool, ttlMs: 60_000 })
  const jwt = new JwtVerifier(JWT_SECRET_HEX)
  const app = buildApp({
    credentials: store,
    sessions,
    jwt,
    allowLocalProviders: opts.allowLocalProviders,
    fetchImpl: opts.fetchImpl,
    turnTimeoutMs: opts.turnTimeoutMs,
  })
  return { app, sessions, credentials: store, credState: state, pool, poolCalls: calls }
}

// ── auth ─────────────────────────────────────────────────────────────

describe('buildApp auth', () => {
  test('GET /v1/health is unauthenticated', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/v1/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'ok' })
  })

  test('protected routes reject requests without bearer', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/v1/credentials')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('missing_bearer')
  })

  test('protected routes reject invalid signature', async () => {
    const { app } = buildTestApp()
    const bad = await new SignJWT({ scope: JWT_SCOPE })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(new Uint8Array(Buffer.from('b'.repeat(64), 'hex')))
    const res = await app.request('/v1/credentials', {
      headers: { authorization: `Bearer ${bad}` },
    })
    expect(res.status).toBe(401)
  })

  test('protected routes reject wrong scope', async () => {
    const { app } = buildTestApp()
    const token = await signToken({ sub: 'u1', scope: 'something-else' })
    const res = await app.request('/v1/credentials', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })
})

// ── credentials CRUD ─────────────────────────────────────────────────

describe('buildApp credentials', () => {
  test('POST /v1/credentials creates and GET lists for the caller only', async () => {
    const { app } = buildTestApp()
    const t1 = await signToken({ sub: 'u1' })
    const t2 = await signToken({ sub: 'u2' })

    const create = await app.request('/v1/credentials', {
      method: 'POST',
      headers: { authorization: `Bearer ${t1}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        label: 'my key',
        apiKey: 'sk-ant-api03-xxxxxxxxxx',
        defaultModel: 'claude-sonnet-4-6',
      }),
    })
    expect(create.status).toBe(201)
    const cred = await create.json()
    expect(cred.id).toBeString()
    expect(cred.keyPreview).toMatch(/^sk-\.\.\./)

    // u1 sees it
    const list1 = await app.request('/v1/credentials', {
      headers: { authorization: `Bearer ${t1}` },
    })
    expect((await list1.json()).credentials.length).toBe(1)

    // u2 does not
    const list2 = await app.request('/v1/credentials', {
      headers: { authorization: `Bearer ${t2}` },
    })
    expect((await list2.json()).credentials.length).toBe(0)
  })

  test('POST /v1/credentials validates body shape', async () => {
    const { app } = buildTestApp()
    const t = await signToken({ sub: 'u1' })
    const res = await app.request('/v1/credentials', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'bogus', label: '', apiKey: '' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /v1/credentials rejects ollama when SOCC_ALLOW_LOCAL_PROVIDERS=false', async () => {
    const { app } = buildTestApp()
    const t = await signToken({ sub: 'u1' })
    const res = await app.request('/v1/credentials', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        label: 'local',
        apiKey: 'unused-but-required-length',
        defaultModel: 'llama3',
      }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('local_provider_disabled')
  })

  test('POST /v1/credentials accepts ollama when allowLocalProviders=true', async () => {
    const { app } = buildTestApp(undefined, { allowLocalProviders: true })
    const t = await signToken({ sub: 'u1' })
    const res = await app.request('/v1/credentials', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        label: 'local',
        apiKey: 'unused-but-required-length',
        defaultModel: 'llama3',
      }),
    })
    expect(res.status).toBe(201)
  })

  test('POST /v1/credentials caps at 20 per user with quota_exceeded', async () => {
    const { app, credentials } = buildTestApp()
    for (let i = 0; i < 20; i++) {
      await credentials.create('u1', {
        provider: 'anthropic',
        label: `k${i}`,
        apiKey: 'sk-ant-xxxxxxxx',
        defaultModel: 'claude-sonnet-4-6',
      })
    }
    const t = await signToken({ sub: 'u1' })
    const res = await app.request('/v1/credentials', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        label: 'over',
        apiKey: 'sk-ant-xxxxxxxx',
        defaultModel: 'claude-sonnet-4-6',
      }),
    })
    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe('quota_exceeded')
  })

  test('POST /v1/credentials/:id/test round-trips provider + records result', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as unknown as typeof fetch
    const { app, credentials } = buildTestApp(undefined, { fetchImpl: fakeFetch })
    const cred = await credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const t = await signToken({ sub: 'u1' })
    const res = await app.request(`/v1/credentials/${cred.id}/test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, result: 'ok' })
    // recorded on the doc
    const [updated] = await credentials.list('u1')
    expect(updated.lastTestResult).toBe('ok')
  })

  test('POST /v1/credentials/:id/test surfaces unauthorized when provider returns 401', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'bad key' }), { status: 401 })) as unknown as typeof fetch
    const { app, credentials } = buildTestApp(undefined, { fetchImpl: fakeFetch })
    const cred = await credentials.create('u1', {
      provider: 'openai',
      label: 'k',
      apiKey: 'sk-xxxxxxxxxx',
      defaultModel: 'gpt-4o-mini',
    })
    const t = await signToken({ sub: 'u1' })
    const res = await app.request(`/v1/credentials/${cred.id}/test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: '{}',
    })
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.result).toBe('unauthorized')
  })

  test('DELETE /v1/credentials/:id revokes', async () => {
    const { app, credentials } = buildTestApp()
    const t = await signToken({ sub: 'u1' })
    const cred = await credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const res = await app.request(`/v1/credentials/${cred.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${t}` },
    })
    expect(res.status).toBe(204)
    expect((await credentials.list('u1')).length).toBe(0)
  })
})

// ── sessions ─────────────────────────────────────────────────────────

describe('buildApp sessions', () => {
  async function seedCred(app: ReturnType<typeof buildTestApp>, userId: string) {
    return app.credentials.create(userId, {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
  }

  test('POST /v1/session spawns a worker and returns 201', async () => {
    const ctx = buildTestApp()
    const cred = await seedCred(ctx, 'u1')
    const t = await signToken({ sub: 'u1' })

    const res = await ctx.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: cred.id }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as SessionSummary
    expect(body.userId).toBe('u1')
    expect(ctx.poolCalls.spawn.length).toBe(1)
    expect(ctx.poolCalls.spawn[0].apiKey).toBe('sk-ant-xxxxxxxx')
  })

  test('POST /v1/session with missing credential → 404', async () => {
    const ctx = buildTestApp()
    const t = await signToken({ sub: 'u1' })
    const res = await ctx.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: 'nope' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('credential_not_found')
  })

  test('POST /v1/session over quota → 429', async () => {
    const ctx = buildTestApp()
    const creds = await Promise.all([
      seedCred(ctx, 'u1'),
      seedCred(ctx, 'u1'),
      seedCred(ctx, 'u1'),
      seedCred(ctx, 'u1'),
    ])
    const t = await signToken({ sub: 'u1' })
    for (let i = 0; i < 3; i++) {
      const ok = await ctx.app.request('/v1/session', {
        method: 'POST',
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: JSON.stringify({ credentialId: creds[i].id }),
      })
      expect(ok.status).toBe(201)
    }
    const over = await ctx.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: creds[3].id }),
    })
    expect(over.status).toBe(429)
  })

  test('GET /v1/session lists only the caller\'s sessions', async () => {
    const ctx = buildTestApp()
    const c1 = await seedCred(ctx, 'u1')
    const c2 = await seedCred(ctx, 'u2')
    await ctx.sessions.createSession({ userId: 'u1', credentialId: c1.id })
    await ctx.sessions.createSession({ userId: 'u2', credentialId: c2.id })
    const t = await signToken({ sub: 'u1' })
    const res = await ctx.app.request('/v1/session', {
      headers: { authorization: `Bearer ${t}` },
    })
    const body = await res.json()
    expect(body.sessions.length).toBe(1)
    expect(body.sessions[0].userId).toBe('u1')
  })

  test('DELETE /v1/session/:id closes the session', async () => {
    const ctx = buildTestApp()
    const cred = await seedCred(ctx, 'u1')
    const s = await ctx.sessions.createSession({ userId: 'u1', credentialId: cred.id })
    const t = await signToken({ sub: 'u1' })
    const res = await ctx.app.request(`/v1/session/${s.sessionId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${t}` },
    })
    expect(res.status).toBe(204)
    expect(ctx.sessions.getSession('u1', s.sessionId)).toBeNull()
  })
})

// ── streaming /turns ─────────────────────────────────────────────────

describe('buildApp /v1/session/:id/turns SSE', () => {
  async function consumeSse(res: Response): Promise<string> {
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    return text
  }

  test('404 when session does not exist', async () => {
    const ctx = buildTestApp()
    const t = await signToken({ sub: 'u1' })
    const res = await ctx.app.request('/v1/session/missing/turns', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(404)
  })

  test('400 when body is missing text', async () => {
    const ctx = buildTestApp()
    const cred = await ctx.credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const s = await ctx.sessions.createSession({ userId: 'u1', credentialId: cred.id })
    const t = await signToken({ sub: 'u1' })
    const res = await ctx.app.request(`/v1/session/${s.sessionId}/turns`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('403 when JWT sid does not match sessionId', async () => {
    const ctx = buildTestApp()
    const cred = await ctx.credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const s = await ctx.sessions.createSession({ userId: 'u1', credentialId: cred.id })
    const t = await signToken({ sub: 'u1', sid: 'other-session' })
    const res = await ctx.app.request(`/v1/session/${s.sessionId}/turns`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(403)
  })

  test('streams projected SSE frames for a full assistant turn', async () => {
    const ctx = buildTestApp(() => [
      {
        kind: 'engine',
        event: {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [{ type: 'text', text: 'hi there' }],
          },
        },
      },
      { kind: 'end', reason: 'complete' },
    ])
    const cred = await ctx.credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const s = await ctx.sessions.createSession({ userId: 'u1', credentialId: cred.id })
    const t = await signToken({ sub: 'u1' })
    const res = await ctx.app.request(`/v1/session/${s.sessionId}/turns`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = await consumeSse(res)
    // must contain each expected event
    expect(body).toContain('event: message.start')
    expect(body).toContain('event: content.delta')
    expect(body).toContain('event: content.done')
    expect(body).toContain('event: message.end')
    // frames are terminated by a blank line
    expect(body.endsWith('\n\n')).toBe(true)
  })

  test('error TurnEvent surfaces as error + message.end', async () => {
    const ctx = buildTestApp(() => [
      {
        kind: 'engine',
        event: {
          type: 'assistant',
          message: { id: 'msg_1', content: [{ type: 'text', text: 'partial' }] },
        },
      },
      { kind: 'end', reason: 'error', errorMessage: 'boom' },
    ])
    const cred = await ctx.credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const s = await ctx.sessions.createSession({ userId: 'u1', credentialId: cred.id })
    const t = await signToken({ sub: 'u1' })
    const res = await ctx.app.request(`/v1/session/${s.sessionId}/turns`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    const body = await res.text()
    expect(body).toContain('event: error')
    expect(body).toContain('boom')
    expect(body).toContain('event: message.end')
  })
})
