#!/usr/bin/env node
/**
 * Postinstall script: triggers the nuwax-codex JS launcher so it downloads
 * the native binary from Alibaba Cloud OSS at install time.  The launcher's
 * `ensureBinary()` call caches the binary under `~/.nuwax-codex-cache/`.
 *
 * After this completes, calls like `nuwax-codex-acp-ts` (which internally
 * spawn `nuwax-codex app-server`) will be instant — no lazy download on
 * first use.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let launcherPath: string;
try {
  launcherPath = require.resolve("nuwax-codex/bin/nuwax-codex.js");
} catch {
  // nuwax-codex not installed as dependency — nothing to pre-download
  process.exit(0);
}

process.stderr.write("Pre-downloading nuwax-codex binary …\n");

const result = spawnSync(process.execPath, [launcherPath, "--version"], {
  stdio: "inherit",
  timeout: 180_000, // 3 minutes for OSS download + extraction
});

if (result.status !== 0) {
  // Don't fail the install — the binary will be downloaded on first run
  process.stderr.write(
    `Warning: nuwax-codex pre-download exited with status ${result.status}. It will retry on first use.\n`,
  );
}
