/**
 * The adapter must look for the engine version that is actually installed.
 *
 * 1.2.50 regressed here: `harnessPackage.version` is inlined by the bundler from
 * whatever `node_modules` held at build time, so the published bundle looked for
 * 0.18.59 while declaring 0.18.61 — a clean machine was told 0.18.59 was
 * missing, and a machine holding that old cache silently ran an older engine.
 * These tests pin the runtime resolution that replaced the inlined value.
 */
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

let fakeHome = "";

vi.mock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return {...actual, homedir: () => fakeHome};
});

const {resolveCodexBinaryPath} = await import("../resolveCodexBinary");

const CACHE_DIR_ENV = "NUWAX_HARNESS_CACHE_DIR";

function cacheFileAt(root: string, version: string, triple: string): string {
    const directory = join(root, version, triple);
    mkdirSync(directory, {recursive: true});
    const binary = join(directory, process.platform === "win32" ? "nuwax-harness.exe" : "nuwax-harness");
    writeFileSync(binary, "");
    return binary;
}

function cacheFile(version: string, triple: string): string {
    return cacheFileAt(join(fakeHome, ".nuwax-harness-cache"), version, triple);
}

/** The triple this test host would resolve first. */
function hostTriple(): string {
    if (process.platform === "darwin") {
        return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    }
    if (process.platform === "linux") {
        return process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
    }
    return "x86_64-pc-windows-msvc";
}

/** The version the real installed `@nuwax-ai/nuwax-harness` declares. */
function installedVersion(): string {
    return JSON.parse(
        require("node:fs").readFileSync(
            require("node:module").createRequire(import.meta.url).resolve(
                "@nuwax-ai/nuwax-harness/package.json",
            ),
            "utf8",
        ),
    ).version as string;
}

describe("resolveCodexBinaryPath", () => {
    beforeEach(() => {
        fakeHome = mkdtempSync(join(tmpdir(), "acp-resolve-"));
        delete process.env[CACHE_DIR_ENV];
    });

    afterEach(() => {
        delete process.env[CACHE_DIR_ENV];
        vi.restoreAllMocks();
    });

    it("returns the installed engine's binary", () => {
        const binary = cacheFile(installedVersion(), hostTriple());
        expect(resolveCodexBinaryPath()).toBe(binary);
    });

    it("falls back to whatever the cache holds when the installed version is absent", () => {
        // The regression: a bundle carrying a stale inlined version must still
        // find the engine that the cache (and therefore the user) actually has.
        const older = "0.18.60";
        const binary = cacheFile(older, hostTriple());
        expect(resolveCodexBinaryPath()).toBe(binary);
    });

    it("prefers the installed version over an older cached one", () => {
        cacheFile("0.18.60", hostTriple());
        const installed = cacheFile(installedVersion(), hostTriple());
        expect(resolveCodexBinaryPath()).toBe(installed);
    });

    it("names the installed version when nothing is cached", () => {
        expect(() => resolveCodexBinaryPath()).toThrowError(
            new RegExp(`The nuwax-harness ${installedVersion().replaceAll(".", "\\.")} binary is not installed`),
        );
    });

    it("searches the override cache root instead of the home cache", () => {
        const root = mkdtempSync(join(tmpdir(), "acp-cache-root-"));
        const binary = cacheFileAt(root, installedVersion(), hostTriple());
        process.env[CACHE_DIR_ENV] = root;
        expect(resolveCodexBinaryPath()).toBe(binary);
    });

    it("treats a blank override as unset", () => {
        const binary = cacheFile(installedVersion(), hostTriple());
        process.env[CACHE_DIR_ENV] = "   ";
        expect(resolveCodexBinaryPath()).toBe(binary);
    });

    it("rejects a relative override", () => {
        process.env[CACHE_DIR_ENV] = "relative/cache";
        expect(() => resolveCodexBinaryPath()).toThrowError(/must be an absolute path/);
    });

    it("names the override root when nothing is cached, and asks for the same variable", () => {
        const root = mkdtempSync(join(tmpdir(), "acp-empty-root-"));
        process.env[CACHE_DIR_ENV] = root;
        expect(() => resolveCodexBinaryPath()).toThrowError(
            new RegExp(`binary is not installed under ${root.replaceAll(".", "\\.")}`),
        );
        expect(() => resolveCodexBinaryPath()).toThrowError(/with the same NUWAX_HARNESS_CACHE_DIR/);
    });

    it("does not tell a deployment that never set the variable to match its value", () => {
        let message = "";
        try {
            resolveCodexBinaryPath();
        } catch (error) {
            message = String(error);
        }
        expect(message).toContain("not installed under");
        expect(message).toContain("set NUWAX_HARNESS_CACHE_DIR to a directory");
        expect(message).not.toContain("the same NUWAX_HARNESS_CACHE_DIR");
    });
});
