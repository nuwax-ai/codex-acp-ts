import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

/**
 * Resolves the native nuwax-codex binary path from this package's own
 * `vendor/nuwax-codex/{version}/` directory.
 *
 * The binary is pre-downloaded there by the postinstall script. It deliberately
 * lives in a non-hidden `vendor/` dir (not under `node_modules/.cache`) so that
 * Electron packagers (electron-builder / @electron/osx-sign) discover and
 * re-sign the Mach-O during app signing — otherwise the ad-hoc-signed binary is
 * skipped and macOS Gatekeeper shows an "unidentified developer" prompt.
 */
export function resolveCodexBinaryPath(): string {
    const require = createRequire(import.meta.url);
    const version = require("nuwax-codex/package.json").version;
    // Bundled output ships at `dist/index.js`, so the package root is two
    // levels up from the current file (also holds when running `src/` via tsx).
    const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const binaryName =
        process.platform === "win32" ? "nuwax-codex.exe" : "nuwax-codex";
    return join(pkgRoot, "vendor", "nuwax-codex", version, binaryName);
}
