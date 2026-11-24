import {existsSync, readdirSync, readFileSync} from "node:fs";
import {createRequire} from "node:module";
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

/**
 * The engine version to look for in the cache.
 *
 * Read at runtime on purpose. `harnessPackage.version` is inlined by the bundler
 * from whatever `node_modules` held at build time, so 1.2.50 shipped a bundle
 * that looked for 0.18.59 while declaring 0.18.61: a clean machine was told the
 * 0.18.59 binary was missing, and a machine that still had that cache silently
 * ran the older engine. Resolving the installed package keeps the adapter and
 * the engine it depends on in agreement.
 */
function harnessVersion(): string {
    try {
        const require = createRequire(import.meta.url);
        const manifest = require.resolve("@nuwax-ai/nuwax-harness/package.json");
        const installed = JSON.parse(readFileSync(manifest, "utf8")) as {version?: string};
        if (typeof installed.version === "string" && installed.version.length > 0) {
            return installed.version;
        }
    } catch {
        // Standalone bundles have no node_modules to resolve; fall through.
    }
    // Last resort: use whatever the cache actually holds. This covers a bundle
    // whose inlined version is stale, which is exactly the 1.2.50 failure mode.
    const cached = cachedVersions();
    if (cached.length > 0) return cached[0];
    return harnessPackage.version;
}

/** Versions present in the bundle cache, newest-looking first. */
function cachedVersions(): string[] {
    try {
        return readdirSync(join(homedir(), CACHE_DIRECTORY), {withFileTypes: true})
            .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name))
            .map(entry => entry.name)
            .sort((left, right) =>
                right.localeCompare(left, undefined, {numeric: true, sensitivity: "base"}),
            );
    } catch {
        return [];
    }
}

export function resolveCodexBinaryPath(): string {
    // Installed version first, then whatever else the cache holds; the triple
    // order inside `targetTriples()` already expresses musl-before-gnu.
    const versions = [...new Set([harnessVersion(), ...cachedVersions()])];
    const cached = targetTriples()
        .flatMap(triple =>
            versions.map(version =>
                join(homedir(), CACHE_DIRECTORY, version, triple, binaryName()),
            ),
        )
        .find(candidate => existsSync(candidate));
    if (cached !== undefined) return cached;
    throw new Error(
        `The nuwax-harness ${versions[0]} binary is not installed. Run \`nuwax-harness --version\` to ` +
        "download it, or set CODEX_PATH to an absolute path.",
    );
}
