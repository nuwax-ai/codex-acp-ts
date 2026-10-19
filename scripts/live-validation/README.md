# Real-model validation

These runners use the same loopback gateway for all Codex exec, vision and
ACP model requests. The gateway owns the vendor credentials; child processes
receive a local gateway key. Each HTTP attempt is charged before opening its
upstream connection, including retries, auxiliary sampling and tool follow-up
requests. Streaming replies remain streaming, and client cancellation closes
the upstream request. Upstream redirects are refused so a client cannot leave
the gateway by following `Location`.

## Run selected cases

Run from the ACP repository. These commands make real model requests except
for `env-determinism`, which starts the real Codex executable against local
native Chat, Responses and Anthropic fixtures and checks the received path,
model and authentication. It also exercises Anthropic bare, `/v1` and full
`/v1/messages` base URLs to catch version-path mismatches.

```bash
export LIVE_ENV_FILE=/Volumes/soddy/git_workspace/fork-nuwax-codex/.env.local
export CODEX_BIN=/absolute/path/to/codex
export CODEX_EXEC_BIN=/absolute/path/to/codex-exec
export VAL_ROOT="$(mktemp -d /tmp/acp-live-validation.XXXXXX)"
export LIVE_BUDGET_ATTEMPTS=24
export LIVE_MAX_OUTPUT_TOKENS=2048

# Zero paid requests: execute Codex, rather than compare constructed strings.
scripts/live-validation/live-smallbatch.sh --cases env-determinism

# Continue the same run and remaining real-request budget.
scripts/live-validation/live-smallbatch.sh --resume --cases wire-chat,wire-anthropic,wire-responses

# One case can be selected in the same way.
scripts/live-validation/live-smallbatch.sh --resume --cases main-screenshot
```

`--list` lists the thirteen cases. Without `--cases`, all run in this order:
local env preflight; GLM Chat; STEP Anthropic; GLM Responses; MIMO Chat;
initial text; cross-process cold recall; real shell tool; ACP streaming
cancel; MCP screenshot; ACP single request; three randomized digit/color
images; ACP prompt/compact/continuation/cold-load.

`main-cold-recall` requires `main-text` in the same run directory. `CODEX_BIN`
is required for every run: it must name the `codex` binary built from the
source under test, and there is no default, because an inherited path would
hash and validate a binary nobody chose. `CODEX_EXEC_BIN` defaults to
`CODEX_BIN` with an `-exec` suffix, which is the sibling cargo produces in the
same profile directory. `LIVE_SKIP_ACP=1` omits the three ACP cases. The
fresh-run request cap defaults to 96; set it explicitly for a smaller
acceptance run. Output defaults to 2048 tokens and the gateway applies the cap
independently of the child setting.

`LIVE_WINDOW_<VENDOR>` pins `CODEX_MODEL_CONTEXT_WINDOW` for that vendor's
child processes, so the local request budget matches the model's advertised
window instead of Codex's fallback default. Absent leaves Codex's own default
handling in place; present but not a positive integer stops the run, since a
silently dropped window would charge paid attempts against a budget nobody
configured.

The credentials file uses `LIVE_{GLM,MIMO,STEP}_MODEL`,
`LIVE_{GLM,MIMO,STEP}_API_KEY` and
`LIVE_{GLM,MIMO,STEP}_{CHAT,ANTHROPIC,RESPONSES}_URL`. Only selected
vendor/wire pairs need to be present. Values may be quoted; shell expressions
are never evaluated. Credentials and upstream URLs are not printed by the
gateway or written to its ledger.

## Receipts and retries

`request-ledger.jsonl` is the authoritative attempt counter. It contains only
safe metadata: timestamps, vendor/wire, admitted sequence, denials and status.
It contains no headers, prompts, image bytes or upstream URLs. Admission is
synchronous before forwarding, so parallel clients share one actual cap.
Connection failures are conservatively charged as attempts. A denied request
never reaches the upstream, and any denial makes the overall run fail even
if a child reports success.

`summary.json` records actual admitted attempts, denials and case results.
Per-case `actualAttempts` is an interval measurement; background auxiliary
calls can fall in the following interval. The shared total is authoritative.
`observedExecUsage` contains usage emitted by exec cases only; it is not a
claim to account for all auxiliary/ACP tokens. The 32 MiB request-body byte
limit is not a token limit. This runner does not promise a 32K input-token
ceiling; model context and vision accounting remain the Codex/provider
contract.

The original JSONL/stderr and screenshot truth remain in the isolated run
directory for inspection. Final-answer assertions parse completed assistant
items and require successful exec exit and turn completion. Tool text and
earlier assistant messages cannot satisfy the screenshot color check. Missing
truth, failed tools, missing typed images or wrong final colors fail. Direct
vision requires all three images to match their randomized digit and color.
The vision prompt explicitly asks for the digit and dominant background
color. A retry reuses the existing seed, `truth.json` and exact PNG bytes;
missing or inconsistent fixtures fail instead of generating easier samples.
The byte receipt in `truth.json` is checked before any vision model request.

```bash
# Retry only failed cases without resetting this run's request counter.
scripts/live-validation/live-fixup.sh --cases main-screenshot,acp-smoke
```

A case may pin its route as `name@VENDOR/wire`, so one scenario can be run
against several vendors inside one shared-budget run; each route keeps its own
result row (`name-VENDOR-wire`). `live-fixup.sh` without `--cases` retries
exactly the rows this run recorded as failed, decoded back to their routes. It
deliberately does not fall back to the default suite: that would spend fresh
paid attempts on routes the run never selected and append rows under labels no
earlier receipt contains. Naming cases narrows that retry — a plain name covers
every route recorded for that case, a routed name stays pinned to its route.
Two spellings of one route (`main-text@GLM/chat` and `main-text@glm/chat`) are
rejected before any request, because they share a row label and the later row
would overwrite the first.

Resume cannot increase/change the stored budget or output cap. An exhausted
run remains exhausted. A pre-gateway manual ledger cannot be resumed as a
gateway-backed receipt. Keep it as historical evidence and start a new run.

Only one gateway can own a ledger. Normal shutdown releases its lock. After
an abnormal termination, startup fails closed if `request-ledger.jsonl.lock`
remains. Confirm that the recorded process no longer owns this run before
manually removing that lock; retain the ledger. Automatic stale-lock
takeover is deliberately absent because concurrent takeovers can double the
allowance. A new `VAL_ROOT` is independent and therefore a new explicit run.

Standalone `vision-direct.py`, `acp-live-smoke.ts` and `acp-live-cancel.ts`
refuse to start model processes without a live authenticated loopback gateway
and matching `NUWAX_*` route. Use the runner to configure them.

## Local regression suites (zero paid requests)

```bash
node --import tsx --test scripts/live-validation/*.test.mjs
python3 -m unittest discover -s scripts/live-validation -p 'test_*.py' -v
node --import tsx --test scripts/acp-validation/stress-contracts.test.mjs
```

They cover concurrent three-wire budget exhaustion, retries, persistent
resume, competing owners, stale locks, redirect refusal, secret-free ledger,
wrong-color screenshot false positives, failed/missing exec terminals,
whole-run denials, shutdown cleanup preserving failure evidence and the
cancel-notification to acknowledgement request window. The ACP text collector
excludes advisory notices and commentary, joins chunks by message identity
and scores the last final assistant message exactly.
