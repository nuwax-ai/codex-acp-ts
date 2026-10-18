#!/usr/bin/env python3
"""Real-model acceptance; every subprocess uses one shared request gateway."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time

from live_support import Gateway, ValidationError, ensure_vision_fixtures, exec_result, local_codex_preflight, provider_env, run_process, screenshot_result

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent.parent
DEFAULT_CODEX = "/Volumes/soddy/git_workspace/fork-nuwax-codex/.claude/worktrees/merge-main-20261014/codex-rs/target/debug/codex"
CASES = ("env-determinism", "wire-chat", "wire-anthropic", "wire-responses", "backup-switch-mimo", "main-text", "main-cold-recall", "main-tool", "main-cancel", "main-screenshot", "vision-direct", "acp-smoke", "acp-workflow")
# Cases whose vendor/wire is fixed by their definition reject an override.
OVERRIDE_REJECTED = ("env-determinism", "wire-chat", "wire-anthropic", "wire-responses", "backup-switch-mimo")


def parse_case(spec):
    """`name` keeps its default route; `name@VENDOR/wire` pins it explicitly.

    The suffixed form exists so the same scenario (for example the full
    acp-workflow loop) can run against several vendors in one shared-budget
    run without reusing a previous round's receipts.
    """
    if "@" not in spec:
        return spec, None, None
    name, route = spec.split("@", 1)
    vendor, _, wire = route.partition("/")
    if name in OVERRIDE_REJECTED or name not in CASES:
        raise ValidationError(f"case {name} does not accept a vendor/wire override")
    if not vendor or wire not in ("chat", "responses", "anthropic"):
        raise ValidationError(f"invalid vendor/wire override: {route}")
    return name, vendor.upper(), wire


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", default=",".join(CASES), help="comma-separated case names; use --list to inspect")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--only-failed", action="store_true")
    args = parser.parse_args()
    if args.list:
        print("\n".join(CASES))
        return 0
    selected = args.cases.split(",")
    parsed = [parse_case(spec) for spec in selected]
    names = [name for name, _, _ in parsed]
    if not names or any(name not in CASES for name in names) or len(set(selected)) != len(selected):
        raise ValidationError("unknown or duplicate live case; use --list")

    def row_name(spec):
        name, vendor, wire = parse_case(spec)
        return name if vendor is None else f"{name}-{vendor}-{wire}"
    root = Path(os.environ.get("VAL_ROOT") or tempfile.mkdtemp(prefix="acp-live-val.")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    ledger = root / "request-ledger.jsonl"
    if args.resume and not ledger.exists():
        raise ValidationError("cannot resume a legacy/manual attempt ledger; start a new gateway-backed run")
    if not args.resume and ledger.exists():
        raise ValidationError("run already has a shared budget; use --resume or a new VAL_ROOT")
    env_file = Path(os.environ.get("LIVE_ENV_FILE", "/Volumes/soddy/git_workspace/fork-nuwax-codex/.env.local"))
    codex = Path(os.environ.get("CODEX_BIN", DEFAULT_CODEX))
    exec_bin = Path(os.environ.get("CODEX_EXEC_BIN", str(codex) + "-exec"))
    if not env_file.is_file() or not exec_bin.is_file() or not os.access(exec_bin, os.X_OK):
        raise ValidationError("credential env file or executable codex-exec is missing")
    max_output = int(os.environ.get("LIVE_MAX_OUTPUT_TOKENS", "2048"))
    budget = int(os.environ["LIVE_BUDGET_ATTEMPTS"]) if "LIVE_BUDGET_ATTEMPTS" in os.environ else None
    previous = [json.loads(line) for line in (root / "results.jsonl").read_text().splitlines() if line.strip()] if (root / "results.jsonl").exists() else []
    latest = {row["name"]: row for row in previous}
    if args.only_failed:
        selected = [spec for spec in selected if not latest.get(row_name(spec), {}).get("pass")]
    if os.environ.get("LIVE_SKIP_ACP") == "1":
        selected = [spec for spec in selected if parse_case(spec)[0] not in ("acp-smoke", "main-cancel", "acp-workflow")]
    manifest = {"codexExecSha256": hashlib.sha256(exec_bin.read_bytes()).hexdigest(), "cases": selected}
    if codex.is_file():
        manifest["codexSha256"] = hashlib.sha256(codex.read_bytes()).hexdigest()
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
            label = row_name(spec)
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
