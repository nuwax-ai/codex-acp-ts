#!/usr/bin/env python3
"""Direct vision checks: synthesized images through codex exec + view_image.

Each image costs 2 model attempts (view call + final answer). The prompt
never names the color/digit/position; answers are scored against truth.json.
Appends one line per attempt to the attempts file and prints a final
`vision: PASS|FAIL ...` line.
"""
import json
import os
import pathlib
import subprocess
import sys

root, env_file, exec_bin, max_out, attempts_file = sys.argv[1:6]
vision_dir = pathlib.Path(root) / "vision"
truth = json.loads((vision_dir / "truth.json").read_text())


def env_field(name):
    for line in pathlib.Path(env_file).read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1]
    return ""


base = env_field("LIVE_GLM_ANTHROPIC_URL")
model = env_field("LIVE_GLM_MODEL")
key = env_field("LIVE_GLM_API_KEY")

correct = 0
total = 0
for image in truth["images"]:
    total += 1
    home = pathlib.Path(root) / f"home-vision-{total}"
    work = pathlib.Path(root) / f"work-vision-{total}"
    home.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    (work / image["file"]).write_bytes((vision_dir / image["file"]).read_bytes())
    env = {
        **os.environ,
        "CODEX_HOME": str(home),
        "NUWAX_BASE_URL": base,
        "NUWAX_MODEL": model,
        "NUWAX_WIRE_API": "anthropic",
        "NUWAX_API_KEY": key,
        "NUWAX_MAX_OUTPUT_TOKENS": max_out,
        "NUWAX_REQUEST_MAX_RETRIES": "1",
        "NUWAX_STREAM_MAX_RETRIES": "1",
        "NUWAX_STREAM_IDLE_TIMEOUT_MS": "120000",
    }
    # The ask is generic; nothing about color/digit/position is in the prompt.
    prompt = (
        f"Open {image['file']} with the view_image tool, look at it, and reply "
        "in exactly this format: digit=<d> color=<c>"
    )
    for _ in range(2):  # 2 model attempts: view call + answer
        with open(attempts_file, "a") as f:
            f.write(json.dumps({"file": image["file"]}) + "\n")
    result = subprocess.run(
        [
            exec_bin,
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--json",
            "-C",
            str(work),
            prompt,
        ],
        env=env,
        cwd=str(work),
        capture_output=True,
        text=True,
        timeout=180,
    )
    out_path = pathlib.Path(root) / f"vision-{total - 1}.jsonl"
    out_path.write_text(result.stdout)
    answer = result.stdout.lower()
    digit_ok = f"digit={image['digit']}" in answer.replace(" ", "")
    color_ok = image["color"] in answer
    if result.returncode == 0 and digit_ok and color_ok:
        correct += 1
        print(f"vision image {image['file']}: CORRECT (digit+color)")
    else:
        print(
            f"vision image {image['file']}: WRONG rc={result.returncode} "
            f"want digit={image['digit']} color={image['color']}"
        )

verdict = "PASS" if correct >= 2 else "FAIL"
print(f"vision: {verdict} {correct}/{total} correct (seed {truth['seed']})")
sys.exit(0 if verdict == "PASS" else 1)
