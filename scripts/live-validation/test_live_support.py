import http.server
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

from live_support import ValidationError, ensure_vision_fixtures, exec_result, screenshot_result, vision_prompt, provider_env

SCRIPT_DIR = Path(__file__).resolve().parent


def write_fake_exec(path, body):
    """Write a fake `codex exec` that the driver can spawn directly."""
    if os.name == "nt":
        script = path.with_name(path.name + ".py")
        script.write_text(body)
        launcher = path.with_name(path.name + ".cmd")
        launcher.write_text(f'@echo off\r\n"{sys.executable}" "{script}" %*\r\n')
        return launcher
    path.write_text("#!/usr/bin/env python3\n" + body)
    path.chmod(0o755)
    return path


def transcript(answer="red", image=True, terminal=True, failed=False):
    events = [{"type": "item.completed", "item": {"type": "mcp_tool_call", "tool": "take_screenshot", "status": "completed", "result": {"content": [{"type": "text", "text": "screenshot captured"}] + ([{"type": "image", "data": "dummy-base64"}] if image else [])}}}]
    if answer is not None:
        events.append({"type": "item.completed", "item": {"type": "agent_message", "text": answer}})
    if terminal:
        events.append({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}})
    if failed:
        events.append({"type": "error", "message": "failure after an answer"})
    return "\n".join(json.dumps(event) for event in events)


