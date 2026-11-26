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
| `src/BuiltInExternalProviders.ts` | The engine's built-in external provider ids (Bedrock, Google Cloud); a session on one is described by the provider, since `account/read` cannot describe it. |
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
- Owns the ACP→engine wire map (`SUPPORTED_GATEWAY_PROTOCOLS`) and reports the
  chosen wire in `providers/list` (`apiType` + `_meta.wire_api`); the parsing and
  defaults stay in `CodexEnvConfig.ts`.
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

## Resume replay: compaction events are not sent to the client (fork behaviour, 2026-11-17)

Resuming a session replays the durable history, and the engine re-emits historical
`contextCompaction` items through the live event path — the baseline handler then
rendered them as **in-progress "Compact conversation" tool-call cards**. Users read
that as a compaction running on a freshly resumed session; in reality those are
finished internal bookkeeping events from earlier turns.

The baseline `CodexEventHandler` (the one that only serves a session no prompt has
subscribed to yet — every event in that window is history) takes
`resumeReplayCompactions = true` and **skips compaction items entirely**, including
the legacy `noteLegacyCompaction` bookkeeping: keeping the bookkeeping would make the
turn-end drain emit a `failed` update for a tool call the client never saw. The
prompt-scoped handler passes `false`, so a compaction that actually runs during a
turn is still announced live (`in_progress` → `completed`).

The `loadSession` paginated-history path matches: clients without compaction
updates get nothing for replayed compaction items (previously a completed card);
v2 clients keep the `createCompactionUpdate` state sync.

Tests: `load-session` snapshots, `session-notices`, and the `history-replay`
baselines (plain/zed) were updated to the new expectation.

## Failure reporting: one user-visible message per failure (fork behaviour, 2026-11-17)

A single engine error reached the client through **two adapter paths**, so the same
`ran out of room…` text appeared twice with the degrade warning in between:

1. the live error notification rendered as an agent text message
   (`CodexEventHandler.createErrorEvent`);
2. the prompt-end fallback (`CodexAcpServer`, "failed after it was inserted"), whose
   `RequestError` is a **different instance** — `failuresShownAsMessage` keys on object
   identity (a `WeakSet`), so it could not suppress it.

Fix: the session state records `lastRenderedFailureText`, set whenever a failure text is
rendered, and the prompt-end fallback skips a text already shown. The record is
**cleared at every prompt start** (`beginPromptTokenUsage`) — without that reset a later
turn failing with identical wording but no live error path would show nothing at all.

Measured before the fix (same turn): engine attempts failed **5** times, degraded once,
but emitted **one** terminal `Turn error:` — so the engine already reports only the last
attempt; the duplication was purely the adapter's two render paths. A `usage` fallback
added in 1.2.40 and reverted in 1.2.41 is the other half of this story: reporting the
session's previous-prompt usage for a prompt with no model call is wrong, so `usage`
stays `null` for prompts that never reached a model (`/status` and failed-before-dispatch
turns).

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
| `NUWAX_WIRE_API` | OpenAI wire: `chat` (default) / `responses`. Unset with `NUWAX_BRIDGE=native` defaults to `responses` (native speaks Responses only). Do not set for the Anthropic protocol (chosen by `NUWAX_API_PROTOCOL=anthropic`). |
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

## Provider wire selection (fork behaviour, 2026-11-19)

ACP `providers/set` carries only `apiType`, and the ACP schema strips unknown
top-level keys, so an explicit `wire_api` sent beside `apiType` never reaches the
adapter. The engine's `wire_api` (chat / responses / anthropic) therefore has to be
selected through one of two spots:

- **Environment gateway** — `NUWAX_WIRE_API` (`chat` / `responses`), with
  `NUWAX_API_PROTOCOL` choosing the family. Unset defaults to **chat**, because the
  gateways this fork targets implement Chat Completions more completely than
  Responses and clients that only know the `openai` protocol expect chat.
  `NUWAX_BRIDGE=native` is Responses-only, so an unset wire follows the bridge and
  defaults to `responses` there.
