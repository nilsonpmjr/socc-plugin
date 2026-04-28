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
- [x] `SOCC_WORKER_URL` eliminado — `workerPool.ts` detecta contexto bundled via `import.meta.url.endsWith('.ts')`; `WorkerPool` aceita `workerUrl` no construtor como alternativa limpa para testes; env var e referências no Dockerfile removidas. Plugin 91/91.
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

### Proxy + auth + audit (concluído — 2026-04-25)
- [x] `backend/routers/socc.py` montado em `/api/socc/*` (com alias `/api/v1/socc/*`).
- [x] Rotas espelhando o plugin: `POST/GET/DELETE /providers`, `POST /providers/:id/test`, `POST/GET/DELETE /session`, `POST /session/:id/message` (SSE), `POST /session/:id/abort`.
- [x] Mintagem JWT interno HS256 com claims `{sub: user_id, scope: "socc", sid?, iss: vantage, aud: socc-plugin}`, TTL 60s, secret `SOCC_INTERNAL_SECRET` (PRD §Security).
- [x] **Cross-user passa 404 verbatim** — confirmado por `test_cross_user_404_passes_through`.
- [x] Flag `socc_allow_local_providers` (config) gateia `ollama` com `403 local_provider_disabled` antes de qualquer chamada httpx — confirmado por `test_ollama_blocked_when_local_providers_disabled`.
- [x] SSE pass-through via `httpx.AsyncClient.stream` + `StreamingResponse` (`text/event-stream` + `X-Accel-Buffering: no`).
- [x] Plugin unreachable → 503 com `error: socc_unavailable` — confirmado por `test_unreachable_plugin_returns_socc_unavailable`.
- [x] Audit log nos eventos do PRD: `socc_provider_created/revoked/tested`, `socc_session_started/ended`, `socc_message_sent`. **Conteúdo de mensagens nunca logado** — confirmado por `test_message_audit_carries_only_metadata` (procura a string secreta no JSON do audit_log e falha se aparecer).
- [x] Rate limit `20/minute` por usuário em `/session/:id/message` via `@limiter.limit(settings.rate_limit_socc_message)`.
- [x] Router opt-in: `main.py` só inclui se `settings.socc_internal_secret != ""` — preserva "socc invisível até instalar" (PRD §Proposed Solution).
- [x] 6 testes pytest novos (`test_socc_router.py`); suite total Vantage 420/420 passando.

### Pendente (LGPD + UX)
- [x] **Hook em `users.py` no deactivate** → chama `DELETE /v1/users/:userId/data` no plugin best-effort (PRD §LGPD). Plugin ganha a rota que fecha sessões ativas, revoga credenciais e apaga messages do usuário.
- [x] **`GET /api/socc/export`** — JSON com sessions, credentials (masked), note sobre messages por sessão. Endpoint disponível para o usuário autenticado.
- [x] **`DELETE /api/socc/users/:id/data`** — wipeout admin-triggered (para retentar o hook quando falhar). Loggado em audit.
- [x] Audit log de `socc_install/uninstall/flag_changed` — Fase 4
  `ExtensionManager` registra install/uninstall via `action=f"{ext_id}_install"`
  / `f"{ext_id}_uninstall"` e settings patch via
  `f"{ext_id}_flag_changed"` com detalhe das chaves alteradas. Coberto por
  `test_uninstall_with_wrong_confirm_phrase_logs_failure` e
  `test_settings_patch_writes_flag_changed_audit`.

---

## Fase 3 — Frontend `/socc` e `/socc/providers` (v1.0 MVP, via Gemini)

**Critério de done do PRD:** "Lint+build limpos; 3 idiomas; screenshots em PR review."

### US-2 — Conversar com o copiloto
- [x] Rota `/socc` — layout duas colunas (sidebar de sessões + chat).
- [x] Enter envia, Shift+Enter quebra linha; textarea auto-grow.
- [x] SSE via `@microsoft/fetch-event-source` (PRD §Dependencies) — POST com reconexão.
- [x] Markdown via `marked` + `DOMPurify` (já presentes no Vantage).
- [x] Syntax highlight (`shiki` ou `highlight.js`, o que já estiver no bundle).
- [x] Botão "parar" durante streaming → `POST /api/socc/session/:id/abort`.
- [x] Heartbeat handling + reconexão com `Last-Event-ID` (plugin já emite `id:`).
- [x] Toast traduzido para `provider_rate_limited` com "tentar de novo".
- [x] **3 idiomas completos pt/en/es** para toda string nova.

### US-1 — Configurar provider pessoal
- [x] Form em `/socc/providers`: provider, rótulo, API key (type=password), base_url opcional, modelo default.
- [x] Save → chama `POST /api/socc/providers/:id/test`; confirma só se `ok: true`.
- [x] Lista de providers com `keyPreview` só (ex: `sk-...abcd`).
- [x] Revoke com confirm; mostra `lastTestResult` quando aplicável.
- [x] `ollama` bloqueado no form quando `SOCC_ALLOW_LOCAL_PROVIDERS=false`, exibe `local_provider_disabled`.

