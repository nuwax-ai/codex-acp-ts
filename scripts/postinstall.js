#!/usr/bin/env node
/**
 * Postinstall script: pre-downloads the native `nuwax-codex` binary from
 * Alibaba Cloud OSS at install time and places it under this package's own
 * `vendor/nuwax-codex/{version}/` directory.
 *
 * We keep it in a non-hidden `vendor/` dir (not `node_modules/.cache`) so that
 * Electron packagers (electron-builder / @electron/osx-sign) discover and
 * re-sign the Mach-O during app signing — a hidden `.cache` dir was being
 * skipped, leaving the binary with only an ad-hoc signature and triggering
 * macOS Gatekeeper's "unidentified developer" prompt. Deleting node_modules
 * cleans up the binary so users always have a predictable clean slate.
 */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

let CODEX_VERSION;
try {
  CODEX_VERSION = require("nuwax-codex/package.json").version;
} catch {
  process.exit(0);
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
    // codex ships only a static musl build for linux arm64; statically
    // linked so it runs on both glibc and musl systems.
    if (a === "arm64") return "aarch64-unknown-linux-musl";
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
// Location: <pkg>/vendor/nuwax-codex/{version}/  (non-hidden so packagers re-sign)
// ---------------------------------------------------------------------------

function cacheDir() {
  // This script ships at `scripts/postinstall.js`, so the package root is two
  // levels up from the current file.
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  return join(pkgRoot, "vendor", "nuwax-codex", CODEX_VERSION);
}

function cachedBinaryPath() {
  return join(cacheDir(), getBinaryName());
}

// ---------------------------------------------------------------------------
// Download & extract
// ---------------------------------------------------------------------------

async function download(url, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `Download failed: HTTP ${res.status} ${res.statusText}\nURL: ${url}`,
    );
  }
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (total > 0 && buffer.length !== total) {
    throw new Error(
      `Download incomplete: got ${buffer.length} bytes, expected ${total}`,
    );
  }
  writeFileSync(outPath, buffer);
  process.stderr.write(
    `  Downloaded ${(buffer.length / 1024 / 1024).toFixed(0)} MB\n`,
  );
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

  await download(url, archivePath);

  process.stderr.write("  Extracting …\n");
  if (ext === "tar.gz") {
    execSync(`tar xzf "${archivePath}" -C "${dir}"`, { stdio: "inherit" });
  } else {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force '${archivePath}' '${dir}'"`,
      { stdio: "inherit" },
    );
  }

  try {
    unlinkSync(archivePath);
  } catch {
    /* best-effort */
  }

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
});
