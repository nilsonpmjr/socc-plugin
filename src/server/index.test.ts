import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  profiles: Map<string, Record<string, unknown> | undefined>
}

function makeCreds(): { store: CredentialsStore; state: StubCredsState } {
  const state: StubCredsState = { byUser: new Map(), plaintext: new Map(), profiles: new Map() }
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
        authMode: (input as { authMode?: ProviderCredential['authMode'] }).authMode ?? 'api_key',
        label: input.label,
        keyPreview: (() => {
          const authMode = (input as { authMode?: string }).authMode
          const authProfile = (input as { authProfile?: Record<string, unknown> }).authProfile
          if (authMode === 'codex_cli') return `codex:${String(authProfile?.accountId ?? 'local').slice(0, 6)}...`
          if (authMode === 'oauth') return 'oauth:profile'
          if (authMode === 'claude_cli') return 'claude:local'
          if (authMode === 'local_discovery') return 'local'
          return `${input.apiKey.slice(0, 3)}...${input.apiKey.slice(-4)}`
        })(),
        accountId:
          typeof (input as { authProfile?: Record<string, unknown> }).authProfile?.accountId === 'string'
            ? String((input as { authProfile?: Record<string, unknown> }).authProfile?.accountId)
            : undefined,
        baseUrl: input.baseUrl,
        defaultModel: input.defaultModel,
        maxOutputTokens: input.maxOutputTokens ?? 4096,
        createdAt: new Date(),
        revoked: false,
      }
      if (!state.byUser.has(userId)) state.byUser.set(userId, new Map())
      state.byUser.get(userId)!.set(id, cred)
      state.plaintext.set(id, input.apiKey)
      state.profiles.set(id, (input as { authProfile?: Record<string, unknown> }).authProfile)
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
    async decryptAuthSecret(userId: string, id: string) {
      const c = state.byUser.get(userId)?.get(id)
      if (!c) throw new Error('not found')
      return {
        apiKey: state.plaintext.get(id)!,
        authMode: c.authMode ?? 'api_key',
        profile: state.profiles.get(id) ?? (c.accountId ? { accountId: c.accountId } : undefined),
      }
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
  toolResponses: Array<{ sessionId: string; requestId: string; ok: boolean; data?: unknown; errorCode?: string }>
}

function makePool(yielder?: (init: { sessionId: string; turnId: string; text: string }) => TurnEvent[]): {
  pool: WorkerPool
  calls: PoolCalls
} {
  const calls: PoolCalls = { spawn: [], run: [], abort: [], shutdown: [], toolResponses: [] }
  const produce =
    yielder ?? (() => [{ kind: 'end', reason: 'complete' }] as TurnEvent[])
  let onDied: ((ev: { sessionId: string; reason: string; message: string }) => void) | null =
    null
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
    setOnWorkerDied: (h: typeof onDied) => {
      const prev = onDied
      onDied = h
      return prev
    },
    forwardToolResponse: (
      sessionId: string,
      msg: { requestId: string; ok: boolean; data?: unknown; errorCode?: string },
    ) => {
      calls.toolResponses.push({ sessionId, ...msg })
    },
    // Test helper — lets tests simulate a Worker crash.
    __fireDied: (sessionId: string, reason = 'crash', message = 'simulated crash') => {
      onDied?.({ sessionId, reason, message })
    },
  } as unknown as WorkerPool & {
    __fireDied: (sessionId: string, reason?: string, message?: string) => void
  }
  return { pool, calls }
}

// Minimal in-memory MessageStore stub — matches the interface
// used by SessionManager without needing a real MongoDB connection.
import type { MessageStore, StoredMessage } from './messageStore.ts'
import type { OAuthStateRecord, OAuthStateStoreLike } from './oauthState.ts'

