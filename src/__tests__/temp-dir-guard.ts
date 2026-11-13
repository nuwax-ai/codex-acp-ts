import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Guards the system temp directory against leaked test homes.
 *
 * The suite creates one temp `CODEX_HOME` (with sqlite WAL/SHM files) per test through
 * `mkdtempSync(os.tmpdir())`. A killed or partially failing run leaves those behind, and
 * their count is not self-limiting: on 2026-11-13 accumulated `codex-acp-*` directories
 * reached 96 GB in `/var/folders/.../T`, which only surfaced as "the system disk lost
 * free space".
 *
 * Strategy: snapshot what already exists when the run starts, then delete only what
 * appeared afterwards. Pre-existing directories are never touched, so a concurrently
 * running suite in another checkout keeps its fixtures.
 */
const OWNED_PREFIXES = ["codex-acp-", "app-server-logs-", "engine-log-", "system-prompts-"];

let preexisting: Set<string> | null = null;

function ownedEntries(tempRoot: string): string[] {
    try {
        return fs
            .readdirSync(tempRoot)
            .filter(name => OWNED_PREFIXES.some(prefix => name.startsWith(prefix)))
            .map(name => path.join(tempRoot, name))
            .filter(candidate => fs.statSync(candidate, {throwIfNoEntry: false})?.isDirectory() ?? false);
    } catch {
        return [];
    }
}

export function setup(): void {
    preexisting = new Set(ownedEntries(os.tmpdir()));
}

export function teardown(): void {
    if (preexisting === null) return;
    for (const entry of ownedEntries(os.tmpdir())) {
        if (preexisting.has(entry)) continue;
        fs.rmSync(entry, {recursive: true, force: true, maxRetries: 3});
    }
}
