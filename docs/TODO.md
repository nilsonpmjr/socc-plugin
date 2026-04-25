# SOC Copilot Plugin — TODO

Fonte de verdade: `/home/nilsonpmjr/Modelos/prd/socc-copilot-plugin.md` (Draft, 2026-04-22).
Este documento traduz o *Phased Rollout* do PRD em checklist acionável.
Itens marcados `[x]` estão concluídos; os demais seguem a ordem do PRD.

> **Success criteria do PRD** (referência, não checklist):
> 1. Install end-to-end ≥ 95% dos cliques em "Install"
> 2. TTFT P50 ≤ 1.2s / P95 ≤ 3s (Anthropic/OpenAI/Gemini)
> 3. Zero cross-user leak em auditoria trimestral
> 4. ≥ 40% dos admins/managers cadastram ≥ 1 credential em 30 dias
> 5. ≥ 99% das mensagens chegam a `message.end` sem `error.retriable=true`

---

## Fase 0 — Headless server no socc-plugin

**Critério de done do PRD:** "REPL original passa smoke sem regressão;
`bun run socc --headless --port=7070` sobe e aceita 1 sessão via curl."

### Upstream socc
- [x] Auditar `STATE` singleton em `bootstrap/state.ts`.
- [x] Expor `query()` via `dist/engine.mjs` + `exports["./engine"]` no `package.json` (sem split de monorepo — Path A do PRD).
- [x] Smoke do REPL original continua passando (`--version`, CLI).

### Plugin (`socc-plugin` sob `nilsonpmjr/`)
- [x] `package.json` com `file:../socc` durante dev; deps: `hono`, `jose`, `libsodium-wrappers`, `mongodb`, `pino`, `ulid`, `zod`.
- [x] `src/sessionWorker.ts` — Bun Worker body, 1 sessão = 1 Worker (não compartilha STATE).
- [x] `src/server/workerPool.ts` — spawn/run/abort/shutdown; limite `maxConcurrent`; respawn em crash.
- [x] `src/server/sessionManager.ts` — quota 3 sessões/usuário (PRD §Security); ownership scoping; TTL sweep; cross-tenant impossível por design.
- [x] `src/server/credentials.ts` — libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305), nonce 24B, master key 32B via env (`SOCC_MASTER_KEY`). Plaintext nunca em log/response. Max 20 creds/user via `MAX_CREDENTIALS_PER_USER`.
- [x] `src/server/auth.ts` — JWT HS256 scope=socc, iss=vantage, aud=socc-plugin, TTL≤60s; `claims.sub` obrigatório; `claims.sid` opcional; secret via `SOCC_INTERNAL_SECRET`.
- [x] `src/server/streamAdapter.ts` — projeção de `query()` events para `SoccStreamEvent` com `content.done{content,usage}`, `message.end{stopReason}`, `heartbeat{ts}` completos. Retorna `{step, finalize, getCurrentMessageId}`.
- [x] `src/server/providerTester.ts` — round-trip Anthropic/OpenAI/Gemini/Ollama, classifica 200/401/400-404/rede; usado pela rota `/v1/credentials/:id/test`.
- [x] `src/server/logger.ts` — pino JSON estruturado com redact em `Authorization` + `apiKey`.
- [x] `src/server/errors.ts` — constantes dos 10 códigos reservados do PRD §Security.
- [x] `src/server/index.ts` — Hono + SSE em `:7070` sob `/v1/*`:
  - [x] `/v1/health` (público), `/v1/credentials` CRUD + `/v1/credentials/:id/test`.
  - [x] `/v1/session` (singular) CRUD + `/v1/session/:id/message` (PRD) + `/v1/session/:id/turns` (alias) + `/v1/session/:id/abort`.
  - [x] Heartbeat 15s com `ts`. Graceful shutdown (SIGINT/SIGTERM).
  - [x] Timeout 90s por turn → SSE `error.code=provider_unavailable retriable=true` + aborta worker.
  - [x] Flag `SOCC_ALLOW_LOCAL_PROVIDERS` (default `false`) → rejeita `provider=ollama` com `local_provider_disabled`.
  - [x] Cross-user = 404 (`session_not_found`); sid mismatch = 403 (`session_forbidden`).
