# SOC Copilot Plugin — Followup (Fase 0 + reconciliação com PRD concluídas)

Fonte de verdade: `/home/nilsonpmjr/Modelos/prd/socc-copilot-plugin.md`
(Draft, 2026-04-22). Este documento narra o que foi feito na Fase 0,
a reconciliação executada em 2026-04-24 contra o PRD, e o que fica como
débito restante antes da Fase 1.

Acompanha o [TODO.md](TODO.md).

---

## 1. O que foi entregue

Um plugin HTTP standalone operacional no nível da Fase 0 do PRD, já
reconciliado com o PRD em todos os pontos de contrato de wire/env/
manifest:

- **Upstream socc (Path A do PRD).** `query()` exportado como API pública
  via `dist/engine.mjs` + `exports["./engine"]`, sem split de monorepo.
  REPL original passa smoke (`--version`, CLI, dist/cli.mjs continua
  funcional).
- **Plugin headless completo.** 10 módulos TypeScript (`sessionWorker`,
  `workerPool`, `sessionManager`, `credentials`, `auth`, `streamAdapter`,
  `providerTester`, `logger`, `errors`, Hono server), 58 testes
  unitários cobrindo crypto, auth, streaming projection (inclusive
  `message_delta` → usage/stop_reason), quotas, cross-tenant, SSE
  encoding, rotas, flag `SOCC_ALLOW_LOCAL_PROVIDERS`, cap 20 creds/user
  e `/v1/credentials/:id/test` com mock de fetch.
- **Empacotamento.** Imagem Docker multi-stage (Bun alpine, non-root,
  healthcheck em `/v1/health`, porta 7070). Compose com `socc-mongo`
  isolado em rede interna do plugin.
- **CI.** Typecheck + test + docker build + smoke boot em GitHub Actions,
  com env vars renomeadas.
- **Smoke real validado** (docker compose up, Worker Bun real carregando
  o engine do socc): `/v1/health` → `POST /v1/credentials` →
  `POST /v1/session` → `activeSessions: 1` → `DELETE` →
  `activeSessions: 0`.

## 2. Reconciliação com o PRD (executada em 2026-04-24)

Todos os itens do antigo §2 (divergências) foram endereçados num único
PR de reconciliação antes de avançar para Fase 1. Resumo do que mudou:

### 2.1 Nomes de secrets — resolvido

| Antes                            | Agora (PRD)             |
|----------------------------------|-------------------------|
| `SOCC_CREDENTIALS_MASTER_KEY`    | `SOCC_MASTER_KEY`       |
| `SOCC_JWT_SECRET`                | `SOCC_INTERNAL_SECRET`  |

Rename mecânico aplicado em: env schema (`src/server/index.ts`), env
vars no compose/Dockerfile/CI, mensagens de erro em `auth.ts` e
`credentials.ts`, `.env.example`, `README.md`. Os nomes agora batem
com os `secrets[].generator: random_bytes_base64` do manifest do PRD
— `ExtensionManager` da Fase 4 provisiona sem mapa de tradução.

### 2.2 Contrato `SoccStreamEvent` — resolvido

`src/server/streamAdapter.ts` agora emite todos os campos que o PRD
declara:

- `content.done { messageId, content, usage }` — `content` é o texto
  agregado da assistant turn; `usage` vem de `message_delta` do
  provider (inputTokens/outputTokens/cache*). `null` se o engine
  não reportou.
- `message.end { messageId, stopReason }` — `stopReason` normalizado
  para `'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' |
  'error' | 'aborted' | null`. Captura vem do `message_delta` ou do
  contexto de fechamento (`finalize('aborted')` / `finalize('error')`).
- `heartbeat { ts }` — `Date.now()` a cada 15s.
- `error { code?, message, retriable }` — agora inclui o `code` do
  conjunto reservado do PRD.

A função de projeção mudou de `createStreamProjection(): (ev) => []`
para `createStreamProjection(): { step, finalize, getCurrentMessageId }`
— `finalize` tem acesso ao estado acumulado e aceita override de
`stopReason` para os casos terminais (client disconnect, timeout,
erro upstream).

