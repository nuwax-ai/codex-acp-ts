#!/usr/bin/env bash
# Run the archived ACP validation suite on all three provider wires
# (chat, responses, anthropic) against one codex binary and merge the
# per-wire results.json artifacts plus the scenario table into a single
# 18-row summary. Exit non-zero if any row failed.
#
# Usage:
#   scripts/acp-validation/run-all-wires.sh /path/to/codex [expected-sha256]
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

CODEX_PATH="${1:-${CODEX_PATH:-}}"
EXPECT_SHA="${2:-${EXPECT_CODEX_SHA256:-}}"
if [ -z "$CODEX_PATH" ] || [ ! -x "$CODEX_PATH" ]; then
    echo "CODEX_PATH missing or not executable: '${CODEX_PATH}'" >&2
    echo "usage: $0 /path/to/codex [expected-sha256]" >&2
    exit 2
fi

SUMMARY_ROOT="$(mktemp -d /tmp/acp-val-wires.XXXXXX)"
echo "wires summary root: $SUMMARY_ROOT"
declare -A WIRE_STATUS
OVERALL=0
for WIRE in chat responses anthropic; do
    WIRE_ROOT="$SUMMARY_ROOT/$WIRE"
    mkdir -p "$WIRE_ROOT"
    echo "=== wire: $WIRE ================================================"
    if VAL_ROOT="$WIRE_ROOT" VAL_WIRE="$WIRE" "$SCRIPT_DIR/run-acp-mock-validation.sh" "$CODEX_PATH" "$EXPECT_SHA"; then
        WIRE_STATUS[$WIRE]=pass
    else
        WIRE_STATUS[$WIRE]="exit-$?"
        OVERALL=1
    fi
done

node - "$SUMMARY_ROOT" "$SCRIPT_DIR/scenarios.json" <<'MERGE'
const fs = require("node:fs");
const path = require("node:path");
const [root, scenariosPath] = process.argv.slice(2);
const table = JSON.parse(fs.readFileSync(scenariosPath, "utf8"));
const rows = [];
let codexPath;
let codexSha256;
for (const wire of table.wires) {
    const resultsPath = path.join(root, wire, "results.json");
    let results;
    try {
        results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
        codexPath ??= results.codexPath;
        codexSha256 ??= results.codexSha256;
    } catch {
        for (const scenario of table.scenarios) {
            rows.push({ wire, scenario: scenario.id, name: scenario.name, pass: false, detail: "results.json missing (driver crashed or runner refused)" });
        }
        continue;
    }
    const byStep = new Map(results.results.map((r) => [r.step.split(" ")[0], r]));
    for (const scenario of table.scenarios) {
        const outcome = byStep.get(scenario.id);
        rows.push({
            wire,
            scenario: scenario.id,
            name: scenario.name,
            pass: Boolean(outcome?.pass),
            detail: outcome?.detail ?? "step never executed",
        });
    }
}
const summary = {
    codexPath,
    codexSha256,
    executed: rows.length,
    passed: rows.filter((r) => r.pass).length,
    rows,
};
fs.writeFileSync(path.join(root, "summary-18.json"), `${JSON.stringify(summary, null, 2)}\n`);
for (const row of rows) {
    console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.wire.padEnd(10)} ${row.scenario} ${row.name}: ${row.detail}`);
}
console.log(`summary: ${summary.passed}/${summary.executed} rows -> ${path.join(root, "summary-18.json")}`);
process.exitCode = summary.passed === summary.executed ? 0 : 1;
MERGE
MERGE_EXIT=$?
[ "$OVERALL" -ne 0 ] && exit "$OVERALL"
exit "$MERGE_EXIT"
