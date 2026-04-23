// JWT verifier for Vantage → plugin requests.
//
// Vantage mints a short-lived HS256 token (scope=socc, TTL 60s) each time
// a user action needs to cross the trust boundary. This module only
// *validates*; token issuance lives in the Vantage backend.
//
// Claim contract (agreed with Vantage backend):
//   sub   — Vantage user id (string)
//   sid   — socc session id (ulid); omitted on session-create requests
//   scope — must equal 'socc'; rejects anything else
//   iss   — 'vantage'
//   aud   — 'socc-plugin'
//   exp   — short TTL (≤ 60s); jose enforces
//   iat   — token mint time
//
// The shared secret comes from SOCC_INTERNAL_SECRET. In prod it's rotated
// by redeploying both sides; there's no in-band rotation for the MVP.

import { jwtVerify, type JWTPayload } from 'jose'

export const JWT_ISSUER = 'vantage'
export const JWT_AUDIENCE = 'socc-plugin'
export const JWT_SCOPE = 'socc'
// Clock skew allowance between Vantage and the plugin. 5s is generous for
// containers on the same docker network; tighten if needed.
const CLOCK_TOLERANCE_SECONDS = 5

export type SoccJwtClaims = {
  sub: string
  sid?: string
  scope: 'socc'
  iss: typeof JWT_ISSUER
  aud: typeof JWT_AUDIENCE
  exp: number
  iat: number
}

export class JwtVerificationError extends Error {
  readonly code:
    | 'missing'
    | 'malformed'
    | 'expired'
    | 'invalid_signature'
    | 'invalid_claims'

  constructor(code: JwtVerificationError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'JwtVerificationError'
  }
}

export class JwtVerifier {
  private readonly secret: Uint8Array

  constructor(secretHex: string) {
    const buf = Buffer.from(secretHex, 'hex')
    if (buf.length < 32) {
      throw new Error(
        `SOCC_INTERNAL_SECRET must be at least 32 bytes (64 hex chars); got ${buf.length} bytes`,
      )
    }
    this.secret = new Uint8Array(buf)
  }

  async verify(token: string): Promise<SoccJwtClaims> {
    if (!token) throw new JwtVerificationError('missing', 'token is empty')

    let payload: JWTPayload
    try {
      const result = await jwtVerify(token, this.secret, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ['HS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      })
      payload = result.payload
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'ERR_JWT_EXPIRED') {
        throw new JwtVerificationError('expired', 'token expired')
      }
      if (
        code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
        code === 'ERR_JWS_INVALID'
      ) {
        throw new JwtVerificationError('invalid_signature', 'bad signature')
      }
      throw new JwtVerificationError('malformed', `token verification failed: ${(err as Error).message}`)
    }

    if (payload.scope !== JWT_SCOPE) {
      throw new JwtVerificationError('invalid_claims', `scope must be '${JWT_SCOPE}'`)
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new JwtVerificationError('invalid_claims', 'sub must be a non-empty string')
    }
    if (payload.sid !== undefined && typeof payload.sid !== 'string') {
      throw new JwtVerificationError('invalid_claims', 'sid must be a string if present')
    }

    return {
      sub: payload.sub,
      sid: payload.sid as string | undefined,
      scope: JWT_SCOPE,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      exp: payload.exp!,
      iat: payload.iat!,
    }
  }
}

// Helper: pulls the bearer token from an `Authorization: Bearer <jwt>`
// header, returns null if the header is absent or malformed. Kept out of
// the verifier class so it can be reused in middleware without coupling.
export function extractBearer(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null
  const match = /^Bearer\s+(.+)$/i.exec(authHeader)
  return match ? match[1]!.trim() : null
}
