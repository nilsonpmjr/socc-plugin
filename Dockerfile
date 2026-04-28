# syntax=docker/dockerfile:1.7
#
# socc-plugin — multi-stage build on the official Bun image.
#
# IMPORTANT: this Dockerfile expects the build context to be the PARENT
# directory containing both `socc-plugin/` and `socc/`. The compose.yml
# sets that up; for a standalone build:
#
#   cd scratch && docker build -f socc-plugin/Dockerfile -t socc-plugin .

ARG BUN_VERSION=1.3.12

# ── stage 1: install ──────────────────────────────────────────────────

FROM oven/bun:${BUN_VERSION}-alpine AS deps

# Mirror the host layout so `file:../socc` in package.json resolves
# naturally. No symlink gymnastics required.
WORKDIR /workspace
COPY socc ./socc
COPY socc-plugin/package.json socc-plugin/bun.lockb* ./socc-plugin/

WORKDIR /workspace/socc-plugin
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# ── stage 2: build ────────────────────────────────────────────────────

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /workspace

COPY --from=deps /workspace/socc ./socc
COPY --from=deps /workspace/socc-plugin/node_modules ./socc-plugin/node_modules
COPY socc-plugin/package.json socc-plugin/tsconfig.json ./socc-plugin/
COPY socc-plugin/src ./socc-plugin/src

WORKDIR /workspace/socc-plugin
RUN bunx tsc --noEmit \
  && bun build src/server/index.ts --target=bun --sourcemap=inline --outfile=dist/server.mjs \
  && bun build src/sessionWorker.ts --target=bun --sourcemap=inline \
       --external '@vantagesec/socc/*' \
       --external '@opentelemetry/*' \
       --outfile=dist/sessionWorker.mjs

# ── stage 3: runtime ──────────────────────────────────────────────────

FROM oven/bun:${BUN_VERSION}-alpine AS run
WORKDIR /app

RUN addgroup -S socc && adduser -S socc -G socc
COPY --from=build /workspace/socc-plugin/dist ./dist
# libsodium ships a WASM blob bun-build references at runtime.
COPY --from=build /workspace/socc-plugin/node_modules/libsodium-wrappers ./node_modules/libsodium-wrappers
COPY --from=build /workspace/socc-plugin/node_modules/libsodium ./node_modules/libsodium
# sessionWorker.mjs dynamically imports @vantagesec/socc/engine; ship it
# alongside the bundle rather than re-bundling the whole engine.
COPY --from=build /workspace/socc-plugin/node_modules/@vantagesec ./node_modules/@vantagesec

USER socc
EXPOSE 7070
ENV NODE_ENV=production
ENV PORT=7070
# sessionWorker.mjs is emitted alongside server.mjs by bun build.
# workerPool.ts detects the bundled context via import.meta.url ending
# in .mjs and resolves ./sessionWorker.mjs automatically — no env var needed.

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7070/v1/health | grep -q '"status":"ok"' || exit 1

CMD ["bun", "run", "dist/server.mjs"]