### Não-goals explícitos do PRD
- [x] (Non-goal) Sem `assistant-ui` ou `chatbot-kit` — tudo com design system do Vantage.
- [x] (Non-goal) Sem rename/pin/export de sessões no MVP (v1.1).

---

## Fase 3.1 — Autenticação Universal estilo OpenClaw (OAuth + CLI reuse + Auto-Discovery) — *escopo novo, fora do PRD original*

> **Origem:** plano do Gemini em
> `/home/nilsonpmjr/.gemini/antigravity/brain/c9823b7d-e1b3-4992-9d2c-ae70f9d1dbbe/implementation_plan.md.resolved`,
> entregue 2026-04-25 após Fase 3 concluída. Replica a UX "mágica" do
> OpenClaw / REPL original, eliminando o paste manual de API key. **Esta
> fase NÃO está concluída. Decisão do usuário em 2026-04-27: o alvo correto
> é autenticar serviços de IA via login/assinatura quando o provider suporta,
> no estilo OpenClaw; API key manual fica só como fallback avançado.

Referências usadas para alinhar o escopo:
- OpenClaw Authentication: `https://docs.openclaw.ai/gateway/authentication`
- OpenClaw OAuth: `https://docs.openclaw.ai/concepts/oauth`
- OpenClaw FAQ auth: `https://docs.openclaw.ai/help/faq`

**Critério de done proposto:** botão "Login with X" em cada provider
suportado; usuário não precisa ver/digitar API key quando existir fluxo de
login suportado; credencial resultante segue cifrada at-rest com
`SOCC_MASTER_KEY` (sem mudar §Security do PRD). O form manual de API key
permanece como fallback.

### Decisões já tomadas
- [x] **OpenAI/Codex:** NÃO usar GitHub Copilot proxy. O fluxo correto é
  OpenAI Codex / ChatGPT OAuth com PKCE (`auth.openai.com`), equivalente ao
  OpenClaw `openai-codex`. A credencial representa assinatura/login OpenAI,
  não uma API key `sk-*`.
- [x] **Anthropic:** NÃO modelar como OAuth genérico em
  `console.anthropic.com/oauth/authorize`. O approach OpenClaw relevante é
  Claude CLI reuse / `claude -p` / setup-token quando disponível, com API key
  como caminho mais previsível para servidor/prod. Para Vantage multiusuário,
  isso deve ser tratado explicitamente como `authMode=claude_cli` ou
  `authMode=setup_token`, não disfarçado de API key.
- [x] **Token sink:** credenciais OAuth/CLI devem viver em auth profiles
  cifrados e roteáveis, evitando múltiplos refresh-token owners brigando entre
  Codex CLI / Claude CLI / SOCC.
- [x] **Fatiamento:** implementar primeiro OpenAI Codex OAuth + Anthropic CLI/setup-token,
  depois Gemini CLI OAuth e Ollama discovery.

### Open Questions (bloqueantes antes de codar)
- [x] **Redirect URI pública/headless:** Vantage terá hostname estável para
  registrar callback OAuth em produção; para dev/headless, o plugin já aceita
  `OPENAI_CODEX_OAUTH_REDIRECT_URI=http://127.0.0.1:<port>/api/socc/oauth/openai-codex/callback`
  e fallback `POST /api/socc/oauth/openai-codex/callback` com redirect URL/code colado.
- [?] **Escopo Anthropic em produção:** permitir Claude CLI/setup-token só em
  instalação local single-tenant/admin, ou também por usuário web? API key deve
  continuar recomendada para long-lived server.
- [x] **Storage:** estender `socc_credentials` com `authMode`/profile encrypted
  blob preservando LGPD delete e cap por usuário.
- [?] **Modelo default e billing:** mapear modelos de assinatura (`openai-codex/gpt-5.4`,
  `anthropic/...`) sem prometer disponibilidade quando o plano do usuário não
  cobre o modelo/contexto.

### Backend — base comum de Auth Profiles
- [x] Modelar credential como `{provider, authMode, label, keyPreview, defaultModel, baseUrl?, accountId?}` mantendo compat com `api_key` — implementado em 2026-04-27 no plugin/Vantage/UI.
- [x] Persistir blobs OAuth/CLI cifrados com `SOCC_MASTER_KEY`: access token,
  refresh token, expires, accountId, provenance (`oauth`, `codex_cli`,
  `claude_cli`, `setup_token`, `api_key`) — base implementada; refresh ainda pendente.
