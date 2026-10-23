import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import harnessPackage from "@nuwax-ai/nuwax-harness/package.json";

/**
 * Resolves the native `nuwax-harness` binary that the adapter spawns as its app-server.
 *
 * The `@nuwax-ai/nuwax-harness` package downloads that bundle into `~/.nuwax-harness-cache` in its
 * own postinstall. The path is derived here rather than imported from the package's launcher,
 * because the launcher reads its version relative to its own file: bundling it into the adapter —
 * as both the esbuild and the bun build do — breaks that lookup. The pieces it would supply are
 * mirrored below, and a cold cache fails with the command that repairs it.
 *
 * The binary is spawned directly rather than through the `nuwax-harness` launcher, because the
 * adapter speaks JSON-RPC over the child's stdio and the launcher inherits its own.
 */

/** Where the nuwax-harness package caches the bundle it installed. */
const CACHE_DIRECTORY = ".nuwax-harness-cache";

/** The platform targets the harness names its bundle archives after, most likely first. */
function targetTriples(): string[] {
    const {platform, arch} = process;
    if (platform === "darwin") {
        if (arch === "arm64") return ["aarch64-apple-darwin"];
        if (arch === "x64") return ["x86_64-apple-darwin"];
    } else if (platform === "linux") {
        // The bundle is built against musl or gnu, and which one is installed decides the directory.
        if (arch === "arm64") return ["aarch64-unknown-linux-musl"];
        if (arch === "x64") return ["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"];
    } else if (platform === "win32") {
        if (arch === "arm64") return ["aarch64-pc-windows-msvc"];
        if (arch === "x64") return ["x86_64-pc-windows-msvc"];
    }
    throw new Error(`Unsupported platform/architecture: ${platform}/${arch}`);
}

/** The main executable inside the bundle. */
function binaryName(): string {
    return process.platform === "win32" ? "nuwax-harness.exe" : "nuwax-harness";
}

export function resolveCodexBinaryPath(): string {
    const version = harnessPackage.version;
    const cached = targetTriples()
        .map(triple => join(homedir(), CACHE_DIRECTORY, version, triple, binaryName()))
        .find(candidate => existsSync(candidate));
    if (cached !== undefined) return cached;
    throw new Error(
        `The nuwax-harness ${version} binary is not installed. Run \`nuwax-harness --version\` to ` +
        "download it, or set CODEX_PATH to an absolute path.",
    );
}
