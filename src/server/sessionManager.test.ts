import { describe, expect, test } from 'bun:test'
import type { CredentialsStore, ProviderCredential } from './credentials.ts'
import {
  CredentialNotFoundError,
  MAX_SESSIONS_PER_USER,
  SessionManager,
  SessionNotFoundError,
  SessionQuotaError,
} from './sessionManager.ts'
import type { SessionInit, TurnEvent, WorkerPool } from './workerPool.ts'

// Minimal stubs — we're testing coordination logic, not Mongo or Bun Workers.

type CredOverride = Partial<ProviderCredential> & { apiKey?: string }

function makeCreds(
  byId: Record<string, { userId: string; override?: CredOverride }>,
): CredentialsStore {
  const get = async (userId: string, id: string): Promise<ProviderCredential | null> => {
    const entry = byId[id]
    if (!entry || entry.userId !== userId) return null
    const base: ProviderCredential = {
      id,
      userId,
      provider: 'anthropic',
      label: 'test',
      keyPreview: 'sk-...abcd',
      defaultModel: 'claude-sonnet-4-6',
      maxOutputTokens: 4096,
      createdAt: new Date(),
      revoked: false,
    }
    return { ...base, ...entry.override }
  }
  const decryptKey = async (userId: string, id: string): Promise<string> => {
    const entry = byId[id]
    if (!entry || entry.userId !== userId) throw new Error('not found')
    return entry.override?.apiKey ?? 'sk-plaintext'
  }
  return { get, decryptKey } as unknown as CredentialsStore
}

type PoolCalls = {
  spawn: SessionInit[]
  run: Array<{ sessionId: string; turnId: string; text: string }>
  abort: Array<{ sessionId: string; turnId?: string }>
  shutdown: string[]
  shutdownAll: number
}

function makePool(options: {
  runYields?: (sessionId: string, turnId: string, text: string) => TurnEvent[]
  capacityError?: Error
} = {}): { pool: WorkerPool; calls: PoolCalls } {
  const calls: PoolCalls = {
    spawn: [],
    run: [],
    abort: [],
    shutdown: [],
    shutdownAll: 0,
  }
  const yieldsFor =
    options.runYields ?? (() => [{ kind: 'end', reason: 'complete' }] as TurnEvent[])
  let onDied: ((ev: { sessionId: string; reason: string; message: string }) => void) | null =
    null
  const pool = {
    spawn: async (init: SessionInit) => {
      if (options.capacityError) throw options.capacityError
      calls.spawn.push(init)
    },
    run: async function* (sessionId: string, turnId: string, text: string) {
      calls.run.push({ sessionId, turnId, text })
      for (const ev of yieldsFor(sessionId, turnId, text)) yield ev
    },
    abortTurn: (sessionId: string, turnId?: string) => {
      calls.abort.push({ sessionId, turnId })
    },
    shutdown: (sessionId: string) => {
      calls.shutdown.push(sessionId)
    },
    shutdownAll: () => {
      calls.shutdownAll++
    },
    has: (_sid: string) => false,
    size: () => 0,
    setOnWorkerDied: (h: typeof onDied) => {
      const prev = onDied
      onDied = h
      return prev
    },
    __fireDied: (sessionId: string, reason = 'crash', message = 'simulated') => {
      onDied?.({ sessionId, reason, message })
    },
  } as unknown as WorkerPool & {
    __fireDied: (sessionId: string, reason?: string, message?: string) => void
  }
  return { pool, calls }
}

describe('SessionManager.createSession', () => {
  test('boots a worker and records a session', async () => {
    const creds = makeCreds({ c1: { userId: 'u1' } })
    const { pool, calls } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })

    const s = await sm.createSession({ userId: 'u1', credentialId: 'c1' })
    expect(s.userId).toBe('u1')
    expect(s.credentialId).toBe('c1')
    expect(s.model).toBe('claude-sonnet-4-6')
    expect(calls.spawn.length).toBe(1)
    expect(calls.spawn[0].apiKey).toBe('sk-plaintext')
    expect(calls.spawn[0].sessionId).toBe(s.sessionId)
  })

  test('rejects when user hits the per-user quota', async () => {
    const byId: Record<string, { userId: string }> = {}
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 1; i++) byId[`c${i}`] = { userId: 'u1' }
    const creds = makeCreds(byId)
    const { pool } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })

    for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
      await sm.createSession({ userId: 'u1', credentialId: `c${i}` })
    }
    await expect(
      sm.createSession({ userId: 'u1', credentialId: `c${MAX_SESSIONS_PER_USER}` }),
    ).rejects.toBeInstanceOf(SessionQuotaError)
  })

  test('rejects when credential is missing or owned by another user', async () => {
    const creds = makeCreds({ c1: { userId: 'u2' } })
    const { pool } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })

    await expect(
      sm.createSession({ userId: 'u1', credentialId: 'c1' }),
    ).rejects.toBeInstanceOf(CredentialNotFoundError)
    await expect(
      sm.createSession({ userId: 'u1', credentialId: 'missing' }),
    ).rejects.toBeInstanceOf(CredentialNotFoundError)
  })
})

