// Fork customization: kept in its own module so this logic is isolated from
// the upstream `CodexAcpClient.ts` and survives merges with upstream. If this
// file disappears after a merge, the system-prompt passthrough stops working.

import {RequestError} from "@agentclientprotocol/sdk";

/**
 * Reads the client-supplied system prompt from an ACP request `_meta`.
 *
 * Accepts the shapes used by ACP clients for the `systemPrompt` extension:
 *   - `{ systemPrompt: { append: "..." } }` — the ACP `systemPrompt.append` mode
 *     (e.g. rcoder forwards its `system_prompt` via `_meta.systemPrompt.append`)
 *   - `{ systemPrompt: "..." }` — plain string
 *
 * Returns `null` when absent so the caller can let Codex fall back to its
 * built-in instructions. Throws `invalidParams` on a malformed value (Fail Fast),
 * mirroring the validation style used by `readAdditionalDirectories`.
 */
export function readMetaSystemPrompt(meta?: Record<string, unknown> | null): string | null {
    const raw = meta?.["systemPrompt"];
    if (raw == null) {
        return null;
    }
    if (typeof raw === "string") {
        return raw.length > 0 ? raw : null;
    }
    if (typeof raw !== "object") {
        throw RequestError.invalidParams(undefined, "_meta.systemPrompt must be a string or { append: string }");
    }
    const append = (raw as Record<string, unknown>)["append"];
    if (append == null) {
        return null;
    }
    if (typeof append !== "string") {
        throw RequestError.invalidParams(undefined, "_meta.systemPrompt.append must be a string");
    }
    return append.length > 0 ? append : null;
}