function makeMessageStore(): MessageStore & { _records: StoredMessage[] } {
  const _records: StoredMessage[] = []
  const stub = {
    _records,
    async save(msg: Parameters<MessageStore['save']>[0]) {
      const doc: StoredMessage = {
        id: `msg-${_records.length + 1}`,
        sessionId: msg.sessionId,
        userId: msg.userId,
        role: msg.role,
        content: msg.content,
        turnId: msg.turnId,
        createdAt: new Date(),
      }
      _records.push(doc)
      return doc
    },
    async list(
      userId: string,
      sessionId: string,
      opts?: { limit?: number; before?: string },
    ): Promise<StoredMessage[]> {
      const limit = opts?.limit ?? 50
      return _records
        .filter((r) => r.userId === userId && r.sessionId === sessionId)
        .slice(0, limit)
    },
    async exportSession(userId: string, sessionId: string): Promise<StoredMessage[]> {
      return _records.filter((r) => r.userId === userId && r.sessionId === sessionId)
    },
    async deleteByUser(userId: string): Promise<number> {
      const before = _records.length
      _records.splice(0, _records.length, ..._records.filter((r) => r.userId !== userId))
      return before - _records.length
    },
    async deleteBySession(userId: string, sessionId: string): Promise<number> {
      const before = _records.length
      _records.splice(
        0,
        _records.length,
        ..._records.filter((r) => !(r.userId === userId && r.sessionId === sessionId)),
      )
      return before - _records.length
    },
  }
  return stub as unknown as MessageStore & { _records: StoredMessage[] }
}

function makeOAuthStates(): OAuthStateStoreLike & { _records: Map<string, OAuthStateRecord> } {
  const _records = new Map<string, OAuthStateRecord>()
  let seq = 0
  const stub = {
    _records,
    async create(input: Parameters<OAuthStateStoreLike['create']>[0]) {
      seq++
      const now = new Date()
      const rec: OAuthStateRecord = {
        state: `state-${seq}`,
        userId: input.userId,
        provider: input.provider,
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
        createdAt: now,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? 600_000)),
      }
      _records.set(rec.state, rec)
      return rec
    },
    async consume(userId: string, state: string) {
      const rec = _records.get(state)
      if (!rec || rec.userId !== userId || rec.expiresAt <= new Date()) return null
      _records.delete(state)
      return rec
    },
  }
  return stub
}

