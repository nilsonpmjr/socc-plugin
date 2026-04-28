// Structured logging via pino.
//
// Why pino: JSON logs are cheap to emit, trivial to parse downstream, and
// pino's redact option matches exact paths rather than regexing every
// message. PRD §Technical Risks calls out token leaks in logs as a
// critical risk, so every place that could serialize a request header
// must flow through this logger (which redacts `Authorization` bearer
// tokens to `[REDACTED]`).
//
// Tests and CLI can call mkLogger({ level: 'silent' }) to mute output.

import pino, { type Logger } from 'pino'

export type LoggerConfig = {
  level?: pino.Level | 'silent'
  name?: string
  stream?: pino.DestinationStream
}

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.Authorization',
  'headers.authorization',
  'headers.Authorization',
  '*.apiKey',
  '*.api_key',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.code',
  '*.codeVerifier',
  '*.code_verifier',
  '*.state',
  'authProfile.apiKey',
  'authProfile.api_key',
  'authProfile.accessToken',
  'authProfile.access_token',
  'authProfile.refreshToken',
  'authProfile.refresh_token',
  'authProfile.code',
  'authProfile.codeVerifier',
  'authProfile.code_verifier',
  'authProfile.state',
  'oauth.apiKey',
  'oauth.api_key',
  'oauth.accessToken',
  'oauth.access_token',
  'oauth.refreshToken',
  'oauth.refresh_token',
  'oauth.code',
  'oauth.codeVerifier',
  'oauth.code_verifier',
  'oauth.state',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'code',
  'codeVerifier',
  'code_verifier',
  'state',
  'plaintext',
]

export function mkLogger(config: LoggerConfig = {}): Logger {
  const options: pino.LoggerOptions = {
    name: config.name ?? 'socc-plugin',
    level: config.level ?? (process.env.LOG_LEVEL as pino.Level | undefined) ?? 'info',
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    base: undefined, // omit pid/hostname; container orchestrators add their own
    timestamp: pino.stdTimeFunctions.isoTime,
  }
  return config.stream ? pino(options, config.stream) : pino(options)
}

export type { Logger }
