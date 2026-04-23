// Reserved error codes from the PRD §Security.
//
// The plugin surfaces these codes back to the Vantage proxy; the proxy
// translates them into i18n strings in the frontend. Anything outside of
// this set must be mapped to `internal_error` before it leaves the
// process — we never want untranslated codes hitting the UI.

export const ERR = {
  // Provider-side failures (from the LLM API, not us).
  ProviderUnauthorized: 'provider_unauthorized',
  ProviderRateLimited: 'provider_rate_limited',
  ProviderUnavailable: 'provider_unavailable',

  // Session lifecycle.
  SessionNotFound: 'session_not_found',
  SessionForbidden: 'session_forbidden',

  // Plugin-level availability.
  SoccUnavailable: 'socc_unavailable',
  SoccNotInstalled: 'socc_not_installed',

  // Policy.
  LocalProviderDisabled: 'local_provider_disabled',
  QuotaExceeded: 'quota_exceeded',

  // Catch-all.
  InternalError: 'internal_error',
} as const

export type ReservedErrorCode = (typeof ERR)[keyof typeof ERR]
