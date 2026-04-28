import { describe, expect, test, beforeEach } from 'bun:test'
import type { Collection, Db } from 'mongodb'
import { MessageStore } from './messageStore.ts'

// ── In-memory Mongo stub (minimal) ────────────────────────────────────

type Doc = Record<string, unknown>

function makeInMemCol(): Collection<Doc> & { _data: Doc[] } {
  const _data: Doc[] = []
  const col = {
    _data,
    createIndex: async () => {},
    insertOne: async (doc: Doc) => {
      _data.push({ ...doc })
      return { insertedId: doc._id }
    },
    find: (query?: Doc) => {
      let results = _data.filter((doc) => {
        if (!query) return true
        for (const [k, v] of Object.entries(query)) {
          if (doc[k] !== v) return false
        }
        return true
      })
      const cursor = {
        _order: 1 as 1 | -1,
        sort: (_key: unknown, direction: 1 | -1 = 1) => {
          cursor._order = direction
          // Reverse in-place for desc.
          if (direction === -1) results = [...results].reverse()
          return cursor
        },
        limit: (n: number) => ({
          toArray: async () => results.slice(0, n),
        }),
        toArray: async () => results,
      }
      return cursor
    },
    deleteMany: async (query: Doc) => {
      const before = _data.length
      const keep = _data.filter((doc) => {
        for (const [k, v] of Object.entries(query)) {
          if (doc[k] !== v) return true
        }
        return false
      })
      _data.length = 0
      _data.push(...keep)
      return { deletedCount: before - _data.length }
    },
  } as unknown as Collection<Doc> & { _data: Doc[] }
  return col
}

function makeDb(col: Collection<Doc>): Db {
  return {
    collection: () => col,
  } as unknown as Db
}

// ── tests ──────────────────────────────────────────────────────────────

describe('MessageStore', () => {
  let store: MessageStore
  let col: ReturnType<typeof makeInMemCol>

  beforeEach(async () => {
    col = makeInMemCol()
    store = await MessageStore.open(makeDb(col))
  })

  test('save persists a message and returns StoredMessage with id', async () => {
    const msg = await store.save({
      sessionId: 'sess-1',
      userId: 'u1',
      role: 'user',
      content: 'hello world',
      turnId: 'turn-1',
    })
    expect(msg.id).toBeString()
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('hello world')
    expect(col._data).toHaveLength(1)
  })

  test('list returns messages scoped by userId + sessionId (cross-tenant excluded)', async () => {
    await store.save({ sessionId: 'sess-1', userId: 'u1', role: 'user', content: 'A', turnId: 't1' })
    await store.save({ sessionId: 'sess-1', userId: 'u1', role: 'assistant', content: 'B', turnId: 't1' })
    // Different user — must not appear
    await store.save({ sessionId: 'sess-1', userId: 'u2', role: 'user', content: 'C', turnId: 't2' })

    const msgs = await store.list('u1', 'sess-1')
    expect(msgs).toHaveLength(2)
    // Content A and B should appear, C (u2) must not
    const contents = msgs.map((m) => m.content)
    expect(contents).toContain('A')
    expect(contents).toContain('B')
    expect(contents).not.toContain('C')
  })

  test('list limit is respected', async () => {
    for (let i = 0; i < 10; i++) {
      await store.save({ sessionId: 's', userId: 'u', role: 'user', content: `m${i}`, turnId: 't' })
    }
    const msgs = await store.list('u', 's', { limit: 3 })
    expect(msgs).toHaveLength(3)
  })

  test('exportSession returns all messages in ascending order', async () => {
    await store.save({ sessionId: 's', userId: 'u', role: 'user', content: 'first', turnId: 't' })
    await store.save({ sessionId: 's', userId: 'u', role: 'assistant', content: 'second', turnId: 't' })
    const all = await store.exportSession('u', 's')
    expect(all).toHaveLength(2)
    expect(all[0].content).toBe('first')
  })

  test('deleteByUser removes all messages for that user only', async () => {
    await store.save({ sessionId: 's', userId: 'u1', role: 'user', content: 'u1 msg', turnId: 't' })
    await store.save({ sessionId: 's', userId: 'u2', role: 'user', content: 'u2 msg', turnId: 't' })
    const count = await store.deleteByUser('u1')
    expect(count).toBe(1)
    expect(col._data).toHaveLength(1)
    expect(col._data[0]['userId']).toBe('u2')
  })

  test('deleteBySession removes only the specified session', async () => {
    await store.save({ sessionId: 'sess-1', userId: 'u1', role: 'user', content: 'A', turnId: 't' })
    await store.save({ sessionId: 'sess-2', userId: 'u1', role: 'user', content: 'B', turnId: 't' })
    await store.deleteBySession('u1', 'sess-1')
    const remaining = await store.exportSession('u1', 'sess-2')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].content).toBe('B')
  })
})