Observação pendente: **nome do evento de fim de tool call.** PRD
declara `tool.call.done`; plugin emite `tool.call.end`. Tools estão
desligados no MVP (`canUseTool` = deny-all), então não é bloqueio; vai
ser decidido no início da Fase 5 antes de wirar o primeiro tool
real — candidato a alinhar com PRD no mesmo PR que ligar tools.

### 2.3 Porta HTTP — resolvido

`PORT=7070` (antes `:8787`) no env schema, `.env.example`, compose.yml,
Dockerfile (`EXPOSE` e `HEALTHCHECK`), manifest (`health.url`) e
README. Bate com o manifest do PRD (`http://socc-copilot:7070/v1/health`).

### 2.4 Path prefix `/v1` — resolvido

Todas as rotas protegidas migraram para sob `/v1`. Middleware de auth
atua em `/v1/*` com early-return em `/v1/health`.

### 2.5 Nome do endpoint de turn — resolvido

- `POST /v1/session/:id/message` (nome do PRD) é o primário.
- `POST /v1/session/:id/turns` permanece como alias com handler
  idêntico para não quebrar callers internos.

### 2.6 Rotas faltantes da Fase 0 (US-1 AC) — resolvidas

- ✅ **`POST /v1/credentials/:id/test`** — `providerTester.ts` faz um
  round-trip mínimo (1 token de max_tokens) contra Anthropic, OpenAI,
  Gemini ou Ollama; classifica em `ok | unauthorized | invalid_model
  | network`; persiste via `recordTestResult`. Timeout 10s default.
- ✅ **Flag `SOCC_ALLOW_LOCAL_PROVIDERS` (default `false`)** —
  `POST /v1/credentials` rejeita `provider=ollama` com erro
  `local_provider_disabled` se desligada.
- ✅ **Max 20 provider credentials por usuário.** `MAX_CREDENTIALS_PER_USER`
  exportado de `credentials.ts`; `POST /v1/credentials` chama
  `countActive()` antes do insert e retorna `quota_exceeded` (429).
- ✅ **Timeout de geração 90s.** `streamTurnResponse` arma um
  `setTimeout(90_000)` que chama `sessions.abortTurn()` e sinaliza
  via SSE: `error { code: 'provider_unavailable', retriable: true }`
  seguido de `message.end { stopReason: 'aborted' }`.
- ✅ **Códigos de erro reservados.** `src/server/errors.ts` expõe o
  enum `ERR` com os 10 códigos do PRD §Security. Handlers mapeiam
  todas as exceções internas (`SessionQuotaError`,
  `PoolCapacityError`, `SessionNotFoundError`, etc.) para esse
  conjunto antes da resposta sair. `sid_mismatch` virou
  `session_forbidden`; `pool_capacity` virou `socc_unavailable`;
  `session_quota` virou `quota_exceeded`.

### 2.7 Logging — resolvido

`pino@^9` adicionado como dep. `src/server/logger.ts` cria o logger
com `redact.paths` cobrindo `req.headers.authorization`,
`headers.authorization`, `apiKey`, `api_key`, `plaintext` — todas
viram `[REDACTED]`. `bootstrap` usa o logger; `console.log` foi
substituído em todos os pontos do `index.ts`.

### 2.8 Manifest do plugin — resolvido

`manifest.yaml` reescrito literalmente no schema do PRD §Extensions
Platform (`id`, `name`, `version`, `compose_file`, `operations`,
`health{url,interval_seconds,timeout_seconds}`,
`secrets[{name,generator,length}]`,
`requires{docker_socket_proxy,disk_space_mb,ports}`,
`settings[{key,type,default,label}]`,
`uninstall{destroy_volumes_by_default,confirm_phrase}`). Quando a
Fase 4 copiar para `backend/extensions/socc/manifest.yaml`, é cópia
direta sem transformação.

## 3. Decisões que continuam corretas

Releitura do PRD confirma:

