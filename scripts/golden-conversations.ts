#!/usr/bin/env bun
import { SignJWT } from 'jose'

type Provider = 'anthropic' | 'openai' | 'gemini'

type ProviderConfig = {
  provider: Provider
  apiKey: string
  model: string
  baseUrl?: string
}

type SessionInfo = {
  userId: string
  credentialId: string
  sessionId: string
}

type GoldenCase = {
  id: string
  title: string
  prompt: string
  marker: string
}

type SseEvent = {
  event: string
  data: string
}

type CaseResult = {
  provider: Provider
  caseId: string
  ok: boolean
  status: number
  sawContent: boolean
  sawEnd: boolean
  sawMarker: boolean
  retriableErrors: number
  errorCodes: string[]
  totalMs: number
}

const PROVIDERS: Provider[] = ['anthropic', 'openai', 'gemini']

const GOLDEN_CASES: GoldenCase[] = [
  {
    id: 'soc-triage-phishing',
    title: 'phishing triage',
    marker: 'SOCC-GOLDEN-01',
    prompt: 'Start with SOCC-GOLDEN-01. In two concise bullets, triage a suspicious email with a mismatched reply-to domain and an urgent invoice attachment.',
  },
  {
    id: 'soc-ioc-extract',
    title: 'IOC extraction',
    marker: 'SOCC-GOLDEN-02',
    prompt: 'Start with SOCC-GOLDEN-02. Extract likely IOC categories from this alert summary: PowerShell spawned by Word, outbound HTTPS to a new domain, and a dropped DLL in AppData.',
  },
  {
    id: 'soc-ransomware-first-hour',
    title: 'ransomware first hour',
    marker: 'SOCC-GOLDEN-03',
    prompt: 'Start with SOCC-GOLDEN-03. Give a first-hour containment checklist for suspected ransomware on one workstation.',
  },
  {
    id: 'soc-cloud-key-leak',
    title: 'cloud key leak',
    marker: 'SOCC-GOLDEN-04',
    prompt: 'Start with SOCC-GOLDEN-04. Summarize immediate actions after discovering a cloud access key committed to a private repository.',
  },
  {
    id: 'soc-false-positive',
    title: 'false positive review',
    marker: 'SOCC-GOLDEN-05',
    prompt: 'Start with SOCC-GOLDEN-05. List evidence that would downgrade an endpoint malware alert to a false positive.',
  },
  {
    id: 'soc-lateral-movement',
    title: 'lateral movement',
    marker: 'SOCC-GOLDEN-06',
    prompt: 'Start with SOCC-GOLDEN-06. Explain what to check when many failed SMB logons are followed by a successful admin logon.',
  },
  {
    id: 'soc-edr-gap',
    title: 'EDR telemetry gap',
    marker: 'SOCC-GOLDEN-07',
    prompt: 'Start with SOCC-GOLDEN-07. Describe how to handle an incident timeline gap where EDR telemetry is missing for 20 minutes.',
  },
  {
    id: 'soc-severity',
    title: 'severity assignment',
    marker: 'SOCC-GOLDEN-08',
    prompt: 'Start with SOCC-GOLDEN-08. Assign a severity rationale for a single host beaconing to known malware infrastructure with no confirmed data access.',
  },
  {
    id: 'soc-oauth-consent',
    title: 'OAuth consent abuse',
    marker: 'SOCC-GOLDEN-09',
    prompt: 'Start with SOCC-GOLDEN-09. Provide investigation steps for a suspicious OAuth consent grant in a SaaS tenant.',
  },
  {
    id: 'soc-vpn-anomaly',
    title: 'VPN anomaly',
    marker: 'SOCC-GOLDEN-10',
    prompt: 'Start with SOCC-GOLDEN-10. Triage a VPN login from an unusual country followed by normal business app access.',
  },
  {
    id: 'soc-dns-tunneling',
    title: 'DNS tunneling',
    marker: 'SOCC-GOLDEN-11',
    prompt: 'Start with SOCC-GOLDEN-11. Name three signals that make DNS tunneling more likely than normal CDN traffic.',
  },
  {
    id: 'soc-email-bec',
    title: 'BEC response',
    marker: 'SOCC-GOLDEN-12',
    prompt: 'Start with SOCC-GOLDEN-12. Give a compact response plan for suspected business email compromise without confirmed mailbox rule changes.',
  },
  {
    id: 'soc-vuln-exploit',
    title: 'exploitation evidence',
    marker: 'SOCC-GOLDEN-13',
    prompt: 'Start with SOCC-GOLDEN-13. Differentiate vulnerability scanning from likely exploitation in web server logs.',
  },
  {
    id: 'soc-privilege-escalation',
    title: 'privilege escalation',
    marker: 'SOCC-GOLDEN-14',
    prompt: 'Start with SOCC-GOLDEN-14. Triage a new local administrator account created by a service account on a Windows endpoint.',
  },
  {
    id: 'soc-data-exfil',
    title: 'data exfiltration',
    marker: 'SOCC-GOLDEN-15',
    prompt: 'Start with SOCC-GOLDEN-15. List indicators that distinguish normal backup traffic from possible data exfiltration.',
  },
  {
    id: 'soc-mfa-fatigue',
    title: 'MFA fatigue',
    marker: 'SOCC-GOLDEN-16',
    prompt: 'Start with SOCC-GOLDEN-16. Recommend containment and verification steps for suspected MFA fatigue attack against one user.',
  },
  {
    id: 'soc-container-alert',
    title: 'container alert',
    marker: 'SOCC-GOLDEN-17',
    prompt: 'Start with SOCC-GOLDEN-17. Triage a container running a shell process that was not part of the image entrypoint.',
  },
  {
    id: 'soc-siem-rule',
    title: 'SIEM rule tuning',
    marker: 'SOCC-GOLDEN-18',
    prompt: 'Start with SOCC-GOLDEN-18. Suggest safe tuning criteria for a noisy impossible-travel SIEM rule.',
  },
  {
    id: 'soc-incident-summary',
    title: 'incident summary',
    marker: 'SOCC-GOLDEN-19',
    prompt: 'Start with SOCC-GOLDEN-19. Write a five-line incident summary for executives after contained credential theft.',
  },
  {
    id: 'soc-next-best-action',
    title: 'next best action',
    marker: 'SOCC-GOLDEN-20',
    prompt: 'Start with SOCC-GOLDEN-20. Pick the next best action after detecting suspicious PowerShell, and explain why in one sentence.',
  },
]

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

