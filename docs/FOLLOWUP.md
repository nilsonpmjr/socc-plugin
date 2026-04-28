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

---

## 9. Fase 3 (Frontend) — entregue 2026-04-25 pelo Gemini

`task.md.resolved` no brain do Gemini (`c9823b7d-…`) confirma todos os
itens de UI:

- Dependências instaladas: `marked`, `@microsoft/fetch-event-source`,
  `shiki`, `react-textarea-autosize`.
- Componentes em `web/src/pages/socc/`:
  - `SoccChat.tsx` (15kB) — duas colunas, SSE via fetch-event-source,
    markdown sanitizado por DOMPurify, syntax highlight com `shiki`
    `github-dark`, abort controller no botão "Stop".
  - `SoccProvidersModal.tsx` (10kB) — modal localizada (não rota
    separada), form com test-on-save, gate `local_provider_disabled`
    para Ollama.
- `App.tsx` lazy-loads `SoccChat` em `/socc` (linha 62 + 135).
- `Layout.tsx` adiciona item de sidebar com ícone `Terminal` (linha 51).
- `lib/i18n.ts` ganhou bloco `socc: {...}` em pt/en/es completo (3
  ocorrências de `socc:` confirmadas).
- Lint + build limpos (relatado pelo Gemini, falta verificar localmente
  na próxima execução).

**Observação:** o Gemini optou por modal em vez de rota
`/socc/providers` separada. Isso é uma boa simplificação para o MVP
(menos navegação para configurar primeiro provider) e não viola o PRD,
que descreve a UX em prosa sem fixar a rota.

## 11. Fase 4 (Extensions Platform) — backend entregue 2026-04-25

A plataforma genérica que converte o socc-plugin de "extensão hard-coded"
em "primeiro tenant de uma plataforma genérica de extensões" foi
implementada do lado backend com critério de generalidade já comprovado.

### O que foi entregue

- **`docker-socket-proxy`** no compose principal com a ACL exata do
  PRD §Extensions Platform (linhas 268-289). Activated by `--profile
  extensions`. Socket montado **read-only**; backend nunca toca o
  `/var/run/docker.sock` direto.
- **`backend/services/extensions/`** — package com:
  - `manifest.py` (151 linhas): pydantic estrito, `extra="forbid"`,
    rejeita path traversal em `compose_file`, regex de id (`^[a-z]…$`),
    semver em `version`, ops válidas hard-coded.
  - `registry.py` (94 linhas): descobre extensões em `backend/extensions/`,
    ignora `plugins/`, `local_plugins/`, `premium_plugins/` (legado), expõe
    `errors()` por diretório malformado para a UI surfaçar.
  - `docker_client.py` (250 linhas): wrapper async httpx para
    `tcp://docker-socket-proxy:2375` + subprocess.exec do `docker compose`
    com `DOCKER_HOST` apontando pro proxy.
  - `manager.py` (486 linhas): orquestrador. Lock atômico via Mongo
    `update_one` com `$or`/`$exists`; geração de secrets
    (`random_bytes_base64`/`hex`); preflight (`compose config` dry-run);
    state guard (`_ACTIONABLE` por status); reconcile no boot.
- **`backend/routers/extensions.py`** (364 linhas): rotas em
  `/api/extensions/{,/:id,/:id/status,/:id/install,/:id/uninstall,
  /:id/start,/:id/stop,/:id/restart,/:id/settings,/:id/secrets/:name/rotate,
  /:id/logs}`. Mutações exigem `require_role(["admin"])`. Audit log nas
  ações (`{ext_id}_install/uninstall/start/stop/...`).
- **`backend/extensions/socc/compose.yml`**: profile-less (gerenciado
  pelo manager), mantendo o caminho dev manual como fallback.
- **`backend/extensions/fake/`**: manifest + nginx:alpine compose
  como probe de generalidade. PRD §Phase 4 done criteria verificado.

### O que comprovamos