- [x] Implementar refresh sob lock por profile para evitar corrida de token —
  `CredentialsStore.refreshAuthSecretWithLock()` usa lock atômico por
  credential em Mongo, recriptografa o auth profile atualizado e cobre lock
  vivo/expirado/no-op em `credentials.store.test.ts`.
- [x] `providerTester` deve testar por `authMode`: API key via headers atuais,
  OAuth via bearer access token/profile, CLI reuse via executor local seguro.
  Codex CLI import é validado sem expor token; API key segue probes atuais.
  Cobertura explícita em `providerTester.test.ts`.
- [x] Audit: `socc_auth_authorized`, `socc_auth_failed`, `socc_auth_refreshed`
  sem token/code/verifier em log — Vantage audita import local; plugin logger redige `code`, `code_verifier`, `state`, access/refresh tokens.

### Backend — OpenAI Codex OAuth (ChatGPT subscription)
- [x] **Fatia funcional inicial:** `POST /api/socc/providers/import-local-auth`
  importa `~/.codex/auth.json` do host do gateway como `provider=openai`,
  `authMode=codex_cli`, `baseUrl=https://chatgpt.com/backend-api/codex`,
  `defaultModel=gpt-5.4`; UI expõe botão "Login with OpenAI Codex" para
  reutilizar a autenticação local já existente.
- [x] `GET /api/socc/oauth/openai-codex/login` — gera `state` + PKCE verifier/challenge,
  persiste state em TTL 10min e redireciona para `https://auth.openai.com/oauth/authorize`
  quando `OPENAI_CODEX_OAUTH_CLIENT_ID` e `OPENAI_CODEX_OAUTH_REDIRECT_URI`
  estão configurados. O backend Vantage proxia o 302 em
  `/api/socc/oauth/openai-codex/login`.
- [x] `GET /api/socc/oauth/openai-codex/callback?code=&state=` — valida state
  com isolamento por usuário e consumo único. Enquanto a troca de token não
  estiver configurada, retorna `oauth_exchange_not_configured` após validar o
  state.
- [ ] Trocar code em endpoint/token contract estável, extrair `accountId`,
  persiste profile cifrado e cria credential `provider=openai`, `authMode=oauth`.
- [x] Fallback headless: `POST /api/socc/oauth/openai-codex/callback`
  permite colar `callbackUrl` ou `{code,state}` e reutiliza a validação
  de state/PKCE. A troca real segue pendente por contrato/token exchange.

### Backend — Anthropic Claude CLI / setup-token
- [x] Detectar Claude CLI login no host do gateway quando permitido pelo deployment
  (`claude` no PATH + auth store legível pelo usuário do processo).
- [x] Criar credential `provider=anthropic`, `authMode=claude_cli`, com profile
  que re-lê a fonte externa em vez de rotacionar refresh token próprio.
- [x] Suportar setup-token/paste-token como fallback Anthropic quando CLI reuse
  não estiver disponível. Implementado como modo avançado no fallback manual:
  `authMode=setup_token` é roteado como bearer no Worker.
- [x] Manter API key Anthropic como opção recomendada para produção/multiusuário
  — UI sinaliza API key como recomendada e setup-token como fallback quando Claude CLI reuse indisponível.

### Backend — Google OAuth (Gemini)
- [ ] Fase posterior: fluxo `google-gemini-cli`/plugin-style, não bloquear
  OpenAI/Anthropic. Validar se a SDK usada pelo engine aceita OAuth direto ou
  se precisa proxy/CLI.

### Backend — Ollama Auto-Discovery
- [x] `POST /api/socc/providers/discover-local` (admin only ou condicional a `SOCC_ALLOW_LOCAL_PROVIDERS=true`):
  - faz HEAD/GET em `http://localhost:11434/api/tags` (timeout 1s);
  - se 200, cria credential automaticamente (`provider=ollama`, `apiKey="ollama-local"`, `defaultModel` = primeiro modelo retornado);
  - se 404/timeout, retorna `{detected: false, hint: "Run: ollama serve"}`.
- [x] **Defesa em profundidade:** mesmo com auto-discovery o gate `socc_allow_local_providers` continua valendo — `discover-local` retorna 403 `local_provider_disabled` se a flag estiver `false`.

### Frontend — Reformulação do `SoccProvidersModal`
- [x] Layout "Connect provider": botões grandes — OpenAI Codex (login OpenAI),
  Anthropic Claude (Claude CLI/setup-token/API key), Google Gemini (fase posterior),
  Ollama (Detect Local).
- [ ] Cada botão dispara seu fluxo (popup OAuth ou POST discover-local). OpenAI
  Codex e Anthropic Claude CLI já disparam `import-local-auth`; Ollama já dispara
  `discover-local`; OAuth público e Gemini seguem pendentes.
- [ ] Footer "Add manually..." preserva o form atual como fallback avançado.
- [x] Estados visuais: loading, success e erro nos imports locais já reutilizam
  o feedback do modal.
