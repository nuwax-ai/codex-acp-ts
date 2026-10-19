"""Shared live-run contracts. This module never reads vendor credentials."""
import json
import base64
import http.server
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import threading
import tempfile
import urllib.parse
import urllib.request


class ValidationError(Exception):
    pass


def vision_prompt(filename):
    return (
        f"Open {filename} with view_image. Identify the digit and the dominant "
        "background color of the image. Reply in exactly this format: "
        "digit=<d> color=<c>, where color means the background color."
    )


def ensure_vision_fixtures(script_dir, vision_dir, allow_create=False):
    """Create fresh fixtures once; an existing directory must validate intact."""
    if not vision_dir.exists():
        if not allow_create:
            raise ValidationError("existing vision fixture directory is missing; refusing to replace the failed sample")
        generated = subprocess.run([sys.executable, str(script_dir / "gen-vision-images.py"), str(vision_dir), "3"], capture_output=True, text=True, timeout=10)
        if generated.returncode:
            raise ValidationError("vision fixture generation failed")
    try:
        truth = json.loads((vision_dir / "truth.json").read_text())
        images = truth["images"]
        if not isinstance(truth["seed"], int) or len(images) != 3:
            raise ValueError("invalid seed or image count")
        names = set()
        for image in images:
            name = image["file"]
            if not isinstance(name, str) or Path(name).name != name or name in names:
                raise ValueError("invalid image filename")
            names.add(name)
            if str(image["digit"]) not in "0123456789" or len(str(image["digit"])) != 1 or image["color"] not in ("red", "green", "blue", "yellow", "purple", "cyan"):
                raise ValueError("invalid image truth")
            prefix = "data:image/png;base64,"
            if not image["dataUrl"].startswith(prefix):
                raise ValueError("missing image byte receipt")
            expected = base64.b64decode(image["dataUrl"][len(prefix):], validate=True)
            actual = (vision_dir / name).read_bytes()
            if not actual.startswith(b"\x89PNG\r\n\x1a\n") or actual != expected:
                raise ValueError("image bytes differ from the existing truth receipt")
        return truth
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise ValidationError("existing vision fixture is incomplete or inconsistent; preserve it and inspect the failure") from error


def exec_result(stdout, returncode):
    if returncode != 0:
        raise ValidationError(f"exec exited with status {returncode}")
    try:
        events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    except (ValueError, TypeError) as error:
        raise ValidationError("exec emitted invalid JSONL") from error
    if any(not isinstance(event, dict) for event in events):
        raise ValidationError("exec emitted a non-object event")
    if any(event.get("type") in ("error", "turn.failed") for event in events):
        raise ValidationError("exec reported an error")
    if not any(event.get("type") == "turn.completed" for event in events):
        raise ValidationError("exec never completed the turn")
    items = [event.get("item", {}) for event in events if event.get("type") == "item.completed"]
    answers = [item.get("text") for item in items if item.get("type") == "agent_message" and isinstance(item.get("text"), str)]
    if not answers or not answers[-1].strip():
        raise ValidationError("exec produced no final assistant answer")
    return {"events": events, "items": items, "answer": answers[-1].strip()}


def screenshot_result(stdout, returncode, truth):
    result = exec_result(stdout, returncode)
    completed = [record for record in truth if record.get("event") == "complete"]
    if len(completed) != 1 or completed[0].get("color") not in ("red", "green", "blue", "yellow", "magenta", "cyan"):
        raise ValidationError("screenshot lacks one completed ground-truth record")
    calls = [item for item in result["items"] if item.get("type") == "mcp_tool_call" and item.get("tool", "").endswith("take_screenshot")]
    if len(calls) != 1 or calls[0].get("status") != "completed" or calls[0].get("error"):
        raise ValidationError("screenshot MCP call did not complete successfully exactly once")
    content = (calls[0].get("result") or {}).get("content", [])
    if not any(part.get("type") == "image" and part.get("data") for part in content if isinstance(part, dict)):
        raise ValidationError("screenshot result contains no typed image")
    if result["answer"].lower().rstrip(".!，。") != completed[0]["color"]:
        raise ValidationError("final assistant color differs from screenshot ground truth")
    return result


