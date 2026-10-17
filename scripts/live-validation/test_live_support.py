import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

from live_support import ValidationError, ensure_vision_fixtures, exec_result, screenshot_result, vision_prompt

SCRIPT_DIR = Path(__file__).resolve().parent


def transcript(answer="red", image=True, terminal=True, failed=False):
    events = [{"type": "item.completed", "item": {"type": "mcp_tool_call", "tool": "take_screenshot", "status": "completed", "result": {"content": [{"type": "text", "text": "screenshot captured"}] + ([{"type": "image", "data": "dummy-base64"}] if image else [])}}}]
    if answer is not None:
        events.append({"type": "item.completed", "item": {"type": "agent_message", "text": answer}})
    if terminal:
        events.append({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}})
    if failed:
        events.append({"type": "error", "message": "failure after an answer"})
    return "\n".join(json.dumps(event) for event in events)


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
            fake = root / "fake-exec"
            # Intentionally ignores a refusal and still reports success. The
            # outer run MUST fail because the shared gateway denied an attempt.
            fake.write_text('''#!/usr/bin/env python3
import json, os, urllib.request, urllib.error
for n in range(3):
    request = urllib.request.Request(os.environ['NUWAX_BASE_URL'] + '/chat/completions', data=b'{}', headers={'authorization': 'Bearer ' + os.environ['NUWAX_API_KEY']})
    try: urllib.request.urlopen(request).read()
    except urllib.error.HTTPError: pass
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'pong'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
''')
            fake.chmod(0o755)
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
