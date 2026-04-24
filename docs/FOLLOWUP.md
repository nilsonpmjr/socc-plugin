# SOC Copilot Plugin — Followup (Fase 0 concluída)

Fonte de verdade: `/home/nilsonpmjr/Modelos/prd/socc-copilot-plugin.md`
(Draft, 2026-04-22). Este documento narra o que foi feito na Fase 0, o
que diverge do PRD, e o que fica como débito antes da Fase 1.

Acompanha o [TODO.md](TODO.md).

---

## 1. O que foi entregue

Um plugin HTTP standalone operacional no nível da Fase 0 do PRD:

- **Upstream socc (Path A do PRD).** `query()` exportado como API pública
  via `dist/engine.mjs` + `exports["./engine"]`, sem split de monorepo.
  REPL original passa smoke (`--version`, CLI, dist/cli.mjs continua
  funcional).
- **Plugin headless completo.** 8 módulos TypeScript (sessionWorker,
  workerPool, sessionManager, credentials, auth, streamAdapter, Hono
  server, types), 52 testes unitários cobrindo crypto, auth, streaming
  projection, quotas, cross-tenant, SSE encoding e todas as rotas.
- **Empacotamento.** Imagem Docker multi-stage (Bun alpine, non-root,
  healthcheck), 163MB final / 46MB compressed. Compose com `socc-mongo`
  isolado em rede interna do plugin.
- **CI.** Typecheck + test + docker build + smoke boot em GitHub Actions.
- **Smoke real validado** (docker compose up, Worker Bun real
  carregando o engine do socc): `/health` → `POST /credentials` →
  `POST /sessions` → `activeSessions: 1` → `DELETE` → `activeSessions: 0`.

## 2. Aderência ao PRD — onde o entregue diverge

Reler o PRD com calma expôs várias divergências com o que implementei.
Nenhuma bloqueia a Fase 1, mas todas precisam de remediação antes da
MVP v1.0. Entro em cada uma.

### 2.1 Nomes de secrets

| PRD              | Implementado hoje             |
|------------------|-------------------------------|
| `SOCC_MASTER_KEY` | `SOCC_CREDENTIALS_MASTER_KEY` |
| `SOCC_INTERNAL_SECRET` | `SOCC_JWT_SECRET`        |

**Por que isso importa.** O manifest do PRD (§Extensions Platform) usa
os nomes `SOCC_MASTER_KEY` e `SOCC_INTERNAL_SECRET` como `generator:
random_bytes_base64` entries. Se continuar divergente, o
`ExtensionManager` da Fase 4 não conseguirá provisionar secrets pro
plugin sem um mapa de tradução. Manter os nomes do PRD é o caminho
limpo. Rename mecânico: env vars + `.env.example` + README + docstrings
+ reset dos stacks compose de dev.

### 2.2 Contrato `SoccStreamEvent` — campos ausentes

PRD §Security declara:

```ts
type SoccStreamEvent =
  | { type: "session.ready";  session_id }
  | { type: "message.start";  message_id; role: "assistant" }
  | { type: "content.delta";  message_id; delta }
  | { type: "content.done";   message_id; content; usage }       // ← usage
  | { type: "tool.call.start" | "tool.call.done"  // v1.1+
  | { type: "message.end";    message_id; stop_reason }          // ← stop_reason
  | { type: "error";          code; message; retriable }
  | { type: "heartbeat";      ts };                              // ← ts
```

O que implementamos em `streamAdapter.ts` e `index.ts`:

- ✅ `session.ready`, `message.start`, `content.delta`, `content.done`,
  `message.end`, `error`, `heartbeat`.
- ❌ `content.done` sai sem `content` agregado nem `usage` (tokens
  consumidos).
- ❌ `message.end` sai sem `stop_reason`.
- ❌ `heartbeat` sai sem `ts`.
- ✅ `tool.call.start/done` existem na forma (`tool.call.start`,
  `tool.call.end` — nome diverge do PRD: `.done`), mas tools estão
  desligadas no MVP, então o payload é exercitado só em teste.

**Impacto.** Frontend da Fase 3 (Gemini) vai precisar desses campos
para mostrar token usage e razão de parada (context length, stop
sequence, max tokens). Reconciliar agora custa pouco; depois da UI
estar pronta custa um migration de contrato.

