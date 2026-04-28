// Message persistence — stores conversation turns in `socc_messages`
// (PRD §v1.1 + §LGPD).
//
// Schema per document:
//   {
//     _id:       ulid()           — ordered, URL-safe
//     sessionId: string
//     userId:    string           — for cross-tenant enforcement
//     role:      "user" | "assistant"
//     content:   string           — plaintext of this turn
//     turnId:    string           — correlates with the Worker's turnId
//     createdAt: Date             — indexed for TTL + pagination
//     pinned:    false            — default; set to true by pin()
//   }
//
// TTL: a Mongo TTL index on `createdAt` expires documents after
// MESSAGE_TTL_DAYS (default 30, configurable via env). The plugin
// creates this index on CredentialsStore.open()-equivalent call.
//
// Privacy: `userId` is stored alongside every message so a GDPR
// delete-on-user-deactivation sweep can hit a single index.

import { type Collection, type Db, Binary } from 'mongodb'
import { ulid } from 'ulid'

export const MESSAGE_TTL_DAYS_DEFAULT = 30

type MessageDoc = {
  _id: string
  sessionId: string
  userId: string
  role: 'user' | 'assistant'
  content: string
  turnId: string
  createdAt: Date
}

export type StoredMessage = Omit<MessageDoc, '_id'> & { id: string }

export class MessageStore {
  private readonly col: Collection<MessageDoc>
  private initialized = false

  private constructor(col: Collection<MessageDoc>) {
    this.col = col
  }

  static async open(db: Db, ttlDays: number = MESSAGE_TTL_DAYS_DEFAULT): Promise<MessageStore> {
    const col = db.collection<MessageDoc>('socc_messages')
    // Index for TTL expiry (PRD §LGPD: 30 days default).
    await col.createIndex(
      { createdAt: 1 },
      {
        expireAfterSeconds: ttlDays * 24 * 60 * 60,
        background: true,
        name: 'ttl_createdAt',
      },
    )
    // Index for fast per-session pagination.
    await col.createIndex({ sessionId: 1, createdAt: 1 }, { background: true })
    // Index for GDPR delete sweep (users.py deactivate hook).
    await col.createIndex({ userId: 1 }, { background: true })

    const store = new MessageStore(col)
    store.initialized = true
    return store
  }

  async save(msg: {
    sessionId: string
    userId: string
    role: 'user' | 'assistant'
    content: string
    turnId: string
  }): Promise<StoredMessage> {
    this.assertReady()
    const doc: MessageDoc = {
      _id: ulid(),
      sessionId: msg.sessionId,
      userId: msg.userId,
      role: msg.role,
      content: msg.content,
      turnId: msg.turnId,
      createdAt: new Date(),
    }
    await this.col.insertOne(doc)
    return this.toPublic(doc)
  }

  // Returns messages for a session in ascending order (oldest first),
  // paginated via `before` cursor (an _id). Scoped by userId for
  // cross-tenant safety.
  async list(
    userId: string,
    sessionId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<StoredMessage[]> {
    this.assertReady()
    const limit = Math.min(options.limit ?? 50, 200)
    const filter: Record<string, unknown> = { userId, sessionId }
    if (options.before) {
      filter['_id'] = { $lt: options.before }
    }
    const docs = await this.col
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
    // Reverse to return oldest-first.
    return docs.reverse().map((d) => this.toPublic(d))
  }

  // Export ALL messages for a session (PRD §LGPD portabilidade).
  // Scoped by userId. Keys are masked by design — this method returns
  // conversation content only, not credentials.
  async exportSession(userId: string, sessionId: string): Promise<StoredMessage[]> {
    this.assertReady()
    const docs = await this.col
      .find({ userId, sessionId })
      .sort({ createdAt: 1 })
      .toArray()
    return docs.map((d) => this.toPublic(d))
  }

  // LGPD delete-all for a given user. Called from Vantage's
  // users.py deactivate hook via socc.py proxy.
  async deleteByUser(userId: string): Promise<number> {
    this.assertReady()
    const result = await this.col.deleteMany({ userId })
    return result.deletedCount
  }

  // Delete messages for a specific session (fires on uninstall or
  // manual close in the future).
  async deleteBySession(userId: string, sessionId: string): Promise<number> {
    this.assertReady()
    const result = await this.col.deleteMany({ userId, sessionId })
    return result.deletedCount
  }

  private toPublic(doc: MessageDoc): StoredMessage {
    return {
      id: doc._id,
      sessionId: doc.sessionId,
      userId: doc.userId,
      role: doc.role,
      content: doc.content,
      turnId: doc.turnId,
      createdAt: doc.createdAt,
    }
  }

  private assertReady(): void {
    if (!this.initialized) {
      throw new Error('MessageStore not initialized; call MessageStore.open() first')
    }
  }
}
