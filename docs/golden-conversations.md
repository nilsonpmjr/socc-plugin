# Golden Conversations Runbook

The PRD hardening pass requires 20 scripted conversations per hosted provider:
Anthropic, OpenAI, and Gemini. The goal is to prove the plugin can create a
session, stream assistant text, emit `message.end`, and avoid retriable stream
errors across the provider matrix.

`scripts/golden-conversations.ts` drives the public `/v1` API. It mints the
same short-lived JWTs used by Vantage, creates a synthetic credential/session
per golden case, sends one prompt, validates the SSE stream, and cleans up.

Each prompt asks the model to include a case-specific `SOCC-GOLDEN-*` marker.
The script fails a case if the marker is missing, no assistant content arrives,
`message.end` is absent, or any `error.retriable=true` event appears.

## Required Environment

```bash
export SOCC_GOLDEN_BASE_URL='http://127.0.0.1:7070'
export SOCC_INTERNAL_SECRET='<same 64-char hex SOCC_INTERNAL_SECRET used by plugin>'

export SOCC_GOLDEN_ANTHROPIC_API_KEY='<anthropic credential>'
export SOCC_GOLDEN_ANTHROPIC_MODEL='<anthropic model>'

export SOCC_GOLDEN_OPENAI_API_KEY='<openai credential>'
export SOCC_GOLDEN_OPENAI_MODEL='<openai model>'

export SOCC_GOLDEN_GEMINI_API_KEY='<gemini credential>'
export SOCC_GOLDEN_GEMINI_MODEL='<gemini model>'
```

Optional knobs:

```bash
export SOCC_GOLDEN_PROVIDER='anthropic'       # anthropic | openai | gemini
export SOCC_GOLDEN_LIMIT_PER_PROVIDER=20
export SOCC_GOLDEN_MAX_OUTPUT_TOKENS=256
export SOCC_GOLDEN_TEST_CREDENTIALS=false
export SOCC_GOLDEN_ANTHROPIC_BASE_URL=''
export SOCC_GOLDEN_OPENAI_BASE_URL=''
export SOCC_GOLDEN_GEMINI_BASE_URL=''
```

When `SOCC_GOLDEN_PROVIDER` is unset, the official run covers all three
providers.

## Run

Start the plugin and Mongo, then run:

```bash
bun run golden:conversations
```

The script exits non-zero if any golden case fails its streaming assertions.

Example summary:

```json
{
  "total": 60,
  "ok": 60,
  "providers": [
    { "provider": "anthropic", "total": 20, "ok": 20, "failures": [] },
    { "provider": "openai", "total": 20, "ok": 20, "failures": [] },
    { "provider": "gemini", "total": 20, "ok": 20, "failures": [] }
  ]
}
```

## Notes

- Use a disposable database or deployment. Cleanup is best-effort, so an
  interrupted run may leave revoked credentials or expired sessions behind.
- Set `SOCC_GOLDEN_PROVIDER` for a cheaper single-provider rehearsal.
- Leave `SOCC_GOLDEN_TEST_CREDENTIALS=false` for the official stream run unless
  provider validation is part of the experiment.
