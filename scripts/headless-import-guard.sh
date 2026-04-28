#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

targets=()
for path in src/server src/sessionWorker.ts; do
  if [[ -e "$path" ]]; then
    targets+=("$path")
  fi
done

# In CI the sibling socc checkout sits next to socc-plugin so package.json's
# file:../socc dependency resolves. Guard only the public headless engine
# entrypoint there; the other socc entrypoints intentionally boot CLI/TUI UI.
if [[ -f ../socc/src/entrypoints/engine.tsx ]]; then
  targets+=("../socc/src/entrypoints/engine.tsx")
fi

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "headless import guard: no targets found" >&2
  exit 1
fi

forbidden_import_pattern="(^[[:space:]]*(import|export)[^'\"]*['\"]|import[[:space:]]*\\([[:space:]]*['\"])(react|react-compiler-runtime|ink|([^'\"]*/)?(components|screens|ink)/[^'\"]*|([^'\"]*/)?ink\\.(js|ts|tsx|mjs))['\"]"

if rg -n \
  --glob '*.ts' \
  --glob '*.tsx' \
  --glob '*.js' \
  --glob '*.mjs' \
  "$forbidden_import_pattern" \
  "${targets[@]}"; then
  cat >&2 <<'MSG'

Forbidden UI import in a headless surface.

src/server, src/sessionWorker.ts, and socc/src/entrypoints/engine.tsx must
not import React, Ink, components/, screens/, or ink/ modules. Pulling those
into the headless bundle inflates the container and risks TTY/UI side effects.
MSG
  exit 1
fi

echo "headless import guard: ok"
