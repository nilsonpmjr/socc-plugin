#!/usr/bin/env bun
import { SignJWT } from 'jose'

type Provider = 'anthropic' | 'openai' | 'gemini' | 'ollama'

type SessionInfo = {
  userId: string
  credentialId: string
  sessionId: string
}

type TurnResult = {
  ok: boolean
  sessionId: string
  userId: string
  status: number
  ttftMs?: number
  totalMs: number
  errors: Array<{ code?: string; retriable?: boolean; message?: string }>
}

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`${name} is required`)
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name, String(fallback))
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function providerEnv(): Provider {
  const value = env('SOCC_LOAD_PROVIDER', 'anthropic')
  if (value === 'anthropic' || value === 'openai' || value === 'gemini' || value === 'ollama') {
    return value
  }
  throw new Error('SOCC_LOAD_PROVIDER must be anthropic, openai, gemini, or ollama')
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]!
}

async function signToken(args: {
  userId: string
  sid?: string
  secretHex: string
}): Promise<string> {
  const secret = new Uint8Array(Buffer.from(args.secretHex, 'hex'))
  return new SignJWT({ scope: 'socc', sid: args.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(args.userId)
    .setIssuer('vantage')
    .setAudience('socc-plugin')
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(secret)
}

async function api<T>(args: {
  baseUrl: string
  secretHex: string
  userId: string
  sid?: string
  path: string
  method?: string
  body?: unknown
}): Promise<T> {
  const token = await signToken({
    userId: args.userId,
    sid: args.sid,
    secretHex: args.secretHex,
  })
  const res = await fetch(`${args.baseUrl}${args.path}`, {
    method: args.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${args.method ?? 'GET'} ${args.path} failed: ${res.status} ${text}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

async function createSession(args: {
  baseUrl: string
  secretHex: string
  userId: string
  provider: Provider
  apiKey: string
  model: string
  baseProviderUrl?: string
  maxOutputTokens: number
  testCredentials: boolean
}): Promise<SessionInfo> {
  const cred = await api<{ id: string }>({
    baseUrl: args.baseUrl,
    secretHex: args.secretHex,
    userId: args.userId,
    path: '/v1/credentials',
    method: 'POST',
    body: {
      provider: args.provider,
      label: `load-${args.userId}`,
      apiKey: args.apiKey,
      baseUrl: args.baseProviderUrl,
      defaultModel: args.model,
      maxOutputTokens: args.maxOutputTokens,
    },
  })

  if (args.testCredentials) {
    await api<unknown>({
      baseUrl: args.baseUrl,
      secretHex: args.secretHex,
      userId: args.userId,
      path: `/v1/credentials/${cred.id}/test`,
      method: 'POST',
    })
  }

  const session = await api<{ sessionId: string }>({
    baseUrl: args.baseUrl,
    secretHex: args.secretHex,
    userId: args.userId,
    path: '/v1/session',
    method: 'POST',
    body: { credentialId: cred.id, sessionName: `load-${args.userId}` },
  })
  return { userId: args.userId, credentialId: cred.id, sessionId: session.sessionId }
}

async function sendTurn(args: {
  baseUrl: string
  secretHex: string
  session: SessionInfo
  text: string
}): Promise<TurnResult> {
  const started = performance.now()
  const token = await signToken({
    userId: args.session.userId,
    sid: args.session.sessionId,
    secretHex: args.secretHex,
  })
  const res = await fetch(`${args.baseUrl}/v1/session/${args.session.sessionId}/message`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ text: args.text }),
  })

  const errors: TurnResult['errors'] = []
  let ttftMs: number | undefined
  let sawEnd = false

  if (!res.body) {
    return {
      ok: false,
      sessionId: args.session.sessionId,
      userId: args.session.userId,
      status: res.status,
      totalMs: performance.now() - started,
      errors: [{ message: 'missing response body' }],
    }
  }

  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const parsed = parseSseFrame(frame)
      if (!parsed) continue
      if ((parsed.event === 'content.delta' || parsed.event === 'content.done') && ttftMs === undefined) {
        ttftMs = performance.now() - started
      }
      if (parsed.event === 'message.end') sawEnd = true
      if (parsed.event === 'error') {
        const data = parseJsonObject(parsed.data)
        errors.push({
          code: typeof data.code === 'string' ? data.code : undefined,
          retriable: typeof data.retriable === 'boolean' ? data.retriable : undefined,
          message: typeof data.message === 'string' ? data.message : undefined,
        })
      }
    }
  }

  return {
    ok: res.ok && sawEnd && errors.length === 0,
    sessionId: args.session.sessionId,
    userId: args.session.userId,
    status: res.status,
    ttftMs,
    totalMs: performance.now() - started,
    errors,
  }
}