- [x] i18n pt/en/es para labels novos de OpenAI Codex, Claude CLI e fallback
  manual.

### Hardening
- [ ] Audit log: `socc_auth_authorized`, `socc_auth_failed`, `socc_auth_refreshed` (com motivo, sem secrets).
- [x] Rate limit nos `/oauth/*/login` para evitar spam de redirect/setup (5/min/user).
- [x] Pino redaction estendida no plugin: cobrir `code`, `code_verifier`, `codeVerifier`, `state`, `access_token`.
- [x] Test: cross-user na collection `socc_oauth_state` (state gerado por A não pode ser consumido por B).

---

## Fase 4 — Plataforma de extensões (genérica)

### Backend (concluído — 2026-04-25)
- [x] `docker-socket-proxy` no `docker-compose.yml` principal com ACL exata do PRD §Extensions Platform (CONTAINERS=1, NETWORKS=1, VOLUMES=1, IMAGES=1, POST=1; tudo o resto = 0). Socket montado read-only; `profiles: [extensions]` para opt-in.
- [x] `backend/services/extensions/manifest.py` — schema pydantic estrito (extra=forbid em todos os modelos), validação de path-traversal em `compose_file`, regex de `id`, set de operations válidas, semver em `version`.
- [x] `backend/services/extensions/registry.py` — descobre `backend/extensions/<id>/manifest.yaml`, ignora pastas legadas (`plugins/`, `local_plugins/`, `premium_plugins/`), expõe `errors()` por diretório malformado.
- [x] `backend/services/extensions/docker_client.py` — wrapper async httpx pra `tcp://docker-socket-proxy:2375` + subprocess.exec do `docker compose` com `DOCKER_HOST` apontando pro proxy. Cobre ping/list/stop/remove/volume + compose up/down/start/stop/restart/config + log streaming.
- [x] `backend/services/extensions/manager.py` — orquestrador: `_try_acquire_lock` atômico via `update_one` com `$or`, geração de secrets (`random_bytes_base64` e `random_bytes_hex`, length em bytes), preflight (proxy ping + `compose config` dry-run), state guard por status (`_ACTIONABLE`), reconcile no boot via healthcheck.
- [x] `backend/routers/extensions.py` montado em `/api/extensions` (e alias `/api/v1/extensions`):
  - [x] `GET /` (catálogo público a usuários autenticados)
  - [x] `GET /:id` + `GET /:id/status` (healthcheck on demand)
  - [x] `POST /:id/install` (admin, 202 + BackgroundTask)
  - [x] `POST /:id/uninstall` (admin, valida `confirm_phrase`, BackgroundTask)
  - [x] `POST /:id/start|stop|restart` (admin, síncrono)
  - [x] `PATCH /:id/settings` (admin, valida tipos contra schema)
  - [x] `POST /:id/secrets/:name/rotate` (admin)
  - [x] `GET /:id/logs` (SSE tail via docker-socket-proxy)
- [x] Lock Mongo por `ext_id` — segunda tentativa concorrente recebe 409 (testado).
- [x] Audit log com eventos do PRD: `<ext_id>_install/uninstall/start/stop/restart/flag_changed/secret_rotated`.
- [x] Pré-flight `compose config` antes de qualquer `up` (mitigação do PRD §Risks: manifest injection).
- [x] **Teste de generalidade** — `backend/extensions/fake/{manifest,compose}` aparece no catálogo ao lado do socc sem mudança de código (cobre PRD §Phase 4 done criteria).
- [x] `backend/extensions/socc/compose.yml` — profile-less (PRD: "runs via manager"). Caminho dev manual ainda funciona.
- [x] 17 testes pytest (parser, registry, manager + lock + secrets + settings, router admin gate). Suite Vantage: 436/436.

**Critério de done do PRD:** "Admin instala/inicia/para/desinstala o SOC Copilot
**inteiramente pela UI** (zero CLI); `tecnativa/docker-socket-proxy` com ACL mínima;
framework aceita nova extensão (teste: manifest fake + compose trivial e ver card renderizar);
uninstall destrói volume por default; audit log de todas as ops; socket nunca montado no backend."

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

### Frontend (entregue 2026-04-25 pelo Gemini — com desvios documentados)