| Camada | Testes | O que prova |
|--------|--------|-------------|
| `manifest.py` | 4 | aceita socc; rejeita extras, path traversal, ops inválidas |
| `registry.py` | 3 | ignora legados; reporta erro por dir; mismatch id↔dir vira erro |
| `manager.py` | 5 | secret length em bytes; lock+release; concurrent install=409; uninstall exige confirm_phrase; settings valida tipos |
| router HTTP | 4 | tech rejeitado em install (403); admin com confirm_phrase errado loga `failure`; catálogo expõe socc; **catálogo expõe socc + fake lado a lado sem hardcode** |
| **Total** | **17** | **Suite Vantage: 436/436** |

### Decisões dignas de nota

1. **Por que httpx em vez de docker-py?** docker-py abre conexão direta
   com socket; queremos forçar todo tráfego pelo proxy ACL-restrito.
   httpx + subprocess do `docker compose` mantém a passagem auditável.

2. **Compose orchestration via subprocess.** Reimplementar `compose up`
   em Python (parsear YAML, `/containers/create` + `/networks/create` +
   depends_on + healthchecks) é semanas de trabalho com edge cases. O
   PRD aceita esse trade-off implicitamente — a plataforma de extensões
   é orquestrada pelo CLI oficial respeitando a ACL.

3. **Lock idempotente via `$or` + `$exists`.** O `_try_acquire_lock`
   usa um único `update_one` atômico (`$or: [{locked_by: None}, {locked_by:
   {$exists: false}}]`) — Mongo garante atomicidade, segunda tentativa
   falha sem race. O FakeDB foi estendido pra suportar essa operação,
   mantendo backward-compat com os 420 testes pré-existentes.

4. **Geração de secrets em bytes, não chars.** PRD §Extensions Platform
   `length: 32` significa 32 bytes (= 64 hex chars / 44 base64 chars
   sem padding). Validado em `test_generate_secret_lengths_match_spec`.

5. **`fake` extension é discoverable mas não auto-instalada.** Aparece
   no catálogo com status `not_installed`. Para removê-la quando a
   generality test passar: `rm -rf backend/extensions/fake`. Documentado
   no manifest.

### Frontend Fase 4 — entregue 2026-04-25 pelo Gemini com 2 desvios

O Gemini concluiu o checklist mas escolheu integrar diferente:

**Desvio 1 (consciente, defensável).** Em vez de criar rota `/extensions`
raiz como o briefing pedia, integrou no `ExtensionsCatalog.tsx` legado
dentro do menu Settings → Extensions Catalog. Justificativa: PRD
§Architecture diz literalmente "Página `/extensions` (expansão do
`ExtensionsCatalog` existente)". O Gemini interpretou ao pé da letra.
Releitura confirma a ambiguidade do próprio PRD — o §Phase 4 done
criteria fala em "página /extensions no frontend" sem mencionar rota
separada. **Critério de done atingido**, só fica numa hierarquia
diferente (Settings em vez de raiz da sidebar).

**Desvio 2 (consequência do 1).** A tabela do `ExtensionsCatalog`
agora mistura, na MESMA tabela:
- `payload.items` — plugins legados Python in-process via
  `GET /api/admin/extensions` (modelo antigo).
- `orchItems` — extensions manifest+container via `GET /api/extensions/*`
  (modelo novo da Fase 4).

Concatenação na linha 368: `rows = [...(payload?.items||[]), ...orchItems]`.

Funciona — `socc` e `fake` aparecem lado a lado, ações Install/Start/
Stop/Logs/Settings/Secrets ramificam por tipo. Mas é débito de UX:
modelos com semânticas diferentes na mesma tabela confundem. Logado
no TODO como "Decidir manter unified vs separar em duas seções".

**Não é bloqueante pra MVP.** Admin completa o ciclo install→start→
stop→restart→logs→uninstall pela UI, audit log entra no Mongo, socket
nunca sai do proxy. Os critérios objetivos do PRD §Phase 4 done estão
todos cumpridos.

### Smoke pendente

Falta apenas o smoke ponta-a-ponta humano (clicar Install → ver
container subir via socket-proxy → Logs → Uninstall com volume drop).
Backend está testado em unit; integração end-to-end com o socket-proxy
real só vai com a UI rodando.

### Risco aceito até Fase 7

- Secrets em plaintext na coleção `extensions_secrets`. Mongo já tem
  auth no Vantage; encryption-at-rest com `crypto.py` está listado em
  Hardening transversal.