def control(origin, token, path, method="GET"):
    url = urllib.parse.urlparse(origin)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.username or url.password or url.path not in ("", "/"):
        raise ValidationError("a loopback budget gateway is required")
    request = urllib.request.Request(origin.rstrip("/") + path, headers={"authorization": "Bearer " + token}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    except Exception as error:
        raise ValidationError("budget gateway control request failed") from error


def provider_env(origin, token, vendor, wire, home, max_output):
    config = control(origin, token, "/control/config?" + urllib.parse.urlencode({"vendor": vendor, "wire": wire}))
    expected = f"{origin}/routes/{vendor}/{wire}"
    if config.get("baseUrl") != expected or not config.get("model"):
        raise ValidationError("gateway returned invalid provider configuration")
    # Vendor secrets and a pre-existing direct NUWAX endpoint must not reach
    # child processes. The only API key below is the local gateway capability.
    provider_overrides = {
        "MODEL_PROVIDER", "CODEX_CONFIG", "CODEX_BASE_URL", "CODEX_API_KEY", "CODEX_API_PROTOCOL",
        "CODEX_WIRE_API", "CODEX_PROVIDER_ID", "CODEX_PROVIDER_NAME", "CODEX_MODEL", "CODEX_MODEL_CONTEXT_WINDOW",
    }
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("NUWAX_", "LIVE_", "OPENAI_", "ANTHROPIC_")) and key not in provider_overrides}
    env.update({
        "CODEX_HOME": str(home), "NUWAX_BASE_URL": expected, "NUWAX_MODEL": config["model"],
        "NUWAX_WIRE_API": wire, "NUWAX_API_KEY": token, "NUWAX_MAX_OUTPUT_TOKENS": str(max_output),
        "NUWAX_REQUEST_MAX_RETRIES": "1", "NUWAX_STREAM_MAX_RETRIES": "1", "NUWAX_STREAM_IDLE_TIMEOUT_MS": "120000",
        "LIVE_GATEWAY_URL": origin, "LIVE_GATEWAY_KEY": token, "LIVE_VENDOR": vendor,
        "DEFAULT_AUTH_REQUEST": json.dumps({"methodId": "api-key", "_meta": {"api-key": {"apiKey": token}}}),
    })
    # A vendor-specific context window keeps the local budget honest for
    # models whose default fallback does not match the advertised capability.
    # Absent leaves Codex's own default handling in place; present-but-unusable
    # must stop the run, because a silently dropped window means the paid
    # attempts were made against a budget nobody configured.
    declared_window = os.environ.get(f"LIVE_WINDOW_{vendor}")
    if declared_window is not None and declared_window.strip():
        window = declared_window.strip()
        if not re.fullmatch(r"[0-9]+", window) or int(window) == 0:
            raise ValidationError(f"LIVE_WINDOW_{vendor} must be a positive integer token count, got {declared_window!r}")
        env["CODEX_MODEL_CONTEXT_WINDOW"] = window
    no_proxy = ",".join(filter(None, [env.get("NO_PROXY", env.get("no_proxy", "")), "127.0.0.1,localhost,::1"]))
    env["NO_PROXY"] = no_proxy
    env["no_proxy"] = no_proxy
    return env


def require_gateway_env():
    origin, token, vendor, wire = (os.environ.get(name) for name in ("LIVE_GATEWAY_URL", "LIVE_GATEWAY_KEY", "LIVE_VENDOR", "NUWAX_WIRE_API"))
    if not all((origin, token, vendor, wire)):
        raise ValidationError("run through live-smallbatch.sh; a shared budget gateway is required")
    config = control(origin, token, "/control/config?" + urllib.parse.urlencode({"vendor": vendor, "wire": wire}))
    if os.environ.get("NUWAX_BASE_URL") != config.get("baseUrl") or os.environ.get("NUWAX_API_KEY") != token:
        raise ValidationError("direct provider endpoint/key bypasses the shared gateway")


def run_process(command, env, cwd, timeout=240):
    process = subprocess.Popen(command, env=env, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=os.name != "nt")
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    except subprocess.TimeoutExpired as error:
        raise ValidationError("validation subprocess exceeded its deadline") from error
    finally:
        # Only the process group created for this invocation is cleaned up.
        # This also closes gateway streams owned by an abandoned ACP child.
        if os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
            else:
                # The leader may already have exited while an owned child
                # ignores TERM. Probe the group itself, never just poll().
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        elif process.poll() is None:
            process.terminate()
        if process.poll() is None:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                if os.name != "nt":
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    process.kill()
                process.wait()


class Gateway:
    def __init__(self, script_dir, root, env_file, budget=None, max_output=2048):
        ready = root / "gateway-ready.json"
        command = ["node", str(script_dir / "budget-gateway.mjs"), "--env-file", str(env_file), "--root", str(root), "--max-output", str(max_output)]
        if budget is not None:
            command += ["--budget", str(budget)]
        self.log = (root / "gateway.log").open("a")
        self.process = subprocess.Popen(command, stdout=self.log, stderr=self.log)
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise ValidationError("budget gateway could not start; inspect gateway.log")
                if ready.exists():
                    try:
                        config = json.loads(ready.read_text())
                        if config.get("pid") == self.process.pid:
                            self.origin, self.token = config["origin"], config["token"]
                            self.stats()
                            return
                    except (ValueError, KeyError):
                        pass
                time.sleep(0.05)
            raise ValidationError("budget gateway did not become ready")
        except Exception:
            self.close()
            raise

    def stats(self):
        return control(self.origin, self.token, "/control/stats")

    def close(self):
        if self.process.poll() is None:
            # TerminateProcess on Windows cannot deliver SIGTERM, so a killed
            # gateway leaves its ledger lock behind and the next --resume on the
            # same run directory fails closed. Ask for a cooperative shutdown
            # first and only escalate to terminate/kill if it stays alive.
            if getattr(self, "origin", None):
                try:
                    control(self.origin, self.token, "/control/shutdown", "POST")
                except ValidationError:
                    pass
            try:
                self.process.wait(timeout=5)
                self.log.close()
                return
            except subprocess.TimeoutExpired:
                self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.log.close()


