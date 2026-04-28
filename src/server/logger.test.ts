import { describe, expect, test } from 'bun:test'
import { mkLogger, REDACT_PATHS } from './logger.ts'

describe('logger redaction', () => {
  test('redacts OAuth and credential secrets from structured logs', () => {
    const lines: string[] = []
    const logger = mkLogger({
      level: 'info',
      stream: {
        write(chunk: string) {
          lines.push(chunk)
        },
      },
    })

    logger.info({
      code: 'oauth-code',
      code_verifier: 'snake-verifier',
      codeVerifier: 'camel-verifier',
      state: 'oauth-state',
      access_token: 'snake-access',
      accessToken: 'camel-access',
      refresh_token: 'snake-refresh',
      authProfile: {
        accessToken: 'profile-access',
        codeVerifier: 'profile-verifier',
      },
      oauth: {
        access_token: 'nested-access',
        state: 'nested-state',
      },
      headers: {
        authorization: 'Bearer secret',
      },
      safe: 'visible',
    }, 'oauth callback')

    const entry = JSON.parse(lines[0]) as Record<string, unknown>
    expect(entry.safe).toBe('visible')
    expect(entry.code).toBe('[REDACTED]')
    expect(entry.code_verifier).toBe('[REDACTED]')
    expect(entry.codeVerifier).toBe('[REDACTED]')
    expect(entry.state).toBe('[REDACTED]')
    expect(entry.access_token).toBe('[REDACTED]')
    expect(entry.accessToken).toBe('[REDACTED]')
    expect(entry.refresh_token).toBe('[REDACTED]')
    expect((entry.authProfile as Record<string, unknown>).accessToken).toBe('[REDACTED]')
    expect((entry.authProfile as Record<string, unknown>).codeVerifier).toBe('[REDACTED]')
    expect((entry.oauth as Record<string, unknown>).access_token).toBe('[REDACTED]')
    expect((entry.oauth as Record<string, unknown>).state).toBe('[REDACTED]')
    expect((entry.headers as Record<string, unknown>).authorization).toBe('[REDACTED]')
  })

  test('redaction list explicitly covers Fase 3.1 OAuth field names', () => {
    expect(REDACT_PATHS).toContain('code')
    expect(REDACT_PATHS).toContain('code_verifier')
    expect(REDACT_PATHS).toContain('codeVerifier')
    expect(REDACT_PATHS).toContain('state')
    expect(REDACT_PATHS).toContain('access_token')
  })
})
