import { describe, expect, test } from 'bun:test'
import { Binary, type Db } from 'mongodb'
import {
  AuthProfileRefreshLockedError,
  CredentialsStore,
  type AuthSecret,
} from './credentials.ts'

type FakeDoc = Record<string, unknown> & { _id: string }

class FakeCollection {
  readonly docs = new Map<string, FakeDoc>()

  async createIndex(): Promise<string> {
    return 'idx'
  }

  async insertOne(doc: FakeDoc): Promise<{ insertedId: string }> {
    this.docs.set(doc._id, doc)
    return { insertedId: doc._id }
  }

  async findOne(query: Record<string, unknown>): Promise<FakeDoc | null> {
    return [...this.docs.values()].find((doc) => matches(doc, query)) ?? null
  }

  async updateOne(
    query: Record<string, unknown>,
    update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> },
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const doc = [...this.docs.values()].find((candidate) => matches(candidate, query))
    if (!doc) return { matchedCount: 0, modifiedCount: 0 }
    for (const [key, value] of Object.entries(update.$set ?? {})) setPath(doc, key, value)
    for (const key of Object.keys(update.$unset ?? {})) unsetPath(doc, key)
    return { matchedCount: 1, modifiedCount: 1 }
  }

  find(query: Record<string, unknown>) {
    const docs = [...this.docs.values()].filter((doc) => matches(doc, query))
    return {
      sort: () => ({
        toArray: async () => docs,
      }),
    }
  }

  async countDocuments(query: Record<string, unknown>): Promise<number> {
    return [...this.docs.values()].filter((doc) => matches(doc, query)).length
  }

  async deleteMany(query: Record<string, unknown>): Promise<{ deletedCount: number }> {
    const ids = [...this.docs.values()]
      .filter((doc) => matches(doc, query))
      .map((doc) => doc._id)
    for (const id of ids) this.docs.delete(id)
    return { deletedCount: ids.length }
  }
}

function makeDb() {
  const collection = new FakeCollection()
  const db = {
    collection: () => collection,
  } as unknown as Db
  return { db, collection }
}

function getPath(doc: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[part]
  }, doc)
}

function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor = doc
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (!next || typeof next !== 'object') cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]!] = value
}

function unsetPath(doc: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  let cursor = doc
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (!next || typeof next !== 'object') return
    cursor = next as Record<string, unknown>
  }
  delete cursor[parts[parts.length - 1]!]
}

function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(query)) {
    if (key === '$or') {
      const clauses = expected as Record<string, unknown>[]
      if (!clauses.some((clause) => matches(doc, clause))) return false
      continue
    }
    const actual = getPath(doc, key)
    if (isOperatorObject(expected)) {
      if ('$exists' in expected) {
        const exists = actual !== undefined
        if (exists !== expected.$exists) return false
      }
      if ('$lte' in expected) {
        const actualTime = actual instanceof Date ? actual.getTime() : Number.NaN
        const expectedTime =
          expected.$lte instanceof Date ? expected.$lte.getTime() : Number(expected.$lte)
        if (!(actualTime <= expectedTime)) return false
      }
      if ('$lt' in expected) {
        const actualTime = actual instanceof Date ? actual.getTime() : Number.NaN
        const expectedTime =
          expected.$lt instanceof Date ? expected.$lt.getTime() : Number(expected.$lt)
        if (!(actualTime < expectedTime)) return false
      }
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.keys(value as Record<string, unknown>).some((key) => key.startsWith('$')),
  )
}

