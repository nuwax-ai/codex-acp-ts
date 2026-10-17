#!/usr/bin/env python3
"""Check every synthesized image using final assistant text, through the shared gateway."""
import json
import os
from pathlib import Path
import re
import sys

from live_support import ValidationError, ensure_vision_fixtures, exec_result, require_gateway_env, run_process, vision_prompt


def main():
    require_gateway_env()
    root, exec_bin = Path(sys.argv[1]), sys.argv[2]
    vision_dir = root / "vision"
    truth = ensure_vision_fixtures(Path(__file__).resolve().parent, vision_dir)
    correct = 0
    for index, image in enumerate(truth["images"]):
        home, work = root / f"home-vision-{index}", root / f"work-vision-{index}"
        home.mkdir(exist_ok=True)
        work.mkdir(exist_ok=True)
        (work / image["file"]).write_bytes((vision_dir / image["file"]).read_bytes())
        env = {**os.environ, "CODEX_HOME": str(home)}
        prompt = vision_prompt(image["file"])
        result = run_process([exec_bin, "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", "-C", str(work), prompt], env, work)
        (root / f"vision-{index}.jsonl").write_text(result.stdout)
        (root / f"vision-{index}.err").write_text(result.stderr)
        try:
            parsed = exec_result(result.stdout, result.returncode)
            match = re.fullmatch(r"digit\s*=\s*(\d)\s+color\s*=\s*([a-z]+)[.!]?", parsed["answer"].lower())
            if match and match[1] == str(image["digit"]) and match[2] == image["color"]:
                correct += 1
                print(f"vision image {index}: CORRECT (final digit+color)")
            else:
                print(f"vision image {index}: WRONG final answer")
        except ValidationError:
            print(f"vision image {index}: FAILED exec contract")
    total = len(truth["images"])
    passed = total > 0 and correct == total
    print(f"vision: {'PASS' if passed else 'FAIL'} {correct}/{total} correct (seed {truth['seed']})")
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValidationError, OSError, ValueError, IndexError) as error:
        print(f"vision: FAIL {error}", file=sys.stderr)
        sys.exit(1)