describe('SessionManager.sendTurn', () => {
  test('streams events and bumps lastUsedAt', async () => {
    const creds = makeCreds({ c1: { userId: 'u1' } })
    const { pool, calls } = makePool({
      runYields: () => [
        { kind: 'engine', event: { type: 'assistant', message: { id: 'm1' } } },
        { kind: 'end', reason: 'complete' },
      ],
    })
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })
    const s = await sm.createSession({ userId: 'u1', credentialId: 'c1' })
    const before = sm.getSession('u1', s.sessionId)!.lastUsedAt

    // tiny wait so lastUsedAt can measurably advance
    await new Promise((r) => setTimeout(r, 5))
    const events: TurnEvent[] = []
    for await (const ev of sm.sendTurn({ userId: 'u1', sessionId: s.sessionId, text: 'hi' })) {
      events.push(ev)
    }
    expect(events.length).toBe(2)
    expect(events[events.length - 1]).toMatchObject({ kind: 'end', reason: 'complete' })
    expect(calls.run.length).toBe(1)
    expect(calls.run[0].text).toBe('hi')

    const after = sm.getSession('u1', s.sessionId)!.lastUsedAt
    expect(after.getTime()).toBeGreaterThan(before.getTime())
  })

  test('rejects sendTurn from a different user (no cross-tenant reads)', async () => {
    const creds = makeCreds({ c1: { userId: 'u1' } })
    const { pool } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })
    const s = await sm.createSession({ userId: 'u1', credentialId: 'c1' })

    await expect(async () => {
      for await (const _ev of sm.sendTurn({
        userId: 'u2',
        sessionId: s.sessionId,
        text: 'hi',
      })) {
        /* no-op */
      }
    }).toThrow(SessionNotFoundError)
  })
})

describe('SessionManager.closeSession + abortTurn + shutdown', () => {
  test('closeSession drops the session and terminates the worker', async () => {
    const creds = makeCreds({ c1: { userId: 'u1' } })
    const { pool, calls } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })
    const s = await sm.createSession({ userId: 'u1', credentialId: 'c1' })

    sm.closeSession('u1', s.sessionId)
    expect(calls.shutdown).toEqual([s.sessionId])
    expect(sm.getSession('u1', s.sessionId)).toBeNull()
    expect(sm.listSessions('u1')).toEqual([])
  })

  test('closeSession is a no-op for the wrong owner', async () => {
    const creds = makeCreds({ c1: { userId: 'u1' } })
    const { pool, calls } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })
    const s = await sm.createSession({ userId: 'u1', credentialId: 'c1' })

    sm.closeSession('intruder', s.sessionId)
    expect(calls.shutdown).toEqual([])
    expect(sm.getSession('u1', s.sessionId)).not.toBeNull()
  })

  test('abortTurn forwards to pool when owner matches', async () => {
    const creds = makeCreds({ c1: { userId: 'u1' } })
    const { pool, calls } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })
    const s = await sm.createSession({ userId: 'u1', credentialId: 'c1' })

    sm.abortTurn('u1', s.sessionId, 'turn-42')
    expect(calls.abort).toEqual([{ sessionId: s.sessionId, turnId: 'turn-42' }])

    // wrong owner → silent no-op
    sm.abortTurn('intruder', s.sessionId)
    expect(calls.abort.length).toBe(1)
  })

  test('shutdown drains all sessions and is idempotent', async () => {
    const creds = makeCreds({ c1: { userId: 'u1' }, c2: { userId: 'u2' } })
    const { pool, calls } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })
    await sm.createSession({ userId: 'u1', credentialId: 'c1' })
    await sm.createSession({ userId: 'u2', credentialId: 'c2' })

    await sm.shutdown()
    expect(calls.shutdownAll).toBe(1)
    expect(sm.activeCount()).toBe(0)

    // second call is a no-op
    await sm.shutdown()
    expect(calls.shutdownAll).toBe(1)

    // operations after shutdown fail loudly for create, silently for close
    await expect(
      sm.createSession({ userId: 'u1', credentialId: 'c1' }),
    ).rejects.toThrow(/shut down/)
  })
})

describe('SessionManager listing + quota release on close', () => {
  test('listSessions returns only the caller\'s sessions', async () => {
    const creds = makeCreds({
      c1: { userId: 'u1' },
      c2: { userId: 'u1' },
      c3: { userId: 'u2' },
    })
    const { pool } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })
    await sm.createSession({ userId: 'u1', credentialId: 'c1' })
    await sm.createSession({ userId: 'u1', credentialId: 'c2' })
    await sm.createSession({ userId: 'u2', credentialId: 'c3' })

    const u1 = sm.listSessions('u1')
    const u2 = sm.listSessions('u2')
    expect(u1.length).toBe(2)
    expect(u2.length).toBe(1)
    expect(u1.every((s) => s.userId === 'u1')).toBe(true)
  })

  test('closeSession frees the quota slot', async () => {
    const byId: Record<string, { userId: string }> = {}
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 1; i++) byId[`c${i}`] = { userId: 'u1' }
    const creds = makeCreds(byId)
    const { pool } = makePool()
    const sm = new SessionManager({ credentials: creds, pool, ttlMs: 60_000 })

    const sessions = []
    for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
      sessions.push(await sm.createSession({ userId: 'u1', credentialId: `c${i}` }))
    }
    await expect(
      sm.createSession({ userId: 'u1', credentialId: `c${MAX_SESSIONS_PER_USER}` }),
    ).rejects.toBeInstanceOf(SessionQuotaError)

    sm.closeSession('u1', sessions[0].sessionId)
    // now there is room again
    const s = await sm.createSession({
      userId: 'u1',
      credentialId: `c${MAX_SESSIONS_PER_USER}`,
    })
    expect(s.userId).toBe('u1')
  })
})