### 2.3 Porta HTTP

PRD (§Fase 0 done e §Architecture): `:7070`. Implementei `:8787`
(Hono default vibe). Alinhar um dos dois; recomendação: alinhar com o
PRD, já que o manifest do PRD também usa `:7070`
(`health.url: http://socc-copilot:7070/v1/health`).

### 2.4 Path prefix `/v1`

PRD usa `/v1/session`, `/v1/session/:id/stream`, etc. Hoje servimos em
`/sessions`, `/credentials`, `/sessions/:id/turns`. Pro proxy do
Vantage da Fase 2 ser 1:1 com o PRD, mover tudo para sob `/v1/` é
trivial (`app.route('/v1', protectedRoutes)` no Hono). Vale fazer
antes da Fase 2.

### 2.5 Nome do endpoint de turn

- PRD: `POST /v1/session/:id/message`
- Hoje: `POST /sessions/:id/turns`

"Message" é mais legível; "turn" é mais preciso (uma mensagem do user
+ a resposta do assistant = um turn). Vou propor manter `turns` só na
implementação interna do plugin e expor `messages` no proxy do
Vantage — mas estou aberto a rename se preferir paridade literal com
o PRD.

### 2.6 Rotas faltantes da Fase 0 (US-1 AC)

- [ ] **`POST /credentials/:id/test`** — US-1 exige bloqueio do save
      se o teste retornar `ok: false`. Hoje `credentials.ts` tem
      `recordTestResult()` e o campo `lastTestResult` no doc, mas a
      rota que dispara o teste contra o provider real **não existe**.
      Debe chamar Anthropic/OpenAI/Gemini com um prompt dummy e
      verificar 200/401.
- [ ] **Flag `SOCC_ALLOW_LOCAL_PROVIDERS` (default `false`)** — rejeita
      provider=`ollama` com erro `local_provider_disabled` se
      desligada. Não implementada.
- [ ] **Max 20 provider credentials por usuário.** Sem limite hoje.
- [ ] **Timeout de geração 90s** — SSE emite `error.retriable=true` +
      aborta. Hoje não há timeout explícito por turn (o client pode
      desconectar e o handler aborta, mas sem um timer servidor).
- [ ] **Códigos de erro reservados** (PRD §Security). Hoje emito
      strings ad-hoc (ex: `session_quota`, `credential_not_found`).
      PRD reserva: `provider_unauthorized`, `provider_rate_limited`,
      `provider_unavailable`, `session_not_found`, `session_forbidden`,
      `socc_unavailable`, `socc_not_installed`, `local_provider_disabled`,
      `quota_exceeded`, `internal_error`. Mapear.

### 2.7 Logging

PRD §Dependencies lista `pino@^9`. Hoje uso `console.log` no boot e
silêncio no resto. Adicionar `pino` com redação de `Authorization`
header (PRD §Technical Risks — vazar token em log é crítico).

### 2.8 Manifest do plugin não casa com o PRD

Implementei um schema próprio em `manifest.yaml`
(`apiVersion: vantage.extensions/v1` + campos que inventei). O PRD
§Extensions Platform define um schema bem diferente (campos
`operations`, `secrets[].generator`, `requires`, `settings`,
`uninstall.confirm_phrase`, etc.) que é o que o `ExtensionManager` da
Fase 4 vai consumir.

**Ação.** Substituir meu `manifest.yaml` pelo formato exato do PRD
(bloco YAML literal, linhas 212–247 do PRD). Sem isso, Fase 4 precisa
de código tradutor.

## 3. Decisões que continuam corretas

Releitura do PRD confirma:

- **Path A (headless-REPL em repo próprio).** PRD §Proposed Solution
  explicitamente escolheu essa abordagem sobre o monorepo split. Fase 0
  entrega exatamente isso.
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
  exatamente esse teste). Não escrevi. É o primeiro item da Fase 1
  e valida a premissa central da arquitetura.
- **Cross-user = 404 (não 403).** Meu code hoje retorna `SessionNotFoundError`
  na camada manager (404-equiv), mas preciso verificar que o Hono de
  fato serializa como 404 em todas as rotas protegidas, inclusive
  SSE antes de começar o stream.