def local_codex_preflight(script_dir, root, exec_bin):
    """Run real Codex on all three wires and Anthropic URL shapes, locally."""
    local = Path(tempfile.mkdtemp(prefix="local-preflight-", dir=root))
    # Reuse the actual wire fixtures instead of inventing a second protocol.
    module_url = (script_dir.parent / "acp-validation/mock-vendor-server.mjs").as_uri()
    emitter = "import {textResponse} from " + json.dumps(module_url) + "; console.log(JSON.stringify(Object.fromEntries(['chat','responses','anthropic'].map(wire=>[wire,textResponse(wire,'pong')]))));"
    emitted = subprocess.run(["node", "--input-type=module", "-e", emitter], capture_output=True, text=True, timeout=10)
    if emitted.returncode:
        raise ValidationError("local native-wire fixture generation failed")
    responses = json.loads(emitted.stdout)
    received = []
    wire_for_path = {"/v1/chat/completions": "chat", "/v1/responses": "responses", "/v1/messages": "anthropic"}

    class Sink(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            received.append({"path": self.path, "model": body.get("model"), "authenticated": self.headers.get("authorization") == "Bearer local-preflight-dummy"})
            wire = wire_for_path.get(self.path)
            if not wire:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(responses[wire].encode())

    sink = http.server.HTTPServer(("127.0.0.1", 0), Sink)
    threading.Thread(target=sink.serve_forever, daemon=True).start()
    env_file = local / "dummy.env"
    base = f"http://127.0.0.1:{sink.server_port}"
    fields = [f"LIVE_LOCAL_CHAT_URL={base}/v1", f"LIVE_LOCAL_RESPONSES_URL={base}/v1", f"LIVE_LOCAL_ANTHROPIC_URL={base}", f"LIVE_LOCAL_V1_ANTHROPIC_URL={base}/v1", f"LIVE_LOCAL_ENDPOINT_ANTHROPIC_URL={base}/v1/messages"]
    for vendor in ("LOCAL", "LOCAL_V1", "LOCAL_ENDPOINT"):
        fields.extend([f"LIVE_{vendor}_MODEL=local-preflight", f"LIVE_{vendor}_API_KEY=local-preflight-dummy"])
    env_file.write_text("\n".join(fields) + "\n")
    gateway = None
    try:
        gateway = Gateway(script_dir, local, env_file, budget=16, max_output=64)
        shapes = [("LOCAL", "chat", "chat"), ("LOCAL", "responses", "responses"), ("LOCAL", "anthropic", "anthropic-bare"), ("LOCAL_V1", "anthropic", "anthropic-v1"), ("LOCAL_ENDPOINT", "anthropic", "anthropic-endpoint")]
        for vendor, wire, label in shapes:
            home, work = local / f"home-{label}", local / f"work-{label}"
            home.mkdir(exist_ok=True)
            work.mkdir(exist_ok=True)
            env = provider_env(gateway.origin, gateway.token, vendor, wire, home, 64)
            before = len(received)
            result = run_process([str(exec_bin), "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", "-C", str(work), "Reply with exactly: pong"], env, work, timeout=90)
            (local / f"exec-{label}.jsonl").write_text(result.stdout)
            (local / f"exec-{label}.err").write_text(result.stderr)
            parsed = exec_result(result.stdout, result.returncode)
            expected_path = {"chat": "/v1/chat/completions", "responses": "/v1/responses", "anthropic": "/v1/messages"}[wire]
            rows = received[before:]
            if parsed["answer"].lower() != "pong" or not rows or not all(row == {"path": expected_path, "model": "local-preflight", "authenticated": True} for row in rows):
                raise ValidationError(f"real Codex {label} did not reach the exact configured NUWAX sink")
        if gateway.stats()["denied"]:
            raise ValidationError("local Codex preflight exceeded its dummy request budget")
    finally:
        (local / "sink-receipt.json").write_text(json.dumps(received, indent=2) + "\n")
        if gateway:
            gateway.close()
        sink.shutdown()
        sink.server_close()
