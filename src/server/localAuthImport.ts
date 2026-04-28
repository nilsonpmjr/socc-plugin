import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readNestedString(value: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    let current = value
    let valid = true
    for (const key of path) {
      if (!current || typeof current !== 'object' || !(key in current)) {
        valid = false
        break
      }
      current = (current as Record<string, unknown>)[key]
    }
    if (!valid) continue
    if (typeof current === 'string' && current.trim()) return current.trim()
  }
  return undefined
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const normalized = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseChatgptAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token)
  const claim = payload?.['https://api.openai.com/auth.chatgpt_account_id']
  if (typeof claim === 'string' && claim.trim()) return claim.trim()
  const fallback = payload?.chatgpt_account_id
  return typeof fallback === 'string' && fallback.trim() ? fallback.trim() : undefined
}

export function resolveCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_AUTH_JSON_PATH?.trim()) return env.CODEX_AUTH_JSON_PATH.trim()
  if (env.CODEX_HOME?.trim()) return join(env.CODEX_HOME.trim(), 'auth.json')
  return join(homedir(), '.codex', 'auth.json')
}

export async function importCodexCliAuth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  accountId?: string
  authPath: string
}> {
  const authPath = resolveCodexAuthPath(env)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(authPath, 'utf8'))
  } catch (err) {
    throw new Error(`codex_auth_not_found:${authPath}`)
  }

  const accessToken = readNestedString(parsed, [
    ['access_token'],
    ['accessToken'],
    ['tokens', 'access_token'],
    ['tokens', 'accessToken'],
    ['auth', 'access_token'],
    ['auth', 'accessToken'],
    ['token', 'access_token'],
    ['token', 'accessToken'],
    ['tokens', 'id_token'],
    ['tokens', 'idToken'],
  ])
  if (!accessToken) throw new Error(`codex_auth_missing_access_token:${authPath}`)

  const refreshToken = readNestedString(parsed, [
    ['refresh_token'],
    ['refreshToken'],
    ['tokens', 'refresh_token'],
    ['tokens', 'refreshToken'],
    ['auth', 'refresh_token'],
    ['auth', 'refreshToken'],
  ])
  const expiresAt = readNestedString(parsed, [
    ['expires_at'],
    ['expiresAt'],
    ['tokens', 'expires_at'],
    ['tokens', 'expiresAt'],
    ['auth', 'expires_at'],
    ['auth', 'expiresAt'],
  ])
  const accountId =
    readNestedString(parsed, [
      ['account_id'],
      ['accountId'],
      ['tokens', 'account_id'],
      ['tokens', 'accountId'],
      ['auth', 'account_id'],
      ['auth', 'accountId'],
    ]) ?? parseChatgptAccountId(accessToken)

  return { accessToken, refreshToken, expiresAt, accountId, authPath }
}

export function resolveClaudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CREDENTIALS_JSON_PATH?.trim()) return env.CLAUDE_CREDENTIALS_JSON_PATH.trim()
  if (env.CLAUDE_CONFIG_DIR?.trim()) return join(env.CLAUDE_CONFIG_DIR.trim(), '.credentials.json')
  if (env.ANTHROPIC_CONFIG_DIR?.trim()) return join(env.ANTHROPIC_CONFIG_DIR.trim(), '.credentials.json')
  return join(homedir(), '.claude', '.credentials.json')
}

export async function importClaudeCliAuth(
  env: NodeJS.ProcessEnv = process.env,
  explicitPath?: string,
): Promise<{
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  organizationUuid?: string
  subscriptionType?: string
  rateLimitTier?: string
  scopes?: string[]
  authPath: string
}> {
  const authPath = explicitPath?.trim() || resolveClaudeCredentialsPath(env)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(authPath, 'utf8'))
  } catch {
    throw new Error(`claude_auth_not_found:${authPath}`)
  }

  const accessToken = readNestedString(parsed, [
    ['claudeAiOauth', 'accessToken'],
    ['accessToken'],
    ['access_token'],
  ])
  if (!accessToken) throw new Error(`claude_auth_missing_access_token:${authPath}`)

  const refreshToken = readNestedString(parsed, [
    ['claudeAiOauth', 'refreshToken'],
    ['refreshToken'],
    ['refresh_token'],
  ])
  const organizationUuid = readNestedString(parsed, [
    ['organizationUuid'],
    ['organization_uuid'],
    ['claudeAiOauth', 'organizationUuid'],
  ])
  const subscriptionType = readNestedString(parsed, [['claudeAiOauth', 'subscriptionType']])
  const rateLimitTier = readNestedString(parsed, [['claudeAiOauth', 'rateLimitTier']])

  const oauth = parsed && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>).claudeAiOauth
    : undefined
  const expiresAtValue =
    oauth && typeof oauth === 'object'
      ? (oauth as Record<string, unknown>).expiresAt
      : undefined
  const expiresAt =
    typeof expiresAtValue === 'number'
      ? expiresAtValue
      : typeof expiresAtValue === 'string' && /^\d+$/.test(expiresAtValue)
        ? Number(expiresAtValue)
        : undefined
  const scopesValue =
    oauth && typeof oauth === 'object'
      ? (oauth as Record<string, unknown>).scopes
      : undefined
  const scopes = Array.isArray(scopesValue)
    ? scopesValue.filter((scope): scope is string => typeof scope === 'string')
    : undefined

  return {
    accessToken,
    refreshToken,
    expiresAt,
    organizationUuid,
    subscriptionType,
    rateLimitTier,
    scopes,
    authPath,
  }
}