function selectedProviders(): Provider[] {
  const raw = process.env.SOCC_GOLDEN_PROVIDER?.trim()
  if (!raw) return PROVIDERS
  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini') return [raw]
  throw new Error('SOCC_GOLDEN_PROVIDER must be anthropic, openai, or gemini')
}

function providerConfig(provider: Provider): ProviderConfig {
  const prefix = `SOCC_GOLDEN_${provider.toUpperCase()}`
  return {
    provider,
    apiKey: env(`${prefix}_API_KEY`),
    model: env(`${prefix}_MODEL`),
    baseUrl: process.env[`${prefix}_BASE_URL`]?.trim() || undefined,
  }
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
  config: ProviderConfig
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
      provider: args.config.provider,
      label: `golden-${args.config.provider}-${args.userId}`,
      apiKey: args.config.apiKey,
      baseUrl: args.config.baseUrl,
      defaultModel: args.config.model,
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
    body: {
      credentialId: cred.id,
      sessionName: `golden-${args.config.provider}-${args.userId}`,
    },
  })
  return { userId: args.userId, credentialId: cred.id, sessionId: session.sessionId }
}

async function runCase(args: {
  baseUrl: string
  secretHex: string
  config: ProviderConfig
  goldenCase: GoldenCase
  index: number
  maxOutputTokens: number
  testCredentials: boolean
}): Promise<CaseResult> {
  const userId = `golden-${args.config.provider}-${String(args.index + 1).padStart(2, '0')}`
  let session: SessionInfo | null = null
  const started = performance.now()
  try {
    session = await createSession({
      baseUrl: args.baseUrl,
      secretHex: args.secretHex,
      userId,
      config: args.config,
      maxOutputTokens: args.maxOutputTokens,
      testCredentials: args.testCredentials,
    })
    return await sendTurn({
      baseUrl: args.baseUrl,
      secretHex: args.secretHex,
      session,
      provider: args.config.provider,
      goldenCase: args.goldenCase,
      started,
    })
  } finally {
    if (session) {
      await cleanup({
        baseUrl: args.baseUrl,
        secretHex: args.secretHex,
        session,
      })
    }
  }
}

async function sendTurn(args: {
  baseUrl: string
  secretHex: string
  session: SessionInfo
  provider: Provider
  goldenCase: GoldenCase
  started: number
}): Promise<CaseResult> {
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
    body: JSON.stringify({ text: args.goldenCase.prompt }),
  })

  const parsed = await readSseResult(res, args.goldenCase.marker)
  return {
    provider: args.provider,
    caseId: args.goldenCase.id,
    ok: res.ok && parsed.sawContent && parsed.sawEnd && parsed.sawMarker && parsed.retriableErrors === 0,
    status: res.status,
    sawContent: parsed.sawContent,
    sawEnd: parsed.sawEnd,
    sawMarker: parsed.sawMarker,
    retriableErrors: parsed.retriableErrors,
    errorCodes: parsed.errorCodes,
    totalMs: performance.now() - args.started,
  }
}

