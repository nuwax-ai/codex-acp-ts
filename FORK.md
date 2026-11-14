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
| `src/__tests__/EngineLog.test.ts` | Contract tests for the fork's `engine.<date>.log` capture (see "Engine log capture"). |
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

### `src/Logger.ts`

- Adds `engine(chunk)` / `engineStderrEnabled`: engine stderr text is appended to
  `<log dir>/engine.<YYYY-MM-DD>.log` instead of being dropped (see "Engine log capture"
  below). `NUWAX_LOG_ENGINE_STDERR=0` opts out; ANSI escapes are stripped.
- Renames the adapter's own log from `app-server.log` to `app-server.<YYYY-MM-DD>.log`
  (date rolling only — no size-based rotation).
- **Merge strategy**: take upstream's `log`/`error`/`formatError` bodies verbatim; keep
  only the new `engine*` members, the dated filename, and the four helpers at the bottom
  (`formatLogDay`, `stripAnsi`, plus the switch constant).

### `src/CodexJsonRpcConnection.ts`

- `attachLogs()` keeps the byte-count record for stdin/stdout (protocol payloads carry
  credentials) and additionally mirrors **stderr text** into the engine log when
  `logger.engineStderrEnabled`; the chunk is only stringified in that branch.
- **Merge strategy**: the only delta inside `attachLogs` is the guarded
  `if (logger.engineStderrEnabled) logger.engine(data.toString("utf8"));` line. Upstream's
  "never stringify traffic" rule must stay for stdin/stdout.

### `.jsonl` test fixtures (`src/__tests__/scenarios/data/air/`)

- One-line metadata changes caused by upstream schema bumps.
- **Merge strategy**: take upstream version, then update fork test expectations
  if any assert the changed field.

## Tool call terminal states (fork behaviour)

A tool call is reported as `tool_call` (`in_progress`) and later closed by a `tool_call_update` with
`completed`/`failed`. ACP has no `cancelled` status, so a cancellation is reported as `failed` with a
readable English result text.

- Any turn that does not end with `status: completed` closes every tool call it left open
  (`CodexSessionToolCalls.finishOutstanding`), for ACP v1 and v2 alike: `Tool call cancelled.` for an
  interrupted turn, `Tool call failed: the turn ended before it finished.` otherwise. The same close-out
  runs when the app-server process dies (`…the Codex process exited before it finished.`). Without it a
  `bash`/MCP card keeps spinning until the session is reloaded.
- Context compaction is rendered as a tool call for clients without `session.compaction`. Since engines
  before harness 0.18.50 report the completion under a different item id, the adapter remembers the
  announced id and closes that entry instead of opening a second one; a compaction that never completes is
  ended at turn end with `Context compaction completed.` / `failed.` / `cancelled.`.

## Engine log capture (fork behaviour)

The engine (`nuwax-harness`, Rust `tracing`) only writes to **stderr**; the app-server protocol
keeps it off stdout. Upstream's adapter counted those chunks as bytes and discarded the text, so
an operator's log directory held nothing about engine decisions — a 2026-11-13 session left a
91 MB `app-server.log` whose one million lines were all `[ERR] {"bytes":N}`.

The fork writes the text instead, into its own file next to the adapter log:

| File | Contents |
|---|---|
| `app-server.<YYYY-MM-DD>.log` | Adapter traffic: `[IN]`/`[OUT]` byte counts, `[SYS]` lifecycle lines, and `[ERR]` byte counts **only while engine capture is off**. |
| `engine.<YYYY-MM-DD>.log` | Engine stderr verbatim (ANSI stripped): `tracing` lines from `RUST_LOG`, opened per process by `=== engine log opened pid=… ===`. |

- Both roll **by local calendar date only**; there is no size-based rotation, so a single day
  always maps to a single file per stream.
- The directory is `$APP_SERVER_LOGS`, falling back to `NUWAX_LOG_DIR` / `CODEX_LOG_DIR`. The
  Electron client points it at its own log directory, so both files sit next to
  `electron-dev.log` and can be exported as one folder.
- `NUWAX_LOG_ENGINE_STDERR=0` (also `false`/`no`/`off`) disables engine capture; the chunk is
  then not even stringified and the adapter falls back to `[ERR] {bytes: N}` lines.
- A failing write (log directory removed, disk full) reports once and then stops trying for the
  rest of the process: one dead directory must not emit an error per stderr chunk.
- Chunks are decoded with `StringDecoder`, so a multi-byte UTF-8 character (or an ANSI escape)
  split across two stderr chunks is not replaced by U+FFFD. `attachLogs` asks
  `logger.engineChunk(buffer)`; when it reports the text was not captured (capture off, or the
  log went away) the adapter falls back to an `[ERR] {bytes: N}` line instead of dropping it.
- **Sensitivity**: engine logs contain workspace content and request URLs. Credentials are not
  written by design (the adapter never stringifies protocol payloads), but the engine's own
  lines are verbatim, so treat the log directory as sensitive data.

## Environment variables

All gateway variables accept both `NUWAX_*` (preferred) and `CODEX_*` (legacy)
spellings. Both set to different values → startup error (split-brain guard).

### Gateway (required group)

| Variable | Description |
|---|---|
| `NUWAX_BASE_URL` | Platform protocol base URL. Setting this activates the gateway. |
| `NUWAX_WIRE_API` | OpenAI wire: `responses` / `chat`. Do not set for the Anthropic protocol (chosen by `NUWAX_API_PROTOCOL=anthropic`). |
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

### Sandbox presets (fork, 2026-11-14)

`AgentMode::WorkspaceWrite` and `AgentMode::Agent` presets set
`networkAccess: true` — outbound network is part of the workspace-write
baseline in the engine (`sandbox_workspace_write.network_access` defaults to
`true`; see the engine fork's FORK.md). `read-only` stays network-restricted.
Client hosts selecting a preset must not re-restrict what the engine enabled
by default; a user can still opt back out per provider config.

### Adapter

| Variable | Description |
|---|---|
| `NUWAX_PATH` / `CODEX_PATH` | Override the engine binary path. |
| `NUWAX_ACP_APP_SERVER_CRASH_LIMIT` | Crash restart limit within the window. |
| `NUWAX_ACP_APP_SERVER_CRASH_WINDOW_MS` | Crash window duration in ms. |
| `NUWAX_CONFIG` | Extra config forwarded to the engine. |
| `NUWAX_LOG_DIR` / `CODEX_LOG_DIR` | Adapter log directory; `APP_SERVER_LOGS` wins when both are set. |
| `NUWAX_LOG_ENGINE_STDERR` | `0`/`false`/`no`/`off` disables the engine stderr capture (`engine.<date>.log`); anything else keeps it on. |

Engine-side switches (`NUWAX_IMAGE_MAX_BYTES`, `NUWAX_REQUEST_IMAGE_MAX_BYTES`,
`NUWAX_TOOL_SEARCH`, `NUWAX_OPENAI_EGRESS`, `NUWAX_AUTO_COMPACT_*`, `NUWAX_HOME`) are read
by the app-server child process, so they work through ACP too; the user-facing reference is
[`my-docs/usage-guide.md`](my-docs/usage-guide.md).

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
