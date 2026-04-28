// Encrypted per-user LLM provider credentials, stored in MongoDB.
//
// Envelope: libsodium crypto_secretbox_easy (XSalsa20-Poly1305) with a
// 32-byte master key from env (SOCC_MASTER_KEY, hex-encoded).
// Each credential gets a fresh 24-byte random nonce stored alongside the
// ciphertext. The plaintext API key exists only transiently in memory
// during an LLM call and is never cached.
//
// This module is CRUD + crypto only. Provider reachability is tested by
// a separate module (router concern); see PRD section "Security & Privacy".

import sodium from 'libsodium-wrappers'
import { Binary, type Collection, type Db } from 'mongodb'
import { ulid } from 'ulid'

export type Provider = 'anthropic' | 'openai' | 'gemini' | 'ollama'
export type AuthMode =
  | 'api_key'
  | 'oauth'
  | 'codex_cli'
  | 'claude_cli'
  | 'setup_token'
  | 'local_discovery'

export type TestResult =
  | 'ok'
  | 'unauthorized'
  | 'network'
  | 'invalid_model'

export type CreateCredentialInput = {
  provider: Provider
  label: string
  apiKey: string
  authMode?: AuthMode
  authProfile?: Record<string, unknown>
  baseUrl?: string
  defaultModel: string
  maxOutputTokens?: number
}

export type ProviderCredential = {
  id: string
  userId: string
  provider: Provider
  authMode?: AuthMode
  label: string
  keyPreview: string
  accountId?: string
  baseUrl?: string
  defaultModel: string
  maxOutputTokens: number
  createdAt: Date
  lastTestedAt?: Date
  lastTestResult?: TestResult
  revoked: boolean
  revokedAt?: Date
}

export type AuthSecret = {
  apiKey: string
  authMode: AuthMode
  profile?: Record<string, unknown>
}

