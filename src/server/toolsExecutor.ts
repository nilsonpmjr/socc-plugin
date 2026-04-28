// Tool executor — mints a scope=socc-tools JWT and POSTs to
// Vantage's /api/socc/tools/:name endpoint on behalf of the Worker.
//
// The plugin holds the SOCC_INTERNAL_SECRET and has network access to
// the Vantage backend (both run in vantage_internal docker network).
// The Worker does not — which is why the tool call is proxied here.
//
// JWT contract (matches backend/routers/socc.py:_verify_tools_jwt):
//   iss  = "socc-plugin"
//   aud  = "vantage"
//   scope = "socc-tools"
//   sub  = userId
//   sid  = sessionId (optional)
//   TTL  = 60s
//
// Error handling: any non-2xx from Vantage is mapped to a
// {ok:false, errorCode, errorMessage} shape so the Worker can present
// a clean canUseTool=deny to the engine.

import * as jose from 'jose'
import type { ToolExecutor } from './index.ts'

const TOOLS_JWT_ISSUER = 'socc-plugin'
const TOOLS_JWT_AUDIENCE = 'vantage'
const TOOLS_JWT_SCOPE = 'socc-tools'
const TOOLS_JWT_TTL_SECONDS = 60
// Tool call timeout: generous but bounded. Must fit inside the per-turn
// 90s budget. Two separate network hops (plugin→Vantage→DB) so 15s.
const TOOLS_HTTP_TIMEOUT_MS = 15_000

export type ToolsExecutorOptions = {
  vantageApiUrl: string // e.g. "http://backend:8000/api"
  internalSecretHex: string // SOCC_INTERNAL_SECRET (64 hex chars)
  // Injected in tests to replace global fetch.
  fetchImpl?: typeof fetch
}

export function createToolsExecutor(opts: ToolsExecutorOptions): ToolExecutor {
  const secret = new Uint8Array(Buffer.from(opts.internalSecretHex, 'hex'))
  const base = opts.vantageApiUrl.replace(/\/+$/, '')
  const fetchFn = opts.fetchImpl ?? globalThis.fetch

  return async ({ userId, sessionId, name, args }) => {
    // Mint a fresh token per request — avoids clock-skew issues if the
    // executor is reused across a long conversation.
    const token = await new jose.SignJWT({
      scope: TOOLS_JWT_SCOPE,
      sid: sessionId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(TOOLS_JWT_ISSUER)
      .setAudience(TOOLS_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${TOOLS_JWT_TTL_SECONDS}s`)
      .sign(secret)

    const url = `${base}/socc/tools/${encodeURIComponent(name)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TOOLS_HTTP_TIMEOUT_MS)

    try {
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId, sessionId, args }),
        signal: controller.signal,
      })

      if (resp.status === 404) {
        return {
          ok: false,
          errorCode: 'unknown_tool',
          errorMessage: `tool '${name}' not found at ${url}`,
        }
      }
      if (resp.status === 501) {
        return {
          ok: false,
          errorCode: 'not_implemented',
          errorMessage: `tool '${name}' not yet implemented`,
        }
      }
      if (!resp.ok) {
        let detail: string
        try {
          const body = (await resp.json()) as { detail?: { message?: string }; message?: string }
          detail =
            body?.detail?.message ?? body?.message ?? `HTTP ${resp.status}`
        } catch {
          detail = `HTTP ${resp.status}`
        }
        return { ok: false, errorCode: 'provider_unavailable', errorMessage: detail }
      }

      const payload = (await resp.json()) as { ok: boolean; data?: unknown; errorCode?: string; errorMessage?: string }
      return {
        ok: payload.ok,
        data: payload.data,
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage,
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return {
          ok: false,
          errorCode: 'provider_unavailable',
          errorMessage: `tool request timed out (${TOOLS_HTTP_TIMEOUT_MS}ms)`,
        }
      }
      return {
        ok: false,
        errorCode: 'internal_error',
        errorMessage: err instanceof Error ? err.message : String(err),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
