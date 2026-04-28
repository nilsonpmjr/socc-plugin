import { beforeEach, describe, expect, test } from 'bun:test'
import type { Collection, Db, Filter } from 'mongodb'
import { createPkcePair, OAuthStateStore, type OAuthStateRecord } from './oauthState.ts'

type OAuthStateDoc = OAuthStateRecord & { _id: string }

function matches(doc: OAuthStateDoc, filter: Filter<OAuthStateDoc>): boolean {
  for (const [key, expected] of Object.entries(filter) as Array<[keyof OAuthStateDoc, unknown]>) {
    const actual = doc[key]
    if (
      expected &&
      typeof expected === 'object' &&
      '$gt' in expected &&
      expected.$gt instanceof Date
    ) {
      if (!(actual instanceof Date) || actual <= expected.$gt) return false
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

function makeOAuthCol(): Collection<OAuthStateDoc> & { _data: OAuthStateDoc[] } {
  const _data: OAuthStateDoc[] = []
  return {
    _data,
    createIndex: async () => 'idx',
    insertOne: async (doc: OAuthStateDoc) => {
      _data.push({ ...doc })
      return { insertedId: doc._id }
    },
    findOneAndDelete: async (filter: Filter<OAuthStateDoc>) => {
      const index = _data.findIndex((doc) => matches(doc, filter))
      if (index === -1) return null
      const [doc] = _data.splice(index, 1)
      return doc
    },
  } as unknown as Collection<OAuthStateDoc> & { _data: OAuthStateDoc[] }
}

function makeDb(col: Collection<OAuthStateDoc>): Db {
  return {
    collection: () => col,
  } as unknown as Db
}

describe('OAuthStateStore', () => {
  let col: ReturnType<typeof makeOAuthCol>
  let store: OAuthStateStore

  beforeEach(async () => {
    col = makeOAuthCol()
    store = await OAuthStateStore.open(makeDb(col))
  })

  test('createPkcePair returns verifier and S256 challenge without leaking verifier shape', () => {
    const pkce = createPkcePair()
    expect(pkce.verifier).toBeString()
    expect(pkce.challenge).toBeString()
    expect(pkce.verifier).not.toBe(pkce.challenge)
    expect(pkce.verifier.length).toBeGreaterThan(40)
    expect(pkce.challenge.length).toBeGreaterThan(40)
  })

  test('state generated for one user cannot be consumed by another user', async () => {
    const rec = await store.create({
      userId: 'user-a',
      provider: 'openai-codex',
      codeVerifier: 'verifier-a',
      redirectUri: 'http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback',
    })

    const wrongUser = await store.consume('user-b', rec.state)
    expect(wrongUser).toBeNull()
    expect(col._data).toHaveLength(1)

    const owner = await store.consume('user-a', rec.state)
    expect(owner).toMatchObject({
      state: rec.state,
      userId: 'user-a',
      provider: 'openai-codex',
      codeVerifier: 'verifier-a',
    })
    expect(col._data).toHaveLength(0)
  })

  test('expired state cannot be consumed', async () => {
    const rec = await store.create({
      userId: 'user-a',
      provider: 'openai-codex',
      codeVerifier: 'expired-verifier',
      redirectUri: 'http://127.0.0.1:3000/api/socc/oauth/openai-codex/callback',
      ttlMs: -1,
    })

    const consumed = await store.consume('user-a', rec.state)
    expect(consumed).toBeNull()
    expect(col._data).toHaveLength(1)
  })
})