class ProviderEnvironmentContract(unittest.TestCase):
    def test_conflicting_parent_routes_and_secrets_cannot_escape_the_shared_gateway(self):
        origin, token = "http://127.0.0.1:54321", "local-gateway-capability"
        home = Path("/isolated/home")
        overrides = {
            "MODEL_PROVIDER": "paid-direct", "CODEX_CONFIG": '{"model_provider":"paid-direct"}',
            "CODEX_BASE_URL": "https://unmetered.invalid", "CODEX_API_KEY": "private-api-key",
            "CODEX_API_PROTOCOL": "anthropic", "CODEX_WIRE_API": "responses", "CODEX_BRIDGE": "native", "CODEX_PROVIDER_ID": "foreign",
            "CODEX_PROVIDER_NAME": "foreign", "CODEX_MODEL": "foreign-model", "CODEX_MODEL_CONTEXT_WINDOW": "1000000",
            "NUWAX_BASE_URL": "https://another-unmetered.invalid", "NUWAX_API_KEY": "private-nuwax-key",
            "LIVE_FOREIGN_API_KEY": "private-live-key", "OPENAI_API_KEY": "private-openai-key", "ANTHROPIC_API_KEY": "private-anthropic-key",
            "DEFAULT_AUTH_REQUEST": '{"methodId":"api-key","_meta":{"api-key":{"apiKey":"private-auth-key"}}}',
        }
        with mock.patch.dict(os.environ, {**overrides, "CODEX_PATH": "/chosen/codex", "PATH": "/chosen/bin"}, clear=True), mock.patch("live_support.control", return_value={"baseUrl": origin + "/routes/GLM/chat", "model": "test-model"}):
            env = provider_env(origin, token, "GLM", "chat", home, 2048)
        self.assertEqual(env["NUWAX_BASE_URL"], origin + "/routes/GLM/chat")
        self.assertEqual(env["NUWAX_API_KEY"], token)
        self.assertEqual(json.loads(env["DEFAULT_AUTH_REQUEST"])["_meta"]["api-key"]["apiKey"], token)
        self.assertEqual(env["CODEX_PATH"], "/chosen/codex")
        self.assertEqual(env["CODEX_HOME"], str(home))
        self.assertEqual(env["PATH"], "/chosen/bin")
        for key in overrides:
            if key not in ("NUWAX_BASE_URL", "NUWAX_API_KEY", "DEFAULT_AUTH_REQUEST"):
                self.assertNotIn(key, env)
        self.assertNotIn("private-", json.dumps(env))

    def test_declared_vendor_window_reaches_the_child_but_raw_live_keys_do_not(self):
        origin, token = "http://127.0.0.1:54322", "local-gateway-capability"
        parent = {
            "LIVE_WINDOW_GLM": "200000", "LIVE_WINDOW_STEP": "131072",
            "LIVE_GATEWAY_URL": origin, "LIVE_GATEWAY_KEY": "private-gateway-key", "PATH": "/chosen/bin",
        }
        for vendor, expected in (("GLM", "200000"), ("STEP", "131072")):
            with mock.patch.dict(os.environ, parent, clear=True), mock.patch("live_support.control", return_value={"baseUrl": origin + f"/routes/{vendor}/chat", "model": "test-model"}):
                env = provider_env(origin, token, vendor, "chat", Path("/isolated/home"), 2048)
            self.assertEqual(env["CODEX_MODEL_CONTEXT_WINDOW"], expected)
            self.assertNotIn("LIVE_WINDOW_GLM", env)
            # The only key material in the child is the loopback gateway's
            # own capability token; the parent's private value was stripped.
            self.assertEqual(env["LIVE_GATEWAY_KEY"], token)

    def test_unusable_declared_window_fails_instead_of_running_unbudgeted(self):
        origin, token = "http://127.0.0.1:54323", "local-gateway-capability"
        # A mistyped window used to be dropped in silence: the child then ran
        # on Codex's own default while the receipt looked configured.
        unusable = ["not-a-number", "0", "-1", "+200000", "2e5", "131072px", "131 072", "131072.5",
                    "٢٠٠٠", "²", "١٢٣"]
        for declared in unusable:
            with self.subTest(declared=declared), mock.patch.dict(
                os.environ, {"LIVE_WINDOW_GLM": declared, "PATH": "/chosen/bin"}, clear=True
            ), mock.patch("live_support.control", return_value={"baseUrl": origin + "/routes/GLM/chat", "model": "test-model"}):
                with self.assertRaises(ValidationError):
                    provider_env(origin, token, "GLM", "chat", Path("/isolated/home"), 2048)

    def test_padded_declared_window_is_accepted_while_absent_stays_unset(self):
        origin, token = "http://127.0.0.1:54324", "local-gateway-capability"
        for declared, expected in ((chr(9) + " 200000" + chr(10), "200000"), ("", None), (None, None)):
            parent = {"PATH": "/chosen/bin"}
            if declared is not None:
                parent["LIVE_WINDOW_GLM"] = declared
            with self.subTest(declared=declared), mock.patch.dict(os.environ, parent, clear=True), mock.patch(
                "live_support.control", return_value={"baseUrl": origin + "/routes/GLM/chat", "model": "test-model"}
            ):
                env = provider_env(origin, token, "GLM", "chat", Path("/isolated/home"), 2048)
            if expected is None:
                self.assertNotIn("CODEX_MODEL_CONTEXT_WINDOW", env)
            else:
                self.assertEqual(env["CODEX_MODEL_CONTEXT_WINDOW"], expected)


class CaseOverrideContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("live_validation_runner", SCRIPT_DIR / "live-validation.py")
        cls.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runner)

    def test_plain_and_suffixed_specs_parse(self):
        self.assertEqual(self.runner.parse_case("acp-workflow"), ("acp-workflow", None, None))
        self.assertEqual(self.runner.parse_case("acp-workflow@MIMO/chat"), ("acp-workflow", "MIMO", "chat"))
        self.assertEqual(self.runner.parse_case("main-screenshot@STEP/anthropic"), ("main-screenshot", "STEP", "anthropic"))

    def test_fixed_route_cases_and_unknown_or_malformed_specs_fail(self):
        for bad in ("wire-chat@MIMO/chat", "env-determinism@GLM/chat", "backup-switch-mimo@GLM/chat",
                    "acp-workflow@GLMgrpc", "acp-workflow@/chat", "acp-workflow@GLM/", "not-a-case@GLM/chat",
                    "acp-workflow@GLM/CHAT", "acp-workflow@GLM/chat/", "acp-workflow@GLM/chat@", "not-a-case",
                    "", "@GLM/chat"):
            with self.subTest(bad=bad), self.assertRaises(ValidationError, msg=bad):
                self.runner.parse_case(bad)
        self.assertEqual(self.runner.parse_case("wire-chat"), ("wire-chat", None, None))

    def test_vendor_is_normalised_to_the_gateway_identifier(self):
        # The gateway registers routes only as LIVE_<VENDOR>_<WIRE>_URL, so a
        # route that cannot normalise to that identifier must fail at parse.
        self.assertEqual(self.runner.parse_case("main-text@mimo/chat"), ("main-text", "MIMO", "chat"))
        self.assertEqual(self.runner.parse_case("main-text@ LOCAL_V1 /anthropic"), ("main-text", "LOCAL_V1", "anthropic"))
        for bad in ("main-text@GLM MIMO/chat", "main-text@glm-mimo/chat", "main-text@1GLM/chat",
                    "main-text@_GLM/chat", "main-text@中文/chat"):
            with self.subTest(bad=bad), self.assertRaises(ValidationError, msg=bad):
                self.runner.parse_case(bad)

    def test_row_labels_round_trip_back_to_the_same_route(self):
        for spec, label in (("main-text", "main-text"),
                            ("main-text@GLM/chat", "main-text-GLM-chat"),
                            ("acp-workflow@MIMO/anthropic", "acp-workflow-MIMO-anthropic"),
                            ("main-screenshot@ LOCAL_V1 /responses", "main-screenshot-LOCAL_V1-responses"),
                            ("vision-direct@STEP/anthropic", "vision-direct-STEP-anthropic")):
            with self.subTest(spec=spec):
                name, vendor, wire = self.runner.parse_case(spec)
                self.assertEqual(self.runner.case_label(name, vendor, wire), label)
                self.assertEqual(self.runner.case_label(*self.runner.parse_case(self.runner.spec_from_row(label))), label)

    def test_routed_and_plain_row_names_are_told_apart(self):
        # Case names already contain hyphens and one ends in a wire word, so
        # decoding must key off the uppercase vendor segment, not on counting.
        for row in ("wire-chat", "wire-anthropic", "backup-switch-mimo", "env-determinism", "main-cold-recall"):
            with self.subTest(row=row):
                self.assertEqual(self.runner.spec_from_row(row), row)
        self.assertEqual(self.runner.spec_from_row("wire-chat"), "wire-chat")
        self.assertEqual(self.runner.spec_from_row("main-text-GLM-chat"), "main-text@GLM/chat")


class CaseSelectionContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("live_validation_runner", SCRIPT_DIR / "live-validation.py")
        cls.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runner)

    def test_default_and_named_selection_keeps_the_declared_order(self):
        self.assertEqual(self.runner.select_specs(None, False, []), list(self.runner.CASES))
        self.assertEqual(self.runner.select_specs("main-tool,wire-chat", False, []), ["main-tool", "wire-chat"])
        self.assertEqual(self.runner.select_specs("main-text@GLM/chat,main-text@GLM/responses", False, []),
                         ["main-text@GLM/chat", "main-text@GLM/responses"])

    def test_one_route_written_two_ways_is_rejected_before_any_paid_attempt(self):
        # Both spellings collapse to one row label, so running them would spend
        # a second paid attempt and let the later row overwrite the first.
        for cases in ("main-text@GLM/chat,main-text@glm/chat", "main-text@ GLM /chat,main-text@GLM/chat",
                      "main-text,main-text", "acp-workflow@MIMO/anthropic,acp-workflow@mimo/anthropic"):
            with self.subTest(cases=cases), self.assertRaises(ValidationError, msg=cases):
                self.runner.select_specs(cases, False, [])

    def test_only_failed_replays_recorded_routed_rows_not_the_default_suite(self):
        previous = [{"name": "main-text-GLM-chat", "pass": True},
                    {"name": "acp-workflow-MIMO-anthropic", "pass": False},
                    {"name": "vision-direct", "pass": False}]
        self.assertEqual(self.runner.select_specs(None, True, previous),
                         ["acp-workflow@MIMO/anthropic", "vision-direct"])

    def test_a_named_fixup_narrows_to_that_case_across_its_recorded_routes(self):
        previous = [{"name": "main-screenshot-STEP-anthropic", "pass": False},
                    {"name": "main-screenshot", "pass": False},
                    {"name": "acp-workflow-MIMO-anthropic", "pass": True}]
        self.assertEqual(self.runner.select_specs("main-screenshot", True, previous),
                         ["main-screenshot@STEP/anthropic", "main-screenshot"])
        # Naming an already-passing case has nothing to retry.
        self.assertEqual(self.runner.select_specs("acp-workflow", True, previous), [])

    def test_only_failed_needs_a_recorded_result_and_an_unknown_row_fails_loud(self):
        with self.assertRaises(ValidationError):
            self.runner.select_specs(None, True, [])
        with self.assertRaises(ValidationError):
            self.runner.select_specs(None, True, [{"name": "legacy-manual-row", "pass": False}])
        with self.assertRaises(ValidationError):
            self.runner.select_specs("not-a-case", False, [])

    def test_failed_rows_are_deduplicated_the_same_way(self):
        previous = [{"name": "main-tool-GLM-chat", "pass": False}, {"name": "main-tool-glm-chat", "pass": False}]
        with self.assertRaises(ValidationError):
            self.runner.select_specs(None, True, previous)


