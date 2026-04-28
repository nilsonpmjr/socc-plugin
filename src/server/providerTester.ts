// Provider reachability tester.
//
// US-1 AC: creating a credential must call `POST /credentials/:id/test`
// and persist only if `ok: true`. This module performs the minimal HTTP
// round-trip that distinguishes 200 (ok) from 401 (unauthorized) from
// everything else (network/invalid_model/other), and records the result
// via CredentialsStore.recordTestResult.
//
// We deliberately issue the cheapest request each SDK allows rather than
// a full completion — we're testing auth + reachability, not quality.
//
// Timeouts default to 10s; the caller may pass a shorter budget.

import type { ProviderCredential, TestResult } from './credentials.ts'

export type TestOutcome = {
  ok: boolean
  result: TestResult
  status?: number
  detail?: string
}

const DEFAULT_TIMEOUT_MS = 10_000

export async function testProvider(
  cred: ProviderCredential,
  apiKey: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<TestOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    if (cred.authMode === 'codex_cli') {
      return apiKey ? { ok: true, result: 'ok' } : { ok: false, result: 'unauthorized' }
    }
    if (cred.authMode === 'claude_cli') {
      return apiKey ? { ok: true, result: 'ok' } : { ok: false, result: 'unauthorized' }
    }
    if (cred.authMode === 'setup_token') {
      return apiKey ? { ok: true, result: 'ok' } : { ok: false, result: 'unauthorized' }
    }
    switch (cred.provider) {
      case 'anthropic':
        return await probeAnthropic(fetchImpl, cred, apiKey, controller.signal)
      case 'openai':
        return await probeOpenAI(fetchImpl, cred, apiKey, controller.signal)
      case 'gemini':
        return await probeGemini(fetchImpl, cred, apiKey, controller.signal)
      case 'ollama':
        return await probeOllama(fetchImpl, cred, controller.signal)
    }
  } catch (err) {
    const aborted = (err as { name?: string }).name === 'AbortError'
    return {
      ok: false,
      result: aborted ? 'network' : 'network',
      detail: aborted ? 'timeout' : (err as Error).message,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function probeAnthropic(
  fetchImpl: typeof fetch,
  cred: ProviderCredential,
  apiKey: string,
  signal: AbortSignal,
): Promise<TestOutcome> {
  const base = cred.baseUrl ?? 'https://api.anthropic.com'
  const res = await fetchImpl(`${base}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cred.defaultModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  })
  return classify(res)
}

async function probeOpenAI(
  fetchImpl: typeof fetch,
  cred: ProviderCredential,
  apiKey: string,
  signal: AbortSignal,
): Promise<TestOutcome> {
  const base = cred.baseUrl ?? 'https://api.openai.com'
  const res = await fetchImpl(`${base}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: cred.defaultModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  })
  return classify(res)
}

async function probeGemini(
  fetchImpl: typeof fetch,
  cred: ProviderCredential,
  apiKey: string,
  signal: AbortSignal,
): Promise<TestOutcome> {
  const base = cred.baseUrl ?? 'https://generativelanguage.googleapis.com'
  const url = `${base}/v1beta/models/${encodeURIComponent(cred.defaultModel)}:generateContent?key=${encodeURIComponent(apiKey)}`
  const res = await fetchImpl(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1 },
    }),
  })
  return classify(res)
}

async function probeOllama(
  fetchImpl: typeof fetch,
  cred: ProviderCredential,
  signal: AbortSignal,
): Promise<TestOutcome> {
  const base = cred.baseUrl ?? 'http://localhost:11434'
  const res = await fetchImpl(`${base}/api/tags`, { method: 'GET', signal })
  return classify(res)
}

async function classify(res: Response): Promise<TestOutcome> {
  if (res.status === 200 || res.status === 201) {
    return { ok: true, result: 'ok', status: res.status }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, result: 'unauthorized', status: res.status }
  }
  if (res.status === 400 || res.status === 404) {
    // Usually means the model id is wrong for this account.
    const text = await res.text().catch(() => '')
    return { ok: false, result: 'invalid_model', status: res.status, detail: text.slice(0, 200) }
  }
  return { ok: false, result: 'network', status: res.status }
}