describe('CredentialsStore auth profile refresh lock', () => {
  test('re-encrypts an updated auth profile while holding a per-credential lock', async () => {
    const { db, collection } = makeDb()
    const store = await CredentialsStore.open(db, 'a'.repeat(64))
    const cred = await store.create('u1', {
      provider: 'openai',
      label: 'OpenAI OAuth',
      apiKey: 'access-old',
      authMode: 'oauth',
      authProfile: {
        accessToken: 'access-old',
        refreshToken: 'refresh-secret',
        accountId: 'acct_123456789',
        expiresAt: '2026-04-28T00:00:00.000Z',
      },
      defaultModel: 'gpt-5.4',
    })

    const updated = await store.refreshAuthSecretWithLock(
      'u1',
      cred.id,
      (current): AuthSecret => ({
        ...current,
        apiKey: 'access-new',
        profile: {
          ...current.profile,
          accessToken: 'access-new',
          expiresAt: '2026-04-29T00:00:00.000Z',
        },
      }),
      { owner: 'refresh-worker' },
    )

    expect(updated?.apiKey).toBe('access-new')
    const secret = await store.decryptAuthSecret('u1', cred.id)
    expect(secret.apiKey).toBe('access-new')
    expect(secret.profile?.refreshToken).toBe('refresh-secret')
    expect(secret.profile?.accessToken).toBe('access-new')
    expect(collection.docs.get(cred.id)?.refreshLock).toBeUndefined()

    const publicCred = await store.get('u1', cred.id)
    expect(publicCred?.keyPreview).toBe('oauth:profile')
    expect(publicCred?.accountId).toBe('acct_123456789')
  })

  test('rejects a refresh when another live lock owns the profile', async () => {
    const { db, collection } = makeDb()
    const store = await CredentialsStore.open(db, 'b'.repeat(64))
    const cred = await store.create('u1', {
      provider: 'openai',
      label: 'OpenAI OAuth',
      apiKey: 'access-old',
      authMode: 'oauth',
      authProfile: { refreshToken: 'refresh-secret' },
      defaultModel: 'gpt-5.4',
    })
    collection.docs.get(cred.id)!.refreshLock = {
      owner: 'other-worker',
      expiresAt: new Date(Date.now() + 60_000),
    }

    let called = false
    await expect(
      store.refreshAuthSecretWithLock(
        'u1',
        cred.id,
        () => {
          called = true
          return { apiKey: 'access-new', authMode: 'oauth' }
        },
        { owner: 'refresh-worker' },
      ),
    ).rejects.toBeInstanceOf(AuthProfileRefreshLockedError)
    expect(called).toBeFalse()
    expect((await store.decryptAuthSecret('u1', cred.id)).apiKey).toBe('access-old')
  })

  test('allows a refresh worker to take over an expired lock', async () => {
    const { db, collection } = makeDb()
    const store = await CredentialsStore.open(db, 'c'.repeat(64))
    const cred = await store.create('u1', {
      provider: 'openai',
      label: 'OpenAI OAuth',
      apiKey: 'access-old',
      authMode: 'oauth',
      authProfile: { refreshToken: 'refresh-secret' },
      defaultModel: 'gpt-5.4',
    })
    collection.docs.get(cred.id)!.refreshLock = {
      owner: 'dead-worker',
      expiresAt: new Date(Date.now() - 1),
    }

    await store.refreshAuthSecretWithLock(
      'u1',
      cred.id,
      () => ({ apiKey: 'access-new', authMode: 'oauth', profile: { refreshToken: 'refresh-secret' } }),
      { owner: 'refresh-worker' },
    )

    expect((await store.decryptAuthSecret('u1', cred.id)).apiKey).toBe('access-new')
    expect(collection.docs.get(cred.id)?.refreshLock).toBeUndefined()
  })

  test('does not rewrite ciphertext when updater reports the token is still fresh', async () => {
    const { db, collection } = makeDb()
    const store = await CredentialsStore.open(db, 'd'.repeat(64))
    const cred = await store.create('u1', {
      provider: 'openai',
      label: 'OpenAI OAuth',
      apiKey: 'access-old',
      authMode: 'oauth',
      authProfile: { refreshToken: 'refresh-secret' },
      defaultModel: 'gpt-5.4',
    })
    const before = collection.docs.get(cred.id)?.ciphertext as Binary

    const result = await store.refreshAuthSecretWithLock('u1', cred.id, () => null, {
      owner: 'refresh-worker',
    })

    expect(result).toBeNull()
    expect(collection.docs.get(cred.id)?.ciphertext).toBe(before)
    expect(collection.docs.get(cred.id)?.refreshLock).toBeUndefined()
  })
})
