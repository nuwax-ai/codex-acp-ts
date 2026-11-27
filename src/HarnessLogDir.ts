import * as path from "node:path";

/** Directory the host wants the engine's own logs in. */
export const HARNESS_LOG_DIR_ENV_VAR = "NUWAX_HARNESS_LOG_DIR";

/**
 * App Server `-c` overrides that point the engine's log directory at the host's logs.
 *
 * The engine defaults its log directory to `$CODEX_HOME`, and an ACP host isolates that per
 * project, so engine logs otherwise scatter one directory per project, away from the adapter's.
 * An absolute `NUWAX_HARNESS_LOG_DIR` keeps the whole stack's logs together.
 *
 * A relative value is refused rather than resolved: the working directory of an App Server is
 * the user's project, so a relative path would silently put logs somewhere unrelated.
 */
export function harnessLogDirArgs(env: NodeJS.ProcessEnv = process.env): string[] {
    const dir = env[HARNESS_LOG_DIR_ENV_VAR]?.trim();
    if (!dir) return [];
    if (!path.isAbsolute(dir)) {
        throw new Error(`${HARNESS_LOG_DIR_ENV_VAR} must be an absolute path, got ${JSON.stringify(dir)}`);
    }
    // `-c key=value` parses the value as TOML, so a JSON string is the right quoting for a path
    // (backslashes on Windows included).
    return ["-c", `log_dir=${JSON.stringify(dir)}`];
}
