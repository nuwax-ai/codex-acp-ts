#!/usr/bin/env python3
"""Small GLM Responses acceptance on the native Codex transport, without rig.

Vendor credentials remain inside the existing shared budget gateway. No failed
case is automatically rerun. Supply freshly built binaries and their hashes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time

from live_support import Gateway, ValidationError, exec_result, provider_env, run_process

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent.parent


def bounded_budget(raw):
    try:
        value = int(raw)
    except (ValueError, TypeError) as error:
        raise argparse.ArgumentTypeError("budget must be an integer from 1 to 24") from error
    if not 1 <= value <= 24:
        raise argparse.ArgumentTypeError("budget must be from 1 to 24")
    return value


def checked_binary(path, expected):
    path = Path(path).resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValidationError("candidate binary is not an executable file")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValidationError("candidate binary SHA-256 differs from the supplied build receipt")
    return path


def native_env(gateway, home, max_output):
    env = provider_env(gateway.origin, gateway.token, "GLM", "responses", home, max_output)
    expected = gateway.origin.rstrip("/") + "/routes/GLM/responses"
    if env.get("NUWAX_BASE_URL") != expected or env.get("NUWAX_API_KEY") != gateway.token:
        raise ValidationError("native acceptance must use the authenticated loopback gateway")
    # CODEX_BRIDGE belongs to the separate ACP environment-gateway entry.
    # An inherited selector must not create that gateway or shadow NUWAX.
    env.pop("CODEX_BRIDGE", None)
    env.update({"NUWAX_BRIDGE": "native", "NUWAX_WIRE_API": "responses",
                "NUWAX_REQUEST_MAX_RETRIES": "0", "NUWAX_STREAM_MAX_RETRIES": "0"})
    return env


def observed_usage(parsed):
    usage = [event.get("usage") for event in parsed["events"] if event.get("type") == "turn.completed"]
    if not usage or any(not isinstance(value, dict) for value in usage):
        raise ValidationError("completed turn omitted structured usage")
    for value in usage:
        for name in ("input_tokens", "output_tokens"):
            if type(value.get(name)) is not int or value[name] < 0:
                raise ValidationError("native turn usage omitted a nonnegative integer token field")
    return usage


def assert_answer(parsed, expected):
    if parsed["answer"].strip().rstrip(".!，。") != expected:
        raise ValidationError("final assistant answer differs from the scenario's exact expected value")


def assert_tool_marker(parsed, marker, value):
    if not marker.is_file() or marker.read_text().strip() != value:
        raise ValidationError("real tool did not create the fresh randomized marker correctly")
    tool_items = [item for item in parsed["items"] if item.get("type") in ("command_execution", "file_change")]
    if not any(item.get("status") == "completed" for item in tool_items):
        raise ValidationError("marker exists without a completed real command/file tool event")
    assert_answer(parsed, "DONE")


def group_gone(pid, timeout=5):
    deadline = time.monotonic() + timeout
    while True:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def archived_process(command, env, cwd, root, name, timeout):
    """Preserve stdout/stderr even if run_process raises on its deadline."""
    pid_file, stdout_file, stderr_file = (root / f"{name}{suffix}" for suffix in (".pid", ".jsonl", ".stderr"))
    shell = shutil.which("sh")
    if not shell:
        raise ValidationError("a POSIX sh is required for the owned process-group receipt")
    wrapper = [shell, "-c", 'receipt_pid=$1; receipt_out=$2; receipt_err=$3; shift 3; printf "%s\\n" "$$" > "$receipt_pid"; exec "$@" > "$receipt_out" 2> "$receipt_err"',
               "native-acceptance", str(pid_file), str(stdout_file), str(stderr_file), *command]
    outcome, failure, cleanup_failure = None, None, None
    try:
        outcome = run_process(wrapper, env, cwd, timeout=timeout)
    except (ValidationError, OSError) as error:
        failure = error
    finally:
        if pid_file.exists() and not group_gone(int(pid_file.read_text().strip())):
            cleanup_failure = "owned validation process group still exists after cleanup"
    if failure is not None:
        raise ValidationError(str(failure) + (f"; {cleanup_failure}" if cleanup_failure else "")) from failure
    if cleanup_failure:
        raise ValidationError(cleanup_failure)
    if outcome is None:
        raise ValidationError("validation subprocess did not produce an exit status")
    return subprocess.CompletedProcess(command, outcome.returncode,
                                       stdout_file.read_text() if stdout_file.exists() else "",
                                       stderr_file.read_text() if stderr_file.exists() else "")


def settle_gateway(gateway):
    """Always close the owned gateway; retain cleanup errors separately."""
    stats, errors = None, []
    try:
        deadline = time.monotonic() + 5
        stats = gateway.stats()
        while stats["active"] and time.monotonic() < deadline:
            time.sleep(0.1)
            stats = gateway.stats()
    except (ValidationError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        errors.append(f"gateway final stats failed: {error}")
    finally:
        try:
            gateway.close()
        except (ValidationError, OSError, ValueError, subprocess.SubprocessError) as error:
            errors.append(f"gateway close failed: {error}")
    return stats, errors


def audit_attempt_ledger(rows, used):
    if any(not isinstance(row, dict) for row in rows):
        return False
    admitted = [row for row in rows if row.get("kind") == "admitted"]
    return type(used) is int and used > 0 and len(admitted) == used and all(row.get("vendor") == "GLM" and row.get("wire") == "responses" for row in admitted)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="new artifact directory on the external drive")
    parser.add_argument("--env-file", required=True, type=Path, help="protected existing vendor configuration, read only by Gateway")
    parser.add_argument("--source-repo", required=True, type=Path)
    parser.add_argument("--codex", required=True, type=Path)
    parser.add_argument("--codex-exec", required=True, type=Path)
    parser.add_argument("--expected-codex-sha256", required=True)
    parser.add_argument("--expected-exec-sha256", required=True)
    parser.add_argument("--budget", type=bounded_budget, default=16)
    parser.add_argument("--acp-cancel", action="store_true", help="also require streamed ACP cancel and successful continuation")
    args = parser.parse_args(argv)
    if os.name == "nt":
        raise ValidationError("this small process-group acceptance is for Linux/macOS; no Windows workspace run")
    root = args.root.resolve()
    if not str(root).startswith("/Volumes/") and not str(root).startswith("/mnt/"):
        raise ValidationError("choose the external-drive artifact root under /Volumes or /mnt")
    if root.exists():
        raise ValidationError("artifact root already exists; preserve the previous run instead of overwriting or retrying it")
    os.umask(0o077)
    codex = checked_binary(args.codex, args.expected_codex_sha256)
    exec_bin = checked_binary(args.codex_exec, args.expected_exec_sha256)
    if not args.env_file.is_file():
        raise ValidationError("protected vendor configuration file is missing")
    source_head = subprocess.check_output(["git", "-C", str(args.source_repo), "rev-parse", "HEAD"], text=True).strip()
    receipt_process = subprocess.run([str(exec_bin), "--build-receipt"], capture_output=True, text=True, timeout=15)
    if receipt_process.returncode:
        raise ValidationError("codex-exec did not return its build receipt")
    receipt = json.loads(receipt_process.stdout)
    if receipt.get("git_sha") != source_head:
        raise ValidationError("codex-exec build receipt is from a different source HEAD")
    root.mkdir(parents=True)
    (root / "binary-receipt.json").write_text(json.dumps({"sourceHead": source_head, "codexSha256": args.expected_codex_sha256,
        "codexExecSha256": args.expected_exec_sha256, "execBuildReceipt": receipt}, indent=2) + "\n")
    home, work = root / "home", root / "work"
    home.mkdir(); work.mkdir()
    capture = root / "rig-requests.jsonl"
    nonce = "NATIVE-" + secrets.token_hex(8)
    marker_name, marker_value = "marker-" + secrets.token_hex(5) + ".txt", secrets.token_hex(8)
    gateway = Gateway(SCRIPT_DIR, root, args.env_file, args.budget, max_output=2048)
    rows, thread_id, fatal, stats, selected_model = [], None, None, None, None
    cases = ["text", "tool", "cold-resume"] + (["acp-cancel-continuation"] if args.acp_cancel else [])
    try:
        env = native_env(gateway, home, 2048)
        selected_model = env.get("NUWAX_MODEL")
        if not isinstance(selected_model, str) or not selected_model:
            raise ValidationError("gateway did not select a concrete model id")
        env.update({"CODEX_PATH": str(codex), "CODEX_RIG_REQUEST_CAPTURE_FILE": str(capture), "VAL_ROOT": str(root / "acp")})
        for name in cases:
            before = gateway.stats()["used"]
            row = {"name": name, "pass": False}
            try:
                if name == "acp-cancel-continuation":
                    (root / "acp").mkdir()
                    result = archived_process(["node", "--import", "tsx", str(SCRIPT_DIR / "acp-live-cancel.ts")], env, REPO, root, name, 600)
                    if result.returncode or "SMOKE-PASS" not in result.stdout or "CONTINUATION-PASS" not in result.stdout:
                        raise ValidationError("ACP live cancel/continuation helper failed its two explicit contracts")
                else:
                    prompt = {"text": f"Remember this exact nonce for this conversation: {nonce}. Reply with exactly: OK",
                              "tool": f"Use an actual tool to create {marker_name} in the working directory containing exactly {marker_value}. Then reply with exactly: DONE",
                              "cold-resume": "What exact nonce did I ask you to remember at the start? Reply with only that nonce."}[name]
                    command = [str(exec_bin), "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", "-C", str(work)]
                    command += [prompt] if name == "text" else ["resume", thread_id, prompt]
                    result = archived_process(command, env, work, root, name, 240)
                    parsed = exec_result(result.stdout, result.returncode)
                    row["usage"] = observed_usage(parsed)
                    if name == "text":
                        assert_answer(parsed, "OK")
                        started = [event.get("thread_id") for event in parsed["events"] if event.get("type") == "thread.started"]
                        if len(started) != 1 or not isinstance(started[0], str) or not started[0]:
                            raise ValidationError("initial process did not identify exactly one persisted thread")
                        thread_id = started[0]
                    elif name == "tool":
                        assert_tool_marker(parsed, work / marker_name, marker_value)
                    else:
                        assert_answer(parsed, nonce)
                after = gateway.stats()["used"]
                if after <= before:
                    raise ValidationError("case completed without a real upstream attempt")
                if capture.exists() and capture.stat().st_size:
                    raise ValidationError("native transport unexpectedly created rig capture entries")
                row.update({"pass": True, "detail": "passed", "ownedProcessGroupGone": True})
            except (ValidationError, OSError, ValueError) as error:
                row["detail"] = str(error)
            try:
                row["actualAttempts"] = gateway.stats()["used"] - before
            except (ValidationError, OSError, ValueError) as error:
                row["statsError"] = str(error)
                if row["pass"]:
                    row.update({"pass": False, "detail": "gateway attempt receipt unavailable after case"})
                row["actualAttempts"] = None
            rows.append(row)
            with (root / "results.jsonl").open("a") as output:
                output.write(json.dumps(row) + "\n")
            print(f"{'PASS' if row['pass'] else 'FAIL'} {name}: {row['detail']}; attempts={row['actualAttempts']}", flush=True)
            if not row["pass"]:
                break  # Preserve the first failure, without retrying later dependencies.
    except (ValidationError, OSError, ValueError) as error:
        fatal = str(error)
    finally:
        stats, cleanup_errors = settle_gateway(gateway)
        evidence_error, rig_entries, route_ok = None, None, False
        try:
            rig_entries = capture.exists() and capture.stat().st_size > 0
            ledger = [json.loads(line) for line in (root / "request-ledger.jsonl").read_text().splitlines() if line.strip()] if (root / "request-ledger.jsonl").exists() else []
            route_ok = stats is not None and audit_attempt_ledger(ledger, stats["used"])
        except (OSError, ValueError, KeyError) as error:
            evidence_error = str(error)
        passed = not fatal and not cleanup_errors and not evidence_error and len(rows) == len(cases) and all(row["pass"] for row in rows) and stats is not None and stats["used"] > 0 and not stats["denied"] and not stats["active"] and rig_entries is False and route_ok and gateway.process.poll() == 0
        summary = {"pass": passed, "provider": "GLM", "model": selected_model, "wire": "responses", "bridge": "native", "officialGptVerified": False,
                   "sourceHead": source_head, "rows": rows, "fatal": fatal, "gateway": stats,
                   "cleanupErrors": cleanup_errors, "evidenceError": evidence_error,
                   "rigCaptureEntries": 0 if rig_entries is False else "unverified-or-unexpected", "gatewayExited": gateway.process.poll() == 0,
                   "routeVerified": route_ok}
        (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"native GLM Responses: {'PASS' if passed else 'FAIL'}; upstream={(stats or {}).get('used', 'unverified')}/{args.budget}; artifacts={root}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValidationError, ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"native acceptance failed: {error}", file=sys.stderr)
        sys.exit(1)