- **Briefing:** [`gemini-prompt-fase4-frontend.md`](gemini-prompt-fase4-frontend.md)
- **Task list:** [`gemini-task-fase4-frontend.md`](gemini-task-fase4-frontend.md)
- **Desvio 1 (consciente):** integrou em `web/src/pages/ExtensionsCatalog.tsx` no menu Settings em vez de criar rota raiz `/extensions`. Justificativa do Gemini: PRD §Architecture diz literalmente "Página `/extensions` (expansão do `ExtensionsCatalog` existente)". O critério de done do PRD §Phase 4 ("framework aceita nova extensão... ver card renderizar") está atingido — só não está em rota separada na sidebar raiz.
- **Desvio 2 (consequência do 1):** a tabela unificada lista `payload.items` (plugins legados Python in-process do `/api/admin/extensions`) **mais** `orchItems` (manifest+container do `/api/extensions/*`) na mesma linha. Funciona, mas mistura dois modelos de extensão com semânticas diferentes. Débito de UX.
- [x] `web/src/pages/extensions/{Extensions.tsx, ExtensionCard.tsx, lib/api.ts, lib/poll.ts, modals/{Uninstall,Logs,Settings,Secrets}Modal.tsx}` criados.
- [x] `OrchestratedExtensions` embutível em `ExtensionsCatalog.tsx` (rows linha 368: `[...payload?.items, ...orchItems]`).
- [x] Pre-flight: Install desabilitado quando proxy down (tooltip).
- [x] i18n pt/en/es sob `extensions.*`.
- [x] `npm run lint` + `npm run build` limpos.
- [x] Smoke: `socc` + `fake` aparecem na tabela unificada.

### Débito do desvio (revisitar antes de v1.0)
- [x] **Ações orchestrated não aparecem em plugins legados** — confirmado: `item._manifest` discrimina entre `buildOrchActions` e `buildExtensionActions`. Logs/Settings/Secrets/Rotate só existem no path orchestrated.
- [x] **Não fazer:** separação visual com header entre grupos (legados vs orchestrated). Decisão do usuário em 2026-04-27: manter tabela unificada sem header/divisor extra.
- [x] **Não fazer:** rota `/extensions` raiz/sidebar como atalho. Decisão do usuário em 2026-04-27: não adicionar atalho de extensão na sidebar.

Wire contract já estabilizado pelo backend:

- `GET /api/extensions` → `{extensions: [{id, name, description, version, status, installed_at, last_health_ts, last_error, settings, operations, requires, settings_schema, uninstall, locked_by}]}`
- `POST /api/extensions/:id/install` → 202 `{task_id, status}`
- `POST /api/extensions/:id/uninstall` body `{confirm_phrase, destroy_volumes?}` → 202
- `POST /api/extensions/:id/start|stop|restart` → 200 com state atualizado
- `PATCH /api/extensions/:id/settings` body `{settings: {KEY: value}}` → 200 `{settings: {...}}`
- `POST /api/extensions/:id/secrets/:name/rotate` → 200 `{rotated}`
- `GET /api/extensions/:id/logs` → SSE event=log

- [ ] Página genérica renderizando cards a partir do catálogo (**sem código específico de socc**).
- [ ] Estados live: `not_installed`, `installing`, `installed_healthy`, `installed_unhealthy`, `stopped`, `installing_failed`, `uninstalling`.
- [ ] Ações contextuais conforme estado: Install / Uninstall / Start / Stop / Restart / View Logs / Settings / Rotate Secret.
- [ ] Modal de logs (SSE tail via `@microsoft/fetch-event-source`, mesma lib da Fase 3).
- [ ] Modal destrutivo de uninstall: usuário digita literal `uninstall <id>` (lê do `manifest.uninstall.confirm_phrase`).
- [ ] Opção "preservar volume" visível mas **desmarcada** por default.
- [ ] Pré-flight falho (`requires.docker_socket_proxy=true` mas `/health` falha) → botão desabilitado com tooltip; backend já retorna `last_error`.
- [ ] i18n pt/en/es para todas as strings novas (PRD §Phase 3 critério herdado).

### Teste de generalidade
- [x] `backend/extensions/fake/{manifest.yaml,compose.yml}` criado (nginx:alpine como probe trivial).
- [x] Backend confirma o card vai renderizar: `test_generality_probe_renders_alongside_socc` valida que `GET /api/extensions` devolve `socc` + `fake` lado a lado, com settings_schema e confirm_phrase corretos.
- [ ] Smoke ponta-a-ponta na UI (Install → Start → Logs → Uninstall sem mencionar "socc" no caminho) — vai junto com a entrega do frontend.

---

## Fase 5 — v1.1: Read-only tools + histórico persistente

**Critério de done do PRD:** "Tool calls aparecem no SSE; precision@1 ≥ 85% em 50 perguntas golden."

