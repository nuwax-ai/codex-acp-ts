/**
 * Environment-driven auto-configuration for the Nuwax Codex bridge.
 *
 * Reads custom env vars (CODEX_BASE_URL, CODEX_WIRE_API, CODEX_MODEL,
 * CODEX_LOG_DIR) and translates them into Codex gateway config or system
 * env overrides. All custom logic lives here to keep merge conflicts with
 * upstream codex-acp to a minimum.
 */
import {CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR} from "./CodexAuthMethod";
import {logger} from "./Logger";

// ---------------------------------------------------------------------------
// Public env var names
// ---------------------------------------------------------------------------

export const CODEX_BASE_URL_ENV_VAR = "CODEX_BASE_URL";
export const CODEX_WIRE_API_ENV_VAR = "CODEX_WIRE_API";
export const CODEX_MODEL_ENV_VAR = "CODEX_MODEL";
export const CODEX_LOG_DIR_ENV_VAR = "CODEX_LOG_DIR";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Codex wire-protocol variant. */
export type EnvWireApi = "responses" | "chat";

/** Well-known provider id used by the auto-configured gateway. */
export const CUSTOM_GATEWAY_ID = "custom-gateway";

/** Shape of the gateway config stored in CodexAcpClient. */
export interface EnvGatewayConfig {
    modelProvider: string;
    config: {
        name: string;
        base_url: string;
        http_headers: Record<string, string>;
        wire_api: EnvWireApi;
    };
}

// ---------------------------------------------------------------------------
// Gateway auto-config from env
// ---------------------------------------------------------------------------

/**
 * If `CODEX_BASE_URL` is set, build a gateway config from environment
 * variables. Returns `null` when no env-driven gateway is requested (so
 * the ACP `authenticate` / `providers/set` flow remains the authority).
 */
export function readGatewayConfigFromEnv(): EnvGatewayConfig | null {
    const baseUrl = process.env[CODEX_BASE_URL_ENV_VAR]?.trim();
    if (!baseUrl) {
        return null;
    }

    const rawWireApi = process.env[CODEX_WIRE_API_ENV_VAR]?.trim();
    const wireApi: EnvWireApi =
        rawWireApi === "chat" || rawWireApi === "responses" ? rawWireApi : "responses";

    const providerName =
        process.env[CODEX_MODEL_ENV_VAR]?.trim() || "Custom Gateway";

    const headers: Record<string, string> = {"X-Client-Feature-ID": "codex"};

    const apiKey = readAnyApiKey();
    if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
    }

    logger.log("Auto-configured gateway from env", {
        baseUrl,
        wireApi,
        providerName,
        hasApiKey: !!apiKey,
    });

    return {
        modelProvider: CUSTOM_GATEWAY_ID,
        config: {
            name: providerName,
            base_url: baseUrl,
            http_headers: headers,
            wire_api: wireApi,
        },
    };
}

// ---------------------------------------------------------------------------
// Model override
// ---------------------------------------------------------------------------

/**
 * If `CODEX_MODEL` is set in env, returns it. Used to override codex's
 * default model selection when using a custom gateway.
 */
export function getEnvModel(): string | undefined {
    return process.env[CODEX_MODEL_ENV_VAR]?.trim() || undefined;
}

/**
 * If `CODEX_MODEL_CONTEXT_WINDOW` is set, returns it parsed as a number.
 * Used to inform codex of a custom model's context window size.
 */
export function getEnvContextWindow(): number | undefined {
    const raw = process.env["CODEX_MODEL_CONTEXT_WINDOW"]?.trim();
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try `CODEX_API_KEY` first, then fall back to `OPENAI_API_KEY`. Returns
 * `undefined` when neither is set (callers decide whether this is fatal).
 */
function readAnyApiKey(): string | undefined {
    for (const envVar of [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR]) {
        const value = process.env[envVar]?.trim();
        if (value) {
            return value;
        }
    }
    return undefined;
}
