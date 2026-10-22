import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from live_support import ValidationError, control

spec = importlib.util.spec_from_file_location("native_responses_acceptance", Path(__file__).with_name("native-responses-acceptance.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeAcceptanceContracts(unittest.TestCase):
    def test_small_budget_refuses_unbounded_or_invalid_values(self):
        self.assertEqual(native.bounded_budget("16"), 16)
        self.assertEqual(native.bounded_budget("24"), 24)
        for value in ("0", "25", "-1", "many", "1.5"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                native.bounded_budget(value)

    def test_binary_receipt_mismatch_fails_before_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "candidate"
            binary.write_bytes(b"#!/bin/sh\nexit 0\n")
            binary.chmod(0o700)
            with self.assertRaisesRegex(ValidationError, "SHA-256"):
                native.checked_binary(binary, "0" * 64)
            self.assertEqual(native.checked_binary(binary, hashlib.sha256(binary.read_bytes()).hexdigest()), binary.resolve())

    def test_native_route_refuses_a_provider_env_bypass(self):
        gateway = types.SimpleNamespace(origin="http://127.0.0.1:23456", token="local-capability")
        with patch.object(native, "provider_env", return_value={"NUWAX_BASE_URL": "https://unrelated.invalid", "NUWAX_API_KEY": "local-capability"}):
            with self.assertRaisesRegex(ValidationError, "loopback gateway"):
                native.native_env(gateway, Path("home"), 2048)

    def test_native_route_removes_inherited_acp_bridge(self):
        gateway = types.SimpleNamespace(origin="http://127.0.0.1:23456", token="local-capability")
        with patch.object(native, "provider_env", return_value={"NUWAX_BASE_URL": gateway.origin + "/routes/GLM/responses", "NUWAX_API_KEY": gateway.token, "CODEX_BRIDGE": "genai"}):
            env = native.native_env(gateway, Path("home"), 2048)
        self.assertNotIn("CODEX_BRIDGE", env)
        self.assertEqual(env["NUWAX_BRIDGE"], "native")
        self.assertEqual(env["NUWAX_REQUEST_MAX_RETRIES"], "0")

    def test_nonloopback_control_is_rejected_without_opening_network(self):
        with patch("urllib.request.urlopen") as request:
            with self.assertRaisesRegex(ValidationError, "loopback"):
                control("https://unrelated.invalid", "unused", "/control/stats")
            request.assert_not_called()

    def test_fabricated_marker_without_a_real_tool_event_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "marker"
            marker.write_text("fresh")
            with self.assertRaisesRegex(ValidationError, "tool event"):
                native.assert_tool_marker({"items": [], "answer": "DONE"}, marker, "fresh")

    def test_usage_requires_actual_nonnegative_integer_fields(self):
        for usage in ({}, {"input_tokens": 1, "output_tokens": -1}, {"input_tokens": True, "output_tokens": 1}):
            with self.subTest(usage=usage), self.assertRaises(ValidationError):
                native.observed_usage({"events": [{"type": "turn.completed", "usage": usage}]})

    def test_empty_or_mismatched_attempt_ledger_cannot_pass(self):
        admitted = {"kind": "admitted", "vendor": "GLM", "wire": "responses"}
        self.assertFalse(native.audit_attempt_ledger([], 0))
        self.assertFalse(native.audit_attempt_ledger([], 1))
        self.assertFalse(native.audit_attempt_ledger([admitted], 2))
        self.assertFalse(native.audit_attempt_ledger([{**admitted, "wire": "chat"}], 1))
        self.assertTrue(native.audit_attempt_ledger([admitted], 1))

    def test_final_control_failure_still_closes_gateway(self):
        closed = []
        def failed_stats():
            raise ValidationError("probe failed")
        gateway = types.SimpleNamespace(stats=failed_stats, close=lambda: closed.append(True))
        stats, errors = native.settle_gateway(gateway)
        self.assertIsNone(stats)
        self.assertEqual(closed, [True])
        self.assertIn("probe failed", errors[0])

    @unittest.skipIf(os.name == "nt", "POSIX process-group contract")
    def test_owned_wrapper_archives_failure_and_reaps_its_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = native.archived_process(["sh", "-c", "echo first-failure >&2; exit 7"], dict(os.environ), root, root, "case", 5)
            self.assertEqual(result.returncode, 7)
            self.assertIn("first-failure", (root / "case.stderr").read_text())
            self.assertTrue(native.group_gone(int((root / "case.pid").read_text())))


if __name__ == "__main__":
    unittest.main()
