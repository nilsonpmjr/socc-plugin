# Gemini Prompt — Fase 4 Frontend (`/extensions` page)

> Cole este arquivo INTEIRO no Gemini como mensagem inicial da task.
> Auto-contido — não precisa de pré-leitura adicional.

---

## Contexto

O Vantage (Threat-Intelligence-Tool) acabou de ganhar uma plataforma
genérica de extensões no backend. Você já entregou a Fase 3 (chat SOC
Copilot em `/socc`); agora vamos fazer a Fase 4: a página `/extensions`
que lista, instala, gerencia e desinstala QUALQUER extensão declarada
em `backend/extensions/<id>/`.

**Princípio central:** o frontend NÃO sabe nada sobre `socc` em
particular. Tudo que renderiza vem do catálogo do backend. A mesma UI
trata o `socc` (chat real) e o `fake` (probe trivial de generalidade)
sem nenhum branch específico.

PRD §Extensions Platform manda. Repo:
`/home/nilsonpmjr/.gemini/antigravity/scratch/Threat-Intelligence-Tool`.

---

## Wire contract (já estabilizado pelo backend — não mudar)

Todas as rotas montadas em `/api/extensions/*` (e alias `/api/v1/extensions/*`).
Auth: cookies HttpOnly do Vantage (já funciona com o existente
`fetch`/`AuthProvider`). Mutações exigem role `admin`.

### `GET /api/extensions`

```json
{
  "extensions": [
    {
      "id": "socc",
      "name": "SOC Copilot",
      "description": "Conversational LLM assistant for threat triage.",
      "version": "0.1.0",
      "status": "not_installed | installing | installed_healthy | installed_unhealthy | stopped | installing_failed | uninstalling",
      "installed_at": "2026-04-25T...Z" | null,
      "last_health_ts": "2026-04-25T...Z" | null,
      "last_error": "string" | null,
      "settings": { "SOCC_ALLOW_LOCAL_PROVIDERS": false },
      "operations": ["install", "start", "stop", "restart", "logs", "uninstall"],
      "requires": { "docker_socket_proxy": true, "disk_space_mb": 512, "ports": [] },
      "settings_schema": [
        { "key": "SOCC_ALLOW_LOCAL_PROVIDERS", "type": "boolean", "default": false, "label": "Permitir provedores locais (Ollama)" }
      ],
      "uninstall": { "destroy_volumes_by_default": true, "confirm_phrase": "uninstall socc" },
      "locked_by": null | { "action": "install", "user": "admin", "started_at": "..." }
    }
  ]
}
```

### `GET /api/extensions/:id`
Mesma shape de um item do array acima.

### `GET /api/extensions/:id/status`
Roda healthcheck na hora e retorna o item atualizado. Use para "Refresh"
manual e polling enquanto `status === "installing" | "uninstalling"`.

### `POST /api/extensions/:id/install` (admin)
Sem body. Retorna `202 { task_id, status: "accepted" }`. **Não bloqueia** —
faça polling em `/status` até o status sair de `installing`.

### `POST /api/extensions/:id/uninstall` (admin)
Body:
```json
{ "confirm_phrase": "uninstall socc", "destroy_volumes": true }
```
- `confirm_phrase` precisa ser exatamente `manifest.uninstall.confirm_phrase`
  (vem do `GET /api/extensions/:id`). Errado → backend loga falha, status
  permanece, frontend mostra erro.
- `destroy_volumes` — opcional. Se omitido, usa
  `manifest.uninstall.destroy_volumes_by_default`.

Retorna `202 { task_id, status: "accepted" }`. Polling em `/status`.

### `POST /api/extensions/:id/start | stop | restart` (admin)
Sem body. Síncrono — retorna o item atualizado em 200.

### `PATCH /api/extensions/:id/settings` (admin)
Body:
```json
{ "settings": { "SOCC_ALLOW_LOCAL_PROVIDERS": true } }
```
Cada chave precisa estar em `settings_schema` e ter o tipo declarado.
Backend valida — chave/tipo errado retorna 400 com `{error:"bad_state",
message:"..."}`.
Retorna `200 { settings: { applied keys } }`.