- [x] 58 testes unitários (typecheck limpo, 125 expect() calls).
- [x] `Dockerfile` multi-stage, non-root, healthcheck `/v1/health`, bundle `server.mjs` + `sessionWorker.mjs`.
- [x] `compose.yml` com `socc-mongo` isolado, env vars e healthcheck alinhados com PRD.
- [x] `manifest.yaml` no schema **exato** do PRD §Extensions Platform (id, compose_file, operations, health, secrets, requires, settings, uninstall).
- [x] `.env.example`, `.dockerignore`, `README.md`, `.github/workflows/ci.yml` (typecheck + test + docker build + smoke boot) atualizados.
- [x] Smoke real: `docker compose up` + curl autenticado → credential cifrada → sessão → Worker real carrega `@vantagesec/socc/engine` → `activeSessions` reflete → DELETE libera slot.

### Débito pendente (hardening antes de v1.0)
- [ ] `SOCC_WORKER_URL` é workaround do bundling; ideal é layout que resolve via `import.meta.url` sem env var.
- [ ] Publicar `@vantagesec/socc` no npm → remover `file:../socc`.
- [x] Teste multi-sessão concorrente no plugin — `src/server/integration/sessionIsolation.test.ts` (6 cenários: same-user paralelo, 5 sessões × 3 turnos, cross-user 404, sid forjado 403, crash recovery, promptCount sequencial).
- [x] **Auto-reap de sessões órfãs após crash do Worker.** PRD §Technical Risks mitigação implementada: `WorkerPool` aceita `setOnWorkerDied`; `SessionManager.handleWorkerDied` marca `rec.crashed`; `consumeCrashed` usado pelo handler `/v1/session/:id/message` antes de criar o stream, emite SSE `error.code=session_worker_crashed retriable=true` e libera a slot da quota imediatamente; `sweepIdle` reapa também records crashed que ninguém leu. Coberto por 2 testes adicionais em `sessionIsolation.test.ts` (HTTP path + sweep path).

---

## Fase 1 — Compose profile no Vantage + multi-session test

**Critério de done do PRD:** "Container sobe via `docker compose --profile socc up`;
cross-user isolation verificado com 2 users concorrentes."

### Teste de isolamento (concluído no plugin — 2026-04-24)
- [x] 2 sessões de **mesmo usuário** com providers diferentes rodando em paralelo → echos confirmam que cada Worker viu seu próprio STATE; sem vazamento de apiKeySuffix/provider/model. [`sessionIsolation.test.ts`]
- [x] 5 sessões × 3 turnos concorrentes + bust de quota (`quota_exceeded` na 4ª sessão) — todos os echos consistentes.
- [x] 2 usuários distintos → user B não lê/aborta sessão de user A; plugin retorna **404 com `error: session_not_found`** (não 403; não vaza existência — PRD §US-4 AC3).
- [x] JWT com `sid` forjado apontando para outra sessão do mesmo user → 403 com `error: session_forbidden`.
- [x] Worker terminate externo (simula SIGKILL) → pool marca `dead`, handler surfaça erro, próxima `POST /v1/session` do mesmo user funciona (quota não bloqueia indefinidamente porque a slot não conta na mesma concorrência).
- [x] Turns sequenciais na mesma sessão → `STATE.promptCount` incrementa dentro do mesmo realm (sem reset espúrio).

