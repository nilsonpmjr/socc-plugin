import { describe, expect, test } from 'bun:test'
import { testProvider } from './providerTester.ts'
import type { ProviderCredential } from './credentials.ts'

type FetchCall = {
  url: string
  method: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

function credential(
  override: Partial<ProviderCredential> = {},
): ProviderCredential {
  return {
    id: 'cred-1',
    userId: 'u1',
    provider: 'openai',
    authMode: 'api_key',
    label: 'Provider',
    keyPreview: 'sk-...test',
    defaultModel: 'gpt-5.4',
    maxOutputTokens: 4096,
    createdAt: new Date(),
    revoked: false,
    ...override,
  }
}

function fakeFetch(status: number, body: unknown = { ok: true }) {
  const calls: FetchCall[] = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const rawHeaders = init?.headers as Record<string, string> | undefined
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: rawHeaders ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl: fetchImpl as typeof fetch, calls }
}

describe('testProvider auth modes', () => {
  test('api_key Anthropic probes with x-api-key and anthropic-version headers', async () => {
    const { fetchImpl, calls } = fakeFetch(200)

    const result = await testProvider(
      credential({
        provider: 'anthropic',
        authMode: 'api_key',
        defaultModel: 'claude-sonnet-4-6',
      }),
      'sk-ant-secret',
      { fetchImpl },
    )

    expect(result).toMatchObject({ ok: true, result: 'ok', status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0].headers['x-api-key']).toBe('sk-ant-secret')
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0].body?.model).toBe('claude-sonnet-4-6')
  })

  test('oauth OpenAI probes with bearer access token rather than key query params', async () => {
    const { fetchImpl, calls } = fakeFetch(200)

    const result = await testProvider(
      credential({
        provider: 'openai',
        authMode: 'oauth',
        baseUrl: 'https://chatgpt.example/backend-api/codex',
      }),
      'oauth-access-token',
      { fetchImpl },
    )

    expect(result).toMatchObject({ ok: true, result: 'ok', status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://chatgpt.example/backend-api/codex/v1/chat/completions')
    expect(calls[0].headers.authorization).toBe('Bearer oauth-access-token')
    expect(calls[0].url).not.toContain('oauth-access-token')
  })

  test('codex_cli and claude_cli auth profiles validate locally without network fetch', async () => {
    let fetchCount = 0
    const fetchImpl = (async () => {
      fetchCount++
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch

    const codex = await testProvider(
      credential({ provider: 'openai', authMode: 'codex_cli' }),
      'codex-access-token',
      { fetchImpl },
    )
    const claude = await testProvider(
      credential({ provider: 'anthropic', authMode: 'claude_cli' }),
      'claude-access-token',
      { fetchImpl },
    )

    expect(codex).toMatchObject({ ok: true, result: 'ok' })
    expect(claude).toMatchObject({ ok: true, result: 'ok' })
    expect(fetchCount).toBe(0)
  })

  test('setup_token mode validates presence without leaking token to a provider probe', async () => {
    let fetchCount = 0
    const fetchImpl = (async () => {
      fetchCount++
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch

    const ok = await testProvider(
      credential({ provider: 'anthropic', authMode: 'setup_token' }),
      'setup-token',
      { fetchImpl },
    )
    const missing = await testProvider(
      credential({ provider: 'anthropic', authMode: 'setup_token' }),
      '',
      { fetchImpl },
    )

    expect(ok).toMatchObject({ ok: true, result: 'ok' })
    expect(missing).toMatchObject({ ok: false, result: 'unauthorized' })
    expect(fetchCount).toBe(0)
  })

  test('provider 401 maps to unauthorized', async () => {
    const { fetchImpl } = fakeFetch(401, { error: 'bad token' })

    const result = await testProvider(
      credential({ provider: 'openai', authMode: 'oauth' }),
      'expired-access-token',
      { fetchImpl },
    )

    expect(result).toMatchObject({ ok: false, result: 'unauthorized', status: 401 })
  })
})