### `POST /api/extensions/:id/secrets/:name/rotate` (admin)
Sem body. `:name` precisa estar em `manifest.secrets[]`.
Retorna `200 { rotated: "<name>" }`.

### `GET /api/extensions/:id/logs` (admin)
SSE com `Content-Type: text/event-stream`. Frames:
```
event: log
data: <bytes raw com \n escapado para \\n>

event: error
data: { "error": "logs_failed", "message": "..." }
```
Use `@microsoft/fetch-event-source` (já no bundle desde a Fase 3) para
abrir e cancelar o stream.

### Status codes a tratar

| Código | Quando | UI |
|--------|--------|----|
| 401 | sessão expirou | redireciona para login |
| 403 | usuário não-admin tentou ação sensível | toast "ação restrita ao admin" |
| 404 | extensão não existe | toast + remove do catálogo |
| 409 | `{error:"locked", message:"..."}` — outra ação concorrente em andamento | toast com `message` (mostra `locked_by.user` + `locked_by.action`) |
| 400 | `{error:"bad_state", message:"..."}` — ação não permitida no status atual ou confirm_phrase errado | toast com `message` |
| 503 | `{error:"socc_unavailable", ...}` (eco do socc) ou `{error:"docker proxy unreachable"}` | banner persistente "Plataforma offline" |

---

## Tarefas (checklist literal — copie para o `task.md`)

```
- [ ] Criar página `web/src/pages/extensions/Extensions.tsx` (route `/extensions`).
- [ ] Card por extensão com: ícone (use Lucide; pode ser Package por default), nome, descrição, version chip, status badge colorido, last_health_ts.
- [ ] Estados de status com cor + ícone:
      not_installed (cinza), installing (amber+spin),
      installed_healthy (green check), installed_unhealthy (amber),
      stopped (gray pause), installing_failed (red), uninstalling (amber+spin).
- [ ] Botões contextuais por status:
      not_installed/installing_failed → Install
      installed_healthy → Stop, Restart, Logs, Settings, Secrets, Uninstall
      installed_unhealthy → Restart, Logs, Settings, Uninstall
      stopped → Start, Logs, Settings, Uninstall
      installing/uninstalling → todos disabled, mostrar spinner
- [ ] Pré-flight: se `requires.docker_socket_proxy=true` e `last_error`
      contém "docker proxy unreachable" ou "docker-socket-proxy unreachable",
      desabilitar Install com tooltip explicativo. Não falhar silenciosamente.
- [ ] Modal de Logs: SSE via `@microsoft/fetch-event-source`,
      auto-scroll do tail, botão Pause/Resume, copy-all, close cancela o stream.
- [ ] Modal de Uninstall (destrutivo):
      input texto que precisa MATCH exato com `manifest.uninstall.confirm_phrase`
      (mostre o phrase como hint placeholder mas exija digitação manual);
      checkbox "Preservar volume" — VISÍVEL e DESMARCADO por default;
      botão Uninstall fica disabled até match;
      após Uninstall: 202 → modal mostra spinner e polla `/status` até sair de `uninstalling`.
- [ ] Modal de Settings: renderiza dinamicamente a partir de `settings_schema`:
      type=boolean → toggle; type=string → input text; type=integer → input number.
      Save dispara PATCH. Toast verde em sucesso, toast vermelho com `message` em erro.
- [ ] Modal de Secrets (admin only): lista `manifest.secrets[].name` com
      botão "Rotate". Confirm dialog antes. Backend nunca devolve o valor;
      a UI só mostra que o secret existe + timestamp da última rotação
      (campo `secrets_present` no state — opcional mostrar; se ausente, só lista nomes).
- [ ] Polling de status: enquanto algum item está em `installing`/`uninstalling`,
      polla `GET /api/extensions/:id/status` a cada 2s até sair desse estado
      (ou 60 polls = 2min timeout com erro).
- [ ] Adicionar item "Extensions" na sidebar (`web/src/components/Layout.tsx`)
      com ícone `Boxes` ou `Package` do Lucide. Posição: depois de SOC Copilot.
- [ ] Adicionar route lazy em `web/src/App.tsx` (mesmo padrão do `SoccChat`).
      Esconder a entrada da sidebar para users não-admin? NÃO — a página é
      visualizável por qualquer authenticated user (read-only catálogo);
      só os botões mutáveis ficam ocultos para non-admin.
- [ ] i18n pt/en/es no `web/src/lib/i18n.ts` para todas as strings novas
      (chaves sob `extensions.*`).
- [ ] `npm run lint` e `npm run build` limpos antes de marcar entregue.
```

