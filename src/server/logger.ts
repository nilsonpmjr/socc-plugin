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
}

export function mkLogger(config: LoggerConfig = {}): Logger {
  return pino({
    name: config.name ?? 'socc-plugin',
    level: config.level ?? (process.env.LOG_LEVEL as pino.Level | undefined) ?? 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.Authorization',
        'headers.authorization',
        'headers.Authorization',
        '*.apiKey',
        '*.api_key',
        'apiKey',
        'api_key',
        'plaintext',
      ],
      censor: '[REDACTED]',
    },
    base: undefined, // omit pid/hostname; container orchestrators add their own
    timestamp: pino.stdTimeFunctions.isoTime,
  })
}

export type { Logger }