- **Path A (headless-REPL em repo próprio).** PRD §Proposed Solution
  explicitamente escolheu essa abordagem sobre o monorepo split.
- **1 Worker por sessão.** PRD §Architecture dedica 3 parágrafos a essa
  decisão. Custo de RAM (~30–50MB/Worker) está documentado no PRD
  como aceitável.
- **Tools desligados no MVP.** PRD §Non-Goals item 1 — "Tools ou skills
  no MVP (v1.0). Só chat puro."
- **Credentials scope por `userId` em todas as queries.** PRD §US-4 AC1.
- **JWT TTL ≤ 60s, scope=socc, sid opcional.** PRD §Security bate.
- **MongoDB isolado do socc (`socc-mongo`).** PRD §Integration Points.
- **Acoplamento frouxo com socc via runtime discriminants.** Não
  está no PRD mas é consistente com a filosofia "socc invisível até
  instalar" (§Proposed Solution).

## 4. O que o PRD cobra que nem começou

Itens que não estão contemplados no código entregue hoje e moram na
Fase 1+ do TODO:

- **Teste multi-sessão concorrente** (PRD §Technical Risks item 1,
  marcado como "Alta probabilidade / Crítico" — a mitigação é
  exatamente esse teste). Primeiro item da Fase 1 e valida a premissa
  central da arquitetura (1 sessão = 1 Worker, STATE não vaza).
- **Cross-user = 404 (não 403).** Handler do `/v1/session/:id/message`
  já retorna 404 quando `sessions.getSession(userId, sessionId)` é
  `null` (cobertura via teste unitário); falta o teste end-to-end
  com 2 users reais em containers separados (Fase 1).
- **Hook LGPD em `users.py`** — deactivate de usuário no Vantage
  dispara `DELETE FROM socc_* WHERE user_id=X`. Nem o hook do lado
  Vantage nem a rota de recepção do lado plugin existem.
- **Export LGPD `GET /api/socc/export`.** Idem.

## 5. Cobertura atual, por camada de risco

| Camada                 | Testes | O que prova                                                    |
|------------------------|--------|----------------------------------------------------------------|
| `credentials.ts`       | 3      | crypto round-trip, wrong key rejected, ciphertext tampering    |
| `auth.ts`              | 11     | scope/issuer/audience/expiry/signature/bearer extraction       |
| `streamAdapter.ts`     | 10     | projeção, message_delta → usage/stop_reason, finalize override |
| `sessionManager.ts`    | 11     | quota, cross-tenant, TTL bump, shutdown idempotente, ownership |
| `index.ts` (Hono+SSE)  | 23     | auth, CRUD, 429 quota, 403 sid, 404 cross-user, SSE, `/test`, flag ollama, cap 20 |
| **Total**              | **58** | **125 expect() calls, typecheck limpo**                         |

E integração real (docker compose + Worker Bun real):

- `/v1/health` sem auth retorna `{"status":"ok","activeSessions":N}`.
- `POST /v1/credentials` persiste no Mongo, não vaza ciphertext na
  response. Rejeita `ollama` quando a flag está desligada.
- `POST /v1/credentials/:id/test` faz round-trip real contra o
  provider e grava `lastTestResult` no doc.
- `POST /v1/session` aciona Worker; o Worker carrega
  `@vantagesec/socc/engine` em runtime via `import()`.
- `activeSessions` no `/v1/health` reflete o estado real do pool.
- `DELETE /v1/session/:id` termina o Worker e libera a slot da quota.

## 6. Bug/workaround notáveis

- **`SOCC_WORKER_URL` como workaround de bundling.** `workerPool.ts`
  tenta `new URL('../sessionWorker.ts', import.meta.url)` em dev, mas
  depois de `bun build` esse path resolve para `/app/sessionWorker.ts`
  (que não existe — só `dist/sessionWorker.mjs`). Workaround atual: o
  Dockerfile define `SOCC_WORKER_URL=file:///app/dist/sessionWorker.mjs`
  e o pool honra a env var se presente. Feio; limpar antes da publish.