---

## Padrões da Fase 3 que valem reusar

- `@microsoft/fetch-event-source` para SSE (já no bundle).
- `marked` + `DOMPurify` para qualquer markdown (não esperado aqui mas
  está disponível).
- Estado local em `useState`/`useEffect`; sem stores globais novos
  (nota da Fase 3: "preserving the localized MVP architecture").
- Lucide para ícones.
- Tailwind tokens já presentes no design system Vantage.
- Lazy load no App.tsx no mesmo formato:
  `const Extensions = lazy(() => import("./pages/extensions/Extensions"));`

## Observações de design

1. **Layout sugerido:** grid responsivo (1 coluna mobile, 2 tablet, 3
   desktop) de cards. Cada card: header (ícone + nome + version chip),
   descrição (2 linhas truncadas), badge de status, footer com botões.
2. **Modal de uninstall** é a parte mais sensível. Use cor vermelha,
   ícone de alerta, e copy explicando que `destroy_volumes=true` apaga
   dados do extension (SOC Copilot perde credenciais e sessões salvas).
3. **Logs** podem chegar em rajada. Buffer + virtualização não é
   necessária para o MVP — só limite o tail visível a ~5000 linhas
   (drop do início) para não estourar memória.
4. **Não invente endpoints**. O wire contract está completo acima — se
   precisar de algo que não está, pare e pergunte.
5. **Empty state**: se `GET /api/extensions` retornar `{extensions:[]}`,
   mostre "Nenhuma extensão disponível. Crie um manifest em
   `backend/extensions/<id>/`."

## Critério de done (PRD §Phase 4)

> "Admin instala/inicia/para/desinstala o SOC Copilot **inteiramente
> pela UI** (zero CLI); framework aceita nova extensão (teste:
> adicionar manifest fake + compose trivial e ver card renderizar);
> uninstall destrói volume por default; audit log de todas as ops;
> socket nunca montado no backend."

Os dois últimos itens já estão garantidos pelo backend. Você precisa
entregar:

1. **Admin completa o ciclo install→start→stop→restart→logs→uninstall**
   100% pela UI.
2. **`socc` e `fake` aparecem lado a lado** no catálogo. Probe visual:
   abra http://localhost/extensions e tire screenshot dos dois cards.
3. **Lint+build limpos**, 3 idiomas completos.

## Arquivos esperados ao final

```
web/src/
├── pages/extensions/
│   ├── Extensions.tsx                    # rota /extensions
│   ├── ExtensionCard.tsx                 # 1 card de extensão
│   ├── modals/
│   │   ├── UninstallModal.tsx
│   │   ├── LogsModal.tsx
│   │   ├── SettingsModal.tsx
│   │   └── SecretsModal.tsx
│   └── lib/
│       ├── api.ts                        # wrappers tipados das rotas
│       └── poll.ts                       # helper de polling de status
├── App.tsx                               # + route lazy
├── components/Layout.tsx                 # + item sidebar
└── lib/i18n.ts                           # + chaves extensions.*
```

Sem arquivos novos no backend — está completo.

---

## Open Questions (responder em vez de assumir)

1. **Cor do tema dos botões de Settings vs Uninstall** — usar o vermelho
   `destructive` do design system (qual é a chave Tailwind do Vantage?).
2. **Audit log da rotação de secret** mostra na UI ou só backend? Resposta
   default: só backend (audit_log table).
3. **Exibição do `locked_by`**: mostrar só "ação em andamento por <user>"
   ou também o tempo decorrido? Default: só ação + user.

> Não bloqueie por essas — pegue o default e siga.