- Compose orchestration depende de `docker` CLI estar presente na
  imagem do backend. CI build vai validar.

## 10. Fase 3.1 (Universal Auth estilo OpenClaw) — aberta, não implementada

O Gemini propôs um plano de OAuth/auto-discovery em
`brain/c9823b7d-…/implementation_plan.md.resolved`, mas ele ficou
incompleto e com um desvio: tratava OpenAI como "GitHub Copilot proxy".
Decisão do usuário em 2026-04-27: a fase deve seguir o padrão OpenClaw,
com login/assinatura do provider quando suportado e API key manual só
como fallback avançado.

Direção corrigida:
1. OpenAI deve ser **OpenAI Codex / ChatGPT OAuth com PKCE**, não GitHub
   Copilot proxy.
2. Anthropic deve ser **Claude CLI reuse / setup-token / API key**, não
   OAuth genérico inventado em `console.anthropic.com/oauth/authorize`.
3. A base técnica é um **auth profile/token sink** cifrado, com
   `authMode` explícito (`api_key`, `oauth`, `claude_cli`,
   `setup_token`, `local_discovery`) e refresh sob lock.
4. Implementação recomendada: OpenAI Codex OAuth + Anthropic
   CLI/setup-token primeiro; Gemini CLI OAuth e Ollama discovery depois.

Pendências antes de implementar:
1. Redirect URI/hostname público de Vantage ou fallback paste-code para
   ambientes headless.
2. Escopo Anthropic: só local/admin ou multiusuário web?
3. Storage: estender `socc_credentials` ou criar `socc_auth_profiles`.
4. Modelo default/billing por plano sem prometer disponibilidade indevida.

Atualização 2026-04-27:
- Base de `authMode` implementada em `socc_credentials`, preservando
  API key manual como `api_key`.
- `POST /api/socc/providers/import-local-auth` importa auth local do
  Codex CLI (`~/.codex/auth.json`) como `provider=openai`,
  `authMode=codex_cli`, com token/profile cifrado no plugin.
- Worker agora ativa explicitamente env/provider por sessão
  (`ANTHROPIC_API_KEY`, `SOCC_USE_OPENAI`, `CODEX_API_KEY`,
  providerOverride etc.), corrigindo a lacuna em que a credential era
  passada ao Worker mas não necessariamente usada pelo engine.
- UI ganhou botões "Login with OpenAI Codex" e "Usar login do Claude CLI".

Atualização 2026-04-27, continuação:
- `POST /api/socc/providers/import-local-auth` também importa
  `~/.claude/.credentials.json` como `provider=anthropic`,
  `authMode=claude_cli`.
- O profile Anthropic armazena metadados (`organizationUuid`,
  `subscriptionType`, `rateLimitTier`, `sourcePath`) e a sessão re-lê a fonte
  local antes de iniciar o Worker; o SOCC não vira dono paralelo do refresh
  token do Claude CLI.
- Worker usa `ANTHROPIC_AUTH_TOKEN` para `authMode=claude_cli` e mantém
  `ANTHROPIC_API_KEY` para API key manual.
- `authMode=setup_token` também passa pelo caminho bearer no Worker e a UI
  expõe esse modo no fallback manual para Anthropic.
- Ainda pendente naquele ponto: refresh sob lock para OpenAI Codex OAuth
  completo, endpoints PKCE públicos/headless, Gemini CLI OAuth e Ollama
  discovery.

Atualização 2026-04-27, Ollama discovery:
- `POST /api/socc/providers/discover-local` proxia para
  `/v1/credentials/discover-local`, respeitando `socc_allow_local_providers`.
- O plugin faz `GET http://localhost:11434/api/tags` com timeout de 1s; quando
  encontra modelos, cria credential `provider=ollama`,
  `authMode=local_discovery`, `apiKey=ollama-local`, `defaultModel` igual ao
  primeiro modelo retornado.
- UI ganhou botão "Detect Local Ollama"; quando não detecta, retorna hint
  operacional (`Run: ollama serve` ou `ollama pull llama3.2`).
- Ainda pendente: refresh sob lock para OpenAI Codex OAuth completo, endpoints
  PKCE públicos/headless e Gemini CLI OAuth.