class FinalAnswerContract(unittest.TestCase):
    truth = [{"event": "complete", "color": "red", "mcpCallId": 1}]

    def test_correct_final_color_with_a_typed_completed_tool_passes(self):
        self.assertEqual(screenshot_result(transcript(), 0, self.truth)["answer"], "red")

    def test_captured_substring_cannot_make_a_blue_final_answer_red(self):
        with self.assertRaises(ValidationError):
            screenshot_result(transcript(answer="blue"), 0, self.truth)

    def test_exit_error_missing_terminal_missing_answer_and_missing_image_fail(self):
        for output, rc in [(transcript(), 1), (transcript(terminal=False), 0), (transcript(answer=None), 0), (transcript(image=False), 0), (transcript(failed=True), 0)]:
            with self.subTest(output=output, rc=rc), self.assertRaises(ValidationError):
                screenshot_result(output, rc, self.truth)

    def test_ground_truth_missing_or_multiple_does_not_pass(self):
        for truth in ([], self.truth * 2):
            with self.subTest(truth=truth), self.assertRaises(ValidationError):
                screenshot_result(transcript(), 0, truth)

    def test_only_last_completed_assistant_answer_is_scored(self):
        output = json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "red"}}) + "\n" + transcript(answer="blue")
        self.assertEqual(exec_result(output, 0)["answer"], "blue")
        with self.assertRaises(ValidationError):
            screenshot_result(output, 0, self.truth)


class GatewayShutdownContract(unittest.TestCase):
    def test_a_finished_run_releases_the_ledger_lock_the_next_process_needs(self):
        # Killing the gateway leaves request-ledger.jsonl.lock behind whenever
        # shutdown is not cooperative. On Windows terminate() is
        # TerminateProcess, so node never ran its SIGTERM handler and every
        # later --resume on the same run directory failed closed while the
        # driver reported the previous run's summary as if it were fresh.
        with tempfile.TemporaryDirectory(prefix="live-gateway-shutdown-") as directory:
            root = Path(directory)
            env_file = root / "dummy.env"
            env_file.write_text("LIVE_GLM_CHAT_URL=http://127.0.0.1:1/v1\nLIVE_GLM_MODEL=test\nLIVE_GLM_API_KEY=dummy-key\n")
            fake = write_fake_exec(root / "fake-exec", '''
import json, os, urllib.request, urllib.error
for n in range(2):
    request = urllib.request.Request(os.environ['NUWAX_BASE_URL'] + '/chat/completions', data=b'{}', headers={'authorization': 'Bearer ' + os.environ['NUWAX_API_KEY']})
    try: urllib.request.urlopen(request).read()
    except Exception: pass
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'pong'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
''')
            run = root / "run"
            env = {**os.environ, "VAL_ROOT": str(run), "LIVE_ENV_FILE": str(env_file),
                   "LIVE_BUDGET_ATTEMPTS": "2", "CODEX_BIN": str(fake), "CODEX_EXEC_BIN": str(fake)}
            command = [sys.executable, str(SCRIPT_DIR / "live-validation.py"), "--cases", "wire-chat"]
            lock = run / "request-ledger.jsonl.lock"
            first = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertFalse(lock.exists(), "a finished run must not keep the ledger locked")
            resumed = subprocess.run([sys.executable, str(SCRIPT_DIR / "live-validation.py"), "--resume"],
                                     env=env, capture_output=True, text=True, timeout=60)
            self.assertNotIn("could not start", resumed.stderr,
                             "a resume must reach the gateway, not reuse the previous summary")
            self.assertEqual(resumed.returncode, 1, resumed.stdout + resumed.stderr)
            summary = json.loads((run / "summary.json").read_text())
            self.assertGreaterEqual(summary["budgetDenied"], 1, "the exhausted budget must charge the resumed attempts")
            self.assertEqual(summary["attemptsUsed"], 2, "a denied attempt never reaches the upstream, so it is not billed as used")
            self.assertFalse(lock.exists(), "the resumed run must release the lock too")