### Integração no Vantage (concluída — 2026-04-24)
- [x] Criado `Threat-Intelligence-Tool/backend/extensions/socc/manifest.yaml` (cópia literal do schema PRD §Extensions Platform).
- [x] Criado `Threat-Intelligence-Tool/backend/extensions/socc/compose.yml` com `profile: socc` em ambos os services (`socc-copilot` + `socc-mongo`).
- [x] Network `vantage_internal` referenciado como `external: true` — overlay anexa à rede do Vantage sem criar uma própria.
- [x] Nada exposto na host (`requires.ports: []`); plugin reachable apenas via DNS interno `socc-copilot:7070`.
- [x] `docker compose -f docker-compose.yml -f backend/extensions/socc/compose.yml --profile socc up -d` sobe os dois services, ambos passam healthcheck.
- [x] **Cross-user smoke contra o container real** via alpine peer (`docker run --network vantage_internal alpine + curl`):
  - Alice cria credential + session → Worker real carrega `@vantagesec/socc/engine`.
  - Bob `GET /v1/session` → `{sessions: []}` (não vaza existência).
  - Bob `POST /v1/session/<alice's id>/message` → **HTTP 404 `{"error":"session_not_found"}`** (PRD §US-4 AC3).
  - `/v1/health` reflete `activeSessions: 1` → `DELETE` → `0`.
  - pino structured logging visível: `{"level":30, "name":"socc-plugin", "port":7070, "msg":"socc-plugin listening"}`.
- [x] `Threat-Intelligence-Tool/backend/extensions/socc/README.md` documenta o ciclo dev (build local + `up` + smoke + `down -v`).

### Ampliações futuras
- [ ] Load test 10 sessões × 5 turnos → medir RSS vs baseline (~30–50MB/Worker esperado). Entra na Fase "Hardening transversal".

---

## Fase 2 — Backend do Vantage (`backend/routers/socc.py`)

**Critério de done do PRD:** "Testes unitários + integração mockando socc-copilot;
cross-user retorna 404."

- [ ] `backend/routers/socc.py` com proxy autenticado:
  - [ ] `POST /api/socc/providers` → encaminha ao plugin após mintagem de JWT.
  - [ ] `GET /api/socc/providers` / `DELETE /api/socc/providers/:id`.
  - [ ] `POST /api/socc/providers/:id/test` — US-1 AC: bloqueia save se `ok: false` (plugin já expõe `/v1/credentials/:id/test`).
  - [ ] `POST /api/socc/session` → plugin `/v1/session`.
  - [ ] `GET /api/socc/session/:id/stream` — proxy SSE bidirecional.
  - [ ] `POST /api/socc/session/:id/message` → plugin `/v1/session/:id/message`.
  - [ ] `POST /api/socc/session/:id/abort` → plugin `/v1/session/:id/abort`.
- [ ] Mintagem JWT interno `{sub: user_id, scope: "socc", sid: session_id, exp: now+60s}` assinado com `SOCC_INTERNAL_SECRET`.
- [ ] Middleware redacta `Authorization` em logs (PRD §Technical Risks — vaza em logs = crítico).
- [ ] Rate limit (PRD §Security):
  - [ ] 20 msgs/min por usuário (via `limiters.py`).
  - [ ] Máx 3 sessões ativas/usuário.
  - [ ] Máx 20 provider credentials/usuário (plugin já enforce; ecoar no backend p/ UX).
  - [ ] Max output tokens configurável por credential (default 4096).
- [ ] Resposta **404** (não 403) para session alheia — não vaza existência.
- [ ] Flag `SOCC_ALLOW_LOCAL_PROVIDERS` (env do backend) — rejeita provider `ollama` com erro `local_provider_disabled` se `false` (plugin também enforce).
- [ ] Audit log em `audit.py` com eventos:
  - [ ] `socc_provider_created`, `socc_provider_revoked`, `socc_provider_tested`.
  - [ ] `socc_session_started`, `socc_session_ended`.
  - [ ] `socc_message_sent` (só metadados — **nunca conteúdo** — PRD §Security).
  - [ ] `socc_install`, `socc_uninstall`, `socc_flag_changed`.