### Iteração A — Plugin tool gateway (concluído 2026-04-25)
- [x] **Rename `tool.call.end` → `tool.call.done`** alinhando com PRD §Security wire contract.
- [x] **Protocolo Worker↔server** definido em `sessionWorker.ts`: `WorkerToolRequestMessage` (worker→server) + `WorkerToolResponseMessage` (server→worker), correlacionados por `requestId`.
- [x] **`canUseTool` substituído** — não mais deny-all. Allowlist via `init.enabledTools` + delegação para o server via `executeTool()` helper. Timeout interno 60s pra evitar engine hanging.
- [x] **`WorkerPool.forwardToolResponse(sessionId, msg)`** + novo `TurnEvent` kind `'tool_request'` que o pool propaga.
- [x] **`SessionManager.forwardToolResponse(userId, sessionId, msg)`** + `enabledTools` no `CreateSessionRequest` → `SessionInit`. Cross-tenant: silently no-op para ownership errado.
- [x] **`buildApp` aceita `executeTool: ToolExecutor`** injetável (DI: prod=HTTP back ao Vantage; tests=stub). Default = deny com `internal_error` quando não injetado, preserva backward-compat.
- [x] **SSE handler dispatcha `tool_request`** out-of-band no stream loop, captura erros e responde com `internal_error` se executor lançar.
- [x] 5 testes novos: `enabledTools` propagado pro init, `forwardToolResponse` ownership, gateway round-trip happy path, executor throws → internal_error, sem executor injetado → deny silencioso. Total plugin: **70/70 passando**.

### Iteração B — Vantage tools router (concluído 2026-04-26)
- [x] `backend/routers/socc.py` adiciona `POST /api/socc/tools/:name` em forma genérica.
- [x] Verificação JWT do plugin: `iss=socc-plugin, aud=vantage, scope=socc-tools, sub=user_id`, leeway=5s. Reuso do `SOCC_INTERNAL_SECRET` (decisão registrada inline: secret novo só dobraria a cerimônia de rotação sem reduzir blast radius — scope diferente já isola o domínio).
- [x] Defesa em profundidade: token `sub` MUST match `body.userId` (forgery → 403 `sub_mismatch`); `sid` opcional valida contra `body.sessionId` quando ambos presentes.
- [x] Registry `_TOOLS` despacha por nome:
  - [x] `query_feed(severity?, source?, limit)` — implementação completa (lê `db.threat_items` direto, sem round-trip via `/api/feed`); coerção segura de `limit` (caso o modelo passe string), serialização de `_id` ObjectId.
  - [x] `analyze_ioc`, `search_watchlist`, `search_incidents`, `get_system_health` — implementados na Iteração C; não retornam mais 501.
- [x] Rate limit `60/minute/user` em `/tools/:name` via `settings.rate_limit_socc_tools` — separado do `rate_limit_socc_message` para não competir.
- [x] Audit log `socc_tool_invoked` com `target=<tool_name>`, `detail=duration_ms=<n>`. **Args nunca aparecem no audit** (testado: `'high' not in audit.detail`).
- [x] 9 testes novos em `tests/test_socc_tools_router.py`: missing bearer, scope errado, issuer errado, expired além da leeway, sub_mismatch, unknown_tool 404, query_feed happy path com filtragem, not_implemented retorna 501, coerção de `limit` inválido. **Suite Vantage: 446/446 passando.**

### Iteração C — Plugin executor wiring + 4 tools reais (concluído 2026-04-26)

**Plugin (`socc-plugin/`):**
- [x] `src/server/toolsExecutor.ts` — `createToolsExecutor(opts)` retorna `ToolExecutor`. Minta JWT `iss=socc-plugin, aud=vantage, scope=socc-tools, sub=userId, sid=sessionId, TTL=60s`. Mapeia 404→`unknown_tool`, 501→`not_implemented`, timeout 15s→`provider_unavailable`, throw→`internal_error`. Propaga `{ok,data,errorCode,errorMessage}` verbatim.
- [x] `envSchema` ganhou `VANTAGE_API_URL?: z.string().url()` — opcional; sem ela o executor não é wired e tools fallback para deny silencioso.
- [x] `bootstrap()` cria e injeta `executeTool` quando `VANTAGE_API_URL` presente.
- [x] 6 testes em `toolsExecutor.test.ts`: JWT claims, URL/method/body corretos, 404→unknown_tool, 501→not_implemented, network error, propagação de data.
- [x] `test:unit` script atualizado para incluir `toolsExecutor.test.ts`. **Plugin: 76/76 passando** (69 unit + 7 integration).

**Vantage (`backend/routers/socc.py`):**
- [x] `_tool_analyze_ioc` — busca `db.scans` por `target`, retorna `{cached:true,...}` ou `{cached:false}`. Valida `target` obrigatório → 400. Coerce `analyzed_at` datetime.
- [x] `_tool_search_watchlist` — regex case-insensitive em `value` e `indicator`, limit=50. Valida `query` obrigatório → 400.
- [x] `_tool_search_incidents` — filtra `db.scans` por `cutoff` datetime + severity, sort desc, limit=20. `date_range` aceita `1d|7d|30d`.
- [x] `_tool_get_system_health` — snapshot de `db.system_status` + counts (threat_items, scans, watchlist).
- [x] 4 testes novos: todas as tools retornam 2xx (não 501), analyze_ioc cache-miss, analyze_ioc target missing→400, search_watchlist query missing→400, search_incidents severity filter. **Vantage: 450/450 passando.**
- [x] `FakeCollection._match_doc` + `count_documents` com `try/except TypeError` na comparação `$gte/$gt/$lte/$lt` — tolera docs heterogêneos (str vs datetime) sem crash.

