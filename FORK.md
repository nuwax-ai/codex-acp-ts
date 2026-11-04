# Fork: nuwax-harness-acp-ts

This document tracks every change this fork makes relative to upstream
`agentclientprotocol/codex-acp`. Use it as the merge playbook when syncing
`main` → `dev`.

## Identity

| | upstream | this fork |
|---|---|---|
| npm package | `@agentclientprotocol/codex-acp` | `@nuwax-ai/nuwax-harness-acp-ts` |
| CLI bin | `codex-acp` | `nuwax-harness-acp-ts` + alias `nuwax-codex-acp-ts` |
| engine dependency | `@openai/codex` | `@nuwax-ai/nuwax-harness` |
| release model | release-please on `main` | tag-driven (`v*`) from `dev` |

## Architecture

The adapter is a thin TypeScript layer that speaks ACP over stdio and
translates to the engine's JSON-RPC app-server protocol. The fork replaces
the upstream engine dependency with `@nuwax-ai/nuwax-harness` and adds an
environment-driven gateway so no explicit login is required.

```
ACP host (Zed / JetBrains / custom)
  │ stdio
  ▼
nuwax-harness-acp-ts  (this repo)
  │ JSON-RPC
  ▼
nuwax-harness app-server  (engine, spawned from ~/.nuwax-harness-cache)
  │ HTTP
  ▼
your model platform (OpenAI / Anthropic / …)
```

## Fork-only files (merge-safe)

These files do not exist upstream. They never conflict on merge.

| File | Purpose |
|---|---|
| `src/CodexEnvConfig.ts` | Reads `NUWAX_*` / `CODEX_*` env vars and builds gateway config. The single entry point for env-driven routing. |
| `src/SystemPromptMeta.ts` | Reads `_meta.systemPrompt` from ACP requests (append mode). |
| `src/RestoredTokenUsageTracker.ts` | Captures and replays restored `thread/tokenUsage/updated` snapshots on resume. |
| `src/SessionOpenQueue.ts` | Serialises concurrent session open/resume calls per session. |
| `src/resolveCodexBinary.ts` | Locates the harness binary inside `~/.nuwax-harness-cache`. |
| `vitest.config.mjs` | Test runner config. Upstream's file with one fork delta: `scripts/acp-validation/` and `scripts/live-validation/` are in the exclude list because they run on node:test, not Vitest. The old fork-owned `vitest.config.ts` was dropped because the `.mjs` extension wins Vitest's resolution order and would shadow it. |
| `scripts/acp-validation/` | Mock-wire validation scripts. |
| `scripts/live-validation/` | Live engine validation scripts. |
| `my-docs/` | User guide (`usage-guide.md`) and dev testing guide. |
| `.github/workflows/publish-beta.yml` | Beta publish workflow. |
| `.github/workflows/version-bump.yml` | Version bump workflow. |

## Modified shared files (conflict surface)

Keep modifications in these files as small as possible. Each entry lists what
the fork changes and how to minimise future conflict area.

### `src/CodexAcpClient.ts`

- Seeds gateway from env vars via `readGatewayConfigFromEnv()` (1 import + 3 lines).
- Wraps `resumeThread()` with `armRestoredTokenUsageCapture` / `settle` / `clear` (5 lines).
- Logs `baseUrlConfigured` instead of raw URL (3 sites).
- **Minimise**: all gateway logic already lives in `CodexEnvConfig.ts`; the only
  touch points are the import and the constructor seed. Token usage hooks are
  delegated to `RestoredTokenUsageTracker` on the client.

### `src/CodexAcpServer.ts`

- Adds `serializeSessionOpen()` wrapper around session load/resume paths (delegates to `SessionOpenQueue`).
- Calls `applyRestoredTokenUsage()` after resume state install.
- Passes `env` through `CodexProcessState`.
- **Minimise**: queue logic lives in `SessionOpenQueue.ts`; the server only
  calls `queue.enqueue(sessionId, canInstall, open)`.

### `src/CodexAppServerClient.ts`

- Instantiates `RestoredTokenUsageTracker`; the `notify()` hook checks the
  tracker before delivering `thread/tokenUsage/updated`.
- Adds `rootTurnId: null` to two synthetic error turns.
- **Minimise**: all capture/dedupe/dispose logic lives in the tracker class.

