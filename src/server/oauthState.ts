import { createHash, randomBytes } from 'node:crypto'
import type { Collection, Db } from 'mongodb'

export type OAuthProvider = 'openai-codex'

export type OAuthStateRecord = {
  state: string
  userId: string
  provider: OAuthProvider
  codeVerifier: string
  redirectUri: string
  createdAt: Date
  expiresAt: Date
}

type OAuthStateDoc = OAuthStateRecord & { _id: string }

export type OAuthStateStoreLike = {
  create(input: {
    userId: string
    provider: OAuthProvider
    codeVerifier: string
    redirectUri: string
    ttlMs?: number
  }): Promise<OAuthStateRecord>
  consume(userId: string, state: string): Promise<OAuthStateRecord | null>
}

const DEFAULT_TTL_MS = 10 * 60 * 1000

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export class OAuthStateStore implements OAuthStateStoreLike {
  private readonly col: Collection<OAuthStateDoc>

  private constructor(col: Collection<OAuthStateDoc>) {
    this.col = col
  }

  static async open(db: Db): Promise<OAuthStateStore> {
    const col = db.collection<OAuthStateDoc>('socc_oauth_state')
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    await col.createIndex({ userId: 1, state: 1 })
    return new OAuthStateStore(col)
  }

  async create(input: {
    userId: string
    provider: OAuthProvider
    codeVerifier: string
    redirectUri: string
    ttlMs?: number
  }): Promise<OAuthStateRecord> {
    const now = new Date()
    const rec: OAuthStateRecord = {
      state: base64url(randomBytes(32)),
      userId: input.userId,
      provider: input.provider,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
      createdAt: now,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
    }
    await this.col.insertOne({ _id: rec.state, ...rec })
    return rec
  }

  async consume(userId: string, state: string): Promise<OAuthStateRecord | null> {
    const doc = await this.col.findOneAndDelete({
      _id: state,
      userId,
      expiresAt: { $gt: new Date() },
    })
    if (!doc) return null
    const { _id: _ignored, ...rec } = doc
    return rec
  }
}