### Iteração D — Histórico + metadata + eval (concluído 2026-04-26)

**Plugin — backend:**
- [x] `src/server/messageStore.ts` — `MessageStore.open(db, ttlDays)`. Coleção `socc_messages` com índice TTL em `createdAt` (30d default, PRD §LGPD), índice por sessão para paginação, índice por userId para delete sweep LGPD.
- [x] `SessionSummary` + `CreateSessionRequest` ganham `sessionName?`, `pinned`, `messageCount`.
- [x] `SessionManager` aceita `messages?: MessageStore` (opcional — sem ele, history desabilitado e chat continua funcionando).
- [x] `SessionManager.patchSession()`, `pinSession()`, `unpinSession()` — rename/pin/unpin in-memory (persistência de sessão em Mongo é Iteração D pós-MVP).
- [x] `SessionManager.recordTurn()` — persiste turn em `socc_messages`, incrementa `messageCount`. Erros são swallowed (não quebram o stream).
- [x] `SessionManager.listHistory()`, `exportHistory()`, `deleteUserHistory()` — history paginado + LGPD wipeout.
- [x] **Pinned sessions sobrevivem ao TTL sweep** — `sweepIdle()` checa `rec.pinned` antes de reap.
- [x] `src/server/index.ts`:
  - [x] `VANTAGE_API_URL` e `MESSAGE_TTL_DAYS` no envSchema.
  - [x] `MessageStore.open()` no `bootstrap()` quando `MESSAGE_TTL_DAYS > 0`.
  - [x] `PATCH /v1/session/:id` (rename), `POST /v1/session/:id/pin`, `DELETE /v1/session/:id/pin`.
  - [x] `GET /v1/session/:id/history?limit=&before=` (paginado, oldest-first).
  - [x] `GET /v1/session/:id/export` (LGPD portabilidade — JSON completo).
  - [x] `streamTurnResponse` persiste user turn (pré-stream) e assistant turn (pós `kind:'end'`), acumula content.delta na closure.
- [x] `.env.example` atualizado com `VANTAGE_API_URL` e `MESSAGE_TTL_DAYS`.
- [x] 9 testes novos em `index.test.ts`: rename, pin + survives sweep, unpin, history empty sem store, history com store, export, cross-tenant 200-empty ou 404, messageCount incrementa, session criada com pinned=false/messageCount=0.
- [x] 6 testes em `messageStore.test.ts`: save, list cross-tenant, limit, export order, deleteByUser, deleteBySession.
- [x] **Plugin: 91/91 passando** (84 unit + 7 integration). Typecheck limpo.

**Eval:**
- [x] `docs/eval-v1.1-golden.md` — 50 perguntas golden (10 por tool), método de pontuação, script de execução, critério: precision@1 ≥ 85% (43/50). Execução humana pós-deploy.

**Pendente desta iteração (UI):**
- [x] Rename / pin / export de sessão na **UI** — implementado em 2026-04-27 no Vantage:
  - `backend/routers/socc.py` proxyando `PATCH /api/socc/session/:id`, `POST|DELETE /api/socc/session/:id/pin`, `GET /api/socc/session/:id/history` e `GET /api/socc/session/:id/export`, com JWT `sid` e audit metadata.
  - `web/src/pages/socc/SoccChat.tsx` normaliza `sessionId`, carrega histórico ao selecionar sessão, permite renomear, fixar/desafixar e exportar JSON.
  - i18n pt/en/es em `web/src/lib/i18n.ts`; testes backend adicionados em `backend/tests/test_socc_router.py`.
- [ ] Execução real do eval golden (requer provider API key válida e dados no DB).

---

## Fase 6 — v1.2: Write tools + skills + RBAC fino

- [x] Write tools: `create_handoff`, `add_to_watchlist`, `start_batch_analysis` — implementadas em 2026-04-27 no dispatcher `POST /api/socc/tools/:name` do Vantage:
  - `add_to_watchlist` valida IOC via `validate_target`, respeita quota/duplicidade por usuário e persiste em `watchlist`.
  - `create_handoff` cria handoff + incidentes persistentes usando o schema/serialização de `routers.shift_handoff`.
  - `start_batch_analysis` valida targets via `_parse_targets`, cria `batch_jobs`, enfileira `_process_batch` e retorna `{job_id,status,total}`.
