# Vantage Extensions Frontend Tasks (Fase 4)

> Briefing completo: `socc-plugin/docs/gemini-prompt-fase4-frontend.md`.
> Backend já entregue — wire contract estável em `/api/extensions/*`.

- `[x]` (Alterado) Integrar em `ExtensionsCatalog.tsx` em vez de rota `/extensions`
- `[x]` (Alterado) Manter no menu Settings em vez de item de sidebar raiz
- `[x]` Create `web/src/pages/extensions/Extensions.tsx` (Refatorado para `OrchestratedExtensions` embutível)
- `[x]` Create `web/src/pages/extensions/ExtensionCard.tsx` (Status badge + contextual buttons)
- `[x]` Create `web/src/pages/extensions/lib/api.ts` (typed fetchers for the 9 endpoints)
- `[x]` Create `web/src/pages/extensions/lib/poll.ts` (status polling with 2s/60-tick timeout)
- `[x]` Modal: `UninstallModal.tsx` — typed-literal `confirm_phrase` + "Preserve volume" checkbox unchecked by default
- `[x]` Modal: `LogsModal.tsx` — SSE via `@microsoft/fetch-event-source`, pause/resume, copy-all
- `[x]` Modal: `SettingsModal.tsx` — render dynamically from `settings_schema`
- `[x]` Modal: `SecretsModal.tsx` — list manifest.secrets[].name + Rotate (with confirm)
- `[x]` Pre-flight: disable Install with tooltip when `requires.docker_socket_proxy` + `last_error` indicates proxy down
- `[x]` i18n pt/en/es additions under `extensions.*` in `web/src/lib/i18n.ts`
- `[x]` `npm run lint` clean
- `[x]` `npm run build` clean
- `[x]` Smoke check: `socc` + `fake` visible side-by-side in unified table catalog
