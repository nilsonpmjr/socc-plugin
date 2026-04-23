import { describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import {
  extractBearer,
  JWT_AUDIENCE,
  JWT_ISSUER,
  JwtVerificationError,
  JwtVerifier,
} from './auth.ts'

const SECRET_HEX = 'a'.repeat(64) // 32 bytes of 0xaa, fine for tests
const SECRET = new Uint8Array(Buffer.from(SECRET_HEX, 'hex'))

async function mint(
  overrides: Record<string, unknown> = {},
  options: { expSeconds?: number; issuer?: string; audience?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: 'user-123',
    sid: '01HX000000000000000000000A',
    scope: 'socc',
    ...overrides,
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expSeconds ?? 60))
    .setIssuer(options.issuer ?? JWT_ISSUER)
    .setAudience(options.audience ?? JWT_AUDIENCE)
    .sign(SECRET)
}

describe('JwtVerifier', () => {
  const verifier = new JwtVerifier(SECRET_HEX)

  test('accepts a well-formed scope=socc token', async () => {
    const token = await mint()
    const claims = await verifier.verify(token)
    expect(claims.sub).toBe('user-123')
    expect(claims.sid).toBe('01HX000000000000000000000A')
    expect(claims.scope).toBe('socc')
  })

  test('accepts a token without sid (session-create case)', async () => {
    const token = await mint({ sid: undefined })
    const claims = await verifier.verify(token)
    expect(claims.sid).toBeUndefined()
  })

  test('rejects wrong scope', async () => {
    const token = await mint({ scope: 'admin' })
    await expect(verifier.verify(token)).rejects.toMatchObject({
      name: 'JwtVerificationError',
      code: 'invalid_claims',
    })
  })

  test('rejects wrong issuer', async () => {
    const token = await mint({}, { issuer: 'attacker' })
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(JwtVerificationError)
  })

  test('rejects expired token', async () => {
    const token = await mint({}, { expSeconds: -120 })
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'expired' })
  })

  test('rejects bad signature (different secret)', async () => {
    const badSecret = new Uint8Array(Buffer.from('b'.repeat(64), 'hex'))
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({ sub: 'u', scope: 'socc' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .sign(badSecret)
    await expect(verifier.verify(token)).rejects.toMatchObject({
      code: 'invalid_signature',
    })
  })

  test('rejects empty token', async () => {
    await expect(verifier.verify('')).rejects.toMatchObject({ code: 'missing' })
  })

  test('constructor rejects short secret', () => {
    expect(() => new JwtVerifier('abc')).toThrow()
  })
})

describe('extractBearer', () => {
  test('extracts token from Bearer header', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi')
  })
  test('case-insensitive on the scheme', () => {
    expect(extractBearer('bearer abc')).toBe('abc')
  })
  test('returns null on missing/malformed header', () => {
    expect(extractBearer(null)).toBeNull()
    expect(extractBearer(undefined)).toBeNull()
    expect(extractBearer('Basic abc')).toBeNull()
    expect(extractBearer('')).toBeNull()
  })
})
