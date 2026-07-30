#!/usr/bin/env node
/**
 * Postinstall script: pre-downloads the native `nuwax-codex` binary from
 * Alibaba Cloud OSS at install time.  After this completes, the ACP bridge
 * can spawn `nuwax-codex app-server` instantly without a lazy download on
 * first use.
 */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);

// Resolve nuwax-codex package version — the binary version must match.
let CODEX_VERSION;
try {
  CODEX_VERSION = require("nuwax-codex/package.json").version;
} catch {
  process.exit(0); // nuwax-codex not installed — nothing to pre-download
}

const OSS_CDN_BASE =
  "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-codex";

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

function getTargetTriple() {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin") {
    return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (p === "linux") {
    if (a !== "x64") throw new Error("Unsupported Linux arch: " + a);
    let family = "gnu";
    try {
      const { familySync } = require("detect-libc");
      family = familySync() === "musl" ? "musl" : "gnu";
    } catch {
      /* musl detection best-effort */
    }
    return `x86_64-unknown-linux-${family}`;
  }
  if (p === "win32") {
    return a === "arm64"
      ? "aarch64-pc-windows-msvc"
      : "x86_64-pc-windows-msvc";
  }
  throw new Error("Unsupported platform: " + p);
}

function getArchiveExt() {
  return process.platform === "win32" ? "zip" : "tar.gz";
}

function getBinaryName() {
  return process.platform === "win32" ? "nuwax-codex.exe" : "nuwax-codex";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function cacheDir() {
  return join(homedir(), ".nuwax-codex-cache", CODEX_VERSION);
}

function cachedBinaryPath() {
  return join(cacheDir(), getBinaryName());
}

async function download(url, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `Download failed: HTTP ${res.status} ${res.statusText}\nURL: ${url}`,
    );
  }
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  let downloaded = 0;
  const reader = res.body.getReader();
  const ws = createWriteStream(outPath);
  const logInterval = setInterval(() => {
    if (total > 0) {
      process.stderr.write(
        `\r  Downloading nuwax-codex ${CODEX_VERSION} … ${((downloaded / total) * 100).toFixed(0)}%`,
      );
    }
  }, 500);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.write(value);
      downloaded += value.length;
    }
  } finally {
    clearInterval(logInterval);
    ws.end();
  }
  process.stderr.write("\n");
}

async function main() {
  const cached = cachedBinaryPath();
  if (existsSync(cached)) {
    process.stderr.write(
      `nuwax-codex ${CODEX_VERSION} already cached, skipping.\n`,
    );
    return;
  }

  const target = getTargetTriple();
  const ext = getArchiveExt();
  const url = `${OSS_CDN_BASE}/v${CODEX_VERSION}/nuwax-codex-${CODEX_VERSION}-${target}.${ext}`;

  process.stderr.write(
    `Pre-downloading nuwax-codex ${CODEX_VERSION} for ${target} …\n  ${url}\n`,
  );

  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const archivePath = join(dir, `nuwax-codex.${ext}`);

  // 1. Download
  await download(url, archivePath);

  // 2. Extract using system tools (reliable, no custom tar-parser bugs)
  process.stderr.write("  Extracting …\n");
  if (ext === "tar.gz") {
    execSync(`tar xzf "${archivePath}" -C "${dir}"`, { stdio: "inherit" });
  } else {
    // Windows: use PowerShell Expand-Archive
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force '${archivePath}' '${dir}'"`,
      { stdio: "inherit" },
    );
  }

  // 3. Clean up archive
  try {
    unlinkSync(archivePath);
  } catch {
    /* best-effort */
  }

  // 4. Ensure executable
  if (process.platform !== "win32") {
    chmodSync(cached, 0o755);
  }

  if (existsSync(cached)) {
    process.stderr.write(`✓ nuwax-codex ${CODEX_VERSION} ready.\n`);
  } else {
    process.stderr.write(
      `⚠ Download completed but binary not found at ${cached} — it will retry on first run.\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`⚠ nuwax-codex pre-download skipped: ${err.message}\n`);
  process.stderr.write(`  The binary will be downloaded on first use instead.\n`);
  // Never fail the install
});
