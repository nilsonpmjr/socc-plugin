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
- [x] `package.json` com `file:../socc` durante dev; deps: `hono`, `jose`, `libsodium-wrappers`, `mongodb`, `ulid`, `zod` (`pino` ainda não — ver débito em FOLLOWUP).
- [x] `src/sessionWorker.ts` — Bun Worker body, 1 sessão = 1 Worker (não compartilha STATE).
- [x] `src/server/workerPool.ts` — spawn/run/abort/shutdown; limite `maxConcurrent`; respawn em crash.
- [x] `src/server/sessionManager.ts` — quota 3 sessões/usuário (PRD §Security); ownership scoping; TTL sweep; cross-tenant impossível por design.
- [x] `src/server/credentials.ts` — libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305), nonce 24B, master key 32B via env. Plaintext nunca em log/response.
- [x] `src/server/auth.ts` — JWT HS256 scope=socc, iss=vantage, aud=socc-plugin, TTL≤60s; `claims.sub` obrigatório; `claims.sid` opcional.
- [x] `src/server/streamAdapter.ts` — projeção de `query()` events para `SoccStreamEvent`.
- [x] `src/server/index.ts` — Hono + SSE em `:8787`: `/health`, `/credentials` CRUD, `/sessions` CRUD, `/sessions/:id/turns`, `/sessions/:id/abort`. Heartbeat 15s. Graceful shutdown (SIGINT/SIGTERM).
- [x] 52 testes unitários (typecheck limpo).
- [x] `Dockerfile` multi-stage, non-root, healthcheck, bundle `server.mjs` + `sessionWorker.mjs`.
- [x] `compose.yml` com `socc-mongo` isolado (critério PRD §Integration Points).
- [x] `manifest.yaml` schema `vantage.extensions/v1` (manifest real do PRD §Extensions Platform ainda precisa reconciliação — ver débito).
- [x] `.env.example`, `.dockerignore`, `README.md`, `.github/workflows/ci.yml` (typecheck + test + docker build + smoke boot).
- [x] Smoke real: `docker compose up` + curl autenticado → credential cifrada → sessão → Worker real carrega `@vantagesec/socc/engine` → `activeSessions` reflete → DELETE libera slot.

### Débito conhecido desta fase (ver FOLLOWUP §Débito técnico)
- [ ] Renomear `SOCC_JWT_SECRET` → `SOCC_INTERNAL_SECRET` (nome do PRD §Security).
- [ ] Renomear `SOCC_CREDENTIALS_MASTER_KEY` → `SOCC_MASTER_KEY` (nome do PRD §Security).
- [ ] `SoccStreamEvent` no PRD inclui `session.ready`, `content.done{content,usage}`, `message.end{stop_reason}`, `heartbeat{ts}`. Hoje emitimos sem `usage`/`stop_reason`/`ts`. Reconciliar contrato.
- [ ] `POST /credentials/:id/test` — US-1 exige que o save só persista se o teste de provider retornar `ok: true`. Hoje existe `recordTestResult` na store mas não existe a rota.
- [ ] Flag `SOCC_ALLOW_LOCAL_PROVIDERS` (default `false`) — rejeitar `provider=ollama` com `local_provider_disabled` se flag desligada. Não implementado.
- [ ] `pino` logging JSON estruturado (PRD §Dependencies). Hoje usamos `console.log`.
- [ ] Binding HTTP no PRD é `:7070`; hoje servimos em `:8787`. Decidir canonicidade e alinhar manifest + compose + docs.
- [ ] Max 20 provider credentials por usuário (PRD §Security). Hoje sem limite.
- [ ] Timeout de geração 90s → SSE emite `error.retriable=true` + aborta (PRD §Security). Hoje sem timeout explícito.
- [ ] `SOCC_WORKER_URL` é workaround do bundling; ideal é layout que resolve via `import.meta.url` sem env var.

---

## Fase 1 — Compose profile no Vantage + multi-session test

**Critério de done do PRD:** "Container sobe via `docker compose --profile socc up`;
cross-user isolation verificado com 2 users concorrentes."

- [ ] Adicionar `profile: socc` em `backend/extensions/socc/compose.yml` (no repo Vantage).
- [ ] Rede interna: `socc-copilot` + `socc-mongo` na rede do Vantage, não expõem porta ao host.
- [ ] `docker compose --profile socc up -d` sobe os dois services e passa healthcheck.
- [ ] **Teste de integração multi-sessão** cobrindo todos os pontos levantados no PRD:
  - [ ] 2 sessões concorrentes de **mesmo usuário** com providers diferentes → `STATE` não vaza entre Workers (prova a premissa do PRD §Architecture).
  - [ ] 2 sessões de **usuários distintos** → user A não lê/aborta sessão de user B; plugin retorna **404 (não 403)** — PRD §US-4 AC3.
  - [ ] `session_id` forjado por user A apontando para sessão de user B → 404.
  - [ ] 10 sessões × 5 turnos rápidos → medir RSS vs baseline (~30–50MB/Worker esperado).
  - [ ] SIGKILL externo em um Worker → sessão marcada como crashed, pool respawn limpo, SSE emite `error.code=session_worker_crashed` (PRD §Technical Risks).

---

## Fase 2 — Backend do Vantage (`backend/routers/socc.py`)

**Critério de done do PRD:** "Testes unitários + integração mockando socc-copilot;
cross-user retorna 404."

- [ ] `backend/routers/socc.py` com proxy autenticado:
  - [ ] `POST /api/socc/providers` → encaminha ao plugin após mintagem de JWT.
  - [ ] `GET /api/socc/providers` / `DELETE /api/socc/providers/:id`.
  - [ ] `POST /api/socc/providers/:id/test` — US-1 AC: bloqueia save se `ok: false`.
  - [ ] `POST /api/socc/session` → plugin `/sessions`.
  - [ ] `GET /api/socc/session/:id/stream` — proxy SSE bidirecional.
  - [ ] `POST /api/socc/session/:id/message` → plugin `/sessions/:id/turns`.
  - [ ] `POST /api/socc/session/:id/abort` → plugin `/sessions/:id/abort`.
- [ ] Mintagem JWT interno `{sub: user_id, scope: "socc", sid: session_id, exp: now+60s}` assinado com `SOCC_INTERNAL_SECRET`.
- [ ] Middleware redacta `Authorization` em logs (PRD §Technical Risks — vaza em logs = crítico).
- [ ] Rate limit (PRD §Security):
  - [ ] 20 msgs/min por usuário (via `limiters.py`).
  - [ ] Máx 3 sessões ativas/usuário.
  - [ ] Máx 20 provider credentials/usuário.
  - [ ] Max output tokens configurável por credential (default 4096).
- [ ] Resposta **404** (não 403) para session alheia — não vaza existência.
- [ ] Flag `SOCC_ALLOW_LOCAL_PROVIDERS` (env do backend) — rejeita provider `ollama` com erro `local_provider_disabled` se `false`.
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
- [ ] `backend/extensions/socc/manifest.yaml` **idêntico ao exemplo do PRD §Extensions Platform** (não o que escrevi em `manifest.yaml` hoje — reconciliar).
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
- [ ] SSE emite `tool.call.start` e `tool.call.done` (PRD §Security SoccStreamEvent).
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