Atualização 2026-04-27, OpenAI Codex PKCE skeleton:
- Plugin ganhou `socc_oauth_state` com TTL index, PKCE verifier/challenge,
  `state` por usuário e consumo único.
- `GET /v1/oauth/openai-codex/login` gera state+PKCE e redireciona para
  `OPENAI_CODEX_OAUTH_AUTHORIZE_URL` quando `OPENAI_CODEX_OAUTH_CLIENT_ID` e
  `OPENAI_CODEX_OAUTH_REDIRECT_URI` estão configurados; há rate limit 5/min/user.
- `GET /v1/oauth/openai-codex/callback` valida `code`/`state`, impede state
  cross-user e consome o state uma vez. A troca de token ainda retorna
  `oauth_exchange_not_configured` de propósito, até existir contrato/token
  exchange configurado.
- `POST /v1/oauth/openai-codex/callback` aceita fallback headless com
  `callbackUrl` colada ou `{code,state}` explícitos, reutilizando a mesma
  validação/consumo único.
- Backend Vantage expõe `/api/socc/oauth/openai-codex/login` e
  `/api/socc/oauth/openai-codex/callback`, preservando redirect 302 no login,
  proxyando o fallback headless e auditando início/falha do fluxo.
- Hardening adicional: Pino redige `code`, `code_verifier`, `codeVerifier`,
  `state`, `access_token` e tokens em `authProfile`/`oauth`; teste dedicado
  cobre saída estruturada do logger. `OAuthStateStore` ganhou teste dedicado
  de isolamento cross-user e expiração.
- UI Anthropic mantém API key como opção recomendada para produção/multiusuário
  e explicita setup-token como fallback quando Claude CLI reuse não está disponível.
- Ainda pendente: token exchange real, criação de credential `authMode=oauth`,
  Gemini CLI OAuth e refresh sob lock.

---

## 12. Fase 4 (Frontend) — entregue 2026-04-25 pelo Gemini

O frontend da plataforma de extensões foi entregue com uma mudança de arquitetura solicitada pelo usuário durante a implementação: **unificação total com o catálogo existente.**

### O que foi alterado (Mudança de plano)

Inicialmente, o plano previa uma página isolada em `/extensions`. O usuário solicitou que:
1.  Não houvesse uma rota separada nem item de sidebar raiz.
2.  As novas extensões fossem integradas diretamente na tabela existente do `ExtensionsCatalog.tsx` em `/settings/extensions`.
3.  Toda a lógica de gerenciamento (modais, polling) fosse incorporada à página de Settings para manter a consistência administrativa.

### O que foi entregue

- **Integração na Tabela Unificada:** `ExtensionsCatalog.tsx` agora faz o merge dos itens do catálogo legado (`/api/admin/extensions`) com os itens orquestrados (`/api/extensions`).
- **Ações Contextuais:** O menu de ações da linha na tabela detecta se a extensão é orquestrada e exibe opções específicas: *Logs, Settings, Secrets, Start/Stop/Restart, Uninstall*.
- **Infraestrutura Genérica em `web/src/pages/extensions/`**:
  - `lib/api.ts`: 9 endpoints do contrato orquestrado tipados.
  - `lib/poll.ts`: Utilitário de polling de status a cada 2s para transições (`installing`/`uninstalling`).
  - **Modais Completos:**
    - `UninstallModal`: Exige frase de confirmação dinâmica e opção de preservação de volumes.
    - `LogsModal`: Streaming via SSE com buffer de 5k linhas e auto-scroll.
    - `SettingsModal`: Formulário gerado dinamicamente a partir do `settings_schema`.
    - `SecretsModal`: Rotação de secrets com confirmação.
- **Side-rail Contextual:** O painel lateral de detalhes agora adapta as métricas exibidas conforme o tipo da extensão selecionada.
- **i18n:** Adicionado namespace `extensions` em PT, EN e ES no `web/src/lib/i18n.ts`.

### Estado Atual

A plataforma está 100% operacional no catálogo de Settings. Extensões como `socc` e `fake` aparecem lado a lado com as extensões legadas, compartilhando a mesma UI de tabela mas com capacidades de gerenciamento modernas.