### `src/CodexEventHandler.ts`

- Adds `thread/readState/changed` and `thread/prediction/updated` to ignored events.
- Makes error category lookup type-safe for unknown kinds.

### `src/ClientSystemPrompt.ts`

- Adds `clientPromptText()` that falls back to `_meta.systemPrompt` via `SystemPromptMeta`.

### `src/TitleGenerator.ts`

- Accepts an optional `getModelRouting` callback; when provided, uses the active
  model/provider for the ephemeral title thread instead of a hardcoded model.

### `package.json`

- Package name, bin names, engine dependency, extra scripts.
- **Merge strategy**: resolve manually; keep upstream's new devDependencies and
  script entries, replace the engine dependency and package identity.

### `package-lock.json`

- **Merge strategy**: resolve `package.json` first, then run `npm install` to
  regenerate. Never hand-merge the lock file.

### `.github/workflows/publish.yml`

- Completely rewritten for tag-driven releases.
- **Merge strategy**: always keep the fork version; cherry-pick upstream CI
  fixes manually if needed.

### `.jsonl` test fixtures (`src/__tests__/scenarios/data/air/`)

- One-line metadata changes caused by upstream schema bumps.
- **Merge strategy**: take upstream version, then update fork test expectations
  if any assert the changed field.

## Environment variables

All gateway variables accept both `NUWAX_*` (preferred) and `CODEX_*` (legacy)
spellings. Both set to different values → startup error (split-brain guard).

### Gateway (required group)

| Variable | Description |
|---|---|
| `NUWAX_BASE_URL` | Platform protocol base URL. Setting this activates the gateway. |
| `NUXAX_WIRE_API` | `responses` / `chat` / `anthropic`. |
| `NUWAX_API_KEY` | API key for the endpoint. Falls back to `OPENAI_API_KEY`. |
| `NUWAX_MODEL` | Platform model ID. |

### Gateway (optional)

| Variable | Description |
|---|---|
| `NUWAX_API_PROTOCOL` | `openai` or `anthropic`. Default: `openai`. |
| `NUWAX_BRIDGE` | `rig` / `native` / `genai`. Default: `rig`. |
| `NUWAX_MODEL_CONTEXT_WINDOW` | Model context window in tokens. |
| `NUWAX_MAX_OUTPUT_TOKENS` | Per-request output cap. |
| `NUWAX_PROVIDER_ID` | Gateway provider ID. Default: `custom-gateway`. |
| `NUWAX_PROVIDER_NAME` | Display name. |
| `NUWAX_DISABLE_THINKING` | `true` = force reasoning effort to `none`. |
| `NUWAX_MODEL_REASONING_EFFORT` | Reasoning effort override. |
| `NUWAX_REASONING_EFFORT_LEVELS` | Comma-separated tier list for validation. `NUWAX_` only. |
| `NUWAX_TOOL_SEARCH` | `false` = expose MCP tools directly. |

### Adapter

| Variable | Description |
|---|---|
| `NUWAX_PATH` / `CODEX_PATH` | Override the engine binary path. |
| `NUWAX_ACP_APP_SERVER_CRASH_LIMIT` | Crash restart limit within the window. |
| `NUWAX_ACP_APP_SERVER_CRASH_WINDOW_MS` | Crash window duration in ms. |
| `NUWAX_CONFIG` | Extra config forwarded to the engine. |

## Merge playbook

1. Sync upstream into `main`: `git fetch upstream && git checkout main && git merge upstream/main`.
2. Switch to `dev`: `git checkout dev`.
3. Run `git merge main`.
4. Resolve conflicts:
   - 30 `.jsonl` fixtures: `git checkout --theirs <file>` for each, then verify tests.
   - `package.json`: manual merge (keep upstream deps, keep fork identity).
   - `package-lock.json`: after `package.json` is resolved, run `npm install`.
   - `publish.yml`: `git checkout --ours .github/workflows/publish.yml`.
   - Core source files: resolve manually, keeping fork hooks minimal.
5. Run `npm run typecheck && npm test`.
6. Push `dev`.

## Documentation

- User guide: `my-docs/usage-guide.md`
- Dev testing guide: `my-docs/harness-dev-testing.md`
