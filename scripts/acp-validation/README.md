# ACP dev integration validation (credential-free, mock vendor)

Re-runnable acceptance contract for the `ACP -> codex (app-server) -> model
provider` path, archived from the one-off rig-0.44 validation drivers. The
vendor is a local mock server that records every model HTTP request, so each
scenario is a machine-checked assertion over the real wire bytes. No real
credentials, account data, or captured screenshots are used: the API key is a
dummy value the runner sets itself, and the only image is a synthetic
solid-red PNG from `shot-server.mjs`.

## Files

- `mock-vendor-server.mjs` — OpenAI-chat-wire mock with a JSONL request
  recorder. Answers are scripted; recall/compaction answers are derived from
  the actual incoming request, so passing still proves codex sent the bytes.
- `shot-server.mjs` — minimal MCP stdio server exposing `take_screenshot`.
- `acp-mock-validation-driver.ts` — the six-scenario driver with assertions.
- `run-acp-mock-validation.sh` — validates the binary receipt (sha256),
  starts the mock, sets the dummy key, runs the driver.

## Scenarios

| Step | Contract |
|---|---|
| S1 | session bootstrap with an MCP screenshot server |
| S2 | the named env var reaches the model request (Authorization header), the configured model id is used, and a full turn completes |
| S3 | the MCP image tool's output reaches the next model request as typed `image_url` content (data URL), after the tool actually ran |
| S4 | `session/cancel` mid-stream resolves the prompt with `stopReason: "cancelled"` |
| S5 | `/compact` then a continuation turn on the same session |
| S6 | kill the agent, `session/load` on a fresh process; recall succeeds only when the token is genuinely present in the resumed request history |

The driver writes a `results.json` artifact (binary path, sha256, per-step
outcomes) and exits non-zero when any step fails.

## Run

```bash
# Build the candidate first, then:
scripts/acp-validation/run-acp-mock-validation.sh /path/to/codex [expected-sha256]
```

`CODEX_PATH` is explicit — no silent default binary. Passing the expected
sha256 (second arg or `EXPECT_CODEX_SHA256`) makes the run refuse to start on
a receipt mismatch.

## Boundary

This mock proves protocol/contract behaviour only. It does **not** prove a
real vendor serves these requests, and it cannot prove vision: the S3 model
answer is scripted. Real-vendor and real-vision validation stays a separately
authorized paid run (see the rig-production notes in the codex repo).

## Open findings (2026-10-16, codex `e6ab13a18`)

The archived runner currently surfaces two product-side defects on the ACP →
app-server path and is kept failing-fast on purpose until they are fixed:

- **S3**: the request's `tools` list advertises `mcp__screenshots__take_screenshot`
  and the MCP server reports `status=ready`, but executing the call returns
  `unsupported call: mcp__screenshots__take_screenshot`. Reproduces with the
  original tmp driver as well, against binaries `914a400d7` and `e6ab13a18`;
  the round-10 paid MiMo run executed the same tool successfully, so this is
  a regression window to bisect, not a fixture artifact.
- **S5/S6**: after a cancelled turn, later prompts (`/compact`, follow-ups,
  recall) never appear as user messages in the model request — the vendor
  keeps receiving the cancelled turn's prompt as the last user message, so
  compaction answers stream stale content and recall cannot succeed. The
  recorded request bodies in the run artifacts show the stale last-user
  message directly.

Reproduce with:

```bash
scripts/acp-validation/run-acp-mock-validation.sh /path/to/codex
```

The per-request mock record (JSONL under the validation root) plus the
app-server log are the primary evidence for both findings.