function buildTestApp(
  poolYield?: Parameters<typeof makePool>[0],
  opts: {
    allowLocalProviders?: boolean
    fetchImpl?: typeof fetch
    turnTimeoutMs?: number
    executeTool?: import('./index.ts').ToolExecutor
    withMessages?: boolean
    oauthStates?: OAuthStateStoreLike
    openaiCodexOAuth?: {
      clientId?: string
      redirectUri?: string
      authorizeUrl?: string
      scope?: string
    }
  } = {},
) {
  const { store, state } = makeCreds()
  const { pool, calls } = makePool(poolYield)
  const msgStore = opts.withMessages ? makeMessageStore() : undefined
  const sessions = new SessionManager({
    credentials: store,
    pool,
    ttlMs: 60_000,
    messages: msgStore,
  })
  const jwt = new JwtVerifier(JWT_SECRET_HEX)
  const app = buildApp({
    credentials: store,
    sessions,
    jwt,
    allowLocalProviders: opts.allowLocalProviders,
    fetchImpl: opts.fetchImpl,
    turnTimeoutMs: opts.turnTimeoutMs,
    executeTool: opts.executeTool,
    messages: msgStore,
    oauthStates: opts.oauthStates,
    openaiCodexOAuth: opts.openaiCodexOAuth,
  })
  return { app, sessions, credentials: store, credState: state, pool, poolCalls: calls, msgStore }
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

// ── OAuth handshakes ─────────────────────────────────────────────────

describe('buildApp OAuth handshakes', () => {
  test('GET /v1/oauth/openai-codex/login returns 501 when state store is absent', async () => {
    const { app } = buildTestApp()
    const token = await signToken({ sub: 'u1' })

    const res = await app.request('/v1/oauth/openai-codex/login', {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ error: 'oauth_not_configured' })
  })

  test('GET /v1/oauth/openai-codex/login redirects with PKCE and stores state', async () => {
    const oauthStates = makeOAuthStates()
    const { app } = buildTestApp(undefined, {
      oauthStates,
      openaiCodexOAuth: {
        clientId: 'codex-client',
        redirectUri: 'http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback',
        authorizeUrl: 'https://auth.openai.test/oauth/authorize',
        scope: 'openid profile',
      },
    })
    const token = await signToken({ sub: 'u1' })

    const res = await app.request('/v1/oauth/openai-codex/login', {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(302)
    const location = res.headers.get('location')
    expect(location).toBeString()
    const url = new URL(location!)
    expect(url.origin + url.pathname).toBe('https://auth.openai.test/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('codex-client')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_verifier')).toBeNull()
    expect(url.searchParams.get('scope')).toBe('openid profile')

    const state = url.searchParams.get('state')
    const stored = oauthStates._records.get(state!)
    expect(stored).toMatchObject({
      state,
      userId: 'u1',
      provider: 'openai-codex',
      redirectUri: 'http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback',
    })
    expect(stored?.codeVerifier.length).toBeGreaterThan(20)
  })

  test('GET /v1/oauth/openai-codex/callback rejects state owned by another user', async () => {
    const oauthStates = makeOAuthStates()
    const { app } = buildTestApp(undefined, {
      oauthStates,
      openaiCodexOAuth: {
        clientId: 'codex-client',
        redirectUri: 'http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback',
      },
    })
    const ownerToken = await signToken({ sub: 'owner' })
    const otherToken = await signToken({ sub: 'other' })
    const login = await app.request('/v1/oauth/openai-codex/login', {
      headers: { authorization: `Bearer ${ownerToken}` },
    })
    const state = new URL(login.headers.get('location')!).searchParams.get('state')

    const res = await app.request(`/v1/oauth/openai-codex/callback?code=abc&state=${state}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'bad_oauth_state' })
    expect(oauthStates._records.has(state!)).toBeTrue()
  })

  test('GET /v1/oauth/openai-codex/callback consumes own state once', async () => {
    const oauthStates = makeOAuthStates()
    const { app } = buildTestApp(undefined, {
      oauthStates,
      openaiCodexOAuth: {
        clientId: 'codex-client',
        redirectUri: 'http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback',
      },
    })
    const token = await signToken({ sub: 'u1' })
    const login = await app.request('/v1/oauth/openai-codex/login', {
      headers: { authorization: `Bearer ${token}` },
    })
    const state = new URL(login.headers.get('location')!).searchParams.get('state')

    const first = await app.request(`/v1/oauth/openai-codex/callback?code=abc&state=${state}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(first.status).toBe(501)
    expect(await first.json()).toMatchObject({ error: 'oauth_exchange_not_configured' })

    const second = await app.request(`/v1/oauth/openai-codex/callback?code=abc&state=${state}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(second.status).toBe(400)
    expect(await second.json()).toMatchObject({ error: 'bad_oauth_state' })
  })

  test('POST /v1/oauth/openai-codex/callback accepts pasted callbackUrl', async () => {
    const oauthStates = makeOAuthStates()
    const { app } = buildTestApp(undefined, {
      oauthStates,
      openaiCodexOAuth: {
        clientId: 'codex-client',
        redirectUri: 'http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback',
      },
    })
    const token = await signToken({ sub: 'u1' })
    const login = await app.request('/v1/oauth/openai-codex/login', {
      headers: { authorization: `Bearer ${token}` },
    })
    const state = new URL(login.headers.get('location')!).searchParams.get('state')

    const res = await app.request('/v1/oauth/openai-codex/callback', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        callbackUrl: `http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback?code=abc&state=${state}`,
      }),
    })

    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ error: 'oauth_exchange_not_configured' })
    expect(oauthStates._records.has(state!)).toBeFalse()
  })

  test('GET /v1/oauth/openai-codex/login rate-limits repeated starts', async () => {
    const oauthStates = makeOAuthStates()
    const { app } = buildTestApp(undefined, {
      oauthStates,
      openaiCodexOAuth: {
        clientId: 'codex-client',
        redirectUri: 'http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback',
      },
    })
    const token = await signToken({ sub: 'u1' })
    for (let i = 0; i < 5; i++) {
      const ok = await app.request('/v1/oauth/openai-codex/login', {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(ok.status).toBe(302)
    }

    const limited = await app.request('/v1/oauth/openai-codex/login', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: 'provider_rate_limited' })
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

  test('POST /v1/credentials/discover-local blocks when local providers are disabled', async () => {
    const { app } = buildTestApp()
    const t = await signToken({ sub: 'u1' })
    const res = await app.request('/v1/credentials/discover-local', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('local_provider_disabled')
  })

  test('POST /v1/credentials/discover-local creates ollama credential from /api/tags', async () => {
    const requests: string[] = []
    const fakeFetch = (async (url: RequestInfo | URL) => {
      requests.push(String(url))
      return new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const { app } = buildTestApp(undefined, { allowLocalProviders: true, fetchImpl: fakeFetch })
    const t = await signToken({ sub: 'u1' })
    const res = await app.request('/v1/credentials/discover-local', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', label: 'Ollama dev' }),
    })
    expect(res.status).toBe(201)
    expect(requests).toEqual(['http://localhost:11434/api/tags'])
    const body = await res.json()
    expect(body).toMatchObject({
      detected: true,
      credential: {
        provider: 'ollama',
        authMode: 'local_discovery',
        label: 'Ollama dev',
        keyPreview: 'local',
        defaultModel: 'llama3.2:latest',
        baseUrl: 'http://localhost:11434',
      },
    })
  })

  test('POST /v1/credentials/discover-local returns detected=false when no model is installed', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof fetch
    const { app } = buildTestApp(undefined, { allowLocalProviders: true, fetchImpl: fakeFetch })
    const t = await signToken({ sub: 'u1' })
    const res = await app.request('/v1/credentials/discover-local', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      detected: false,
      hint: 'Install a model first: ollama pull llama3.2',
    })
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

  test('POST /v1/credentials/import-local-auth imports local Codex CLI auth profile', async () => {
    const ctx = buildTestApp()
    const token = await signToken({ sub: 'u1' })
    const dir = await mkdtemp(join(tmpdir(), 'socc-codex-auth-'))
    const oldPath = process.env.CODEX_AUTH_JSON_PATH
    process.env.CODEX_AUTH_JSON_PATH = join(dir, 'auth.json')
    const accessToken = [
      'header',
      Buffer.from(JSON.stringify({
        'https://api.openai.com/auth.chatgpt_account_id': 'acct_test_123',
      })).toString('base64url'),
      'signature',
    ].join('.')
    await writeFile(
      process.env.CODEX_AUTH_JSON_PATH,
      JSON.stringify({ tokens: { access_token: accessToken } }),
      'utf8',
    )

    try {
      const res = await ctx.app.request('/v1/credentials/import-local-auth', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', source: 'codex_cli' }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body).toMatchObject({
        provider: 'openai',
        authMode: 'codex_cli',
        keyPreview: 'codex:acct_t...',
        accountId: 'acct_test_123',
        defaultModel: 'gpt-5.4',
      })

      const testRes = await ctx.app.request(`/v1/credentials/${body.id}/test`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(await testRes.json()).toMatchObject({ ok: true, result: 'ok' })
    } finally {
      if (oldPath === undefined) delete process.env.CODEX_AUTH_JSON_PATH
      else process.env.CODEX_AUTH_JSON_PATH = oldPath
    }
  })

  test('POST /v1/credentials/import-local-auth imports local Claude CLI auth profile', async () => {
    const ctx = buildTestApp()
    const token = await signToken({ sub: 'u1' })
    const dir = await mkdtemp(join(tmpdir(), 'socc-claude-auth-'))
    const oldPath = process.env.CLAUDE_CREDENTIALS_JSON_PATH
    process.env.CLAUDE_CREDENTIALS_JSON_PATH = join(dir, '.credentials.json')
    await writeFile(
      process.env.CLAUDE_CREDENTIALS_JSON_PATH,
      JSON.stringify({
        organizationUuid: 'org_test_123',
        claudeAiOauth: {
          accessToken: 'claude-oauth-access-token',
          refreshToken: 'claude-refresh-token',
          expiresAt: 1777777777000,
          subscriptionType: 'pro',
          rateLimitTier: 'default_claude_ai',
          scopes: ['user:inference', 'user:profile'],
        },
      }),
      'utf8',
    )

    try {
      const res = await ctx.app.request('/v1/credentials/import-local-auth', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', source: 'claude_cli' }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body).toMatchObject({
        provider: 'anthropic',
        authMode: 'claude_cli',
        keyPreview: 'claude:local',
        defaultModel: 'claude-sonnet-4-6',
      })

      const testRes = await ctx.app.request(`/v1/credentials/${body.id}/test`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(await testRes.json()).toMatchObject({ ok: true, result: 'ok' })
    } finally {
      if (oldPath === undefined) delete process.env.CLAUDE_CREDENTIALS_JSON_PATH
      else process.env.CLAUDE_CREDENTIALS_JSON_PATH = oldPath
    }
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

  test('provider unauthorized TurnEvent is classified for frontend retry UX', async () => {
    const ctx = buildTestApp(() => [
      {
        kind: 'engine',
        event: {
          type: 'assistant',
          message: { id: 'msg_1', content: [{ type: 'text', text: 'partial' }] },
        },
      },
      { kind: 'end', reason: 'error', errorMessage: 'provider returned 401 unauthorized' },
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
    expect(body).toContain('"code":"provider_unauthorized"')
    expect(body).toContain('"retriable":false')
    expect(body).toContain('event: message.end')
  })
})

// ── tool gateway (Fase 5) ────────────────────────────────────────────

describe('buildApp tool gateway', () => {
  test('a tool_request from the worker is dispatched to executeTool, response forwarded', async () => {
    const executorCalls: Array<{ userId: string; sessionId: string; name: string; args: unknown }> = []
    const ctx = buildTestApp(
      // Fake worker stream that emits a tool_request mid-turn, then ends.
      ({ turnId }) => [
        {
          kind: 'tool_request',
          requestId: 'req-test-1',
          name: 'query_feed',
          args: { severity: 'high', limit: 5 },
        },
        { kind: 'end', reason: 'complete' },
      ],
      {
        executeTool: async ({ userId, sessionId, name, args }) => {
          executorCalls.push({ userId, sessionId, name, args })
          return { ok: true, data: { items: [{ id: 'evt-1', severity: 'high' }] } }
        },
      },
    )
    const cred = await ctx.credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const s = await ctx.sessions.createSession({
      userId: 'u1',
      credentialId: cred.id,
      enabledTools: ['query_feed'],
    })
    const t = await signToken({ sub: 'u1' })

    const res = await ctx.app.request(`/v1/session/${s.sessionId}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'use the tool' }),
    })
    expect(res.status).toBe(200)
    // Drain the SSE so the BackgroundTask running executeTool finishes.
    await res.text()
    // Give microtasks one tick to flush forwardToolResponse.
    await new Promise((r) => setTimeout(r, 10))

    expect(executorCalls).toHaveLength(1)
    expect(executorCalls[0]).toMatchObject({
      userId: 'u1',
      sessionId: s.sessionId,
      name: 'query_feed',
      args: { severity: 'high', limit: 5 },
    })
    expect(ctx.poolCalls.toolResponses).toHaveLength(1)
    expect(ctx.poolCalls.toolResponses[0]).toMatchObject({
      sessionId: s.sessionId,
      requestId: 'req-test-1',
      ok: true,
      data: { items: [{ id: 'evt-1', severity: 'high' }] },
    })
  })

  test('when executeTool throws, an error response is forwarded with internal_error', async () => {
    const ctx = buildTestApp(
      () => [
        {
          kind: 'tool_request',
          requestId: 'req-fail',
          name: 'query_feed',
          args: {},
        },
        { kind: 'end', reason: 'complete' },
      ],
      {
        executeTool: async () => {
          throw new Error('Vantage backend unreachable')
        },
      },
    )
    const cred = await ctx.credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const s = await ctx.sessions.createSession({
      userId: 'u1',
      credentialId: cred.id,
      enabledTools: ['query_feed'],
    })
    const t = await signToken({ sub: 'u1' })

    const res = await ctx.app.request(`/v1/session/${s.sessionId}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'use the tool' }),
    })
    expect(res.status).toBe(200)
    await res.text()
    await new Promise((r) => setTimeout(r, 10))

    expect(ctx.poolCalls.toolResponses[0]).toMatchObject({
      requestId: 'req-fail',
      ok: false,
      errorCode: 'internal_error',
    })
  })

  test('without executeTool injected, every tool_request resolves as deny', async () => {
    const ctx = buildTestApp(() => [
      { kind: 'tool_request', requestId: 'r1', name: 'query_feed', args: {} },
      { kind: 'end', reason: 'complete' },
    ])
    const cred = await ctx.credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const s = await ctx.sessions.createSession({
      userId: 'u1',
      credentialId: cred.id,
      enabledTools: ['query_feed'],
    })
    const t = await signToken({ sub: 'u1' })
    const res = await ctx.app.request(`/v1/session/${s.sessionId}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'use it' }),
    })
    await res.text()
    await new Promise((r) => setTimeout(r, 10))
    expect(ctx.poolCalls.toolResponses[0]).toMatchObject({
      ok: false,
      errorCode: 'internal_error',
    })
  })
})