- [x] Skills portadas de `.socc/skills/`: `payload-triage`, `phishing-analysis`, `malware-behavior`, `suspicious-url`, `soc-generalist` — implementado em 2026-04-27 no plugin:
  - `SessionManager.createSession()` injeta no `systemPrompt` um bloco SOC carregado do pacote `@vantagesec/socc`, incluindo as cinco skills e referências compartilhadas (`output-contract`, `evidence-rules`, `ioc-extraction`, `mitre-guidance`).
  - Mantém qualquer `systemPrompt` customizado do caller antes do bloco SOC e evita duplicação via marcador interno.
  - Testes novos cobrem carregamento das skills/referências e propagação ao Worker.
- [x] RBAC fino: tool só aparece no registry da sessão se `user.role` tem permissão. `GET /api/socc/tools` retorna registry filtrado; `POST /api/socc/session` encaminha `enabledTools` filtrado ao plugin; dispatcher também bloqueia tool proibida como defesa em profundidade. Teste negativo: tech não vê/chama `get_system_health`; admin vê/chama.
- [ ] Cotas por org (não por usuário) + dashboards de custo por user/org via `cost-tracker.ts` do socc.
  - Bloqueio atual: Vantage ainda não tem modelo/campo de organização ou tenancy formal em `users`; implementar agora exigiria inventar `org_id`/migração e semântica de cobrança. Deve virar fase própria junto de Multi-org/Fase 7.
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
- [x] Installer rejeita imagens mutáveis no ExtensionManager: `docker compose config`
  é validado antes do `compose up`; todo `services.*.image` precisa conter
  `@sha256:<64 hex>` e `:latest` falha explicitamente. Coberto por
  `test_validate_compose_images_pinned_*`; fake extension e `mongo:7` do
  overlay SOC foram pinados por digest.
- [x] Pin do workload SOC publicado:
  `ghcr.io/nilsonpmjr/socc-plugin@sha256:e940ec31f9189787fbe9b587098d2c3584419c6d8a189ea11ba559083b1b3fc6`
  no overlay Vantage. `socc-plugin:local` fica apenas para debug manual e é
  bloqueado pelo installer em instalação gerenciada.
- [x] Procedimento manual documentado de rotação do `SOCC_MASTER_KEY` (re-encrypt loop + restart) — PRD §Security. Ver `docs/master-key-rotation.md` + `bun run rotate:master-key` para dry-run/write pass offline.
- [x] Trivy scan no CI; CVE high/critical = build quebrado —
  `.github/workflows/ci.yml` roda `aquasecurity/trivy-action@v0.36.0`
  contra `socc-plugin:ci` com `exit-code: '1'`, `severity: HIGH,CRITICAL`
  e `vuln-type: os,library`.
- [x] Lint rule bloqueando imports de `components/`, `screens/`, `ink/` em `src/server/` e entrypoints headless do socc (PRD §Technical Risks: "Headless server importa React/Ink acidentalmente e infla imagem") —
  `scripts/headless-import-guard.sh` roda via `bun run guard:headless-imports`
  no CI e falha se `src/server`, `src/sessionWorker.ts` ou
  `../socc/src/entrypoints/engine.tsx` importarem React/Ink/UI.
- [x] Harness de load test do PRD §Evaluation Strategy — `bun run load:test`
  cria 50 sessões sintéticas, envia mensagens a 10 msg/s, mede TTFT P50/P95
  e falha em erro retriable ou P95 > 3s. Runbook em `docs/load-test.md`.
- [ ] Executar load test oficial: 50 sessões concorrentes, 10 msg/s, P95 TTFT < 3s, zero vazamento de estado (requer provider válido e ambiente dedicado).
- [x] Harness de golden conversations do PRD §Evaluation Strategy —
  `bun run golden:conversations` roda até 20 prompts SOC por provider
  (Anthropic/OpenAI/Gemini), valida SSE com `content.*`, `message.end`,
  marcador `SOCC-GOLDEN-*` e ausência de `error.retriable=true`. Runbook em
  `docs/golden-conversations.md`.
- [ ] Executar golden conversations oficiais: 20 por provider
  (Anthropic/OpenAI/Gemini), 60/60 com `message.end`, marcador presente e
  zero erro retriable (requer provider API key válida e ambiente dedicado).
- [x] Provider failover implementado para `provider_unauthorized` mid-stream:
  plugin classifica erro de Worker contendo 401/unauthorized como
  `error.code=provider_unauthorized` (não `internal_error`) e mantém
  `message.end`; UI do Vantage traduz `provider_unauthorized`,
  `provider_unavailable` e rate limit, preserva o prompt e exibe botão
  "Tentar de novo". Também corrige parsing de `content.delta`/`content.done`
  no chat. Verificação: `index.test.ts`, `npm run lint`, `npm run build`.
- [ ] Smoke visual/browser do provider failover com SSE mockado ou provider real
  expirado, confirmando toast + clique no retry ponta-a-ponta.

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