async function readSseResult(res: Response, marker: string): Promise<{
  sawContent: boolean
  sawEnd: boolean
  sawMarker: boolean
  retriableErrors: number
  errorCodes: string[]
}> {
  if (!res.body) {
    return {
      sawContent: false,
      sawEnd: false,
      sawMarker: false,
      retriableErrors: 0,
      errorCodes: ['missing_response_body'],
    }
  }

  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  const errorCodes: string[] = []
  let buffer = ''
  let content = ''
  let doneContent: string | null = null
  let sawEnd = false
  let retriableErrors = 0

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const parsed = parseSseFrame(frame)
      if (!parsed) continue
      const data = parseJsonObject(parsed.data)
      if (parsed.event === 'content.delta') {
        const text = typeof data.text === 'string' ? data.text : ''
        content += text
      }
      if (parsed.event === 'content.done') {
        doneContent = typeof data.content === 'string' ? data.content : content
      }
      if (parsed.event === 'message.end') sawEnd = true
      if (parsed.event === 'error') {
        if (typeof data.code === 'string') errorCodes.push(data.code)
        if (data.retriable === true) retriableErrors++
      }
    }
  }

  const finalContent = doneContent ?? content
  return {
    sawContent: finalContent.trim().length > 0,
    sawEnd,
    sawMarker: finalContent.includes(marker),
    retriableErrors,
    errorCodes,
  }
}

function parseSseFrame(frame: string): SseEvent | null {
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

async function cleanup(args: {
  baseUrl: string
  secretHex: string
  session: SessionInfo
}): Promise<void> {
  await api<unknown>({
    baseUrl: args.baseUrl,
    secretHex: args.secretHex,
    userId: args.session.userId,
    sid: args.session.sessionId,
    path: `/v1/session/${args.session.sessionId}`,
    method: 'DELETE',
  }).catch(() => undefined)
  await api<unknown>({
    baseUrl: args.baseUrl,
    secretHex: args.secretHex,
    userId: args.session.userId,
    path: `/v1/credentials/${args.session.credentialId}`,
    method: 'DELETE',
  }).catch(() => undefined)
}

async function main(): Promise<void> {
  const baseUrl = env('SOCC_GOLDEN_BASE_URL', 'http://127.0.0.1:7070').replace(/\/+$/, '')
  const secretHex = env('SOCC_INTERNAL_SECRET')
  const limitPerProvider = intEnv('SOCC_GOLDEN_LIMIT_PER_PROVIDER', 20)
  const maxOutputTokens = intEnv('SOCC_GOLDEN_MAX_OUTPUT_TOKENS', 256)
  const testCredentials = process.env.SOCC_GOLDEN_TEST_CREDENTIALS === 'true'
  const cases = GOLDEN_CASES.slice(0, Math.min(limitPerProvider, GOLDEN_CASES.length))
  const configs = selectedProviders().map(providerConfig)

  console.log(`base=${baseUrl} providers=${configs.map((c) => c.provider).join(',')} cases=${cases.length}`)

  const results: CaseResult[] = []
  for (const config of configs) {
    for (let i = 0; i < cases.length; i++) {
      const goldenCase = cases[i]!
      const result = await runCase({
        baseUrl,
        secretHex,
        config,
        goldenCase,
        index: i,
        maxOutputTokens,
        testCredentials,
      })
      results.push(result)
      const label = result.ok ? 'ok' : 'fail'
      console.log(`${label} provider=${config.provider} case=${goldenCase.id} status=${result.status} totalMs=${Math.round(result.totalMs)}`)
    }
  }

  const byProvider = configs.map((config) => {
    const providerResults = results.filter((r) => r.provider === config.provider)
    const failures = providerResults.filter((r) => !r.ok)
    return {
      provider: config.provider,
      total: providerResults.length,
      ok: providerResults.length - failures.length,
      failures: failures.map((failure) => ({
        caseId: failure.caseId,
        status: failure.status,
        sawContent: failure.sawContent,
        sawEnd: failure.sawEnd,
        sawMarker: failure.sawMarker,
        retriableErrors: failure.retriableErrors,
        errorCodes: failure.errorCodes,
      })),
    }
  })

  console.log(JSON.stringify({
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    providers: byProvider,
  }, null, 2))

  if (results.some((r) => !r.ok)) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`golden conversations failed: ${(err as Error).message}`)
  process.exit(1)
})