class ExecutableReceiptContract(unittest.TestCase):
    def test_codex_binary_must_be_named_explicitly_instead_of_a_stale_default(self):
        # The old built-in default pointed at an abandoned merge worktree. On a
        # machine where that path still exists it silently validated (and hashed)
        # a pre-fix binary; elsewhere it failed with a message naming the wrong
        # file. The receipt must bind the binary the operator actually built.
        with tempfile.TemporaryDirectory(prefix="live-runner-test-") as directory:
            root = Path(directory)
            env_file = root / "dummy.env"
            env_file.write_text("LIVE_GLM_CHAT_URL=http://127.0.0.1:1/v1\nLIVE_GLM_MODEL=test\nLIVE_GLM_API_KEY=dummy-key\n")
            env = {**os.environ, "VAL_ROOT": str(root / "run"), "LIVE_ENV_FILE": str(env_file),
                   "LIVE_BUDGET_ATTEMPTS": "1"}
            for key in ("CODEX_BIN", "CODEX_EXEC_BIN"):
                env.pop(key, None)
            completed = subprocess.run([sys.executable, str(SCRIPT_DIR / "live-validation.py"), "--cases", "main-text"],
                                       env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(completed.returncode, 1)
            self.assertIn("CODEX_BIN", completed.stderr)
            self.assertNotIn("merge-main-20261014", completed.stderr + completed.stdout)

    def test_receipt_always_hashes_both_executables_the_run_drives(self):
        # A receipt that silently omits the CLI hash cannot be bound to a build.
        with tempfile.TemporaryDirectory(prefix="live-runner-test-") as directory:
            root = Path(directory)
            env_file = root / "dummy.env"
            env_file.write_text("LIVE_GLM_CHAT_URL=http://127.0.0.1:1/v1\nLIVE_GLM_MODEL=test\nLIVE_GLM_API_KEY=dummy-key\n")
            fake = write_fake_exec(root / "fake-exec", '''
import json
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'pong'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
''')
            env = {**os.environ, "VAL_ROOT": str(root / "run"), "LIVE_ENV_FILE": str(env_file),
                   "LIVE_BUDGET_ATTEMPTS": "1", "CODEX_BIN": str(fake), "CODEX_EXEC_BIN": str(fake)}
            completed = subprocess.run([sys.executable, str(SCRIPT_DIR / "live-validation.py"), "--cases", "wire-chat"],
                                       env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            receipt = json.loads((root / "run" / "binary-receipt.json").read_text())
            self.assertEqual(set(receipt), {"codexSha256", "codexExecSha256", "cases"})
            self.assertEqual(receipt["codexSha256"], hashlib.sha256(fake.read_bytes()).hexdigest())
            self.assertEqual(receipt["cases"], ["wire-chat"])


class WholeRunnerBudgetContract(unittest.TestCase):
    def test_real_http_attempts_not_nominal_flows_decide_budget_and_resume(self):
        with tempfile.TemporaryDirectory(prefix="live-runner-test-") as directory:
            root = Path(directory)
            calls = []
            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def do_POST(self):
                    self.rfile.read(int(self.headers.get("content-length", 0)))
                    calls.append(self.path)
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"ok")
            server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            env_file = root / "dummy.env"
            env_file.write_text(f"LIVE_GLM_CHAT_URL=http://127.0.0.1:{server.server_port}/v1\nLIVE_GLM_MODEL=test\nLIVE_GLM_API_KEY=dummy-key\n")
            # Intentionally ignores a refusal and still reports success. The
            # outer run MUST fail because the shared gateway denied an attempt.
            fake = write_fake_exec(root / "fake-exec", '''
import json, os, urllib.request, urllib.error
for n in range(3):
    request = urllib.request.Request(os.environ['NUWAX_BASE_URL'] + '/chat/completions', data=b'{}', headers={'authorization': 'Bearer ' + os.environ['NUWAX_API_KEY']})
    try: urllib.request.urlopen(request).read()
    except urllib.error.HTTPError: pass
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'pong'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
''')
            try:
                for budget in (2, 3):
                    run_root = root / str(budget)
                    env = {**os.environ, "VAL_ROOT": str(run_root), "LIVE_ENV_FILE": str(env_file), "LIVE_BUDGET_ATTEMPTS": str(budget), "CODEX_EXEC_BIN": str(fake), "CODEX_BIN": str(fake)}
                    command = [sys.executable, str(SCRIPT_DIR / "live-validation.py"), "--cases", "wire-chat"]
                    completed = subprocess.run(command, env=env, capture_output=True, text=True, timeout=20)
                    self.assertEqual(completed.returncode, 1 if budget == 2 else 0, completed.stdout + completed.stderr)
                    summary = json.loads((run_root / "summary.json").read_text())
                    self.assertEqual(summary["attemptsUsed"], budget)
                    self.assertEqual(summary["budgetDenied"], 1 if budget == 2 else 0)
                    if budget == 3:
                        resumed = subprocess.run(command + ["--resume"], env=env, capture_output=True, text=True, timeout=20)
                        self.assertEqual(resumed.returncode, 1, resumed.stdout + resumed.stderr)
                        summary = json.loads((run_root / "summary.json").read_text())
                        self.assertEqual(summary["attemptsUsed"], 3)
                        self.assertEqual(summary["budgetDenied"], 3)
                self.assertEqual(len(calls), 5, "only the two admitted budgets reached the local upstream")
            finally:
                server.shutdown()
                server.server_close()


class RoutedFixupRunContract(unittest.TestCase):
    def test_fixup_without_cases_replays_only_the_recorded_routed_failure(self):
        # live-fixup.sh passes --resume --only-failed with no --cases. The
        # candidate set used to be the default suite, so a routed failure named
        # main-text-GLM-chat was "retried" as thirteen plain GLM/chat cases:
        # new labels, new paid attempts, rows the run never asked for.
        with tempfile.TemporaryDirectory(prefix="live-runner-test-") as directory:
            root = Path(directory)
            calls = []

            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def do_POST(self):
                    self.rfile.read(int(self.headers.get("content-length", 0)))
                    calls.append(self.path)
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"ok")

            server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            env_file = root / "dummy.env"
            env_file.write_text(f"LIVE_GLM_CHAT_URL=http://127.0.0.1:{server.server_port}/v1\nLIVE_GLM_MODEL=test\nLIVE_GLM_API_KEY=dummy-key\n")
            # Two charged attempts, then a final answer that fails the case.
            fake = write_fake_exec(root / "fake-exec", '''
import json, os, urllib.request
for n in range(2):
    request = urllib.request.Request(os.environ['NUWAX_BASE_URL'] + '/chat/completions', data=b'{}', headers={'authorization': 'Bearer ' + os.environ['NUWAX_API_KEY']})
    try: urllib.request.urlopen(request).read()
    except Exception: pass
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'wrong answer'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
''')
            run_root = root / "run"
            env = {**os.environ, "VAL_ROOT": str(run_root), "LIVE_ENV_FILE": str(env_file),
                   "LIVE_BUDGET_ATTEMPTS": "2", "CODEX_EXEC_BIN": str(fake), "CODEX_BIN": str(fake)}
            try:
                first = subprocess.run([sys.executable, str(SCRIPT_DIR / "live-validation.py"), "--cases", "main-text@GLM/chat"],
                                       env=env, capture_output=True, text=True, timeout=60)
                self.assertEqual(first.returncode, 1, first.stdout + first.stderr)
                rows = [json.loads(line) for line in (run_root / "results.jsonl").read_text().splitlines() if line.strip()]
                self.assertEqual([row["name"] for row in rows], ["main-text-GLM-chat"])
                self.assertFalse(rows[0]["pass"])
                self.assertEqual(json.loads((run_root / "binary-receipt.json").read_text())["cases"], ["main-text@GLM/chat"])
                used_after_first = len(calls)
                fixup = subprocess.run([sys.executable, str(SCRIPT_DIR / "live-validation.py"), "--resume", "--only-failed"],
                                       env=env, capture_output=True, text=True, timeout=120)
                self.assertEqual(json.loads((run_root / "binary-receipt.json").read_text())["cases"], ["main-text@GLM/chat"],
                                 "the fixup must name the recorded routed case, not the default suite")
                rows = [json.loads(line) for line in (run_root / "results.jsonl").read_text().splitlines() if line.strip()]
                self.assertEqual({row["name"] for row in rows}, {"main-text-GLM-chat"},
                                 "a fixup may not add rows for cases this run never selected")
                summary = json.loads((run_root / "summary.json").read_text())
                self.assertEqual(summary["attemptsUsed"], used_after_first)
                self.assertGreaterEqual(summary["budgetDenied"], 1)
            finally:
                server.shutdown()
                server.server_close()