- [ ] Hook em `users.py` no deactivate → `DELETE FROM socc_* WHERE user_id=X` (PRD §LGPD).
- [ ] `GET /api/socc/export` (LGPD portabilidade): JSON com sessões/mensagens/providers (keys mascaradas).
- [ ] Testes pytest: proxy happy path, JWT TTL, redação de log, rate limit, cross-user=404, audit trail, LGPD export.

---

## Fase 3 — Frontend `/socc` e `/socc/providers` (v1.0 MVP, via Gemini)

**Critério de done do PRD:** "Lint+build limpos; 3 idiomas; screenshots em PR review."

### US-2 — Conversar com o copiloto
- [ ] Rota `/socc` — layout duas colunas (sidebar de sessões + chat).
- [ ] Enter envia, Shift+Enter quebra linha; textarea auto-grow.
- [ ] SSE via `@microsoft/fetch-event-source` (PRD §Dependencies) — POST com reconexão.
- [ ] Markdown via `marked` + `DOMPurify` (já presentes no Vantage).
- [ ] Syntax highlight (`shiki` ou `highlight.js`, o que já estiver no bundle).
- [ ] Botão "parar" durante streaming → `POST /api/socc/session/:id/abort`.
- [ ] Heartbeat handling + reconexão com `Last-Event-ID` (plugin já emite `id:`).
- [ ] Toast traduzido para `provider_rate_limited` com "tentar de novo".
- [ ] **3 idiomas completos pt/en/es** para toda string nova.

### US-1 — Configurar provider pessoal
- [ ] Form em `/socc/providers`: provider, rótulo, API key (type=password), base_url opcional, modelo default.
- [ ] Save → chama `POST /api/socc/providers/:id/test`; confirma só se `ok: true`.
- [ ] Lista de providers com `keyPreview` só (ex: `sk-...abcd`).
- [ ] Revoke com confirm; mostra `lastTestResult` quando aplicável.
- [ ] `ollama` bloqueado no form quando `SOCC_ALLOW_LOCAL_PROVIDERS=false`, exibe `local_provider_disabled`.

### Não-goals explícitos do PRD
- [ ] (Non-goal) Sem `assistant-ui` ou `chatbot-kit` — tudo com design system do Vantage.
- [ ] (Non-goal) Sem rename/pin/export de sessões no MVP (v1.1).

---

## Fase 4 — Plataforma de extensões (genérica)

**Critério de done do PRD:** "Admin instala/inicia/para/desinstala o SOC Copilot
**inteiramente pela UI** (zero CLI); `tecnativa/docker-socket-proxy` com ACL mínima;
framework aceita nova extensão (teste: manifest fake + compose trivial e ver card renderizar);
uninstall destrói volume por default; audit log de todas as ops; socket nunca montado no backend."

### Docker Socket Proxy
- [ ] `docker-socket-proxy` no `docker-compose.yml` principal com imagem `tecnativa/docker-socket-proxy:0.2`.
- [ ] ACL exata do PRD: `CONTAINERS=1, NETWORKS=1, VOLUMES=1, IMAGES=1, POST=1, EXEC=0, SERVICES=0, TASKS=0, SECRETS=0, CONFIGS=0, NODES=0, PLUGINS=0, SWARM=0, SYSTEM=0`.
- [ ] Socket montado read-only; backend fala via `tcp://docker-socket-proxy:2375`.
- [ ] **Socket nunca montado no backend diretamente** (auditoria grep no compose).
- [ ] Smoke no CI: tenta `EXEC` e `SWARM` e espera 403 (PRD §Technical Risks).

### Manifest schema + parser
- [ ] Schema do PRD §Extensions Platform (pydantic strict): `id`, `name`, `version`, `compose_file`, `operations`, `health{url,interval_seconds,timeout_seconds}`, `secrets[{name,generator,length}]`, `requires{docker_socket_proxy,disk_space_mb,ports}`, `settings[{key,type,default,label}]`, `uninstall{destroy_volumes_by_default,confirm_phrase}`.
- [ ] `generator: random_bytes_base64` implementado para `SOCC_MASTER_KEY` (32B) e `SOCC_INTERNAL_SECRET` (32B).
- [ ] Validar `compose.yml` com `docker compose config` dry-run antes de `up` (PRD §Risks: manifest injection).