// Mongo document shape (ciphertext + nonce kept out of ProviderCredential
// so consumers can't accidentally serialize them to a response body).
type CredentialDoc = {
  _id: string
  userId: string
  provider: Provider
  authMode?: AuthMode
  label: string
  keyPreview: string
  accountId?: string
  baseUrl?: string
  defaultModel: string
  maxOutputTokens: number
  ciphertext: Binary
  nonce: Binary
  createdAt: Date
  lastTestedAt?: Date
  lastTestResult?: TestResult
  revoked: boolean
  revokedAt?: Date
  refreshLock?: {
    owner: string
    expiresAt: Date
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096
const MASTER_KEY_LENGTH = 32
// PRD §Security — at most 20 provider credentials per user.
export const MAX_CREDENTIALS_PER_USER = 20
const DEFAULT_REFRESH_LOCK_TTL_MS = 30_000

// Only the last 4 chars of the key are shown; prefix depends on provider
// conventions but we don't parse — the user's raw prefix stays visible.
function previewOf(apiKey: string): string {
  if (apiKey.length <= 8) return '***'
  return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`
}

function previewFor(input: CreateCredentialInput): string {
  if (input.authMode === 'codex_cli') {
    const accountId =
      typeof input.authProfile?.accountId === 'string'
        ? input.authProfile.accountId
        : undefined
    return accountId ? `codex:${accountId.slice(0, 6)}...` : 'codex:local'
  }
  if (input.authMode === 'oauth') return 'oauth:profile'
  if (input.authMode === 'claude_cli') return 'claude:local'
  if (input.authMode === 'setup_token') return 'anthropic:setup-token'
  if (input.authMode === 'local_discovery') return 'local'
  return previewOf(input.apiKey)
}

function plaintextFor(input: CreateCredentialInput): string {
  if (input.authProfile) {
    return JSON.stringify({
      ...input.authProfile,
      authMode: input.authMode ?? 'api_key',
      apiKey: input.apiKey,
    })
  }
  return input.apiKey
}

function plaintextForSecret(secret: AuthSecret): string {
  if (secret.profile) {
    return JSON.stringify({
      ...secret.profile,
      authMode: secret.authMode,
      apiKey: secret.apiKey,
    })
  }
  return secret.apiKey
}

function previewForSecret(secret: AuthSecret): string {
  if (secret.authMode === 'codex_cli') {
    const accountId =
      typeof secret.profile?.accountId === 'string'
        ? secret.profile.accountId
        : undefined
    return accountId ? `codex:${accountId.slice(0, 6)}...` : 'codex:local'
  }
  if (secret.authMode === 'oauth') return 'oauth:profile'
  if (secret.authMode === 'claude_cli') return 'claude:local'
  if (secret.authMode === 'setup_token') return 'anthropic:setup-token'
  if (secret.authMode === 'local_discovery') return 'local'
  return previewOf(secret.apiKey)
}

function toDoc(cred: ProviderCredential, ciphertext: Binary, nonce: Binary): CredentialDoc {
  return {
    _id: cred.id,
    userId: cred.userId,
    provider: cred.provider,
    authMode: cred.authMode,
    label: cred.label,
    keyPreview: cred.keyPreview,
    accountId: cred.accountId,
    baseUrl: cred.baseUrl,
    defaultModel: cred.defaultModel,
    maxOutputTokens: cred.maxOutputTokens,
    ciphertext,
    nonce,
    createdAt: cred.createdAt,
    lastTestedAt: cred.lastTestedAt,
    lastTestResult: cred.lastTestResult,
    revoked: cred.revoked,
    revokedAt: cred.revokedAt,
  }
}

function fromDoc(doc: CredentialDoc): ProviderCredential {
  return {
    id: doc._id,
    userId: doc.userId,
    provider: doc.provider,
    authMode: doc.authMode ?? 'api_key',
    label: doc.label,
    keyPreview: doc.keyPreview,
    accountId: doc.accountId,
    baseUrl: doc.baseUrl,
    defaultModel: doc.defaultModel,
    maxOutputTokens: doc.maxOutputTokens,
    createdAt: doc.createdAt,
    lastTestedAt: doc.lastTestedAt,
    lastTestResult: doc.lastTestResult,
    revoked: doc.revoked,
    revokedAt: doc.revokedAt,
  }
}

export class AuthProfileRefreshLockedError extends Error {
  readonly code = 'auth_profile_refresh_locked'
  constructor(public readonly credentialId: string) {
    super(`credential ${credentialId} already has an active auth refresh lock`)
  }
}

export class CredentialsStore {
  private readonly col: Collection<CredentialDoc>
  private readonly masterKey: Uint8Array
  private initialized = false

  private constructor(col: Collection<CredentialDoc>, masterKey: Uint8Array) {
    this.col = col
    this.masterKey = masterKey
  }

  // libsodium requires async init (loads WASM). Callers must await this
  // once at boot; it also creates the required Mongo indexes.
  static async open(db: Db, masterKeyHex: string): Promise<CredentialsStore> {
    const key = Buffer.from(masterKeyHex, 'hex')
    if (key.length !== MASTER_KEY_LENGTH) {
      throw new Error(
        `SOCC_MASTER_KEY must be ${MASTER_KEY_LENGTH} bytes (${MASTER_KEY_LENGTH * 2} hex chars); got ${key.length} bytes`,
      )
    }
    await sodium.ready
    const col = db.collection<CredentialDoc>('socc_credentials')
    await col.createIndex({ userId: 1, revoked: 1 })
    await col.createIndex({ revoked: 1, revokedAt: 1 })
    const store = new CredentialsStore(col, new Uint8Array(key))
    store.initialized = true
    return store
  }

  async create(userId: string, input: CreateCredentialInput): Promise<ProviderCredential> {
    this.assertReady()
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    const ciphertext = sodium.crypto_secretbox_easy(
      sodium.from_string(plaintextFor(input)),
      nonce,
      this.masterKey,
    )
    const authMode = input.authMode ?? 'api_key'

    const cred: ProviderCredential = {
      id: ulid(),
      userId,
      provider: input.provider,
      authMode,
      label: input.label,
      keyPreview: previewFor(input),
      accountId:
        typeof input.authProfile?.accountId === 'string'
          ? input.authProfile.accountId
          : undefined,
      baseUrl: input.baseUrl,
      defaultModel: input.defaultModel,
      maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      createdAt: new Date(),
      revoked: false,
    }

    await this.col.insertOne(
      toDoc(cred, new Binary(ciphertext), new Binary(nonce)),
    )
    return cred
  }

  async list(userId: string): Promise<ProviderCredential[]> {
    this.assertReady()
    const docs = await this.col
      .find({ userId, revoked: false })
      .sort({ createdAt: -1 })
      .toArray()
    return docs.map(fromDoc)
  }

  async get(userId: string, id: string): Promise<ProviderCredential | null> {
    this.assertReady()
    const doc = await this.col.findOne({ _id: id, userId, revoked: false })
    return doc ? fromDoc(doc) : null
  }

  // Returns the plaintext API key. Callers must use it transiently and
  // never persist/log/cache the return value. Scoped by userId to prevent
  // cross-tenant reads even if an id is guessed.
  async decryptKey(userId: string, id: string): Promise<string> {
    this.assertReady()
    const doc = await this.col.findOne({ _id: id, userId, revoked: false })
    if (!doc) throw new Error(`credential ${id} not found for user`)

    const plaintext = sodium.crypto_secretbox_open_easy(
      doc.ciphertext.buffer,
      doc.nonce.buffer,
      this.masterKey,
    )
    return sodium.to_string(plaintext)
  }

  async decryptAuthSecret(userId: string, id: string): Promise<{
    apiKey: string
    authMode: AuthMode
    profile?: Record<string, unknown>
  }> {
    const raw = await this.decryptKey(userId, id)
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const authMode =
        parsed.authMode === 'codex_cli' ||
        parsed.authMode === 'oauth' ||
        parsed.authMode === 'claude_cli' ||
        parsed.authMode === 'setup_token' ||
        parsed.authMode === 'local_discovery' ||
        parsed.authMode === 'api_key'
          ? parsed.authMode
          : 'api_key'
      const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : raw
      return { apiKey, authMode, profile: parsed }
    } catch {
      return { apiKey: raw, authMode: 'api_key' }
    }
  }

  async refreshAuthSecretWithLock(
    userId: string,
    id: string,
    updater: (current: AuthSecret) => AuthSecret | null | Promise<AuthSecret | null>,
    options: { owner?: string; ttlMs?: number } = {},
  ): Promise<AuthSecret | null> {
    this.assertReady()
    const owner = options.owner ?? ulid()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_REFRESH_LOCK_TTL_MS))

    const lock = await this.col.updateOne(
      {
        _id: id,
        userId,
        revoked: false,
        $or: [
          { refreshLock: { $exists: false } },
          { 'refreshLock.expiresAt': { $lte: now } },
          { 'refreshLock.owner': owner },
        ],
      },
      { $set: { refreshLock: { owner, expiresAt } } },
    )
    if (lock.matchedCount === 0) {
      throw new AuthProfileRefreshLockedError(id)
    }

    try {
      const current = await this.decryptAuthSecret(userId, id)
      const next = await updater(current)
      if (!next) return null

      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
      const ciphertext = sodium.crypto_secretbox_easy(
        sodium.from_string(plaintextForSecret(next)),
        nonce,
        this.masterKey,
      )
      const accountId =
        typeof next.profile?.accountId === 'string'
          ? next.profile.accountId
          : undefined
      const write = await this.col.updateOne(
        {
          _id: id,
          userId,
          revoked: false,
          'refreshLock.owner': owner,
        },
        {
          $set: {
            ciphertext: new Binary(ciphertext),
            nonce: new Binary(nonce),
            authMode: next.authMode,
            keyPreview: previewForSecret(next),
            accountId,
          },
        },
      )
      if (write.matchedCount === 0) {
        throw new AuthProfileRefreshLockedError(id)
      }
      return next
    } finally {
      await this.col.updateOne(
        { _id: id, userId, 'refreshLock.owner': owner },
        { $unset: { refreshLock: '' } },
      )
    }
  }

  async revoke(userId: string, id: string): Promise<void> {
    this.assertReady()
    await this.col.updateOne(
      { _id: id, userId, revoked: false },
      { $set: { revoked: true, revokedAt: new Date() } },
    )
  }

  async recordTestResult(
    userId: string,
    id: string,
    result: TestResult,
  ): Promise<void> {
    this.assertReady()
    await this.col.updateOne(
      { _id: id, userId },
      { $set: { lastTestedAt: new Date(), lastTestResult: result } },
    )
  }

  async countActive(userId: string): Promise<number> {
    this.assertReady()
    return this.col.countDocuments({ userId, revoked: false })
  }

  async hardDeleteRevokedOlderThan(days: number): Promise<number> {
    this.assertReady()
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const res = await this.col.deleteMany({
      revoked: true,
      revokedAt: { $lt: cutoff },
    })
    return res.deletedCount
  }

  private assertReady(): void {
    if (!this.initialized) {
      throw new Error('CredentialsStore not initialized; call CredentialsStore.open() first')
    }
  }
}