- **`providers/set`** — `apiType: "openai"` now defaults to **chat**;
  `"openai-responses"` selects Responses, `"openai-chat"` is an accepted synonym,
  and `_meta: {wire_api: "responses" | "chat"}` overrides `apiType: "openai"`.
  `providers/list` reports the protocol family (`openai` / `anthropic`) plus
  `_meta.wire_api`, so clients that only understand the two family values keep
  working and can still render the exact wire.

Rejected combinations fail fast with `invalid_params`: an unknown
`_meta.wire_api`, or any `wire_api` on the `anthropic` family.

Tests: `src/__tests__/CodexACPAgent/env-bridge.test.ts` (default wire per bridge),
`src/__tests__/CodexEnvConfig.test.ts` (unset → chat, carried `apiType`),
`src/__tests__/CodexACPAgent/providers.test.ts` and `providers-v2.test.ts`
(chat/responses selection, `providers/list` round-trip).

### Consequence for upstream's `src/__tests__/integration` (2026-11-26)

The `gateway` **`authenticate`** method is a third spot. Its request carries only
`baseUrl` / `headers` / `providerName`, so the adapter installs the protocol the
agent advertises for the method (`GatewayAuthMethod._meta.gateway.protocol` =
`openai`) — which is **chat** here.

Upstream's integration suite (`npm run test:integration`) assumes `openai` means
Responses: its fixture authenticates against `mock-responses-server.ts`, which
only answers `POST …/responses`, so every model call gets a 404 and 18 of 19
tests fail before their assertions run. That is independent of the engine
version (identical on nuwax-harness 0.18.64 and 0.18.65), and `NUWAX_WIRE_API`
does not help because the gateway installed by `authenticate` replaces the
env-seeded one. `ci.yml` still runs that suite on `main`.

- The fork's own acceptance suite covers the same path the fork's way:
  `scripts/acp-validation/run-all-wires.sh <path-to-nuwax-harness>` — real
  engine, tri-wire mock vendor, 7 steps on each of chat / responses / anthropic.
  Green on 0.18.65, with step results identical to 0.18.64.
- Reviving upstream's suite needs a deliberate change — an env-seeded gateway
  without the `authenticate` step, or a mock that also speaks Chat Completions.
  It is not a one-line fixture fix; the comment at `connectAndLogin` in
  `src/__tests__/integration/integration-fixture.ts` explains the failure where
  it happens.

## Generated protocol types (`src/app-server/`)

`src/app-server/` is the engine's app-server protocol as TypeScript, one file
per type, written by `npm run generate-types`
(`nuwax-harness app-server generate-ts --out src/app-server`). Every file says
"GENERATED CODE! DO NOT MODIFY BY HAND!"; about 70 adapter source files import
from it. It is compile-time knowledge only — at runtime the JSON passes through
untyped — so a stale copy keeps compiling and the published package keeps
working, while the adapter silently stops knowing what the engine sends.

**Regenerate on every engine bump, in the same commit.** The generator only
adds and overwrites; it never deletes, so a clean refresh is:

```bash
rm -rf src/app-server && npm run generate-types   # uses the pinned engine in node_modules
npx tsc --noEmit                                   # then fix what the new surface breaks
```

`npm run typecheck` chains four `tsc` runs with `&&`; when the root project
fails the other three never run, so check them one by one before concluding
they are clean.

Why this is a rule (2026-11-26): the types had last been generated at v1.2.19
(engine 0.18.17) and 33 later releases bumped the engine without regenerating.
By 0.18.65 the engine's protocol had moved under the adapter — 40 upstream
commits and 7 fork ones touch the protocol crate in that range — leaving 24
types the adapter did not have, 29 whose definition had changed (15 of them in
use) and 288 files from an older generator that nothing produced any more.
Refreshing them cost 45 type errors (13 in source, 32 in test fixtures). The
`codex-update.yml` bot does regenerate, but it opens PRs against `main` while
releases are cut from `dev` by hand, so it does not cover the release path.

### Adapter-owned types

One name the adapter imports is no longer a protocol type; it lives in the
adapter and must not be recreated under `src/app-server/`:

- **`McpStartupResult`** (`src/mcp/McpStartupTracker.ts`) — `McpStartupReporter`
  used to borrow the shape of the protocol's `mcpStartupComplete` event, which
  later engines no longer publish. The reporter itself is live: it turns MCP
  servers that failed or were cancelled at session start into failed tool
  calls, from the tracker's result.