### Backend services/routers
- [ ] `backend/services/extensions/manager.py` — `ExtensionManager`: load manifests, pré-flight, lifecycle, `extensions_state`, audit.
- [ ] `backend/services/extensions/docker_client.py` — wrapper apontando para socket-proxy.
- [ ] `backend/services/extensions/manifest.py` — parser + validator.
- [ ] `backend/services/extensions/registry.py` — lista extensions a partir de `backend/extensions/`.
- [ ] `backend/routers/extensions.py` com rotas do PRD:
  - [ ] `GET /api/extensions`
  - [ ] `GET /api/extensions/:ext_id`
  - [ ] `GET /api/extensions/:ext_id/status` (polling + SSE)
  - [ ] `POST /api/extensions/:ext_id/install` (admin + MFA, 202 + task_id)
  - [ ] `POST /api/extensions/:ext_id/uninstall` (admin + MFA + `confirm_phrase` no body)
  - [ ] `POST /api/extensions/:ext_id/start|stop|restart` (admin + MFA)
  - [ ] `GET /api/extensions/:ext_id/logs` (SSE tail, multiplexa containers)
  - [ ] `PATCH /api/extensions/:ext_id/settings` (admin + MFA, reinicia se necessário)
  - [ ] `POST /api/extensions/:ext_id/secrets/:name/rotate` (admin + MFA)
- [ ] Install assíncrono (FastAPI `BackgroundTasks`; Celery em v2 se virar gargalo).
- [ ] Lock Mongo por `ext_id` (`extensions_state.locked_by`) — segunda tentativa concorrente = 409.
- [ ] Reconciliação no boot — lê `extensions_state`, verifica containers, corrige divergências.

### Manifest do SOC Copilot
- [x] `socc-plugin/manifest.yaml` **idêntico ao schema do PRD §Extensions Platform** (reconciliado em 2026-04-24). Quando for copiado para `backend/extensions/socc/manifest.yaml`, é cópia direta.
- [ ] `backend/extensions/socc/compose.yml` — `socc-copilot` + `socc-mongo`, profile-less (runs via manager).

### Frontend `/extensions`
- [ ] Página genérica renderizando cards a partir do catálogo (**sem código específico de socc**).
- [ ] Estados live: `not_installed`, `installing`, `installed_healthy`, `installed_unhealthy`, `stopped`, `installing_failed`, `uninstalling`.
- [ ] Ações contextuais conforme estado: Install / Uninstall / Start / Stop / Restart / View Logs / Settings / Rotate Secret.
- [ ] Modal de logs (SSE tail em tempo real).
- [ ] Modal destrutivo de uninstall com `confirm_phrase` literal digitada (ex: `uninstall socc`).
- [ ] Opção "preservar volume" visível mas **desmarcada** por default.
- [ ] Pré-flight falho → botão desabilitado com tooltip (não falha silenciosa).

### Teste de generalidade
- [ ] Adicionar manifest fake + compose trivial (pacote npm dummy) em `backend/extensions/fake/`.
- [ ] Card renderiza na UI sem nenhuma mudança de código. Install → Start → Logs → Uninstall completo ponta-a-ponta sem mencionar "socc" no caminho.

---

## Fase 5 — v1.1: Read-only tools + histórico persistente

**Critério de done do PRD:** "Tool calls aparecem no SSE; precision@1 ≥ 85% em 50 perguntas golden."