// ── session metadata + history (Fase 5 Iteração D) ───────────────────

describe('buildApp session rename/pin/export/history', () => {
  async function seedSession(ctx: ReturnType<typeof buildTestApp>, userId: string) {
    const cred = await ctx.credentials.create(userId, {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const t = await signToken({ sub: userId })
    const res = await ctx.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: cred.id }),
    })
    const s = (await res.json()) as { sessionId: string; pinned: boolean; sessionName?: string; messageCount: number }
    return { sessionId: s.sessionId, token: t, session: s }
  }

  test('PATCH /v1/session/:id renames the session', async () => {
    const ctx = buildTestApp()
    const { sessionId, token } = await seedSession(ctx, 'u1')

    const res = await ctx.app.request(`/v1/session/${sessionId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionName: 'My IR Session' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessionName).toBe('My IR Session')

    // Persisted — list reflects it.
    const listRes = await ctx.app.request('/v1/session', {
      headers: { authorization: `Bearer ${token}` },
    })
    const sessions = ((await listRes.json()) as { sessions: Array<{ sessionName?: string }> }).sessions
    expect(sessions[0].sessionName).toBe('My IR Session')
  })

  test('POST /v1/session/:id/pin pins the session; pinned sessions survive TTL sweep', async () => {
    const ctx = buildTestApp()
    const { sessionId, token } = await seedSession(ctx, 'u1')

    const pin = await ctx.app.request(`/v1/session/${sessionId}/pin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(pin.status).toBe(200)
    expect((await pin.json()).pinned).toBe(true)

    // Sweep a manager with 0-ms TTL — pinned session survives.
    const store = ctx.sessions as unknown as {
      sweepIdle: () => void
      ttlMs: number
    }
    const original = (store as unknown as { ttlMs: number }).ttlMs
    ;(store as unknown as { ttlMs: number }).ttlMs = 0
    ;(store as unknown as { sweepIdle: () => void }).sweepIdle()
    ;(store as unknown as { ttlMs: number }).ttlMs = original

    expect(ctx.sessions.getSession('u1', sessionId)).not.toBeNull()
  })

  test('DELETE /v1/session/:id/pin unpins the session', async () => {
    const ctx = buildTestApp()
    const { sessionId, token } = await seedSession(ctx, 'u1')

    await ctx.app.request(`/v1/session/${sessionId}/pin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    const unpin = await ctx.app.request(`/v1/session/${sessionId}/pin`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(unpin.status).toBe(200)
    expect((await unpin.json()).pinned).toBe(false)
  })

  test('GET /v1/session/:id/history returns empty list when no MessageStore', async () => {
    const ctx = buildTestApp()
    const { sessionId, token } = await seedSession(ctx, 'u1')

    const res = await ctx.app.request(`/v1/session/${sessionId}/history`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).messages).toEqual([])
  })

  test('GET /v1/session/:id/history returns persisted messages when MessageStore present', async () => {
    const ctx = buildTestApp(undefined, { withMessages: true })
    const { sessionId, token } = await seedSession(ctx, 'u1')

    // Manually record a turn (replicates what streamTurnResponse does).
    await ctx.sessions.recordTurn('u1', sessionId, 'turn-1', 'user', 'hello')
    await ctx.sessions.recordTurn('u1', sessionId, 'turn-1', 'assistant', 'hi there')

    const res = await ctx.app.request(`/v1/session/${sessionId}/history`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const { messages } = (await res.json()) as { messages: Array<{ role: string; content: string }> }
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'hi there' })
  })

  test('GET /v1/session/:id/export returns full conversation JSON', async () => {
    const ctx = buildTestApp(undefined, { withMessages: true })
    const { sessionId, token } = await seedSession(ctx, 'u1')

    await ctx.sessions.recordTurn('u1', sessionId, 'turn-2', 'user', 'export me')
    await ctx.sessions.recordTurn('u1', sessionId, 'turn-2', 'assistant', 'here you go')

    const res = await ctx.app.request(`/v1/session/${sessionId}/export`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string; userId: string; messages: unknown[] }
    expect(body.sessionId).toBe(sessionId)
    expect(body.userId).toBe('u1')
    expect(body.messages).toHaveLength(2)
  })

  test('history cross-tenant: user B cannot read user A sessions history', async () => {
    const ctx = buildTestApp(undefined, { withMessages: true })
    const { sessionId, token: tokenA } = await seedSession(ctx, 'alice')
    const tokenB = await signToken({ sub: 'bob' })

    await ctx.sessions.recordTurn('alice', sessionId, 't', 'user', 'alice secret')

    // Bob tries to read Alice's history.
    const res = await ctx.app.request(`/v1/session/${sessionId}/history`, {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    // Either 200 with empty (no cross-tenant) or 404.
    if (res.status === 200) {
      expect((await res.json()).messages).toEqual([])
    } else {
      expect(res.status).toBe(404)
    }
  })

  test('messageCount increments after recordTurn', async () => {
    const ctx = buildTestApp(undefined, { withMessages: true })
    const { sessionId, session } = await seedSession(ctx, 'u1')
    expect(session.messageCount).toBe(0)

    await ctx.sessions.recordTurn('u1', sessionId, 't', 'user', 'hello')
    const s = ctx.sessions.getSession('u1', sessionId)!
    expect(s.messageCount).toBe(1)
  })

  test('new session summary includes pinned=false and messageCount=0', async () => {
    const ctx = buildTestApp()
    const { session } = await seedSession(ctx, 'u1')
    expect(session.pinned).toBe(false)
    expect(session.messageCount).toBe(0)
  })

  test('POST /v1/session accepts RBAC-derived enabledTools from Vantage', async () => {
    const ctx = buildTestApp()
    const cred = await ctx.credentials.create('u1', {
      provider: 'anthropic',
      label: 'k',
      apiKey: 'sk-ant-xxxxxxxx',
      defaultModel: 'claude-sonnet-4-6',
    })
    const token = await signToken({ sub: 'u1' })

    const res = await ctx.app.request('/v1/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        credentialId: cred.id,
        enabledTools: ['query_feed', 'search_incidents'],
      }),
    })

    expect(res.status).toBe(201)
    expect(ctx.poolCalls.spawn[0].enabledTools).toEqual(['query_feed', 'search_incidents'])
  })
})