- **Hook LGPD em `users.py`** — deactivate de usuário no Vantage
  dispara `DELETE FROM socc_* WHERE user_id=X`. Nem o hook do lado
  Vantage nem a rota de recepção do lado plugin existem.
- **Export LGPD `GET /api/socc/export`.** Idem.

## 5. Cobertura atual, por camada de risco

| Camada                 | Testes | O que prova                                                    |
|------------------------|--------|----------------------------------------------------------------|
| `credentials.ts`       | 3      | crypto round-trip, wrong key rejected, ciphertext tampering    |
| `auth.ts`              | 11     | scope/issuer/audience/expiry/signature/bearer extraction       |
| `streamAdapter.ts`     | 10     | projeção de assistant/stream_event/tool_result + edge cases    |
| `sessionManager.ts`    | 11     | quota, cross-tenant, TTL bump, shutdown idempotente, ownership |
| `index.ts` (Hono+SSE)  | 17     | auth middleware, CRUD, 429 quota, 403 sid mismatch, SSE frames |
| **Total**              | **52** | **72 expect() calls, typecheck limpo**                         |

E integração real (docker compose + Worker Bun real):

- `/health` sem auth retorna `{"status":"ok","activeSessions":N}`.
- `POST /credentials` persiste no Mongo, não vaza ciphertext na response.
- `POST /sessions` aciona Worker; o Worker carrega `@vantagesec/socc/engine`
  em runtime via `import()`.
- `activeSessions` no `/health` reflete o estado real do pool.
- `DELETE /sessions/:id` termina o Worker e libera a slot da quota.

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
  52 testes passam e SSE chega completo ao client. Reportar upstream
  se persistir em Bun 1.4+.

- **`Binary` do Mongo retornando `.buffer` em vez de `Uint8Array`.**
  Funciona porque libsodium aceita ambos, mas driver Mongo 7.x pode
  mudar. Revisitar no bump do driver.

## 7. Próximo passo recomendado

**Antes de mexer na Fase 1**, fazer um PR de reconciliação com o PRD:

1. Rename de env vars (`SOCC_MASTER_KEY`, `SOCC_INTERNAL_SECRET`).
2. Mover rotas para `/v1/*` e aceitar `message` como alias de `turns`.
3. Mudar porta default para `:7070`.
4. Reescrever `manifest.yaml` no formato do PRD §Extensions Platform.
5. Completar `SoccStreamEvent` (`usage`, `stop_reason`, `heartbeat.ts`).
6. Adicionar `pino` com redação de `Authorization`.
7. Implementar `POST /credentials/:id/test` + flag
   `SOCC_ALLOW_LOCAL_PROVIDERS` + max 20 providers + timeout 90s.
8. Mapear erros para os códigos reservados do PRD §Security.

Sem isso, o proxy da Fase 2 e a Fase 4 vão precisar de camadas de
tradução que encarecem o resto do rollout. Com isso, Fase 1 (multi-
sessão concorrente) é só escrever o teste — o contrato já estará
correto.

Na Fase 1 propriamente dita, **o teste a escrever é o que o PRD
§Technical Risks marca como `Alta/Crítico` com mitigação "Fase 0
inclui auditoria ativa + testes multi-sessão concorrentes antes de
Fase 1 fechar"**. Ou seja: o PRD tecnicamente cobra esse teste na
Fase 0. Entregamos o resto da Fase 0 mas esse teste ficou para a
próxima iteração.

## 8. Inventário de arquivos

```
socc-plugin/
├── .github/workflows/ci.yml
├── .dockerignore
├── .env.example
├── compose.yml
├── Dockerfile
├── manifest.yaml                ← diverge do PRD §Extensions Platform
├── package.json                 ← file:../socc (temporário)
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
        ├── credentials.ts       # + credentials.test.ts
        ├── index.ts             # + index.test.ts
        ├── sessionManager.ts    # + sessionManager.test.ts
        ├── streamAdapter.ts     # + streamAdapter.test.ts
        └── workerPool.ts
```

E no upstream `socc/`:

```
socc/
├── scripts/build.ts             # + pre-processing do feature() shim + emite dist/engine.mjs
├── src/entrypoints/engine.tsx   # NEW — re-exporta query
└── package.json                 # 0.2.0 + exports["./engine"]
```
