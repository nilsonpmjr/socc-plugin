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
bun test                 # 52 tests, no network/mongo needed
bun run typecheck

cp .env.example .env
# fill SOCC_JWT_SECRET and SOCC_CREDENTIALS_MASTER_KEY with:
#   openssl rand -hex 32
bun run dev              # :8787
```

Or with Docker:

```bash
# From scratch/socc-plugin:
cp .env.example .env     # fill secrets as above
docker compose up --build
curl http://localhost:8787/health
```

## API surface

All routes except `/health` require `Authorization: Bearer <jwt>`
signed with `SOCC_JWT_SECRET`, issuer `vantage`, audience `socc-plugin`,
scope `socc`.

| Method | Path                          | Purpose                                        |
|--------|-------------------------------|------------------------------------------------|
| GET    | `/health`                     | liveness + active session count                |
| POST   | `/credentials`                | store an encrypted LLM provider key            |
| GET    | `/credentials`                | list the caller's credentials (metadata only)  |
| DELETE | `/credentials/:id`            | revoke                                         |
| POST   | `/sessions`                   | spawn a worker bound to a credential           |
| GET    | `/sessions`                   | list the caller's live sessions                |
| DELETE | `/sessions/:id`               | terminate the worker                           |
| POST   | `/sessions/:id/turns`         | **SSE**: stream a user turn                    |
| POST   | `/sessions/:id/abort`         | cancel the in-flight turn                      |

SSE event types: `message.start`, `content.delta`, `content.done`,
`tool.call.start`, `tool.call.end`, `message.end`, `error`, `heartbeat`.
See [src/server/streamAdapter.ts](src/server/streamAdapter.ts) for the
full payload shapes.

## Configuration

See [.env.example](.env.example). Required secrets:

- `SOCC_JWT_SECRET` — 32-byte hex HS256 secret shared with Vantage.
- `SOCC_CREDENTIALS_MASTER_KEY` — 32-byte hex key for libsodium
  secretbox. Rotating this invalidates every stored credential.

Tunables:

- `SESSION_TTL_MS` (default 15 min) — idle workers reaped after.
- `MAX_CONCURRENT_SESSIONS` (default 50) — hard cap on live workers.

Per-user quota of 3 live sessions is hard-coded in `sessionManager.ts`
per PRD.

## Layout

```
src/
  sessionWorker.ts        # Bun Worker body — owns one socc session
  server/
    index.ts              # Hono routes + SSE + bootstrap
    auth.ts               # JWT verifier (jose)
    credentials.ts        # Mongo + libsodium CRUD
    streamAdapter.ts      # engine events → SoccStreamEvent projection
    workerPool.ts         # spawn / run / abort / shutdown
    sessionManager.ts     # userId↔sessionId↔worker + TTL + quotas
    *.test.ts             # bun:test, no network
  types/
    socc-engine.d.ts      # ambient shim for @vantagesec/socc/engine
Dockerfile
compose.yml
manifest.yaml             # consumed by Vantage's /extensions installer
```

## Install as a Vantage extension

See [manifest.yaml](manifest.yaml). The extensions service reads this
file, validates it against the v1 schema, and stands the container up
via `docker-socket-proxy`. No host mounts, no install scripts.

## Security notes

- Plaintext API keys never touch logs, never cross the Mongo boundary,
  never appear in any response body (only a 7-char `keyPreview`).
- Every route is scoped by `claims.sub` (Vantage user id) before
  touching Mongo — cross-tenant reads are impossible even with a leaked
  id.
- `sid` in the JWT, when present, is enforced against `:id` in the URL.
- SSE handler aborts the in-flight turn on client disconnect.

## License

See LICENSE.