- **Warning cosmético `Failed to find Response internal state key`.**
  Aparece no `bun test` e no stdout do servidor. É do runtime do Bun
  ao observar `Response` com `ReadableStream` antes do primeiro read.
  58 testes passam e SSE chega completo ao client. Reportar upstream
  se persistir em Bun 1.4+.

- **`Binary` do Mongo retornando `.buffer` em vez de `Uint8Array`.**
  Funciona porque libsodium aceita ambos, mas driver Mongo 7.x pode
  mudar. Revisitar no bump do driver.

- **Nome `tool.call.end` vs PRD `tool.call.done`.** Plugin emite
  `tool.call.end` desde a Fase 0; PRD especifica `tool.call.done`.
  Sem impacto no MVP porque tools estão desligados
  (`canUseTool = deny`). Renomear no PR que ligar o primeiro tool
  read-only (Fase 5).

## 7. Próximo passo recomendado

**Reconciliação com o PRD está fechada.** O PR que foi planejado na
versão anterior deste documento (§7 de "Próximo passo recomendado")
foi executado:

1. ✅ Rename de env vars (`SOCC_MASTER_KEY`, `SOCC_INTERNAL_SECRET`).
2. ✅ Rotas movidas para `/v1/*`; `message` aceito como primário,
   `turns` mantido como alias.
3. ✅ Porta default `:7070`.
4. ✅ `manifest.yaml` reescrito no formato do PRD §Extensions Platform.
5. ✅ `SoccStreamEvent` completo (`usage`, `stopReason`, `heartbeat.ts`).
6. ✅ `pino` adicionado com redação de `Authorization` + `apiKey`.
7. ✅ `POST /v1/credentials/:id/test` + flag `SOCC_ALLOW_LOCAL_PROVIDERS`
   + cap 20 providers + timeout 90s.
8. ✅ Erros mapeados para os códigos reservados do PRD §Security.

**Agora a Fase 1 é só escrever o teste.** O contrato está correto,
o proxy Vantage da Fase 2 pode ser 1:1 com os caminhos do plugin, e
a plataforma de extensões da Fase 4 consome o manifest sem tradução.

Na Fase 1 propriamente dita, **o teste a escrever é o que o PRD
§Technical Risks marca como `Alta/Crítico` com mitigação "Fase 0
inclui auditoria ativa + testes multi-sessão concorrentes antes de
Fase 1 fechar"**. Esse teste ficou para a próxima iteração; entregar
ele é o que efetivamente fecha a Fase 0 pela régua do PRD.

## 8. Inventário de arquivos

```
socc-plugin/
├── .github/workflows/ci.yml
├── .dockerignore
├── .env.example
├── compose.yml
├── Dockerfile
├── manifest.yaml                ← schema exato do PRD §Extensions Platform
├── package.json                 ← file:../socc (temporário) + pino
├── README.md
├── tsconfig.json
├── docs/
│   ├── TODO.md
│   └── FOLLOWUP.md              ← você está aqui
└── src/
    ├── sessionWorker.ts
    ├── types/
    │   └── socc-engine.d.ts
    └── server/
        ├── auth.ts              # + auth.test.ts
        ├── credentials.ts       # + credentials.test.ts (MAX_CREDENTIALS_PER_USER)
        ├── errors.ts            # NOVO: códigos reservados do PRD §Security
        ├── index.ts             # + index.test.ts (rotas /v1, flag ollama, cap 20, /test)
        ├── logger.ts            # NOVO: pino com redact
        ├── providerTester.ts    # NOVO: Anthropic/OpenAI/Gemini/Ollama probe
        ├── sessionManager.ts    # + sessionManager.test.ts
        ├── streamAdapter.ts     # + streamAdapter.test.ts (usage/stopReason/ts)
        └── workerPool.ts
```

E no upstream `socc/`:

```
socc/
├── scripts/build.ts             # + pre-processing do feature() shim + emite dist/engine.mjs
├── src/entrypoints/engine.tsx   # re-exporta query
└── package.json                 # 0.2.0 + exports["./engine"]
```