class VisionFixtureContract(unittest.TestCase):
    def make_fixture(self, directory):
        vision = Path(directory) / "vision"
        subprocess.run([sys.executable, str(SCRIPT_DIR / "gen-vision-images.py"), str(vision), "3", "438073469"], check=True, capture_output=True)
        return vision

    def test_existing_failed_seed_and_image_bytes_are_reused_without_generation(self):
        with tempfile.TemporaryDirectory(prefix="vision-reuse-") as directory:
            vision = self.make_fixture(directory)
            before = {file.name: (file.read_bytes(), file.stat().st_mtime_ns) for file in vision.iterdir()}
            with mock.patch("live_support.subprocess.run", side_effect=AssertionError("must not regenerate existing images")):
                self.assertEqual(ensure_vision_fixtures(SCRIPT_DIR, vision)["seed"], 438073469)
            after = {file.name: (file.read_bytes(), file.stat().st_mtime_ns) for file in vision.iterdir()}
            self.assertEqual(after, before)

    def test_missing_truth_png_or_entire_retry_directory_fails_without_regeneration(self):
        for damage in ("truth.json", "vision-0.png", "all"):
            with self.subTest(damage=damage), tempfile.TemporaryDirectory(prefix="vision-damage-") as directory:
                vision = self.make_fixture(directory)
                if damage == "all":
                    for file in vision.iterdir():
                        file.unlink()
                    vision.rmdir()
                else:
                    (vision / damage).unlink()
                with mock.patch("live_support.subprocess.run", side_effect=AssertionError("must not replace a damaged failure sample")), self.assertRaises(ValidationError):
                    ensure_vision_fixtures(SCRIPT_DIR, vision)

    def test_changed_png_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="vision-corrupt-") as directory:
            vision = self.make_fixture(directory)
            (vision / "vision-0.png").write_bytes(b"\x89PNG\r\n\x1a\ncorrupt")
            with self.assertRaises(ValidationError):
                ensure_vision_fixtures(SCRIPT_DIR, vision)

    def test_prompt_asks_for_background_without_digit_or_color_answers(self):
        prompt = vision_prompt("vision-0.png")
        self.assertIn("dominant background color", prompt)
        self.assertIn("digit=<d> color=<c>", prompt)
        self.assertNotIn("438073469", prompt)
        for color in ("red", "green", "blue", "yellow", "purple", "cyan", "white"):
            self.assertNotIn(color, prompt.lower())
        for digit in "0123456789":
            self.assertNotIn("digit=" + digit, prompt)


if __name__ == "__main__":
    unittest.main()