The service tier needs no type of its own: the engine's field is a free
string, so the adapter keeps what it receives as `string | null` and
recognises the Fast mode ids with `isFastServiceTier` — see "Fast mode service
tier".

### Decisions for new protocol surface (0.18.65)

- **A new notification with no ACP counterpart** goes on the ignored list of
  `createUpdateEvent` (`src/CodexEventHandler.ts`), which keeps that switch
  exhaustive. `thread/section/changed` (a thread moved into, within or out of
  a section) is handled this way.
- **`Account` variant `gcp`** (Google Cloud Vertex AI with externally managed
  credentials) maps like Bedrock: `kind: "external"`, label
  `"Google Cloud Vertex AI"`; `getAuthenticationStatus` reports it as gateway
  `"gcp"` (the engine's `GCP_PROVIDER_ID`), and `/status` names it the same.
  `formatAccountInfo` is a `switch` on purpose: as an if-chain with a trailing
  `"unknown"` it compiled fine while showing GCP users "unknown". A session on
  such a provider is described by the provider itself — see "Built-in external
  providers are their own auth source".
- **`Account.workspaceName`** is required on ChatGPT accounts. `fromAccount`
  does not surface it yet; `accountFromUpdated` keeps the previous value
  across an `account/updated` push, the same rule the email already follows.
- **An `audio` user input** carries either `url` or `fileId`, like an image;
  history replay renders `fileId` as `audio:<id>`.
- **Error kinds are open, and the category table does not check them.**
  `CodexErrorInfo` ends in `| string | {[key: string]: unknown}`, so
  `Extract<CodexErrorInfo, string>` is plain `string`: the
  `satisfies Record<…>` on `STRING_CODEX_ERROR_CATEGORIES`
  (`src/CodexEventHandler.ts`) accepts any set of keys. A kind missing from the
  table falls back to `provider_error` in `sessionFailureKind`, which is the
  intended behaviour for kinds this build does not know. Nothing will remind
  you of a new kind. Of the two that arrived in 0.18.65, `modelNotFound` is
  mapped to `bad_request` — the engine does not retry it
  (`CodexErr::retry_delay`), so the user is not offered a retry either — and
  `policyCapacityUnavailable` keeps the fallback, since the engine does retry
  it.
- **`ReviewDelivery` lost `detached`** (reviews run inline on the given
  thread). The adapter already sends `delivery: "inline"`.

Test fixtures that build a ChatGPT `Account` need `workspaceName`, and an
`imageGeneration` `ThreadItem` needs `generationId` — both `null` where the
fixture does not care.

Verification for a refresh: `npm run typecheck`, `npm test`, then
`scripts/acp-validation/run-all-wires.sh <path-to-nuwax-harness>` (real
engine, three wires).

## Fast mode service tier (fork behaviour, 2026-11-26)

The engine accepts `fast` as a request value but names the tier `priority`:
`ServiceTier::Fast.request_value()` is `"priority"`, config normalises `fast`
to it, and a thread started with `serviceTier: "fast"` is reported back with
`"priority"` (checked against nuwax-harness 0.18.65). The protocol types the
field as a free string, because a model catalog can define tiers of its own.

Upstream's adapter compared the reported tier with `"fast"` only, and sent
`serviceTier: null` whenever Fast mode was off. The engine reads that field as
a double option — `null` clears the thread's tier for this and every later
turn, an omitted field leaves it unchanged — so the combination had two
effects:

- A thread on the fast tier was shown as **Off**, and its first turn sent
  `null` and cleared the tier the user had configured.
- A thread on any tier the adapter does not describe (`flex`, a catalog tier)
  had that tier cleared on its first turn as well.

Both are fixed in `src/FastModeConfig.ts`:

- `isFastServiceTier` recognises `fast` and `priority`. The session's Fast mode
  state no longer looks at a typed enum.
- `modelSupportsFast` mirrors the engine's `ModelPreset::supports_fast_mode`
  field by field: the deprecated `additionalSpeedTiers` names the tier `fast`,
  `serviceTiers` lists it as `priority`. A `fast` id under `serviceTiers` is
  not one the engine honours, so it is not offered either.
- `resolveTurnServiceTier` decides what a turn carries, and
  `SessionState.fastModeExplicitlyOff` records whether the user turned Fast
  mode off in this session:

  | Fast mode | Model has the tier | `serviceTier` on the turn |
  |---|---|---|
  | on | yes | `"fast"` |
  | on | no | `null` (explicit standard speed, as before) |
  | off, turned off by the user | — | `null` (the user asked for it) |
  | off, never turned on | — | omitted (the thread keeps its own tier) |

**A toggle is applied to the thread at the same time.** `CodexAcpClient.setThreadFastMode`
sends `thread/settings/update` with `serviceTier`, whose `null` clears the
thread's tier. The engine answers a cleared tier with its `"default"`
sentinel. The choice therefore lives in the engine and survives closing and
resuming the session before the next turn; rebuilding the session state from
the reported tier gives the user's choice back. Upstream applied a turn-off
only on the next turn, so a resume in between restored the old tier. A toggle
that changes nothing does not call the engine — turning off what is already
off must not clear a tier the thread has on its own — and a rejected update
rejects the request and leaves the session as it was.

The received tier is kept as `string | null`; the `as ServiceTier` casts are
gone together with the type. The wire snapshots under
`src/__tests__/CodexACPAgent/data/` therefore no longer contain
`"serviceTier": null` on a `turn/start`.

Tests: `src/__tests__/CodexACPAgent/fast-mode-config.test.ts`.

## Built-in external providers are their own auth source (fork behaviour, 2026-11-26)

`account/read` cannot describe a session on a built-in external provider
(Amazon Bedrock, Google Cloud Vertex AI). Its params carry no thread id, so it
always answers for the engine's default configuration: with an OpenAI default
and a Vertex AI thread it reports the OpenAI account, which says nothing about
that session. An earlier attempt to use that read for these sessions put an
`API key configured` line into a Vertex AI session's `/status`.

Such a session is therefore described by its provider alone, in
`src/BuiltInExternalProviders.ts` (fork-only):

- The auth status is `{kind: "external", label}` with the provider's name, and
  `/status` prints the same label. The session's `account` stays `null`.
- The status names the auth source and nothing more: whether the credentials
  work is settled by the first real request.
- The provider ids are the engine's constants and differ from the account type
  names: the Bedrock account is `"amazonBedrock"`, its provider ids are
  `"amazon-bedrock"` and `"amazon-bedrock-runtime"`.

**A status remembers where it came from.** `authStatusFromAccount` records
whether the connection-level status was derived from the Codex account, and
`account/updated` — which describes that account only — rewrites nothing else.
Upstream guarded by kind (`kind === "gateway"`); the `external` status of these
sessions slipped past it, and a Codex logout turned `Google Cloud Vertex AI`
into `Not logged in`.

`fromAccount` and `builtInExternalProviderStatus` name the providers the same
way, so the Codex-account and the session-provider paths agree; `/status` says
`AWS Bedrock` for Bedrock where it used to say `Amazon Bedrock`.

Tests: "sessions on built-in external providers" in
`src/__tests__/CodexACPAgent/auth-status.test.ts`, which opens a real
`session/new` behind a default OpenAI account.

## Merge playbook

1. Sync upstream into `main`: `git fetch upstream && git checkout main && git merge upstream/main`.
2. Switch to `dev`: `git checkout dev`.
3. Run `git merge main`.
4. Resolve conflicts:
   - 30 `.jsonl` fixtures: `git checkout --theirs <file>` for each, then verify tests.
   - `package.json`: manual merge (keep upstream deps, keep fork identity).
   - `package-lock.json`: after `package.json` is resolved, run `npm install`.
   - `src/app-server/`: never merge by hand — regenerate it from the pinned
     engine once `package.json` is settled (see "Generated protocol types").
   - `publish.yml`: `git checkout --ours .github/workflows/publish.yml`.
   - Core source files: resolve manually, keeping fork hooks minimal.
5. Run `npm run typecheck && npm test`.
6. Push `dev`.

## Documentation

- User guide: `my-docs/usage-guide.md`
- Dev testing guide: `my-docs/harness-dev-testing.md`
