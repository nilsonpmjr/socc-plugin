import { describe, expect, test } from 'bun:test'
import * as jose from 'jose'
import { createToolsExecutor } from './toolsExecutor.ts'

// 32-byte hex secret; same constraint as SOCC_INTERNAL_SECRET.
const SECRET_HEX = '11'.repeat(32) // 64 hex chars

type FakeCall = {
  url: string
  method: string
  authHeader: string | null
  body: Record<string, unknown>
}

// Build a fake fetch that records the call and returns the given response.
function fakeFetch(
  status: number,
  responseBody: unknown,
): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string> ?? {}
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      authHeader: headers['Authorization'] ?? null,
      body: JSON.parse((init?.body as string) ?? '{}'),
    })
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetch: fetchFn as typeof fetch, calls }
}

describe('createToolsExecutor', () => {
  test('mints JWT with correct claims and calls Vantage /socc/tools/:name', async () => {
    const { fetch: fakeFn, calls } = fakeFetch(200, { ok: true, data: { items: [] } })
    const exec = createToolsExecutor({
      vantageApiUrl: 'http://vantage:8000/api',
      internalSecretHex: SECRET_HEX,
      fetchImpl: fakeFn,
    })

    const result = await exec({
      userId: 'user-1',
      sessionId: 'sess-1',
      name: 'query_feed',
      args: { severity: 'high' },
    })

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://vantage:8000/api/socc/tools/query_feed')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toMatchObject({
      userId: 'user-1',
      sessionId: 'sess-1',
      args: { severity: 'high' },
    })

    // Decode and verify the JWT without trusting the executor's output.
    const rawToken = calls[0].authHeader?.replace('Bearer ', '') ?? ''
    const secret = new Uint8Array(Buffer.from(SECRET_HEX, 'hex'))
    const { payload } = await jose.jwtVerify(rawToken, secret, {
      issuer: 'socc-plugin',
      audience: 'vantage',
    })
    expect(payload.scope).toBe('socc-tools')
    expect(payload.sub).toBe('user-1')
    expect(payload.sid).toBe('sess-1')
    expect(typeof payload.exp).toBe('number')
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(60)
  })

  test('maps 404 from Vantage to {ok:false, errorCode:"unknown_tool"}', async () => {
    const { fetch: fakeFn } = fakeFetch(404, { detail: { error: 'unknown_tool' } })
    const exec = createToolsExecutor({
      vantageApiUrl: 'http://vantage:8000/api',
      internalSecretHex: SECRET_HEX,
      fetchImpl: fakeFn,
    })
    const result = await exec({ userId: 'u', sessionId: 's', name: 'no_such_tool', args: {} })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('unknown_tool')
  })

  test('maps 501 from Vantage to {ok:false, errorCode:"not_implemented"}', async () => {
    const { fetch: fakeFn } = fakeFetch(501, { detail: { error: 'not_implemented' } })
    const exec = createToolsExecutor({
      vantageApiUrl: 'http://vantage:8000/api',
      internalSecretHex: SECRET_HEX,
      fetchImpl: fakeFn,
    })
    const result = await exec({ userId: 'u', sessionId: 's', name: 'analyze_ioc', args: {} })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_implemented')
  })

  test('network error maps to {ok:false, errorCode:"internal_error"}', async () => {
    const brokenFetch = async (): Promise<Response> => {
      throw new TypeError('fetch failed')
    }
    const exec = createToolsExecutor({
      vantageApiUrl: 'http://vantage:8000/api',
      internalSecretHex: SECRET_HEX,
      fetchImpl: brokenFetch as unknown as typeof fetch,
    })
    const result = await exec({ userId: 'u', sessionId: 's', name: 'query_feed', args: {} })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('internal_error')
  })

  test('propagates {ok:true, data} from Vantage unchanged', async () => {
    const data = { items: [{ id: 'ev-1', severity: 'critical' }], total: 1 }
    const { fetch: fakeFn } = fakeFetch(200, { ok: true, data })
    const exec = createToolsExecutor({
      vantageApiUrl: 'http://vantage:8000/api',
      internalSecretHex: SECRET_HEX,
      fetchImpl: fakeFn,
    })
    const result = await exec({ userId: 'u', sessionId: 's', name: 'query_feed', args: {} })
    expect(result.ok).toBe(true)
    expect(result.data).toEqual(data)
  })

  test('propagates {ok:false, errorCode, errorMessage} from Vantage', async () => {
    const { fetch: fakeFn } = fakeFetch(200, {
      ok: false,
      errorCode: 'quota_exceeded',
      errorMessage: 'too many calls',
    })
    const exec = createToolsExecutor({
      vantageApiUrl: 'http://vantage:8000/api',
      internalSecretHex: SECRET_HEX,
      fetchImpl: fakeFn,
    })
    const result = await exec({ userId: 'u', sessionId: 's', name: 'query_feed', args: {} })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('quota_exceeded')
    expect(result.errorMessage).toBe('too many calls')
  })
})