- [ ] Tools do PRD §AI System Requirements:
  - [ ] `query_feed(severity?, source?, limit)` → `/api/feed`
  - [ ] `analyze_ioc(target, type)` → `/api/analyze` (verdict + risk score)
  - [ ] `search_watchlist(query)` → `/api/watchlist`
  - [ ] `search_incidents(date_range?, severity?)` → `/api/stats`
  - [ ] `get_system_health()` → `/api/admin/system-health` (admin only)
- [ ] `canUseTool` substituído por policy real no plugin (hoje: deny-all).
- [ ] SSE emite `tool.call.start` e `tool.call.done` (PRD §Security). Nota: plugin hoje emite `tool.call.end` — decidir paridade de nome antes de Fase 5.
- [ ] Histórico persistente em `socc_messages` do `socc-mongo` — TTL 30 dias default (PRD §LGPD).
- [ ] Rename / pin / export de sessão na UI.
- [ ] Eval: 50 perguntas golden com tools esperadas → precision@1 ≥ 85%.

---

## Fase 6 — v1.2: Write tools + skills + RBAC fino

- [ ] Write tools: `create_handoff`, `add_to_watchlist`, `start_batch_analysis`.
- [ ] Skills portadas de `.socc/skills/`: `payload-triage`, `phishing-analysis`, `malware-behavior`, `suspicious-url`, `soc-generalist`.
- [ ] RBAC fino: tool só aparece no registry da sessão se `user.role` tem permissão. Teste negativo (tech não vê admin tools).
- [ ] Cotas por org (não por usuário) + dashboards de custo por user/org via `cost-tracker.ts` do socc.
- [ ] MCP custom por usuário (v2, move para Fase 7).

---

## Fase 7 — Pós-validação

- [ ] Reavaliar extração de `@socc/engine` puro (monorepo split) com base nas métricas de Success Criteria. Decisão go/no-go documentada.
- [ ] Rotação in-band de `SOCC_MASTER_KEY` — endpoint `POST /api/socc/rotate-master-key` com re-encrypt loop.
- [ ] Multi-org / tenancy hierárquico quando o Vantage ganhar orgs.
- [ ] MCP custom por usuário.
- [ ] Streaming em redes móveis/PWA — validar reconexão SSE em background.
- [ ] Billing/cost tracking dashboards.

---

## Hardening transversal (antes de sair de `dev` para `main`)

PRD §Non-Goals: "Deploy em produção via `main` no MVP — vive em `dev` até validação distribuída."

- [ ] Publicar `@vantagesec/socc` no npm → remover `file:../socc`.
- [ ] Tag de imagem pinada por digest (`ghcr.io/nilsonpmjr/socc-plugin@sha256:…`); installer **rejeita `:latest`**.
- [ ] Procedimento manual documentado de rotação do `SOCC_MASTER_KEY` (re-encrypt loop + restart) — PRD §Security.
- [ ] Trivy/grype scan no CI; CVE high = build quebrado.
- [ ] Lint rule bloqueando imports de `components/`, `screens/`, `ink/` em `src/server/` e entrypoints headless do socc (PRD §Technical Risks: "Headless server importa React/Ink acidentalmente e infla imagem").
- [ ] Load test do PRD §Evaluation Strategy: 50 sessões concorrentes, 10 msg/s, P95 TTFT < 3s, zero vazamento de estado.
- [ ] Golden conversations: 20 por provider (Anthropic/OpenAI/Gemini) — roteiro scripted + asserts de streaming.
- [ ] Provider failover: simular `provider_unauthorized` mid-stream, verificar toast traduzido + retry funciona.

---

## Escopo deliberadamente adiado (Non-goals do PRD §2)

- Tools ou skills no MVP (só chat puro).
- Compartilhamento de credenciais entre usuários ou orgs.
- Rename/pin/export de sessões (v1.1).
- MCP custom por usuário (v2).
- Histórico persistente em Mongo no MVP (memória com TTL).
- Providers locais (Ollama) habilitados por padrão (flag admin explícita).
- UI de chat com lib externa (assistant-ui, chatbot-kit, etc).
- Deploy em produção via `main` no MVP.
