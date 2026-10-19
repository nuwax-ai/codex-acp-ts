#!/usr/bin/env python3
"""Real-model acceptance; every subprocess uses one shared request gateway."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

from live_support import Gateway, ValidationError, ensure_vision_fixtures, exec_result, local_codex_preflight, provider_env, run_process, screenshot_result

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent.parent
CASES = ("env-determinism", "wire-chat", "wire-anthropic", "wire-responses", "backup-switch-mimo", "main-text", "main-cold-recall", "main-tool", "main-cancel", "main-screenshot", "vision-direct", "acp-smoke", "acp-workflow")
# Cases whose vendor/wire is fixed by their definition reject an override.
OVERRIDE_REJECTED = ("env-determinism", "wire-chat", "wire-anthropic", "wire-responses", "backup-switch-mimo")
WIRES = ("chat", "responses", "anthropic")
# The gateway registers a route as LIVE_<VENDOR>_<WIRE>_URL, so a vendor token
# that cannot normalise into that identifier can never resolve.
VENDOR = re.compile(r"[A-Z][A-Z0-9_]*")
# A routed result row is `<case>-<VENDOR>-<wire>`. Case names carry hyphens and
# one ends in a wire word, so the uppercase vendor segment is what separates a
# routed row from a plain case name.
ROUTED_ROW = re.compile(r"(.+)-([A-Z][A-Z0-9_]*)-(?P<wire>" + "|".join(WIRES) + r")\Z")


def parse_case(spec):
    """`name` keeps its default route; `name@VENDOR/wire` pins it explicitly.

    The suffixed form exists so the same scenario (for example the full
    acp-workflow loop) can run against several vendors in one shared-budget
    run without reusing a previous round's receipts.
    """
    if "@" not in spec:
        name = spec.strip()
        if name not in CASES:
            raise ValidationError(f"unknown live case {spec!r}; use --list")
        return name, None, None
    name, route = spec.split("@", 1)
    vendor, _, wire = route.partition("/")
    if name in OVERRIDE_REJECTED or name not in CASES:
        raise ValidationError(f"case {name} does not accept a vendor/wire override")
    vendor = vendor.strip().upper()
    if not vendor or not VENDOR.fullmatch(vendor) or wire not in WIRES:
        raise ValidationError(f"invalid vendor/wire override: {route}")
    return name, vendor, wire


def case_label(name, vendor, wire):
    return name if vendor is None else f"{name}-{vendor}-{wire}"


def spec_from_row(name):
    """Inverse of `case_label`, so a fixup retries the route that failed."""
    match = ROUTED_ROW.fullmatch(name)
    if not match:
        return name
    return f"{match.group(1)}@{match.group(2)}/{match.group('wire')}"


def select_specs(cases_arg, only_failed, previous):
    """Resolve the case specs to run, refusing labels that would collide.

    `--only-failed` without `--cases` selects from this run's own recorded
    rows. Falling back to the default suite instead would spend fresh paid
    attempts on routes the run never selected and append rows under labels no
    earlier receipt contains.
    """
    if not only_failed:
        return dedup(list(CASES) if cases_arg is None else cases_arg.split(","))
    if not previous:
        raise ValidationError("no recorded results to select failures from; run the cases first")
    # results.jsonl is append-only, so a case already retried appears more
    # than once. Only its newest verdict decides whether it must run again.
    still_failing = [spec_from_row(name) for name, row in {row["name"]: row for row in previous}.items() if not row.get("pass")]
    if cases_arg is not None:
        narrowing = [parse_case(spec) for spec in cases_arg.split(",")]
        # A plain name in a fixup means "retry every route this run recorded
        # for this case"; a routed name stays pinned to that one route.
        plain = {name for name, vendor, _ in narrowing if vendor is None}
        exact = {case_label(*route) for route in narrowing if route[1] is not None}
        narrowed = []
        for spec in still_failing:
            name, vendor, wire = parse_case(spec)
            if name in plain or case_label(name, vendor, wire) in exact:
                narrowed.append(spec)
        still_failing = narrowed
    return dedup(still_failing)


def dedup(specs):
    labels = [case_label(*parse_case(spec)) for spec in specs]
    if len(set(labels)) != len(labels):
        collision = next(label for index, label in enumerate(labels) if label in labels[:index])
        raise ValidationError(f"live case {collision} is selected more than once; one route spends one paid attempt set")
    return specs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", help="comma-separated case names, each optionally name@VENDOR/wire; use --list to inspect")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--only-failed", action="store_true")
    args = parser.parse_args()
    if args.list:
        print("\n".join(CASES))
        return 0
    root = Path(os.environ.get("VAL_ROOT") or tempfile.mkdtemp(prefix="acp-live-val.")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    ledger = root / "request-ledger.jsonl"
    if args.resume and not ledger.exists():
        raise ValidationError("cannot resume a legacy/manual attempt ledger; start a new gateway-backed run")
    if not args.resume and ledger.exists():
        raise ValidationError("run already has a shared budget; use --resume or a new VAL_ROOT")
    previous = [json.loads(line) for line in (root / "results.jsonl").read_text().splitlines() if line.strip()] if (root / "results.jsonl").exists() else []
    selected = select_specs(args.cases, args.only_failed, previous)
    env_file = Path(os.environ.get("LIVE_ENV_FILE", "/Volumes/soddy/git_workspace/fork-nuwax-codex/.env.local"))
    codex_env = os.environ.get("CODEX_BIN")
    if not codex_env:
        raise ValidationError("CODEX_BIN must name the codex binary built from the source under test; there is no default")
    codex = Path(codex_env)
    exec_bin = Path(os.environ.get("CODEX_EXEC_BIN", str(codex) + "-exec"))
    if not env_file.is_file():
        raise ValidationError(f"credential env file {env_file} is missing; set LIVE_ENV_FILE")
    if not codex.is_file() or not exec_bin.is_file() or not os.access(exec_bin, os.X_OK):
        raise ValidationError("CODEX_BIN or the codex-exec it names is missing, unreadable or not executable")
    max_output = int(os.environ.get("LIVE_MAX_OUTPUT_TOKENS", "2048"))
    budget = int(os.environ["LIVE_BUDGET_ATTEMPTS"]) if "LIVE_BUDGET_ATTEMPTS" in os.environ else None
    latest = {row["name"]: row for row in previous}
    if os.environ.get("LIVE_SKIP_ACP") == "1":
        selected = [spec for spec in selected if parse_case(spec)[0] not in ("acp-smoke", "main-cancel", "acp-workflow")]
    manifest = {"codexSha256": hashlib.sha256(codex.read_bytes()).hexdigest(),
                "codexExecSha256": hashlib.sha256(exec_bin.read_bytes()).hexdigest(), "cases": selected}
    (root / "binary-receipt.json").write_text(json.dumps(manifest, indent=2) + "\n")
    observed_usage = []
    print(f"live artifacts: {root}", flush=True)
    gateway = Gateway(SCRIPT_DIR, root, env_file, budget, max_output)

    def env_for(vendor, wire, name):
        home, work = root / f"home-{name}", root / f"work-{name}"
        home.mkdir(exist_ok=True)
        work.mkdir(exist_ok=True)
        env = provider_env(gateway.origin, gateway.token, vendor, wire, home, max_output)
        env.update({"CODEX_PATH": str(codex), "VAL_ROOT": str(work)})
        return env, home, work

    def execute(name, label, vendor, wire, prompt, resume=False, setup=None):
        # A cold recall resumes the session its unsuffixed main-text partner
        # recorded, under the same route suffix when one is pinned.
        session = label.replace("main-cold-recall", "main-text")
        env, home, work = env_for(vendor, wire, session)
        if setup:
            setup(home, work, env)
        command = [str(exec_bin), "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", "-C", str(work)]
        command += ["resume", "--last", prompt] if resume else [prompt]
        result = run_process(command, env, work)
        (root / f"{label}.jsonl").write_text(result.stdout)
        (root / f"{label}.err").write_text(result.stderr)
        parsed = exec_result(result.stdout, result.returncode)
        for event in parsed["events"]:
            if event.get("type") == "turn.completed":
                observed_usage.append({"case": label, **event.get("usage", {})})
        return result, parsed, work

    try:
        for spec in selected:
            name, vendor_override, wire_override = parse_case(spec)
            label = case_label(name, vendor_override, wire_override)
            before = gateway.stats()["used"]
            passed, detail = True, "passed"
            try:
                if name == "env-determinism":
                    local_codex_preflight(SCRIPT_DIR, root, exec_bin)
                    detail = "real Codex reached exact local NUWAX path/model with dummy auth; no real vendor request"
                elif name in ("wire-chat", "wire-anthropic", "wire-responses", "backup-switch-mimo"):
                    vendor, wire = {"wire-chat": ("GLM", "chat"), "wire-anthropic": ("STEP", "anthropic"), "wire-responses": ("GLM", "responses"), "backup-switch-mimo": ("MIMO", "chat")}[name]
                    _, parsed, _ = execute(name, label, vendor, wire, "Reply with exactly the single word: pong")
                    if parsed["answer"].lower().rstrip(".!，。") != "pong":
                        raise ValidationError("final assistant answer was not pong")
                elif name == "main-text":
                    _, parsed, _ = execute(name, label, vendor_override or "GLM", wire_override or "chat", "Remember the secret word LIVE-KIWANO-7 and reply with exactly: OK")
                    if parsed["answer"].upper().rstrip(".!，。") != "OK":
                        raise ValidationError("initial final assistant answer was not OK")
                elif name == "main-cold-recall":
                    _, parsed, _ = execute(name, label, vendor_override or "GLM", wire_override or "chat", "What secret word did I ask you to remember? Reply with just the word.", resume=True)
                    if parsed["answer"].upper().rstrip(".!，。") != "LIVE-KIWANO-7":
                        raise ValidationError("final assistant did not recall the cold-session secret")
                elif name == "main-tool":
                    _, parsed, work = execute(name, label, vendor_override or "GLM", wire_override or "chat", "Create a file named tool-marker.txt containing the text marlin, then reply with exactly: DONE")
                    if not (work / "tool-marker.txt").is_file() or (work / "tool-marker.txt").read_text().strip() != "marlin":
                        raise ValidationError("real tool marker was not created correctly")
                    if parsed["answer"].upper().rstrip(".!，。") != "DONE":
                        raise ValidationError("tool turn did not finish with DONE")
                elif name == "main-screenshot":
                    truth_path = root / f"{label}-shot-truth.jsonl"
                    truth_path.write_text("")
                    def setup(home, _work, env):
                        config = '[mcp_servers.screenshots]\ncommand = "node"\nargs = [' + json.dumps(str(REPO / "scripts/acp-validation/shot-server.mjs")) + ']\n[mcp_servers.screenshots.env]\nSHOT_TRUTH_PATH = ' + json.dumps(str(truth_path)) + '\n'
                        (home / "config.toml").write_text(config)
                        env["SHOT_TRUTH_PATH"] = str(truth_path)
                    result, _, _ = execute(name, label, vendor_override or "GLM", wire_override or "chat", "Call take_screenshot exactly once, then reply with ONLY the dominant color word you see.", setup=setup)
                    truth = [json.loads(line) for line in truth_path.read_text().splitlines() if line.strip()]
                    screenshot_result(result.stdout, result.returncode, truth)
                    detail = "one successful typed MCP image; final assistant matched ground truth"
                elif name in ("main-cancel", "acp-smoke", "acp-workflow", "vision-direct"):
                    wire = wire_override or ("anthropic" if name == "vision-direct" else "chat")
                    env, _, work = env_for(vendor_override or "GLM", wire, label)
                    if name == "vision-direct":
                        ensure_vision_fixtures(SCRIPT_DIR, work / "vision", allow_create=label not in latest)
                        command = [sys.executable, str(SCRIPT_DIR / "vision-direct.py"), str(work), str(exec_bin)]
                        expected = "vision: PASS 3/3"
                    else:
                        helper = {"main-cancel": "acp-live-cancel.ts", "acp-smoke": "acp-live-smoke.ts", "acp-workflow": "acp-live-workflow.ts"}[name]
                        command = ["node", "--import", "tsx", str(SCRIPT_DIR / helper)]
                        expected = "WORKFLOW-PASS" if name == "acp-workflow" else "SMOKE-PASS"
                    result = run_process(command, env, REPO, timeout=1800 if name == "acp-workflow" else 600)
                    (root / f"{label}.log").write_text(result.stdout)
                    (root / f"{label}.err").write_text(result.stderr)
                    if result.returncode or expected not in result.stdout:
                        raise ValidationError("live helper failed; inspect its log")
                else:
                    raise ValidationError("unimplemented live case")
            except (ValidationError, OSError, ValueError) as error:
                passed, detail = False, str(error)
            after = gateway.stats()["used"]
            row = {"name": label, "pass": passed, "detail": detail, "actualAttempts": after - before}
            latest[label] = row
            with (root / "results.jsonl").open("a") as output:
                output.write(json.dumps(row) + "\n")
            print(f"{'PASS' if passed else 'FAIL'} {label}: {detail}; actualAttempts={after - before}", flush=True)
            if gateway.stats()["denied"]:
                break
        deadline = time.monotonic() + 3
        while gateway.stats()["active"] and time.monotonic() < deadline:
            time.sleep(0.1)
        stats = gateway.stats()
        rows = list(latest.values())
        summary = {"attemptsUsed": stats["used"], "budget": stats["limit"], "budgetDenied": stats["denied"], "activeRequests": stats["active"], "passed": sum(bool(row["pass"]) for row in rows), "failed": sum(not row["pass"] for row in rows), "rows": rows, "observedExecUsage": observed_usage}
        (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(f"summary: {summary['passed']} passed / {summary['failed']} failed; real upstream attempts {stats['used']}/{stats['limit']}; denied={stats['denied']}", flush=True)
        return 1 if summary["failed"] or stats["denied"] or stats["active"] else 0
    finally:
        gateway.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValidationError, ValueError, OSError) as error:
        print(f"live validation failed: {error}", file=sys.stderr)
        sys.exit(1)
