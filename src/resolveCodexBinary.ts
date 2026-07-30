import { createRequire } from "node:module";
import { join, dirname } from "node:path";

/**
 * Resolves the native nuwax-codex binary path from
 * node_modules/.cache/nuwax-codex/{version}/.
 *
 * The binary is pre-downloaded there by the postinstall script so it
 * lives inside node_modules — deleting node_modules cleans everything.
 */
export function resolveCodexBinaryPath(): string {
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(require.resolve("nuwax-codex/package.json"));
    const version = require("nuwax-codex/package.json").version;
    const binaryName =
        process.platform === "win32" ? "nuwax-codex.exe" : "nuwax-codex";
    return join(pkgDir, "..", ".cache", "nuwax-codex", version, binaryName);
}
