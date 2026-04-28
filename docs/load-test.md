# Load Test Runbook

The PRD target is 50 concurrent sessions, 10 messages/second, P95 TTFT under
3 seconds, and zero retriable stream errors.

`scripts/load-test.ts` drives a running `socc-plugin` instance through the
public `/v1` HTTP API. It mints the same short-lived JWTs that Vantage uses,
creates one credential and one session per synthetic user, sends SSE message
turns at a controlled global rate, records TTFT at the first `content.delta`
or `content.done`, then cleans up sessions and credentials.

## Required Environment

```bash
export SOCC_LOAD_BASE_URL='http://127.0.0.1:7070'
export SOCC_INTERNAL_SECRET='<same 64-char hex SOCC_INTERNAL_SECRET used by plugin>'
export SOCC_LOAD_PROVIDER='anthropic'      # anthropic | openai | gemini | ollama
export SOCC_LOAD_API_KEY='<provider credential>'
export SOCC_LOAD_MODEL='<provider model>'
```

Optional knobs:

```bash
export SOCC_LOAD_PROVIDER_BASE_URL=''      # override provider base URL
export SOCC_LOAD_SESSIONS=50
export SOCC_LOAD_TOTAL_MESSAGES=50
export SOCC_LOAD_RATE_PER_SECOND=10
export SOCC_LOAD_MAX_OUTPUT_TOKENS=128
export SOCC_LOAD_TEST_CREDENTIALS=false
export SOCC_LOAD_PROMPT='Reply with one concise sentence: load-test-ok'
```

## Run

Start the plugin and Mongo, then run:

```bash
bun run load:test
```

The script exits non-zero if any message lacks TTFT, P95 TTFT exceeds 3000ms,
or a retriable SSE error appears.

Example output:

```json
{
  "sessions": 50,
  "totalMessages": 50,
  "ok": 50,
  "messageEndRate": 1,
  "retriableErrors": 0,
  "ttftMs": { "p50": 850, "p95": 2100, "count": 50 },
  "totalMs": { "p50": 1200, "p95": 2600 }
}
```

## Notes

- Use distinct synthetic users to avoid the 3-session-per-user quota.
- Keep `SOCC_LOAD_TOTAL_MESSAGES` equal to `SOCC_LOAD_SESSIONS` for the PRD
  smoke. Larger totals are supported, but repeated turns on the same session
  are serialized to avoid intentional `turn_conflict` noise.
- `SOCC_LOAD_TEST_CREDENTIALS=true` adds provider test calls before session
  creation. Leave it off for the main latency run unless credential validation
  is part of the experiment.
- Run against a clean database or a disposable deployment; the script cleans up
  best-effort, but interrupted runs may leave revoked credential records.
