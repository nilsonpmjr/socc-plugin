# socc-plugin

Headless SOC Copilot server. Wraps [@vantagesec/socc](https://github.com/vantagesec/socc)
in a multi-tenant HTTP service: one isolated Bun Worker per session,
streaming SSE, encrypted per-user LLM credentials.

Designed to be installed from Vantage's `/extensions` page. Standalone
operation is supported for dev and self-hosters.

## Architecture

```
Vantage frontend
   │  (HTTPS, user JWT)
   ▼
Vantage backend ── mints scope=socc JWT (TTL 60s) ──┐
                                                     │
                            ┌────────────────────────▼────────────────────────┐
                            │ socc-plugin (this repo)                         │
                            │                                                 │
                            │   Hono + SSE  ── auth (JWT verify)              │
                            │        │                                        │
                            │        ▼                                        │
                            │   SessionManager ── quotas, TTL, ownership      │
                            │        │                                        │
                            │        ▼                                        │
                            │   WorkerPool ── 1 Bun Worker per session        │
                            │        │                                        │
                            │        ▼                                        │
                            │   sessionWorker.ts → @vantagesec/socc/engine    │
                            │                                                 │
                            │   CredentialsStore ── libsodium + MongoDB       │
                            └─────────────────────────────────────────────────┘
```

Key design choices:

- **1 Worker per session, no recycling.** socc has a module-level STATE
  singleton; Workers give each session its own realm and we terminate-
  and-respawn rather than reset the singleton by hand.
- **Tools disabled in MVP.** `canUseTool` denies everything — this is
  chat-only until we wire a per-user permission policy.
- **Credentials never leave the plugin realm.** Ciphertext lives in
  Mongo, plaintext API keys exist only transiently on the Worker.
- **Loose coupling to socc.** `streamAdapter.ts` pattern-matches on
  runtime discriminants instead of importing socc's internal types, so
  minor socc refactors don't break the wire protocol.

## Requirements

- Bun ≥ 1.3.9
- MongoDB 7+ (for dev: `docker compose up` provisions one)
- Sibling `socc/` checkout (this repo depends on `file:../socc` until a
  registry release exists)

## Quick start

```bash
# From the scratch/ parent directory:
git clone https://github.com/vantagesec/socc.git
git clone https://github.com/nilsonpmjr/socc-plugin.git
cd socc-plugin

bun install
bun test                 # 52+ tests, no network/mongo needed
bun run typecheck

cp .env.example .env
# fill SOCC_INTERNAL_SECRET and SOCC_MASTER_KEY with:
#   openssl rand -hex 32
bun run dev              # :7070
```

Or with Docker:

```bash
# From scratch/socc-plugin:
cp .env.example .env     # fill secrets as above
docker compose up --build
curl http://localhost:7070/v1/health
```

## API surface

All routes under `/v1` except `/v1/health` require
`Authorization: Bearer <jwt>` signed with `SOCC_INTERNAL_SECRET`,
issuer `vantage`, audience `socc-plugin`, scope `socc`.

| Method | Path                                 | Purpose                                        |
|--------|--------------------------------------|------------------------------------------------|
| GET    | `/v1/health`                         | liveness + active session count                |
| POST   | `/v1/credentials`                    | store an encrypted LLM provider key            |
| GET    | `/v1/credentials`                    | list the caller's credentials (metadata only)  |
| DELETE | `/v1/credentials/:id`                | revoke                                         |
| POST   | `/v1/credentials/:id/test`           | test provider reachability + record result     |
| POST   | `/v1/session`                        | spawn a worker bound to a credential           |
| GET    | `/v1/session`                        | list the caller's live sessions                |
| DELETE | `/v1/session/:id`                    | terminate the worker                           |
| POST   | `/v1/session/:id/message`            | **SSE**: stream a user turn (PRD name)         |
| POST   | `/v1/session/:id/turns`              | alias for `/message` (legacy)                  |
| POST   | `/v1/session/:id/abort`              | cancel the in-flight turn                      |

SSE event types: `session.ready`, `message.start`, `content.delta`,
`content.done` (with `content` + `usage`), `tool.call.start`,
`tool.call.end`, `message.end` (with `stopReason`), `error` (with
reserved `code`), `heartbeat` (with `ts`). See
[src/server/streamAdapter.ts](src/server/streamAdapter.ts) for the full
payload shapes.

Reserved error codes (PRD §Security): `provider_unauthorized`,
`provider_rate_limited`, `provider_unavailable`, `session_not_found`,
`session_forbidden`, `socc_unavailable`, `socc_not_installed`,
`local_provider_disabled`, `quota_exceeded`, `internal_error`.

## Configuration

See [.env.example](.env.example). Required secrets:

- `SOCC_INTERNAL_SECRET` — 32-byte hex HS256 secret shared with Vantage.
- `SOCC_MASTER_KEY` — 32-byte hex key for libsodium secretbox.
  Rotating this invalidates every stored credential.

Tunables:

- `PORT` (default `7070`) — HTTP bind port.
- `SESSION_TTL_MS` (default 15 min) — idle workers reaped after.
- `MAX_CONCURRENT_SESSIONS` (default 50) — hard cap on live workers.
- `TURN_TIMEOUT_MS` (default 90s) — per-turn generation timeout; on
  expiry the worker aborts and the SSE stream emits
  `error.retriable=true`.
- `SOCC_ALLOW_LOCAL_PROVIDERS` (default `false`) — when `false`,
  creating an `ollama` credential returns `local_provider_disabled`.
- `LOG_LEVEL` (default `info`) — pino level.

Per-user caps (PRD §Security):
- 3 live sessions (hard-coded in `sessionManager.ts`).
- 20 provider credentials (`MAX_CREDENTIALS_PER_USER` in
  `credentials.ts`).

## Layout

```
src/
  sessionWorker.ts        # Bun Worker body — owns one socc session
  server/
    index.ts              # Hono routes + SSE + bootstrap
    auth.ts               # JWT verifier (jose)
    credentials.ts        # Mongo + libsodium CRUD
    providerTester.ts     # round-trips Anthropic/OpenAI/Gemini/Ollama
    streamAdapter.ts      # engine events → SoccStreamEvent projection
    workerPool.ts         # spawn / run / abort / shutdown
    sessionManager.ts     # userId↔sessionId↔worker + TTL + quotas
    logger.ts             # pino with Authorization redaction
    errors.ts             # PRD-reserved error code enum
    *.test.ts             # bun:test, no network
  types/
    socc-engine.d.ts      # ambient shim for @vantagesec/socc/engine
Dockerfile
compose.yml
manifest.yaml             # consumed by Vantage's /extensions installer
```

## Install as a Vantage extension

See [manifest.yaml](manifest.yaml) — the schema matches PRD
§Extensions Platform so the `ExtensionManager` can consume it without
translation. The extensions service validates the file, generates
required secrets (`SOCC_MASTER_KEY`, `SOCC_INTERNAL_SECRET`) via
`random_bytes_base64`, and stands the container up via
`docker-socket-proxy`. No host mounts, no install scripts.

## Security notes

- Plaintext API keys never touch logs, never cross the Mongo boundary,
  never appear in any response body (only a 7-char `keyPreview`).
- Every route is scoped by `claims.sub` (Vantage user id) before
  touching Mongo — cross-tenant reads are impossible even with a leaked
  id.
- `sid` in the JWT, when present, is enforced against `:id` in the URL.
- SSE handler aborts the in-flight turn on client disconnect and on the
  90s generation timeout.
- `Authorization` header is redacted to `[REDACTED]` in every pino log
  line via `redact.paths`.

## License

See LICENSE.