function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = 'message'
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart())
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const baseUrl = env('SOCC_LOAD_BASE_URL', 'http://127.0.0.1:7070').replace(/\/+$/, '')
  const secretHex = env('SOCC_INTERNAL_SECRET')
  const provider = providerEnv()
  const apiKey = env('SOCC_LOAD_API_KEY')
  const model = env('SOCC_LOAD_MODEL')
  const baseProviderUrl = process.env.SOCC_LOAD_PROVIDER_BASE_URL?.trim() || undefined
  const sessionsCount = intEnv('SOCC_LOAD_SESSIONS', 50)
  const totalMessages = intEnv('SOCC_LOAD_TOTAL_MESSAGES', sessionsCount)
  const ratePerSecond = intEnv('SOCC_LOAD_RATE_PER_SECOND', 10)
  const maxOutputTokens = intEnv('SOCC_LOAD_MAX_OUTPUT_TOKENS', 128)
  const testCredentials = process.env.SOCC_LOAD_TEST_CREDENTIALS === 'true'
  const prompt = env(
    'SOCC_LOAD_PROMPT',
    'Reply with one concise sentence and no markdown: load-test-ok',
  )

  console.log(`base=${baseUrl} provider=${provider} model=${model}`)
  console.log(`sessions=${sessionsCount} totalMessages=${totalMessages} rate=${ratePerSecond}/s`)

  const sessions: SessionInfo[] = []
  try {
    for (let i = 0; i < sessionsCount; i++) {
      const userId = `load-user-${String(i + 1).padStart(3, '0')}`
      sessions.push(await createSession({
        baseUrl,
        secretHex,
        userId,
        provider,
        apiKey,
        model,
        baseProviderUrl,
        maxOutputTokens,
        testCredentials,
      }))
      if ((i + 1) % 10 === 0 || i + 1 === sessionsCount) {
        console.log(`created ${i + 1}/${sessionsCount} sessions`)
      }
    }

    const perSessionTail = new Map<string, Promise<TurnResult>>()
    const turns: Array<Promise<TurnResult>> = []
    const start = performance.now()
    for (let i = 0; i < totalMessages; i++) {
      const scheduledAt = start + (i / ratePerSecond) * 1000
      const session = sessions[i % sessions.length]!
      const previous = perSessionTail.get(session.sessionId) ?? Promise.resolve(undefined as never)
      const turn = previous
        .catch(() => undefined)
        .then(async () => {
          const waitMs = scheduledAt - performance.now()
          if (waitMs > 0) await sleep(waitMs)
          return sendTurn({ baseUrl, secretHex, session, text: `${prompt} #${i + 1}` })
        })
      perSessionTail.set(session.sessionId, turn)
      turns.push(turn)
    }

    const results = await Promise.all(turns)
    const ttfts = results.flatMap((r) => r.ttftMs === undefined ? [] : [r.ttftMs])
    const ok = results.filter((r) => r.ok).length
    const retriableErrors = results.flatMap((r) => r.errors).filter((e) => e.retriable).length

    console.log(JSON.stringify({
      sessions: sessions.length,
      totalMessages: results.length,
      ok,
      messageEndRate: results.length === 0 ? 0 : ok / results.length,
      retriableErrors,
      ttftMs: {
        p50: Math.round(percentile(ttfts, 50)),
        p95: Math.round(percentile(ttfts, 95)),
        count: ttfts.length,
      },
      totalMs: {
        p50: Math.round(percentile(results.map((r) => r.totalMs), 50)),
        p95: Math.round(percentile(results.map((r) => r.totalMs), 95)),
      },
    }, null, 2))

    const p95 = percentile(ttfts, 95)
    if (ttfts.length !== results.length || p95 > 3000 || retriableErrors > 0) {
      process.exitCode = 1
    }
  } finally {
    await Promise.allSettled(sessions.map(async (session) => {
      await api<unknown>({
        baseUrl,
        secretHex,
        userId: session.userId,
        sid: session.sessionId,
        path: `/v1/session/${session.sessionId}`,
        method: 'DELETE',
      }).catch(() => undefined)
      await api<unknown>({
        baseUrl,
        secretHex,
        userId: session.userId,
        path: `/v1/credentials/${session.credentialId}`,
        method: 'DELETE',
      }).catch(() => undefined)
    }))
  }
}

main().catch((err) => {
  console.error(`load test failed: ${(err as Error).message}`)
  process.exit(1)
})
